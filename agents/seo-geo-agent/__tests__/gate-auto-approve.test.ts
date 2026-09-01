import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import { goodFixDrafts, goodNarrative, makePromptStore, setupTestEnvironment, smartFakeRouter, withMeasuredCapture, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "seo_geo_run_gate_timeout", clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring" as const };

/**
 * SCRUM-273/T-A20 shrank `prompt_set_review` (step 03) and
 * `fix_generation_review` (step 12) from a 24h hold to a 1h auto-approve.
 * SCRUM-389 closes the gap T-A20's own ticket text missed: this file (not
 * the ticket, not the dispatch brief) is the source of truth for how many
 * human gates this workflow has, and a full read of it
 * (`grep -n "step\.gate(\|runReviewCycle(" create-seo-geo-agent-workflow.ts`)
 * turns up exactly THREE — 03-prompt-set-review, 12-fix-generation-review,
 * and 16-batch-review (via `runReviewCycle`, which is why a plain
 * `step.gate(` grep alone misses it). All three now carry the same
 * `{ duration: "1h", onTimeout: "auto_approve" }`.
 *
 * This is the cutover proof at the WORKFLOW level (the shared primitive
 * itself is proven in `packages/workflow/__tests__/gate-timeout.test.ts`):
 * a real dispatch with NO `autoApprove` opt-out and NOBODY EVER CALLING
 * `resolveGate` still reaches `completed` once enough fake-clock time has
 * passed for all three windows — onboarding no longer sticks at
 * `awaiting_gate` indefinitely at ANY of the three gates, including the one
 * that actually holds the client-visible deliverable.
 */
describe("SCRUM-273/T-A20 + SCRUM-389: seo-geo-agent's three human gates all auto-approve after 1h", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("a run nobody ever reviews still completes once all three gate windows have elapsed", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    // No `autoApprove` — this is a real dispatch, not the tests'-own opt-out.
    const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore, router });

    let clock = Date.parse("2026-08-30T00:00:00Z");
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore, () => clock);

    const first = await engine.run(workflowFn, params);
    expect(first.status).toBe("awaiting_gate");
    expect(first.status === "awaiting_gate" ? first.pendingGateId : null).toBe(`${params.runId}__03-prompt-set-review`);

    // 61 minutes later, nobody has resolved the gate — step 03 auto-approves,
    // the run proceeds until it hits step 12's gate, which has JUST opened
    // and is therefore not yet timed out.
    clock += 61 * 60 * 1000;
    const secondGate = await engine.run(workflowFn, params);
    expect(secondGate.status).toBe("awaiting_gate");
    expect(secondGate.status === "awaiting_gate" ? secondGate.pendingGateId : null).toBe(`${params.runId}__12-fix-generation-review`);

    const promptGateStep = await durableStore.getStep(params.runId, "03-prompt-set-review");
    expect(promptGateStep?.output).toMatchObject({ decision: "approve", actor: "system:gate-timeout" });

    // Another 61 minutes — step 12's own window has now elapsed too. The run
    // now progresses all the way to step 16 (`batch_review`), which per
    // SCRUM-389 is no longer out of scope: it carries the same 1h/auto_approve
    // as its two siblings, so it is now open and waiting on its own clock.
    clock += 61 * 60 * 1000;
    const thirdGate = await engine.run(workflowFn, params);
    expect(thirdGate.status).toBe("awaiting_gate");
    expect(thirdGate.status === "awaiting_gate" ? thirdGate.pendingGateId : null).toBe(`${params.runId}__16-batch-review-r0`);

    const fixGateStep = await durableStore.getStep(params.runId, "12-fix-generation-review");
    expect(fixGateStep?.output).toMatchObject({ decision: "approve", actor: "system:gate-timeout" });

    // A THIRD 61 minutes — 16-batch-review's own window elapses with nobody
    // ever having called `resolveGate` on it either. SCRUM-389's whole point:
    // the run reaches `completed` with zero human decisions anywhere in it,
    // proving the client-visible deliverable itself no longer sticks at
    // `awaiting_gate` for up to 24h.
    clock += 61 * 60 * 1000;
    const final = await engine.run(workflowFn, params);
    expect(final.status).toBe("completed");
    if (final.status !== "completed") throw new Error("unreachable");
    expect(final.output.deliverableId).toBeTruthy();

    const batchReviewGateStep = await durableStore.getStep(params.runId, "16-batch-review-r0");
    expect(batchReviewGateStep?.output).toMatchObject({ decision: "approve", actor: "system:gate-timeout" });
  });

  it("a real human decision on 16-batch-review before its window elapses still completes the run (the timeout is a fallback, not the only path)", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore, router });

    let clock = Date.parse("2026-08-30T00:00:00Z");
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore, () => clock);

    const runId = "seo_geo_run_gate_16_human";
    await engine.run(workflowFn, { ...params, runId });
    clock += 61 * 60 * 1000;
    await engine.run(workflowFn, { ...params, runId });
    clock += 61 * 60 * 1000;
    const atBatchReview = await engine.run(workflowFn, { ...params, runId });
    expect(atBatchReview.status).toBe("awaiting_gate");
    expect(atBatchReview.status === "awaiting_gate" ? atBatchReview.pendingGateId : null).toBe(`${runId}__16-batch-review-r0`);

    await engine.resolveGate(runId, "16-batch-review-r0", { decision: "approve", actor: "jane@karoslabs.com", at: new Date(clock).toISOString() });
    const final = await engine.run(workflowFn, { ...params, runId });
    expect(final.status).toBe("completed");
    if (final.status !== "completed") throw new Error("unreachable");
    expect(final.output.deliverableId).toBeTruthy();

    const batchReviewGateStep = await durableStore.getStep(runId, "16-batch-review-r0");
    expect(batchReviewGateStep?.output).toMatchObject({ decision: "approve", actor: "jane@karoslabs.com" });
  });

  it("resolving a gate by hand before the window elapses still works exactly as before (a real human decision, not the timeout)", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore, router });

    const clock = Date.parse("2026-08-30T00:00:00Z");
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore, () => clock);

    const runId = "seo_geo_run_gate_human";
    const first = await engine.run(workflowFn, { ...params, runId });
    expect(first.status).toBe("awaiting_gate");

    await engine.resolveGate(runId, "03-prompt-set-review", { decision: "approve", actor: "jane@karoslabs.com", at: new Date(clock).toISOString() });
    const afterHumanApproval = await engine.run(workflowFn, { ...params, runId });
    expect(afterHumanApproval.status).toBe("awaiting_gate"); // now at step 12

    const promptGateStep = await durableStore.getStep(runId, "03-prompt-set-review");
    expect(promptGateStep?.output).toMatchObject({ decision: "approve", actor: "jane@karoslabs.com" });
  });
});
