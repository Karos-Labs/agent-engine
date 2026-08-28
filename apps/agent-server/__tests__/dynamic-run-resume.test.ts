import { describe, expect, it, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Application } from "express";
import { MemoryAgentDefinitionStore, type AgentDefinitionInput } from "@agent-engine/core";
import { WorkflowEngine, type WorkflowContext } from "@agent-engine/workflow";
import { createApp } from "../src/app.js";
import { setupTestEnvironment, smartFakeRouter, type TestEnvironment } from "./test-helpers.js";

/**
 * SCRUM-315 / AU6 — `POST /runs/:runId/resume` for a DYNAMIC agent (Task 2).
 *
 * Deliberately a file of its own rather than an addition to `runs.test.ts`:
 * that file is another ticket's surface (SCRUM-345) and every test in it is
 * about one of the 13 fixed products.
 *
 * ## Why the paused run is seeded rather than produced by the dynamic runner
 *
 * `buildDynamicWorkflow` emits no `wf.step.gate` call today — an
 * `AgentDefinition` has no gate stage kind (`packages/core/src/agent-definitions/
 * types.ts` has only `"ai"` and `"code"`), and `report.ts:409` says so in as
 * many words. So the paused state cannot be reached by running a definition,
 * and this test builds it the only other way it can exist: by running a real
 * gating workflow through the real `WorkflowEngine` under the dynamic agent's
 * own `productId`. What lands in the store — a run record at `awaiting_gate`
 * carrying a non-fixed `productId`, plus a registered, unresolved gate record —
 * is byte-identical to what a gating dynamic agent would leave behind, which is
 * the state `/resume` is being asked to handle.
 *
 * The honest scope of the bug, stated plainly: the asymmetry in `routes/runs.ts`
 * is real and present in the code, but the ticket's "hits a gate" symptom is
 * LATENT today, not live, precisely because no definition can declare a gate.
 */

const GATE_ID = "human-review";

function twoStageAgent(agentId: string): AgentDefinitionInput {
  return {
    agentId,
    name: "Two Stage Agent",
    description: "A dynamic agent with two sequential stages",
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

/** Drives a real run under `productId` to a real `awaiting_gate` state — see the file header. */
async function pauseAtGate(env: TestEnvironment, runId: string, productId: string): Promise<string> {
  const engine = new WorkflowEngine(env.durableStore);
  const result = await engine.run(
    async (wf: WorkflowContext) => {
      await wf.step.gate(GATE_ID, {
        kind: "batch_review",
        payload: { headline: "Big News Today" },
        requiredRole: "account_manager",
        timeout: { duration: "24h", onTimeout: "hold" },
      });
      return {};
    },
    { runId, clientSlug: "acme", productId, runKind: "recurring" },
  );
  if (result.status !== "awaiting_gate") throw new Error(`seed failed: expected awaiting_gate, got ${result.status}`);
  const record = await env.durableStore.getRun(runId);
  expect(record?.status, "the seeded run must actually be parked at a gate before /resume is called").toBe("awaiting_gate");
  expect(record?.productId, "and it must carry the dynamic agent's own id, not a fixed product").toBe(productId);
  return result.pendingGateId;
}

const APPROVE = { gateId: GATE_ID, resolution: { decision: "approve" as const, actor: "tester" } };

describe("POST /api/v1/runs/:runId/resume — dynamic agents (SCRUM-315 / AU6)", () => {
  let env: TestEnvironment;
  let agentDefinitionStore: MemoryAgentDefinitionStore;
  let app: Application;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    agentDefinitionStore = new MemoryAgentDefinitionStore();
    app = createApp({
      durableStore: env.durableStore,
      // The shared fake router in `test-helpers` answers the five channel agents'
      // schemas; this agent's two stages need their own candidate outputs.
      runtimeDeps: { ...env.runtimeDeps, router: smartFakeRouter([{ headline: "Big News Today" }, { score: 9 }]) },
      agentDefinitionStore,
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("resumes a registered dynamic agent's paused run instead of rejecting its productId", async () => {
    await agentDefinitionStore.upsert("headline-scorer", twoStageAgent("headline-scorer"), { expectExisting: false });
    await pauseAtGate(env, "run-dyn-resume", "headline-scorer");

    const res = await request(app).post("/api/v1/runs/run-dyn-resume/resume").send(APPROVE);

    // Before the fix this is 500 `unrecognized productId "headline-scorer"`: the
    // route narrowed the stored productId to the fixed 13 and gave up on anything
    // else, so the human approval above could never be delivered.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    // The definition's own stages actually ran on the resumed half, which is the
    // difference between "the route stopped 500ing" and "the run resumed".
    const stepIds = (await env.durableStore.listSteps("run-dyn-resume")).map((s) => s.stepId).sort();
    expect(stepIds).toContain("draft");
    expect(stepIds).toContain("score");
    expect(res.body.report).toBeDefined();
  });

  /**
   * The other half of the same change, and the reason it is not a check that
   * cannot fail: widening resume to dynamic agents must not widen it to
   * ANYTHING. A run record naming an id that resolves to neither a fixed
   * product nor a registered definition still has to be refused.
   */
  it("still refuses a run whose stored productId resolves to no workflow at all", async () => {
    await pauseAtGate(env, "run-dyn-orphan", "deleted-agent");

    const res = await request(app).post("/api/v1/runs/run-dyn-orphan/resume").send(APPROVE);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/neither a known product id nor a registered dynamic agent/);
    // And it refused BEFORE recording the decision: a productId that cannot be
    // resolved must not consume the human's one-shot gate response.
    const gate = await env.durableStore.getGate("run-dyn-orphan__human-review");
    expect(gate?.response, "the gate must still be open for a later, working resume").toBeUndefined();
  });
});
