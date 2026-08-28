import { z } from "zod";

/** `capture_tier` (review-schema.md): set at capture, never upgraded. `UNAVAILABLE` is a tombstone, never a fabricated zero. */
export const REPUTATION_CAPTURE_TIERS = ["MEASURED", "ESTIMATED", "UNAVAILABLE"] as const;
export type ReputationCaptureTier = (typeof REPUTATION_CAPTURE_TIERS)[number];

export const RouteSchema = z.enum(["RESPOND", "FLAG", "NO_ACTION"]);
export type Route = z.infer<typeof RouteSchema>;

// Fields below have no existing per-field TSDoc to transcribe (SCRUM-293 flag) — descriptions
// synthesized from this schema's own header comment (review-schema.md) and each field's evident
// role in triage.ts's scoring.
/** The one model-touched signal set (review-schema.md `annotations`) — cached forever per `(review_id, classifier_model_id)`, never recomputed by this engine. */
export const AnnotationsSchema = z.object({
  classifier_model_id: z.string().describe("Which classifier model produced these annotations, for cache-key and audit purposes."),
  sentiment: z.enum(["pos", "neg", "neutral", "mixed"]).describe("The review's overall sentiment."),
  factual_error: z.boolean().describe("Whether the review asserts something factually wrong the response should correct."),
  fixable_complaint: z.boolean().describe("Whether the review raises a complaint the business could plausibly fix."),
  detailed_positive: z.boolean().describe("Whether the review is a substantive, detailed positive account (worth amplifying)."),
  service_recovery_opportunity: z.boolean().describe("Whether responding could plausibly recover this reviewer's satisfaction."),
});
export type Annotations = z.infer<typeof AnnotationsSchema>;

/** The normalized review record every capture adapter emits (review-schema.md). */
export const ReviewSchema = z.object({
  review_id: z.string().min(1).describe("The review's unique id, as assigned by its source platform."),
  platform: z.string().min(1).describe("The platform this review was posted on (e.g. \"google\", \"appstore\")."),
  source: z.string().min(1).describe("Which capture adapter produced this record (e.g. \"gbp_api\", \"appstore_rss\", \"manual_export\")."),
  capture_tier: z.enum(REPUTATION_CAPTURE_TIERS).describe("Set at capture, never upgraded. UNAVAILABLE is a tombstone, never a fabricated zero."),
  listing_id: z.string().nullable().optional().describe("Which of the client's listings this review belongs to."),
  listing_label: z.string().nullable().optional().describe("Human-readable label for the listing this review belongs to."),
  rating: z.number().int().min(1).max(5).nullable().optional().describe("The reviewer's star rating, 1-5, if the platform carries one."),
  author: z.string().nullable().optional().describe("The reviewer's display name."),
  author_badge: z.string().nullable().optional().describe("A platform-conferred badge on the reviewer (e.g. a Local Guide level), if any."),
  language: z.string().nullable().optional().describe("The review text's language code, if known."),
  text: z.string().nullable().optional().describe("The review's text content."),
  created_at: z.string().describe("When the review was originally posted, as an ISO date string."),
  updated_at: z.string().nullable().optional().describe("When the review was last edited, as an ISO date string, if the platform reports edits."),
  owner_response: z
    .object({ text: z.string(), responded_at: z.string() })
    .nullable()
    .optional()
    .describe("The business's existing public reply to this review, if one has already been posted."),
  url: z.string().nullable().optional().describe("A direct link to the review on its platform, if available."),
  captured_at: z.string().optional().describe("When this engine captured the review, as an ISO date string."),
  raw_sha256: z.string().nullable().optional().describe("A hash of the raw captured payload, for change detection and audit."),
  text_truncated: z.boolean().optional().describe("Whether `text` was truncated from a longer original by the capture adapter."),
  unavailable_reason: z.string().optional().describe("Why this record is a tombstone, when capture_tier is UNAVAILABLE."),
  /** Absent entirely (not just null) on an UNAVAILABLE tombstone — the fixtures are the shape authority. */
  annotations: AnnotationsSchema.optional(),
});
export type Review = z.infer<typeof ReviewSchema>;

