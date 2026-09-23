import { describe, expect, it } from "vitest";
import { assembleSlidesData } from "../src/workflow/slides-data.js";
import type { ImageSelection, InstagramCopyOutput } from "../src/workflow/types.js";

// karoslabs pubsub-21701979152019948 (2026-09-23) shipped two closers: the
// writer put one on slide 7, which the singleton rule allowed because no
// closer had been used yet, and slide 8 was the series' closer, which the
// series exemption allowed. A closer only closes; a cover only opens.
const slide = (n: number, layout: InstagramCopyOutput["slides"][number]["layout"]) => ({ n, headline: `h${n}`, body: `b${n}`, visualNeed: "v", sourceRef: "c", layout });

function layoutsOf(slides: InstagramCopyOutput["slides"], seriesDirected?: ReadonlySet<number>) {
  const copy = { format: "carousel", caption: "c", slides } as InstagramCopyOutput;
  const selections: ImageSelection[] = slides.map((s) => ({ n: s.n, imagePath: null, reason: "r", license: "n/a", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "r" }));
  return assembleSlidesData({ clientSlug: "k", postId: "p", repoRoot: "/r", brandTokens: { templateDir: "t", slideTemplate: "slide.html" }, copy, selections, canvas: { w: 1080, h: 1440, scale: 2, slides_min: 4, slides_max: 8 }, ...(seriesDirected ? { seriesDirected } : {}) }).slides.map((s) => s.template);
}

describe("positional archetypes keep their positions", () => {
  it("renders exactly one closer, on the last slide, even when the series directs the last one", () => {
    const templates = layoutsOf([slide(1, "cover"), slide(2, "headline_focus"), slide(3, "photo"), slide(4, "closer"), slide(5, "closer")], new Set([1, 5]));
    expect(templates.filter((t) => t === "closer.html")).toHaveLength(1);
    expect(templates[4]).toBe("closer.html");
    expect(templates[3]).not.toBe("closer.html");
  });

  it("renders a cover only on slide 1", () => {
    const templates = layoutsOf([slide(1, "cover"), slide(2, "cover"), slide(3, "headline_focus"), slide(4, "closer")]);
    expect(templates.filter((t) => t === "cover.html")).toHaveLength(1);
    expect(templates[0]).toBe("cover.html");
  });
});
