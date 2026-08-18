import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createSeoGeoAgentWorkflow } from "../src/workflow/create-seo-geo-agent-workflow.js";
import type { SeoGeoReport } from "../src/workflow/types.js";
import { goodFixDrafts, goodNarrative, makePromptStore, setupTestEnvironment, smartFakeRouter, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "seo_geo_run_gated", clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring" as const };

/**
 * RFC-04 §4 lists four decisions this migration must carry forward as
 * explicit, visible, typed state rather than silently resolving: the N vs
 * N_e visibility denominator, `geo_score_model`'s PROPOSED weights, the
 * GSC-credential-gated connectors, and `seo-geo-connectors-config-edits.txt`'s
 * NOT-applied edit. This suite asserts each one actually lands on the
 * persisted report, not just that the run completes.
 */
describe("RFC-04 §4 gated decisions are surfaced, never silently resolved", () => {
  let env: TestEnvironment;
  let report: SeoGeoReport;

  beforeEach(async () => {
    env = await setupTestEnvironment();
    const promptStore = makePromptStore();
    const router = smartFakeRouter([goodFixDrafts(), goodNarrative()]);
    const workflowFn = createSeoGeoAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);
    expect(result.status).toBe("completed");

    const stored = await env.store.readJson<{ deliverable: SeoGeoReport }>("acme", ["ledger", "deliverables", params.runId, "_", "seo-geo-report"]);
    report = stored!.deliverable;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("surfaces the N vs N_e visibility denominator as pending, with both values computed", () => {
    expect(report.visibility.denominatorDecision.status).toBe("pending");
    expect(report.visibility.denominatorDecision.blockingOn).toMatch(/Daniel/);
    expect(report.visibility.denominatorDecision.defaultUsedForCanonicalScore).toBe("N");
    // Both frozen from the exact same capture-cell blob — neither recomputed from scratch.
    expect(report.visibility.byN).not.toBeNull();
    expect(report.visibility.byNe).not.toBeNull();
  });

  it("surfaces geo_score_model as a PROPOSED, not-computed diagnostic", () => {
    expect(report.geoScoreModel.computed).toBe(false);
    expect(report.geoScoreModel.weightsStatus.toLowerCase()).toContain("propos");
    expect(report.geoScoreModel.note).toMatch(/Ines/);
  });

  it("reports every Google connector as not connected, never a fabricated first-party number", () => {
    expect(report.connectorOverlay.connectors.length).toBeGreaterThan(0);
    for (const connector of report.connectorOverlay.connectors) {
      expect(connector.connected).toBe(false);
      expect(connector.reason).toMatch(/not connected/i);
    }
    expect(report.connectorOverlay.sourceLadder).toContain("UNAVAILABLE");
  });

  it("references seo-geo-connectors-config-edits.txt as GATED and NOT applied", () => {
    expect(report.connectorOverlay.pendingConfigEdit.file).toBe("seo-geo-connectors-config-edits.txt");
    expect(report.connectorOverlay.pendingConfigEdit.status).toBe("GATED_NOT_APPLIED");
    expect(report.connectorOverlay.pendingConfigEdit.note).toMatch(/Daniel/);
  });

  it("honestly reports the reproducibility snapshot as incomplete (Phase 1 stand-in — no crawler/classifier/connector data)", () => {
    expect(report.reproducibility.hashInputsIncomplete).toBe(true);
    expect(report.reproducibility.missingHashInputs.length).toBeGreaterThan(0);
    expect(report.reproducibility.missingHashInputs).toEqual(
      expect.arrayContaining(["backlink_export_date", "ner_model_id", "classifier_model_id", "reviews_snapshot_hash", "entity_snapshot_hash"]),
    );
    expect(report.reproducibility.inputsDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
