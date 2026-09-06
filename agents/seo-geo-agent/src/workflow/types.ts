import type {
  FiredRecommendation,
  ScoreBreakdown,
  SeoGeoCaptureCell,
  SeoGeoVisibilityEngine,
  VisibilityDenominatorDecision,
  VisibilityIndexResult,
} from "@agent-engine/tool-karos-seo-geo";
import { SEO_GEO_VISIBILITY_ENGINE_DECISION } from "@agent-engine/tool-karos-seo-geo";

/** Phase 0 (RFC-04 §2): the two intake fields whose absence blocks the run, same pattern as `linkedin-agent`'s step 00. */
export interface SeoGeoIntakeConfig {
  profile: Record<string, unknown>;
  brand: Record<string, unknown>;
}

export interface SeoGeoCompetitor {
  name: string;
  website?: string;
}

/** Phase 0's full context bundle — brand aliases/roster/category-vocabulary inputs, per RFC-04's phase-0 description. */
export interface SeoGeoClientContext {
  profile: Record<string, unknown>;
  brand: Record<string, unknown>;
  config: Record<string, unknown>;
  competitors: SeoGeoCompetitor[];
  /**
   * Where `competitors` came from, so a reader of the run record can tell a
   * measured zero from an unmeasurable one.
   *
   * `"none"` is the case that used to be invisible: every competitor metric
   * this agent reports — roster share, "named first", per-competitor mention
   * counts — is structurally zero with an empty roster, and that zero looks
   * exactly like "no competitor was ever mentioned". They mean opposite things
   * and a client is shown the same number for both.
   */
  competitorRosterSource: "client-curated" | "intel-report" | "none";
  /** At least one entry — `seoGeo.score`'s `visibility.clientDomains` requires `min(1)`; see `deriveClientDomain`. */
  clientDomains: string[];
}

/**
 * The 5 LOCKED prompt intent types (`seo-geo-capture-config.json`
 * `prompt_set.intent_types`, verbatim) — "Per-intent-type quota enforced so
 * coverage is guaranteed and reproducible." Locked means exactly these 5,
 * never a 6th invented ad hoc and never fewer.
 */
export const SEO_GEO_PROMPT_INTENT_TYPES = ["discovery", "comparison", "brand", "problem", "navigational"] as const;
export type SeoGeoPromptIntentType = (typeof SEO_GEO_PROMPT_INTENT_TYPES)[number];

/**
 * `desired_outcome` enum (`seo-geo-capture-config.json` `prompt_set.client_confirmation`,
 * verbatim): what the client is confirming they want THIS prompt to do for
 * their brand once captured.
 */
export const SEO_GEO_DESIRED_OUTCOMES = ["named_first", "named_in_answer", "cited", "not_applicable"] as const;
export type SeoGeoDesiredOutcome = (typeof SEO_GEO_DESIRED_OUTCOMES)[number];

/**
 * The NEUTRAL pre-fill (`prompt_set.desired_outcome_prefill_default`,
 * verbatim) — deliberately never `named_first` (which would make every
 * prompt read as a foregone failure) and never `not_applicable` (which
 * would hide real gaps). Keep this exact value; changing it un-neutralizes
 * every client approval screen silently.
 */
export const DESIRED_OUTCOME_NEUTRAL_PREFILL: SeoGeoDesiredOutcome = "named_in_answer";

export interface SeoGeoPrompt {
  promptId: string;
  promptText: string;
  intentType: SeoGeoPromptIntentType;
  /** Pre-filled `DESIRED_OUTCOME_NEUTRAL_PREFILL` at draft time — see that constant's doc. Per-prompt client edits are not wired (no gate-response field carries them yet; `GateResponse` only carries approve/revise/reject + free-text feedback), so every prompt currently freezes with the neutral default. */
  desiredOutcome: SeoGeoDesiredOutcome;
}

