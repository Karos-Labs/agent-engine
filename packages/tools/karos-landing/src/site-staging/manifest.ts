import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * Shared plumbing for staging a client's site tree through GCS across a gate
 * pause.
 *
 * ## Why this exists
 *
 * `landing-builder-agent` builds into a container-local directory
 * (`LANDING_ENGINE_ROOT`, `/tmp/...` on Cloud Run). That is fine for a run
 * that executes start to finish in one process, and it was fine for a long
 * time because runs were started over HTTP and resumed over HTTP against the
 * same service.
 *
 * It stops being fine the moment a run pauses at the human-review gate:
 * steps 00-07 execute on `agent-engine-*-worker` (the Pub/Sub consumer),
 * while `POST /runs/{id}/resume` is served by `agent-engine-*` (the HTTP
 * service). Two Cloud Run services, two containers, two empty `/tmp`s. On
 * resume the workflow engine replays the completed steps from the durable
 * store *without re-executing them*, so nothing ever re-creates the tree —
 * and `landing.uploadSiteBundle` then finds an empty directory and fails.
 *
 * Observed for real in prep: run `pubsub-21513920400985095` reached
 * `awaiting_gate` cleanly, then died at `09b-upload-site-bundle` after the
 * resume landed on a different container.
 *
 * ## Why a manifest rather than a bucket listing
 *
 * `GcsArtifactStoreLike` is deliberately narrow — `upload` / `download` /
 * `exists`, no listing. Widening that shared interface (and every
 * implementation and fake behind it) to serve one workflow is a bigger change
 * than this problem warrants. Writing the file list *as* an object makes the
 * staged bundle self-describing, restorable with the methods that already
 * exist, and gives the restore step something to validate against: a short
 * download tells it exactly how many files it should end up with.
 */

/** Object key of a run's staging manifest. */
export function manifestObjectPath(runId: string): string {
  return `runs/${runId}/staging/manifest.json`;
}

/** Object key of one staged file, addressed by its site-relative path. */
export function stagedObjectPath(runId: string, relativePath: string): string {
  return `runs/${runId}/staging/site/${relativePath}`;
}

export interface StagingManifest {
  runId: string;
  clientSlug: string;
  /** Site-relative paths, POSIX separators, sorted for a stable object body. */
  files: string[];
  stagedAt: string;
}

/** Every file under `root`, as absolute paths. Throws if `root` is unreadable. */
export async function listFilesRecursive(root: string, dir: string = root): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(root, full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/** `path.relative` with POSIX separators — object keys are never Windows-shaped. */
export function toRelativeKey(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

/**
 * Whether a directory already holds at least one file.
 *
 * The restore step uses this to stay a no-op when the run never actually
 * changed containers — the common case, and one where re-downloading would
 * be pure waste and could clobber a newer local edit.
 */
export async function directoryHasFiles(root: string): Promise<boolean> {
  try {
    return (await listFilesRecursive(root)).length > 0;
  } catch {
    return false;
  }
}
