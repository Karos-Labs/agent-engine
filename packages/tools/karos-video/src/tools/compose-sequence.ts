import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, toolingError } from "@agent-engine/tool-common";
import { resolveRuntime, type KarosVideoRuntime, type KarosVideoToolOptions } from "../config.js";
import { assertToolPath, probeDuration } from "./clip-compose.js";

// 1.1.0 (2026-09-10) — `move` per clip: a slow 6% push-in or pull-back paced
// over the clip's hold, on a 2x-oversampled frame so it does not shimmer.
// Every 2026-09-08/10 short played its stock shots dead still; a slow move
// under a spoken line is the cheapest thing that reads as filmed rather than
// assembled. Static by default; a clip without a hold cannot be paced and
// stays static whatever it asks.
const TOOL_VERSION = "1.1.0";

/** Total zoom of a `move` over the hold: 1.0 → 1.06. Light on purpose: a viewer should feel it, not see it. */
export const MOVE_ZOOM_SPAN = 0.06;
const OUTPUT_FPS = 30;

/**
 * `video.composeSequence` — N generated/cut plates → one 9:16 clip, with an
 * optional voiceover mixed over the plates' own (ducked) audio.
 *
 * Pure ffmpeg, the same reasoning as `clip-compose.ts`: the branded-shorts
 * Python engine is unvendored and configured nowhere, ffmpeg ships in the
 * agent-server image. Everything the tool decides about the media is decided
 * in {@link buildComposeSequenceArgs}, a pure function of the input and the
 * ffprobe results, so the exact graph is unit-tested without ffmpeg — the
 * discipline `buildBrandFrameFilter` set.
 *
 * ## Timing rules (what the graph encodes)
 *
 * - Every plate is normalised to the canvas (letterboxed on black, 30 fps,
 *   yuv420p, square pixels) so `concat` never sees mismatched streams — Veo
 *   plates and yt-dlp cuts arrive in whatever geometry they arrive in.
 * - `holdSeconds` pins a plate to an exact length: trimmed when longer,
 *   last-frame-frozen (`tpad=stop_mode=clone`) when shorter. Freezing rather
 *   than looping, because a 6s Veo plate looped to 8s visibly jumps.
 * - With a voiceover, the finished length is
 *   `max(voiceover + tailPadding, video)`: the video is frozen out to cover
 *   the speech plus a beat of silence, and the audio is padded out to cover
 *   the video, so neither ends before the other.
 * - The plates' own audio (Veo's ambient sound) sits under the voiceover at
 *   `ambientGainDb`. Plates without an audio stream contribute silence of
 *   their own length so the ambient track stays aligned to the picture.
 */

export const ComposeSequenceClipSchema = z.object({
  path: z.string().min(1).describe("Path to one plate (a generated or cut clip) in sequence order."),
  holdSeconds: z
    .number()
    .positive()
    .optional()
    .describe("Trim/extend this clip to exactly this many seconds (freeze the last frame if it is shorter). Absent means the clip's own length."),
  move: z
    .enum(["none", "push-in", "pull-back"])
    .default("none")
    .describe("A slow 6% zoom paced over the clip's holdSeconds: push-in grows, pull-back shrinks, none stays static. Needs holdSeconds; without one the clip stays static."),
});
export type ComposeSequenceClip = z.infer<typeof ComposeSequenceClipSchema>;

/**
 * The filter for one clip's `move`, or "" for none: the frame is oversampled
 * 2x, `zoompan` advances a constant zoom step per output frame (d=1: one
 * output frame per input frame, so `on` runs over the whole hold) and sizes
 * back to the canvas. Exported for the test.
 */
export function moveFilter(move: ComposeSequenceClip["move"], holdSeconds: number | undefined, w: number, h: number): string {
  if (move === "none" || holdSeconds === undefined) return "";
  const frames = Math.max(2, Math.round(holdSeconds * OUTPUT_FPS));
  const step = (MOVE_ZOOM_SPAN / (frames - 1)).toFixed(6);
  const span = (1 + MOVE_ZOOM_SPAN).toFixed(3);
  const zoom = move === "push-in" ? `min(1+on*${step},${span})` : `max(${span}-on*${step},1)`;
  return `,scale=${w * 2}:${h * 2},zoompan=z='${zoom}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${OUTPUT_FPS},setsar=1,format=yuv420p`;
}

