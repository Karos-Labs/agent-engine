import type { BigQuery as BigQueryType, Table } from "@google-cloud/bigquery";

/**
 * Lazy BigQuery singleton, mirroring karosCMO's `src/lib/telemetry/bigquery-client.ts`.
 * Loaded dynamically (see tracer.ts's `initTelemetry` for why) so importing
 * this module never pulls in `@google-cloud/bigquery` unless a row is
 * actually inserted. Returns null when no project is resolvable —
 * callers no-op, same contract as `getTracer()`'s no-op tracer.
 */
let client: BigQueryType | undefined;
let clientProjectId: string | undefined;

/**
 * Which GCP project owns the BI dataset.
 *
 * `BQ_PROJECT_ID` first, and it exists because `GOOGLE_CLOUD_PROJECT` is the
 * wrong answer in prep. Prep's Firestore lives in the *production* project
 * (`karoscmo`, under a database named `prep`), so prep's services set
 * `GOOGLE_CLOUD_PROJECT=karoscmo` to reach it. BigQuery then inherited that
 * and every prep run tried to insert into production's
 * `karoscmo:bi_telemetry.agent_runs_bi` — denied on `bigquery.tables.updateData`,
 * swallowed by the catch below, so it showed up only as a WARNING line on
 * every single run and no prep telemetry was ever recorded.
 *
 * Two distinct things were tangled in one variable: "where is our Firestore"
 * and "where does our telemetry go". They are separate now.
 */
function projectId(): string | undefined {
  return process.env.BQ_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || undefined;
}

async function getBigQuery(): Promise<BigQueryType | null> {
  const project = projectId();
  if (!project) return null;
  // Rebuild when the target changes — the singleton pins a projectId at
  // construction, so a cached client would keep writing to the old project.
  if (!client || clientProjectId !== project) {
    const { BigQuery } = await import("@google-cloud/bigquery");
    client = new BigQuery({ projectId: project });
    clientProjectId = project;
  }
  return client;
}

const DATASET_ID = () => process.env.BQ_DATASET_ID || "bi_telemetry";

/** Returns null when BigQuery isn't configured — callers no-op. */
export async function biTable(tableId: string): Promise<Table | null> {
  const bq = await getBigQuery();
  if (!bq) return null;
  return bq.dataset(DATASET_ID()).table(tableId);
}

/**
 * Reads rows back out of the BI dataset with a parameterized Standard SQL
 * query (SCRUM-308 / AU25).
 *
 * The counterpart to `biTable`, and added for the same reason that exists: the
 * eval ladder persists a score into `agent_runs_bi` and has to be able to
 * prove the row is readable back out, which a `Table` handle cannot do —
 * `Table.insert` writes, and nothing on it reads. Same no-op contract as
 * `biTable`: null when no project is resolvable, so a caller in an
 * unconfigured environment gets "not configured" rather than a crash or — far
 * worse — an empty array indistinguishable from "the row is not there".
 *
 * Named parameters only. Every value a caller filters on here (a client slug,
 * a golden-run id) is text that came from somewhere else, and whether to
 * interpolate it into SQL is not a decision to leave to each call site.
 *
 * No `location` option, deliberately: the client resolves a query's location
 * from the dataset the SQL references, and adding an env var for it would put
 * a fourth "where does telemetry go" knob next to the three this file already
 * spends its header untangling.
 */
export async function biQuery<T = Record<string, unknown>>(sql: string, params: Record<string, unknown> = {}): Promise<T[] | null> {
  const bq = await getBigQuery();
  if (!bq) return null;
  const [rows] = await bq.query({ query: sql, params });
  return rows as T[];
}

/** Test seam: drops the memoized client so the next call re-reads the env. */
export function __resetBigQueryClient(): void {
  client = undefined;
  clientProjectId = undefined;
}
