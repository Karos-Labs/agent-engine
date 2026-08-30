import { describe, expect, it } from "vitest";
import { MIN_ANSWERS_FOR_RATE, VISIBILITY_DENOMINATOR_DECISION, computeVisibilityMetrics, publishRate } from "../src/visibility-metrics.js";
import { computeVisibilityIndex } from "../src/visibility-index.js";
import type { SeoGeoCaptureCell, VisibilityCohort } from "../src/types.js";

/**
 * Hand-computed fixture: 2 prompts (N=2), capture data only for `chatgpt`, and
 * one of its two cells UNAVAILABLE (so N_e=1 there and N_e differs from N —
 * the whole point of the denominator decision). The other 4 engines are present
 * in the config but have zero cells here; they still contribute their raw `N`
 * slots to the blended Index rather than being skipped, exactly matching the
 * stored formulas' literal `/N` division.
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

describe("computeVisibilityMetrics (seo-geo-scoring-config.json visibility.metrics; per-engine rates on N_e)", () => {
  it("computes per-engine citation_share, mention_share, ghost_citation_rate and first_position_rate for the engine with capture data", () => {
    const metrics = fixtureMetrics();
    const chatgpt = metrics.perEngine.find((e) => e.engine === "chatgpt")!;
    // SCRUM-319: per-engine rates divide by N_e, so p2 (UNAVAILABLE) leaves the
    // denominator entirely — chatgpt answered once and the client was cited in it.
    expect(chatgpt.nEffective).toBe(1);
    expect(chatgpt.n).toBe(2); // N is printed alongside N_e, always
    expect(chatgpt.denominatorUsed).toBe("N_e");
    expect(chatgpt.citationShare).toBeCloseTo(1); // 1 cited / N_e=1
    expect(chatgpt.mentionShare).toBeCloseTo(1); // 1 named / N_e=1
    expect(chatgpt.ghostCitationRate).toBe(0); // the only citation was also named — no ghosting
    expect(chatgpt.firstPositionRate).toBeCloseTo(1); // the one answer was first-cited
    expect(chatgpt.netSentiment).toBe(1); // 1 pos, 0 neg, 1 total mention
  });

  it("engines with zero captured cells report all-zero metrics rather than being omitted from the blend", () => {
    const metrics = fixtureMetrics();
    const gemini = metrics.perEngine.find((e) => e.engine === "gemini")!;
    expect(gemini.citationShare).toBe(0);
    expect(gemini.mentionShare).toBe(0);
    expect(gemini.netSentiment).toBe(0);
  });

  it("citation_share_blended and mention_rate_blended span all 5 fixed engines, not just the ones with data", () => {
    const metrics = fixtureMetrics();
    expect(metrics.citationShareBlended).toBeCloseTo(0.1); // 1 cited-slot / (N=2 * 5 engines)
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

/**
 * SCRUM-319 acceptance 3. v2 closed `seo-geo-capture-config.json`'s
 * `open_scoring_decisions.N_vs_N_e` on 2026-08-20 (ratified in
 * `docs/AUDIT-2026-08-25-architecture-optimization-plan.md` §4c.2): per-engine
 * rates use N_e, the blended Index uses N, both counts always printed. The
 * `denominator` parameter that existed only to keep the decision visible is
 * therefore retired — it is still accepted, but it selects nothing, and the
 * request is echoed back so an ignored request is visible in the data.
 */
