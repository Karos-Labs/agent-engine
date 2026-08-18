import { z } from "zod";

/**
 * The 8 scored dimensions and their fixed weights (`DEFAULT_INTEL_PROMPT`'s
 * scoring methodology, ported verbatim — RFC-05 §3 step 4): Content &
 * Messaging 15%, Conversion 15%, SEO 12%, GEO 8%, Positioning 15%, Brand
 * 10%, Growth 10%, Social 15% — sums to 100. Note "social" is scored but has
 * no dedicated long-form analysis section (only 7 of the 8 dimensions get a
 * `*Analysis` prose field below) — that asymmetry exists in the legacy
 * prompt too, not an omission introduced here.
 */
export const DIMENSION_WEIGHTS = {
  contentMessaging: 15,
  conversion: 15,
  seo: 12,
  geo: 8,
  positioning: 15,
  brand: 10,
  growth: 10,
  social: 15,
} as const;
export type DimensionKey = keyof typeof DIMENSION_WEIGHTS;
export const DIMENSION_KEYS = Object.keys(DIMENSION_WEIGHTS) as DimensionKey[];

export const DimensionScoreSchema = z.object({
  dimension: z.enum(DIMENSION_KEYS as [DimensionKey, ...DimensionKey[]]),
  /** The model's real judgment call, 0-100 — this stays an LLM assessment; only the weighted roll-up below is computed deterministically. */
  score: z.number().min(0).max(100),
});
export type DimensionScore = z.infer<typeof DimensionScoreSchema>;

export const CompetitorRankingSchema = z.object({
  company: z.string().min(1),
  score: z.number().min(0).max(100),
  grade: z.string().min(1),
  rank: z.number().int().positive(),
  bestDimension: z.string().min(1),
  weakestDimension: z.string().min(1),
});
export type CompetitorRanking = z.infer<typeof CompetitorRankingSchema>;

/**
 * Minimum-bullet-count floors ported verbatim from `DEFAULT_INTEL_PROMPT`'s
 * `## SWOT` template section (`karosCMO/src/lib/intel/brain.ts` lines
 * 436-445: "min 4 bullets" for Strengths and Weaknesses, "min 3 bullets" for
 * Opportunities and Threats). These are schema-enforced (not just prompt
 * guidance) — a judgment call, documented here: unlike the Wide Scan
 * competitor-count minimum (see `write-report.ts`'s `WIDE_SCAN_MIN_COMPETITORS`,
 * which is a soft prompt target + code warning, not a hard schema floor),
 * legacy's own template lists these SWOT counts unconditionally, with no
 * "if evidence supports it" hedge the way Customer Sentiment or Metadata are
 * explicitly marked conditional/optional in the same rules list. A SWOT
 * bullet is also synthesized FROM the report's own dimension scores and
 * analysis prose the model just wrote (not from external live research the
 * Phase-1 `research.pull` stand-in can't yet supply), so honoring this floor
 * never forces the model to fabricate evidence it doesn't have — it can
 * always ground four strengths/weaknesses and three opportunities/threats in
 * material already present in the same report.
 */
export const SWOT_MIN_STRENGTHS = 4;
export const SWOT_MIN_WEAKNESSES = 4;
export const SWOT_MIN_OPPORTUNITIES = 3;
export const SWOT_MIN_THREATS = 3;

export const SwotSchema = z.object({
  strengths: z.array(z.string()).min(SWOT_MIN_STRENGTHS),
  weaknesses: z.array(z.string()).min(SWOT_MIN_WEAKNESSES),
  opportunities: z.array(z.string()).min(SWOT_MIN_OPPORTUNITIES),
  threats: z.array(z.string()).min(SWOT_MIN_THREATS),
});
export type Swot = z.infer<typeof SwotSchema>;

export const RecommendationSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  description: z.string().default(""),
  priority: z.number().int().positive(),
  priorityLabel: z.string().min(1),
  tag: z.string().min(1),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

/**
 * Ported verbatim from legacy `karosCMO/src/lib/types.ts`'s real
 * `CustomerSentimentEntry` interface (read directly, lines 1436-1442):
 * ```
 * export interface CustomerSentimentEntry {
 *   company: string;
 *   rating?: string;
 *   ratingLabel?: string;
 *   responseTime?: string;
 *   wouldReturn?: string;
 * }
 * ```
 * This is a per-company row in a review-platform ratings table (Reclame Aqui
 * for Brazilian companies; G2/Capterra/Trustpilot otherwise — see
 * `DEFAULT_INTEL_PROMPT`'s Output Quality Rule 6 and `report.ts` lines
 * 730-753's rendering, which is literally `<td>rating (ratingLabel)</td>
 * <td>responseTime</td><td>wouldReturn</td>` per company). It is NOT a
 * theme/sentiment/evidence NLP-style structure — that shape (the previous
 * version of this schema) has no legacy counterpart at all.
 */
