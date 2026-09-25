import { describe, expect, it } from "vitest";
import { applyCoverPictureMove, coverPictureMove } from "../src/workflow/cover-picture.js";
import type { ImageSelection, InstagramCopyOutput } from "../src/workflow/types.js";

/** Prep batch 5, The Pitch by Deel (b): four interior pictures and a bare cover. */
const slide = (n: number, layout: string) => ({ n, headline: `h${n}`, body: `b${n}`, visualNeed: "v", sourceRef: "c", layout });
const copy = { slides: [slide(1, "cover"), slide(2, "photo"), slide(3, "stat_callout"), slide(4, "photo"), slide(5, "closer")] } as unknown as InstagramCopyOutput;
const pic = (n: number, path: string | null, claimMatch = 4, reason = "a founder on stage"): ImageSelection => ({
  n, imagePath: path, reason, license: "Pexels", rightsUsable: true, watermarkFree: true, claimMatch, claimMatchReason: "fits",
});
const standIn = (n: number): ImageSelection => ({ n, imagePath: null, reason: "typographic", license: "n/a", rightsUsable: true, watermarkFree: true, claimMatch: 5, claimMatchReason: "none" });

describe("the cover takes a picture before any interior slide keeps one", () => {
  it("moves the best interior picture to a bare cover, from a panel slide before a photo plate at equal match", () => {
    const sels = [pic(1, null), pic(2, "a.jpg", 4), pic(3, "b.jpg", 4), pic(4, "c.jpg", 3), pic(5, null)];
    const move = coverPictureMove(copy, sels)!;
    expect(move).toEqual({ from: 3, path: "b.jpg" });
    const after = applyCoverPictureMove(sels, 1, move, standIn);
    expect(after.find((s) => s.n === 1)!.imagePath).toBe("b.jpg");
    expect(after.find((s) => s.n === 3)!.imagePath).toBeNull();
    // Vetted for slide 3, not for the cover: the claim verdict is capped at the floor and still passes it.
    expect(after.find((s) => s.n === 1)!.claimMatch).toBe(3);
    expect(after.find((s) => s.n === 1)!.subjectMatch).toBeUndefined();
    // Moved, not copied: the post still shows three pictures, each once.
    expect(after.filter((s) => s.imagePath !== null).map((s) => s.imagePath).sort()).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
  });

  it("leaves a cover that already has a usable picture alone", () => {
    expect(coverPictureMove(copy, [pic(1, "x.jpg"), pic(2, "a.jpg", 5)])).toBeUndefined();
  });

  it("never moves a logo, the screen cliché, a picture the floor refuses, or the closer's picture", () => {
    expect(coverPictureMove(copy, [pic(1, null), pic(2, "logo.png", 5)], new Set(["logo.png"]))).toBeUndefined();
    expect(coverPictureMove(copy, [pic(1, null), pic(2, "s.jpg", 5, "a man lit by a laptop screen in a dark room")])).toBeUndefined();
    expect(coverPictureMove(copy, [pic(1, null), pic(2, "weak.jpg", 1)])).toBeUndefined();
    expect(coverPictureMove(copy, [pic(1, null), pic(5, "closer.jpg", 5)])).toBeUndefined();
  });

  it("a cover whose own picture failed the floor counts as bare", () => {
    expect(coverPictureMove(copy, [pic(1, "weak-cover.jpg", 1), pic(2, "a.jpg", 4)])).toEqual({ from: 2, path: "a.jpg" });
  });
});
