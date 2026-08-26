import { describe, expect, it } from "vitest";
import type { AgentContext } from "@agent-engine/core";
import {
  BrandFrameInputSchema,
  buildBrandFrameFilter,
  buildSrt,
  createBrandFrame,
  createCutClip,
  hexToFfmpeg,
  sanitizeOverlayText,
} from "../src/tools/clip-compose.js";
import type { ProcessRunner } from "../src/process/runner.js";

const ctx: AgentContext = { runId: "r1", clientSlug: "acme", productId: "tiktok-agent", runKind: "recurring", metadata: {} };

/** A runner that records invocations and pretends success. */
function fakeRunner(record: Array<{ bin: string; args: string[] }>): ProcessRunner {
  return async (bin, args) => {
    record.push({ bin, args: [...args] });
    if (bin === "ffprobe") return { exitCode: 0, stdout: JSON.stringify({ format: { duration: "12.5" } }), stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

describe("buildSrt", () => {
  it("groups words into phrase cues, shifted to clip-relative time", () => {
    const words = [
      { word: "the", start: 10.0, end: 10.2 },
      { word: "quick", start: 10.2, end: 10.5 },
      { word: "brown", start: 10.5, end: 10.9 },
      { word: "fox", start: 10.9, end: 11.3 },
      { word: "jumps", start: 11.3, end: 11.8 },
    ];
    const srt = buildSrt(words, 10.0, 4);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,300\nthe quick brown fox");
    expect(srt).toContain("2\n00:00:01,300 --> 00:00:01,800\njumps");
  });

  it("never emits a zero-length cue", () => {
    const srt = buildSrt([{ word: "hi", start: 5, end: 5 }], 5);
    expect(srt).toContain("00:00:00,000 --> 00:00:00,200");
  });
});

describe("sanitizeOverlayText / hexToFfmpeg", () => {
  it("strips filtergraph-significant characters rather than escaping them", () => {
    expect(sanitizeOverlayText("PITCH SCHOOL | LESSON 15")).toBe("PITCH SCHOOL | LESSON 15");
    expect(sanitizeOverlayText("evil':drawbox=%{pts}")).toBe("evildrawbox=pts".replace("=", "")); // no quotes/colons/percent/braces survive
    expect(sanitizeOverlayText("@geektimecoil")).toBe("@geektimecoil");
  });

  it("converts #RRGGBB to ffmpeg 0x form", () => {
    expect(hexToFfmpeg("#A5E82B")).toBe("0xA5E82B");
  });
});

describe("buildBrandFrameFilter", () => {
  const base = BrandFrameInputSchema.parse({
    videoPath: "in.mp4",
    outputPath: "out.mp4",
    brand: { ground: "#17181C", fg: "#F4F2EC", accent: "#A5E82B", seriesHeader: "GEEK WEEKLY", handle: "@geektimecoil" },
  });

  it("always paints the bars, and composites every present element into one graph ending at [out]", () => {
    const filter = buildBrandFrameFilter(base);
    expect(filter).toContain("pad=1080:1920:0:200:color=0x17181C");
    expect(filter).toContain("drawbox=x=0:y=194:w=1080:h=6:color=0xA5E82B");
    expect(filter).toContain("drawtext=text='GEEK WEEKLY'");
    expect(filter).toContain("drawtext=text='@geektimecoil'");
    expect(filter.endsWith("[out]")).toBe(true);
    expect(filter).not.toContain("[framed]"); // no logo → single chain
  });

  it("routes through an overlay chain when a logo is present", () => {
    const filter = buildBrandFrameFilter({ ...base, brand: { ...base.brand, logoPath: "logo.png" } });
    expect(filter).toContain("[1:v]scale=-1:110[logo]");
    expect(filter).toContain("[framed][logo]overlay=48:100-h/2[out]");
  });

  it("burns captions when an srt is given, with colon-escaped forward-slash paths", () => {
    const filter = buildBrandFrameFilter({ ...base, srtPath: "C:\\work\\clip.srt" });
    expect(filter).toContain("subtitles='C\\:/work/clip.srt'");
  });

  it("a bare ground with nothing else still frames — brand furniture is optional, bars are not", () => {
    const filter = buildBrandFrameFilter(BrandFrameInputSchema.parse({ videoPath: "a.mp4", outputPath: "b.mp4", brand: { ground: "#111111" } }));
    expect(filter).toContain("pad=1080:1920:0:200");
    expect(filter).not.toContain("drawtext");
    expect(filter.endsWith("[out]")).toBe(true);
  });
});

describe("video.cutClip", () => {
  it("re-encodes the [start,end) window and probes the result", async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const tool = createCutClip({ runner: fakeRunner(calls), env: {} });
    const outcome = await tool.execute({ sourcePath: "ep.mp4", startSeconds: 30, endSeconds: 42.5, outputPath: "clip.mp4" }, { ctx });
    expect(outcome.status).toBe("success");
    const ffmpeg = calls.find((c) => c.bin === "ffmpeg")!;
    expect(ffmpeg.args).toEqual(expect.arrayContaining(["-ss", "30", "-to", "42.5", "-i", "ep.mp4", "clip.mp4"]));
    expect((outcome as { result: { durationSeconds: number } }).result.durationSeconds).toBe(12.5);
  });

  it("refuses an inverted window as a tooling error", async () => {
    const tool = createCutClip({ runner: fakeRunner([]), env: {} });
    const outcome = await tool.execute({ sourcePath: "ep.mp4", startSeconds: 42, endSeconds: 30, outputPath: "clip.mp4" }, { ctx });
    expect(outcome.status).toBe("tooling_error");
  });

  it("refuses a traversal path before ever spawning ffmpeg", async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const tool = createCutClip({ runner: fakeRunner(calls), env: {} });
    const outcome = await tool.execute({ sourcePath: "../../etc/passwd", startSeconds: 0, endSeconds: 1, outputPath: "clip.mp4" }, { ctx });
    expect(outcome.status).toBe("tooling_error");
    expect(calls).toHaveLength(0);
  });
});

describe("video.brandFrame", () => {
  it("skips an unreadable logo instead of failing — brand furniture never holds a run", async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const tool = createBrandFrame({ runner: fakeRunner(calls), env: {} });
    const outcome = await tool.execute(
      BrandFrameInputSchema.parse({
        videoPath: "clip.mp4",
        outputPath: "framed.mp4",
        brand: { ground: "#17181C", fg: "#F4F2EC", logoPath: "definitely/not/a/real/logo.png" },
      }),
      { ctx },
    );
    expect(outcome.status).toBe("success");
    const result = (outcome as { result: { applied: string[] } }).result;
    expect(result.applied).toContain("bars");
    expect(result.applied).not.toContain("logo");
    // And ffmpeg was invoked WITHOUT a second input.
    const ffmpeg = calls.find((c) => c.bin === "ffmpeg")!;
    expect(ffmpeg.args.filter((a) => a === "-i")).toHaveLength(1);
  });

  it("reports which elements composited", async () => {
    const tool = createBrandFrame({ runner: fakeRunner([]), env: {} });
    const outcome = await tool.execute(
      BrandFrameInputSchema.parse({
        videoPath: "clip.mp4",
        outputPath: "framed.mp4",
        brand: { ground: "#17181C", fg: "#F4F2EC", accent: "#A5E82B", seriesHeader: "X", handle: "@x" },
      }),
      { ctx },
    );
    const result = (outcome as { result: { applied: string[] } }).result;
    expect(result.applied).toEqual(expect.arrayContaining(["bars", "accent-rules", "series-header", "handle"]));
  });
});
