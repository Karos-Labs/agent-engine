import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import {
  BrandFrameInputSchema,
  buildBrandFrameFilter,
  BrandFrameCaptionStyleSchema,
  captionForceStyle,
  wrapOverlayText,
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

  it("letterboxes by default and fills-and-crops on fit: cover", () => {
    expect(buildBrandFrameFilter(base)).toContain("scale=1080:1520:force_original_aspect_ratio=decrease,pad=1080:1520:");
    const cover = buildBrandFrameFilter({ ...base, fit: "cover" });
    expect(cover).toContain("scale=1080:1520:force_original_aspect_ratio=increase,crop=1080:1520,pad=1080:1520:");
    expect(cover).toContain("pad=1080:1920:0:200:color=0x17181C");
  });

  it("routes through an overlay chain when a logo is present", () => {
    const filter = buildBrandFrameFilter({ ...base, brand: { ...base.brand, logoPath: "logo.png" } });
    expect(filter).toContain("[1:v]scale=-1:110[logo]");
    expect(filter).toContain("[framed][logo]overlay=48:100-h/2[out]");
  });

  /**
   * AU38 (SCRUM-322). The caller computes the contrast — `planBrandLogoPlacement`
   * in karos-media, against the same `ground` the bars are painted in — and
   * hands down the plate it verified. This tool's job is only to paint it,
   * and to paint NOTHING when it wasn't asked to.
   */
  it("pads the logo in the caller's verified scrim plate when one is set, and leaves it bare when it isn't", () => {
    const bare = buildBrandFrameFilter({ ...base, brand: { ...base.brand, logoPath: "logo.png" } });
    expect(bare).toContain("[1:v]scale=-1:110[logo]");
    expect(bare).not.toContain("pad=iw");

    const scrimmed = buildBrandFrameFilter({ ...base, brand: { ...base.brand, logoPath: "logo.png", logoScrim: "#FFFFFF" } });
    expect(scrimmed).toContain("[1:v]scale=-1:110,pad=iw+32:ih+32:16:16:color=0xFFFFFF[logo]");
    expect(scrimmed).toContain("[framed][logo]overlay=48:100-h/2[out]");
    // No logo at all means no plate, whatever the field says.
    expect(buildBrandFrameFilter({ ...base, brand: { ...base.brand, logoScrim: "#FFFFFF" } })).not.toContain("pad=iw");
  });

  it("burns captions when an srt is given, with colon-escaped forward-slash paths, styled and held above the bottom bar", () => {
    const filter = buildBrandFrameFilter({ ...base, srtPath: "C:\\work\\clip.srt" });
    expect(filter).toContain("subtitles='C\\:/work/clip.srt':force_style='FontName=Liberation Sans,FontSize=13,Bold=1,");
    // 200px bar + 56px gap on a 1920 canvas = 38 libass units: the block ends
    // in the picture, not across the @handle (libass's default put it there).
    expect(filter).toContain("Alignment=2,MarginV=38,");
    expect(captionForceStyle(BrandFrameCaptionStyleSchema.parse({}), 1920, 200)).toContain("MarginV=38");
  });

  it("draws each timed title card in the upper third, boxed in the ground colour, from a text file", () => {
    const filter = buildBrandFrameFilter(base, [
      { textfile: "C:\\work\\overlay-1.txt", start: 0, end: 5.5 },
      { textfile: "C:\\work\\overlay-2.txt", start: 5.5, end: 11 },
    ]);
    expect(filter).toContain("drawtext=textfile='C\\:/work/overlay-1.txt':font='Liberation Sans':fontcolor=0xF4F2EC:fontsize=61:");
    expect(filter).toContain("box=1:boxcolor=0x17181C@0.72:boxborderw=22:x=(w-text_w)/2:y=306:enable='between(t,0,5.5)'");
    expect(filter).toContain("enable='between(t,5.5,11)'");
    // The cards are drawn BEFORE the captions burn, so the two never share a zone.
    expect(filter.indexOf("drawtext=textfile")).toBeLessThan(filter.indexOf("subtitles=") === -1 ? Infinity : filter.indexOf("subtitles="));
  });

  it("wraps an on-screen line for drawtext, which never wraps by itself", () => {
    expect(wrapOverlayText("Stop paying for clicks that never convert")).toBe("Stop paying for clicks\nthat never convert");
    expect(wrapOverlayText("Short")).toBe("Short");
    expect(wrapOverlayText("  spaced   out\tline ")).toBe("spaced out line");
    expect(wrapOverlayText("one two three four five six seven eight nine ten eleven twelve thirteen").split("\n")).toHaveLength(3);
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

  it("writes each overlay's wrapped text to a file next to the output and references it from the graph", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brand-frame-"));
    try {
      const calls: Array<{ bin: string; args: string[] }> = [];
      const tool = createBrandFrame({ runner: fakeRunner(calls), env: {} });
      const outcome = await tool.execute(
        BrandFrameInputSchema.parse({
          videoPath: path.join(dir, "clip.mp4"),
          outputPath: path.join(dir, "framed.mp4"),
          brand: { ground: "#17181C", fg: "#F4F2EC" },
          overlays: [
            { text: "Stop paying for clicks that never convert", start: 0, end: 6 },
            { text: "   ", start: 6, end: 9 }, // nothing to show: skipped, not an empty card
          ],
        }),
        { ctx },
      );
      expect(outcome.status).toBe("success");
      expect((outcome as { result: { applied: string[] } }).result.applied).toContain("overlays");
      expect(await fs.readFile(path.join(dir, "overlay-1.txt"), "utf8")).toBe("Stop paying for clicks\nthat never convert");
      const ffmpeg = calls.find((c) => c.bin === "ffmpeg")!;
      const graph = ffmpeg.args[ffmpeg.args.indexOf("-filter_complex") + 1]!;
      expect(graph).toContain("overlay-1.txt");
      expect(graph).not.toContain("overlay-2.txt");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
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
