import { describe, expect, it } from "vitest";
import { INSTAGRAM_GOLDEN_RUNS } from "./src/golden-runs.js";
import { runInstagramDeterministicAssertions } from "./src/run-assertions.js";

describe("Instagram agent golden runs — deterministic assertions (RFC-01 §12)", () => {
  it("has at least one golden run defined", () => {
    expect(INSTAGRAM_GOLDEN_RUNS.length).toBeGreaterThan(0);
  });

  for (const goldenRun of INSTAGRAM_GOLDEN_RUNS) {
    it(`${goldenRun.id}: the endorsed research/copy/selections triple passes step 07's real self-check`, async () => {
      const results = await runInstagramDeterministicAssertions(goldenRun);
      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result.verdict, `${result.check} failed: ${result.reason ?? "(no reason)"}`).toBe("pass");
      }
    });

    it(`${goldenRun.id}: is deterministic — running it twice gives identical verdicts`, async () => {
      const first = await runInstagramDeterministicAssertions(goldenRun);
      const second = await runInstagramDeterministicAssertions(goldenRun);
      expect(first).toEqual(second);
    });
  }

  it("catches a regression: a slide whose sourceRef no longer traces to a real fact fails the self-check", async () => {
    const goldenRun = INSTAGRAM_GOLDEN_RUNS[0]!;
    const regressed = {
      ...goldenRun,
      endorsedCopy: {
        ...goldenRun.endorsedCopy,
        slides: goldenRun.endorsedCopy.slides.map((s, i) => (i === 0 ? { ...s, sourceRef: "a claim that was never in the research facts" } : s)),
      },
    };
    const results = await runInstagramDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "step07.checkSlidesData")!;
    expect(check.verdict).toBe("content_fail");
    expect(check.reason).toMatch(/does not match any research fact/i);
  });

  it("catches a regression: reintroducing a banned word into slide copy fails the self-check", async () => {
    const goldenRun = INSTAGRAM_GOLDEN_RUNS[0]!;
    const regressed = {
      ...goldenRun,
      endorsedCopy: {
        ...goldenRun.endorsedCopy,
        slides: goldenRun.endorsedCopy.slides.map((s, i) => (i === 0 ? { ...s, body: `${s.body} This is guaranteed to work.` } : s)),
      },
    };
    const results = await runInstagramDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "step07.checkSlidesData")!;
    expect(check.verdict).toBe("content_fail");
    expect(check.reason).toMatch(/banned word/i);
  });

  it("catches a regression: an unfillable slide (null imagePath) fails the no-unfillable-slide check", async () => {
    const goldenRun = INSTAGRAM_GOLDEN_RUNS[0]!;
    const regressed = {
      ...goldenRun,
      endorsedSelections: {
        selections: goldenRun.endorsedSelections.selections.map((s, i) => (i === 0 ? { ...s, imagePath: null } : s)),
      },
    };
    const results = await runInstagramDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "no-unfillable-slide")!;
    expect(check.verdict).toBe("content_fail");
  });

  it("catches a regression: canvas.scale drifting away from 2 fails the canvas.scale check", async () => {
    const goldenRun = INSTAGRAM_GOLDEN_RUNS[0]!;
    const regressed = { ...goldenRun, styleConfig: { ...goldenRun.styleConfig, canvas: { ...goldenRun.styleConfig.canvas, scale: 1 } } };
    const results = await runInstagramDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "canvas.scale")!;
    expect(check.verdict).toBe("content_fail");
  });
});
