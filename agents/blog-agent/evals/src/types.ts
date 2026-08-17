import { z } from "zod";

/**
 * A golden run for the Blog agent (RFC-01 §12 bullet 1): a frozen input
 * bundle plus a human-endorsed long-form article, signed off before the
 * first automated run. Scoped to blog specifically (fixed `platform:
 * "blog"`, the real 120-char title / 160-char meta description / 20,000-char
 * body limits) rather than reusing the generic `evals/` package's
 * `GoldenRun` — small and blog-specific enough that a shared type would
 * cost more than it saves. Mirrors the X, LinkedIn, and Reddit agents'
 * golden-run schemas (same recipe, RFC-02 §5).
 */
export const BlogGoldenRunSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  agentId: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  endorsedOutput: z.object({
    title: z.string().min(1),
    slug: z.string().min(1),
    excerpt: z.string().min(1),
    bodyMarkdown: z.string().min(1),
    headersList: z.array(z.string()),
    metaDescription: z.string().min(1),
    estimatedReadMinutes: z.number().positive(),
    text: z.string().min(1),
    platform: z.literal("blog"),
  }),
  gateArgs: z
    .object({
      brandCompliance: z.object({ forbiddenTerms: z.array(z.string()).optional() }).optional(),
      /** Real source content backing this article's numeric claims — `gate.numbersSourced` is strict: a claim's exact figure must literally appear here, a citation marker in the text alone is not enough. */
      numbersSourced: z.object({ sources: z.array(z.string()).optional() }).optional(),
    })
    .default({}),
  endorsedBy: z.string().min(1),
  endorsedAt: z.string().min(1),
});
export type BlogGoldenRun = z.infer<typeof BlogGoldenRunSchema>;

export const BlogDeterministicAssertionResultSchema = z.object({
  goldenRunId: z.string().min(1),
  check: z.string().min(1),
  verdict: z.enum(["pass", "content_fail", "tooling_error"]),
  reason: z.string().optional(),
});
export type BlogDeterministicAssertionResult = z.infer<typeof BlogDeterministicAssertionResultSchema>;
