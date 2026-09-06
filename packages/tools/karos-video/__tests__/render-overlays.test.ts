import { describe, expect, it } from "vitest";
import { createRenderOverlays } from "../src/tools/render-overlays.js";
import { ctx, fakeRunner } from "./test-helpers.js";

describe("video.renderOverlays", () => {
  it("builds the exact render_overlays.py CLI contract", async () => {
    const { runner, calls } = fakeRunner({ stdout: "rendered anim-chart-0: 60 frames (chart)\nOVERLAYS: PASS (1 rendered)", stderr: "", exitCode: 0 });
    const tool = createRenderOverlays({ runner, engineDir: "/engine", pythonBin: "python3" });
    const outcome = await tool.execute({ profilePath: "/p.json", jobPath: "/j.json" }, { ctx });

    expect(calls).toEqual([{ command: "python3", args: ["/engine/render_overlays.py", "--profile", "/p.json", "--job", "/j.json"] }]);
    if (outcome.status !== "success") throw new Error("unreachable");
    if (outcome.result.verdict !== "pass") throw new Error(`expected a pass verdict, got ${outcome.result.verdict}`);
    // The script's own summary leads, and the per-overlay lines survive as
    // evidence — the summary alone does not say WHICH sequences exist.
    expect(outcome.result.evidence[0]).toBe("OVERLAYS: PASS (1 rendered)");
    expect(outcome.result.evidence).toContain("rendered anim-chart-0: 60 frames (chart)");
  });

  it("is a content_fail — feeding the plan's remedy loop — when an archetype has no renderer or a callout has no label", async () => {
    const { runner } = fakeRunner({
      stdout: [
        "rendered anim-chart-0: 60 frames (chart)",
        "OVERLAYS: FAIL (2)",
        '  - anim-sparkle_burst-1: no renderer for archetype "Sparkle Burst" — known: logo, chart, clock, browser, signoff, platforms, callout',
        "  - anim-callout-2: a `label` — the callout archetype renders the payoff word and has nothing to draw without one",
      ].join("\n"),
      stderr: "",
      exitCode: 1,
    });
    const tool = createRenderOverlays({ runner, engineDir: "/engine", pythonBin: "python3" });
    const outcome = await tool.execute({ profilePath: "/p.json", jobPath: "/j.json" }, { ctx });

    if (outcome.status !== "success") throw new Error("unreachable");
    if (outcome.result.verdict !== "content_fail") throw new Error(`expected a content_fail verdict, got ${outcome.result.verdict}`);
    expect(outcome.result.reason).toContain("Sparkle Burst");
    expect(outcome.result.reason).toContain("label");
  });

  it("is a tooling_error when the script crashes without a parseable report", async () => {
    const { runner } = fakeRunner({ stdout: "", stderr: "Traceback (most recent call last):\nModuleNotFoundError: No module named 'PIL'", exitCode: 1 });
    const tool = createRenderOverlays({ runner, engineDir: "/engine", pythonBin: "python3" });
    const outcome = await tool.execute({ profilePath: "/p.json", jobPath: "/j.json" }, { ctx });
    expect(outcome.status).toBe("tooling_error");
    expect((outcome as { reason: string }).reason).toContain("PIL");
  });

  it("reports a missing engine directory as tooling_error without spawning anything", async () => {
    const { runner, calls } = fakeRunner({ stdout: "", stderr: "", exitCode: 0 });
    const tool = createRenderOverlays({ runner, env: {} });
    const outcome = await tool.execute({ profilePath: "/p.json", jobPath: "/j.json" }, { ctx });
    expect(calls).toHaveLength(0);
    expect(outcome.status).toBe("tooling_error");
  });
});
