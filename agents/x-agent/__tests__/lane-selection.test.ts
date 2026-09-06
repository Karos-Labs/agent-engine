import { describe, expect, it } from "vitest";
import { countRecentEngagementPosts, ENGAGEMENT_DAILY_CAP, parseLaneFromSummary, selectLane } from "../src/workflow/lane.js";
import type { XRecentDecision } from "../src/workflow/types.js";

function decision(summary: string, at: number): XRecentDecision {
  return { decisionId: `d_${at}`, summary, at };
}

describe("parseLaneFromSummary", () => {
  it("extracts the lane token from a decision summary written by step 20", () => {
    expect(parseLaneFromSummary('Posted about "x" (lane: knowledge, angle: trend-observation)')).toBe("knowledge");
    expect(parseLaneFromSummary('Posted about "x" (lane: build-in-public, angle: data-point)')).toBe("build-in-public");
  });

  it("returns undefined for a summary with no lane token, or an unrecognized one", () => {
    expect(parseLaneFromSummary('Posted about "x" (angle: data-point)')).toBeUndefined();
    expect(parseLaneFromSummary('Posted about "x" (lane: not-a-real-lane)')).toBeUndefined();
  });
});

describe("selectLane", () => {
  it("an explicit, valid requestedLane always wins, regardless of history", () => {
    const history = [decision('Posted about "x" (lane: build-in-public, angle: data-point)', Date.now())];
    expect(selectLane("engagement", history)).toBe("engagement");
  });

  it("an invalid requestedLane is ignored and falls back to the rotation", () => {
    expect(selectLane("not-a-real-lane", [])).toBe("knowledge");
  });

  it("with no history, defaults to the top-weighted lane (knowledge)", () => {
    expect(selectLane(undefined, [])).toBe("knowledge");
  });

  it("never repeats the immediately-prior run's lane", () => {
    const priorLane = decision('Posted about "x" (lane: knowledge, angle: trend-observation)', Date.now());
    const picked = selectLane(undefined, [priorLane]);
    expect(picked).not.toBe("knowledge");
    expect(picked).toBe("pov"); // next-highest weight once knowledge is excluded
  });

  it("picks the least-used lane among candidates when usage differs, even if it isn't the top weight", () => {
    const now = Date.now();
    // knowledge and pov both used twice; build-in-public unused. The
    // immediately-prior lane was pov, so knowledge is still eligible but
    // tied in usage with pov (both count 2) — build-in-public (count 0)
    // should win over both on usage, despite its lower base weight.
    const history: XRecentDecision[] = [
      decision('Posted about "a" (lane: knowledge, angle: trend-observation)', now - 4000),
      decision('Posted about "b" (lane: pov, angle: trend-observation)', now - 3000),
      decision('Posted about "c" (lane: knowledge, angle: trend-observation)', now - 2000),
      decision('Posted about "d" (lane: pov, angle: trend-observation)', now - 1000),
    ];
    expect(selectLane(undefined, history)).toBe("build-in-public");
  });

  // Prep run pubsub-21699953559354996: a deep-value week, prior lane pov, a
  // scouted OpenAI story — and the rotation handed it build-in-public, the
  // lane for the client's OWN ship. The draft spent all eight turns on that
  // contradiction. The workflow now excludes the lane for an external topic.
  describe("excluded lanes", () => {
    const now = Date.now();
    const priorPov: XRecentDecision[] = [
      decision('Posted about "a" (lane: knowledge, angle: data-point)', now - 2000),
      decision('Posted about "b" (lane: pov, angle: data-point)', now - 1000),
    ];

    it("an excluded lane is out of the rotation even when it is the least-used preferred lane", () => {
      // Without the exclusion, build-in-public (0 uses) beats knowledge (1 use).
      expect(selectLane(undefined, priorPov, ["knowledge", "build-in-public"])).toBe("build-in-public");
      expect(selectLane(undefined, priorPov, ["knowledge", "build-in-public"], ["build-in-public"])).toBe("knowledge");
    });

    it("the exclusion holds when the preferred set narrows to nothing and the whole menu applies", () => {
      const priorKnowledge = [decision('Posted about "a" (lane: knowledge, angle: data-point)', now)];
      // preferred minus prior minus excluded is empty → whole menu, which must
      // also not re-admit the excluded lane: pov is the next weight down.
      expect(selectLane(undefined, priorKnowledge, ["knowledge", "build-in-public"], ["build-in-public"])).toBe("pov");
    });

    it("an explicit requestedLane is not subject to the exclusion", () => {
      expect(selectLane("build-in-public", priorPov, ["knowledge"], ["build-in-public"])).toBe("build-in-public");
    });
  });
});

describe("countRecentEngagementPosts", () => {
  it("counts only engagement-lane decisions within the window", () => {
    const now = Date.now();
    const history: XRecentDecision[] = [
      decision('Posted about "a" (lane: engagement, angle: trend-observation)', now - 1000),
      decision('Posted about "b" (lane: knowledge, angle: trend-observation)', now - 1000),
      decision('Posted about "c" (lane: engagement, angle: trend-observation)', now - 60 * 60 * 1000),
    ];
    expect(countRecentEngagementPosts(history, now, 24 * 60 * 60 * 1000)).toBe(2);
  });

  it("excludes engagement decisions outside the window", () => {
    const now = Date.now();
    const history: XRecentDecision[] = [
      decision('Posted about "old" (lane: engagement, angle: trend-observation)', now - 48 * 60 * 60 * 1000),
    ];
    expect(countRecentEngagementPosts(history, now, 24 * 60 * 60 * 1000)).toBe(0);
  });

  it("ignores decisions with no numeric `at` timestamp", () => {
    const history: XRecentDecision[] = [{ decisionId: "no-at", summary: 'Posted about "x" (lane: engagement, angle: trend-observation)' }];
    expect(countRecentEngagementPosts(history, Date.now())).toBe(0);
  });

  it("the daily cap constant is a small, documented default", () => {
    expect(ENGAGEMENT_DAILY_CAP).toBe(5);
  });
});
