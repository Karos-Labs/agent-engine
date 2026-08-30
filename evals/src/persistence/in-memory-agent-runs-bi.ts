import { AGENT_RUNS_BI_COLUMNS, AgentRunsBiRowSchema, type AgentRunsBiRow } from "./agent-runs-bi-row.js";
import { buildEvalReadBackSql, projectedColumns, whereEqualities, type AgentRunsBiSink, type EvalRowQuery } from "./sink.js";

/** Thrown by the fake when a row does not conform to `agent_runs_bi`. Named after the failure a real strict insert reports. */
export class AgentRunsBiSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRunsBiSchemaError";
  }
}

/**
 * An in-memory `agent_runs_bi` that enforces the real row shape.
 *
 * ## Why this is stricter than the live table, on purpose
 *
 * CI has no BigQuery credential, so the round-trip has to run against
 * something local — and "a fake that accepts anything proves nothing"
 * (SCRUM-308). The live insert runs with `ignoreUnknownValues: true`, which
 * means the REAL table is the permissive one: it silently discards a field it
 * does not have, reports success, and that is precisely how `operation`,
 * `jobId`, `stepId` and `source` were thrown away on every insert for months
 * (`scripts/check-bq-insert-schema.ts`, quality.yml:66-73). Reproducing that
 * tolerance would make this fake incapable of failing.
 *
 * So it enforces, in this order, and throws rather than dropping:
 *
 *   1. the exact column set — a missing column and an extra one are both
 *      errors, checked against `columns`, which a caller should supply from
 *      `insertRowFields()` so the fake is bound to the engine's own insert
 *      literal rather than to a copy of it;
 *   2. the per-column types and nullability, via `AgentRunsBiRowSchema` —
 *      BigQuery rejects a string in a NUMERIC column too;
 *
 * and it re-validates on the way OUT, so a round trip that returns something
 * the schema would not accept fails at the read rather than being quietly
 * believed.
 *
 * ## What it does not model
 *
 * Streaming-buffer latency, partial-failure semantics (`skipInvalidRows`),
 * partitioning, or SQL beyond the equality filters
 * `buildEvalReadBackSql` emits. It is a conformance harness for the row
 * shape and the read-back path, not a BigQuery emulator, and a test that
 * needs more than that needs a real table.
 */
export class InMemoryAgentRunsBiTable implements AgentRunsBiSink {
  private readonly stored: AgentRunsBiRow[] = [];
  private readonly columns: readonly string[];

  constructor(columns: readonly string[] = AGENT_RUNS_BI_COLUMNS) {
    if (columns.length === 0) {
      // An empty column list would make every conformance check below vacuous
      // — the same "an empty set passes every comparison by checking nothing"
      // failure `check-bq-insert-schema.ts` guards its own parser against.
      throw new AgentRunsBiSchemaError("InMemoryAgentRunsBiTable: refusing to run with an empty column list — it would check nothing");
    }
    this.columns = [...columns];
  }

  /** Every row inserted so far, in insertion order. For assertions that need the raw stored form. */
  get rows(): readonly AgentRunsBiRow[] {
    return this.stored;
  }

  async insert(rows: readonly AgentRunsBiRow[]): Promise<void> {
    for (const row of rows) {
      this.stored.push(this.conform(row, "insert"));
    }
  }

  async query(where: EvalRowQuery): Promise<AgentRunsBiRow[]> {
    // Deliberately routed through the production SQL builder: the filters and
    // the projection below are the ones a real BigQuery read would use.
    const { sql, params } = buildEvalReadBackSql(where);
    const projection = projectedColumns(sql);
    const equalities = whereEqualities(sql, params);

    const matched = this.stored.filter((row) => equalities.every(([column, value]) => (row as Record<string, unknown>)[column] === value));

    const projected = matched.map((row) => {
      const out: Record<string, unknown> = {};
      for (const column of projection) out[column] = (row as Record<string, unknown>)[column];
      return this.conform(out, "read-back");
    });

    // `ORDER BY timestamp DESC`, honoured rather than assumed — a caller that
    // reads `[0]` expecting the newest row gets the newest row.
    return projected.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  }

  private conform(row: unknown, phase: "insert" | "read-back"): AgentRunsBiRow {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new AgentRunsBiSchemaError(`agent_runs_bi ${phase}: expected a row object, got ${Array.isArray(row) ? "an array" : typeof row}`);
    }
    const keys = Object.keys(row as Record<string, unknown>);
    const unknown = keys.filter((k) => !this.columns.includes(k));
    const missing = this.columns.filter((c) => !keys.includes(c));
    if (unknown.length > 0 || missing.length > 0) {
      const parts: string[] = [];
      if (unknown.length > 0) parts.push(`no such field(s): ${unknown.join(", ")}`);
      if (missing.length > 0) parts.push(`field(s) absent from the row: ${missing.join(", ")}`);
      throw new AgentRunsBiSchemaError(`agent_runs_bi ${phase}: ${parts.join("; ")}`);
    }

    const parsed = AgentRunsBiRowSchema.safeParse(row);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(row)"}: ${i.message}`).join("; ");
      throw new AgentRunsBiSchemaError(`agent_runs_bi ${phase}: ${issues}`);
    }
    return parsed.data;
  }
}
