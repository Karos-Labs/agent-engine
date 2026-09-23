import { describe, expect, it } from "vitest";
import { ceilingFor, enforceImageryBand, isPictureDensity, MAX_PICTURE_SLIDES, MIN_PICTURE_SLIDES, MIN_QUIET_SLIDES, PICTURE_BANDS, placementMixShortfall } from "../src/workflow/imagery-floor.js";
import { FULL_BLEED_IMAGE_LAYOUTS, HERO_IMAGE_LAYOUTS } from "../src/workflow/slides-data.js";
import type { InstagramCopyOutput, InstagramSlideLayout } from "../src/workflow/types.js";
import { goodCopyOutput } from "./test-helpers.js";

/**
 * # THE IMAGERY FLOOR
 *
 * The defect this module exists for is two real prep runs of the same agent in
 * the same week on the same budget:
 *
 * ```
 * karoslabs       8 slides   5 with a hero image (one AI-GENERATED)
 * thepitchbydeel  8 slides   0
 * ```
 *
 * Nothing was broken in either. Images are sourced only for
 * `HERO_IMAGE_LAYOUTS`, so the picture count was decided entirely by the copy
 * model's layout choices — while the budget priced six image slides on every
 * run. **The owner's complaint is the gap between those two facts**, and every
 * case below is about closing it without turning every carousel into stock
 * photography.
 */

/** A carousel with the given layouts, in order, on otherwise valid copy. */
function carousel(...layouts: InstagramSlideLayout[]): InstagramCopyOutput {
  const base = goodCopyOutput();
  return {
    ...base,
    slides: layouts.map((layout, i) => ({ ...base.slides[i % base.slides.length]!, n: i + 1, layout })),
  };
}

const layoutsOf = (copy: InstagramCopyOutput): InstagramSlideLayout[] => copy.slides.map((s) => s.layout ?? "photo");
/** What the BAND counts: a plate whose picture IS the plate. See `FULL_BLEED_IMAGE_LAYOUTS` for why that is a different set from the one sourcing reads. */
const pictures = (copy: InstagramCopyOutput): number => layoutsOf(copy).filter((l) => FULL_BLEED_IMAGE_LAYOUTS.has(l)).length;
const capable = (copy: InstagramCopyOutput): number => layoutsOf(copy).filter((l) => HERO_IMAGE_LAYOUTS.has(l)).length;

