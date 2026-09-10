import { describe, expect, it } from "vitest";
import { parseContentModeFromSummary, selectContentMode, type ResearchPullResult, type TrendCandidate, type TrendScoutOutput } from "@agent-engine/workflow";
import {
  MAX_ALTERNATIVES,
  PLANNED_ROW_SCORE,
  candidateDistance,
  recentModesFromDecisions,
  resolveTopicClaim,
  scoreCandidate,
  topicDecisionForGate,
  topicDecisionSummary,
} from "../src/workflow/topic-selection.js";
import type { InstagramTopicClaim } from "../src/workflow/types.js";
import { goodTrendScoutOutput } from "./test-helpers.js";

/**
 * `resolveTopicClaim` is the one place the subject precedence lives (RFC-13
 * §E): request > planned row (unless trend-jacking) > on-brand trend > real
 * headline > honest hold. Pure, so every rule is pinned here without a
 * workflow run.
 */

const NO_HISTORY = { avoidTopics: [] as string[], recentExcerpts: [] as string[], scoutStatus: "ran" as const };

function candidate(overrides: Partial<TrendCandidate>): TrendCandidate {
  return { ...goodTrendScoutOutput().candidates[0]!, ...overrides };
}

function scoutWith(...candidates: TrendCandidate[]): TrendScoutOutput {
  return { candidates, skipped: [] };
}

const reservedSeed: InstagramTopicClaim = { reservationKey: "run__topic", topic: "how our team cut onboarding time in half", source: "reserved" };
const requestedSeed: InstagramTopicClaim = { topic: "our new onboarding flow", source: "requested" };
const researchSeed: InstagramTopicClaim = { topic: "B2B SaaS", source: "research" };

describe("resolveTopicClaim: a person's request stands", () => {
  it("keeps the requested topic and records every scouted story as outranked-by-request", () => {
    const strong = candidate({ brandFit: 5, interest: 5 });
    const result = resolveTopicClaim(requestedSeed, scoutWith(strong, goodTrendScoutOutput().candidates[1]!), "deep-value", NO_HISTORY);
    if ("hold" in result) throw new Error(`unexpected hold: ${result.hold}`);
    expect(result.claim.topic).toBe("our new onboarding flow");
    expect(result.claim.source).toBe("requested");
    expect(result.releaseReservation).toBe(false);
    expect(result.claim.alternatives).toHaveLength(2);
    expect(result.claim.alternatives!.every((a) => a.reason === "outranked-by-request")).toBe(true);
    // Strongest first, so the reviewer reads the best story they did not get at the top.
    expect(result.claim.alternatives![0]!.topic).toBe(strong.topic);
    expect(result.claim.mode).toBe("deep-value");
    expect(result.claim.scoutStatus).toBe("ran");
    expect(result.claim.weighting?.rule).toMatch(/typed or configured/);
  });
});

describe("resolveTopicClaim: a planned catalog row", () => {
  it("is displaced by a 5/5 story only under trendJacking 'always', releasing the reservation and listing the row as outranked-by-trend", () => {
    const story = candidate({ topic: "the story of the week", brandFit: 5, interest: 5 });
    const result = resolveTopicClaim(reservedSeed, scoutWith(story, goodTrendScoutOutput().candidates[2]!), "deep-value", { ...NO_HISTORY, trendJacking: "always" });
    if ("hold" in result) throw new Error(`unexpected hold: ${result.hold}`);
    expect(result.claim.source).toBe("trend");
    expect(result.claim.topic).toBe("the story of the week");
    expect(result.claim.trend).toBe(story);
    expect(result.releaseReservation).toBe(true);
    // The row goes back to the catalog: no key on the claim, so step 09 cannot commit a reservation the run did not use.
    expect(result.claim.reservationKey).toBeUndefined();
    expect(result.claim.alternatives![0]).toMatchObject({ topic: reservedSeed.topic, reason: "outranked-by-trend", score: PLANNED_ROW_SCORE });
    expect(result.claim.alternatives!.slice(1).every((a) => a.reason === "lower-rank")).toBe(true);
    expect(result.claim.weighting).toMatchObject({ plannedScore: PLANNED_ROW_SCORE, bestCandidateScore: 25 });
  });

  it("stays when the best story scores exactly the planned row's worth (brand fit 4 × interest 3 = 12 is not > 12)", () => {
    const even = candidate({ brandFit: 4, interest: 3 });
    const result = resolveTopicClaim(reservedSeed, scoutWith(even), "deep-value", { ...NO_HISTORY, trendJacking: "always" });
    if ("hold" in result) throw new Error(`unexpected hold: ${result.hold}`);
    expect(result.claim.source).toBe("reserved");
    expect(result.claim.reservationKey).toBe("run__topic");
    expect(result.releaseReservation).toBe(false);
    expect(result.claim.alternatives).toEqual([expect.objectContaining({ topic: even.topic, reason: "outranked-by-catalog", score: 12 })]);
    expect(result.claim.weighting?.rule).toMatch(/no story cleared/);
  });

  it("stays regardless of the story when the client has not opted into trend-jacking", () => {
    const story = candidate({ brandFit: 5, interest: 5 });
    for (const trendJacking of [undefined, "fallback", "sometimes"]) {
      const result = resolveTopicClaim(reservedSeed, scoutWith(story), "deep-value", { ...NO_HISTORY, trendJacking });
      if ("hold" in result) throw new Error(`unexpected hold: ${result.hold}`);
      expect(result.claim.source).toBe("reserved");
      expect(result.releaseReservation).toBe(false);
      expect(result.claim.alternatives![0]!.reason).toBe("outranked-by-catalog");
      expect(result.claim.weighting?.rule).toMatch(/trendJacking to "always"/);
    }
  });

  it("is not displaced by a 5/5 story the client already posted about — distance drives the score to zero", () => {
    const story = candidate({ topic: "automated weekly reporting replaces the Monday status meeting", headline: "Teams that automated reporting reclaimed four hours a week", brandFit: 5, interest: 5 });
    const recentExcerpts = ["automated weekly reporting replaces the Monday status meeting: teams that automated reporting reclaimed four hours a week"];
    expect(scoreCandidate(story, recentExcerpts)).toBeLessThan(PLANNED_ROW_SCORE);
    const result = resolveTopicClaim(reservedSeed, scoutWith(story), "deep-value", { ...NO_HISTORY, recentExcerpts, trendJacking: "always" });
    if ("hold" in result) throw new Error(`unexpected hold: ${result.hold}`);
    expect(result.claim.source).toBe("reserved");
  });

  it("is not displaced by a story overlapping a subject another channel already covered", () => {
    const story = candidate({ topic: "AI triage for support tickets", brandFit: 5, interest: 5 });
    const result = resolveTopicClaim(reservedSeed, scoutWith(story), "deep-value", { ...NO_HISTORY, avoidTopics: ["ai triage"], trendJacking: "always" });
    if ("hold" in result) throw new Error(`unexpected hold: ${result.hold}`);
    expect(result.claim.source).toBe("reserved");
  });
});

