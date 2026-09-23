import { describe, expect, it } from "vitest";
import { markEntityForLabel, type RecognisedEntity } from "../src/workflow/entity-imagery.js";
import { assembleSlidesData } from "../src/workflow/slides-data.js";
import type { ImageSelection, InstagramCopyOutput } from "../src/workflow/types.js";

// 2026-09-23: each comparison column under its own mark (the Karos Labs
// reference's Pepsi vs Coca-Cola).
const entity = (name: string, kind: RecognisedEntity["kind"] = "company"): RecognisedEntity => ({ name, kind, isPublicFigure: false, cardIds: ["k1"], salience: 4 });

describe("markEntityForLabel", () => {
  const entities = [entity("Pepsi"), entity("Coca-Cola"), entity("OpenAI"), entity("OpenAI Codex", "product"), entity("Sam Altman", "person")];

  it("finds the company a column names, whole words only, longest name first", () => {
    expect(markEntityForLabel("Pepsi", entities)?.name).toBe("Pepsi");
    expect(markEntityForLabel("Coca-Cola's bet", entities)?.name).toBe("Coca-Cola");
    expect(markEntityForLabel("OpenAI Codex agents", entities)?.name).toBe("OpenAI Codex");
  });

  it("finds nobody for a column that names no marked entity, a person, or a word inside another word", () => {
    expect(markEntityForLabel("In-house", entities)).toBeUndefined();
    expect(markEntityForLabel("Sam Altman", entities)).toBeUndefined();
    expect(markEntityForLabel("Pepsico-free", [entity("Pepsi")])).toBeUndefined();
  });
});

describe("assembleSlidesData with sideLogos", () => {
  const copy = {
    format: "carousel",
    caption: "c",
    slides: [
      { n: 1, headline: "Two companies", body: "b", visualNeed: "v", sourceRef: "c", layout: "comparison_card", comparison: { leftLabel: "Pepsi", leftBody: "a", rightLabel: "Coca-Cola", rightBody: "b" } },
    ],
  } as InstagramCopyOutput;
  const selections: ImageSelection[] = [{ n: 1, imagePath: null, reason: "r", license: "n/a", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "r" }];

  it("puts each verified mark on its column, and only on a comparison slide", () => {
    const data = assembleSlidesData({ clientSlug: "k", postId: "p", repoRoot: "/r", brandTokens: { templateDir: "t", slideTemplate: "slide.html" }, copy, selections, canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 }, sideLogos: new Map([[1, { left: "logos/pepsi.png", right: "logos/coke.png" }]]) });
    expect(data.slides[0]!.images).toEqual({ logoLeft: "logos/pepsi.png", logoRight: "logos/coke.png" });
  });
});
