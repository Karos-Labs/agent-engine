import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { ModelRouter } from "@agent-engine/core";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import { goodFixDrafts, goodNarrative, makePromptStore, setupTestEnvironment, withMeasuredCapture, type TestEnvironment } from "./test-helpers.js";

/**
 * The end-to-end half of `previous-run.test.ts`.
 *
 * A pure comparison module that nothing calls would pass every one of its own
 * tests while four consecutive reports stayed identical. So this runs the
 * whole workflow TWICE for one client and reads the prompt the narrative agent
 * was actually handed on the second run.
 */

/** Records every prompt the router is asked to complete, so the test can read what the narrative was told. */
function recordingRouter(prompts: string[]): ModelRouter {
  return {
    async complete(prompt, schema, policy) {
      prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
      for (const candidate of [goodFixDrafts(), goodNarrative()]) {
        const parsed = schema.safeParse({ type: "final", output: candidate });
        if (parsed.success) {
          return {
            output: parsed.data,
            modelUsed: policy.policy === "pinned" ? policy.model : "claude-haiku-4-5-20251001",
            inputTokens: { cached: 0, uncached: 100 },
            outputTokens: 30,
          };
        }
      }
      throw new Error("recordingRouter: no candidate matches the schema");
    },
    async completeAlias() {
      throw new Error("not used");
    },
  } as ModelRouter;
}

describe("09b: the report is written against the previous run", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  const run = async (runId: string, prompts: string[]) => {
    const workflowFn = createSeoGeoAgentWorkflow({
      tools: withMeasuredCapture(env.tools),
      promptStore: makePromptStore(),
      router: recordingRouter(prompts),
      autoApprove: true,
    });
    const store = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(store).run(workflowFn, {
      runId,
      clientSlug: "acme",
      productId: "seo-geo-agent",
      runKind: "recurring" as const,
    });
    return { result, steps: await store.listSteps(runId) };
  };

  it("has nothing to compare on the first run, and says so", async () => {
    const prompts: string[] = [];
    const { result, steps } = await run("seo_geo_first", prompts);
    expect(result.status).toBe("completed");
    expect(steps.find((s) => s.stepId === "09b-read-previous-run")?.output).toBeNull();
    const narrativePrompt = prompts.find((p) => p.includes("movementDirective"))!;
    expect(narrativePrompt).toContain("FIRST measured run");
    expect(narrativePrompt).toContain("firstMeasuredRun");
  });

  it("reads the snapshot the previous run wrote, and tells the summary what moved", async () => {
    // The whole defect in one assertion: before this, the second run's prompt
    // was byte-identical to the first's, which is why four karoslabs reports
    // opened on the same sentence.
    await run("seo_geo_one", []);
    const prompts: string[] = [];
    const { result, steps } = await run("seo_geo_two", prompts);
    expect(result.status).toBe("completed");

    const movement = steps.find((s) => s.stepId === "09b-read-previous-run")?.output as {
      previous: { runId: string };
      unchanged: boolean;
    } | null;
    expect(movement).not.toBeNull();
    expect(movement!.previous.runId).toBe("seo_geo_one");
    // Same fixture twice, so nothing moved — and a flat month must READ as one.
    expect(movement!.unchanged).toBe(true);

    const narrativePrompt = prompts.find((p) => p.includes("movementDirective"))!;
    expect(narrativePrompt).toContain("identical to the previous run");
    expect(narrativePrompt).toContain("scoresUnchangedSinceLastRun");
  });

  it("does not compare a run against itself when the same run id comes round again", async () => {
    // Step 20 writes the snapshot under this run's own id. A run that reaches
    // 09b with that id already in beliefs — a redelivery of the same message, a
    // resume whose checkpoint for this step is gone — would otherwise compare
    // itself against itself and report a flat month it never measured.
    // (A resume WITH its checkpoint replays 09b's stored result and never calls
    // the reader at all, which is why 09b is a step.)
    const prompts: string[] = [];
    await run("seo_geo_self", prompts);
    const again = await run("seo_geo_self", []);
    expect(again.steps.find((s) => s.stepId === "09b-read-previous-run")?.output).toBeNull();
  });
});