export const ComposeSequenceInputSchema = z.object({
  clips: z.array(ComposeSequenceClipSchema).min(1).max(8).describe("The plates to concatenate, in order. 1 to 8."),
  outputPath: z.string().min(1).describe("Path to write the finished MP4 to."),
  voiceoverPath: z.string().min(1).optional().describe("An MP3/WAV voiceover (e.g. from video.synthesizeVoice) laid over the sequence. Absent means the clips' own audio, or silence."),
  ambientGainDb: z.number().max(0).default(-18).describe("Level of the clips' own audio under a voiceover, in dB (0 = untouched, -18 = ducked well under speech). Ignored without a voiceover."),
  canvas: z
    .object({ w: z.number().int().positive(), h: z.number().int().positive() })
    .default(() => ({ w: 1080, h: 1920 }))
    .describe("Output canvas size in pixels. Defaults to 1080x1920 (9:16)."),
  tailPaddingSeconds: z.number().min(0).max(3).default(0.4).describe("Silence after the voiceover ends before the video cuts."),
});
export type ComposeSequenceInput = z.infer<typeof ComposeSequenceInputSchema>;

/** What ffprobe told us about one input clip — the two facts the graph depends on. */
export interface ProbedClip {
  /** Container duration; null when ffprobe reported none (the graph then trusts `holdSeconds` or gives up on length arithmetic for that clip). */
  durationSeconds: number | null;
  hasAudio: boolean;
}

export interface ComposeSequenceProbe {
  /** One entry per `input.clips[i]`, same order. */
  clips: readonly ProbedClip[];
  /** The voiceover's duration; null when there is no voiceover or it could not be measured. */
  voiceoverDurationSeconds: number | null;
}

export interface ComposeSequenceResult {
  outputPath: string;
  durationSeconds: number | null;
  clipsUsed: number;
  hasVoiceover: boolean;
}

/** ffmpeg filter args want plain decimals, not `0.40000000000000002`. */
function secs(n: number): string {
  return String(Number(n.toFixed(3)));
}

/** One sample format for every audio leg, so `concat`/`amix` never negotiate between a mono Veo track and a stereo MP3. */
const AUDIO_FORMAT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
const SILENCE_SOURCE = "anullsrc=channel_layout=stereo:sample_rate=48000";

/**
 * The full ffmpeg argv for one composition — inputs, `-filter_complex`,
 * maps, encode settings, output. Pure: the only facts about the files it
 * uses are the ones in `probe`.
 */
