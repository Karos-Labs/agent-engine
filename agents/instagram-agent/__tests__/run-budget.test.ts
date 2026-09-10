import { describe, expect, it } from "vitest";
import {
  CANDIDATES_PER_PHOTO_SLIDE,
  DEFAULT_RUN_BUDGET_PLAN,
  DEFAULT_RUN_SHAPE,
  DRAFT_ATTEMPT_ESTIMATE_USD,
  EMPTY_RUN_BUDGET_HISTORY,
  BRIEF_REFRESH_SCRAPER_EXECUTIONS,
  GENERATED_IMAGES_PER_RUN_CAP,
  MAX_RUN_SPEND_USD,
  RUN_BUDGET_BELIEF_KEY,
  RunSpendMeter,
  STEP_COST_ESTIMATES_USD,
  TARGET_RUN_SPEND_USD,
  calibrationPosture,
  estimateRunCost,
  estimateVsActualLine,
  maxCrossedNote,
  planRunBudget,
  readBudgetHistory,
  recordRunInHistory,
  remainingGenerationBudget,
  summarizeRunBudget,
  targetCrossedNote,
} from "../src/workflow/run-budget.js";

/**
 * Phase 0 cost controls (owner's target $1.00 / hard max $1.50 per run, and
 * the 2026-09-09 amendment: the budget ADAPTS and never holds) — the pure
 * meter, the image cap, the pre-run planner and the per-client learning in
 * isolation. The workflow-level proofs (an over-target estimate adapts the
 * plan and the run completes; an over-max actual finishes degraded with a
 * full deliverable and a ledger row; the next run starts tighter; a fake
 * `image.generate` never asked for more than the cap) live in
 * `run-budget-workflow.test.ts`.
 */

/**
 * Every evidence pull a cache hit — the steady-state weekly run. Kept next to
 * `DEFAULT_RUN_SHAPE` (the cold worst case the planner is fed) so the two
 * ends of the range are both exercised.
 */
const WARM_RUN_SHAPE = { ...DEFAULT_RUN_SHAPE, trendQueries: 0, signalExecutions: 0, researchLaneQueries: 0, pageFetches: 0 };

/** A client whose past runs cost about half what the cold worst case predicts — the calibration every client reaches after one delivered run. */
const CALIBRATED_HISTORY = { ...EMPTY_RUN_BUDGET_HISTORY, ewmaRatio: 0.5, runs: [] };

describe("RunSpendMeter.add — max(measured, estimate), never trusting a $0 reading", () => {
  it("counts the estimate when the step reported nothing", () => {
    const meter = new RunSpendMeter();
    meter.add("05-write-copy-attempt-1", undefined, STEP_COST_ESTIMATES_USD.copyAttempt);
    expect(meter.totalUsd).toBe(0.12);
    expect(meter.lines[0]).toMatchObject({ label: "05-write-copy-attempt-1", usd: 0.12, estimateUsd: 0.12, basis: "estimate" });
    expect(meter.lines[0]).not.toHaveProperty("measuredUsd");
  });

  it("counts the estimate when the step reported exactly $0 — a Vertex step that certainly ran a model", () => {
    const meter = new RunSpendMeter();
    meter.add("06-vet-images-attempt-1", 0, STEP_COST_ESTIMATES_USD.vetCall);
    expect(meter.totalUsd).toBe(0.006);
    expect(meter.lines[0]!.basis).toBe("estimate");
  });

  it("counts the measured figure when it exceeds the estimate", () => {
    const meter = new RunSpendMeter();
    meter.add("05-write-copy-attempt-1", 0.31, STEP_COST_ESTIMATES_USD.copyAttempt);
    expect(meter.totalUsd).toBe(0.31);
    expect(meter.lines[0]).toMatchObject({ measuredUsd: 0.31, estimateUsd: 0.12, basis: "measured" });
  });

  it("counts the estimate when the measured figure is below it — an under-reporting vendor is still bounded", () => {
    const meter = new RunSpendMeter();
    meter.add("05-write-copy-attempt-1", 0.02, STEP_COST_ESTIMATES_USD.copyAttempt);
    expect(meter.totalUsd).toBe(0.12);
    expect(meter.lines[0]).toMatchObject({ measuredUsd: 0.02, basis: "estimate" });
  });

  it("treats a negative or non-finite measurement as 'nothing reported'", () => {
    const meter = new RunSpendMeter();
    meter.add("a", -1, 0.01);
    meter.add("b", Number.NaN, 0.01);
    meter.add("c", Number.POSITIVE_INFINITY, 0.01);
    expect(meter.totalUsd).toBe(0.03);
    expect(meter.lines.every((l) => l.basis === "estimate" && l.measuredUsd === undefined)).toBe(true);
  });

  it("never fails the run on a bad estimate — a negative estimate counts as zero", () => {
    const meter = new RunSpendMeter();
    expect(() => meter.add("odd", undefined, -5)).not.toThrow();
    expect(meter.totalUsd).toBe(0);
  });
});

