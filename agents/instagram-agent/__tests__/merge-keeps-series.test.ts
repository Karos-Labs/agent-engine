import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { remapDirectedSlides } from "../src/workflow/editorial-series.js";

describe("a merge keeps the slides the series directed (XO Digital, pubsub-21255083755108745)", () => {
  it("renumbers a directed slide instead of dropping its exemption", () => {
    // Eight slides, the lists at 2, 4 and 7 directed; slide 3 merges into 2.
    const renumber = new Map([[1, 1], [2, 2], [4, 3], [5, 4], [6, 5], [7, 6], [8, 7]]);
    expect([...remapDirectedSlides([2, 4, 7], 3, renumber)].sort()).toEqual([2, 3, 6]);
  });

  it("drops the merged-away slide", () => {
    const renumber = new Map([[1, 1], [2, 2], [3, 3], [5, 4]]);
    expect([...remapDirectedSlides([2, 4], 4, renumber)]).toEqual([2]);
  });

  it("the relayout carries the set through the merge and commits it with the render", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/workflow/create-instagram-agent-workflow.ts"), "utf8");
    expect(src).toContain("nextDirectedCarry = remapDirectedSlides(");
    expect(src).toContain("assembleForAttempt(nextCopy, nextSelections, nextValidatedCustomArchetypeIds, nextStyleOverrides, nextDirectedCarry)");
    expect(src).toContain("seriesDirectedCarry = nextDirectedCarry;");
    expect(src).toContain("seriesDirected: new Set([...seriesDirectedSlides(series.series, bounded.copy.slides), ...directedCarry])");
  });
});
