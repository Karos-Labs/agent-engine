import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  FilePromptStore,
  FirestorePromptStore,
  InMemoryPromptStore,
  VertexAIPromptStore,
  createPromptStoreFromEnv,
  type FirestoreCollectionRef,
  type FirestoreDocumentRef,
  type FirestoreDocumentSnapshot,
  type FirestoreLike,
  type FirestoreQuerySnapshot,
  type VertexAIPromptClient,
} from "../src/index.js";

/**
 * A minimal in-memory double for `FirestoreLike` — the same shape as
 * `packages/workflow/__tests__/fake-firestore.ts`'s fixture, duplicated
 * (not imported) since `packages/core` doesn't depend on
 * `packages/workflow` and this is a test-only fixture either way.
 */
class FakeDoc implements FirestoreDocumentRef {
  private data: Record<string, unknown> | undefined;
  private readonly subcollections = new Map<string, FakeCollection>();

  async get(): Promise<FirestoreDocumentSnapshot> {
    const data = this.data;
    return { exists: data !== undefined, data: () => data };
  }

  async set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown> {
    this.data = options?.merge && this.data ? { ...this.data, ...data } : { ...data };
    return undefined;
  }

  collection(name: string): FirestoreCollectionRef {
    let col = this.subcollections.get(name);
    if (!col) {
      col = new FakeCollection();
      this.subcollections.set(name, col);
    }
    return col;
  }
}

class FakeCollection implements FirestoreCollectionRef {
  private readonly docs = new Map<string, FakeDoc>();

  doc(id: string): FirestoreDocumentRef {
    let doc = this.docs.get(id);
    if (!doc) {
      doc = new FakeDoc();
      this.docs.set(id, doc);
    }
    return doc;
  }

  async get(): Promise<FirestoreQuerySnapshot> {
    const entries = [...this.docs.entries()];
    const snaps = await Promise.all(entries.map(async ([id, doc]) => ({ id, snap: await doc.get() })));
    const docs = snaps.filter(({ snap }) => snap.exists).map(({ id, snap }) => ({ id, data: () => snap.data() ?? {} }));
    return { docs };
  }
}

class FakeFirestore implements FirestoreLike {
  private readonly collections = new Map<string, FakeCollection>();

  collection(path: string): FirestoreCollectionRef {
    let col = this.collections.get(path);
    if (!col) {
      col = new FakeCollection();
      this.collections.set(path, col);
    }
    return col;
  }
}

describe("FirestorePromptStore", () => {
  let db: FakeFirestore;
  let store: FirestorePromptStore;

  beforeEach(async () => {
    db = new FakeFirestore();
    store = new FirestorePromptStore(db);
    await db.collection("prompts").doc("linkedin-voice").set({ latestVersion: "2" });
    await db.collection("promptVersions").doc("linkedin-voice@1").set({ content: "v1 content" });
    await db.collection("promptVersions").doc("linkedin-voice@2").set({ content: "v2 content" });
  });

  it("resolves the latest version via the prompts doc when no version is requested", async () => {
    expect(await store.getPrompt("linkedin-voice")).toBe("v2 content");
  });

  it("resolves a specific version directly, bypassing the prompts doc entirely", async () => {
    expect(await store.getPrompt("linkedin-voice", "1")).toBe("v1 content");
  });

  it("throws a clear error when the promptId has no prompts doc at all", async () => {
    await expect(store.getPrompt("nonexistent")).rejects.toThrow(/no prompt registered for id "nonexistent"/);
  });

  it("throws a clear error when the requested promptVersions doc doesn't exist", async () => {
    await expect(store.getPrompt("linkedin-voice", "99")).rejects.toThrow(/no prompt version found for "linkedin-voice@99"/);
  });

  it("throws a clear error when the prompts doc is missing its latestVersion field", async () => {
    await db.collection("prompts").doc("broken").set({ notLatestVersion: "1" });
    await expect(store.getPrompt("broken")).rejects.toThrow(/missing a string "latestVersion" field/);
  });

  it("throws a clear error when the promptVersions doc is missing its content field", async () => {
    await db.collection("promptVersions").doc("broken@1").set({ notContent: "oops" });
    await expect(store.getPrompt("broken", "1")).rejects.toThrow(/missing a string "content" field/);
  });

  it("includes the configured databaseId in its error messages", async () => {
    const namedStore = new FirestorePromptStore(db, { databaseId: "prep" });
    await expect(namedStore.getPrompt("nonexistent")).rejects.toThrow(/database="prep"/);
  });
});

