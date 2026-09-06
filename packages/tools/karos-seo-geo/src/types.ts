/**
 * Shared types for the SEO & GEO deterministic scoring engine (RFC-04 Phase 4/6).
 * Every shape here mirrors a concept named explicitly in
 * `seo-geo-scoring-config.json` / `seo-geo-capture-config.json` / the
 * routing config — see `src/config/*.data.ts` for the verbatim source data.
 */

/**
 * The ratified AI-visibility engine list (SCRUM-396) — **the single source**
 * every other engine list in this repo derives from. Do not re-list these keys
 * anywhere; import this constant, or `SEO_GEO_CAPTURE_ENGINES` below.
 *
 * Seven engines, not five: `aimode` and `google_aio` are the two the v2 skill's
 * only real measured run actually used and this constant was missing. The
 * decision, its evidence and its date are recorded in
 * `docs/decisions/SCRUM-396-visibility-engine-list.md` — read that before
 * changing this list, because the previous reader changed it from the wrong
 * document (the same failure mode as SCRUM-387).
 *
 * **`claude` is kept deliberately.** SCRUM-396 read the v2 skill as having
 * dropped it; the v2 skill's own machine truth
 * (`assets/config/seo-geo-v2-capture-config.json`) carries `claude` as engine
 * seven with `enabled_by_default: false` and
 * `status: "FUTURE ADD-ON, deliberately not built (Albert, 2026-08-19)"`. It is
 * a recorded deferral, never a removal — and the reason it was deferred (v2's
 * routed provider has no Claude endpoint) does not apply here, because this
 * repo measures Claude first-party through `capture-adapters/claude.ts`.
 *
 * Ordering is load-bearing: `SEO_GEO_CAPTURE_ENGINES` is hashed into every
 * frozen run record, so the captured engines keep their original order and the
 * two new keys are appended. See that constant's own note.
 */
export const SEO_GEO_VISIBILITY_ENGINES = Object.freeze(["chatgpt", "perplexity", "gemini", "claude", "copilot", "aimode", "google_aio"] as const);
export type SeoGeoVisibilityEngine = (typeof SEO_GEO_VISIBILITY_ENGINES)[number];

/** One engine's ratified place in the list — why it is here, and whether this build actually captures it. */
export interface SeoGeoVisibilityEngineSpec {
  /** The engine's client-facing label, so a renderer never has to invent one from the key. */
  readonly label: string;
  /**
   * Whether this engine is in the capture fan-out. `false` means the engine is
   * accepted on read (its cells validate, its column can be stored) but this
   * build sends it no traffic — the forward-compatible half of the list.
   */
  readonly captured: boolean;
  /** Why `captured` is what it is, so the next reader does not re-derive it from a stale document. */
  readonly note: string;
}

/**
 * Per-engine ratification, keyed by engine so the typechecker enforces what a
 * test can only observe: this is a `Record` over `SeoGeoVisibilityEngine`, so
 * an engine added to the list above **cannot compile** without a spec here, and
 * a spec for a non-engine cannot compile either. That is the anti-drift
 * guarantee SCRUM-396 asked for, checked at build time rather than asserted.
 */
