import { describe, expect, it } from "vitest";

import { buildVariationPlan, planTextAlign, type SlideStyleOverride, type SlideTextAlign } from "../src/workflow/slides-data.js";

/**
 * RFC-17 §5.5 — THE COMPOSITION WALK.
 *
 * ── WHAT THIS IS FOR ─────────────────────────────────────────────────────
 *
 * The owner's complaint had two halves, and this is the second one:
 * *"בנוסף בגלל שזה חזרתי זה נראה AI"* — because it REPEATS, it reads as
 * machine-made. Phase 2 answered the first half (a mostly-grey plate is
 * refused by the pixel interest floor). The reference accounts answer this
 * half differently from how we had been answering it: their variety comes
 * from COMPOSITION over one constant material — the type block migrates and
 * the alignment changes — not from eight different painted grounds.
 *
 * Of the reference's four axes (vertical position, alignment, mark colour,
 * imagery) exactly one was free to take today: **alignment**. Every template
 * already carries `body.ta-center` and `body.ta-end`, and `textAlign` had
 * until now defaulted to `"start"` on every slide and only ever moved when a
 * reviewer moved it — so an eight-slide carousel shipped eight left-aligned
 * type blocks, which is precisely the repetition the owner named.
 *
 * Vertical migration is deliberately NOT built: it needs a `cw-*` trio in
 * every template and it moves the type block relative to a FIXED painted
 * field, re-opening the clause E band the interest floor's calibration
 * depends on. That is its own phase.
 *
 * ── SEVERABLE BY DESIGN ──────────────────────────────────────────────────
 *
 * This axis moves the bundled set's RENDERED PIXELS, so the Chromium
 * calibration suite is its real gate and CI is authoritative. Nothing in
 * this file needs Chromium: the walk is a pure seeded function, and these
 * are the tests that say what it must produce. If calibration rejects it,
 * the walk is dropped and the mark system ships alone — which is why it is
 * tested here, on its own, rather than through `assembleSlidesData`.
 */

/** Every phase the walk can start at, so nothing below is true only for one seed. */
const SEEDS = ["", "kit-a", "kit-b", "geektime", "acme-2026", "x", "seed-with-a-much-longer-name", "7"];

const runs = (list: readonly SlideTextAlign[]): number => {
  let worst = 1;
  let current = 1;
  for (let i = 1; i < list.length; i++) {
    current = list[i] === list[i - 1] ? current + 1 : 1;
    if (current > worst) worst = current;
  }
  return worst;
};

describe("planTextAlign — seeded, never random", () => {
  it("is deterministic: the same seed and the same length give the same walk, every time", () => {
    for (const seed of SEEDS) {
      const a = planTextAlign(8, seed);
      expect(planTextAlign(8, seed)).toEqual(a);
      expect(planTextAlign(8, seed)).toEqual(a);
    }
  });

  it("reads the seed: different runs start the walk at a different phase", () => {
    const walks = new Set(SEEDS.map((s) => planTextAlign(8, s).join(",")));
    // Not all 8 need differ (there are only 8 phases and some collide), but a
    // single walk for every client would mean the seed is being ignored —
    // which is the whole defect this axis exists to fix.
    expect(walks.size).toBeGreaterThan(1);
  });

  it("returns exactly one alignment per slide, for every carousel length", () => {
    for (let n = 0; n <= 8; n++) {
      const walk = planTextAlign(n, "kit-a");
      expect(walk).toHaveLength(n);
      for (const a of walk) expect(["start", "center", "end"]).toContain(a);
    }
  });

  /**
   * THE ANTI-REPETITION INVARIANT, checked exhaustively rather than on one
   * example: no three consecutive slides share an alignment, at EVERY phase
   * of the walk and at every carousel length this agent can produce.
   *
   * BREAK IT: change `TEXT_ALIGN_WALK` to
   * `["start","start","start","end","center","center","start","center"]`.
   * The first three positions then collide and this goes red at phase 0.
   */
  it("never puts three consecutive slides on the same alignment, at any phase or length", () => {
    for (const seed of SEEDS) {
      for (let n = 1; n <= 8; n++) {
        const walk = planTextAlign(n, seed);
        expect({ seed, n, walk, longestRun: runs(walk) }).toEqual({ seed, n, walk, longestRun: runs(walk) });
        expect(runs(walk)).toBeLessThanOrEqual(2);
      }
    }
  });

  /**
   * The COVER is pinned to `start` or `center`. A cover set to `end` reads as
   * a mistake rather than a choice: it is the one slide carrying a masthead,
   * a badge and usually a hero, all anchored to the start edge.
   *
   * `PIN_SEED` IS NOT DECORATIVE, AND THIS COMMENT EXISTS BECAUSE THE FIRST
   * VERSION OF THIS TEST COULD NOT FAIL. Only ONE of the walk's eight phases
   * starts on `end`, so a handful of human-looking seeds checks the pin
   * roughly never: removing the guard entirely left the original assertion
   * green. `kit-5` is a seed MEASURED to land on that phase, so it is the
   * only line here that actually exercises the pin — the rest is breadth.
   *
   * BREAK IT: remove the `i === 0 && picked === "end"` guard.
   */
  it("never sets the cover to `end` — including on the one phase that otherwise would", () => {
    /** Measured, not chosen: this seed's walk starts at the `end` position. */
    const PIN_SEED = "kit-5";
    // The premise first. Without it, the assertion below is vacuous: it would
    // pass on a seed whose phase never offered `end` in the first place.
    expect(planTextAlign(8, PIN_SEED).slice(1, 4)).toEqual(["center", "center", "start"]);
    expect(planTextAlign(8, PIN_SEED)[0]).toBe("start");
    // …and no phase, on any seed, ever puts `end` on the cover.
    for (const seed of [...SEEDS, PIN_SEED, ...Array.from({ length: 64 }, (_, i) => `kit-${i}`)]) {
      expect(planTextAlign(8, seed)[0]).not.toBe("end");
    }
  });

  /**
   * The point of the whole axis: an eight-slide carousel must not ship eight
   * identically aligned type blocks. Two alignments is the floor; the walk
   * in fact uses all three.
   *
   * BREAK IT: return `Array(n).fill("start")`, which is what shipped before
   * this phase. Every other test in this file still passes.
   */
  it("actually VARIES: an eight-slide post uses at least two alignments, and the walk uses all three", () => {
    for (const seed of SEEDS) expect(new Set(planTextAlign(8, seed)).size).toBeGreaterThanOrEqual(2);
    const everything = new Set(SEEDS.flatMap((s) => planTextAlign(8, s)));
    expect(everything).toEqual(new Set<SlideTextAlign>(["start", "center", "end"]));
  });

  it("degrades quietly on a missing or empty seed rather than throwing", () => {
    expect(planTextAlign(8, undefined)).toHaveLength(8);
    expect(planTextAlign(8, "")).toHaveLength(8);
    expect(planTextAlign(0, "kit-a")).toEqual([]);
    expect(planTextAlign(-3, "kit-a")).toEqual([]);
  });
});

