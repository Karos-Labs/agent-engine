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

const BASE_CTX_FIELDS = { clientSlug: "acme", productId: "blog-agent", runKind: "recurring" as const };

export async function setupTestEnvironment(
  opts: { withVoiceRules?: boolean; withTargetKeywords?: boolean; withContentPillars?: boolean } = {},
): Promise<TestEnvironment> {
  const withVoiceRules = opts.withVoiceRules ?? true;
  const withTargetKeywords = opts.withTargetKeywords ?? true;
  const withContentPillars = opts.withContentPillars ?? true;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "blog-agent-test-"));
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
  await store.writeJson("acme", ["client", "brand"], { forbiddenTerms: ["guaranteed", "the best", "#1"] });
  if (withVoiceRules) {
    await store.writeJson("acme", ["client", "voice-rules"], { tone: "confident, no jargon" });
  }
  const config: { targetKeywords?: string[]; contentPillars?: string[] } = {};
  if (withTargetKeywords) config.targetKeywords = ["engineering onboarding", "developer ramp-up time"];
  if (withContentPillars) config.contentPillars = ["engineering culture", "team operations"];
  await store.writeJson("acme", ["client", "config"], config);
  await tools["topics.topUp"]!.execute({ topics: ["structured engineering onboarding", "async standups", "on-call rotations"] }, { ctx: seedCtx });

  return {
    rootDir,
    store,
    tools,
    cleanup: () => fs.rm(rootDir, { recursive: true, force: true }),
  };
}

/**
 * The blog post as the client actually receives it.
 *
 * Reads the persisted deliverable rather than the workflow's return value on
 * purpose: `bodyMarkdown` is what a reader gets, and a repair that fixed only
 * the gated `text` would pass every re-check and still publish the unredacted
 * article. Assertions built on this catch that; assertions built on `text`
 * alone do not.
 */
export async function deliveredPost(env: TestEnvironment, runId: string): Promise<Record<string, unknown>> {
  const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", runId, "_"]);
  if (deliverables.length !== 1) throw new Error(`expected exactly one deliverable for ${runId}, found ${deliverables.length}`);
  return (deliverables[0] as { data: { deliverable: Record<string, unknown> } }).data.deliverable;
}

/** Every prose field of a delivered post, concatenated — title and FAQ answers included. */
export function allProse(post: Record<string, unknown>): string {
  return JSON.stringify([post["title"], post["metaDescription"], post["excerpt"], post["text"], post["bodyMarkdown"], post["faqItems"]]);
}
