import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentContext, AgentToolRegistry, BaseAgentRuntime, CompletionResult, ModelRouter, RouterCompleteOptions } from "@agent-engine/core";
import { NewsletterDraftAgent, type NewsletterPostOutput } from "../src/agent/newsletter-draft-agent.js";

// SCRUM-291 (AU14): "no agent in the fleet sets maxTokens" was true on
// unmodified code — this fails against `git stash` / main and passes once
// `NewsletterDraftAgent.config.maxTokens` is set. It asserts on the actual
// 4th argument `router.complete()` receives, not on the static config field,
// so a maxTokens that's set but never threaded through to the model call
// would still fail this test.

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "newsletter-agent", runKind: "recurring", metadata: {} };

const goodDraft: NewsletterPostOutput = {
  subjectLine: "s",
  previewText: "p",
  intro: "i",
  sections: [{ heading: "h", body: "b" }],
  callToAction: { text: "c", url: "https://example.com" },
  signoff: "sign",
  text: "t",
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

/** `NewsletterDraftAgent.config.selfCritique` runs `gate.lintPost` after the draft turn — stub it as a pass so the run completes end-to-end. */
function passingGateTools(): AgentToolRegistry {
  return {
    "gate.lintPost": {
      name: "gate.lintPost",
      // Required since SCRUM-293 (AU7) — every tool carries a description the model reads.
      description: "Test stub for the post lint gate: always passes.",
      version: "test",
      inputSchema: z.unknown(),
      execute: async () => ({ status: "success", result: { verdict: "pass", evidence: [], toolVersion: "test" } }),
    },
  };
}

describe("NewsletterDraftAgent maxTokens", () => {
  it("passes an explicit maxTokens through to the model call, sized above the adapter's 16,384 default", async () => {
    const { router, complete } = fakeRouter();
    const runtime: BaseAgentRuntime = { router, tools: passingGateTools() };
    const agent = new NewsletterDraftAgent(runtime);

    const result = await agent.run(ctx, {});

    expect(result.status).toBe("completed");
    expect(complete).toHaveBeenCalledTimes(1);
    const opts = complete.mock.calls[0]![3] as RouterCompleteOptions | undefined;
    expect(opts?.maxTokens).toBeDefined();
    expect(opts?.maxTokens).toBeGreaterThan(16_384);
  });
});
