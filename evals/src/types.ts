import { z } from "zod";

/**
 * A golden run (RFC-01 §12 bullet 1): a frozen input bundle plus a
 * human-endorsed output, signed off *before* the first automated run — so a
 * pilot produces a verdict, not an impression. `input` is kept for
 * provenance/documentation (what would have been fed to the agent) even
 * though the deterministic assertion runner only ever checks `endorsedOutput`.
 */
export const GoldenRunSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  agentId: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  endorsedOutput: z.object({
    text: z.string().min(1),
    platform: z.enum(["twitter", "x", "linkedin", "instagram", "facebook", "generic"]).default("generic"),
  }),
  /** Per-gate argument overrides (e.g. this client's own forbidden terms) — merged over the defaults derived from `endorsedOutput`. */
  gateArgs: z
    .object({
      brandCompliance: z.object({ forbiddenTerms: z.array(z.string()).optional(), requiredDisclaimer: z.string().optional() }).optional(),
      leakCheck: z.object({ extraTerms: z.array(z.string()).optional() }).optional(),
      numbersSourced: z.object({ sources: z.array(z.string()).optional() }).optional(),
    })
    .default({}),
  /** Who signed off, and when — RFC-01 §12's "produced by a human sign-off before the first automated run". */
  endorsedBy: z.string().min(1),
  endorsedAt: z.string().min(1),
});
export type GoldenRun = z.infer<typeof GoldenRunSchema>;

export const DeterministicAssertionResultSchema = z.object({
  goldenRunId: z.string().min(1),
  gate: z.string().min(1),
  verdict: z.enum(["pass", "content_fail", "tooling_error"]),
  reason: z.string().optional(),
});
export type DeterministicAssertionResult = z.infer<typeof DeterministicAssertionResultSchema>;
