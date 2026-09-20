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
 * How many more generations this run has GUARANTEED, given how many GENERATED
 * frames it is actually HOLDING.
 *
 * The guarantee is per RUN and not per attempt or per tier: a run already
 * carrying two surviving generated frames owes one more, not another three, so the floor
 * is a floor rather than a per-attempt multiplier — three attempts x three
 * guaranteed images would be nine guaranteed generations on a run whose plan was
 * already in trouble.
 *
 * ## Why this counts FRAMES THAT SURVIVED and not FRAMES BOUGHT (2026-09-20)
 *
 * It took `generatedSoFar` — the workflow's gross counter, incremented from
 * `tierPool.length` the moment `image.generate` returns, before any vet sees a
 * frame. Two prep carousels shipped at 0 and 1 picture against this floor of 3
 * on 2026-09-20 (karoslabs `pubsub-21902648165262839`, thepitchbydeel
 * `pubsub-21903994794164204`) and the trace is the same in both: three frames
 * bought on attempt 1, the copy loop then rewrote the slides on attempts 2 and
 * 3, and the vet correctly refused all three — *"lacks the required conversation
 * interface and the 'sponsored' label"* — because they were drawn to claims that
 * no longer existed. The counter read 3, the guarantee read PAID, and every
 * downstream gate went quiet: `partitionGaps` returned an empty `guaranteed`, so
 * the rescue tiers had nothing to protect from `optionalRevets: false`, and the
 * floor's own re-entry found `guaranteeLeft === 0` and recorded
 * `{ action: "unfilled" }` on a post with no pictures in it.
 *
 * A frame the vet refused bought nothing. Whatever it cost — and it is still
 * BILLED, the meter is not rewritten — it did not pay down a guarantee
 * denominated in frames that reach the reader. The counter has to mean what the
 * floor means, or the floor measures one thing and binds on another.
 *
 * It counts GENERATED frames specifically, not pictures of any provenance. The
 * first version of this fix counted every surviving picture and was wrong in the
 * other direction: retrieved stock would have discharged a guarantee that exists
 * for the two gaps retrieval provably cannot fill (see
 * `MIN_GENERATED_IMAGES_PER_RUN`'s own docs, and the owner's 2026-09-18 ruling
 * asking for made conceptual visuals by name). `run-budget-workflow.test.ts`
 * caught it.
 *
 * The bound on the other side is NOT this function's job: a run whose vet
 * refuses everything must not buy frames forever. The caller passes `ceiling`
 * (the workflow uses `GENERATED_IMAGES_PER_RUN_CAP`, the widest plan) and
 * `meter.crossedMax` remains the unconditional loop-breaker above it.
 *
 * Garbage in `generatedHeld` reads as ZERO held, which is the direction that
 * keeps the pictures: a NaN must never be allowed to satisfy the floor.
 *
 * @param generatedHeld generated frames this run is currently carrying — frames
 *                      `image.generate` made that SURVIVED vetting, never the
 *                      gross count of frames bought.
 * @param floor         overrides `MIN_GENERATED_IMAGES_PER_RUN`. Tests only.
 */
export function guaranteedGapCount(generatedHeld: number, floor: number = MIN_GENERATED_IMAGES_PER_RUN): number {
  const held = Number.isFinite(generatedHeld) ? Math.max(0, Math.floor(generatedHeld)) : 0;
  const bound = Number.isFinite(floor) ? Math.max(0, Math.floor(floor)) : 0;
  return Math.max(0, bound - held);
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
 * Everything past `guaranteedGapCount(generatedHeld)` is optional, in the same
 * order, so a caller that can afford some of them takes the best ones first.
 *
 * @param gaps          this tier's gaps, in any order.
 * @param generatedHeld generated frames this RUN is currently carrying —
 *                      surviving generated selections, NOT frames bought. See
 *                      `guaranteedGapCount` for the two carousels that shipped
 *                      pictureless because this argument was the gross counter.
 * @param options.conceptSlide the slide number carrying the concept frame, when
 *                       this call is carrying one.
 * @param options.floor  overrides `MIN_GENERATED_IMAGES_PER_RUN`. Tests only —
 *                       the workflow passes nothing, so there is exactly one
 *                       floor in production.
 * @param options.ceiling the most gaps this call may GUARANTEE, whatever the
 *                       floor says — the run's remaining frame allowance.
 *
 *                       Since 2026-09-20 the guarantee RE-ARMS: a frame the vet
 *                       refused no longer pays it down, so a run whose vet
 *                       refuses everything would otherwise buy a fresh
 *                       guarantee's worth on every attempt. It did: the cap
 *                       test asked `image.generate` for ELEVEN frames against a
 *                       per-run ceiling of 8, because `keep` takes the whole
 *                       `guaranteed` slice before the plan's budget is applied.
 *                       The re-arming is the fix; this is what bounds it.
 */
export function partitionGaps<T extends ImageGapLike>(
  gaps: readonly T[],
  generatedHeld: number,
  options: { conceptSlide?: number; floor?: number; ceiling?: number } = {},
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
  const ceiling = options.ceiling === undefined || !Number.isFinite(options.ceiling) ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(options.ceiling));
  const guaranteedCount = Math.min(ordered.length, guaranteedGapCount(generatedHeld, options.floor), ceiling);
  return { guaranteed: ordered.slice(0, guaranteedCount), optional: ordered.slice(guaranteedCount) };
}
