import type { SceneSource } from "./scene-brief.js";
import { FULL_BLEED_IMAGE_LAYOUTS, HERO_IMAGE_LAYOUTS } from "./slides-data.js";
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

/** FNV-1a plus murmur3's finalizer. The avalanche is not decoration — see {@link choosePlacements}. */
function placementHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Raw FNV-1a's HIGH bits barely move between inputs that share a prefix and
  // differ at the end, and that is the exact shape of a run id:
  // `pubsub-21904879061334183` vs `pubsub-21896063218741941`. Taking a
  // fraction off the top of the raw hash put six different seeds inside
  // 0.41-0.44 and produced the identical placement for all of them — a
  // "seeded" choice that was not seeded by anything. The finalizer spreads the
  // entropy down into the low bits, which is where `% length` reads.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * Which `count` of `candidates` carry a picture this run, seeded.
 *
 * ── WHY THIS IS NOT SLIDE ORDER ──
 *
 * It was, in both directions: promote lowest-numbered first, demote
 * highest-numbered first. Perfectly deterministic, and therefore identical on
 * every post a client has ever published — photographs on 1, 2, 4 and 6, run
 * after run. The owner, 2026-09-20: *"אני רוצה שמיקומי התמונות ישתנו לפעמים כי
 * תבניות גנריות בכל הפוסטים נראה AI"*. A reader cannot say why a feed looks
 * machine-made; a picture in the same four places every time is part of it.
 *
 * ── SPREAD BY CONSTRUCTION, NOT BY LUCK ──
 *
 * A seeded shuffle would vary the places and cluster them: three photographs
 * in a row and then five text plates is a worse post than the fixed order it
 * replaced. So the picks are spaced `length / count` apart and the SEED moves
 * the starting offset. Every run gets an evenly spread set; different runs get
 * different ones.
 *
 * The entropy requirement is deliberately tiny — one `% length` — because a
 * scheme that needs a well-distributed float is the one that silently failed
 * here first (see {@link placementHash}). Rounding can collide when `count`
 * approaches `length`, so the walk fills forward past anything already taken,
 * which also makes `count >= length` degrade to "all of them" rather than to a
 * short list.
 *
 * With no seed the answer is the first `count` in slide order — what every
 * caller that is not a run should get, so a fixture does not move because a
 * run would have.
 */
function choosePlacements(candidates: readonly number[], count: number, seed: string | undefined): Set<number> {
  if (count <= 0) return new Set();
  if (count >= candidates.length) return new Set(candidates);
  if (seed === undefined || seed.length === 0) return new Set(candidates.slice(0, count));

  // Stratified: the list is cut into `count` contiguous bands and the seed
  // picks one slide INSIDE each band. One per band is what makes the result
  // spread; a free position inside the band is what makes it vary.
  //
  // A single seeded offset with a fixed stride — the first version of this —
  // is spread too, but it can only ever produce `stride` distinct answers: six
  // candidates choosing two gave exactly {2,5}, {3,6}, {4,7} and nothing else,
  // so eight different real run ids produced three different posts. Choosing
  // within the band turns that into `stride ** count`.
  const chosen = new Set<number>();
  const stride = candidates.length / count;
  for (let j = 0; j < count; j++) {
    const bandStart = Math.floor(j * stride);
    const bandEnd = j === count - 1 ? candidates.length : Math.floor((j + 1) * stride);
    const width = Math.max(1, bandEnd - bandStart);
    let index = bandStart + (placementHash(`${seed}:${j}`) % width);
    // Forward-fill past a collision, so the set always reaches `count` even
    // when a band is one slide wide and its slide is already taken.
    for (let probe = 0; probe < candidates.length && chosen.has(candidates[index]!); probe++) {
      index = (index + 1) % candidates.length;
    }
    chosen.add(candidates[index]!);
  }
  return chosen;
}

