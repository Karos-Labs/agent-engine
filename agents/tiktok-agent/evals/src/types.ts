import { z } from "zod";
import { EvalLanguageSchema } from "@agent-engine/evals";
import { ShortScriptSchema } from "../../src/workflow/types.js";

/**
 * One endorsed original-short SCRIPT for a fixed brief (RFC-01 §12, plan
 * item 2.6, 2026-09-10). The script is the unit, not the rendered clip: the
 * render is deterministic ffmpeg over library footage, and every quality
 * rule the pipeline enforces in code (`repairScriptStructure`,
 * `scriptVoiceIssues`, `shotVarietyIssues`, `salesPitchIssues`, the dash
 * normaliser, the gates) is a function of the script. A prompt or lint
 * change that would send an endorsed script back to the writer fails here
 * before it ships.
 */
export const TikTokGoldenRunSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  agentId: z.literal("tiktok-agent"),
  language: EvalLanguageSchema.default("en"),
  /** What the writer was given: at least `topic`; `runDirection` when the brief carried one (it lifts the pitch rule when it asks for a call to action). */
  input: z.record(z.string(), z.unknown()),
  endorsedOutput: ShortScriptSchema,
  gateArgs: z
    .object({
      brandCompliance: z.object({ forbiddenTerms: z.array(z.string()).optional() }).optional(),
      /** The lines every figure in the script rests on; a figure with no source here is the invented number the prompt bans. */
      numbersSourced: z.object({ sources: z.array(z.string()).optional() }).optional(),
    })
    .default({}),
  endorsedBy: z.string().min(1),
  endorsedAt: z.string().min(1),
});
export type TikTokGoldenRun = z.infer<typeof TikTokGoldenRunSchema>;

export const TikTokDeterministicAssertionResultSchema = z.object({
  goldenRunId: z.string().min(1),
  check: z.string().min(1),
  verdict: z.enum(["pass", "content_fail", "tooling_error"]),
  reason: z.string().optional(),
});
export type TikTokDeterministicAssertionResult = z.infer<typeof TikTokDeterministicAssertionResultSchema>;
