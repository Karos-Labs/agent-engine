import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, notAvailable, toolingError } from "@agent-engine/tool-common";
import { MEDIA_CACHE_PREFIX } from "./find-images.js";

// 1.1.0: the provider seam grew a `download` branch and the input grew a
// rights scope (`allowedSources`) and duration bounds; the first real
// backend (`createYtDlpHarvestProvider`) sits behind `VIDEO_HARVEST_PROVIDER`.
// 1.2.0 (2026-09-20, RFC-25): `discovery: "open"` lets the clipping agent
// search the open web for a podcast to clip, instead of refusing when the
// client's sourcePool names no shows. Defaults to `"allowlist"`, so no
// existing caller changes behaviour.
// 1.3.0 (2026-09-20, RFC-25 phase 4): `sourceUrl` resolves ONE page a person
// pasted, with no search at all. `media.ingestAssets` fetches an https:// URI
// as a direct file, so a watch page has never been something a client could
// hand this pipeline.
const TOOL_VERSION = "1.3.0";

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
 * ## Rights are an INPUT, and since RFC-25 the input has two settings
 *
 * A harvested clip is `licenseConfidence: "unknown"` whichever way it was
 * found — copyright stays with the original poster, and nothing here asserts
 * a right the system does not have.
 *
 * `discovery: "allowlist"` (the default, and the original behaviour) is the
 * stronger posture: the client holds clipping rights to specific shows (their
 * `tiktokClips.sourcePool`), those names travel in as `allowedSources`, and a
 * provider MUST confine its results to them. With none it refuses rather than
 * searching the open web.
 *
 * `discovery: "open"` searches anyway, and it exists because the owner
 * weighed the exposure on 2026-09-20 and chose reach — see
 * `docs/RFC-25-tiktok-clipping-sources.md`, which is there precisely so this
 * does not read as a regression of the paragraph above. It is a REVERSIBLE
 * decision: a client with a `sourcePool` still takes the allowlist path, and
 * setting one restores the old behaviour for that client with no code change.
 *
 * What did not change, and is the protection that was always doing the work:
 * every clip reaches a human at `11-clip-review` before anything is
 * published, the caption must carry an explicit source credit (checked in
 * code, not asked of the model), and `sourceUrl`/`channel`/`discovery` are
 * carried through so the reviewer sees exactly how this footage was found.
 */

export const HarvestVideoInputSchema = z.object({
  repoRoot: z.string().min(1).describe("Bounds root. The written clip path is relative to this and provably inside it."),
  runId: z.string().min(1).describe("Namespaces the cache directory, exactly as media.findImages does."),
  query: z.string().min(1).max(400).describe("What to look for — the run's topic/angle. Ignored when `sourceUrl` is given."),
  sourceUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "A page a person pasted (a YouTube watch URL, a podcast episode page). Given this, the tool resolves and downloads THAT video and never searches: `query`, `allowedSources` and `discovery` are all ignored. The duration bounds still apply, because a three-hour stream is a download the run cannot afford whoever chose it.",
    ),
  allowedSources: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Show/channel names the client holds clipping rights to (their `tiktokClips.sourcePool`). Under `discovery: \"allowlist\"` a provider MUST restrict results to these; with none it refuses. Ignored under `discovery: \"open\"`.",
    ),
  discovery: z
    .enum(["allowlist", "open"])
    .default("allowlist")
    .describe(
      "How to find a video. `allowlist` (default) searches only within `allowedSources` and refuses when there are none — the stronger rights posture. `open` searches the whole provider for the query, for a client with no sourcePool of their own (RFC-25, owner ruling 2026-09-20). Either way the clip is `licenseConfidence: \"unknown\"` and a human approves it before anything ships.",
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
  /** How this video was found. On the reviewer's payload because "we searched the open web for this" is a fact about the clip, not an implementation detail. */
  discovery: "allowlist" | "open" | "pasted";
}

/** Everything a provider needs to search within the client's rights scope and size cap. */
export interface VideoHarvestQuery {
  query: string;
  allowedSources: readonly string[];
  /** `allowlist` confines results to `allowedSources` and refuses with none; `open` searches everything. See the module comment. */
  discovery: "allowlist" | "open";
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
  /**
   * Resolve ONE page into a downloadable candidate — no search (RFC-25 phase 4).
   *
   * Optional on the seam: a provider that cannot do this is not broken, it
   * simply has no way to turn a page into a video, and the tool reports that
   * rather than pretending the paste failed for a content reason.
   */
  resolveUrl?(sourceUrl: string, q: Pick<VideoHarvestQuery, "maxBytes" | "minDurationSeconds" | "maxDurationSeconds">): Promise<VideoHarvestFind>;
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
        if (input.sourceUrl !== undefined) {
          if (provider.resolveUrl === undefined) {
            return notAvailable(`media.harvestVideo: provider "${provider.name}" cannot resolve a pasted page into a video`);
          }
          found = await provider.resolveUrl(input.sourceUrl, {
            maxBytes: input.maxBytes,
            minDurationSeconds: input.minDurationSeconds,
            maxDurationSeconds: input.maxDurationSeconds,
          });
        } else {
          found = await provider.findVideo({
          query: input.query,
          allowedSources: input.allowedSources,
          discovery: input.discovery,
          maxBytes: input.maxBytes,
          minDurationSeconds: input.minDurationSeconds,
            maxDurationSeconds: input.maxDurationSeconds,
          });
        }
      } catch (error) {
        return toolingError(`media.harvestVideo: provider "${provider.name}" failed to ${input.sourceUrl !== undefined ? "resolve the pasted page" : "search"} — ${(error as Error).message}`);
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
        discovery: input.sourceUrl !== undefined ? "pasted" : input.discovery,
      });
    },
  });
}
