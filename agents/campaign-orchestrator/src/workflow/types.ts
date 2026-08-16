import type { CampaignChannel } from "../agent/campaign-strategy-agent.js";

export interface CampaignIntakeConfig {
  goals: string;
  requestedTheme?: string;
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
}

export interface CampaignAgentWorkflowResult {
  campaignName: string;
  theme: string;
  channelResults: CampaignChannelResult[];
  deliverableId: string;
}