describe("RunSpendMeter.totalUsd / lines", () => {
  it("sums every line in insertion order and rounds away float artefacts", () => {
    const meter = new RunSpendMeter();
    meter.add("copy", undefined, 0.1);
    meter.add("vet", undefined, 0.2);
    meter.add("image", 0.039, STEP_COST_ESTIMATES_USD.generatedImage);
    // 0.1 + 0.2 in IEEE-754 is 0.30000000000000004 — the payload must not show that.
    expect(meter.totalUsd).toBe(0.339);
    expect(meter.lines.map((l) => l.label)).toEqual(["copy", "vet", "image"]);
  });

  it("starts at zero with no lines", () => {
    const meter = new RunSpendMeter();
    expect(meter.totalUsd).toBe(0);
    expect(meter.lines).toHaveLength(0);
  });
});

describe("RunSpendMeter.canAfford — flips exactly at the $1.50 ceiling", () => {
  it("allows a step that lands exactly on the ceiling", () => {
    const meter = new RunSpendMeter();
    meter.add("so far", undefined, 1.38);
    expect(meter.canAfford(0.12)).toEqual({ ok: true });
  });

  it("refuses a step that would cross it by a cent, naming the money", () => {
    const meter = new RunSpendMeter();
    meter.add("so far", undefined, 1.39);
    const verdict = meter.canAfford(0.12);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("$1.39 spent so far");
    expect(verdict.reason).toContain("$0.12");
    expect(verdict.reason).toContain("$1.51");
    expect(verdict.reason).toContain("$1.50 per-run ceiling");
  });

  it("is not fooled by float summation near the boundary", () => {
    const meter = new RunSpendMeter();
    // 0.1 x 15 = 1.5000000000000002 in floating point; the ceiling comparison must read it as 1.50.
    for (let i = 0; i < 14; i++) meter.add(`step ${i}`, undefined, 0.1);
    expect(meter.canAfford(0.1)).toEqual({ ok: true });
    // Comparisons are made at micro-dollar precision: a single cent over is refused, a sub-micro-dollar float artefact is not.
    expect(meter.canAfford(0.11).ok).toBe(false);
    expect(meter.canAfford(0.100001).ok).toBe(false);
  });

  it("a fresh meter affords the whole ceiling and nothing more", () => {
    const meter = new RunSpendMeter();
    expect(meter.canAfford(MAX_RUN_SPEND_USD)).toEqual({ ok: true });
    expect(meter.canAfford(MAX_RUN_SPEND_USD + 0.01).ok).toBe(false);
  });

  it("the pre-attempt bundle is copy + vet + visual QA", () => {
    expect(DRAFT_ATTEMPT_ESTIMATE_USD).toBeCloseTo(0.12 + 0.006 + 0.004, 10);
  });
});

