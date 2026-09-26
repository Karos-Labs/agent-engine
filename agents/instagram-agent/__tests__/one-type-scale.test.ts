import { describe, expect, it } from "vitest";
import type { InterestFinding } from "../src/workflow/interest-floor.js";
import { planInterestRelayout } from "../src/workflow/interest-relayout.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";
import { goodCopyOutput, goodImageVettingOutput, SIX_RESEARCH_FACTS } from "./test-helpers.js";

/**
 * WS-06 (#253): one type scale per post. Prep batches 6 and 7 dropped one
 * slide's fontScale on most posts to cure an overflow, and that slide then set
 * smaller than its neighbours. A sentence to spare now goes to the caption
 * first; the step down is for a slide with nothing left to move.
 */
function clippedOn(slide: number): InterestFinding {
  return { slide, role: "interior", kind: "clipped", measured: { clippedEdgeShare: 0.05 }, threshold: 0.004, sentence: `slide ${slide} clips`, steer: "shorten" };
}

function withBody(copy: InstagramCopyOutput, n: number, body: string): InstagramCopyOutput {
  return { ...copy, slides: copy.slides.map((s) => (s.n === n ? { ...s, body } : s)) };
}

describe("an overflowing slide keeps the post's type scale when it can", () => {
  it("two sentences: the last one moves to the caption, no fontScale change", () => {
    const copy = withBody(goodCopyOutput(), 3, "The first sentence carries the point. The second adds a detail.");
    const plan = planInterestRelayout(copy, goodImageVettingOutput().selections, SIX_RESEARCH_FACTS, [clippedOn(3)]);
    const change = plan?.changes.find((c) => c.slide === 3);
    expect(change?.kind).toBe("move-sentence-to-caption");
    expect(plan?.changes.some((c) => c.kind === "font-scale")).toBe(false);
  });

  it("one sentence: nothing to move, so the step down stays", () => {
    const copy = withBody(goodCopyOutput(), 3, "A single sentence that is the whole body.");
    const plan = planInterestRelayout(copy, goodImageVettingOutput().selections, SIX_RESEARCH_FACTS, [clippedOn(3)]);
    expect(plan?.changes.find((c) => c.slide === 3)?.kind).toBe("font-scale");
  });
});