describe("where the pictures land, run to run (2026-09-20)", () => {
  /**
   * The owner, on a feed of posts that each had photographs in the same four
   * places: *"אני רוצה שמיקומי התמונות ישתנו לפעמים כי תבניות גנריות בכל
   * הפוסטים נראה AI"*.
   *
   * They were in the same places because both halves of the band walked the
   * carousel in slide order — promote lowest-numbered first, demote
   * highest-numbered first — which is perfectly deterministic and therefore
   * identical on every post a client has ever published.
   */
  const textOnlyEight = () => carousel("cover", "text_only", "text_only", "text_only", "text_only", "text_only", "text_only", "closer");
  const placed = (seed: string | undefined): number[] =>
    enforceImageryBand(textOnlyEight(), undefined, undefined, seed).promotions.map((p) => p.slide);

  /**
   * REAL run ids, not `run-a`/`run-b`. The seeds a client's posts actually
   * carry share a 20-character prefix and differ only in their last digits,
   * and that is the case a placement scheme is most likely to fail on: raw
   * FNV-1a's high bits barely move across them, so the first version of this
   * put all eight of these inside phase 0.41-0.44 and produced the IDENTICAL
   * placement for every one. Toy seeds would have passed it.
   */
  const REAL_RUN_IDS = [
    "pubsub-21904879061334183",
    "pubsub-21896063218741941",
    "pubsub-21895722571509959",
    "pubsub-21899590279354945",
    "pubsub-21120774919499971",
    "pubsub-21066011420549815",
    "pubsub-21868183257380937",
    "pubsub-21864573169935321",
  ];

  it("puts the pictures in different places across real run ids", () => {
    const seen = new Set(REAL_RUN_IDS.map((seed) => placed(seed).join(",")));
    // Most of them distinct, not merely "more than one": the failure this
    // guards against produced exactly one, and a scheme that produced two or
    // three out of eight would still read as the same post every time.
    expect(seen.size, `placements across ${REAL_RUN_IDS.length} real run ids: ${[...seen].join(" | ")}`).toBeGreaterThanOrEqual(5);
  });

  it("gives one run the same answer every time, because the band runs before sourcing and its result is checkpointed", () => {
    expect(placed("run-stable")).toEqual(placed("run-stable"));
  });

  it("still puts a picture in the front half, whichever way the seed falls", () => {
    // The editorial argument the old slide order carried inside it: an early
    // photograph earns the swipe. The seed chooses WHICH slides; it does not
    // get to leave the first half bare.
    for (const seed of REAL_RUN_IDS) {
      const result = enforceImageryBand(textOnlyEight(), undefined, undefined, seed);
      const early = result.copy.slides.filter((slide) => slide.n <= 4 && FULL_BLEED_IMAGE_LAYOUTS.has(slide.layout ?? "photo"));
      expect(early.length, `seed "${seed}" left the front half with no picture`).toBeGreaterThan(0);
    }
  });

  it("still lands inside the band, whichever way the seed falls", () => {
    // Moving the pictures must not change HOW MANY there are.
    for (const seed of REAL_RUN_IDS) {
      const result = enforceImageryBand(textOnlyEight(), undefined, undefined, seed);
      expect(pictures(result.copy), `seed "${seed}"`).toBeGreaterThanOrEqual(MIN_PICTURE_SLIDES);
      expect(pictures(result.copy), `seed "${seed}"`).toBeLessThanOrEqual(MAX_PICTURE_SLIDES);
    }
  });

  it("with no seed, keeps the old slide order exactly — a fixture must not move because a run would have", () => {
    expect(placed(undefined)).toEqual([2, 3]);
  });
});

describe("placementMixShortfall: a post whose every picture is a background", () => {
  /**
   * prep `pubsub-21926643455584277` (karoslabs, 2026-09-21) shipped three
   * pictures — slides 1, 2 and 7, a `cover` and two `photo` plates. All three
   * are full-bleed, so all three pictures WERE the plate and
   * `figurePlacementFor` returned `"band"` for every one. Three picture-capable
   * interior plates sat empty. The owner: *"יצא פה שכל התמונות הן רקע ...
   * לפעמים זה טוב שזה באמצע למשל או בצד באמצע"*.
   *
   * Nothing had malfunctioned, which is why it lasted. The floor asks for
   * three pictures, the post had three, `want` came out 0, and
   * `planImageBackfill`'s own "a BOUNDED plate before a full-bleed one"
   * preference never ran. A rule that fires only when a post is SHORT of
   * pictures cannot shape one that has enough.
   */
  const karosShape = () => carousel("cover", "photo", "stat_callout", "list_takeaway", "quote_card", "headline_focus", "photo", "closer");

  it("asks for one bounded picture when every picture the post holds is full-bleed", () => {
    expect(placementMixShortfall(karosShape(), new Set([1, 2, 7]))).toBe(1);
  });

  it("asks for nothing once something bounded has landed", () => {
    expect(placementMixShortfall(karosShape(), new Set([1, 2, 3]))).toBe(0);
  });

  it("stays out of a post with no pictures at all — that is the floor's business", () => {
    expect(placementMixShortfall(karosShape(), new Set())).toBe(0);
  });

  it("has no opinion when the post has nowhere bounded to put one", () => {
    expect(placementMixShortfall(carousel("cover", "photo", "photo", "photo", "closer", "closer"), new Set([1, 2]))).toBe(0);
  });

  it("stops at the ceiling rather than pushing a post over it for the sake of variety", () => {
    expect(placementMixShortfall(karosShape(), new Set([1, 2, 3, 4, 7]))).toBe(0);
  });

  it("asks for ONE, never a quota — the defect is monotony and one inset breaks it", () => {
    // Two full-bleed pictures and four empty bounded seats still asks for one.
    expect(placementMixShortfall(karosShape(), new Set([1, 2]))).toBe(1);
  });
});

