import { z } from "zod";

/**
 * A golden run for the Newsletter agent (RFC-01 §12 bullet 1): a frozen
 * input bundle plus a human-endorsed edition, signed off before the first
 * automated run. Scoped to newsletter specifically (fixed `platform:
 * "newsletter"`, the real 70-char subject / 140-char preview text /
 * 10,000-char body limits) rather than reusing the generic `evals/`
 * package's `GoldenRun` — small and newsletter-specific enough that a
 * shared type would cost more than it saves. Mirrors the X, LinkedIn,
 * Reddit, and Blog agents' golden-run schemas (same recipe, RFC-02 §5).
 */
export const NewsletterGoldenRunSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  agentId: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  endorsedOutput: z.object({
    subjectLine: z.string().min(1),
    previewText: z.string().min(1),
    intro: z.string().min(1),
    sections: z.array(
      z.object({
        heading: z.string().min(1),
        body: z.string().min(1),
        linkUrl: z.string().optional(),
      }),
    ),
    callToAction: z.object({ text: z.string().min(1), url: z.string().min(1) }),
    signoff: z.string().min(1),
    text: z.string().min(1),
    platform: z.literal("newsletter"),
  }),
  gateArgs: z
    .object({
      brandCompliance: z.object({ forbiddenTerms: z.array(z.string()).optional() }).optional(),
    })
    .default({}),
  endorsedBy: z.string().min(1),
  endorsedAt: z.string().min(1),
});
export type NewsletterGoldenRun = z.infer<typeof NewsletterGoldenRunSchema>;

export const NewsletterDeterministicAssertionResultSchema = z.object({
  goldenRunId: z.string().min(1),
  check: z.string().min(1),
  verdict: z.enum(["pass", "content_fail", "tooling_error"]),
  reason: z.string().optional(),
});
export type NewsletterDeterministicAssertionResult = z.infer<typeof NewsletterDeterministicAssertionResultSchema>;