describe("remainingGenerationBudget — 8 generated images per run", () => {
  it("is the cap minus what was already generated, never negative", () => {
    expect(GENERATED_IMAGES_PER_RUN_CAP).toBe(8);
    expect(remainingGenerationBudget(0)).toBe(8);
    expect(remainingGenerationBudget(6)).toBe(2);
    expect(remainingGenerationBudget(8)).toBe(0);
    expect(remainingGenerationBudget(11)).toBe(0);
  });

  it("reads a nonsensical count as zero generated rather than throwing", () => {
    expect(remainingGenerationBudget(Number.NaN)).toBe(8);
    expect(remainingGenerationBudget(-3)).toBe(8);
    expect(remainingGenerationBudget(2.7)).toBe(6);
  });
});

describe("estimateRunCost — every term priced off what the run actually bills", () => {
  /** Isolates the per-attempt terms: the rescue tier also scales with the photo count, so it is switched off for the differencing tests. */
  const noRescue = { ...DEFAULT_RUN_BUDGET_PLAN, optionalRevets: false };

  it("prices 05c candidate inspection at the harvester's real width — six candidates per photo slide, not one", () => {
    const withPhotos = estimateRunCost(noRescue, DEFAULT_RUN_SHAPE);
    const noPhotos = estimateRunCost(noRescue, { ...DEFAULT_RUN_SHAPE, photoSlides: 0 });
    // `media.findImages` is asked for `maxPerNeed: CANDIDATES_PER_PHOTO_SLIDE`
    // per slide and 05c inspects every candidate in that pool, on every
    // allowed attempt. Pricing it at one image per slide under-counted the
    // second-largest per-attempt cost sixfold.
    const expected = noRescue.maxSelfCheckAttempts * DEFAULT_RUN_SHAPE.photoSlides * CANDIDATES_PER_PHOTO_SLIDE * STEP_COST_ESTIMATES_USD.visionInspectPerImage;
    expect(CANDIDATES_PER_PHOTO_SLIDE).toBe(6);
    expect(expected).toBeCloseTo(0.108, 6);
    expect(withPhotos.rawUsd - noPhotos.rawUsd).toBeCloseTo(expected, 6);
  });

  it("prices 08a4 rendered inspection off the SLIDE count, since it looks at every rendered slide", () => {
    const eight = estimateRunCost(noRescue, { ...DEFAULT_RUN_SHAPE, photoSlides: 0, slideCount: 8 });
    const six = estimateRunCost(noRescue, { ...DEFAULT_RUN_SHAPE, photoSlides: 0, slideCount: 6 });
    expect(eight.rawUsd - six.rawUsd).toBeCloseTo(noRescue.maxSelfCheckAttempts * 2 * STEP_COST_ESTIMATES_USD.visionInspectPerImage, 6);
    // A shape that claims more photo slides than slides is priced at the
    // larger of the two rather than under-counting the render.
    expect(estimateRunCost(noRescue, { ...DEFAULT_RUN_SHAPE, photoSlides: 8, slideCount: 6 }).rawUsd).toBeCloseTo(
      estimateRunCost(noRescue, { ...DEFAULT_RUN_SHAPE, photoSlides: 8, slideCount: 8 }).rawUsd,
      6,
    );
  });

  it("the cold Phase 1 carousel does not fit the target, so the first lever fires on this phase's own spend", () => {
    // $1.14 cold English. Every term of the $0.2015 fixed line is Phase 1
    // spend the estimator used to be blind to: 03e's eight signal
    // executions, 04a2's six lane queries, 04a3's two page fetches, the
    // re-priced scout and extraction, and 04i's angle. Priced at Phase 0's
    // `fixed` ($0.049) the same run read as $0.99, `fits()` was true, and the
    // adaptation the owner's amendment exists to trigger never fired.
    const cold = estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, DEFAULT_RUN_SHAPE);
    expect(cold.breakdown.fixed).toBeCloseTo(0.2015, 6);
    expect(cold.estimatedUsd).toBeGreaterThan(TARGET_RUN_SPEND_USD);
    const decision = planRunBudget(DEFAULT_RUN_SHAPE);
    expect(decision.adaptations).toEqual(["images capped at 4"]);
    expect(decision.estimate.estimatedUsd).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD);
    // A Hebrew client pays the fluency judge on every attempt and needs one
    // lever more.
    expect(planRunBudget({ ...DEFAULT_RUN_SHAPE, targetLanguage: true }).adaptations).toEqual(["images capped at 4", "images capped at 2"]);
  });

  it("prices every once-per-run line Phase 1 added, each one off the step that bills it", () => {
    const of = (shape: Partial<typeof DEFAULT_RUN_SHAPE>) => estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, { ...DEFAULT_RUN_SHAPE, ...shape }).rawUsd;
    const base = of({});
    const c = STEP_COST_ESTIMATES_USD;
    // 03e-topic-signals: reference accounts + community queries.
    expect(base - of({ signalExecutions: 0 })).toBeCloseTo(8 * c.scraperExecution, 6);
    // 04a2-research-pull-deep: the three lanes (Phase 0 priced ONE pull).
    expect(base - of({ researchLaneQueries: 0 })).toBeCloseTo(6 * c.scraperExecution, 6);
    // 04a3-fetch-primary-sources.
    expect(base - of({ pageFetches: 0 })).toBeCloseTo(2 * c.scraperExecution, 6);
    // 04i-propose-angles, once for the initial round.
    expect(base - of({ angleRounds: 0 })).toBeCloseTo(c.angle, 6);
    // 00b2-write-client-brief plus 00b1's page/socialHistory scrapes — only
    // on the runs `00b` sent to the writer.
    expect(of({ briefRefresh: true }) - base).toBeCloseTo(c.brief + BRIEF_REFRESH_SCRAPER_EXECUTIONS * c.scraperExecution, 6);
    // The re-priced Phase 1 model calls (scout 18k/2.5k, extraction 20k/3k).
    expect(c.scout).toBeCloseTo(0.012, 6);
    expect(c.extraction).toBeCloseTo(0.0135, 6);
  });

  it("a first run for a new client is planned WITH the brief it is about to write, not after it", () => {
    // $1.32 cold with the refresh, so the ladder runs to the fourth rung
    // rather than discovering $0.18 of Sonnet on the meter.
    const refresh = { ...DEFAULT_RUN_SHAPE, briefRefresh: true };
    expect(estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, refresh).estimatedUsd).toBeGreaterThan(1.3);
    const decision = planRunBudget(refresh);
    expect(decision.adaptations.length).toBeGreaterThan(1);
    expect(decision.estimate.estimatedUsd).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD);
    expect(decision.spentBeforePlanUsd).toBe(0);
  });

  it("money already billed before the plan is money the plan cannot spend: the target left is what it fits", () => {
    // Belt for the ordering invariant (`02j` runs before `00b1`/`00b2`): if a
    // paid step is ever added above it, the lever still fires.
    const warmFits = planRunBudget(WARM_RUN_SHAPE, CALIBRATED_HISTORY);
    expect(warmFits.adaptations).toEqual([]);
    const withSpend = planRunBudget(WARM_RUN_SHAPE, CALIBRATED_HISTORY, { spentUsd: 0.6 });
    expect(withSpend.adaptations).not.toEqual([]);
    expect(withSpend.spentBeforePlanUsd).toBe(0.6);
    expect(withSpend.note).toContain("$0.60 was already spent before the plan");
    expect(withSpend.estimate.estimatedUsd + 0.6).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD + 1e-9);
    // A nonsensical figure is read as nothing spent rather than thrown on.
    expect(planRunBudget(WARM_RUN_SHAPE, CALIBRATED_HISTORY, { spentUsd: Number.NaN }).spentBeforePlanUsd).toBe(0);
  });
});

