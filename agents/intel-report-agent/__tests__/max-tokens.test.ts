import { describe, expect, it, vi } from "vitest";
import type { AgentContext, BaseAgentRuntime, CompletionResult, ModelRouter, RouterCompleteOptions } from "@agent-engine/core";
import { DIMENSION_KEYS, type IntelReportOutput } from "@agent-engine/tool-karos-intel";
import { IntelReportDraftAgent } from "../src/agent/intel-report-draft-agent.js";

// SCRUM-291 (AU14): "no agent in the fleet sets maxTokens" was true on
// unmodified code — this fails against `git stash` / main and passes once
// `IntelReportDraftAgent.config.maxTokens` is set. It asserts on the actual
// 3rd argument `router.complete()` receives, not on the static config field,
// so a maxTokens that's set but never threaded through to the model call
// would still fail this test. intel-report is the ticket's #1 named risk, so
// this also pins its ceiling above the other two named agents.

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "intel-report-agent", runKind: "recurring", metadata: {} };

const goodDraft: IntelReportOutput = {
  dimensionScores: DIMENSION_KEYS.map((dimension) => ({ dimension, score: 50 })),
  contentAnalysis: "a",
  conversionAnalysis: "a",
  seoAnalysis: "a",
  geoAnalysis: "a",
  positioningAnalysis: "a",
  brandAnalysis: "a",
  growthAnalysis: "a",
  swot: {
    strengths: ["s1", "s2", "s3", "s4"],
    weaknesses: ["w1", "w2", "w3", "w4"],
    opportunities: ["o1", "o2", "o3"],
    threats: ["t1", "t2", "t3"],
  },
  recommendations: [],
  competitorRankings: [],
  competitors: [],
  brandSynchronizationUpdate: "u",
};

function fakeRouter(): { router: ModelRouter; complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(
    async (): Promise<CompletionResult<unknown>> => ({
      output: { type: "final", output: goodDraft },
      modelUsed: "claude-sonnet-4-6",
      inputTokens: { cached: 0, uncached: 100 },
      outputTokens: 20,
    }),
  );
  return {
    complete,
    router: {
      complete,
      completeAlias: vi.fn(async () => {
        throw new Error("not used in this test");
      }),
    } as unknown as ModelRouter,
  };
}

describe("IntelReportDraftAgent maxTokens", () => {
  it("passes an explicit maxTokens through to the model call, sized above the adapter's 16,384 default", async () => {
    const { router, complete } = fakeRouter();
    const runtime: BaseAgentRuntime = { router, tools: {} };
    const agent = new IntelReportDraftAgent(runtime);

    const result = await agent.run(ctx, {});

    expect(result.status).toBe("completed");
    expect(complete).toHaveBeenCalledTimes(1);
    const opts = complete.mock.calls[0]![3] as RouterCompleteOptions | undefined;
    expect(opts?.maxTokens).toBeDefined();
    expect(opts?.maxTokens).toBeGreaterThan(16_384);
  });
});
