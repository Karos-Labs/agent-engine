import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { ZodType } from "zod";
import { DEDUPE_SIMILARITY_THRESHOLD, FilePromptStore, similarity, type AgentToolRegistry, type CompletionResult, type ModelRouter } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { BrandFrameInputSchema, CutClipInputSchema, SelfEvalGateInputSchema, TranscribeInputSchema } from "@agent-engine/tool-karos-video";
import { createTikTokAgentWorkflow } from "../src/workflow/create-tiktok-agent-workflow.js";

/**
 * SCRUM-381: AU20 (SCRUM-304) verified `checkOutputDedupe` on five channel
 * agents and left `tiktok-agent` off the capability matrix by mistake — six
 * agents were advisory, not five. This is the acceptance test: a planted
 * NEAR-duplicate commentary draft is caught and redrafted before it can reach
 * the reviewer, not merely warned against in the drafting prompt.
 *
 * "Near", not byte-identical, on purpose — the point of the ticket is that
 * `recentPosts` in the commentary prompt was ADVISORY, and nothing downstream
 * ever measured whether the model actually complied. The planted draft below
 * scores comfortably over `evaluateDedupe`'s calibrated threshold while
 * sharing no whole sentence verbatim with the published clip it recycles —
 * exactly the case a prompt-only check sails past.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_ROOT = path.join(HERE, "..", "prompts");
const PARAMS = { clientSlug: "acme", productId: "tiktok-agent", runKind: "recurring" as const };

/** 90 seconds of one-second sentences, so a legal 20-120s clip exists. */
function transcriptWords(): Array<{ text: string; start: number; end: number }> {
  return Array.from({ length: 90 }, (_, i) => ({ text: `word${i}.`, start: i, end: i + 1 }));
}

const GOOD_MOMENT = {
  startSeconds: 10,
  endSeconds: 50,
  hookLine: "word10.",
  hookType: "surprising-number" as const,
  rationale: "The figure reframes the whole discussion.",
};

const SOURCE_CREDIT = "Jane Doe on The Show ep. 12";

/** Already shipped for this client, sitting in the output-history window. */
const PUBLISHED_CAPTION =
  "Four day week trials keep spreading across mid sized teams. Internal data shows output held steady while sick days fell. The real trade off is scheduling, not productivity.";
const PUBLISHED_ABOUT = "A clip where a guest cites four-day-week data that changed our view.";
const PUBLISHED_TEXT = `${PUBLISHED_CAPTION}\n\n${PUBLISHED_ABOUT}`;

/** This run's first draft: the same point, sentences reordered and lightly reworded — not a copy. */
const NEAR_DUP_COMMENTARY = {
  caption: `The real trade off here is scheduling, not productivity. Fresh internal data shows output held steady while sick days fell. Four day week trials keep spreading among mid sized teams. Via ${SOURCE_CREDIT}.`,
  about: PUBLISHED_ABOUT,
  sourceCredit: SOURCE_CREDIT,
};

/** The redraft: a genuinely different angle, hook and subject matter. */
const FRESH_COMMENTARY = {
  caption: `Hiring managers keep asking us how to interview for judgement rather than trivia. Our answer is boring: give the candidate a real ticket from last week and talk about what they would cut. Via ${SOURCE_CREDIT}.`,
  about: "A clip where a guest walks through how she actually interviews for judgement.",
  sourceCredit: SOURCE_CREDIT,
};

/** Replays a fixed sequence of outputs in order, validated against whatever schema each call actually requests. */
function sequentialRouter(candidates: readonly unknown[]): ModelRouter {
  let i = 0;
  return {
    complete: vi.fn(async (_prompt: unknown, schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: unknown } }, policy: { policy: string; model?: string }) => {
      if (i >= candidates.length) throw new Error("sequentialRouter: exhausted configured turns");
      const candidate = candidates[i++];
      const parsed = schema.safeParse({ type: "final", output: candidate });
      if (!parsed.success) {
        throw new Error(`sequentialRouter: turn ${i} does not match the requested schema: ${JSON.stringify(parsed.error)}`);
      }
      return {
        output: parsed.data,
        modelUsed: policy.policy === "pinned" ? policy.model : "claude-haiku-4-5-20251001",
        inputTokens: { cached: 0, uncached: 100 },
        outputTokens: 30,
      } as CompletionResult<unknown>;
    }),
    completeAlias: vi.fn(async () => {
      throw new Error("completeAlias is not used here");
    }),
  } as unknown as ModelRouter;
}

