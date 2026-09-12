import { describe, expect, it } from "vitest";
import {
  CHEAPEST_PATH_STUDIO_TEMPLATES,
  DEFAULT_SETUP_SHAPE,
  EMPTY_SETUP_BUDGET_HISTORY,
  MAX_RUN_SPEND_USD,
  MAX_SETUP_SPEND_USD,
  MIN_STUDIO_TEMPLATES,
  RunSpendMeter,
  SETUP_BUDGET_BELIEF_KEY,
  SETUP_STEP_COST_ESTIMATES_USD,
  STUDIO_TEMPLATES_TARGET,
  TARGET_RUN_SPEND_USD,
  TARGET_SETUP_SPEND_USD,
  estimateSetupCost,
  maxCrossedNote,
  planSetupBudget,
  readSetupBudgetHistory,
  recordSetupInHistory,
  setupEstimateVsActualLine,
  summarizeSetupBudget,
  targetCrossedNote,
  type SetupShape,
} from "../src/workflow/run-budget.js";

/**
 * Phase 2, item N — the SETUP budget (owner's second number: target $2.00,
 * hard max $3.00 per client per setup) under the same standing amendment as
 * the run budget: it ADAPTS and it never holds.
 *
 * The load-bearing claims here are (a) the levers fire in the owner's stated
 * order, (b) there is no refusal branch anywhere — not past the target, not
 * past the hard max, not with the calibration pinned at its ceiling — and
 * (c) the setup meter is the SAME class as the run meter with two different
 * numbers, so the run's $1.00/$1.50 posture is untouched. `run-budget.test.ts`
 * is the pin for that last one from the run side; the byte-identical
 * zero-argument constructor is re-asserted here from the setup side.
 */

/** Cold worst case, five templates and two repairs — spec N.5's own table figure. */
const FIVE_TEMPLATE_SHAPE: SetupShape = { ...DEFAULT_SETUP_SHAPE, templates: 5 };

/** A client whose one past setup billed three times its estimate — the calibration ceiling. */
const EXPENSIVE_HISTORY = { ...EMPTY_SETUP_BUDGET_HISTORY, ewmaRatio: 3, setups: [] };

describe("the setup estimate table", () => {
  it("carries every unit a setup can bill, and no Opus-priced line", () => {
    expect(Object.keys(SETUP_STEP_COST_ESTIMATES_USD).sort()).toEqual(
      ["artDirection", "designBrief", "formatMap", "sampleInspect", "scraperExecution", "setReview", "templateDesign", "templateRepair", "visualPatterns"].sort(),
    );
    expect(Object.values(SETUP_STEP_COST_ESTIMATES_USD).every((v) => v > 0)).toBe(true);
    // The two Sonnet authoring lines are the only ones above a cent, and even
    // six of the larger one plus the thesis is a fifth of the target.
    expect(Math.max(...Object.values(SETUP_STEP_COST_ESTIMATES_USD))).toBe(SETUP_STEP_COST_ESTIMATES_USD.templateDesign);
    expect(SETUP_STEP_COST_ESTIMATES_USD.designBrief + 6 * SETUP_STEP_COST_ESTIMATES_USD.templateDesign).toBeLessThan(TARGET_SETUP_SPEND_USD / 2);
  });

  it("prices spec N.5's cold five-template setup at $0.552, itemised", () => {
    const decision = planSetupBudget(FIVE_TEMPLATE_SHAPE);
    const estimate = estimateSetupCost({ templates: 5, repairsAllowed: 2, referenceImages: 12, setReview: true, visualDirection: true }, FIVE_TEMPLATE_SHAPE);
    expect(estimate.rawUsd).toBe(0.552);
    expect(estimate.breakdown).toEqual({ evidence: 0.075, design: 0.297, validation: 0.005, review: 0.004, repairs: 0.096, direction: 0.075 });
    // And the whole thing lands at roughly a quarter of the target with no
    // lever pulled, which is why the studio can afford one call per template.
    expect(decision.adaptations).toEqual([]);
    expect(decision.estimate.estimatedUsd).toBeLessThan(TARGET_SETUP_SPEND_USD / 3);
  });

  it("keeps a full six-template setup under target even with the calibration pinned at its ×3 ceiling", () => {
    const decision = planSetupBudget(DEFAULT_SETUP_SHAPE, EXPENSIVE_HISTORY);
    expect(decision.calibration.ratio).toBe(3);
    expect(decision.estimate.estimatedUsd).toBeLessThanOrEqual(TARGET_SETUP_SPEND_USD);
    expect(decision.plan.templates).toBe(STUDIO_TEMPLATES_TARGET);
    expect(decision.adaptations).toEqual([]);
    expect(decision.note).toContain("full plan");
  });
});

