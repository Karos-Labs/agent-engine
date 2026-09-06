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
 * requires genuine external research. This comment used to say `research.pull`
 * was a "cached/deterministic stand-in with no live search backend" — that has
 * not been true since it was wired to a real scraper, and the claim outlived
 * the condition long enough to send a reader looking for a retrieval gap that
 * had already been closed. It performs live search; six sources per intel run
 * (`create-intel-report-agent-workflow.ts` step 01). The target still is not a
 * schema floor, for the reason below rather than for want of retrieval: how
 * many verifiable competitors a query surfaces is a property of the market and
 * the query, not something a run can be compelled to produce. A hard schema
 * minimum here would force the model to either
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

/**
 * The portal's `BrandVoiceRow` (`karosCMO/src/lib/types.ts` lines 1497-1500,
 * read directly): one row of the brand-voice comparison TABLE, keyed by
 * dimension, with one column per company.
 * ```
 * export interface BrandVoiceRow { dimension: string; scores: Record<string, string>; }
 * ```
 * This used to be `z.array(z.string())` here, which is not that shape at all —
 * a flat list cannot populate a per-company comparison table, so the portal
 * rendered nothing for it. Corrected under SCRUM-267 (T-A18): the persisted
 * record has to BE the portal's `ClientReport`, field for field.
 */
export const BrandVoiceRowSchema = z.object({
  dimension: z.string().min(1),
  scores: z.record(z.string(), z.string()),
});
export type BrandVoiceRow = z.infer<typeof BrandVoiceRowSchema>;

/** The portal's `brandVoiceArchetypes` element (`ClientReport`, line 1602): `Array<{ company: string; archetype: string }>` — again NOT a flat string list. */
export const BrandVoiceArchetypeSchema = z.object({
  company: z.string().min(1),
  archetype: z.string().min(1),
});
export type BrandVoiceArchetype = z.infer<typeof BrandVoiceArchetypeSchema>;

/**
 * The company-profile extras the portal's `ClientReport` carries "beyond what
 * Client already stores" (`karosCMO/src/lib/types.ts` lines 1576-1584). Legacy
 * populated them by regex-parsing the report markdown
 * (`report-parser.ts` -> `buildClientReport`); here the model reports them
 * directly, which is the whole point of a structured output. All optional,
 * exactly as the portal declares them.
 */
// Top-level fields below carry .describe() transcribed from this schema's own doc comment
// ("the company-profile extras the portal's ClientReport carries beyond what Client already
// stores... all optional, exactly as the portal declares them") and each field's own name against
// the portal's ClientReport interface documented above. None of these eight had a per-field TSDoc
// comment of their own to transcribe (SCRUM-293 flag) — descriptions are the field's evident,
// portal-mirrored purpose, not new invented copy.
export const ReportProfileExtrasSchema = z.object({
  url: z.string().optional().describe("The client's website URL, as the portal's ClientReport.url."),
  businessType: z.string().optional().describe("The client's business type/category, as the portal's ClientReport.businessType."),
  founded: z.string().optional().describe("When the client company was founded, as the portal's ClientReport.founded."),
  authorization: z.string().optional().describe("The client's regulatory authorization status, as the portal's ClientReport.authorization."),
  cnpj: z.string().optional().describe("The client's Brazilian company registration number (CNPJ), as the portal's ClientReport.cnpj."),
  minInvestment: z.string().optional().describe("The client's minimum investment figure, as the portal's ClientReport.minInvestment."),
  techStack: z.string().optional().describe("The client's technology stack, as the portal's ClientReport.techStack."),
  reportStatus: z.string().optional().describe("This report's status label, as the portal's ClientReport.reportStatus."),
});


/**
 * One buyer persona of the client's ICP blueprint — the structure legacy's
 * "## Target Audience" section carried (karosCMO `brain.ts`, 2026-08) and
 * this schema had acknowledged as "a real, acknowledged omission for a future
 * revision" since v2 of the craft guide. Every field is prose or a list of
 * short strings so the whole block reads as a document, and every field is
 * optional inside the persona so the model writes what the evidence supports
 * and omits what it does not (Zero Placeholder Rule) rather than padding.
 */
