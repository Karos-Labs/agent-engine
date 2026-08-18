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

  it("passes and honestly flags the checks it does not yet implement", async () => {
    const { runner } = fakeRunner({
      stdout: ffprobeJson({ color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", color_range: "tv" }),
      stderr: "",
      exitCode: 0,
    });
    const tool = createSelfEvalGate({ runner });
    const outcome = await tool.execute({ videoPath: "/edit/final.mp4", renderWarnings: [] }, { ctx });

    if (outcome.status !== "success") throw new Error("unreachable");
    if (outcome.result.verdict !== "pass") throw new Error("expected a pass verdict");
    expect(outcome.result.evidence.join(" ")).toContain("not yet implemented");
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

    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.verdict).toBe("tooling_error");
  });

  it("is a tooling_error on unparseable ffprobe output, never silently passed", async () => {
    const { runner } = fakeRunner({ stdout: "not json", stderr: "", exitCode: 0 });
    const tool = createSelfEvalGate({ runner });
    const outcome = await tool.execute({ videoPath: "/edit/final.mp4", renderWarnings: [] }, { ctx });

    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.verdict).toBe("tooling_error");
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
