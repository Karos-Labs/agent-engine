import { describe, expect, it } from "vitest";
import { createRender } from "../src/tools/render.js";
import { ctx, fakeRunner } from "./test-helpers.js";

describe("video.render", () => {
  it("builds the exact build_short.py CLI contract", async () => {
    const { runner, calls } = fakeRunner({ stdout: "done: /run/edit/final.mp4  duration=24.30s  (side-data clean)\n", stderr: "", exitCode: 0 });
    const tool = createRender({ runner, engineDir: "/engine" });
    await tool.execute({ profilePath: "/p.json", jobPath: "/j.json" }, { ctx });

    expect(calls).toEqual([{ command: "python3", args: ["/engine/build_short.py", "--profile", "/p.json", "--job", "/j.json"] }]);
  });

  it("parses the output path and duration from the success line, with no warnings on a clean build", async () => {
    const { runner } = fakeRunner({ stdout: "done: /run/edit/final.mp4  duration=24.30s  (side-data clean)\n", stderr: "", exitCode: 0 });
    const tool = createRender({ runner, engineDir: "/engine" });
    const outcome = await tool.execute({ profilePath: "/p.json", jobPath: "/j.json" }, { ctx });

    expect(outcome).toEqual({
      status: "success",
      result: {
        outputPath: "/run/edit/final.mp4",
        durationSeconds: 24.3,
        stdout: "done: /run/edit/final.mp4  duration=24.30s  (side-data clean)\n",
        warnings: [],
      },
    });
  });

  it("captures the caption-density WARNING line on an otherwise successful build, never silently discarding it", async () => {
    const stdout = [
      "  caption density WARNING: 3+ consecutive chunks without an emphasis word around cap_04 — v2 rule wants the second font every few words",
      "done: /run/edit/final.mp4  duration=18.00s  (side-data clean)",
    ].join("\n");
    const { runner } = fakeRunner({ stdout, stderr: "", exitCode: 0 });
    const tool = createRender({ runner, engineDir: "/engine" });
    const outcome = await tool.execute({ profilePath: "/p.json", jobPath: "/j.json" }, { ctx });

    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.warnings).toEqual([
      "caption density WARNING: 3+ consecutive chunks without an emphasis word around cap_04 — v2 rule wants the second font every few words",
    ]);
    expect(outcome.result.outputPath).toBe("/run/edit/final.mp4");
  });

  it("is a tooling_error on ffmpeg failure, never a content judgment", async () => {
    const { runner } = fakeRunner({ stdout: "", stderr: "FAILED: ffmpeg -y -i clip.mov ...\nUnknown encoder 'libx264'", exitCode: 1 });
    const tool = createRender({ runner, engineDir: "/engine" });
    const outcome = await tool.execute({ profilePath: "/p.json", jobPath: "/j.json" }, { ctx });

    expect(outcome.status).toBe("tooling_error");
    expect((outcome as { reason: string }).reason).toContain("Unknown encoder");
  });

  it("reports a missing engine directory as tooling_error without spawning anything", async () => {
    const { runner, calls } = fakeRunner({ stdout: "", stderr: "", exitCode: 0 });
    const tool = createRender({ runner, env: {} });
    const outcome = await tool.execute({ profilePath: "/p.json", jobPath: "/j.json" }, { ctx });

    expect(calls).toHaveLength(0);
    expect(outcome.status).toBe("tooling_error");
  });
});