describe("enforceImageryBand", () => {
  it("promotes text_only to photo until the floor is met — the thepitchbydeel carousel, which shipped zero pictures", () => {
    // The real one, read off `pubsub-21559620763659451`'s deliverable: one
    // stat callout, three heroless `slide.html`, a comparison, a quote, a
    // headline focus and a list. Not one archetype in `HERO_IMAGE_LAYOUTS`.
    // `stat_callout` and `quote_card` joined `HERO_IMAGE_LAYOUTS` when they got
    // their bounded image band, so the shipped mix is re-stated with the four
    // archetypes that still carry no picture. The defect is the same one — a
    // structured draft sourcing nothing — and it is now harder to reach, which
    // is the point of widening the set.
    const shipped = carousel("headline_focus", "text_only", "custom", "text_only", "headline_focus", "text_only", "closer", "custom");
    expect(capable(shipped), "the fixture is not the imageless carousel this case is about").toBe(0);

    const out = enforceImageryBand(shipped);
    expect(out.before).toBe(0);
    expect(out.after).toBe(MIN_PICTURE_SLIDES);
    expect(out.shortfallReason).toBeUndefined();
    // Lowest slide number first: an early photograph is what earns the swipe.
    expect(out.promotions.map((p) => p.slide)).toEqual([2, 4, 6]);
    expect(layoutsOf(out.copy)).toEqual(["headline_focus", "photo", "custom", "photo", "headline_focus", "photo", "closer", "custom"]);
  });

  it("LEAVES A CAROUSEL THAT ALREADY MET THE FLOOR COMPLETELY ALONE — it only ever adds", () => {
    // The karoslabs shape: the writer chose its own pictures and keeps every
    // one of them, and the three `text_only` slides stay text_only. A floor
    // that also REMOVED pictures would be a composition rule, and this is not
    // one.
    const composed = carousel("cover", "photo", "text_only", "photo", "stat_callout", "photo", "text_only", "closer");
    const out = enforceImageryBand(composed);
    expect(out.promotions).toEqual([]);
    expect(out.copy).toBe(composed);
    expect(layoutsOf(out.copy)).toEqual(layoutsOf(composed));
  });

  it("stops the moment the floor is met, and never promotes one slide more than it needs", () => {
    const one = carousel("cover", "text_only", "text_only", "text_only", "text_only", "text_only", "text_only", "closer");
    const out = enforceImageryBand(one);
    // One capable slide already (the cover), so exactly two promotions.
    expect(out.before).toBe(1);
    expect(out.promotions.map((p) => p.slide)).toEqual([2, 3]);
    expect(out.after).toBe(MIN_PICTURE_SLIDES);
    expect(layoutsOf(out.copy).filter((l) => l === "text_only")).toHaveLength(4);
  });

  it("NEVER promotes a designed archetype, because its content would have nowhere to go", () => {
    // `text_only` and `photo` resolve to the SAME template and differ by
    // nothing but whether an image was found — which is the entire safety
    // argument for promoting one. A `stat_callout` carries a figure, a
    // `quote_card` an attribution, a `list_takeaway` its rows; converting one
    // into a photograph throws away the content that made it that shape.
    const structured = carousel("headline_focus", "custom", "headline_focus", "closer", "custom", "closer", "cover", "custom");
    const out = enforceImageryBand(structured);
    expect(out.promotions).toEqual([]);
    expect(layoutsOf(out.copy)).toEqual(layoutsOf(structured));
  });

  it("reports a SHORTFALL rather than forcing it, when there is nothing left to promote", () => {
    // Seven designed archetypes and one text_only: the floor cannot be met and
    // the honest answer is to say so, not to convert a quote card. The run
    // continues — this module never holds anything.
    const dense = carousel("headline_focus", "closer", "custom", "headline_focus", "custom", "closer", "headline_focus", "text_only");
    const out = enforceImageryBand(dense);
    expect(out.promotions.map((p) => p.slide)).toEqual([8]);
    expect(out.after).toBe(1);
    expect(out.shortfallReason).toMatch(/only 1 of 3/u);
    expect(out.shortfallReason).toMatch(/throw away the content/u);
  });

  it("returns a NEW copy and mutates nothing, because the draft it is handed is checkpointed", () => {
    const before = carousel("headline_focus", "text_only", "text_only", "text_only", "headline_focus", "closer", "custom", "custom");
    const snapshot = JSON.stringify(before);
    const out = enforceImageryBand(before);
    expect(JSON.stringify(before), "a resumed run would see a different input from the one that was recorded").toBe(snapshot);
    expect(out.copy).not.toBe(before);
  });

  it("is idempotent: running it twice promotes nothing the second time", () => {
    const once = enforceImageryBand(carousel("headline_focus", "text_only", "text_only", "text_only", "headline_focus", "closer", "custom", "custom"));
    const twice = enforceImageryBand(once.copy);
    expect(once.promotions.length).toBeGreaterThan(0);
    expect(twice.promotions).toEqual([]);
  });

  it("the floor is 3 and that is a COMPOSITION number, not the budget's", () => {
    // `DEFAULT_RUN_SHAPE.photoSlides` is 6 — what the run may SPEND on
    // sourcing. Enforcing six here would make three quarters of every carousel
    // a photograph and produce the post the copy prompt warns against: "one
    // rhythm, reads as filler". The budget over-estimating is the safe
    // direction (`budgets-adapt-never-hold`); the composition floor is a
    // different question and gets its own number, from the restraint
    // reference's own count of roughly every third plate.
    expect(MIN_PICTURE_SLIDES).toBe(3);
    const eight = carousel("cover", "text_only", "text_only", "text_only", "text_only", "text_only", "text_only", "closer");
    expect(enforceImageryBand(eight).after, "the floor became a target — every carousel is now mostly photographs").toBe(3);
  });

  it("takes the floor as a parameter, so the sweep above is a real range and not one number twice", () => {
    const eight = carousel("text_only", "text_only", "text_only", "text_only", "text_only", "text_only", "text_only", "text_only");
    for (const floor of [0, 1, 2, 3, 5, 8]) {
      expect(enforceImageryBand(eight, floor).promotions, `floor ${floor}`).toHaveLength(floor);
    }
    // And past what the carousel can supply it reports rather than throws.
    const over = enforceImageryBand(eight, 99);
    expect(over.promotions).toHaveLength(8);
    expect(over.shortfallReason).toBeDefined();
  });

  // ───────────────────────────────────────────────────────────────────────
  // THE CEILING. The owner's rule is a RANGE - images in 3 to 5 slides across
  // the post - and until 2026-09-15 this module had only a bottom. The
  // karoslabs run it was written about shipped five of eight, inside the band;
  // nothing stopped the next draft choosing eight, which is the one-rhythm
  // post the copy prompt warns against in its own words.
  // ───────────────────────────────────────────────────────────────────────

  it("demotes photo back to text_only when a draft reaches for a picture on nearly every plate", () => {
    const saturated = carousel("cover", "photo", "photo", "photo", "photo", "photo", "photo", "closer");
    expect(pictures(saturated), "the fixture is not the over-photographed carousel this case is about").toBe(7);

    const out = enforceImageryBand(saturated);
    expect(out.before).toBe(7);
    expect(out.after).toBe(MAX_PICTURE_SLIDES);
    expect(out.promotions).toEqual([]);
    expect(out.excessReason).toBeUndefined();
    // HIGHEST slide number first, the mirror of the promotion's rule: an early
    // photograph earns the swipe, so the pictures that go are the late ones.
    // Reported ascending, because a reviewer reads a carousel forwards.
    expect(out.demotions.map((d) => d.slide)).toEqual([6, 7]);
    expect(layoutsOf(out.copy)).toEqual(["cover", "photo", "photo", "photo", "photo", "text_only", "text_only", "closer"]);
  });

  it("LEAVES EVERY COUNT INSIDE THE BAND COMPLETELY ALONE, by identity", () => {
    // 3, 4 and 5 are the counts the owner asked for, and on all three this
    // module is a no-op. Identity rather than deep equality: the caller's
    // ledger tells a change from a no-op by whether it got a new object back,
    // and a step that rewrote the copy every run would checkpoint a new draft
    // on every attempt.
    const cases: ReadonlyArray<readonly [number, InstagramCopyOutput]> = [
      [3, carousel("cover", "photo", "text_only", "photo", "stat_callout", "headline_focus", "text_only", "closer")],
      [4, carousel("cover", "photo", "photo", "photo", "stat_callout", "headline_focus", "text_only", "closer")],
      [5, carousel("cover", "photo", "photo", "photo", "photo", "headline_focus", "text_only", "closer")],
    ];
    for (const [n, cs] of cases) {
      expect(pictures(cs), `fixture for ${n}`).toBe(n);
      const out = enforceImageryBand(cs);
      expect(out.copy, `${n} pictures is inside the band and must not be rewritten`).toBe(cs);
      expect(out.promotions, `${n}`).toEqual([]);
      expect(out.demotions, `${n}`).toEqual([]);
      expect(out.after, `${n}`).toBe(n);
    }
  });

  it("NEVER demotes the cover, because slide 1 is the hook and the cover rule requires a picture or a device on it", () => {
    // Driven past what demotion can reach by asking for a ceiling of zero: the
    // two `photo` slides go and the `cover` stays, whatever the ceiling says.
    // `default:cover-carries-device` fails a slide 1 with neither a photograph
    // nor a figure device, so demoting it would return to 05 on every attempt
    // for a picture no redraft can produce.
    const out = enforceImageryBand(carousel("cover", "photo", "photo"), 0, 0);
    expect(out.demotions.map((d) => d.slide)).toEqual([2, 3]);
    expect(layoutsOf(out.copy)[0]).toBe("cover");
    expect(out.after).toBe(1);
    expect(out.excessReason).toMatch(/still 1 picture slides against a ceiling of 0/u);
    expect(out.excessReason).toMatch(/the hook/u);
  });

  it("never demotes a designed panel, whose bounded band is not what this bound counts", () => {
    // All four panel archetypes are in `HERO_IMAGE_LAYOUTS` and none is in
    // `FULL_BLEED_IMAGE_LAYOUTS`, so a carousel of them is neither over the
    // ceiling nor touched by it. That is the distinction the two sets exist
    // for: a 300px band beside a figure is an accent on a typographic plate,
    // and counting it as a photograph is what let a carousel of three banded
    // panels meet a floor a reader would say it missed.
    const panels = carousel("stat_callout", "quote_card", "comparison_card", "list_takeaway", "headline_focus", "closer", "custom", "custom");
    expect(panels.slides.filter((sl) => HERO_IMAGE_LAYOUTS.has(sl.layout!)).length, "all four panels can source a band").toBe(4);
    expect(pictures(panels), "and not one of them is a picture plate").toBe(0);
    const out = enforceImageryBand(panels, 0);
    expect(out.demotions).toEqual([]);
    expect(out.promotions).toEqual([]);
  });

  it("the ceiling KEEPS A REST, so a six-slide post is not five photographs and one survivor", () => {
    // The table in `ceilingFor`, asserted rather than described. The first
    // draft of the constant was an absolute 5 and argued that a ratio would
    // change nothing a reader could see; `goodCopyOutput()` is six slides and
    // every one of them is a `photo`, which proved otherwise. That is why this
    // case exists, and it is why the suite is the thing that found it.
    expect(ceilingFor(8)).toBe(5);
    expect(ceilingFor(7)).toBe(5);
    expect(ceilingFor(6)).toBe(4);
    expect(ceilingFor(5)).toBe(3);
    // THE FLOOR TAKES TIES. Below five slides `slides - MIN_QUIET_SLIDES` drops
    // under the floor, and a ceiling under the floor is a gate that argues with
    // itself: promote to 3, demote to 2, and whichever ran last wins. The outer
    // `max` in `ceilingFor` is what makes a short post simply never over it.
    expect(ceilingFor(4)).toBe(MIN_PICTURE_SLIDES);
    expect(ceilingFor(3)).toBe(MIN_PICTURE_SLIDES);
    expect(ceilingFor(1)).toBe(MIN_PICTURE_SLIDES);
    expect(MIN_QUIET_SLIDES).toBe(2);

    // And it BITES: six photo slides on a six-slide carousel come back with
    // four pictures and two quiet plates, not five and one.
    const six = enforceImageryBand(carousel("cover", "photo", "photo", "photo", "photo", "photo"));
    expect(six.before).toBe(6);
    expect(six.after).toBe(4);
    expect(six.demotions.map((d) => d.slide)).toEqual([5, 6]);
  });

  it("the band is 3 to 5, and the two ends cannot fight", () => {
    expect(MIN_PICTURE_SLIDES).toBe(3);
    expect(MAX_PICTURE_SLIDES).toBe(5);
    expect(MIN_PICTURE_SLIDES, "a floor at or above the ceiling would make one of them unreachable").toBeLessThan(MAX_PICTURE_SLIDES);

    // A single pass, so the result is idempotent by construction at BOTH ends:
    // promotion stops AT the floor and the floor is under the ceiling, so a
    // promotion can never overshoot into a demotion on the next run.
    const bare = carousel("text_only", "text_only", "text_only", "text_only", "text_only", "text_only", "text_only", "text_only");
    const once = enforceImageryBand(bare);
    const twice = enforceImageryBand(once.copy);
    expect(once.after).toBe(MIN_PICTURE_SLIDES);
    expect(twice.promotions).toEqual([]);
    expect(twice.demotions).toEqual([]);
    expect(twice.copy).toBe(once.copy);

    const saturated = carousel("photo", "photo", "photo", "photo", "photo", "photo", "photo", "photo");
    const cut = enforceImageryBand(saturated);
    const cutTwice = enforceImageryBand(cut.copy);
    expect(cut.after).toBe(MAX_PICTURE_SLIDES);
    expect(cutTwice.demotions).toEqual([]);
    expect(cutTwice.promotions).toEqual([]);
  });
});

