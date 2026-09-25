import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_CUTOUT_MAX_COVERAGE, PRODUCT_CUTOUT_MIN_COVERAGE } from "../src/workflow/create-instagram-agent-workflow.js";
import { describe, expect, it } from "vitest";
import { looksLikeMark, MARK_CANDIDATE_TAG, planEntitySourcing, type RecognisedEntity } from "../src/workflow/entity-imagery.js";
import { MARK_AUTO_CANDIDATES, rotatedCandidates } from "@agent-engine/tool-karos-publish";
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

  // 2026-09-24, the owner: "a small framed logo is strange; either a picture
  // related to the logo, or the logo appears some other way". No badges.
  it("shows a mark the vet chose as the picture AS the picture, a tile (heroKind mark), never a small badge", () => {
    const data = run(new Set(["media/anthropic-logo.webp"]));
    const byN = new Map(data.slides.map((s) => [s.n, s]));
    expect(byN.get(1)!.images.hero).toBe("media/anthropic-logo.webp");
    expect(byN.get(1)!.fields.heroKind).toBe("mark");
    expect(byN.get(1)!.images.mark).toBeUndefined();
    expect(byN.get(1)!.fields.markAt).toBeUndefined();
    expect(byN.get(2)!.images.hero).toBe("media/speaker.jpg");
    // NOT `undefined` since 2026-09-24: slide 2 is a `photo` plate carrying a
    // headline AND a body, which is the case `framedHeroFor` sets as a block
    // rather than a wall. What this test is about is the MARK — the point is
    // that slide 2 is not treated as one.
    // (Framed or poster depends on the deck's length, `FRAMED_DECK_MIN_WORDS`.)
    expect(byN.get(2)!.fields.heroKind).not.toBe("mark");
  });

  it("never stamps a mark onto a real photograph: the photograph carries the slide", () => {
    const data = run(new Set(), new Map([[2, "media/anthropic-cc0.svg"], [1, "media/unused.svg"]]));
    const byN = new Map(data.slides.map((s) => [s.n, s]));
    expect(byN.get(2)!.images).toEqual({ hero: "media/speaker.jpg" });
    expect(byN.get(1)!.images.mark).toBeUndefined();
  });

  it("emits nothing when the run supplied no marks (byte-identical to before)", () => {
    for (const s of run().slides) {
      expect(s.images.mark).toBeUndefined();
      expect(s.fields.markAt).toBeUndefined();
    }
  });
});

describe("where the badge sits varies", () => {
  it("offers eight placements, including the sides and corners, and rotates the tie-break by slide", () => {
    expect(MARK_AUTO_CANDIDATES).toEqual(expect.arrayContaining(["side-start", "side-end", "corner-top-start", "corner-top-end", "lead-start", "tail-end"]));
    const firsts = new Set<string>();
    for (let n = 1; n <= 40; n++) firsts.add(rotatedCandidates(`pubsub-21773753139346000:${n}`)[0]!);
    expect(firsts.size).toBeGreaterThanOrEqual(6);
    expect(rotatedCandidates("p:3")).toEqual(rotatedCandidates("p:3"));
    expect(new Set(rotatedCandidates("p:3"))).toEqual(new Set(MARK_AUTO_CANDIDATES));
  });
});

