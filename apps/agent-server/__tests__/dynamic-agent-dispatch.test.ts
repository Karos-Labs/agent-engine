import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MemoryAgentDefinitionStore, type AgentDefinitionInput, type ModelRouter } from "@agent-engine/core";
import { startRunJob } from "../src/run-job.js";
import { setupTestEnvironment, smartFakeRouter, type TestEnvironment } from "./test-helpers.js";

function twoStageAgent(agentId: string): AgentDefinitionInput {
  return {
    agentId,
    name: "Two Stage Agent",
    description: "A dynamic agent with two sequential stages, used to prove the generic dynamic-workflow runner (Task 2)",
    defaultModelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    stages: [
      {
        id: "draft",
        description: "produce a draft headline",
        systemPrompt: "You write short headlines.",
        allowedTools: [],
        outputSchema: [{ name: "headline", type: "string", optional: false }],
      },
      {
        id: "score",
        description: "score the headline",
        allowedTools: [],
        outputSchema: [{ name: "score", type: "number", optional: false }],
      },
    ],
  };
}

describe("dynamic agent dispatch (Task 2)", () => {
  let env: TestEnvironment;
  let agentDefinitionStore: MemoryAgentDefinitionStore;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    agentDefinitionStore = new MemoryAgentDefinitionStore();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("resolveWorkflowFn dispatches an unregistered productId to the dynamic agent store, runs every stage in order, and checkpoints each one", async () => {
    await agentDefinitionStore.upsert("headline-scorer", twoStageAgent("headline-scorer"), { expectExisting: false });
    const router = smartFakeRouter([{ headline: "Big News Today" }, { score: 9 }]);

    const outcome = await startRunJob(
      { clientSlug: "acme", productId: "headline-scorer", runKind: "recurring" },
      "run-dynamic-1",
      { durableStore: env.durableStore, runtimeDeps: { ...env.runtimeDeps, router }, agentDefinitionStore },
    );

    expect(outcome.outcome).toBe("started");
    if (outcome.outcome !== "started") throw new Error("expected started");
    expect(outcome.status).toBe("completed");

    const steps = await env.durableStore.listSteps("run-dynamic-1");
    const stepIds = steps.map((s) => s.stepId).sort();
    // `guardrail-verify-load-topics` is appended to every dynamic run by the
    // builder, not declared by any definition — that is the guardrail's whole
    // design (see dynamic-guardrail.test.ts). It checkpoints even when the
    // client forbids nothing, because "we checked and there was nothing to
    // enforce" is the fact an auditor needs recorded; the verifier model call
    // itself is skipped, so this costs one workspace read.
    expect(stepIds).toEqual(["draft", "guardrail-verify-load-topics", "score"]);

    const draftStep = steps.find((s) => s.stepId === "draft");
    expect(draftStep?.kind).toBe("agent");
    expect((draftStep?.output as { finalOutput: unknown })?.finalOutput).toEqual({ headline: "Big News Today" });
  });

  it("a run naming neither a known product nor a registered agent fails clearly, not silently", async () => {
    const outcome = await startRunJob(
      { clientSlug: "acme", productId: "totally-unknown-agent", runKind: "recurring" },
      "run-dynamic-2",
      { durableStore: env.durableStore, runtimeDeps: env.runtimeDeps, agentDefinitionStore },
    );
    expect(outcome.outcome).toBe("not_found");
    if (outcome.outcome !== "not_found") throw new Error("expected not_found");
    expect(outcome.message).toMatch(/neither a known product id nor a registered dynamic agent/);
  });

  it("without an agentDefinitionStore configured at all, an unregistered productId still fails clearly", async () => {
    const outcome = await startRunJob(
      { clientSlug: "acme", productId: "totally-unknown-agent", runKind: "recurring" },
      "run-dynamic-3",
      { durableStore: env.durableStore, runtimeDeps: env.runtimeDeps },
    );
    expect(outcome.outcome).toBe("not_found");
    if (outcome.outcome !== "not_found") throw new Error("expected not_found");
    expect(outcome.message).toMatch(/no AgentDefinitionStore is configured/);
  });

  it("a stage whose output fails validation resolves the run to degraded, not a silent success", async () => {
    await agentDefinitionStore.upsert("bad-stage-agent", twoStageAgent("bad-stage-agent"), { expectExisting: false });
    // The router returns a shape that satisfies neither stage's schema (via smartFakeRouter's
    // own "no candidate matches" failure) — simulating a model call that errors out.
    const router: ModelRouter = {
      async complete() {
        throw new Error("simulated model failure");
      },
      async completeAlias() {
        throw new Error("not used");
      },
    };

    const outcome = await startRunJob(
      { clientSlug: "acme", productId: "bad-stage-agent", runKind: "recurring" },
      "run-dynamic-4",
      { durableStore: env.durableStore, runtimeDeps: { ...env.runtimeDeps, router }, agentDefinitionStore },
    );

    expect(outcome.outcome).toBe("started");
    if (outcome.outcome !== "started") throw new Error("expected started");
    expect(outcome.status).toBe("degraded");
  });
});
