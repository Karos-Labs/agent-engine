import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { AgentContext, BaseAgentRuntime } from "@agent-engine/core";
import { SeoGeoFixDraftAgent } from "../src/agent/seo-geo-fix-draft-agent.js";
import { SeoGeoNarrativeAgent } from "../src/agent/seo-geo-narrative-agent.js";
import { fakeRouterSequence, finalTurn, makePromptStore, PROMPTS_ROOT } from "./test-helpers.js";
import { goodFixDrafts, goodNarrative } from "./test-helpers.js";

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "seo-geo-agent", runKind: "recurring", metadata: {} };

describe("PromptStore resolution (RFC-01 §16.1)", () => {
  it("resolves 'seo-geo-fix-draft@1' to the real prompts/seo-geo-fix-draft/1.md file content", async () => {
    const promptStore = makePromptStore();
    const resolved = await promptStore.getPrompt("seo-geo-fix-draft", "1");
    expect(resolved).toContain("Ground everything in what you were given");
  });

  it("resolves 'seo-geo-narrative@1' to the real prompts/seo-geo-narrative/1.md file content", async () => {
    const promptStore = makePromptStore();
    const resolved = await promptStore.getPrompt("seo-geo-narrative", "1");
    expect(resolved).toContain("never invent a number");
  });

  it("SeoGeoFixDraftAgent actually passes the resolved prompt content as the system prompt at runtime", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodFixDrafts())]);
    const runtime: BaseAgentRuntime = { router, tools: {}, promptStore };
    const agent = new SeoGeoFixDraftAgent(runtime);

    await agent.run(ctx, { firedRecommendations: [] });

    const expectedPrompt = readFileSync(path.join(PROMPTS_ROOT, "seo-geo-fix-draft", "1.md"), "utf8");
    expect(router.complete).toHaveBeenCalledWith(expect.any(String), expect.anything(), expect.anything(), expect.objectContaining({ system: expectedPrompt }));
  });

  it("SeoGeoNarrativeAgent actually passes the resolved prompt content as the system prompt at runtime", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodNarrative())]);
    const runtime: BaseAgentRuntime = { router, tools: {}, promptStore };
    const agent = new SeoGeoNarrativeAgent(runtime);

    await agent.run(ctx, { seoScore: 0 });

    const expectedPrompt = readFileSync(path.join(PROMPTS_ROOT, "seo-geo-narrative", "1.md"), "utf8");
    expect(router.complete).toHaveBeenCalledWith(expect.any(String), expect.anything(), expect.anything(), expect.objectContaining({ system: expectedPrompt }));
  });
});
