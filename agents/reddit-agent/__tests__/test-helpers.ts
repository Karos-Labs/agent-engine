import { vi } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { FilePromptStore, type AgentContext, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import { createAllKarosTools, WorkspaceStore } from "@agent-engine/tools";

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

const BASE_CTX_FIELDS = { clientSlug: "acme", productId: "reddit-agent", runKind: "recurring" as const };

/**
 * Phase 1 has no live thread-discovery backend (see workflow step 08's own
 * comment), so a target thread only ever comes from an explicit client
 * intake candidate — this is the one every test that expects the run to
 * reach a real thread uses by default.
 */
export const DEFAULT_TARGET_THREAD_URL = "https://www.reddit.com/r/smallbusiness/comments/abc123/our_team_tried_a_4_day_week/";
export const DEFAULT_TARGET_THREAD_TITLE = "Our team tried a 4-day work week: anyone else run a trial like this?";

export async function setupTestEnvironment(
  opts: { withTargetSubreddits?: boolean; withBrand?: boolean; withTargetThread?: boolean } = {},
): Promise<TestEnvironment> {
  const withTargetSubreddits = opts.withTargetSubreddits ?? true;
  const withBrand = opts.withBrand ?? true;
  const withTargetThread = opts.withTargetThread ?? true;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "reddit-agent-test-"));
  const store = new WorkspaceStore(rootDir);
  const tools = createAllKarosTools(store);

  const seedCtx: AgentContext = { runId: "seed", ...BASE_CTX_FIELDS, metadata: {} };
  await store.writeJson("acme", ["client", "profile"], { name: "Acme Corp", industry: "B2B SaaS" });
  await store.writeJson("acme", ["client", "voice-rules"], { tone: "conversational, no jargon" });
  if (withBrand) {
    await store.writeJson("acme", ["client", "brand"], { forbiddenTerms: ["guaranteed", "the best", "#1"] });
  }
  if (withTargetSubreddits) {
    await store.writeJson("acme", ["client", "config"], {
      targetSubreddits: ["smallbusiness", "startups"],
      ...(withTargetThread ? { requestedThreadUrl: DEFAULT_TARGET_THREAD_URL, requestedThreadTitle: DEFAULT_TARGET_THREAD_TITLE } : {}),
    });
  }
  await tools["topics.topUp"]!.execute({ topics: ["four-day work weeks", "remote hiring", "customer support tooling"] }, { ctx: seedCtx });

  return {
    rootDir,
    store,
    tools,
    cleanup: () => fs.rm(rootDir, { recursive: true, force: true }),
  };
}