export const TargetAudiencePersonaSchema = z.object({
  label: z.string().min(1).describe("The persona in one line: role title at company/customer type, e.g. 'VP Marketing at a Series B B2B SaaS company'."),
  isPrimary: z.boolean().default(false).describe("True for the primary ICP; false for a secondary persona."),
  firmographics: z.string().optional().describe("Company size band, revenue range, vertical, geography (B2C: age, income, lifestyle) — grounded, not assumed."),
  role: z.string().optional().describe("Specific title(s) and where they sit in the buying committee: buyer, champion, influencer, or end user."),
  painPoints: z.array(z.string()).default([]).describe("4-6 specific, functional problems this persona faces, each mapping to something the client addresses."),
  successMetrics: z.array(z.string()).default([]).describe("The KPIs or outcomes this persona is judged on."),
  incumbentTools: z.array(z.string()).default([]).describe("Named products, platforms or methods they use today — specific names, not category labels."),
  incumbentShortfalls: z.array(z.string()).default([]).describe("Where those incumbents fall short in ways the client's offer addresses."),
  switchingTriggers: z.array(z.string()).default([]).describe("Observable events that start an evaluation: contract cycles, growth milestones, failures, mandates."),
  channels: z.array(z.string()).default([]).describe("Named platforms/formats where this persona consumes professional content, with the format that hooks them."),
  trustBuilders: z.array(z.string()).default([]).describe("What makes this persona believe a claim: peer logos, certifications, third-party benchmarks, named case studies."),
  vocabulary: z.array(z.string()).default([]).describe("Professional jargon and terms this persona uses — for copy to mirror."),
  problemPhrases: z.array(z.string()).default([]).describe("Near-verbatim phrases they use to describe the problem when searching or complaining."),
  outcomePhrases: z.array(z.string()).default([]).describe("The language of success — what they say they want, in their words."),
  avoidPhrases: z.array(z.string()).default([]).describe("Terms that trigger scepticism or read as vendor-speak to this persona."),
});
export type TargetAudiencePersona = z.infer<typeof TargetAudiencePersonaSchema>;

/**
 * The client's ICP blueprint as this run could ground it. Optional at the top
 * level — a run with no audience evidence writes nothing rather than inventing
 * a persona — but when present it is what every downstream content agent
 * reads for WHO it is writing to.
 */
export const TargetAudienceSchema = z.object({
  summary: z.string().min(1).describe("Two to four sentences: who buys, why, and what the client's stated ICP is if the client stated one."),
  personas: z.array(TargetAudiencePersonaSchema).min(1).describe("One or more labelled personas; the primary first."),
  evidence: z.array(z.string()).default([]).describe("Where this came from, in the same source labels as the analysis prose: context-provided / training knowledge / industry pattern."),
});
export type TargetAudience = z.infer<typeof TargetAudienceSchema>;

