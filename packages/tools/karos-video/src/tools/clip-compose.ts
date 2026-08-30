import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, toolingError } from "@agent-engine/tool-common";
import { resolveRuntime, type KarosVideoToolOptions } from "../config.js";
import { assertNoTraversalOrNul, assertWithinTenantWorkRoot } from "../sandbox.js";

const TOOL_VERSION = "1.0.0";

/**
 * The pure-ffmpeg clip pipeline: `video.cutClip` and `video.brandFrame`.
 *
 * Deliberately INDEPENDENT of the branded-shorts Python engine
 * (`BRANDED_SHORTS_ENGINE_DIR`): that engine is an unvendored external
 * checkout that no deployment configures, so every tool that shells into it
 * returns `tooling_error` in prep and prod today. A clip agent whose whole
 * guarantee is "zero-held, degrade never fail" cannot stand on it. ffmpeg,
 * by contrast, ships in the agent-server image (`apps/agent-server/
 * Dockerfile` installs it alongside python3), so this pair works everywhere
 * the server runs.
 *
 * Every branded element in `video.brandFrame` is OPTIONAL and skipped when
 * absent — a missing logo, an unset series header, no caption file — the
 * same "brand furniture must never be able to hold a run" rule
 * `downloadBrandLogo`'s doc comment states for slides. The tool only fails
 * over ffmpeg itself.
 */

/** Exactly 6 hex digits — ffmpeg color syntax is built from this, so anything looser is refused, never coerced. */
const HEX6 = /^#[0-9a-fA-F]{6}$/;

/**
 * drawtext-safe text: no quotes, colons, backslashes, or percent signs —
 * the characters that carry meaning inside an ffmpeg filtergraph. Stripped,
 * not escaped: a series header or an @handle that loses a stray colon is
 * still itself; a broken filtergraph is a failed render.
 */
