import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MARK_CANDIDATE_TAG, planEntitySourcing, type RecognisedEntity } from "../src/workflow/entity-imagery.js";
import { assembleSlidesData, MARK_PLACEMENTS, markPlacementFor } from "../src/workflow/slides-data.js";
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
  const run = (marks?: Set<string>, badges?: Map<number, string>) =>
    assembleSlidesData({
      clientSlug: "k",
      postId: "p",
      repoRoot: "/r",
      brandTokens: { templateDir: "t", slideTemplate: "slide.html" },
      copy,
      selections: [sel(1, "media/anthropic-logo.webp"), sel(2, "media/speaker.jpg")],
      canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
      paletteSeed: "pubsub-21773753139346000",
      ...(marks !== undefined ? { markImagePaths: marks } : {}),
      ...(badges !== undefined ? { markBadges: badges } : {}),
    });

  // 2026-09-23, the owner on the first version's white panel: a logo does
  // not have to fill the slide or stand alone; it can be small, to the side.
  it("turns a mark the vet chose as the picture into a badge, and the slide goes typographic around it", () => {
    const data = run(new Set(["media/anthropic-logo.webp"]));
    const byN = new Map(data.slides.map((s) => [s.n, s]));
    expect(byN.get(1)!.images.hero).toBeUndefined();
    expect(byN.get(1)!.images.mark).toBe("media/anthropic-logo.webp");
    expect(MARK_PLACEMENTS).toContain(byN.get(1)!.fields.markAt);
    expect(byN.get(2)!.images.hero).toBe("media/speaker.jpg");
    expect(byN.get(2)!.images.mark).toBeUndefined();
    expect(byN.get(2)!.fields.markAt).toBeUndefined();
  });

  it("puts the entity's mark beside a real photograph, never on a slide with no picture", () => {
    const data = run(new Set(), new Map([[2, "media/anthropic-cc0.svg"], [1, "media/unused.svg"]]));
    const byN = new Map(data.slides.map((s) => [s.n, s]));
    expect(byN.get(2)!.images).toEqual({ hero: "media/speaker.jpg", mark: "media/anthropic-cc0.svg" });
    // Slide 1's hero is not a mark here, so it is a photo and gets its badge too.
    expect(byN.get(1)!.images.mark).toBe("media/unused.svg");
  });

  it("emits nothing when the run supplied no marks (byte-identical to before)", () => {
    for (const s of run().slides) {
      expect(s.images.mark).toBeUndefined();
      expect(s.fields.markAt).toBeUndefined();
    }
  });
});

describe("where the badge sits varies", () => {
  it("uses all four placements across slides and runs, and is stable for one slide of one run", () => {
    const seen = new Set<string>();
    for (let r = 0; r < 12; r++) for (let n = 1; n <= 8; n++) seen.add(markPlacementFor(`pubsub-2177${r}3753139346000`, n));
    expect(seen).toEqual(new Set(MARK_PLACEMENTS));
    expect(markPlacementFor("pubsub-1", 3)).toBe(markPlacementFor("pubsub-1", 3));
  });
});

describe("every picture plate carries the badge slot, in flow", () => {
  it("each of the six plates has exactly one badge as a child of its plate, and the stylesheet never positions it absolutely", () => {
    for (const file of ["cover.html", "slide.html", "stat-callout.html", "quote-card.html", "comparison-card.html", "list-takeaway.html"]) {
      const html = readFileSync(path.join(TEMPLATES, file), "utf8");
      expect(html.match(/<div class="mark-badge" data-at="\{\{markAt\}\}"><img src="\{\{image:mark\}\}"/gu)?.length, file).toBe(1);
      expect(html).toMatch(/<div class="plate [a-z]+">\s*<div class="mark-badge"/u);
    }
    const css = readFileSync(path.join(TEMPLATES, "_design-system.css"), "utf8");
    const rules = css.match(/\.mark-badge[^{]*\{[^}]*\}/gu) ?? [];
    expect(rules.length).toBeGreaterThan(3);
    for (const rule of rules) expect(rule).not.toMatch(/position:\s*absolute/u);
    // The first version's 700px panel is gone.
    expect(css).not.toContain('img.hero[data-kind="mark"]');
  });
});
