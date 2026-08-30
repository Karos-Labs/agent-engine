import { z } from "zod";
import { EvalLanguageSchema } from "../language.js";
import { RUBRIC_DIMENSIONS } from "../judge/types.js";
import type { EvalScore } from "../scoring/eval-score.js";

/**
 * The columns of `bi_telemetry.agent_runs_bi`, in the order
 * `packages/telemetry/src/span-helpers.ts` writes them.
 *
 * ## This list is checked, not trusted
 *
 * It is pinned to `scripts/check-bq-insert-schema.ts`'s `insertRowFields()`
 * by `evals/__tests__/agent-runs-bi-schema-pin.test.ts`, which parses the real
 * insert literal out of `span-helpers.ts` and asserts set equality both ways.
 * Add a column to the engine's insert and forget this file, or edit this file
 * and forget the engine, and that test fails naming the field.
 *
 * The pin lives in a test rather than in this module because `evals/`'s
 * `tsconfig.json` sets `rootDir: "src"`: `src/` cannot import
 * `../../scripts/*`, and a build-time read of a file outside the package
 * would break the moment `dist/` is what runs. Tests have no such
 * restriction, which is why the drift check is a test and the list is a
 * constant.
 *
 * ## Why a list exists here at all
 *
 * Because the fake this file feeds (`InMemoryAgentRunsBiTable`) has to be able
 * to REJECT a wrong row, and the production insert deliberately cannot. That
 * insert runs with `ignoreUnknownValues: true`, which is how `operation`,
 * `jobId`, `stepId` and `source` were dropped on every insert for months
 * (see the header of `check-bq-insert-schema.ts`). A fake that reproduced that
 * tolerance faithfully would accept a malformed row and prove nothing.
 */
export const AGENT_RUNS_BI_COLUMNS = [
  "runId",
  "clientId",
  "agentId",
  "model",
  "inputTokens",
  "outputTokens",
  "costUsd",
  "durationMs",
  "status",
  "errorDetails",
  "timestamp",
  "operation",
  "servedByHop",
  "servingAdapter",
  "jobId",
  "stepId",
  "source",
] as const;
export type AgentRunsBiColumn = (typeof AGENT_RUNS_BI_COLUMNS)[number];

/** ISO 8601 with a timezone — what `new Date().toISOString()` produces, and what the engine's own insert writes into `timestamp`. */
const IsoTimestamp = z.string().refine((v) => !Number.isNaN(Date.parse(v)) && /\dT\d/.test(v), {
  message: "must be an ISO 8601 timestamp",
});

const NullableString = z.string().nullable();

/**
 * The row shape `agent_runs_bi` actually accepts.
 *
 * `.strict()` on purpose: an unknown key is an error here even though the live
 * table would silently discard it. Nullability mirrors the engine's own row
 * literal exactly — the five columns it writes `?? null` into are nullable,
 * and the ones it always populates are not. `NUMERIC`/`INTEGER` columns reject
 * a string in BigQuery too, so the numeric types below are a real constraint
 * and not decoration.
 */
export const AgentRunsBiRowSchema = z
  .object({
    runId: z.string().min(1),
    clientId: z.string().min(1),
    agentId: z.string().min(1),
    model: z.string().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    status: z.string().min(1),
    errorDetails: NullableString,
    timestamp: IsoTimestamp,
    operation: NullableString,
    servedByHop: NullableString,
    servingAdapter: NullableString,
    jobId: NullableString,
    stepId: NullableString,
    source: z.string().min(1),
  })
  .strict();
export type AgentRunsBiRow = z.infer<typeof AgentRunsBiRowSchema>;

/** `agent_runs_bi.operation` for a row written by the eval ladder's rubric judge. */
export const EVAL_OPERATION = "eval_rubric_judge";
/** `agent_runs_bi.source` — every row this repo writes is engine-originated; the portal stamps its own rows "portal". */
export const EVAL_ROW_SOURCE = "agent-engine";

const DIMENSION_SCORES = Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, z.number().int().min(1).max(5)])) as {
  [K in (typeof RUBRIC_DIMENSIONS)[number]]: z.ZodNumber;
};

