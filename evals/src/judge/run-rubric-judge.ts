import { computeStepCostUsd, type ModelPolicy, type ModelRouter } from "@agent-engine/core";
import { buildJudgePrompt, JUDGE_SYSTEM_PROMPT } from "./rubric.js";
import {
  DEFAULT_JUDGE_POLICY,
  DEFAULT_JUDGE_THRESHOLDS,
  JudgeVerdictSchema,
  RUBRIC_DIMENSIONS,
  type JudgeCase,
  type JudgeScores,
  type JudgeThresholds,
  type RubricDimension,
  type RubricJudgeResult,
} from "./types.js";

export interface RubricJudgeOptions {
  policy?: ModelPolicy;
  thresholds?: JudgeThresholds;
  /** Injected clock, so a persisted `durationMs` is assertable rather than whatever the machine happened to take. */
  now?: () => number;
  maxTokens?: number;
}

/** Unweighted mean of the four dimensions, rounded to 2dp. */
export function overallScore(scores: JudgeScores): number {
  const total = RUBRIC_DIMENSIONS.reduce((sum, dimension) => sum + scores[dimension], 0);
  return Math.round((total / RUBRIC_DIMENSIONS.length) * 100) / 100;
}

/** The threshold this dimension must clear: its own override if it has one, otherwise the shared floor. */
export function thresholdFor(dimension: RubricDimension, thresholds: JudgeThresholds): number {
  return thresholds.perDimension?.[dimension] ?? thresholds.minPerDimension;
}

/** Dimensions scoring under their threshold, in `RUBRIC_DIMENSIONS` order. */
export function failedDimensions(scores: JudgeScores, thresholds: JudgeThresholds): RubricDimension[] {
  return RUBRIC_DIMENSIONS.filter((dimension) => scores[dimension] < thresholdFor(dimension, thresholds));
}

/**
 * Rung 3 of the eval ladder (RFC-01 §12 bullet 3): a strong judge model scores
 * one output against the fixed rubric.
 *
 * ## Why this takes a `ModelRouter` rather than calling a provider
 *
 * Same reason every agent does (RFC-01 §5.4): nothing here picks a provider,
 * and — the operative reason for an eval harness specifically — it makes the
 * judge stubbable by exactly the mechanism this repo's tests already use for
 * model calls. Every agent's own `__tests__/test-helpers.ts` builds a
 * `fakeRouterSequence(...)` object with `complete`/`completeAlias` and passes
 * it in; a judge wired to a provider client instead would have needed its own
 * bespoke mocking, and CI has no live model. See
 * `evals/__tests__/rubric-judge.test.ts`.
 *
 * ## What it does not do
 *
 * It does not retry, and it does not swallow a judge failure into a neutral
 * score. A judge call that throws propagates: a "3 out of 5 because the judge
 * was unreachable" row is worse than no row, because it is indistinguishable
 * from a real mediocre score once it is in BigQuery.
 */
export async function runRubricJudge(router: ModelRouter, judgeCase: JudgeCase, opts: RubricJudgeOptions = {}): Promise<RubricJudgeResult> {
  const policy = opts.policy ?? DEFAULT_JUDGE_POLICY;
  const thresholds = opts.thresholds ?? DEFAULT_JUDGE_THRESHOLDS;
  const now = opts.now ?? (() => Date.now());

  const startedAt = now();
  const completion = await router.complete(buildJudgePrompt(judgeCase), JudgeVerdictSchema, policy, {
    system: JUDGE_SYSTEM_PROMPT,
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
  });
  const durationMs = now() - startedAt;

  // Parsed again on the way out rather than trusted. `ModelRouter.complete` is
  // typed by the schema it is handed, but a stubbed or mis-wired router can
  // return anything at all, and an out-of-range "score" that reaches BigQuery
  // is a number nobody can later tell from a real one.
  const verdict = JudgeVerdictSchema.parse(completion.output);
  const overall = overallScore(verdict.scores);
  const failed = failedDimensions(verdict.scores, thresholds);

  return {
    caseId: judgeCase.caseId,
    language: judgeCase.language,
    verdict,
    overall,
    passed: failed.length === 0 && overall >= thresholds.minOverall,
    failedDimensions: failed,
    thresholds,
    modelUsed: completion.modelUsed,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
    costUsd: computeStepCostUsd(completion.modelUsed, completion.inputTokens, completion.outputTokens),
    durationMs,
    // Absent means primary — the same convention `CostAndTokenAttributes`
    // documents, so a judged row's hop columns read identically to a
    // drafting step's.
    ...(completion.provenance && completion.provenance.hop !== "primary"
      ? { servedByHop: completion.provenance.hop, servingAdapter: completion.provenance.servedBy }
      : {}),
  };
}