/** Built by `envelope.py build` in legacy — the ONE payload shape both `triage.py` and `analysis.py` consume. */
export const TriagePayloadSchema = z.object({
  now: z.string().describe("The caller's clock reading, as an ISO date string — triage is a pure function and never reads the system clock itself."),
  reviews: z.array(ReviewSchema).default([]).describe("Every review to triage in this call."),
  already_responded_ids: z.array(z.string()).default([]).describe("review_ids the business has already publicly responded to — routed away from RESPOND again."),
  seen_review_ids: z.array(z.string()).default([]).describe("review_ids already surfaced in a prior triage pass, so a repeat run doesn't re-flag them as new."),
  alerted_crisis_signatures: z.array(z.string()).default([]).describe("Crisis signatures already alerted on, so the same crisis condition doesn't re-fire an alert."),
  baseline_rating_avg: z.record(z.string(), z.number()).default({}).describe("Each listing's baseline average rating, used to detect a rating-dip crisis signal."),
});
export type TriagePayload = z.infer<typeof TriagePayloadSchema>;

export const ProposedActionSchema = z.object({
  id: z.string(),
  action: z.string(),
});
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

export interface TriageResultRow {
  review_id: string;
  route: Route;
  value_score: number;
  urgency_score: number;
  draft_attached: boolean;
  signals: string[];
  crisis_hit: boolean;
  reason: string;
  proposed_action?: ProposedAction;
}

export interface RatingDipTrigger {
  type: "rating_dip";
  platform: string;
  baseline_rating_avg: number;
  window_rating_avg: number;
  window_review_count: number;
  review_ids: string[];
  signature: string;
  suppressed: boolean;
}

export interface NegativeBurstTrigger {
  type: "negative_burst";
  review_ids: string[];
  signature: string;
  suppressed: boolean;
}

export interface CrisisKeywordsTrigger {
  type: "crisis_keywords";
  reviews: Array<{ review_id: string; keywords: string[] }>;
  signature: string;
  suppressed: boolean;
}

export type CrisisTrigger = RatingDipTrigger | NegativeBurstTrigger | CrisisKeywordsTrigger;

export interface TriageResult {
  triage_config_version: string;
  now: string;
  results: TriageResultRow[];
  crisis: {
    fired: boolean;
    triggers: CrisisTrigger[];
  };
  summary: {
    respond: number;
    flag: number;
    no_action: number;
    unavailable: number;
  };
}

/** The shape of `triage-config.json` — every field `triage.py` reads. */
export interface TriageConfig {
  triage_config_version: string;
  proposed_actions: {
    rules: Array<{
      id: string;
      // `| undefined` (not just `?`): matches Zod's `.optional()` inferred output shape
      // under `exactOptionalPropertyTypes` — removing triage-tool.ts's `as TriageConfig`
      // cast (a triage-config-hardening audit finding) surfaced that this interface
      // and TriageConfigSchema had silently disagreed here all along.
      when_any_signal?: string[] | undefined;
      when_any_signal_prefix?: string[] | undefined;
      action: string;
    }>;
    already_responded: string;
    default: string;
  };
  value_signals: {
    has_question: number;
    factual_error: number;
    fixable_complaint: number;
    service_recovery_opportunity: number;
    detailed_positive: number;
    platform_visibility: Record<string, number> & { default: number };
  };
  recency_decay: {
    full_value_within_days: number;
    zero_value_after_days: number;
  };
  urgency_signals: {
    rating_1: number;
    rating_2: number;
    crisis_keyword: number;
    influence_badge: number;
    burst_context: number;
  };
  routes: {
    flag_threshold: number;
    respond_threshold: number;
  };
  crisis: {
    rating_dip: { delta: number; window_days: number; min_reviews_in_window: number; baseline_days: number };
    negative_burst: { count: number; max_rating: number; window_hours: number };
    keyword_instant: boolean;
    max_trigger_age_days: number;
  };
  crisis_keywords: Record<string, string[]>;
}
