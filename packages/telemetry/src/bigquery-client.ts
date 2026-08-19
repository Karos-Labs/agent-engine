import type { BigQuery as BigQueryType, Table } from "@google-cloud/bigquery";

/**
 * Lazy BigQuery singleton, mirroring karosCMO's `src/lib/telemetry/bigquery-client.ts`.
 * Loaded dynamically (see tracer.ts's `initTelemetry` for why) so importing
 * this module never pulls in `@google-cloud/bigquery` unless a row is
 * actually inserted. Returns null when `GOOGLE_CLOUD_PROJECT` is unset —
 * callers no-op, same contract as `getTracer()`'s no-op tracer.
 */
let client: BigQueryType | undefined;

async function getBigQuery(): Promise<BigQueryType | null> {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) return null;
  if (!client) {
    const { BigQuery } = await import("@google-cloud/bigquery");
    client = new BigQuery({ projectId });
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