export function sanitizeOverlayText(text: string): string {
  return text.replace(/[^A-Za-z0-9 @#&+.,|_\-!?]/g, "").trim().slice(0, 60);
}

/** `#RRGGBB` → ffmpeg's `0xRRGGBB`. */
export function hexToFfmpeg(hex: string): string {
  return `0x${hex.slice(1)}`;
}

/** Breathing room between the mark and the edge of its legibility plate, in output pixels. */
const LOGO_SCRIM_PAD = 16;

export interface SrtWord {
  word: string;
  start: number;
  end: number;
}

function formatSrtTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/**
 * Word-level transcript → SRT, grouped a few words per cue so captions read
 * as phrases rather than a strobing single word. `clipStartSeconds` shifts
 * source-relative timestamps to clip-relative ones — the words come from the
 * FULL episode's transcript, the captions burn onto the CUT clip.
 */
export function buildSrt(words: readonly SrtWord[], clipStartSeconds = 0, wordsPerCue = 4): string {
  const cues: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerCue) {
    const group = words.slice(i, i + wordsPerCue);
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const start = first.start - clipStartSeconds;
    const end = Math.max(last.end - clipStartSeconds, start + 0.2);
    cues.push(`${cues.length + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${group.map((w) => w.word).join(" ").trim()}`);
  }
  return cues.join("\n\n") + (cues.length > 0 ? "\n" : "");
}

/** The brand inputs `video.brandFrame` composites. Everything optional except the ground color the bars are painted in. */
export const BrandFrameBrandSchema = z.object({
  ground: z.string().regex(HEX6).describe("Bar/padding color, 6-digit hex."),
  fg: z.string().regex(HEX6).default("#F4F2EC").describe("Text color for the header and handle, 6-digit hex."),
  accent: z.string().regex(HEX6).optional().describe("The thin accent rule along each bar's inner edge, 6-digit hex."),
  logoPath: z
    .string()
    .min(1)
    .optional()
    .describe("Local PNG/JPEG path (the caller downloads it — e.g. via downloadBrandLogo — this tool never fetches)."),
  logoScrim: z
    .string()
    .regex(HEX6)
    .optional()
    .describe(
      "A legibility plate painted behind the logo, 6-digit hex. The caller sets it when the mark's own colors do not clear WCAG 3:1 against `ground` — see `planBrandLogoPlacement` in karos-media, which computes that ratio from the mark's decoded pixels. Absent means the mark already clears the floor on the bar, or that there is no logo; this tool never decides legibility for itself.",
    ),
  seriesHeader: z.string().min(1).max(60).optional().describe('"PITCH SCHOOL | LESSON 15"-style standing header, top bar.'),
  handle: z.string().min(1).max(48).optional().describe('"@clienthandle" watermark, bottom bar.'),
});
export type BrandFrameBrand = z.infer<typeof BrandFrameBrandSchema>;

export const BrandFrameInputSchema = z.object({
  // No existing TSDoc on these two fields to transcribe (SCRUM-293 flag) — synthesized from execute()'s usage.
  videoPath: z.string().min(1).describe("Path to the source clip to composite the branded frame onto."),
  outputPath: z.string().min(1).describe("Path to write the finished, branded clip to."),
  brand: BrandFrameBrandSchema.describe("The brand inputs to composite — everything optional except the ground color the bars are painted in."),
  srtPath: z.string().min(1).optional().describe("SRT file to burn as captions. Absent means no captions."),
  canvas: z
    .object({ w: z.number().int().positive(), h: z.number().int().positive() })
    .default(() => ({ w: 1080, h: 1920 }))
    .describe("Output canvas size in pixels. Defaults to 1080x1920 (9:16)."),
  barHeight: z.number().int().positive().default(200).describe("Bar height in pixels, top and bottom."),
});
export type BrandFrameInput = z.infer<typeof BrandFrameInputSchema>;

/**
 * Builds the single `-filter_complex` graph — exported pure so the exact
 * graph is unit-tested without ffmpeg. The video is scaled into the region
 * between the bars, padded in the brand ground, then text/logo/captions
 * composite on top.
 */
export function buildBrandFrameFilter(input: BrandFrameInput): string {
  const { w, h } = input.canvas;
  const bar = input.barHeight;
  const inner = h - 2 * bar;
  const ground = hexToFfmpeg(input.brand.ground);
  const fg = hexToFfmpeg(input.brand.fg);
  const hasLogo = input.brand.logoPath !== undefined;

  const filters: string[] = [
    // Scale into the region between the bars, pad in the brand ground, then
    // pad again to the full canvas with a top offset — that second pad IS
    // the top and bottom bars, always painted, whatever else is absent.
    `scale=${w}:${inner}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${inner}:(ow-iw)/2:(oh-ih)/2:color=${ground},` +
      `pad=${w}:${h}:0:${bar}:color=${ground},format=yuv420p`,
  ];

  if (input.brand.accent !== undefined) {
    const accent = hexToFfmpeg(input.brand.accent);
    filters.push(`drawbox=x=0:y=${bar - 6}:w=${w}:h=6:color=${accent}:t=fill`);
    filters.push(`drawbox=x=0:y=${h - bar}:w=${w}:h=6:color=${accent}:t=fill`);
  }
  if (input.brand.seriesHeader !== undefined) {
    const text = sanitizeOverlayText(input.brand.seriesHeader);
    if (text.length > 0) {
      filters.push(`drawtext=text='${text}':fontcolor=${fg}:fontsize=44:x=(w-text_w)/2:y=${Math.round(bar / 2)}-text_h/2`);
    }
  }
  if (input.brand.handle !== undefined) {
    const text = sanitizeOverlayText(input.brand.handle);
    if (text.length > 0) {
      filters.push(`drawtext=text='${text}':fontcolor=${fg}:fontsize=36:x=(w-text_w)/2:y=${h - bar}+${Math.round(bar / 2)}-text_h/2`);
    }
  }
  if (input.srtPath !== undefined) {
    // Forward slashes always: the subtitles filter parses backslashes as
    // escapes even on Windows, and Linux (production) only ever sees them.
    const srt = input.srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
    filters.push(`subtitles='${srt}'`);
  }

  const base = `[0:v]${filters.filter((f) => f.length > 0).join(",")}`;
  if (!hasLogo) return `${base}[out]`;
  // The logo is a second input, scaled to sit inside the top bar and
  // overlaid at the start-side corner (`h` in overlay expressions is the
  // OVERLAID input's height).
  //
  // AU38 (SCRUM-322): when the caller's contrast plan says the mark would
  // disappear into the bar, `logoScrim` is the plate it verified the mark
  // DOES clear. It is applied as a `pad` around the scaled mark rather than
  // a separate `drawbox`, because the mark's scaled width is only known
  // inside the filter graph — a drawbox would need a width nobody has yet.
  const logoHeight = Math.round(bar * 0.55);
  const scrim = input.brand.logoScrim;
  const logoChain =
    scrim === undefined
      ? `[1:v]scale=-1:${logoHeight}[logo]`
      : `[1:v]scale=-1:${logoHeight},pad=iw+${2 * LOGO_SCRIM_PAD}:ih+${2 * LOGO_SCRIM_PAD}:${LOGO_SCRIM_PAD}:${LOGO_SCRIM_PAD}:color=${hexToFfmpeg(scrim)}[logo]`;
  return `${base}[framed];${logoChain};[framed][logo]overlay=48:${Math.round(bar / 2)}-h/2[out]`;
}

/** ffprobe duration of a finished file — the same probe `selfEvalGate` trusts. */
async function probeDuration(runtime: ReturnType<typeof resolveRuntime>, filePath: string): Promise<number | null> {
  const result = await runtime.runner(runtime.ffprobeBin, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    filePath,
  ]);
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { format?: { duration?: string } };
    const seconds = Number(parsed.format?.duration);
    return Number.isFinite(seconds) ? seconds : null;
  } catch {
    return null;
  }
}

