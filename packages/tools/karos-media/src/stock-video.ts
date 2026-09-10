import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, notAvailable, toolingError } from "@agent-engine/tool-common";
import { MEDIA_CACHE_PREFIX } from "./find-images.js";
import { broadeningVariants } from "./quality.js";
import { DEFAULT_VISION_MODEL, stripCodeFence, type VisionAnalysisClient, type VisionPart } from "./visual-patterns.js";

// 1.0.0 — Pexels Videos as the clip pipeline's Tier 2c: real portrait
// footage, free to use, tried BEFORE Veo generation for an original short.
// 1.1.0 (2026-09-09) — `relevance`: a vision model scores the candidates'
// thumbnails against the beat's brief and narration and the best fit wins,
// where 1.0.0 took the shortest clip that cleared the length. The 2026-09-08
// prep renders showed why: "empty conference stage" returned a guitarist mid-
// solo, "empty boardroom" a tram window, because nothing ever looked.
const TOOL_VERSION = "1.1.0";

/** How many portrait, long-enough candidates per query are shown to the vision model. Each thumbnail is ~260 tokens; eight is about a tenth of a cent. */
const DEFAULT_RELEVANCE_CANDIDATES = 8;
/** A thumbnail under this score does not fit the beat; the next query variant is tried instead. */
const DEFAULT_RELEVANCE_MIN_SCORE = 6;
const THUMBNAIL_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;

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
  relevance: z
    .object({
      brief: z.string().min(1).max(600).describe("The beat's visual brief: the scene the clip should show."),
      narration: z.string().min(1).max(400).describe("What is being said over this clip. The clip has to make sense under these words."),
      minScore: z.number().min(1).max(10).default(DEFAULT_RELEVANCE_MIN_SCORE).describe("A candidate below this fit score is not used; the next query variant is tried."),
      candidates: z.number().int().min(2).max(12).default(DEFAULT_RELEVANCE_CANDIDATES).describe("How many candidates per query the vision model is shown."),
    })
    .optional()
    .describe(
      "When present and a vision backend is configured, the candidates' thumbnails are scored against the brief and narration and the best fit is downloaded, instead of the shortest clip that clears the length. Without a vision backend the tool behaves as 1.0.0 and says so in `relevanceNote`.",
    ),
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
  /** The vision model's fit score (1-10) for the chosen clip, when `relevance` was asked for and a backend answered. */
  relevanceScore?: number;
  /** The model's one-line reason, or why no scoring happened (no backend, scoring failed: the shortest clip was taken instead). */
  relevanceNote?: string;
  /** How many candidates the model was shown, across every query variant tried. */
  candidatesConsidered?: number;
}

export interface StockVideoOptions {
  /** `PEXELS_API_KEY`. Absent → `not_available`, never a construction throw. */
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** The same Vertex vision client `media.inspectImages` uses. Absent: `relevance` degrades to shortest-first with a note. */
  visionClient?: VisionAnalysisClient | undefined;
  visionModel?: string | undefined;
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
  /** Pexels' poster frame for the video, a JPEG URL — what the vision model is shown. */
  image?: unknown;
  user?: { name?: unknown } | undefined;
  video_files?: PexelsVideoFile[] | undefined;
}

/** What the vision model is asked for, per candidate. Parsed strictly; a malformed answer degrades to shortest-first rather than picking blind. */
const RelevanceResponseSchema = z.object({
  scores: z.array(z.object({ ref: z.string().min(1), score: z.number().min(0).max(10), reason: z.string().max(300).default("") })).min(1),
});

/** The scoring brief. Exported so the test pins what the model is asked, not just what it answered. */
export function buildRelevancePrompt(relevance: { brief: string; narration: string }, refs: readonly string[]): string {
  return [
    "You are a documentary editor choosing one stock clip to play under a line of voiceover in a vertical short. You are shown the poster frame of each candidate clip.",
    "",
    `What is said over this shot: "${relevance.narration}"`,
    `The scene the script asked for: ${relevance.brief}`,
    "",
    "Score every candidate 0-10 for how well the FRAME fits the words a viewer will hear over it, and would read as deliberate rather than random b-roll:",
    "- 9-10: the picture is exactly this scene, or a natural visual metaphor for the line.",
    "- 6-8: plausible under the line; the viewer would not notice a mismatch.",
    "- 0-5: unrelated, a different mood, a different world, a concert under a line about a boardroom.",
    "Subtract heavily for: legible text, logos or brand names in frame; a screenshot or interface; watermarks; anything that looks staged for a stock catalogue (thumbs up, handshake, pointing at charts); people looking into the camera.",
    "",
    `Candidate refs, in order: ${refs.join(", ")}.`,
    "Answer with JSON only, in exactly this shape:",
    '{ "scores": [ { "ref": "<ref>", "score": 0-10, "reason": "<one short line>" } ] }',
  ].join("\n");
}

