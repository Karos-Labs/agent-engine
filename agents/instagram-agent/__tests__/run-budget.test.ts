import { describe, expect, it } from "vitest";
import {
  CANDIDATES_PER_PHOTO_SLIDE,
  DEFAULT_RUN_BUDGET_PLAN,
  DEFAULT_RUN_SHAPE,
  DRAFT_ATTEMPT_ESTIMATE_USD,
  EMPTY_RUN_BUDGET_HISTORY,
  BRIEF_REFRESH_SCRAPER_EXECUTIONS,
  GENERATED_IMAGES_PER_RUN_CAP,
  IMAGE_CAP_STEPS,
  MAX_RUN_SPEND_USD,
  MIN_GENERATED_IMAGES_PER_RUN,
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
  roundUsd,
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
    expect(meter.totalUsd).toBe(0.315);
    expect(meter.lines[0]).toMatchObject({ label: "05-write-copy-attempt-1", usd: 0.315, estimateUsd: 0.315, basis: "estimate" });
    expect(meter.lines[0]).not.toHaveProperty("measuredUsd");
  });

  it("counts the estimate when the step reported exactly $0 — a Vertex step that certainly ran a model", () => {
    const meter = new RunSpendMeter();
    meter.add("06-vet-images-attempt-1", 0, STEP_COST_ESTIMATES_USD.vetCall);
    expect(meter.totalUsd).toBe(0.023);
    expect(meter.lines[0]!.basis).toBe("estimate");
  });

  it("counts the measured figure when it exceeds the estimate", () => {
    const meter = new RunSpendMeter();
    // $0.468424 is karoslabs' dearest live copy attempt on 2026-09-16 — the
    // real shape of this line, and the reason the estimate below it moved.
    meter.add("05-write-copy-attempt-1", 0.468424, STEP_COST_ESTIMATES_USD.copyAttempt);
    expect(meter.totalUsd).toBe(0.468424);
    expect(meter.lines[0]).toMatchObject({ measuredUsd: 0.468424, estimateUsd: 0.315, basis: "measured" });
  });

  it("counts the estimate when the measured figure is below it — an under-reporting vendor is still bounded", () => {
    const meter = new RunSpendMeter();
    meter.add("05-write-copy-attempt-1", 0.02, STEP_COST_ESTIMATES_USD.copyAttempt);
    expect(meter.totalUsd).toBe(0.315);
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

/**
 * `canAfford` answers ONE question: is there room under the ceiling for this
 * next step. A `false` is an input to a downgrade decision — take the cheaper
 * tier, skip the optional call — and is NEVER a reason to hold a run. That
 * guarantee is asserted where it can actually be broken, in
 * `zero-held-guarantee.test.ts`; what is asserted here is only that the number
 * flips where it says it flips.
 *
 * The ceiling moved 1.50 -> 1.60 on 2026-09-14, with the owner's ruling that
 * its purpose is to break an infinite loop and not to fail a run.
 */
describe("RunSpendMeter.canAfford — flips exactly at the $2.60 ceiling", () => {
  it("allows a step that lands exactly on the ceiling", () => {
    const meter = new RunSpendMeter();
    meter.add("so far", undefined, 2.48);
    expect(meter.canAfford(0.12)).toEqual({ ok: true });
  });

  it("refuses a step that would cross it by a cent, naming the money", () => {
    const meter = new RunSpendMeter();
    meter.add("so far", undefined, 2.49);
    const verdict = meter.canAfford(0.12);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("$2.49 spent so far");
    expect(verdict.reason).toContain("$0.12");
    expect(verdict.reason).toContain("$2.61");
    expect(verdict.reason).toContain("$2.60 per-run ceiling");
  });

  it("is not fooled by float summation near the boundary", () => {
    const meter = new RunSpendMeter();
    // 0.1 x 26 = 2.6000000000000005 in floating point; the ceiling comparison must read it as 2.60.
    for (let i = 0; i < 25; i++) meter.add(`step ${i}`, undefined, 0.1);
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

  it("the pre-attempt bundle is copy + vet + visual QA, at the Phase 5.5 MEASURED prices", () => {
    // Phase 5.5 re-prices all three against the 2026-09-16 runs rather than
    // against the prompt files: the copy draft off eight live attempts, the vet
    // and the visual judge off their live flash calls converted to
    // `gemini-2.5-pro` at the published rates. See `run-budget.ts` for each
    // derivation; the block below pins that the three keys ARE those numbers.
    expect(STEP_COST_ESTIMATES_USD.vetCall).toBe(0.023);
    expect(STEP_COST_ESTIMATES_USD.visualQa).toBe(0.046);
    expect(DRAFT_ATTEMPT_ESTIMATE_USD).toBeCloseTo(0.315 + 0.023 + 0.046, 10);
    // The bundle quotes the COLD draft even though a second attempt inside one
    // round bills the warm one. That is deliberate and it is not an oversight:
    // this figure is read before a REVISION, which follows a human gate by
    // minutes or hours, and the prompt cache holding the warm price lives five
    // minutes. A quote read immediately before the spend may never be the cheap
    // version of the truth.
    expect(STEP_COST_ESTIMATES_USD.copyAttemptWarm).toBeLessThan(STEP_COST_ESTIMATES_USD.copyAttempt);
    expect(DRAFT_ATTEMPT_ESTIMATE_USD).toBeGreaterThan(
      STEP_COST_ESTIMATES_USD.copyAttemptWarm + STEP_COST_ESTIMATES_USD.vetCall + STEP_COST_ESTIMATES_USD.visualQa,
    );
    // The bundle is the three lines EVERY attempt pays regardless of language. Phase 4's two new keys are
    // deliberately NOT in it: `copyLanguageBrief` and `nativeJudge` are conditional on a resolved
    // `targetLanguage`, and folding either in here would over-state every English revision quote.
    expect(DRAFT_ATTEMPT_ESTIMATE_USD).toBeLessThan(DRAFT_ATTEMPT_ESTIMATE_USD + STEP_COST_ESTIMATES_USD.copyLanguageBrief);
  });

  /**
   * ════════════════════════════════════════════════════════════════════════
   * PHASE 5.5 — THE COPY KEY, MEASURED OFF THE CALL INSTEAD OF OFF THE PROMPT
   * ════════════════════════════════════════════════════════════════════════
   *
   * Every version of this test from @14 to @19 derived `copyAttempt` from the
   * PROMPT FILE's growth: `AT_16_IN` input tokens plus one quarter of the
   * characters each new section added. The method is sound and the arithmetic
   * was right. **The base was wrong**, and nobody re-measured it for five
   * prompt versions: `AT_16_IN` is 22,260 tokens against a live call that bills
   * 46,945 uncached input tokens, because the prompt file is one input among
   * many (the fact cards, the client brief, the register card, the recent
   * skeletons, the series directive and the reference posts all ride the same
   * call, and every one of them grew).
   *
   * So the key tracked the prompt to three decimals while drifting 1.8x below
   * the call it prices. This test is rewritten to assert the failure rather
   * than to repeat it: the prompt-file derivation is KEPT, and what is asserted
   * about it now is that it is not the price.
   */
  it("prices the copy call off the MEASURED call, and pins the prompt-file method that under-counted it by 1.8x", () => {
    const SONNET_IN_PER_1M = 3;
    const SONNET_OUT_PER_1M = 15;
    const CACHE_WRITE_PREMIUM = 0.25;
    /** `pricing.ts`'s `CACHE_READ_DISCOUNT`: an Anthropic cache read is 10% of the base input rate. */
    const CACHE_READ_RATE_PER_1M = SONNET_IN_PER_1M * 0.1;

    // ── THE MEASUREMENT. Eight completed `05-write-copy-attempt-N` steps
    // ── across the six prep runs of 2026-09-16, `costUsd` off the step record.
    const LIVE_ATTEMPTS = [0.468424, 0.402785, 0.400484, 0.358827, 0.347409, 0.334373, 0.279247, 0.110939];
    const liveMean = LIVE_ATTEMPTS.reduce((a, b) => a + b, 0) / LIVE_ATTEMPTS.length;
    expect(liveMean).toBeCloseTo(0.337811, 6);

    // ── THE CALL, RECONSTRUCTED FROM ITS THREE TERMS. ──
    //
    // This is what makes the input figure a measurement rather than a guess:
    // the same three terms at the MEASURED 16,305 output tokens reproduce
    // karoslabs attempt 1 to the cent.
    const UNCACHED_IN = 46_945;
    const CACHE_WRITE = 23_167;
    const priceCold = (outTokens: number) =>
      (UNCACHED_IN * SONNET_IN_PER_1M + CACHE_WRITE * CACHE_WRITE_PREMIUM * SONNET_IN_PER_1M + outTokens * SONNET_OUT_PER_1M) / 1_000_000;
    expect(priceCold(16_305)).toBeCloseTo(0.402785, 5);

    // ── THE KEY. The call this prices is the POST-HOIST one (W1-B moves the
    // ── custom archetype's markup to `05f` and bounds `headline`/`body`,
    // ── taking the draft from ~16.3k output tokens to ~10k).
    const HOISTED_OUT = 10_000;
    // ── AND THE FOURTH TERM, added at wave-1 integration: the PROMPT is input
    // ── too, and `instagram-copy@21` is +4,415 characters over @20 (79,348 ->
    // ── 83,763, line endings normalised) = +1,206 tokens at the 3.66
    // ── characters-a-token rate fitted across the same six runs. The live
    // ── measurement above was taken on @20, so without this the key prices a
    // ── prompt the run no longer sends. Charged in the worse of the two
    // ── buckets it can land in — inside the cached prefix, where it pays the
    // ── write premium as well.
    const PROMPT_21_EXTRA_IN = 1_206;
    const promptDelta = (PROMPT_21_EXTRA_IN * (1 + CACHE_WRITE_PREMIUM) * SONNET_IN_PER_1M) / 1_000_000;
    expect(promptDelta).toBeCloseTo(0.0045225, 7);
    const coldExact = priceCold(HOISTED_OUT) + promptDelta;
    expect(priceCold(HOISTED_OUT)).toBeCloseTo(0.30821, 5);
    expect(coldExact).toBeCloseTo(0.312733, 5);
    // Never below the call — the one direction `run-budget.ts`'s header forbids.
    expect(STEP_COST_ESTIMATES_USD.copyAttempt).toBeGreaterThanOrEqual(coldExact);
    // And the residue stated as what it BUYS, so it is checkable rather than
    // decorative: $0.00227 is 151 output tokens. A hoisted draft above 10,151
    // output tokens puts this key under the call again, and
    // `copy-schema-length.test.ts` (W1-B) is the test that measures that.
    const headroomTokens = Math.floor(((STEP_COST_ESTIMATES_USD.copyAttempt - coldExact) * 1_000_000) / SONNET_OUT_PER_1M);
    expect(headroomTokens).toBe(151);
    expect(priceCold(HOISTED_OUT + headroomTokens) + promptDelta).toBeLessThanOrEqual(STEP_COST_ESTIMATES_USD.copyAttempt);
    expect(priceCold(HOISTED_OUT + headroomTokens + 2) + promptDelta).toBeGreaterThan(STEP_COST_ESTIMATES_USD.copyAttempt);

    // ── THE WARM KEY, and the fact the estimator has never known. Every later
    // ── attempt of every run on 2026-09-16 reported `cached: 23,167`.
    const WARM_UNCACHED_IN = 27_500;
    const warmExact =
      (WARM_UNCACHED_IN * SONNET_IN_PER_1M + CACHE_WRITE * CACHE_READ_RATE_PER_1M + HOISTED_OUT * SONNET_OUT_PER_1M) / 1_000_000;
    expect(warmExact).toBeCloseTo(0.23945, 5);
    expect(STEP_COST_ESTIMATES_USD.copyAttemptWarm).toBeGreaterThanOrEqual(warmExact);
    expect(STEP_COST_ESTIMATES_USD.copyAttemptWarm - warmExact).toBeLessThan(0.001);
    // A three-attempt run pays cold once and warm twice: $0.15 less than three
    // cold drafts, which is a whole image rung's worth of over-statement the
    // old single-key model carried.
    expect(
      3 * STEP_COST_ESTIMATES_USD.copyAttempt - (STEP_COST_ESTIMATES_USD.copyAttempt + 2 * STEP_COST_ESTIMATES_USD.copyAttemptWarm),
    ).toBeCloseTo(0.15, 6);

    // ── THE PROMPT-FILE METHOD, KEPT AND FALSIFIED. ──
    //
    // @16's base plus every measured prompt delta since, exactly as this test
    // computed it through @19. It lands on $0.184 — which was the shipped key,
    // and which is 1.8x below the live mean. Keeping the derivation means the
    // next author can see WHICH input the method was blind to rather than being
    // told that it was blind.
    const AT_16_IN = 22_260;
    const AT_16_OUT = 6_300;
    const CHARS_PER_TOKEN = 4;
    /** @16 -> @17, measured on the shipped files with line endings normalised: 45,757 -> 62,057. */
    const PROMPT_CHAR_DELTA = 18_896;
    /** @17 -> @18: section 28 "Marking". */
    const EMPHASIS_CHAR_DELTA = 3_276;
    /** @18 -> @19: section 29 "Your series", plus its changelog note. */
    const SERIES_CHAR_DELTA = 3_715;
    /** The series directive rides on the INPUT OBJECT rather than in the prompt file. */
    const SERIES_DIRECTIVE_TOKENS = 175;
    /** The `emphasis` array: ~3.6 marks a slide at ~4.8 tokens, plus ~4 of array overhead, across 8 slides. */
    const EMPHASIS_OUT_TOKENS = 176;
    const methodInputTokens =
      AT_16_IN + (PROMPT_CHAR_DELTA + EMPHASIS_CHAR_DELTA + SERIES_CHAR_DELTA) / CHARS_PER_TOKEN + SERIES_DIRECTIVE_TOKENS;
    const promptFileMethod =
      (methodInputTokens * SONNET_IN_PER_1M + (AT_16_OUT + 10 + EMPHASIS_OUT_TOKENS) * SONNET_OUT_PER_1M) / 1_000_000;
    expect(promptFileMethod).toBeCloseTo(0.18401, 5);
    // THE FINDING, as a number: the method under-counts the live call by 1.8x.
    expect(liveMean / promptFileMethod).toBeGreaterThan(1.8);
    // And the input half is where it all went: the prompt-file method thinks
    // the call carries ~28.7k input tokens; it carries 46,945 plus a 23,167
    // cache write.
    expect(methodInputTokens).toBeLessThan(UNCACHED_IN);
    expect(UNCACHED_IN - methodInputTokens).toBeGreaterThan(18_000);
    // Every historical key this file argued over — 0.166, 0.171, 0.174, 0.176,
    // 0.179, 0.180, 0.181, 0.184, 0.185 — is below the live mean. The argument
    // was real and the answer was the same at every branch of it: too low.
    for (const stale of [0.166, 0.171, 0.174, 0.176, 0.179, 0.18, 0.181, 0.184, 0.185]) {
      expect(stale, "a historical key at or above the live mean would refute the finding").toBeLessThan(liveMean);
    }

    // ── NO OPUS, still, and now the arithmetic is even more one-sided. The
    // ── identical post-hoist call on `claude-opus-4-8` ($5/$25 per 1M).
    const opus = (UNCACHED_IN * 5 + CACHE_WRITE * CACHE_WRITE_PREMIUM * 5 + HOISTED_OUT * 25) / 1_000_000;
    expect(opus).toBeCloseTo(0.513684, 6);
    // The ratio, not a fitted multiplier: $0.513684 / $0.315 = 1.63x. It fell
    // from 1.66x when `copyAttempt` picked up @21's own prompt tokens, which is
    // the honest direction — Sonnet got dearer, Opus did not get cheaper.
    expect(opus / STEP_COST_ESTIMATES_USD.copyAttempt).toBeGreaterThan(1.6);
    // Three Opus attempts is $1.54 — 86% of the whole $1.80 target, before the
    // post has a single image, which is the spend this phase exists to protect.
    expect(3 * opus).toBeGreaterThan(0.85 * TARGET_RUN_SPEND_USD);
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

  it("the cold carousel does not fit the target, and what it gives up is OPTIONAL work — the pictures survive", () => {
    // ════════════════════════════════════════════════════════════════════════
    // THE ACCEPTANCE TEST OF PHASE 5.5, AND IT IS ONE LINE LONG:
    //   `decision.plan.generatedImagesCap` is 8 on the cold English default.
    // ════════════════════════════════════════════════════════════════════════
    //
    // Before 2026-09-16 this same shape landed on `generatedImagesCap: 0` after
    // three image rungs, and that plan is what shipped six prep posts with no
    // pictures in them. The ladder now spends the one rung it needs on rescue
    // re-vets — work whose own name is optional — and buys every picture.
    const cold = estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, DEFAULT_RUN_SHAPE);
    // `fixed` is $0.2745: Phase 1's $0.2015 of evidence and angle, Phase 4's
    // $0.030 concept line, Phase 5's $0.010 packager and lead-claim
    // verification, and Phase 5.5's two new once-per-run lines.
    expect(cold.breakdown.fixed).toBeCloseTo(0.2745, 6);
    expect(cold.breakdown.fixed - 0.2415).toBeCloseTo(STEP_COST_ESTIMATES_USD.entityExtract + STEP_COST_ESTIMATES_USD.customArchetype, 6);
    expect(cold.estimatedUsd).toBeCloseTo(1.9605, 6);
    expect(cold.estimatedUsd).toBeGreaterThan(TARGET_RUN_SPEND_USD);

    const decision = planRunBudget(DEFAULT_RUN_SHAPE);
    // ONE rung, and it is the one nobody can see: $0.201 of rescue re-vets
    // (3 attempts x (3 scrapes + 2 pro vets)) takes $1.9605 to $1.7595.
    expect(decision.adaptations).toEqual(["optional rescue re-vets skipped"]);
    expect(decision.estimate.estimatedUsd).toBeCloseTo(1.7595, 6);
    expect(decision.estimate.estimatedUsd).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD);
    // THE ASSERTIONS THAT MATTER, and they are absences as much as values.
    expect(decision.plan.generatedImagesCap).toBe(GENERATED_IMAGES_PER_RUN_CAP);
    expect(decision.plan.maxSelfCheckAttempts).toBe(3);
    expect(decision.plan.duplicateVisionPasses).toBe(true);
    expect(decision.plan.evidencePulls).toBe("full");
    expect(decision.adaptations.some((a) => /image/i.test(a))).toBe(false);

    // The image rungs, priced, so the ladder's own stepping is pinned and not
    // merely its endpoint. Each step is one to four generated pictures at
    // $0.039 — the same order of money as the rungs above it, which is why the
    // steps are 4 and 3 rather than 4 and 2.
    const at = (cap: number) => estimateRunCost({ ...DEFAULT_RUN_BUDGET_PLAN, generatedImagesCap: cap }, DEFAULT_RUN_SHAPE).estimatedUsd;
    expect(at(8)).toBeCloseTo(1.9605, 6);
    expect(at(4)).toBeCloseTo(1.8045, 6);
    expect(at(3)).toBeCloseTo(1.7655, 6);
    expect(at(2)).toBeCloseTo(1.7265, 6);
    expect(at(8) - at(4)).toBeCloseTo(4 * STEP_COST_ESTIMATES_USD.generatedImage, 6);

    // The concept line is now booked on EVERY run the mode is reachable on,
    // with no plan-side precondition. It used to be conditioned on
    // `generatedImagesCap > 0 && optionalRevets`, which was honest while a rung
    // could zero the cap and the workflow could decline the concept outright.
    // Neither is true after this phase — `partitionGaps` makes the concept a
    // guaranteed gap — so pricing it conditionally would under-count exactly
    // the tightest plans.
    const withoutConcept = estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, { ...DEFAULT_RUN_SHAPE, conceptPossible: false });
    expect(cold.breakdown.fixed - withoutConcept.breakdown.fixed).toBeCloseTo(
      STEP_COST_ESTIMATES_USD.concept + STEP_COST_ESTIMATES_USD.visionInspectPerImage,
      6,
    );
    for (const plan of [
      { ...DEFAULT_RUN_BUDGET_PLAN, generatedImagesCap: MIN_GENERATED_IMAGES_PER_RUN },
      { ...DEFAULT_RUN_BUDGET_PLAN, optionalRevets: false },
      {
        maxSelfCheckAttempts: 3,
        generatedImagesCap: MIN_GENERATED_IMAGES_PER_RUN,
        evidencePulls: "reduced" as const,
        optionalRevets: false,
        duplicateVisionPasses: false,
      },
    ]) {
      // Differenced against the SAME plan with the mode switched off, so the
      // evidence rung's own $0.021 (which also lives in `fixed`) cannot be
      // mistaken for the concept moving.
      const off = estimateRunCost({ ...plan }, { ...DEFAULT_RUN_SHAPE, conceptPossible: false }).breakdown.fixed;
      expect(estimateRunCost(plan, DEFAULT_RUN_SHAPE).breakdown.fixed - off, "the concept is priced on the tightest plan too").toBeCloseTo(
        STEP_COST_ESTIMATES_USD.concept + STEP_COST_ESTIMATES_USD.visionInspectPerImage,
        6,
      );
    }

    // ── THE COLD HEBREW PLAN: three rungs, and still every picture. ──
    //
    // This is the shape the whole of RFC-18 §7.3 turned on and the tightest
    // real plan the fleet produces. It carries the same acceptance condition as
    // the English one plus the older one: three drafting attempts.
    const hebrew = planRunBudget({ ...DEFAULT_RUN_SHAPE, targetLanguage: true });
    expect(hebrew.plan.maxSelfCheckAttempts).toBe(3);
    expect(hebrew.plan.generatedImagesCap).toBe(GENERATED_IMAGES_PER_RUN_CAP);
    expect(hebrew.adaptations).toEqual([
      "optional rescue re-vets skipped",
      "trend evidence reduced to the one cached industry query",
      "duplicate vision passes skipped (candidates and slides are inspected once, not once per attempt)",
    ]);
    expect(hebrew.initialEstimateUsd).toBeCloseTo(2.0535, 6);
    expect(hebrew.estimate.estimatedUsd).toBeCloseTo(1.7595, 6);
    expect(hebrew.estimate.estimatedUsd).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD);
    // And well under the hard max, which is the bound that still binds: over the
    // target costs the run its optional work, over the ceiling would put it on
    // the cheapest complete path before it started.
    expect(MAX_RUN_SPEND_USD - hebrew.estimate.estimatedUsd).toBeGreaterThan(0.8);

    // ── EACH RUNG, PRICED ON THE SHAPE THAT PULLS IT, IN ORDER. ──
    //
    // Read the four numbers together: the ladder gives up $0.201 of rescue,
    // then $0.021 of repeat evidence, then $0.072 of repeat vision, before it
    // touches a single picture. The rung it no longer has — a drafting attempt
    // — would have been $0.356, and the pictures it now protects are $0.312.
    const hebrewShape = { ...DEFAULT_RUN_SHAPE, targetLanguage: true };
    const rawAt = (p: typeof DEFAULT_RUN_BUDGET_PLAN) => estimateRunCost(p, hebrewShape).rawUsd;
    const full = DEFAULT_RUN_BUDGET_PLAN;
    const afterRevets = { ...full, optionalRevets: false };
    const afterEvidence = { ...afterRevets, evidencePulls: "reduced" as const };
    const afterVision = { ...afterEvidence, duplicateVisionPasses: false };
    expect(roundUsd(rawAt(full) - rawAt(afterRevets))).toBeCloseTo(0.201, 6);
    expect(roundUsd(rawAt(full) - rawAt(afterRevets))).toBeCloseTo(
      3 * (3 * STEP_COST_ESTIMATES_USD.scraperExecution + 2 * STEP_COST_ESTIMATES_USD.vetCall),
      6,
    );
    expect(roundUsd(rawAt(afterRevets) - rawAt(afterEvidence))).toBeCloseTo(3 * STEP_COST_ESTIMATES_USD.scraperExecution, 6);
    // The duplicate-vision rung is worth two re-inspections of the candidate
    // pool — the pool the live `unitUsage` shows being re-described at an
    // identical width on every attempt.
    expect(roundUsd(rawAt(afterEvidence) - rawAt(afterVision))).toBeCloseTo(
      2 * DEFAULT_RUN_SHAPE.photoSlides * CANDIDATES_PER_PHOTO_SLIDE * STEP_COST_ESTIMATES_USD.visionInspectPerImage,
      6,
    );
    // The deleted attempt rung, and the pictures, measured against each other:
    // the rung that no longer exists was worth more than everything the ladder
    // now gives up before it reaches the images.
    const attemptRung = roundUsd(rawAt(afterVision) - rawAt({ ...afterVision, maxSelfCheckAttempts: 2 }));
    expect(attemptRung).toBeCloseTo(0.357, 6);
    expect(attemptRung).toBeGreaterThan(roundUsd(rawAt(full) - rawAt(afterVision)));
    const images = roundUsd(rawAt(afterVision) - rawAt({ ...afterVision, generatedImagesCap: MIN_GENERATED_IMAGES_PER_RUN }));
    expect(images).toBeCloseTo((GENERATED_IMAGES_PER_RUN_CAP - MIN_GENERATED_IMAGES_PER_RUN) * STEP_COST_ESTIMATES_USD.generatedImage, 6);

    // ── THE LADDER THAT IS NO LONGER SHIPPED, REPLAYED WITHOUT EDITING THE
    // ── MODULE — the technique this file has used since Phase 5, and for the
    // ── same reason: "it goes red if you break it" is a claim until someone
    // ── breaks it, and the reader of this file cannot.
    //
    // The PRE-PHASE-5.5 order: images FIRST, stepping 4 -> 2 -> 0, then
    // evidence, then the optional re-vets. Applied to the same shape at the
    // same prices it lands on `generatedImagesCap: 0` — the plan that shipped
    // the posts the owner returned.
    const ratio = hebrew.calibration.ratio;
    const fitsAt = (p: typeof DEFAULT_RUN_BUDGET_PLAN) => estimateRunCost(p, hebrewShape, ratio).estimatedUsd <= TARGET_RUN_SPEND_USD;
    let old = { ...DEFAULT_RUN_BUDGET_PLAN };
    for (const cap of [4, 2, 0]) if (!fitsAt(old) && old.generatedImagesCap > cap) old = { ...old, generatedImagesCap: cap };
    if (!fitsAt(old) && old.evidencePulls === "full") old = { ...old, evidencePulls: "reduced" };
    if (!fitsAt(old) && old.optionalRevets) old = { ...old, optionalRevets: false };
    expect(old.generatedImagesCap, "the superseded ladder reaches zero images on the shape that ships today").toBe(0);
    expect(old.optionalRevets, "and it does it with $0.201 of optional work still unspent").toBe(true);
    // (c) And what actually ships: not that.
    expect(hebrew.plan.generatedImagesCap).toBeGreaterThan(old.generatedImagesCap);
    expect(hebrew.plan.optionalRevets).toBe(false);
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
    // $1.55 cold with the refresh, so every rung of the ladder fires rather
    // than $0.18 of Sonnet being discovered on the meter.
    const refresh = { ...DEFAULT_RUN_SHAPE, briefRefresh: true };
    expect(estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, refresh).estimatedUsd).toBeGreaterThan(1.3);
    const decision = planRunBudget(refresh);
    expect(decision.adaptations.length).toBeGreaterThan(1);
    expect(decision.spentBeforePlanUsd).toBe(0);

    // A brand-new client is the one ordinary shape that reaches the image rung
    // at all — $0.176 of brief writing and source scraping has to come from
    // somewhere — and it reaches it having spent all three optional rungs
    // first. It stops at 4, four pictures above the floor, and the plan FITS.
    //
    // Until 2026-09-16 this same shape landed on `generatedImagesCap: 0` after
    // the FIRST rung, with $0.201 of rescue re-vets still unspent.
    expect(decision.plan).toEqual({
      maxSelfCheckAttempts: 3,
      generatedImagesCap: 4,
      evidencePulls: "reduced",
      optionalRevets: false,
      duplicateVisionPasses: false,
    });
    expect(decision.adaptations).toEqual([
      "optional rescue re-vets skipped",
      "trend evidence reduced to the one cached industry query",
      "duplicate vision passes skipped (candidates and slides are inspected once, not once per attempt)",
      "images capped at 4",
    ]);
    expect(decision.estimate.estimatedUsd).toBeCloseTo(1.6865, 6);
    expect(decision.estimate.estimatedUsd).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD);
    expect(decision.estimate.estimatedUsd).toBeLessThan(MAX_RUN_SPEND_USD);
    expect(decision.plan.generatedImagesCap).toBeGreaterThan(MIN_GENERATED_IMAGES_PER_RUN);
  });

  it("money already billed before the plan is money the plan cannot spend: the target left is what it fits", () => {
    // Belt for the ordering invariant (`02j` runs before `00b1`/`00b2`): if a
    // paid step is ever added above it, the lever still fires.
    const warmFits = planRunBudget(WARM_RUN_SHAPE, CALIBRATED_HISTORY);
    expect(warmFits.adaptations).toEqual([]);
    const withSpend = planRunBudget(WARM_RUN_SHAPE, CALIBRATED_HISTORY, { spentUsd: 0.9 });
    expect(withSpend.adaptations).not.toEqual([]);
    expect(withSpend.spentBeforePlanUsd).toBe(0.9);
    expect(withSpend.note).toContain("$0.90 was already spent before the plan");
    // THE LEVER FIRED, which is what this belt is for, and it fired on the
    // OPTIONAL rung: $0.90 already billed leaves $0.90, the full warm plan is
    // $0.91, and dropping the rescue re-vets closes it. The pictures are
    // untouched — which is the property this phase adds to this old belt.
    expect(withSpend.adaptations).toEqual(["optional rescue re-vets skipped"]);
    expect(withSpend.plan.generatedImagesCap).toBe(GENERATED_IMAGES_PER_RUN_CAP);
    expect(withSpend.estimate.estimatedUsd).toBeLessThan(planRunBudget(WARM_RUN_SHAPE, CALIBRATED_HISTORY).estimate.estimatedUsd);
    expect(withSpend.estimate.estimatedUsd + 0.9).toBeLessThan(MAX_RUN_SPEND_USD);
    // A nonsensical figure is read as nothing spent rather than thrown on.
    expect(planRunBudget(WARM_RUN_SHAPE, CALIBRATED_HISTORY, { spentUsd: Number.NaN }).spentBeforePlanUsd).toBe(0);
  });
});

