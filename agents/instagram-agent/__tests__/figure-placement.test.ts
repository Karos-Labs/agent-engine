import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { figurePlacementFor } from "../src/workflow/slides-data.js";
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

  it("leaves the plain band on a plate with no picture, and on the two where the picture IS the plate", () => {
    expect(figurePlacementFor("stat_callout", 2, false)).toBe("band");
    expect(figurePlacementFor("cover", 2, true)).toBe("band");
    expect(figurePlacementFor("photo", 3, true)).toBe("band");
  });
});

describe("the stylesheet carries every shape the code can ask for", () => {
  it("declares a rule for each placement, or the code names a shape nothing paints", () => {
    for (const placement of ["side", "side-end", "inset", "tall", "bleed"]) {
      expect(DS, placement).toContain(`body[data-figure="${placement}"]`);
    }
  });

  it("gives the side shapes an actual column, and the size shapes an actual size", () => {
    expect(DS).toMatch(/body\[data-figure="side"\] \.plate \{[^}]*grid-template-columns: 44% 1fr/u);
    expect(DS).toMatch(/body\[data-figure="side-end"\] \.plate \{[^}]*grid-template-columns: 1fr 44%/u);
    // `tall` and `bleed` are about weight, so they must actually change it.
    expect(DS).toMatch(/body\[data-figure="tall"\] \.sc-figure-band \{[^}]*block-size: 620px/u);
    expect(DS).toMatch(/body\[data-figure="bleed"\] \.sc-figure-band \{[^}]*margin-inline: calc\(var\(--mx\) \* -1\)/u);
  });

  it("DROPS THE GRID when the band collapses, or a pictureless side plate keeps an empty 44% track", () => {
    // `display: none` on a grid item leaves its track declared and empty, so
    // the type would sit in the second column of a two-column plate with a
    // 44% hole beside it. This is the rule that stops it.
    expect(DS).toContain('body[data-figure]:not([data-figure="band"]) .plate:not(:has(.sc-figure-band img[src]:not([src=""])))');
  });

  it("every plate reads the slot, or the attribute never arrives", () => {
    for (const plate of PLATES) {
      const html = readFileSync(path.join(HERE, "..", "assets", "templates", "default", `${plate}.html`), "utf8");
      expect(html, plate).toContain('data-figure="{{figurePlacement}}"');
    }
  });
});