describe("buildVariationPlan — the gate payload reports what the slide RENDERS with", () => {
  const slideNs = [1, 2, 3, 4, 5, 6, 7, 8];
  const base = { slideNs, paletteSeed: "kit-a", brandAccentFallback: "#FF6B2C" };
  const textAlignEntries = (plan: ReturnType<typeof buildVariationPlan>) => plan.filter((e) => e.axis === "textAlign");

  it("emits exactly one textAlign entry per slide, each carrying the alignment it renders with", () => {
    const entries = textAlignEntries(buildVariationPlan(base));
    expect(entries).toHaveLength(slideNs.length);
    expect(entries.map((e) => e.slide)).toEqual(slideNs);
    for (const e of entries) expect(["start", "center", "end"]).toContain(e.value);
  });

  it("reports the same alignments the walk itself produced — the two cannot drift", () => {
    expect(textAlignEntries(buildVariationPlan(base)).map((e) => e.value)).toEqual(planTextAlign(slideNs.length, "kit-a"));
  });

  /**
   * A REVIEWER OVERRIDE STILL WINS, UNCHANGED. This axis is a better DEFAULT,
   * never a new authority: a human who set a slide to `end` in the portal
   * gets `end`, and the plan says the axis stood aside rather than pretending
   * it chose.
   *
   * BREAK IT: drop the `pinned ?? ` in `buildVariationPlan`. The reported
   * value then disagrees with what `assembleSlidesData` actually renders,
   * which is the worst kind of failure here — the payload lies.
   */
  it("lets a reviewer's textAlign win, and says the axis stood aside", () => {
    const overrides = new Map<number, SlideStyleOverride>([[3, { textAlign: "end" }]]);
    const entries = textAlignEntries(buildVariationPlan({ ...base, slideStyleOverrides: overrides }));
    const pinned = entries.find((e) => e.slide === 3)!;
    expect(pinned.value).toBe("end");
    expect(pinned.used).toBe(false);
    expect(pinned.reason).toBe("reviewer-pinned");
    // …and only that slide is affected.
    for (const e of entries.filter((x) => x.slide !== 3)) {
      expect(e.used).toBe(true);
      expect(e.reason).toBeUndefined();
    }
  });

  it("marks the walk as USED on every slide a reviewer did not pin", () => {
    for (const e of textAlignEntries(buildVariationPlan(base))) expect(e.used).toBe(true);
  });

  it("a reviewer override on a DIFFERENT axis leaves textAlign to the walk", () => {
    const overrides = new Map<number, SlideStyleOverride>([[2, { fontScale: "l" }]]);
    const entries = textAlignEntries(buildVariationPlan({ ...base, slideStyleOverrides: overrides }));
    expect(entries.find((e) => e.slide === 2)!.used).toBe(true);
    expect(entries.map((e) => e.value)).toEqual(planTextAlign(slideNs.length, "kit-a"));
  });

  it("still reports the accent and groundFg axes — this phase adds an axis, it does not replace one", () => {
    const axes = new Set(buildVariationPlan(base).map((e) => e.axis));
    expect(axes).toEqual(new Set(["accent", "groundFg", "textAlign"]));
  });

  it("is deterministic for a whole plan, not just for the walk", () => {
    expect(buildVariationPlan(base)).toEqual(buildVariationPlan(base));
  });

  it("survives a six- and seven-slide carousel, which are both shapes this agent ships", () => {
    for (const n of [6, 7]) {
      const entries = textAlignEntries(buildVariationPlan({ ...base, slideNs: slideNs.slice(0, n) }));
      expect(entries).toHaveLength(n);
      expect(runs(entries.map((e) => e.value!))).toBeLessThanOrEqual(2);
    }
  });
});
