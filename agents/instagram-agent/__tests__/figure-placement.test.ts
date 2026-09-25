import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BODY_WORD_BUDGET, CLOSER_FORMS, closerFormFor, figurePlacementFor, trimToSentenceBudget } from "../src/workflow/slides-data.js";
import type { InstagramSlideLayout } from "../src/workflow/types.js";

/**
 * # THE BOUNDED PICTURE HAD EXACTLY ONE SHAPE
 *
 * A full-bleed ground on `cover` and `photo`, and `.sc-figure-band` on the four
 * panels: 300px tall, the full width of the field, at the top, every time.
 * Every picture in the three prep carousels of 2026-09-18 was one of those two,
 * which is why they read as a template. The owner:
 *
 *   *"the positions and the sizes can change, it can appear at the side
 *    sometimes, it can be next to the text. Think about it as a CMO."*
 *
 * A source scan for the CSS half, following `figure-band-collapse.test.ts`'s
 * own reasoning: the rule is a fact about the stylesheet, a render costs a CI
 * round trip to say so, and `default-template-render.test.ts` still renders
 * these plates.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DS = readFileSync(path.join(HERE, "..", "assets", "templates", "default", "_design-system.css"), "utf8");
const PLATES = ["closer", "comparison-card", "cover", "headline-focus", "list-takeaway", "quote-card", "slide", "stat-callout"];

const PANEL: InstagramSlideLayout[] = ["stat_callout", "quote_card", "comparison_card", "list_takeaway"];

describe("figurePlacementFor", () => {
  it("varies across ONE carousel, which is the whole property", () => {
    const seen = new Set(Array.from({ length: 8 }, (_, i) => figurePlacementFor("stat_callout", i + 1, true)));
    expect(seen.size, `eight panels drew ${seen.size} distinct shapes`).toBeGreaterThan(3);
  });

  it("selects the shapes that look right; the split left the rotation on the owner's second look (2026-09-24)", () => {
    // The stylesheet declares them and they render correctly. The calibration
    // sweep refused every archetype that was offered a 56% column, because
    // `_ds-fit.js` sizes type against the FIELD and a side variant changes the
    // field's width without telling it. This keeps the two in sync: the day
    // the ladder learns, this test is what says the rotation may change.
    const drawn = new Set(
      (["stat_callout", "quote_card", "comparison_card", "list_takeaway"] as const).flatMap((layout) =>
        Array.from({ length: 12 }, (_, i) => figurePlacementFor(layout, i + 1, true)),
      ),
    );
    // 2026-09-25: the corner square left the rotation too (owner, Kindly Yours' quote).
    expect([...drawn].sort()).toEqual(["band", "bleed", "circle", "foot", "inset", "tall"]);
  });

  it("never gives two ADJACENT slides the same shape", () => {
    for (let n = 1; n < 12; n++) {
      expect(figurePlacementFor("list_takeaway", n, true), `slides ${n} and ${n + 1}`).not.toBe(
        figurePlacementFor("list_takeaway", n + 1, true),
      );
    }
  });

  it("is STABLE for a slide, because one attempt renders up to three times", () => {
    // `07c`, the typographic fallback at `08a`, and the free re-layout's
    // re-render at `08a1c`. A random choice would hand the re-render a
    // different plate than the one the interest floor measured.
    for (const layout of PANEL) {
      expect(figurePlacementFor(layout, 4, true)).toBe(figurePlacementFor(layout, 4, true));
    }
  });

  it("is PHASED per client and run, so slide 3 is not the same shape in every client's every post (2026-09-24)", () => {
    const seeds = ["geektime:run-1", "thepitchbydeel:run-1", "xodigital:run-1", "sitti:run-1", "hankypanky:run-1", "karoslabs:run-1", "karoslabs:run-2"];
    const atSlide3 = new Set(seeds.map((seed) => figurePlacementFor("stat_callout", 3, true, seed)));
    // Three, not four, since the centred block is WEIGHTED (three slots of nine): variety across clients, not uniformity.
    expect(atSlide3.size, `slide 3 across seven client/run seeds drew ${[...atSlide3].join(", ")}`).toBeGreaterThanOrEqual(3);
    // Still stable for one seed, and still never the same shape twice in a row.
    for (const seed of seeds) {
      expect(figurePlacementFor("quote_card", 4, true, seed)).toBe(figurePlacementFor("quote_card", 4, true, seed));
      for (let n = 1; n < 8; n++) expect(figurePlacementFor("list_takeaway", n, true, seed)).not.toBe(figurePlacementFor("list_takeaway", n + 1, true, seed));
    }
  });

  it("keeps the first and last slide on the four full-width shapes, which were calibrated against the cover and closer floors", () => {
    const drawn = new Set(
      ["a:1", "b:2", "c:3", "d:4", "e:5", "f:6", "g:7"].flatMap((seed) => Array.from({ length: 8 }, (_, i) => figurePlacementFor("list_takeaway", i + 1, true, seed, { edge: true }))),
    );
    expect([...drawn].sort()).toEqual(["band", "bleed", "foot", "tall"]);
  });

  it("leaves the plain band on a plate with no picture, and on the two where the picture IS the plate", () => {
    expect(figurePlacementFor("stat_callout", 2, false)).toBe("band");
    expect(figurePlacementFor("cover", 2, true)).toBe("band");
    expect(figurePlacementFor("photo", 3, true)).toBe("band");
  });
});

describe("the stylesheet carries every shape the code can ask for", () => {
  it("declares a rule for each placement, or the code names a shape nothing paints", () => {
    for (const placement of ["side", "side-end", "foot", "tall", "bleed", "corner", "circle", "inset"]) {
      expect(DS, placement).toContain(`body[data-figure="${placement}"]`);
    }
  });

  it("gives the side shapes an actual column, and the size shapes an actual size", () => {
    // The split: the picture bleeds down one half, the plate narrows to the other.
    expect(DS).toMatch(/body\[data-figure="side"\] \.sc-figure-band \{[^}]*inset-inline-start: 0/u);
    expect(DS).toMatch(/body\[data-figure="side"\] \.plate \{[^}]*padding-inline-start: calc\(var\(--split\)/u);
    expect(DS).toMatch(/body\[data-figure="side-end"\] \.plate \{[^}]*padding-inline-end: calc\(var\(--split\)/u);
    // `tall` and `bleed` are about weight, so they must actually change it.
    expect(DS).toMatch(/body\[data-figure="tall"\] \.sc-figure-band \{[^}]*block-size: 620px/u);
    // `foot` fills by construction: it sorts last and an auto margin pushes it
    // to the bottom, which is what `.plate` already does for everything else.
    expect(DS).toMatch(/body\[data-figure="foot"\] \.sc-figure-band \{[^}]*order: 2/u);
    expect(DS).toMatch(/body\[data-figure="foot"\] \.sc-figure-band \{[^}]*margin-block-start: auto/u);
    expect(DS).toMatch(/body\[data-figure="bleed"\] \.sc-figure-band \{[^}]*margin-inline: calc\(var\(--mx\) \* -1\)/u);
  });

  it("DROPS THE GRID when the band collapses, or a pictureless side plate keeps an empty 44% track", () => {
    // `display: none` on a grid item leaves its track declared and empty, so
    // the type would sit in the second column of a two-column plate with a
    // 44% hole beside it. This is the rule that stops it.
    expect(DS).toContain('body[data-figure]:not([data-figure="band"]) .plate:not(:has(.sc-figure-band img[src]:not([src=""])))');
  });

  it("a pictureless split gives the copy its whole field back", () => {
    expect(DS).toContain('body:is([data-figure="side"], [data-figure="side-end"]):not(:has(.sc-figure-band img[src]:not([src=""]))) .plate { padding-inline: var(--mx); }');
  });

  it("shows the centred block (copy above, picture, copy below) in any carousel with three pictured panels", () => {
    for (const seed of ["geektime:r1", "thepitchbydeel:r1", "xodigital:r1", "sitti:r1", "hankypanky:r1", "karoslabs:r1", "karoslabs:r2", "kindlyyours:r1"]) {
      const shapes = [2, 3, 4].map((n) => figurePlacementFor("stat_callout", n, true, seed));
      expect(shapes.includes("inset"), `${seed}: ${shapes.join(", ")}`).toBe(true);
    }
  });

  it("every plate reads the slot, or the attribute never arrives", () => {
    for (const plate of PLATES) {
      const html = readFileSync(path.join(HERE, "..", "assets", "templates", "default", `${plate}.html`), "utf8");
      expect(html, plate).toContain('data-figure="{{figurePlacement}}"');
    }
  });
});

describe("closerFormFor: three closers, seeded per client and run (2026-09-24)", () => {
  it("is stable for a seed, varies across clients, and stays the original panel with no seed", () => {
    expect(closerFormFor(undefined)).toBe("panel");
    expect(closerFormFor("geektime:r1")).toBe(closerFormFor("geektime:r1"));
    const seen = new Set(["geektime:r1", "thepitchbydeel:r1", "xodigital:r1", "sitti:r1", "hankypanky:r1", "karoslabs:r1", "karoslabs:r2", "kindlyyours:r1"].map((s) => closerFormFor(s)));
    expect([...seen].sort()).toEqual([...CLOSER_FORMS].sort());
  });

  it("the closer plate reads the attribute and styles both variants", () => {
    const html = readFileSync(path.join(HERE, "..", "assets", "templates", "default", "closer.html"), "utf8");
    expect(html).toContain('data-closer="{{closerForm}}"');
    expect(html).toContain('body[data-closer="block"] .cl-panel');
    expect(html).toContain('body[data-closer="split"] .cl-panel');
  });
});

describe("trimToSentenceBudget: one idea per slide (2026-09-24)", () => {
  it("keeps whole sentences within the budget, never cuts mid-sentence, and keeps a long first sentence whole", () => {
    const body = "They use AI as an assistant. The approval structure stays the same. Nothing is actually delegated. An approval queue that approvers stop reading is not oversight.";
    expect(trimToSentenceBudget(body, 18)).toBe("They use AI as an assistant. The approval structure stays the same. Nothing is actually delegated.");
    expect(trimToSentenceBudget("One very long opening sentence that runs well past any budget at all for sure. Second.", 5)).toBe("One very long opening sentence that runs well past any budget at all for sure.");
    expect(trimToSentenceBudget("Short.", 3)).toBe("Short.");
    expect(BODY_WORD_BUDGET.stat_callout).toBeLessThanOrEqual(20);
  });
});

describe("a quote card's quote is cut to whole sentences (2026-09-25)", () => {
  it("keeps a quotation verbatim, only shorter", async () => {
    const { QUOTE_WORD_BUDGET } = await import("../src/workflow/slides-data.js");
    const long = "Call me crazy, but I just don't see the day when a CMO simply and successfully manages 3,000 AI agents. Good marketing and good human relationships are more complex than that. They always were.";
    const cut = trimToSentenceBudget(long, QUOTE_WORD_BUDGET);
    expect(long.startsWith(cut)).toBe(true);
    expect(cut.split(/\s+/u).length).toBeLessThanOrEqual(QUOTE_WORD_BUDGET);
    expect(cut.endsWith(".")).toBe(true);
  });
});
