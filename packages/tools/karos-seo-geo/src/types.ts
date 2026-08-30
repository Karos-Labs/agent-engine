/**
 * Shared types for the SEO & GEO deterministic scoring engine (RFC-04 Phase 4/6).
 * Every shape here mirrors a concept named explicitly in
 * `seo-geo-scoring-config.json` / `seo-geo-capture-config.json` / the
 * routing config — see `src/config/*.data.ts` for the verbatim source data.
 */

/** One of the 5 fixed AI-visibility engines (`seo-geo-capture-config.json` `engines[]`). */
export const SEO_GEO_VISIBILITY_ENGINES = ["chatgpt", "perplexity", "gemini", "claude", "copilot"] as const;
export type SeoGeoVisibilityEngine = (typeof SEO_GEO_VISIBILITY_ENGINES)[number];

/**
 * `capture_tier` enum (`seo-geo-capture-config.json`): how a (prompt, engine)
 * cell's answer was obtained. `UNAVAILABLE` is the honest terminal state —
 * never a fabricated zero, and excluded from `N_e` (RFC-04 §4's connector
 * overlay ladder terminal state).
 */
export const SEO_GEO_CAPTURE_TIERS = ["MEASURED", "MEASURED_grounded", "ESTIMATED", "UNAVAILABLE"] as const;
export type SeoGeoCaptureTier = (typeof SEO_GEO_CAPTURE_TIERS)[number];

/**
 * `grade_data_only_rule` (scoring config): every input that feeds a grade
 * must trace to real measured/first-party/third-party-real-answer data.
 * `estimated` inputs are excluded from the grade and shown as context only;
 * `unavailable` inputs are excluded and shown as "pending", never guessed.
 */
export type DataCoverage = "measured" | "estimated" | "unavailable";

/** One `inputs[]` entry's raw measurement, keyed by the normalization primitive it feeds. */
export type InputMeasurementData =
  | { kind: "boolean"; measured: boolean }
  | { kind: "count"; actual: number }
  | { kind: "ratio"; value: number }
  | { kind: "percentage"; valuePct: number }
  | { kind: "stepped"; value: number }
  | { kind: "multiBool"; subBools: boolean[] }
  /** For `combine` inputs: field name (matching the config's `legs[].field`) -> raw value. */
  | { kind: "combine"; fields: Record<string, number | boolean> };

export interface InputMeasurement {
  data: InputMeasurementData;
  /**
   * Required when the config input carries a `gate` block (e.g. GEO-18
   * anti-stuffing). Omitting it does NOT mean "the gate passed" — it means
   * the gate was never checked, and `gate_rule` then forces the norm to
   * `on_fail_norm` just as an explicit `false` would (`grade_data_only_rule`:
   * an unmeasured input is never guessed). Supply `true` only when the check
   * actually ran and actually passed.
   */
  gatePass?: boolean | undefined;
  /** `grade_data_only_rule`: an `estimated`/`unavailable` measurement scores 0 and is excluded from `dataCoveragePct`'s numerator. */
  coverage: DataCoverage;
}

export interface EvaluatedInput {
  recId: string;
  bucket: string;
  measure: string;
  inputKey: string;
  weight: number;
  norm: number;
  points: number;
  coverage: DataCoverage;
  /** True whenever a config-declared gate withheld credit — i.e. `gateState` is `failed` or `unverified`. */
  gated: boolean;
  /**
   * Whether this input's config-declared gate was verified. `"none"` means
   * the config declares no gate for this input; `"unverified"` means it
   * declares one and the caller never measured it (scored as a failure, not
   * waved through).
   */
  gateState: "none" | "pass" | "failed" | "unverified";
  /**
   * The normalization primitive this instance was scored with
   * (`normalization_fns`) — carried through to `seoGeo.recommend` so the
   * fire-state classifier can apply `trigger.fires_when`'s explicit
   * `boolean`/`multi_bool` override ("norm==1 pass else fail", no
   * "approaching" tier) rather than the generic continuous pass/
   * approaching/fail bands meant for ratio-typed inputs.
   */
  normalization: "boolean" | "count_with_target" | "ratio_clamp" | "percentage" | "lower_is_better_stepped" | "multi_bool" | "combine";
}

export interface BucketSubtotal {
  bucket: string;
  weightTotal: number;
  points: number;
}

export interface ScoreBreakdown {
  /** `round_half_up` applied once to the 0-100 total (unmeasured inputs contribute 0 points, per `grade_data_only_rule`). */
  score: number;
  weightTotal: number;
  dataCoveragePct: number;
  /** True whenever `dataCoveragePct < 100` — mirrors `grade_data_only_rule`'s "labelled partial until coverage is complete". */
  partial: boolean;
  bucketSubtotals: BucketSubtotal[];
  inputs: EvaluatedInput[];
}

