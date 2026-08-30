import { CONSTANTS, VISIBILITY_ENGINES_CONFIG } from "./scoring-config.js";
import type {
  CohortEngineVisibility,
  KnownVsFoundReport,
  PerEngineVisibilityMetrics,
  PublishedRate,
  SeoGeoCaptureCell,
  SeoGeoVisibilityEngine,
  VisibilityCohort,
  VisibilityDenominator,
  VisibilityDenominatorDecision,
  VisibilityMetricsResult,
} from "./types.js";

/**
 * v2's answer to `seo-geo-capture-config.json`'s
 * `open_scoring_decisions.N_vs_N_e` — decided 2026-08-20 on a real client run
 * and ratified in `docs/AUDIT-2026-08-25-architecture-optimization-plan.md`
 * §4c.2. The decision is CLOSED: it is no longer surfaced as a parameter,
 * because there is no longer a choice to surface.
 */
export const VISIBILITY_DENOMINATOR_DECISION: VisibilityDenominatorDecision = Object.freeze({
  status: "resolved",
  decidedOn: "2026-08-20",
  perEngineRates: "N_e",
  blendedIndex: "N",
  bothAlwaysPrinted: true,
  supersedes: "seo-geo-capture-config.json open_scoring_decisions.N_vs_N_e (was BLOCKING, for Daniel)",
  ratifiedIn: "docs/AUDIT-2026-08-25-architecture-optimization-plan.md §4c.2",
});

/**
 * v2's publication floor: an engine with fewer than this many answers publishes
 * a COUNT, never a percentage. "50%" off two answers looks like a measurement
 * and is noise; "1 of 2 answers" cannot be misread.
 */
export const MIN_ANSWERS_FOR_RATE = 10;

/**
 * Turn a count into the figure a report actually prints, applying
 * `MIN_ANSWERS_FOR_RATE`. Below the floor `ratePct` is `null` — not 0, not a
 * rounded guess — so a renderer cannot accidentally print a percentage that was
 * never publishable.
 */
export function publishRate(count: number, answers: number): PublishedRate {
  const countsOnly = answers < MIN_ANSWERS_FOR_RATE;
  const ratePct = answers > 0 ? (count / answers) * 100 : 0;
  return {
    count,
    answers,
    countsOnly,
    ratePct: countsOnly ? null : ratePct,
    display: countsOnly ? `${count} of ${answers} answers` : `${ratePct.toFixed(1)}%`,
  };
}

/**
 * Raw per-engine visibility metrics, ported from
 * `seo-geo-scoring-config.json` `visibility.metrics[]` and then amended by
 * v2's two ratified decisions (audit §4c.2):
 *
 * 1. **N vs N_e is closed.** Per-engine rates divide by `N_e`; the blended
 *    Visibility Index divides by `N`; every per-engine row prints both counts.
 *    The old `denominator` parameter existed only to keep the open decision
 *    visible, and is retired — see its own doc below.
 * 2. **KNOWN and FOUND never blend.** Supply `promptCohorts` and the result
 *    carries a `knownVsFound` report with the two cohorts side by side; there
 *    is no combined field, and each row carries the `neverBlend` marker.
 */
export interface ComputeVisibilityMetricsOptions {
  cells: readonly SeoGeoCaptureCell[];
  /** The frozen prompt count (`N`) — shared across all 5 engines by construction (one fixed prompt set). */
  promptCount: number;
  clientDomains: readonly string[];
  competitorRoster: readonly string[];
  /** brandId -> that competitor's own domains — enables the citation leg of "first" for competitors, symmetric to `clientDomains`. Omit (or pass `{}`) when no competitor domain roster is known yet; competitors are then judged on the named leg alone, never fabricated. */
  competitorDomains?: Readonly<Record<string, readonly string[]>>;
  /**
   * promptId -> which cohort that prompt belongs to: `"known"` when the prompt
   * text names the client company (recognition), `"found"` when it does not
   * (discovery). Classification is an input, never inferred here — a prompt
   * absent from this map is reported as unclassified and excluded from BOTH
   * cohorts rather than guessed into one. Omit entirely when nothing has been
   * classified yet; `knownVsFound.cohortsScoped` then says so.
   */
  promptCohorts?: Readonly<Record<string, VisibilityCohort>>;
  /**
   * @deprecated The N-vs-N_e decision is CLOSED (`VISIBILITY_DENOMINATOR_DECISION`),
   * so this no longer selects anything: per-engine rates always use `N_e` and the
   * blended Index always uses `N`. Still accepted so callers written against the
   * open decision keep compiling, and echoed back as
   * `VisibilityMetricsResult.denominatorRequested` so an ignored request is
   * visible in the data rather than swallowed.
   */
  denominator?: VisibilityDenominator;
}

