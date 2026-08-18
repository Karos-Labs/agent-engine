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