export const CustomerSentimentEntrySchema = z.object({
  company: z.string().min(1),
  rating: z.string().optional(),
  ratingLabel: z.string().optional(),
  responseTime: z.string().optional(),
  wouldReturn: z.string().optional(),
});
export type CustomerSentimentEntry = z.infer<typeof CustomerSentimentEntrySchema>;

/** Legacy's exact literal unions (`karosCMO/src/lib/types.ts` lines 1557/1559, confirmed
 *  again verbatim in `report-parser.ts` lines 176/178 and `refresh-apply-core.ts` lines
 *  120-122) — NOT loose strings. A model (or a manual edit) emitting anything outside
 *  these sets is a validation error, exactly like legacy's TypeScript union would be. */
export const MARKET_TIERS = ["Leader", "Challenger", "Niche", "Other"] as const;
export const OVERLAPS = ["High", "Medium", "Low-Med", "Low"] as const;
export const THREAT_LEVELS = ["HIGH", "MEDIUM", "LOW"] as const;

/**
 * Ported field-for-field from legacy's real `ClientCompetitor` interface
 * (`karosCMO/src/lib/types.ts` lines 1551-1580, read directly — NOT
 * reconstructed from paraphrase). The interface, verbatim:
 * ```
 * export interface ClientCompetitor {
 *   id: string;
 *   clientId: string;
 *   company: string;
 *   url?: string;
 *   founded?: string;
 *   marketTier: "Leader" | "Challenger" | "Niche" | "Other";
 *   minInvestment?: string;
 *   overlap: "High" | "Medium" | "Low-Med" | "Low";
 *   deepDive: boolean;
 *   positioning?: string;
 *   scale?: string;
 *   keyStrengths: string[];
 *   keyWeaknesses: string[];
 *   threatLevel?: "HIGH" | "MEDIUM" | "LOW";
 *   source: "report" | "manual";
 *   llmMentions?: number;
 *   llmMentionsAt?: number;
 *   createdAt: number;
 *   updatedAt: number;
 * }
 * ```
 * Cross-checked against the field allowlist a human-facing proposal is
 * permitted to touch, `karosCMO/src/lib/refresh-apply-core.ts` lines 105-118
 * (`COMPETITOR_FIELDS`), and against what `report-parser.ts`'s
 * `parseWideScan`/`parseCompetitorProfiles` (lines 161-184, 301-336) actually
 * populate — both agree exactly with the interface above.
 *
 * Three fields from `ClientCompetitor` are deliberately NOT in this
 * model-facing schema, each for a documented reason:
 *   - `id` / `clientId`: Firestore document bookkeeping. This package
 *     persists the whole competitor roster as one JSON array per client
 *     (`ctx.clientSlug` already scopes the tenant) rather than one row per
 *     document, so there is no per-row id/clientId to assign — the model
 *     never produces or needs one.
 *   - `createdAt` / `updatedAt`: same — per-row bookkeeping timestamps
 *     assigned by the write path (see `write-report.ts`'s merge), not
 *     something the model itself judges.
 *   - `llmMentions` / `llmMentionsAt`: legacy writes these ONLY from
 *     `syncCompetitorsFromVisibility` (a live SEO/GEO measurement pass) —
 *     never from the report-parsing path (`report-parser.ts`'s
 *     `ParsedReport.competitorRows` type explicitly omits them:
 *     `Omit<ClientCompetitor, "id" | "clientId" | "source" | "createdAt" |
 *     "updatedAt">`, and they are absent from `COMPETITOR_FIELDS` too). This
 *     package has no SEO/GEO coupling by design (see `write-report.ts`'s
 *     docstring) and the model must never invent a measured mention count,
 *     so these two fields live only on `PersistedClientCompetitor` below,
 *     carried forward mechanically by the merge, never authored by the
 *     model. See `competitor-merge.ts`.
 *
 * NOTE ON THE THREE NAMES THE INITIAL AUDIT BRIEF NAMED
 * ("pricingModel", "targetAudience", "positioningStrategy"): none of these
 * exist anywhere in the real `ClientCompetitor` interface, in
 * `refresh-apply-core.ts`'s `COMPETITOR_FIELDS` allowlist, or in
 * `report-parser.ts`'s parsing of competitor rows — confirmed by directly
 * reading all three files, not by inference. The field legacy actually has
 * is `positioning?: string` (a free-text positioning note used by the
 * "Competitor Profiles" deep-dive section), which is what this schema
 * restores instead.
 */
export const ClientCompetitorSchema = z.object({
  company: z.string().min(1),
  url: z.string().optional(),
  founded: z.string().optional(),
  marketTier: z.enum(MARKET_TIERS),
  minInvestment: z.string().optional(),
  overlap: z.enum(OVERLAPS),
  deepDive: z.boolean().default(false),
  positioning: z.string().optional(),
  scale: z.string().optional(),
  keyStrengths: z.array(z.string()).default([]),
  keyWeaknesses: z.array(z.string()).default([]),
  threatLevel: z.enum(THREAT_LEVELS).optional(),
  source: z.enum(["report", "manual"]).default("report"),
});
export type ClientCompetitor = z.infer<typeof ClientCompetitorSchema>;

