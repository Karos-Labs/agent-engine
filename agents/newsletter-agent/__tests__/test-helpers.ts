import { vi } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { FilePromptStore, type AgentContext, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import { createAllKarosTools, WorkspaceStore } from "@agent-engine/tools";
import { createOfflineScraper } from "@agent-engine/tool-karos-scraper";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROMPTS_ROOT = path.join(HERE, "..", "prompts");

export function makePromptStore(): FilePromptStore {
  return new FilePromptStore(PROMPTS_ROOT);
}

/** A router whose `.complete()` replays a fixed sequence of turns in order. */
export function fakeRouterSequence(turns: Array<() => CompletionResult<unknown>>): ModelRouter {
  const queue = [...turns];
  return {
    complete: vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error("fakeRouterSequence: exhausted configured turns");
      return next();
    }),
    completeAlias: vi.fn(async () => {
      throw new Error("fakeRouterSequence: completeAlias not used in these tests");
    }),
  } as unknown as ModelRouter;
}

export function finalTurn(output: unknown, opts: { model?: string; inputTokens?: number; outputTokens?: number } = {}): () => CompletionResult<unknown> {
  return () => ({
    output: { type: "final", output },
    modelUsed: opts.model ?? "claude-sonnet-4-6",
    inputTokens: { cached: 0, uncached: opts.inputTokens ?? 100 },
    outputTokens: opts.outputTokens ?? 30,
  });
}

export interface TestEnvironment {
  rootDir: string;
  store: WorkspaceStore;
  tools: ReturnType<typeof createAllKarosTools>;
  cleanup: () => Promise<void>;
}

const BASE_CTX_FIELDS = { clientSlug: "acme", productId: "newsletter-agent", runKind: "recurring" as const };

export async function setupTestEnvironment(
  opts: { withTargetAudience?: boolean; withFrequency?: boolean; withBrand?: boolean } = {},
): Promise<TestEnvironment> {
  const withTargetAudience = opts.withTargetAudience ?? true;
  const withFrequency = opts.withFrequency ?? true;
  const withBrand = opts.withBrand ?? true;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "newsletter-agent-test-"));
  const store = new WorkspaceStore(rootDir);
  // `createOfflineScraper()` is passed EXPLICITLY, because `research.pull` now
  // reports `not_available` without a real scraper rather than returning a
  // placeholder payload. That is deliberate (see karos-research/src/pull.ts): a
  // placeholder is what let every content agent draft from nothing for months.
  // Tests still need deterministic offline data, so they opt in here; nothing in
  // `apps/` does.
  const tools = createAllKarosTools(store, undefined, { scraper: createOfflineScraper() });

  const seedCtx: AgentContext = { runId: "seed", ...BASE_CTX_FIELDS, metadata: {} };
  await store.writeJson("acme", ["client", "profile"], { name: "Acme Corp", industry: "B2B SaaS" });
  await store.writeJson("acme", ["client", "voice-rules"], { tone: "confident, no jargon" });
  if (withBrand) {
    await store.writeJson("acme", ["client", "brand"], { forbiddenTerms: ["guaranteed", "the best", "#1"] });
  }
  const config: { targetAudience?: string; frequency?: string } = {};
  if (withTargetAudience) config.targetAudience = "engineering leaders at mid-size B2B SaaS companies";
  if (withFrequency) config.frequency = "weekly";
  await store.writeJson("acme", ["client", "config"], config);
  // At least 3 topics so a full main-story + two-secondary-sections reservation can succeed.
  await tools["topics.topUp"]!.execute(
    { topics: ["structured engineering onboarding", "async standups", "on-call rotations", "code review culture"] },
    { ctx: seedCtx },
  );

  return {
    rootDir,
    store,
    tools,
    cleanup: () => fs.rm(rootDir, { recursive: true, force: true }),
  };
}
