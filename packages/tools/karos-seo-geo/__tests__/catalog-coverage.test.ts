import { describe, expect, it } from "vitest";
import { GEO_READINESS_BUCKETS, SEO_BUCKETS } from "../src/scoring-config.js";
import { computeCatalogCoverage, evaluateRecommendations, groupInputsByRecId } from "../src/recommend.js";
import { scoringConfigData } from "../src/config/scoring-config.data.js";

/**
 * SCRUM-318 (AU27) asks for the agent-engine rec catalog — which predates
 * v2 — to be diffed and reconciled against v2's. That comparison could NOT
 * be made here: `Karos-Labs/karos-agents` is unreachable from this
 * environment, so v2's catalog is unavailable and no reconciliation is
 * claimed. What is measurable without it is the catalog's coverage against
 * this repo's own scoring config, which is the precondition the reconcile
 * would work from — and it surfaces a real gap.
 */

describe("rec-catalog vs scoring-config coverage (SCRUM-318's reconcile item, as far as it can be taken here)", () => {
  const scoredRecIds = [
    ...SEO_BUCKETS.flatMap((b) => b.inputs.map((i) => i.recId)),
    ...GEO_READINESS_BUCKETS.flatMap((b) => b.inputs.map((i) => i.recId)),
    ...(scoringConfigData.visibility.metrics as ReadonlyArray<{ id: string }>).map((m) => m.id),
  ];
  const coverage = computeCatalogCoverage(scoredRecIds);

  it("every rec_id the scoring config scores exists in the catalog (else it is scored then silently dropped)", () => {
    expect(coverage.uncatalogedScoredRecIds).toEqual([]);
  });

  it("records how many catalog recs are structurally unfirable, so the gap cannot drift unnoticed", () => {
    // Not an endorsement: `evaluateRecommendations` skips any rec with no scored
    // instance, so each of these is a recommendation the engine CANNOT make whatever a
    // run measures. Reconciling them needs v2's catalog, which is unreachable from this
    // environment — so this pins the current number as a baseline for SCRUM-319/320.
    // If someone wires one up (or drops one), this fails and forces the count updated.
    expect(coverage.catalogRecIds).toHaveLength(75);
    expect(coverage.unscoredCatalogRecIds).toHaveLength(28);
    expect(coverage.unscoredCatalogRecIds).toContain("SEO-01");
  });

  it("the recs that ARE scored can actually fire — the catalog is not inert end to end", () => {
    // Guards the inverse defect: a coverage report is worthless if nothing fires at all.
    const fired = evaluateRecommendations(
      groupInputsByRecId(
        SEO_BUCKETS.flatMap((b) => b.inputs.map((i) => ({ recId: i.recId, norm: 0, weight: i.weight, normalization: i.params.normalization }))),
      ),
    );
    expect(fired.length).toBeGreaterThan(0);
    expect(fired.every((f) => coverage.catalogRecIds.includes(f.recId))).toBe(true);
  });
});
