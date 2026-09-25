import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { describedAsPhotograph, looksLikeMark, mayBeMark } from "../src/workflow/entity-imagery.js";

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

describe("the mark tier drops a namesake's photograph (the Lusha confusion, 2026-09-25)", () => {
  it("keeps real logos in any language and drops a person who shares the name", () => {
    const singer = { path: "n2-a.jpg", description: "slide 2 candidate — Lusha attending a P.A.L (Police Activities League) event in 2010. (by VajzaG39 on Wikimedia Commons) [licence: CC BY-SA 4.0]" };
    const cvm = { path: "n1-b.png", description: "slide 1 candidate — Logotipo da Comissão de Valores Mobiliários (CVM) [licence: CC BY 4.0]" };
    const svg = { path: "n1-c.svg", description: "slide 1 candidate — Acme" };
    expect(mayBeMark(singer)).toBe(false);
    expect(mayBeMark(cvm)).toBe(true);
    expect(mayBeMark(svg)).toBe(true);
  });

  it("the entity route filters the mark tier before tagging", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/workflow/create-instagram-agent-workflow.ts"), "utf8");
    expect(src).toContain("gained = gained.filter((c) => describedAsPhotograph(c) || mayBeMark(");
  });
});
