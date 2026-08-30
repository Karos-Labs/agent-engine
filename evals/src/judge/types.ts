import { z } from "zod";
import type { ModelPolicy } from "@agent-engine/core";
import { EvalLanguageSchema, type EvalLanguage } from "../language.js";

/**
 * The craft-quality dimensions RFC-01 §12 bullet 3 names ("brand voice
 * fidelity, hook strength, platform-convention adherence"), plus
 * `languageFidelity`.
 *
 * `languageFidelity` is not in the RFC's list and is added here deliberately:
 * the AU32 incident's root cause 1 was recorded as "no language dimension
 * existed anywhere in the QA chain", and a rubric that repeats that omission
 * would make the same failure unmeasurable at the judged rung too. The
 * deterministic script check (`checkLanguageFidelity`) covers "wrong language
 * entirely"; this dimension covers what a script count cannot see — a draft
 * in the right alphabet that reads as machine translation.
 */
export const RUBRIC_DIMENSIONS = ["languageFidelity", "brandVoiceFidelity", "hookStrength", "platformConvention"] as const;
export type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number];

/** One 1–5 score per dimension. Integers only: a judge that answers 3.5 is hedging, and the anchors are written for whole steps. */
export const JudgeScoresSchema = z.object({
  languageFidelity: z.number().int().min(1).max(5),
  brandVoiceFidelity: z.number().int().min(1).max(5),
  hookStrength: z.number().int().min(1).max(5),
  platformConvention: z.number().int().min(1).max(5),
});
export type JudgeScores = z.infer<typeof JudgeScoresSchema>;

/**
 * What the judge model is required to return. This is the `schema` handed to
 * `ModelRouter.complete`, so the router's structured-output mechanism enforces
 * it at the provider boundary — a judge that free-texts its answer fails the
 * call rather than producing an unparseable "score".
 */
export const JudgeVerdictSchema = z.object({
  scores: JudgeScoresSchema,
  /** Why, in one paragraph. Required: an unexplained score cannot be argued with, and a rubric nobody can argue with stops being maintained. */
  rationale: z.string().min(1),
  /** Specific defects worth naming, e.g. "English hashtags on a Hebrew post". Empty is a valid answer. */
  flags: z.array(z.string()).default([]),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

/** One thing to be graded. Deliberately not tied to `GoldenRun`: production samples (rung 6) are graded on the same rubric. */
export interface JudgeCase {
  caseId: string;
  agentId: string;
  clientId: string;
  language: EvalLanguage;
  /** The channel this output is for — "linkedin", "instagram", … Fed to the judge so `platformConvention` means something concrete. */
  platform: string;
  /** The text under evaluation. */
  output: string;
  /** A human-endorsed output for the same input, when one exists. Absent for production samples, present for golden runs. */
  reference?: string;
  /** The client's own voice rules, as the drafting step received them. */
  brandRules?: { forbiddenTerms?: readonly string[]; tone?: string };
  /** Anything else the judge should know (the revision feedback a reviewer left, for a production sample). */
  notes?: string;
}

export const JudgeCaseSchema = z.object({
  caseId: z.string().min(1),
  agentId: z.string().min(1),
  clientId: z.string().min(1),
  language: EvalLanguageSchema,
  platform: z.string().min(1),
  output: z.string().min(1),
  reference: z.string().min(1).optional(),
  brandRules: z.object({ forbiddenTerms: z.array(z.string()).optional(), tone: z.string().optional() }).optional(),
  notes: z.string().min(1).optional(),
});

/**
 * Where "good enough" is, per dimension and overall.
 *
 * `perDimension` overrides `minPerDimension` for individual dimensions.
 * `languageFidelity` is raised above the floor by `DEFAULT_JUDGE_THRESHOLDS`
 * because a 3 there ("recognizably the right language, but reads translated")
 * is exactly the outcome AU32 shipped, and a threshold that passes it makes
 * the dimension decorative.
 */
export interface JudgeThresholds {
  minOverall: number;
  minPerDimension: number;
  perDimension?: Partial<Record<RubricDimension, number>>;
}

export const DEFAULT_JUDGE_THRESHOLDS: JudgeThresholds = {
  minOverall: 3.5,
  minPerDimension: 3,
  perDimension: { languageFidelity: 4 },
};

/**
 * The judge model.
 *
 * `pinned`: RFC-01 §5.4's own example of a pinned step is "the self-critique
 * gate", and a judge has the same property — a score is only comparable
 * across time if the thing producing it did not silently swap models between
 * runs. A judge that fell back to a cheaper model on a transient error would
 * produce a quality delta indistinguishable from a real regression, which is
 * the one thing this whole ladder exists to prevent.
 */
export const DEFAULT_JUDGE_POLICY: ModelPolicy = { policy: "pinned", model: "claude-opus-4-8" };

export interface RubricJudgeResult {
  caseId: string;
  language: EvalLanguage;
  verdict: JudgeVerdict;
  /** Unweighted mean of the four dimensions, rounded to 2dp. */
  overall: number;
  passed: boolean;
  /** Which dimensions came in under their threshold, in `RUBRIC_DIMENSIONS` order. Empty when `passed`. */
  failedDimensions: RubricDimension[];
  thresholds: JudgeThresholds;
  modelUsed: string;
  inputTokens: { cached: number; uncached: number };
  outputTokens: number;
  /** Priced through `@agent-engine/core`'s own `computeStepCostUsd`, so a judged run's cost is comparable with every other row in `agent_runs_bi`. */
  costUsd: number;
  durationMs: number;
  /** Present only when the judge call went through a fallback hop — see `CostAndTokenAttributes.servedByHop`. */
  servedByHop?: string;
  servingAdapter?: string;
}
