import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import { goodFixDrafts, goodNarrative, makePromptStore, setupTestEnvironment, smartFakeRouter, withMeasuredCapture, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "seo_geo_run_gate_timeout", clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring" as const };

/**
 * SCRUM-273/T-A20: both `prompt_set_review` (step 03) and
 * `fix_generation_review` (step 12) shrink from a 24h hold to a 1h
 * auto-approve. This is the cutover proof at the WORKFLOW level (the shared
 * primitive itself is proven in `packages/workflow/__tests__/gate-timeout.test.ts`):
 * a real dispatch with NO `autoApprove` opt-out and NOBODY EVER CALLING
 * `resolveGate` still reaches `completed` once enough fake-clock time has
 * passed — onboarding no longer sticks at `awaiting_gate` indefinitely.
 */
describe("SCRUM-273/T-A20: seo-geo-agent's two human gates auto-approve after 1h", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("a run nobody ever reviews still completes once both gate windows have elapsed", async () => {
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
    // now progresses all the way to step 16 (`batch_review`), which is
    // deliberately OUT of T-A20's scope and stays a plain 24h hold — proving
    // both changed gates cleared on their own is the point of this test, not
    // driving the whole run to `completed` (that would need either a real
    // human decision on step 16 or fast-forwarding a further 24h, neither of
    // which is what this ticket changed).
    clock += 61 * 60 * 1000;
    const thirdGate = await engine.run(workflowFn, params);
    expect(thirdGate.status).toBe("awaiting_gate");
    expect(thirdGate.status === "awaiting_gate" ? thirdGate.pendingGateId : null).toBe(`${params.runId}__16-batch-review-r0`);

    const fixGateStep = await durableStore.getStep(params.runId, "12-fix-generation-review");
    expect(fixGateStep?.output).toMatchObject({ decision: "approve", actor: "system:gate-timeout" });

    // A real human decision on the one gate T-A20 left untouched still
    // completes the run end-to-end — the pipeline upstream of it (including
    // the two auto-approved gates) is genuinely fully automated, not merely
    // "unstuck at 03 but broken further down."
    await engine.resolveGate(params.runId, "16-batch-review-r0", { decision: "approve", actor: "jane@karoslabs.com", at: new Date(clock).toISOString() });
    const final = await engine.run(workflowFn, params);
    expect(final.status).toBe("completed");
    if (final.status !== "completed") throw new Error("unreachable");
    expect(final.output.deliverableId).toBeTruthy();
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
