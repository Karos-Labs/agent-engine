import { CONSTANTS, VISIBILITY_ENGINES_CONFIG } from "./scoring-config.js";
import type { PerEngineVisibilityMetrics, SeoGeoCaptureCell, SeoGeoVisibilityEngine, VisibilityDenominator, VisibilityMetricsResult } from "./types.js";

/**
 * Raw per-engine visibility metrics, ported verbatim from
 * `seo-geo-scoring-config.json` `visibility.metrics[]`. The stored formulas
 * divide by `N` (raw frozen prompt count), not `N_e` (measured-only count) —
 * `seo-geo-capture-config.json`'s `open_scoring_decisions.N_vs_N_e` flags
 * this as an unresolved, BLOCKING decision pending sign-off ("Daniel").
 * `denominator` defaults to `"N"` to match the config as currently written;
 * pass `"N_e"` to compute the alternative without recapturing anything —
 * both counts are frozen per capture cell for exactly this reason. This is
 * a decision surfaced as a parameter, never silently picked.
 */
export interface ComputeVisibilityMetricsOptions {
  cells: readonly SeoGeoCaptureCell[];
  /** The frozen prompt count (`N`) — shared across all 5 engines by construction (one fixed prompt set). */
  promptCount: number;
  clientDomains: readonly string[];
  competitorRoster: readonly string[];
  /** brandId -> that competitor's own domains — enables the citation leg of "first" for competitors, symmetric to `clientDomains`. Omit (or pass `{}`) when no competitor domain roster is known yet; competitors are then judged on the named leg alone, never fabricated. */
  competitorDomains?: Readonly<Record<string, readonly string[]>>;
  denominator?: VisibilityDenominator;
}

function denominatorFor(engineCells: readonly SeoGeoCaptureCell[], promptCount: number, denominator: VisibilityDenominator): number {
  if (denominator === "N") return promptCount;
  return engineCells.filter((c) => c.captureTier !== "UNAVAILABLE").length;
}

interface FirstFlags {
  /** True if the client is BOTH-14's `first(p,e)` for this cell: named before every competitor, or cited first. */
  clientFirst: boolean;
  /** Every competitor (by brandId) that independently satisfies `first(p,e)` in this cell — naming and citation can crown different entities in the same answer, so this is a set, not a single winner. */
  competitorFirsts: Set<string>;
}

/**
 * BOTH-14: `first(p,e) = max(first_named, first_cited)`. `first_named` is
 * "this entity's first mention preceded every other named entity's" (a
 * strict min-offset comparison across client + all named competitors, per
 * `seo-geo-capture-config.json`'s `competitors_named[].char_offset` field);
 * `first_cited` is "this entity's domain is the very first citation
 * (ordinal 1)". The two legs can crown different entities in the same
 * answer (e.g. the client is named first, but a competitor's domain happens
 * to be cited first) — this is evaluated per-entity, not as a single
 * winner-take-all per cell, matching the formula's literal boolean-OR
 * semantics applied independently to each entity.
 */
function evaluateFirstFlags(cell: SeoGeoCaptureCell, competitorDomains: Readonly<Record<string, readonly string[]>>): FirstFlags {
  const namedOffsets: Array<{ id: string; offset: number }> = [];
  if (cell.brandMentioned && cell.brandFirstMentionCharOffset !== undefined) {
    namedOffsets.push({ id: "client", offset: cell.brandFirstMentionCharOffset });
  }
  for (const competitor of cell.competitorsNamed) {
    namedOffsets.push({ id: competitor.brandId, offset: competitor.charOffset });
  }
  const firstNamedId = namedOffsets.length > 0 ? namedOffsets.reduce((min, cur) => (cur.offset < min.offset ? cur : min)).id : null;

  const clientFirstCited = cell.brandCited && cell.brandFirstCitationOrdinal === 1;
  const firstCitation = cell.citations.find((c) => c.ordinal === 1);
  let competitorFirstCitedId: string | null = null;
  if (firstCitation) {
    for (const [brandId, domains] of Object.entries(competitorDomains)) {
      if (domains.includes(firstCitation.domain)) {
        competitorFirstCitedId = brandId;
        break;
      }
    }
  }

  const clientFirst = firstNamedId === "client" || clientFirstCited;
  const competitorFirsts = new Set<string>();
  if (firstNamedId !== null && firstNamedId !== "client") competitorFirsts.add(firstNamedId);
  if (competitorFirstCitedId !== null) competitorFirsts.add(competitorFirstCitedId);

  return { clientFirst, competitorFirsts };
}

