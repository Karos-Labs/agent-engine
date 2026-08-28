import { z } from "zod";
import { AnnotationsSchema, ReviewSchema, TriagePayloadSchema } from "./types.js";

export { ReviewSchema, AnnotationsSchema, TriagePayloadSchema };

// Top-level fields below have no existing per-field TSDoc to transcribe (SCRUM-293 flag) —
// descriptions synthesized from this schema's own header comment (references/scoring.md) and
// each field's evident role in triage.ts's routing arithmetic. Deeply-nested rubric numbers
// inside these objects are not individually annotated — a known depth limit for this ticket.
export const TriageConfigSchema = z.object({
  triage_config_version: z.string().describe("This config shape's version string, for compatibility checks."),
  proposed_actions: z
    .object({
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
    })
    .describe("Rule-based mapping from a review's signals to a proposed action string."),
  value_signals: z
    .object({
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
    })
    .describe("Point weights for each value signal that feeds a review's overall value score."),
  recency_decay: z.object({ full_value_within_days: z.number(), zero_value_after_days: z.number() }).describe("How a review's value score decays with its age."),
  urgency_signals: z
    .object({
      rating_1: z.number(),
      rating_2: z.number(),
      crisis_keyword: z.number(),
      influence_badge: z.number(),
      burst_context: z.number(),
    })
    .describe("Point weights for each urgency signal that feeds a review's overall urgency score."),
  routes: z.object({ flag_threshold: z.number(), respond_threshold: z.number() }).describe("Score thresholds that decide RESPOND vs FLAG vs NO_ACTION."),
  crisis: z
    .object({
      rating_dip: z.object({
        delta: z.number(),
        window_days: z.number(),
        min_reviews_in_window: z.number(),
        baseline_days: z.number(),
      }),
      negative_burst: z.object({ count: z.number(), max_rating: z.number(), window_hours: z.number() }),
      keyword_instant: z.boolean(),
      max_trigger_age_days: z.number(),
    })
    .describe("Thresholds that trigger a crisis alert: a rating dip, a negative-review burst, or an instant keyword hit."),
  crisis_keywords: z.record(z.string(), z.array(z.string())).describe("Keyword lists, by category, that can instantly trigger a crisis alert."),
});

/** `reputation.triage`'s tool input: the envelope (per `envelope.py build`) plus an optional per-client config override. */
export const TriageToolInputSchema = z.object({
  payload: TriagePayloadSchema.describe("The reviews and routing state to triage this call — built by envelope.py build in legacy."),
  config: TriageConfigSchema.optional().describe("Per-client override of the frozen triage rubric. Omitted uses DEFAULT_TRIAGE_CONFIG."),
});
export type TriageToolInput = z.infer<typeof TriageToolInputSchema>;
