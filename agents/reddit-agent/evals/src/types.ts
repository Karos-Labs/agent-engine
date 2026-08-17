import { z } from "zod";

/**
 * A golden run for the Reddit agent (RFC-01 §12 bullet 1): a frozen input
 * bundle plus a human-endorsed Reddit reply, signed off before the first
 * automated run. Scoped to Reddit specifically (the real 10,000-character
 * comment limit) rather than reusing the generic `evals/` package's
 * `GoldenRun` — small and Reddit-specific enough that a shared type would
 * cost more than it saves. Mirrors the X and LinkedIn agents' golden-run
 * schemas (same recipe, RFC-02 §5).
 *
 * Phase 2.5 Batch 2.1: `endorsedOutput` was reshaped from a submission
 * (`title`/`body`/`targetSubreddit`/`flair`/`hook`/`platform`) to a reply
 * (`targetThreadUrl`/`targetThreadTitle`/`replyBody`/`targetSubreddit`/
 * `disclosureIncluded`/`text`), matching `RedditReplyOutputSchema` — legacy's
 * non-negotiable rule is "comments only, never original posts."
 */
export const RedditGoldenRunSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  agentId: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  endorsedOutput: z.object({
    targetThreadUrl: z.string().min(1),
    targetThreadTitle: z.string().min(1),
    parentCommentId: z.string().min(1).optional(),
    replyBody: z.string().min(1),
    targetSubreddit: z.string().min(1),
    disclosureIncluded: z.boolean(),
    text: z.string().min(1),
  }),
  gateArgs: z
    .object({
      brandCompliance: z.object({ forbiddenTerms: z.array(z.string()).optional() }).optional(),
    })
    .default({}),
  endorsedBy: z.string().min(1),
  endorsedAt: z.string().min(1),
});
export type RedditGoldenRun = z.infer<typeof RedditGoldenRunSchema>;

export const RedditDeterministicAssertionResultSchema = z.object({
  goldenRunId: z.string().min(1),
  check: z.string().min(1),
  verdict: z.enum(["pass", "content_fail", "tooling_error"]),
  reason: z.string().optional(),
});
export type RedditDeterministicAssertionResult = z.infer<typeof RedditDeterministicAssertionResultSchema>;
