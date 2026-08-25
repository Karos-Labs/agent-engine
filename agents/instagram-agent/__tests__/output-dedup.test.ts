import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";
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

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

/** Same shape, genuinely different words — lands well under the 0.4 trigram threshold. */
function freshCopy(): InstagramCopyOutput {
  const good = goodCopyOutput();
  return {
    ...good,
    caption: "A completely separate story about how the design department reorganized their weekly critique sessions.",
    slides: good.slides.map((s, i) => ({
      ...s,
      headline: `Another take ${i + 1}`,
      body: `Distinct sentence ${i + 1} exploring an unrelated dimension of the quarterly workflow experiments nobody wrote about yet.`,
    })),
  };
}

describe("output dedup: the shipped-output window steers future runs", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    // Two-plus runs against one client — the topic-floor guard needs headroom.
    env = await setupTestEnvironment({ seedTopics: Array.from({ length: 12 }, (_, i) => `dedup test topic ${i + 1}`) });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  function workflowFor(router: ReturnType<typeof fakeRouterSequence>) {
    return createInstagramAgentWorkflow({
      tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });
  }

  it("delivery records the post into the excerpt window, and a repeat draft on the NEXT run burns a retry and redrafts", async () => {
    const engine = new WorkflowEngine(new MemoryDurableStepStore());

    // Run 1: ships goodCopyOutput's text, which enters the window.
    const first = await engine.run(
      workflowFor(
        fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(goodCopyOutput()), finalTurn(goodImageVettingOutput()), finalTurn(goodVisualQaOutput())]),
      ),
      { runId: "dedup_run_1", ...base },
    );
    expect(first.status).toBe("completed");
    const window = await env.store.readJson<Array<{ runId: string; excerpt: string }>>("acme", ["ledger", "output-history", "instagram-agent"]);
    expect(window?.some((e) => e.runId === "dedup_run_1" && e.excerpt.includes("Finding #1"))).toBe(true);

    // Run 2: the model re-drafts the SAME post (attempt 1), gets caught by
    // 07d, and its second attempt (fresh copy) ships instead.
    const durableStore2 = new MemoryDurableStepStore();
    const second = await new WorkflowEngine(durableStore2).run(
      workflowFor(
        fakeRouterSequence([
          finalTurn(goodResearchOutput()),
          finalTurn(goodCopyOutput()),
          finalTurn(goodImageVettingOutput()),
          finalTurn(freshCopy()),
          finalTurn(goodImageVettingOutput()),
          finalTurn(goodVisualQaOutput()),
        ]),
      ),
      { runId: "dedup_run_2", ...base },
    );
    expect(second.status).toBe("completed");

    const steps = await durableStore2.listSteps("dedup_run_2");
    const verdict1 = steps.find((s) => s.stepId === "07d-dedupe-check-attempt-1")?.output as { status: string; maxSimilarity: number } | undefined;
    expect(verdict1?.status).toBe("similar");
    // The redraft genuinely ran and cleared the check.
    const verdict2 = steps.find((s) => s.stepId === "07d-dedupe-check-attempt-2")?.output as { status: string } | undefined;
    expect(verdict2?.status).toBe("ok");
    const delivered = steps.find((s) => s.stepId === "07c-emit-slides-data-attempt-2")?.output as
      | { slides: Array<{ fields: Record<string, string> }> }
      | undefined;
    expect(delivered?.slides[0]?.fields["headline"]).toContain("Another take");
  }, 60000);

  it("a repeat that survives every attempt ships FLAGGED, never held — the human gate outranks the threshold", async () => {
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const r1 = await engine.run(
      workflowFor(
        fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(goodCopyOutput()), finalTurn(goodImageVettingOutput()), finalTurn(goodVisualQaOutput())]),
      ),
      { runId: "dedup_flag_1", ...base },
    );
    expect(r1.status).toBe("completed");

    // Run 2 drafts the identical post on ALL three attempts.
    const durableStore = new MemoryDurableStepStore();
    const r2 = await new WorkflowEngine(durableStore).run(
      workflowFor(
        fakeRouterSequence([
          finalTurn(goodResearchOutput()),
          finalTurn(goodCopyOutput()),
          finalTurn(goodImageVettingOutput()),
          finalTurn(goodCopyOutput()),
          finalTurn(goodImageVettingOutput()),
          finalTurn(goodCopyOutput()),
          finalTurn(goodImageVettingOutput()),
          finalTurn(goodVisualQaOutput()),
        ]),
      ),
      { runId: "dedup_flag_2", ...base },
    );
    // Ships anyway: dedup flags, it does not hold. The verdict is in the
    // trace for the reviewer.
    expect(r2.status).toBe("completed");
    const finalVerdict = (await durableStore.listSteps("dedup_flag_2")).find((s) => s.stepId === "07d-dedupe-check-attempt-3")?.output as
      | { status: string }
      | undefined;
    expect(finalVerdict?.status).toBe("similar");
  }, 60000);
});
