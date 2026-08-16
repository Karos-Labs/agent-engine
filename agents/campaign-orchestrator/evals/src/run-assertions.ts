import { CampaignChannelSchema } from "../../src/agent/campaign-strategy-agent.js";
import type { CampaignDeterministicAssertionResult, CampaignGoldenRun } from "./types.js";

const ALL_CHANNELS = CampaignChannelSchema.options;

/**
 * Deterministic assertions for the campaign orchestrator (RFC-01 §12
 * bullet 2): structural checks against `campaign-craft@1`'s own rules,
 * run against a golden run's endorsed plan. No `karos-gates` tool applies
 * at the plan level (those all check a single composed `text`, which this
 * artifact doesn't have), so these are hand-written checks against the
 * plan's own structure instead — fast, free, zero model cost, same as
 * every channel agent's deterministic assertions.
 */
export function runCampaignDeterministicAssertions(goldenRun: CampaignGoldenRun): CampaignDeterministicAssertionResult[] {
  const { theme, targetPillars, channelSlots } = goldenRun.endorsedOutput;
  const results: CampaignDeterministicAssertionResult[] = [];

  // 1. Every channel is scheduled exactly once (campaign-craft@1 §4 — topic distribution assumes full coverage).
  const scheduledChannels = channelSlots.map((slot) => slot.channel);
  const missingChannels = ALL_CHANNELS.filter((channel) => !scheduledChannels.includes(channel));
  const duplicateChannels = scheduledChannels.filter((channel, index) => scheduledChannels.indexOf(channel) !== index);
  if (missingChannels.length > 0 || duplicateChannels.length > 0) {
    results.push({
      goldenRunId: goldenRun.id,
      check: "channel-coverage",
      verdict: "content_fail",
      reason: `missing: [${missingChannels.join(", ")}], duplicated: [${duplicateChannels.join(", ")}]`,
    });
  } else {
    results.push({ goldenRunId: goldenRun.id, check: "channel-coverage", verdict: "pass" });
  }

  // 2. Every slotId is unique (RFC-01 §5.5 — slot identity, assigned by the plan, never collides).
  const slotIds = channelSlots.map((slot) => slot.slotId);
  const duplicateSlotIds = slotIds.filter((id, index) => slotIds.indexOf(id) !== index);
  results.push(
    duplicateSlotIds.length > 0
      ? { goldenRunId: goldenRun.id, check: "slotId-uniqueness", verdict: "content_fail", reason: `duplicated: [${duplicateSlotIds.join(", ")}]` }
      : { goldenRunId: goldenRun.id, check: "slotId-uniqueness", verdict: "pass" },
  );

  // 3. Target pillars are non-empty (campaign-craft@1 §8 — never invented, but also never absent).
  results.push(
    targetPillars.length > 0
      ? { goldenRunId: goldenRun.id, check: "target-pillars-present", verdict: "pass" }
      : { goldenRunId: goldenRun.id, check: "target-pillars-present", verdict: "content_fail", reason: "targetPillars is empty" },
  );

  // 4. Audience segmentation — no two slots share the exact same targetAudience (campaign-craft@1 §3).
  const audiences = channelSlots.map((slot) => slot.targetAudience);
  const duplicateAudiences = audiences.filter((audience, index) => audiences.indexOf(audience) !== index);
  results.push(
    duplicateAudiences.length > 0
      ? {
          goldenRunId: goldenRun.id,
          check: "audience-segmentation",
          verdict: "content_fail",
          reason: `targetAudience reused verbatim across slots: "${duplicateAudiences[0]}"`,
        }
      : { goldenRunId: goldenRun.id, check: "audience-segmentation", verdict: "pass" },
  );

  // 5. Key-message discipline — no slot's keyMessage is just the campaign theme restated (campaign-craft@1 §6).
  const slotRestatingTheme = channelSlots.find((slot) => slot.keyMessage.trim() === theme.trim());
  results.push(
    slotRestatingTheme
      ? {
          goldenRunId: goldenRun.id,
          check: "key-message-discipline",
          verdict: "content_fail",
          reason: `slot "${slotRestatingTheme.slotId}" keyMessage is just the campaign theme restated`,
        }
      : { goldenRunId: goldenRun.id, check: "key-message-discipline", verdict: "pass" },
  );

  return results;
}
