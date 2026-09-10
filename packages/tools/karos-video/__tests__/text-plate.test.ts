import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { TextPlateInputSchema, buildTextPlateArgs, buildTextPlateAss, createTextPlate, fitPlateText, statLayout } from "../src/tools/text-plate.js";
import type { ProcessRunner } from "../src/process/runner.js";

const ctx: AgentContext = { runId: "r1", clientSlug: "acme", productId: "tiktok-agent", runKind: "recurring", metadata: {} };

function fakeRunner(record: Array<{ bin: string; args: string[] }>, exitCode = 0): ProcessRunner {
  return async (bin, args) => {
    record.push({ bin, args: [...args] });
    if (bin === "ffprobe") return { exitCode: 0, stdout: JSON.stringify({ format: { duration: "6.0" } }), stderr: "" };
    return { exitCode, stdout: "", stderr: exitCode === 0 ? "" : "boom" };
  };
}

describe("buildTextPlateAss / buildTextPlateArgs", () => {
  it("sets the line large, centred, faded in, in the brand's text colour, wrapped to three lines at most, in any script", () => {
    const input = TextPlateInputSchema.parse({ text: "The money is not the prize", outputPath: "o.mp4", durationSeconds: 6, ground: "#242429", fg: "#FFFFFF", accent: "#FF6B2C" });
    const ass = buildTextPlateAss(input);
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toMatch(/Style: Line,Liberation Sans,100,&H00FFFFFF,&H00FFFFFF,&HFF000000,&HFF000000,-1,0,0,0,100,100,0,0,1,0,0,5,97,97,0,1/);
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:06.00,Line,,0,0,0,,{\\fad(350,0)}The money is not\\Nthe prize");
    const hebrew = buildTextPlateAss(TextPlateInputSchema.parse({ text: "הכסף הוא לא הפרס", outputPath: "o.mp4", durationSeconds: 4, ground: "#242429", fontName: "Noto Sans Hebrew" }));
    expect(hebrew).toContain("Style: Line,Noto Sans Hebrew,");
    expect(hebrew).toContain("הכסף הוא לא הפרס");
  });

  it("a line that needs more than three lines is set smaller and wrapped wider, never cut (prep run pubsub-21157031361398626's hook)", () => {
    // 12 words, 67 characters: four lines at 18 chars; at 85% (21 chars) still four; at 75% (24 chars) three.
    const hook = "Your AI tools saved you time. Nobody measured what that time built.";
    const fit = fitPlateText(hook, 100);
    expect(fit.lines).toBe(3);
    expect(fit.fontSize).toBe(75);
    expect(fit.text.replace(/\\N/g, " ")).toBe(hook);
    const ass = buildTextPlateAss(TextPlateInputSchema.parse({ text: hook, outputPath: "o.mp4", durationSeconds: 2, ground: "#242429" }));
    expect(ass).toContain("Style: Line,Liberation Sans,75,");
    expect(ass).toContain("time built.");
    // Short lines keep the full size…
    expect(fitPlateText("Pick one thing", 100)).toEqual({ text: "Pick one thing", fontSize: 100, lines: 1 });
    // …and a line too long for even the smallest size takes the lines it needs rather than losing its end.
    const long = "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty";
    const longFit = fitPlateText(long, 100);
    expect(longFit.fontSize).toBe(65);
    expect(longFit.lines).toBeGreaterThan(3);
    expect(longFit.text.replace(/\\N/g, " ")).toBe(long);
  });

  it("a stat card sets the figure at 2.5x the fitted label size with the label under it, in the same faded, centred line", () => {
    const input = TextPlateInputSchema.parse({ text: "of founders run their own ads", stat: { value: "47%", label: "of founders run their own ads" }, outputPath: "o.mp4", durationSeconds: 6, ground: "#242429" });
    const ass = buildTextPlateAss(input);
    expect(ass).toContain("Style: Line,Liberation Sans,100,");
    expect(ass).toContain("{\\fad(350,0)}{\\fs250}47%{\\fs100}\\Nof founders run\\Nthe own ads".replace("the own", "their own"));
    expect(statLayout({ value: "$2", label: "a short, at most" }, { text: "a short, at most", fontSize: 75 })).toBe("{\\fs188}$2{\\fs75}\\Na short, at most");
    // A label that needs the smaller size scales the figure with it, so both fit.
    const long = buildTextPlateAss(TextPlateInputSchema.parse({ text: "x", stat: { value: "3 of 4", label: "marketing budgets nobody can defend at the quarterly review" }, outputPath: "o.mp4", durationSeconds: 6, ground: "#242429" }));
    expect(long).toMatch(/\{\\fs(163|188|213)\}3 of 4\{\\fs(65|75|85)\}/);
  });

  it("renders from a colour source on the composer's encode contract, silent, with the accent bar drawing across over the hold", () => {
    const input = TextPlateInputSchema.parse({ text: "Pick one thing", outputPath: "out.mp4", durationSeconds: 4, ground: "#242429", accent: "#FF6B2C" });
    const args = buildTextPlateArgs(input, "C:\\work\\plate-2.ass");
    expect(args.slice(0, 5)).toEqual(["-y", "-f", "lavfi", "-i", "color=c=0x242429:s=1080x1920:r=30:d=4"]);
    const vf = args[args.indexOf("-vf") + 1]!;
    expect(vf).toContain("drawbox=x=97:y=1382:w='min(t/4\\,1)*886':h=6:color=0xFF6B2C:t=fill");
    expect(vf).toContain("subtitles='C\\:/work/plate-2.ass'");
    expect(vf).toContain("format=yuv420p");
    expect(args).toContain("-an");
    expect(args).toContain("bt709");
    expect(args[args.length - 1]).toBe("out.mp4");
    // No accent → no bar.
    const plain = buildTextPlateArgs(TextPlateInputSchema.parse({ text: "x", outputPath: "o.mp4", durationSeconds: 4, ground: "#242429" }), "p.ass");
    expect(plain[plain.indexOf("-vf") + 1]).not.toContain("drawbox");
  });

  it("refuses a non-hex ground or a hold outside 1..15s at the schema", () => {
    expect(TextPlateInputSchema.safeParse({ text: "x", outputPath: "o.mp4", durationSeconds: 4, ground: "red" }).success).toBe(false);
    expect(TextPlateInputSchema.safeParse({ text: "x", outputPath: "o.mp4", durationSeconds: 30, ground: "#242429" }).success).toBe(false);
  });
});

