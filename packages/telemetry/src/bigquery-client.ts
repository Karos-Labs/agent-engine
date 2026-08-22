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

/** Test seam: drops the memoized client so the next call re-reads the env. */
export function __resetBigQueryClient(): void {
  client = undefined;
  clientProjectId = undefined;
}
