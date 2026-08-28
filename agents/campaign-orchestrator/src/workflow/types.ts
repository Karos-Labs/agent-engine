import type { CampaignChannel } from "../agent/campaign-strategy-agent.js";

export interface CampaignIntakeConfig {
  goals: string;
  requestedTheme?: string;
  /**
   * Subjects this client does not engage with, carried from the same
   * `client.getConfig` read that produced `goals`/`requestedTheme` so the
   * campaign-level topic guardrail (SCRUM-302/AU18) does not have to read it
   * a second time.
   */
  forbiddenTopics: string[];
}

export interface CampaignClientContext {
  profile: Record<string, unknown>;
  brand: Record<string, unknown>;
  voiceRules: { tone?: string; forbiddenTerms?: string[]; [key: string]: unknown };
}

export interface CampaignStrategicSummary {
  candidatePillar?: string;
  hasNumericInsight: boolean;
  sourceLabel: string;
}

export interface CampaignTopicPool {
  reservationKey?: string;
  topics: string[];
}

/** One channel slot's outcome after the fan-out — recovered by index against the plan's own `channelSlots`, since the engine's own slot id is positional, not content-derived. */
export interface CampaignChannelResult {
  slotId: string;
  channel: CampaignChannel;
  status: "completed" | "failed";
  deliverableId?: string;
  reason?: string;
  /**
   * The exact text this channel's own `15-batch-review`/`13-batch-review`
   * gate would have shown a human, folded into the campaign gate's own
   * payload (SCRUM-302/AU18 fix): the campaign's fan-out runs every channel
   * with `autoApprove: true`, so `13-campaign-review` is the only human
   * checkpoint the bundle gets. Without this field that one gate reviewed
   * five `deliverableId` strings and nothing a reviewer could actually read.
   * Present only for a `completed` slot.
   */
  preview?: string;
}

export interface CampaignAgentWorkflowResult {
  campaignName: string;
  theme: string;
  channelResults: CampaignChannelResult[];
  deliverableId: string;
}
