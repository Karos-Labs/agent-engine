import { describe, expect, it } from "vitest";
import { createRender } from "../src/tools/render.js";
import { ctx, fakeRunner } from "./test-helpers.js";

describe("video.render", () => {
  it("builds the exact build_short.py CLI contract", async () => {
    const { runner, calls } = fakeRunner({ stdout: "done: /run/edit/final.mp4  duration=24.30s  (side-data clean)\n", stderr: "", exitCode: 0 });
    const tool = createRender({ runner, engineDir: "/engine", pythonBin: "python3" });
    await tool.execute({ profilePath: "/p.json", jobPath: "/j.json", stage: "full" }, { ctx });

    expect(calls).toEqual([{ command: "python3", args: ["/engine/build_short.py", "--profile", "/p.json", "--job", "/j.json"] }]);
  });

  it("parses the output path and duration from the success line, with no warnings on a clean build", async () => {
    const { runner } = fakeRunner({ stdout: "done: /run/edit/final.mp4  duration=24.30s  (side-data clean)\n", stderr: "", exitCode: 0 });
    const tool = createRender({ runner, engineDir: "/engine", pythonBin: "python3" });
    const outcome = await tool.execute({ profilePath: "/p.json", jobPath: "/j.json", stage: "full" }, { ctx });

    expect(outcome).toEqual({
      status: "success",
      result: {
        outputPath: "/run/edit/final.mp4",
        durationSeconds: 24.3,
        stage: "full",
        stdout: "done: /run/edit/final.mp4  duration=24.30s  (side-data clean)\n",
        warnings: [],
      },
    });
  });

  it('stage "base" passes --until base and returns the base.mp4 path from the engine\'s own "base:" line, with no duration', async () => {
    const { runner, calls } = fakeRunner({ stdout: "extracting segments\n  seg_00: 5.00s\nconcat -> base.mp4\nbase: /run/edit/base.mp4\n", stderr: "", exitCode: 0 });
    const tool = createRender({ runner, engineDir: "/engine", pythonBin: "python3" });
    const outcome = await tool.execute({ profilePath: "/p.json", jobPath: "/j.json", stage: "base" }, { ctx });

    expect(calls[0]!.args).toEqual(["/engine/build_short.py", "--profile", "/p.json", "--job", "/j.json", "--until", "base"]);
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.outputPath).toBe("/run/edit/base.mp4");
    expect(outcome.result.durationSeconds).toBeNull();
    expect(outcome.result.stage).toBe("base");
  });

  it('stage "base" is a tooling_error when the engine exits 0 without its "base:" line — never a guessed path', async () => {
    const { runner } = fakeRunner({ stdout: "extracting segments\n", stderr: "", exitCode: 0 });
    const tool = createRender({ runner, engineDir: "/engine", pythonBin: "python3" });
    const outcome = await tool.execute({ profilePath: "/p.json", jobPath: "/j.json", stage: "base" }, { ctx });
    expect(outcome.status).toBe("tooling_error");
  });

  it("captures the caption-density WARNING line on an otherwise successful build, never silently discarding it", async () => {
    const stdout = [
      "  caption density WARNING: 3+ consecutive chunks without an emphasis word around cap_04 — v2 rule wants the second font every few words",
      "done: /run/edit/final.mp4  duration=18.00s  (side-data clean)",
    ].join("\n");
    const { runner } = fakeRunner({ stdout, stderr: "", exitCode: 0 });
    const tool = createRender({ runner, engineDir: "/engine", pythonBin: "python3" });
    const outcome = await tool.execute({ profilePath: "/p.json", jobPath: "/j.json", stage: "full" }, { ctx });

    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.warnings).toEqual([
      "caption density WARNING: 3+ consecutive chunks without an emphasis word around cap_04 — v2 rule wants the second font every few words",
    ]);
    expect(outcome.result.outputPath).toBe("/run/edit/final.mp4");
  });

  it("is a tooling_error on ffmpeg failure, never a content judgment", async () => {
    const { runner } = fakeRunner({ stdout: "", stderr: "FAILED: ffmpeg -y -i clip.mov ...\nUnknown encoder 'libx264'", exitCode: 1 });
    const tool = createRender({ runner, engineDir: "/engine", pythonBin: "python3" });
    const outcome = await tool.execute({ profilePath: "/p.json", jobPath: "/j.json", stage: "full" }, { ctx });

    expect(outcome.status).toBe("tooling_error");
    expect((outcome as { reason: string }).reason).toContain("Unknown encoder");
  });

  it("reports a missing engine directory as tooling_error without spawning anything", async () => {
    const { runner, calls } = fakeRunner({ stdout: "", stderr: "", exitCode: 0 });
    const tool = createRender({ runner, env: {} });
    const outcome = await tool.execute({ profilePath: "/p.json", jobPath: "/j.json", stage: "full" }, { ctx });

    expect(calls).toHaveLength(0);
    expect(outcome.status).toBe("tooling_error");
  });
});
