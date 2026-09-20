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
  CATALOG_MIN_FIT_RATIO,
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
  type BelowFloorWeighting,
  freshnessBonus,
  FRESHNESS_NEUTRAL,
  FRESHNESS_STALE,
} from "../src/workflow/topic-selection.js";
import type { InstagramTopicClaim } from "../src/workflow/types.js";
import { goodTrendScoutOutput } from "./test-helpers.js";

/**
 * `resolveTopicClaim` is the one place the subject precedence lives (RFC-13
 * §E): request > planned row (unless trend-jacking) > on-brand trend > real
 * headline > the client's own declared industry. Pure, so every rule is pinned
 * here without a workflow run.
 *
 * The last rung used to be an honest hold and is not one any more (RFC-19 §4
 * item 16): a brand-fit floor refusing every scouted story is a QUALITY
 * verdict about stories, and a quality verdict may not end a run. The floor
 * itself is untouched — `belowFloor` records exactly what it refused — and the
 * intake hold one step earlier (`WF:3286`, no row AND no request AND no
 * declared industry) is deliberately still a hold, pinned by
 * `topic-floor-breach.test.ts`.
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
    expect(result.claim.source).toBe("reserved");
  });

  it("is not displaced by a story overlapping a subject another channel already covered", () => {
    const story = candidate({ topic: "AI triage for support tickets", brandFit: 5, interest: 5 });
    const result = resolveTopicClaim(reservedSeed, scoutWith(story), "deep-value", { ...NO_HISTORY, avoidTopics: ["ai triage"], trendJacking: "always" });
    expect(result.claim.source).toBe("reserved");
  });
});

describe("resolveTopicClaim: nothing planned (research seed)", () => {
  it("takes the strongest on-brand candidate in this run's mode and tags the rest lower-rank / off-mode", () => {
    const scout = goodTrendScoutOutput();
    const result = resolveTopicClaim(researchSeed, scout, "hot-news", NO_HISTORY);
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
    expect(result.claim.source).toBe("research");
    expect(result.claim.topic).toBe("Ops teams report 40% fewer status meetings after reporting automation");
    expect(result.claim.topic).not.toMatch(/trends this week/);
    expect(result.claim.alternatives).toEqual([expect.objectContaining({ topic: weak.topic, reason: "lower-rank" })]);
    expect(result.claim.weighting?.rule).toMatch(/https:\/\/example\.test\/ops/);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Branch 6 (RFC-19 §4 item 16): the brand-fit floor stopped ending runs
  //
  // These three cases HELD until Phase 6. The floor is unchanged — every
  // story it refused is still refused, and `belowFloor` is where the refusal
  // is now recorded — but a judgment about STORIES may not be the end of a
  // run when the client has told us what business they are in.
  // ─────────────────────────────────────────────────────────────────────

  it("BRANCH 6, the exact return shape: a non-empty seed leads, the floor's counts ride along, and there is no hold", () => {
    // The unit pin RFC-19 asks for by name, so this branch cannot rot into a
    // dead guard the way a fall-through with no direct test does. Every field
    // is asserted, not just the ones the workflow happens to read.
    const weak = candidate({ topic: "a story the floor refused", brandFit: 2, interest: 5 });
    const scout: TrendScoutOutput = { candidates: [weak], skipped: [{ headline: "x", reason: "y" }, { headline: "z", reason: "w" }] };
    const empty: ResearchPullResult = { runId: "r0", query: "B2B SaaS", fromCache: false, result: { documents: [] } };

    const result = resolveTopicClaim(researchSeed, scout, "deep-value", { ...NO_HISTORY, trendResearchMerged: empty });

    expect(result.releaseReservation).toBe(false);
    expect(result.claim.topic).toBe("B2B SaaS");
    expect(result.claim.source).toBe("research");
    expect(result.claim.mode).toBe("deep-value");
    expect(result.claim.scoutStatus).toBe("ran");
    // The refused story is still carried to the gate — the reviewer sees what
    // the floor turned down, which is the road not taken, not a secret.
    expect(result.claim.alternatives).toEqual([expect.objectContaining({ topic: weak.topic, reason: "lower-rank" })]);
    expect(result.claim.weighting?.rule).toMatch(/^no scouted story cleared brand fit 3 and no fetched headline was usable — the client's declared industry leads$/);
    // `considered` is candidates + skipped: 1 + 2. `bestFit` is the best
    // brand fit anything reached. `floor` is `MIN_BRAND_FIT`, unmoved.
    expect((result.claim.weighting as BelowFloorWeighting).belowFloor).toEqual({ considered: 3, bestFit: 2, floor: 3 });
    expect(result.claim.weighting?.bestCandidateScore).toBe(10);
    // And the premise: the story really was below the floor. Without this the
    // case would pass if branch 6 had silently become the only branch.
    expect(weak.brandFit).toBeLessThan((result.claim.weighting as BelowFloorWeighting).belowFloor.floor);
  });

  it("leads with the industry, naming the scout status, when the scout never ran and there are no documents", () => {
    const result = resolveTopicClaim(researchSeed, undefined, "deep-value", { ...NO_HISTORY, scoutStatus: "no-documents" });
    expect(result.claim.topic).toBe("B2B SaaS");
    expect(result.claim.source).toBe("research");
    expect(result.claim.scoutStatus).toBe("no-documents");
    expect(result.claim.alternatives).toEqual([]);
    // Nothing was scored, so there is no score to report — absent, not zero.
    expect(result.claim.weighting?.bestCandidateScore).toBeUndefined();
    expect((result.claim.weighting as BelowFloorWeighting).belowFloor).toEqual({ considered: 0, bestFit: 0, floor: 3 });
  });

  it("never turns the empty-search query into the subject: an untitled document is still treated as nothing", () => {
    // The query is deliberately NOT the seed, so "the subject is the industry"
    // and "the subject is the query" are distinguishable outcomes.
    const merged: ResearchPullResult = { runId: "r2", query: "B2B SaaS trends this week", fromCache: false, result: { documents: [{ url: "https://example.test/untitled", content: "…" }] } };
    const result = resolveTopicClaim(researchSeed, scoutWith(), "deep-value", { ...NO_HISTORY, trendResearchMerged: merged });
    // The half this branch must NOT change: branch 4 is still refused (an
    // untitled document is not a headline), so the subject is the client's
    // declared industry — never `merged.query`, which is what RFC-13 §E
    // deleted and what a "just use what you have" fallback would resurrect.
    expect(result.claim.topic).toBe("B2B SaaS");
    expect(result.claim.topic).not.toBe(merged.query);
    expect(result.claim.weighting?.rule).toMatch(/no fetched headline was usable/);
  });

  it("has no hold to return at all — the member is gone from the type, not merely unreachable", () => {
    // Six shapes that used to reach the hold, one per reason. If a later
    // change re-introduces a hold on any of them this fails on `claim`
    // being undefined rather than by a type error nobody runs.
    const shapes: Array<[string, ReturnType<typeof resolveTopicClaim>]> = [
      ["nothing at all", resolveTopicClaim(researchSeed, undefined, "deep-value", NO_HISTORY)],
      ["an empty scout", resolveTopicClaim(researchSeed, scoutWith(), "hot-news", NO_HISTORY)],
      ["everything below the floor", resolveTopicClaim(researchSeed, scoutWith(candidate({ brandFit: 1 })), "deep-value", NO_HISTORY)],
      ["a scout that could not run", resolveTopicClaim(researchSeed, undefined, "deep-value", { ...NO_HISTORY, scoutStatus: "unavailable" })],
      [
        "documents with no titles",
        resolveTopicClaim(researchSeed, scoutWith(), "deep-value", {
          ...NO_HISTORY,
          trendResearchMerged: { runId: "r", query: "q", fromCache: false, result: { documents: [{ url: "https://x.test/1" }] } },
        }),
      ],
      ["every story already covered", resolveTopicClaim(researchSeed, scoutWith(candidate({ topic: "AI triage" })), "deep-value", { ...NO_HISTORY, avoidTopics: ["ai triage"] })],
    ];

    for (const [why, result] of shapes) {
      expect(result.claim, why).toBeDefined();
      expect(result.claim.topic, why).toBe("B2B SaaS");
      expect(Object.keys(result), why).not.toContain("hold");
    }
  });

  it("caps the alternatives it carries to the gate", () => {
    const many = Array.from({ length: 9 }, (_, i) => candidate({ topic: `story ${i}`, headline: `headline ${i}`, brandFit: 4, interest: 3 }));
    const result = resolveTopicClaim(requestedSeed, scoutWith(...many), "deep-value", NO_HISTORY);
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

  it("no longer charges an evergreen angle a second time for being undated, and still ranks it below the week's mode", () => {
    // ── THE 0.8 IS GONE (2026-09-20). ──
    //
    // An evergreen angle is undated by definition, so it already sits at
    // freshness 1.0 while a dated story reaches 1.35. The extra off-mode 0.8
    // took the same fact out of its score twice, and the two together came to
    // a handicap no brand fit could clear: on karoslabs' run
    // `pubsub-21904879061334183` the best evergreen idea scored 15.74 against
    // 38.81 for a news item, and the feed published its third AI-search post
    // in a row.
    //
    // What remains is the MODE bonus, which is the honest half of the
    // distinction and still says evergreen is what a deep-value week is for.
    const evergreen = candidate({ topic: "what practitioners get wrong about retainers", engine: "evergreen", mode: "deep-value" });
    const onDeepValue = rankTopicCandidates([evergreen], { ...RANK_BASE, mode: "deep-value" });
    expect(onDeepValue.ranked[0]!.components.engineBonus).toBe(1);

    const onHotNews = rankTopicCandidates([evergreen], { ...RANK_BASE, mode: "hot-news" });
    expect(onHotNews.ranked[0]!.components).toMatchObject({ engineBonus: 1, modeBonus: 1 });
    // Still lower on a news week — carried by the mode bonus alone now.
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
    expect(result.claim.topic).toBe(requestedSeed.topic);
    expect(result.claim.alternatives).toEqual([
      expect.objectContaining({ topic: assetStory.topic, engine: "own-assets", reason: "outranked-by-request", score: pre.ranked[0]!.score }),
      expect.objectContaining({ topic: questionStory.topic, engine: "audience-questions", reason: "outranked-by-request" }),
    ]);
    expect(result.claim.weighting?.bestCandidateScore).toBe(pre.ranked[0]!.score);
  });

  /**
   * CHANGED BY PHASE 5.5 (spec §6 G5.1). `assetStory` is the client's own case
   * study, in this run's mode, for a client with an offer, so the ranking gives
   * it `5 × 5 × 1 × 1.15 × 1.5 = 43.125` — above anything the scout's own two
   * judgments can award (25, or 28.75 with the mode bonus) and therefore above
   * `PLANNED_ROW_SCORE / CATALOG_MIN_FIT_RATIO = 30`.
   *
   * The row used to keep its slot against it unconditionally, which is the rule
   * that shipped thepitchbydeel's 2026-09-16 post from a catalog row seeded with
   * another client's subject matter. It now loses on FIT, and the reason string
   * says which of the two rules took it. A row the field beats by less than that
   * factor is still untouchable without `trendJacking` — the case two tests up
   * pins, and `topic-catalog-and-format.test.ts` measures the boundary.
   */
  it("lets an own-asset story outclass a planned row on FIT, and trend-jacking still displaces it by its own rule", () => {
    const pre = ranked();
    expect(pre.ranked[0]!.score).toBeGreaterThan(PLANNED_ROW_SCORE / CATALOG_MIN_FIT_RATIO);

    const onFit = resolveTopicClaim(reservedSeed, scoutWith(assetStory, questionStory), "deep-value", { ...NO_HISTORY, ranked: pre });
    expect(onFit.claim.source).toBe("trend");
    expect(onFit.claim.topic).toBe(assetStory.topic);
    expect(onFit.releaseReservation).toBe(true);
    expect(onFit.claim.weighting?.rule).toMatch(/lost its slot on fit/);
    expect(onFit.claim.weighting?.rule).not.toMatch(/trendJacking is "always"/);

    const jacked = resolveTopicClaim(reservedSeed, scoutWith(assetStory, questionStory), "deep-value", { ...NO_HISTORY, ranked: pre, trendJacking: "always" });
    expect(jacked.claim.source).toBe("trend");
    expect(jacked.claim.topic).toBe(assetStory.topic);
    expect(jacked.releaseReservation).toBe(true);
    expect(jacked.claim.alternatives![0]).toMatchObject({ topic: reservedSeed.topic, reason: "outranked-by-trend" });
  });

  it("takes the ranking's winner for a research seed and states which engine won and why", () => {
    const pre = ranked();
    const result = resolveTopicClaim(researchSeed, scoutWith(assetStory, questionStory), "deep-value", { ...NO_HISTORY, ranked: pre });
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

/**
 * # RECENCY WAS A TIE-BREAKER, SO IT NEVER REACHED A REAL RANKING
 *
 * `publishedAt` appeared exactly once in this module: in the comparator, after
 * the score and after `hasNumbers`. Two candidates with different scores never
 * got that far. So an evergreen abstraction beat anything that happened this
 * week, every time, and all three prep carousels of 2026-09-18 opened on one.
 *
 * The owner: *"it is important that the topics are sometimes trendy or about
 * something new that came out."* It is also upstream of the image problem: a
 * post about a real, named, recent thing gives the picture something real to
 * show, and a post about a metaphor gives it a pocket watch.
 */
const NOW = new Date("2026-09-18T12:00:00Z");
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("freshnessBonus", () => {
  it("rewards this week and leaves a month ago alone", () => {
    expect(freshnessBonus(daysAgo(1), NOW)).toBe(1.35);
    expect(freshnessBonus(daysAgo(5), NOW)).toBe(1.25);
    expect(freshnessBonus(daysAgo(12), NOW)).toBe(1.12);
    expect(freshnessBonus(daysAgo(25), NOW)).toBe(FRESHNESS_NEUTRAL);
  });

  it("treats an UNDATED candidate as neutral, because an absent date is not evidence of age", () => {
    // Most good evergreen ideas have no date. Punishing them would be guessing.
    expect(freshnessBonus(undefined, NOW)).toBe(FRESHNESS_NEUTRAL);
    expect(freshnessBonus("   ", NOW)).toBe(FRESHNESS_NEUTRAL);
    expect(freshnessBonus("not a date", NOW)).toBe(FRESHNESS_NEUTRAL);
  });

  it("makes a five-week-old news peg compete as the evergreen idea it has become", () => {
    expect(freshnessBonus(daysAgo(35), NOW)).toBe(FRESHNESS_STALE);
    expect(FRESHNESS_STALE).toBeLessThan(FRESHNESS_NEUTRAL);
  });

  it("does not reward a date in the FUTURE, which is a clock skew and not a scoop", () => {
    expect(freshnessBonus(new Date(NOW.getTime() + 5 * 86_400_000).toISOString(), NOW)).toBe(1.35);
    expect(freshnessBonus(new Date(NOW.getTime() + 400 * 86_400_000).toISOString(), NOW)).toBe(1.35);
  });
});

describe("rankTopicCandidates: recency now reaches the score", () => {
  it("prefers this week's story over an equally strong evergreen one", () => {
    const evergreen = candidate({ topic: "retainer scopes drift in month three", brandFit: 4, interest: 4, publishedAt: undefined });
    const thisWeek = candidate({ topic: "a vendor shipped agent guardrails", brandFit: 4, interest: 4, publishedAt: daysAgo(2) });
    const ranked = rankTopicCandidates([evergreen, thisWeek], { ...RANK_BASE, now: NOW });
    expect(ranked.chosen).toBe(thisWeek);
    expect(scoreOf(ranked, thisWeek.topic)).toBeGreaterThan(scoreOf(ranked, evergreen.topic));
  });

  it("does NOT let freshness beat a real brand-fit gap, because it is a nudge and not a veto", () => {
    // 1.35 is smaller than the spread brandFit and interest can open, which is
    // the intended weight: a fresh story the client has no business telling
    // still loses.
    const fresh = candidate({ topic: "an unrelated consumer launch", brandFit: 3, interest: 3, publishedAt: daysAgo(1) });
    const fitting = candidate({ topic: "how onboarding time actually falls", brandFit: 5, interest: 5, publishedAt: undefined });
    const ranked = rankTopicCandidates([fresh, fitting], { ...RANK_BASE, now: NOW });
    expect(ranked.chosen).toBe(fitting);
  });

  it("reports the factor it applied, so a boring week is diagnosable rather than mysterious", () => {
    const ranked = rankTopicCandidates([candidate({ topic: "x", publishedAt: daysAgo(2) })], { ...RANK_BASE, now: NOW });
    expect(ranked.ranked[0]!.components.freshness).toBe(1.35);
  });
});