export function computeVisibilityMetrics(options: ComputeVisibilityMetricsOptions): VisibilityMetricsResult {
  const { cells, promptCount, clientDomains, competitorRoster, competitorDomains = {}, denominator = "N" } = options;
  const engines = VISIBILITY_ENGINES_CONFIG as readonly SeoGeoVisibilityEngine[];
  const rosterSize = competitorRoster.length + 1; // + client

  const cellFirstFlags = new Map<SeoGeoCaptureCell, FirstFlags>(cells.map((cell) => [cell, evaluateFirstFlags(cell, competitorDomains)]));

  const perEngine: PerEngineVisibilityMetrics[] = engines.map((engine) => {
    const engineCells = cells.filter((c) => c.engine === engine);
    const n = promptCount;
    const nEffective = denominatorFor(engineCells, promptCount, denominator);
    const safeDen = Math.max(nEffective, 1);

    const citedCount = engineCells.filter((c) => c.brandCited && clientDomains.some((d) => c.citations.some((cite) => cite.domain === d))).length;
    const namedCount = engineCells.filter((c) => c.brandMentioned).length;
    const namedAndCitedCount = engineCells.filter(
      (c) => c.brandMentioned && c.brandCited && clientDomains.some((d) => c.citations.some((cite) => cite.domain === d)),
    ).length;

    const citationShare = citedCount / safeDen;
    const mentionShare = namedCount / safeDen;
    const totalCited = engineCells.filter((c) => c.brandCited).length;
    const ghostCitationRate = totalCited === 0 ? 0 : ((totalCited - namedAndCitedCount) / Math.max(totalCited, 1)) * 100;

    const firstCount = engineCells.filter((cell) => cellFirstFlags.get(cell)!.clientFirst).length;
    const firstPositionRate = firstCount / safeDen;

    const sentiments = engineCells.flatMap((c) => c.sentimentPerMention);
    const posCount = sentiments.filter((s) => s.label === "pos").length;
    const negCount = sentiments.filter((s) => s.label === "neg").length;
    const netSentiment = (posCount - negCount) / Math.max(sentiments.length, 1);

    const baselineShare = (CONSTANTS.engine_baseline_share as Record<string, number>)[engine];
    const engineIndexDiagnostic = baselineShare ? citationShare / baselineShare : null;

    return {
      engine,
      n,
      nEffective,
      denominatorUsed: denominator,
      citationShare,
      mentionShare,
      ghostCitationRate,
      firstPositionRate,
      netSentiment,
      engineIndexDiagnostic,
    };
  });

  const citationShareBlended = perEngine.reduce((sum, e) => sum + e.citationShare, 0) / perEngine.length;
  const totalNamedAcrossEngines = perEngine.reduce((sum, e) => sum + e.mentionShare * Math.max(e.nEffective, 1), 0);
  const totalPromptSlots = promptCount * engines.length;
  const mentionRateBlended = totalPromptSlots > 0 ? totalNamedAcrossEngines / totalPromptSlots : 0;

  // GEO-27 share_of_voice: SOV[b] = mentions(b) / sum_{b' in roster} mentions(b') * 100.
  const mentionTotals: Record<string, number> = {};
  for (const cell of cells) {
    for (const [brandId, count] of Object.entries(cell.mentionCounts)) {
      mentionTotals[brandId] = (mentionTotals[brandId] ?? 0) + count;
    }
  }
  const rosterMentionSum = Object.values(mentionTotals).reduce((sum, n) => sum + n, 0);
  const shareOfVoiceClient = rosterMentionSum > 0 ? ((mentionTotals["client"] ?? 0) / rosterMentionSum) * 100 : 0;

  // BOTH-14: rank_first_competitor = argmax over competitor_set of how often
  // that competitor independently achieves first(p,e) (named-first OR
  // cited-first) — not "most mentioned overall", which is a different metric.
  const competitorFirstCounts: Record<string, number> = {};
  for (const flags of cellFirstFlags.values()) {
    for (const competitor of flags.competitorFirsts) {
      competitorFirstCounts[competitor] = (competitorFirstCounts[competitor] ?? 0) + 1;
    }
  }
  const rankFirstCompetitor =
    Object.keys(competitorFirstCounts).length > 0
      ? (Object.entries(competitorFirstCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null)
      : null;

  return {
    perEngine,
    citationShareBlended,
    mentionRateBlended,
    shareOfVoiceClient,
    rankFirstCompetitor,
    clientDomains: [...clientDomains],
    rosterSize,
  };
}
