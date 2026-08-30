import { vi } from "vitest";
import type { CompletionResult, ModelRouter } from "@agent-engine/core";
import type { JudgeScores, JudgeVerdict } from "../src/judge/types.js";

/**
 * A judge router whose `complete()` replays a fixed sequence of turns.
 *
 * Same shape as every agent's own `fakeRouterSequence`
 * (`agents/linkedin-agent/__tests__/test-helpers.ts` and its eight siblings):
 * an object literal with `complete`/`completeAlias`, cast to `ModelRouter`.
 * That is this repo's established way to stub a model call, and CI has no live
 * model — SCRUM-308 requires the judge to be stubbable "the way this repo's
 * existing tests stub model calls", so this deliberately does not invent a
 * second mechanism.
 *
 * Unlike the agents' version the turns here return the judge verdict directly
 * rather than a `{ type: "final", output }` envelope: `runRubricJudge` calls
 * `router.complete` itself, so nothing is unwrapping a ReAct turn.
 */
export function fakeJudgeRouter(turns: Array<() => CompletionResult<unknown>>): ModelRouter {
  const queue = [...turns];
  return {
    complete: vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error("fakeJudgeRouter: exhausted configured turns");
      return next();
    }),
    completeAlias: vi.fn(async () => {
      throw new Error("fakeJudgeRouter: completeAlias is not used by the rubric judge");
    }),
  } as unknown as ModelRouter;
}

export interface JudgeTurnOptions {
  rationale?: string;
  flags?: string[];
  model?: string;
  inputTokensCached?: number;
  inputTokensUncached?: number;
  outputTokens?: number;
  /** Overrides the whole verdict payload, for the "a judge that returns nonsense must not reach BigQuery" case. */
  rawOutput?: unknown;
}

/** One judge turn returning the given 1-5 scores. */
export function judgeTurn(scores: JudgeScores, opts: JudgeTurnOptions = {}): () => CompletionResult<unknown> {
  const verdict: JudgeVerdict = {
    scores,
    rationale: opts.rationale ?? "Scored against the rubric anchors.",
    flags: opts.flags ?? [],
  };
  return () => ({
    output: opts.rawOutput !== undefined ? opts.rawOutput : verdict,
    modelUsed: opts.model ?? "claude-opus-4-8",
    inputTokens: { cached: opts.inputTokensCached ?? 0, uncached: opts.inputTokensUncached ?? 1_200 },
    outputTokens: opts.outputTokens ?? 180,
  });
}

/** Every dimension at the same score — the shortest way to write "clearly passing" or "clearly failing". */
export function flatScores(value: 1 | 2 | 3 | 4 | 5): JudgeScores {
  return { languageFidelity: value, brandVoiceFidelity: value, hookStrength: value, platformConvention: value };
}
