import { FULL_BLEED_IMAGE_LAYOUTS } from "./slides-data.js";
import type { InstagramCopyOutput, InstagramSlideLayout } from "./types.js";

/**
 * # THE IMAGERY BAND
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
 * `HERO_IMAGE_LAYOUTS`, which at the time of the two runs above was `photo`
 * and `cover` — the only two archetypes whose templates declared an
 * `{{image:hero}}` slot. Every other archetype sourced nothing, by design.
 *
 * (That set is six wide now: the four panel archetypes got a bounded
 * `.sc-figure-band` in the same phase. What this module COUNTS is the narrower
 * `FULL_BLEED_IMAGE_LAYOUTS`, and that set's doc comment says why — a 300px
 * band on a 1440px plate is an accent, not a photograph, and counting it here
 * would let a carousel of three banded panels meet a floor a reader would say
 * it missed.)
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
 * **Between the two bounds it changes nothing.** A carousel with 3, 4 or 5
 * pictures is returned untouched, so a draft that chose its own mix keeps
 * exactly the mix the writer chose. Only the two ends are enforced.
 *
 * ## The ceiling, added 2026-09-15
 *
 * Over `MAX_PICTURE_SLIDES` it demotes `photo` slides back to `text_only` —
 * HIGHEST slide number first, the mirror of the promotion's lowest-first rule
 * and for the same reason: an early photograph earns the swipe, so the
 * pictures that go are the late ones. It never touches slide 1.
 *
 * The two ends cannot fight: the floor only runs below the floor, the ceiling
 * only above the ceiling, and `MIN_PICTURE_SLIDES < MAX_PICTURE_SLIDES`
 * leaves three counts where neither does anything. A single pass, so the
 * result is idempotent by construction.
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
export const MIN_PICTURE_SLIDES = 3;

/**
 * How many slides of a carousel may carry a full-bleed picture.
 *
 * ## The other half of the owner's rule, 2026-09-15
 *
 * > *"מינון ויזואלי מאוזן: שילוב תמונות ב-3 עד 5 שקופיות לאורך הפוסט (איפה
 * > שזה משרת את המסר), ושאר השקופיות נשענות על טיפוגרפיה נקייה, נתונים או
 * > אובייקטים גרפיים."*
 * >
 * > Balanced visual dosage: images in 3 to 5 slides across the post (where it
 * > serves the message), and the rest lean on clean typography, data or
 * > graphic objects.
 *
 * A range, not a minimum - and the module had only ever had a bottom. The
 * karoslabs run this file was written about shipped **five** of eight, which
 * is inside the band; nothing stopped the next draft choosing eight. Eight
 * photographs is the post the copy prompt warns against in its own words:
 * *"a carousel where every slide is a caption over a stock photo has one
 * rhythm and reads as filler."* The floor refuses a post with no pictures;
 * this refuses a post that is nothing else.
 *
 * ## Why 5 on an 8-slide carousel
 *
 * It is the owner's number, and it is also the point at which the OTHER
 * register still has a majority of the remaining plates: 5 pictures leaves 3
 * slides for the typography, the figures and the bounded objects that the
 * second half of his sentence asks for. At 6 the quiet plates are down to two
 * and the mix has a single rhythm again.
 *
 * ## And why 5 is not the whole rule
 *
 * The first draft of this constant said it was deliberately NOT scaled to the
 * slide count, on the grounds that "a shorter carousel is already inside the
 * band by arithmetic (a 5-slide post cannot exceed 5)". That reasoning is
 * wrong, and the suite said so: `goodCopyOutput()` is SIX slides and every one
 * of them is a `photo`, so an absolute 5 let it through having removed exactly
 * one picture. Five of six is not a mix, and the sentence the owner actually
 * wrote is not "at most five" - it is *"and the rest lean on clean typography,
 * data or graphic objects"*. A post with one quiet plate has no rest.
 *
 * So the ceiling keeps a REST, and `MIN_QUIET_SLIDES` is what that word means
 * in numbers. `ceilingFor` is the whole rule; this constant is its upper bound.
 */
export const MAX_PICTURE_SLIDES = 5;

/**
 * How many plates a post keeps for the other register, whatever else it does.
 *
 * Two, and it comes from the same place the floor's 3 does: the restraint
 * reference's count of the accounts that ship this format professionally, where
 * the plates between the photographs are not padding but where the argument is
 * actually made. One is not a rest, it is a survivor.
 *
 * It binds only on SHORT carousels. At 8 slides the absolute 5 is the lower of
 * the two and this changes nothing, which is the intended shape: the owner's
 * number governs a full-length post, and this keeps a six-slide one honest.
 */
export const MIN_QUIET_SLIDES = 2;

/**
 * The ceiling in force for a carousel of this length.
 *
 * `max(floor, min(ceiling, slides - MIN_QUIET_SLIDES))`, and all three terms
 * are load-bearing:
 *
 * ```
 *   slides   min(5, slides - 2)   in force
 *        8                    5          5   the owner's number binds
 *        7                    5          5
 *        6                    4          4   the rest binds
 *        5                    3          3
 *        4                    2          3   the FLOOR binds
 *        3                    1          3   (a no-op: nothing is over it)
 * ```
 *
 * The outer `max` is not a detail. Without it the ceiling drops below
 * `MIN_PICTURE_SLIDES` on a four-slide post, and the floor and the ceiling would
 * then disagree about the same carousel: promote to 3, demote to 2, and whichever
 * ran last wins. A gate that can argue with itself is worse than either of its
 * halves, so the floor takes ties by construction and a short post is simply
 * never over its ceiling.
 */
