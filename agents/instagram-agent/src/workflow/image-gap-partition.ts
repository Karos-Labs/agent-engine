import { MIN_GENERATED_IMAGES_PER_RUN } from "./run-budget.js";

/**
 * # THE IMAGE FLOOR, ENFORCED WHERE IT ACTUALLY BINDS
 *
 * ## The defect, from the runs the owner judged
 *
 * `planRunBudget`'s floor is ADVISORY. It decides how many generated images a
 * run may buy; it cannot decide that any get made, because three independent
 * gates in `create-instagram-agent-workflow.ts` skip the generate tier outright
 * before the cap is ever consulted:
 *
 * ```
 *   ~:6883   if (!budgetPlan.optionalRevets)  continue;   // the plan pulled a rung
 *   ~:6891   if (meter.posture !== "normal")  continue;   // the live meter crossed the target
 *   ~:6906   gaps = gaps.slice(0, remainingGenerationBudget(...))
 * ```
 *
 * Each of those is a `continue` over the WHOLE tier. So on 2026-09-16 every
 * prep run reached image generation with a plan that had already zeroed the cap
 * AND a ladder that had switched optional work off, and not one picture was
 * made — including the concept frame, which is the one image in the run that
 * retrieval can never recover, because there is no photograph of a designed
 * metaphor anywhere on earth.
 *
 * The owner, on reading those posts: *"אין תמונות למרות שאמרנו שיהיו וזה לא
 * הגיוני"* — there are no images although we said there would be, and that
 * makes no sense.
 *
 * ## What this module is
 *
 * One pure function, called at each of those three gates, that splits the gap
 * list into the part the run has GUARANTEED and the part that is genuinely
 * optional. The gates change from *skip the tier* to *record `rescueSkipped`
 * for the optional part and fall through with the guaranteed part*. The budget
 * still shapes the run — it just cannot shape it below the floor.
 *
 * **`meter.crossedMax` stays the one exception**, and it is not a budget
 * decision: the hard max is a loop-breaker (`MAX_RUN_SPEND_USD`'s own comment),
 * and a run that has spent past it is in a state no amount of image policy
 * should argue with.
 *
 * ## Why a separate module and not a helper inside the workflow file
 *
 * `create-instagram-agent-workflow.ts` is 11,000 lines with several agents
 * editing it at once, and this is the rule three different call sites have to
 * agree about. A rule that lives at its call sites gets three slightly
 * different implementations — which is how the cap came to be checked in three
 * places and enforced in none.
 */

/** The shape the workflow's own `ImageGap` (`{ n, prompt }`) satisfies — only the slide number matters here. */
export interface ImageGapLike {
  /** 1-based slide number. */
  readonly n: number;
}

/**
 * The split. `guaranteed` is what the tier must ask for whatever the budget
 * says; `optional` is what an optional-spend gate may skip, with a reason.
 *
 * Both arrays are new; neither shares identity with the input. Together they
 * are a permutation of the input — nothing is dropped, so a caller that records
 * `rescueSkipped` for `optional` and generates `guaranteed` accounts for every
 * gap it was given.
 */
export interface GapPartition<T extends ImageGapLike> {
  guaranteed: T[];
  optional: T[];
}

/**
 * How many more generations this run has GUARANTEED, given what it has already
 * made.
 *
 * The guarantee is per RUN and not per attempt or per tier: a run that already
 * generated two images on attempt 1 owes nothing further on attempt 2, and the
 * whole of attempt 2's slate is honestly optional. That is what makes the floor
 * a floor rather than a per-attempt multiplier — three attempts x two
 * guaranteed images would be six guaranteed generations, $0.234, on a run whose
 * plan was already in trouble.
 *
 * Garbage in `generatedSoFar` reads as ZERO generated, which is the direction
 * that keeps the pictures: a NaN must never be allowed to satisfy the floor.
 */
export function guaranteedGapCount(generatedSoFar: number, floor: number = MIN_GENERATED_IMAGES_PER_RUN): number {
  const made = Number.isFinite(generatedSoFar) ? Math.max(0, Math.floor(generatedSoFar)) : 0;
  const bound = Number.isFinite(floor) ? Math.max(0, Math.floor(floor)) : 0;
  return Math.max(0, bound - made);
}

/**
 * Split this tier's gaps into the guaranteed ones and the optional ones.
 *
 * ## The order, which is the whole design
 *
 * 1. **The concept slide first**, when `options.conceptSlide` names one. It is
 *    the one picture retrieval cannot recover: every other gap can still be
 *    answered by a photograph, and this one is a drawing of an idea. The
 *    workflow's own generate tier already puts the concept at the head of its
 *    list for exactly this reason (§6.4.2's concept-first ordering); passing
 *    `conceptSlide` here makes that guarantee this module's, so a call site
 *    that forgets cannot silently lose it.
 * 2. **Then the remaining gaps in slide order.** An early picture earns the
 *    swipe — the same argument `imagery-floor.ts` makes when it promotes the
 *    lowest-numbered `text_only` slide first — so if only one guarantee is left
 *    it should land on slide 2 rather than slide 7.
 *
 * Everything past `guaranteedGapCount(generatedSoFar)` is optional, in the same
 * order, so a caller that can afford some of them takes the best ones first.
 *
 * @param gaps          this tier's gaps, in any order.
 * @param generatedSoFar images this RUN has already generated (the workflow's
 *                       own `generatedSoFar` counter).
 * @param options.conceptSlide the slide number carrying the concept frame, when
 *                       this call is carrying one.
 * @param options.floor  overrides `MIN_GENERATED_IMAGES_PER_RUN`. Tests only —
 *                       the workflow passes nothing, so there is exactly one
 *                       floor in production.
 */
export function partitionGaps<T extends ImageGapLike>(
  gaps: readonly T[],
  generatedSoFar: number,
  options: { conceptSlide?: number; floor?: number } = {},
): GapPartition<T> {
  const ordered = [...gaps].sort((a, b) => {
    // The concept first, whichever slide it sits on. `undefined` never matches
    // a slide number, so an ordinary tier sorts purely by slide order.
    if (options.conceptSlide !== undefined) {
      if (a.n === options.conceptSlide && b.n !== options.conceptSlide) return -1;
      if (b.n === options.conceptSlide && a.n !== options.conceptSlide) return 1;
    }
    return a.n - b.n;
  });
  const guaranteedCount = Math.min(ordered.length, guaranteedGapCount(generatedSoFar, options.floor));
  return { guaranteed: ordered.slice(0, guaranteedCount), optional: ordered.slice(guaranteedCount) };
}
