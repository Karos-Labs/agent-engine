import { Storage } from "@google-cloud/storage";
import { createWorkspaceStoreFromEnv, type WorkspaceStoreLike } from "@agent-engine/tools";

/**
 * Builds the client `WorkspaceStoreLike` (profiles, topics, memory, ledger)
 * from environment configuration — a real `GcsWorkspaceStore` when
 * `GCS_WORKSPACE_BUCKET` is set, the file+git `WorkspaceStore` otherwise.
 * The GCS backend is what makes `POST /api/v1/runs/:runId/resume` actually
 * safe on Cloud Run: any instance can hydrate a client's state from the
 * bucket, not just whichever ephemeral instance happened to handle the
 * original `/start` request.
 *
 * `new Storage()` uses Application Default Credentials the same way
 * `../wiring/firebase-app.ts` does for Firestore — no key file is ever read
 * from an env var here.
 */
export function createServerWorkspaceStore(env: Record<string, string | undefined> = process.env): WorkspaceStoreLike {
  return createWorkspaceStoreFromEnv({
    env,
    gcsBucketFactory: (bucketName) => new Storage().bucket(bucketName),
  });
}
