import { getFirestore } from "firebase-admin/firestore";
import { FirestoreAgentDefinitionStore, MemoryAgentDefinitionStore, type AgentDefinitionStore } from "@agent-engine/core";
import { getSharedFirebaseApp } from "./firebase-app.js";

function readEnv(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Selects the `AgentDefinitionStore` (Task 2) the same way
 * `createDurableStoreFromEnv` selects the run/step/gate store: a real
 * `FirestoreAgentDefinitionStore` when a GCP project is configured
 * (`agentDefinitions/{agentId}`), a `MemoryAgentDefinitionStore` otherwise
 * — correct for local dev and tests, never for a real multi-instance Cloud
 * Run deployment, where an in-process definition wouldn't be visible to
 * whichever instance later handles a run naming it.
 */
export function createAgentDefinitionStoreFromEnv(env: Record<string, string | undefined> = process.env): AgentDefinitionStore {
  const project = readEnv(env, "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT");
  if (!project) {
    return new MemoryAgentDefinitionStore();
  }
  const databaseId = readEnv(env, "FIRESTORE_DATABASE_ID") ?? "(default)";
  const db = getFirestore(getSharedFirebaseApp(project), databaseId);
  return new FirestoreAgentDefinitionStore(db, undefined, { databaseId });
}
