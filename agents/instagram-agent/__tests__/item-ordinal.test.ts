import { describe, expect, it } from "vitest";
import { assembleSlidesData } from "../src/workflow/slides-data.js";
import type { ImageSelection, InstagramCopyOutput } from "../src/workflow/types.js";

// 2026-09-23 (stage 6 of the reference-looks plan): the list people save
// numbers its item slides, and the cover is not item one.
const CANVAS = { w: 1080, h: 1440, scale: 2, slides_min: 4, slides_max: 8 };
const copy: InstagramCopyOutput = {
  format: "carousel",
  caption: "Five moves.",
  slides: [
    { n: 1, headline: "Five moves that get you quoted", body: "b", visualNeed: "v", sourceRef: "c", layout: "cover" },
    { n: 2, headline: "Answer first", body: "b", visualNeed: "v", sourceRef: "c", layout: "headline_focus" },
    { n: 3, headline: "Name the source", body: "b", visualNeed: "v", sourceRef: "c", layout: "headline_focus" },
    { n: 4, headline: "Date the claim", body: "b", visualNeed: "v", sourceRef: "c", layout: "headline_focus" },
    { n: 5, headline: "Save this", body: "Save this for Friday.", visualNeed: "v", sourceRef: "c", layout: "closer" },
  ],
};
const selections: ImageSelection[] = copy.slides.map((s) => ({ n: s.n, imagePath: null, reason: "typographic", license: "n/a", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "typographic" }));
const assemble = (numberedItems: boolean) =>
  assembleSlidesData({
    clientSlug: "acme",
    postId: "p1",
    repoRoot: "/repo",
    brandTokens: { templateDir: "fixtures/templates", slideTemplate: "slide.html" },
    copy,
    selections,
    canvas: CANVAS,
    seriesDirected: new Set([2, 3, 4]),
    numberedItems,
  });

describe("itemOrdinal", () => {
  it("numbers the item slides 01, 02, 03 and nothing else", () => {
    const fields = assemble(true).slides.map((s) => s.fields["itemOrdinal"]);
    expect(fields).toEqual([undefined, "01", "02", "03", undefined]);
  });

  it("is absent on every other series", () => {
    expect(assemble(false).slides.some((s) => s.fields["itemOrdinal"] !== undefined)).toBe(false);
  });
});
