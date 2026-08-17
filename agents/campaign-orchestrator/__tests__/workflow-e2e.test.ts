import { describe, expect, it, afterEach, beforeEach } from "vitest";
import {
  MemoryDurableStepStore,
  WorkflowEngine,
  serializeToDynamicAgentRunReport,
  type DynamicAgentStepDescriptor,
} from "@agent-engine/workflow";
import { createCampaignWorkflow } from "../src/workflow/create-campaign-workflow.js";
import {
  fakeRouterSequence,
  finalTurn,
  goodCampaignPlan,
  makeCampaignPromptStore,
  makeChannelPromptStores,
  makeChannelRouters,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "campaign_run_1", clientSlug: "acme", productId: "campaign-orchestrator", runKind: "recurring" as const };

const ORCHESTRATOR_STEP_IDS = [
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
  "14-persist-campaign-bundle",
  "15-commit-and-record",
];

const PLAN = goodCampaignPlan();

describe("end-to-end: the 16-step campaign orchestrator workflow (multi-channel fan-out)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment("acme");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("fans out across all 5 channels, pauses at the campaign gate, then resumes to completed / domainOutcome: delivered", async () => {
    const campaignPromptStore = makeCampaignPromptStore();
    const channelPromptStores = makeChannelPromptStores();
    const campaignRouter = fakeRouterSequence([finalTurn(goodCampaignPlan())]);
    const channelRouters = makeChannelRouters();

    const workflowFn = createCampaignWorkflow({
      tools: env.tools,
      promptStore: campaignPromptStore,
      router: campaignRouter,
      channelPromptStores,
      channelRouters,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, params);
    expect(first.status).toBe("awaiting_gate");
    if (first.status !== "awaiting_gate") throw new Error("unreachable");
    expect(first.pendingGateId).toContain("13-campaign-review");

    // Every channel's own draft turn already ran — the fan-out completed before the gate paused execution.
    expect(campaignRouter.complete).toHaveBeenCalledTimes(1);
    for (const channel of ["x", "linkedin", "reddit", "blog", "newsletter"] as const) {
      expect(channelRouters[channel].complete).toHaveBeenCalledTimes(1);
    }

    const stepsBeforeGate = await durableStore.listSteps(params.runId);
    const slotsBeforeGate = await durableStore.listSlots(params.runId, "channel-fanout");
    expect(slotsBeforeGate).toHaveLength(5);
    expect(slotsBeforeGate.every((s) => s.status === "completed")).toBe(true);
    // Every channel's own nested workflow really executed under this run. Each
    // channel restructured its own workflow independently in Phase 2.5 Batch 2
    // (lane/archetype/thread-selection steps inserted before the draft), so the
    // draft step's own id/number now differs per channel — the plan's slot order
    // is x/linkedin/reddit/blog/newsletter. Reddit's draft step is also named
    // "-draft-reply", not "-draft-post", since it drafts a reply, not a post.
    const draftStepSuffix = (slotIndex: number): string => {
      switch (slotIndex) {
        case 0:
          return "10-draft-post"; // x: 08-select-lane, 09-check-engagement-cap precede it
        case 1:
          return "09-draft-post"; // linkedin: 08-determine-archetype precedes it
        case 2:
          return "12-draft-reply"; // reddit: 08-select-target-thread, 09-check-thread-not-answered, 10-verify-subreddit-eligibility, 11-determine-angle precede it
        case 3:
          return "09-draft-post"; // blog: unchanged
        case 4:
          return "09-draft-post"; // newsletter: unchanged
        default:
          throw new Error(`unexpected slot index ${slotIndex}`);
      }
    };
    for (let i = 0; i < 5; i++) {
      const nestedDraftStep = stepsBeforeGate.find((s) => s.stepId === `channel-fanout__slot_${i}::${draftStepSuffix(i)}`);
      expect(nestedDraftStep?.status).toBe("completed");
    }

    await engine.resolveGate(params.runId, "13-campaign-review", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date(2026, 7, 16).toISOString(),
    });

    const second = await engine.run(workflowFn, params);
    expect(second.status).toBe("completed");
    if (second.status !== "completed") throw new Error("unreachable");
    expect(second.output.campaignName).toBe(PLAN.campaignName);
    expect(second.output.channelResults).toHaveLength(5);
    expect(second.output.channelResults.every((r) => r.status === "completed")).toBe(true);
    expect(second.output.channelResults.every((r) => typeof r.deliverableId === "string")).toBe(true);

    // Resume did not re-run anything: same turn/tool counts as before the gate.
    expect(campaignRouter.complete).toHaveBeenCalledTimes(1);
    for (const channel of ["x", "linkedin", "reddit", "blog", "newsletter"] as const) {
      expect(channelRouters[channel].complete).toHaveBeenCalledTimes(1);
    }

    // The unified campaign bundle, and every channel's own deliverable, really landed
    // on the real file-backed WorkspaceStore under the same run, tenant-scoped.
    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id).sort()).toEqual(
      ["blog-post", "campaign-bundle", "linkedin-post", "newsletter-edition", "reddit-reply", "x-post"].sort(),
    );

    const stepRecords = await durableStore.listSteps(params.runId);
    const slotRecords = await durableStore.listSlots(params.runId, "channel-fanout");

    const descriptors: DynamicAgentStepDescriptor[] = [
      ...ORCHESTRATOR_STEP_IDS.map((stepId) => ({ stepId, label: stepId, type: stepId === "07-generate-strategy-plan" ? ("ai" as const) : ("code" as const) })),
      ...slotRecords.map((slot, i) => ({ stepId: slot.slotId, label: `channel slot ${i}`, type: "code" as const })),
      ...[0, 1, 2, 3, 4].map((i) => ({ stepId: `channel-fanout__slot_${i}::${draftStepSuffix(i)}`, label: `channel ${i} draft`, type: "ai" as const })),
    ];
    const runRecord = await durableStore.getRun(params.runId);
    const report = serializeToDynamicAgentRunReport({
      specId: "spec_campaign_orchestrator",
      specVersion: 1,
      steps: descriptors,
      stepRecords,
      slotRecords,
      ...(runRecord !== undefined ? { runRecord } : {}),
    });

    expect(report.domainOutcome).toBe("delivered");
    expect(report.steps.every((s) => s.status === "done")).toBe(true);

    // Cost/token telemetry really aggregates across every child channel's own draft step.
    const draftStepReports = report.steps.filter((s) => s.stepId.endsWith("-draft-post") || s.stepId.endsWith("-draft-reply"));
    expect(draftStepReports).toHaveLength(5);
    for (const draftStep of draftStepReports) {
      expect(draftStep.costUsd).toBeGreaterThan(0);
      expect(draftStep.model).toBe("claude-sonnet-4-6");
    }
    expect(second.totalCostUsd).toBeGreaterThan(0);
  });
});
