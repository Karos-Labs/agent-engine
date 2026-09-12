import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, toolingError } from "@agent-engine/tool-common";
import { resolveRuntime, type KarosVideoToolOptions } from "../config.js";
import { assertToolPath, filterPath, hexToAss, hexToFfmpeg, probeDuration, sanitizeAssText, wrapOverlayText } from "./clip-compose.js";

// 1.0.1 — `fps` documented (the registry's description guard).
// 1.1.0 (2026-09-10) — the line is FITTED, never cut. 1.0.x wrapped at 18
// characters and dropped everything past the third line, so the cold-open
// hook of prep run pubsub-21157031361398626 ("Your AI tools saved you time.
// Nobody measured what that time built.") played as "…Nobody measured" for
// two seconds. Now a line that needs more than three lines at the full size
// is set smaller and wrapped wider, down to 65% of the size, and past that
// simply takes more lines. `fitPlateText` is exported for the test.
// 1.2.0 (2026-09-10) — `stat`: the plate as a STAT CARD, the number set at
// 2.5x the line size with its label under it, for a beat whose whole point is
// one figure ("47%"). The plan's phase 2 asked for a stat-card format through
// the branded-shorts Python engine; that engine is unvendored, and libass
// already sets any figure in any script, so the card is this tool with one
// more layout. `statLayout` is exported for the test.
const TOOL_VERSION = "1.2.0";

/** The figure of a stat card relative to the line size: big enough to be the picture, small enough for "$1,250,000" to fit. */
export const STAT_VALUE_SCALE = 2.5;

/** The ASS text of a stat card: the figure at STAT_VALUE_SCALE times the fitted label size, the label fitted under it. */
export function statLayout(stat: { value: string; label: string }, label: { text: string; fontSize: number }): string {
  const big = Math.round(label.fontSize * STAT_VALUE_SCALE);
  return `{\\fs${big}}${sanitizeAssText(stat.value)}{\\fs${label.fontSize}}\\N${label.text}`;
}

/** Characters per line at the full size: a 12-word hook is three lines. Scales with the size below. */
const BASE_WRAP_CHARS = 18;
/** How many lines the plate holds at a given size before the size comes down. */
const MAX_LINES_AT_SIZE = 3;
/** The sizes tried, largest first. The last one is kept whatever it needs. */
const FIT_SCALES: readonly number[] = [1, 0.85, 0.75, 0.65];

/**
 * The line wrapped to fit the plate: the full size when it makes three lines
 * or fewer, else the next size down with a proportionally wider wrap, and at
 * the smallest size as many lines as it takes. Every word survives.
 */
