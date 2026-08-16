import { describe, expect, it, afterEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createCampaignWorkflow } from "../src/workflow/create-campaign-workflow.js";
import {
  fakeRouterSequence,
  finalTurn,
  makeCampaignPromptStore,
  makeChannelPromptStores,
  makeChannelRouters,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "campaign_run_blocked", clientSlug: "acme", productId: "campaign-orchestrator", runKind: "recurring" as const };

describe("00-intake-check: missing campaign goals or brand baseline blocks the run (RFC-02 §4)", () => {
  let env: TestEnvironment;

  afterEach(async () => {
    await env.cleanup();
  });

  it("resolves to status: blocked_intake when the client has no campaign goals configured", async () => {
    env = await setupTestEnvironment("acme", { withCampaignGoals: false });
    const workflowFn = createCampaignWorkflow({
      tools: env.tools,
      promptStore: makeCampaignPromptStore(),
      router: fakeRouterSequence([finalTurn({ text: "unused — should never be reached" })]),
      channelPromptStores: makeChannelPromptStores(),
      channelRouters: makeChannelRouters(),
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("blocked_intake");

    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords.map((s) => s.stepId)).toEqual(["00-intake-check"]);
    // The fan-out never started — no channel was ever invoked.
    const slotRecords = await durableStore.listSlots(params.runId, "channel-fanout");
    expect(slotRecords).toHaveLength(0);
  });

  it("resolves to status: blocked_intake when the client has no brand baseline set up", async () => {
    env = await setupTestEnvironment("acme", { withBrand: false });
    const workflowFn = createCampaignWorkflow({
      tools: env.tools,
      promptStore: makeCampaignPromptStore(),
      router: fakeRouterSequence([finalTurn({ text: "unused" })]),
      channelPromptStores: makeChannelPromptStores(),
      channelRouters: makeChannelRouters(),
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "campaign_run_blocked_2" });

    expect(result.status).toBe("blocked_intake");
  });
});