describe("planRunBudget — the owner's levers, in order, never a hold", () => {
  it("a warm run for a calibrated client fits the $1.00 target with no adaptation and says so", () => {
    // The steady state: caches warm, and one delivered run's worth of history
    // saying the cold worst case over-predicts. This is the shape that gets
    // the full plan — a first, cold, uncalibrated run does not, and the test
    // above proves the lever fires there instead.
    const decision = planRunBudget(WARM_RUN_SHAPE, CALIBRATED_HISTORY);
    expect(decision.plan).toEqual(DEFAULT_RUN_BUDGET_PLAN);
    expect(decision.adaptations).toEqual([]);
    expect(decision.estimate.estimatedUsd).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD);
    expect(decision.estimate.estimatedUsd).toBeGreaterThan(0.3);
    expect(decision.note).toMatch(/^budget: estimate \$0\.\d\d ≤ \$1\.00 → full plan$/);
    expect(decision.calibration).toEqual({ ratio: 0.5, posture: "default", pastRuns: 0 });
  });

  it("a non-English target adds the fluency judge to every attempt", () => {
    const english = estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, DEFAULT_RUN_SHAPE);
    const hebrew = estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, { ...DEFAULT_RUN_SHAPE, targetLanguage: true });
    expect(hebrew.estimatedUsd - english.estimatedUsd).toBeCloseTo(3 * STEP_COST_ESTIMATES_USD.fluency, 6);
  });

  it("over the target it caps images FIRST (8 -> 4) and records the adaptation in the reviewer's words", () => {
    // The cold Phase 1 default ($1.14): one lever (images 8 -> 4, $0.156 of
    // pictures instead of $0.312) brings it back to $0.98, and nothing else
    // is touched — no attempt is given up for a picture.
    const decision = planRunBudget(DEFAULT_RUN_SHAPE);
    expect(decision.initialEstimateUsd).toBeGreaterThan(TARGET_RUN_SPEND_USD);
    expect(decision.estimate.estimatedUsd).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD);
    expect(decision.plan.generatedImagesCap).toBe(4);
    expect(decision.plan.maxSelfCheckAttempts).toBe(3);
    expect(decision.plan.evidencePulls).toBe("full");
    expect(decision.plan.optionalRevets).toBe(true);
    expect(decision.adaptations).toEqual(["images capped at 4"]);
    expect(decision.note).toMatch(/^budget: estimate \$1\.\d\d > \$1\.00 → images capped at 4 \(now \$0\.\d\d\)$/);
  });

  it("pulls every lever in the owner's order when one is not enough: images, evidence pulls, one return instead of two, re-vets", () => {
    // 1.8x on the cold Phase 1 shape: $2.05 initially, still $1.08 with no
    // images, reduced evidence and one return instead of two, and $0.96 once
    // the optional re-vets go too — so every rung of the ladder is needed and
    // the last one fits.
    const history = { ...EMPTY_RUN_BUDGET_HISTORY, ewmaRatio: 1.8, runs: [] };
    const decision = planRunBudget(DEFAULT_RUN_SHAPE, history);
    expect(decision.adaptations).toEqual([
      "images capped at 4",
      "images capped at 2",
      "no generated images (stock or text-only)",
      "trend evidence reduced to the one cached industry query",
      "one return to step 05 instead of two",
      "optional rescue re-vets skipped",
    ]);
    expect(decision.plan).toEqual({ maxSelfCheckAttempts: 2, generatedImagesCap: 0, evidencePulls: "reduced", optionalRevets: false });
    expect(decision.estimate.estimatedUsd).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD);
  });

  it("when even the tightest plan does not fit, it still returns a plan — the run proceeds and the note says so", () => {
    const history = { ...EMPTY_RUN_BUDGET_HISTORY, ewmaRatio: 3, runs: [] };
    const decision = planRunBudget({ ...DEFAULT_RUN_SHAPE, targetLanguage: true, photoSlides: 8 }, history);
    expect(decision.plan.maxSelfCheckAttempts).toBe(2);
    expect(decision.estimate.estimatedUsd).toBeGreaterThan(TARGET_RUN_SPEND_USD);
    expect(decision.note).toMatch(/still \$\d\.\d\d on the tightest plan — running anyway/);
  });

  it("starts TIGHT (images capped at 4) after an overrun, and relaxes again only after two runs under target", () => {
    let history = recordRunInHistory(EMPTY_RUN_BUDGET_HISTORY, { runId: "r1", at: "", estimatedUsd: 0.8, actualUsd: 1.1, crossedTarget: true, crossedMax: false, adaptations: 0 });
    expect(calibrationPosture(history)).toBe("tight");
    const tight = planRunBudget(DEFAULT_RUN_SHAPE, history);
    expect(tight.calibration.posture).toBe("tight");
    expect(tight.plan.generatedImagesCap).toBeLessThanOrEqual(4);
    expect(tight.adaptations[0]).toMatch(/^started tight after 1 run\(s\) over target: images capped at 4$/);

    history = recordRunInHistory(history, { runId: "r2", at: "", estimatedUsd: 0.6, actualUsd: 0.5, crossedTarget: false, crossedMax: false, adaptations: 1 });
    expect(calibrationPosture(history)).toBe("tight");
    history = recordRunInHistory(history, { runId: "r3", at: "", estimatedUsd: 0.6, actualUsd: 0.5, crossedTarget: false, crossedMax: false, adaptations: 1 });
    expect(calibrationPosture(history)).toBe("default");
    expect(history.underTargetStreak).toBe(2);
    expect(history.overrunStreak).toBe(0);
  });
});

