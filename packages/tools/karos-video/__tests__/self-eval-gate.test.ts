import { describe, expect, it } from "vitest";
import { createSelfEvalGate } from "../src/tools/self-eval-gate.js";
import { ctx, fakeRunner } from "./test-helpers.js";

function ffprobeJson(stream: Record<string, string>): string {
  return JSON.stringify({ streams: [stream] });
}

describe("video.selfEvalGate", () => {
  it("calls ffprobe (not python) with the expected stream-entries contract", async () => {
    const { runner, calls } = fakeRunner({
      stdout: ffprobeJson({ color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", color_range: "tv" }),
      stderr: "",
      exitCode: 0,
    });
    const tool = createSelfEvalGate({ runner, ffprobeBin: "ffprobe" });
    await tool.execute({ videoPath: "/edit/final.mp4", renderWarnings: [] }, { ctx });

    expect(calls[0]!.command).toBe("ffprobe");
    expect(calls[0]!.args).toEqual([
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=color_space,color_transfer,color_primaries,color_range",
      "-of",
      "json",
      "/edit/final.mp4",
    ]);
  });

  it("with no engine directory, passes on the tags alone and says the engine's whole-file checks did not run", async () => {
    const { runner, calls } = fakeRunner({
      stdout: ffprobeJson({ color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", color_range: "tv" }),
      stderr: "",
      exitCode: 0,
    });
    const tool = createSelfEvalGate({ runner, env: {} });
    const outcome = await tool.execute({ videoPath: "/edit/final.mp4", renderWarnings: [] }, { ctx });

    if (outcome.status !== "success") throw new Error("unreachable");
    if (outcome.result.verdict !== "pass") throw new Error("expected a pass verdict");
    expect(outcome.result.evidence.join(" ")).toContain("did not run");
    expect(calls).toHaveLength(1); // ffprobe only — nothing spawned python
  });

  it("with an engine directory, runs self_eval.py after the tag check and merges its evidence into a pass", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = async (command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === "ffprobe") {
        return { stdout: ffprobeJson({ color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", color_range: "tv" }), stderr: "", exitCode: 0 };
      }
      return { stdout: "  sdr tags ok\n  flash scan 400 frames, 0 spikes\nSELF-EVAL GATE: PASS (13.30s)", stderr: "", exitCode: 0 };
    };
    const tool = createSelfEvalGate({ runner, engineDir: "/engine", ffprobeBin: "ffprobe" });
    const outcome = await tool.execute({ videoPath: "/edit/final.mp4", renderWarnings: [], profilePath: "/p.json", jobPath: "/j.json" }, { ctx });

    expect(calls[1]!.args).toEqual(["/engine/self_eval.py", "--video", "/edit/final.mp4", "--profile", "/p.json", "--job", "/j.json"]);
    if (outcome.status !== "success") throw new Error("unreachable");
    if (outcome.result.verdict !== "pass") throw new Error(`expected a pass verdict, got ${outcome.result.verdict}`);
    expect(outcome.result.evidence).toContain("SELF-EVAL GATE: PASS (13.30s)");
  });

  it("with an engine directory, a self_eval.py FAIL is a content_fail carrying its bullets even when the tags are clean", async () => {
    const runner = async (command: string) => {
      if (command === "ffprobe") {
        return { stdout: ffprobeJson({ color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", color_range: "tv" }), stderr: "", exitCode: 0 };
      }
      return { stdout: "SELF-EVAL GATE: FAIL (1)\n  - FLASH: 1 single-frame luma spike(s) that revert within 3 frames at 4.20s", stderr: "", exitCode: 1 };
    };
    const tool = createSelfEvalGate({ runner, engineDir: "/engine", ffprobeBin: "ffprobe" });
    const outcome = await tool.execute({ videoPath: "/edit/final.mp4", renderWarnings: [] }, { ctx });

    if (outcome.status !== "success") throw new Error("unreachable");
    if (outcome.result.verdict !== "content_fail") throw new Error(`expected a content_fail verdict, got ${outcome.result.verdict}`);
    expect(outcome.result.reason).toContain("FLASH");
  });

  it("with an engine directory, a self_eval.py crash (no parseable report) is a tooling_error, never a content judgment", async () => {
    const runner = async (command: string) => {
      if (command === "ffprobe") {
        return { stdout: ffprobeJson({ color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", color_range: "tv" }), stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "Traceback (most recent call last):\nModuleNotFoundError: No module named 'numpy'", exitCode: 1 };
    };
    const tool = createSelfEvalGate({ runner, engineDir: "/engine", ffprobeBin: "ffprobe" });
    const outcome = await tool.execute({ videoPath: "/edit/final.mp4", renderWarnings: [] }, { ctx });
    expect(outcome.status).toBe("tooling_error");
  });

  it("content_fails the HLG-orange-renders-as-red bug: HDR tags surviving onto the finished file", async () => {
    const { runner } = fakeRunner({
      stdout: ffprobeJson({ color_space: "bt2020nc", color_transfer: "arib-std-b67", color_primaries: "bt2020", color_range: "tv" }),
      stderr: "",
      exitCode: 0,
    });
    const tool = createSelfEvalGate({ runner });
    const outcome = await tool.execute({ videoPath: "/edit/final.mp4", renderWarnings: [] }, { ctx });

    if (outcome.status !== "success") throw new Error("unreachable");
    if (outcome.result.verdict !== "content_fail") throw new Error("expected a content_fail verdict");
    expect(outcome.result).toMatchObject({
      evidence: [
        "color_space=bt2020nc (expected bt709)",
        "color_primaries=bt2020 (expected bt709)",
        "color_transfer=arib-std-b67 (expected bt709)",
      ],
    });
  });

  it("is a tooling_error when ffprobe itself fails to read the file", async () => {
    const { runner } = fakeRunner({ stdout: "", stderr: "No such file or directory", exitCode: 1 });
    const tool = createSelfEvalGate({ runner });
    const outcome = await tool.execute({ videoPath: "/missing.mp4", renderWarnings: [] }, { ctx });

    // AU8: a broken engine/ffprobe run is a tooling_error OUTCOME, never a
    // successful call carrying a tooling_error verdict.
    expect(outcome.status).toBe("tooling_error");
    if (outcome.status === "success") throw new Error("unreachable");
    expect(outcome.reason).toBeTruthy();
  });

  it("is a tooling_error on unparseable ffprobe output, never silently passed", async () => {
    const { runner } = fakeRunner({ stdout: "not json", stderr: "", exitCode: 0 });
    const tool = createSelfEvalGate({ runner });
    const outcome = await tool.execute({ videoPath: "/edit/final.mp4", renderWarnings: [] }, { ctx });

    // AU8: a broken engine/ffprobe run is a tooling_error OUTCOME, never a
    // successful call carrying a tooling_error verdict.
    expect(outcome.status).toBe("tooling_error");
    if (outcome.status === "success") throw new Error("unreachable");
    expect(outcome.reason).toBeTruthy();
  });

  it("folds carried-forward render warnings (e.g. caption density) into evidence on a pass, without failing over them", async () => {
    const { runner } = fakeRunner({
      stdout: ffprobeJson({ color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", color_range: "tv" }),
      stderr: "",
      exitCode: 0,
    });
    const tool = createSelfEvalGate({ runner });
    const outcome = await tool.execute(
      { videoPath: "/edit/final.mp4", renderWarnings: ["caption density WARNING: 3+ consecutive chunks without an emphasis word around cap_04"] },
      { ctx },
    );

    if (outcome.status !== "success") throw new Error("unreachable");
    if (outcome.result.verdict !== "pass") throw new Error("expected a pass verdict — a render warning is advisory, never fatal on its own");
    expect(outcome.result.evidence).toContain("build warning: caption density WARNING: 3+ consecutive chunks without an emphasis word around cap_04");
  });

  it("also folds carried-forward render warnings into evidence on a content_fail, so they aren't lost when the SDR check independently fails", async () => {
    const { runner } = fakeRunner({
      stdout: ffprobeJson({ color_space: "bt2020nc", color_transfer: "arib-std-b67", color_primaries: "bt2020", color_range: "tv" }),
      stderr: "",
      exitCode: 0,
    });
    const tool = createSelfEvalGate({ runner });
    const outcome = await tool.execute({ videoPath: "/edit/final.mp4", renderWarnings: ["caption density WARNING: ..."] }, { ctx });

    if (outcome.status !== "success") throw new Error("unreachable");
    if (outcome.result.verdict !== "content_fail") throw new Error("expected a content_fail verdict");
    expect(outcome.result.evidence).toContain("build warning: caption density WARNING: ...");
  });
});
