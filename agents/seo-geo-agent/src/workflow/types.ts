import type {
  FiredRecommendation,
  ScoreBreakdown,
  SeoGeoCaptureCell,
  VisibilityIndexResult,
} from "@agent-engine/tool-karos-seo-geo";

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
  /** At least one entry — `seoGeo.score`'s `visibility.clientDomains` requires `min(1)`; see `deriveClientDomain`. */
  clientDomains: string[];
}

export interface SeoGeoPrompt {
  promptId: string;
  promptText: string;
}

/** What step 02 proposes to the human gate (step 03) — not yet frozen/hashed. */
export interface SeoGeoPromptSetDraft {
  prompts: SeoGeoPrompt[];
  competitorRoster: string[];
  source: "reused" | "drafted";
}

/** What step 04 freezes after the gate approves — the reproducibility-spine fields RFC-04 §2 Phase 1 calls for. */
export interface SeoGeoFrozenSet {
  prompts: SeoGeoPrompt[];
  competitorRoster: string[];
  promptSetHash: string;
  competitorSetHash: string;
  engineListHash: string;
  gazetteerHash: string;
  /** True when this recurring run's prompt set differs from the prior frozen one — logged via `memory.appendDecision`, never silent (RFC-04 §3/§4). */
  driftLogged: boolean;
}

export interface SeoGeoCrawlAspectResult {
  aspect: string;
  runId: string;
  fromCache: boolean;
}

/** Phase 2's output — see `create-seo-geo-agent-workflow.ts` step 06 for why every measurement is `coverage: "unavailable"` in this environment. */
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
    denominatorDecision: {
      status: "pending";
      blockingOn: string;
      defaultUsedForCanonicalScore: "N";
    };
  };
  geoScoreModel: {
    weightsStatus: string;
    computed: false;
    note: string;
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
