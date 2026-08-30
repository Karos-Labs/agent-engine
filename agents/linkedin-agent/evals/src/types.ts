import { z } from "zod";
import { EvalLanguageSchema } from "@agent-engine/evals";
import { LINKEDIN_ARCHETYPES } from "../../src/workflow/types.js";

/**
 * A golden run for the LinkedIn agent (RFC-01 §12 bullet 1): a frozen input
 * bundle plus a human-endorsed LinkedIn post, signed off before the first
 * automated run. Scoped to LinkedIn specifically (fixed `platform:
 * "linkedin"`, the real 3000-character limit) rather than reusing the
 * generic `evals/` package's `GoldenRun` — small and LinkedIn-specific
 * enough that a shared type would cost more than it saves. Mirrors the X
 * agent's `XGoldenRunSchema` (same recipe, RFC-02 §5).
 */
export const LinkedInGoldenRunSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  agentId: z.string().min(1),
  /**
   * The language this run's client publishes in, and therefore the language
   * this endorsed post is graded as (SCRUM-308 / AU25, rung 4).
   *
   * Defaults to `en` so every golden run written before per-language grading
   * existed keeps loading unchanged. The default is NOT "unknown": a fixture
   * with no language stated is an English one, because that is what every
   * fixture written to date actually is — an "unknown" default would let a
   * Hebrew fixture be added with the field forgotten and grade nothing, which
   * is the AU32 failure mode reproduced inside the eval harness itself.
   */
  language: EvalLanguageSchema.default("en"),
  input: z.record(z.string(), z.unknown()),
  endorsedOutput: z.object({
    headline: z.string().min(1),
    hook: z.string().min(1),
    body: z.string().min(1),
    hashtags: z.array(z.string()),
    callToAction: z.string().min(1),
    targetAudience: z.string().min(1),
    archetype: z.enum(LINKEDIN_ARCHETYPES),
    text: z.string().min(1),
    platform: z.literal("linkedin"),
  }),
  gateArgs: z
    .object({
      brandCompliance: z.object({ forbiddenTerms: z.array(z.string()).optional() }).optional(),
    })
    .default({}),
  endorsedBy: z.string().min(1),
  endorsedAt: z.string().min(1),
});
export type LinkedInGoldenRun = z.infer<typeof LinkedInGoldenRunSchema>;

export const LinkedInDeterministicAssertionResultSchema = z.object({
  goldenRunId: z.string().min(1),
  check: z.string().min(1),
  verdict: z.enum(["pass", "content_fail", "tooling_error"]),
  reason: z.string().optional(),
});
export type LinkedInDeterministicAssertionResult = z.infer<typeof LinkedInDeterministicAssertionResultSchema>;
