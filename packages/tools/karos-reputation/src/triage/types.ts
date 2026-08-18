import { z } from "zod";

/** `capture_tier` (review-schema.md): set at capture, never upgraded. `UNAVAILABLE` is a tombstone, never a fabricated zero. */
export const REPUTATION_CAPTURE_TIERS = ["MEASURED", "ESTIMATED", "UNAVAILABLE"] as const;
export type ReputationCaptureTier = (typeof REPUTATION_CAPTURE_TIERS)[number];

export const RouteSchema = z.enum(["RESPOND", "FLAG", "NO_ACTION"]);
export type Route = z.infer<typeof RouteSchema>;

/** The one model-touched signal set (review-schema.md `annotations`) — cached forever per `(review_id, classifier_model_id)`, never recomputed by this engine. */
export const AnnotationsSchema = z.object({
  classifier_model_id: z.string(),
  sentiment: z.enum(["pos", "neg", "neutral", "mixed"]),
  factual_error: z.boolean(),
  fixable_complaint: z.boolean(),
  detailed_positive: z.boolean(),
  service_recovery_opportunity: z.boolean(),
});
export type Annotations = z.infer<typeof AnnotationsSchema>;

/** The normalized review record every capture adapter emits (review-schema.md). */
export const ReviewSchema = z.object({
  review_id: z.string().min(1),
  platform: z.string().min(1),
  source: z.string().min(1),
  capture_tier: z.enum(REPUTATION_CAPTURE_TIERS),
  listing_id: z.string().nullable().optional(),
  listing_label: z.string().nullable().optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  author: z.string().nullable().optional(),
  author_badge: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string().nullable().optional(),
  owner_response: z.object({ text: z.string(), responded_at: z.string() }).nullable().optional(),
  url: z.string().nullable().optional(),
  captured_at: z.string().optional(),
  raw_sha256: z.string().nullable().optional(),
  text_truncated: z.boolean().optional(),
  unavailable_reason: z.string().optional(),
  /** Absent entirely (not just null) on an UNAVAILABLE tombstone — the fixtures are the shape authority. */
  annotations: AnnotationsSchema.optional(),
});
export type Review = z.infer<typeof ReviewSchema>;

/** Built by `envelope.py build` in legacy — the ONE payload shape both `triage.py` and `analysis.py` consume. */
export const TriagePayloadSchema = z.object({
  now: z.string(),
  reviews: z.array(ReviewSchema).default([]),
  already_responded_ids: z.array(z.string()).default([]),
  seen_review_ids: z.array(z.string()).default([]),
  alerted_crisis_signatures: z.array(z.string()).default([]),
  baseline_rating_avg: z.record(z.string(), z.number()).default({}),
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
      when_any_signal?: string[];
      when_any_signal_prefix?: string[];
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
