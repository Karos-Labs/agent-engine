import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine, CLEAN_GATE_TIMEOUT, FLAGGED_GATE_TIMEOUT } from "@agent-engine/workflow";
import type { ModelRouter } from "@agent-engine/core";
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

/**
 * A GATE THAT APPROVES ON TIMEOUT IS A DELAY, NOT A GATE.
 *
 * `13-campaign-review` is the single human checkpoint for a bundle of five
 * channels, and it carried a flat `1h / auto_approve`: a campaign where two
 * channels produced NOTHING shipped on the same hour as one where all five
 * landed. The platform's three-tier policy
 * (`packages/workflow/src/primitives/gate-timeout.ts`) gives the incomplete
 * bundle six hours and then still ships it — a flag buys a reviewer TIME, not
 * a veto.
 */

const baseParams = { clientSlug: "acme", productId: "campaign-orchestrator", runKind: "recurring" as const };

async function pauseAtGate(env: TestEnvironment, channelRouters: Record<string, ModelRouter>, runId: string) {
  const workflowFn = createCampaignWorkflow({
    tools: env.tools,
    promptStore: makeCampaignPromptStore(),
    router: fakeRouterSequence([finalTurn(goodCampaignPlan())]),
    channelPromptStores: makeChannelPromptStores(),
    channelRouters: channelRouters as never,
  });
  const durableStore = new MemoryDurableStepStore();
  const paused = await new WorkflowEngine(durableStore).run(workflowFn, { ...baseParams, runId });
  if (paused.status !== "awaiting_gate") throw new Error(`expected the campaign gate, got ${paused.status}`);
  const gate = await durableStore.getGate(paused.pendingGateId);
  return { gate, payload: (gate?.payload ?? {}) as Record<string, unknown> };
}

describe("what the clock on the campaign gate is worth", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment("acme");
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("a bundle where every channel landed keeps the hour it always had", async () => {
    const { gate, payload } = await pauseAtGate(env, makeChannelRouters(), `campaign_clock_clean_${Date.now()}`);
    const results = payload["channelResults"] as Array<{ status: string }>;
    expect(results.every((r) => r.status === "completed")).toBe(true);
    expect(gate?.timeout?.duration).toBe(CLEAN_GATE_TIMEOUT);
    expect(gate?.timeout?.onTimeout).toBe("auto_approve");
    expect(payload["gateFlags"]).toBeUndefined();
  });

  it("a bundle where a channel produced nothing waits six hours, and names the channel", async () => {
    // One channel's model never answers: that slot comes back `failed` and the
    // campaign still delivers the other four — which is exactly the case a
    // reviewer should see before it ships.
    const routers = makeChannelRouters();
    routers.reddit = {
      complete: async () => {
        throw new Error("the reddit model is unreachable in this test");
      },
    } as unknown as ModelRouter;

    const { gate, payload } = await pauseAtGate(env, routers, `campaign_clock_flagged_${Date.now()}`);
    const results = payload["channelResults"] as Array<{ channel: string; status: string }>;
    expect(results.find((r) => r.channel === "reddit")?.status).not.toBe("completed");
    expect(gate?.timeout?.duration).toBe(FLAGGED_GATE_TIMEOUT);
    expect(gate?.timeout?.onTimeout).toBe("auto_approve");
    expect(payload["gateFlags"]).toEqual([expect.stringMatching(/channels produced nothing.*reddit/)]);
  }, 60_000);
});
