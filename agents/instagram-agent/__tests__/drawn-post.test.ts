import { describe, expect, it } from "vitest";
import { DRAWN_MAX_SHARE, DRAWN_MIN_EXEMPLAR_VOTES, DRAWN_STYLE_LINE, drawnDisplayFontCssBlock, drawnGenerationStyle, drawnPostDecision, GenerationStyleSchema } from "../src/workflow/style-lock.js";

/** S6 (2026-09-26): a whole post drawn in one ink line, only where the category's best posts are drawn. */
const entry = (coverType: string, craft = 5) => ({ role: "reference", craft, lift: 3, dna: { coverType } });
const library = (drawn: number, of = 12) => ({ status: "built", entries: [...Array.from({ length: drawn }, () => entry("doodle")), ...Array.from({ length: of - drawn }, () => entry("photo-full-bleed"))] });
const base = { seed: "run", clientUploads: 0, clientMediaOnly: false, forbid: [] as string[] };

describe("drawnPostDecision", () => {
  it("never draws a category whose strongest posts are not drawn", () => {
    const d = drawnPostDecision({ ...base, library: library(DRAWN_MIN_EXEMPLAR_VOTES - 1) });
    expect(d.drawn).toBe(false);
    expect(d.reason).toMatch(/under 3/u);
  });

  it("draws a seeded share of runs in a drawn category, never above the cap", () => {
    const lib = library(12);
    const drawn = Array.from({ length: 400 }, (_, i) => drawnPostDecision({ ...base, library: lib, seed: `pubsub-2180${i}` }).drawn).filter(Boolean).length;
    expect(drawn / 400).toBeGreaterThan(DRAWN_MAX_SHARE - 0.1);
    expect(drawn / 400).toBeLessThan(DRAWN_MAX_SHARE + 0.1);
    // Seeded: the same run decides the same way on a resume.
    expect(drawnPostDecision({ ...base, library: lib, seed: "x" }).drawn).toBe(drawnPostDecision({ ...base, library: lib, seed: "x" }).drawn);
  });

  it("never over the client's own photographs, a client-media run, or a direction that forbids drawing", () => {
    const lib = library(12);
    expect(drawnPostDecision({ ...base, library: lib, clientUploads: 2 }).drawn).toBe(false);
    expect(drawnPostDecision({ ...base, library: lib, clientMediaOnly: true }).drawn).toBe(false);
    expect(drawnPostDecision({ ...base, library: lib, forbid: ["cartoon or illustrated imagery"] }).drawn).toBe(false);
    expect(drawnPostDecision({ ...base, library: undefined }).drawn).toBe(false);
  });

  it("freezes one ink line with no photographic treatment, and a handwriting display face", () => {
    const style = drawnGenerationStyle();
    expect(GenerationStyleSchema.parse(style)).toEqual(style);
    expect(style.line).toBe(DRAWN_STYLE_LINE);
    expect(style.treatment).toBe("none");
    expect(drawnDisplayFontCssBlock()).toMatch(/--f-display: "Caveat"/u);
  });
});
