import { z } from "zod";

/**
 * A golden run for the X agent (RFC-01 §12 bullet 1): a frozen input bundle
 * plus a human-endorsed X post, signed off before the first automated run.
 * Scoped to X specifically (fixed `platform: "x"`, the real 280-character
 * limit) rather than reusing the generic `evals/` package's `GoldenRun` —
 * small and X-specific enough that a shared type would cost more than it
 * saves.
 */
export const XGoldenRunSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  agentId: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  endorsedOutput: z.object({
    text: z.string().min(1),
    hook: z.string().min(1),
    angle: z.string().min(1),
    targetHandle: z.string().min(1),
    platform: z.literal("x"),
  }),
  gateArgs: z
    .object({
      brandCompliance: z.object({ forbiddenTerms: z.array(z.string()).optional() }).optional(),
    })
    .default({}),
  endorsedBy: z.string().min(1),
  endorsedAt: z.string().min(1),
});
export type XGoldenRun = z.infer<typeof XGoldenRunSchema>;

export const XDeterministicAssertionResultSchema = z.object({
  goldenRunId: z.string().min(1),
  check: z.string().min(1),
  verdict: z.enum(["pass", "content_fail", "tooling_error"]),
  reason: z.string().optional(),
});
export type XDeterministicAssertionResult = z.infer<typeof XDeterministicAssertionResultSchema>;
