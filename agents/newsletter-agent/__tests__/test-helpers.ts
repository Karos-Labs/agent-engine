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

/** The `08b-plan-edition` output every edition run needs before drafting (2026-09-05). */
export function goodEditionPlan() {
  return {
    thesis: "Structured onboarding is quietly becoming the default for engineering teams that measure ramp time.",
    lead: {
      title: "structured engineering onboarding",
      angle: "Why a fixed four-day structure beats a reading list, using the teams that measured it.",
      specifics: ["a fixed four-day onboarding rollout"],
      ourTake: "We think the structure matters more than the content of any single day.",
      whyItMatters: "Engineering leaders are hiring again and ramp time is the first metric that slips.",
    },
    quickHits: [],
    oneThingToDo: "Write down what a new hire ships by the end of day one, then work backwards.",
    subjectLineDirection: "Lead with the ramp-time result, not the word onboarding.",
    passedOn: [],
  };
}

/** The editor's approving verdict (`15c-editor-verdict`). */
export function approvingEditorVerdict(notes: string[] = []) {
  return { verdict: "approve", scores: { specificity: 5, voice: 5, structure: 5, humanity: 5 }, notes };
}

/** The editor sending a draft back with notes. */
export function revisingEditorVerdict(notes: string[]) {
  return { verdict: "revise", scores: { specificity: 2, voice: 3, structure: 3, humanity: 2 }, notes };
}

/**
 * The turns a run that clears every gate consumes, in order: the edition plan,
 * the given draft turn(s) (more than one when the draft's own self-critique
 * or the dedupe check costs an extra pass), then the editor's approval.
 */
export function editionRouter(draftTurns: Array<() => CompletionResult<unknown>>): ModelRouter {
  return fakeRouterSequence([finalTurn(goodEditionPlan()), ...draftTurns, finalTurn(approvingEditorVerdict())]);
}

/**
 * The turns a run whose draft never clears the deterministic gates consumes:
 * the plan, then the failing draft once per editorial round (three), after
 * which the run holds. The editor is never reached.
 */
export function heldEditionRouter(draftTurns: Array<() => CompletionResult<unknown>>): ModelRouter {
  const last = draftTurns[draftTurns.length - 1]!;
  return fakeRouterSequence([finalTurn(goodEditionPlan()), ...draftTurns, last, last]);
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
