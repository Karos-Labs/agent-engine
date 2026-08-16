import { InMemoryPromptStore, type PromptStore } from "./prompt-store.js";
import { FilePromptStore } from "./file-prompt-store.js";
import { FirestorePromptStore } from "./firestore-prompt-store.js";
import { VertexAIPromptStore } from "./vertex-ai-prompt-store.js";
import type { FirestoreLike, VertexAIPromptClient } from "./gcp-types.js";

export type PromptStoreDriver = "vertex" | "firestore" | "file" | "memory";

/** Resolved once per `createPromptStoreFromEnv()` call and handed to whichever client factory the selected driver needs — so region/project/database selection lives in one place instead of being recomputed at each call site. */
export interface GcpPromptStoreConfig {
  project: string;
  location: string;
  databaseId: string;
}

export interface CreatePromptStoreFromEnvOptions {
  /** Defaults to `process.env`. Override for tests or a non-Node runtime. */
  env?: Record<string, string | undefined>;
  /**
   * Constructs the real Vertex AI prompt client, only invoked when
   * `PROMPT_STORE_DRIVER=vertex`. Building the actual client needs a real
   * Google Cloud/Vertex AI SDK import, which this package deliberately never
   * adds as a dependency (see `./gcp-types.ts`'s `VertexAIPromptClient` doc
   * comment) — wire this at your application's composition root, using
   * whichever current Vertex AI prompt-management SDK/REST surface your
   * deployment targets. Receives the resolved `{project, location}` so you
   * don't have to re-read the same env vars yourself.
   */
  vertexClientFactory?: (config: GcpPromptStoreConfig) => VertexAIPromptClient;
  /**
   * Constructs the real Firestore client, only invoked when
   * `PROMPT_STORE_DRIVER=firestore` (or, optionally, to build a Vertex
   * fallback yourself — see `vertexFallback`). Typically
   * `getFirestore(initializeApp(), config.databaseId)` from `firebase-admin`.
   */
  firestoreDbFactory?: (config: GcpPromptStoreConfig) => FirestoreLike;
  /**
   * A ready-made fallback `PromptStore` for the `"vertex"` driver — e.g. a
   * `FirestorePromptStore` you built via `firestoreDbFactory`, or a
   * `FilePromptStore` pointed at prompts checked into the repo. Optional:
   * omit for no fallback (a Vertex outage then just fails the call).
   */
  vertexFallback?: PromptStore;
}

function readEnv(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

function requireProject(env: Record<string, string | undefined>, driver: PromptStoreDriver): string {
  const project = readEnv(env, "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT");
  if (!project) {
    throw new Error(
      `createPromptStoreFromEnv: PROMPT_STORE_DRIVER="${driver}" requires GOOGLE_CLOUD_PROJECT (or GCLOUD_PROJECT) to be set`,
    );
  }
  return project;
}

/**
 * Selects and constructs a `PromptStore` from environment configuration
 * (RFC-01 §16.1) — `PROMPT_STORE_DRIVER` picks the backend, defaulting to
 * `"memory"` (the only driver that needs zero configuration, so an
 * unconfigured environment fails safe into local/test behavior rather than
 * throwing). `"vertex"`/`"firestore"` both need a real GCP client, which this
 * function never constructs itself (see `vertexClientFactory`/
 * `firestoreDbFactory` above) — it only decides *which* backend and *how
 * it's configured*, then asks the caller for the actual client.
 */
export function createPromptStoreFromEnv(options: CreatePromptStoreFromEnvOptions = {}): PromptStore {
  const env = options.env ?? process.env;
  const driver = (readEnv(env, "PROMPT_STORE_DRIVER") ?? "memory") as PromptStoreDriver;

  switch (driver) {
    case "memory":
      return new InMemoryPromptStore();

    case "file": {
      const root = readEnv(env, "PROMPT_STORE_FILE_ROOT");
      if (!root) {
        throw new Error('createPromptStoreFromEnv: PROMPT_STORE_DRIVER="file" requires PROMPT_STORE_FILE_ROOT to be set');
      }
      return new FilePromptStore(root);
    }

    case "firestore": {
      const project = requireProject(env, driver);
      if (!options.firestoreDbFactory) {
        throw new Error(
          'createPromptStoreFromEnv: PROMPT_STORE_DRIVER="firestore" requires options.firestoreDbFactory — construct a real ' +
            "Firestore client (e.g. firebase-admin's getFirestore()) at your application's composition root and pass a factory returning it",
        );
      }
      const config: GcpPromptStoreConfig = {
        project,
        location: readEnv(env, "VERTEX_AI_LOCATION", "GCP_REGION") ?? "us-central1",
        databaseId: readEnv(env, "FIRESTORE_DATABASE_ID") ?? "(default)",
      };
      return new FirestorePromptStore(options.firestoreDbFactory(config), { databaseId: config.databaseId });
    }

    case "vertex": {
      const project = requireProject(env, driver);
      if (!options.vertexClientFactory) {
        throw new Error(
          'createPromptStoreFromEnv: PROMPT_STORE_DRIVER="vertex" requires options.vertexClientFactory — construct a real ' +
            "Vertex AI prompt client at your application's composition root and pass a factory returning it",
        );
      }
      const config: GcpPromptStoreConfig = {
        project,
        location: readEnv(env, "VERTEX_AI_LOCATION", "GCP_REGION") ?? "us-central1",
        databaseId: readEnv(env, "FIRESTORE_DATABASE_ID") ?? "(default)",
      };
      const ttlMsRaw = readEnv(env, "PROMPT_STORE_TTL_MS");
      let ttlMs: number | undefined;
      if (ttlMsRaw !== undefined) {
        ttlMs = Number(ttlMsRaw);
        if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
          throw new Error(`createPromptStoreFromEnv: PROMPT_STORE_TTL_MS must be a positive number, got "${ttlMsRaw}"`);
        }
      }
      return new VertexAIPromptStore(options.vertexClientFactory(config), {
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        ...(options.vertexFallback !== undefined ? { fallback: options.vertexFallback } : {}),
      });
    }

    default: {
      const exhaustiveCheck: never = driver;
      throw new Error(
        `createPromptStoreFromEnv: unknown PROMPT_STORE_DRIVER "${String(exhaustiveCheck)}" — expected "vertex" | "firestore" | "file" | "memory"`,
      );
    }
  }
}