describe("planSetupBudget: the six levers, in the owner's order", () => {
  /**
   * A deliberately unaffordable shape, at the calibration ceiling.
   *
   * The scraper lines are the only ones NO lever reaches (the evidence a
   * setup reads is not optional work), so driving the plan past the hard max
   * takes an absurd number of them — which is itself the honest finding this
   * shape records: with `SocialHistoryInputSchema`'s own cap of six accounts,
   * a real setup cannot reach lever 6. The shape exists to prove the ORDER of
   * all six levers in one assertion rather than the existence of each.
   */
  const impossible: SetupShape = { templates: 6, repairs: 4, referenceAccounts: 90, sitePages: 20, referenceImages: 60, setReview: true, visualDirection: true };

  it("pulls them in order: images, set review, templates to four, repairs, visual direction, then below four only past the hard max", () => {
    const decision = planSetupBudget(impossible, EXPENSIVE_HISTORY);
    const order = decision.adaptations.join(" | ");

    // Lever 1 before lever 2 before lever 3, and so on — asserted as
    // positions, because the order IS the owner's instruction.
    expect(order.indexOf("reference-post images")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("no set review")).toBeGreaterThan(order.indexOf("reference-post images"));
    expect(order.indexOf("templates instead of")).toBeGreaterThan(order.indexOf("no set review"));
    expect(order.indexOf("repair turn")).toBeGreaterThan(order.indexOf("templates instead of"));
    expect(order.indexOf("visual direction deferred")).toBeGreaterThan(order.indexOf("repair turn"));
    expect(order.indexOf("cheapest complete path")).toBeGreaterThan(order.indexOf("visual direction deferred"));

    expect(decision.plan.referenceImages).toBe(0);
    expect(decision.plan.setReview).toBe(false);
    expect(decision.plan.repairsAllowed).toBe(0);
    expect(decision.plan.visualDirection).toBe(false);
    // NEVER a refusal: the decision has no such branch to take.
    expect(decision.plan.templates).toBeGreaterThanOrEqual(CHEAPEST_PATH_STUDIO_TEMPLATES);
    expect(decision).not.toHaveProperty("ok");
    expect(decision.note).toContain("generating anyway");
  });

  it("stops at four templates while the plan is merely over TARGET — two formats is not a menu", () => {
    // Over the target and under the hard max: levers 1-5 run, lever 6 does not.
    const overTarget: SetupShape = { templates: 6, repairs: 4, referenceAccounts: 22, sitePages: 8, referenceImages: 40, setReview: true, visualDirection: true };
    const decision = planSetupBudget(overTarget, EXPENSIVE_HISTORY);
    expect(decision.initialEstimateUsd).toBeGreaterThan(TARGET_SETUP_SPEND_USD);
    expect(decision.estimate.estimatedUsd).toBeLessThanOrEqual(MAX_SETUP_SPEND_USD);
    expect(decision.plan.templates).toBe(MIN_STUDIO_TEMPLATES);
    expect(decision.belowTemplateFloor).toBe(false);
    expect(decision.adaptations.join(" ")).not.toContain("cheapest complete path");
  });

  // The realistic route past the hard max is not a huge plan, it is a setup
  // that has ALREADY billed: a resumed `00c` whose earlier turns overran.
  it("goes below four ONLY past the hard max, one template at a time, with the reason recorded", () => {
    const decision = planSetupBudget(DEFAULT_SETUP_SHAPE, EMPTY_SETUP_BUDGET_HISTORY, { spentUsd: 2.7 });
    expect(decision.belowTemplateFloor).toBe(true);
    expect(decision.plan.templates).toBe(3);
    expect(decision.plan.templates).toBeLessThan(MIN_STUDIO_TEMPLATES);
    expect(decision.adaptations.at(-1)).toContain("generated 3 templates instead of 4 on the cheapest complete path (past the $3.00 hard max)");
    // And it stops as soon as it fits, rather than falling to the floor.
    expect(decision.plan.templates).toBeGreaterThan(CHEAPEST_PATH_STUDIO_TEMPLATES);
  });

  it("fits the plan to what is LEFT of the target when money was already spent on this setup", () => {
    const decision = planSetupBudget(DEFAULT_SETUP_SHAPE, EXPENSIVE_HISTORY, { spentUsd: 1.5 });
    expect(decision.spentBeforePlanUsd).toBe(1.5);
    // $1.81 of plan on top of $1.50 already spent does not fit $2.00, so the
    // levers fire even though the plan alone would have.
    expect(decision.adaptations.length).toBeGreaterThan(0);
    expect(decision.note).toContain("already spent on this setup");
  });

  it("never returns fewer than four templates for a plan that fits, and never more than six", () => {
    expect(planSetupBudget({ ...DEFAULT_SETUP_SHAPE, templates: 9 }).plan.templates).toBe(STUDIO_TEMPLATES_TARGET);
    expect(planSetupBudget({ ...DEFAULT_SETUP_SHAPE, templates: 1 }).plan.templates).toBe(MIN_STUDIO_TEMPLATES);
    // A replayed or hand-written shape with nonsense in it must not make the
    // planner subtract or refuse.
    const nonsense = planSetupBudget({ templates: Number.NaN, repairs: -3, referenceAccounts: Number.POSITIVE_INFINITY, sitePages: -1, referenceImages: Number.NaN, setReview: true, visualDirection: true });
    expect(nonsense.plan.templates).toBeGreaterThanOrEqual(CHEAPEST_PATH_STUDIO_TEMPLATES);
    expect(nonsense.plan.repairsAllowed).toBe(0);
    expect(Number.isFinite(nonsense.estimate.estimatedUsd)).toBe(true);
  });
});

