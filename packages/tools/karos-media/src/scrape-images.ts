import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, toolingError, notAvailable } from "@agent-engine/tool-common";
import { ScraperError, type ScrapedRecord, type ScraperProvider, type SocialPlatform } from "@agent-engine/tool-karos-scraper";
import { MEDIA_CACHE_PREFIX, downloadImage, type FindImagesCandidate } from "./find-images.js";

// 1.0.1 (SCRUM-296/AU11): removed the redundant re-parse of already-validated input.
const TOOL_VERSION = "1.0.1";

/**
 * Platforms searched for a visual need, in order.
 *
 * Instagram and TikTok are where a photograph of a specific real thing
 * actually lives. Both are searched because a need one has nothing for, the
 * other often does.
 */
const VISUAL_PLATFORMS: readonly SocialPlatform[] = ["instagram", "tiktok"];

export const ScrapeImagesInputSchema = z.object({
  repoRoot: z.string().min(1).describe("Bounds root. Every returned path is relative to this and provably inside it."),
  runId: z.string().min(1).describe("Namespaces the cache directory, exactly as the other media tools do."),
  needs: z
    .array(
      z.object({
        n: z.number().int().positive().describe("This slide's number."),
        query: z.string().min(1).describe("The search query for this slide's picture."),
      }),
    )
    .min(1)
    .describe("One entry per slide still missing a picture after the harvester tier."),
  perNeed: z.number().int().min(1).max(6).default(3).describe("Candidates to keep per need. Each platform search is a billed scrape."),
});
export type ScrapeImagesInput = z.input<typeof ScrapeImagesInputSchema>;

export interface ScrapeImagesResult {
  candidates: FindImagesCandidate[];
  unmet: { n: number; query: string; reason: string }[];
  platformsUsed: string[];
}

/**
 * The licence line recorded on a scraped social image.
 *
 * Stated this bluntly on purpose. These are user-generated posts: the
 * uploader holds the copyright, and "it appeared in a hashtag search" is not a
 * commercial licence. `instagram-agent` step 06 should and will refuse most of
 * them on `rightsUsable`, and it can only do that if the description says so.
 */
const SCRAPED_LICENCE =
  "UNKNOWN / user-generated: copyright retained by the original poster, no commercial licence granted, not cleared for publication without permission";

/**
 * `media.scrapeImages` — tier 2 of the visual pipeline.
 *
 * ## What this is for, and what it is not
 *
 * Tier 1 (`media.findImages`) searches stock and CC libraries, which hold
 * generic scenes but not specific real subjects. Tier 3
 * (`image.generate`) can draw anything but invents it. Between them sits a
 * real gap: a photograph *of the actual thing*, which exists on the open
 * social web and nowhere else.
 *
 * That gap is worth covering, and this covers it — but the honest framing
 * matters more than the capability. Every candidate here is
 * `licenseConfidence: "unknown"`, so the rights gate will refuse nearly all of
 * them for an unattended publish. This tier earns its place as reference
 * material and for human-reviewed picks; it is **not** what makes a run
 * complete. Tier 3 is.
 *
 * Unconfigured (no scraper) it reports `not_available`, like every other
 * credentialed capability here.
 */