/**
 * The persisted-record shape (`write-report.ts` / `get-report.ts`'s store
 * type) — `ClientCompetitor` plus the two machine-measured fields legacy
 * carries forward across regenerations but never lets the model author (see
 * the doc comment above). Not a Zod schema: nothing ever validates model
 * input against this type, it only describes what the JSON file on disk can
 * contain once the merge in `competitor-merge.ts` has run.
 */
export interface PersistedClientCompetitor extends ClientCompetitor {
  llmMentions?: number;
  llmMentionsAt?: number;
}

/**
 * The typed structured output a bounded generation step produces directly
 * (RFC-05 §4) — replacing the legacy markdown-write / regex-parse round
 * trip. `overallScore`/`overallGrade` are deliberately NOT part of this
 * schema: they're computed deterministically in code from `dimensionScores`
 * (see `scoring.ts`) rather than trusted to the model's own arithmetic —
 * the model still does every real judgment call (each dimension's score,
 * every section's prose, the SWOT, the recommendations), it just never
 * touches the weighted-sum arithmetic.
 */
/**
 * Wide Scan minimum-competitor-count target — `DEFAULT_INTEL_PROMPT`'s
 * Output Quality Rule 5 (`karosCMO/src/lib/intel/brain.ts` line 320): "At
 * least 8 competitors spanning Leader / Challenger / Niche tiers." Exported
 * as a soft target (prompt guidance + a non-blocking code-level warning in
 * `write-report.ts`), deliberately NOT a Zod `.min(8)` schema floor — a
 * judgment call, documented here: reaching 8 REAL, verifiable competitors
 * requires genuine external research (the live web search/fetch legacy's
 * `researchCompetitive` runs), and this repo's Phase-1 `research.pull` is an
 * explicit, out-of-scope-for-this-fix, cached/deterministic stand-in with no
 * live search backend (see `create-intel-report-agent-workflow.ts`'s step
 * 01 comment). A hard schema minimum here would force the model to either
 * invent competitors to satisfy the count — directly violating Directive 1's
 * zero-fabrication rule and the "real, verifiable entity" requirement in
 * Output Quality Rule 2 — or hard-fail every run until real research exists.
 * Neither is acceptable, so this stays a target the prompt states explicitly
 * and a real signal (`write-report.ts` logs a warning) surfaces when missed,
 * without corrupting the report or blocking persistence. Contrast with
 * `SWOT_MIN_STRENGTHS` etc. above, which ARE hard-enforced because a SWOT
 * bullet is synthesized from evidence already inside the same report, not
 * from research this pipeline doesn't yet have.
 */
export const WIDE_SCAN_MIN_COMPETITORS = 8;

export const IntelReportOutputSchema = z.object({
  dimensionScores: z.array(DimensionScoreSchema).length(DIMENSION_KEYS.length),
  contentAnalysis: z.string().min(1),
  conversionAnalysis: z.string().min(1),
  seoAnalysis: z.string().min(1),
  geoAnalysis: z.string().min(1),
  positioningAnalysis: z.string().min(1),
  brandAnalysis: z.string().min(1),
  growthAnalysis: z.string().min(1),
  swot: SwotSchema,
  recommendations: z.array(RecommendationSchema).default([]),
  competitorRankings: z.array(CompetitorRankingSchema).default([]),
  competitors: z.array(ClientCompetitorSchema).default([]),
  brandVoiceRows: z.array(z.string()).optional(),
  brandVoiceArchetypes: z.array(z.string()).optional(),
  brandVoiceTerritory: z.string().optional(),
  customerSentiment: z.array(CustomerSentimentEntrySchema).optional(),
  whitespaceOpportunities: z.array(z.string()).optional(),
  /**
   * Directive 2's "Dynamic Brand Feedback Loop" closing section
   * (`karosCMO/src/lib/intel/brain.ts` lines 225, 561-574: "This section
   * must exist in every report.") — a prescriptive synthesis of what the
   * competitive/positioning analysis implies for the client's brand
   * guidelines, not a summary. Required (not optional) because legacy states
   * it unconditionally, unlike e.g. Customer Sentiment which is explicitly
   * conditional on data availability.
   */
  brandSynchronizationUpdate: z.string().min(1),
});
export type IntelReportOutput = z.infer<typeof IntelReportOutputSchema>;

/** The persisted `ClientReport` record — `IntelReportOutput` plus the deterministically-computed grade and bookkeeping fields. */
export interface ClientReportRecord extends IntelReportOutput {
  overallScore: number;
  overallGrade: string;
  createdAt: number;
  updatedAt: number;
}

/** One doc per client (legacy `upsertClientReport`'s Firestore doc ID = clientId) — `ctx.clientSlug` already scopes the tenant partition, so no client identifier repeats in the path. */
export function reportSegments(): string[] {
  return ["intel", "report"];
}

export function competitorSegments(): string[] {
  return ["intel", "competitors"];
}
