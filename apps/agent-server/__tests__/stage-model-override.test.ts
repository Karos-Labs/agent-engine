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
    // claude-opus-4-8, not gemini-2.5-pro: this stage's compiled default is
    // vendor-less (anthropic), and since AU33 (SCRUM-311) a stage override
    // must name a catalogued model of that SAME vendor — a real, catalogued
    // but wrong-vendor id is exercised separately below, where it's the point.
    const { seen } = await run("run-sm-one", { polish: "claude-opus-4-8" });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.model, "draft keeps its default").toBe("claude-sonnet-4-6");
    expect(seen[1]?.model, "polish takes the override").toBe("claude-opus-4-8");
  });

  it("can point every stage at a different model in one run", async () => {
    const { seen } = await run("run-sm-both", { draft: "claude-haiku-4-5-20251001", polish: "claude-opus-4-8" });

    expect(seen.map((s) => s.model)).toEqual(["claude-haiku-4-5-20251001", "claude-opus-4-8"]);
  });

  it("reports the model that actually ran, not the compiled default", async () => {
    // A run whose telemetry names the default while billing for the override
    // is worse than no override at all: the cost record and the audit trail
    // both become wrong, and nothing surfaces it.
    const { outcome } = await run("run-sm-report", { draft: "claude-haiku-4-5-20251001" });

    if (outcome.outcome !== "started") throw new Error("unreachable");
    const steps = await env.durableStore.listSteps("run-sm-report");
    const draft = steps.find((s) => s.stepId === "draft");
    const telemetry = (draft?.output as { steps?: Array<{ modelUsed: string }> })?.steps ?? [];
    expect(telemetry.length).toBeGreaterThan(0);
    expect(telemetry.every((t) => t.modelUsed === "claude-haiku-4-5-20251001")).toBe(true);
  });

  it("ignores a key that names no stage rather than failing the run", async () => {
    // The map is authored against a stage list that changes when an agent is
    // edited. A stale key should not take down a run that is otherwise fine.
    const { outcome, seen } = await run("run-sm-stale", { "stage-that-was-deleted": "gemini-2.5-pro" });

    expect(outcome.outcome).toBe("started");
    if (outcome.outcome !== "started") throw new Error("unreachable");
    expect(outcome.status).toBe("completed");
    expect(seen.map((s) => s.model)).toEqual(["claude-sonnet-4-6", "claude-sonnet-4-6"]);
  });

  it("leaves the policy tier alone — an override changes the model, not the routing class", async () => {
    // `policy` drives fallback and cost tiering. Swapping the model id is a
    // different decision from re-tiering the step, and the models catalog is
    // what knows which vendor serves an id.
    const { seen } = await run("run-sm-tier", { draft: "claude-opus-4-8" });

    expect(seen[0]?.policy).toBe("pinned");
  });

  it("fails the run rather than silently routing a Studio typo to a nonexistent model (AU33 / SCRUM-311)", async () => {
    // Before the model-capability catalog, this override reached the router
    // unchecked — a typo in Studio would only surface once the provider
    // rejected it, three layers away from the actual misconfiguration. The
    // engine catches the thrown validation error at the workflow boundary
    // (`WorkflowEngine.run`'s generic catch) and records it as a `degraded`
    // run with the reason preserved, rather than as a silently wrong model.
    const runId = "run-sm-typo";
    const { outcome } = await run(runId, { draft: "claude-sonnet-4-fake-typo" });

    expect(outcome.outcome).toBe("started");
    if (outcome.outcome !== "started") throw new Error("unreachable");
    expect(outcome.status).toBe("degraded");
    const runRecord = await env.durableStore.getRun(runId);
    expect(runRecord?.failureReason).toMatch(/not in the model-capability catalog/);
  });

  it("fails the run when a Studio override names a real, catalogued model from the wrong vendor", async () => {
    // gemini-2.5-pro is a real catalogued model — just not one the Anthropic
    // adapter this stage is wired to (its policy.vendor is unset, i.e.
    // anthropic) will ever be asked to serve. `DefaultModelRouter` picks its
    // adapter from `ModelPolicy.vendor` alone, never from the model id, so
    // letting this through would have sent an anthropic-shaped request
    // carrying a Gemini model id.
    const runId = "run-sm-wrong-vendor";
    const { outcome } = await run(runId, { draft: "gemini-2.5-pro" });

    expect(outcome.outcome).toBe("started");
    if (outcome.outcome !== "started") throw new Error("unreachable");
    expect(outcome.status).toBe("degraded");
    const runRecord = await env.durableStore.getRun(runId);
    expect(runRecord?.failureReason).toMatch(/catalogued under vendor "gemini"/);
  });
});
