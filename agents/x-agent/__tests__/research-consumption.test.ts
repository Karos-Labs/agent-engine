import { describe, expect, it } from "vitest";
import type { AgentTool } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createXAgentWorkflow } from "../src/workflow/create-x-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * Step 05 must actually consume the research step 04 fetched.
 *
 * It used to return the *query* as the candidate topic, correctly, because
 * `research.pull` was a stand-in with nothing to extract. That stopped being
 * true when the scraper landed, and the cost of the stale assumption was
 * measured in prep run pubsub-20272693789971486: four real current sources
 * fetched in 5.9 billed seconds, then a draft
 * ("Most AI marketing output passes the readability check and fails the buyer
 * test") that mentioned none of them. The engine paid for research and threw it
 * away.
 */

const params = { runId: "x_research_consumption", clientSlug: "acme", productId: "x-agent", runKind: "recurring" as const };

/** A `research.pull` stand-in returning a payload in the real tool's shape. */
function stubResearchPull(documents: unknown[], onCall?: (args: Record<string, unknown>) => void): AgentTool {
  return {
    name: "research.pull",
    version: "1.1.0",
    inputSchema: { parse: (v: unknown) => v } as never,
    async execute(args: unknown) {
      onCall?.(args as Record<string, unknown>);
      return {
        status: "success",
        result: {
          runId: "run-1",
          query: "acme trends this week",
          fromCache: false,
          result: { provider: "scrappycoco", documents },
        },
      };
    },
  } as unknown as AgentTool;
}

async function runWith(env: TestEnvironment, research: AgentTool) {
  const router = fakeRouterSequence([
    finalTurn({
      text: "A clean post about the thing.",
      mainPostText: "A clean post about the thing.",
      hook: "A clean post about the thing.",
      angle: "trend-observation",
      lane: "news-reaction",
      targetHandle: "@acme",
      mediaRefs: [],
    }),
  ]);
  const store = new MemoryDurableStepStore();
  const workflowFn = createXAgentWorkflow({
    tools: { ...env.tools, "research.pull": research },
    promptStore: makePromptStore(),
    router,
    autoApprove: true,
  });
  await new WorkflowEngine(store).run(workflowFn, params);
  const steps = await store.listSteps(params.runId);
  const summary = steps.find((s) => s.stepId === "05-extract-candidate-summary");
  return summary?.output as { candidateTopic?: string; hasNumericInsight: boolean; sourceLabel: string } | undefined;
}

describe("x-agent step 05 consumes real research", () => {
  let env: TestEnvironment;

  it("takes its candidate topic from a source headline, and cites that source's URL", async () => {
    env = await setupTestEnvironment();
    try {
      const summary = await runWith(
        env,
        stubResearchPull([
          { title: "August spam update lands globally", url: "https://example.test/spam-update", content: "Rolling out now across all regions." },
        ]),
      );

      expect(summary?.candidateTopic).toBe("August spam update lands globally");
      // The URL, not an opaque run id: a downstream claim has to cite
      // something a reader can open.
      expect(summary?.sourceLabel).toBe("https://example.test/spam-update");
    } finally {
      await env.cleanup();
    }
  });

  it("prefers a source whose text carries numbers, since the numbers gate rewards a sourced figure", async () => {
    env = await setupTestEnvironment();
    try {
      const summary = await runWith(
        env,
        stubResearchPull([
          { title: "No figures here", url: "https://example.test/a", content: "Purely qualitative commentary." },
          { title: "Ads reach thirty one countries", url: "https://example.test/b", content: "Now live in 31 European countries." },
        ]),
      );

      expect(summary?.candidateTopic).toBe("Ads reach thirty one countries");
      expect(summary?.hasNumericInsight).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it("falls back to the query, clearly labelled, when the search honestly returned nothing", async () => {
    env = await setupTestEnvironment();
    try {
      const summary = await runWith(env, stubResearchPull([]));

      // No invention: the same conservative behaviour as before the scraper
      // existed, and it says so rather than looking like a real source.
      expect(summary?.candidateTopic).toBe("acme trends this week");
      expect(summary?.hasNumericInsight).toBe(false);
      expect(summary?.sourceLabel).toContain("no external sources returned");
    } finally {
      await env.cleanup();
    }
  });

  it("asks research.pull for this agent's own history, so drafting can avoid repeating itself", async () => {
    env = await setupTestEnvironment();
    try {
      let seen: Record<string, unknown> | undefined;
      await runWith(
        env,
        stubResearchPull([{ title: "T", url: "https://example.test/t" }], (args) => {
          seen = args;
        }),
      );

      expect(seen?.["historyAgentId"]).toBe("x-agent");
      expect(seen?.["job"]).toBe("x-news-scan");
    } finally {
      await env.cleanup();
    }
  });
});
