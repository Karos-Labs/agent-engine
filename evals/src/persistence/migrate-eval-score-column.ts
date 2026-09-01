import { EVAL_OPERATION, PersistedEvalDetailSchema, type AgentRunsBiRow } from "./agent-runs-bi-row.js";
import { AGENT_RUNS_BI_TABLE, DEFAULT_BI_DATASET } from "./sink.js";

/**
 * SCRUM-385's backfill: moves the rubric-detail JSON that SCRUM-308 wrote
 * into `errorDetails` (there being no score column at the time) into the two
 * purpose-built columns this ticket adds — `evalScore` and
 * `evalRubricDetail` — and clears `errorDetails` back to what it means on
 * every other row in the table: null, because nothing failed.
 *
 * ## What this file is, and is not
 *
 * This environment has no BigQuery credential and cannot reach `karoscmo` or
 * `karoscmo-prep` (see EXEC-CONTEXT-ENGINE.md) — nothing here has executed
 * against a real table. What IS tested, against `InMemoryAgentRunsBiTable`
 * (see `evals/__tests__/migrate-eval-score-column.test.ts`), is:
 *
 *   - the transform itself (`migrateLegacyEvalRow`) round-trips a legacy row's
 *     score and rubric detail exactly, losing nothing;
 *   - the row-selection predicate (`isLegacyEncodedEvalRow`) matches only rows
 *     actually written under the old encoding, not every eval row and not
 *     every row with a populated `errorDetails`;
 *   - the generated SQL (`buildBackfillUpdateSql`) has the shape a human
 *     copies into `scripts/migrate-eval-score-column.sql` to run for real.
 *
 * The actual UPDATE against BigQuery is a single DML statement (see
 * `buildBackfillUpdateSql`), not a client-side row-by-row rewrite — there is
 * no reason to stream every legacy row through this process just to write it
 * back with three fields changed, and doing so would need `Table.insert`
 * (append-only) or a second, differently-configured write path, neither of
 * which this exists to add. The TS functions below exist so the SQL's logic
 * is unit-testable and version-controlled as code, not so this module runs
 * the migration itself.
 */

/** The columns of a row as they exist under the OLD (SCRUM-308) encoding — score and detail both still inside `errorDetails`. */
export interface LegacyEncodedEvalRow {
  runId: string;
  operation: string | null;
  errorDetails: string;
}

/** The three column values the backfill sets on one row. */
export interface MigratedEvalRowFields {
  evalScore: number;
  evalRubricDetail: string;
  errorDetails: null;
}

/**
 * Pure transform: a legacy-encoded row's `errorDetails` JSON becomes the
 * `evalScore` / `evalRubricDetail` / `errorDetails` triple the new schema
 * expects. Throws — rather than skipping or defaulting — when `errorDetails`
 * does not parse as the `eval-score/v1` payload the caller claims it is: a
 * migration that silently drops a row it cannot parse is exactly the kind of
 * quiet failure SCRUM-385 exists to close, applied to itself.
 */
export function migrateLegacyEvalRow(row: LegacyEncodedEvalRow): MigratedEvalRowFields {
  const detail = PersistedEvalDetailSchema.parse(JSON.parse(row.errorDetails));
  return {
    evalScore: detail.overall,
    // The whole payload moves verbatim — same JSON text, new column. Nothing
    // about the shape changes; only where it lives does.
    evalRubricDetail: row.errorDetails,
    errorDetails: null,
  };
}

/**
 * Whether a row was written under the old (SCRUM-308) encoding and still
 * needs migrating.
 *
 * Two checks, both load-bearing:
 *
 *   1. `operation === EVAL_OPERATION` — a non-eval row's `errorDetails` is a
 *      real error string (or null), never this payload, and must never be
 *      touched by this migration.
 *   2. the JSON actually parses as `eval-score/v1` — `operation` alone is not
 *      proof of encoding; a future eval row written by code that has already
 *      moved past this migration would have `errorDetails: null` and no
 *      legacy payload to find, and this must say no to it rather than throw.
 *
 * Deliberately `safeParse`, not `parse`: unlike `migrateLegacyEvalRow` (which
 * throws on a row it was TOLD is legacy-encoded and is not), this is the
 * PREDICATE that decides which rows are in scope, and a used-to-be-eval row
 * with a since-repurposed `errorDetails` value is out of scope, not an error.
 */
export function isLegacyEncodedEvalRow(row: Pick<AgentRunsBiRow, "operation" | "errorDetails">): boolean {
  if (row.operation !== EVAL_OPERATION || row.errorDetails === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.errorDetails);
  } catch {
    return false;
  }
  return PersistedEvalDetailSchema.safeParse(parsed).success;
}

/**
 * The exact BigQuery Standard SQL DML a human with project access runs for
 * the real backfill (`scripts/migrate-eval-score-column.sql`, STEP 3).
 *
 * `EVAL_OPERATION` is interpolated directly, not bound as a parameter, unlike
 * `buildEvalReadBackSql`'s caller-supplied filters — it is a repo constant
 * this file imports, not text a caller passes in, so there is nothing here
 * for parameter binding to protect against.
 *
 * Idempotent: a row this has already migrated has `errorDetails = NULL` and
 * no longer matches the WHERE clause, so running it twice is a no-op the
 * second time, not a double-write.
 */
export function buildBackfillUpdateSql(opts: { projectId: string; datasetId?: string } = { projectId: "PROJECT" }): string {
  const dataset = opts.datasetId ?? DEFAULT_BI_DATASET;
  const qualified = `${opts.projectId}.${dataset}.${AGENT_RUNS_BI_TABLE}`;
  return [
    `UPDATE \`${qualified}\``,
    `SET`,
    `  evalScore = CAST(JSON_VALUE(errorDetails, '$.overall') AS NUMERIC),`,
    `  evalRubricDetail = errorDetails,`,
    `  errorDetails = NULL`,
    `WHERE operation = '${EVAL_OPERATION}'`,
    `  AND errorDetails IS NOT NULL`,
    `  AND JSON_VALUE(errorDetails, '$.schema') = 'eval-score/v1';`,
  ].join("\n");
}
