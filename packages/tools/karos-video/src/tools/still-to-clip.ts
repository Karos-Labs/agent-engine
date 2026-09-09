import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, toolingError } from "@agent-engine/tool-common";
import { resolveRuntime, type KarosVideoToolOptions } from "../config.js";
import { assertToolPath, probeDuration } from "./clip-compose.js";

const TOOL_VERSION = "1.0.0";

/**
 * `video.stillToClip` (2026-09-09): one still image, held for a few seconds
 * with a slow push-in, as a 9:16 plate the sequence composer can take like
 * any other clip.
 *
 * This is the TikTok original short's LAST footage tier, replacing generated
 * video outright. A generated still costs $0.039 (`image.generate`,
 * gemini-2.5-flash-image); a generated 8-second clip cost $3.20 (Veo 3.1
 * Standard) and read as rendered anyway. A photograph with a gentle camera
 * move is what a documentary edit does when it has no footage of the thing,
 * and it is what a viewer accepts as a cutaway. The move is deliberately
 * small (about 8% over the hold) and constant-speed: a fast or eased zoom on
 * a still is the "Ken Burns template" tell.
 *
 * Pure ffmpeg, same encode contract as `video.composeSequence` (H.264, yuv420p,
 * 30 fps, bt709 tags) so `concat` never sees a mismatched stream. Silent — the
 * composer lays the voiceover under it.
 */
export const StillToClipInputSchema = z.object({
  imagePath: z.string().min(1).describe("Path to the still (PNG/JPEG/WebP)."),
  outputPath: z.string().min(1).describe("Path to write the MP4 plate to."),
  durationSeconds: z.number().min(1).max(15).describe("How long the plate holds."),
  canvas: z
    .object({ w: z.number().int().positive(), h: z.number().int().positive() })
    .default(() => ({ w: 1080, h: 1920 }))
    .describe("Output canvas in pixels. Defaults to 1080x1920 (9:16)."),
  move: z
    .enum(["push-in", "pull-back", "none"])
    .default("push-in")
    .describe("The camera move over the hold. `push-in` (default) zooms slowly into the centre; `pull-back` starts tight and opens; `none` holds the frame."),
  fps: z.number().int().min(24).max(60).default(30).describe("Output frame rate. 30 matches the composer's normalisation."),
});
export type StillToClipInput = z.infer<typeof StillToClipInputSchema>;

export interface StillToClipResult {
  outputPath: string;
  durationSeconds: number | null;
}

/** Total zoom over the hold: 1.0 → 1.08. Small on purpose; see the module comment. */
const ZOOM_SPAN = 0.08;

/**
 * The ffmpeg args for one plate. Exported for the test, which asserts the
 * filtergraph rather than spawning ffmpeg. `zoompan` works on the oversampled
 * frame (`scale` to 4x the canvas first) so the sub-pixel motion of a slow zoom
 * does not shimmer; `d` is the frame count of the hold, `z` advances a constant
 * step per frame and clamps at the span.
 */
export function buildStillToClipArgs(input: StillToClipInput): string[] {
  const { w, h } = input.canvas;
  const frames = Math.round(input.durationSeconds * input.fps);
  const step = ZOOM_SPAN / Math.max(1, frames - 1);
  const zoomExpr =
    input.move === "none"
      ? "1"
      : input.move === "push-in"
        ? `min(1+on*${step.toFixed(6)},${(1 + ZOOM_SPAN).toFixed(3)})`
        : `max(${(1 + ZOOM_SPAN).toFixed(3)}-on*${step.toFixed(6)},1)`;
  const filter = [
    // Cover the canvas: scale up so both dimensions reach 4x the canvas, then centre-crop to exactly 4x.
    `scale=${w * 4}:${h * 4}:force_original_aspect_ratio=increase`,
    `crop=${w * 4}:${h * 4}`,
    `zoompan=z='${zoomExpr}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${input.fps}`,
    "setsar=1",
    "format=yuv420p",
  ].join(",");
  return [
    "-y",
    "-loop",
    "1",
    "-framerate",
    String(input.fps),
    "-i",
    input.imagePath,
    "-vf",
    filter,
    "-t",
    String(Number(input.durationSeconds.toFixed(3))),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
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
    input.outputPath,
  ];
}

export function createStillToClip(options: KarosVideoToolOptions = {}) {
  const runtime = resolveRuntime(options);
  return defineTool<StillToClipInput, StillToClipResult>({
    name: "video.stillToClip",
    description:
      "Turns one still image into a silent 9:16 video plate held for a few seconds with a slow, constant push-in (or pull-back, or no move). The cheapest footage tier an original short has: a $0.04 generated still where a generated clip cost dollars. Same encode contract as video.composeSequence.",
    version: TOOL_VERSION,
    inputSchema: StillToClipInputSchema,
    async execute(input, { ctx }) {
      await assertToolPath(runtime, ctx.clientSlug, input.imagePath, "imagePath");
      await assertToolPath(runtime, ctx.clientSlug, input.outputPath, "outputPath");
      try {
        await fs.access(input.imagePath);
      } catch {
        return toolingError(`video.stillToClip: cannot read ${input.imagePath}`);
      }
      await fs.mkdir(path.dirname(path.resolve(input.outputPath)), { recursive: true });
      const result = await runtime.runner(runtime.ffmpegBin, buildStillToClipArgs(input));
      if (result.exitCode !== 0) {
        const tail = (result.stderr || result.stdout || "").trim().slice(-2000);
        return toolingError(`video.stillToClip: ffmpeg exited ${result.exitCode}${tail ? `: ${tail}` : ""}`);
      }
      return success<StillToClipResult>({ outputPath: input.outputPath, durationSeconds: await probeDuration(runtime, input.outputPath) });
    },
  });
}
