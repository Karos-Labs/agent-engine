import { Storage } from "@google-cloud/storage";
import { createArtifactStoreFromEnv, type GcsArtifactStoreLike } from "@agent-engine/tool-common";

/**
 * `publish.renderCarousel`'s upload target (Task 1, RFC-01's GCS media
 * store) — rendered Instagram carousel PNGs. `undefined` when
 * `GCS_MEDIA_BUCKET` is unset, which keeps that tool's exact prior
 * local-scratch-path behavior (Task 3's "mock/local fallbacks remain
 * functional").
 *
 * `new Storage()` uses Application Default Credentials, the same way
 * `./firebase-app.ts` does for Firestore and `./workspace-store.ts` does for
 * GCS-backed client state — no key file is ever read from an env var here.
 */
export function createServerMediaStore(env: Record<string, string | undefined> = process.env): GcsArtifactStoreLike | undefined {
  return createArtifactStoreFromEnv("GCS_MEDIA_BUCKET", {
    env,
    gcsBucketFactory: (bucketName) => new Storage().bucket(bucketName),
  });
}

/**
 * The Task 2 dual-storage archive target — oversized step/slot outputs that
 * would otherwise exceed Firestore's 1 MiB per-document limit
 * (`FirestoreDurableStepStore`'s own `FIRESTORE_INLINE_VALUE_LIMIT_BYTES`).
 * `undefined` when `GCS_ARTIFACTS_BUCKET` is unset, in which case an
 * oversized write still goes straight to Firestore (and still throws there
 * past the real limit) exactly as it did before Task 2.
 */
export function createServerArchiveStore(env: Record<string, string | undefined> = process.env): GcsArtifactStoreLike | undefined {
  return createArtifactStoreFromEnv("GCS_ARTIFACTS_BUCKET", {
    env,
    gcsBucketFactory: (bucketName) => new Storage().bucket(bucketName),
  });
}
