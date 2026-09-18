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
// 1.2.0 (2026-09-15) — a plate shorter than its hold is SLOWED before it is
// frozen. `tpad=stop_mode=clone` held the last frame for the difference, and
// a frame that stops moving under a voice that keeps talking reads as a
// glitch; the visual QA lists "frozen frames" among the defects it fails a
// clip for, and it was our own graph producing them whenever a voice ran a
// little longer than the script had priced. Now the plate plays at up to
// `MAX_STRETCH` (1.35x slower) to cover the hold, which on library footage
// reads as deliberate slow motion, and only the remainder past that is
// frozen. Its own audio is `atempo`-stretched by the same factor so the
// ambient track stays on the picture. `normalizeLoudness` (off by default)
// ends the audio chain with an EBU R128 `loudnorm` to -16 LUFS: a TTS voice
// arrives at whatever level the vendor chose, and a short that is quieter
// than the one before it in a feed is a short that gets scrolled.
//
// 1.2.1: the loudnorm tail pins its channel layout (see LOUDNORM_FILTER). The
// 1.2.0 graph passed every string test and failed inside ffmpeg on the first
// real voiced render; nothing else in the graph changes.
const TOOL_VERSION = "1.2.1";

/** Total zoom of a `move` over the hold: 1.0 → 1.06. Light on purpose: a viewer should feel it, not see it. */
export const MOVE_ZOOM_SPAN = 0.06;
/**
 * The most a short plate is slowed to reach its hold before the last frame
 * is frozen for the rest. 1.35: at that factor a walking figure still walks
 * and a slow move still moves; past it footage reads as stuttering, and a
 * frozen tail is the lesser defect.
 */
export const MAX_STRETCH = 1.35;
/** A shortfall under this many seconds is not worth re-timing a plate over; the frozen tail is shorter than a frame is noticed. */
const MIN_STRETCH_SHORTFALL_SECONDS = 0.15;
const OUTPUT_FPS = 30;
/**
 * The loudness target for a finished short: streaming platforms normalise to
 * about -14 LUFS; -16 with a -1.5 dBTP ceiling leaves headroom for a music bed
 * laid on top afterwards.
 *
 * The trailing `aformat` is not decoration. `loudnorm` runs at 192 kHz
 * internally and hands the next filter a link whose channel layout the
 * ffmpeg 5.1 that ships in `node:22-slim` (Debian bookworm) leaves
 * unconstrained. `aresample=48000` on its own propagates that and the encoder's
 * output format then has nothing to choose from, and the whole render dies
 * with `Cannot select channel layout for the link between filters
 * Parsed_aresample_N and format_out_0_1` -- which is exactly how the first real
 * voiced content-design short on prep failed (run pubsub-21890159642627765,
 * 17.9.2026), $0.13 spent, nothing to deliver. Every leg BEFORE `amix` was
 * already pinned to stereo by `AUDIO_FORMAT`; the one leg after `loudnorm` was
 * not. Pinning it gives the negotiator a single answer on every ffmpeg version.
 * The unit tests pin this string against the exact graph; they cannot catch a
 * negotiation failure, because they never run ffmpeg -- see the render-fixture
 * test below for the one that does.
 */
export const LOUDNORM_FILTER = "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

/**
 * How a plate of `probed` seconds is fitted to `hold`: the slow-down factor
 * (1 when none) and the seconds still frozen after it. Exported for the test.
 */
export function stretchPlan(probed: number | null, hold: number | undefined): { factor: number; freezeSeconds: number } {
  if (hold === undefined || probed === null || probed <= 0 || probed >= hold) return { factor: 1, freezeSeconds: 0 };
  const shortfall = hold - probed;
  if (shortfall < MIN_STRETCH_SHORTFALL_SECONDS) return { factor: 1, freezeSeconds: Number(shortfall.toFixed(3)) };
  const wanted = hold / probed;
  const factor = Math.min(wanted, MAX_STRETCH);
  const covered = probed * factor;
  return { factor: Number(factor.toFixed(4)), freezeSeconds: Math.max(0, Number((hold - covered).toFixed(3))) };
}

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
 * - `holdSeconds` pins a plate to an exact length: trimmed when longer;
 *   when shorter, slowed by up to `MAX_STRETCH` (`setpts`, ahead of the fps
 *   filter) and only then last-frame-frozen (`tpad=stop_mode=clone`) for
 *   whatever the slow-down could not cover. Never looped: a 6s plate looped
 *   to 8s visibly jumps.
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
    .describe("Trim/extend this clip to exactly this many seconds (slow it down by up to 1.35x if it is shorter, then freeze the last frame for the rest). Absent means the clip's own length."),
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
  normalizeLoudness: z
    .boolean()
    .default(false)
    .describe("End the audio chain with an EBU R128 loudnorm to -16 LUFS / -1.5 dBTP, so a synthesized voice lands at a feed-consistent level. Off by default; a caller laying a music bed afterwards sets it here, before the bed."),
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
  /** Per clip, the slow-down applied to reach its hold (1 = none); the ambient leg below matches it. */
  const stretchFactors: number[] = [];
  for (let i = 0; i < n; i++) {
    const clip = input.clips[i]!;
    const probed = probe.clips[i]?.durationSeconds ?? null;
    const stretch = stretchPlan(probed, clip.holdSeconds);
    stretchFactors.push(stretch.factor);
    // A plate shorter than its hold is slowed FIRST (`setpts` ahead of the
    // fps filter, so the extra frames are spread evenly rather than
    // duplicated in a burst), and only what the slow-down cannot cover is
    // frozen. See `stretchPlan`.
    let chain =
      `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1` +
      (stretch.factor > 1 ? `,setpts=${secs(stretch.factor)}*PTS` : "") +
      `,fps=30,format=yuv420p`;
    if (clip.holdSeconds !== undefined) {
      chain += `,trim=duration=${secs(clip.holdSeconds)}`;
      if (stretch.freezeSeconds > 0) {
        chain += `,tpad=stop_mode=clone:stop_duration=${secs(stretch.freezeSeconds)}`;
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
        // A slowed plate's own sound is slowed with it (atempo takes the
        // reciprocal), so the ambient stays on the picture it belongs to.
        const factor = stretchFactors[i] ?? 1;
        const tempo = factor > 1 ? `,atempo=${secs(1 / factor)}` : "";
        const fit = eff !== null ? `,atrim=duration=${secs(eff)},apad=whole_dur=${secs(eff)}` : "";
        filters.push(`[${i}:a]${AUDIO_FORMAT}${tempo}${fit}[a${i}]`);
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

  // ── Loudness ──
  // Applied to whatever the final audio is, but only when there is something
  // to normalise: a silent track fed to loudnorm is a silent track plus a
  // warning, and the gain it would compute is meaningless.
  if (input.normalizeLoudness && (hasVoiceover || ambientOk)) {
    const last = filters.length - 1;
    filters[last] = filters[last]!.replace(/\[aout\]$/, "[apre]");
    filters.push(`[apre]${LOUDNORM_FILTER}[aout]`);
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
      "Concatenates 1-8 plates onto one 9:16 canvas (letterboxed, 30fps), optionally holding each to an exact length (a short plate is slowed up to 1.35x before its last frame is frozen), and lays a voiceover over the plates' ducked ambient audio — the picture is frozen out to cover the speech plus a tail of silence. Optionally loudness-normalises the result to -16 LUFS. Pure ffmpeg; fails only over ffprobe/ffmpeg themselves.",
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