describe("resolveTopicClaim: nothing planned (research seed)", () => {
  it("takes the strongest on-brand candidate in this run's mode and tags the rest lower-rank / off-mode", () => {
    const scout = goodTrendScoutOutput();
    const result = resolveTopicClaim(researchSeed, scout, "hot-news", NO_HISTORY);
    if ("hold" in result) throw new Error(`unexpected hold: ${result.hold}`);
    expect(result.claim.source).toBe("trend");
    // brandFit 4 in-mode beats brandFit 5 off-mode: the rotation is a steer.
    expect(result.claim.trend?.mode).toBe("hot-news");
    expect(result.claim.topic).toBe(scout.candidates[1]!.topic);
    expect(result.claim.alternatives!.map((a) => a.reason)).toEqual(["off-mode", "off-mode"]);
    expect(result.claim.weighting?.rule).toMatch(/in this run's mode \(hot-news\)/);
  });

  it("falls back to any mode when nothing in the requested mode clears the floor, and says so", () => {
    const only = candidate({ mode: "deep-value", brandFit: 5 });
    const result = resolveTopicClaim(researchSeed, scoutWith(only), "open-discussion", NO_HISTORY);
    if ("hold" in result) throw new Error(`unexpected hold: ${result.hold}`);
    expect(result.claim.source).toBe("trend");
    expect(result.claim.weighting?.rule).toMatch(/no candidate in this run's mode \(open-discussion\)/);
  });

  it("uses a REAL fetched headline when no candidate is on-brand — never a query, never 'trends this week'", () => {
    const weak = candidate({ brandFit: 2, interest: 5 });
    const merged: ResearchPullResult = {
      runId: "r1",
      query: "B2B SaaS trends this week",
      fromCache: false,
      result: {
        documents: [
          { title: "Ops teams report 40% fewer status meetings after reporting automation", url: "https://example.test/ops", content: "40% fewer meetings" },
          { title: "A second story", url: "https://example.test/second", content: "no figures" },
        ],
      },
    };
    const result = resolveTopicClaim(researchSeed, scoutWith(weak), "deep-value", { ...NO_HISTORY, trendResearchMerged: merged });
    if ("hold" in result) throw new Error(`unexpected hold: ${result.hold}`);
    expect(result.claim.source).toBe("research");
    expect(result.claim.topic).toBe("Ops teams report 40% fewer status meetings after reporting automation");
    expect(result.claim.topic).not.toMatch(/trends this week/);
    expect(result.claim.alternatives).toEqual([expect.objectContaining({ topic: weak.topic, reason: "lower-rank" })]);
    expect(result.claim.weighting?.rule).toMatch(/https:\/\/example\.test\/ops/);
  });

  it("holds with the scout's counts when the research fetched nothing and no candidate is on-brand", () => {
    const weak = candidate({ brandFit: 2 });
    const scout: TrendScoutOutput = { candidates: [weak], skipped: [{ headline: "x", reason: "y" }, { headline: "z", reason: "w" }] };
    const empty: ResearchPullResult = { runId: "r0", query: "B2B SaaS", fromCache: false, result: { documents: [] } };
    const result = resolveTopicClaim(researchSeed, scout, "deep-value", { ...NO_HISTORY, trendResearchMerged: empty });
    expect(result).toEqual({ hold: expect.stringMatching(/^no on-brand subject this week: catalog empty, nothing requested, scout considered 3 stories \(best brand fit 2\/5\) — add a catalog row or a requestedSubject$/) });
  });

  it("holds, naming the scout status, when the scout never ran and there are no documents", () => {
    const result = resolveTopicClaim(researchSeed, undefined, "deep-value", { ...NO_HISTORY, scoutStatus: "no-documents" });
    expect(result).toEqual({ hold: expect.stringContaining("scout considered 0 stories (best brand fit n/a; scout no-documents)") });
  });

  it("never turns the empty-search query into the subject: a merged pull whose only 'document' has no title is treated as nothing", () => {
    const merged: ResearchPullResult = { runId: "r2", query: "B2B SaaS", fromCache: false, result: { documents: [{ url: "https://example.test/untitled", content: "…" }] } };
    const result = resolveTopicClaim(researchSeed, scoutWith(), "deep-value", { ...NO_HISTORY, trendResearchMerged: merged });
    expect("hold" in result).toBe(true);
  });

  it("caps the alternatives it carries to the gate", () => {
    const many = Array.from({ length: 9 }, (_, i) => candidate({ topic: `story ${i}`, headline: `headline ${i}`, brandFit: 4, interest: 3 }));
    const result = resolveTopicClaim(requestedSeed, scoutWith(...many), "deep-value", NO_HISTORY);
    if ("hold" in result) throw new Error("unreachable");
    expect(result.claim.alternatives).toHaveLength(MAX_ALTERNATIVES);
  });
});

describe("scoring", () => {
  it("distance is 1 with no history and 0 against an identical excerpt", () => {
    const c = candidate({ topic: "automated weekly reporting", headline: "teams that automated reporting reclaimed four hours a week" });
    expect(candidateDistance(c, [])).toBe(1);
    expect(candidateDistance(c, ["automated weekly reporting teams that automated reporting reclaimed four hours a week"])).toBe(0);
  });

  it("score is brandFit × interest × distance", () => {
    expect(scoreCandidate(candidate({ brandFit: 5, interest: 4 }), [])).toBe(20);
  });
});

describe("content-mode rotation over the decision log", () => {
  it("orders memory.read's newest-first rows oldest-first and skips rows without a mode, so selectContentMode avoids the LAST mode", () => {
    // `memory.read` with a limit returns newest first. Fed raw, the rotation
    // would avoid the oldest post's mode; oldest-first is what the shared
    // selector expects (`recentModes.at(-1)` is "the prior post").
    const decisions = [
      { at: 3000, summary: 'instagram post: "c" (mode: hot-news; source: trend; archetypes: photo)' },
      { at: 2000, summary: "style directive accepted: accent #ff6b2c" },
      { at: 1000, summary: 'instagram post: "a" (mode: deep-value; source: reserved; archetypes: photo,stat_callout)' },
    ];
    const modes = recentModesFromDecisions(decisions);
    expect(modes).toEqual(["deep-value", "hot-news"]);
    expect(selectContentMode(modes)).toBe("open-discussion");
    expect(selectContentMode(modes, "hot-news")).toBe("hot-news");
  });

  it("topicDecisionSummary round-trips the mode through parseContentModeFromSummary and records the archetypes", () => {
    const summary = topicDecisionSummary({ topic: "our new onboarding flow", mode: "open-discussion", source: "requested", archetypes: ["photo", "stat_callout", "photo"] });
    expect(summary).toBe('instagram post: "our new onboarding flow" (mode: open-discussion; source: requested; archetypes: photo,stat_callout)');
    expect(parseContentModeFromSummary(summary)).toBe("open-discussion");
    expect(topicDecisionSummary({ topic: "t", mode: "hot-news", source: "trend", archetypes: [] })).toContain("archetypes: none");
  });

  it("topicDecisionForGate exposes the decision without the reservation key or the full trend candidate", () => {
    const result = resolveTopicClaim(reservedSeed, goodTrendScoutOutput(), "deep-value", NO_HISTORY);
    if ("hold" in result) throw new Error("unreachable");
    const gate = topicDecisionForGate(result.claim);
    expect(gate).toEqual({
      topic: reservedSeed.topic,
      source: "reserved",
      mode: "deep-value",
      alternatives: result.claim.alternatives,
      weighting: result.claim.weighting,
      scoutStatus: "ran",
    });
    expect(gate).not.toHaveProperty("reservationKey");
    // Step 03's bare seed, before 03g: no mode yet, empty alternatives — never undefined.
    expect(topicDecisionForGate(researchSeed)).toEqual({ topic: "B2B SaaS", source: "research", alternatives: [] });
  });
});