/**
 * Does this post need one more picture for the sake of WHERE its pictures
 * sit, rather than how many it has?
 *
 * ## The post this exists because of
 *
 * prep `pubsub-21926643455584277` (karoslabs, 2026-09-21) shipped three
 * pictures, on slides 1, 2 and 7 — a `cover` and two `photo` plates. All three
 * are in `FULL_BLEED_IMAGE_LAYOUTS`, so all three pictures WERE the plate, and
 * `figurePlacementFor` returns `"band"` for every one of them. The post had
 * three picture-capable interior plates (`stat_callout`, `list_takeaway`,
 * `quote_card`) and gave a picture to none. The owner: *"יצא פה שכל התמונות הן
 * רקע ... לפעמים זה טוב שזה באמצע למשל או בצד באמצע"*.
 *
 * Nothing malfunctioned, which is why it had survived this long. The floor
 * asks for THREE PICTURES and the post had three, so `want` came out 0,
 * `planImageBackfill` was never called, and the bounded-plate preference that
 * function already implements — "a BOUNDED plate before a full-bleed one" —
 * never got a chance to express itself. A rule that only fires when the post
 * is short of pictures cannot shape a post that has enough.
 *
 * ## What this asks for, and what it deliberately does not
 *
 * One bounded picture, and only when EVERY picture the post holds is
 * full-bleed. Not a quota, not a ratio: the defect is the monotony of a post
 * whose every image is a background, and one inset breaks it. Asking for more
 * would start trading away the full-bleed plates that earn the swipe.
 *
 * It returns 0 when the post is already at its ceiling, when it holds no
 * pictures at all (that is the floor's business, not this rule's), and when
 * something bounded already landed — including a bounded plate the writer
 * asked for itself, which is the case this must not double.
 */