export function ceilingFor(slideCount: number, ceiling: number = MAX_PICTURE_SLIDES, floor: number = MIN_PICTURE_SLIDES): number {
  return Math.max(floor, Math.min(ceiling, slideCount - MIN_QUIET_SLIDES));
}

/** One promotion, for the trace. A composition change nobody can audit is a composition change nobody can correct. */
export interface ImageryPromotion {
  slide: number;
  from: InstagramSlideLayout;
  to: "photo";
}

/**
 * One demotion, the exact inverse.
 *
 * `photo` -> `text_only` is the only demotion this module will make, for the
 * same reason `text_only` -> `photo` is the only promotion: the two resolve to
 * the SAME template and differ by nothing but whether an image was sourced, so
 * the change is not a design change at all. It cannot touch a `cover` (slide 1
 * is the hook, and `default:cover-carries-device` requires a photograph or a
 * figure device there) and it cannot touch a designed panel, whose bounded band
 * is not what this bound counts.
 *
 * The demoted slide lands on the plate the bounded object was built for
 * (RFC-20 §11.4): `composeBoundedObjects` runs at assembly, well after this, so
 * a demoted slide whose copy carries a sourced figure renders that figure as a
 * device rather than going quiet. That ordering is why the ceiling can be
 * enforced here at all.
 */
export interface ImageryDemotion {
  slide: number;
  from: "photo";
  to: "text_only";
}

export interface ImageryBandResult {
  copy: InstagramCopyOutput;
  /** Empty when the draft already met the floor — the ordinary case on a well-composed post. */
  promotions: ImageryPromotion[];
  /** How many slides could carry a picture before and after, for the ledger. */
  before: number;
  after: number;
  /** Set when the floor could not be met — every promotable slide was used and it still was not enough. */
  shortfallReason?: string;
  /** Empty on a draft already inside the band, which is the ordinary case. */
  demotions: ImageryDemotion[];
  /** Set when the ceiling could not be reached — every photo slide that could be demoted was, and the rest are covers or panels. */
  excessReason?: string;
}

/**
 * Whether this slide's layout carries a picture a reader would call a picture.
 *
 * `FULL_BLEED_IMAGE_LAYOUTS`, not `HERO_IMAGE_LAYOUTS`, and that set's own doc
 * comment carries the argument: the four panel archetypes source an image into
 * a bounded 300px band, which is an accent on a typographic plate rather than a
 * photograph, and counting it here let a carousel of three banded panels meet a
 * floor a reader would say it missed.
 *
 * `resolveLayout` is not consulted: a `custom` archetype's markup is
 * model-authored and declares no hero slot.
 */
function carriesPicture(layout: InstagramSlideLayout): boolean {
  return FULL_BLEED_IMAGE_LAYOUTS.has(layout);
}

/**
 * The carousel brought inside the imagery band.
 *
 * Returns a NEW copy whenever it changes anything — this runs before image
 * sourcing and the draft it is handed is checkpointed, so mutating it in place
 * would make a resumed run see a different input from the one that was
 * recorded. Returns the SAME object, by identity, when the draft was already
 * inside the band, which is how the caller's ledger tells a no-op from a
 * change without comparing layouts.
 */
export function enforceImageryBand(
  copy: InstagramCopyOutput,
  floor: number = MIN_PICTURE_SLIDES,
  ceiling: number = MAX_PICTURE_SLIDES,
): ImageryBandResult {
  const before = copy.slides.filter((s) => carriesPicture(s.layout ?? "photo")).length;
  // The ceiling in force depends on how long this carousel is — see
  // `ceilingFor`. The ARGUMENT is the upper bound a caller asked for; what
  // binds is that bound or the rest, whichever is lower, and never below the
  // floor.
  const inForce = ceilingFor(copy.slides.length, ceiling, floor);

  // ── UNDER THE FLOOR: promote `text_only`, lowest slide number first. ──
  if (before < floor) {
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
      copy: promotions.length > 0 ? { ...copy, slides } : copy,
      promotions,
      demotions: [],
      before,
      after: carried,
      ...(carried < floor
        ? {
            shortfallReason:
              `only ${carried} of ${floor} picture slides after promoting every text_only slide — ` +
              `this draft is ${copy.slides.length} structured archetypes deep, and promoting a designed shape would throw away the content that made it one`,
          }
        : {}),
    };
  }

  // ── OVER THE CEILING: demote `photo`, highest slide number first. ──
  //
  // `cover` is excluded by name rather than by being outside the promotable
  // set, because it IS inside `FULL_BLEED_IMAGE_LAYOUTS` and so it is counted:
  // slide 1 is the hook the owner's first principle is about, and
  // `default:cover-carries-device` refuses a slide 1 with neither a photograph
  // nor a figure device. Demoting it would return to `05` on every attempt.
  if (before > inForce) {
    const demotions: ImageryDemotion[] = [];
    let carried = before;
    const slides = [...copy.slides].reverse().map((slide) => {
      if (carried <= inForce || (slide.layout ?? "photo") !== "photo") return slide;
      carried -= 1;
      demotions.push({ slide: slide.n, from: "photo", to: "text_only" });
      return { ...slide, layout: "text_only" as const };
    });
    demotions.reverse();

    return {
      copy: demotions.length > 0 ? { ...copy, slides: slides.reverse() } : copy,
      promotions: [],
      demotions,
      before,
      after: carried,
      ...(carried > inForce
        ? {
            excessReason:
              `still ${carried} picture slides against a ceiling of ${inForce} after demoting every photo slide — ` +
              `the rest are the cover, which is the hook and must carry a picture or a device`,
          }
        : {}),
    };
  }

  // ── INSIDE THE BAND: the ordinary case, and it touches nothing. ──
  return { copy, promotions: [], demotions: [], before, after: before };
}
