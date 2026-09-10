import { describe, expect, it } from "vitest";
import {
  DRAFT_ATTEMPT_ESTIMATE_USD,
  MAX_RUN_SPEND_USD,
  PER_REVISION_ESTIMATE_USD,
  RunSpendMeter,
  STEP_COST_ESTIMATES_USD,
  revisionEstimateUsd,
} from "../src/workflow/run-budget.js";

/**
 * RFC-13 §K's cost half: what a REVISION round is expected to cost.
 *
 * A revision is not one more attempt. `revise` re-enters `draftOnce`, which
 * proposes a fresh angle at `04i` (once per revision, outside the attempt
 * loop) before drafting, so pricing a revision as one attempt under-counts
 * it by the whole Sonnet angle call. The owner's amendment still applies to
 * what the meter DOES with the figure: it degrades optional work, it never
 * refuses a reviewer's round.
 */
describe("PER_REVISION_ESTIMATE_USD / revisionEstimateUsd", () => {
  it("prices a revision as one angle proposal plus its drafting attempts, not as an attempt alone", () => {
    expect(PER_REVISION_ESTIMATE_USD).toBe(revisionEstimateUsd());
    expect(PER_REVISION_ESTIMATE_USD).toBeGreaterThan(DRAFT_ATTEMPT_ESTIMATE_USD);
    expect(PER_REVISION_ESTIMATE_USD).toBeCloseTo(STEP_COST_ESTIMATES_USD.angle + DRAFT_ATTEMPT_ESTIMATE_USD + STEP_COST_ESTIMATES_USD.relevance, 6);
    // The spec's own figure for the Sonnet angle call.
    expect(STEP_COST_ESTIMATES_USD.angle).toBe(0.036);
    expect(STEP_COST_ESTIMATES_USD.brief).toBe(0.113);
  });

  it("scales with the attempts the plan allows, adds the fluency judge for a non-English target, and can drop the angle", () => {
    const one = revisionEstimateUsd({ attempts: 1 });
    const three = revisionEstimateUsd({ attempts: 3 });
    // The angle is paid ONCE for the round, so three attempts is not three angles.
    expect(three - one).toBeCloseTo(2 * (DRAFT_ATTEMPT_ESTIMATE_USD + STEP_COST_ESTIMATES_USD.relevance), 6);

    expect(revisionEstimateUsd({ attempts: 1, targetLanguage: true }) - one).toBeCloseTo(STEP_COST_ESTIMATES_USD.fluency, 6);
    expect(revisionEstimateUsd({ attempts: 1, angle: false })).toBeCloseTo(one - STEP_COST_ESTIMATES_USD.angle, 6);

    // Nonsense inputs floor at one attempt rather than returning a figure
    // that would make a round look free.
    expect(revisionEstimateUsd({ attempts: 0 })).toBe(one);
    expect(revisionEstimateUsd({ attempts: Number.NaN })).toBe(one);
  });

  it("is the figure the meter is asked about before a revision, and the answer is never a hold", () => {
    const meter = new RunSpendMeter();
    meter.add("run so far", undefined, 1.45);
    const verdict = meter.canAfford(PER_REVISION_ESTIMATE_USD);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("over the $1.50 per-run ceiling");
    // `canAfford` is a question about optional spend, not a refusal: crossing
    // the ceiling switches the posture to the cheapest complete path and the
    // round still delivers (owner's amendment, 2026-09-09).
    expect(meter.totalUsd).toBeLessThanOrEqual(MAX_RUN_SPEND_USD);
    expect(meter.posture).toBe("essential-only");
  });
});
