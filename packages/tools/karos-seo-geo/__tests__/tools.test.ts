import { describe, expect, it } from "vitest";
import type { AgentContext } from "@agent-engine/core";
import { createSeoGeoScore } from "../src/score-tool.js";
import { createSeoGeoRecommend } from "../src/recommend-tool.js";

const ctx: AgentContext = {
  runId: "run_1",
  clientSlug: "acme",
  productId: "seo-geo-agent",
  runKind: "recurring",
  metadata: {},
};

describe("seoGeo.score tool", () => {
  it("returns a success outcome with 0 scores and full-partial coverage when no measurements are supplied", async () => {
    const tool = createSeoGeoScore();
    const outcome = await tool.execute({ seoMeasurements: {}, geoReadinessMeasurements: {}, hashInputs: {} } as never, { ctx });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.seoScore.score).toBe(0);
    expect(outcome.result.seoScore.partial).toBe(true);
    expect(outcome.result.hashInputsIncomplete).toBe(true);
    expect(outcome.result.visibility).toBeNull();
    expect(outcome.result.visibilityMetrics).toBeNull();
  });

  it("surfaces the KNOWN/FOUND split and the resolved denominator decision alongside the blended index", async () => {
    const tool = createSeoGeoScore();
    const outcome = await tool.execute(
      {
        seoMeasurements: {},
        geoReadinessMeasurements: {},
        hashInputs: {},
        visibility: {
          cells: [
            {
              promptId: "p1",
              engine: "chatgpt",
              captureTier: "MEASURED",
              brandMentioned: true,
              brandCited: false,
              competitorsNamed: [],
              citations: [],
              mentionCounts: { client: 1 },
              sentimentPerMention: [],
            },
          ],
          promptCount: 1,
          clientDomains: ["client.com"],
          competitorRoster: [],
          promptCohorts: { p1: "known" },
        },
      } as never,
      { ctx },
    );
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    const metrics = outcome.result.visibilityMetrics!;
    expect(metrics.denominatorDecision.status).toBe("resolved");
    expect(metrics.knownVsFound.neverBlend).toBe(true);
    expect(metrics.knownVsFound.knownPromptCount).toBe(1);
    // One answer is far below the 10-answer floor, so the tool publishes a count.
    expect(metrics.knownVsFound.known.find((r) => r.engine === "chatgpt")!.named.display).toBe("1 of 1 answers");
  });

  it("rejects malformed input as a tooling_error, not a thrown exception", async () => {
    const tool = createSeoGeoScore();
    const outcome = await tool.execute({ seoMeasurements: "not-an-object" } as never, { ctx });
    expect(outcome.status).toBe("tooling_error");
  });
});

describe("seoGeo.recommend tool", () => {
  it("returns an empty fired list when no inputs are supplied", async () => {
    const tool = createSeoGeoRecommend();
    const outcome = await tool.execute({ seoInputs: [], geoReadinessInputs: [] }, { ctx });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.fired).toEqual([]);
  });

  it("fires a rec from a merged seoInputs + geoReadinessInputs list", async () => {
    const tool = createSeoGeoRecommend();
    const outcome = await tool.execute(
      { seoInputs: [{ recId: "SEO-02", norm: 0.5, weight: 5, normalization: "ratio_clamp" }], geoReadinessInputs: [] },
      { ctx },
    );
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unreachable");
    expect(outcome.result.fired.some((f) => f.recId === "SEO-02")).toBe(true);
  });
});
