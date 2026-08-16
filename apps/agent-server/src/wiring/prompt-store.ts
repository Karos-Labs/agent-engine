import { getFirestore } from "firebase-admin/firestore";
import { createPromptStoreFromEnv, type PromptStore } from "@agent-engine/core";
import { getSharedFirebaseApp } from "./firebase-app.js";

/**
 * Builds the active `PromptStore` from environment configuration (RFC-01
 * §16.1). `PROMPT_STORE_DRIVER=firestore` is wired to a real client here;
 * `=vertex` deliberately is not — this build wasn't able to confirm the
 * current Vertex AI Prompt Management SDK/REST surface with confidence
 * (it's a newer, still-evolving part of the product), so rather than
 * guessing at method names that might not match reality, the factory below
 * fails fast with an actionable message pointing at where to plug in the
 * real client once that surface is confirmed. `=file`/`=memory` need no GCP
 * wiring at all and work as-is.
 */
export function createServerPromptStore(env: Record<string, string | undefined> = process.env): PromptStore {
  return createPromptStoreFromEnv({
    env,
    firestoreDbFactory: (config) => getFirestore(getSharedFirebaseApp(config.project), config.databaseId),
    vertexClientFactory: () => {
      throw new Error(
        'createServerPromptStore: PROMPT_STORE_DRIVER="vertex" has no real client wired up in this build — the exact ' +
          "current Vertex AI Prompt Management SDK/REST surface wasn't confirmed. Implement VertexAIPromptClient.getPromptVersion() " +
          'against your target surface in this file, or use PROMPT_STORE_DRIVER="firestore" instead.',
      );
    },
  });
}