describe("planRunBudget — the owner's levers, in order, never a hold", () => {
  it("a warm run for a calibrated client fits the $1.80 target with no adaptation and says so", () => {
    // The steady state: caches warm, and one delivered run's worth of history
    // saying the cold worst case over-predicts. This is the shape that gets
    // the full plan — a first, cold, uncalibrated run does not, and the test
    // above proves the lever fires there instead.
    const decision = planRunBudget(WARM_RUN_SHAPE, CALIBRATED_HISTORY);
    expect(decision.plan).toEqual(DEFAULT_RUN_BUDGET_PLAN);
    expect(decision.adaptations).toEqual([]);
    expect(decision.estimate.estimatedUsd).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD);
    expect(decision.estimate.estimatedUsd).toBeGreaterThan(0.3);
    expect(decision.note).toMatch(/^budget: estimate \$0\.\d\d ≤ \$1\.80 → full plan$/);
    expect(decision.calibration).toEqual({ ratio: 0.5, posture: "default", pastRuns: 0 });
  });

  it("a non-English target adds the languageBrief field and one native-editor round to every planned attempt", () => {
    const english = estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, DEFAULT_RUN_SHAPE);
    const hebrew = estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, { ...DEFAULT_RUN_SHAPE, targetLanguage: true });
    const c = STEP_COST_ESTIMATES_USD;
    // Phase 5 adds a fourth language line and it is the only one OUTSIDE the attempt loop:
    // `08c2-package-native-round` judges the hashtags' script, the alt text and the first comment ONCE per
    // revision, not once per attempt. Asserting the delta as `3 x perAttempt + 1 x fixed` rather than as a
    // lump is what would catch someone moving the packager's native round inside the loop, which would cost
    // $0.018 more a run and judge two drafts that are about to be thrown away.
    expect(hebrew.estimatedUsd - english.estimatedUsd).toBeCloseTo(3 * (c.copyLanguageBrief + c.nativeJudge) + c.packageNativeJudge, 6);
    expect(hebrew.breakdown.fixed - english.breakdown.fixed).toBeCloseTo(c.packageNativeJudge, 6);
    expect(hebrew.breakdown.attempts - english.breakdown.attempts).toBeCloseTo(3 * (c.copyLanguageBrief + c.nativeJudge), 6);
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
      c.angle + 3 * (DRAFT_ATTEMPT_ESTIMATE_USD + c.relevance + c.valueJudge + c.copyLanguageBrief + 2 * c.nativeJudge),
      6,
    );
    // Phase 5 — the value judge rides the attempt loop a `revise` re-enters, so it is quoted per attempt on
    // both sides of the language split. $0.003 is under this quote's own rounding; it is added anyway,
    // because the rule this file keeps is that a number read immediately before the spend may never be the
    // cheap version of the truth.
    expect(revisionEstimateUsd({ attempts: 3 }) - revisionEstimateUsd({ attempts: 2 })).toBeCloseTo(
      DRAFT_ATTEMPT_ESTIMATE_USD + c.relevance + c.valueJudge,
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
    // Phase 5 puts a SECOND term in that difference and it points the other way, so the assertion names
    // both: the quote prices three extra native-editor rounds ($0.042) that the planner does not, and the
    // PLANNER prices `08c2-package-native-round` ($0.009) that the quote does not. `08c` is revision-scoped
    // and sits outside `draftOnce`, so a pre-revision quote of the ATTEMPTS a `revise` buys is right not to
    // carry it. If either term is ever dropped this goes red with the missing one named.
    expect(quoteDelta - plannerDelta).toBeCloseTo(3 * c.nativeJudge - c.packageNativeJudge, 6);
    expect(quoteDelta).toBeCloseTo(3 * (c.copyLanguageBrief + 2 * c.nativeJudge), 6);
    expect(plannerDelta).toBeCloseTo(3 * (c.copyLanguageBrief + c.nativeJudge) + c.packageNativeJudge, 6);
  });

  it("pulls the rungs in the owner's Phase 5.5 order — re-vets, evidence, duplicate vision, and LAST the images", () => {
    // The order is the whole of brief item A1, so it is asserted as an ORDER
    // and not as a set. A ratio of 1.45 is what it takes to reach every rung on
    // the cold English shape: the full plan prices at $2.83 calibrated, and the
    // ladder walks every step down to the floor.
    //
    // The ratio moved 1.8 -> 1.45 over Phase 4 and 5 with each honest re-price
    // of `copyAttempt`; it is kept at 1.45 here so the regime this test names is
    // the one the incident record refers to.
    //
    // THE LADDER IS ONE RUNG SHORTER SINCE 2026-09-18, and that is the point of
    // the change rather than a side effect of it. `MIN_GENERATED_IMAGES_PER_RUN`
    // moved 2 -> 3 because it could not satisfy `MIN_PICTURE_SLIDES` from zero,
    // and a run that cannot buy three pictures ships the post the owner called
    // a failure that day. So the floor no lever may cross is 3, the "images
    // capped at 2" rung is gone, and this run has less room under pressure —
    // which is the trade quality-before-cost names.
    const history = { ...EMPTY_RUN_BUDGET_HISTORY, ewmaRatio: 1.45, runs: [] };
    const decision = planRunBudget(DEFAULT_RUN_SHAPE, history);
    expect(decision.adaptations).toEqual([
      "optional rescue re-vets skipped",
      "trend evidence reduced to the one cached industry query",
      "duplicate vision passes skipped (candidates and slides are inspected once, not once per attempt)",
      "images capped at 4",
      "images capped at 3 — the floor no lever may cross",
    ]);
    // The three rungs that fire BEFORE any picture is given up, in order, and
    // the fact that no image rung appears among them.
    expect(decision.adaptations.slice(0, 3).some((a) => /image/i.test(a))).toBe(false);
    expect(decision.adaptations.findIndex((a) => /images capped/.test(a))).toBe(3);
    // THE ASSERTION THAT MATTERS, and it is where the ladder STOPS: at the
    // floor, with three attempts, on a plan that still does not fit.
    expect(decision.plan).toEqual({
      maxSelfCheckAttempts: 3,
      generatedImagesCap: MIN_GENERATED_IMAGES_PER_RUN,
      evidencePulls: "reduced",
      optionalRevets: false,
      duplicateVisionPasses: false,
    });
    expect(decision.adaptations.at(-1)).toMatch(/the floor no lever may cross/);
    expect(decision.estimate.estimatedUsd).toBeGreaterThan(TARGET_RUN_SPEND_USD);
    expect(decision.estimate.estimatedUsd).toBeCloseTo(2.133675, 6);
    expect(decision.note).toMatch(/running anyway/);
    // Over target and still under the hard max, so nothing about this plan puts
    // the run on the cheapest path before it has drawn a breath.
    expect(decision.estimate.estimatedUsd).toBeLessThan(MAX_RUN_SPEND_USD);
    // The ratio this test USES is the one the history carries — asserted, so
    // that editing one and not the other is a failure rather than a test that
    // silently stops testing the regime it names.
    expect(history.ewmaRatio).toBe(1.45);
  });

  it("drives the spend up rung by rung so a target of $1.80 that rarely fires cannot let the ladder rot", () => {
    // ## Why this test exists at all
    //
    // At $1.00 every cold run walked the whole ladder, so every rung was
    // exercised by the ordinary cases above. At $1.80 the cold English plan
    // stops after ONE rung and the cold Hebrew plan after three — which is the
    // intended outcome and is also how a ladder rots: a rung nothing reaches is
    // a rung nobody notices is broken.
    //
    // So this walks `spentUsd` up and asserts the plan at each step. `spentUsd`
    // is the honest lever for it: `planRunBudget` fits the plan to what is LEFT
    // of the target, so money already billed reaches every rung in order
    // without touching a single price.
    /** The ladder, in the owner's order. Every plan's `adaptations` must be a PREFIX of this. */
    const LADDER = [
      "optional rescue re-vets skipped",
      "trend evidence reduced to the one cached industry query",
      "duplicate vision passes skipped (candidates and slides are inspected once, not once per attempt)",
      "images capped at 4",
      // One rung shorter since MIN_GENERATED_IMAGES_PER_RUN moved 2 -> 3: the
      // guarantee could not satisfy MIN_PICTURE_SLIDES from zero, and a run
      // that cannot buy three pictures ships the post the owner read on
      // 2026-09-18 and called a failure.
      "images capped at 3 — the floor no lever may cross",
    ];

    // Nothing spent on the warm calibrated shape: the full plan, every picture,
    // no adaptation — the one end of the range.
    expect(planRunBudget(WARM_RUN_SHAPE, CALIBRATED_HISTORY).adaptations).toEqual([]);
    expect(planRunBudget(WARM_RUN_SHAPE, CALIBRATED_HISTORY).plan).toEqual(DEFAULT_RUN_BUDGET_PLAN);

    const planAt = (spentUsd: number) => planRunBudget(WARM_RUN_SHAPE, CALIBRATED_HISTORY, { spentUsd });
    let seen = 0;
    const capsSeen = new Set<number>();
    for (let spent = 0; spent <= 1.8; spent = roundUsd(spent + 0.02)) {
      const plan = planAt(spent);
      // THE ORDER, asserted at every point rather than at hand-picked ones. A
      // prefix check is the right shape because two rungs can fire on the same
      // call when the first frees nothing (on a warm shape the evidence rung
      // frees exactly $0, since there are no cold trend queries to drop) — and
      // "they fired together" must still mean "in this order".
      expect(plan.adaptations, `out-of-order ladder at $${spent} spent`).toEqual(LADDER.slice(0, plan.adaptations.length));
      // MONOTONE in the money already spent: more spent is never fewer rungs.
      expect(plan.adaptations.length, `rung count went DOWN at $${spent} spent`).toBeGreaterThanOrEqual(seen);
      seen = plan.adaptations.length;
      capsSeen.add(plan.plan.generatedImagesCap);
      // And the two things no rung may take, at every point on the sweep.
      expect(plan.plan.maxSelfCheckAttempts, `attempts sold at $${spent} spent`).toBe(3);
      expect(plan.plan.generatedImagesCap, `images cut below the floor at $${spent} spent`).toBeGreaterThanOrEqual(MIN_GENERATED_IMAGES_PER_RUN);
    }
    // The sweep reached the BOTTOM of the ladder, which is what makes the
    // assertions above worth anything: a sweep that only ever saw the full plan
    // would pass every line in this test.
    expect(seen).toBe(LADDER.length);
    // Every cap on the ladder was actually visited, and nothing below the floor
    // ever was.
    expect([...capsSeen].sort((a, b) => b - a)).toEqual([GENERATED_IMAGES_PER_RUN_CAP, ...IMAGE_CAP_STEPS]);
    expect(Math.min(...capsSeen)).toBe(MIN_GENERATED_IMAGES_PER_RUN);
  });

  it("never plans zero generated images, on ANY shape, and the cap steps contain no zero", () => {
    // ## The one-line version of brief item A1
    //
    // `04m-concept-eligibility` declines with the reason `"generatedImagesCap 0"`,
    // and on 2026-09-16 that reason appeared on all six prep runs. The cap
    // cannot be zero any more, and this sweeps for it rather than asserting it
    // about the two shapes that happen to be in front of us.
    expect(IMAGE_CAP_STEPS).not.toContain(0);
    expect(Math.min(...IMAGE_CAP_STEPS)).toBe(MIN_GENERATED_IMAGES_PER_RUN);
    expect(MIN_GENERATED_IMAGES_PER_RUN).toBeGreaterThan(0);

    const shapes = [
      DEFAULT_RUN_SHAPE,
      WARM_RUN_SHAPE,
      { ...DEFAULT_RUN_SHAPE, targetLanguage: true },
      { ...DEFAULT_RUN_SHAPE, targetLanguage: true, briefRefresh: true, photoSlides: 8, socialAccounts: 6 },
      { ...DEFAULT_RUN_SHAPE, photoSlides: 8, slideCount: 8, angleRounds: 2 },
      { ...WARM_RUN_SHAPE, targetLanguage: true, conceptPossible: false },
    ];
    const histories = [
      EMPTY_RUN_BUDGET_HISTORY,
      CALIBRATED_HISTORY,
      { ...EMPTY_RUN_BUDGET_HISTORY, ewmaRatio: 1.45, runs: [] },
      { ...EMPTY_RUN_BUDGET_HISTORY, ewmaRatio: 3, runs: [] },
      { ...EMPTY_RUN_BUDGET_HISTORY, ewmaRatio: 3, overrunStreak: 4, runs: [] },
    ];
    for (const shape of shapes) {
      for (const history of histories) {
        for (const spentUsd of [0, 0.5, 1.2, 2.5, 40]) {
          const d = planRunBudget(shape, history, { spentUsd });
          expect(d.plan.generatedImagesCap, `zero images planned at spent $${spentUsd}`).toBeGreaterThanOrEqual(MIN_GENERATED_IMAGES_PER_RUN);
          expect(d.plan.maxSelfCheckAttempts).toBe(3);
          // And the words the reviewer reads never promise a post with no
          // pictures in it. `"no generated images (stock or text-only)"` was
          // the adaptation string on every prep run of 2026-09-16.
          for (const note of d.adaptations) expect(note).not.toMatch(/no generated images/);
          expect(d.note).not.toMatch(/no generated images/);
        }
      }
    }
  });

  it("when even the tightest plan does not fit, it still returns a plan — the run proceeds and the note says so", () => {
    const history = { ...EMPTY_RUN_BUDGET_HISTORY, ewmaRatio: 3, runs: [] };
    const decision = planRunBudget({ ...DEFAULT_RUN_SHAPE, targetLanguage: true, photoSlides: 8 }, history);
    // "Tightest" means every OPTIONAL lever pulled and the image cap at its
    // floor. It does not, and since 2026-09-14 cannot, mean fewer drafting
    // attempts; and since 2026-09-16 it cannot mean a post with no pictures.
    expect(decision.plan.maxSelfCheckAttempts).toBe(3);
    expect(decision.plan.optionalRevets).toBe(false);
    expect(decision.plan.duplicateVisionPasses).toBe(false);
    expect(decision.plan.generatedImagesCap).toBe(MIN_GENERATED_IMAGES_PER_RUN);
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

  /**
   * Phase 5 (RFC-18 §5.8) — the value gate's own telemetry, beside `language`.
   *
   * RFC-15 §9.4 named this gap about ITS phase and had to leave it open: the
   * deliverable carried the numbers and no later run ever reads a deliverable
   * back. This is the belief a later run CAN read, and the three things it has
   * to survive a round trip are `status` (was the bar met), `axes` (which axis
   * the writer keeps failing) and `returns` (what the gate cost in redrafts —
   * a gate that is always 0 is decoration, a gate that is always 2 is an
   * unwinnable floor).
   */
  it("round-trips the value record, and reads an absent or garbage one as absent rather than as a keepable post", () => {
    const record = {
      runId: "v1",
      at: "2026-09-13T00:00:00.000Z",
      estimatedUsd: 0.94,
      actualUsd: 0.61,
      crossedTarget: false,
      crossedMax: false,
      adaptations: 5,
      value: { status: "below-bar" as const, axes: { newFact: "weak", position: "weak", payload: "pass", action: "pass" }, returns: 2 },
    };
    const history = recordRunInHistory(EMPTY_RUN_BUDGET_HISTORY, record);
    const read = readBudgetHistory({ [RUN_BUDGET_BELIEF_KEY]: history });
    expect(read.runs[0]!.value).toEqual(record.value);

    // A run recorded before Phase 5 carries NO value key, and that must stay
    // distinguishable from a recorded verdict — the same distinction the two
    // concept booleans are read with. An absent record read as
    // `{status:"keepable", returns:0}` would make the gate look like it was
    // passing every post it never judged.
    const older = readBudgetHistory({ [RUN_BUDGET_BELIEF_KEY]: { runs: [{ runId: "old", actualUsd: 0.5 }] } });
    expect(older.runs[0]).not.toHaveProperty("value");

    // Garbage in the beliefs document is absent, not a zero-filled row: an
    // unknown status is the whole record's discriminator.
    for (const bad of [null, "keepable", 7, {}, { status: "great" }, { axes: {}, returns: 1 }]) {
      const got = readBudgetHistory({ [RUN_BUDGET_BELIEF_KEY]: { runs: [{ runId: "g", value: bad }] } });
      expect(got.runs[0], JSON.stringify(bad)).not.toHaveProperty("value");
    }

    // `returns` is bounded the way every other count here is — VALUE_MAX_RETURNS is 2, and a hand edit
    // saying 99 must not make a later reader's average absurd. A missing count reads as 0 because the
    // record's EXISTENCE already carries the fact that the judge ran.
    const wild = readBudgetHistory({
      [RUN_BUDGET_BELIEF_KEY]: { runs: [{ runId: "w", value: { status: "unjudged", returns: 99 } }, { runId: "n", value: { status: "keepable" } }] },
    });
    expect(wild.runs[0]!.value).toEqual({ status: "unjudged", axes: {}, returns: 2 });
    expect(wild.runs[1]!.value).toEqual({ status: "keepable", axes: {}, returns: 0 });
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
    meter.add("05-write-copy-attempt-1", undefined, 1.81);
    expect(meter.crossedTarget).toBe(true);
    expect(meter.crossedMax).toBe(false);
  });

  it("normal under the target, essential-only over it, cheapest-path over the hard max", () => {
    const meter = new RunSpendMeter();
    meter.add("a", undefined, 1.7);
    expect(meter.posture).toBe("normal");
    expect(meter.crossedTarget).toBe(false);
    meter.add("b", undefined, 0.2);
    expect(meter.posture).toBe("essential-only");
    expect(meter.crossedTarget).toBe(true);
    expect(meter.crossedMax).toBe(false);
    // $2.60 exactly is still `essential-only`: the ceiling is crossed only
    // when it is EXCEEDED, which is the same rule that makes "a step that
    // lands exactly on the ceiling" affordable in the block above.
    meter.add("c", 0.7, 0.01);
    expect(meter.totalUsd).toBe(2.6);
    expect(meter.crossedMax).toBe(false);
    expect(meter.posture).toBe("essential-only");
    meter.add("d", 0.2, 0.01);
    expect(meter.posture).toBe("cheapest-path");
    expect(meter.crossedMax).toBe(true);
    expect(targetCrossedNote(meter, "06d-generate-images-attempt-2")).toMatch(/^budget: \$2\.80 spent at 06d-generate-images-attempt-2, over the \$1\.80 target — optional work stopped/);
    expect(maxCrossedNote(meter, "05-write-copy-attempt-3")).toMatch(/over the \$2\.60 hard max — finishing on the cheapest complete path .* never held$/);
  });

  it("summarizes estimate vs actual for the gate, the deliverable and the ledger", () => {
    const decision = planRunBudget(WARM_RUN_SHAPE, CALIBRATED_HISTORY);
    const meter = new RunSpendMeter();
    meter.add("05-write-copy-attempt-1", undefined, STEP_COST_ESTIMATES_USD.copyAttempt);
    const summary = summarizeRunBudget(decision, meter, [decision.note]);
    expect(summary).toMatchObject({ estimatedUsd: decision.estimate.estimatedUsd, actualUsd: STEP_COST_ESTIMATES_USD.copyAttempt, targetUsd: 1.8, maxUsd: 2.6, crossedTarget: false, crossedMax: false, posture: "normal", adaptations: [] });
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
        "concept",
        "copyAttempt",
        "copyAttemptWarm",
        "copyLanguageBrief",
        "customArchetype",
        "entityExtract",
        "entitySource",
        "extraction",
        "fluency",
        "generatedImage",
        "nativeJudge",
        "packageNativeJudge",
        "postPackage",
        "relevance",
        "scout",
        "scraperExecution",
        "valueJudge",
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
    // 8.6k in, not the 6.0k this line said until Phase 5: the "rubric 1,500" term was never measured
    // against the file. `instagram-native-editor@1` is 13,109 chars = 3,277 tokens, and @2 is 16,573 =
    // 4,143. Both this key and `packageNativeJudge` carry the whole prompt, so one mis-measurement was
    // two under-counts. See the block below for the full derivation and the rounding rule.
    const nativeJudgeExactHere = (8_643 * 1.25 + 650 * 10) / 1_000_000;
    expect(nativeJudgeExactHere).toBeCloseTo(0.01730375, 8);
    expect(STEP_COST_ESTIMATES_USD.nativeJudge).toBeGreaterThanOrEqual(nativeJudgeExactHere);
    expect(STEP_COST_ESTIMATES_USD.nativeJudge - nativeJudgeExactHere).toBeLessThan(0.001);
    expect((8_643 * 5 + 650 * 25) / 1_000_000).toBeGreaterThan(3 * STEP_COST_ESTIMATES_USD.nativeJudge);
    expect(STEP_COST_ESTIMATES_USD.copyLanguageBrief).toBeCloseTo((3_000 * 3) / 1_000_000, 6);
  });

  /**
   * Phase 5's three new keys, each priced at the published rate for the model
   * it is pinned to, with the input and output halves asserted SEPARATELY —
   * the house rule the `@13 -> @14` note in `run-budget.ts` exists to enforce,
   * and the rule a lump-sum assertion quietly stops enforcing.
   *
   * The no-Opus line is asserted here too, not only written in a comment. The
   * owner's rule is that every new model step justifies its cost beside it; a
   * justification that no test can read is a justification the next re-price
   * will delete without noticing.
   */
  it("prices Phase 5's three new steps on the tier each is pinned to, input and output stated apart, and no Opus anywhere", () => {
    const c = STEP_COST_ESTIMATES_USD;
    const FLASH_IN = 0.3;
    const FLASH_OUT = 2.5;
    const PRO_IN = 1.25;
    const PRO_OUT = 10;
    const OPUS_IN = 5;
    const OPUS_OUT = 25;

    // 07j-value-judge, gemini-2.5-flash, once per attempt in every language.
    // In: rubric 1,700 + brief 600 + the post 1,700 + fact-card digest 800 + scaffolding 300.
    // Out: 4 axes + 4 verbatim quotes + 3 index-aligned fix arrays + keepLine.
    const valueIn = (1_700 + 600 + 1_700 + 800 + 300) * FLASH_IN;
    const valueOut = 500 * FLASH_OUT;
    expect(valueIn / 1_000_000).toBeCloseTo(0.00153, 8);
    expect(valueOut / 1_000_000).toBeCloseTo(0.00125, 8);
    expect(c.valueJudge).toBeCloseTo((valueIn + valueOut) / 1_000_000, 3);
    // Gemini 2.5 Pro on the identical payload is $0.0114 an attempt, $0.034 across three — nearly four
    // times this, a third of Phase 5's entire budget — and what it would buy is TASTE. The rubric is built
    // so taste is not needed: every axis quotes a span and the span is re-checked in code. Opus, out by
    // owner decision, would be $0.0380 an attempt: twelve times, on the judge alone.
    expect((5_100 * PRO_IN + 500 * PRO_OUT) / 1_000_000).toBeCloseTo(0.011375, 8);
    expect((5_100 * PRO_IN + 500 * PRO_OUT) / 1_000_000).toBeGreaterThan(3.5 * c.valueJudge);
    expect((5_100 * OPUS_IN + 500 * OPUS_OUT) / 1_000_000).toBeCloseTo(0.038, 8);
    expect((5_100 * OPUS_IN + 500 * OPUS_OUT) / 1_000_000).toBeGreaterThan(10 * c.valueJudge);

    // 08c-package-post, gemini-2.5-flash, ONCE PER REVISION — hashtags, alt text, first-comment prose.
    const pkgIn = (1_700 + 300 + 600 + 450 + 800 + 200 + 1_250) * FLASH_IN;
    const pkgOut = (40 + 8 * 45 + 120 + 40) * FLASH_OUT;
    expect(pkgIn / 1_000_000).toBeCloseTo(0.00159, 8);
    expect(pkgOut / 1_000_000).toBeCloseTo(0.0014, 8);
    expect(c.postPackage).toBeCloseTo((pkgIn + pkgOut) / 1_000_000, 3);
    // The reason it is a step of its own and not ~520 more output tokens on the Sonnet writer: authored at
    // `05` it would cost ~$0.008 on EVERY attempt, ~$0.023 a run, most of it on drafts a redraft throws
    // away. One Flash call after the loop is 8x cheaper, and alt text for a replaced slide is money burned.
    expect((520 * 15) / 1_000_000).toBeGreaterThan(2 * c.postPackage);
    expect(3 * ((520 * 15) / 1_000_000)).toBeGreaterThan(7 * c.postPackage);

    // 08c2-package-native-round, gemini-2.5-pro, non-English only, once per revision. NO FEW-SHOT: that is
    // the whole difference from `nativeJudge`, which carries four of the client's own posts (~2,000 tokens)
    // because it judges whether a whole draft sounds like this account.
    // THE RUBRIC TERM IS MEASURED, NOT FORECAST. `instagram-native-editor@2` is 16,573 characters
    // LF-normalised; at this repo's chars/4 convention that is 4,143 tokens. Until Phase 5 both this
    // derivation and `nativeJudge`'s said "rubric 1,500" — a figure nobody ever checked against the file,
    // which was already 3,277 tokens at @1. That is the same class of error `copyAttempt` records twice
    // (@14->@15 and @17): a prompt priced from a forecast instead of from disk.
    const RUBRIC_TOKENS = 4_143;
    const nativeIn = (RUBRIC_TOKENS + 450 + 600 + 150) * PRO_IN;
    const nativeOut = (6 * 70 + 90) * PRO_OUT;
    expect(nativeIn / 1_000_000).toBeCloseTo(0.00667875, 8);
    expect(nativeOut / 1_000_000).toBeCloseTo(0.0051, 8);
    // $0.01177875 exactly, entered as 0.012 — rounded UP, not to nearest. The three-decimal table has to
    // pick a direction and this file's header names which one is safe: an estimate that flatters itself
    // pulls no lever.
    const packageNativeExact = (nativeIn + nativeOut) / 1_000_000;
    expect(packageNativeExact).toBeCloseTo(0.01177875, 8);
    expect(c.packageNativeJudge).toBeGreaterThanOrEqual(packageNativeExact);
    expect(c.packageNativeJudge - packageNativeExact).toBeLessThan(0.001);
    expect(c.packageNativeJudge).toBeLessThan(c.nativeJudge);
    // The gap is 3,300 input tokens and 140 output ones, and the single largest line in it is the FEW-SHOT
    // block `nativeJudge` carries and this round does not: four of the client's own recent posts, ~2,000
    // tokens, there because that judge decides whether a whole draft SOUNDS like this account. This one
    // reads an alt text and a first comment, whose register was settled on the copy they were derived from.
    const nativeJudgeExact = ((RUBRIC_TOKENS + 450 + 2_000 + 1_700 + 200 + 150) * PRO_IN + 650 * PRO_OUT) / 1_000_000;
    expect(nativeJudgeExact).toBeCloseTo(0.01730375, 8);
    // Rounded up to 0.018 on the same rule as its sibling, so this is an inequality rather than an
    // equality now. It used to be an equality only because 6,000/650 happened to land on 0.014 exactly.
    expect(c.nativeJudge).toBeGreaterThanOrEqual(nativeJudgeExact);
    expect(c.nativeJudge - nativeJudgeExact).toBeLessThan(0.001);
    // The gap between the two keys is UNCHANGED by the re-price, and that is the point: the rubric is the
    // one input line they share, so correcting it moved both keys and left their difference alone.
    expect(nativeJudgeExact - packageNativeExact).toBeCloseTo((3_300 * PRO_IN + 140 * PRO_OUT) / 1_000_000, 8);
    expect((2_000 * PRO_IN) / 1_000_000).toBeGreaterThan(((3_300 - 2_000) * PRO_IN) / 1_000_000);
    expect((2_000 * PRO_IN) / 1_000_000).toBeGreaterThan((140 * PRO_OUT) / 1_000_000);
    // Same model as `nativeJudge` rather than something cheaper, because Hebrew is first-class and
    // gemini-2.5-pro is the cheapest multilingual-strong + rtlSupport:"strong" row. Opus on the identical
    // call is three times the price for a six-correction pass over two paragraphs.
    expect(((RUBRIC_TOKENS + 450 + 600 + 150) * OPUS_IN + 510 * OPUS_OUT) / 1_000_000).toBeGreaterThan(2.5 * c.packageNativeJudge);

    // The whole phase, against the owner's target: $0.034 English, $0.043 Hebrew — about 4% of $1.00,
    // against the ~72% an Opus writer would have cost. That comparison is the no-Opus reconciliation, and
    // it is asserted rather than asserted-about.
    const phase5English = 3 * 0.005 + 3 * c.valueJudge + c.postPackage + c.scraperExecution;
    const phase5Hebrew = phase5English + c.packageNativeJudge;
    expect(phase5English).toBeCloseTo(0.034, 6);
    // $0.046, not $0.043: `packageNativeJudge` carries the corrected rubric measurement.
    expect(phase5Hebrew).toBeCloseTo(0.046, 6);
    expect(phase5Hebrew).toBeLessThan(0.05 * TARGET_RUN_SPEND_USD);
    // Every new key is a commodity- or mid-tier price: none of them is within reach of the Sonnet writer,
    // let alone of Opus. Stated as a property so a future key added to this table has to answer it too.
    for (const key of ["valueJudge", "postPackage", "packageNativeJudge"] as const) {
      expect(c[key]).toBeLessThan(c.copyAttempt / 10);
    }
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * RFC-19 §8.4 — THE ATTEMPT RUNG GUARD
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ## What this exists to catch, stated as an incident rather than as a policy
 *
 * `run-budget.ts:1524-1554` records it in the module's own words: a cold
 * Hebrew plan sat $0.0002 under target, an HONEST $0.0045 re-price of
 * `vetCall` pushed it over, rung 4 — the ATTEMPT rung — fired,
 * `maxSelfCheckAttempts` went 3 -> 2, and **two tests whose names contain the
 * words "NEVER holds" started producing `status: "held"` runs**. Nobody
 * changed a gate. Nobody changed a hold. A cost key moved by less than half a
 * cent and a quality guarantee three files away stopped being true.
 *
 * ## HOW THIS WAS ACTUALLY RESOLVED (owner, 2026-09-14)
 *
 * The headroom went $0.0002 -> $0.0017 and this guard was written to defend
 * it. Then the owner read the incident and removed the thing being defended:
 * *"the $1 target is a goal and an optimisation, not a hard limit that fails a
 * run"* — so the ladder may adapt OPTIONAL work only, and rung 4 is gone.
 *
 * There is now no margin to protect, because there is no cliff at the end of
 * it. This block is kept, and every assertion in it flipped from "the cliff is
 * here" to "sweep for a cliff and find none". That is a strictly stronger
 * guard: the old one went red when a price moved past one specific number,
 * the new one goes red the moment anyone re-introduces a rung that sells a
 * drafting attempt at ANY price.
 *
 * Why it still matters: RFC-19 (Phase 6) makes every quality gate DELIVER
 * instead of hold, and every one of those deliveries rides the drafting
 * attempt loop rung 4 used to cut. The loop is **the load-bearing member under
 * the owner's "the client cannot receive a failed run" requirement**.
 *
 * ## Why it lives HERE and not only in the flipped gate suites
 *
 * When rung 4 fires the symptom appears in `language-compliance-gate.test.ts`
 * and `zero-held-guarantee.test.ts` as a held run, which reads as a WORKFLOW
 * regression and sends the next reader into the workflow file. It is not one.
 * These two tests fail FIRST, in the file where the cause is, with a number
 * that says how much was added and what it cost.
 *
 * ## RFC-19's own cost claim, asserted rather than asserted-about
 *
 * RFC-19 §7.1 claims **$0.000000 of added planned cost**: `rawEstimate` gains
 * no term in `fixed`, `perAttempt`, `rescue` or `images`. That is not a claim
 * a reviewer can check by reading a diff of a 10,000-line workflow file. It is
 * a claim about four numbers, and the four numbers are pinned below.
 */
describe("RFC-19 §8.4 — there is no attempt rung and no zero-image rung, so no cost can buy itself either one", () => {
  /** The shape RFC-19 §7.3 turns on, and the one `planRunBudget` is handed for a Hebrew client. */
  const COLD_HEBREW_SHAPE = { ...DEFAULT_RUN_SHAPE, targetLanguage: true };

  it("pins the cold Hebrew raw estimate LEG BY LEG, so a new cost lands on a named number here first", () => {
    const c = STEP_COST_ESTIMATES_USD;
    const raw = estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, COLD_HEBREW_SHAPE);

    // ── The pin. Four legs and the total, as literals. ──
    //
    // Literals rather than derivations ON PURPOSE, and the derivation is
    // asserted separately below. A test that only ever re-derives the number
    // from the module's own keys agrees with the module by construction: add a
    // key to `rawEstimate.perAttempt` AND to the derivation, and a
    // derivation-only test still passes while every plan in production moves.
    // The literal is the half that cannot be told the answer.
    expect(raw.breakdown.fixed).toBe(0.2865);
    expect(raw.breakdown.attempts).toBe(1.254);
    expect(raw.breakdown.rescue).toBe(0.201);
    expect(raw.breakdown.images).toBe(0.312);
    expect(raw.rawUsd).toBe(2.0535);
    // `estimateRunCost`'s third argument defaults to a calibration ratio of 1,
    // so on a client with no history the raw figure IS the planned figure.
    expect(raw.estimatedUsd).toBe(raw.rawUsd);
    expect(EMPTY_RUN_BUDGET_HISTORY.ewmaRatio).toBe(1);

    // ── The derivation, term by term, ENUMERATED and not observed. ──
    //
    // Every term `rawEstimate` carries is written out here. A phase that added
    // a priced step inside the attempt loop — a re-ask, a second judge round, a
    // repair that bills — would have to appear on this list to keep the
    // equality, and the moment it does the LITERAL above refuses. The two
    // assertions fail together and say different things: the literal says "the
    // plan moved", this one says "by which term".
    //
    // Phase 5.5 splits what used to be one `perAttempt` figure into three, and
    // the split is the point: the DRAFT is priced cold once and warm after
    // that, the candidate POOL is priced once per attempt or once per run
    // depending on the duplicate-vision rung, and everything else is flat.
    const perAttemptFlat =
      c.vetCall +
      c.relevance +
      c.valueJudge +
      // Hebrew: the `languageBrief` field plus ONE native-editor round. The
      // planner prices one and `revisionEstimateUsd` prices two, deliberately.
      c.copyLanguageBrief +
      c.nativeJudge +
      c.visualQa +
      // Phase 5.5 (spec §4.8): `08b1-compose-contact-sheet` — one vision read
      // of ONE composite of all eight plates, which is what makes
      // `instagram-visual-qa@5`'s five CMO questions answerable (rhythm and
      // repetition are properties of the SEQUENCE). The composite itself is a
      // local browser screenshot at $0; only the read is priced.
      c.visionInspectPerImage +
      // Phase 5.5 (W2-A): one ScrappyCoco execution for the entity's own press
      // page. Every other tier of the entity ladder is $0.
      c.entitySource +
      // 08a4 inspects every rendered slide, capped at 12 by the step itself.
      Math.min(COLD_HEBREW_SHAPE.slideCount, 12) * c.visionInspectPerImage;
    // 05c inspects the whole candidate POOL, six per photo slide.
    const pool = COLD_HEBREW_SHAPE.photoSlides * CANDIDATES_PER_PHOTO_SLIDE * c.visionInspectPerImage;
    const drafts = c.copyAttempt + 2 * c.copyAttemptWarm;
    expect(perAttemptFlat).toBeCloseTo(0.117, 10);
    expect(raw.breakdown.attempts).toBeCloseTo(3 * perAttemptFlat + drafts + 3 * pool, 10);
    // The three free steps, named so nobody "completes" the list above with
    // them: `07i`, `07i2`, `07e2`, `08c1` and RFC-19's two salvage steps are
    // `wf.step.code` with no model call and no tool call, and they contribute
    // nothing BY CONSTRUCTION rather than by omission.
    expect(raw.rawUsd).toBeCloseTo(raw.breakdown.fixed + raw.breakdown.attempts + raw.breakdown.rescue + raw.breakdown.images, 10);

    // The English cold shape differs by exactly the two language lines and
    // nothing else — differencing one thing at a time. This is what makes
    // "Hebrew is the tight one" a measured fact rather than an assumption.
    const english = estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, DEFAULT_RUN_SHAPE);
    expect(raw.breakdown.fixed - english.breakdown.fixed).toBeCloseTo(c.packageNativeJudge, 10);
    expect(raw.breakdown.attempts - english.breakdown.attempts).toBeCloseTo(3 * (c.copyLanguageBrief + c.nativeJudge), 10);
    expect(raw.breakdown.rescue).toBe(english.breakdown.rescue);
    expect(raw.breakdown.images).toBe(english.breakdown.images);
  });

  it("keeps three attempts AND every picture on the cold Hebrew plan, and sweeps for a cliff on either", () => {
    const hebrew = planRunBudget(COLD_HEBREW_SHAPE);

    // ── The acceptance conditions, first and each on its own line. ──
    expect(hebrew.plan.maxSelfCheckAttempts).toBe(3);
    expect(hebrew.plan.generatedImagesCap).toBe(GENERATED_IMAGES_PER_RUN_CAP);
    expect(hebrew.adaptations).not.toContain("one return to step 05 instead of two");
    expect(hebrew.adaptations.some((a) => /image/i.test(a))).toBe(false);

    // ── WHAT CHANGED, AND WHY THIS TEST SURVIVES ITS OWN PREMISE. ──
    //
    // This block was written to defend a $0.0017 margin, and the owner deleted
    // the thing being defended: the attempt rung. Phase 5.5 does the same to
    // the image rung's bottom step. Both assertions are now sweeps — "look for
    // a cliff and find none" — rather than pins on where a cliff was.
    expect(hebrew.estimate.estimatedUsd).toBe(1.7595);
    expect(hebrew.estimate.estimatedUsd).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD);

    // ── THE LADDER, REPLAYED — "it goes red if you break it" is a claim until
    // ── someone breaks it, and the reader of this file cannot.
    //
    // `addedPerAttempt` is money a future phase might spend inside the attempt
    // loop. Feeding it through the real `estimateRunCost` and the real `fits()`
    // rule answers the only question that matters — what does a drafting
    // attempt, or a picture, cost in cents — with the module's own arithmetic
    // instead of with a forecast. The answer is: neither is for sale.
    const replayLadder = (addedPerAttempt: number) => {
      const at = (p: typeof DEFAULT_RUN_BUDGET_PLAN) =>
        roundUsd(estimateRunCost(p, COLD_HEBREW_SHAPE, EMPTY_RUN_BUDGET_HISTORY.ewmaRatio).estimatedUsd + p.maxSelfCheckAttempts * addedPerAttempt);
      const fits = (p: typeof DEFAULT_RUN_BUDGET_PLAN) => at(p) <= TARGET_RUN_SPEND_USD;
      let plan = { ...DEFAULT_RUN_BUDGET_PLAN };
      if (!fits(plan) && plan.optionalRevets) plan = { ...plan, optionalRevets: false };
      if (!fits(plan) && plan.evidencePulls === "full") plan = { ...plan, evidencePulls: "reduced" };
      if (!fits(plan) && plan.duplicateVisionPasses) plan = { ...plan, duplicateVisionPasses: false };
      for (const cap of IMAGE_CAP_STEPS) if (!fits(plan) && plan.generatedImagesCap > cap) plan = { ...plan, generatedImagesCap: cap };
      // There is no rung below this one, and that ABSENCE is what is under test.
      return { plan, landedUsd: at(plan) };
    };

    // ── ASSERT THE PREMISE. ──
    //
    // A replay that has drifted from the module proves nothing about the
    // module, and a guard built on a stale replay is one of the recorded ways
    // this codebase has produced a guard that cannot fail. So the replay at
    // ZERO added cost must land on `planRunBudget`'s OWN answer, plan field for
    // plan field and dollar for dollar, before anything below it is allowed to
    // mean anything. Re-order the rungs in `run-budget.ts` and THIS line fails
    // first.
    const unchanged = replayLadder(0);
    expect(unchanged.plan).toEqual(hebrew.plan);
    expect(unchanged.landedUsd).toBe(hebrew.estimate.estimatedUsd);

    // ── AND THE TWO CLIFFS, SWEPT FOR RATHER THAN PINNED. ──
    //
    // Across four orders of magnitude of added per-attempt cost — from a tenth
    // of a cent to a whole dollar, far past anything the ladder could ever
    // absorb — the plan keeps three attempts AND at least the floor of
    // generated images. Re-introduce an attempt lever, or a zero in
    // `IMAGE_CAP_STEPS`, and one of these fails.
    for (const added of [0.0005, 0.0006, 0.001, 0.01, 0.1, 1]) {
      const replayed = replayLadder(added);
      expect(replayed.plan.maxSelfCheckAttempts, `$${added}/attempt must not buy a drafting attempt`).toBe(3);
      expect(replayed.plan.generatedImagesCap, `$${added}/attempt must not buy the last two pictures`).toBeGreaterThanOrEqual(
        MIN_GENERATED_IMAGES_PER_RUN,
      );
    }

    // The module itself and not only the replay: a shape expensive enough that
    // every remaining rung fires still plans three attempts and still buys the
    // floor.
    const saturated = planRunBudget({ ...COLD_HEBREW_SHAPE, photoSlides: 8 }, { ...EMPTY_RUN_BUDGET_HISTORY, ewmaRatio: 3, runs: [] });
    expect(saturated.plan.generatedImagesCap).toBe(MIN_GENERATED_IMAGES_PER_RUN);
    expect(saturated.plan.evidencePulls).toBe("reduced");
    expect(saturated.plan.optionalRevets).toBe(false);
    expect(saturated.plan.duplicateVisionPasses).toBe(false);
    expect(saturated.plan.maxSelfCheckAttempts).toBe(3);
    expect(saturated.estimate.estimatedUsd).toBeGreaterThan(TARGET_RUN_SPEND_USD);

    // What the deleted rungs would have taken, named in deliverables rather
    // than in dollars — because this is the sentence the next author needs and
    // a dollar figure does not say it. Cutting 3 attempts to 2 never made the
    // run cheaper by a third: it made the gate that returns work on attempt 2
    // the LAST word, which is the difference between a redraft and a degraded
    // delivery. Cutting the image cap to 0 never made the run cheaper by
    // $0.312 either: it made the post a carousel of type, which is the post the
    // owner sent back.
    expect(saturated.plan.maxSelfCheckAttempts).toBe(hebrew.plan.maxSelfCheckAttempts);
    expect(saturated.plan.generatedImagesCap).toBeGreaterThan(0);
  });
});
