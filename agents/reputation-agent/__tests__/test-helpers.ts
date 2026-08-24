import { vi } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { FilePromptStore, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import { createAllKarosTools, WorkspaceStore } from "@agent-engine/tools";
import { createOfflineScraper } from "@agent-engine/tool-karos-scraper";
import {
  DOCTRINE_CONSTRAINTS,
  type CaptureLegRequest,
  type DoctrineConstraint,
  type DoctrineVerdict,
  type Review,
} from "@agent-engine/tool-karos-reputation";
import type { ReputationDoctrineGateAgentOutput } from "../src/agent/reputation-doctrine-gate-agent.js";
import type {
  DepartmentTag,
  ReputationDraftOutput,
  ReputationExtractionOutput,
  ReputationTagOutput,
  ReputationVoiceOutput,
} from "../src/workflow/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROMPTS_ROOT = path.join(HERE, "..", "prompts");

export function makePromptStore(): FilePromptStore {
  return new FilePromptStore(PROMPTS_ROOT);
}

export function finalTurn(output: unknown, opts: { model?: string; inputTokens?: number; outputTokens?: number } = {}): () => CompletionResult<unknown> {
  return () => ({
    output: { type: "final", output },
    modelUsed: opts.model ?? "claude-sonnet-4-6",
    inputTokens: { cached: 0, uncached: opts.inputTokens ?? 100 },
    outputTokens: opts.outputTokens ?? 30,
  });
}

/** A router whose `.complete()` replays a fixed sequence of turns in order — never used by tests that expect zero model calls. */
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

/**
 * A `ModelRouter` that serves every bounded agent in the pulse workflow
 * (extraction/tag/draft/voice/doctrine-gate) from one shared pool of canned
 * outputs, matching the requested turn schema against each candidate in
 * order — mirrors `seo-geo-agent`/`intel-report-agent`'s own
 * `smartFakeRouter` helper. Reliable across the pulse workflow's variable
 * call order (which agents run, and how many times, depends on triage's own
 * routing decision and the 06-09 retry loop).
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

/**
 * Same matching behavior as `smartFakeRouter`, but records every
 * `(prompt, modelPolicy)` pair it was asked to complete — for tests that need
 * to inspect what a specific bounded agent's own turn actually contained
 * (e.g. proving the doctrine-gate agent's turn never carries the draft
 * agent's own transcript/reasoning).
 */
export interface RecordedCall {
  prompt: string;
  policy: unknown;
}

export function recordingSmartFakeRouter(candidates: readonly unknown[]): { router: ModelRouter; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const base = smartFakeRouter(candidates);
  return {
    calls,
    router: {
      async complete(prompt, schema, policy, opts) {
        calls.push({ prompt, policy });
        return base.complete(prompt, schema, policy, opts);
      },
      async completeAlias() {
        throw new Error("recordingSmartFakeRouter: completeAlias not used in these tests");
      },
    } as ModelRouter,
  };
}

/**
 * `smartFakeRouter`, but the first `failFirstN` turns belonging to `stepId`
 * THROW instead of completing — `BaseAgent.runOneTurn` catches a router
 * throw and resolves that agent run to `status: "tooling_error"`
 * (`packages/core/src/agent/base-agent.ts`), which is exactly the transient
 * model/API failure run-protocol.md §4 means by "a crash". Pass
 * `failFirstN: Infinity` for a fault that never clears.
 */
export function flakyStepRouter(candidates: readonly unknown[], opts: { stepId: string; failFirstN: number }): ModelRouter {
  const base = smartFakeRouter(candidates);
  let thrown = 0;
  return {
    async complete(prompt, schema, policy, options) {
      const stepId = (JSON.parse(prompt) as { stepId?: string }).stepId;
      if (stepId === opts.stepId && thrown < opts.failFirstN) {
        thrown++;
        throw new Error(`simulated transient model API failure on "${opts.stepId}" turn #${thrown}`);
      }
      return base.complete(prompt, schema, policy, options);
    },
    async completeAlias() {
      throw new Error("flakyStepRouter: completeAlias not used in these tests");
    },
  } as ModelRouter;
}

/** Parses one `BaseAgent.buildTurnPrompt()` JSON payload back into its structured pieces, for asserting exactly what a given step id's turn was handed. */
export function parseTurnPrompt(prompt: string): { stepId: string; input: Record<string, unknown>; transcript: unknown[] } {
  return JSON.parse(prompt) as { stepId: string; input: Record<string, unknown>; transcript: unknown[] };
}

// ── canned agent outputs ────────────────────────────────────────────────

export function extractionOutput(overrides: Partial<ReputationExtractionOutput> = {}): ReputationExtractionOutput {
  const noEvidence = { value: false, evidenceSpan: "" };
  return {
    sentiment: "neutral",
    hasQuestion: noEvidence,
    factualError: noEvidence,
    fixableComplaint: noEvidence,
    detailedPositive: noEvidence,
    serviceRecoveryOpportunity: noEvidence,
    ...overrides,
  };
}

export function draftOutput(text: string): ReputationDraftOutput {
  return { draftText: text };
}

export function tagOutput(pairs: Array<{ reviewId: string; tag: DepartmentTag }>): ReputationTagOutput {
  return { tags: pairs };
}

export function voicePassOutput(reviewIds: readonly string[]): ReputationVoiceOutput {
  return { verdicts: reviewIds.map((reviewId) => ({ reviewId, pass: true, reason: "reads consistently with this client's brand voice" })) };
}

function allPassDoctrineVerdicts(): DoctrineVerdict[] {
  return DOCTRINE_CONSTRAINTS.map((constraint) => ({ constraint, verdict: "pass" as const, quote: "", rationale: `${constraint}: nothing found` }));
}

/** All 4 doctrine verdicts pass by default; pass a partial override keyed by constraint to fail one on purpose (e.g. for the retry-cap test). */
export function doctrineOutput(overrides: Partial<Record<DoctrineConstraint, Partial<DoctrineVerdict>>> = {}): ReputationDoctrineGateAgentOutput {
  return { verdicts: allPassDoctrineVerdicts().map((v) => ({ ...v, ...overrides[v.constraint] })) };
}

// ── review / capture-leg factories ──────────────────────────────────────

export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** A minimal, valid `Review` — every field `triage()`/the workflow actually reads has a deliberate, deterministic default (recent, mid-rating, no annotations) so a caller only has to override what the scenario actually needs. */
export function makeReview(overrides: Partial<Review> & { review_id: string }): Review {
  return {
    platform: "google",
    source: "manual_export",
    capture_tier: "MEASURED",
    listing_id: "loc-1",
    listing_label: "Loc One",
    rating: 3,
    author: "A Reviewer",
    author_badge: null,
    language: "en",
    text: "A fine experience overall.",
    created_at: daysAgoIso(2),
    updated_at: null,
    owner_response: null,
    url: null,
    ...overrides,
  } as Review;
}

export function manualExportLeg(rows: Review[], opts: { listingId?: string; listingLabel?: string } = {}): CaptureLegRequest {
  return {
    leg: "manual_export",
    listingId: opts.listingId ?? "loc-1",
    listingLabel: opts.listingLabel ?? "Loc One",
    inRoster: true,
    rows,
  } as CaptureLegRequest;
}

// ── test environment ─────────────────────────────────────────────────────

export interface TestEnvironment {
  rootDir: string;
  store: WorkspaceStore;
  tools: ReturnType<typeof createAllKarosTools>;
  clientSlug: string;
  cleanup: () => Promise<void>;
}

export async function setupTestEnvironment(opts: { clientSlug?: string; facts?: string[] } = {}): Promise<TestEnvironment> {
  const clientSlug = opts.clientSlug ?? "acme-cafe";
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "reputation-agent-test-"));
  const store = new WorkspaceStore(rootDir);
  // `createOfflineScraper()` is passed EXPLICITLY, because `research.pull` now
  // reports `not_available` without a real scraper rather than returning a
  // placeholder payload. That is deliberate (see karos-research/src/pull.ts): a
  // placeholder is what let every content agent draft from nothing for months.
  // Tests still need deterministic offline data, so they opt in here; nothing in
  // `apps/` does.
  const tools = createAllKarosTools(store, undefined, { scraper: createOfflineScraper() });

  await store.writeJson(clientSlug, ["client", "profile"], {
    name: "Acme Cafe",
    facts: opts.facts ?? ["We are open 7 days a week.", "We respond to every review within one business day."],
  });
  await store.writeJson(clientSlug, ["client", "brand"], { voice: "warm, direct, no corporate jargon" });
  await store.writeJson(clientSlug, ["client", "voice-rules"], { tone: "warm", doList: ["thank the reviewer by name if given"], dontList: ["over-apologize"] });

  return {
    rootDir,
    store,
    tools,
    clientSlug,
    cleanup: () => fs.rm(rootDir, { recursive: true, force: true }),
  };
}

export interface ClientConfigOverrides {
  reputationAutonomy?: string;
  reputationRoster?: CaptureLegRequest[];
  reputationLocks?: { neverSay: string[]; requiredFramingAnyOf: string[] };
  reputationBaselineRatingAvg?: Record<string, number>;
  [key: string]: unknown;
}

export async function writeClientConfig(store: WorkspaceStore, clientSlug: string, overrides: ClientConfigOverrides = {}): Promise<void> {
  await store.writeJson(clientSlug, ["client", "config"], {
    reputationAutonomy: "approve-all",
    reputationRoster: [],
    reputationLocks: { neverSay: [], requiredFramingAnyOf: [] },
    reputationBaselineRatingAvg: {},
    ...overrides,
  });
}
