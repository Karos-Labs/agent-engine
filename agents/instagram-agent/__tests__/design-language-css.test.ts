import { describe, expect, it } from "vitest";
import { designLanguageCssBlock, DESIGN_LANGUAGE_MAX_RADIUS, type StoredDesignLanguage } from "../src/workflow/design-language.js";

const measured = (tokens: NonNullable<StoredDesignLanguage["tokens"]>): StoredDesignLanguage => ({ version: 1, measuredAt: "2026-09-25T00:00:00Z", status: "measured", tokens });

/**
 * WS-07 (#253): the language `00f1` measures off the client's site is painted,
 * where #302 only stored it. Values are the prep measurements of 2026-09-25.
 */
describe("designLanguageCssBlock", () => {
  it("no measurement, or a failed one, paints nothing: today's render is untouched", () => {
    expect(designLanguageCssBlock(undefined)).toBe("");
    expect(designLanguageCssBlock({ version: 1, measuredAt: "x", status: "failed", problem: "bot wall" })).toBe("");
  });

  it("Sitti (16px hairline+fill cards, square buttons): panels and bounded pictures take 16px, the CTA follows the boxes, the hairline stays", () => {
    const css = designLanguageCssBlock(measured({ boxRadius: 16, pillButtons: false, boxStyle: "hairline-fill", shadowShare: 0.55, gradientShare: 0 }));
    expect(css).toContain(".num-zone");
    expect(css).toContain('img.hero[data-kind="framed"]');
    expect(css).toMatch(/border-radius: 16px; \}/u);
    expect(css).toContain('html body[data-cta="pill"] .cl-cta { border-radius: 16px; }');
    expect(css).not.toContain("box-shadow: none");
  });

  it("Geektime (6px filled cards): no hairline round the panels", () => {
    const css = designLanguageCssBlock(measured({ boxRadius: 6, pillButtons: false, boxStyle: "fill", shadowShare: 0.77, gradientShare: 0 }));
    expect(css).toMatch(/border-radius: 6px; \}/u);
    expect(css).toContain("box-shadow: none");
  });

  it("XO Digital (pill buttons): the CTA keeps its pill; a huge site radius is capped", () => {
    const css = designLanguageCssBlock(measured({ boxRadius: 40, pillButtons: true, boxStyle: "hairline", shadowShare: 1, gradientShare: 0 }));
    expect(css).not.toContain(".cl-cta");
    expect(css).toContain(`border-radius: ${DESIGN_LANGUAGE_MAX_RADIUS}px;`);
  });

  it("never rounds the placements that are square or round on purpose, nor a logo or cutout", () => {
    const css = designLanguageCssBlock(measured({ boxRadius: 16, pillButtons: false, boxStyle: "hairline", shadowShare: 0, gradientShare: 0 }));
    for (const kept of ['[data-figure="circle"]', '[data-figure="side"]', '[data-figure="carry-in"]', '[data-kind="cutout"]', '[data-kind="mark"]']) expect(css).toContain(`:not(${kept})`);
  });
});