/** `N_e`: cells that carry an answer at all. `UNAVAILABLE` is the honest empty, never a measured zero. */
function measuredCount(engineCells: readonly SeoGeoCaptureCell[]): number {
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
  const { cells, promptCount, clientDomains, competitorRoster, competitorDomains = {}, promptCohorts, denominator } = options;
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

  /**
   * Raw counts per engine, computed once. The per-engine RATES below divide
   * them by `N_e` and the blended Index aggregates divide the same counts by
   * `N` — two denominators over one set of counts, which is exactly what
   * `VISIBILITY_DENOMINATOR_DECISION` fixes.
   */
  const engineRaw = engines.map((engine) => {
    const engineCells = cells.filter((c) => c.engine === engine);
    return {
      engine,
      nEffective: measuredCount(engineCells),
      citedCount: engineCells.filter(isCited).length,
      namedCount: engineCells.filter((c) => c.brandMentioned).length,
      namedAndCitedCount: engineCells.filter((c) => c.brandMentioned && isCited(c)).length,
      firstCount: engineCells.filter((cell) => cellFirstFlags.get(cell)!.clientFirst).length,
      sentiments: engineCells.flatMap((c) => c.sentimentPerMention),
    };
  });

  const perEngine: PerEngineVisibilityMetrics[] = engineRaw.map((raw) => {
    // Per-engine rates divide by N_e, per the closed decision: a rate whose
    // denominator counts prompts nobody ever got an answer for reports the
    // capture gap as a visibility gap.
    const safeDen = Math.max(raw.nEffective, 1);

    const citationShare = raw.citedCount / safeDen;
    const mentionShare = raw.namedCount / safeDen;
    // ghost_citation_rate[e] = (sum_p cited - sum_p named_AND_cited)/max(sum_p cited,1) * 100
    const ghostCitationRate =
      raw.citedCount === 0 ? 0 : ((raw.citedCount - raw.namedAndCitedCount) / Math.max(raw.citedCount, 1)) * 100;
    const firstPositionRate = raw.firstCount / safeDen;

    const posCount = raw.sentiments.filter((s) => s.label === "pos").length;
    const negCount = raw.sentiments.filter((s) => s.label === "neg").length;
    const netSentiment = (posCount - negCount) / Math.max(raw.sentiments.length, 1);

    const baselineShare = (CONSTANTS.engine_baseline_share as Record<string, number>)[raw.engine];
    const engineIndexDiagnostic = baselineShare ? citationShare / baselineShare : null;

    return {
      engine: raw.engine,
      // Both counts, always — the decision's "both always printed" leg. `n` is
      // printed even though nothing on this row divides by it, so a reader can
      // always see how much of the frozen prompt set went unanswered.
      n: promptCount,
      nEffective: raw.nEffective,
      denominatorUsed: "N_e",
      cohortBlind: true,
      citationShare,
      mentionShare,
      ghostCitationRate,
      firstPositionRate,
      netSentiment,
      engineIndexDiagnostic,
    };
  });

  // The blended Visibility Index divides by `N` — the raw frozen prompt count
  // across all 5 engines — so the headline number is stable against how much of
  // the matrix a given run managed to capture. Written as `Σ count / (N × engines)`
  // rather than as the mean of the per-engine rates: those now use `N_e`, and
  // averaging them would drag `N_e` back into the Index the decision fixes on `N`.
  const blendedSlots = promptCount * engines.length;
  const blend = (pick: (raw: (typeof engineRaw)[number]) => number): number =>
    blendedSlots > 0 ? engineRaw.reduce((sum, raw) => sum + pick(raw), 0) / blendedSlots : 0;
  const citationShareBlended = blend((raw) => raw.citedCount);
  const mentionRateBlended = blend((raw) => raw.namedCount);
  const firstPositionRateBlended = blend((raw) => raw.firstCount);

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

  const knownVsFound = buildKnownVsFound({
    cells,
    engines,
    promptCohorts,
    isCited,
    isClientFirst: (cell) => cellFirstFlags.get(cell)!.clientFirst,
  });

  return {
    perEngine,
    knownVsFound,
    denominatorDecision: VISIBILITY_DENOMINATOR_DECISION,
    denominatorRequested: denominator ?? null,
    citationShareBlended,
    mentionRateBlended,
    firstPositionRateBlended,
    shareOfVoiceClient,
    shareOfVoiceByBrand,
    rankFirstCompetitor,
    clientDomains: [...clientDomains],
    rosterSize,
    rosterScoped,
    offRosterBrandsIgnored: [...offRosterBrands].sort(),
  };
}