describe("the setup meter is the run meter with two different numbers", () => {
  it("postures on the setup target and hard max, and says which budget it is", () => {
    const setup = new RunSpendMeter({ targetUsd: TARGET_SETUP_SPEND_USD, maxUsd: MAX_SETUP_SPEND_USD, scope: "setup" });
    setup.add("00c4-design-template-cover", undefined, SETUP_STEP_COST_ESTIMATES_USD.templateDesign);
    expect(setup.posture).toBe("normal");

    setup.add("00c-inflated", 2.0, 0);
    expect(setup.crossedTarget).toBe(true);
    expect(setup.crossedMax).toBe(false);
    // A $1.95 setup is over ITS target and nowhere near a run's hard max —
    // the exact confusion an unparameterised meter would have produced.
    expect(setup.totalUsd).toBeGreaterThan(MAX_RUN_SPEND_USD);
    expect(setup.posture).toBe("essential-only");
    expect(targetCrossedNote(setup, "00c4-design-template-closer")).toContain("over the $2.00 target");
    expect(setup.canAfford(1.5).ok).toBe(false);
    expect(setup.canAfford(1.5)).toMatchObject({ reason: expect.stringContaining("over the $3.00 per-setup ceiling") });

    setup.add("00c7-repair-template-cover", 1.2, 0);
    expect(setup.crossedMax).toBe(true);
    expect(setup.posture).toBe("cheapest-path");
    expect(maxCrossedNote(setup, "00c7-repair-template-cover")).toContain("over the $3.00 hard max");
  });

  it("leaves the zero-argument constructor byte-identical to the run meter it has always been", () => {
    const run = new RunSpendMeter();
    expect(run.targetUsd).toBe(TARGET_RUN_SPEND_USD);
    expect(run.maxUsd).toBe(MAX_RUN_SPEND_USD);
    expect(run.scope).toBe("run");
    run.add("05-write-copy-attempt-1", undefined, 1.01);
    expect(run.crossedTarget).toBe(true);
    expect(targetCrossedNote(run, "05")).toContain("over the $1.00 target");
    expect(run.canAfford(0.6)).toMatchObject({ reason: expect.stringContaining("over the $1.50 per-run ceiling") });
  });

  it("falls back to the run numbers for a limit computed badly, rather than throwing", () => {
    const meter = new RunSpendMeter({ targetUsd: Number.NaN, maxUsd: 0, scope: "   " });
    expect(meter.targetUsd).toBe(TARGET_RUN_SPEND_USD);
    expect(meter.maxUsd).toBe(MAX_RUN_SPEND_USD);
    expect(meter.scope).toBe("run");
  });
});

