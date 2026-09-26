import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { coverWeightsFor, DEFAULT_COVER_WEIGHTS, pickCoverComposition, COVER_COMPOSITIONS } from "../src/workflow/cover-composition.js";
import { coverCompositionForHeadline, POSTER_MAX_HEADLINE_WORDS } from "../src/workflow/slides-data.js";
import type { ExemplarLibrary } from "../src/workflow/exemplar-library.js";
import { assembleSlidesData } from "../src/workflow/slides-data.js";
import type { ImageSelection, InstagramCopyOutput } from "../src/workflow/types.js";

const entry = (coverType: string, craft = 5, lift = 3, role: "reference" | "client" = "reference") => ({
  handle: "ref", role, format: "carousel", frameCount: 6, lift, craft, dna: { coverType }, standout: "s", hook: "h", storedFrames: [],
});
const library = (entries: ReturnType<typeof entry>[]): ExemplarLibrary => ({ version: 1, builtAt: "2026-09-25T00:00:00Z", status: "built", problems: [], accounts: [], entries });

/**
 * The owner (2026-09-26): a poster cover every time turns generic; sometimes the
 * first slide should be a picture in the middle with the words around it, or
 * another cover shape, according to what the harvests show.
 */
describe("cover composition", () => {
  it("with no harvest, the owner's default: mostly posters", () => {
    expect(coverWeightsFor(undefined).weights).toEqual(DEFAULT_COVER_WEIGHTS);
    expect(DEFAULT_COVER_WEIGHTS.poster).toBeGreaterThan(0.5);
  });

  it("a category whose best posts open framed or collaged moves the mix, but never erases the default", () => {
    const { weights, basis } = coverWeightsFor(library([entry("photo-framed"), entry("collage"), entry("screenshot"), entry("photo-framed")]));
    expect(weights.sandwich + weights.framed).toBeGreaterThan(DEFAULT_COVER_WEIGHTS.sandwich + DEFAULT_COVER_WEIGHTS.framed);
    expect(weights.poster).toBeCloseTo(0.5 * DEFAULT_COVER_WEIGHTS.poster, 6);
    expect(basis).toMatch(/4 exemplar covers/u);
  });

  it("the reference looks judge 1.2.0 names vote for the nearest composition the renderer has", () => {
    const objects = coverWeightsFor(library([entry("object-on-ground"), entry("ui-collage"), entry("abstract-3d")])).weights;
    expect(objects.sandwich).toBeGreaterThan(DEFAULT_COVER_WEIGHTS.sandwich);
    const drawn = coverWeightsFor(library([entry("doodle"), entry("annotated-photo"), entry("doodle")])).weights;
    expect(drawn.poster).toBeGreaterThanOrEqual(DEFAULT_COVER_WEIGHTS.poster);
  });

  it("ignores the client's own WEAK posts (craft under 4, S1) and thin libraries", () => {
    expect(coverWeightsFor(library([entry("collage", 3, 3, "client"), entry("collage", 3, 3, "client"), entry("collage", 3, 3, "client")])).weights).toEqual(DEFAULT_COVER_WEIGHTS);
    expect(coverWeightsFor(library([entry("collage"), entry("collage")])).weights).toEqual(DEFAULT_COVER_WEIGHTS);
  });

  it("is seeded (a resume re-renders the same cover) and, across runs, opens more than one way", () => {
    expect(pickCoverComposition(DEFAULT_COVER_WEIGHTS, "karoslabs:run-1")).toBe(pickCoverComposition(DEFAULT_COVER_WEIGHTS, "karoslabs:run-1"));
    const seen = new Set(Array.from({ length: 40 }, (_, i) => pickCoverComposition(DEFAULT_COVER_WEIGHTS, `karoslabs:run-${i}`)));
    // Every composition the default weights allow appears; `typographic` (weight 0) only ever comes from a harvest.
    for (const c of COVER_COMPOSITIONS) expect(seen.has(c), c).toBe(DEFAULT_COVER_WEIGHTS[c] > 0);
  });

  it("assembleSlidesData sets a photographic cover as the run's composition, and leaves the poster when told poster", () => {
    const copy = {
      format: "carousel",
      caption: "c",
      slides: [
        { n: 1, headline: "A cover headline", body: "A deck line.", visualNeed: "v", sourceRef: "c", layout: "cover" },
        { n: 2, headline: "Close", body: "Is this for you?", visualNeed: "v", sourceRef: "c", layout: "closer" },
      ],
    } as InstagramCopyOutput;
    const sel = (n: number, imagePath: string | null): ImageSelection => ({ n, imagePath, reason: "r", license: "CC0", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "r" });
    const run = (coverComposition: "poster" | "sandwich" | "framed") =>
      assembleSlidesData({
        clientSlug: "k", postId: "p", repoRoot: "/r", brandTokens: { templateDir: "t", slideTemplate: "slide.html" }, copy,
        selections: [sel(1, "media/cover.jpg"), sel(2, null)], canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 }, paletteSeed: "cc", coverComposition,
      }).slides[0]!.fields.heroKind;
    expect(run("sandwich")).toBe("sandwich");
    expect(run("framed")).toBe("framed");
    expect(run("poster")).toBeUndefined();

    // A sandwich cover whose picture lifted clean is the object-on-ground cover (owner references, 2026-09-26).
    const lifted = assembleSlidesData({
      clientSlug: "k", postId: "p", repoRoot: "/r", brandTokens: { templateDir: "t", slideTemplate: "slide.html" }, copy,
      selections: [sel(1, "media/cover-cut.png"), sel(2, null)], canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 }, paletteSeed: "cc",
      coverComposition: "sandwich", productCutoutPaths: new Set(["media/cover-cut.png"]),
    }).slides[0]!.fields.heroKind;
    expect(lifted).toBe("cutout");
    // 06h26 offers the cover to the lift only on a sandwich run, and never a client upload.
    const src = readFileSync(new URL("../src/workflow/create-instagram-agent-workflow.ts", import.meta.url), "utf8");
    expect(src).toMatch(/coverChoice\.composition === "sandwich"\s*\?\s*selections\.find\(\(sel\) => sel\.n === 1[^\n]*!tier0Slots\.has\(1\)\)/u);
  });
});