export function fitPlateText(text: string, fullFontSize: number): { text: string; fontSize: number; lines: number } {
  const clean = sanitizeAssText(text);
  let wrapped = "";
  let scale = 1;
  for (const s of FIT_SCALES) {
    scale = s;
    wrapped = wrapOverlayText(clean, Math.round(BASE_WRAP_CHARS / s), Number.POSITIVE_INFINITY);
    if (wrapped.split("\n").length <= MAX_LINES_AT_SIZE) break;
  }
  return { text: wrapped.replace(/\n/g, "\\N"), fontSize: Math.round(fullFontSize * scale), lines: wrapped.split("\n").length };
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/**
 * `video.textPlate` (2026-09-10): a beat's line as the picture.
 *
 * The free tier under every other tier. A short whose beat no library has
 * a clip for, and that may not buy a still (a client on `footageSource:
 * "stock"`, a plan the budget forced to stock only, a run at its ceiling),
 * used to HOLD there — the one place the original short still stopped a
 * run over footage. A text plate costs nothing and needs nothing: the
 * brand ground, a slow accent bar drawing across the bottom of the picture
 * over the hold, and the beat's on-screen line set large in the brand's
 * text colour, faded in. It is also a legitimate TikTok format on its own
 * (text-led shorts are a third of the platform), which is why it renders
 * through libass: any script, any direction, wrapped and centred.
 *
 * Pure ffmpeg from a `color` source, silent, on the composer's encode
 * contract (H.264, yuv420p, 30 fps, bt709), so `concat` takes it as a plate.
 */
export const TextPlateInputSchema = z.object({
  text: z.string().min(1).max(160).describe("The line to set, 1-14 words. Wrapped to fit: three lines at the full size, set smaller and wider when it needs more; never cut."),
  outputPath: z.string().min(1).describe("Path to write the MP4 plate to."),
  durationSeconds: z.number().min(1).max(15).describe("How long the plate holds."),
  ground: z.string().regex(HEX6).describe("Background colour, 6-digit hex (the brand ground)."),
  fg: z.string().regex(HEX6).default("#F4F2EC").describe("Text colour, 6-digit hex."),
  accent: z.string().regex(HEX6).optional().describe("A thin bar that draws across the lower third over the hold. Omit for none."),
  fontName: z.string().min(1).default("Liberation Sans").describe("fontconfig family. Name the script's own face (Noto Sans Hebrew, Noto Sans Arabic, …) for non-Latin text."),
  canvas: z
    .object({ w: z.number().int().positive(), h: z.number().int().positive() })
    .default(() => ({ w: 1080, h: 1920 }))
    .describe("Output canvas in pixels. Defaults to 1080x1920 (9:16)."),
  stat: z
    .object({ value: z.string().min(1).max(12).describe("The figure, as written: 47%, $2, 3 of 4."), label: z.string().min(1).max(60).describe("What the figure is, in a few words.") })
    .optional()
    .describe("Renders a STAT CARD instead of a plain line: the figure set at 2.5x the line size with the label under it. `text` still sets the fallback line and the wrap size."),
  fps: z.number().int().min(24).max(60).default(30).describe("Output frame rate. 30 matches the composer's normalisation."),
});
export type TextPlateInput = z.infer<typeof TextPlateInputSchema>;

export interface TextPlateResult {
  outputPath: string;
  durationSeconds: number | null;
}

/**
 * The libass script for the plate: one centred style (Alignment 5 = middle
 * centre), the line faded in over 350 ms, sized and wrapped by
 * `fitPlateText` so all of it is on the plate. Exported for the test.
 */
export function buildTextPlateAss(input: TextPlateInput): string {
  const { w, h } = input.canvas;
  const fit = fitPlateText(input.stat?.label ?? input.text, Math.round(h * 0.052));
  const fontSize = fit.fontSize;
  const text = input.stat !== undefined ? statLayout(input.stat, fit) : fit.text;
  const end = (() => {
    const s = input.durationSeconds;
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    const cs = Math.min(99, Math.round((s - Math.floor(s)) * 100));
    return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
  })();
  return (
    [
      "[Script Info]",
      "ScriptType: v4.00+",
      `PlayResX: ${w}`,
      `PlayResY: ${h}`,
      "WrapStyle: 0",
      "ScaledBorderAndShadow: yes",
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      `Style: Line,${input.fontName},${fontSize},${hexToAss(input.fg)},${hexToAss(input.fg)},&HFF000000,&HFF000000,-1,0,0,0,100,100,0,0,1,0,0,5,${Math.round(w * 0.09)},${Math.round(w * 0.09)},0,1`,
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      `Dialogue: 0,0:00:00.00,${end},Line,,0,0,0,,{\\fad(350,0)}${text}`,
    ].join("\n") + "\n"
  );
}

/** ffmpeg filter args want plain decimals, not `0.40000000000000002`. */
function secs(n: number): string {
  return String(Number(n.toFixed(3)));
}

/** The ffmpeg args for one plate, given where the ASS script was written. Exported for the test. */
export function buildTextPlateArgs(input: TextPlateInput, assPath: string): string[] {
  const { w, h } = input.canvas;
  const filters: string[] = [];
  if (input.accent !== undefined) {
    // A 6px bar in the lower third that draws left to right over the hold:
    // the one moving element, so the plate reads as video, not a slide.
    const y = Math.round(h * 0.72);
    filters.push(`drawbox=x=${Math.round(w * 0.09)}:y=${y}:w='min(t/${secs(input.durationSeconds)}\\,1)*${Math.round(w * 0.82)}':h=6:color=${hexToFfmpeg(input.accent)}:t=fill`);
  }
  filters.push(`subtitles='${filterPath(assPath)}'`, "format=yuv420p");
  return [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${hexToFfmpeg(input.ground)}:s=${w}x${h}:r=${input.fps}:d=${secs(input.durationSeconds)}`,
    "-vf",
    filters.join(","),
    "-t",
    secs(input.durationSeconds),
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

export function createTextPlate(options: KarosVideoToolOptions = {}) {
  const runtime = resolveRuntime(options);
  return defineTool<TextPlateInput, TextPlateResult>({
    name: "video.textPlate",
    description:
      "Renders a beat's line as a silent 9:16 video plate: the brand ground, the text set large and centred through libass (any script), faded in, with an optional accent bar drawing across over the hold. The free tier under stock footage and stills, and a text-led format in its own right. Fails only over ffmpeg.",
    version: TOOL_VERSION,
    inputSchema: TextPlateInputSchema,
    async execute(input, { ctx }) {
      await assertToolPath(runtime, ctx.clientSlug, input.outputPath, "outputPath");
      const outDir = path.dirname(path.resolve(input.outputPath));
      await fs.mkdir(outDir, { recursive: true });
      const assPath = path.join(outDir, `${path.basename(input.outputPath, path.extname(input.outputPath))}.ass`);
      await fs.writeFile(assPath, buildTextPlateAss(input), "utf8");
      const result = await runtime.runner(runtime.ffmpegBin, buildTextPlateArgs(input, assPath));
      if (result.exitCode !== 0) {
        const tail = (result.stderr || result.stdout || "").trim().slice(-2000);
        return toolingError(`video.textPlate: ffmpeg exited ${result.exitCode}${tail ? `: ${tail}` : ""}`);
      }
      return success<TextPlateResult>({ outputPath: input.outputPath, durationSeconds: await probeDuration(runtime, input.outputPath) });
    },
  });
}