describe("RunBudgetHistory — EWMA of actual/estimate, tolerant of anything in the beliefs document", () => {
  it("the first run sets the ratio outright; later runs blend at alpha 0.5; a replayed run is not double-counted", () => {
    let h = recordRunInHistory(EMPTY_RUN_BUDGET_HISTORY, { runId: "a", at: "", estimatedUsd: 1, actualUsd: 2, crossedTarget: true, crossedMax: true, adaptations: 0 });
    expect(h.ewmaRatio).toBe(2);
    h = recordRunInHistory(h, { runId: "b", at: "", estimatedUsd: 1, actualUsd: 1, crossedTarget: false, crossedMax: false, adaptations: 0 });
    expect(h.ewmaRatio).toBe(1.5);
    const replayed = recordRunInHistory(h, { runId: "b", at: "", estimatedUsd: 1, actualUsd: 9, crossedTarget: true, crossedMax: true, adaptations: 0 });
    expect(replayed).toBe(h);
    expect(h.runs.map((r) => r.runId)).toEqual(["a", "b"]);
  });

  it("bounds a wild ratio so one bad reading cannot make the estimator refuse every plan", () => {
    const h = recordRunInHistory(EMPTY_RUN_BUDGET_HISTORY, { runId: "a", at: "", estimatedUsd: 0.1, actualUsd: 9, crossedTarget: true, crossedMax: true, adaptations: 0 });
    expect(h.ewmaRatio).toBe(3);
    const low = recordRunInHistory(EMPTY_RUN_BUDGET_HISTORY, { runId: "a", at: "", estimatedUsd: 1, actualUsd: 0, crossedTarget: false, crossedMax: false, adaptations: 0 });
    expect(low.ewmaRatio).toBe(0.5);
  });

  it("reads an empty, missing or malformed beliefs document as no history", () => {
    expect(readBudgetHistory(undefined)).toEqual(EMPTY_RUN_BUDGET_HISTORY);
    expect(readBudgetHistory({})).toEqual(EMPTY_RUN_BUDGET_HISTORY);
    expect(readBudgetHistory({ [RUN_BUDGET_BELIEF_KEY]: "nonsense" })).toEqual(EMPTY_RUN_BUDGET_HISTORY);
    const partial = readBudgetHistory({ [RUN_BUDGET_BELIEF_KEY]: { ewmaRatio: "1.2", overrunStreak: 2, runs: [{ runId: "x", actualUsd: 1.2 }, { nope: true }] } });
    expect(partial.ewmaRatio).toBe(1);
    expect(partial.overrunStreak).toBe(2);
    expect(partial.runs).toEqual([{ runId: "x", at: "", estimatedUsd: 0, actualUsd: 1.2, crossedTarget: false, crossedMax: false, adaptations: 0 }]);
  });
});

