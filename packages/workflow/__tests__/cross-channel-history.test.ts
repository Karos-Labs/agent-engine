import { describe, expect, it } from "vitest";
import type { AgentContext, AgentTool, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "../src/index.js";
import { crossChannelAvoidTopics, crossChannelDirective, readCrossChannelHistory, socialAccountsFromClient } from "../src/index.js";

/**
 * The cross-channel memory (2026-09): what the client already said on every
 * channel and on their own accounts, as one dedupe corpus and one directive.
 */

const ctx: AgentContext = { runId: "run_now", clientSlug: "acme", productId: "x-agent", runKind: "recurring", metadata: {} };

function fakeTool(name: string, handler: (args: unknown) => unknown): AgentTool {
  return { name, version: "1.0.0", inputSchema: { parse: (v: unknown) => v } as never, async execute(args: unknown) { return handler(args) as never; } } as unknown as AgentTool;
}

describe("socialAccountsFromClient", () => {
  it("folds the configured handles and explicit accounts into one de-duplicated list, stripping @ and URLs", () => {
    const accounts = socialAccountsFromClient(
      { xHandle: "@acmehq", socialAccounts: [{ platform: "x", username: "AcmeHQ" }, { platform: "tiktok", username: "acme.tok" }, { platform: "linkedin", username: "ignored" }] },
      { handle: "https://instagram.com/acme.gram/" },
    );
    expect(accounts).toEqual([
      { platform: "x", username: "AcmeHQ" },
      { platform: "tiktok", username: "acme.tok" },
      { platform: "instagram", username: "acme.gram" },
    ]);
    expect(socialAccountsFromClient(undefined, undefined)).toEqual([]);
  });
});

describe("readCrossChannelHistory", () => {
  it("reads every channel's ledger plus the client's own posts, labels the channel, and never fails on a missing source", async () => {
    const asked: string[] = [];
    const tools: AgentToolRegistry = {
      "ledger.listOutputExcerpts": fakeTool("ledger.listOutputExcerpts", (args) => {
        const { agentId, excludeRunId } = args as { agentId: string; excludeRunId?: string };
        asked.push(agentId);
        expect(excludeRunId).toBe("run_now");
        if (agentId === "linkedin-agent") return { status: "success", result: { entries: [{ runId: "li-1", excerpt: "Anchor days cut scheduling friction.\n\nWe looked at attendance data.", recordedAt: 1_788_500_000_000 }] } };
        if (agentId === "x-agent") return { status: "success", result: { entries: [{ runId: "x-1", excerpt: "Four-day weeks are spreading.", recordedAt: 1_788_650_000_000 }] } };
        return { status: "success", result: { entries: [] } };
      }),
      "research.socialHistory": fakeTool("research.socialHistory", () => ({
        status: "success",
        result: { posts: [{ platform: "x", username: "acmehq", url: "https://x.com/acmehq/status/9", excerpt: "We just launched anchor-day scheduling.", publishedAt: "2026-09-05T09:00:00.000Z" }], problems: ["could not read instagram/@acme: 404"] },
      })),
    };
    const store = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(store).run(
      async (wf) => readCrossChannelHistory(wf, tools, ctx, { stepId: "h", socialAccounts: [{ platform: "x", username: "acmehq" }, { platform: "instagram", username: "acme" }] }),
      { runId: "run_now", clientSlug: "acme", productId: "x-agent", runKind: "recurring" },
    );
    if (result.status !== "completed") throw new Error(result.status);
    const history = result.output as Awaited<ReturnType<typeof readCrossChannelHistory>>;
    // Every channel agent was asked, not only the running one.
    expect(asked).toContain("linkedin-agent");
    expect(asked).toContain("instagram-agent");
    expect(asked).toContain("newsletter-agent");
    expect(history.entries.map((e) => `${e.origin}:${e.channel}:${e.runId}`)).toEqual(["ledger:x-agent:x-1", "ledger:linkedin-agent:li-1", "social:x:social:x:https://x.com/acmehq/status/9"]);
    expect(history.notes).toEqual(["could not read instagram/@acme: 404"]);

    const directive = crossChannelDirective(history)!;
    expect(directive).toContain("across EVERY channel");
    expect(directive).toContain("[LinkedIn (drafted by us) · 2026-09-04]");
    expect(directive).toContain("[X (the client's own account) · 2026-09-05]");
    expect(crossChannelAvoidTopics(history)).toEqual(["Four-day weeks are spreading.", "Anchor days cut scheduling friction.", "We just launched anchor-day scheduling."]);
  });

  it("degrades to notes when the tools are missing, and to an undefined directive when the memory is empty", async () => {
    const store = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(store).run(
      async (wf) => readCrossChannelHistory(wf, {}, ctx, { stepId: "h", socialAccounts: [{ platform: "x", username: "acmehq" }] }),
      { runId: "run_now", clientSlug: "acme", productId: "x-agent", runKind: "recurring" },
    );
    if (result.status !== "completed") throw new Error(result.status);
    const history = result.output as Awaited<ReturnType<typeof readCrossChannelHistory>>;
    expect(history.entries).toEqual([]);
    expect(history.notes).toHaveLength(2);
    expect(crossChannelDirective(history)).toBeUndefined();
  });
});