describe("a poster carries a short headline; a long one takes the sandwich (2026-09-26)", () => {
  it("keeps the poster for the short lines that read over a photograph, and moves the long ones", () => {
    expect(coverCompositionForHeadline("poster", "The 3,000-agent CMO fallacy")).toBe("poster");
    expect(coverCompositionForHeadline(undefined, "You're briefing your underwear wrong.")).toBe("poster");
    // Prep batch 8's unreadable covers: 10, 9 and 8 words.
    expect(coverCompositionForHeadline("poster", "Geography is not the disqualifier. nybl won Paris from the UAE.")).toBe("sandwich");
    expect(coverCompositionForHeadline("poster", "96% of creator search value goes to the top 10%")).toBe("sandwich");
    expect(coverCompositionForHeadline("poster", "O piloto é institucional. A distribuição já é sua.")).toBe("sandwich");
    expect(POSTER_MAX_HEADLINE_WORDS).toBe(7);
  });

  it("never overrides a composition the run chose on purpose", () => {
    expect(coverCompositionForHeadline("framed", "Geography is not the disqualifier. nybl won Paris from the UAE.")).toBe("framed");
    expect(coverCompositionForHeadline("sandwich", "Short line")).toBe("sandwich");
    // An unhonoured typographic cover (it kept its photograph) is a poster, so a long headline still takes the sandwich.
    expect(coverCompositionForHeadline("typographic", "Geography is not the disqualifier. nybl won Paris from the UAE.")).toBe("sandwich");
    expect(coverCompositionForHeadline("typographic", "The 3,000-agent CMO fallacy")).toBe("poster");
  });
});

describe("the typographic cover: the owner's type references (2026-09-26)", () => {
  const sel = (n: number, imagePath: string | null): ImageSelection => ({ n, imagePath, reason: "r", license: "CC0", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "r" });
  const cover = (device: boolean) => ({ n: 1, headline: "O piloto é institucional.", body: "Em 2025, 45,8% do volume.", visualNeed: "v", sourceRef: "c", layout: "cover", ...(device ? { device: { kind: "figure", value: "45,8%", label: "das emissões de renda fixa digital em 2025", source: "Cointelegraph" } } : {}) });
  const run = (device: boolean, others: number) =>
    assembleSlidesData({
      clientSlug: "k", postId: "p", repoRoot: "/r", brandTokens: { templateDir: "t", slideTemplate: "slide.html" },
      copy: { format: "carousel", caption: "c", slides: [cover(device), ...[2, 3, 4, 5].map((n) => ({ n, headline: `Slide ${n} headline`, body: "b", visualNeed: "v", sourceRef: "c", layout: "photo" })), { n: 6, headline: "Close", body: "Is this for you?", visualNeed: "v", sourceRef: "c", layout: "closer" }] } as unknown as InstagramCopyOutput,
      selections: [sel(1, "media/cover.jpg"), ...[2, 3, 4, 5].map((n) => sel(n, n - 1 <= others ? `media/${n}.jpg` : null)), sel(6, null)],
      canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 }, paletteSeed: "cc", coverComposition: "typographic",
    }).slides[0]!;
  it("sets no photograph when the cover carries its own figure and the post keeps three pictures elsewhere", () => {
    expect(run(true, 3).images?.["hero"]).toBeUndefined();
  });
  it("keeps the photograph without a figure (type on bare ground is what the floor refuses) or without enough pictures elsewhere", () => {
    expect(run(false, 4).images?.["hero"]).toBe("media/cover.jpg");
    expect(run(true, 2).images?.["hero"]).toBe("media/cover.jpg");
  });
  it("is weight 0 by default and moves only with a harvest of typographic covers", () => {
    expect(DEFAULT_COVER_WEIGHTS.typographic).toBe(0);
    expect(coverWeightsFor(library([entry("typographic"), entry("typographic"), entry("typographic")])).weights.typographic).toBeGreaterThan(0);
  });
});
