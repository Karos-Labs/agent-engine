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
function evaluateFirstFlags(
  cell: SeoGeoCaptureCell,
  competitorDomains: Readonly<Record<string, readonly string[]>>,
  isRosterMember: (brandId: string) => boolean,
): FirstFlags {
  const namedOffsets: Array<{ id: string; offset: number }> = [];
  if (cell.brandMentioned && cell.brandFirstMentionCharOffset !== undefined) {
    namedOffsets.push({ id: "client", offset: cell.brandFirstMentionCharOffset });
  }
  for (const competitor of cell.competitorsNamed) {
    // "argmax over competitor_set": the comparison set is the LOCKED roster
    // (`competitor_set_hash`), not every brand an answer happens to name. A
    // brand outside the frozen roster is not a competitor, so it can neither
    // strip the client of first position nor be emitted as
    // `rank_first_competitor`.
    if (!isRosterMember(competitor.brandId)) continue;
    namedOffsets.push({ id: competitor.brandId, offset: competitor.charOffset });
  }
  const firstNamedId = namedOffsets.length > 0 ? namedOffsets.reduce((min, cur) => (cur.offset < min.offset ? cur : min)).id : null;

  const clientFirstCited = cell.brandCited && cell.brandFirstCitationOrdinal === 1;
  const firstCitation = cell.citations.find((c) => c.ordinal === 1);
  let competitorFirstCitedId: string | null = null;
  if (firstCitation) {
    // Sorted so that a domain claimed by two roster members resolves to the same
    // brand on every run (`reproducibility.rule`: nothing drifts silently).
    for (const [brandId, domains] of Object.entries(competitorDomains).sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!isRosterMember(brandId)) continue;
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

  /**
   * The locked roster (`competitor_set_hash`) scopes every formula the config
   * writes as "over competitor_set". When no roster is supplied there is no
   * locked set to scope to — and scoping to `{client}` alone would make
   * share_of_voice structurally incapable of being anything but 100% and the
   * client structurally incapable of losing first position. So an empty
   * roster falls back to the observed brands (the pre-existing behaviour) and
   * `rosterScoped: false` says so, rather than quietly asserting roster
   * semantics the inputs cannot support.
   */
  const rosterScoped = competitorRoster.length > 0;
  const rosterSet = new Set(competitorRoster);
  const isRosterMember = (brandId: string): boolean => !rosterScoped || rosterSet.has(brandId);

  const cellFirstFlags = new Map<SeoGeoCaptureCell, FirstFlags>(
    cells.map((cell) => [cell, evaluateFirstFlags(cell, competitorDomains, isRosterMember)]),
  );

  /**
   * `cited(p,e)`, defined once. The config fixes this predicate in
   * `citation_share`'s formula — "client root domain in citations[p][e].domain"
   * — and `ghost_citation_rate` then divides by that same `sum_p cited`.
   * `brandCited` alone is a looser flag (the answer cited the brand somehow);
   * using it for the ghost denominator while the numerator's subtrahend also
   * required a client-domain match made the two legs of one formula mean
   * different things, inflating the ghost rate for every answer that cited a
   * third-party page about the client.
   */
  const isCited = (cell: SeoGeoCaptureCell): boolean =>
    cell.brandCited && clientDomains.some((d) => cell.citations.some((cite) => cite.domain === d));

  const perEngine: PerEngineVisibilityMetrics[] = engines.map((engine) => {
    const engineCells = cells.filter((c) => c.engine === engine);
    const n = promptCount;
    const nEffective = denominatorFor(engineCells, promptCount, denominator);
    const safeDen = Math.max(nEffective, 1);

    const citedCount = engineCells.filter(isCited).length;
    const namedCount = engineCells.filter((c) => c.brandMentioned).length;
    const namedAndCitedCount = engineCells.filter((c) => c.brandMentioned && isCited(c)).length;

    const citationShare = citedCount / safeDen;
    const mentionShare = namedCount / safeDen;
    // ghost_citation_rate[e] = (sum_p cited - sum_p named_AND_cited)/max(sum_p cited,1) * 100
    const ghostCitationRate = citedCount === 0 ? 0 : ((citedCount - namedAndCitedCount) / Math.max(citedCount, 1)) * 100;

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
  // `mentionShare_e * max(nEffective_e, 1)` cancels back out to the raw named count per
  // engine (mentionShare is itself namedCount / max(nEffective,1)) — so this sum is just
  // Σ namedCount across engines regardless of denominator mode. The blended RATE, though,
  // must divide by a denominator that agrees with `denominator`: raw `N × engines` when
  // `"N"`, or the measured-only `Σ max(nEffective, 1)` when `"N_e"` — previously this
  // always used the raw-N denominator even when the caller asked for `"N_e"`, so the one
  // aggregate feeding GEO-35's named_mention_rate silently ignored the N-vs-N_e choice
  // every per-engine metric otherwise honors (a scoring-formula-fidelity audit finding).
  const totalNamedAcrossEngines = perEngine.reduce((sum, e) => sum + e.mentionShare * Math.max(e.nEffective, 1), 0);
  const blendedMentionDenominator =
    denominator === "N_e" ? perEngine.reduce((sum, e) => sum + Math.max(e.nEffective, 1), 0) : promptCount * engines.length;
  const mentionRateBlended = blendedMentionDenominator > 0 ? totalNamedAcrossEngines / blendedMentionDenominator : 0;

  // GEO-27 share_of_voice: "SOV[b] = mentions(b) / sum_{b' in client+competitor_set}
  // mentions(b') * 100; share_of_voice = SOV[client]; sums to 100 across locked roster".
  // The denominator is the LOCKED roster, so a brand the model happened to name that is
  // not on `competitor_set` must not enter the sum — it would depress the client's SOV
  // (and with it GEO-27, 20 of the Visibility Index's 100 points) for a brand nobody
  // chose to compete against, and would break the config's own "sums to 100" invariant.
  const mentionTotals: Record<string, number> = {};
  const offRosterBrands = new Set<string>();
  for (const cell of cells) {
    for (const [brandId, count] of Object.entries(cell.mentionCounts)) {
      if (brandId !== "client" && !isRosterMember(brandId)) {
        offRosterBrands.add(brandId);
        continue;
      }
      mentionTotals[brandId] = (mentionTotals[brandId] ?? 0) + count;
    }
  }
  const rosterMentionSum = Object.values(mentionTotals).reduce((sum, n) => sum + n, 0);
  const sovFor = (brandId: string): number => (rosterMentionSum > 0 ? ((mentionTotals[brandId] ?? 0) / rosterMentionSum) * 100 : 0);
  const shareOfVoiceClient = sovFor("client");
  const shareOfVoiceByBrand: Record<string, number> = Object.fromEntries(
    Object.keys(mentionTotals)
      .sort()
      .map((brandId) => [brandId, sovFor(brandId)]),
  );

  // BOTH-14: rank_first_competitor = argmax over competitor_set of how often
  // that competitor independently achieves first(p,e) (named-first OR
  // cited-first) — not "most mentioned overall", which is a different metric.
  const competitorFirstCounts: Record<string, number> = {};
  for (const flags of cellFirstFlags.values()) {
    for (const competitor of flags.competitorFirsts) {
      competitorFirstCounts[competitor] = (competitorFirstCounts[competitor] ?? 0) + 1;
    }
  }
  // Ties break on brandId ascending, so the emitted competitor depends only on the
  // frozen inputs and never on which capture cell happened to be scanned first
  // (`reproducibility.rule`: identical inputs, bit-identical outputs).
  const rankFirstCompetitor =
    Object.entries(competitorFirstCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

  return {
    perEngine,
    citationShareBlended,
    mentionRateBlended,
    shareOfVoiceClient,
    shareOfVoiceByBrand,
    rankFirstCompetitor,
    clientDomains: [...clientDomains],
    rosterSize,
    rosterScoped,
    offRosterBrandsIgnored: [...offRosterBrands].sort(),
  };
}