export const SEO_GEO_VISIBILITY_ENGINE_SPECS: Readonly<Record<SeoGeoVisibilityEngine, SeoGeoVisibilityEngineSpec>> = Object.freeze({
  chatgpt: {
    label: "ChatGPT",
    captured: true,
    note:
      "OpenAI Responses API with the server-side `web_search` tool — `capture-adapters/openai-answer-engine.ts`. This is the API, not the ChatGPT product: retrieval, ranking and citations differ from what a person sees in the UI, and a client comparing the two will find differences. It replaced a ScrappyCoco route that never worked — that vendor's live catalogue has no answer-engine capability at all.",
  },
  perplexity: { label: "Perplexity", captured: true, note: "First-party Sonar, native citations — `capture-adapters/perplexity.ts`." },
  gemini: { label: "Google Gemini", captured: true, note: "Grounding-with-Google-Search, labelled MEASURED_grounded — `capture-adapters/gemini.ts`." },
  claude: {
    label: "Claude",
    captured: true,
    note:
      "First-party Anthropic Messages + `web_search`, Haiku-class for capture and never the report model — `capture-adapters/claude.ts`. Kept, not dropped: v2 deferred this column only because its routed provider has no Claude endpoint, which is not this repo's situation.",
  },
  copilot: {
    label: "Microsoft Copilot",
    captured: false,
    note:
      "Accepted but NOT captured, by product decision on 2026-09-05: Copilot has no consumer API and no vendor route this account will be given (the ScrappyCoco capability it once named does not exist on the account — 52 capabilities, all web/social/filings scraping, no answer engine — and the owner has said no other route will be added). Until then it was kept in the fan-out so its column showed as an honest UNAVAILABLE rather than vanishing; the owner's call is that a column that can never be measured is noise in the coverage denominator, not honesty. Dropping it from the fan-out changes `engineListHash` — deliberately, logged as engine-list drift by `04-freeze-prompt-set` on every client's next recurring run. It stays in the accepted vocabulary so historical cells and frozen records still parse. Flip `captured` back and add an adapter if a route ever appears.",
  },
  aimode: {
    label: "Google AI Mode",
    captured: false,
    note:
      "Added by SCRUM-396 and accepted on read, but NOT in the fan-out: this build has no AI-Mode adapter. Fanning out to an adapter-less engine would write a column of honest-but-empty UNAVAILABLE cells every run, which lowers the coverage percentage a client feels while measuring nothing. It joins the fan-out when an adapter lands — flip `captured` and add the adapter, no schema change.",
  },
  google_aio: {
    label: "Google AI Overview",
    captured: false,
    note:
      "Same as `aimode`: accepted on read, no adapter in this build, so out of the fan-out. Distinct from `gemini` on purpose — per the Ahrefs 540K-pair study the two Google surfaces agree ~86% of the time but cite the same URLs only 13.7% of the time, so neither substitutes for the other.",
  },
});

/**
 * The engines this build actually sends capture traffic to — the fan-out list,
 * and the list hashed as `engineListHash` into every frozen run record.
 *
 * Derived, never re-listed. It is deliberately **not** the same as
 * `SEO_GEO_VISIBILITY_ENGINES`: the wide list is what a stored cell may claim
 * (so widening it breaks no persisted data and needs no read-compat path), and
 * this narrow list is what a run measures.
 *
 * Because SCRUM-396 only *widened* the accepted list and left the captured set
 * untouched, this array is byte-identical to the five-engine constant it
 * replaces — so `engineListHash` does not change and no prior run's frozen
 * record is invalidated. There is no version bump to make here. The moment this
 * list does change, `04-freeze-prompt-set` logs an engine-list drift decision
 * on recurring runs, exactly as it already does for the prompt set.
 */
export const SEO_GEO_CAPTURE_ENGINES: readonly SeoGeoVisibilityEngine[] = Object.freeze(
  SEO_GEO_VISIBILITY_ENGINES.filter((engine) => SEO_GEO_VISIBILITY_ENGINE_SPECS[engine].captured),
);

/**
 * SCRUM-396's ratification, recorded in code the way SCRUM-392 recorded
 * `karos_tool` and AU28/SCRUM-319 recorded the N-vs-N_e answer — so the next
 * reader inherits the decision instead of re-deriving it from whichever
 * document they happen to open first.
 */
export const SEO_GEO_VISIBILITY_ENGINE_DECISION = Object.freeze({
  status: "ratified",
  decidedOn: "2026-09-02",
  ticket: "SCRUM-396",
  accepted: SEO_GEO_VISIBILITY_ENGINES,
  captured: SEO_GEO_CAPTURE_ENGINES,
  added: ["aimode", "google_aio"],
  claudeKept: true,
  authority: "karos-agents/products/building/seo-geo-agent-v2/assets/config/seo-geo-v2-capture-config.json (7 engines, `claude` enabled_by_default:false), paired with references/capture-contract.md (decided 2026-08-19, Albert)",
  supersedes: "capture-config.data.ts `engines[]` (v1.1, 5 engines) and this repo's own five-key constant",
  notAuthority: "docs/AUDIT-2026-08-25-architecture-optimization-plan.md §4c's per-engine table, which quotes docs/SEO-GEO-V2-CAPTURE-CONTRACT.md — a document its own banner marks HISTORY",
  writeUp: "docs/decisions/SCRUM-396-visibility-engine-list.md",
});

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
  /**
   * Gemini-only (T-A3/SCRUM-237): true when Google's AI Overview /
   * Grounding-with-Google-Search equivalent genuinely did not render for this
   * query at all — distinct from `brandMentioned: false`, which means an
   * answer DID come back and simply never named the brand. See
   * `tool-karos-research`'s `CaptureCell.aioAbsent` for the full contract.
   */
  aioAbsent?: boolean | undefined;
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
