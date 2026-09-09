import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, toolingError } from "@agent-engine/tool-common";
import { resolveRuntime, type KarosVideoRuntime, type KarosVideoToolOptions } from "../config.js";
import { assertToolPath, probeDuration } from "./clip-compose.js";

const TOOL_VERSION = "1.0.0";

const AUDIO_FORMAT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

/**
 * `video.mixMusic` (2026-09-09): a music bed under a finished sequence.
 *
 * Every 2026-09-08 prep short played a synthetic voice over dead silence,
 * which is the second-loudest "this was made by a machine" signal after the
 * footage. A vertical short has a bed under the voice, always. This lays one:
 * the track is looped or trimmed to the picture's length, set at
 * `musicGainDb`, DUCKED under speech by a side-chain compressor keyed off the
 * clip's own audio (the voiceover), and faded out over the last
 * `fadeOutSeconds`. A silent clip (no audio stream) gets the bed alone, at
 * the same level, no ducking to do.
 *
 * Pure ffmpeg, video stream copied untouched (the sequence composer already
 * produced the encode contract; re-encoding it here would only cost quality).
 */
export const MixMusicInputSchema = z.object({
  videoPath: z.string().min(1).describe("The finished sequence (video + voiceover, or silent)."),
  musicPath: z.string().min(1).describe("The music track (mp3/m4a/wav). Looped when shorter than the picture, trimmed when longer."),
  outputPath: z.string().min(1).describe("Where to write the mixed MP4."),
  musicGainDb: z.number().max(0).min(-40).default(-16).describe("Level of the bed when nobody is speaking, in dB. -16 sits under a voice without disappearing."),
  duckRatio: z.number().min(1).max(20).default(6).describe("Side-chain compression ratio applied to the bed while the voice is above threshold. 6 = the bed drops well under speech and comes back between lines."),
  duckThreshold: z.number().min(0.001).max(1).default(0.03).describe("Linear amplitude of the voice above which the bed ducks."),
  fadeOutSeconds: z.number().min(0).max(5).default(1.2).describe("Fade the bed out over the last N seconds."),
});
export type MixMusicInput = z.infer<typeof MixMusicInputSchema>;

export interface MixMusicResult {
  outputPath: string;
  durationSeconds: number | null;
  /** Whether the bed was ducked under a voice (the clip had audio) or laid alone (it did not). */
  ducked: boolean;
}

/** ffmpeg filter args want plain decimals, not `0.40000000000000002`. */
function secs(n: number): string {
  return String(Number(n.toFixed(3)));
}

/**
 * The ffmpeg args for the mix. Exported pure for the test: input, the
 * picture's length, and whether it carries audio.
 */
export function buildMixMusicArgs(input: MixMusicInput, durationSeconds: number, videoHasAudio: boolean): string[] {
  const dur = secs(durationSeconds);
  const fadeStart = secs(Math.max(0, durationSeconds - input.fadeOutSeconds));
  const bed =
    `[1:a]${AUDIO_FORMAT},aloop=loop=-1:size=2147483647,atrim=duration=${dur},volume=${secs(input.musicGainDb)}dB` +
    (input.fadeOutSeconds > 0 ? `,afade=t=out:st=${fadeStart}:d=${secs(input.fadeOutSeconds)}` : "");
  const filters = videoHasAudio
    ? [
        `[0:a]${AUDIO_FORMAT},asplit=2[voice][key]`,
        `${bed}[bed]`,
        // The bed listens to the voice: down while a line is spoken, back up
        // between lines. `makeup=1` so the compressor never lifts the bed.
        `[bed][key]sidechaincompress=threshold=${secs(input.duckThreshold)}:ratio=${secs(input.duckRatio)}:attack=40:release=500:makeup=1[ducked]`,
        // `normalize=0`: amix's default scales every input by 1/n, which
        // would halve the voice — the one thing this mix must not do.
        `[voice][ducked]amix=inputs=2:duration=first:normalize=0[aout]`,
      ]
    : [`${bed}[aout]`];
  return [
    "-y",
    "-i",
    input.videoPath,
    "-i",
    input.musicPath,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "0:v",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    ...(videoHasAudio ? [] : ["-shortest"]),
    "-movflags",
    "+faststart",
    input.outputPath,
  ];
}

type MediaProbe = { ok: true; durationSeconds: number | null; hasAudio: boolean } | { ok: false; reason: string };

async function probeMedia(runtime: KarosVideoRuntime, filePath: string): Promise<MediaProbe> {
  const result = await runtime.runner(runtime.ffprobeBin, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", filePath]);
  if (result.exitCode !== 0) {
    const tail = (result.stderr || result.stdout || "").trim().slice(-500);
    return { ok: false, reason: `ffprobe exited ${result.exitCode}${tail ? `: ${tail}` : ""}` };
  }
  try {
    const parsed = JSON.parse(result.stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
    const seconds = Number(parsed.format?.duration);
    return { ok: true, durationSeconds: Number.isFinite(seconds) ? seconds : null, hasAudio: (parsed.streams ?? []).some((s) => s.codec_type === "audio") };
  } catch {
    return { ok: false, reason: "ffprobe output was not JSON" };
  }
}

export function createMixMusic(options: KarosVideoToolOptions = {}) {
  const runtime = resolveRuntime(options);
  return defineTool<MixMusicInput, MixMusicResult>({
    name: "video.mixMusic",
    description:
      "Lays a music bed under a finished clip: looped or trimmed to the picture, set at musicGainDb, side-chain ducked under the clip's own voice, faded out at the end. A silent clip gets the bed alone. Video stream copied, audio re-encoded. Fails only over ffmpeg/ffprobe.",
    version: TOOL_VERSION,
    inputSchema: MixMusicInputSchema,
    async execute(input, { ctx }) {
      await assertToolPath(runtime, ctx.clientSlug, input.videoPath, "videoPath");
      await assertToolPath(runtime, ctx.clientSlug, input.musicPath, "musicPath");
      await assertToolPath(runtime, ctx.clientSlug, input.outputPath, "outputPath");
      for (const [what, p] of [
        ["videoPath", input.videoPath],
        ["musicPath", input.musicPath],
      ] as const) {
        try {
          await fs.access(p);
        } catch {
          return toolingError(`video.mixMusic: cannot read ${what} ${p}`);
        }
      }
      const probe = await probeMedia(runtime, input.videoPath);
      if (!probe.ok) return toolingError(`video.mixMusic: could not probe ${input.videoPath}: ${probe.reason}`);
      if (probe.durationSeconds === null) return toolingError(`video.mixMusic: ${input.videoPath} reports no duration; the bed cannot be cut to length`);
      await fs.mkdir(path.dirname(path.resolve(input.outputPath)), { recursive: true });
      const result = await runtime.runner(runtime.ffmpegBin, buildMixMusicArgs(input, probe.durationSeconds, probe.hasAudio));
      if (result.exitCode !== 0) {
        const tail = (result.stderr || result.stdout || "").trim().slice(-2000);
        return toolingError(`video.mixMusic: ffmpeg exited ${result.exitCode}${tail ? `: ${tail}` : ""}`);
      }
      return success<MixMusicResult>({ outputPath: input.outputPath, durationSeconds: await probeDuration(runtime, input.outputPath), ducked: probe.hasAudio });
    },
  });
}
