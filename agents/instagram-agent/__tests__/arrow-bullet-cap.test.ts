import { describe, expect, it } from "vitest";
import { MAX_ARROW_BULLETS_PER_CAPTION, repairArrowBullets, repairMechanicalTells } from "../src/workflow/mechanical-repair.js";
import { usesArrowBullets } from "../src/workflow/post-performance.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";

/**
 * ── ARROWS ARE BANNED, NOT RATIONED. ──
 *
 * Three prompt-shaped attempts failed before this one, and then a cap failed
 * too. `instagram-copy@23` §2 PERMITTED the device and was read as a
 * recommendation. `deviceSteer` needs `usedArrowBullets` on two of the last
 * three posts — a field that shipped the same day, so no record carries it and
 * the steer is structurally silent until three more posts ship.
 *
 * Then this file capped a caption at ONE arrow, and the owner corrected the
 * axis:
 *
 *   *"it is not about how many arrows appear in a single post, it is about the
 *   fact that literally every post includes arrows. That pattern screams
 *   AI/bot… Ban or severely suppress them so they aren't a default fixture."*
 *
 * One arrow in every post is still a signature in every post. The tell is the
 * consistency ACROSS posts, which a per-caption cap cannot see at all. So the
 * constant is zero and the marker comes off every line that opens on one.
 */

function copyWith(caption: string): InstagramCopyOutput {
  return {
    caption,
    slides: [{ n: 1, headline: "h", body: "b", layout: "photo", visualNeed: "v", sourceRef: "s" }],
  } as unknown as InstagramCopyOutput;
}

describe("arrows are banned, not rationed", () => {
  it("strips the marker from EVERY arrow line, without touching a word", () => {
    const before = ["The short version.", "", "-> Ship faster", "-> Spend less", "-> Sleep at night"].join("\n");
    const after = repairArrowBullets(before);
    expect(after).toBe(["The short version.", "", "Ship faster", "Spend less", "Sleep at night"].join("\n"));
    // Every word survives. This is a formatting repair, not a rewrite — the
    // bar `mechanical-repair.ts` sets for itself.
    for (const word of ["Ship faster", "Spend less", "Sleep at night", "The short version."]) {
      expect(after).toContain(word);
    }
  });

  it("strips a SINGLE arrow too, because one in every post IS the pattern", () => {
    const one = ["A real sentence.", "-> and one turn", "then prose again."].join("\n");
    expect(repairArrowBullets(one)).toBe(["A real sentence.", "and one turn", "then prose again."].join("\n"));
  });

  it("handles every spelling the copy guide used to permit", () => {
    for (const glyph of ["→", "⇒", "»", "->", "=>"]) {
      expect(repairArrowBullets([`${glyph} one`, `${glyph} two`].join("\n")).split("\n")).toEqual(["one", "two"]);
    }
  });

  it("never touches an arrow INSIDE a sentence, which is prose", () => {
    // The ban is on the marker that opens a line. An arrow used mid-sentence
    // to mean "and then" is writing, and banning that would be a worse rule
    // than the tell it fixes.
    const prose = "Revenue fell 4% -> the round was pulled the same week.\nThe mapping is old -> new.";
    expect(repairArrowBullets(prose)).toBe(prose);
  });

  it("preserves indentation, so an indented list stays indented", () => {
    expect(repairArrowBullets(["  -> first", "  -> second"].join("\n"))).toBe(["  first", "  second"].join("\n"));
  });

  it("leaves a caption with no arrows byte-identical", () => {
    const plain = "Three sentences.\nNo markers anywhere.\nJust prose.";
    expect(repairArrowBullets(plain)).toBe(plain);
  });

  it("runs inside repairMechanicalTells and is reported separately from the dashes", () => {
    const { copy, repairs } = repairMechanicalTells(copyWith(["-> one", "-> two", "-> three"].join("\n")));
    expect(repairs.map((r) => r.field)).toContain("caption arrow bullets");
    const remaining = copy.caption.split("\n").filter((l) => /^(?:→|⇒|»|->|=>)\s/u.test(l));
    expect(remaining).toHaveLength(0);
    // The knob itself, asserted so a future edit to it is a deliberate one.
    expect(MAX_ARROW_BULLETS_PER_CAPTION).toBe(0);
  });

  it("leaves the cross-run measurement honest: a banned caption records no device", () => {
    // `usedArrowBullets` must report what SHIPPED. With the ban that is
    // always false, so `arrowBulletSteer` never fires — correct, because
    // there is no habit left for it to warn the next post about.
    const { copy } = repairMechanicalTells(copyWith(["-> one", "-> two"].join("\n")));
    expect(usesArrowBullets(copy.caption)).toBe(false);
  });
});
