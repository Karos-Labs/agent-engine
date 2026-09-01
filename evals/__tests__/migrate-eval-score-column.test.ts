import { describe, expect, it } from "vitest";
import { insertRowFields } from "../../scripts/check-bq-insert-schema.js";
import { checkLanguageFidelity } from "../src/language.js";
import { runRubricJudge } from "../src/judge/run-rubric-judge.js";
import { buildEvalScore, type EvalScore } from "../src/scoring/eval-score.js";
import { AgentRunsBiRowSchema, buildEvalDetail, EVAL_OPERATION, EVAL_ROW_SOURCE, evalRowStatus, parseEvalDetail, type AgentRunsBiRow } from "../src/persistence/agent-runs-bi-row.js";
import { InMemoryAgentRunsBiTable } from "../src/persistence/in-memory-agent-runs-bi.js";
import { buildBackfillUpdateSql, isLegacyEncodedEvalRow, migrateLegacyEvalRow, type LegacyEncodedEvalRow } from "../src/persistence/migrate-eval-score-column.js";
import { fakeJudgeRouter, flatScores, judgeTurn } from "./judge-test-helpers.js";

/**
 * SCRUM-385's backfill, tested against a fake — this environment has no
 * BigQuery credential (see EXEC-CONTEXT-ENGINE.md), so the real UPDATE in
 * `scripts/migrate-eval-score-column.sql` has NOT been executed. What is
 * tested here is that the transform is correct and that the SQL generated
 * for a human to run matches it.
 */

async function makeScore(): Promise<EvalScore> {
  const text = "We looked at attendance data across our hybrid client base this quarter.";
  const judge = await runRubricJudge(fakeJudgeRouter([judgeTurn(flatScores(4))]), {
    caseId: "linkedin-post-hybrid-anchor-days-en:en",
    agentId: "linkedin-agent",
    clientId: "geektime-like",
    language: "en",
    platform: "linkedin",
    output: text,
  });

  return buildEvalScore({
    evalRunId: "suite-2026-08-01:linkedin-post-hybrid-anchor-days-en:en",
    evalSuiteRunId: "suite-2026-08-01",
    goldenRunId: "linkedin-post-hybrid-anchor-days-en",
    agentId: "linkedin-agent",
    clientId: "geektime-like",
    language: "en",
    deterministic: [{ name: "gate.lintPost", verdict: "pass" }],
    languageFidelity: checkLanguageFidelity(text, "en"),
    judge,
    startedAt: "2026-08-01T09:00:00.000Z",
  });
}

/**
 * Builds a row exactly as SCRUM-308's writer produced it, BEFORE SCRUM-385:
 * the rubric JSON in `errorDetails`, `evalScore`/`evalRubricDetail` absent
 * from the table (represented here as null, which is what an old row reads
 * back as once STEP 1 of the migration has added the columns — a column
 * added to an existing table is NULL on every pre-existing row).
 */
async function legacyEncodedRow(): Promise<AgentRunsBiRow> {
  const score = await makeScore();
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
    errorDetails: JSON.stringify(buildEvalDetail(score)), // the SCRUM-308 encoding
    evalScore: null, // column exists post-STEP-1, unpopulated pre-backfill
    evalRubricDetail: null,
    timestamp: score.startedAt,
    operation: EVAL_OPERATION,
    servedByHop: score.judge.servedByHop ?? null,
    servingAdapter: score.judge.servingAdapter ?? null,
    jobId: score.evalSuiteRunId,
    stepId: `${score.goldenRunId}:${score.language}`,
    source: EVAL_ROW_SOURCE,
  });
}

/** `legacyEncodedRow()` always has a populated `errorDetails` by construction — narrows the type for `migrateLegacyEvalRow`, which requires that statically. */
function asLegacy(row: AgentRunsBiRow): LegacyEncodedEvalRow {
  if (row.errorDetails === null) throw new Error("test fixture is not legacy-encoded — errorDetails is null");
  return { runId: row.runId, operation: row.operation, errorDetails: row.errorDetails };
}