describe("reporting a setup exactly the way a run is reported", () => {
  it("summarizes estimate vs actual with the planned template count in the line", () => {
    const decision = planSetupBudget(FIVE_TEMPLATE_SHAPE);
    const meter = new RunSpendMeter({ targetUsd: TARGET_SETUP_SPEND_USD, maxUsd: MAX_SETUP_SPEND_USD, scope: "setup" });
    meter.add("00c3-write-design-brief", undefined, SETUP_STEP_COST_ESTIMATES_USD.designBrief);
    for (const id of ["cover", "closer", "stat_callout", "quote_card", "list_takeaway"]) {
      meter.add(`00c4-design-template-${id}`, undefined, SETUP_STEP_COST_ESTIMATES_USD.templateDesign);
    }
    const summary = summarizeSetupBudget(decision, meter, [decision.note, "1 dropped (cover: occupied 0.31 against a 0.42 floor after one repair)"]);

    expect(summary).toMatchObject({ targetUsd: 2, maxUsd: 3, crossedTarget: false, crossedMax: false, posture: "normal", adaptations: [] });
    expect(summary.actualUsd).toBe(0.297);
    expect(summary.lines).toHaveLength(6);
    expect(summary.notes[1]).toContain("1 dropped");
    expect(summary.estimatedUsd).toBe(0.552);
    expect(setupEstimateVsActualLine(summary)).toBe("setup budget: estimated $0.55, actual $0.30 (under target) for 5 planned template(s)");
  });

  it("round-trips history through the belief key and calibrates the next setup", () => {
    const first = recordSetupInHistory(EMPTY_SETUP_BUDGET_HISTORY, {
      runId: "run_first_setup",
      at: "2026-09-10T09:00:00.000Z",
      estimatedUsd: 0.6,
      actualUsd: 1.2,
      templatesStored: 5,
      templatesDropped: 1,
      crossedTarget: false,
      crossedMax: false,
      adaptations: 0,
    });
    expect(first.ewmaRatio).toBe(2);
    expect(first.setups).toHaveLength(1);

    // Idempotent per runId: a resumed 09b must not double-count one setup.
    expect(recordSetupInHistory(first, { ...first.setups[0]! })).toBe(first);

    const beliefs = { [SETUP_BUDGET_BELIEF_KEY]: first, someOtherKey: { untouched: true } };
    const read = readSetupBudgetHistory(beliefs);
    expect(read).toEqual(first);
    // The next setup starts calibrated at ×2 rather than ×1.
    expect(planSetupBudget(DEFAULT_SETUP_SHAPE, read).calibration).toEqual({ ratio: 2, pastSetups: 1 });
  });

  it("tolerates anything a hand edit or an older version left under the belief key", () => {
    expect(readSetupBudgetHistory(undefined)).toEqual(EMPTY_SETUP_BUDGET_HISTORY);
    expect(readSetupBudgetHistory({})).toEqual(EMPTY_SETUP_BUDGET_HISTORY);
    expect(readSetupBudgetHistory({ [SETUP_BUDGET_BELIEF_KEY]: "nonsense" })).toEqual(EMPTY_SETUP_BUDGET_HISTORY);
    const partial = readSetupBudgetHistory({
      [SETUP_BUDGET_BELIEF_KEY]: { ewmaRatio: "1.2", setups: [{ runId: "x", actualUsd: 0.9 }, { nope: true }] },
    });
    expect(partial.ewmaRatio).toBe(1);
    expect(partial.setups).toEqual([
      { runId: "x", at: "", estimatedUsd: 0, actualUsd: 0.9, templatesStored: 0, templatesDropped: 0, crossedTarget: false, crossedMax: false, adaptations: 0 },
    ]);
  });
});
