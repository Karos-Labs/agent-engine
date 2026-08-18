import { describe, expect, it } from "vitest";
import { computeVisibilityMetrics } from "../src/visibility-metrics.js";
import { computeVisibilityIndex } from "../src/visibility-index.js";
import type { SeoGeoCaptureCell } from "../src/types.js";

/**
 * Hand-computed fixture: 2 prompts (N=2), capture data only for `chatgpt`
 * (the other 4 engines are present in the config but have zero cells here,
 * which — using the default `N` denominator — still contributes 0s to the
 * blend rather than being skipped, exactly matching the stored formulas'
 * literal `/N` division).
 */
const cells: SeoGeoCaptureCell[] = [
  {
    promptId: "p1",
    engine: "chatgpt",
    captureTier: "MEASURED",
    brandMentioned: true,
    brandFirstMentionCharOffset: 10,
    brandCited: true,
    brandFirstCitationOrdinal: 1,
    competitorsNamed: [],
    citations: [{ domain: "client.com", ordinal: 1 }],
    mentionCounts: { client: 2, competitorA: 1 },
    sentimentPerMention: [{ mentionIndex: 0, label: "pos" }],
  },
  {
    promptId: "p2",
    engine: "chatgpt",
    captureTier: "UNAVAILABLE",
    brandMentioned: false,
    brandCited: false,
    competitorsNamed: [{ brandId: "competitorA", charOffset: 5 }],
    citations: [],
    mentionCounts: { competitorA: 1 },
    sentimentPerMention: [],
  },
];

function fixtureMetrics() {
  return computeVisibilityMetrics({
    cells,
    promptCount: 2,
    clientDomains: ["client.com"],
    competitorRoster: ["competitorA"],
  });
}

describe("computeVisibilityMetrics (seo-geo-scoring-config.json visibility.metrics, N denominator by default)", () => {
  it("computes per-engine citation_share, mention_share, ghost_citation_rate and first_position_rate for the engine with capture data", () => {
    const metrics = fixtureMetrics();
    const chatgpt = metrics.perEngine.find((e) => e.engine === "chatgpt")!;
    expect(chatgpt.citationShare).toBeCloseTo(0.5); // 1 cited / N=2
    expect(chatgpt.mentionShare).toBeCloseTo(0.5); // 1 named / N=2
    expect(chatgpt.ghostCitationRate).toBe(0); // the only citation was also named — no ghosting
    expect(chatgpt.firstPositionRate).toBeCloseTo(0.5); // p1 was first-cited, p2 wasn't
    expect(chatgpt.netSentiment).toBe(1); // 1 pos, 0 neg, 1 total mention
  });

  it("engines with zero captured cells report all-zero metrics rather than being omitted from the blend", () => {
    const metrics = fixtureMetrics();
    const gemini = metrics.perEngine.find((e) => e.engine === "gemini")!;
    expect(gemini.citationShare).toBe(0);
    expect(gemini.mentionShare).toBe(0);
    expect(gemini.netSentiment).toBe(0);
  });

  it("citation_share_blended and mention_rate_blended average across all 5 fixed engines, not just the ones with data", () => {
    const metrics = fixtureMetrics();
    expect(metrics.citationShareBlended).toBeCloseTo(0.1); // (0.5+0+0+0+0)/5
    expect(metrics.mentionRateBlended).toBeCloseTo(0.1); // 1 named-slot / (N=2 * 5 engines)
  });

  it("share_of_voice: client mentions / (client+roster mentions) across the whole capture set", () => {
    const metrics = fixtureMetrics();
    expect(metrics.shareOfVoiceClient).toBeCloseTo(50); // client=2, competitorA=2, 2/4*100
  });

  it("rank_first_competitor identifies the competitor who most often independently achieves first(p,e)", () => {
    const metrics = fixtureMetrics();
    expect(metrics.rankFirstCompetitor).toBe("competitorA");
  });
});

