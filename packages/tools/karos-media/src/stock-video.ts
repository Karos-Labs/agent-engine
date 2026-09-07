import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, notAvailable, toolingError } from "@agent-engine/tool-common";
import { MEDIA_CACHE_PREFIX } from "./find-images.js";
import { broadeningVariants } from "./quality.js";

// 1.0.0 — Pexels Videos as the clip pipeline's Tier 2c: real portrait
// footage, free to use, tried BEFORE Veo generation for an original short.
const TOOL_VERSION = "1.0.0";

const PEXELS_VIDEO_ENDPOINT = "https://api.pexels.com/videos/search";
const PEXELS_LICENSE = "Pexels License — free for commercial use, no attribution required";
/** A Full-HD portrait clip of a few seconds is 5–30 MB; anything past this is not a plate. */
const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024;

/**
 * `video.findStockClip` — real footage for a beat, from Pexels' video library.
 *
 * Why this tier exists (2026-09-08): the visual QA on a Veo-generated original
 * short scored it 3/10, "obviously looks AI-generated" — paper with gibberish
 * text, plastic-looking leather, smoothed-over streets — and a reviewer said
 * the same in plainer words. Generated footage is the last resort for a
 * reason; a library of real clips shot by real people is the tier that was
 * missing between "the client's own footage" and "make some up". It also
 * costs nothing per second where Veo costs $0.40.
 *
 * Portrait only, by construction: the brand frame fills a 1080-wide picture
 * area and a landscape clip cropped to fill it is a slice of nothing. The
 * `excludeIds` list keeps one run from using the same clip for two beats.
 */
export const FindStockClipInputSchema = z.object({
  repoRoot: z.string().min(1).describe("Bounds root. The written clip path is relative to this and provably inside it."),
  runId: z.string().min(1).describe("Namespaces the cache directory, exactly as media.findImages does."),
  query: z.string().min(2).max(80).describe("What to search the library for: 2 to 5 plain nouns (`empty office desk night`), not a scene description."),
  minDurationSeconds: z.number().int().min(1).max(60).default(4).describe("The beat's length; a shorter clip would have to loop, which shows."),
  excludeIds: z.array(z.number().int()).max(50).default([]).describe("Library ids already used in this run, so two beats never show the same clip."),
  outputName: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default("stock-clip")
    .describe("File stem inside the run cache (`<outputName>.mp4`)."),
});
export type FindStockClipInput = z.infer<typeof FindStockClipInputSchema>;

export interface FindStockClipResult {
  /** Repo-relative, forward-slashed — the same contract every media tier's candidates use. */
  path: string;
  pexelsId: number;
  durationSeconds: number;
  width: number;
  height: number;
  /** The clip's page on Pexels, for the reviewer's provenance. */
  sourceUrl: string;
  photographer: string;
  license: string;
  /** The query that actually matched — the caller's, or a broadened variant of it. */
  query: string;
}

