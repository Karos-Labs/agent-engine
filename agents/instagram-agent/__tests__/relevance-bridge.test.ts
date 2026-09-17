import { describe, expect, it, vi } from "vitest";
import type { AgentContext, CompletionResult, ModelRouter, PromptStore } from "@agent-engine/core";
import type { WorkflowContext } from "@agent-engine/workflow";
import {
  MIN_RELEVANCE_SCORE,
  THIN_GROUNDING_MIN_RELEVANCE_SCORE,
  relevanceFloor,
  relevanceSteerFor,
  runRelevanceJudge,
  type RelevanceJudgeInput,
} from "../src/workflow/relevance-gate.js";

/**
 * Phase 5.5 (spec §6 G5.2) — THE BRIDGE THAT WAS NEVER PARSED.
 *
 * `relevance-gate.ts` read `missingBridge` BELOW the `score >= minScore`
 * return, so on every passing verdict the judge's own "here is the sentence
 * this post is missing" was thrown away unread. `relevanceSteerFor` — a
 * function written for exactly that verdict — has never once been reachable
 * with a bridge in it on a run that passed.
 *
 * **This guard has never been able to fire.** Restore the early return above
 * the parse and the first case here goes red: a 3-with-a-bridge comes back
 * `relevant` with no bridge anywhere on the verdict.
 *
 * The fixture is thepitchbydeel's `07g-relevance-attempt-3` from 2026-09-16,
 * VERBATIM — `score`, `reason` and `missingBridge` copied character for
 * character out of the run document. That post shipped. Its four middle slides
 * argued general LLM workflow design at an audience of founders applying to a
 * pitch competition, because the subject came from a catalog row seeded with
 * Karos Labs' subject matter (see `topic-catalog-and-format.test.ts` for the
 * other half of the same defect).
 */

// ─────────────────────────────────────────────────────────────────────────
// The fixture: deel's 07g verdict, verbatim
// ─────────────────────────────────────────────────────────────────────────

const DEEL_07G = {
  score: 3,
  reason:
    'The caption and several slides explicitly mention "The Pitch by Deel" and its unique scoring criteria, directly addressing founders. ' +
    "However, slides 4-7 pivot to a detailed discussion of general AI/LLM workflow design principles. " +
    'While the brief mentions "AI analysis" is used, the post does not explicitly connect why these specific architectural details matter to a founder ' +
    "applying to the competition, making it less clear for a stranger to see the relevance of these particular slides to 'The Pitch's' offer.",
  missingBridge:
    "These detailed AI workflow principles are crucial because they ensure The Pitch's evaluation is consistently fair and provides reliable feedback for every founder.",
} as const;

// ─────────────────────────────────────────────────────────────────────────
// A harness with no dependency on the shared test helpers
// ─────────────────────────────────────────────────────────────────────────

const CTX: AgentContext = { runId: "run_bridge", clientSlug: "thepitchbydeel", productId: "instagram-agent", runKind: "recurring", metadata: {} };

/** One turn, shaped the way `BaseAgent` reads a completion. */
function finalTurn(output: unknown): () => CompletionResult<unknown> {
  return () => ({
    output: { type: "final", output },
    modelUsed: "gemini-2.5-flash",
    inputTokens: { cached: 0, uncached: 3115 },
    outputTokens: 168,
  });
}

function routerReturning(output: unknown): ModelRouter {
  const turn = finalTurn(output);
  return { complete: vi.fn(async () => turn()), completeAlias: vi.fn(async () => { throw new Error("completeAlias is not used here"); }) } as unknown as ModelRouter;
}

/** A `WorkflowContext` whose `step.agent` runs the agent directly — enough for the verdict mapping. */
function fakeWorkflowContext(): WorkflowContext {
  return {
    runId: CTX.runId,
    clientSlug: CTX.clientSlug,
    productId: CTX.productId,
    runKind: CTX.runKind,
    input: {},
    step: {
      code: async <T,>(_id: string, fn: () => T | Promise<T>) => fn(),
      agent: async (_id: string, agent: { run: (ctx: AgentContext, input: unknown) => Promise<unknown> }, input: unknown) => agent.run(CTX, input),
    },
  } as unknown as WorkflowContext;
}

/** The relevance judge declares no `skillRef`, so the store is never read. */
const NO_PROMPTS = {} as unknown as PromptStore;

const INPUT: RelevanceJudgeInput = {
  brief: "What we sell: a pitch competition for early-stage founders. Audience: founders preparing to raise.",
  topic: "a workflow we would rebuild from scratch",
  caption: "Most competitions score you on a feeling.",
  slides: [
    { n: 1, headline: "Most competitions score you on a feeling.", body: "Five criteria, two layers." },
    { n: 4, headline: "One call cannot do every job", body: "Specialised steps beat a single prompt." },
  ],
};

async function judge(output: unknown, floor = relevanceFloor(false)) {
  return runRelevanceJudge(fakeWorkflowContext(), { tools: {}, router: routerReturning(output), promptStore: NO_PROMPTS }, "07g-relevance-attempt-3", INPUT, floor);
}

// ─────────────────────────────────────────────────────────────────────────

