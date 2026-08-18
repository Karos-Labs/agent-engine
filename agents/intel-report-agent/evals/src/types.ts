import { z } from "zod";
import { IntelReportOutputSchema } from "@agent-engine/tool-karos-intel";

/**
 * A golden run for the Intel Report agent (RFC-01 §12 bullet 1): a frozen
 * input bundle plus a human-endorsed report, signed off before the first
 * automated run. `endorsedOutput` is a full `IntelReportOutput` — the exact
 * schema `intel.writeReport` accepts — so a golden run doubles as a
 * regression fixture for the persistence contract, not just the prompt.
 * `sources` is the evidence text `gate.numbersSourced` checks the report's
 * analysis prose against (standing in for a real research pull's content).
 * `expectedOverallScore`/`expectedOverallGrade` are the deterministically
 * computed values `karos-intel/src/scoring.ts` should produce from
 * `endorsedOutput.dimensionScores` — pinned here so a change to the scoring
 * formula or the golden run's own scores is caught as a regression.
 */
export const IntelReportGoldenRunSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  agentId: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  endorsedOutput: IntelReportOutputSchema,
  sources: z.array(z.string()).default([]),
  expectedOverallScore: z.number().min(0).max(100),
  expectedOverallGrade: z.enum(["A", "B", "C", "D", "F"]),
  endorsedBy: z.string().min(1),
  endorsedAt: z.string().min(1),
});
export type IntelReportGoldenRun = z.infer<typeof IntelReportGoldenRunSchema>;

export const IntelReportDeterministicAssertionResultSchema = z.object({
  goldenRunId: z.string().min(1),
  check: z.string().min(1),
  verdict: z.enum(["pass", "content_fail", "tooling_error"]),
  reason: z.string().optional(),
});
export type IntelReportDeterministicAssertionResult = z.infer<typeof IntelReportDeterministicAssertionResultSchema>;
