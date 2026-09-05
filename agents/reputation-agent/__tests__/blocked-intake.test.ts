import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createReputationPulseWorkflow } from "../src/workflow/create-reputation-pulse-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, writeClientConfig, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "pulse_blocked_1", clientSlug: "acme-cafe", productId: "reputation-agent", runKind: "recurring" as const };

describe("WorkflowBlockedIntake: missing/illegal client intake never reaches step 04+ (RFC-08 §5/§6)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("resolves to blocked_intake at step 03 when the client's roster has no capture legs configured", async () => {
    await writeClientConfig(env.store, env.clientSlug, { reputationRoster: [] });

    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused — should never be reached" })]);
    const workflowFn = createReputationPulseWorkflow({ tools: env.tools, promptStore, router, store: env.store });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("blocked_intake");
    if (result.status !== "blocked_intake") throw new Error("unreachable");
    expect(result.reason).toMatch(/no reputation capture legs are configured/i);
    expect(router.complete).not.toHaveBeenCalled();

    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords.map((s) => s.stepId).sort()).toEqual(["00-roster-setup", "01-open-pulse", "02-freeze-inputs", "03-capture"].sort());
    expect(stepRecords.find((s) => s.stepId === "03-capture")?.status).toBe("failed");
  });

  it("resolves to blocked_intake at step 02 when the client's autonomy is set to anything other than approve-all", async () => {
    await writeClientConfig(env.store, env.clientSlug, { reputationAutonomy: "review-each" });

    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused — should never be reached" })]);
    const workflowFn = createReputationPulseWorkflow({ tools: env.tools, promptStore, router, store: env.store });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "pulse_blocked_autonomy" });

    expect(result.status).toBe("blocked_intake");
    if (result.status !== "blocked_intake") throw new Error("unreachable");
    expect(result.reason).toMatch(/reputationAutonomy is set to "review-each"/);
    expect(router.complete).not.toHaveBeenCalled();

    const stepRecords = await durableStore.listSteps("pulse_blocked_autonomy");
    expect(stepRecords.map((s) => s.stepId).sort()).toEqual(["00-roster-setup", "01-open-pulse", "02-freeze-inputs"].sort());
  });
});