async function fetchThumbnail(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<{ data: string; mimeType: string } | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!THUMBNAIL_TYPES.has(mimeType)) return undefined;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    return undefined;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_THUMBNAIL_BYTES) return undefined;
  return { data: bytes.toString("base64"), mimeType };
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
      let chosen: { video: PexelsVideo; file: { link: string; width: number; height: number }; query: string; score?: number; reason?: string } | undefined;
      /** Vision tokens spent scoring, summed across every query variant tried; undefined until the model is actually asked. */
      let usageTokens: { prompt: number; output: number } | undefined;
      let relevanceNote: string | undefined;
      let candidatesConsidered = 0;
      const scoring = input.relevance !== undefined && options.visionClient !== undefined ? { client: options.visionClient, model: options.visionModel ?? DEFAULT_VISION_MODEL, ...input.relevance } : undefined;
      if (input.relevance !== undefined && scoring === undefined) relevanceNote = "no vision backend configured; took the shortest clip that cleared the beat";
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
        const usable = rankStockVideos(body.videos ?? [], input.minDurationSeconds, input.excludeIds)
          .map((video) => ({ video, file: pickPortraitFile(video.video_files ?? []) }))
          .filter((c): c is { video: PexelsVideo; file: { link: string; width: number; height: number } } => c.file !== undefined);
        if (usable.length === 0) continue;
        if (scoring === undefined) {
          chosen = { ...usable[0]!, query };
          break;
        }

        // Show the model the poster frames, in the library's own relevance
        // order (Pexels ranks by query match; our shortest-first sort is a
        // download-size preference, not a quality one), and take the best
        // fit that clears the floor. Nothing over the floor on this query
        // means the next, broader variant is tried — a broader query with a
        // fitting frame beats a precise query with a wrong one.
        const pool = (body.videos ?? [])
          .map((video) => ({ video, file: pickPortraitFile(video.video_files ?? []) }))
          .filter((c): c is { video: PexelsVideo; file: { link: string; width: number; height: number } } => c.file !== undefined && usable.some((u) => u.video.id === c.video.id))
          .slice(0, scoring.candidates);
        const parts: VisionPart[] = [];
        const refs: string[] = [];
        const byRef = new Map<string, (typeof pool)[number]>();
        for (const candidate of pool) {
          const thumbnail = str(candidate.video.image);
          if (thumbnail === undefined) continue;
          const inline = await fetchThumbnail(fetchImpl, thumbnail, timeoutMs);
          if (inline === undefined) continue;
          const ref = `c${num(candidate.video.id)}`;
          refs.push(ref);
          byRef.set(ref, candidate);
          parts.push({ text: `Candidate ref: ${ref}` }, { inlineData: inline });
        }
        if (refs.length === 0) {
          relevanceNote = "no candidate thumbnail could be fetched; took the shortest clip that cleared the beat";
          chosen = { ...usable[0]!, query };
          break;
        }
        candidatesConsidered += refs.length;
        let scored: z.infer<typeof RelevanceResponseSchema> | undefined;
        try {
          const response = await scoring.client.models.generateContent({
            model: scoring.model,
            contents: [{ role: "user", parts: [{ text: buildRelevancePrompt(scoring, refs) }, ...parts] }],
            config: { responseMimeType: "application/json" },
          });
          usageTokens = {
            prompt: (usageTokens?.prompt ?? 0) + (response.usageMetadata?.promptTokenCount ?? 0),
            output: (usageTokens?.output ?? 0) + (response.usageMetadata?.candidatesTokenCount ?? 0),
          };
          const text = response.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
          scored = RelevanceResponseSchema.parse(JSON.parse(stripCodeFence(text)));
        } catch (error) {
          // A scoring failure is not a footage failure: the beat still gets a
          // real plate, the old way, and the note says the model never looked.
          relevanceNote = `relevance scoring failed (${(error as Error).message.slice(0, 160)}); took the shortest clip that cleared the beat`;
          chosen = { ...usable[0]!, query };
          break;
        }
        const best = scored.scores
          .filter((s) => byRef.has(s.ref))
          .sort((a, b) => b.score - a.score)[0];
        if (best !== undefined && best.score >= scoring.minScore) {
          chosen = { ...byRef.get(best.ref)!, query, score: best.score, reason: best.reason };
          break;
        }
        relevanceNote = `best fit for "${query}" scored ${best?.score ?? 0}/10, under the ${scoring.minScore} floor`;
      }
      if (!chosen) {
        return contentFail(
          scoring !== undefined && candidatesConsidered > 0
            ? `video.findStockClip: ${candidatesConsidered} portrait clip(s) matched "${input.query}" but none fit the beat (${relevanceNote ?? "no candidate cleared the relevance floor"})`
            : `video.findStockClip: no portrait clip of at least ${input.minDurationSeconds}s matched "${input.query}"`,
        );
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

      const result: FindStockClipResult = {
        path: `${relDir}/${fileName}`,
        pexelsId: num(chosen.video.id)!,
        durationSeconds: num(chosen.video.duration)!,
        width: chosen.file.width,
        height: chosen.file.height,
        sourceUrl: str(chosen.video.url) ?? `https://www.pexels.com/video/${num(chosen.video.id)}/`,
        photographer: str(chosen.video.user?.name) ?? "unknown",
        license: PEXELS_LICENSE,
        query: chosen.query,
        ...(chosen.score !== undefined ? { relevanceScore: chosen.score } : {}),
        ...(chosen.reason !== undefined ? { relevanceNote: chosen.reason } : relevanceNote !== undefined ? { relevanceNote } : {}),
        ...(candidatesConsidered > 0 ? { candidatesConsidered } : {}),
      };
      // The Pexels licence is free of charge, so the clip itself bills
      // nothing — the whole point of this tier. Without scoring there is no
      // usage row at all (the 1.0.0 contract).
      if (usageTokens === undefined) return success<FindStockClipResult>(result);
      // With scoring, the vision model's tokens, at the per-token rows
      // `media.inspectImages` bills against (a miss after scoring still
      // returns content_fail without them — that outcome carries no usage).
      return success<FindStockClipResult>(result, [
        { model: "gemini-2.5-flash-vision-analysis-input-token", unit: "input-token", quantity: usageTokens.prompt },
        { model: "gemini-2.5-flash-vision-analysis-output-token", unit: "output-token", quantity: usageTokens.output },
      ]);
    },
  });
}