describe("BOTH-14 first(p,e) fidelity regression (parity audit P0: a competitor named anywhere must not disqualify a genuinely-first client)", () => {
  it("the client still ranks first when named BEFORE a competitor in the same answer, even though a competitor is also named", () => {
    const metrics = computeVisibilityMetrics({
      cells: [
        {
          promptId: "p1",
          engine: "chatgpt",
          captureTier: "MEASURED",
          brandMentioned: true,
          brandFirstMentionCharOffset: 10,
          brandCited: false,
          competitorsNamed: [{ brandId: "competitorA", charOffset: 200 }], // named well after the client
          citations: [],
          mentionCounts: { client: 1, competitorA: 1 },
          sentimentPerMention: [],
        },
      ],
      promptCount: 1,
      clientDomains: ["client.com"],
      competitorRoster: ["competitorA"],
    });
    const chatgpt = metrics.perEngine.find((e) => e.engine === "chatgpt")!;
    expect(chatgpt.firstPositionRate).toBe(1); // client was genuinely first — a competitor merely appearing later must not disqualify it
    expect(metrics.rankFirstCompetitor).toBeNull(); // competitorA never independently achieved "first" here
  });

  it("the client does NOT rank first when a competitor is named before it and the client isn't cited first either", () => {
    const metrics = computeVisibilityMetrics({
      cells: [
        {
          promptId: "p1",
          engine: "chatgpt",
          captureTier: "MEASURED",
          brandMentioned: true,
          brandFirstMentionCharOffset: 200,
          brandCited: false,
          competitorsNamed: [{ brandId: "competitorA", charOffset: 10 }], // named before the client
          citations: [],
          mentionCounts: { client: 1, competitorA: 1 },
          sentimentPerMention: [],
        },
      ],
      promptCount: 1,
      clientDomains: ["client.com"],
      competitorRoster: ["competitorA"],
    });
    const chatgpt = metrics.perEngine.find((e) => e.engine === "chatgpt")!;
    expect(chatgpt.firstPositionRate).toBe(0);
    expect(metrics.rankFirstCompetitor).toBe("competitorA");
  });

  it("naming and citation can crown different entities in the same cell — first(p,e) is evaluated per-entity, not winner-take-all", () => {
    // competitorA is named first (offset 5), but the client's own domain is the first CITATION (ordinal 1) —
    // both the client (via first_cited) and competitorA (via first_named) independently satisfy first(p,e).
    const metrics = computeVisibilityMetrics({
      cells: [
        {
          promptId: "p1",
          engine: "chatgpt",
          captureTier: "MEASURED",
          brandMentioned: true,
          brandFirstMentionCharOffset: 300,
          brandCited: true,
          brandFirstCitationOrdinal: 1,
          competitorsNamed: [{ brandId: "competitorA", charOffset: 5 }],
          citations: [{ domain: "client.com", ordinal: 1 }],
          mentionCounts: { client: 1, competitorA: 1 },
          sentimentPerMention: [],
        },
      ],
      promptCount: 1,
      clientDomains: ["client.com"],
      competitorRoster: ["competitorA"],
    });
    const chatgpt = metrics.perEngine.find((e) => e.engine === "chatgpt")!;
    expect(chatgpt.firstPositionRate).toBe(1); // client wins via first_cited despite being named last
    expect(metrics.rankFirstCompetitor).toBe("competitorA"); // competitorA still wins via first_named
  });

  it("a competitor's own domain being cited first counts toward rank_first_competitor when competitorDomains is supplied", () => {
    const metrics = computeVisibilityMetrics({
      cells: [
        {
          promptId: "p1",
          engine: "chatgpt",
          captureTier: "MEASURED",
          brandMentioned: false,
          brandCited: false,
          competitorsNamed: [],
          citations: [{ domain: "competitor-a.com", ordinal: 1 }],
          mentionCounts: { competitorA: 1 },
          sentimentPerMention: [],
        },
      ],
      promptCount: 1,
      clientDomains: ["client.com"],
      competitorRoster: ["competitorA"],
      competitorDomains: { competitorA: ["competitor-a.com"] },
    });
    expect(metrics.rankFirstCompetitor).toBe("competitorA");
  });
});

describe("computeVisibilityIndex (seo-geo-scoring-config.json visibility.index, 6 weighted components)", () => {
  it("matches the hand-computed index for the fixture (round_half_up(69.6) = 70)", () => {
    const metrics = fixtureMetrics();
    const result = computeVisibilityIndex(metrics);
    expect(result.index).toBe(70);

    const byName = Object.fromEntries(result.componentNorms.map((c) => [c.name, c.norm]));
    expect(byName.citation_share).toBeCloseTo(1); // 0.1 / TARGET_CITE(0.1), clamped to 1
    expect(byName.who_ranks_first).toBeCloseTo(0.1);
    expect(byName.share_of_voice).toBeCloseTo(1); // (50/100) / (1/rosterSize=2) = 1
    expect(byName.named_mention_rate).toBeCloseTo(0.1 / 0.3);
    expect(byName.sentiment).toBeCloseTo(0.6); // (meanNetSentiment 0.2 + 1) / 2
    expect(byName.ghost_penalty).toBeCloseTo(1); // no ghost citations at all
  });

  it("weights sum to 100 (seo-geo-scoring-config.json visibility.index.weight_total)", () => {
    const metrics = fixtureMetrics();
    const result = computeVisibilityIndex(metrics);
    const weightSum = result.componentNorms.reduce((sum, c) => sum + c.weight, 0);
    expect(weightSum).toBe(100);
  });
});
