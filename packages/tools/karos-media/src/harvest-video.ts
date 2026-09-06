import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, notAvailable, toolingError } from "@agent-engine/tool-common";
import { MEDIA_CACHE_PREFIX } from "./find-images.js";

// 1.1.0: the provider seam grew a `download` branch and the input grew a
// rights scope (`allowedSources`) and duration bounds; the first real
// backend (`createYtDlpHarvestProvider`) sits behind `VIDEO_HARVEST_PROVIDER`.
const TOOL_VERSION = "1.1.0";

/**
 * `media.harvestVideo` — Tier 2b of the clip cascade: contextual footage
 * from a show the client may clip (a podcast soundbite, a keynote moment)
 * found by topic.
 *
 * The PROVIDER is a seam with one real implementation today: `yt-dlp`,
 * enabled per deployment with `VIDEO_HARVEST_PROVIDER=yt-dlp`
 * (`src/providers/yt-dlp-harvest.ts`). A deployment without it still gets
 * this tool registered and answering `not_available` per call, so the
 * cascade moves to Tier 3 — which is exactly what "zero-held between tiers"
 * means. The tests inject a fake provider through the same option.
 *
 * ## Rights are an INPUT, not a hope
 *
 * A harvested clip is `licenseConfidence: "unknown"` by the scrape tier's
 * own standard — copyright stays with the original poster. What makes a
 * commentary clip publishable anyway is that the client holds clipping rights
 * to specific shows (their `tiktokClips.sourcePool`), so those show names
 * travel in as `allowedSources` and a provider MUST confine its results to
 * them. With none, a provider refuses rather than searching the open web.
 * The clip pipeline's caption already requires an explicit source credit
 * (checked in code, not asked of the model) and the human gate sees the
 * source; `sourceUrl`/`channel` are carried through so both keep working.
 */

export const HarvestVideoInputSchema = z.object({
  repoRoot: z.string().min(1).describe("Bounds root. The written clip path is relative to this and provably inside it."),
  runId: z.string().min(1).describe("Namespaces the cache directory, exactly as media.findImages does."),
  query: z.string().min(1).max(400).describe("What to look for — the run's topic/angle."),
  allowedSources: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Show/channel names the client holds clipping rights to (their `tiktokClips.sourcePool`). A provider MUST restrict results to these; with none, the provider refuses rather than searching the open web.",
    ),
  maxBytes: z
    .number()
    .int()
    .positive()
    .default(256 * 1024 * 1024)
    .describe("Cap on the source file, defaulted well under the ingest ceiling."),
  minDurationSeconds: z
    .number()
    .int()
    .nonnegative()
    .default(90)
    .describe("Skip anything shorter — Shorts and teasers have no spoken moment worth clipping."),
  maxDurationSeconds: z
    .number()
    .int()
    .positive()
    .default(3 * 3600)
    .describe("Skip anything longer; a multi-hour stream is a download the run cannot afford."),
});
export type HarvestVideoInput = z.infer<typeof HarvestVideoInputSchema>;

export interface HarvestVideoResult {
  /** Repo-relative, forward-slashed. */
  path: string;
  /** Where it came from — carried into the deliverable's source credit trail. */
  sourceUrl: string;
  title?: string;
  /** The uploader/channel the provider matched against `allowedSources` — the rights basis, spelled out for the human gate. */
  channel?: string;
  durationSeconds?: number;
  /** Which backend answered (`VideoHarvestProvider.name`). */
  provider: string;
}

/** Everything a provider needs to search within the client's rights scope and size cap. */
export interface VideoHarvestQuery {
  query: string;
  allowedSources: readonly string[];
  maxBytes: number;
  minDurationSeconds: number;
  maxDurationSeconds: number;
}

export interface VideoHarvestCandidate {
  sourceUrl: string;
  title?: string;
  channel?: string;
  durationSeconds?: number;
  /** Either a directly fetchable media URL the tool downloads with `fetch` … */
  mediaUrl?: string;
  /** … or the provider downloads itself (yt-dlp does): writes ONE file into `destDirAbs`, returns its absolute path. */
  download?: (destDirAbs: string) => Promise<{ path: string }>;
}

/** `candidate: null` is an honest "nothing to clip" and becomes `content_fail`; a provider that BROKE should throw instead, and becomes `tooling_error`. */
export type VideoHarvestFind = { candidate: VideoHarvestCandidate } | { candidate: null; reason: string };

/** The seam a backend implements. `createYtDlpHarvestProvider` is the in-repo one; tests inject fakes. */
export interface VideoHarvestProvider {
  readonly name: string;
  findVideo(q: VideoHarvestQuery): Promise<VideoHarvestFind>;
}

