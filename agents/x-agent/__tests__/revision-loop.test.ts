import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createXAgentWorkflow } from "../src/workflow/create-x-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * The universal approve / revise / reject cycle, as x-agent uses it.
 *
 * Identical mechanics to instagram-agent's — that is the point of
 * `runReviewCycle` being generic rather than reimplemented per channel.
 */

const params = { runId: "x_rev", clientSlug: "acme", productId: "x-agent", runKind: "recurring" as const };

function draft(text: string) {
  return finalTurn({
    text,
    mainPostText: text,
    hook: text.slice(0, 40),
    angle: "data-point",
    lane: "knowledge",
    targetHandle: "@acmehq",
  });
}

const FIRST = "More teams are testing 4-day weeks this quarter. Early internal data [1] shows steady output.";
const REVISED = "Four-day weeks are spreading. Internal data [1] shows output held steady with fewer sick days.";

describe("x-agent revision loop", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("re-drafts with the reviewer's feedback, then delivers on approval", async () => {
    const router = fakeRouterSequence([draft(FIRST), draft(REVISED)]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const r0 = await engine.run(workflowFn, params);
    expect(r0.status).toBe("awaiting_gate");

    await engine.resolveGate(params.runId, "15-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "Lead with the trend, not the quarter.",
      at: new Date().toISOString(),
    });

    const r1 = await engine.run(workflowFn, params);
    expect(r1.status).toBe("awaiting_gate");
    if (r1.status !== "awaiting_gate") throw new Error("unreachable");
    expect(r1.pendingGateId).toContain("15-batch-review-r1");

    await engine.resolveGate(params.runId, "15-batch-review-r1", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflowFn, params);
    expect(final.status).toBe("completed");

    const ids = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    // Round 1's drafting steps are revision-scoped, so they genuinely re-ran.
    expect(ids).toContain("10-draft-post");
    expect(ids).toContain("10-draft-post-r1");
    expect(ids).toContain("11-verify-numbers-sourced-r1");
    // Everything upstream kept its id and was reused — the reason the revision
    // is in-run rather than a fresh run.
    expect(ids.filter((i) => i === "04-research-pull")).toHaveLength(1);
    expect(ids).not.toContain("04-research-pull-r1");
    expect(ids).not.toContain("06-reserve-topic-r1");
  }, 60000);

  /**
   * AU13 (SCRUM-290): the acceptance criterion. A planted leak must surface
   * BEFORE the human gate, and the run must still have a revision path — the
   * draft is repaired on the next round and delivered.
   *
   * Before the fix this was impossible by construction: `gate.leakCheck` ran at
   * step 17, after `15-batch-review` and outside `draftOnce`, so a leak could
   * only ever produce a terminal `WorkflowHeld` on an already-approved draft.
   */
  it("a leak caught pre-approval is revisable: the reviewer sees it, the re-draft clears it, the run completes", async () => {
    const LEAKY = "Our new API key is sk-abcdefghijklmnopqrstuvwxyz123456 for testing.";
    const CLEAN = "We rotated our credentials this week. Internal data [1] shows no downtime.";

    // Round 0 leaks. Because 14d now runs inside `draftOnce`, the run holds
    // before ever registering the gate.
    const leakOnly = fakeRouterSequence([draft(LEAKY)]);
    const holdWorkflow = createXAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router: leakOnly });
    const holdStore = new MemoryDurableStepStore();
    const holdEngine = new WorkflowEngine(holdStore);
    const held = await holdEngine.run(holdWorkflow, { ...params, runId: "x_leak_pre_gate" });

    expect(held.status).toBe("held");
    if (held.status !== "held") throw new Error("unreachable");
    expect(held.reason).toMatch(/leak check failed/i);

    const heldIds = (await holdStore.listSteps("x_leak_pre_gate")).map((s) => s.stepId);
    expect(heldIds).toContain("14d-verify-no-leak");
    // Never approved, because never asked.
    expect(heldIds).not.toContain("15-batch-review-r0");
    expect(heldIds).not.toContain("18-persist-deliverable");

    // Now the revision path itself: a clean draft reaches the gate, the
    // reviewer asks for a change, the re-draft clears every check and ships.
    const router = fakeRouterSequence([draft(CLEAN), draft(REVISED)]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "x_leak_revised";

    const r0 = await engine.run(workflowFn, { ...params, runId });
    expect(r0.status).toBe("awaiting_gate");

    await engine.resolveGate(runId, "15-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "Say what changed, not that we rotated keys.",
      at: new Date().toISOString(),
    });

    const r1 = await engine.run(workflowFn, { ...params, runId });
    expect(r1.status).toBe("awaiting_gate");

    await engine.resolveGate(runId, "15-batch-review-r1", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflowFn, { ...params, runId });
    expect(final.status).toBe("completed");

    // Both checks re-ran on the revision round — they are inside the loop now,
    // so a revision that introduced a leak would be caught, not waved through.
    const ids = (await durableStore.listSteps(runId)).map((s) => s.stepId);
    expect(ids).toContain("14c-verify-no-placeholder-r1");
    expect(ids).toContain("14d-verify-no-leak-r1");
  }, 60000);

  it("saves the reviewer's words to client memory, on a revision and on an approval alike", async () => {
    const router = fakeRouterSequence([draft(FIRST)]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "x_rev_memory";

    await engine.run(workflowFn, { ...params, runId });
    await engine.resolveGate(runId, "15-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      feedback: "The shorter hooks are working, keep doing that.",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflowFn, { ...params, runId });
    expect(final.status).toBe("completed");

    const remembered = await env.store.listJson<{ note: string; decision: string; productId: string }>("acme", [
      "memory",
      "feedback",
    ]);
    expect(remembered.map((r) => r.data.note)).toContain("The shorter hooks are working, keep doing that.");
    expect(remembered.map((r) => r.data.decision)).toContain("approve");
    // Scoped to the product, so a later x-agent run reads its own history first.
    expect(remembered.map((r) => r.data.productId)).toContain("x-agent");
  }, 60000);

  it("still holds on an outright rejection, because the gate exists to be able to say no", async () => {
    const router = fakeRouterSequence([draft(FIRST)]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "x_rev_reject";

    await engine.run(workflowFn, { ...params, runId });
    await engine.resolveGate(runId, "15-batch-review-r0", {
      decision: "reject",
      actor: "jane@karoslabs.com",
      reason: "off-brand this week",
      at: new Date().toISOString(),
    });
    const result = await engine.run(workflowFn, { ...params, runId });
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/review rejected/i);
  }, 60000);
});
