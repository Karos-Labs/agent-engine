import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "@agent-engine/core";
import { StillToClipInputSchema, buildStillToClipArgs, createStillToClip } from "../src/tools/still-to-clip.js";
import type { ProcessRunner } from "../src/process/runner.js";

const ctx: AgentContext = { runId: "r1", clientSlug: "acme", productId: "tiktok-agent", runKind: "recurring", metadata: {} };

function fakeRunner(record: Array<{ bin: string; args: string[] }>, exitCode = 0): ProcessRunner {
  return async (bin, args) => {
    record.push({ bin, args: [...args] });
    if (bin === "ffprobe") return { exitCode: 0, stdout: JSON.stringify({ format: { duration: "6.0" } }), stderr: "" };
    return { exitCode, stdout: "", stderr: exitCode === 0 ? "" : "boom" };
  };
}

describe("buildStillToClipArgs", () => {
  it("holds the still for the requested seconds with a slow constant push-in, silent, on the composer's encode contract", () => {
    const args = buildStillToClipArgs(StillToClipInputSchema.parse({ imagePath: "a.png", outputPath: "out.mp4", durationSeconds: 6 }));
    const vf = args[args.indexOf("-vf") + 1]!;
    expect(args.slice(0, 3)).toEqual(["-y", "-loop", "1"]);
    expect(args[args.indexOf("-t") + 1]).toBe("6");
    expect(args).toContain("-an");
    expect(vf).toContain("zoompan=z='min(1+on*");
    expect(vf).toContain(",1.080)'");
    expect(vf).toContain(`d=${6 * 30}`);
    expect(vf).toContain("s=1080x1920");
    expect(vf).toContain("format=yuv420p");
    expect(args).toContain("bt709");
    expect(args[args.length - 1]).toBe("out.mp4");
  });

  it("a `none` move holds the frame; a `pull-back` starts tight and opens to 1", () => {
    const none = buildStillToClipArgs(StillToClipInputSchema.parse({ imagePath: "a.png", outputPath: "o.mp4", durationSeconds: 4, move: "none" }));
    expect(none[none.indexOf("-vf") + 1]).toContain("zoompan=z='1'");
    const back = buildStillToClipArgs(StillToClipInputSchema.parse({ imagePath: "a.png", outputPath: "o.mp4", durationSeconds: 4, move: "pull-back" }));
    expect(back[back.indexOf("-vf") + 1]).toContain("zoompan=z='max(1.080-on*");
  });

  it("refuses a hold outside 1..15 seconds at the schema", () => {
    expect(StillToClipInputSchema.safeParse({ imagePath: "a.png", outputPath: "o.mp4", durationSeconds: 0.5 }).success).toBe(false);
    expect(StillToClipInputSchema.safeParse({ imagePath: "a.png", outputPath: "o.mp4", durationSeconds: 20 }).success).toBe(false);
  });
});

describe("video.stillToClip", () => {
  it("runs ffmpeg once and reports the probed duration", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "still-to-clip-"));
    const image = path.join(dir, "plate.png");
    await fs.writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const record: Array<{ bin: string; args: string[] }> = [];
    const tool = createStillToClip({ runner: fakeRunner(record), ffmpegBin: "ffmpeg", ffprobeBin: "ffprobe" });
    const outcome = await tool.execute(StillToClipInputSchema.parse({ imagePath: image, outputPath: path.join(dir, "plate.mp4"), durationSeconds: 6 }), { ctx });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.durationSeconds).toBe(6);
    expect(record.filter((r) => r.bin === "ffmpeg")).toHaveLength(1);
  });

  it("an unreadable still is a tooling error naming the path, and ffmpeg is never spawned", async () => {
    const record: Array<{ bin: string; args: string[] }> = [];
    const tool = createStillToClip({ runner: fakeRunner(record) });
    const outcome = await tool.execute(StillToClipInputSchema.parse({ imagePath: path.join(os.tmpdir(), "does-not-exist-still.png"), outputPath: path.join(os.tmpdir(), "x.mp4"), durationSeconds: 4 }), { ctx });
    expect(outcome.status).toBe("tooling_error");
    expect(record).toHaveLength(0);
  });

  it("a non-zero ffmpeg exit is a tooling error carrying stderr", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "still-to-clip-"));
    const image = path.join(dir, "plate.png");
    await fs.writeFile(image, Buffer.from([0x89]));
    const tool = createStillToClip({ runner: fakeRunner([], 1) });
    const outcome = await tool.execute(StillToClipInputSchema.parse({ imagePath: image, outputPath: path.join(dir, "plate.mp4"), durationSeconds: 4 }), { ctx });
    expect(outcome.status).toBe("tooling_error");
    if (outcome.status !== "tooling_error") throw new Error("unreachable");
    expect(outcome.reason).toMatch(/exited 1.*boom/);
  });
});