describe("every picture plate carries the badge slot, in flow", () => {
  it("each of the six plates has exactly one badge as a child of its plate, positioned absolutely only for the side and corner placements", () => {
    for (const file of ["cover.html", "slide.html", "stat-callout.html", "quote-card.html", "comparison-card.html", "list-takeaway.html"]) {
      const html = readFileSync(path.join(TEMPLATES, file), "utf8");
      expect(html.match(/<div class="mark-badge" data-at="\{\{markAt\}\}"><img src="\{\{image:mark\}\}"/gu)?.length, file).toBe(1);
      expect(html).toMatch(/<div class="plate [a-z]+">\s*<div class="mark-badge"/u);
    }
    const css = readFileSync(path.join(TEMPLATES, "_design-system.css"), "utf8");
    const rules = css.match(/\.mark-badge[^{]*\{[^}]*\}/gu) ?? [];
    expect(rules.length).toBeGreaterThan(3);
    for (const rule of rules) if (/position:\s*absolute/u.test(rule)) expect(rule).toMatch(/data-at\^="(corner|side)-"/u);
    // The first version's 700px panel is gone; a mark hero is a bounded tile
    // under the brand band (2026-09-24), never the top half of the plate.
    expect(css).not.toMatch(/img\.hero\[data-kind="mark"\][^{]*\{[^}]*block-size: 700px/u);
    expect(css).toMatch(/img\.hero:is\(\[data-kind="mark"\], \[data-kind="mark-clear"\]\) \{[^}]*max-block-size: 220px/u);
  });
});

describe("a badge must be a mark (2026-09-23)", () => {
  it("accepts a title that calls itself a logo, or a vector file, and refuses a photograph that only mentions the name", () => {
    expect(looksLikeMark({ path: "a.png", description: "slide 3 candidate — Anthropic logo (Wikimedia) [licence: public domain]" })).toBe(true);
    expect(looksLikeMark({ path: "a.svg", description: "slide 3 candidate — Sagum (Wikimedia) [licence: CC0]" })).toBe(true);
    expect(looksLikeMark({ path: "a.jpg", description: "slide 3 candidate — Sagum team at the office (Openverse) [licence: CC0]" })).toBe(false);
    expect(looksLikeMark({ path: "b.jpg", description: 'slide 1 candidate — geo-verified photo of "ChatGPT logo" from Google Places (contributed by M.) [licence: Google Places photo]' })).toBe(false);
    // The engine's own tag says "logo"; the check reads the provider's title, not the tag.
    expect(looksLikeMark({ path: "a.jpg", description: "slide 3 candidate — a desk [licence: CC0] [kind: brand mark — a logo or wordmark, not a photograph]" })).toBe(false);
  });
});

describe("a client product lifted off its backdrop is set as an object (2026-09-24)", () => {
  it("carries heroKind cutout, and the plates contain it with a shadow instead of cropping it", () => {
    const data = assembleSlidesData({
      clientSlug: "k", postId: "p", repoRoot: "/r",
      brandTokens: { templateDir: "t", slideTemplate: "slide.html" },
      copy: { format: "carousel", caption: "c", slides: [{ n: 1, headline: "A product", body: "b", visualNeed: "v", sourceRef: "c", layout: "photo" }] } as InstagramCopyOutput,
      selections: [{ n: 1, imagePath: "media/lifted.png", reason: "r", license: "x", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "r" }],
      canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
      productCutoutPaths: new Set(["media/lifted.png"]),
    });
    expect(data.slides[0]!.fields.heroKind).toBe("cutout");
    const css = readFileSync(path.join(TEMPLATES, "_design-system.css"), "utf8");
    expect(css).toMatch(/\.sc-figure-band\[data-kind="cutout"\] img \{[^}]*object-fit: contain/u);
    expect(css).toMatch(/img\.hero\[data-kind="cutout"\] \{[^}]*drop-shadow/u);
    expect(PRODUCT_CUTOUT_MIN_COVERAGE).toBeLessThan(PRODUCT_CUTOUT_MAX_COVERAGE);
  });
});

describe("the scrim is never hidden globally (2026-09-24 regression)", () => {
  it("hides the scrim only under a condition, never as a bare rule", () => {
    const css = readFileSync(path.join(TEMPLATES, "_design-system.css"), "utf8");
    // #230's CSS splice left a bare `.scrim { display: none; }`, which removed the
    // shade under the copy on every photographed slide of every client.
    for (const line of css.split(/\r?\n/u)) expect(line.trim()).not.toBe(".scrim { display: none; }");
    expect(css).not.toContain("460px + var(--sp-2)");
  });
});

describe("an interior photograph is a block, not the whole screen (2026-09-24)", () => {
  it("frames interior photo slides as an inset block and keeps the cover full-bleed", () => {
    const copy = {
      format: "carousel", caption: "c",
      slides: [
        { n: 1, headline: "Cover", body: "A deck long enough to be a real second block of copy here.", visualNeed: "v", sourceRef: "c", layout: "cover" },
        { n: 2, headline: "A photo slide", body: "b", visualNeed: "v", sourceRef: "c", layout: "photo" },
        { n: 3, headline: "Close", body: "Which one?", visualNeed: "v", sourceRef: "c", layout: "closer" },
      ],
    } as InstagramCopyOutput;
    const sel = (n: number, imagePath: string | null) => ({ n, imagePath, reason: "r", license: "CC0", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "r" });
    const data = assembleSlidesData({
      clientSlug: "k", postId: "p", repoRoot: "/r", brandTokens: { templateDir: "t", slideTemplate: "slide.html" }, copy,
      selections: [sel(1, "media/a.jpg"), sel(2, "media/b.jpg"), sel(3, null)],
      canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
      interiorPhotosAsBlocks: true,
    });
    expect(data.slides[1]!.fields.figurePlacement).toBe("inset");
    expect(data.slides[1]!.images.hero).toBe("media/b.jpg");
    expect(data.slides[0]!.fields.figurePlacement).not.toBe("inset");
    // Owner decision 5 (2026-09-25) over #244: the cover is a poster even with a deck (capped by
    // `withCoverBudget`, shaded by `anchorScrim`); the interior photo is the inset block.
    expect(data.slides[0]!.fields.heroKind).not.toBe("framed");
    expect(data.slides[1]!.fields.heroKind).not.toBe("framed");
    const css = readFileSync(path.join(TEMPLATES, "_design-system.css"), "utf8");
    expect(css).toContain('body[data-figure="inset"]:has(.plate.slide) .scrim { display: none; }');
  });
});
