import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MARK_CANDIDATE_TAG, planEntitySourcing, type RecognisedEntity } from "../src/workflow/entity-imagery.js";
import { assembleSlidesData } from "../src/workflow/slides-data.js";
import type { ImageSelection, InstagramCopyOutput } from "../src/workflow/types.js";

// 2026-09-23: prep `pubsub-21947180423151342` (karoslabs) laid the Anthropic
// wordmark full-bleed over a dark plate, cropped, and the slide read as empty.
// A mark is tagged at sourcing and shown whole on a white panel at render.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.resolve(HERE, "../assets/templates/default");
const entity = (name: string, kind: RecognisedEntity["kind"]): RecognisedEntity => ({ name, kind, isPublicFigure: kind === "person", cardIds: ["k1"], salience: 4 });

describe("the entity ladder names its mark rung", () => {
  it("flags exactly the logo search, for a company, and nothing for a person", () => {
    const company = planEntitySourcing({ entity: entity("Anthropic", "company"), citedUrls: [], hasMediaLibrary: false, sceneTerms: [], associatedPeople: [] });
    const marks = company.filter((s) => s.mark === true);
    expect(marks.map((s) => s.query)).toEqual(["Anthropic logo"]);
    // The premise: the ladder has other rungs, so "one flagged" is a choice.
    expect(company.length).toBeGreaterThan(1);
    const person = planEntitySourcing({ entity: entity("Dario Amodei", "person"), citedUrls: [], hasMediaLibrary: false, sceneTerms: [], associatedPeople: [] });
    expect(person.some((s) => s.mark === true)).toBe(false);
  });

  it("tags in words the vet prompt quotes verbatim", () => {
    const vet = readFileSync(path.resolve(HERE, "../prompts/instagram-image-vet/latest.md"), "utf8");
    expect(vet).toContain(MARK_CANDIDATE_TAG.slice(1, -1));
  });
});

describe("assembleSlidesData with markImagePaths", () => {
  const copy = {
    format: "carousel",
    caption: "c",
    slides: [
      { n: 1, headline: "Anthropic hit this problem", body: "b", visualNeed: "v", sourceRef: "c", layout: "photo" },
      { n: 2, headline: "A second photo slide", body: "b", visualNeed: "v", sourceRef: "c", layout: "photo" },
    ],
  } as InstagramCopyOutput;
  const sel = (n: number, imagePath: string): ImageSelection => ({ n, imagePath, reason: "r", license: "CC0", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "r" });
  const run = (marks?: Set<string>) =>
    assembleSlidesData({
      clientSlug: "k",
      postId: "p",
      repoRoot: "/r",
      brandTokens: { templateDir: "t", slideTemplate: "slide.html" },
      copy,
      selections: [sel(1, "media/anthropic-logo.webp"), sel(2, "media/speaker.jpg")],
      canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
      ...(marks !== undefined ? { markImagePaths: marks } : {}),
    });

  it("marks the slide whose hero IS a mark, and only that one", () => {
    const data = run(new Set(["media/anthropic-logo.webp"]));
    const byN = new Map(data.slides.map((s) => [s.n, s]));
    expect(byN.get(1)!.images.hero).toBe("media/anthropic-logo.webp");
    expect(byN.get(1)!.fields.heroKind).toBe("mark");
    expect(byN.get(2)!.images.hero).toBe("media/speaker.jpg");
    expect(byN.get(2)!.fields.heroKind).toBeUndefined();
  });

  it("emits nothing when the run supplied no marks (byte-identical to before)", () => {
    for (const s of run().slides) expect(s.fields.heroKind).toBeUndefined();
  });
});

describe("every picture slot says what it holds", () => {
  it("each plate that carries a hero tags its holder with data-kind, and the stylesheet selects on it", () => {
    let slots = 0;
    for (const file of ["cover.html", "slide.html", "stat-callout.html", "quote-card.html", "comparison-card.html", "list-takeaway.html"]) {
      const html = readFileSync(path.join(TEMPLATES, file), "utf8");
      const heroes = html.match(/<[^>]*\{\{image:hero\}\}[^>]*>/gu) ?? [];
      const holders = html.match(/data-kind="\{\{heroKind\}\}"/gu) ?? [];
      expect(holders.length, file).toBe(1);
      expect(heroes.length, file).toBeGreaterThan(0);
      slots += holders.length;
    }
    expect(slots).toBe(6);
    const css = readFileSync(path.join(TEMPLATES, "_design-system.css"), "utf8");
    expect(css).toMatch(/img\.hero\[data-kind="mark"\][^{]*\{[^}]*object-fit: contain/u);
  });
});
