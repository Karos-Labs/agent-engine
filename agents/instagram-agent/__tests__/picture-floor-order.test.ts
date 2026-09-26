import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { MIN_PICTURE_SLIDES } from "../src/workflow/imagery-floor.js";
import { MIN_GENERATED_IMAGES_PER_RUN } from "../src/workflow/run-budget.js";

/**
 * Prep batch 7 (2026-09-25): most posts shipped 2 pictures against a floor of
 * 3, and the owner asked for 3 to 5 and more. Three causes are pinned here.
 */
describe("the picture floor counts the post that ships, and it is 4", () => {
  const src = readFileSync(path.resolve(__dirname, "../src/workflow/create-instagram-agent-workflow.ts"), "utf8");

  it("the cover move (06h4) runs BEFORE the floor check (06h), so the floor counts what the move leaves", () => {
    const move = src.indexOf("rev(`06h4-cover-takes-a-picture-attempt-${attempt}`)");
    const floor = src.indexOf("rev(`06h-imagery-floor-check-attempt-${attempt}`)");
    expect(move).toBeGreaterThan(0);
    expect(floor).toBeGreaterThan(0);
    expect(move).toBeLessThan(floor);
  });

  it("the floor is 4 and the generation guarantee can reach it from zero", () => {
    expect(MIN_PICTURE_SLIDES).toBe(4);
    expect(MIN_GENERATED_IMAGES_PER_RUN).toBeGreaterThanOrEqual(MIN_PICTURE_SLIDES);
  });

  it("a made frame goes first to failed slides that name no entity of the post; entity-naming ones take what is left", () => {
    expect(src).toContain("const namesPostEntity = (n: number): boolean =>");
    expect(src).toMatch(/diversifySceneBriefs\(\[\.\.\.fromFailed, \.\.\.backfilled, \.\.\.fromNamedFailed\]/u);
  });
});
