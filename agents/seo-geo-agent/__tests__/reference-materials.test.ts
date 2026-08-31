import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { ModelRouter } from "@agent-engine/core";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import { goodFixDrafts, goodNarrative, makePromptStore, setupTestEnvironment, smartFakeRouter, withMeasuredCapture, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "seo_geo_run_refs", clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring" as const };

/**
 * Wraps `smartFakeRouter` (unchanged behavior) but also records every raw
 * `prompt` string `BaseAgent.buildTurnPrompt` builds, tagged by which step's
 * config produced it (`stepId` is always present in that JSON — see
 * `base-agent.ts`'s `buildTurnPrompt`). This is how these tests prove a field
 * *actually reaches the model-facing prompt bytes*, not merely some
 * intermediate object nobody serializes.
 */
function recordingRouter(candidates: readonly unknown[]): { router: ModelRouter; promptsByStepId: Map<string, string[]> } {
  const inner = smartFakeRouter(candidates);
  const promptsByStepId = new Map<string, string[]>();
  const router = {
    async complete(prompt: string, schema: unknown, policy: unknown, opts: unknown) {
      const parsed = JSON.parse(prompt) as { stepId?: string };
      const stepId = parsed.stepId ?? "(unknown)";
      const list = promptsByStepId.get(stepId) ?? [];
      list.push(prompt);
      promptsByStepId.set(stepId, list);
      return (inner.complete as (...a: unknown[]) => unknown)(prompt, schema, policy, opts);
    },
    async completeAlias(...args: unknown[]) {
      return (inner.completeAlias as (...a: unknown[]) => unknown)(...args);
    },
  } as unknown as ModelRouter;
  return { router, promptsByStepId };
}

describe("T-A13/SCRUM-269: client-attached 'reference' media reaches the drafting prompts", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("a reference-role asset's uri/label land in BOTH step 13's and step 14's actual model-facing prompt", async () => {
    const { router, promptsByStepId } = recordingRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore: makePromptStore(), router, autoApprove: true });

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, {
      ...params,
      input: {
        mediaAssets: [{ uri: "gs://bucket/competitor-teardown.pdf", role: "reference", label: "Q3 competitor audit" }],
      },
    });

    expect(result.status).toBe("completed");

    const fixPrompts = promptsByStepId.get("seo-geo-fix-draft") ?? [];
    const narrativePrompts = promptsByStepId.get("seo-geo-narrative") ?? [];
    expect(fixPrompts.length).toBeGreaterThan(0);
    expect(narrativePrompts.length).toBeGreaterThan(0);

    // Every turn's prompt carries the CURRENT input on every turn (see
    // `buildTurnPrompt`), so the first turn of each step is enough to check.
    expect(fixPrompts[0]).toContain('"clientAttachedReferences"');
    expect(fixPrompts[0]).toContain("gs://bucket/competitor-teardown.pdf");
    expect(fixPrompts[0]).toContain("Q3 competitor audit");

    expect(narrativePrompts[0]).toContain('"clientAttachedReferences"');
    expect(narrativePrompts[0]).toContain("gs://bucket/competitor-teardown.pdf");
    expect(narrativePrompts[0]).toContain("Q3 competitor audit");
  });

  it("a 'source'-role asset (not 'reference') is excluded from clientAttachedReferences entirely", async () => {
    const { router, promptsByStepId } = recordingRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore: makePromptStore(), router, autoApprove: true });

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, {
      ...params,
      runId: "seo_geo_run_refs_source_role",
      input: {
        mediaAssets: [{ uri: "gs://bucket/some-source-video.mp4", role: "source", label: "not a reference" }],
      },
    });

    expect(result.status).toBe("completed");
    const fixPrompt = (promptsByStepId.get("seo-geo-fix-draft") ?? [])[0];
    const narrativePrompt = (promptsByStepId.get("seo-geo-narrative") ?? [])[0];
    expect(fixPrompt).toBeDefined();
    expect(narrativePrompt).toBeDefined();
    // The field must be omitted entirely, not present-but-empty — same
    // omit-when-absent rule `runDirectionField` already follows.
    expect(fixPrompt).not.toContain("clientAttachedReferences");
    expect(fixPrompt).not.toContain("some-source-video.mp4");
    expect(narrativePrompt).not.toContain("clientAttachedReferences");
    expect(narrativePrompt).not.toContain("some-source-video.mp4");
  });

  it("a run with no mediaAssets at all omits clientAttachedReferences from every drafting prompt", async () => {
    const { router, promptsByStepId } = recordingRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore: makePromptStore(), router, autoApprove: true });

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, { ...params, runId: "seo_geo_run_refs_none" });

    expect(result.status).toBe("completed");
    const fixPrompt = (promptsByStepId.get("seo-geo-fix-draft") ?? [])[0];
    const narrativePrompt = (promptsByStepId.get("seo-geo-narrative") ?? [])[0];
    expect(fixPrompt).not.toContain("clientAttachedReferences");
    expect(narrativePrompt).not.toContain("clientAttachedReferences");
  });

  it("a typed customPrompt (runDirection) also demonstrably reaches both drafting prompts", async () => {
    const { router, promptsByStepId } = recordingRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore: makePromptStore(), router, autoApprove: true });

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, {
      ...params,
      runId: "seo_geo_run_refs_customprompt",
      input: { customPrompt: "lead with the pricing-page findings" },
    });

    expect(result.status).toBe("completed");
    const fixPrompt = (promptsByStepId.get("seo-geo-fix-draft") ?? [])[0];
    const narrativePrompt = (promptsByStepId.get("seo-geo-narrative") ?? [])[0];
    expect(fixPrompt).toContain("lead with the pricing-page findings");
    expect(narrativePrompt).toContain("lead with the pricing-page findings");
  });

  it("malformed mediaAssets entries are dropped, not thrown on — the run still completes, and only the valid entry survives", async () => {
    const { router, promptsByStepId } = recordingRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore: makePromptStore(), router, autoApprove: true });

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, {
      ...params,
      runId: "seo_geo_run_refs_malformed",
      input: {
        mediaAssets: [
          { uri: "", role: "reference" }, // empty uri fails MediaAssetSchema's min(1) — dropped
          { role: "reference" }, // missing uri entirely — dropped
          "not-even-an-object", // dropped
          42, // dropped
          null, // dropped
          { uri: "gs://bucket/good-reference.pdf", role: "reference", label: "Valid Ref" }, // the one good entry
        ],
      },
    });

    expect(result.status).toBe("completed");
    const fixPrompt = (promptsByStepId.get("seo-geo-fix-draft") ?? [])[0];
    expect(fixPrompt).toContain('"clientAttachedReferences"');
    expect(fixPrompt).toContain("gs://bucket/good-reference.pdf");
    expect(fixPrompt).toContain("Valid Ref");
    // Confirms exactly one survivor, not that the junk entries silently
    // became additional (malformed) reference rows.
    const parsed = JSON.parse(fixPrompt!) as { input: { clientAttachedReferences: unknown[] } };
    expect(parsed.input.clientAttachedReferences).toHaveLength(1);
  });

  it("an entirely garbage mediaAssets array (nothing valid survives) completes with the field omitted, never a run failure", async () => {
    const { router, promptsByStepId } = recordingRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore: makePromptStore(), router, autoApprove: true });

    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, {
      ...params,
      runId: "seo_geo_run_refs_all_garbage",
      input: { mediaAssets: ["junk", 1, null, {}, { role: "reference" }] },
    });

    expect(result.status).toBe("completed");
    const fixPrompt = (promptsByStepId.get("seo-geo-fix-draft") ?? [])[0];
    expect(fixPrompt).not.toContain("clientAttachedReferences");
  });

  it("a `mediaAssets` that isn't even an array (the never-throws guard's own case) still completes, field omitted", async () => {
    const { router, promptsByStepId } = recordingRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore: makePromptStore(), router, autoApprove: true });

    // `readRichRunInput`'s never-throws contract is exercised at its widest
    // point here: `mediaAssets` is not an array at all, the shape its own
    // `Array.isArray` guard exists for.
    const result = await new WorkflowEngine(new MemoryDurableStepStore()).run(workflowFn, {
      ...params,
      runId: "seo_geo_run_refs_not_an_array",
      input: { mediaAssets: "not-an-array-at-all" },
    });

    expect(result.status).toBe("completed");
    const fixPrompt = (promptsByStepId.get("seo-geo-fix-draft") ?? [])[0];
    expect(fixPrompt).not.toContain("clientAttachedReferences");
  });
});