async function assertToolPath(runtime: ReturnType<typeof resolveRuntime>, clientSlug: string, candidate: string, what: string): Promise<void> {
  if (runtime.workRoot) {
    await assertWithinTenantWorkRoot(runtime.workRoot, clientSlug, candidate, what);
  } else {
    assertNoTraversalOrNul(candidate, what);
  }
}

export const CutClipInputSchema = z.object({
  // No existing TSDoc on these fields to transcribe (SCRUM-293 flag) — synthesized from execute()'s usage.
  sourcePath: z.string().min(1).describe("Path to the source video file to cut a clip from."),
  startSeconds: z.number().nonnegative().describe("Start of the [start, end) span to cut, in seconds from the start of the source."),
  endSeconds: z.number().positive().describe("End of the [start, end) span to cut, in seconds from the start of the source; must be after startSeconds."),
  outputPath: z.string().min(1).describe("Path to write the re-encoded cut clip to."),
});
export type CutClipInput = z.infer<typeof CutClipInputSchema>;

export interface CutClipResult {
  outputPath: string;
  durationSeconds: number | null;
}

/** `video.cutClip` — one re-encoded cut of `[start, end)` from a source file. Re-encode, not stream copy: a copy cut lands on the previous keyframe and ships seconds of the wrong sentence. */
export function createCutClip(options: KarosVideoToolOptions = {}) {
  const runtime = resolveRuntime(options);
  return defineTool<CutClipInput, CutClipResult>({
    name: "video.cutClip",
    description:
      "One re-encoded cut of [start, end) from a source file. Re-encode, not stream copy: a copy cut lands on the previous keyframe and ships seconds of the wrong sentence.",
    version: TOOL_VERSION,
    inputSchema: CutClipInputSchema,
    async execute({ sourcePath, startSeconds, endSeconds, outputPath }, { ctx }) {
      if (endSeconds <= startSeconds) {
        return toolingError(`video.cutClip: endSeconds (${endSeconds}) must be after startSeconds (${startSeconds})`);
      }
      await assertToolPath(runtime, ctx.clientSlug, sourcePath, "sourcePath");
      await assertToolPath(runtime, ctx.clientSlug, outputPath, "outputPath");
      await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });

      const args = [
        "-y",
        "-ss",
        String(startSeconds),
        "-to",
        String(endSeconds),
        "-i",
        sourcePath,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        outputPath,
      ];
      const result = await runtime.runner(runtime.ffmpegBin, args);
      if (result.exitCode !== 0) {
        const tail = (result.stderr || result.stdout || "").trim().slice(-2000);
        return toolingError(`video.cutClip: ffmpeg exited ${result.exitCode}${tail ? `: ${tail}` : ""}`);
      }
      return success<CutClipResult>({ outputPath, durationSeconds: await probeDuration(runtime, outputPath) });
    },
  });
}

