import { describe, expect, it } from "vitest";
import { runSeoGeoGoldenRun } from "./src/run-golden.js";

describe("SEO & GEO agent golden run — structural assertions (RFC-01 §12 / RFC-04 §7)", () => {
  it("runs the full 9-phase workflow end-to-end (autoApprove: true) and resolves to completed", async () => {
    const outcome = await runSeoGeoGoldenRun();
    try {
      expect(outcome.result.status).toBe("completed");
    } finally {
      await outcome.cleanup();
    }
  });

  it("the persisted report carries every RFC-04 §4 gated decision as a typed, visible field", async () => {
    const outcome = await runSeoGeoGoldenRun();
    try {
      expect(outcome.report).not.toBeNull();
      const report = outcome.report!;

      expect(report.visibility.denominatorDecision.status).toBe("pending");
      expect(report.geoScoreModel.computed).toBe(false);
      expect(report.connectorOverlay.connectors.every((c) => !c.connected)).toBe(true);
      expect(report.connectorOverlay.pendingConfigEdit.status).toBe("GATED_NOT_APPLIED");
      expect(report.reproducibility.hashInputsIncomplete).toBe(true);
    } finally {
      await outcome.cleanup();
    }
  });

  it("is deterministic given the same seeded environment: two independent golden runs score identically", async () => {
    const first = await runSeoGeoGoldenRun();
    const second = await runSeoGeoGoldenRun();
    try {
      expect(first.result.status).toBe("completed");
      expect(second.result.status).toBe("completed");
      if (first.result.status !== "completed" || second.result.status !== "completed") throw new Error("unreachable");
      expect(second.result.output.seoScore).toBe(first.result.output.seoScore);
      expect(second.result.output.geoReadinessScore).toBe(first.result.output.geoReadinessScore);
      expect(second.report?.promptSet.promptSetHash).toBe(first.report?.promptSet.promptSetHash);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  it("catches a regression: report assembly must never silently drop the connectors-config-edits.txt reference", async () => {
    const outcome = await runSeoGeoGoldenRun();
    try {
      const note = outcome.report?.connectorOverlay.pendingConfigEdit.note ?? "";
      expect(note).toMatch(/Daniel/);
      expect(outcome.report?.connectorOverlay.pendingConfigEdit.file).toBe("seo-geo-connectors-config-edits.txt");
    } finally {
      await outcome.cleanup();
    }
  });
});