export const IntelReportOutputSchema = ReportProfileExtrasSchema.extend({
  /** The date the report describes, as the portal stores it (`ClientReport.reportDate`, a string). Defaulted at build time when the model omits it. */
  reportDate: z.string().optional().describe("The date the report describes, as the portal stores it (ClientReport.reportDate). Defaulted at build time when the model omits it."),
  dimensionScores: z
    .array(DimensionScoreSchema)
    .length(DIMENSION_KEYS.length)
    .describe(
      "The model's 0-100 judgment score for each of the 8 fixed dimensions (contentMessaging, conversion, seo, geo, positioning, brand, growth, social — see DIMENSION_WEIGHTS). overallScore/overallGrade are then computed deterministically from these, never trusted to the model.",
    ),
  contentAnalysis: z.string().min(1).describe("Long-form prose analysis of the client's content & messaging dimension."),
  conversionAnalysis: z.string().min(1).describe("Long-form prose analysis of the client's conversion dimension."),
  seoAnalysis: z.string().min(1).describe("Long-form prose analysis of the client's SEO dimension."),
  geoAnalysis: z.string().min(1).describe("Long-form prose analysis of the client's GEO (generative-engine optimization) dimension."),
  positioningAnalysis: z.string().min(1).describe("Long-form prose analysis of the client's market positioning dimension."),
  brandAnalysis: z.string().min(1).describe("Long-form prose analysis of the client's brand dimension."),
  growthAnalysis: z.string().min(1).describe("Long-form prose analysis of the client's growth dimension."),
  swot: SwotSchema.describe(
    "Strengths/weaknesses/opportunities/threats, each synthesized from the report's own dimension scores and analysis prose. Schema-enforced minimum bullet counts (4/4/3/3) mirror the legacy prompt template exactly.",
  ),
  recommendations: z.array(RecommendationSchema).default([]).describe("The report's prioritized, numbered recommendations for the client."),
  competitorRankings: z.array(CompetitorRankingSchema).default([]).describe("Each competitor's overall score/grade/rank plus its best and weakest dimension."),
  competitors: z
    .array(ClientCompetitorSchema)
    .default([])
    .describe(
      "The full competitor roster this run identified, field-for-field matching the portal's ClientCompetitor interface. Merged (never replaced wholesale) with any existing manually-curated rows by write-report.ts.",
    ),
  brandVoiceRows: z.array(BrandVoiceRowSchema).optional().describe("The brand-voice comparison table: one row per scored dimension, one score per company."),
  brandVoiceArchetypes: z.array(BrandVoiceArchetypeSchema).optional().describe("Each company's brand-voice archetype label."),
  brandVoiceTerritory: z.string().optional().describe("The client's claimed brand-voice territory, as free text."),
  customerSentiment: z
    .array(CustomerSentimentEntrySchema)
    .optional()
    .describe("Per-company customer review-platform ratings (Reclame Aqui for Brazilian companies; G2/Capterra/Trustpilot otherwise)."),
  whitespaceOpportunities: z.array(z.string()).optional().describe("Market gaps or unclaimed positioning opportunities the competitive analysis surfaced."),
  /**
   * Directive 2's "Dynamic Brand Feedback Loop" closing section
   * (`karosCMO/src/lib/intel/brain.ts` lines 225, 561-574: "This section
   * must exist in every report.") — a prescriptive synthesis of what the
   * competitive/positioning analysis implies for the client's brand
   * guidelines, not a summary. Required (not optional) because legacy states
   * it unconditionally, unlike e.g. Customer Sentiment which is explicitly
   * conditional on data availability.
   */
  targetAudience: TargetAudienceSchema.optional().describe(
    "The client's ICP blueprint — personas, pains, incumbents, channels and vocabulary — grounded in the research and the client's own target-audience document when one was provided. Optional: omit entirely rather than invent an audience the evidence does not support.",
  ),
  brandSynchronizationUpdate: z
    .string()
    .min(1)
    .describe(
      "A prescriptive synthesis of what the competitive/positioning analysis implies for the client's brand guidelines, not a summary. Required because legacy states this section unconditionally in every report.",
    ),
});
export type IntelReportOutput = z.infer<typeof IntelReportOutputSchema>;

/**
 * The portal's stored dimension score (`karosCMO/src/lib/types.ts` lines
 * 1464-1469) — three fields, not two:
 * ```
 * export interface DimensionScore { dimension: string; weight: number; score: number; }
 * ```
 * `weight` is DELIBERATELY absent from the model-facing `DimensionScoreSchema`
 * above and filled in here from `DIMENSION_WEIGHTS`, for the same reason
 * `overallScore` is computed rather than accepted: the weights are the scoring
 * methodology, fixed in code, and a model that could restate them could also
 * restate them wrong. The portal renders each dimension's contribution FROM
 * this field, so omitting it (as this package did before SCRUM-267) renders
 * every weight as `undefined`.
 */
export interface PersistedDimensionScore {
  dimension: string;
  weight: number;
  score: number;
}