describe("the N vs N_e denominator decision is resolved, not pending", () => {
  const requested = (denominator: "N" | "N_e") =>
    computeVisibilityMetrics({
      cells,
      promptCount: 2,
      clientDomains: ["client.com"],
      competitorRoster: ["competitorA"],
      denominator,
    });

  it("carries a resolved decision record on every result, never a 'pending' status", () => {
    const metrics = fixtureMetrics();
    expect(metrics.denominatorDecision).toEqual(VISIBILITY_DENOMINATOR_DECISION);
    expect(metrics.denominatorDecision.status).toBe("resolved");
    expect(metrics.denominatorDecision.status).not.toBe("pending");
    expect(metrics.denominatorDecision.perEngineRates).toBe("N_e");
    expect(metrics.denominatorDecision.blendedIndex).toBe("N");
    expect(metrics.denominatorDecision.bothAlwaysPrinted).toBe(true);
  });

  it("prints BOTH N and N_e on every per-engine row, so neither can stand in for the other", () => {
    const metrics = fixtureMetrics();
    for (const engine of metrics.perEngine) {
      expect(engine.n).toBe(2);
      expect(typeof engine.nEffective).toBe("number");
      expect(engine.denominatorUsed).toBe("N_e");
    }
    expect(metrics.perEngine.find((e) => e.engine === "chatgpt")!.nEffective).toBe(1); // p2 is UNAVAILABLE
  });

  it("the retired `denominator` request changes no number, and is echoed back rather than swallowed", () => {
    const asN = requested("N");
    const asNe = requested("N_e");
    expect(asN.denominatorRequested).toBe("N");
    expect(asNe.denominatorRequested).toBe("N_e");
    expect(fixtureMetrics().denominatorRequested).toBeNull(); // nothing asked

    // Identical numbers either way: the decision is closed, so the request is inert.
    expect(asNe.perEngine).toEqual(asN.perEngine);
    expect(asNe.citationShareBlended).toBe(asN.citationShareBlended);
    expect(asNe.mentionRateBlended).toBe(asN.mentionRateBlended);
    expect(computeVisibilityIndex(asNe).index).toBe(computeVisibilityIndex(asN).index);
  });

  it("the blended aggregates divide by N (raw prompt slots), not by N_e", () => {
    const metrics = fixtureMetrics();
    // 1 named / (N=2 x 5 engines) = 0.1. Under N_e the denominator would be the
    // 1 answer that exists, giving 1.0 — the Index must not move with capture luck.
    expect(metrics.mentionRateBlended).toBeCloseTo(0.1);
    expect(metrics.citationShareBlended).toBeCloseTo(0.1);
    expect(metrics.firstPositionRateBlended).toBeCloseTo(0.1);
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

// ---------------------------------------------------------------------------
// SCRUM-319 — Known vs Found, never blended (v2, 2026-08-20; audit §4c.2)
// ---------------------------------------------------------------------------

function answer(promptId: string, named: boolean): SeoGeoCaptureCell {
  return {
    promptId,
    engine: "chatgpt",
    captureTier: "MEASURED",
    brandMentioned: named,
    brandFirstMentionCharOffset: named ? 10 : undefined,
    brandCited: false,
    competitorsNamed: [],
    citations: [],
    mentionCounts: named ? { client: 1 } : {},
    sentimentPerMention: [],
  };
}

/** `count` answers for one cohort, the first `named` of which name the client. */
function cohort(prefix: string, count: number, named: number): SeoGeoCaptureCell[] {
  return Array.from({ length: count }, (_, i) => answer(`${prefix}${i + 1}`, i < named));
}

function cohortMap(cells: readonly SeoGeoCaptureCell[], assigned: VisibilityCohort): Record<string, VisibilityCohort> {
  return Object.fromEntries(cells.map((c) => [c.promptId, assigned]));
}

/** Every number reachable in a result, for "this figure exists nowhere" assertions. */
function everyNumberIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) for (const item of value) everyNumberIn(item, out);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) everyNumberIn(item, out);
  return out;
}

describe("KNOWN and FOUND are reported separately and never averaged", () => {
  // KNOWN: 12 answers, all 12 name the client -> 100%.
  // FOUND: 10 answers, 3 name the client      ->  30%.
  // The retired blend would publish their average, 65% ("you appear 65% of the time"),
  // a number that describes no population at all. The pooled rate (15/22 = 68.2%) is a
  // different wrong answer; neither is published as a visibility figure.
  const knownCells = cohort("k", 12, 12);
  const foundCells = cohort("f", 10, 3);
  const allCells = [...knownCells, ...foundCells];
  const promptCohorts = { ...cohortMap(knownCells, "known"), ...cohortMap(foundCells, "found") };

  function metrics() {
    return computeVisibilityMetrics({
      cells: allCells,
      promptCount: allCells.length,
      clientDomains: ["client.com"],
      competitorRoster: [],
      promptCohorts,
    });
  }

  it("publishes the two cohorts side by side, each against its own answers", () => {
    const knownVsFound = metrics().knownVsFound;
    expect(knownVsFound.cohortsScoped).toBe(true);
    expect(knownVsFound.knownPromptCount).toBe(12);
    expect(knownVsFound.foundPromptCount).toBe(10);

    const known = knownVsFound.known.find((r) => r.engine === "chatgpt")!;
    const found = knownVsFound.found.find((r) => r.engine === "chatgpt")!;
    expect(known.nEffective).toBe(12);
    expect(found.nEffective).toBe(10);
    expect(known.named.ratePct).toBeCloseTo(100);
    expect(found.named.ratePct).toBeCloseTo(30);
    expect(known.named.display).toBe("100.0%");
    expect(found.named.display).toBe("30.0%");
  });

  it("carries the never_blend marker on the report and on every row, so the rule travels with the data", () => {
    const knownVsFound = metrics().knownVsFound;
    expect(knownVsFound.neverBlend).toBe(true);
    for (const row of [...knownVsFound.known, ...knownVsFound.found]) {
      expect(row.neverBlend).toBe(true);
    }
  });

  it("exposes no combined KNOWN+FOUND field — the blended visibility score is retired", () => {
    const knownVsFound = metrics().knownVsFound;
    expect(Object.keys(knownVsFound).sort()).toEqual(
      ["cohortsScoped", "foundPromptCount", "found", "known", "knownPromptCount", "neverBlend", "unclassifiedPromptIds"].sort(),
    );
  });

  it("no code path produces the average of the two cohorts: 65 appears nowhere in the result or the index", () => {
    const result = metrics();
    const knownRate = result.knownVsFound.known.find((r) => r.engine === "chatgpt")!.named.ratePct!;
    const foundRate = result.knownVsFound.found.find((r) => r.engine === "chatgpt")!.named.ratePct!;
    const blended = (knownRate + foundRate) / 2;
    expect(blended).toBeCloseTo(65); // the number v2 retired

    const published = [...everyNumberIn(result), ...everyNumberIn(computeVisibilityIndex(result))];
    expect(published.length).toBeGreaterThan(0);
    for (const value of published) {
      expect(Math.abs(value - blended)).toBeGreaterThan(1e-9);
    }
  });

  it("classifies nothing when no cohort map is supplied, rather than folding every prompt into one cohort", () => {
    const unscoped = computeVisibilityMetrics({
      cells: allCells,
      promptCount: allCells.length,
      clientDomains: ["client.com"],
      competitorRoster: [],
    });
    expect(unscoped.knownVsFound.cohortsScoped).toBe(false);
    expect(unscoped.knownVsFound.known).toEqual([]);
    expect(unscoped.knownVsFound.found).toEqual([]);
    expect(unscoped.knownVsFound.unclassifiedPromptIds).toHaveLength(22);
  });

  it("a prompt missing from the cohort map is reported unclassified, never guessed into a cohort", () => {
    const partial = computeVisibilityMetrics({
      cells: allCells,
      promptCount: allCells.length,
      clientDomains: ["client.com"],
      competitorRoster: [],
      promptCohorts: cohortMap(knownCells, "known"), // the 10 FOUND prompts are unlisted
    });
    expect(partial.knownVsFound.unclassifiedPromptIds).toEqual(foundCells.map((c) => c.promptId).sort());
    expect(partial.knownVsFound.found.every((r) => r.nEffective === 0)).toBe(true);
    expect(partial.knownVsFound.known.find((r) => r.engine === "chatgpt")!.nEffective).toBe(12);
  });
});

describe("an engine with fewer than 10 answers publishes counts, not percentages", () => {
  // 7 answers is the whole point: "3 of 7" is honest, "42.9%" reads as a measurement.
  const foundCells = cohort("f", 7, 3);

  function thinEngine() {
    return computeVisibilityMetrics({
      cells: foundCells,
      promptCount: 7,
      clientDomains: ["client.com"],
      competitorRoster: [],
      promptCohorts: cohortMap(foundCells, "found"),
    }).knownVsFound.found.find((r) => r.engine === "chatgpt")!;
  }

  it("renders as a count, with no percentage available to print", () => {
    const row = thinEngine();
    expect(row.nEffective).toBe(7);
    expect(row.nEffective).toBeLessThan(MIN_ANSWERS_FOR_RATE);
    expect(row.countsOnly).toBe(true);
    expect(row.named.countsOnly).toBe(true);
    expect(row.named.count).toBe(3);
    expect(row.named.answers).toBe(7);
    expect(row.named.ratePct).toBeNull(); // null, not 0 and not a rounded 42.9
    expect(row.named.display).toBe("3 of 7 answers");
    expect(row.named.display).not.toMatch(/%/);
  });

  it("applies to every figure on the row, not just the headline one", () => {
    const row = thinEngine();
    for (const figure of [row.named, row.cited, row.first]) {
      expect(figure.ratePct).toBeNull();
      expect(figure.display).toMatch(/^\d+ of 7 answers$/);
    }
  });

  it("an engine with no answers at all publishes 0 of 0, never a 0%", () => {
    const gemini = computeVisibilityMetrics({
      cells: foundCells,
      promptCount: 7,
      clientDomains: ["client.com"],
      competitorRoster: [],
      promptCohorts: cohortMap(foundCells, "found"),
    }).knownVsFound.found.find((r) => r.engine === "gemini")!;
    expect(gemini.named.display).toBe("0 of 0 answers");
    expect(gemini.named.ratePct).toBeNull();
  });

  it("the floor is exactly 10 answers: 9 publishes a count, 10 publishes a percentage", () => {
    expect(MIN_ANSWERS_FOR_RATE).toBe(10);
    expect(publishRate(3, 9).ratePct).toBeNull();
    expect(publishRate(3, 9).display).toBe("3 of 9 answers");
    expect(publishRate(3, 10).ratePct).toBeCloseTo(30);
    expect(publishRate(3, 10).display).toBe("30.0%");
  });

  it("UNAVAILABLE cells are not counted as answers — a capture gap never dilutes a published figure", () => {
    const withGap = [...cohort("f", 7, 3), { ...answer("f8", false), captureTier: "UNAVAILABLE" as const }];
    const row = computeVisibilityMetrics({
      cells: withGap,
      promptCount: 8,
      clientDomains: ["client.com"],
      competitorRoster: [],
      promptCohorts: cohortMap(withGap, "found"),
    }).knownVsFound.found.find((r) => r.engine === "chatgpt")!;
    expect(row.n).toBe(8); // N: every prompt in the cohort
    expect(row.nEffective).toBe(7); // N_e: the ones that came back with an answer
    expect(row.named.display).toBe("3 of 7 answers");
  });
});
