import type { ModelRouter } from "@agent-engine/core";
import {
  buildEvalScore,
  checkLanguageFidelity,
  evalScoreToAgentRunsBiRow,
  runRubricJudge,
  type AgentRunsBiRow,
  type AgentRunsBiSink,
  type EvalCheckResult,
  type EvalScore,
  type JudgeCase,
  type RubricJudgeOptions,
} from "@agent-engine/evals";
import { runLinkedInDeterministicAssertions } from "./run-assertions.js";
import type { LinkedInGoldenRun } from "./types.js";

export interface LinkedInJudgeLadderOptions {
  /** The judge model's router. Stubbed in CI exactly as every agent test stubs a model call — see `linkedin-judge-ladder.test.ts`. */
  router: ModelRouter;
  /** Where the score lands. `InMemoryAgentRunsBiTable` in CI, `BigQueryAgentRunsBiSink` in an environment with a credential. */
  sink: AgentRunsBiSink;
  /** Identifies this whole ladder invocation; becomes `agent_runs_bi.jobId`, shared by every case in the suite. */
  evalSuiteRunId: string;
  /** ISO timestamp for the row. Injected so a persisted row is assertable. */
  startedAt?: string;
  judge?: RubricJudgeOptions;
}

export interface LinkedInLadderCaseResult {
  score: EvalScore;
  row: AgentRunsBiRow;
}

/** The client this golden run was endorsed for. `input.clientSlug` is where every LinkedIn fixture states it. */
function clientIdOf(goldenRun: LinkedInGoldenRun): string {
  const slug = goldenRun.input["clientSlug"];
  return typeof slug === "string" && slug.length > 0 ? slug : "eval";
}

/** The voice rules as the drafting step received them, so the judge grades against the same brand rules the agent was given. */
function brandRulesOf(goldenRun: LinkedInGoldenRun): JudgeCase["brandRules"] {
  const voiceRules = goldenRun.input["voiceRules"];
  const tone = typeof voiceRules === "object" && voiceRules !== null ? (voiceRules as Record<string, unknown>)["tone"] : undefined;
  const forbiddenTerms = goldenRun.gateArgs.brandCompliance?.forbiddenTerms;
  if (typeof tone !== "string" && forbiddenTerms === undefined) return undefined;
  return {
    ...(typeof tone === "string" ? { tone } : {}),
    ...(forbiddenTerms !== undefined ? { forbiddenTerms } : {}),
  };
}

export function buildLinkedInJudgeCase(goldenRun: LinkedInGoldenRun, output?: string): JudgeCase {
  const brandRules = brandRulesOf(goldenRun);
  return {
    caseId: `${goldenRun.id}:${goldenRun.language}`,
    agentId: goldenRun.agentId,
    clientId: clientIdOf(goldenRun),
    language: goldenRun.language,
    platform: goldenRun.endorsedOutput.platform,
    output: output ?? goldenRun.endorsedOutput.text,
    // No `reference` when the thing under evaluation IS the endorsed output:
    // handing the judge the same text twice and calling one of them a
    // reference invites it to score the comparison rather than the copy.
    ...(output !== undefined && output !== goldenRun.endorsedOutput.text ? { reference: goldenRun.endorsedOutput.text } : {}),
    ...(brandRules !== undefined ? { brandRules } : {}),
  };
}

/**
 * One golden run, all the way up the ladder: deterministic gate assertions
 * (rung 2) → deterministic language fidelity + model-graded rubric (rungs 3
 * and 4) → one combined score → one `bi_telemetry.agent_runs_bi` row
 * (rung 5), inserted and returned.
 *
 * `output` overrides the text being graded, defaulting to the endorsed output.
 * That parameter is what lets the same ladder grade a REGRESSION — feed the
 * English post as the Hebrew client's output and the language rungs report
 * exactly the AU32 failure, with a persisted row saying so — and it is also
 * the hook a future caller that actually executes the agent plugs into, with
 * no other change to this function.
 */
export async function runLinkedInJudgeLadder(
  goldenRun: LinkedInGoldenRun,
  opts: LinkedInJudgeLadderOptions,
  output?: string,
): Promise<LinkedInLadderCaseResult> {
  const graded = output ?? goldenRun.endorsedOutput.text;

  const assertions = await runLinkedInDeterministicAssertions(
    output === undefined ? goldenRun : { ...goldenRun, endorsedOutput: { ...goldenRun.endorsedOutput, text: graded } },
  );
  const deterministic: EvalCheckResult[] = assertions.map((a) => ({
    name: a.check,
    verdict: a.verdict,
    ...(a.reason !== undefined ? { reason: a.reason } : {}),
  }));

  const languageFidelity = checkLanguageFidelity(graded, goldenRun.language);
  const judge = await runRubricJudge(opts.router, buildLinkedInJudgeCase(goldenRun, output), opts.judge ?? {});

  const score = buildEvalScore({
    evalRunId: `${opts.evalSuiteRunId}:${goldenRun.id}:${goldenRun.language}`,
    evalSuiteRunId: opts.evalSuiteRunId,
    goldenRunId: goldenRun.id,
    agentId: goldenRun.agentId,
    clientId: clientIdOf(goldenRun),
    language: goldenRun.language,
    deterministic,
    languageFidelity,
    judge,
    startedAt: opts.startedAt ?? new Date().toISOString(),
  });

  const row = evalScoreToAgentRunsBiRow(score);
  await opts.sink.insert([row]);
  return { score, row };
}

/**
 * Every golden run in the suite, one per language, graded in order.
 *
 * Sequential rather than `Promise.all`: the judge is a `pinned` model call
 * per case, and firing the whole suite at a provider at once is how an eval
 * run becomes the thing that rate-limits production.
 */
export async function runLinkedInJudgeLadderSuite(
  goldenRuns: readonly LinkedInGoldenRun[],
  opts: LinkedInJudgeLadderOptions,
): Promise<LinkedInLadderCaseResult[]> {
  const results: LinkedInLadderCaseResult[] = [];
  for (const goldenRun of goldenRuns) {
    results.push(await runLinkedInJudgeLadder(goldenRun, opts));
  }
  return results;
}