/** A single (prompt × engine) capture cell — the load-bearing subset of `seo-geo-capture-config.json`'s ~29-field record. */
export interface SeoGeoCaptureCell {
  promptId: string;
  engine: SeoGeoVisibilityEngine;
  captureTier: SeoGeoCaptureTier;
  brandMentioned: boolean;
  brandFirstMentionCharOffset?: number | undefined;
  brandCited: boolean;
  brandFirstCitationOrdinal?: number | undefined;
  /**
   * Competitor roster members named in this answer, each with the char
   * offset of their first mention (`seo-geo-capture-config.json`
   * `response_set.per_prompt_engine_fields`'s `competitors_named[].
   * {brand_id, char_offset}`) — required to determine BOTH-14's
   * "first_named" leg (who was mentioned first: client or a competitor),
   * not just whether a competitor was mentioned at all.
   */
  competitorsNamed: Array<{ brandId: string; charOffset: number }>;
  citations: Array<{ domain: string; ordinal: number }>;
  /** brandId (including "client") -> mention count in this answer, for share-of-voice. */
  mentionCounts: Record<string, number>;
  /** Per-mention sentiment, pre-classified and frozen (`net_sentiment`'s cached-label rule) — this scoring layer never classifies. */
  sentimentPerMention: Array<{ mentionIndex: number; label: "pos" | "neg" | "neutral" }>;
  /**
   * SHA-256 over the frozen raw provider payload (`response_set.per_prompt_engine_fields`'s
   * `raw_sha256`) — provenance only (`non_scoring_fields.provenance`), never
   * read by any scoring metric in this file. Optional here (unlike
   * `@agent-engine/tool-karos-research`'s `CaptureCell`, which always sets
   * it) purely so hand-built fixtures elsewhere in this package's own test
   * suite don't need updating for a field they never assert on.
   */
  rawSha256?: string | undefined;
  /** Set only when `captureTier` is `UNAVAILABLE` because a pre-flight credit probe rejected this cell — see `tool-karos-research`'s `CaptureCell` for the full contract. */
  unavailableReason?: "credit_probe_402" | "no_adapter_wired" | undefined;
}

/** Which raw-count denominator a metric divides by. No longer a choice — see `VisibilityDenominatorDecision`. */
export type VisibilityDenominator = "N" | "N_e";

/**
 * The CLOSED form of `seo-geo-capture-config.json`'s
 * `open_scoring_decisions.N_vs_N_e` ("BLOCKING, for Daniel"). v2 decided it on
 * 2026-08-20 against a real client run and the decision is ratified in
 * `docs/AUDIT-2026-08-25-architecture-optimization-plan.md` §4c.2: per-engine
 * rates divide by `N_e` (answers that actually exist), the blended Visibility
 * Index divides by `N` (the raw frozen prompt count), and BOTH counts are
 * printed on every per-engine row so neither can silently stand in for the
 * other. `status` is `"resolved"` — this type cannot express "pending" again.
 */
export interface VisibilityDenominatorDecision {
  status: "resolved";
  /** The date v2 decided it, on real data — not the date this port landed. */
  decidedOn: string;
  perEngineRates: "N_e";
  blendedIndex: "N";
  bothAlwaysPrinted: true;
  supersedes: string;
  ratifiedIn: string;
}

/**
 * v2's KNOWN/FOUND split (decided 2026-08-20 on real client data; ratified in
 * `docs/AUDIT-2026-08-25-architecture-optimization-plan.md` §4c.2). `known` =
 * the prompt names the company, so the answer measures RECOGNITION; `found` =
 * it does not, so the answer measures DISCOVERY. They answer different
 * questions about different prompt populations, so they are published side by
 * side and NEVER averaged into one visibility number — the single blended
 * KNOWN+FOUND score is retired.
 */
export const VISIBILITY_COHORTS = ["known", "found"] as const;
export type VisibilityCohort = (typeof VISIBILITY_COHORTS)[number];

/**
 * One publishable figure. v2's floor: an engine with fewer than
 * `MIN_ANSWERS_FOR_RATE` answers publishes a COUNT, never a percentage — a
 * "50%" off two answers reads as a measurement and is noise. Below the floor
 * `ratePct` is `null` (not 0, not a rounded guess) and `display` is the count.
 */
export interface PublishedRate {
  count: number;
  /** The N_e this figure is out of: answers that actually exist for this engine (and cohort). */
  answers: number;
  /** True when `answers < MIN_ANSWERS_FOR_RATE` — a count publishes instead of a rate. */
  countsOnly: boolean;
  /** `null` whenever `countsOnly`; there is no percentage to publish and none is invented. */
  ratePct: number | null;
  /** Exactly what a report prints: `"3 of 7 answers"` below the floor, `"42.9%"` at or above it. */
  display: string;
}

/** One (engine × cohort) row of the KNOWN/FOUND report. Rows are published, never merged with the other cohort's row. */
export interface CohortEngineVisibility {
  engine: SeoGeoVisibilityEngine;
  cohort: VisibilityCohort;
  /** `N` for this cohort: every prompt assigned to it, answered or not. Always printed alongside `nEffective`. */
  n: number;
  /** `N_e` for this (engine, cohort): cohort cells whose `captureTier !== "UNAVAILABLE"`. Every rate here divides by this. */
  nEffective: number;
  /** True when `nEffective < MIN_ANSWERS_FOR_RATE` — every figure in this row publishes as a count. */
  countsOnly: boolean;
  named: PublishedRate;
  cited: PublishedRate;
  first: PublishedRate;
  /** The marker that travels with the data: this row may never be averaged with the other cohort's row. */
  neverBlend: true;
}

