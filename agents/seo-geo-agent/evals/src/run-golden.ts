import { MemoryDurableStepStore, WorkflowEngine, type WorkflowRunResult } from "@agent-engine/workflow";
import { createSeoGeoAgentWorkflow } from "../../src/workflow/create-seo-geo-agent-workflow.js";
import type { SeoGeoAgentWorkflowResult, SeoGeoReport } from "../../src/workflow/types.js";
import {
  goodFixDrafts,
  goodNarrative,
  makePromptStore,
  setupTestEnvironment,
  smartFakeRouter,
  withMeasuredCapture,
} from "../../__tests__/test-helpers.js";

export interface SeoGeoGoldenRunOutcome {
  result: WorkflowRunResult<SeoGeoAgentWorkflowResult>;
  report: SeoGeoReport | null;
  cleanup: () => Promise<void>;
}

/**
 * Runs the full 9-phase SEO & GEO workflow end-to-end, both human gates
 * auto-approved, against a freshly-seeded temp `WorkspaceStore` — the
 * "golden run" this package's eval suite asserts against (see `types.ts`'s
 * header comment for why this is a structural, not numeric-reproduction,
 * golden run).
 *
 * Visibility capture is faked to MEASURED (`withMeasuredCapture`) because the
 * real `research.captureVisibility` has no capture adapter and returns
 * `UNAVAILABLE` for every cell, which the workflow now correctly refuses to
 * score or deliver a report from (AU26 / SCRUM-292). A golden run that held at
 * step 08a would assert nothing about the seven phases after it. The technical
 * measurements are deliberately left unavailable, so this stays a structural
 * golden run — the SEO/GEO readiness scores are still honestly 0.
 */
export async function runSeoGeoGoldenRun(): Promise<SeoGeoGoldenRunOutcome> {
  const env = await setupTestEnvironment();
  const promptStore = makePromptStore();
  const router = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
  const workflowFn = createSeoGeoAgentWorkflow({ tools: withMeasuredCapture(env.tools), promptStore, router, autoApprove: true });

  const durableStore = new MemoryDurableStepStore();
  const engine = new WorkflowEngine(durableStore);
  const params = { runId: "seo_geo_golden_run", clientSlug: "acme", productId: "seo-geo-agent", runKind: "setup" as const };
  const result = await engine.run(workflowFn, params);

  let report: SeoGeoReport | null = null;
  if (result.status === "completed") {
    const stored = await env.store.readJson<{ deliverable: SeoGeoReport }>("acme", [
      "ledger",
      "deliverables",
      params.runId,
      "_",
      "seo-geo-report",
    ]);
    report = stored?.deliverable ?? null;
  }

  return { result, report, cleanup: env.cleanup };
}