interface KnownVsFoundInputs {
  cells: readonly SeoGeoCaptureCell[];
  engines: readonly SeoGeoVisibilityEngine[];
  promptCohorts: Readonly<Record<string, VisibilityCohort>> | undefined;
  isCited: (cell: SeoGeoCaptureCell) => boolean;
  isClientFirst: (cell: SeoGeoCaptureCell) => boolean;
}

/**
 * v2's KNOWN/FOUND report (audit §4c.2). The two cohorts are built
 * independently and returned side by side; this function deliberately computes
 * NO combined figure — the single blended KNOWN+FOUND visibility score is
 * retired, and `neverBlend` rides on the report and on every row so the
 * prohibition travels with the data rather than living in a doc.
 *
 * Every figure here divides by that cohort's own `N_e` and passes through
 * `publishRate`, so an engine below `MIN_ANSWERS_FOR_RATE` answers publishes
 * counts and no percentage exists to be printed.
 */
function buildKnownVsFound(inputs: KnownVsFoundInputs): KnownVsFoundReport {
  const { cells, engines, promptCohorts, isCited, isClientFirst } = inputs;
  const allPromptIds = [...new Set(cells.map((c) => c.promptId))].sort();

  // No classification supplied: emit EMPTY cohorts rather than five zero-filled
  // rows per cohort, which would read as "measured, and it's zero". Everything
  // is reported unclassified instead, and `cohortsScoped: false` says why.
  if (promptCohorts === undefined || Object.keys(promptCohorts).length === 0) {
    return {
      neverBlend: true,
      known: [],
      found: [],
      cohortsScoped: false,
      unclassifiedPromptIds: allPromptIds,
      knownPromptCount: 0,
      foundPromptCount: 0,
    };
  }

  const promptsIn = (cohort: VisibilityCohort): string[] =>
    Object.entries(promptCohorts)
      .filter(([, assigned]) => assigned === cohort)
      .map(([promptId]) => promptId);

  const rowsFor = (cohort: VisibilityCohort): CohortEngineVisibility[] => {
    const n = promptsIn(cohort).length;
    return engines.map((engine) => {
      // Numerators and the denominator are drawn from the SAME set — answers
      // that exist for this (engine, cohort). An `UNAVAILABLE` cell is not a
      // "didn't appear", so it is out of both.
      const answered = cells.filter(
        (c) => c.engine === engine && c.captureTier !== "UNAVAILABLE" && promptCohorts[c.promptId] === cohort,
      );
      const nEffective = answered.length;
      return {
        engine,
        cohort,
        n,
        nEffective,
        countsOnly: nEffective < MIN_ANSWERS_FOR_RATE,
        named: publishRate(answered.filter((c) => c.brandMentioned).length, nEffective),
        cited: publishRate(answered.filter(isCited).length, nEffective),
        first: publishRate(answered.filter(isClientFirst).length, nEffective),
        neverBlend: true,
      };
    });
  };

  return {
    neverBlend: true,
    known: rowsFor("known"),
    found: rowsFor("found"),
    cohortsScoped: true,
    unclassifiedPromptIds: allPromptIds.filter((promptId) => promptCohorts[promptId] === undefined),
    knownPromptCount: promptsIn("known").length,
    foundPromptCount: promptsIn("found").length,
  };
}