// 2026-09-23: a photo-led client. The owner's Deel reference carousels carry a
// real photograph on four slides of five; the standard band demotes one.
describe("picture density: photo-first", () => {
  it("keeps four photographs in a five-slide carousel where the standard band keeps three", () => {
    const copy = carousel("cover", "photo", "photo", "photo", "closer");
    expect(pictures(copy)).toBe(4);
    const standard = PICTURE_BANDS.standard;
    const photoFirst = PICTURE_BANDS["photo-first"];
    expect(pictures(enforceImageryBand(copy, standard.floor, standard.ceiling, undefined, standard.quiet).copy)).toBe(3);
    expect(pictures(enforceImageryBand(copy, photoFirst.floor, photoFirst.ceiling, undefined, photoFirst.quiet).copy)).toBe(4);
  });

  it("still keeps one quiet plate, never lowers the floor, and leaves the standard band exactly as it was", () => {
    expect(ceilingFor(8, PICTURE_BANDS["photo-first"].ceiling, PICTURE_BANDS["photo-first"].floor, PICTURE_BANDS["photo-first"].quiet)).toBe(7);
    expect(PICTURE_BANDS["photo-first"].floor).toBe(MIN_PICTURE_SLIDES);
    expect(PICTURE_BANDS.standard).toEqual({ floor: MIN_PICTURE_SLIDES, ceiling: MAX_PICTURE_SLIDES, quiet: MIN_QUIET_SLIDES });
    expect(isPictureDensity("photo-first")).toBe(true);
    expect(isPictureDensity("photo first")).toBe(false);
  });
});