/**
 * THE PORTAL'S `ClientReport`, field for field
 * (`karosCMO/src/lib/types.ts` lines 1572-1613, read directly from the
 * checked-out portal source — not reconstructed from the ticket text).
 *
 * This replaces `ClientReportRecord`, which was `IntelReportOutput` plus four
 * bookkeeping fields and therefore NOT the shape the portal reads: it had no
 * `id`, no `clientId`, no `reportDate`, no `rawMarkdown`, no `reportHtml`, no
 * `weight` on its dimension scores, and it carried `brandSynchronizationUpdate`,
 * a field the portal's interface does not declare. SCRUM-267 names two of those
 * directly; Tomer's 2026-08-28 decision 5 makes the whole list load-bearing —
 * "the output must be written in EXACTLY the same shape, to EXACTLY the same
 * Firestore location the system already reads from."
 *
 * So: every field below exists on the portal's interface, and no field below
 * does not. `brandSynchronizationUpdate` survives as a rendered SECTION inside
 * `rawMarkdown`/`reportHtml` (which is where every other section of the legacy
 * report lived too), never as an undeclared extra key on the document.
 */
export interface ClientReport {
  id: string;
  clientId: string;
  reportDate: string;
  url?: string;
  businessType?: string;
  founded?: string;
  authorization?: string;
  cnpj?: string;
  minInvestment?: string;
  techStack?: string;
  reportStatus?: string;
  overallScore: number;
  overallGrade: string;
  dimensionScores: PersistedDimensionScore[];
  competitorRankings: CompetitorRanking[];
  contentAnalysis: string;
  conversionAnalysis: string;
  seoAnalysis: string;
  geoAnalysis: string;
  positioningAnalysis: string;
  brandAnalysis: string;
  growthAnalysis: string;
  swot: Swot;
  recommendations: Recommendation[];
  brandVoiceRows?: BrandVoiceRow[];
  brandVoiceArchetypes?: BrandVoiceArchetype[];
  brandVoiceTerritory?: string;
  customerSentiment?: CustomerSentimentEntry[];
  whitespaceOpportunities?: string[];
  rawMarkdown: string;
  reportHtml?: string;
  pdfUrl?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * The exact set of keys the portal's `ClientReport` declares. Used by
 * `assertPortalClientReportShape` to fail a write that has drifted — an extra
 * key means this package invented a field the portal will never read; a
 * missing REQUIRED key means the portal renders a hole.
 */
export const CLIENT_REPORT_REQUIRED_KEYS = [
  "id",
  "clientId",
  "reportDate",
  "overallScore",
  "overallGrade",
  "dimensionScores",
  "competitorRankings",
  "contentAnalysis",
  "conversionAnalysis",
  "seoAnalysis",
  "geoAnalysis",
  "positioningAnalysis",
  "brandAnalysis",
  "growthAnalysis",
  "swot",
  "recommendations",
  "rawMarkdown",
  "createdAt",
  "updatedAt",
] as const;

export const CLIENT_REPORT_OPTIONAL_KEYS = [
  "url",
  "businessType",
  "founded",
  "authorization",
  "cnpj",
  "minInvestment",
  "techStack",
  "reportStatus",
  "brandVoiceRows",
  "brandVoiceArchetypes",
  "brandVoiceTerritory",
  "customerSentiment",
  "whitespaceOpportunities",
  "reportHtml",
  "pdfUrl",
] as const;

/**
 * The Firestore collection the portal reads a client report FROM — literally
 * `adminDb().collection("clientReports")` (`karosCMO/src/lib/data.ts` line
 * 105), with the document id equal to the clientId (`getClientReport`, line
 * 1369: `col.clientReports().doc(clientId).get()`).
 *
 * Named here as a constant because decision 5's constraint is about this exact
 * string: the read path does not change, so the write path has to come to it.
 */
export const CLIENT_REPORTS_COLLECTION = "clientReports";

/** One doc per client (legacy `upsertClientReport`'s Firestore doc ID = clientId) — `ctx.clientSlug` already scopes the tenant partition, so no client identifier repeats in the path. */
export function reportSegments(): string[] {
  return ["intel", "report"];
}

export function competitorSegments(): string[] {
  return ["intel", "competitors"];
}
