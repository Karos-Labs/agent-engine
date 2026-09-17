import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import {
  goodFixDrafts,
  goodNarrative,
  makePromptStore,
  setupTestEnvironment,
  smartFakeRouter,
  withMeasuredCapture,
  type TestEnvironment,
} from "./test-helpers.js";

const params = { runId: "seo_geo_zero_cell", clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring" as const };

/**
 * AU26 (SCRUM-292): a run whose AI-visibility capture measured nothing must
 * end `held` and must never persist a client-facing report.
 *
 * The distinction under test is `measuredCount` vs `capturedCount`. Every
 * capture slot COMPLETES today — `research.captureVisibility` has no capture
 * adapter and returns a successful, schema-valid `UNAVAILABLE` cell for every
 * input — so `capturedCount` is the full prompt×engine matrix on a run that
 * measured precisely nothing. A `capturedCount === 0` guard would never fire.
 */
describe("AU26: zero measured capture cells holds the run", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("DELIVERS the measured technical half when every captured cell is UNAVAILABLE, with the GEO half marked NOT MEASURED", async () => {
    const promptStore = makePromptStore();
    // Records every prompt the workflow sends, so the assertion at the bottom
    // can prove the narrative was actually told not to characterise an
    // unmeasured visibility rather than merely assuming it.
    const seenPrompts: string[] = [];
    const inner = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    const router = {
      complete: (prompt: unknown, schema: unknown, policy: unknown) => {
        seenPrompts.push(String(prompt));
        return (inner.complete as (p: unknown, s: unknown, o: unknown) => unknown)(prompt, schema, policy);
      },
      completeAlias: inner.completeAlias,
    } as typeof inner;
    // env.tools is the REAL registry — the stub capture tool, unmodified.
    const workflowFn = createSeoGeoAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    // The technical half of this report comes from a real crawl. Withholding
    // it because the AI-visibility half came back empty punished the client
    // for a disconnected fuel line on our side.
    expect(result.status).toBe("completed");

    // The capture itself worked — this is a data-availability hold, not a
    // tooling failure, and the message says so with real counts.
    const assembled = await durableStore.getStep(params.runId, "08-assemble-visibility-cells");
    expect(assembled?.status).toBe("completed");
    const capture = assembled?.output as { capturedCount: number; measuredCount: number; attemptedCount: number };
    expect(capture.measuredCount).toBe(0);
    expect(capture.capturedCount).toBeGreaterThan(0);
    expect(capture.capturedCount).toBe(capture.attemptedCount);

    // Everything past the old hold now runs, on honest inputs.
    for (const stepId of ["09-compute-scores", "13-draft-fixes", "14-draft-narrative", "18-persist-deliverable"]) {
      expect(await durableStore.getStep(params.runId, stepId), `${stepId} must have run`).toBeDefined();
    }

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables).toHaveLength(1);
    const report = (deliverables[0] as { data: { deliverable: Record<string, unknown> } }).data.deliverable;

    // THE LOAD-BEARING PART. The risk this guard was written for is a client
    // reading an unmeasured GEO score as a bad one, so the absent measurement
    // has to be unmissable in two independent places and the honest field has
    // to stay honest.
    expect(report["visibilityUnmeasured"]).toBe(true);
    expect(report["contentRepairs"]).toContainEqual(
      expect.objectContaining({
        check: "ai-visibility-capture",
        action: "unresolved",
        detail: expect.stringMatching(/NOT MEASURED/),
      }),
    );
    // Precision matters here, and writing this test corrected a wrong
    // assumption: GEO readiness is NOT entirely unmeasured when visibility
    // capture fails. Its other inputs — robots.txt, llms.txt, JSON-LD, the
    // on-page checks — come from the real crawl, so `measuredBasisScore` is a
    // genuine number and must stay one. What IS absent is the AI-visibility
    // index, and that is what must not be presented as a measurement.
    expect((report["geoReadiness"] as { measuredBasisScore: number | null }).measuredBasisScore).toEqual(expect.any(Number));
    const visibility = report["visibility"] as { byN: unknown; byNe: unknown };
    expect(visibility.byN ?? null).toBeNull();
    expect(visibility.byNe ?? null).toBeNull();

    // And the narrative was told not to characterise visibility at all. A
    // directive nobody receives is not a safeguard, so this asserts the prompt
    // actually carried it rather than trusting that it was wired.
    expect(seenPrompts.some((prompt) => prompt.includes("visibilityUnmeasured") && prompt.includes("NOT MEASURED"))).toBe(true);
  });

  it("proceeds normally when at least one cell is genuinely MEASURED", async () => {
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    const assembled = await durableStore.getStep(params.runId, "08-assemble-visibility-cells");
    const capture = assembled?.output as { capturedCount: number; measuredCount: number };
    expect(capture.measuredCount).toBeGreaterThan(0);
    expect(capture.measuredCount).toBe(capture.capturedCount);

    // The phases the hold would have skipped all ran, and a report exists.
    expect(await durableStore.getStep(params.runId, "09-compute-scores")).toBeDefined();
    expect(result.output.deliverableId).toBeTruthy();
  });
});
