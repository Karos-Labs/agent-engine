import { z } from "zod";
import { AnnotationsSchema, ReviewSchema, TriagePayloadSchema } from "./types.js";

export { ReviewSchema, AnnotationsSchema, TriagePayloadSchema };

/** `triage-config.json`'s shape, loosely validated — a client's frozen `02-config.json` is a per-client copy of this same shape (`references/scoring.md`). */
export const TriageConfigSchema = z.object({
  triage_config_version: z.string(),
  proposed_actions: z.object({
    rules: z.array(
      z.object({
        id: z.string(),
        when_any_signal: z.array(z.string()).optional(),
        when_any_signal_prefix: z.array(z.string()).optional(),
        action: z.string(),
      }),
    ),
    already_responded: z.string(),
    default: z.string(),
  }),
  value_signals: z.object({
    has_question: z.number(),
    factual_error: z.number(),
    fixable_complaint: z.number(),
    service_recovery_opportunity: z.number(),
    detailed_positive: z.number(),
    // `default` is required — `triage.ts` falls back to it (`vis[review.platform] ?? vis.default`)
    // for any platform not explicitly listed. A plain z.record can't express a required key
    // alongside arbitrary others, so a per-client config override that omitted `default` used
    // to pass validation and then silently score every unlisted-platform review as NaN — the
    // deterministic routing authority (RFC-08: "the model extracts, arithmetic routes")
    // degrading with no error anywhere (a triage-config-hardening audit finding).
    platform_visibility: z.object({ default: z.number() }).catchall(z.number()),
  }),
  recency_decay: z.object({
    full_value_within_days: z.number(),
    zero_value_after_days: z.number(),
  }),
  urgency_signals: z.object({
    rating_1: z.number(),
    rating_2: z.number(),
    crisis_keyword: z.number(),
    influence_badge: z.number(),
    burst_context: z.number(),
  }),
  routes: z.object({
    flag_threshold: z.number(),
    respond_threshold: z.number(),
  }),
  crisis: z.object({
    rating_dip: z.object({
      delta: z.number(),
      window_days: z.number(),
      min_reviews_in_window: z.number(),
      baseline_days: z.number(),
    }),
    negative_burst: z.object({
      count: z.number(),
      max_rating: z.number(),
      window_hours: z.number(),
    }),
    keyword_instant: z.boolean(),
    max_trigger_age_days: z.number(),
  }),
  crisis_keywords: z.record(z.string(), z.array(z.string())),
});

/** `reputation.triage`'s tool input: the envelope (per `envelope.py build`) plus an optional per-client config override. */
export const TriageToolInputSchema = z.object({
  payload: TriagePayloadSchema,
  config: TriageConfigSchema.optional(),
});
export type TriageToolInput = z.infer<typeof TriageToolInputSchema>;
