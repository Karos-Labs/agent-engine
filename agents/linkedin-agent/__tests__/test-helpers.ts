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

const BASE_CTX_FIELDS = { clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" as const };

export async function setupTestEnvironment(opts: { withProfile?: boolean; withVoiceRules?: boolean } = {}): Promise<TestEnvironment> {
  const withProfile = opts.withProfile ?? true;
  const withVoiceRules = opts.withVoiceRules ?? true;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "linkedin-agent-test-"));
  const store = new WorkspaceStore(rootDir);
  // `createOfflineScraper()` is passed EXPLICITLY, because `research.pull` now
  // reports `not_available` without a real scraper rather than returning a
  // placeholder payload. That is deliberate (see karos-research/src/pull.ts): a
  // placeholder is what let every content agent draft from nothing for months.
  // Tests still need deterministic offline data, so they opt in here; nothing in
  // `apps/` does.
  const tools = createAllKarosTools(store, undefined, { scraper: createOfflineScraper() });

  const seedCtx: AgentContext = { runId: "seed", ...BASE_CTX_FIELDS, metadata: {} };
  if (withProfile) {
    await store.writeJson("acme", ["client", "profile"], { name: "Acme Corp", industry: "B2B SaaS" });
  }
  await store.writeJson("acme", ["client", "brand"], { forbiddenTerms: ["guaranteed", "the best", "#1"] });
  if (withVoiceRules) {
    await store.writeJson("acme", ["client", "voice-rules"], { tone: "confident, no jargon" });
  }
  await tools["topics.topUp"]!.execute({ topics: ["hybrid work anchor days", "async collaboration", "manager burnout"] }, { ctx: seedCtx });

  return {
    rootDir,
    store,
    tools,
    cleanup: () => fs.rm(rootDir, { recursive: true, force: true }),
  };
}

/**
 * The post as the client actually receives it.
 *
 * Reads the persisted deliverable rather than the workflow's return value on
 * purpose: the deliverable spreads every draft field, so `body`, `hook`,
 * `headline`, `takeaway` and `callToAction` all reach the client. A repair
 * that fixed only the gated `text` would re-check clean and ship the rest
 * unredacted; assertions built on this catch that.
 */
export async function deliveredPost(env: TestEnvironment, runId: string): Promise<Record<string, unknown>> {
  const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", runId, "_"]);
  if (deliverables.length !== 1) throw new Error(`expected exactly one deliverable for ${runId}, found ${deliverables.length}`);
  return (deliverables[0] as { data: { deliverable: Record<string, unknown> } }).data.deliverable;
}

/** Every prose field of a delivered post, concatenated. */
export function allProse(post: Record<string, unknown>): string {
  return JSON.stringify([post["text"], post["headline"], post["hook"], post["body"], post["takeaway"], post["callToAction"]]);
}
