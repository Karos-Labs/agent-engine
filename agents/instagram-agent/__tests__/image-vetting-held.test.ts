import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRouterSequence,
  finalTurn,
  goodCopyOutput,
  goodImageCandidatePool,
  goodResearchOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "instagram_run_novimg", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

describe("06-vet-images: no viable image holds the WHOLE post (preserved legacy-defect fix, RFC-03 §1/§3)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("holds the whole post when exactly one slide has no viable candidate -- never a placeholder, never a silently-dropped slide", async () => {
    const promptStore = makePromptStore();
    const copy = goodCopyOutput();
    const vetting = {
      selections: copy.slides.map((s) => ({
        n: s.n,
        imagePath: s.n === 3 ? null : goodImageCandidatePool()[0]!.path,
        reason: s.n === 3 ? "nothing in the pool shows this slide's specific visual need" : "candidate matches closely enough",
        license: s.n === 3 ? "n/a — no candidate qualified" : "CC0, test fixture",
        rightsUsable: s.n !== 3,
        watermarkFree: s.n !== 3,
      })),
    };
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(copy), finalTurn(vetting)]);
    const workflowFn = createInstagramAgentWorkflow({
      tools: env.tools,
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/no viable image found for slide\(s\) 3/i);
    expect(result.reason).toMatch(/holding the whole post/i);

    // The hold fires immediately after image vetting -- self-check, slides-data
    // assembly, and rendering never even ran; nothing was rendered, nothing
    // was delivered, and the "unfillable" slide was never quietly excluded
    // from the run's own accounting.
    const stepRecords = await durableStore.listSteps(params.runId);
    const stepIds = stepRecords.map((s) => s.stepId);
    expect(stepIds).toContain("06-vet-images-attempt-1");
    expect(stepIds).not.toContain("07-self-check-attempt-1");
    expect(stepIds).not.toContain("08-render-carousel");
    expect(stepIds).not.toContain("09b-deliver-and-log");

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables).toHaveLength(0);
  });

  it("holds the whole post when every slide is unfillable (an empty/irrelevant candidate pool)", async () => {
    const promptStore = makePromptStore();
    const copy = goodCopyOutput();
    const vetting = {
      selections: copy.slides.map((s) => ({
        n: s.n,
        imagePath: null,
        reason: "the supplied pool has no candidates at all for this run",
        license: "n/a — no candidate qualified",
        rightsUsable: false,
        watermarkFree: false,
      })),
    };
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(copy), finalTurn(vetting)]);
    const workflowFn = createInstagramAgentWorkflow({
      tools: env.tools,
      promptStore,
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: [], // Phase-1 stand-in pool is empty this run -- nothing to vet against
      autoApprove: true,
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...params, runId: "instagram_run_novimg_all" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/no viable image found for slide\(s\) 1, 2, 3, 4, 5, 6/);
  });
});
