import { describe, expect, it } from "vitest";
import { MAX_ARROW_BULLETS_PER_CAPTION, repairArrowBullets, repairMechanicalTells } from "../src/workflow/mechanical-repair.js";
import { usesArrowBullets } from "../src/workflow/post-performance.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";

/**
 * ── THE THIRD ATTEMPT AT THE ARROWS, AND THE FIRST DETERMINISTIC ONE. ──
 *
 * The owner, 2026-09-20: *"there are still arrows in the post's text all the
 * time and it is already templated and happens too much."*
 *
 * Attempt one was `instagram-copy@23` §2, which PERMITTED the device and was
 * read as a recommendation. Attempt two was `deviceSteer`, fed by
 * `arrowBulletSteer`, which needs `usedArrowBullets: true` on two of the last
 * three posts — a field that shipped the same day, so no record carries it and
 * the steer is structurally silent until three more posts ship.
 *
 * This is the within-post half: it needs no history and works on the next run.
 */

function copyWith(caption: string): InstagramCopyOutput {
  return {
    caption,
    slides: [{ n: 1, headline: "h", body: "b", layout: "photo", visualNeed: "v", sourceRef: "s" }],
  } as unknown as InstagramCopyOutput;
}

describe("one arrow is a device, four is a template", () => {
  it("keeps the first arrow bullet and strips the marker from the rest, without touching a word", () => {
    const before = ["The short version.", "", "-> Ship faster", "-> Spend less", "-> Sleep at night"].join("\n");
    const after = repairArrowBullets(before);
    expect(after).toBe(["The short version.", "", "-> Ship faster", "Spend less", "Sleep at night"].join("\n"));
    // Every word survives. This is a formatting repair, not a rewrite — the
    // bar `mechanical-repair.ts` sets for itself.
    for (const word of ["Ship faster", "Spend less", "Sleep at night", "The short version."]) {
      expect(after).toContain(word);
    }
  });

  it("handles every spelling the copy guide permits", () => {
    for (const glyph of ["→", "⇒", "»", "->", "=>"]) {
      const after = repairArrowBullets([`${glyph} one`, `${glyph} two`, `${glyph} three`].join("\n"));
      expect(after.split("\n")[0]).toBe(`${glyph} one`);
      expect(after.split("\n")[1]).toBe("two");
      expect(after.split("\n")[2]).toBe("three");
    }
  });

  it("leaves a caption that already uses the device once completely alone", () => {
    // Once is fine and always was. A repair that fired here would be removing
    // a device the owner explicitly said is acceptable in moderation.
    const fine = ["A real sentence.", "-> and one turn", "then prose again."].join("\n");
    expect(repairArrowBullets(fine)).toBe(fine);
  });

  it("never touches an arrow INSIDE a sentence, which is prose", () => {
    const prose = "Revenue fell 4% -> the round was pulled the same week.\nThe mapping is old -> new.";
    expect(repairArrowBullets(prose)).toBe(prose);
  });

  it("preserves indentation, so an indented list stays indented", () => {
    const after = repairArrowBullets(["  -> first", "  -> second"].join("\n"));
    expect(after).toBe(["  -> first", "  second"].join("\n"));
  });

  it("leaves a caption with no arrows byte-identical", () => {
    const plain = "Three sentences.\nNo markers anywhere.\nJust prose.";
    expect(repairArrowBullets(plain)).toBe(plain);
  });

  it("runs inside repairMechanicalTells and is reported separately from the dashes", () => {
    const { copy, repairs } = repairMechanicalTells(copyWith(["-> one", "-> two", "-> three"].join("\n")));
    expect(repairs.map((r) => r.field)).toContain("caption arrow bullets");
    // And the caption that ships really is capped.
    const lines = copy.caption.split("\n").filter((l) => /^(?:→|⇒|»|->|=>)\s/u.test(l));
    expect(lines).toHaveLength(MAX_ARROW_BULLETS_PER_CAPTION);
  });

  it("leaves the cross-run measurement still able to see the surviving device", () => {
    // `usedArrowBullets` must still record TRUE for a capped caption: the post
    // did use the device, once. Recording false would quietly starve
    // `arrowBulletSteer` of the history it needs, and the two halves of this
    // fix would cancel each other out.
    const { copy } = repairMechanicalTells(copyWith(["-> one", "-> two"].join("\n")));
    expect(usesArrowBullets(copy.caption)).toBe(true);
  });
});
