import { vi } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { FilePromptStore, type CompletionResult, type ModelRouter } from "@agent-engine/core";
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

/**
 * A `ModelRouter` that serves both bounded agents (`seo-geo-fix-draft`,
 * `seo-geo-narrative`) from one shared instance by matching the requested
 * schema against a pool of candidates, rather than a strict call-order queue
 * — the fix-draft step only runs conditionally (when at least one
 * `agent-direct` recommendation fired), so a fixed queue position isn't
 * reliable across every test scenario. Mirrors `apps/agent-server`'s
 * `smartFakeRouter`.
 */
export function smartFakeRouter(candidates: readonly unknown[]): ModelRouter {
  return {
    async complete(_prompt, schema, policy) {
      for (const candidate of candidates) {
        const parsed = schema.safeParse({ type: "final", output: candidate });
        if (parsed.success) {
          return {
            output: parsed.data,
            modelUsed: policy.policy === "pinned" ? policy.model : "claude-haiku-4-5-20251001",
            inputTokens: { cached: 0, uncached: 100 },
            outputTokens: 30,
          };
        }
      }
      throw new Error("smartFakeRouter: no candidate output matches the requested schema");
    },
    async completeAlias() {
      throw new Error("smartFakeRouter: completeAlias not used in these tests");
    },
  } as ModelRouter;
}

export function goodFixDrafts() {
  return {
    fixes: [
      { recId: "SEO-02", title: "Fix example issue", description: "A grounded description referencing only the given recommendation data." },
    ],
  };
}

export function goodNarrative() {
  return { summary: "This audit scored the site at 0 out of 100 for SEO and 0 out of 100 for GEO Readiness, based on the data measured so far." };
}

export interface TestEnvironment {
  rootDir: string;
  store: WorkspaceStore;
  tools: ReturnType<typeof createAllKarosTools>;
  cleanup: () => Promise<void>;
}

export async function setupTestEnvironment(opts: { withProfile?: boolean; withBrand?: boolean; withCompetitors?: boolean } = {}): Promise<TestEnvironment> {
  const withProfile = opts.withProfile ?? true;
  const withBrand = opts.withBrand ?? true;
  const withCompetitors = opts.withCompetitors ?? true;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "seo-geo-agent-test-"));
  const store = new WorkspaceStore(rootDir);
  // `createOfflineScraper()` is passed EXPLICITLY, because `research.pull` now
  // reports `not_available` without a real scraper rather than returning a
  // placeholder payload. That is deliberate (see karos-research/src/pull.ts): a
  // placeholder is what let every content agent draft from nothing for months.
  // Tests still need deterministic offline data, so they opt in here; nothing in
  // `apps/` does.
  const tools = createAllKarosTools(store, undefined, { scraper: createOfflineScraper() });

  if (withProfile) {
    await store.writeJson("acme", ["client", "profile"], { name: "Acme Corp", industry: "B2B SaaS", website: "https://acme.example" });
  }
  if (withBrand) {
    await store.writeJson("acme", ["client", "brand"], { forbiddenTerms: ["guaranteed", "the best", "#1"] });
  }
  if (withCompetitors) {
    await store.writeJson("acme", ["client", "competitors"], [{ name: "Rivalco", website: "https://rivalco.example" }]);
  }

  return {
    rootDir,
    store,
    tools,
    cleanup: () => fs.rm(rootDir, { recursive: true, force: true }),
  };
}
