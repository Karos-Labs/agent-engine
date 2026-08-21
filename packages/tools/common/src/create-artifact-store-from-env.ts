import { GcsArtifactStore, type GcsArtifactStoreLike } from "./adapters/gcs/gcs-artifact-store.js";
import type { GcsBucketLike } from "./adapters/gcs/gcs-types.js";

export interface CreateArtifactStoreFromEnvOptions {
  /** Defaults to `process.env`. Override for tests or a non-Node runtime. */
  env?: Record<string, string | undefined>;
  /**
   * Constructs the real GCS bucket client, only invoked when the named env
   * var is actually set. Building the real client needs a real
   * `@google-cloud/storage` import, which this package deliberately never
   * adds as a dependency (see `./adapters/gcs/gcs-types.ts`'s `GcsBucketLike`
   * doc comment) — wire this at your application's composition root.
   */
  gcsBucketFactory?: (bucketName: string) => GcsBucketLike;
}

function readEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * Selects a `GcsArtifactStoreLike` from one env var (RFC-01's "media/build
 * artifacts to GCS, keyed by env var per bucket" convention — `GCS_MEDIA_BUCKET`
 * for karos-publish/karos-video renders, `GCS_ARTIFACTS_BUCKET` for archived
 * step transcripts and build output) — the artifact-store counterpart to
 * `createWorkspaceStoreFromEnv`.
 *
 * Returns `undefined`, not a throwing stub, when the env var is unset — every
 * caller of this factory (a tool factory, `FirestoreDurableStepStore`) must
 * already treat "no store configured" as "skip GCS, keep the previous
 * local-only/inline behavior" (Task 3's "mock/local fallbacks remain
 * functional"), so there is deliberately no way to end up with a store that
 * exists but always throws.
 */
export function createArtifactStoreFromEnv(envVarName: string, options: CreateArtifactStoreFromEnvOptions = {}): GcsArtifactStoreLike | undefined {
  const env = options.env ?? process.env;
  const bucketName = readEnv(env, envVarName);
  if (!bucketName) {
    return undefined;
  }

  if (!options.gcsBucketFactory) {
    throw new Error(
      `createArtifactStoreFromEnv: ${envVarName} is set to "${bucketName}" but options.gcsBucketFactory was not provided — construct a real ` +
        "@google-cloud/storage Bucket (e.g. new Storage().bucket(bucketName)) at your application's composition root and pass a factory returning it",
    );
  }

  return new GcsArtifactStore(options.gcsBucketFactory(bucketName), bucketName);
}