/** KNOWN and FOUND, side by side. There is deliberately no combined field — that number is retired. */
export interface KnownVsFoundReport {
  /** Travels with the data (v2, 2026-08-20): no consumer may average `known` with `found`. */
  neverBlend: true;
  known: CohortEngineVisibility[];
  found: CohortEngineVisibility[];
  /**
   * False when no `promptCohorts` map was supplied: nothing was classified, so
   * `known`/`found` are EMPTY rather than filled with fabricated zero rows, and
   * every prompt lands in `unclassifiedPromptIds`.
   */
  cohortsScoped: boolean;
  /** Prompts with no cohort assignment — excluded from both cohorts rather than guessed into one. Sorted. */
  unclassifiedPromptIds: string[];
  knownPromptCount: number;
  foundPromptCount: number;
}

export interface PerEngineVisibilityMetrics {
  engine: SeoGeoVisibilityEngine;
  /** `N`: the raw frozen prompt count. Always printed, even though no rate on this row divides by it. */
  n: number;
  /** `N_e`: this engine's cells whose `captureTier !== "UNAVAILABLE"`. Always printed; every rate on this row divides by it. */
  nEffective: number;
  /** Always `"N_e"` — the denominator decision is closed (`VisibilityDenominatorDecision`), so this records a fact, not a choice. */
  denominatorUsed: VisibilityDenominator;
  /**
   * Always `true`: these rates POOL known-prompt and found-prompt answers.
   * They exist to feed the blended Visibility Index that the same ratified
   * decision preserves — they are NOT the client-facing visibility figure, and
   * rendering one as "your visibility" re-creates exactly the blended score v2
   * retired. Publish `VisibilityMetricsResult.knownVsFound` instead.
   */
  cohortBlind: true;
  citationShare: number;
  mentionShare: number;
  ghostCitationRate: number;
  firstPositionRate: number;
  netSentiment: number;
  /** GEO-36: diagnostic only, never folded into the Visibility Index (would double-count citation share). */
  engineIndexDiagnostic: number | null;
}

export interface VisibilityMetricsResult {
  perEngine: PerEngineVisibilityMetrics[];
  /**
   * The retired-blend replacement: KNOWN and FOUND published separately, with
   * the `neverBlend` marker on the report and on every row.
   */
  knownVsFound: KnownVsFoundReport;
  /** The closed N-vs-N_e decision, carried on every result so a consumer never has to look it up. */
  denominatorDecision: VisibilityDenominatorDecision;
  /**
   * What the caller asked for on the retired `denominator` option, echoed back,
   * or `null` when nothing was asked. The decision is closed, so this request
   * changes no number — recorded here so an ignored request is visible IN THE
   * DATA rather than only in a comment.
   */
  denominatorRequested: VisibilityDenominator | null;
  /** Index input, `N`-based (`Σ_e cited / (N × engines)`) — see `PerEngineVisibilityMetrics.cohortBlind`. */
  citationShareBlended: number;
  /** Index input, `N`-based (`Σ_e named / (N × engines)`) — see `PerEngineVisibilityMetrics.cohortBlind`. */
  mentionRateBlended: number;
  /**
   * Index input, `N`-based (`Σ_e first / (N × engines)`). BOTH-14's blended leg
   * used to be the arithmetic mean of the per-engine rates; once those flipped
   * to `N_e` that mean would have dragged `N_e` into the Index, which the
   * decision fixes on `N`. Identical to the old mean whenever `N_e == N`.
   */
  firstPositionRateBlended: number;
  shareOfVoiceClient: number;
  /** SOV per brand across the locked roster (`client` included), sorted by brandId — sums to 100 per GEO-27's formula. */
  shareOfVoiceByBrand: Record<string, number>;
  rankFirstCompetitor: string | null;
  clientDomains: string[];
  rosterSize: number;
  /**
   * True when a non-empty `competitorRoster` was supplied, so every
   * "over competitor_set" formula (share_of_voice, first_named,
   * rank_first_competitor) really was scoped to the locked roster. False
   * means no roster was frozen and those formulas fell back to the brands
   * observed in the data — reported, never assumed.
   */
  rosterScoped: boolean;
  /** Brands named in the capture set but absent from the locked roster, excluded from the roster-scoped formulas. Sorted; empty when `rosterScoped` is false. */
  offRosterBrandsIgnored: string[];
}

export interface VisibilityIndexResult {
  index: number;
  componentNorms: Array<{ recId: string; name: string; weight: number; norm: number; points: number }>;
}

/** The alternate `geo_score_model` ("geo-score-v3") diagnostic — PROPOSED, pending Ines's sign-off. Never the canonical GEO number. */
export interface GeoScoreModelResult {
  overall: number;
  perEngine: Array<{ engine: SeoGeoVisibilityEngine; score: number }>;
  weightsStatus: string;
}
