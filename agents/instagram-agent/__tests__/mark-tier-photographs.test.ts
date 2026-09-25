import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { describedAsPhotograph, looksLikeMark } from "../src/workflow/entity-imagery.js";

/**
 * Hanky Panky, prep batch 3 (2026-09-25): the mark tier returned a Google
 * Places "geo-verified photo of 'Met's Costume Institute logo'" and every
 * candidate from that tier was tagged a mark, so the photograph rendered as a
 * small logo card in the corner of the cover.
 */
describe("a photograph from the mark tier stays a photograph", () => {
  const places = { description: 'slide 1 candidate — geo-verified photo of "Met\'s Costume Institute logo" from Google Places (contributed by x) [licence: Google Places photo]' };
  const wordmark = { description: "Cvm-logo (by Daniel Siqueira Carvalho via wikimedia on Openverse) [licence: CC BY 4.0]" };

  it("recognises the provider's own photograph wording, and not a real logo", () => {
    expect(describedAsPhotograph(places)).toBe(true);
    expect(describedAsPhotograph(wordmark)).toBe(false);
    // The same line `looksLikeMark` already draws.
    expect(looksLikeMark({ path: "a.jpg", ...places })).toBe(false);
  });

  it("the entity route tags only non-photographs as marks", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/workflow/create-instagram-agent-workflow.ts"), "utf8");
    expect(src).toContain("for (const c of gained) if (!describedAsPhotograph(c)) marks.push(c.path);");
    expect(src).not.toContain("for (const c of gained) marks.push(c.path);");
  });
});
