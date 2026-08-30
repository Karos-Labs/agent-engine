import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertRowFields } from "../../scripts/check-bq-insert-schema.js";
import { checkLanguageFidelity } from "../src/language.js";
import { runRubricJudge } from "../src/judge/run-rubric-judge.js";
import { buildEvalScore, type EvalScore } from "../src/scoring/eval-score.js";
import {
  AGENT_RUNS_BI_COLUMNS,
  EVAL_OPERATION,
  evalScoreToAgentRunsBiRow,
  parseEvalDetail,
  type AgentRunsBiRow,
} from "../src/persistence/agent-runs-bi-row.js";
import { AgentRunsBiSchemaError, InMemoryAgentRunsBiTable } from "../src/persistence/in-memory-agent-runs-bi.js";
import { buildEvalReadBackSql } from "../src/persistence/sink.js";
import { BigQueryAgentRunsBiSink, BigQueryNotConfiguredError } from "../src/persistence/bigquery-agent-runs-bi.js";
import { fakeJudgeRouter, flatScores, judgeTurn } from "./judge-test-helpers.js";

/**
 * Rung 5 of the ladder (SCRUM-308 / AU25): a judged score reaches
 * `bi_telemetry.agent_runs_bi` and can be read back out.
 *
 * The fake is constructed from `insertRowFields()` — the field list parsed
 * out of the engine's own `table.insert(...)` literal — rather than from this
 * package's constant, so the conformance being checked here is conformance
 * to the ENGINE'S row, not to the eval package's opinion of it. A fake that
 * accepts anything proves nothing, and a fake that enforces a hand-copied
 * schema proves only that the copy is self-consistent.
 */
const HEBREW_TEXT = "בדקנו את נתוני הנוכחות אצל הלקוחות ההיברידיים שלנו ברבעון האחרון, והתבנית שהתגלתה הפתיעה אותנו.";

async function makeScore(overrides: { language?: "en" | "he"; text?: string; scores?: Parameters<typeof judgeTurn>[0] } = {}): Promise<EvalScore> {
  const language = overrides.language ?? "he";
  const text = overrides.text ?? HEBREW_TEXT;
  const judge = await runRubricJudge(fakeJudgeRouter([judgeTurn(overrides.scores ?? flatScores(5))]), {
    caseId: `linkedin-post-hybrid-anchor-days-he:${language}`,
    agentId: "linkedin-agent",
    clientId: "geektime-like",
    language,
    platform: "linkedin",
    output: text,
  });

  return buildEvalScore({
    evalRunId: `suite-2026-08-30:linkedin-post-hybrid-anchor-days-he:${language}`,
    evalSuiteRunId: "suite-2026-08-30",
    goldenRunId: "linkedin-post-hybrid-anchor-days-he",
    agentId: "linkedin-agent",
    clientId: "geektime-like",
    language,
    deterministic: [
      { name: "gate.lintPost", verdict: "pass" },
      { name: "render.preview", verdict: "pass" },
    ],
    languageFidelity: checkLanguageFidelity(text, language),
    judge,
    startedAt: "2026-08-30T09:00:00.000Z",
  });
}

describe("agent_runs_bi round trip, against a fake bound to the engine's own insert literal", () => {
  it("persists a judged score and reads the same row back out", async () => {
    const table = new InMemoryAgentRunsBiTable(insertRowFields());
    const score = await makeScore();

    await table.insert([evalScoreToAgentRunsBiRow(score)]);

    const readBack = await table.query({ jobId: "suite-2026-08-30", operation: EVAL_OPERATION });
    expect(readBack).toHaveLength(1);

    const row = readBack[0]!;
    expect(row.runId).toBe("suite-2026-08-30:linkedin-post-hybrid-anchor-days-he:he");
    expect(row.agentId).toBe("linkedin-agent");
    expect(row.clientId).toBe("geektime-like");
    expect(row.status).toBe("eval_pass");
    // The per-language discriminator: two languages of one golden run are two
    // separable rows, which is the whole point of rung 4.
    expect(row.stepId).toBe("linkedin-post-hybrid-anchor-days-he:he");
    expect(row.source).toBe("agent-engine");
    expect(row.model).toBe("claude-opus-4-8");
    expect(row.inputTokens).toBe(1_200);
    expect(row.timestamp).toBe("2026-08-30T09:00:00.000Z");
  });

  it("reads the rubric scores back out of the persisted row, not just the row's identity", async () => {
    const table = new InMemoryAgentRunsBiTable(insertRowFields());
    await table.insert([evalScoreToAgentRunsBiRow(await makeScore())]);

    const detail = parseEvalDetail((await table.query({ jobId: "suite-2026-08-30" }))[0]!);
    expect(detail.schema).toBe("eval-score/v1");
    expect(detail.language).toBe("he");
    expect(detail.verdict).toBe("pass");
    expect(detail.scores).toEqual(flatScores(5));
    expect(detail.overall).toBe(5);
    expect(detail.languageScriptShare).toBe(1);
    expect(detail.deterministic.map((d) => d.name)).toEqual(["gate.lintPost", "render.preview"]);
  });

  it("keeps one golden run's two languages apart, and finds each on its own", async () => {
    const table = new InMemoryAgentRunsBiTable(insertRowFields());
    await table.insert([evalScoreToAgentRunsBiRow(await makeScore({ language: "he" }))]);
    await table.insert([evalScoreToAgentRunsBiRow(await makeScore({ language: "en", text: "We looked at attendance data." }))]);

    expect(await table.query({ jobId: "suite-2026-08-30" })).toHaveLength(2);
    const hebrewOnly = await table.query({ stepId: "linkedin-post-hybrid-anchor-days-he:he" });
    expect(hebrewOnly).toHaveLength(1);
    expect(parseEvalDetail(hebrewOnly[0]!).language).toBe("he");
  });

  it("persists a failing score as eval_fail, with the reasons readable back out", async () => {
    // An English draft graded as the Hebrew client's output: the AU32 shape.
    const table = new InMemoryAgentRunsBiTable(insertRowFields());
    const score = await makeScore({ language: "he", text: "We looked at attendance data across our hybrid client base this quarter." });
    expect(score.verdict).toBe("fail");

    await table.insert([evalScoreToAgentRunsBiRow(score)]);
    const row = (await table.query({ jobId: "suite-2026-08-30" }))[0]!;

    expect(row.status).toBe("eval_fail");
    const detail = parseEvalDetail(row);
    expect(detail.verdict).toBe("fail");
    expect(detail.failureReasons.join("\n")).toMatch(/language\.fidelity: content_fail/);
    expect(detail.languageScriptShare).toBe(0);
  });

  it("returns nothing for a query that matches nothing, rather than everything", async () => {
    const table = new InMemoryAgentRunsBiTable(insertRowFields());
    await table.insert([evalScoreToAgentRunsBiRow(await makeScore())]);
    expect(await table.query({ jobId: "some-other-suite" })).toEqual([]);
    expect(await table.query({ agentId: "instagram-agent" })).toEqual([]);
  });
});

