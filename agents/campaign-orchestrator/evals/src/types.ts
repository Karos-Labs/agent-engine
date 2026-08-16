import { z } from "zod";
import { CampaignChannelSlotSchema } from "../../src/agent/campaign-strategy-agent.js";

/**
 * A golden run for the campaign orchestrator (RFC-01 §12 bullet 1): a
 * frozen input bundle plus a human-endorsed strategy plan, signed off
 * before the first automated run. Unlike the five channel agents' golden
 * runs, there is no single composed `text` field or `karos-gates` check
 * that applies at the plan level — the endorsed artifact here is the
 * *strategy plan* `CampaignStrategyAgent` produces, not a piece of
 * publishable copy. `runCampaignDeterministicAssertions` checks the
 * structural properties `campaign-craft@1` actually calls for instead
 * (channel coverage, slotId uniqueness, audience segmentation, key-message
 * discipline) — the plan-level equivalent of a gate check.
 */
export const CampaignGoldenRunSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  agentId: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  endorsedOutput: z.object({
    campaignName: z.string().min(1),
    theme: z.string().min(1),
    targetPillars: z.array(z.string()).min(1),
    channelSlots: z.array(CampaignChannelSlotSchema).min(1),
  }),
  endorsedBy: z.string().min(1),
  endorsedAt: z.string().min(1),
});
export type CampaignGoldenRun = z.infer<typeof CampaignGoldenRunSchema>;

export const CampaignDeterministicAssertionResultSchema = z.object({
  goldenRunId: z.string().min(1),
  check: z.string().min(1),
  verdict: z.enum(["pass", "content_fail"]),
  reason: z.string().optional(),
});
export type CampaignDeterministicAssertionResult = z.infer<typeof CampaignDeterministicAssertionResultSchema>;
