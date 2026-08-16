import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { AgentContext } from "@agent-engine/core";
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

const params = { runId: "campaign_run_tenant", clientSlug: "acme", productId: "campaign-orchestrator", runKind: "recurring" as const };

describe("multi-tenant isolation across the 5-channel fan-out (zero cross-tenant leakage)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment("acme");

    // A second, completely independent tenant sharing only the same underlying
    // WorkspaceStore — exactly how one file+git-backed store serves every client.
    await env.store.writeJson("globex", ["client", "profile"], { name: "Globex Corp", industry: "Manufacturing" });
    await env.store.writeJson("globex", ["client", "voice-rules"], { tone: "formal, precise" });
    await env.store.writeJson("globex", ["client", "brand"], { forbiddenTerms: ["cheap"] });
    await env.store.writeJson("globex", ["client", "config"], {
      campaignGoals: "Globex's own, unrelated campaign goals — never read by acme's run.",
      xHandle: "@globexcorp",
      targetSubreddits: ["manufacturing"],
      targetKeywords: ["industrial automation"],
      contentPillars: ["supply chain"],
      targetAudience: "plant operations managers",
      frequency: "monthly",
    });
    const globexSeedCtx: AgentContext = { runId: "seed-globex", clientSlug: "globex", productId: "campaign-orchestrator", runKind: "recurring", metadata: {} };
    await env.tools["topics.topUp"]!.execute({ topics: ["globex topic alpha", "globex topic beta", "globex topic gamma"] }, { ctx: globexSeedCtx });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("running acme's full 5-channel campaign never reads, writes, or consumes globex's own data", async () => {
    const globexCatalogBefore = await env.store.readJson("globex", ["topics", "catalog"]);
    const globexConfigBefore = await env.store.readJson("globex", ["client", "config"]);
    const globexProfileBefore = await env.store.readJson("globex", ["client", "profile"]);

    const workflowFn = createCampaignWorkflow({
      tools: env.tools,
      promptStore: makeCampaignPromptStore(),
      router: fakeRouterSequence([finalTurn(goodCampaignPlan())]),
      channelPromptStores: makeChannelPromptStores(),
      channelRouters: makeChannelRouters(),
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, params);
    expect(first.status).toBe("awaiting_gate");

    await engine.resolveGate(params.runId, "13-campaign-review", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date(2026, 7, 16).toISOString(),
    });

    const second = await engine.run(workflowFn, params);
    expect(second.status).toBe("completed");
    if (second.status !== "completed") throw new Error("unreachable");
    expect(second.output.channelResults.every((r) => r.status === "completed")).toBe(true);

    // globex's own client data and topic catalog are byte-for-byte unchanged —
    // the acme run's 5-channel fan-out never touched them.
    expect(await env.store.readJson("globex", ["topics", "catalog"])).toEqual(globexCatalogBefore);
    expect(await env.store.readJson("globex", ["client", "config"])).toEqual(globexConfigBefore);
    expect(await env.store.readJson("globex", ["client", "profile"])).toEqual(globexProfileBefore);

    // globex has zero deliverables, zero decisions — nothing was ever written under its tenant.
    const globexDeliverables = await env.store.listJson("globex", ["ledger", "deliverables", params.runId, "_"]);
    expect(globexDeliverables).toHaveLength(0);
    const globexDecisions = await env.store.listJson("globex", ["memory", "decisions"]);
    expect(globexDecisions).toHaveLength(0);

    // acme, meanwhile, really did get its full bundle of deliverables.
    const acmeDeliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(acmeDeliverables.length).toBe(6); // 5 channels + the campaign bundle itself
  });
});