describe("the fake rejects rows the live table would not accept", () => {
  const table = () => new InMemoryAgentRunsBiTable(insertRowFields());

  async function validRow(): Promise<AgentRunsBiRow> {
    return evalScoreToAgentRunsBiRow(await makeScore());
  }

  it("refuses an unknown column — the drift `ignoreUnknownValues: true` silently swallows in production", async () => {
    const row = { ...(await validRow()), evalScore: 4.5 } as unknown as AgentRunsBiRow;
    await expect(table().insert([row])).rejects.toThrow(AgentRunsBiSchemaError);
    await expect(table().insert([row])).rejects.toThrow(/no such field\(s\): evalScore/);
  });

  it("refuses a row missing a column the engine writes", async () => {
    const row = { ...(await validRow()) } as Record<string, unknown>;
    delete row["source"];
    await expect(table().insert([row as AgentRunsBiRow])).rejects.toThrow(/field\(s\) absent from the row: source/);
  });

  it("refuses a wrong type in a numeric column", async () => {
    const row = { ...(await validRow()), costUsd: "0.42" } as unknown as AgentRunsBiRow;
    await expect(table().insert([row])).rejects.toThrow(/costUsd/);
  });

  it("refuses a non-nullable column set to null", async () => {
    const row = { ...(await validRow()), source: null } as unknown as AgentRunsBiRow;
    await expect(table().insert([row])).rejects.toThrow(/source/);
  });

  it("refuses a timestamp that is not an ISO 8601 instant", async () => {
    const row = { ...(await validRow()), timestamp: "2026-08-30" } as unknown as AgentRunsBiRow;
    await expect(table().insert([row])).rejects.toThrow(/timestamp/);
  });

  it("accepts null in the columns the engine writes `?? null` into", async () => {
    const row = { ...(await validRow()), servedByHop: null, servingAdapter: null, operation: null, jobId: null, stepId: null };
    await expect(table().insert([row])).resolves.toBeUndefined();
  });

  it("refuses to exist with an empty column list, which would check nothing", () => {
    expect(() => new InMemoryAgentRunsBiTable([])).toThrow(/would check nothing/);
  });
});

describe("buildEvalReadBackSql", () => {
  it("projects every column of the row, generated from the pinned column list", () => {
    const { sql } = buildEvalReadBackSql({ jobId: "suite-1" });
    for (const column of AGENT_RUNS_BI_COLUMNS) expect(sql).toContain(column);
    expect(sql).not.toContain("SELECT *");
  });

  it("targets bi_telemetry.agent_runs_bi and binds filters as named parameters", () => {
    const { sql, params } = buildEvalReadBackSql({ jobId: "suite-1", agentId: "linkedin-agent", operation: EVAL_OPERATION });
    expect(sql).toContain("FROM `bi_telemetry.agent_runs_bi`");
    expect(sql).toContain("jobId = @jobId");
    expect(sql).toContain("agentId = @agentId");
    expect(sql).toContain("ORDER BY timestamp DESC");
    expect(params).toEqual({ jobId: "suite-1", agentId: "linkedin-agent", operation: EVAL_OPERATION });
    // The value itself never appears in the SQL text.
    expect(sql).not.toContain("linkedin-agent");
  });

  it("qualifies the table with a project when one is given", () => {
    const { sql } = buildEvalReadBackSql({}, { projectId: "karoscmo-prep", datasetId: "bi_telemetry" });
    expect(sql).toContain("FROM `karoscmo-prep.bi_telemetry.agent_runs_bi`");
  });
});

describe("BigQueryAgentRunsBiSink without a credential", () => {
  const ORIGINAL = { ...process.env };
  beforeEach(() => {
    delete process.env.BQ_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("says so loudly instead of no-op'ing a score into nowhere", async () => {
    const sink = new BigQueryAgentRunsBiSink();
    await expect(sink.insert([evalScoreToAgentRunsBiRow(await makeScore())])).rejects.toThrow(BigQueryNotConfiguredError);
    await expect(sink.query({ jobId: "suite-2026-08-30" })).rejects.toThrow(/BigQuery is not configured/);
  });
});
