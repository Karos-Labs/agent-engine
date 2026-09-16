import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  goodRelevanceVerdict,
  goodTrendScoutOutput,
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
import { DEFAULT_ENTITIES_TURN, DEFAULT_PACKAGE_TURN, VALUE_TURN_NO_FINDINGS } from "./turns.js";
import { goodAngleProposal } from "./angle-fixtures.js";

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
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(badQa),
      // Attempt 2: full re-run of write-copy -> vet-images -> visual QA.
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(goodVisualQaOutput()), finalTurn(DEFAULT_PACKAGE_TURN),
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

    // scout + research + angle + 2 x (copy + vet + relevance + QA).
    expect(result.status).toBe("completed");
    // Phase 5.5 (spec §2 A2): +1 for `04b3-extract-entities`, ONE model turn per REVISION (outside the attempt loop, so a redraft never re-pays).
    expect(router.complete).toHaveBeenCalledTimes(15);

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

  it("DELIVERS THE RENDER IT ALREADY PAID FOR after all 3 attempts fail visual QA, degraded and naming the ruleId", async () => {
    // RFC-19 §4 item 9. The judge refuses all three renders, at the same bar, in
    // the same words — nothing here is relaxed. What changed is the third one:
    // `finalRendered` is the PNG set attempt 3 already rendered, one assignment
    // away, and binning it removed the absurdity where crossing the hard max made
    // a run SAFER than staying under it (`WF:8454`'s cheapest-path branch has
    // always delivered a post whose QA it could not afford to buy).
    const promptStore = makePromptStore();
    const badQa = { pass: false, findings: [{ ruleId: "nothing-overlaps", passed: false, note: "a headline field and a stat field both claim the same region" }] };
    const router = fakeRouterSequence([
      finalTurn(goodTrendScoutOutput()), finalTurn(goodResearchOutput()), finalTurn(goodAngleProposal()), finalTurn(DEFAULT_ENTITIES_TURN),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(badQa),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(badQa),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodRelevanceVerdict()), finalTurn(VALUE_TURN_NO_FINDINGS), finalTurn(badQa),
      // The ONE turn this fixture gains, and the only one: attempt 3's QA refusal
      // no longer returns the draft to `05`, so the loop breaks normally and
      // `08c-package-post` is bought — the turn a delivering run has always
      // bought, arriving on a path that never used to deliver.
      finalTurn(DEFAULT_PACKAGE_TURN),
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

    expect(result.status, JSON.stringify(result)).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    const stepIds = (await durableStore.listSteps("instagram_run_visualqa_exhausted")).map((s) => s.stepId);
    expect(stepIds).toContain("08b-visual-qa-attempt-3");
    // There is no fourth attempt: the loop exited because attempt 3 finished, not
    // because it ran out of road.
    expect(stepIds).not.toContain("05-write-copy-attempt-4");

    // THE PREMISE (RFC-19 §8.2 assertion 7): the judge really did refuse the
    // render that shipped. A fall-through must happen AFTER a refusal, never
    // INSTEAD of one — without this line the case would pass just as happily if
    // `08b` had quietly started passing everything.
    const qa3 = (await durableStore.getStep("instagram_run_visualqa_exhausted", "08b-visual-qa-attempt-3")) as { output: { finalOutput: { pass: boolean } } };
    expect(qa3.output.finalOutput.pass).toBe(false);

    // The finding carries the judge's OWN ruleId and note, never a paraphrase —
    // a reviewer has to be able to go and read `nothing-overlaps`.
    const selfCheck = result.output.selfCheck;
    expect(selfCheck?.status).toBe("degraded");
    const finding = selfCheck!.checks.find((c) => c.gate === "visual-qa");
    expect(finding, `checks: ${JSON.stringify(selfCheck?.checks)}`).toBeDefined();
    expect(finding!.kind).toBe("nothing-overlaps");
    expect(finding!.detail).toContain("a headline field and a stat field both claim the same region");
    // A judge that REFUSED is not a judge that could not run: `unjudged` is a
    // different kind for a different event (§4 item 10) and must not appear here.
    expect(finding!.kind).not.toBe("unjudged");

    // THE TURN COUNT, ENUMERATED (RFC-19 §8.2 assertion 9):
    //   scout 1 + research 1 + angle 1                                        = 3
    //   3 × (copy + vet + relevance + value + visual QA)                      = 15
    //   after the loop: packager                                              = 1
    //                                                                     total 19
    // Phase 5.5 (spec §2 A2): +1 for `04b3-extract-entities`, ONE model turn per REVISION (outside the attempt loop, so a redraft never re-pays).
    expect(router.complete).toHaveBeenCalledTimes(20);

    // And the client receives it, with the truth attached rather than a 404.
    const deliverables = await env.store.listJson<{ deliverable: { selfCheck?: { reason: string } } }>(
      "acme",
      ["ledger", "deliverables", "instagram_run_visualqa_exhausted", "_"],
    );
    expect(deliverables).toHaveLength(1);
    expect(deliverables[0]!.data.deliverable.selfCheck?.reason).toBe(selfCheck!.reason);
  }, 60000);
});
