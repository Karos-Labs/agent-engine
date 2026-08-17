import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { z } from "zod";
import { MockAgent, type AgentContext, type BaseAgentRuntime } from "@agent-engine/core";
import { RedditDraftAgent } from "../src/agent/reddit-draft-agent.js";
import { fakeRouterSequence, finalTurn, makePromptStore, PROMPTS_ROOT } from "./test-helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.join(HERE, "..", "src");

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "reddit-agent", runKind: "recurring", metadata: {} };

function sampleDraft() {
  const replyBody = "A reply.";
  return {
    targetThreadUrl: "https://www.reddit.com/r/smallbusiness/comments/abc123/a_thread/",
    targetThreadTitle: "A thread",
    replyBody,
    targetSubreddit: "smallbusiness",
    disclosureIncluded: false,
    text: replyBody,
  };
}

describe("PromptStore resolution (RFC-01 §16.1)", () => {
  it("resolves 'reddit-craft@2' to the real prompts/reddit-craft/2.md file content", async () => {
    const promptStore = makePromptStore();
    const resolved = await promptStore.getPrompt("reddit-craft", "2");
    expect(resolved).toContain("Comments only, never original posts");
    expect(resolved).toContain("four answer shapes");
  });

  it("resolves 'reddit-craft' (no version) to prompts/reddit-craft/latest.md", async () => {
    const promptStore = makePromptStore();
    const resolved = await promptStore.getPrompt("reddit-craft");
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("RedditDraftAgent actually passes the resolved prompt content as the system prompt at runtime", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(sampleDraft())]);
    const runtime: BaseAgentRuntime = { router, tools: {}, promptStore };
    const agent = new RedditDraftAgent(runtime);

    await agent.run(ctx, {});

    const expectedPrompt = readFileSync(path.join(PROMPTS_ROOT, "reddit-craft", "2.md"), "utf8");
    expect(router.complete).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ system: expectedPrompt }),
    );
  });

  it("produces tooling_error, not a crash, when skillRef names a prompt the store doesn't have", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused" })]);
    const runtime: BaseAgentRuntime = { router, tools: {}, promptStore };
    const agent = new MockAgent(runtime, {
      id: "broken-skill-probe",
      description: "probe",
      allowedTools: [],
      outputSchema: z.object({ text: z.string() }),
      modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
      skillRef: "does-not-exist@99",
    });
    const result = await agent.run(ctx, {});
    expect(result.status).toBe("tooling_error");
  });
});

describe("zero hardcoded prompts (RFC-01 §16.1)", () => {
  function listTsFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...listTsFiles(full));
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
    return files;
  }

  // Distinctive phrases from prompts/reddit-craft/2.md — if any of these appear
  // in TypeScript source, the craft content has been duplicated as a literal
  // instead of living only in the markdown file resolved via PromptStore.
  const CRAFT_CONTENT_MARKERS = [
    "Redditors can tell a marketing reply from a real one within a sentence",
    "That was wrong. A thread to reply to has already been selected for you",
    "never invent a plausible-sounding statistic",
    "No competitor names, ever, even neutrally.",
  ];

  it("sanity check: the markers really do appear in the prompt file (so the negative check below is meaningful)", () => {
    const promptContent = readFileSync(path.join(PROMPTS_ROOT, "reddit-craft", "2.md"), "utf8");
    for (const marker of CRAFT_CONTENT_MARKERS) {
      expect(promptContent.includes(marker), `expected "${marker}" to actually be in reddit-craft/2.md`).toBe(true);
    }
  });

  it("contains no literal craft-content strings anywhere in src/", () => {
    const sourceFiles = listTsFiles(SRC_ROOT);
    expect(sourceFiles.length).toBeGreaterThan(0);

    for (const file of sourceFiles) {
      const content = readFileSync(file, "utf8");
      for (const marker of CRAFT_CONTENT_MARKERS) {
        expect(content.includes(marker), `${file} appears to embed craft content ("${marker}") as a literal`).toBe(false);
      }
    }
  });

  it("RedditDraftAgent's config carries a skillRef, not an inline system prompt field", () => {
    const configSource = readFileSync(path.join(SRC_ROOT, "agent", "reddit-draft-agent.ts"), "utf8");
    expect(configSource).toMatch(/skillRef:\s*"reddit-craft@2"/);
  });
});
