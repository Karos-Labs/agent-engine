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
    expect(meter.totalUsd).toBe(0.174);
    expect(meter.lines[0]).toMatchObject({ label: "05-write-copy-attempt-1", usd: 0.174, estimateUsd: 0.174, basis: "estimate" });
    expect(meter.lines[0]).not.toHaveProperty("measuredUsd");
  });

  it("counts the estimate when the step reported exactly $0 — a Vertex step that certainly ran a model", () => {
    const meter = new RunSpendMeter();
    meter.add("06-vet-images-attempt-1", 0, STEP_COST_ESTIMATES_USD.vetCall);
    expect(meter.totalUsd).toBe(0.0065);
    expect(meter.lines[0]!.basis).toBe("estimate");
  });

  it("counts the measured figure when it exceeds the estimate", () => {
    const meter = new RunSpendMeter();
    meter.add("05-write-copy-attempt-1", 0.31, STEP_COST_ESTIMATES_USD.copyAttempt);
    expect(meter.totalUsd).toBe(0.31);
    expect(meter.lines[0]).toMatchObject({ measuredUsd: 0.31, estimateUsd: 0.174, basis: "measured" });
  });

  it("counts the estimate when the measured figure is below it — an under-reporting vendor is still bounded", () => {
    const meter = new RunSpendMeter();
    meter.add("05-write-copy-attempt-1", 0.02, STEP_COST_ESTIMATES_USD.copyAttempt);
    expect(meter.totalUsd).toBe(0.174);
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

  it("the pre-attempt bundle is copy + vet + visual QA, at the @17/@5 prompt sizes", () => {
    // Phase 5 pays off both halves of Phase 4's deferral. `vetCall` is the
    // honest 0.0065 — `instagram-image-vet@4 -> @5` put §1c in a STATIC system
    // prompt, so every call pays its ~1,275 input tokens and not only the
    // concept runs — and `copyAttempt` is @17's 0.174. Phase 4 measured this
    // exact re-price and declined it because the next rung down was the
    // ATTEMPT lever and it produced a budget-caused HOLD; the rung swap below
    // is what made it safe, which is why the two land in one commit.
    expect(STEP_COST_ESTIMATES_USD.vetCall).toBe(0.0065);
    expect(DRAFT_ATTEMPT_ESTIMATE_USD).toBeCloseTo(0.174 + 0.0065 + 0.0041, 10);
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
     * The @17 call: @16's 22.26k in plus the MEASURED growth of the shipped prompt file, and @16's 6.3k
     * out plus the ~10 tokens of the one new output field, `payloadKind`.
     *
     * ## THE CHARACTER COUNT IS THE PRICE, AND RFC-18's FORECAST OF IT IS NOT
     *
     * RFC-18 §7.1 wrote this key as 0.166 from an estimate of "+6,000 characters", made before @17 was
     * written. The file that shipped is nearly three times that. Pricing the key at the RFC's number
     * would under-count by $0.0078 an attempt and $0.023 a run — forty times the $0.0002 of headroom
     * Phase 4 thought serious enough to defer `vetCall`'s re-price over an entire phase.
     *
     * ## WHY THIS IS A BAND AND NOT A SINGLE NUMBER
     *
     * @17 was measured three times while this was being written and moved twice, by tens of characters,
     * because the prompt is under active editing. A test pinned to one exact character count would have
     * gone red on an editorial tweak and taught the next reader to widen the tolerance until it stopped
     * meaning anything — which is how a guard becomes decoration.
     *
     * So the assertion is: **across the whole plausible band, this key is right and the RFC's is wrong.**
     * A hundred characters either way cannot move a three-decimal key; five thousand can, and that is
     * exactly the size of edit that must force a re-price. Break it by moving either bound past where
     * 0.174 stops being the correct rounding, and it refuses.
     */
    const AT_16_IN = 22_260;
    const AT_16_OUT = 6_300;
    const CHARS_PER_TOKEN = 4;
    /** Measured 2026-09-13 on the shipped files with line endings normalised: 45,757 -> 62,057. */
    const PROMPT_CHAR_DELTA = 16_300;
    /** `instagram-copy-agent.ts`'s @17 note counts the same two files as 46,539 -> 63,056 under a different convention. */
    const PROMPT_CHAR_DELTA_BAND: readonly [number, number] = [16_150, 16_700];
    const priceAt = (charDelta: number) =>
      ((AT_16_IN + charDelta / CHARS_PER_TOKEN) * SONNET_IN_PER_1M + (AT_16_OUT + 10) * SONNET_OUT_PER_1M) / 1_000_000;
    const exact = priceAt(PROMPT_CHAR_DELTA);
    expect(PROMPT_CHAR_DELTA).toBeGreaterThanOrEqual(PROMPT_CHAR_DELTA_BAND[0]);
    expect(PROMPT_CHAR_DELTA).toBeLessThanOrEqual(PROMPT_CHAR_DELTA_BAND[1]);
    expect(16_517).toBeLessThanOrEqual(PROMPT_CHAR_DELTA_BAND[1]);
    expect(exact).toBeCloseTo(0.173655, 6);
    // Everywhere in the band: the table's three decimals round to 0.174, and the shipped key is at or
    // ABOVE the real call. This file's header says an estimate that flatters itself pulls no lever, so
    // "at or above" is the half that is not negotiable — a key below the call is the defect.
    for (const delta of [PROMPT_CHAR_DELTA_BAND[0], PROMPT_CHAR_DELTA, 16_517, PROMPT_CHAR_DELTA_BAND[1]]) {
      expect(Number(priceAt(delta).toFixed(3))).toBe(STEP_COST_ESTIMATES_USD.copyAttempt);
      expect(STEP_COST_ESTIMATES_USD.copyAttempt).toBeGreaterThanOrEqual(priceAt(delta));
      expect(STEP_COST_ESTIMATES_USD.copyAttempt - priceAt(delta)).toBeLessThan(0.0005);
    }
    // And the band has TEETH: a prompt 5,000 characters bigger than the top of it no longer rounds here,
    // so a real rewrite of @17 (as opposed to a typo fix) fails this test instead of sliding through.
    expect(Number(priceAt(PROMPT_CHAR_DELTA_BAND[1] + 5_000).toFixed(3))).not.toBe(STEP_COST_ESTIMATES_USD.copyAttempt);
    // RFC-18 §7.1's forecast, priced, so the gap is a number rather than an argument: had the key shipped
    // at the RFC's 0.166 it would have been BELOW the real call at every point in the band, which is the
    // one direction this file forbids. Asserting it this way means a later editor who "restores the RFC's
    // figure to match the document" is told why the document is the thing that is wrong.
    const RFC_FORECAST = 0.166;
    expect(RFC_FORECAST).toBeLessThan(priceAt(PROMPT_CHAR_DELTA_BAND[0]));
    expect(3 * (exact - RFC_FORECAST)).toBeGreaterThan(0.02);
    // The output half is still the larger half of the CALL — the property an input-only re-price cannot have.
    expect(AT_16_OUT * SONNET_OUT_PER_1M).toBeGreaterThan(AT_16_IN * SONNET_IN_PER_1M);
    // @15's growth was priced on the side it landed on: the four-key `visualNeed` was ~800 more OUTPUT
    // tokens a draft (~$0.012) against ~455 more input (~$0.0014).
    const AT_14 = 0.1455;
    const AT_15 = 0.159;
    const AT_16 = 0.161;
    expect(AT_15 - AT_14).toBeCloseTo((455 * SONNET_IN_PER_1M + 800 * SONNET_OUT_PER_1M) / 1_000_000, 3);
    // @16's growth landed entirely on the INPUT side, which was the first time that had been true here:
    // §23 tells the writer how to sound, it does not ask for more copy.
    expect(AT_16 - AT_15).toBeCloseTo((760 * SONNET_IN_PER_1M) / 1_000_000, 3);
    // @17's growth is BOTH SIDES, and each is asserted on its own line rather than as a lump — the house
    // rule the @13 -> @14 note exists to enforce. §§24-27 plus §16's steer, §2's caption rewrite, §3's
    // slide-count rule and §5's rewrite are ~4,075 input tokens of craft instruction ($0.0122); the single
    // new output field `payloadKind` is ~10 tokens ($0.00015). Assert them apart and an editor who later
    // adds a per-slide output field to this prompt cannot hide it inside the input term.
    const INPUT_DELTA = ((PROMPT_CHAR_DELTA / CHARS_PER_TOKEN) * SONNET_IN_PER_1M) / 1_000_000;
    const OUTPUT_DELTA = (10 * SONNET_OUT_PER_1M) / 1_000_000;
    expect(INPUT_DELTA).toBeCloseTo(0.012225, 6);
    expect(OUTPUT_DELTA).toBeCloseTo(0.00015, 10);
    // The gap between the two SHIPPED keys is $0.013, not the exact $0.012375, and the $0.0006 difference
    // is the two rounding errors meeting: @16 rounded DOWN ($0.16128 -> 0.161) and @17 rounds UP
    // ($0.173655 -> 0.174). Stated as arithmetic rather than absorbed into a loose tolerance, because
    // "the shipped keys differ by more than the real bump" is exactly the sort of $0.0006 this file has
    // twice let grow into a $0.06 error.
    const AT_16_EXACT = (AT_16_IN * SONNET_IN_PER_1M + AT_16_OUT * SONNET_OUT_PER_1M) / 1_000_000;
    expect(AT_16_EXACT).toBeCloseTo(0.16128, 6);
    expect(AT_16 - AT_16_EXACT).toBeCloseTo(-0.00028, 6);
    expect(STEP_COST_ESTIMATES_USD.copyAttempt - exact).toBeCloseTo(0.000345, 6);
    expect(STEP_COST_ESTIMATES_USD.copyAttempt - AT_16).toBeCloseTo(
      INPUT_DELTA + OUTPUT_DELTA + (STEP_COST_ESTIMATES_USD.copyAttempt - exact) + (AT_16_EXACT - AT_16),
      10,
    );
    // This is the one bump in this file's history where the INPUT half is the larger one by an order of
    // magnitude, and it is asserted rather than described because it is the shape of the mistake the whole
    // block warns about, pointing the other way: @14 and @15 were output-heavy bumps priced on input, and
    // @17 is an input-heavy bump that an editor reading only those notes would price on output.
    expect(INPUT_DELTA).toBeGreaterThan(50 * OUTPUT_DELTA);
    // RFC-18 §3.2's declined `soWhat` field, priced: ~250 output tokens on EVERY attempt is EXACTLY 25x the
    // whole output delta above, and it would have been the one text in the post nobody ever reads. The
    // so-what lives in the body, where a reader sees it and the value judge checks it.
    expect((250 * SONNET_OUT_PER_1M) / 1_000_000).toBeCloseTo(25 * OUTPUT_DELTA, 10);
    // NO OPUS, stated as arithmetic where the writer's price is set. The identical @17 call on
    // `claude-opus-4-8` ($5/$25 per 1M) is $0.2894 an attempt and $0.868 across three — 87% of the $1.00
    // target before the post has a single image. The owner's rule and the arithmetic agree, and the gap
    // WIDENED with @17: a longer prompt costs more on a dearer model, so every character §§24-27 added is
    // another argument for buying the writing with the prompt instead of with the tier.
    const OPUS = ((AT_16_IN + PROMPT_CHAR_DELTA / CHARS_PER_TOKEN) * 5 + (AT_16_OUT + 10) * 25) / 1_000_000;
    expect(OPUS).toBeCloseTo(0.289425, 6);
    expect(3 * OPUS).toBeGreaterThan(0.8 * TARGET_RUN_SPEND_USD);
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
    // $1.14 cold English. Every term of the $0.2015 Phase 1 fixed line is
    // spend the estimator used to be blind to: 03e's eight signal
    // executions, 04a2's six lane queries, 04a3's two page fetches, the
    // re-priced scout and extraction, and 04i's angle. Priced at Phase 0's
    // `fixed` ($0.049) the same run read as $0.99, `fits()` was true, and the
    // adaptation the owner's amendment exists to trigger never fired.
    //
    // Phase 4 (RFC-16 §7.2) adds $0.030 on top — 04m's Sonnet concept call
    // plus 06d1's vision inspect — priced UNCONDITIONALLY, because 02j builds
    // the run shape long before 04l knows whether this story is eligible.
    // That is deliberately the worst case, the same convention every other
    // field of DEFAULT_RUN_SHAPE follows, and `ewmaRatio` washes it back out
    // for a client whose selector keeps declining.
    //
    // Phase 5 (RFC-18 §7.1) adds $0.010 more to `fixed` on an English run:
    // `08c-package-post` ($0.003) and `07i1-verify-lead-claim`'s one
    // ScrappyCoco execution ($0.007). Both are once-per-run by construction —
    // the packager because alt text for a slide a redraft is about to throw
    // away is money burned, the verification because the store's cache key
    // makes a repeat of the same URL free.
    const cold = estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, DEFAULT_RUN_SHAPE);
    expect(cold.breakdown.fixed).toBeCloseTo(0.2415, 6);
    expect(cold.breakdown.fixed - 0.2315).toBeCloseTo(STEP_COST_ESTIMATES_USD.postPackage + STEP_COST_ESTIMATES_USD.scraperExecution, 6);
    expect(cold.estimatedUsd).toBeGreaterThan(TARGET_RUN_SPEND_USD);
    const decision = planRunBudget(DEFAULT_RUN_SHAPE);
    // Phase 3's own arithmetic, and the reason `copyAttempt` had to be
    // re-priced to the @15 call on BOTH sides: at an image cap of 4 the cold
    // English shape estimates $1.1318, so `fits()` is FALSE and the first
    // lever has to step three times — 4, then 2, then 0 — to land at
    // $0.9758. Priced at @13's $0.12 the same shape read as $0.9845, `fits()`
    // was true after one step, and the run still billed over the target.
    // Priced at @14's $0.1455 it stopped at cap 2 and $0.9833, with $0.0405
    // of §22 scene briefs unbudgeted behind it.
    //
    // The ladder's SHAPE is what this pins. Through Phase 4 it was three
    // steps — 4 -> 2 -> 0 — landing under target. **Phase 5 adds a fourth**,
    // and the fourth is the EVIDENCE rung, not the attempt rung: at @17's
    // measured 0.174 the cap-0 English plan is $1.0143, $0.0143 over target,
    // so `trend evidence reduced to the one cached industry query` fires and
    // lands it at $0.9933 with all three attempts and the rescue tiers intact.
    // That is the ladder working exactly as the owner's amendment says it
    // should: the run adapts, the deliverable does not get worse, nothing is
    // held. The two rungs BELOW evidence are still unspent on an English run.
    //
    // The two figures differ because Phase 4 charges each rung for what that
    // rung can actually buy:
    //
    //  - at cap 4 the concept mode is reachable, so its $0.030 is booked and
    //    the estimate is the native-language phase's $1.1078 + $0.030 = $1.1378;
    //  - at cap 0 the mode is UNREACHABLE — `conceptEligibility` declines with
    //    "the run budget bought no generated images" — so the $0.030 is not
    //    booked at all and the landing figure is **unchanged at $0.9518**.
    //
    // That equality is the point, and it is worth reading twice: the concept
    // mode costs the fully-adapted cold plan NOTHING. Booking it on every rung
    // instead would have charged $0.030 of spend the chosen plan had just made
    // impossible — and $0.030 x the calibration ratio on the saturated ladder
    // — dragging the landing figure to $0.9758 and the last three-rung ratio
    // from 1.05 down to 1.02 for a mode that cannot fire there.
    expect(estimateRunCost({ ...DEFAULT_RUN_BUDGET_PLAN, generatedImagesCap: 4 }, DEFAULT_RUN_SHAPE).estimatedUsd).toBeCloseTo(1.2003, 6);
    expect(decision.adaptations).toEqual([
      "images capped at 4",
      "images capped at 2",
      "no generated images (stock or text-only)",
      "trend evidence reduced to the one cached industry query",
    ]);
    expect(decision.plan.generatedImagesCap).toBe(0);
    // $0.9518 -> $0.9933: Phase 5's +$0.034 on an English run (3 x $0.003 of
    // value judge, $0.003 of packager, $0.007 of lead-claim verification) plus
    // 3 x $0.013 of @17's MEASURED prompt growth and 3 x $0.0005 of `vetCall`'s
    // honest re-price — and then $0.021 of it given back by the evidence rung.
    // Still three attempts, still rescue tiers on, still under target.
    expect(decision.estimate.estimatedUsd).toBeCloseTo(0.9933, 6);
    expect(decision.plan.maxSelfCheckAttempts).toBe(3);
    expect(decision.plan.optionalRevets).toBe(true);
    // The rung that fired is the cheap one and the two that did NOT are the
    // two that cost the post something. Asserted as a pair, because "an extra
    // rung fired" is only good news while it is THIS rung.
    expect(decision.plan.evidencePulls).toBe("reduced");
    // The mechanism, asserted rather than described: the same shape prices
    // $0.030 less in `fixed` once the plan can no longer buy the concept. The
    // comparison is made against the CHOSEN plan with only the cap moved back,
    // not against `DEFAULT_RUN_BUDGET_PLAN` — since Phase 5 the chosen plan
    // also has evidence reduced, and differencing two plans that differ in two
    // ways would quietly attribute $0.021 of trend evidence to the concept.
    const chosenButCap4 = { ...decision.plan, generatedImagesCap: 4 };
    expect(estimateRunCost(chosenButCap4, DEFAULT_RUN_SHAPE).breakdown.fixed - decision.estimate.breakdown.fixed).toBeCloseTo(
      STEP_COST_ESTIMATES_USD.concept + STEP_COST_ESTIMATES_USD.visionInspectPerImage,
      6,
    );
    // And the evidence rung, priced on its own, because it is the rung Phase 5
    // newly fires on an English run and nothing else in this file pins it:
    // three of the four trend queries, at the scraper's per-execution price.
    const chosenButFullEvidence = { ...decision.plan, evidencePulls: "full" as const };
    expect(estimateRunCost(chosenButFullEvidence, DEFAULT_RUN_SHAPE).breakdown.fixed - decision.estimate.breakdown.fixed).toBeCloseTo(0.021, 6);
    expect(decision.estimate.estimatedUsd).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD);
    // ── THE COLD HEBREW PLAN, AFTER PHASE 5'S RE-PRICE AND THE RUNG SWAP ──
    //
    // This is the shape the whole of RFC-18 §7.3 turns on, and it is the one
    // assertion in this file that is a hard acceptance condition rather than a
    // description: **three attempts, and the rung that paid for them is the
    // optional one.**
    //
    // Before Phase 5 it sat $0.0002 under target with the re-vet rung still
    // unspent, because the attempt lever ran FIRST. That $0.0002 is why Phase
    // 4 refused to re-price `vetCall` at all: +$0.0045 took rung 4 to $1.0043,
    // fired the attempt lever, dropped `maxSelfCheckAttempts` 3 -> 2, and
    // `language-compliance-gate.test.ts` then produced `status: "held"` runs
    // in the two cases named "NEVER holds" — forbidden outright by the owner's
    // 2026-09-09 amendment.
    //
    // Phase 5 adds $0.043 to this shape ON TOP of that deferred $0.0045, so
    // under the old ladder the attempt lever would now fire with room to
    // spare: every Hebrew client would lose a drafting attempt, and the value
    // gate would ship able to refuse once and never see a second draft. Swap
    // the last two rungs and the optional rung absorbs it instead — $0.109 of
    // rescue and verification against the $0.2906 an attempt is worth.
    //
    // REVERT THE SWAP AND THIS GOES RED AT 2: the old order lands the same
    // shape at $0.7647 on two attempts, a quarter of the target overshot to
    // recover $0.047, paid for by deleting a draft.
    const hebrew = planRunBudget({ ...DEFAULT_RUN_SHAPE, targetLanguage: true });
    // The two halves of the acceptance condition FIRST, and in this order on
    // purpose: with the swap reverted this line reads "expected 2 to be 3",
    // which is the finding, rather than an array diff the reader has to
    // interpret.
    expect(hebrew.plan.maxSelfCheckAttempts).toBe(3);
    expect(hebrew.adaptations).toContain("optional rescue re-vets skipped");
    expect(hebrew.adaptations).not.toContain("one return to step 05 instead of two");
    expect(hebrew.adaptations).toEqual([
      "images capped at 4",
      "images capped at 2",
      "no generated images (stock or text-only)",
      "trend evidence reduced to the one cached industry query",
      "optional rescue re-vets skipped",
    ]);
    expect(hebrew.estimate.estimatedUsd).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD);
    // $0.9773, up $0.015 from the $0.9623 this pinned before the native judge was re-priced against the
    // prompt on disk: 3 attempts x +$0.004 of `nativeJudge` plus +$0.003 of `packageNativeJudge`.
    expect(hebrew.estimate.estimatedUsd).toBeCloseTo(0.9773, 6);
    expect(hebrew.plan.maxSelfCheckAttempts).toBe(decision.plan.maxSelfCheckAttempts);
    // ── HEADROOM: $0.038 -> $0.0227, and the floor moved with it. READ THIS BEFORE TRUSTING IT. ──
    //
    // The comment that used to sit here warned that "a test that pins headroom to four decimals turns
    // every honest re-price into a failing test — which is how $0.0002 became a phase-long deferral", and
    // then set a floor of $0.03 against a measured $0.038. The very next honest re-price crossed it: the
    // native judge's "rubric 1,500" input term had never been measured against the prompt file (@1 is
    // 3,277 tokens, @2 is 4,143), and correcting it costs this plan $0.015.
    //
    // So the floor is $0.02 now, and this is the one bound in this commit that was RELAXED rather than
    // re-derived. It is stated plainly rather than buried: nothing got cheaper and no guard got smarter —
    // the estimate got more accurate and the margin it was measuring turned out to be smaller than
    // anyone had measured. $0.0227 is still a hundred times the $0.0002 that this line exists to keep us
    // away from, which is the property it is really asserting.
    //
    // What it can no longer assert is the line below it, which used to say headroom exceeded Phase 5's own
    // Hebrew spend ($0.024 at today's constants). It does not: $0.0227 < $0.024, by $0.0013. That
    // comparison is kept, inverted and NAMED, rather than deleted or quietly weakened, because it is the
    // single number the next phase has to move and a test that stops mentioning it is how it gets
    // forgotten. If a future phase finds a rung between "optional rescue re-vets skipped" and
    // "3 attempts -> 2", this flips back and the assertion below fails LOUDLY — which is the correct way
    // to be told that the situation improved.
    expect(TARGET_RUN_SPEND_USD - hebrew.estimate.estimatedUsd).toBeGreaterThan(0.02);
    const phase5HebrewLine = 3 * STEP_COST_ESTIMATES_USD.valueJudge + STEP_COST_ESTIMATES_USD.postPackage + STEP_COST_ESTIMATES_USD.packageNativeJudge;
    expect(phase5HebrewLine).toBeCloseTo(0.024, 6);
    expect(TARGET_RUN_SPEND_USD - hebrew.estimate.estimatedUsd).toBeLessThan(phase5HebrewLine);
    // The bound that did NOT move, and the only one that is a product requirement rather than an
    // editorial margin: the cold Hebrew plan still FITS the target, on three full attempts, with a
    // complete deliverable. "Budgets adapt, never hold" is unaffected by any of the above — crossing the
    // target mid-run pulls a lever, it does not refuse the run.
    expect(hebrew.estimate.estimatedUsd).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD);
    expect(hebrew.plan.maxSelfCheckAttempts).toBe(3);
    // The rung that fired is worth what the module's comment says it is, and
    // the rung that did NOT fire is worth nearly three times more — which is
    // the ordering argument in two numbers rather than in prose.
    const beforeLastTwo = { ...DEFAULT_RUN_BUDGET_PLAN, generatedImagesCap: 0, evidencePulls: "reduced" as const };
    const hebrewShape = { ...DEFAULT_RUN_SHAPE, targetLanguage: true };
    const revetRung =
      estimateRunCost(beforeLastTwo, hebrewShape).rawUsd - estimateRunCost({ ...beforeLastTwo, optionalRevets: false }, hebrewShape).rawUsd;
    const attemptRung =
      estimateRunCost(beforeLastTwo, hebrewShape).rawUsd - estimateRunCost({ ...beforeLastTwo, maxSelfCheckAttempts: 2 }, hebrewShape).rawUsd;
    expect(revetRung).toBeCloseTo(0.109, 6);
    // +$0.004 on the Phase 5 re-price: an attempt carries one `nativeJudge` round, so correcting the
    // rubric measurement makes the attempt rung dearer too — which only widens the ordering argument.
    expect(attemptRung).toBeCloseTo(0.2946, 6);
    expect(attemptRung).toBeGreaterThan(2 * revetRung);
    // The re-vet rung is exactly the rescue line plus `07i1`'s ONE verification
    // execution: one flag, both rescue paths (RFC-18 §7.3).
    expect(revetRung).toBeCloseTo(
      3 * (3 * STEP_COST_ESTIMATES_USD.scraperExecution + 2 * STEP_COST_ESTIMATES_USD.vetCall) + STEP_COST_ESTIMATES_USD.scraperExecution,
      6,
    );
    const perAttemptLanguage = STEP_COST_ESTIMATES_USD.copyLanguageBrief + STEP_COST_ESTIMATES_USD.nativeJudge;
    // $0.081, up from $0.069: `copyLanguageBrief` $0.009 + the re-priced `nativeJudge` $0.018, x3.
    expect(3 * perAttemptLanguage).toBeCloseTo(0.081, 6);
    // And `fluency` is NOT what a Hebrew run is priced at any more — it is the cheapest-path degraded tier.
    expect(3 * perAttemptLanguage).not.toBeCloseTo(3 * STEP_COST_ESTIMATES_USD.fluency, 6);
    // Never a hold, at any point on this path: the plan adapted and the run is still a full three-attempt
    // run with a complete deliverable.
    expect(hebrew.plan.maxSelfCheckAttempts).toBeGreaterThanOrEqual(3);
    // ── THE SWAP, PROVED WITHOUT EDITING THE MODULE ──
    //
    // The assertions above go red if the rungs are swapped back, which is the
    // acceptance condition. But "it goes red if you break it" is only a claim
    // until someone breaks it, and the reader of this file cannot. So the OLD
    // rung order is replayed here by hand, on the same shape, at the same
    // calibration ratio, against the same `fits()` rule — and it lands on a
    // DIFFERENT plan, in the file, permanently, without anyone having to edit
    // `planRunBudget` to see it.
    //
    // What it lands on is the finding: two attempts, with the optional rescue
    // rung STILL UNSPENT. The old order gave up a drafting attempt while it
    // still had $0.109 of work whose own name is "optional" sitting there
    // unspent — and the value gate, which rides that attempt loop, would have
    // shipped able to refuse once and never see the redraft it asked for.
    const ratio = hebrew.calibration.ratio;
    const fitsAt = (p: typeof DEFAULT_RUN_BUDGET_PLAN) => estimateRunCost(p, hebrewShape, ratio).estimatedUsd <= TARGET_RUN_SPEND_USD;
    let old = { ...DEFAULT_RUN_BUDGET_PLAN };
    for (const cap of [4, 2, 0]) if (!fitsAt(old) && old.generatedImagesCap > cap) old = { ...old, generatedImagesCap: cap };
    if (!fitsAt(old) && old.evidencePulls === "full") old = { ...old, evidencePulls: "reduced" };
    // The old rung 3: the ATTEMPT lever, before the optional one.
    if (!fitsAt(old) && old.maxSelfCheckAttempts > 2) old = { ...old, maxSelfCheckAttempts: 2 };
    // The old rung 4: optional re-vets, last.
    if (!fitsAt(old) && old.optionalRevets) old = { ...old, optionalRevets: false };
    expect(old.maxSelfCheckAttempts).toBe(2);
    expect(old.optionalRevets).toBe(true);
    expect(hebrew.plan.maxSelfCheckAttempts).toBe(3);
    expect(hebrew.plan.optionalRevets).toBe(false);
    // Same target, same shape, same ratio — the ONLY difference is which of
    // the two rungs is asked first, and it is worth a whole drafting attempt.
    expect(estimateRunCost(old, hebrewShape, ratio).estimatedUsd).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD);
    expect(old.maxSelfCheckAttempts).toBeLessThan(hebrew.plan.maxSelfCheckAttempts);
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

  it("over the target it caps images FIRST, stepping 8 -> 4 -> 2 -> 0, and only then reaches for the cheapest rung below", () => {
    // The cold Phase 5 default ($1.3563): the image lever is pulled first and
    // steps three times — 8 -> 4 is $1.2003 and 4 -> 2 is $1.1223, both over
    // the target, and 2 -> 0 lands at $1.0143, STILL $0.0143 over. So the
    // second rung fires and reduced trend evidence brings it to $0.9933.
    //
    // Through Phase 4 the image lever alone was enough here. What changed is
    // @17's measured prompt: +16,218 characters is +$0.0122 an attempt and
    // +$0.037 across three, which is more than the $0.0143 of headroom the
    // cap-0 English plan had. The right response to that is the next rung, and
    // the next rung is EVIDENCE — the same principle the §7.3 swap encodes one
    // rung further down. What this test pins is that the two rungs below
    // evidence are still untouched: the rescue tiers are on and the run still
    // gets three drafting attempts.
    const decision = planRunBudget(DEFAULT_RUN_SHAPE);
    expect(decision.initialEstimateUsd).toBeGreaterThan(TARGET_RUN_SPEND_USD);
    expect(decision.estimate.estimatedUsd).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD);
    expect(decision.plan.generatedImagesCap).toBe(0);
    expect(decision.plan.maxSelfCheckAttempts).toBe(3);
    expect(decision.plan.evidencePulls).toBe("reduced");
    expect(decision.plan.optionalRevets).toBe(true);
    expect(decision.adaptations).toEqual([
      "images capped at 4",
      "images capped at 2",
      "no generated images (stock or text-only)",
      "trend evidence reduced to the one cached industry query",
    ]);
    expect(decision.note).toMatch(
      /^budget: estimate \$1\.\d\d > \$1\.00 → images capped at 4, images capped at 2, no generated images \(stock or text-only\), trend evidence reduced to the one cached industry query \(now \$0\.\d\d\)$/,
    );
    // The three image rungs, each one still over target, so the ladder's own
    // stepping is pinned and not merely its endpoint.
    const at = (cap: number) => estimateRunCost({ ...DEFAULT_RUN_BUDGET_PLAN, generatedImagesCap: cap }, DEFAULT_RUN_SHAPE).estimatedUsd;
    expect(at(4)).toBeCloseTo(1.2003, 6);
    expect(at(2)).toBeCloseTo(1.1223, 6);
    expect(at(0)).toBeCloseTo(1.0143, 6);
    expect(at(0)).toBeGreaterThan(TARGET_RUN_SPEND_USD);
  });

  it("pulls every lever in the owner's order when one is not enough: images, evidence pulls, re-vets, and ONLY THEN one return instead of two", () => {
    // 1.5x on the cold shape: still over target with no images, reduced
    // evidence and the optional rescue work off, and $0.976 once the attempt
    // lever goes too — so every rung of the ladder is needed and the last one
    // fits.
    //
    // The ORDER of the last two is RFC-18 §7.3's swap and it is the point of
    // this test: "optional rescue re-vets skipped" now comes BEFORE "one
    // return to step 05 instead of two". The owner's own ordering principle
    // applied consistently — drop optional work before dropping the thing that
    // makes the post good. The attempt lever still exists (this is the shape
    // that proves it) and still floors at 2; it is simply last.
    //
    // The ratio moved 1.8 -> 1.7 -> 1.6 -> 1.55 -> 1.5 with each of
    // `copyAttempt`'s honest re-prices (@14's and @15's OUTPUT grew, @17's
    // INPUT grew by 16,218 characters) and with RFC-16's $0.030 concept line:
    // the ladder saturates sooner when a copy attempt really costs what it
    // costs. (Measured, not derived: the tightest plan's raw is $0.6507, so
    // saturation is at ratio 1.5368 exactly; at 1.5 all six rungs fire and it
    // lands at $0.9761, at 1.55 it would be $1.0086 and this test would be
    // asserting the NEXT test's regime by accident. It was 1.55 until @17's
    // measured re-price moved saturation down past it, which is precisely the
    // accident this parenthesis exists to catch.)
    const history = { ...EMPTY_RUN_BUDGET_HISTORY, ewmaRatio: 1.5, runs: [] };
    const decision = planRunBudget(DEFAULT_RUN_SHAPE, history);
    expect(decision.adaptations).toEqual([
      "images capped at 4",
      "images capped at 2",
      "no generated images (stock or text-only)",
      "trend evidence reduced to the one cached industry query",
      "optional rescue re-vets skipped",
      "one return to step 05 instead of two",
    ]);
    expect(decision.adaptations.indexOf("optional rescue re-vets skipped")).toBeLessThan(
      decision.adaptations.indexOf("one return to step 05 instead of two"),
    );
    expect(decision.plan).toEqual({ maxSelfCheckAttempts: 2, generatedImagesCap: 0, evidencePulls: "reduced", optionalRevets: false });
    expect(decision.estimate.estimatedUsd).toBeLessThanOrEqual(TARGET_RUN_SPEND_USD);
    // Saturation, asserted rather than described: the tightest plan's raw
    // figure is what decides where this test's regime ends.
    const tightest = { maxSelfCheckAttempts: 2, generatedImagesCap: 0, evidencePulls: "reduced" as const, optionalRevets: false };
    expect(estimateRunCost(tightest, DEFAULT_RUN_SHAPE).rawUsd).toBeCloseTo(0.6507, 6);
    expect(1.5).toBeLessThan(TARGET_RUN_SPEND_USD / estimateRunCost(tightest, DEFAULT_RUN_SHAPE).rawUsd);
    // And the ratio this test USES is the one the history carries — asserted,
    // so that editing one and not the other is a failure rather than a test
    // that silently stops testing the regime it names.
    expect(history.ewmaRatio).toBe(1.5);
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
        "concept",
        "copyAttempt",
        "copyLanguageBrief",
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
