import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodCopyOutput,
  goodImageCandidatePool,
  goodImageVettingOutput,
  goodResearchOutput,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "instagram_run_visualqa", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/** Chromium-free `publish.renderCarousel` stand-in — same rationale as `workflow-e2e.test.ts`. */
function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

describe("08b-visual-qa: post-render visual QA runs and retries through the SAME step-07 retry loop (P0 parity-audit Fix 2)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("fails visual QA on attempt 1 (a bad closer, per findings), then succeeds on attempt 2 with a clean re-render", async () => {
    const promptStore = makePromptStore();
    const badQa = {
      pass: false,
      findings: [{ ruleId: "no-empty-closer", slide: 6, passed: false, note: "the closer slide's images carry no device/photo reference" }],
    };
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(badQa),
      // Attempt 2: full re-run of write-copy -> vet-images -> visual QA.
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodVisualQaOutput()),
    ]);
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("completed");
    expect(router.complete).toHaveBeenCalledTimes(7);

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("08b-visual-qa-attempt-1");
    expect(stepIds).toContain("05-write-copy-attempt-2");
    expect(stepIds).toContain("08b-visual-qa-attempt-2");
    expect(stepIds).not.toContain("05-write-copy-attempt-3");

    const qa1 = (await durableStore.getStep(params.runId, "08b-visual-qa-attempt-1")) as { output: { finalOutput: { pass: boolean } } };
    expect(qa1.output.finalOutput.pass).toBe(false);
    const qa2 = (await durableStore.getStep(params.runId, "08b-visual-qa-attempt-2")) as { output: { finalOutput: { pass: boolean } } };
    expect(qa2.output.finalOutput.pass).toBe(true);
  }, 60000);

  it("holds the whole post after exhausting all 3 attempts when visual QA never passes", async () => {
    const promptStore = makePromptStore();
    const badQa = { pass: false, findings: [{ ruleId: "nothing-overlaps", passed: false, note: "a headline field and a stat field both claim the same region" }] };
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(badQa),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(badQa),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(badQa),
    ]);
    const workflowFn = createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "instagram_run_visualqa_exhausted" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/self-check never passed after 3 attempt/i);
    expect(result.reason).toMatch(/visual QA failed on attempt 3/i);

    const stepIds = (await durableStore.listSteps("instagram_run_visualqa_exhausted")).map((s) => s.stepId);
    expect(stepIds).toContain("08b-visual-qa-attempt-3");
    expect(stepIds).not.toContain("09b-deliver-and-log");

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", "instagram_run_visualqa_exhausted", "_"]);
    expect(deliverables).toHaveLength(0);
  }, 60000);
});
