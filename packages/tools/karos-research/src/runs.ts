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

/**
 * The most recent run for a job, or `undefined` if the job has never run
 * (RFC-01 §6's `not_available` case).
 *
 * Query-agnostic on purpose, and correct for its callers:
 * `research.checkFreshness` asks "when did this job last run", which is a
 * question about cadence. It is NOT what a cache lookup wants — see
 * `latestRunForQuery`.
 */
export async function latestRun(store: WorkspaceStoreLike, clientSlug: string, job: string): Promise<RunRecord | undefined> {
  const runs = await listRuns(store, clientSlug, job);
  return runs[0];
}

/**
 * Two queries are the same question when they differ only in case or spacing.
 *
 * Anything cleverer — stemming, fuzzy distance — would start deciding that two
 * genuinely different subjects are close enough, and the whole point here is
 * that they are not.
 */
function sameQuestion(a: string, b: string): boolean {
  const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The most recent run for a job THAT ASKED THIS QUESTION.
 *
 * `research.pull` used `latestRun`, which keys only on `(clientSlug, job)`. A
 * live prep run showed what that costs: `instagram-agent` always passes
 * `job: "instagram-carousel-research"` with a 24h window, so a second run that
 * day reused the first run's research whatever its own subject was — and
 * returned that run's query, so the trace said so plainly while nothing
 * errored. The agent then drafted from stale facts about someone else's topic,
 * and a typed direction that had correctly won topic selection looked like it
 * had been ignored.
 *
 * A subject is part of a research result's identity, not a parameter of it.
 */
export async function latestRunForQuery(
  store: WorkspaceStoreLike,
  clientSlug: string,
  job: string,
  query: string,
): Promise<RunRecord | undefined> {
  const runs = await listRuns(store, clientSlug, job);
  return runs.find((run) => sameQuestion(run.query, query));
}