/**
 * What travels in `errorDetails`.
 *
 * ## Why `errorDetails`, which is not an error
 *
 * `agent_runs_bi` HAS NO SCORE COLUMN. SCRUM-308 is explicit that the eval
 * ladder must persist into this table and must not invent a new one, and of
 * its seventeen columns exactly one is free text: `errorDetails`, which the
 * engine writes `null` into on every row it has ever written. So the rubric
 * detail goes there, versioned, as JSON, and `status` carries the verdict in
 * a form a `GROUP BY` can read without parsing anything.
 *
 * This is a compromise and is recorded as one — see the ticket report's
 * findings. The honest shape is a `score` column (or a sibling table); until
 * one exists, a reader who does not know about this encoding sees eval rows
 * with a populated `errorDetails` and could reasonably read them as failures.
 * `schema` is the first key so that anything parsing the column can tell an
 * eval payload from a real error string before it tries.
 */
export const PersistedEvalDetailSchema = z.object({
  schema: z.literal("eval-score/v1"),
  goldenRunId: z.string().min(1),
  language: EvalLanguageSchema,
  verdict: z.enum(["pass", "fail"]),
  overall: z.number(),
  scores: z.object(DIMENSION_SCORES),
  failedDimensions: z.array(z.string()),
  failureReasons: z.array(z.string()),
  judgeRationale: z.string(),
  judgeFlags: z.array(z.string()),
  languageScriptShare: z.number(),
  deterministic: z.array(z.object({ name: z.string(), verdict: z.string() })),
});
export type PersistedEvalDetail = z.infer<typeof PersistedEvalDetailSchema>;

/** `eval_pass` / `eval_fail` — prefixed so an eval row is never confused with a drafting run's `completed`/`failed`. */
export function evalRowStatus(verdict: EvalScore["verdict"]): string {
  return verdict === "pass" ? "eval_pass" : "eval_fail";
}

export function buildEvalDetail(score: EvalScore): PersistedEvalDetail {
  return {
    schema: "eval-score/v1",
    goldenRunId: score.goldenRunId,
    language: score.language,
    verdict: score.verdict,
    overall: score.judge.overall,
    scores: score.judge.verdict.scores,
    failedDimensions: [...score.judge.failedDimensions],
    failureReasons: [...score.failureReasons],
    judgeRationale: score.judge.verdict.rationale,
    judgeFlags: [...score.judge.verdict.flags],
    languageScriptShare: score.languageFidelity.scriptShare,
    deterministic: score.deterministic.map((c) => ({ name: c.name, verdict: c.verdict })),
  };
}

/**
 * One `EvalScore` as one `agent_runs_bi` row.
 *
 * The token/cost/duration columns describe the JUDGE call, not the agent run
 * being graded — the judge is what this row's model actually spent, and
 * RFC-01 §12's closing paragraph ("read the score and the dollar delta") only
 * works if the cost of grading is itself in the same table as everything else.
 * `stepId` is `<goldenRunId>:<language>` so the per-language runs of one golden
 * run are separable, which is the whole point of rung 4.
 */
export function evalScoreToAgentRunsBiRow(score: EvalScore): AgentRunsBiRow {
  return AgentRunsBiRowSchema.parse({
    runId: score.evalRunId,
    clientId: score.clientId,
    agentId: score.agentId,
    model: score.judge.modelUsed,
    inputTokens: score.judge.inputTokens.cached + score.judge.inputTokens.uncached,
    outputTokens: score.judge.outputTokens,
    costUsd: score.judge.costUsd,
    durationMs: score.judge.durationMs,
    status: evalRowStatus(score.verdict),
    errorDetails: JSON.stringify(buildEvalDetail(score)),
    timestamp: score.startedAt,
    operation: EVAL_OPERATION,
    servedByHop: score.judge.servedByHop ?? null,
    servingAdapter: score.judge.servingAdapter ?? null,
    jobId: score.evalSuiteRunId,
    stepId: `${score.goldenRunId}:${score.language}`,
    source: EVAL_ROW_SOURCE,
  });
}

/** Reads the rubric detail back out of a row. Throws on a row whose `errorDetails` is not an eval payload. */
export function parseEvalDetail(row: AgentRunsBiRow): PersistedEvalDetail {
  if (row.errorDetails === null) {
    throw new Error(`agent_runs_bi row ${row.runId} has no errorDetails payload — it is not an eval row`);
  }
  return PersistedEvalDetailSchema.parse(JSON.parse(row.errorDetails));
}
