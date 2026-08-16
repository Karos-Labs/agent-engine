import type { WorkspaceStoreLike } from "@agent-engine/tool-common";

export interface RunRecord {
  job: string;
  runId: string;
  query: string;
  result: unknown;
  /** Epoch ms this run was recorded. */
  at: number;
}

export function runSegments(job: string, runId: string): string[] {
  return ["research", job, "runs", runId];
}

export function runsDirSegments(job: string): string[] {
  return ["research", job, "runs"];
}

export async function listRuns(store: WorkspaceStoreLike, clientSlug: string, job: string): Promise<RunRecord[]> {
  const entries = await store.listJson<RunRecord>(clientSlug, runsDirSegments(job));
  return entries.map((e) => e.data).sort((a, b) => b.at - a.at);
}

/** The most recent run for a job, or `undefined` if the job has never run (RFC-01 §6's `not_available` case). */
export async function latestRun(store: WorkspaceStoreLike, clientSlug: string, job: string): Promise<RunRecord | undefined> {
  const runs = await listRuns(store, clientSlug, job);
  return runs[0];
}
