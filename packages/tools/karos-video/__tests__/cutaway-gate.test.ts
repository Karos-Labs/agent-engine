import { describe, expect, it } from "vitest";
import { createCutawayGate } from "../src/tools/cutaway-gate.js";
import { ctx, fakeRunner } from "./test-helpers.js";

describe("video.cutawayGate", () => {
  it("builds the exact cutaway_check.py CLI contract, omitting --allow-count by default", async () => {
    const { runner, calls } = fakeRunner({ stdout: "CUTAWAY GATE: PASS (4 cutaways, 2 graphics, no conflicts)", stderr: "", exitCode: 0 });
    const tool = createCutawayGate({ runner, engineDir: "/engine" });
    await tool.execute({ jobPath: "/j.json", transcriptPath: "/t.json", allowCount: false }, { ctx });

    expect(calls).toEqual([{ command: "python3", args: ["/engine/cutaway_check.py", "--job", "/j.json", "--transcript", "/t.json"] }]);
  });

  it("adds --allow-count for a short-runtime approved exception", async () => {
    const { runner, calls } = fakeRunner({ stdout: "CUTAWAY GATE: PASS (2 cutaways, 0 graphics, no conflicts)", stderr: "", exitCode: 0 });
    const tool = createCutawayGate({ runner, engineDir: "/engine" });
    await tool.execute({ jobPath: "/j.json", transcriptPath: "/t.json", allowCount: true }, { ctx });

    expect(calls[0]!.args).toContain("--allow-count");
  });

  it("parses TIMING/EXCLUSION failures into content_fail evidence", async () => {
    const stdout = [
      "CUTAWAY GATE: FAIL (2)",
      "  - cutaway[0] ('the launch') TIMING: lead 40ms is outside 80-150ms",
      "  - cutaway[1] ('the logo') EXCLUSION: window 12.0-14.0s overlaps graphic 'chart.mp4' (12.5-13.5s)",
    ].join("\n");
    const { runner } = fakeRunner({ stdout, stderr: "", exitCode: 1 });
    const tool = createCutawayGate({ runner, engineDir: "/engine" });
    const outcome = await tool.execute({ jobPath: "j.json", transcriptPath: "t.json", allowCount: false }, { ctx });

    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.verdict).toBe("content_fail");
    expect(outcome.result).toMatchObject({
      evidence: [
        "cutaway[0] ('the launch') TIMING: lead 40ms is outside 80-150ms",
        "cutaway[1] ('the logo') EXCLUSION: window 12.0-14.0s overlaps graphic 'chart.mp4' (12.5-13.5s)",
      ],
    });
  });

  it("propagates a missing engine directory as tooling_error without spawning anything", async () => {
    const { runner, calls } = fakeRunner({ stdout: "", stderr: "", exitCode: 0 });
    const tool = createCutawayGate({ runner, env: {} });
    const outcome = await tool.execute({ jobPath: "j.json", transcriptPath: "t.json", allowCount: false }, { ctx });

    expect(calls).toHaveLength(0);
    // AU8: a broken engine/ffprobe run is a tooling_error OUTCOME, never a
    // successful call carrying a tooling_error verdict.
    expect(outcome.status).toBe("tooling_error");
    if (outcome.status === "success") throw new Error("unreachable");
    expect(outcome.reason).toBeTruthy();
  });
});
