import type { WorkspaceStoreLike, WorkspaceStoreWriteResult } from "@agent-engine/tool-common";

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

/**
 * A single-record pointer at `research/<job>/latest.json` — the fix for
 * AU12's "`latestRun()` parses every historical run record on every cache
 * check" finding. Kept as its own record (rather than derived from the
 * `runs/` directory) so a job with a long history costs the same one read
 * on every freshness/cache check that a brand-new job does.
 */
export function latestSegments(job: string): string[] {
  return ["research", job, "latest"];
}

export async function listRuns(store: WorkspaceStoreLike, clientSlug: string, job: string): Promise<RunRecord[]> {
  const entries = await store.listJson<RunRecord>(clientSlug, runsDirSegments(job));
  return entries.map((e) => e.data).sort((a, b) => b.at - a.at);
}

/**
 * Records one research run AND keeps the `latest.json` pointer for its job
 * current — the only place either write happens, so every caller
 * (`research.writeRun`, `research.pull`, `research.captureVisibility`) gets
 * the pointer maintained the same way.
 *
 * Guarded by `at` rather than unconditionally overwritten: an idempotent
 * retry of an older write (or a delayed duplicate) must never regress the
 * pointer past a newer run that already landed.
 */
export async function writeRunRecord(store: WorkspaceStoreLike, clientSlug: string, record: RunRecord): Promise<WorkspaceStoreWriteResult> {
  const result = await store.writeJson(clientSlug, runSegments(record.job, record.runId), record);
  const existingLatest = await store.readJson<RunRecord>(clientSlug, latestSegments(record.job));
  if (!existingLatest || record.at >= existingLatest.at) {
    await store.writeJson(clientSlug, latestSegments(record.job), record);
  }
  return result;
}

/**
 * The most recent run for a job, or `undefined` if the job has never run
 * (RFC-01 §6's `not_available` case).
 *
 * Reads the `latest.json` pointer directly — O(1) regardless of how many
 * runs the job has recorded — falling back to the full historical scan only
 * for a job whose runs predate the pointer's introduction (no pointer file
 * yet, despite recorded runs).
 *
 * Query-agnostic on purpose, and correct for its callers:
 * `research.checkFreshness` asks "when did this job last run", which is a
 * question about cadence. It is NOT what a cache lookup wants — see
 * `latestRunForQuery`.
 */
export async function latestRun(store: WorkspaceStoreLike, clientSlug: string, job: string): Promise<RunRecord | undefined> {
  const pointer = await store.readJson<RunRecord>(clientSlug, latestSegments(job));
  if (pointer) return pointer;
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
 *
 * Same pointer fast-path as `latestRun`: a recurring job that keeps asking
 * the same question (the common case this cache exists for) is answered
 * from the single `latest.json` read without ever listing `runs/`. Only a
 * pointer miss — a different subject than what's latest, or no pointer yet —
 * falls back to the full historical scan, which is the one case where an
 * older, non-latest run might still be the match.
 */
export async function latestRunForQuery(
  store: WorkspaceStoreLike,
  clientSlug: string,
  job: string,
  query: string,
): Promise<RunRecord | undefined> {
  const pointer = await store.readJson<RunRecord>(clientSlug, latestSegments(job));
  if (pointer && sameQuestion(pointer.query, query)) return pointer;
  const runs = await listRuns(store, clientSlug, job);
  return runs.find((run) => sameQuestion(run.query, query));
}