interface Harness {
  tools: AgentToolRegistry;
  /** The fake output-history store `ledger.listOutputExcerpts`/`recordOutputExcerpt` read and write, pre-seeded with `PUBLISHED_TEXT`. */
  outputHistory: Array<{ runId: string; excerpt: string }>;
}

function stubTools(): Harness {
  const outputHistory: Array<{ runId: string; excerpt: string }> = [{ runId: "prior-run", excerpt: PUBLISHED_TEXT }];
  const ok = (result: unknown) => ({ status: "success" as const, result });
  const pass = () => ({ verdict: "pass" as const, reason: "" });

  const tool = (name: string, run: (args: never) => unknown, schema?: ZodType) => ({
    name,
    version: "1.0.0",
    inputSchema: schema ?? { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
    async execute(args: never) {
      if (schema) schema.parse(args);
      return run(args);
    },
  });

  const tools: Record<string, unknown> = {
    "client.getConfig": tool("client.getConfig", () => ok({ tiktokClips: { sourcePool: ["The Show"], guestWatchlist: [], narrowing: [] } })),
    "client.getVoiceRules": tool("client.getVoiceRules", () => ok({ tone: "direct" })),
    "client.getBrand": tool("client.getBrand", () => ok({ forbiddenTerms: [], colors: { neutralDark: "#101418", neutralLight: "#F2F0EA" }, handle: "acmeco" })),
    "client.getStrategy": tool("client.getStrategy", () => ok({ markdown: "" })),
    "topics.reserve": tool("topics.reserve", () => ok({ reservationKey: "res-1", topics: ["The Show ep. 12 — the interviewing bit"] })),
    "topics.commit": tool("topics.commit", () => ok({ committed: true })),
    "topics.release": tool("topics.release", () => ok({ released: true })),
    "video.transcribe": tool("video.transcribe", () => ok({ words: transcriptWords() }), TranscribeInputSchema),
    "video.cutClip": tool("video.cutClip", (args) => ok({ outputPath: (args as { outputPath: string }).outputPath, durationSeconds: 40 }), CutClipInputSchema),
    "video.brandFrame": tool(
      "video.brandFrame",
      (args) => ok({ outputPath: (args as { outputPath: string }).outputPath, durationSeconds: 40, applied: ["bars"] }),
      BrandFrameInputSchema,
    ),
    "video.selfEvalGate": tool("video.selfEvalGate", () => ok(pass()), SelfEvalGateInputSchema),
    "gate.lintPost": tool("gate.lintPost", () => ok(pass())),
    "gate.brandCompliance": tool("gate.brandCompliance", () => ok(pass())),
    "gate.noPlaceholder": tool("gate.noPlaceholder", () => ok(pass())),
    "gate.leakCheck": tool("gate.leakCheck", () => ok(pass())),
    "ledger.writeDeliverable": tool("ledger.writeDeliverable", () => ok({ id: "deliv-1", created: true })),
    "memory.appendDecision": tool("memory.appendDecision", () => ok({ id: "dec-1" })),
    // The anti-repetition read/write half — a lightweight in-memory stand-in
    // for the real `packages/tools/karos-ledger` implementation, faithful to
    // its `{entries}` / idempotent-on-runId contract.
    "ledger.listOutputExcerpts": tool("ledger.listOutputExcerpts", (args) => {
      const { agentId, excludeRunId } = args as { agentId: string; excludeRunId?: string };
      if (agentId !== "tiktok-agent") return ok({ entries: [] });
      return ok({ entries: outputHistory.filter((e) => e.runId !== excludeRunId) });
    }),
    "ledger.recordOutputExcerpt": tool("ledger.recordOutputExcerpt", (args) => {
      const { agentId, runId, excerpt } = args as { agentId: string; runId: string; excerpt: string };
      if (agentId !== "tiktok-agent" || !excerpt.trim()) return ok({ recorded: false, total: outputHistory.length });
      const next = outputHistory.filter((e) => e.runId !== runId);
      next.push({ runId, excerpt: excerpt.trim() });
      outputHistory.length = 0;
      outputHistory.push(...next);
      return ok({ recorded: true, total: outputHistory.length });
    }),
  };
  return { tools: tools as unknown as AgentToolRegistry, outputHistory };
}

describe("tiktok-agent verified de-duplication (SCRUM-381)", () => {
  it("catches a planted near-duplicate before review, redrafts, and ships the fresh commentary", async () => {
    // The plant really is a near-duplicate and really is not a copy: an
    // exact-match or substring check would not fire on it.
    const nearDupText = `${NEAR_DUP_COMMENTARY.caption}\n\n${NEAR_DUP_COMMENTARY.about}`;
    const freshText = `${FRESH_COMMENTARY.caption}\n\n${FRESH_COMMENTARY.about}`;
    expect(nearDupText).not.toBe(PUBLISHED_TEXT);
    expect(similarity(nearDupText, PUBLISHED_TEXT)).toBeGreaterThanOrEqual(DEDUPE_SIMILARITY_THRESHOLD);
    expect(similarity(freshText, PUBLISHED_TEXT)).toBeLessThan(DEDUPE_SIMILARITY_THRESHOLD);

    const h = stubTools();
    const router = sequentialRouter([GOOD_MOMENT, NEAR_DUP_COMMENTARY, FRESH_COMMENTARY]);
    const workflow = createTikTokAgentWorkflow({
      tools: h.tools,
      promptStore: new FilePromptStore(PROMPTS_ROOT),
      router,
      autoApprove: true,
    });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "run-tt-dedupe";

    const result = await engine.run(workflow, { ...PARAMS, runId, input: { sourcePath: "/tmp/episode.mp4" } });

    // The headline claim, asserted first so a regression here reads as what it
    // is: without the verified check the near-duplicate is what ships.
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    const output = result.output as { commentary: { caption: string; about: string } };
    expect(output.commentary.caption).toBe(FRESH_COMMENTARY.caption);
    expect(output.commentary.about).toBe(FRESH_COMMENTARY.about);

    // The advisory half was present and was not enough: the do-not-repeat
    // directive reached the first drafting prompt, and the model returned the
    // near-duplicate anyway. Only the verified check stopped it.
    const calls = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(String(calls[1]![0])).toContain("RECENTLY PUBLISHED");

    const flagged = await durableStore.getStep(runId, "06b-verify-not-duplicate");
    expect(flagged?.status).toBe("completed");
    const verdict = flagged?.output as { status: string; maxSimilarity: number; comparedCount: number; mostSimilarRunId?: string };
    expect(verdict.status).toBe("similar");
    expect(verdict.mostSimilarRunId).toBe("prior-run");
    expect(verdict.comparedCount).toBe(1);
    expect(verdict.maxSimilarity).toBeGreaterThanOrEqual(DEDUPE_SIMILARITY_THRESHOLD);

    // The hit COST the draft: a second commentary pass ran, steered by the
    // offending post, and cleared the same check.
    const ids = (await durableStore.listSteps(runId)).map((s) => s.stepId);
    expect(ids).toContain("06-commentary-attempt-2");
    const cleared = await durableStore.getStep(runId, "06b-verify-not-duplicate-attempt-2");
    expect((cleared?.output as { status: string }).status).toBe("ok");

    // The near-duplicate never reached the reviewer, and never shipped.
    expect(h.outputHistory.map((e) => e.excerpt)).toContain(freshText);
    expect(h.outputHistory.map((e) => e.excerpt)).not.toContain(nearDupText);
  }, 20_000);

  it("ships FLAGGED rather than held when every attempt still scores similar — dedupe steers, it never holds a run", async () => {
    const h = stubTools();
    // Both attempts the retry budget allows (MAX_DEDUPE_ATTEMPTS = 2) come
    // back near-duplicate. On the final attempt the draft ships anyway: a
    // fixed threshold is not entitled to overrule the human reviewer.
    const router = sequentialRouter([GOOD_MOMENT, NEAR_DUP_COMMENTARY, NEAR_DUP_COMMENTARY]);
    const workflow = createTikTokAgentWorkflow({
      tools: h.tools,
      promptStore: new FilePromptStore(PROMPTS_ROOT),
      router,
      autoApprove: true,
    });
    const durableStore = new MemoryDurableStepStore();
    const runId = "run-tt-dedupe-flagged";
    const result = await new WorkflowEngine(durableStore).run(workflow, { ...PARAMS, runId, input: { sourcePath: "/tmp/episode.mp4" } });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    const output = result.output as { commentary: { caption: string } };
    expect(output.commentary.caption).toBe(NEAR_DUP_COMMENTARY.caption);

    const last = await durableStore.getStep(runId, "06b-verify-not-duplicate-attempt-2");
    expect((last?.output as { status: string }).status).toBe("similar");
    // Never a third attempt: the budget is exactly two.
    const ids = (await durableStore.listSteps(runId)).map((s) => s.stepId);
    expect(ids).not.toContain("06-commentary-attempt-3");
  }, 20_000);
});
