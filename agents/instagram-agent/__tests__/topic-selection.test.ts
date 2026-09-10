import { describe, expect, it } from "vitest";
import {
  parseContentModeFromSummary,
  selectContentMode,
  type ResearchPullResult,
  type TopicSignalsForScout,
  type TrendCandidate,
  type TrendScoutOutput,
} from "@agent-engine/workflow";
import type { ClientBrief } from "@agent-engine/tools";
import {
  EVERGREEN_OFF_MODE_MULTIPLIER,
  MAX_ALTERNATIVES,
  MODE_BONUS,
  OWN_ASSET_WITH_OFFER_BONUS,
  PLANNED_ROW_SCORE,
  candidateDistance,
  rankTopicCandidates,
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

// ─────────────────────────────────────────────────────────────────────────
// Phase 1 (RFC-13 §I): ranking across the five topic engines
// ─────────────────────────────────────────────────────────────────────────

/** Only the fields `rankTopicCandidates` reads — the ranking must not need a whole brief. */
const NO_OFFERS: Pick<ClientBrief, "offers"> = { offers: [] };
const WITH_OFFER: Pick<ClientBrief, "offers"> = { offers: [{ name: "Retainer teardown", summary: "a paid audit of one retainer" }] };

const RANK_BASE = { mode: "deep-value" as const, brief: NO_OFFERS, recentExcerpts: [] as string[], avoidTopics: [] as string[] };

function scoreOf(ranked: ReturnType<typeof rankTopicCandidates>, topic: string): number {
  const row = ranked.ranked.find((r) => r.candidate.topic === topic);
  if (row === undefined) throw new Error(`"${topic}" was not ranked (dropped: ${ranked.dropped.map((d) => d.reason).join("; ")})`);
  return row.score;
}

describe("rankTopicCandidates: distance beats brand fit", () => {
  it("prefers a distant 4/5 story over a near-duplicate of last week's post that scores 5/5", () => {
    const stale = candidate({
      topic: "automated weekly reporting replaces the Monday status meeting",
      headline: "Teams that automated reporting reclaimed four hours a week",
      brandFit: 5,
      interest: 4,
    });
    const fresh = candidate({ topic: "retainer scopes drift in month three", headline: "Why agency retainers lose money by month three", brandFit: 4, interest: 4 });
    const ranked = rankTopicCandidates([stale, fresh], {
      ...RANK_BASE,
      recentExcerpts: ["automated weekly reporting replaces the Monday status meeting: teams that automated reporting reclaimed four hours a week"],
    });
    expect(ranked.chosen).toBe(fresh);
    expect(scoreOf(ranked, fresh.topic)).toBeGreaterThan(scoreOf(ranked, stale.topic));
    expect(ranked.ranked.find((r) => r.candidate === fresh)!.components).toMatchObject({ distance: 1, modeBonus: MODE_BONUS, engineBonus: 1, engine: "niche-news" });
  });

  it("drops what is below the brand-fit floor or already covered, and says which was which", () => {
    const weak = candidate({ topic: "a famous company did a thing", brandFit: 2 });
    const covered = candidate({ topic: "AI triage for support tickets", brandFit: 5 });
    const ranked = rankTopicCandidates([weak, covered, candidate({ topic: "keeper" })], { ...RANK_BASE, avoidTopics: ["ai triage"] });
    expect(ranked.chosen?.topic).toBe("keeper");
    expect(ranked.dropped).toEqual([
      { topic: weak.topic, reason: "brand fit 2/5 is below the floor of 3" },
      { topic: covered.topic, reason: "a subject this client already covered on some channel" },
    ]);
  });
});

describe("rankTopicCandidates: the engine bonuses", () => {
  it("lifts an own-asset story by half again — but only when the client has an offer for it to lead to", () => {
    const asset = candidate({ topic: "how Northwind cut onboarding to 3 days", engine: "own-assets", evidenceRefs: ["market-strategy#Northwind"] });
    const news = candidate({ topic: "a vendor shipped AI triage" });
    const withoutOffer = rankTopicCandidates([asset, news], RANK_BASE);
    expect(scoreOf(withoutOffer, asset.topic)).toBe(scoreOf(withoutOffer, news.topic));

    const withOffer = rankTopicCandidates([asset, news], { ...RANK_BASE, brief: WITH_OFFER });
    expect(withOffer.chosen).toBe(asset);
    expect(scoreOf(withOffer, asset.topic)).toBeCloseTo(scoreOf(withOffer, news.topic) * OWN_ASSET_WITH_OFFER_BONUS, 5);
  });

  it("discounts an evergreen angle except on a deep-value week", () => {
    const evergreen = candidate({ topic: "what practitioners get wrong about retainers", engine: "evergreen", mode: "deep-value" });
    const onDeepValue = rankTopicCandidates([evergreen], { ...RANK_BASE, mode: "deep-value" });
    expect(onDeepValue.ranked[0]!.components.engineBonus).toBe(1);

    // Same candidate, a hot-news week: it also loses the mode bonus, which is
    // the point — evergreen is what you post when there is no news.
    const onHotNews = rankTopicCandidates([evergreen], { ...RANK_BASE, mode: "hot-news" });
    expect(onHotNews.ranked[0]!.components).toMatchObject({ engineBonus: EVERGREEN_OFF_MODE_MULTIPLIER, modeBonus: 1 });
    expect(onHotNews.ranked[0]!.score).toBeLessThan(onDeepValue.ranked[0]!.score);
  });

  it("lifts a reference-account story by the measured engagement of the post it cites, and not at all when it cites none", () => {
    const signals: TopicSignalsForScout = {
      referencePosts: [
        { platform: "instagram", handle: "peer", url: "https://peer.test/1", excerpt: "what landed", engagementScore: 0.8 },
        { platform: "x", handle: "quiet", url: "https://peer.test/2", excerpt: "what did not", engagementScore: 0 },
      ],
      audienceQuestions: [],
      ownAssets: [],
      evergreen: [],
    };
    const cited = candidate({ topic: "the pricing thread everyone shared", engine: "reference-accounts", evidenceRefs: ["https://peer.test/1"] });
    const uncited = candidate({ topic: "a peer post nobody engaged with", engine: "reference-accounts", evidenceRefs: ["https://peer.test/2"] });
    const unsourced = candidate({ topic: "a peer post with no evidence at all", engine: "reference-accounts" });
    const ranked = rankTopicCandidates([cited, uncited, unsourced], { ...RANK_BASE, signals });
    expect(ranked.ranked.find((r) => r.candidate === cited)!.components.engineBonus).toBeCloseTo(1.2, 5);
    expect(ranked.ranked.find((r) => r.candidate === uncited)!.components.engineBonus).toBe(1);
    expect(ranked.ranked.find((r) => r.candidate === unsourced)!.components.engineBonus).toBe(1);
    expect(ranked.chosen).toBe(cited);

    // Without `03e`'s signals the bonus is neutral rather than guessed.
    expect(rankTopicCandidates([cited], RANK_BASE).ranked[0]!.components.engineBonus).toBe(1);
  });
});

describe("rankTopicCandidates: the alternatives the reviewer sees", () => {
  it("carries the engine, the deciding score and a reason on each, capped, and never the chosen one", () => {
    const chosen = candidate({ topic: "chosen", brandFit: 5, interest: 5, mode: "deep-value", engine: "own-assets" });
    const sameMode = candidate({ topic: "second", brandFit: 4, interest: 4, mode: "deep-value", engine: "audience-questions" });
    const otherMode = candidate({ topic: "third", brandFit: 4, interest: 3, mode: "hot-news", engine: "reference-accounts" });
    const many = Array.from({ length: 6 }, (_, i) => candidate({ topic: `filler ${i}`, brandFit: 3, interest: 3, mode: "deep-value" }));
    const ranked = rankTopicCandidates([chosen, sameMode, otherMode, ...many], { ...RANK_BASE, brief: WITH_OFFER });

    expect(ranked.chosen).toBe(chosen);
    expect(ranked.alternatives).toHaveLength(MAX_ALTERNATIVES);
    expect(ranked.alternatives.map((a) => a.topic)).not.toContain("chosen");
    expect(ranked.alternatives[0]).toMatchObject({ topic: "second", engine: "audience-questions", reason: "lower-rank", score: scoreOf(ranked, "second") });
    expect(ranked.alternatives.find((a) => a.topic === "third")).toMatchObject({ engine: "reference-accounts", reason: "off-mode" });
  });
});

describe("resolveTopicClaim with a pre-ranked field", () => {
  const signalsBrief = { ...RANK_BASE, brief: WITH_OFFER };
  const assetStory = candidate({ topic: "how Northwind cut onboarding to 3 days", headline: "Northwind: 11 days to 3", brandFit: 5, interest: 5, engine: "own-assets" });
  const questionStory = candidate({ topic: "who owns the onboarding checklist", headline: "Debate: who owns it", brandFit: 4, interest: 4, engine: "audience-questions" });
  const ranked = () => rankTopicCandidates([assetStory, questionStory], signalsBrief);

  it("still lets a person's request stand, recording the ranked field with its engines and scores", () => {
    const pre = ranked();
    const result = resolveTopicClaim(requestedSeed, scoutWith(assetStory, questionStory), "deep-value", { ...NO_HISTORY, ranked: pre });
    if ("hold" in result) throw new Error(`unexpected hold: ${result.hold}`);
    expect(result.claim.topic).toBe(requestedSeed.topic);
    expect(result.claim.alternatives).toEqual([
      expect.objectContaining({ topic: assetStory.topic, engine: "own-assets", reason: "outranked-by-request", score: pre.ranked[0]!.score }),
      expect.objectContaining({ topic: questionStory.topic, engine: "audience-questions", reason: "outranked-by-request" }),
    ]);
    expect(result.claim.weighting?.bestCandidateScore).toBe(pre.ranked[0]!.score);
  });

  it("still lets a planned row keep its slot, and still lets trend-jacking displace it — on the ranked score", () => {
    const pre = ranked();
    expect(pre.ranked[0]!.score).toBeGreaterThan(PLANNED_ROW_SCORE);

    const kept = resolveTopicClaim(reservedSeed, scoutWith(assetStory, questionStory), "deep-value", { ...NO_HISTORY, ranked: pre });
    if ("hold" in kept) throw new Error("unreachable");
    expect(kept.claim.source).toBe("reserved");
    expect(kept.claim.alternatives!.every((a) => a.reason === "outranked-by-catalog")).toBe(true);
    expect(kept.claim.alternatives![0]!.engine).toBe("own-assets");

    const jacked = resolveTopicClaim(reservedSeed, scoutWith(assetStory, questionStory), "deep-value", { ...NO_HISTORY, ranked: pre, trendJacking: "always" });
    if ("hold" in jacked) throw new Error("unreachable");
    expect(jacked.claim.source).toBe("trend");
    expect(jacked.claim.topic).toBe(assetStory.topic);
    expect(jacked.releaseReservation).toBe(true);
    expect(jacked.claim.alternatives![0]).toMatchObject({ topic: reservedSeed.topic, reason: "outranked-by-trend" });
  });

  it("takes the ranking's winner for a research seed and states which engine won and why", () => {
    const pre = ranked();
    const result = resolveTopicClaim(researchSeed, scoutWith(assetStory, questionStory), "deep-value", { ...NO_HISTORY, ranked: pre });
    if ("hold" in result) throw new Error(`unexpected hold: ${result.hold}`);
    expect(result.claim.source).toBe("trend");
    expect(result.claim.topic).toBe(assetStory.topic);
    expect(result.claim.trend).toBe(assetStory);
    expect(result.claim.weighting?.bestCandidateScore).toBe(pre.ranked[0]!.score);
    expect(result.claim.weighting?.rule).toMatch(/strongest candidate across the five topic engines: own-assets scored/);
    expect(result.claim.weighting?.rule).toMatch(/engine 1\.5/);
    expect(result.claim.alternatives).toEqual(pre.alternatives);
  });

  it("falls through to a real fetched headline when the ranking dropped everything", () => {
    const pre = rankTopicCandidates([candidate({ topic: "off-brand", brandFit: 1 })], signalsBrief);
    expect(pre.chosen).toBeUndefined();
    const merged: ResearchPullResult = {
      runId: "r1",
      query: "agency retainers",
      fromCache: false,
      result: { documents: [{ title: "Agencies report 30% of retainers lose money by month three", url: "https://example.test/retainers", content: "30%" }] },
    };
    const result = resolveTopicClaim(researchSeed, scoutWith(candidate({ topic: "off-brand", brandFit: 1 })), "deep-value", {
      ...NO_HISTORY,
      ranked: pre,
      trendResearchMerged: merged,
    });
    if ("hold" in result) throw new Error(`unexpected hold: ${result.hold}`);
    expect(result.claim.source).toBe("research");
    expect(result.claim.topic).toBe("Agencies report 30% of retainers lose money by month three");
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