describe("VertexAIPromptStore", () => {
  function fakeClient(impl: (promptId: string, version?: string) => Promise<string>): { client: VertexAIPromptClient; getPromptVersion: ReturnType<typeof vi.fn> } {
    const getPromptVersion = vi.fn(impl);
    return { client: { getPromptVersion }, getPromptVersion };
  }

  it("resolves from the client and caches the result", async () => {
    const { client, getPromptVersion } = fakeClient(async () => "resolved content");
    const store = new VertexAIPromptStore(client);

    expect(await store.getPrompt("linkedin-voice", "3")).toBe("resolved content");
    expect(await store.getPrompt("linkedin-voice", "3")).toBe("resolved content");
    expect(getPromptVersion).toHaveBeenCalledTimes(1);
  });

  it("keys the cache separately per version, and separately for 'no version requested'", async () => {
    const { client, getPromptVersion } = fakeClient(async (_id, version) => `content for ${version ?? "latest"}`);
    const store = new VertexAIPromptStore(client);

    expect(await store.getPrompt("p", "1")).toBe("content for 1");
    expect(await store.getPrompt("p", "2")).toBe("content for 2");
    expect(await store.getPrompt("p")).toBe("content for latest");
    expect(getPromptVersion).toHaveBeenCalledTimes(3);

    // All three now serve from cache.
    await store.getPrompt("p", "1");
    await store.getPrompt("p", "2");
    await store.getPrompt("p");
    expect(getPromptVersion).toHaveBeenCalledTimes(3);
  });

  it("refetches once the TTL has elapsed", async () => {
    let tick = 0;
    const { client, getPromptVersion } = fakeClient(async () => "content");
    const store = new VertexAIPromptStore(client, { ttlMs: 1000, now: () => tick });

    await store.getPrompt("p");
    tick += 999;
    await store.getPrompt("p"); // still within the TTL window
    expect(getPromptVersion).toHaveBeenCalledTimes(1);

    tick += 2;
    await store.getPrompt("p"); // TTL has now elapsed
    expect(getPromptVersion).toHaveBeenCalledTimes(2);
  });

  it("falls back to the configured store when the client throws, and caches the fallback's result too", async () => {
    const { client, getPromptVersion } = fakeClient(async () => {
      throw new Error("Vertex AI is unavailable");
    });
    const fallback = new InMemoryPromptStore();
    fallback.setPrompt("p", "1", "fallback content");
    const store = new VertexAIPromptStore(client, { fallback });

    expect(await store.getPrompt("p", "1")).toBe("fallback content");
    expect(await store.getPrompt("p", "1")).toBe("fallback content");
    // The client was still only ever called once — the second call served from
    // the cache the fallback's own result populated, not from a second Vertex retry.
    expect(getPromptVersion).toHaveBeenCalledTimes(1);
  });

  it("propagates the original client error as-is when no fallback is configured", async () => {
    const { client } = fakeClient(async () => {
      throw new Error("Vertex AI is unavailable");
    });
    const store = new VertexAIPromptStore(client);

    await expect(store.getPrompt("p")).rejects.toThrow(/Vertex AI is unavailable/);
  });

  it("reports both failures, with the original error preserved as .cause, when the fallback also throws", async () => {
    const { client } = fakeClient(async () => {
      throw new Error("Vertex AI is unavailable");
    });
    const fallback = new InMemoryPromptStore(); // never had setPrompt called — will itself throw
    const store = new VertexAIPromptStore(client, { fallback });

    let caught: unknown;
    try {
      await store.getPrompt("p");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error;
    expect(err.message).toMatch(/both the Vertex AI client and the configured fallback failed/);
    expect(err.message).toMatch(/Vertex AI is unavailable/);
    expect(err.message).toMatch(/no prompt registered/);
    expect((err.cause as Error)?.message).toMatch(/Vertex AI is unavailable/);
  });
});

describe("createPromptStoreFromEnv", () => {
  it("defaults to InMemoryPromptStore when PROMPT_STORE_DRIVER is unset", () => {
    const store = createPromptStoreFromEnv({ env: {} });
    expect(store).toBeInstanceOf(InMemoryPromptStore);
  });

  describe("file driver", () => {
    let rootDir: string;

    beforeEach(async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-store-env-"));
    });

    afterEach(async () => {
      await fs.rm(rootDir, { recursive: true, force: true });
    });

    it("returns a FilePromptStore rooted at PROMPT_STORE_FILE_ROOT", () => {
      const store = createPromptStoreFromEnv({ env: { PROMPT_STORE_DRIVER: "file", PROMPT_STORE_FILE_ROOT: rootDir } });
      expect(store).toBeInstanceOf(FilePromptStore);
    });

    it("throws when PROMPT_STORE_FILE_ROOT is missing", () => {
      expect(() => createPromptStoreFromEnv({ env: { PROMPT_STORE_DRIVER: "file" } })).toThrow(/PROMPT_STORE_FILE_ROOT/);
    });
  });

  describe("firestore driver", () => {
    it("throws when GOOGLE_CLOUD_PROJECT (or GCLOUD_PROJECT) is missing", () => {
      expect(() => createPromptStoreFromEnv({ env: { PROMPT_STORE_DRIVER: "firestore" } })).toThrow(/GOOGLE_CLOUD_PROJECT/);
    });

    it("throws when firestoreDbFactory is missing", () => {
      expect(() =>
        createPromptStoreFromEnv({ env: { PROMPT_STORE_DRIVER: "firestore", GOOGLE_CLOUD_PROJECT: "acme-prod" } }),
      ).toThrow(/firestoreDbFactory/);
    });

    it("constructs a FirestorePromptStore, passing the resolved project/location/databaseId to the factory", () => {
      const firestoreDbFactory = vi.fn(() => new FakeFirestore());
      const store = createPromptStoreFromEnv({
        env: {
          PROMPT_STORE_DRIVER: "firestore",
          GOOGLE_CLOUD_PROJECT: "acme-prod",
          VERTEX_AI_LOCATION: "europe-west1",
          FIRESTORE_DATABASE_ID: "prep",
        },
        firestoreDbFactory,
      });

      expect(store).toBeInstanceOf(FirestorePromptStore);
      expect(firestoreDbFactory).toHaveBeenCalledWith({ project: "acme-prod", location: "europe-west1", databaseId: "prep" });
      expect((store as FirestorePromptStore).databaseId).toBe("prep");
    });

    it("accepts GCLOUD_PROJECT and defaults location/databaseId when unset", () => {
      const firestoreDbFactory = vi.fn(() => new FakeFirestore());
      createPromptStoreFromEnv({ env: { PROMPT_STORE_DRIVER: "firestore", GCLOUD_PROJECT: "acme-prod" }, firestoreDbFactory });

      expect(firestoreDbFactory).toHaveBeenCalledWith({ project: "acme-prod", location: "us-central1", databaseId: "(default)" });
    });
  });

  describe("vertex driver", () => {
    function fakeVertexClient(): VertexAIPromptClient {
      return { getPromptVersion: vi.fn(async () => "content") };
    }

    it("throws when GOOGLE_CLOUD_PROJECT (or GCLOUD_PROJECT) is missing", () => {
      expect(() => createPromptStoreFromEnv({ env: { PROMPT_STORE_DRIVER: "vertex" } })).toThrow(/GOOGLE_CLOUD_PROJECT/);
    });

    it("throws when vertexClientFactory is missing", () => {
      expect(() => createPromptStoreFromEnv({ env: { PROMPT_STORE_DRIVER: "vertex", GOOGLE_CLOUD_PROJECT: "acme-prod" } })).toThrow(
        /vertexClientFactory/,
      );
    });

    it("constructs a VertexAIPromptStore, passing the resolved project/location to the factory", () => {
      const vertexClientFactory = vi.fn(fakeVertexClient);
      const store = createPromptStoreFromEnv({
        env: { PROMPT_STORE_DRIVER: "vertex", GOOGLE_CLOUD_PROJECT: "acme-prod", GCP_REGION: "europe-west1" },
        vertexClientFactory,
      });

      expect(store).toBeInstanceOf(VertexAIPromptStore);
      expect(vertexClientFactory).toHaveBeenCalledWith({ project: "acme-prod", location: "europe-west1", databaseId: "(default)" });
    });

    it("rejects a non-numeric or non-positive PROMPT_STORE_TTL_MS", () => {
      expect(() =>
        createPromptStoreFromEnv({
          env: { PROMPT_STORE_DRIVER: "vertex", GOOGLE_CLOUD_PROJECT: "acme-prod", PROMPT_STORE_TTL_MS: "not-a-number" },
          vertexClientFactory: fakeVertexClient,
        }),
      ).toThrow(/PROMPT_STORE_TTL_MS must be a positive number/);
    });

    it("wires the configured TTL and vertexFallback through to the store's actual behavior", async () => {
      const failingClient: VertexAIPromptClient = {
        getPromptVersion: vi.fn(async () => {
          throw new Error("offline");
        }),
      };
      const fallback = new InMemoryPromptStore();
      fallback.setPrompt("p", "1", "fallback content");

      const store = createPromptStoreFromEnv({
        env: { PROMPT_STORE_DRIVER: "vertex", GOOGLE_CLOUD_PROJECT: "acme-prod", PROMPT_STORE_TTL_MS: "60000" },
        vertexClientFactory: () => failingClient,
        vertexFallback: fallback,
      });

      expect(await store.getPrompt("p", "1")).toBe("fallback content");
    });
  });

  it("throws a clear error for an unrecognized PROMPT_STORE_DRIVER value", () => {
    expect(() => createPromptStoreFromEnv({ env: { PROMPT_STORE_DRIVER: "carrier-pigeon" } })).toThrow(/unknown PROMPT_STORE_DRIVER/);
  });
});
