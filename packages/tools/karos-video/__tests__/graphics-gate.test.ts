import { describe, expect, it } from "vitest";
import { createGraphicsGate } from "../src/tools/graphics-gate.js";
import { ctx, fakeRunner } from "./test-helpers.js";

describe("video.graphicsGate", () => {
  it("builds the exact graphic_qa.py CLI contract", async () => {
    const { runner, calls } = fakeRunner({ stdout: "PASS  chart->growth", stderr: "", exitCode: 0 });
    const tool = createGraphicsGate({ runner, engineDir: "/engine" });
    await tool.execute({ profilePath: "/p.json", videoPath: "/edit/base.mp4", jobPath: "/j.json" }, { ctx });

    expect(calls).toEqual([{ command: "python3", args: ["/engine/graphic_qa.py", "--profile", "/p.json", "--video", "/edit/base.mp4", "--job", "/j.json"] }]);
  });

  it("maps a VISIBILITY fail (contrast over dark footage) to content_fail with the remedy hint intact", async () => {
    const stdout = "FAIL  chart->growth: VISIBILITY fail (mean contrast 14, 40% strokes lost over footage) — remedy: heavier ink rim, or reposition away from bright zone";
    const { runner } = fakeRunner({ stdout, stderr: "", exitCode: 1 });
    const tool = createGraphicsGate({ runner, engineDir: "/engine" });
    const outcome = await tool.execute({ profilePath: "/p.json", videoPath: "/base.mp4", jobPath: "/j.json" }, { ctx });

    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.verdict).toBe("content_fail");
    expect((outcome.result as { reason: string }).reason).toContain("remedy: heavier ink rim");
  });

  it("passes with an honest 'nothing to check' note when the job has no overlays", async () => {
    const { runner } = fakeRunner({ stdout: "", stderr: "", exitCode: 0 });
    const tool = createGraphicsGate({ runner, engineDir: "/engine" });
    const outcome = await tool.execute({ profilePath: "/p.json", videoPath: "/base.mp4", jobPath: "/j.json" }, { ctx });

    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result).toEqual({ verdict: "pass", evidence: ["graphic_qa.py: PASS (nothing to check)"], toolVersion: "1.0.0" });
  });
});
