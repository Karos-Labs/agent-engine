import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ComposeSequenceInputSchema, LOUDNORM_FILTER, buildComposeSequenceArgs } from "../src/tools/compose-sequence.js";

/**
 * The one test in this package that RUNS ffmpeg.
 *
 * Every other compose-sequence test pins the filter graph as a string, and
 * a string is not a render: the first real voiced content-design short on
 * prep (run pubsub-21890159642627765, 17.9.2026) failed inside ffmpeg with
 * `Cannot select channel layout for the link between filters
 * Parsed_aresample_N and format_out_0_1` on a graph every string test
 * approved. The failing shape was ordinary — seven stock plates, one of them
 * carrying its own stereo AAC, a 24 kHz mono MP3 voiceover from TTS, and
 * `normalizeLoudness` on — and the failing link was the one leg no `aformat`
 * pinned: after `loudnorm`.
 *
 * This test builds exactly that shape from lavfi sources (no fixture files
 * to rot) and asks ffmpeg to encode it. It is skipped where ffmpeg is not
 * installed, and it says so, so a green run with no ffmpeg is never mistaken
 * for a verified render.
 */

function ffmpegAvailable(): boolean {
  return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
}

const HAS_FFMPEG = ffmpegAvailable();

describe.skipIf(!HAS_FFMPEG)("compose-sequence renders (real ffmpeg)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "compose-render-"));
    const ff = (args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "pipe" });
    // A plate with its own stereo AAC — the shape a stock clip with sound has.
    ff(["-f", "lavfi", "-i", "color=c=blue:s=270x480:r=30:d=1.2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:d=1.2",
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-ac", "2", "-shortest", path.join(dir, "with-audio.mp4")]);
    // A silent plate — a generated still or a muted stock clip.
    ff(["-f", "lavfi", "-i", "color=c=red:s=270x480:r=30:d=1.2", "-c:v", "libx264", "-preset", "ultrafast", "-an", path.join(dir, "silent.mp4")]);
    // The voiceover exactly as video.synthesizeVoice delivers it: mono, 24 kHz, 32 kb/s MP3.
    ff(["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=24000:d=2", "-ac", "1", "-ar", "24000", "-b:a", "32k", path.join(dir, "voice.mp3")]);
  });

  afterAll(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it("encodes a stereo-plate + silent-plate + mono-TTS voiceover graph with loudnorm on, end to end", () => {
    const input = ComposeSequenceInputSchema.parse({
      clips: [
        { path: path.join(dir, "with-audio.mp4"), holdSeconds: 1 },
        { path: path.join(dir, "silent.mp4"), holdSeconds: 1 },
      ],
      outputPath: path.join(dir, "out.mp4"),
      voiceoverPath: path.join(dir, "voice.mp3"),
      canvas: { w: 270, h: 480 },
      normalizeLoudness: true,
    });
    const args = buildComposeSequenceArgs(input, {
      clips: [{ durationSeconds: 1.2, hasAudio: true }, { durationSeconds: 1.2, hasAudio: false }],
      voiceoverDurationSeconds: 2,
    });
    const r = spawnSync("ffmpeg", ["-loglevel", "error", ...args], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);

    // What came out is what the graph promised: 48 kHz stereo AAC, the format
    // every leg was pinned to. A mono or 192 kHz track here would mean a pin
    // fell off somewhere after amix.
    const probe = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels", "-of", "csv=p=0", input.outputPath], { encoding: "utf8" }).trim();
    expect(probe).toBe("48000,2");
  }, 60_000);
});

describe("the loudnorm tail", () => {
  it("pins its own channel layout, because loudnorm's output link does not", () => {
    // Removing this is how the first real render died. The string tests
    // upstream assert the constant is used; this one asserts what it must say.
    expect(LOUDNORM_FILTER.startsWith("loudnorm=I=-16:TP=-1.5:LRA=11,")).toBe(true);
    expect(LOUDNORM_FILTER.endsWith(",aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo")).toBe(true);
  });
});
