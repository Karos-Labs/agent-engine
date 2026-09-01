import { biQuery, biTable } from "@agent-engine/telemetry";
import { AgentRunsBiRowSchema, type AgentRunsBiRow } from "./agent-runs-bi-row.js";
import { AGENT_RUNS_BI_TABLE, buildEvalReadBackSql, type AgentRunsBiSink, type EvalRowQuery } from "./sink.js";

/** Thrown when the sink is asked to write or read and no BigQuery project is configured. */
export class BigQueryNotConfiguredError extends Error {
  constructor(operation: string) {
    super(
      `agent_runs_bi ${operation}: BigQuery is not configured (neither BQ_PROJECT_ID nor GOOGLE_CLOUD_PROJECT is set). ` +
        "An eval score that silently went nowhere is worse than a failed eval run.",
    );
    this.name = "BigQueryNotConfiguredError";
  }
}

/**
 * The production sink: real `bi_telemetry.agent_runs_bi`, through the engine's
 * own established insert path (`biTable`, `packages/telemetry`) and its
 * read-back counterpart (`biQuery`).
 *
 * ## Two differences from `recordCostAndTokens`, both deliberate
 *
 * That function is fire-and-forget and swallows failures, because telemetry
 * must never take down the run it is describing. An eval run is not
 * describing anything — persisting the score IS the work — so this one
 * awaits, and it throws. A ladder that reported "graded" while the score went
 * nowhere would recreate, inside the eval system, the exact silence AU72
 * found in the telemetry sink: every insert denied, every denial swallowed,
 * every deploy reporting success.
 *
 * It also declines to run at all when BigQuery is unconfigured rather than
 * no-op'ing, for the same reason. CI has no credential and is expected to use
 * `InMemoryAgentRunsBiTable` instead; an unconfigured environment reaching
 * this class is a wiring mistake, and saying so is more useful than
 * pretending.
 *
 * ## `ignoreUnknownValues`
 *
 * Left ON, matching `insertAgentRunRow` exactly, so this writes through the
 * same door as the engine and inherits `scripts/check-bq-insert-schema.ts` as
 * its drift guard rather than inventing a second, differently-configured
 * insert path. What protects the row shape *before* it gets here is
 * `evalScoreToAgentRunsBiRow`'s own `AgentRunsBiRowSchema.parse`, and the
 * conformance round trip in CI.
 */
export class BigQueryAgentRunsBiSink implements AgentRunsBiSink {
  constructor(private readonly options: { datasetId?: string; projectId?: string } = {}) {}

  async insert(rows: readonly AgentRunsBiRow[]): Promise<void> {
    if (rows.length === 0) return;
    const table = await biTable(AGENT_RUNS_BI_TABLE);
    if (!table) throw new BigQueryNotConfiguredError("insert");
    await table.insert(
      rows.map((row) => AgentRunsBiRowSchema.parse(row)),
      { ignoreUnknownValues: true, skipInvalidRows: false },
    );
  }

  async query(where: EvalRowQuery): Promise<AgentRunsBiRow[]> {
    const { sql, params } = buildEvalReadBackSql(where, this.options);
    const rows = await biQuery<Record<string, unknown>>(sql, params);
    if (rows === null) throw new BigQueryNotConfiguredError("query");
    // Parsed on the way back, not trusted: a column dropped from the table
    // returns as `undefined` here, and the whole point of the read-back is to
    // notice that rather than to hand a caller a hole shaped like a score.
    return rows.map((row) => AgentRunsBiRowSchema.parse(normalizeBigQueryRow(row)));
  }
}

/**
 * BigQuery hands back `TIMESTAMP` columns as `BigQueryTimestamp` wrappers and
 * `NUMERIC` as `Big`-like objects, not as the primitives that went in. Both
 * stringify correctly; neither is what `AgentRunsBiRowSchema` expects.
 */
function normalizeBigQueryRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  const timestamp = out["timestamp"];
  if (timestamp !== null && typeof timestamp === "object" && "value" in timestamp) {
    out["timestamp"] = String((timestamp as { value: unknown }).value);
  }
  for (const numeric of ["inputTokens", "outputTokens", "costUsd", "durationMs", "evalScore"] as const) {
    const value = out[numeric];
    if (value !== null && value !== undefined && typeof value !== "number") out[numeric] = Number(value);
  }
  return out;
}
