import { describe, expect, it } from "vitest";
import { assembleSlidesData, carryPairFor } from "../src/workflow/slides-data.js";
import type { ImageSelection, InstagramCopyOutput } from "../src/workflow/types.js";

// 2026-09-23 (stage 5 of the reference-looks plan): the Deel event recap runs
// one photograph across the edge between two adjacent slides.
describe("carryPairFor", () => {
  it("picks the FIRST adjacent pair of panel slides that both hold a picture, and only one", () => {
    expect(
      carryPairFor([
        { n: 1, layout: "cover", hasPicture: true },
        { n: 2, layout: "stat_callout", hasPicture: true },
        { n: 3, layout: "quote_card", hasPicture: true },
        { n: 4, layout: "comparison_card", hasPicture: true },
        { n: 5, layout: "closer", hasPicture: false },
      ]),
    ).toEqual({ out: 2, in: 3 });
  });

  it("never pairs a full-bleed slide, a slide with no picture, or two slides that are not adjacent", () => {
    expect(carryPairFor([{ n: 2, layout: "photo", hasPicture: true }, { n: 3, layout: "quote_card", hasPicture: true }])).toBeUndefined();
    expect(carryPairFor([{ n: 2, layout: "stat_callout", hasPicture: false }, { n: 3, layout: "quote_card", hasPicture: true }])).toBeUndefined();
    expect(carryPairFor([{ n: 2, layout: "stat_callout", hasPicture: true }, { n: 4, layout: "quote_card", hasPicture: true }])).toBeUndefined();
  });
});

describe("assembleSlidesData with carryStrip", () => {
  const copy: InstagramCopyOutput = {
    format: "carousel",
    caption: "The finale.",
    slides: [
      { n: 1, headline: "Every winner, one stage", body: "b", visualNeed: "v", sourceRef: "c", layout: "cover" },
      { n: 2, headline: "A check changes a company", body: "b", visualNeed: "v", sourceRef: "c", layout: "stat_callout", stat: { figure: "$50K", subLabel: "SAFE", source: "s" } },
      { n: 3, headline: "A full house", body: "b", visualNeed: "v", sourceRef: "c", layout: "quote_card", quote: { text: "Every founder held that stage.", attribution: "The Pitch" } },
      { n: 4, headline: "Join the waitlist", body: "Join the 2027 waitlist", visualNeed: "v", sourceRef: "c", layout: "closer" },
    ],
  } as InstagramCopyOutput;
  const selections: ImageSelection[] = copy.slides.map((s) => ({ n: s.n, imagePath: s.n <= 3 ? `photos/n${s.n}.jpg` : null, reason: "r", license: "client-owned asset", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "r" }));
  const assemble = (carryStrip: boolean) =>
    assembleSlidesData({ clientSlug: "deel", postId: "p", repoRoot: "/repo", brandTokens: { templateDir: "t", slideTemplate: "slide.html" }, copy, selections, canvas: { w: 1080, h: 1440, scale: 2, slides_min: 4, slides_max: 8 }, carryStrip });

  it("runs slide 2's photograph into slide 3, which carries it as `carry`", () => {
    const slides = assemble(true).slides;
    expect(slides[1]!.fields["figurePlacement"]).toBe("carry-out");
    expect(slides[2]!.fields["figurePlacement"]).toBe("carry-in");
    expect(slides[2]!.images).toEqual({ hero: "photos/n3.jpg", carry: "photos/n2.jpg" });
  });

  it("changes nothing without it", () => {
    const slides = assemble(false).slides;
    expect(slides.some((s) => String(s.fields["figurePlacement"]).startsWith("carry"))).toBe(false);
    expect(slides.some((s) => "carry" in s.images)).toBe(false);
  });
});