export interface BrandFrameResult {
  outputPath: string;
  durationSeconds: number | null;
  /** Which brand elements actually composited — so a trace can answer "why is there no logo on this clip". */
  applied: string[];
}

/** `video.brandFrame` — the branded 9:16 frame: bars, header, handle, logo, captions, all optional. */
export function createBrandFrame(options: KarosVideoToolOptions = {}) {
  const runtime = resolveRuntime(options);
  return defineTool<BrandFrameInput, BrandFrameResult>({
    name: "video.brandFrame",
    description:
      "Composites the branded 9:16 frame onto a clip: bars, header, handle, logo, captions, all optional — a missing logo, an unset series header, or no caption file is skipped, never a failure. The tool only fails over ffmpeg itself.",
    version: TOOL_VERSION,
    inputSchema: BrandFrameInputSchema,
    async execute(input, { ctx }) {
      await assertToolPath(runtime, ctx.clientSlug, input.videoPath, "videoPath");
      await assertToolPath(runtime, ctx.clientSlug, input.outputPath, "outputPath");
      // A logo whose file is not actually readable is SKIPPED, not fatal —
      // brand furniture never holds a run.
      let brand = input.brand;
      if (brand.logoPath !== undefined) {
        const readable = await fs
          .access(brand.logoPath)
          .then(() => true)
          .catch(() => false);
        if (!readable) brand = { ...brand, logoPath: undefined } as BrandFrameBrand;
      }
      if (input.srtPath !== undefined) {
        const readable = await fs
          .access(input.srtPath)
          .then(() => true)
          .catch(() => false);
        if (!readable) input = { ...input, srtPath: undefined };
      }
      const effective: BrandFrameInput = { ...input, brand };
      await fs.mkdir(path.dirname(path.resolve(input.outputPath)), { recursive: true });

      const filter = buildBrandFrameFilter(effective);
      const args = [
        "-y",
        "-i",
        effective.videoPath,
        ...(brand.logoPath !== undefined ? ["-i", brand.logoPath] : []),
        "-filter_complex",
        filter,
        "-map",
        "[out]",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-c:a",
        "aac",
        // The SDR bitstream tags video.selfEvalGate verifies — the same
        // "orange renders as red" HLG fix build_short.py carries.
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
        "-movflags",
        "+faststart",
        effective.outputPath,
      ];
      const result = await runtime.runner(runtime.ffmpegBin, args);
      if (result.exitCode !== 0) {
        const tail = (result.stderr || result.stdout || "").trim().slice(-2000);
        return toolingError(`video.brandFrame: ffmpeg exited ${result.exitCode}${tail ? `: ${tail}` : ""}`);
      }
      const applied = [
        "bars",
        ...(brand.accent !== undefined ? ["accent-rules"] : []),
        ...(brand.seriesHeader !== undefined ? ["series-header"] : []),
        ...(brand.handle !== undefined ? ["handle"] : []),
        ...(brand.logoPath !== undefined ? ["logo"] : []),
        ...(brand.logoPath !== undefined && brand.logoScrim !== undefined ? ["logo-scrim"] : []),
        ...(effective.srtPath !== undefined ? ["captions"] : []),
      ];
      return success<BrandFrameResult>({
        outputPath: effective.outputPath,
        durationSeconds: await probeDuration(runtime, effective.outputPath),
        applied,
      });
    },
  });
}
