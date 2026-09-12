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
  revisionEstimateUsd,
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
    expect(meter.totalUsd).toBe(0.161);
    expect(meter.lines[0]).toMatchObject({ label: "05-write-copy-attempt-1", usd: 0.161, estimateUsd: 0.161, basis: "estimate" });
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
    expect(meter.lines[0]).toMatchObject({ measuredUsd: 0.31, estimateUsd: 0.161, basis: "measured" });
  });

  it("counts the estimate when the measured figure is below it — an under-reporting vendor is still bounded", () => {
    const meter = new RunSpendMeter();
    meter.add("05-write-copy-attempt-1", 0.02, STEP_COST_ESTIMATES_USD.copyAttempt);
    expect(meter.totalUsd).toBe(0.161);
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

  it("the pre-attempt bundle is copy + vet + visual QA, at the @16/@4 prompt sizes", () => {
    expect(DRAFT_ATTEMPT_ESTIMATE_USD).toBeCloseTo(0.161 + 0.006 + 0.0041, 10);
    // The bundle is the three lines EVERY attempt pays regardless of language. Phase 4's two new keys are
    // deliberately NOT in it: `copyLanguageBrief` and `nativeJudge` are conditional on a resolved
    // `targetLanguage`, and folding either in here would over-state every English revision quote.
    expect(DRAFT_ATTEMPT_ESTIMATE_USD).toBeLessThan(DRAFT_ATTEMPT_ESTIMATE_USD + STEP_COST_ESTIMATES_USD.copyLanguageBrief);
  });

  // `copyAttempt` is priced on BOTH sides of the call, and both times the
  // output side is the one that moved: an output token costs 5x an input one
  // on Sonnet. @14 turned `customArchetype` from "a rare tool" into "at most
  // two per carousel" (a `bodyHtml` fragment plus a `css` block each, on top
  // of §19's device objects); @15 replaced a ~12-word `visualNeed` string
  // with a four-key object on EVERY slide. Priced on input growth alone the
  // estimate flattered itself by $0.0585 over three attempts at @14 and a
  // further $0.036 at @15 — each more than the whole first image lever.
  it("prices the copy call on its OUTPUT as well as its input, at the published Sonnet rates", () => {
    const SONNET_IN_PER_1M = 3;
    const SONNET_OUT_PER_1M = 15;
    /**
     * The @16 call: @15's 21.5k in plus the +3,020 prompt characters (§23, §16's `nativeSteer` paragraph,
     * §1's demotion header) at ~760 tokens — and @15's 6.3k out UNCHANGED, because §23 adds no output field.
     */
    const exact = (22_260 * SONNET_IN_PER_1M + 6_300 * SONNET_OUT_PER_1M) / 1_000_000;
    expect(exact).toBeCloseTo(0.16128, 10);
    // The table carries three decimals, so 0.1611 is entered as 0.161 — and the rounding is asserted to be
    // within half a mil rather than waved at, because the direction matters: this file's own header says an
    // estimate that flatters itself pulls no lever, and $0.0001 an attempt is the most it may flatter by.
    expect(STEP_COST_ESTIMATES_USD.copyAttempt).toBeCloseTo(exact, 3);
    expect(Math.abs(STEP_COST_ESTIMATES_USD.copyAttempt - exact)).toBeLessThan(0.0005);
    // The output half is still the larger half — the property an input-only
    // re-price cannot have.
    expect(6_300 * SONNET_OUT_PER_1M).toBeGreaterThan(22_200 * SONNET_IN_PER_1M);
    // @15's growth was priced on the side it landed on: the four-key `visualNeed` was ~800 more OUTPUT
    // tokens a draft (~$0.012) against ~455 more input (~$0.0014).
    const AT_14 = 0.1455;
    const AT_15 = 0.159;
    expect(AT_15 - AT_14).toBeCloseTo((455 * SONNET_IN_PER_1M + 800 * SONNET_OUT_PER_1M) / 1_000_000, 3);
    // @16's growth lands entirely on the INPUT side, which is the first time that has been true here, and
    // saying so is the point: §23 tells the writer how to sound, it does not ask for more copy. A re-price
    // that assumed the @15 shape and added an output term would over-state every English run.
    expect(STEP_COST_ESTIMATES_USD.copyAttempt - AT_15).toBeCloseTo((760 * SONNET_IN_PER_1M) / 1_000_000, 3);
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
    // Phase 3's own arithmetic, and the reason `copyAttempt` had to be
    // re-priced to the @15 call on BOTH sides: at an image cap of 4 the cold
    // English shape estimates $1.1018, so `fits()` is FALSE and the first
    // lever has to step three times — 4, then 2, then 0 — to land at
    // $0.9458. Priced at @13's $0.12 the same shape read as $0.9845, `fits()`
    // was true after one step, and the run still billed over the target.
    // Priced at @14's $0.1455 it stopped at cap 2 and $0.9833, with $0.0405
    // of §22 scene briefs unbudgeted behind it.
    expect(estimateRunCost({ ...DEFAULT_RUN_BUDGET_PLAN, generatedImagesCap: 4 }, DEFAULT_RUN_SHAPE).estimatedUsd).toBeCloseTo(1.1078, 6);
    expect(decision.adaptations).toEqual(["images capped at 4", "images capped at 2", "no generated images (stock or text-only)"]);
    expect(decision.plan.generatedImagesCap).toBe(0);
    expect(decision.estimate.estimatedUsd).toBeCloseTo(0.9518, 6);
    expect(decision.estimate.estimatedUsd).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD);
    // Phase 4 costs a cold Hebrew run $0.069 more over three attempts, against Phase 0's $0.0165, and the
    // English plan had only $0.048 of headroom left after the image levers. So it does NOT fit inside them,
    // and the honest thing to pin is what actually happens rather than a claim that it was absorbed: ONE
    // further lever fires, the cheapest one left, and the three drafting attempts survive.
    const hebrew = planRunBudget({ ...DEFAULT_RUN_SHAPE, targetLanguage: true });
    expect(hebrew.adaptations).toEqual([
      "images capped at 4",
      "images capped at 2",
      "no generated images (stock or text-only)",
      "trend evidence reduced to the one cached industry query",
    ]);
    expect(hebrew.estimate.estimatedUsd).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD);
    // The attempt lever is the one that must NOT fire. It is the last lever before the deliverable itself
    // gets worse, and firing it would buy $0.25 of headroom nobody asked for by taking a whole redraft away
    // from the clients this phase exists to serve — the failure mode that made the planner price the
    // conditional second judge round at one round rather than two (`rawEstimate`'s note).
    expect(hebrew.plan.maxSelfCheckAttempts).toBe(decision.plan.maxSelfCheckAttempts);
    expect(hebrew.adaptations).not.toContain("one return to step 05 instead of two");
    const perAttemptLanguage = STEP_COST_ESTIMATES_USD.copyLanguageBrief + STEP_COST_ESTIMATES_USD.nativeJudge;
    expect(3 * perAttemptLanguage).toBeCloseTo(0.069, 6);
    // And `fluency` is NOT what a Hebrew run is priced at any more — it is the cheapest-path degraded tier.
    expect(3 * perAttemptLanguage).not.toBeCloseTo(3 * STEP_COST_ESTIMATES_USD.fluency, 6);
    // Never a hold, at any point on this path: the plan adapted and the run is still a full three-attempt
    // run with a complete deliverable.
    expect(hebrew.plan.maxSelfCheckAttempts).toBeGreaterThanOrEqual(3);
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
    // 04e-read-cross-channel-history: one ScrappyCoco execution per account
    // the client configures. 04e has been scraping since it was written and
    // was metered for the first time in Phase 4 — fixing the METER without
    // this term leaves the plan knowingly short by up to $0.042 on a
    // multi-account client, which is the difference between the shipped
    // Hebrew plan fitting the $1.00 target and crossing it.
    expect(of({ socialAccounts: 6 }) - base).toBeCloseTo(6 * c.scraperExecution, 6);
    expect(of({ socialAccounts: 1 }) - base).toBeCloseTo(c.scraperExecution, 6);
    // The default shape prices it at zero — a client with no configured
    // accounts pays 04e nothing, and the real count is read from free config
    // at 02j.
    expect(DEFAULT_RUN_SHAPE.socialAccounts).toBe(0);
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

  it("a non-English target adds the languageBrief field and one native-editor round to every planned attempt", () => {
    const english = estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, DEFAULT_RUN_SHAPE);
    const hebrew = estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, { ...DEFAULT_RUN_SHAPE, targetLanguage: true });
    const c = STEP_COST_ESTIMATES_USD;
    expect(hebrew.estimatedUsd - english.estimatedUsd).toBeCloseTo(3 * (c.copyLanguageBrief + c.nativeJudge), 6);
    // `04l-language-register` and `07e2-native-conventions-attempt-N` are `wf.step.code` — no model call, no
    // tool call. They contribute nothing here, and an English run pays NOTHING for any of this: the English
    // delta is the prompt file's own growth, already inside `copyAttempt`.
    expect(english.estimatedUsd).toBeCloseTo(estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, { ...DEFAULT_RUN_SHAPE, targetLanguage: false }).estimatedUsd, 10);
  });

  it("the second judge round is priced on every non-English attempt, because the estimate is read before the round is known", () => {
    const c = STEP_COST_ESTIMATES_USD;
    // `revisionEstimateUsd` is consulted BEFORE a revision starts. Pricing the judge at one round would be
    // the estimate flattering itself by $0.014 an attempt on exactly the runs most likely to need two.
    const oneAttempt = revisionEstimateUsd({ attempts: 1, targetLanguage: true });
    const english = revisionEstimateUsd({ attempts: 1, targetLanguage: false });
    expect(oneAttempt - english).toBeCloseTo(c.copyLanguageBrief + 2 * c.nativeJudge, 10);
    expect(revisionEstimateUsd({ attempts: 3, targetLanguage: true })).toBeCloseTo(
      c.angle + 3 * (DRAFT_ATTEMPT_ESTIMATE_USD + c.relevance + c.copyLanguageBrief + 2 * c.nativeJudge),
      6,
    );
    // Haiku is not what a revision is quoted at. It is the degraded tier RFC-15 §6.5 reserves for the
    // cheapest path, kept in the table rather than deleted precisely because the judge is NEVER SKIPPED —
    // a non-English client's language check is mandatory and only its TIER is negotiable. It is also not
    // yet REACHABLE: `runNativeEditor` takes no tier argument, so 07f meters at `nativeJudge` on both paths
    // and degrades the payload instead. A priced-and-not-yet-routed key is the honest state, and asserting
    // it here means deleting the key fails rather than quietly removing the plan's own fallback.
    expect(c.fluency).toBeGreaterThan(0);
    expect(c.fluency).toBeLessThan(c.nativeJudge);
    expect(oneAttempt - english).not.toBeCloseTo(c.fluency, 6);
    // The asymmetry is deliberate and is the thing that would be silently undone by "tidying" the two
    // functions into one helper: the PLANNER prices one round (over-pricing there fires the attempt lever
    // and costs a redraft), the PRE-REVISION quote prices two (under-pricing there is the estimate
    // flattering itself immediately before the spend). If they ever agree, one of them is wrong.
    const plannerDelta =
      estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, { ...DEFAULT_RUN_SHAPE, targetLanguage: true }).rawUsd -
      estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, DEFAULT_RUN_SHAPE).rawUsd;
    const quoteDelta = revisionEstimateUsd({ attempts: 3, targetLanguage: true }) - revisionEstimateUsd({ attempts: 3, targetLanguage: false });
    expect(quoteDelta - plannerDelta).toBeCloseTo(3 * c.nativeJudge, 6);
  });

  it("over the target it caps images FIRST, stepping 8 -> 4 -> 2 -> 0, and records each step in the reviewer's words", () => {
    // The cold Phase 3 default ($1.26): the FIRST lever is the only one
    // touched, and it steps three times — 8 -> 4 is $1.1018 and 4 -> 2 is
    // $1.0238, both over the target, so 2 -> 0 lands it at $0.9458. Nothing
    // below the image cap moves: no attempt is given up for a picture. The
    // third step is @15's honest price arriving (0.1455 -> 0.159 x 3
    // attempts = +$0.0405, which is what pushed cap-2 back over $1.00) —
    // exactly the lever an input-only re-price would have left unpulled while
    // the run billed over target.
    const decision = planRunBudget(DEFAULT_RUN_SHAPE);
    expect(decision.initialEstimateUsd).toBeGreaterThan(TARGET_RUN_SPEND_USD);
    expect(decision.estimate.estimatedUsd).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD);
    expect(decision.plan.generatedImagesCap).toBe(0);
    expect(decision.plan.maxSelfCheckAttempts).toBe(3);
    expect(decision.plan.evidencePulls).toBe("full");
    expect(decision.plan.optionalRevets).toBe(true);
    expect(decision.adaptations).toEqual(["images capped at 4", "images capped at 2", "no generated images (stock or text-only)"]);
    expect(decision.note).toMatch(
      /^budget: estimate \$1\.\d\d > \$1\.00 → images capped at 4, images capped at 2, no generated images \(stock or text-only\) \(now \$0\.\d\d\)$/,
    );
  });

  it("pulls every lever in the owner's order when one is not enough: images, evidence pulls, one return instead of two, re-vets", () => {
    // 1.6x on the cold Phase 3 shape: $2.02 initially, still over target with
    // no images, reduced evidence and one return instead of two, and $0.98
    // once the optional re-vets go too — so every rung of the ladder is needed
    // and the last one fits.
    //
    // The ratio moved 1.8 -> 1.7 -> 1.6 with each of `copyAttempt`'s honest
    // re-prices (the @14 and @15 calls' OUTPUT grew, and output costs 5x
    // input on Sonnet): the ladder saturates sooner when a copy attempt
    // really costs $0.159, which is the point of pricing it that way. Above
    // ~1.63 the tightest plan no longer fits — that regime is the next test,
    // which asserts the run proceeds anyway.
    const history = { ...EMPTY_RUN_BUDGET_HISTORY, ewmaRatio: 1.6, runs: [] };
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
  // Phase 2 gave the meter one optional constructor argument so the per-client
  // SETUP budget (item N: target $2.00, hard max $3.00) could reuse the same
  // machinery. This is the pin that the RUN meter is unchanged: zero
  // arguments still means the owner's $1.00/$1.50, and every existing
  // `new RunSpendMeter()` call site still postures on those two numbers.
  it("still defaults to the owner's per-run numbers with no constructor argument", () => {
    const meter = new RunSpendMeter();
    expect(meter.targetUsd).toBe(TARGET_RUN_SPEND_USD);
    expect(meter.maxUsd).toBe(MAX_RUN_SPEND_USD);
    expect(meter.scope).toBe("run");
    meter.add("05-write-copy-attempt-1", undefined, 1.01);
    expect(meter.crossedTarget).toBe(true);
    expect(meter.crossedMax).toBe(false);
  });

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
    expect(summary).toMatchObject({ estimatedUsd: decision.estimate.estimatedUsd, actualUsd: STEP_COST_ESTIMATES_USD.copyAttempt, targetUsd: 1, maxUsd: 1.5, crossedTarget: false, crossedMax: false, posture: "normal", adaptations: [] });
    expect(summary.lines).toHaveLength(1);
    expect(estimateVsActualLine(summary)).toBe(
      `budget: estimated $${decision.estimate.estimatedUsd.toFixed(2)}, actual $${STEP_COST_ESTIMATES_USD.copyAttempt.toFixed(2)} (under target)`,
    );
  });
});