export function buildComposeSequenceArgs(input: ComposeSequenceInput, probe: ComposeSequenceProbe): string[] {
  const { w, h } = input.canvas;
  const n = input.clips.length;
  const hasVoiceover = input.voiceoverPath !== undefined;
  const voIndex = n; // the voiceover, when present, is the input after the last clip

  const filters: string[] = [];
  const effective: Array<number | null> = [];

  // ── Video legs ──
  for (let i = 0; i < n; i++) {
    const clip = input.clips[i]!;
    const probed = probe.clips[i]?.durationSeconds ?? null;
    let chain =
      `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p`;
    if (clip.holdSeconds !== undefined) {
      chain += `,trim=duration=${secs(clip.holdSeconds)}`;
      if (probed !== null && probed < clip.holdSeconds) {
        chain += `,tpad=stop_mode=clone:stop_duration=${secs(clip.holdSeconds - probed)}`;
      }
    }
    // The move comes AFTER the hold is fixed, so a frozen tail keeps moving
    // and the zoom is paced over exactly the seconds the plate is on screen.
    chain += moveFilter(clip.move, clip.holdSeconds, w, h);
    filters.push(`[${i}:v]${chain}[v${i}]`);
    effective.push(clip.holdSeconds ?? probed);
  }
  const videoDuration = effective.every((d): d is number => d !== null) ? effective.reduce((sum, d) => sum + d, 0) : null;

  // ── Total length, when a voiceover sets it ──
  const voDuration = hasVoiceover ? probe.voiceoverDurationSeconds : null;
  const total = voDuration !== null ? (videoDuration !== null ? Math.max(voDuration + input.tailPaddingSeconds, videoDuration) : voDuration + input.tailPaddingSeconds) : null;
  const videoShortfall = total !== null && videoDuration !== null && total > videoDuration ? total - videoDuration : 0;

  const concatLabel = videoShortfall > 0 ? "[vcat]" : "[vout]";
  if (n === 1) {
    // No concat for a single plate — relabel its leg directly.
    filters[0] = filters[0]!.replace(/\[v0\]$/, concatLabel);
  } else {
    filters.push(`${input.clips.map((_, i) => `[v${i}]`).join("")}concat=n=${n}:v=1:a=0${concatLabel}`);
  }
  if (videoShortfall > 0) {
    // Padding the concatenated stream rather than the last leg: identical
    // output, and it composes with a `holdSeconds` tpad already on that leg.
    filters.push(`[vcat]tpad=stop_mode=clone:stop_duration=${secs(videoShortfall)}[vout]`);
  }

  // ── Ambient (the plates' own audio) ──
  // Buildable when at least one plate has audio and every silent plate has a
  // known length to fill with silence — otherwise the legs would misalign.
  const anyAudio = probe.clips.some((c) => c.hasAudio);
  const ambientOk = anyAudio && probe.clips.every((c, i) => c.hasAudio || effective[i] !== null);
  let ambientLabel: string | null = null;
  if (ambientOk) {
    for (let i = 0; i < n; i++) {
      const eff = effective[i] ?? null;
      if (probe.clips[i]!.hasAudio) {
        const fit = eff !== null ? `,atrim=duration=${secs(eff)},apad=whole_dur=${secs(eff)}` : "";
        filters.push(`[${i}:a]${AUDIO_FORMAT}${fit}[a${i}]`);
      } else {
        filters.push(`${SILENCE_SOURCE},atrim=duration=${secs(eff!)}[a${i}]`);
      }
    }
    // The ambient track is the final audio when there is no voiceover; under
    // one it is ducked and mixed, so it needs an intermediate label.
    ambientLabel = hasVoiceover ? "[amb]" : "[aout]";
    if (n === 1) {
      filters[filters.length - 1] = filters[filters.length - 1]!.replace(/\[a0\]$/, hasVoiceover ? "[acat]" : "[aout]");
    } else {
      filters.push(`${input.clips.map((_, i) => `[a${i}]`).join("")}concat=n=${n}:v=0:a=1${hasVoiceover ? "[acat]" : "[aout]"}`);
    }
    if (hasVoiceover) filters.push(`[acat]volume=${secs(input.ambientGainDb)}dB[amb]`);
  }

  // ── Voiceover / final audio ──
  let shortest = false;
  if (hasVoiceover) {
    // Pad to the agreed total when we know it; otherwise at least the tail.
    const pad = total !== null ? `apad=whole_dur=${secs(total)}` : `apad=pad_dur=${secs(input.tailPaddingSeconds)}`;
    filters.push(`[${voIndex}:a]${AUDIO_FORMAT},${pad}${ambientLabel ? "[vo]" : "[aout]"}`);
    if (ambientLabel) {
      // `normalize=0`: amix's default scales every input by 1/n, which would
      // halve the voiceover — the one thing this mix must not do.
      filters.push(`[vo]${ambientLabel}amix=inputs=2:duration=first:normalize=0[aout]`);
    }
  } else if (!ambientOk) {
    // No voiceover and no usable plate audio: a silent track, ended by the
    // video (`-shortest`) since anullsrc alone would run forever.
    filters.push(`${SILENCE_SOURCE}${videoDuration !== null ? `,atrim=duration=${secs(videoDuration)}` : ""}[aout]`);
    shortest = true;
  }

  return [
    "-y",
    ...input.clips.flatMap((c) => ["-i", c.path]),
    ...(hasVoiceover ? ["-i", input.voiceoverPath!] : []),
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    ...(shortest ? ["-shortest"] : []),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    // The SDR bitstream tags video.selfEvalGate verifies — same as brandFrame.
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

type MediaProbe = { ok: true; durationSeconds: number | null; hasAudio: boolean } | { ok: false; reason: string };

/**
 * Duration plus "is there an audio stream" in one ffprobe call — the second
 * fact decides whether the plate contributes ambient sound or silence, and
 * `probeDuration` alone cannot answer it.
 */
async function probeMedia(runtime: KarosVideoRuntime, filePath: string): Promise<MediaProbe> {
  const result = await runtime.runner(runtime.ffprobeBin, [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type",
    "-of",
    "json",
    filePath,
  ]);
  if (result.exitCode !== 0) {
    const tail = (result.stderr || result.stdout || "").trim().slice(-500);
    return { ok: false, reason: `ffprobe exited ${result.exitCode}${tail ? `: ${tail}` : ""}` };
  }
  try {
    const parsed = JSON.parse(result.stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
    const seconds = Number(parsed.format?.duration);
    return {
      ok: true,
      durationSeconds: Number.isFinite(seconds) ? seconds : null,
      hasAudio: (parsed.streams ?? []).some((s) => s.codec_type === "audio"),
    };
  } catch {
    return { ok: false, reason: "ffprobe output was not JSON" };
  }
}

/** `video.composeSequence` — see the module comment for the timing rules. */
export function createComposeSequence(options: KarosVideoToolOptions = {}) {
  const runtime = resolveRuntime(options);
  return defineTool<ComposeSequenceInput, ComposeSequenceResult>({
    name: "video.composeSequence",
    description:
      "Concatenates 1-8 plates onto one 9:16 canvas (letterboxed, 30fps), optionally holding each to an exact length, and lays a voiceover over the plates' ducked ambient audio — the picture is frozen out to cover the speech plus a tail of silence. Pure ffmpeg; fails only over ffprobe/ffmpeg themselves.",
    version: TOOL_VERSION,
    inputSchema: ComposeSequenceInputSchema,
    async execute(input, { ctx }) {
      // Every path through the tenant sandbox before anything is spawned.
      for (let i = 0; i < input.clips.length; i++) {
        await assertToolPath(runtime, ctx.clientSlug, input.clips[i]!.path, `clips[${i}].path`);
      }
      if (input.voiceoverPath !== undefined) await assertToolPath(runtime, ctx.clientSlug, input.voiceoverPath, "voiceoverPath");
      await assertToolPath(runtime, ctx.clientSlug, input.outputPath, "outputPath");

      // An unreadable INPUT is reported by name here rather than left to
      // ffmpeg's stderr tail, which names nothing usefully.
      const clips: ProbedClip[] = [];
      for (let i = 0; i < input.clips.length; i++) {
        const probed = await probeMedia(runtime, input.clips[i]!.path);
        if (!probed.ok) return toolingError(`video.composeSequence: clips[${i}] "${input.clips[i]!.path}" could not be probed: ${probed.reason}`);
        clips.push({ durationSeconds: probed.durationSeconds, hasAudio: probed.hasAudio });
      }
      let voiceoverDurationSeconds: number | null = null;
      if (input.voiceoverPath !== undefined) {
        const probed = await probeMedia(runtime, input.voiceoverPath);
        if (!probed.ok) return toolingError(`video.composeSequence: voiceoverPath "${input.voiceoverPath}" could not be probed: ${probed.reason}`);
        if (!probed.hasAudio) return toolingError(`video.composeSequence: voiceoverPath "${input.voiceoverPath}" has no audio stream`);
        voiceoverDurationSeconds = probed.durationSeconds;
      }

      await fs.mkdir(path.dirname(path.resolve(input.outputPath)), { recursive: true });
      const args = buildComposeSequenceArgs(input, { clips, voiceoverDurationSeconds });
      const result = await runtime.runner(runtime.ffmpegBin, args);
      if (result.exitCode !== 0) {
        const tail = (result.stderr || result.stdout || "").trim().slice(-2000);
        return toolingError(`video.composeSequence: ffmpeg exited ${result.exitCode}${tail ? `: ${tail}` : ""}`);
      }
      return success<ComposeSequenceResult>({
        outputPath: input.outputPath,
        durationSeconds: await probeDuration(runtime, input.outputPath).catch(() => null),
        clipsUsed: input.clips.length,
        hasVoiceover: input.voiceoverPath !== undefined,
      });
    },
  });
}