export interface StockVideoOptions {
  /** `PEXELS_API_KEY`. Absent → `not_available`, never a construction throw. */
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface PexelsVideoFile {
  id?: unknown;
  quality?: unknown;
  file_type?: unknown;
  width?: unknown;
  height?: unknown;
  link?: unknown;
}

interface PexelsVideo {
  id?: unknown;
  width?: unknown;
  height?: unknown;
  duration?: unknown;
  url?: unknown;
  user?: { name?: unknown } | undefined;
  video_files?: PexelsVideoFile[] | undefined;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/**
 * The one file of a video worth downloading: an mp4, portrait, at least
 * 1080 tall (the frame's picture area is 1080 wide, so anything smaller is
 * upscaled) and not 4K (a 4K plate is 5x the bytes for no visible gain on a
 * phone). Closest to 1920 tall wins.
 */
export function pickPortraitFile(files: readonly PexelsVideoFile[]): { link: string; width: number; height: number } | undefined {
  const candidates = files
    .map((f) => ({ link: str(f.link), width: num(f.width), height: num(f.height), type: str(f.file_type) }))
    .filter((f): f is { link: string; width: number; height: number; type: string } => f.link !== undefined && f.width !== undefined && f.height !== undefined)
    .filter((f) => (f.type ?? "video/mp4").includes("mp4") && f.height > f.width && f.height >= 1080 && f.height <= 2160)
    .sort((a, b) => Math.abs(a.height - 1920) - Math.abs(b.height - 1920));
  const best = candidates[0];
  return best ? { link: best.link, width: best.width, height: best.height } : undefined;
}

/**
 * Ranks the search hits: portrait, long enough, not already used — then the
 * SHORTEST that clears the beat (a 9-second clip for a 6-second beat is a
 * smaller download and less to trim than a 45-second one).
 */
export function rankStockVideos(videos: readonly PexelsVideo[], minDurationSeconds: number, excludeIds: readonly number[]): PexelsVideo[] {
  const excluded = new Set(excludeIds);
  return videos
    .filter((v) => {
      const id = num(v.id);
      const w = num(v.width);
      const h = num(v.height);
      const d = num(v.duration);
      return id !== undefined && !excluded.has(id) && w !== undefined && h !== undefined && h > w && d !== undefined && d >= minDurationSeconds;
    })
    .sort((a, b) => (num(a.duration) ?? 0) - (num(b.duration) ?? 0));
}

export function createFindStockClip(options: StockVideoOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;

  return defineTool<FindStockClipInput, FindStockClipResult>({
    name: "video.findStockClip",
    description:
      "Tier 2c of the clip pipeline's sourcing cascade: a real portrait clip from Pexels' free video library for a beat, tried before Veo generation. Reports not_available without PEXELS_API_KEY and content_fail when nothing portrait and long enough matches, so the cascade moves on rather than holding.",
    version: TOOL_VERSION,
    inputSchema: FindStockClipInputSchema,
    async execute(input) {
      const apiKey = options.apiKey?.trim();
      if (!apiKey) {
        return notAvailable("stock footage is not configured for this deployment (no PEXELS_API_KEY) — the clip pipeline's other tiers still work");
      }

      const relDir = `${MEDIA_CACHE_PREFIX}/${input.runId}`;
      const absDir = path.resolve(input.repoRoot, relDir);
      const rootResolved = path.resolve(input.repoRoot);
      if (absDir !== rootResolved && !absDir.startsWith(rootResolved + path.sep)) {
        return toolingError(`video.findStockClip: resolved cache dir escaped repoRoot (runId="${input.runId}")`);
      }

      // The caller's query first, then its broadened forms — a five-noun
      // query that matches nothing usually has a three-noun core that does.
      const variants = [input.query, ...broadeningVariants(input.query).filter((v) => v !== input.query)].slice(0, 3);
      let chosen: { video: PexelsVideo; file: { link: string; width: number; height: number }; query: string } | undefined;
      for (const query of variants) {
        const url = new URL(PEXELS_VIDEO_ENDPOINT);
        url.searchParams.set("query", query);
        url.searchParams.set("orientation", "portrait");
        url.searchParams.set("size", "medium");
        url.searchParams.set("per_page", "25");
        let response: Response;
        try {
          response = await fetchImpl(url, { headers: { Authorization: apiKey }, signal: AbortSignal.timeout(timeoutMs) });
        } catch (error) {
          return toolingError(`video.findStockClip: search failed for "${query}": ${(error as Error).message}`);
        }
        if (response.status === 401 || response.status === 403) {
          return toolingError(`video.findStockClip: Pexels rejected the API key (${response.status})`);
        }
        if (response.status === 429) {
          return toolingError("video.findStockClip: Pexels rate limit reached (429) — the plate falls through to generation");
        }
        if (!response.ok) {
          return toolingError(`video.findStockClip: search for "${query}" returned ${response.status}`);
        }
        let body: { videos?: PexelsVideo[] };
        try {
          body = (await response.json()) as { videos?: PexelsVideo[] };
        } catch (error) {
          return toolingError(`video.findStockClip: Pexels returned a non-JSON body for "${query}": ${(error as Error).message}`);
        }
        for (const video of rankStockVideos(body.videos ?? [], input.minDurationSeconds, input.excludeIds)) {
          const file = pickPortraitFile(video.video_files ?? []);
          if (file) {
            chosen = { video, file, query };
            break;
          }
        }
        if (chosen) break;
      }
      if (!chosen) {
        return contentFail(`video.findStockClip: no portrait clip of at least ${input.minDurationSeconds}s matched "${input.query}"`);
      }

      let download: Response;
      try {
        download = await fetchImpl(chosen.file.link, { signal: AbortSignal.timeout(Math.max(timeoutMs, 60_000)) });
      } catch (error) {
        return toolingError(`video.findStockClip: could not download the clip: ${(error as Error).message}`);
      }
      if (!download.ok) {
        return toolingError(`video.findStockClip: clip download returned ${download.status}`);
      }
      const declared = Number(download.headers.get("content-length") ?? "0");
      if (declared > MAX_DOWNLOAD_BYTES) {
        return contentFail(`video.findStockClip: the matched clip is ${Math.round(declared / 1_048_576)} MB, above the ${MAX_DOWNLOAD_BYTES / 1_048_576} MB plate ceiling`);
      }
      const bytes = Buffer.from(await download.arrayBuffer());
      if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
        return contentFail(`video.findStockClip: the matched clip is ${Math.round(bytes.byteLength / 1_048_576)} MB, above the ${MAX_DOWNLOAD_BYTES / 1_048_576} MB plate ceiling`);
      }
      await fs.mkdir(absDir, { recursive: true });
      const fileName = `${input.outputName}.mp4`;
      await fs.writeFile(path.join(absDir, fileName), bytes);

      // No `usage`: the Pexels licence is free of charge, so there is nothing
      // to bill — the whole point of trying this tier before Veo's $0.40/s.
      return success<FindStockClipResult>({
        path: `${relDir}/${fileName}`,
        pexelsId: num(chosen.video.id)!,
        durationSeconds: num(chosen.video.duration)!,
        width: chosen.file.width,
        height: chosen.file.height,
        sourceUrl: str(chosen.video.url) ?? `https://www.pexels.com/video/${num(chosen.video.id)}/`,
        photographer: str(chosen.video.user?.name) ?? "unknown",
        license: PEXELS_LICENSE,
        query: chosen.query,
      });
    },
  });
}