/** What step 02 proposes to the human gate (step 03) — not yet frozen/hashed. */
export interface SeoGeoPromptSetDraft {
  prompts: SeoGeoPrompt[];
  competitorRoster: string[];
  source: "reused" | "drafted";
  /** `PROMPT_TEMPLATE_VERSION` the prompts were drafted from — carried on a reused set from its frozen record. */
  templateVersion: number;
  /**
   * Why a recurring run drafted fresh instead of reusing. Absent on a baseline
   * run (drafting is simply what baselines do) and on a genuine reuse.
   */
  redraftReason?: "no_prior_frozen_set" | "template_version_changed";
  /** BCP-47-ish language tag the prompts were actually drafted in (e.g. "en", "es") — always the language ACTUALLY used, after any fallback. */
  language: string;
  /** True when the client's requested/profile language has no template set and this draft fell back to "en" — never silent (surfaced on the gate payload and frozen alongside the set). */
  languageFallbackApplied: boolean;
  /** Per-intent-type shortfalls against the enforced quota (RFC-04 §2 Phase 1's "Per-intent-type quota enforced"), e.g. after 5-shingle dedupe removed a near-duplicate with nothing to backfill it — never silently padded with a fabricated prompt to hit the count. Empty when every intent type met its quota. */
  quotaShortfalls: string[];
}

/** What step 04 freezes after the gate approves — the reproducibility-spine fields RFC-04 §2 Phase 1 calls for. */
export interface SeoGeoFrozenSet {
  prompts: SeoGeoPrompt[];
  competitorRoster: string[];
  promptSetHash: string;
  templateVersion: number;
  competitorSetHash: string;
  engineListHash: string;
  gazetteerHash: string;
  /** True when this recurring run's prompt set differs from the prior frozen one — logged via `memory.appendDecision`, never silent (RFC-04 §3/§4). */
  driftLogged: boolean;
  language: string;
  languageFallbackApplied: boolean;
  quotaShortfalls: string[];
}

export interface SeoGeoCrawlAspectResult {
  aspect: string;
  runId: string;
  fromCache: boolean;
  /**
   * Present only for the `"technical-infra"` aspect (T-A2/SCRUM-236): the
   * real, HTTP-derived crawl facts `research.crawlTechnicalSeo` returned —
   * `undefined` either because this isn't that aspect, or because no scraper
   * capable of crawling is configured (`not_available`, never a placeholder).
   */
  technicalSnapshot?: import("@agent-engine/tools").TechnicalSeoSnapshot;
}

/**
 * Phase 2's output. Most inputs still honestly report `coverage:
 * "unavailable"` (no real Core Web Vitals tool, on-page content parser, or
 * keyword/content-gap NLP classifier exists in this environment) — but a
 * real subset (`measurements.ts`'s `buildTechnicalMeasurements`) is now
 * genuinely `coverage: "measured"` from `technicalSnapshot`'s real crawl
 * facts (T-A2/SCRUM-236), where before this ticket EVERY input was
 * unconditionally unavailable regardless of what step 05 actually crawled.
 */
export interface SeoGeoTechnicalPhaseResult {
  seoMeasurements: Record<string, import("@agent-engine/tool-karos-seo-geo").InputMeasurement>;
  geoReadinessMeasurements: Record<string, import("@agent-engine/tool-karos-seo-geo").InputMeasurement>;
  crawlSnapshotHash: string;
  aspectsAttempted: number;
  aspectsCompleted: number;
}

export interface SeoGeoVisibilityCapture {
  cells: SeoGeoCaptureCell[];
  responseSetHash: string;
  attemptedCount: number;
  /**
   * Cells whose capture slot COMPLETED — i.e. the tool call did not throw.
   * This counts tooling success, NOT data availability: a cell that came back
   * `captureTier: "UNAVAILABLE"` is still "captured" by this measure, because
   * the capture itself worked and honestly reported having nothing. Do not
   * use this to decide whether a run has enough data to score — see
   * `measuredCount`.
   */
  capturedCount: number;
  /**
   * Cells carrying data a grade may actually be computed from —
   * `captureTier !== "UNAVAILABLE"`, the same test `denominatorFor` in
   * `karos-seo-geo/src/visibility-metrics.ts` uses for `N_e`, so the two can
   * never disagree about what "usable" means.
   *
   * This is the number that answers "did this run measure anything at all".
   * `capturedCount` cannot: `research.captureVisibility` currently has no real
   * capture adapter and returns a successful, schema-valid `UNAVAILABLE` cell
   * for every input, so `capturedCount` equals the full prompt×engine matrix
   * on a run that measured precisely nothing.
   */
  measuredCount: number;
}

