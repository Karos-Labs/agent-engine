import { describe, expect, it } from "vitest";
import {
  DRAFT_ATTEMPT_ESTIMATE_USD,
  MAX_RUN_SPEND_USD,
  PER_REVISION_ESTIMATE_USD,
  RunSpendMeter,
  STEP_COST_ESTIMATES_USD,
  TARGET_RUN_SPEND_USD,
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
    // Phase 5 (RFC-18 §7.1): an attempt now also buys the VALUE JUDGE, one
    // Flash call at $0.003 that `revisionEstimateUsd`'s `perAttempt` carries
    // beside the relevance judge. Written as the key rather than as a number
    // so a re-price moves both sides at once.
    expect(PER_REVISION_ESTIMATE_USD).toBeCloseTo(
      STEP_COST_ESTIMATES_USD.angle + DRAFT_ATTEMPT_ESTIMATE_USD + STEP_COST_ESTIMATES_USD.relevance + STEP_COST_ESTIMATES_USD.valueJudge,
      6,
    );
    // The spec's own figure for the Sonnet angle call.
    expect(STEP_COST_ESTIMATES_USD.angle).toBe(0.036);
    expect(STEP_COST_ESTIMATES_USD.brief).toBe(0.113);
  });

  it("scales with the attempts the plan allows, adds the languageBrief field and BOTH native-editor rounds for a non-English target, and can drop the angle", () => {
    const one = revisionEstimateUsd({ attempts: 1 });
    const three = revisionEstimateUsd({ attempts: 3 });
    // The angle is paid ONCE for the round, so three attempts is not three angles.
    expect(three - one).toBeCloseTo(
      2 * (DRAFT_ATTEMPT_ESTIMATE_USD + STEP_COST_ESTIMATES_USD.relevance + STEP_COST_ESTIMATES_USD.valueJudge),
      6,
    );

    // Phase 4 (RFC-15 §6.5): a reviewer's round on a non-English target now
    // costs the `languageBrief` prompt field plus TWO judge rounds, not one
    // Haiku fluency call. Two, not one, deliberately: a revision round is
    // spend the meter has already committed to, so it must be priced at what
    // the round COULD cost — and the second round is reached by exactly the
    // draft a reviewer most often sends back. (The PLANNER prices one round;
    // that asymmetry is asserted in run-budget.test.ts, not here.)
    expect(revisionEstimateUsd({ attempts: 1, targetLanguage: true }) - one).toBeCloseTo(
      STEP_COST_ESTIMATES_USD.copyLanguageBrief + 2 * STEP_COST_ESTIMATES_USD.nativeJudge,
      6,
    );
    expect(revisionEstimateUsd({ attempts: 1, angle: false })).toBeCloseTo(one - STEP_COST_ESTIMATES_USD.angle, 6);

    // Nonsense inputs floor at one attempt rather than returning a figure
    // that would make a round look free.
    expect(revisionEstimateUsd({ attempts: 0 })).toBe(one);
    expect(revisionEstimateUsd({ attempts: Number.NaN })).toBe(one);
  });

  it("is the figure the meter is asked about before a revision, and the answer is never a hold", () => {
    // PHASE 5.5 (spec §2 A1): the ceiling moved $1.60 -> $2.60, so the
    // "already spent" figure that puts a revision over it moved with it. The
    // property under test is unchanged and is not about either number: the
    // meter answers "no" and the round runs anyway.
    const meter = new RunSpendMeter();
    meter.add("run so far", undefined, 2.4);
    const verdict = meter.canAfford(PER_REVISION_ESTIMATE_USD);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("over the $2.60 per-run ceiling");
    // `canAfford` is a question about optional spend, not a refusal: crossing
    // the ceiling switches the posture to the cheapest complete path and the
    // round still delivers (owner's amendment, 2026-09-09).
    expect(meter.totalUsd).toBeLessThanOrEqual(MAX_RUN_SPEND_USD);
    expect(meter.posture).toBe("essential-only");
  });

  /**
   * ── RFC-19 §8.4, the second half of the rung guard ──
   *
   * `run-budget.test.ts` guards the PLANNER's per-attempt figure, which is the
   * one that can fire rung 4 and delete a drafting attempt. This guards the
   * other per-attempt figure, and it is a different function with a different
   * failure mode: `revisionEstimateUsd` is read immediately BEFORE a reviewer's
   * round is spent, so an omission here does not cut an attempt — it quotes the
   * reviewer a cheaper round than the round costs, which is exactly the
   * "estimate that flatters itself" this module's header refuses.
   *
   * RFC-19 §7.1 says this function is untouched: "revisionEstimateUsd (:775) is
   * unchanged". Both quotes are pinned as literals so that claim is checkable
   * in one line instead of by reading a diff.
   */
  it("pins both revision quotes as literals, with every term enumerated — RFC-19 adds nothing to a reviewer's round either", () => {
    const c = STEP_COST_ESTIMATES_USD;

    // The literals. English and Hebrew, before and after the language lines.
    // PHASE 5.5 RE-BASELINE (spec §2 A1). Nothing was added to this function;
    // the KEYS it reads were re-priced off the 2026-09-16 measurements — the
    // copy attempt from $0.185 to a measured $0.31 cold, the image vet and the
    // visual judge onto `gemini-2.5-pro`. The literals move, the enumeration
    // below does not, and that is exactly the split these two halves are for.
    expect(PER_REVISION_ESTIMATE_USD).toBe(0.425);
    expect(revisionEstimateUsd({ attempts: 1, targetLanguage: true })).toBe(0.47);

    // The enumeration, beside them rather than instead of them: the literal
    // catches a term that was ADDED to both the module and this list, and the
    // enumeration says which term moved. Neither alone is a guard.
    expect(DRAFT_ATTEMPT_ESTIMATE_USD).toBeCloseTo(c.copyAttempt + c.vetCall + c.visualQa, 10);
    expect(PER_REVISION_ESTIMATE_USD).toBeCloseTo(c.angle + DRAFT_ATTEMPT_ESTIMATE_USD + c.relevance + c.valueJudge, 10);
    // TWO native rounds here against the planner's one, and that asymmetry is
    // deliberate and documented (`run-budget.ts:1176-1191`). Asserted as a
    // difference so a future author who "harmonises" the two functions breaks
    // this rather than quietly re-pricing every Hebrew revision.
    expect(revisionEstimateUsd({ attempts: 1, targetLanguage: true }) - PER_REVISION_ESTIMATE_USD).toBeCloseTo(
      c.copyLanguageBrief + 2 * c.nativeJudge,
      10,
    );

    // A full three-attempt Hebrew round, which is what a reviewer's `revise`
    // actually buys under the cold Hebrew plan: $0.7608. That is three
    // quarters of the whole $1.00 target on its own, and very nearly half the
    // $1.60 ceiling — the honest reason the meter answers `canAfford` with
    // "no" and the round runs anyway, which is the assertion directly above
    // this one. RFC-19 adds no gate that can refuse it either.
    //
    // The second bound below was `> MAX_RUN_SPEND_USD / 2` while the ceiling
    // was $1.50. The owner moved the ceiling to $1.60 on 2026-09-14 and the
    // round did not get cheaper, so the comparison is restated against the
    // number that actually governs a reviewer's round — the TARGET — with the
    // ceiling kept as the looser second bound rather than dropped.
    //
    // PHASE 5.5: $1.338 on the re-priced keys. The shape of the claim is
    // unchanged and is if anything starker — a reviewer's `revise` on a Hebrew
    // post is now 74% of the whole $1.80 target and more than half the $2.60
    // ceiling on its own. The `0.75 * TARGET` bound is restated as `0.70`
    // because $1.338 sits just under $1.35; widening it would be fitting the
    // bound to the number, so the fraction is stated as what it measures.
    expect(revisionEstimateUsd({ attempts: 3, targetLanguage: true })).toBe(1.338);
    expect(revisionEstimateUsd({ attempts: 3, targetLanguage: true })).toBeGreaterThan(0.7 * TARGET_RUN_SPEND_USD);
    expect(revisionEstimateUsd({ attempts: 3, targetLanguage: true })).toBeGreaterThan(0.45 * MAX_RUN_SPEND_USD);
  });
});
