import { serializeToDynamicAgentRunReport, type DurableStepStore, type DynamicAgentRunReport, type DynamicAgentStepDescriptor } from "@agent-engine/workflow";
import type { ProductId } from "./wiring/workflows.js";

/** The fixed 16-step id shape every channel agent shares (RFC-02 §5 — "same recipe"). Only step "09-draft-post" is an agent step; every other step is code. */
const CHANNEL_AGENT_STEP_IDS = [
  "00-intake-check",
  "01-load-client-context",
  "02-load-memory-shelf",
  "03-load-recent-decisions",
  "04-research-pull",
  "05-extract-candidate-summary",
  "06-reserve-topic",
  "07-select-candidate",
  "08-determine-angle",
  "09-draft-post",
  "10-verify-numbers-sourced",
  "11-verify-brand-compliance",
  "12-render-preview-check",
  "13-persist-deliverable",
  "14-persist-manifest",
  "15-commit-and-record",
] as const;

/** The orchestrator's own top-level steps (RFC-02 §4) — the fan-out itself (`channel-fanout`) isn't a `step.code` id, so it isn't listed here; its slots and their nested steps are discovered dynamically below. */
const CAMPAIGN_ORCHESTRATOR_STEP_IDS = [
  "00-intake-check",
  "01-load-client-context",
  "02-load-memory-shelf",
  "03-load-past-campaign-performance",
  "04-research-pull",
  "05-extract-strategic-summary",
  "06-reserve-topic-pool",
  "07-generate-strategy-plan",
  "08-validate-strategy-plan",
  "09-prepare-channel-fanout-items",
  "11-aggregate-channel-outcomes",
  "12-verify-campaign-completeness",
  "13-campaign-review",
  "14-persist-campaign-bundle",
  "15-commit-and-record",
] as const;

function channelAgentDescriptors(): DynamicAgentStepDescriptor[] {
  return CHANNEL_AGENT_STEP_IDS.map((stepId) => ({ stepId, label: stepId, type: stepId === "09-draft-post" ? "ai" : "code" }));
}

function campaignOrchestratorDescriptors(slotIds: readonly string[]): DynamicAgentStepDescriptor[] {
  const topLevel: DynamicAgentStepDescriptor[] = CAMPAIGN_ORCHESTRATOR_STEP_IDS.map((stepId) => ({
    stepId,
    label: stepId,
    type: stepId === "07-generate-strategy-plan" ? "ai" : "code",
  }));
  const perSlot: DynamicAgentStepDescriptor[] = slotIds.flatMap((slotId, index) => [
    { stepId: slotId, label: `channel slot ${index}`, type: "code" as const },
    { stepId: `${slotId}::09-draft-post`, label: `channel ${index} draft`, type: "ai" as const },
  ]);
  return [...topLevel, ...perSlot];
}

/**
 * Builds the `DynamicAgentRunReport` for one run (RFC-01 §7.2), adaptively:
 * the five channel agents always follow the same fixed 16-step shape, but
 * the campaign orchestrator's own fan-out schedules a plan-dependent number
 * of channel slots — known only after the run actually reaches that step —
 * so its descriptor list is built from whatever slot records actually exist
 * for this run, not a static constant.
 */
export async function buildRunReport(
  durableStore: DurableStepStore,
  runId: string,
  productId: ProductId,
): Promise<DynamicAgentRunReport> {
  const stepRecords = await durableStore.listSteps(runId);
  const runRecord = await durableStore.getRun(runId);

  let descriptors: DynamicAgentStepDescriptor[];
  let slotRecords: Awaited<ReturnType<DurableStepStore["listSlots"]>> = [];
  if (productId === "campaign-orchestrator") {
    slotRecords = await durableStore.listSlots(runId, "channel-fanout");
    descriptors = campaignOrchestratorDescriptors(slotRecords.map((slot) => slot.slotId));
  } else {
    descriptors = channelAgentDescriptors();
  }

  return serializeToDynamicAgentRunReport({
    specId: `spec_${productId}`,
    specVersion: 1,
    steps: descriptors,
    stepRecords,
    slotRecords,
    ...(runRecord !== undefined ? { runRecord } : {}),
  });
}
