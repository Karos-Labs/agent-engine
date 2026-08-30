import type { EvalLanguage, LanguageFidelityResult } from "../language.js";
import type { RubricJudgeResult } from "../judge/types.js";

/**
 * One deterministic check's outcome, in the narrowest shape both existing
 * runners already produce.
 *
 * Structural rather than an import of either `DeterministicAssertionResult`
 * (root `evals/`, keyed `gate`) or `LinkedInDeterministicAssertionResult`
 * (`agents/linkedin-agent/evals`, keyed `check` and covering `render.preview`
 * as well as the gates): the two disagree on the key name, and the scorer has
 * no business caring which. Adopting either one would have forced the other
 * agent's runner to rename its field for no reason but this file.
 */
export interface EvalCheckResult {
  name: string;
  verdict: "pass" | "content_fail" | "tooling_error";
  reason?: string;
}

export interface EvalScoreInput {
  /** Identifies this one graded case. Becomes `agent_runs_bi.runId`. */
  evalRunId: string;
  /** Identifies the whole ladder invocation this case belongs to. Becomes `agent_runs_bi.jobId`. */
  evalSuiteRunId: string;
  goldenRunId: string;
  agentId: string;
  clientId: string;
  language: EvalLanguage;
  deterministic: readonly EvalCheckResult[];
  languageFidelity: LanguageFidelityResult;
  judge: RubricJudgeResult;
  /** ISO 8601. */
  startedAt: string;
}

export interface EvalScore extends EvalScoreInput {
  verdict: "pass" | "fail";
  /** Every reason the case failed, deterministic first. Empty when `verdict` is `pass`. */
  failureReasons: string[];
}

/**
 * Combines the three rungs into one verdict.
 *
 * Order matters and is not cosmetic: deterministic checks first, then the
 * deterministic language check, then the model-graded rubric. A case that
 * fails a free check has already failed, and reading the judge's opinion of a
 * draft that is in the wrong language or contains a forbidden term is a
 * category error — the judge is being asked about craft, and craft is not the
 * problem. Every rung still RUNS (a run that stopped early would persist a row
 * with no rubric scores in it, and a score history with holes in it is a score
 * history nobody trusts); what short-circuits is the interpretation, not the
 * execution.
 */
export function buildEvalScore(input: EvalScoreInput): EvalScore {
  const failureReasons: string[] = [];

  for (const check of input.deterministic) {
    if (check.verdict !== "pass") {
      failureReasons.push(`${check.name}: ${check.verdict}${check.reason ? ` — ${check.reason}` : ""}`);
    }
  }

  if (input.languageFidelity.verdict !== "pass") {
    failureReasons.push(`language.fidelity: content_fail — ${input.languageFidelity.reason ?? "wrong language"}`);
  }

  if (!input.judge.passed) {
    const under = input.judge.failedDimensions.map((d) => `${d}=${input.judge.verdict.scores[d]}`);
    failureReasons.push(
      `judge.rubric: overall ${input.judge.overall} (min ${input.judge.thresholds.minOverall})` +
        (under.length > 0 ? `, under threshold: ${under.join(", ")}` : ""),
    );
  }

  return { ...input, verdict: failureReasons.length === 0 ? "pass" : "fail", failureReasons };
}