export function createScrapeImages(options: { scraper?: ScraperProvider | undefined; fetchImpl?: typeof fetch }) {
  const fetchImpl = options.fetchImpl ?? fetch;

  return defineTool<ScrapeImagesInput, ScrapeImagesResult>({
    name: "media.scrapeImages",
    description:
      "Tier 2 of the visual pipeline: searches Instagram/TikTok for a photograph of the actual real subject, which stock/CC libraries (Tier 1) and generation (Tier 3) cannot supply. Every candidate is licenseConfidence: \"unknown\", so this is reference/human-reviewed material, not what makes an unattended run complete. Reports not_available when no scraper is configured.",
    version: TOOL_VERSION,
    inputSchema: ScrapeImagesInputSchema,
    async execute(rawInput) {
      // See find-images.ts's identical comment: `defineTool` already parsed `rawInput`
      // against `ScrapeImagesInputSchema` (defaults applied) before calling this —
      // this cast reflects that instead of a second, actually-redundant `.parse()` call.
      const input = rawInput as z.output<typeof ScrapeImagesInputSchema>;
      if (options.scraper === undefined) {
        return notAvailable(
          "media.scrapeImages: no scraper configured — set SCRAPPYCOCO_API_KEY to enable the scrape tier " +
            "(see packages/tools/karos-media/README.md)",
        );
      }
      const scraper = options.scraper;

      const relDir = `${MEDIA_CACHE_PREFIX}/${input.runId}`;
      const absDir = path.resolve(input.repoRoot, relDir);
      const rootResolved = path.resolve(input.repoRoot);
      if (absDir !== rootResolved && !absDir.startsWith(rootResolved + path.sep)) {
        return toolingError(`media.scrapeImages: resolved cache dir escaped repoRoot (runId="${input.runId}")`);
      }
      try {
        await fs.mkdir(absDir, { recursive: true });
      } catch (error) {
        return toolingError(`media.scrapeImages: could not create ${relDir}: ${(error as Error).message}`);
      }

      const candidates: FindImagesCandidate[] = [];
      const unmet: ScrapeImagesResult["unmet"] = [];
      const platformsUsed: string[] = [];

      for (const need of input.needs) {
        const attempts: string[] = [];
        let sawScraperError = false;
        let savedForNeed = 0;

        for (const platform of VISUAL_PLATFORMS) {
          if (savedForNeed >= input.perNeed) break;

          let records: ScrapedRecord[];
          try {
            records = await scraper.searchSocial(platform, need.query, { limit: input.perNeed });
          } catch (error) {
            if (error instanceof ScraperError) {
              // Demote to the next platform: one platform's outage must not
              // discard the other, and the tier below still has a turn.
              attempts.push(`${platform}: ${error.message}`);
              sawScraperError = true;
              continue;
            }
            throw error;
          }

          const urls = records.flatMap((r) => [...(r.imageUrls ?? [])].map((url) => ({ url, record: r })));
          if (urls.length === 0) {
            attempts.push(`${platform}: no images on ${records.length} result(s)`);
            continue;
          }

          for (const { url, record } of urls) {
            if (savedForNeed >= input.perNeed) break;
            const saved = await downloadImage(fetchImpl, { id: `${platform}-${url}`, url }, absDir, relDir, need.n);
            if (saved === undefined) continue;

            const caption = (record.text ?? record.title ?? "").replace(/\s+/g, " ").slice(0, 180);
            candidates.push({
              path: saved,
              description:
                `slide ${need.n} candidate — social post image found by searching ${platform} for "${need.query}"` +
                `${caption ? `; post caption: "${caption}"` : ""}` +
                `${record.author ? `; posted by ${record.author}` : ""} [licence: ${SCRAPED_LICENCE}]`,
              provider: `scrape:${platform}`,
              licenseConfidence: "unknown",
            });
            savedForNeed += 1;
            if (!platformsUsed.includes(platform)) platformsUsed.push(platform);
          }
        }

        if (savedForNeed === 0) {
          if (sawScraperError) {
            return toolingError(`media.scrapeImages: scraper failure left slide ${need.n} unfilled — ${attempts.join("; ")}`);
          }
          unmet.push({ n: need.n, query: need.query, reason: attempts.join("; ") || "no images found" });
        }
      }

      if (candidates.length === 0) {
        return contentFail(
          `media.scrapeImages: found no usable images for ${input.needs.length} need(s) — ${unmet
            .map((u) => `slide ${u.n} (${u.reason})`)
            .join("; ")}`,
        );
      }

      return success<ScrapeImagesResult>({ candidates, unmet, platformsUsed });
    },
  });
}
