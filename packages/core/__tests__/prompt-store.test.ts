import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import {
  FilePromptStore,
  InMemoryPromptStore,
  MockAgent,
  parseSkillRef,
  type AgentContext,
  type AgentStepConfig,
  type BaseAgentRuntime,
  type CompletionResult,
  type ModelRouter,
} from "../src/index.js";

const ctx: AgentContext = {
  runId: "run_1",
  clientSlug: "acme",
  productId: "linkedin",
  runKind: "recurring",
  metadata: {},
};

describe("parseSkillRef", () => {
  it("splits promptId@version", () => {
    expect(parseSkillRef("linkedin-voice@3")).toEqual({ promptId: "linkedin-voice", version: "3" });
  });

  it("leaves version undefined when skillRef names only an id", () => {
    expect(parseSkillRef("linkedin-voice")).toEqual({ promptId: "linkedin-voice" });
  });
});

describe("InMemoryPromptStore", () => {
  it("resolves the most recently set version as latest when no version is requested", async () => {
    const store = new InMemoryPromptStore();
    store.setPrompt("linkedin-voice", "1", "v1 content");
    store.setPrompt("linkedin-voice", "2", "v2 content");

    expect(await store.getPrompt("linkedin-voice")).toBe("v2 content");
  });

  it("resolves a specific version when requested", async () => {
    const store = new InMemoryPromptStore();
    store.setPrompt("linkedin-voice", "1", "v1 content");
    store.setPrompt("linkedin-voice", "2", "v2 content");

    expect(await store.getPrompt("linkedin-voice", "1")).toBe("v1 content");
  });

  it("throws for an unregistered promptId", async () => {
    const store = new InMemoryPromptStore();
    await expect(store.getPrompt("nope")).rejects.toThrow(/no prompt registered/);
  });

  it("throws for a registered promptId but unknown version", async () => {
    const store = new InMemoryPromptStore();
    store.setPrompt("linkedin-voice", "1", "v1 content");
    await expect(store.getPrompt("linkedin-voice", "99")).rejects.toThrow(/no version "99"/);
  });
});

describe("FilePromptStore", () => {
  let rootDir: string;
  let store: FilePromptStore;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-store-"));
    store = new FilePromptStore(rootDir);
    await fs.mkdir(path.join(rootDir, "linkedin-voice"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "linkedin-voice", "latest.md"), "latest content", "utf8");
    await fs.writeFile(path.join(rootDir, "linkedin-voice", "1.md"), "v1 content", "utf8");
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("reads latest.md when no version is requested", async () => {
    expect(await store.getPrompt("linkedin-voice")).toBe("latest content");
  });

  it("reads <version>.md when a version is requested", async () => {
    expect(await store.getPrompt("linkedin-voice", "1")).toBe("v1 content");
  });

  it("throws a clear error for a missing prompt", async () => {
    await expect(store.getPrompt("nonexistent")).rejects.toThrow(/no prompt found for "nonexistent" \(latest\)/);
  });

  it("throws a clear error for a missing version", async () => {
    await expect(store.getPrompt("linkedin-voice", "99")).rejects.toThrow(/no prompt found for "linkedin-voice@99"/);
  });

  it("rejects a path-traversal promptId", async () => {
    await expect(store.getPrompt("../../etc/passwd")).rejects.toThrow(/invalid path segment/);
  });
});

describe("BaseAgent resolves skillRef through runtime.promptStore", () => {
  const OutputSchema = z.object({ body: z.string() });

  function fakeRouter(): { router: ModelRouter; complete: ReturnType<typeof vi.fn> } {
    const complete = vi.fn(
      async (): Promise<CompletionResult<unknown>> => ({
        output: { type: "final", output: { body: "hello" } },
        modelUsed: "claude-sonnet-4-6",
        inputTokens: { cached: 0, uncached: 50 },
        outputTokens: 10,
      }),
    );
    return { router: { complete, completeAlias: vi.fn() } as unknown as ModelRouter, complete };
  }

  function makeConfig(overrides: Partial<AgentStepConfig<{ body: string }>> = {}): AgentStepConfig<{ body: string }> {
    return {
      id: "draft",
      description: "draft",
      allowedTools: [],
      outputSchema: OutputSchema,
      modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
      ...overrides,
    };
  }

  // SCRUM-298: `system` now always carries the response contract too (see
  // `buildSystemPromptWithContract`), appended after the loaded skill body —
  // so these assert the skill content is present at the front of `system`,
  // not that `system` equals it exactly.
  it("passes the resolved prompt content as the system prompt when skillRef and promptStore are both set", async () => {
    const { router, complete } = fakeRouter();
    const promptStore = new InMemoryPromptStore();
    promptStore.setPrompt("linkedin-voice", "3", "Always confident, never jargon.");

    const runtime: BaseAgentRuntime = { router, tools: {}, promptStore };
    const agent = new MockAgent(runtime, makeConfig({ skillRef: "linkedin-voice@3" }));
    await agent.run(ctx, {});

    const [, , , opts] = complete.mock.calls[0]!;
    expect((opts as { system: string }).system).toMatch(/^Always confident, never jargon\.\n\n/);
  });

  it("resolves to the store's latest version when skillRef names only an id", async () => {
    const { router, complete } = fakeRouter();
    const promptStore = new InMemoryPromptStore();
    promptStore.setPrompt("linkedin-voice", "1", "v1");
    promptStore.setPrompt("linkedin-voice", "2", "v2 latest");

    const runtime: BaseAgentRuntime = { router, tools: {}, promptStore };
    const agent = new MockAgent(runtime, makeConfig({ skillRef: "linkedin-voice" }));
    await agent.run(ctx, {});

    const [, , , opts] = complete.mock.calls[0]!;
    expect((opts as { system: string }).system).toMatch(/^v2 latest\n\n/);
  });

  it("system carries only the response contract (no skill body) when skillRef is set but no promptStore is configured", async () => {
    const { router, complete } = fakeRouter();
    const runtime: BaseAgentRuntime = { router, tools: {} };
    const agent = new MockAgent(runtime, makeConfig({ skillRef: "linkedin-voice" }));
    const result = await agent.run(ctx, {});

    expect(result.status).toBe("completed");
    const [, , , opts] = complete.mock.calls[0]!;
    expect((opts as { system: string }).system).toContain("responseContract");
    expect((opts as { system: string }).system.startsWith("{")).toBe(true);
  });

  it("system carries only the response contract (no skill body) when no skillRef is set, even with a promptStore configured", async () => {
    const { router, complete } = fakeRouter();
    const promptStore = new InMemoryPromptStore();
    promptStore.setPrompt("linkedin-voice", "1", "should never be used");

    const runtime: BaseAgentRuntime = { router, tools: {}, promptStore };
    const agent = new MockAgent(runtime, makeConfig());
    await agent.run(ctx, {});

    const [, , , opts] = complete.mock.calls[0]!;
    expect((opts as { system: string }).system).not.toContain("should never be used");
    expect((opts as { system: string }).system).toContain("responseContract");
  });

  it("resolves to tooling_error when skillRef names a prompt the store doesn't have", async () => {
    const { router } = fakeRouter();
    const promptStore = new InMemoryPromptStore();

    const runtime: BaseAgentRuntime = { router, tools: {}, promptStore };
    const agent = new MockAgent(runtime, makeConfig({ skillRef: "does-not-exist" }));
    const result = await agent.run(ctx, {});

    expect(result.status).toBe("tooling_error");
  });
});