describe("the missing bridge is read on every verdict, not only on the ones that already failed", () => {
  it("deel's 07g verdict VERBATIM: a 3 with a bridge is off-brief, and the bridge is the steer", async () => {
    const verdict = await judge(DEEL_07G);

    // The premise, asserted rather than assumed: this verdict is AT the floor,
    // so under the old code it took the `score >= minScore` early return.
    expect(DEEL_07G.score).toBe(MIN_RELEVANCE_SCORE);

    expect(verdict.status).toBe("off-brief");
    if (verdict.status !== "off-brief") throw new Error("unreachable");
    expect(verdict.score).toBe(3);
    expect(verdict.missingBridge).toBe(DEEL_07G.missingBridge);
    // The function that has never been reachable on a live run.
    expect(relevanceSteerFor(verdict)).toBe(DEEL_07G.missingBridge);
    // And the steer is the BRIDGE, not the reason — the writer is handed a
    // sentence to add, not a complaint to interpret.
    expect(relevanceSteerFor(verdict)).not.toBe(DEEL_07G.reason);
  });

  it("a 4 with a bridge PASSES, carrying the bridge to the gate as a note", async () => {
    const verdict = await judge({ ...DEEL_07G, score: 4 });
    expect(verdict.status).toBe("relevant");
    if (verdict.status !== "relevant") throw new Error("unreachable");
    expect(verdict.score).toBe(4);
    expect(verdict.note).toBe(DEEL_07G.missingBridge);
  });

  it("a 3 with NO bridge still passes clean — the floor did not move", async () => {
    const verdict = await judge({ score: 3, reason: "the bridge exists but takes a sentence" });
    expect(verdict).toEqual({ status: "relevant", score: 3, reason: "the bridge exists but takes a sentence" });
  });

  it("a blank or whitespace bridge is no bridge: it must not turn a passing 3 into a redraft", async () => {
    for (const missingBridge of ["", "   ", "\n\t "]) {
      const verdict = await judge({ score: 3, reason: "the bridge exists but takes a sentence", missingBridge });
      expect(verdict.status).toBe("relevant");
    }
  });

  it("a 5 with a bridge passes with the note, and a 1 with a bridge is off-brief as it always was", async () => {
    const five = await judge({ ...DEEL_07G, score: 5 });
    expect(five).toMatchObject({ status: "relevant", score: 5, note: DEEL_07G.missingBridge });

    const one = await judge({ ...DEEL_07G, score: 1 });
    expect(one).toMatchObject({ status: "off-brief", score: 1, missingBridge: DEEL_07G.missingBridge });
  });
});

describe("the relaxed floor still means what it meant", () => {
  it("a thinly-grounded 2 with a bridge does NOT go back — the bridge rides the note instead", async () => {
    const floor = relevanceFloor(true);
    expect(floor.minScore).toBe(THIN_GROUNDING_MIN_RELEVANCE_SCORE);

    // The relaxation's premise is that 2 is the ceiling of what this brief can
    // earn, so no redraft can answer the verdict. A bridge here reads like an
    // instruction and is not one: the writer has no offer to name because the
    // brief does not contain one. Returning the draft would re-open exactly the
    // unwinnable hold `THIN_GROUNDING_MIN_RELEVANCE_SCORE` exists to close.
    const two = await judge({ ...DEEL_07G, score: 2 }, floor);
    expect(two.status).toBe("relevant");
    if (two.status !== "relevant") throw new Error("unreachable");
    // Both facts reach the reviewer: why the floor was lowered, and the
    // sentence the judge wanted, with the reason no redraft can supply it.
    expect(two.note).toContain(floor.relaxedReason!);
    expect(two.note).toContain(DEEL_07G.missingBridge);
    expect(two.note).toMatch(/no redraft against this brief could build/);
  });

  it("one point above the relaxed floor the bridge is a note again, and the relaxation is not competing for the field", async () => {
    const three = await judge({ ...DEEL_07G, score: 3 }, relevanceFloor(true));
    expect(three).toMatchObject({ status: "relevant", score: 3, note: DEEL_07G.missingBridge });
  });

  it("a 1 is still off-brief on the relaxed floor: the relaxation moved the line by one point, it did not remove it", async () => {
    const one = await judge({ ...DEEL_07G, score: 1 }, relevanceFloor(true));
    expect(one).toMatchObject({ status: "off-brief", score: 1, missingBridge: DEEL_07G.missingBridge });
  });

  it("a thinly-grounded 2 with NO bridge still passes on the relaxed reason, untouched", async () => {
    const floor = relevanceFloor(true);
    const two = await judge({ score: 2, reason: "this field, not this business" }, floor);
    expect(two).toMatchObject({ status: "relevant", score: 2, note: floor.relaxedReason });
  });
});

describe("the rubric was NOT changed to solicit more bridges", () => {
  it("the output contract still tells the judge to omit a bridge at 3 or above, which is what bounds the cost of this change", async () => {
    const { RELEVANCE_OUTPUT_FIELDS } = await import("../src/workflow/relevance-gate.js");
    const field = RELEVANCE_OUTPUT_FIELDS.find((f) => f.name === "missingBridge");
    expect(field?.description).toMatch(/Omit when the score is 3 or higher/);
    // A bridge at the floor is therefore a sentence the judge VOLUNTEERED
    // against its instruction. If this assertion is ever relaxed, the floor has
    // effectively become 4 and `relevance-gate.ts`'s argument for a lenient
    // floor has to be re-made.
  });
});
