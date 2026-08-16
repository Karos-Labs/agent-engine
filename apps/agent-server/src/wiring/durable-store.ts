import { getFirestore } from "firebase-admin/firestore";
import { FirestoreDurableStepStore, MemoryDurableStepStore, type DurableStepStore } from "@agent-engine/workflow";
import { getSharedFirebaseApp } from "./firebase-app.js";

function readEnv(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Selects the run/step/gate durable store from environment configuration
 * (RFC-01 §8.4a): a real `FirestoreDurableStepStore` when a GCP project is
 * configured, a `MemoryDurableStepStore` otherwise — the in-process store is
 * genuinely correct for local development and for the integration tests in
 * `__tests__/`, never for a real Cloud Run deployment (each request may land
 * on a different, ephemeral instance, so in-memory state wouldn't survive
 * between a run's start and its resume).
 *
 * Uses Application Default Credentials — `gcloud auth application-default
 * login` locally, or the attached Service Account in Cloud Run/GKE. No key
 * file is ever read from an env var here.
 */
export function createDurableStoreFromEnv(env: Record<string, string | undefined> = process.env): DurableStepStore {
  const project = readEnv(env, "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT");
  if (!project) {
    return new MemoryDurableStepStore();
  }

  const databaseId = readEnv(env, "FIRESTORE_DATABASE_ID") ?? "(default)";
  const db = getFirestore(getSharedFirebaseApp(project), databaseId);
  return new FirestoreDurableStepStore(db, { databaseId });
}