describe("RunSpendMeter posture and the notes — the live meter adapts, it does not hold", () => {
  it("normal under the target, essential-only over it, cheapest-path over the hard max", () => {
    const meter = new RunSpendMeter();
    meter.add("a", undefined, 0.9);
    expect(meter.posture).toBe("normal");
    expect(meter.crossedTarget).toBe(false);
    meter.add("b", undefined, 0.2);
    expect(meter.posture).toBe("essential-only");
    expect(meter.crossedTarget).toBe(true);
    expect(meter.crossedMax).toBe(false);
    meter.add("c", 0.5, 0.01);
    expect(meter.posture).toBe("cheapest-path");
    expect(meter.crossedMax).toBe(true);
    expect(targetCrossedNote(meter, "06d-generate-images-attempt-2")).toMatch(/^budget: \$1\.60 spent at 06d-generate-images-attempt-2, over the \$1\.00 target — optional work stopped/);
    expect(maxCrossedNote(meter, "05-write-copy-attempt-3")).toMatch(/over the \$1\.50 hard max — finishing on the cheapest complete path .* never held$/);
  });

  it("summarizes estimate vs actual for the gate, the deliverable and the ledger", () => {
    const decision = planRunBudget(WARM_RUN_SHAPE, CALIBRATED_HISTORY);
    const meter = new RunSpendMeter();
    meter.add("05-write-copy-attempt-1", undefined, STEP_COST_ESTIMATES_USD.copyAttempt);
    const summary = summarizeRunBudget(decision, meter, [decision.note]);
    expect(summary).toMatchObject({ estimatedUsd: decision.estimate.estimatedUsd, actualUsd: 0.12, targetUsd: 1, maxUsd: 1.5, crossedTarget: false, crossedMax: false, posture: "normal", adaptations: [] });
    expect(summary.lines).toHaveLength(1);
    expect(estimateVsActualLine(summary)).toBe(`budget: estimated $${decision.estimate.estimatedUsd.toFixed(2)}, actual $0.12 (under target)`);
  });
});

describe("the estimate table", () => {
  it("the estimate table carries every unit the workflow meters", () => {
    expect(Object.keys(STEP_COST_ESTIMATES_USD).sort()).toEqual(
      [
        "angle",
        "brief",
        "copyAttempt",
        "extraction",
        "fluency",
        "generatedImage",
        "relevance",
        "scout",
        "scraperExecution",
        "vetCall",
        "visionInspectPerImage",
        "visualQa",
      ].sort(),
    );
    expect(Object.values(STEP_COST_ESTIMATES_USD).every((v) => v > 0)).toBe(true);
    // No Opus anywhere: the largest single-step estimate is the Sonnet copy draft, and it is an order of magnitude under the ceiling.
    expect(Math.max(...Object.values(STEP_COST_ESTIMATES_USD))).toBe(STEP_COST_ESTIMATES_USD.copyAttempt);
    expect(STEP_COST_ESTIMATES_USD.copyAttempt * 10).toBeLessThan(MAX_RUN_SPEND_USD);
  });
});
