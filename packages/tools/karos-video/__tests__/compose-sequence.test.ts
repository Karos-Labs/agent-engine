import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ComposeSequenceInputSchema,
  buildComposeSequenceArgs,
  createComposeSequence,
  type ComposeSequenceProbe,
  type ComposeSequenceResult,
} from "../src/tools/compose-sequence.js";
import type { ProcessRunner } from "../src/process/runner.js";
import { ctx } from "./test-helpers.js";

/**
 * The graph is the product here. `buildComposeSequenceArgs` is pure — input
 * plus what ffprobe said — so every timing rule in the module comment is
 * asserted against the literal filter string, with ffmpeg never spawned.
 */

function filterOf(args: string[]): string {
  const i = args.indexOf("-filter_complex");
  return args[i + 1]!;
}

const VIDEO_LEG = "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p";
const AFMT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

describe("buildComposeSequenceArgs", () => {
  it("one silent clip, no voiceover: normalises the plate, adds a silent track, and encodes like brandFrame", () => {
    const input = ComposeSequenceInputSchema.parse({ clips: [{ path: "a.mp4" }], outputPath: "out.mp4" });
    const args = buildComposeSequenceArgs(input, { clips: [{ durationSeconds: 6, hasAudio: false }], voiceoverDurationSeconds: null });

    expect(args.slice(0, 3)).toEqual(["-y", "-i", "a.mp4"]);
    expect(filterOf(args)).toBe(`[0:v]${VIDEO_LEG}[vout];anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=6[aout]`);
    expect(args).toContain("-shortest");
    expect(args).toEqual(
      expect.arrayContaining(["-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-colorspace", "bt709", "-movflags", "+faststart"]),
    );
    expect(args[args.length - 1]).toBe("out.mp4");
  });

  it("three clips: one leg each, a video concat, and their own audio concatenated when they all have some", () => {
    const input = ComposeSequenceInputSchema.parse({ clips: [{ path: "a.mp4" }, { path: "b.mp4" }, { path: "c.mp4" }], outputPath: "out.mp4" });
    const probe: ComposeSequenceProbe = {
      clips: [
        { durationSeconds: 5, hasAudio: true },
        { durationSeconds: 7, hasAudio: true },
        { durationSeconds: 6, hasAudio: true },
      ],
      voiceoverDurationSeconds: null,
    };
    const args = buildComposeSequenceArgs(input, probe);
    expect(args.filter((a) => a === "-i")).toHaveLength(3);
    const filter = filterOf(args);
    expect(filter).toContain(`[0:v]${VIDEO_LEG}[v0];[1:v]${VIDEO_LEG}[v1];[2:v]${VIDEO_LEG}[v2];[v0][v1][v2]concat=n=3:v=1:a=0[vout]`);
    expect(filter).toContain(`[0:a]${AFMT},atrim=duration=5,apad=whole_dur=5[a0]`);
    expect(filter).toContain("[a0][a1][a2]concat=n=3:v=0:a=1[aout]");
    expect(filter).not.toContain("volume=");
    expect(args).not.toContain("-shortest");
  });

  it("a silent plate among sounding ones contributes silence of its own length so the ambient track stays aligned", () => {
    const input = ComposeSequenceInputSchema.parse({ clips: [{ path: "a.mp4" }, { path: "b.mp4" }], outputPath: "out.mp4" });
    const filter = filterOf(
      buildComposeSequenceArgs(input, {
        clips: [
          { durationSeconds: 5, hasAudio: true },
          { durationSeconds: 4, hasAudio: false },
        ],
        voiceoverDurationSeconds: null,
      }),
    );
    expect(filter).toContain("anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=4[a1]");
    expect(filter).toContain("[a0][a1]concat=n=2:v=0:a=1[aout]");
  });

  it("holdSeconds trims a longer plate and freezes a shorter one out to exactly the hold", () => {
    const input = ComposeSequenceInputSchema.parse({
      clips: [
        { path: "long.mp4", holdSeconds: 4 },
        { path: "short.mp4", holdSeconds: 6.5 },
      ],
      outputPath: "out.mp4",
    });
    const filter = filterOf(
      buildComposeSequenceArgs(input, {
        clips: [
          { durationSeconds: 8, hasAudio: false },
          { durationSeconds: 5.2, hasAudio: false },
        ],
        voiceoverDurationSeconds: null,
      }),
    );
    // Longer than the hold: trim only, no tpad.
    expect(filter).toContain(`[0:v]${VIDEO_LEG},trim=duration=4[v0]`);
    // Shorter: trim (a no-op) then clone the last frame for the difference, decimals kept sane.
    expect(filter).toContain(`[1:v]${VIDEO_LEG},trim=duration=6.5,tpad=stop_mode=clone:stop_duration=1.3[v1]`);
    // The silent track covers the held total, 10.5s.
    expect(filter).toContain("atrim=duration=10.5[aout]");
  });

  it("with a voiceover: ducks the ambient, mixes voiceover-first without normalising, and freezes the video out to voiceover + tail", () => {
    const input = ComposeSequenceInputSchema.parse({
      clips: [{ path: "a.mp4" }, { path: "b.mp4" }],
      outputPath: "out.mp4",
      voiceoverPath: "vo.mp3",
      ambientGainDb: -18,
      tailPaddingSeconds: 0.4,
    });
    const args = buildComposeSequenceArgs(input, {
      clips: [
        { durationSeconds: 5, hasAudio: true },
        { durationSeconds: 5, hasAudio: true },
      ],
      voiceoverDurationSeconds: 12,
    });
    // The voiceover is the input AFTER the clips.
    expect(args.slice(0, 7)).toEqual(["-y", "-i", "a.mp4", "-i", "b.mp4", "-i", "vo.mp3"]);
    const filter = filterOf(args);
    // Video 10s, voiceover 12s + 0.4 tail = 12.4 → the concatenated video is frozen 2.4s.
    expect(filter).toContain("[v0][v1]concat=n=2:v=1:a=0[vcat]");
    expect(filter).toContain("[vcat]tpad=stop_mode=clone:stop_duration=2.4[vout]");
    expect(filter).toContain("[a0][a1]concat=n=2:v=0:a=1[acat]");
    expect(filter).toContain("[acat]volume=-18dB[amb]");
    expect(filter).toContain(`[2:a]${AFMT},apad=whole_dur=12.4[vo]`);
    expect(filter).toContain("[vo][amb]amix=inputs=2:duration=first:normalize=0[aout]");
    expect(args).not.toContain("-shortest");
  });

  it("with a voiceover shorter than the video: no video freeze, and the audio is padded out to the video's length", () => {
    const input = ComposeSequenceInputSchema.parse({ clips: [{ path: "a.mp4" }], outputPath: "out.mp4", voiceoverPath: "vo.mp3" });
    const filter = filterOf(
      buildComposeSequenceArgs(input, { clips: [{ durationSeconds: 8, hasAudio: false }], voiceoverDurationSeconds: 3 }),
    );
    expect(filter).toContain(`[0:v]${VIDEO_LEG}[vout]`);
    expect(filter).not.toContain("tpad");
    // Silent plate → no ambient leg; the voiceover IS the output audio, padded to the 8s picture.
    expect(filter).toContain(`[1:a]${AFMT},apad=whole_dur=8[aout]`);
    expect(filter).not.toContain("amix");
  });

  it("with an unmeasurable voiceover: pads by the tail only and never guesses a total", () => {
    const input = ComposeSequenceInputSchema.parse({ clips: [{ path: "a.mp4" }], outputPath: "out.mp4", voiceoverPath: "vo.mp3", tailPaddingSeconds: 1 });
    const filter = filterOf(buildComposeSequenceArgs(input, { clips: [{ durationSeconds: 8, hasAudio: false }], voiceoverDurationSeconds: null }));
    expect(filter).toContain(`[1:a]${AFMT},apad=pad_dur=1[aout]`);
    expect(filter).not.toContain("tpad");
  });

  it("honours a custom canvas", () => {
    const input = ComposeSequenceInputSchema.parse({ clips: [{ path: "a.mp4" }], outputPath: "out.mp4", canvas: { w: 720, h: 1280 } });
    expect(filterOf(buildComposeSequenceArgs(input, { clips: [{ durationSeconds: 1, hasAudio: false }], voiceoverDurationSeconds: null }))).toContain(
      "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:",
    );
  });
});

