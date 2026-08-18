import { describe, expect, it } from "vitest";
import { createCutGate } from "../src/tools/cut-gate.js";
import { ctx, fakeRunner } from "./test-helpers.js";

describe("video.cutGate", () => {
  it("reports tooling_error when no engine directory is configured", async () => {
    const { runner } = fakeRunner({ stdout: "", stderr: "", exitCode: 0 });
    const tool = createCutGate({ runner, env: {} });
    const outcome = await tool.execute({ jobPath: "job.json", transcriptPath: "t.json", verbose: false }, { ctx });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.verdict).toBe("tooling_error");
    expect((outcome.result as { reason: string }).reason).toContain("BRANDED_SHORTS_ENGINE_DIR");
  });

  it("builds the exact cut_check.py CLI contract and maps exit 0 to pass", async () => {
    const stdout = "CUT GATE: PASS (4 segments, 3 cuts, 18.20s from a 20.10s window)\n";
    const { runner, calls } = fakeRunner({ stdout, stderr: "", exitCode: 0 });
    const tool = createCutGate({ runner, engineDir: "/engine", pythonBin: "python3" });
    const outcome = await tool.execute({ jobPath: "/run/job.json", transcriptPath: "/run/transcript.json", verbose: false }, { ctx });

    expect(calls).toEqual([{ command: "python3", args: ["/engine/cut_check.py", "--job", "/run/job.json", "--transcript", "/run/transcript.json"] }]);
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result).toEqual({ verdict: "pass", evidence: [stdout.trim()], toolVersion: "1.0.0" });
  });

  it("adds --verbose when requested", async () => {
    const { runner, calls } = fakeRunner({ stdout: "CUT GATE: PASS (1 segments, 0 cuts, 2.00s from a 2.00s window)", stderr: "", exitCode: 0 });
    const tool = createCutGate({ runner, engineDir: "/engine" });
    await tool.execute({ jobPath: "job.json", transcriptPath: "t.json", verbose: true }, { ctx });
    expect(calls[0]!.args).toContain("--verbose");
  });

  it("parses HONESTY/DENSITY failures into content_fail evidence", async () => {
    const stdout = [
      "CUT GATE: FAIL (2)",
      "  - DENSITY: 5 cuts over 10.00s output = 5.00 per 10s, limit 4.0",
      "  - HONESTY: cut 3.00-3.40s removes content, not filler: 'and honestly'. Either keep it, or declare it in job['content_cuts'] with a reason.",
    ].join("\n");
    const { runner } = fakeRunner({ stdout, stderr: "", exitCode: 1 });
    const tool = createCutGate({ runner, engineDir: "/engine" });
    const outcome = await tool.execute({ jobPath: "job.json", transcriptPath: "t.json", verbose: false }, { ctx });

    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.verdict).toBe("content_fail");
    expect(outcome.result).toMatchObject({
      evidence: [
        "DENSITY: 5 cuts over 10.00s output = 5.00 per 10s, limit 4.0",
        "HONESTY: cut 3.00-3.40s removes content, not filler: 'and honestly'. Either keep it, or declare it in job['content_cuts'] with a reason.",
      ],
    });
  });

  it("maps a non-zero exit with no parseable report to tooling_error, never content_fail", async () => {
    const { runner } = fakeRunner({ stdout: "", stderr: "Traceback (most recent call last):\nKeyError: 'words'", exitCode: 1 });
    const tool = createCutGate({ runner, engineDir: "/engine" });
    const outcome = await tool.execute({ jobPath: "job.json", transcriptPath: "t.json", verbose: false }, { ctx });

    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.verdict).toBe("tooling_error");
    expect((outcome.result as { reason: string }).reason).toContain("KeyError");
  });
});
