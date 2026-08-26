import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, notAvailable } from "@agent-engine/tool-common";
import { MEDIA_CACHE_PREFIX } from "./find-images.js";

const TOOL_VERSION = "1.0.0";

/**
 * `media.harvestVideo` — Tier 2b of the clip cascade: contextual footage
 * from the open web (a podcast soundbite, a keynote clip) found by topic.
 *
 * The PROVIDER is a seam, not an implementation: no video-capable search
 * backend exists in this deployment yet (the Apify presets are image-only
 * and unregistered; the scraper's `ScrapedRecord` carries no video field),
 * and guessing an unverified actor's output shape would fail inside a run
 * instead of here. Until a provider is wired, every call reports
 * `not_available` and the cascade moves to Tier 3 — which is exactly what
 * "zero-held between tiers" means.
 *
 * Rights note, inherited from the scrape tier's own license stance: harvested
 * web video is `licenseConfidence: "unknown"` — copyright stays with the
 * original poster. The clip pipeline's caption ALREADY requires an explicit
 * source credit (checked in code, not asked of the model), and the human
 * gate sees the source; a provider implementation must carry the source URL
 * through so both keep working.
 */

export const HarvestVideoInputSchema = z.object({
  repoRoot: z.string().min(1),
  runId: z.string().min(1),
  /** What to look for — the run's topic/angle. */
  query: z.string().min(1).max(400),
  /** Cap on the source file, defaulted well under the ingest ceiling. */
  maxBytes: z
    .number()
    .int()
    .positive()
    .default(256 * 1024 * 1024),
});
export type HarvestVideoInput = z.infer<typeof HarvestVideoInputSchema>;

export interface HarvestVideoResult {
  /** Repo-relative, forward-slashed. */
  path: string;
  /** Where it came from — carried into the deliverable's source credit trail. */
  sourceUrl: string;
  title?: string;
}

/** The seam a real backend (an Apify video actor, a feed resolver) implements. */
export interface VideoHarvestProvider {
  /** Finds one downloadable candidate for the query, or null when nothing usable exists. */
  findVideo(query: string): Promise<{ mediaUrl: string; sourceUrl: string; title?: string } | null>;
}

const VIDEO_MIME_EXTENSION: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mp4",
  "video/webm": ".webm",
};

export function createHarvestVideo(options: { provider?: VideoHarvestProvider | undefined; fetchImpl?: typeof fetch } = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  return defineTool<HarvestVideoInput, HarvestVideoResult>({
    name: "media.harvestVideo",
    version: TOOL_VERSION,
    inputSchema: HarvestVideoInputSchema,
    async execute(input) {
      const provider = options.provider;
      if (provider === undefined) {
        return notAvailable(
          "no video-harvest provider is wired for this deployment — the clip cascade's other tiers still work (see media.harvestVideo's own doc comment for what a provider implements)",
        );
      }

      const candidate = await provider.findVideo(input.query);
      if (candidate === null) {
        return contentFail(`media.harvestVideo: nothing usable found for "${input.query}"`);
      }

      const relDir = `${MEDIA_CACHE_PREFIX}/${input.runId}`;
      const absDir = path.resolve(input.repoRoot, relDir);
      const rootResolved = path.resolve(input.repoRoot);
      if (absDir !== rootResolved && !absDir.startsWith(rootResolved + path.sep)) {
        return contentFail(`media.harvestVideo: resolved cache dir escaped repoRoot (runId="${input.runId}")`);
      }
      await fs.mkdir(absDir, { recursive: true });

      const response = await fetchImpl(candidate.mediaUrl);
      if (!response.ok) {
        return contentFail(`media.harvestVideo: the candidate at ${candidate.sourceUrl} did not download (${response.status})`);
      }
      const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const extension = VIDEO_MIME_EXTENSION[mime];
      if (extension === undefined) {
        return contentFail(`media.harvestVideo: refused content type "${mime}" — refused, never guessed`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > input.maxBytes) {
        return contentFail(`media.harvestVideo: candidate is ${bytes.byteLength} bytes (cap ${input.maxBytes})`);
      }

      const fileName = `harvested-clip${extension}`;
      await fs.writeFile(path.join(absDir, fileName), bytes);
      return success<HarvestVideoResult>({
        path: `${relDir}/${fileName}`,
        sourceUrl: candidate.sourceUrl,
        ...(candidate.title !== undefined ? { title: candidate.title } : {}),
      });
    },
  });
}