describe("video.textPlate", () => {
  it("writes the ASS beside the output, runs ffmpeg once, and reports the probed duration", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "text-plate-"));
    const record: Array<{ bin: string; args: string[] }> = [];
    const tool = createTextPlate({ runner: fakeRunner(record), ffmpegBin: "ffmpeg", ffprobeBin: "ffprobe" });
    const outcome = await tool.execute(TextPlateInputSchema.parse({ text: "Pick one thing", outputPath: path.join(dir, "plate-2-text.mp4"), durationSeconds: 6, ground: "#242429" }), { ctx });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.durationSeconds).toBe(6);
    expect(await fs.readFile(path.join(dir, "plate-2-text.ass"), "utf8")).toContain("Pick one thing");
    expect(record.filter((r) => r.bin === "ffmpeg")).toHaveLength(1);
  });

  it("a non-zero ffmpeg exit is a tooling error carrying stderr", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "text-plate-"));
    const tool = createTextPlate({ runner: fakeRunner([], 1) });
    const outcome = await tool.execute(TextPlateInputSchema.parse({ text: "x", outputPath: path.join(dir, "p.mp4"), durationSeconds: 4, ground: "#242429" }), { ctx });
    expect(outcome.status).toBe("tooling_error");
    if (outcome.status !== "tooling_error") throw new Error("unreachable");
    expect(outcome.reason).toMatch(/exited 1.*boom/);
  });
});
