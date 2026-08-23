import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MemoryAgentDefinitionStore, type AgentDefinitionInput, type ModelRouter } from "@agent-engine/core";
import { startRunJob } from "../src/run-job.js";
import { setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * Per-stage model selection, end to end.
 *
 * The claim worth testing is not "the field is accepted" but "the model that
 * was chosen is the model the router was actually asked for, and the model the
 * run reports having used". A per-stage override that is stored, echoed back,
 * and then silently ignored at the model call is the failure this guards, and
 * it is invisible from the outside — the run succeeds either way, just on the
 * wrong model and at the wrong price.
 */

/** Records the policy each call was made with, then returns a valid turn. */
function recordingRouter(seen: Array<{ model: string; policy: string }>): ModelRouter {
  return {
    async complete(_prompt, schema, policy) {
      seen.push({ model: policy.model, policy: policy.policy });
      const parsed = schema.safeParse({ type: "final", output: { text: "a draft" } });
      if (!parsed.success) throw new Error("recordingRouter: schema did not accept the stub output");
      return {
        output: parsed.data,
        modelUsed: policy.model,
        inputTokens: { cached: 0, uncached: 10 },
        outputTokens: 5,
      };
    },
    async completeAlias() {
      throw new Error("completeAlias is not used here");
    },
  } as ModelRouter;
}

function twoStageAgent(): AgentDefinitionInput {
  return {
    agentId: "two-stage",
    name: "Two Stage",
    description: "Two AI stages with different compiled defaults",
    defaultModelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    stages: [
      {
        id: "draft",
        description: "draft it",
        systemPrompt: "You draft.",
        allowedTools: [],
        outputSchema: [{ name: "text", type: "string", optional: false }],
      },
      {
        id: "polish",
        description: "polish it",
        systemPrompt: "You polish.",
        allowedTools: [],
        outputSchema: [{ name: "text", type: "string", optional: false }],
      },
    ],
  };
}

describe("per-stage model selection", () => {
  let env: TestEnvironment;
  let store: MemoryAgentDefinitionStore;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    store = new MemoryAgentDefinitionStore();
    await store.upsert("two-stage", twoStageAgent(), { expectExisting: false });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  async function run(runId: string, stageModels?: Record<string, string>) {
    const seen: Array<{ model: string; policy: string }> = [];
    const outcome = await startRunJob(
      { clientSlug: "acme", productId: "two-stage", runKind: "recurring", ...(stageModels ? { stageModels } : {}) },
      runId,
      {
        durableStore: env.durableStore,
        runtimeDeps: { ...env.runtimeDeps, router: recordingRouter(seen) },
        agentDefinitionStore: store,
      },
    );
    return { outcome, seen };
  }

  it("uses each stage's compiled default when nothing is overridden", async () => {
    const { outcome, seen } = await run("run-sm-default");

    expect(outcome.outcome).toBe("started");
    expect(seen.map((s) => s.model)).toEqual(["claude-sonnet-4-6", "claude-sonnet-4-6"]);
  });

  it("sends the overridden model for the named stage, and only that stage", async () => {
    // The whole point of PER-stage: overriding one must not move the others.
    const { seen } = await run("run-sm-one", { polish: "gemini-3-pro" });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.model, "draft keeps its default").toBe("claude-sonnet-4-6");
    expect(seen[1]?.model, "polish takes the override").toBe("gemini-3-pro");
  });

  it("can point every stage at a different model in one run", async () => {
    const { seen } = await run("run-sm-both", { draft: "claude-haiku-4-5-20251001", polish: "gemini-3-pro" });

    expect(seen.map((s) => s.model)).toEqual(["claude-haiku-4-5-20251001", "gemini-3-pro"]);
  });

  it("reports the model that actually ran, not the compiled default", async () => {
    // A run whose telemetry names the default while billing for the override
    // is worse than no override at all: the cost record and the audit trail
    // both become wrong, and nothing surfaces it.
    const { outcome } = await run("run-sm-report", { draft: "gemini-3-pro" });

    if (outcome.outcome !== "started") throw new Error("unreachable");
    const steps = await env.durableStore.listSteps("run-sm-report");
    const draft = steps.find((s) => s.stepId === "draft");
    const telemetry = (draft?.output as { steps?: Array<{ modelUsed: string }> })?.steps ?? [];
    expect(telemetry.length).toBeGreaterThan(0);
    expect(telemetry.every((t) => t.modelUsed === "gemini-3-pro")).toBe(true);
  });

  it("ignores a key that names no stage rather than failing the run", async () => {
    // The map is authored against a stage list that changes when an agent is
    // edited. A stale key should not take down a run that is otherwise fine.
    const { outcome, seen } = await run("run-sm-stale", { "stage-that-was-deleted": "gemini-3-pro" });

    expect(outcome.outcome).toBe("started");
    if (outcome.outcome !== "started") throw new Error("unreachable");
    expect(outcome.status).toBe("completed");
    expect(seen.map((s) => s.model)).toEqual(["claude-sonnet-4-6", "claude-sonnet-4-6"]);
  });

  it("leaves the policy tier alone — an override changes the model, not the routing class", async () => {
    // `policy` drives fallback and cost tiering. Swapping the model id is a
    // different decision from re-tiering the step, and the models catalog is
    // what knows which vendor serves an id.
    const { seen } = await run("run-sm-tier", { draft: "gemini-3-pro" });

    expect(seen[0]?.policy).toBe("pinned");
  });
});
