import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { ModelRouter } from "@agent-engine/core";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import { goodFixDrafts, makePromptStore, setupTestEnvironment, withMeasuredCapture, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "seo_geo_narrative_fix", clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring" as const };

/**
 * A router that serves the fix-draft schema from one candidate and the
 * narrative schema from a QUEUE — so the first narrative turn can carry a
 * derived figure and the redraft a clean one, which `smartFakeRouter`'s
 * first-match-wins pool cannot express.
 */
function routerWithNarratives(narratives: string[]): ModelRouter {
  const queue = [...narratives];
  return {
    async complete(_prompt, schema, policy) {
      for (const candidate of [goodFixDrafts(), { summary: queue.length > 1 ? queue.shift()! : queue[0]! }]) {
        const parsed = schema.safeParse({ type: "final", output: candidate });
        if (parsed.success) {
          return { output: parsed.data, modelUsed: policy.policy === "pinned" ? policy.model : "claude-haiku-4-5-20251001", inputTokens: { cached: 0, uncached: 100 }, outputTokens: 30 };
        }
      }
      throw new Error("routerWithNarratives: no candidate matches the schema");
    },
    async completeAlias() {
      throw new Error("not used");
    },
  } as ModelRouter;
}

describe("14b: the narrative corrects an unsourced figure before the gate, and still holds when it cannot", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("redrafts once with the flagged figure named, then passes the gate", async () => {
    const router = routerWithNarratives([
      // "37%" appears nowhere in the scoring output — the shape of the 2026-09-07 hold (100 minus a coverage figure).
      "Based on the data measured so far, roughly 37% of checks still need a Search Console connection.",
      "This audit scored the site based on the data measured so far; fix drafts are attached.",
    ]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFn, params);
    expect(result.status).toBe("completed");
    const steps = await durableStore.listSteps(params.runId);
    const corrected = steps.find((s) => s.stepId === "14b-ground-narrative-numbers");
    expect(corrected?.status).toBe("completed");
    expect((corrected?.output as { summary: string }).summary).toContain("fix drafts are attached");
    expect(steps.find((s) => s.stepId === "15-verify-narrative-numbers")?.status).toBe("completed");
  });

  it("holds at the real gate when the redraft repeats the unsourced figure — the correction pass never waves a summary through", async () => {
    const router = routerWithNarratives(["Roughly 37% of checks still need a Search Console connection."]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore: makePromptStore(), router, autoApprove: true });
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, params);
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toContain("37%");
  });
});
