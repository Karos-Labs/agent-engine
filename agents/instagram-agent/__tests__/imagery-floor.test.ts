import { describe, expect, it } from "vitest";
import { enforceImageryFloor, MIN_IMAGE_CAPABLE_SLIDES } from "../src/workflow/imagery-floor.js";
import { HERO_IMAGE_LAYOUTS } from "../src/workflow/slides-data.js";
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
const capable = (copy: InstagramCopyOutput): number => layoutsOf(copy).filter((l) => HERO_IMAGE_LAYOUTS.has(l)).length;

describe("enforceImageryFloor", () => {
  it("promotes text_only to photo until the floor is met — the thepitchbydeel carousel, which shipped zero pictures", () => {
    // The real one, read off `pubsub-21559620763659451`'s deliverable: one
    // stat callout, three heroless `slide.html`, a comparison, a quote, a
    // headline focus and a list. Not one archetype in `HERO_IMAGE_LAYOUTS`.
    const shipped = carousel("stat_callout", "text_only", "comparison_card", "text_only", "quote_card", "text_only", "headline_focus", "list_takeaway");
    expect(capable(shipped), "the fixture is not the imageless carousel this case is about").toBe(0);

    const out = enforceImageryFloor(shipped);
    expect(out.before).toBe(0);
    expect(out.after).toBe(MIN_IMAGE_CAPABLE_SLIDES);
    expect(out.shortfallReason).toBeUndefined();
    // Lowest slide number first: an early photograph is what earns the swipe.
    expect(out.promotions.map((p) => p.slide)).toEqual([2, 4, 6]);
    expect(layoutsOf(out.copy)).toEqual(["stat_callout", "photo", "comparison_card", "photo", "quote_card", "photo", "headline_focus", "list_takeaway"]);
  });

  it("LEAVES A CAROUSEL THAT ALREADY MET THE FLOOR COMPLETELY ALONE — it only ever adds", () => {
    // The karoslabs shape: the writer chose its own pictures and keeps every
    // one of them, and the three `text_only` slides stay text_only. A floor
    // that also REMOVED pictures would be a composition rule, and this is not
    // one.
    const composed = carousel("cover", "photo", "text_only", "photo", "stat_callout", "photo", "text_only", "closer");
    const out = enforceImageryFloor(composed);
    expect(out.promotions).toEqual([]);
    expect(out.copy).toBe(composed);
    expect(layoutsOf(out.copy)).toEqual(layoutsOf(composed));
  });

  it("stops the moment the floor is met, and never promotes one slide more than it needs", () => {
    const one = carousel("cover", "text_only", "text_only", "text_only", "text_only", "text_only", "text_only", "closer");
    const out = enforceImageryFloor(one);
    // One capable slide already (the cover), so exactly two promotions.
    expect(out.before).toBe(1);
    expect(out.promotions.map((p) => p.slide)).toEqual([2, 3]);
    expect(out.after).toBe(MIN_IMAGE_CAPABLE_SLIDES);
    expect(layoutsOf(out.copy).filter((l) => l === "text_only")).toHaveLength(4);
  });

  it("NEVER promotes a designed archetype, because its content would have nowhere to go", () => {
    // `text_only` and `photo` resolve to the SAME template and differ by
    // nothing but whether an image was found — which is the entire safety
    // argument for promoting one. A `stat_callout` carries a figure, a
    // `quote_card` an attribution, a `list_takeaway` its rows; converting one
    // into a photograph throws away the content that made it that shape.
    const structured = carousel("stat_callout", "quote_card", "comparison_card", "list_takeaway", "headline_focus", "closer", "cover", "custom");
    const out = enforceImageryFloor(structured);
    expect(out.promotions).toEqual([]);
    expect(layoutsOf(out.copy)).toEqual(layoutsOf(structured));
  });

  it("reports a SHORTFALL rather than forcing it, when there is nothing left to promote", () => {
    // Seven designed archetypes and one text_only: the floor cannot be met and
    // the honest answer is to say so, not to convert a quote card. The run
    // continues — this module never holds anything.
    const dense = carousel("stat_callout", "quote_card", "comparison_card", "list_takeaway", "headline_focus", "closer", "custom", "text_only");
    const out = enforceImageryFloor(dense);
    expect(out.promotions.map((p) => p.slide)).toEqual([8]);
    expect(out.after).toBe(1);
    expect(out.shortfallReason).toMatch(/only 1 of 3/u);
    expect(out.shortfallReason).toMatch(/throw away the content/u);
  });

  it("returns a NEW copy and mutates nothing, because the draft it is handed is checkpointed", () => {
    const before = carousel("stat_callout", "text_only", "text_only", "text_only", "quote_card", "closer", "cover", "list_takeaway");
    const snapshot = JSON.stringify(before);
    const out = enforceImageryFloor(before);
    expect(JSON.stringify(before), "a resumed run would see a different input from the one that was recorded").toBe(snapshot);
    expect(out.copy).not.toBe(before);
  });

  it("is idempotent: running it twice promotes nothing the second time", () => {
    const once = enforceImageryFloor(carousel("stat_callout", "text_only", "text_only", "text_only", "quote_card", "closer", "custom", "list_takeaway"));
    const twice = enforceImageryFloor(once.copy);
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
    expect(MIN_IMAGE_CAPABLE_SLIDES).toBe(3);
    const eight = carousel("cover", "text_only", "text_only", "text_only", "text_only", "text_only", "text_only", "closer");
    expect(enforceImageryFloor(eight).after, "the floor became a target — every carousel is now mostly photographs").toBe(3);
  });

  it("takes the floor as a parameter, so the sweep above is a real range and not one number twice", () => {
    const eight = carousel("text_only", "text_only", "text_only", "text_only", "text_only", "text_only", "text_only", "text_only");
    for (const floor of [0, 1, 2, 3, 5, 8]) {
      expect(enforceImageryFloor(eight, floor).promotions, `floor ${floor}`).toHaveLength(floor);
    }
    // And past what the carousel can supply it reports rather than throws.
    const over = enforceImageryFloor(eight, 99);
    expect(over.promotions).toHaveLength(8);
    expect(over.shortfallReason).toBeDefined();
  });
});