/** ffprobe answers per file; ffmpeg pretends success. */
function fakeRunner(probes: Record<string, { duration?: string; audio: boolean }>) {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const runner: ProcessRunner = async (bin, args) => {
    calls.push({ bin, args: [...args] });
    if (bin === "ffprobe") {
      const file = args[args.length - 1]!;
      const p = probes[path.basename(file)] ?? probes[file];
      if (!p) return { exitCode: 1, stdout: "", stderr: `No such file or directory: ${file}` };
      const streams = [{ codec_type: "video" }, ...(p.audio ? [{ codec_type: "audio" }] : [])];
      return { exitCode: 0, stdout: JSON.stringify({ streams, format: p.duration !== undefined ? { duration: p.duration } : {} }), stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "compose-seq-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("video.composeSequence", () => {
  it("probes every input (duration + audio presence), builds the graph from what it learned, and probes the output", async () => {
    const { runner, calls } = fakeRunner({ "a.mp4": { duration: "5", audio: true }, "b.mp4": { duration: "6", audio: false }, "vo.mp3": { duration: "9", audio: true }, "out.mp4": { duration: "9.4", audio: true } });
    const tool = createComposeSequence({ runner, env: {} });
    const outcome = await tool.execute(
      ComposeSequenceInputSchema.parse({ clips: [{ path: "a.mp4" }, { path: "b.mp4" }], outputPath: path.join(tmp, "out.mp4"), voiceoverPath: "vo.mp3" }),
      { ctx },
    );
    expect(outcome.status).toBe("success");
    expect((outcome as { result: ComposeSequenceResult }).result).toEqual({ outputPath: path.join(tmp, "out.mp4"), durationSeconds: 9.4, clipsUsed: 2, hasVoiceover: true });

    const probes = calls.filter((c) => c.bin === "ffprobe");
    expect(probes.map((c) => path.basename(c.args[c.args.length - 1]!))).toEqual(["a.mp4", "b.mp4", "vo.mp3", "out.mp4"]);
    expect(probes[0]!.args).toEqual(["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", "a.mp4"]);

    const ffmpeg = calls.find((c) => c.bin === "ffmpeg")!;
    const filter = filterOf(ffmpeg.args);
    // b.mp4 was probed silent, so its ambient leg is generated silence of its 6s.
    expect(filter).toContain("anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=6[a1]");
    // Video 11s > voiceover 9.4s → no freeze; audio padded to 11.
    expect(filter).toContain("apad=whole_dur=11[vo]");
    expect(filter).not.toContain("tpad");
  });

  it("names the unreadable input instead of surfacing ffmpeg's stderr", async () => {
    const { runner, calls } = fakeRunner({ "a.mp4": { duration: "5", audio: true } });
    const tool = createComposeSequence({ runner, env: {} });
    const outcome = await tool.execute(ComposeSequenceInputSchema.parse({ clips: [{ path: "a.mp4" }, { path: "missing.mp4" }], outputPath: path.join(tmp, "out.mp4") }), { ctx });
    expect(outcome.status).toBe("tooling_error");
    expect((outcome as { reason: string }).reason).toContain('clips[1] "missing.mp4"');
    expect(calls.some((c) => c.bin === "ffmpeg")).toBe(false);
  });

  it("refuses a voiceover with no audio stream", async () => {
    const { runner } = fakeRunner({ "a.mp4": { duration: "5", audio: true }, "vo.mp4": { duration: "5", audio: false } });
    const tool = createComposeSequence({ runner, env: {} });
    const outcome = await tool.execute(ComposeSequenceInputSchema.parse({ clips: [{ path: "a.mp4" }], outputPath: path.join(tmp, "out.mp4"), voiceoverPath: "vo.mp4" }), { ctx });
    expect(outcome.status).toBe("tooling_error");
    expect((outcome as { reason: string }).reason).toContain("no audio stream");
  });

  it("surfaces a non-zero ffmpeg exit as a tooling_error with the stderr tail", async () => {
    const calls: string[] = [];
    const runner: ProcessRunner = async (bin) => {
      calls.push(bin);
      if (bin === "ffprobe") return { exitCode: 0, stdout: JSON.stringify({ streams: [{ codec_type: "video" }], format: { duration: "3" } }), stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "Error initializing filter 'tpad'" };
    };
    const outcome = await createComposeSequence({ runner, env: {} }).execute(ComposeSequenceInputSchema.parse({ clips: [{ path: "a.mp4" }], outputPath: path.join(tmp, "out.mp4") }), { ctx });
    expect(outcome.status).toBe("tooling_error");
    expect((outcome as { reason: string }).reason).toContain("Error initializing filter 'tpad'");
  });

  describe("tenant sandbox applies to every path", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["a clip", { clips: [{ path: "ok.mp4" }, { path: "../../etc/passwd" }], outputPath: "out.mp4" }],
      ["the voiceover", { clips: [{ path: "ok.mp4" }], outputPath: "out.mp4", voiceoverPath: "../vo.mp3" }],
      ["the output", { clips: [{ path: "ok.mp4" }], outputPath: "../../out.mp4" }],
    ];
    for (const [what, raw] of cases) {
      it(`refuses a traversal in ${what} before spawning anything`, async () => {
        const { runner, calls } = fakeRunner({ "ok.mp4": { duration: "5", audio: true } });
        const outcome = await createComposeSequence({ runner, env: {} }).execute(ComposeSequenceInputSchema.parse(raw), { ctx });
        expect(outcome.status).toBe("tooling_error");
        expect(calls).toHaveLength(0);
      });
    }

    it("confines every path to <workRoot>/<clientSlug>/ when a work root is configured", async () => {
      const { runner, calls } = fakeRunner({ "a.mp4": { duration: "5", audio: true }, "out.mp4": { duration: "5", audio: true } });
      const tool = createComposeSequence({ runner, env: {}, workRoot: tmp });
      // An absolute path into ANOTHER tenant's directory is refused even though it is under workRoot.
      const outside = await tool.execute(ComposeSequenceInputSchema.parse({ clips: [{ path: path.join(tmp, "other", "a.mp4") }], outputPath: "out.mp4" }), { ctx });
      expect(outside.status).toBe("tooling_error");
      expect(calls).toHaveLength(0);
      // Relative paths resolve inside the tenant root and are accepted.
      const inside = await tool.execute(ComposeSequenceInputSchema.parse({ clips: [{ path: "a.mp4" }], outputPath: "out.mp4" }), { ctx });
      expect(inside.status).toBe("success");
    });
  });
});