export function placementMixShortfall(
  copy: InstagramCopyOutput,
  withPictureNs: ReadonlySet<number>,
  ceiling: number = MAX_PICTURE_SLIDES,
): number {
  if (withPictureNs.size === 0) return 0;
  if (withPictureNs.size >= ceilingFor(copy.slides.length, ceiling, MIN_PICTURE_SLIDES)) return 0;
  const carrying = copy.slides.filter((slide) => withPictureNs.has(slide.n));
  const anyBounded = carrying.some((slide) => !FULL_BLEED_IMAGE_LAYOUTS.has(slide.layout ?? "photo"));
  if (anyBounded) return 0;
  // Only worth asking when there is somewhere bounded for it to go. A post of
  // nothing but covers and photo plates has no inset to offer and this rule
  // has no opinion about it.
  const boundedSeatsFree = copy.slides.some(
    (slide) => !withPictureNs.has(slide.n) && HERO_IMAGE_LAYOUTS.has(slide.layout ?? "photo") && !FULL_BLEED_IMAGE_LAYOUTS.has(slide.layout ?? "photo"),
  );
  return boundedSeatsFree ? 1 : 0;
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
  /** Per-RUN seed (the workflow passes `wf.runId`) — see {@link placementOrder}. Omitted keeps strict slide order. */
  seed?: string,
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
    const candidates = copy.slides.filter((slide) => (slide.layout ?? "photo") === "text_only").map((slide) => slide.n);

    // ── THE COVER IS NOT PART OF THE LOTTERY. ──
    //
    // Slide 1 is the hook, and the pipeline already says so twice: the
    // demotion branch below refuses to take its picture away, and
    // `default:cover-carries-device` refuses a cover carrying neither a
    // photograph nor a figure device. Under strict slide order it was promoted
    // first for free; under a seeded choice it stopped being promoted at all
    // on some runs, which is a worse post than the repetition this change
    // exists to fix. So it takes its picture first when it needs one, and the
    // seed distributes what is left.
    const first = copy.slides[0];
    const coverNeedsPicture = first !== undefined && candidates.includes(first.n);
    const need = Math.max(0, floor - before);
    const chosen = coverNeedsPicture && need > 0
      ? new Set([first.n, ...choosePlacements(candidates.filter((n) => n !== first.n), need - 1, seed)])
      : choosePlacements(candidates, need, seed);

    // ── THE EARLY PICTURE SURVIVES THE SHUFFLE. ──
    //
    // The old strict slide order carried a real editorial argument inside it —
    // an early photograph is what earns the swipe, and a picture on slide 7
    // does less work than the same picture on slide 2 — and a seeded order
    // would throw that away roughly one run in four by putting every promotion
    // in the back half.
    //
    // So the seed chooses WHICH slides, and this keeps the one property that
    // was worth having: the front half of the carousel carries a picture. Only
    // when the draft did not already put one there, and only by moving the
    // latest promotion to the earliest candidate — the smallest edit that
    // makes it true, rather than a re-sort that would collapse back onto
    // slide order.
    const frontHalfLast = Math.ceil(copy.slides.length / 2);
    const hasEarlyPicture = copy.slides.some(
      (slide) => slide.n <= frontHalfLast && (carriesPicture(slide.layout ?? "photo") || chosen.has(slide.n)),
    );
    if (!hasEarlyPicture && chosen.size > 0) {
      const earliest = candidates.find((n) => n <= frontHalfLast);
      if (earliest !== undefined) {
        chosen.delete(Math.max(...chosen));
        chosen.add(earliest);
      }
    }

    let carried = before;
    const slides = copy.slides.map((slide) => {
      const layout = slide.layout ?? "photo";
      if (!chosen.has(slide.n) || layout !== "text_only") return slide;
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
    // The mirror of the promotion side: the seed picks WHICH photographs go,
    // spread the same way, so the survivors are not always the lowest-numbered
    // ones. Reversed before choosing, so that with NO seed this still demotes
    // from the back — byte-identical to the behaviour this branch had before,
    // which is what the fixtures pin. `cover` is never a candidate: it is
    // excluded by `!== "photo"`, for the reason this branch's own comment
    // gives.
    // Slide 1 is never demotable, for the reason this branch's comment above
    // already gives: it is the hook, and `default:cover-carries-device`
    // refuses a cover with neither a photograph nor a device. The old
    // walk-from-the-end reached it only after exhausting everything else, so
    // in practice it never lost its picture; a stratified choice picks across
    // the WHOLE list and took it immediately. Excluded by position rather
    // than by layout name, because a first slide the writer typed as `photo`
    // is still the cover.
    const demotable = copy.slides
      .filter((slide, index) => index > 0 && (slide.layout ?? "photo") === "photo")
      .map((slide) => slide.n);
    const dropped = choosePlacements([...demotable].reverse(), Math.max(0, before - inForce), seed);

    let carried = before;
    const slides = copy.slides.map((slide) => {
      if (!dropped.has(slide.n) || (slide.layout ?? "photo") !== "photo") return slide;
      carried -= 1;
      demotions.push({ slide: slide.n, from: "photo", to: "text_only" });
      return { ...slide, layout: "text_only" as const };
    });

    return {
      copy: demotions.length > 0 ? { ...copy, slides } : copy,
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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5.5, brief item A5 — A SLIDE THAT LOST ITS PHOTOGRAPH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What to do about a slide that asked for a picture and did not get one.
 *
 * The ladder is `interest-relayout.ts`'s (spec §4.7), in its order, and every
 * value here means "the relayout may consider this remedy for this slide":
 *
 * - `promote` — the run holds a vetted image nobody placed. Put it here. The
 *   only remedy that ends with the picture the slide asked for.
 * - `attach-device` — the slide's own copy carries a sourced figure with its
 *   complete label, so the bounded device path can carry the plate. **Only with
 *   a figure that appears verbatim in this slide's copy**: the remedy that
 *   fabricated the digit `2` out of the middle of `B2B` on run
 *   `pubsub-21839432908803804` is the reason that clause is written twice.
 * - `merge` — fold this slide into its neighbour and let the carousel be one
 *   slide shorter. The spec's own first rung (§4.7), and the ONLY remedy that
 *   removes an empty plate rather than resizing one.
 * - `font-scale` — the writer's own plate, still carrying its own idea, on a
 *   carousel that cannot afford to lose it. Raise the type step of the
 *   strongest line: a composition, not an addition.
 * - `none` — the slide already ships a designed object, so losing the
 *   photograph cost the post nothing to fix. Recorded anyway, because the gate
 *   payload should say a picture was wanted and not found even when the plate
 *   survives it.
 */
export type ImageryRemedy = "merge" | "promote" | "font-scale" | "attach-device" | "none";

/**
 * One slide that wanted a picture and ships without one.
 *
 * **Emitted, and gating nothing.** Losing a photograph is never a hold (clause
 * E's `downgradedForImages` waiver stands, and the standing rule is that
 * budgets and imagery adapt). What changes is that the loss stops being silent:
 * today it sits inside `waived` where nobody reads it, and the owner's *"חלק
 * מהשקפים ריקים"* — some of the slides are empty — is the result. This record
 * travels to the gate payload and into `08a1b-relayout-for-interest` as an
 * input, so on attempts 1..n-1 the finding can go back to `05` and only the
 * final attempt degrades.
 */
export interface ImageryShortfall {
  /** 1-based slide number. */
  slide: number;
  /** What the slide's own brief asked for. `none` never appears: a slide that asked for no picture has not lost one. */
  wanted: SceneSource;
  /** Whether `enforceImageryBand` is what asked this slide for a picture, rather than the writer. */
  promotedByBand: boolean;
  /** `none` — the layout still wants a hero and has none. `text_only` — the slide was reassigned to a typographic plate. */
  got: "none" | "text_only";
  /** The real reason, in the sourcing ladder's own words ("no candidate cleared the vet", a provider 503, "generation budget spent"). */
  why: string;
  remedy: ImageryRemedy;
}

/** One slide's side of the question, as the sourcing ladder knows it. */
export interface ImageryShortfallInput {
  slide: number;
  wanted: SceneSource;
  got: "none" | "text_only";
  why: string;
  /** The slide's copy carries a figure WITH its complete label — `composeBoundedObjects`'s precondition. */
  hasOwnFigure?: boolean;
  /** The plate already renders a designed object, so it is not a bare type plate. */
  hasDesignedObject?: boolean;
}

/**
 * The shortfall records for one attempt, with a remedy chosen deterministically
 * and for $0.
 *
 * `spareVettedImages` is how many vetted, rights-clean images the run sourced
 * and did not place. It is consumed in order — two shortfalls and one spare
 * produce exactly one `promote` — because a remedy that two slides both claim
 * is a remedy that fails for one of them at relayout time, and the relayout has
 * no way to tell which.
 *
 * Slides are processed in slide order so the spare lands on the earliest plate,
 * which is the same argument `enforceImageryBand` makes when it promotes
 * lowest-first: an early picture earns the swipe.
 *
 * ── WHY `merge` IS NOT RESERVED FOR A BAND PROMOTION ANY MORE. ──
 *
 * It was, and the consequence was measured on this tree: a plain photo slide
 * that sourced nothing and carries no figure of its own fell all the way to
 * `font-scale`, i.e. *set the same two strings larger*. Rendered with sourcing
 * returning nothing (the 2026-09-16 condition), karoslabs slides 3 and 6
 * measured `occupiedShare` 0.023/0.024 with a single empty rectangle covering
 * 46% of the plate, and deel's the same — and in the same attempt clause H is
 * waived for exactly these slides, so nothing objected either. `font-scale` on
 * a two-element plate adds nothing a reader looks at; the spec's §4.7 order is
 * merge, promote, raise the step, attach a device, and `merge` is the one rung
 * that makes the empty plate stop existing.
 *
 * So `merge` is now offered to ANY shortfall slide a neighbour can absorb once
 * the two rungs that would IMPROVE the plate (a spare picture, the slide's own
 * figure) have been tried, and `font-scale` is what is left when no neighbour
 * can take it. Whether a neighbour CAN is the
 * caller's fact and arrives as `mergeable`: `interest-relayout.ts`'s
 * `mergeRemedy` refuses the cover, the closer, a post already at its client's
 * `slides_min`, and any caller that cannot apply the change — and a remedy the
 * planner will refuse is a remedy that reads like a fix in the trace and is
 * not one. Absent, no slide is offered `merge`, which is the pre-5.5 behaviour
 * for every caller that has not been told the carousel's shape.
 *
 * AT MOST ONE per attempt, like `spareVettedImages` and for the same reason:
 * the workflow's apply case renumbers every n-keyed structure from ONE table,
 * and two merges planned against pre-merge numbering would move the second
 * one's picture onto the wrong slide.
 */
export function imageryShortfallsFor(
  slides: readonly ImageryShortfallInput[],
  context: {
    promotedSlides?: readonly number[] | ReadonlySet<number>;
    spareVettedImages?: number;
    /** Which slide numbers a neighbour could absorb — the caller's own answer to `mergeRemedy`'s preconditions. Absent means "this caller cannot merge", and no slide is offered one. */
    mergeable?: readonly number[] | ReadonlySet<number>;
  } = {},
): ImageryShortfall[] {
  const promoted = context.promotedSlides instanceof Set ? context.promotedSlides : new Set(context.promotedSlides ?? []);
  const mergeable = context.mergeable instanceof Set ? context.mergeable : new Set(context.mergeable ?? []);
  let spare = Number.isFinite(context.spareVettedImages) ? Math.max(0, Math.floor(context.spareVettedImages!)) : 0;
  let mergesLeft = 1;
  return [...slides]
    .filter((s) => s.wanted !== "none")
    .sort((a, b) => a.slide - b.slide)
    .map((s) => {
      const promotedByBand = promoted.has(s.slide);
      let remedy: ImageryRemedy;
      if (spare > 0) {
        spare -= 1;
        remedy = "promote";
      } else if (s.hasOwnFigure === true) {
        remedy = "attach-device";
      } else if (s.hasDesignedObject === true) {
        // Checked AFTER the two remedies that would improve the plate and
        // BEFORE the two that only rearrange it: a plate with a designed object
        // is not empty, so there is nothing here the relayout has to fix — and
        // merging one away would throw a composed plate out.
        remedy = "none";
      } else if (mergeable.has(s.slide) && mergesLeft > 0) {
        // NOTHING LEFT TO PUT ON IT, and a neighbour that can take its words.
        // This is where a plain photo slide that sourced nothing used to fall
        // through to `font-scale`; `promotedByBand` is now a fact on the record
        // rather than the gate on this rung.
        mergesLeft -= 1;
        remedy = "merge";
      } else {
        remedy = "font-scale";
      }
      return { slide: s.slide, wanted: s.wanted, promotedByBand, got: s.got, why: s.why, remedy };
    });
}