describe("the estimate table", () => {
  it("the estimate table carries every unit the workflow meters", () => {
    expect(Object.keys(STEP_COST_ESTIMATES_USD).sort()).toEqual(
      [
        "angle",
        "brief",
        "copyAttempt",
        "copyLanguageBrief",
        "extraction",
        "fluency",
        "generatedImage",
        "nativeJudge",
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
    // Sonnet-priced, not Opus-priced, stated as arithmetic rather than as a
    // round multiple: the IDENTICAL call on Opus ($15/$75 per 1M, 5x) would
    // be ~$0.80 — over half the hard max for one draft, and three attempts of
    // it would not fit a run at all. On Sonnet three full attempts (copy +
    // vet + visual QA) still sit inside half the max, which is what leaves
    // room for the images, the research and the rescue tiers.
    expect(STEP_COST_ESTIMATES_USD.copyAttempt * 5).toBeGreaterThan(MAX_RUN_SPEND_USD / 2);
    expect(3 * DRAFT_ATTEMPT_ESTIMATE_USD).toBeLessThan(MAX_RUN_SPEND_USD / 2);
    // Phase 4's judge is priced at gemini-2.5-pro's published $1.25/$10 per 1M on 6.0k in / 0.65k out.
    // Stated as arithmetic, not as a round number, because the owner's rule is that every new model step
    // justifies its cost where it is written: the SAME call on claude-opus-4-8 ($5/$25) is $0.046, and on the
    // five steps carrying `contentLanguageSensitive` a Hebrew run would be ~$2.9 against a $1.50 max.
    expect(STEP_COST_ESTIMATES_USD.nativeJudge).toBeCloseTo((6_000 * 1.25 + 650 * 10) / 1_000_000, 6);
    expect((6_000 * 5 + 650 * 25) / 1_000_000).toBeGreaterThan(3 * STEP_COST_ESTIMATES_USD.nativeJudge);
    expect(STEP_COST_ESTIMATES_USD.copyLanguageBrief).toBeCloseTo((3_000 * 3) / 1_000_000, 6);
  });
});
