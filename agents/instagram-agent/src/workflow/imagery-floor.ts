import { HERO_IMAGE_LAYOUTS } from "./slides-data.js";
import type { InstagramCopyOutput, InstagramSlideLayout } from "./types.js";

/**
 * # THE IMAGERY FLOOR
 *
 * ## The defect, measured on two real prep runs
 *
 * ```
 * karoslabs       pubsub-21551118258353204   8 slides   5 carried a hero image
 *                                                       (one AI-GENERATED, n4-gen0.png)
 * thepitchbydeel  pubsub-21559620763659451   8 slides   0 carried a hero image
 * ```
 *
 * Same agent, same week, same budget. One post shipped five photographs
 * including a generated one; the other shipped a carousel with **no picture in
 * it at all**.
 *
 * The owner, 2026-09-15, on reading that: *"it makes no sense that the budget
 * pays for 6 and the post comes out with 0."*
 *
 * ## Why it happens, and why nothing caught it
 *
 * Images are sourced only for slides whose resolved layout is in
 * `HERO_IMAGE_LAYOUTS` — `photo` and `cover`, the only two archetypes whose
 * templates declare an `{{image:hero}}` slot. Every other archetype
 * (`stat_callout`, `quote_card`, `comparison_card`, `list_takeaway`,
 * `headline_focus`, `text_only`) sources nothing, by design.
 *
 * **So the number of pictures in a post is decided entirely by the copy
 * model's `layout` choices, and nothing has ever enforced a floor on it.** A
 * draft that reaches for structured panels — which prompt `instagram-copy`
 * actively encourages, and rightly: *"a carousel where every slide is a caption
 * over a stock photo has one rhythm and reads as filler"* — produces a post
 * with zero imagery and no gate objects.
 *
 * Meanwhile `DEFAULT_RUN_SHAPE.photoSlides` is **6**: the budget plans, prices
 * and reserves spend for six image slides on every run. The two halves of the
 * system have disagreed about this for the whole of the agent's life.
 *
 * ## What this module does
 *
 * Before image sourcing runs, it counts the slides that CAN carry a picture. If
 * that is under the floor it promotes `text_only` slides to `photo` — lowest
 * slide number first — until the floor is met or there is nothing left to
 * promote.
 *
 * **`text_only` is the only archetype it will promote, and that is the whole
 * safety argument.** `text_only` and `photo` resolve to the SAME template
 * (`slide.html`); the difference between them is nothing but whether an image
 * was sourced. Promoting one is therefore not a design change at all — it is
 * asking for a picture on a plate already built to hold one. Every other
 * archetype is a designed shape whose content would have nowhere to go, and
 * converting a `stat_callout` into a photograph would throw away the figure
 * that made it a stat callout.
 *
 * **And it only ever adds.** A carousel already over the floor is returned
 * untouched, so a draft that chose its own photographs keeps exactly the mix
 * the writer chose.
 *
 * ## Why promotion rather than a gate
 *
 * A gate here would hold or redraft a post over furniture, and the standing
 * owner rule is that budgets adapt and never hold. Promotion is **$0.00 and
 * deterministic** — it changes one enum on one slide and lets the existing
 * sourcing ladder (client upload -> library -> stock -> scrape -> **generate**)
 * do the rest. That ladder already works; the karoslabs run above is the proof,
 * and its fourth slide is an AI-generated image the ladder produced unaided.
 *
 * If sourcing then finds nothing for a promoted slide, the workflow's existing
 * behaviour applies unchanged: the slide is reassigned back to `text_only` and
 * ships heroless, with `downgradedForImages` waiving clause E. **A promotion is
 * a request for a picture, never a promise of one.**
 */

/**
 * How many slides of a carousel must be able to carry a picture.
 *
 * ## Why 3 and not 6
 *
 * `DEFAULT_RUN_SHAPE.photoSlides` is 6, and that number is a BUDGET estimate —
 * what the run may spend on sourcing — not a composition target. Enforcing six
 * would make three quarters of every carousel a photograph and produce exactly
 * the post the copy prompt warns against: *"one rhythm, reads as filler."* The
 * budget over-estimating is the safe direction and the owner's own rule
 * (`budgets-adapt-never-hold`: estimate first, adapt, always deliver); the
 * composition floor is a different question and gets its own number.
 *
 * ## Where 3 comes from
 *
 * `docs/instagram-restraint-reference.md`, harvested from the accounts that
 * ship this format professionally: `@semrush` and `@buffer` carry a real
 * photograph or a real diagram on roughly every third plate, never on every
 * one and never on none. On an 8-slide carousel that is 3.
 *
 * It is a FLOOR and not a target: a draft that wants five photographs keeps
 * five. What it refuses is the shape this module was written for — a post with
 * one or none.
 */
export const MIN_IMAGE_CAPABLE_SLIDES = 3;

/** One promotion, for the trace. A composition change nobody can audit is a composition change nobody can correct. */
export interface ImageryPromotion {
  slide: number;
  from: InstagramSlideLayout;
  to: "photo";
}

export interface ImageryFloorResult {
  copy: InstagramCopyOutput;
  /** Empty when the draft already met the floor — the ordinary case on a well-composed post. */
  promotions: ImageryPromotion[];
  /** How many slides could carry a picture before and after, for the ledger. */
  before: number;
  after: number;
  /** Set when the floor could not be met — every promotable slide was used and it still was not enough. */
  shortfallReason?: string;
}

/** Whether this slide's layout can carry a hero image at all. `resolveLayout` is not consulted: a `custom` archetype's markup is model-authored and declares no hero slot. */
function canCarryImage(layout: InstagramSlideLayout): boolean {
  return HERO_IMAGE_LAYOUTS.has(layout);
}

/**
 * The carousel with enough image-capable slides to meet the floor.
 *
 * Returns a NEW copy — this runs before image sourcing and the draft it is
 * handed is checkpointed, so mutating it in place would make a resumed run see
 * a different input from the one that was recorded.
 */
export function enforceImageryFloor(copy: InstagramCopyOutput, floor: number = MIN_IMAGE_CAPABLE_SLIDES): ImageryFloorResult {
  const before = copy.slides.filter((s) => canCarryImage(s.layout ?? "photo")).length;
  if (before >= floor) return { copy, promotions: [], before, after: before };

  const promotions: ImageryPromotion[] = [];
  let carried = before;
  const slides = copy.slides.map((slide) => {
    const layout = slide.layout ?? "photo";
    // Lowest slide number first, which `map` gives for free: an early
    // photograph is what earns the swipe, and a picture on slide 7 does less
    // work than the same picture on slide 2.
    if (carried >= floor || layout !== "text_only") return slide;
    carried += 1;
    promotions.push({ slide: slide.n, from: layout, to: "photo" });
    return { ...slide, layout: "photo" as const };
  });

  return {
    copy: { ...copy, slides },
    promotions,
    before,
    after: carried,
    ...(carried < floor
      ? {
          shortfallReason:
            `only ${carried} of ${floor} image-capable slides after promoting every \`text_only\` slide — ` +
            `this draft is ${copy.slides.length} structured archetypes deep, and promoting a designed shape would throw away the content that made it one`,
        }
      : {}),
  };
}
