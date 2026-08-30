import { AGENT_RUNS_BI_COLUMNS, type AgentRunsBiRow } from "./agent-runs-bi-row.js";

/** The BI dataset the engine's telemetry lives in — `bigquery-client.ts`'s own default, overridable by `BQ_DATASET_ID` there. */
export const DEFAULT_BI_DATASET = "bi_telemetry";
export const AGENT_RUNS_BI_TABLE = "agent_runs_bi";

/**
 * The columns an eval row can be looked up by.
 *
 * Not "any column": these are the four the ladder actually keys on — the whole
 * suite invocation (`jobId`), one graded case (`runId`), one agent's history
 * (`agentId`), one golden run in one language (`stepId`), and the row kind
 * (`operation`). Widening this to `Partial<AgentRunsBiRow>` would invite a
 * lookup by `costUsd`, which BigQuery would happily run as a full scan.
 */
export interface EvalRowQuery {
  runId?: string;
  jobId?: string;
  agentId?: string;
  stepId?: string;
  operation?: string;
}

const QUERYABLE = ["runId", "jobId", "agentId", "stepId", "operation"] as const;

export interface AgentRunsBiSink {
  /** Streams rows into `agent_runs_bi`. */
  insert(rows: readonly AgentRunsBiRow[]): Promise<void>;
  /** Reads eval rows back out, newest first. */
  query(where: EvalRowQuery): Promise<AgentRunsBiRow[]>;
}

export interface ReadBackSql {
  sql: string;
  params: Record<string, string>;
}

/**
 * The BigQuery Standard SQL that reads persisted eval rows back out — the
 * "query proving the row is readable back out" half of SCRUM-308's acceptance
 * criterion.
 *
 * The projection is generated from `AGENT_RUNS_BI_COLUMNS` rather than typed
 * out, so it cannot fall behind the row shape; `SELECT *` was rejected because
 * it would make a dropped column invisible at exactly the moment the caller
 * parses the result back through `AgentRunsBiRowSchema` and needs to know.
 *
 * Named parameters, never interpolation: a client slug or a golden-run id is
 * caller-supplied text, and BigQuery's own parameter binding is the only
 * correct way to put it in a query.
 */
export function buildEvalReadBackSql(where: EvalRowQuery, opts: { datasetId?: string; projectId?: string } = {}): ReadBackSql {
  const dataset = opts.datasetId ?? DEFAULT_BI_DATASET;
  const qualified = opts.projectId ? `${opts.projectId}.${dataset}.${AGENT_RUNS_BI_TABLE}` : `${dataset}.${AGENT_RUNS_BI_TABLE}`;

  const params: Record<string, string> = {};
  const conditions: string[] = [];
  for (const column of QUERYABLE) {
    const value = where[column];
    if (value === undefined) continue;
    params[column] = value;
    conditions.push(`${column} = @${column}`);
  }

  const clause = conditions.length > 0 ? `\nWHERE ${conditions.join("\n  AND ")}` : "";
  const sql = `SELECT ${AGENT_RUNS_BI_COLUMNS.join(", ")}\nFROM \`${qualified}\`${clause}\nORDER BY timestamp DESC`;
  return { sql, params };
}

/** The projected column names of a query built by `buildEvalReadBackSql`. */
export function projectedColumns(sql: string): string[] {
  const match = /^SELECT\s+([\s\S]+?)\nFROM\s/.exec(sql);
  if (!match) throw new Error("buildEvalReadBackSql produced SQL with no readable SELECT projection");
  return match[1]!.split(",").map((c) => c.trim());
}

/**
 * The `column = @param` equalities in a query's WHERE clause, resolved against
 * its parameter bag.
 *
 * Exists so `InMemoryAgentRunsBiTable` can filter using the SQL the production
 * sink would actually send, rather than using the caller's `EvalRowQuery`
 * object directly. That is the difference between a fake that agrees with the
 * real read path and a fake that merely agrees with itself: drop a condition
 * from the builder and the in-memory round-trip starts returning rows it
 * should have filtered out.
 */
export function whereEqualities(sql: string, params: Record<string, string>): Array<[string, string]> {
  const clause = /\nWHERE ([\s\S]+?)\nORDER BY/.exec(sql);
  if (!clause) return [];
  return [...clause[1]!.matchAll(/(\w+)\s*=\s*@(\w+)/g)].map(([, column, param]) => {
    const value = params[param!];
    if (value === undefined) throw new Error(`read-back SQL references @${param} with no matching parameter`);
    return [column!, value] as [string, string];
  });
}
