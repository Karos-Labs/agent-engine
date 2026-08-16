import { z } from "zod";
import { BaseAgent, type AgentStepConfig } from "@agent-engine/core";

/** The five migrated channel agents (RFC-02 §5) a campaign can schedule a slot against. */
export const CampaignChannelSchema = z.enum(["x", "linkedin", "reddit", "blog", "newsletter"]);
export type CampaignChannel = z.infer<typeof CampaignChannelSchema>;

/**
 * One scheduled channel slot in the plan. `slotId` is the workflow-level
 * identity this slot will run under (RFC-01 §5.5) — assigned by the plan,
 * never derived from content, the same discipline every fan-out in this
 * system already follows.
 */
export const CampaignChannelSlotSchema = z.object({
  slotId: z.string().min(1),
  channel: CampaignChannelSchema,
  targetAudience: z.string().min(1),
  angle: z.string().min(1),
  keyMessage: z.string().min(1),
});
export type CampaignChannelSlot = z.infer<typeof CampaignChannelSlotSchema>;

/**
 * A single campaign strategy plan (RFC-02 §4). This is the artifact the
 * orchestrator's fan-out schedules against — it does not itself contain any
 * channel's actual drafted copy; each channel's own draft agent produces
 * that independently, guided by its own craft policy.
 */
export const CampaignPlanOutputSchema = z.object({
  campaignName: z.string().min(1),
  theme: z.string().min(1),
  targetPillars: z.array(z.string()).min(1),
  channelSlots: z.array(CampaignChannelSlotSchema).min(1),
});
export type CampaignPlanOutput = z.infer<typeof CampaignPlanOutputSchema>;

/**
 * The RFC-02 §4 orchestrator's strategy step: produces exactly one
 * cross-channel campaign plan per run (RFC-01 §16.2's "one artifact, one
 * run" ruling, applied here at the campaign level). `skillRef` resolves the
 * full strategy craft policy (cross-channel narrative alignment, audience
 * segmentation, topic distribution, messaging cadence) dynamically through
 * `runtime.promptStore` (RFC-01 §16.1) — nothing here is a hardcoded prompt
 * literal. `allowedTools` is deliberately read-only plus a single topic
 * reservation call — this agent plans the campaign, it never drafts or
 * publishes anything itself.
 */
export class CampaignStrategyAgent extends BaseAgent<CampaignPlanOutput> {
  protected readonly config: AgentStepConfig<CampaignPlanOutput> = {
    id: "campaign-strategy",
    description: "Produce a cross-channel campaign strategy plan: theme, content pillars, and one scheduled slot per target channel.",
    // "topics.reserve" is the tool's real registered name (the karos-topics
    // package's own tool, not a "karos-topics.reserve"-prefixed name) — kept
    // consistent with every channel agent's own `allowedTools` list.
    allowedTools: ["client.getProfile", "client.getBrand", "client.getVoiceRules", "memory.read", "topics.reserve"],
    outputSchema: CampaignPlanOutputSchema,
    // Pinned — RFC-02 §4: claude-sonnet-4-6 today, claude-sonnet-5 is an
    // equally acceptable pin once available; never a fallback for a pinned step.
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    skillRef: "campaign-craft@1",
  };
}