/** Phase 4's output, doubled for the N/N_e dual-freeze (RFC-04 §4's "BLOCKING scoring-model decision for Daniel"). */
export interface SeoGeoScoringResult {
  seoScore: ScoreBreakdown;
  geoReadiness: ScoreBreakdown;
  visibilityByN: VisibilityIndexResult | null;
  visibilityByNe: VisibilityIndexResult | null;
  inputsDigest: string;
  hashInputsIncomplete: boolean;
  missingHashInputs: string[];
}

export interface SeoGeoConnectorStatus {
  key: string;
  googleProduct: string;
  connected: boolean;
  reason: string;
}

/** Phase 5's output — every connector reported honestly as not connected, and the gated config-edit doc referenced, never applied (RFC-04 §4). */
export interface SeoGeoConnectorOverlay {
  sourceLadder: readonly string[];
  connectors: SeoGeoConnectorStatus[];
  pendingConfigEdit: {
    file: string;
    status: "GATED_NOT_APPLIED";
    note: string;
  };
}

export interface SeoGeoFixDraft {
  recId: string;
  title: string;
  description: string;
}

/** The one merged report object persisted at Phase 8 (RFC-04 §2 Phase 8). */
export interface SeoGeoReport {
  seoScore: ScoreBreakdown;
  geoReadiness: ScoreBreakdown;
  visibility: {
    byN: VisibilityIndexResult | null;
    byNe: VisibilityIndexResult | null;
    /**
     * SCRUM-390: this used to be a hardcoded literal advertising an open
     * decision ("pending", "blockingOn: Daniel...") over an engine that had
     * already made it — AU28/SCRUM-319 resolved N vs N_e with data and froze
     * the answer as `VISIBILITY_DENOMINATOR_DECISION` (status: "resolved").
     * The report now reads the frozen record instead of repeating the stale
     * literal.
     */
    denominatorDecision: VisibilityDenominatorDecision;
  };
  geoScoreModel: {
    weightsStatus: string;
    computed: false;
    note: string;
  };
  /**
   * SCRUM-396: which AI-visibility engines this run's numbers are about.
   * `accepted` is the full ratified list (what a stored cell may claim);
   * `captured` is the subset this run actually sent traffic to and the list
   * `engineListHash` covers. Stated on the report so a renderer reads the
   * engine count instead of hardcoding one.
   */
  engines: {
    accepted: SeoGeoVisibilityEngine[];
    captured: SeoGeoVisibilityEngine[];
    decision: typeof SEO_GEO_VISIBILITY_ENGINE_DECISION;
  };
  connectorOverlay: SeoGeoConnectorOverlay;
  firedRecommendations: FiredRecommendation[];
  fixDrafts: SeoGeoFixDraft[];
  narrative: string;
  reproducibility: {
    inputsDigest: string;
    hashInputsIncomplete: boolean;
    missingHashInputs: string[];
  };
  promptSet: {
    prompts: SeoGeoPrompt[];
    source: "reused" | "drafted";
    promptSetHash: string;
    competitorSetHash: string;
    /** The language this frozen set's prompts were actually drafted in — must reflect the client's language on every run, baseline and recurring alike (SCRUM-320: a recurring run silently reporting "en" for a client whose frozen prompts are Spanish is the exact regression this field guards against). */
    language: string;
    languageFallbackApplied: boolean;
    quotaShortfalls: string[];
  };
  runKind: string;
}

export interface SeoGeoAgentWorkflowResult {
  seoScore: number;
  geoReadinessScore: number;
  visibilityIndexN: number | null;
  visibilityIndexNe: number | null;
  firedRecommendationCount: number;
  fixDraftCount: number;
  deliverableId: string;
  inputsDigest: string;
  hashInputsIncomplete: boolean;
}
