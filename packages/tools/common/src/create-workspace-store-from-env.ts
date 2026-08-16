import { createWorkspaceStore, type WorkspaceStoreLike } from "./adapters/file-git/workspace-store.js";
import type { GitCommitter } from "./adapters/file-git/git-committer.js";
import { GcsWorkspaceStore } from "./adapters/gcs/gcs-workspace-store.js";
import type { GcsBucketLike } from "./adapters/gcs/gcs-types.js";

export interface CreateWorkspaceStoreFromEnvOptions {
  /** Defaults to `process.env`. Override for tests or a non-Node runtime. */
  env?: Record<string, string | undefined>;
  /**
   * Constructs the real GCS bucket client, only invoked when
   * `GCS_WORKSPACE_BUCKET` is set. Building the actual client needs a real
   * `@google-cloud/storage` import, which this package deliberately never
   * adds as a dependency (see `./adapters/gcs/gcs-types.ts`'s
   * `GcsBucketLike` doc comment) — wire this at your application's
   * composition root.
   */
  gcsBucketFactory?: (bucketName: string) => GcsBucketLike;
  /** Passed through to the file-backed store when `GCS_WORKSPACE_BUCKET` is unset. */
  gitCommitter?: GitCommitter;
}

function readEnv(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Selects the client `WorkspaceStoreLike` backend from environment
 * configuration (RFC-01 §9.2): a real `GcsWorkspaceStore` when
 * `GCS_WORKSPACE_BUCKET` is configured — the one that actually survives a
 * paused run being resumed on a different, stateless Cloud Run instance —
 * a file+git `WorkspaceStore` otherwise (correct for local development, and
 * for every existing test that constructs its own temp-directory store
 * directly rather than going through this factory).
 */
export function createWorkspaceStoreFromEnv(options: CreateWorkspaceStoreFromEnvOptions = {}): WorkspaceStoreLike {
  const env = options.env ?? process.env;
  const bucketName = readEnv(env, "GCS_WORKSPACE_BUCKET");

  if (!bucketName) {
    return createWorkspaceStore(undefined, options.gitCommitter);
  }

  if (!options.gcsBucketFactory) {
    throw new Error(
      "createWorkspaceStoreFromEnv: GCS_WORKSPACE_BUCKET is set but options.gcsBucketFactory was not provided — construct a real " +
        "@google-cloud/storage Bucket (e.g. new Storage().bucket(bucketName)) at your application's composition root and pass a factory returning it",
    );
  }

  return new GcsWorkspaceStore(options.gcsBucketFactory(bucketName));
}