describe("migrateLegacyEvalRow", () => {
  it("moves the score and rubric detail out of errorDetails, losing nothing", async () => {
    const legacy = await legacyEncodedRow();
    const detailBefore = parseEvalDetail({ ...legacy, evalRubricDetail: legacy.errorDetails } as AgentRunsBiRow);

    const migrated = migrateLegacyEvalRow(asLegacy(legacy));

    expect(migrated.errorDetails).toBeNull();
    expect(migrated.evalRubricDetail).toBe(legacy.errorDetails);
    expect(migrated.evalScore).toBe(detailBefore.overall);

    // Reconstructing the row as the real UPDATE would leave it, and
    // re-validating against the live schema, is the closest this environment
    // can get to "ran the backfill" without a BigQuery credential.
    const updated = AgentRunsBiRowSchema.parse({ ...legacy, ...migrated });
    expect(updated.errorDetails).toBeNull();
    const detailAfter = parseEvalDetail(updated);
    expect(detailAfter).toEqual(detailBefore);
  });

  it("throws rather than silently skipping a row whose errorDetails does not parse as the claimed encoding", () => {
    expect(() => migrateLegacyEvalRow({ runId: "r1", operation: EVAL_OPERATION, errorDetails: "not json" })).toThrow();
    expect(() => migrateLegacyEvalRow({ runId: "r1", operation: EVAL_OPERATION, errorDetails: JSON.stringify({ schema: "eval-score/v2" }) })).toThrow();
  });
});

describe("isLegacyEncodedEvalRow", () => {
  it("is true for a row written under the old encoding", async () => {
    expect(isLegacyEncodedEvalRow(await legacyEncodedRow())).toBe(true);
  });

  it("is false for a row already migrated (errorDetails null)", async () => {
    const legacy = await legacyEncodedRow();
    const migrated = migrateLegacyEvalRow(asLegacy(legacy));
    expect(isLegacyEncodedEvalRow({ ...legacy, ...migrated })).toBe(false);
  });

  it("is false for a non-eval row, even with a populated errorDetails", () => {
    expect(isLegacyEncodedEvalRow({ operation: "drafting_step", errorDetails: JSON.stringify({ schema: "eval-score/v1" }) })).toBe(false);
  });

  it("is false for an eval-operation row whose errorDetails is not the eval payload (a real error string, say)", () => {
    expect(isLegacyEncodedEvalRow({ operation: EVAL_OPERATION, errorDetails: "ECONNRESET" })).toBe(false);
  });

  it("is false for a row with no errorDetails at all", () => {
    expect(isLegacyEncodedEvalRow({ operation: EVAL_OPERATION, errorDetails: null })).toBe(false);
  });
});

describe("buildBackfillUpdateSql", () => {
  it("targets the given project/dataset and encodes the exact transform migrateLegacyEvalRow performs", () => {
    const sql = buildBackfillUpdateSql({ projectId: "karoscmo-prep" });
    expect(sql).toContain("UPDATE `karoscmo-prep.bi_telemetry.agent_runs_bi`");
    expect(sql).toContain("evalScore = CAST(JSON_VALUE(errorDetails, '$.overall') AS NUMERIC)");
    expect(sql).toContain("evalRubricDetail = errorDetails");
    expect(sql).toContain("errorDetails = NULL");
    expect(sql).toContain(`WHERE operation = '${EVAL_OPERATION}'`);
    expect(sql).toContain("AND errorDetails IS NOT NULL");
    expect(sql).toContain("AND JSON_VALUE(errorDetails, '$.schema') = 'eval-score/v1'");
  });

  it("qualifies with a custom dataset when one is given", () => {
    const sql = buildBackfillUpdateSql({ projectId: "karoscmo", datasetId: "bi_telemetry_test" });
    expect(sql).toContain("UPDATE `karoscmo.bi_telemetry_test.agent_runs_bi`");
  });
});

/**
 * End-to-end against the fake: a legacy row goes in, the migration runs, and
 * what comes back out through the real read path is indistinguishable from a
 * row `evalScoreToAgentRunsBiRow` would have written directly.
 */
describe("the migration end to end, against InMemoryAgentRunsBiTable", () => {
  it("a migrated row is schema-valid and its score/detail read back exactly as before migrating", async () => {
    const table = new InMemoryAgentRunsBiTable(insertRowFields());
    const legacy = await legacyEncodedRow();
    await table.insert([legacy]);

    const [stored] = await table.query({ runId: legacy.runId });
    expect(stored).toBeDefined();
    expect(isLegacyEncodedEvalRow(stored!)).toBe(true);

    const migratedFields = migrateLegacyEvalRow(asLegacy(stored!));
    const migratedRow = AgentRunsBiRowSchema.parse({ ...stored, ...migratedFields });

    expect(migratedRow.errorDetails).toBeNull();
    expect(migratedRow.evalScore).toBe(migratedRow.evalScore); // sanity: present, see next assertion
    expect(typeof migratedRow.evalScore).toBe("number");
    expect(parseEvalDetail(migratedRow)).toEqual(parseEvalDetail({ ...stored, evalRubricDetail: stored!.errorDetails } as AgentRunsBiRow));
    expect(isLegacyEncodedEvalRow(migratedRow)).toBe(false);
  });
});
