import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { MixMusicInputSchema, buildMixMusicArgs, createMixMusic } from "../src/tools/mix-music.js";
import type { ProcessRunner } from "../src/process/runner.js";

const ctx: AgentContext = { runId: "r1", clientSlug: "acme", productId: "tiktok-agent", runKind: "recurring", metadata: {} };

function fakeRunner(record: Array<{ bin: string; args: string[] }>, opts: { hasAudio?: boolean; exitCode?: number } = {}): ProcessRunner {
  return async (bin, args) => {
    record.push({ bin, args: [...args] });
    if (bin === "ffprobe") {
      const streams = opts.hasAudio === false ? [{ codec_type: "video" }] : [{ codec_type: "video" }, { codec_type: "audio" }];
      return { exitCode: 0, stdout: JSON.stringify({ format: { duration: "32.5" }, streams }), stderr: "" };
    }
    return { exitCode: opts.exitCode ?? 0, stdout: "", stderr: opts.exitCode ? "boom" : "" };
  };
}

function filterOf(args: string[]): string {
  return args[args.indexOf("-filter_complex") + 1]!;
}

describe("buildMixMusicArgs", () => {
  it("under a voice: loops/trims the bed to the picture, sets its level, ducks it off the voice, fades it out, mixes without scaling the voice, copies the video", () => {
    const input = MixMusicInputSchema.parse({ videoPath: "seq.mp4", musicPath: "bed.mp3", outputPath: "out.mp4" });
    const args = buildMixMusicArgs(input, 32.5, true);
    const filter = filterOf(args);
    expect(filter).toContain("[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aloop=loop=-1:size=2147483647,atrim=duration=32.5,volume=-16dB,afade=t=out:st=31.3:d=1.2[bed]");
    expect(filter).toContain("[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asplit=2[voice][key]");
    expect(filter).toContain("[bed][key]sidechaincompress=threshold=0.03:ratio=6:attack=40:release=500:makeup=1[ducked]");
    expect(filter).toContain("[voice][ducked]amix=inputs=2:duration=first:normalize=0[aout]");
    expect(args).toContain("copy");
    expect(args.slice(args.indexOf("-map"), args.indexOf("-map") + 4)).toEqual(["-map", "0:v", "-map", "[aout]"]);
    expect(args).not.toContain("-shortest");
    expect(args[args.length - 1]).toBe("out.mp4");
  });

  it("over a silent clip: the bed alone, no side-chain, ended by the picture", () => {
    const input = MixMusicInputSchema.parse({ videoPath: "seq.mp4", musicPath: "bed.mp3", outputPath: "out.mp4", musicGainDb: -10, fadeOutSeconds: 0 });
    const args = buildMixMusicArgs(input, 20, false);
    const filter = filterOf(args);
    expect(filter).toBe("[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aloop=loop=-1:size=2147483647,atrim=duration=20,volume=-10dB[aout]");
    expect(filter).not.toContain("sidechaincompress");
    expect(args).toContain("-shortest");
  });

  it("refuses a bed louder than 0 dB or a duck ratio under 1 at the schema", () => {
    expect(MixMusicInputSchema.safeParse({ videoPath: "a", musicPath: "b", outputPath: "c", musicGainDb: 3 }).success).toBe(false);
    expect(MixMusicInputSchema.safeParse({ videoPath: "a", musicPath: "b", outputPath: "c", duckRatio: 0.5 }).success).toBe(false);
  });
});

describe("video.mixMusic", () => {
  it("probes the picture once, runs ffmpeg once, and reports whether it ducked", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mix-music-"));
    await fs.writeFile(path.join(dir, "seq.mp4"), Buffer.from([0]));
    await fs.writeFile(path.join(dir, "bed.mp3"), Buffer.from([0]));
    const record: Array<{ bin: string; args: string[] }> = [];
    const tool = createMixMusic({ runner: fakeRunner(record), ffmpegBin: "ffmpeg", ffprobeBin: "ffprobe" });
    const outcome = await tool.execute(MixMusicInputSchema.parse({ videoPath: path.join(dir, "seq.mp4"), musicPath: path.join(dir, "bed.mp3"), outputPath: path.join(dir, "mixed.mp4") }), { ctx });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.ducked).toBe(true);
    expect(outcome.result.durationSeconds).toBe(32.5);
    expect(record.filter((r) => r.bin === "ffmpeg")).toHaveLength(1);
    expect(filterOf(record.find((r) => r.bin === "ffmpeg")!.args)).toContain("sidechaincompress");
  });

  it("a silent picture gets the bed alone and reports ducked: false", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mix-music-"));
    await fs.writeFile(path.join(dir, "seq.mp4"), Buffer.from([0]));
    await fs.writeFile(path.join(dir, "bed.mp3"), Buffer.from([0]));
    const record: Array<{ bin: string; args: string[] }> = [];
    const tool = createMixMusic({ runner: fakeRunner(record, { hasAudio: false }) });
    const outcome = await tool.execute(MixMusicInputSchema.parse({ videoPath: path.join(dir, "seq.mp4"), musicPath: path.join(dir, "bed.mp3"), outputPath: path.join(dir, "mixed.mp4") }), { ctx });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.ducked).toBe(false);
  });

  it("a missing track is a tooling error naming the path, and ffmpeg never runs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mix-music-"));
    await fs.writeFile(path.join(dir, "seq.mp4"), Buffer.from([0]));
    const record: Array<{ bin: string; args: string[] }> = [];
    const tool = createMixMusic({ runner: fakeRunner(record) });
    const outcome = await tool.execute(MixMusicInputSchema.parse({ videoPath: path.join(dir, "seq.mp4"), musicPath: path.join(dir, "nope.mp3"), outputPath: path.join(dir, "mixed.mp4") }), { ctx });
    expect(outcome.status).toBe("tooling_error");
    if (outcome.status !== "tooling_error") throw new Error("unreachable");
    expect(outcome.reason).toContain("musicPath");
    expect(record.filter((r) => r.bin === "ffmpeg")).toHaveLength(0);
  });
});