const VIDEO_MIME_EXTENSION: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mp4",
  "video/webm": ".webm",
};

/** The extensions a provider-written file may carry — the same two the fetch path accepts, so both branches hand downstream the same contract. */
const ACCEPTED_EXTENSIONS = new Set([".mp4", ".webm"]);

export function createHarvestVideo(options: { provider?: VideoHarvestProvider | undefined; fetchImpl?: typeof fetch } = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  return defineTool<HarvestVideoInput, HarvestVideoResult>({
    name: "media.harvestVideo",
    description:
      "Tier 2b of the clip cascade: finds contextual footage by topic, confined to the shows the client holds clipping rights to (`allowedSources`), and downloads it into the run cache. Reports not_available when no harvest provider is configured (VIDEO_HARVEST_PROVIDER), so the cascade always moves on to Tier 3 rather than holding.",
    version: TOOL_VERSION,
    inputSchema: HarvestVideoInputSchema,
    async execute(input) {
      const provider = options.provider;
      if (provider === undefined) {
        return notAvailable(
          "no video-harvest provider is wired for this deployment (set VIDEO_HARVEST_PROVIDER=yt-dlp) — the clip cascade's other tiers still work",
        );
      }

      const relDir = `${MEDIA_CACHE_PREFIX}/${input.runId}`;
      const absDir = path.resolve(input.repoRoot, relDir);
      const rootResolved = path.resolve(input.repoRoot);
      if (absDir !== rootResolved && !absDir.startsWith(rootResolved + path.sep)) {
        return contentFail(`media.harvestVideo: resolved cache dir escaped repoRoot (runId="${input.runId}")`);
      }

      let found: VideoHarvestFind;
      try {
        found = await provider.findVideo({
          query: input.query,
          allowedSources: input.allowedSources,
          maxBytes: input.maxBytes,
          minDurationSeconds: input.minDurationSeconds,
          maxDurationSeconds: input.maxDurationSeconds,
        });
      } catch (error) {
        return toolingError(`media.harvestVideo: provider "${provider.name}" failed to search — ${(error as Error).message}`);
      }
      if (found.candidate === null) {
        return contentFail(`media.harvestVideo: ${found.reason}`);
      }
      const candidate = found.candidate;
      await fs.mkdir(absDir, { recursive: true });

      let fileName: string;
      if (candidate.download !== undefined) {
        // The provider writes the file (yt-dlp merges streams itself). The
        // tool still verifies everything it would have verified on a fetch:
        // in-bounds, present, non-empty, under the cap, a video extension.
        let written: string;
        try {
          written = path.resolve((await candidate.download(absDir)).path);
        } catch (error) {
          return contentFail(`media.harvestVideo: the candidate at ${candidate.sourceUrl} did not download — ${(error as Error).message}`);
        }
        if (path.dirname(written) !== absDir) {
          return toolingError(`media.harvestVideo: provider "${provider.name}" wrote outside the run cache dir (${written})`);
        }
        const extension = path.extname(written).toLowerCase();
        if (!ACCEPTED_EXTENSIONS.has(extension)) {
          return contentFail(`media.harvestVideo: refused extension "${extension}" from ${candidate.sourceUrl} — refused, never guessed`);
        }
        let size: number;
        try {
          size = (await fs.stat(written)).size;
        } catch {
          return contentFail(`media.harvestVideo: the candidate at ${candidate.sourceUrl} reported a download but no file exists at ${written}`);
        }
        if (size === 0 || size > input.maxBytes) {
          await fs.rm(written, { force: true });
          return contentFail(`media.harvestVideo: candidate is ${size} bytes (cap ${input.maxBytes})`);
        }
        fileName = path.basename(written);
      } else if (candidate.mediaUrl !== undefined) {
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
        fileName = `harvested-clip${extension}`;
        await fs.writeFile(path.join(absDir, fileName), bytes);
      } else {
        return toolingError(`media.harvestVideo: provider "${provider.name}" returned a candidate with neither mediaUrl nor download`);
      }

      return success<HarvestVideoResult>({
        path: `${relDir}/${fileName}`,
        sourceUrl: candidate.sourceUrl,
        ...(candidate.title !== undefined ? { title: candidate.title } : {}),
        ...(candidate.channel !== undefined ? { channel: candidate.channel } : {}),
        ...(candidate.durationSeconds !== undefined ? { durationSeconds: candidate.durationSeconds } : {}),
        provider: provider.name,
      });
    },
  });
}
