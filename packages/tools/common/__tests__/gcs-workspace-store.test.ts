import { describe, expect, it, beforeEach } from "vitest";
import { GcsWorkspaceStore, type GcsBucketLike, type GcsFileLike } from "../src/index.js";

/**
 * A minimal in-memory double for `GcsBucketLike` — mirrors the real
 * `@google-cloud/storage` tuple-return convention (`[boolean]`, `[Buffer]`,
 * `[GcsFileLike[]]`) closely enough to verify `GcsWorkspaceStore`'s own
 * logic (object-key construction, existence-then-write idempotency,
 * prefix listing) without a real GCS bucket.
 */
class FakeGcsFile implements GcsFileLike {
  constructor(
    public readonly name: string,
    private readonly objects: Map<string, Buffer>,
  ) {}

  async exists(): Promise<[boolean]> {
    return [this.objects.has(this.name)];
  }

  async download(): Promise<[Buffer]> {
    const buf = this.objects.get(this.name);
    if (!buf) throw new Error(`FakeGcsFile: "${this.name}" does not exist`);
    return [buf];
  }

  async save(data: string): Promise<void> {
    this.objects.set(this.name, Buffer.from(data, "utf8"));
  }
}

class FakeGcsBucket implements GcsBucketLike {
  private readonly objects = new Map<string, Buffer>();

  file(objectPath: string): GcsFileLike {
    return new FakeGcsFile(objectPath, this.objects);
  }

  async getFiles(options: { prefix: string }): Promise<[GcsFileLike[]]> {
    const matching = [...this.objects.keys()].filter((key) => key.startsWith(options.prefix)).map((key) => new FakeGcsFile(key, this.objects));
    return [matching];
  }
}

describe("GcsWorkspaceStore", () => {
  let bucket: FakeGcsBucket;
  let store: GcsWorkspaceStore;

  beforeEach(() => {
    bucket = new FakeGcsBucket();
    store = new GcsWorkspaceStore(bucket);
  });

  it("returns undefined for a record that doesn't exist yet", async () => {
    const result = await store.readJson("acme", ["ledger", "deliverables", "run_1"]);
    expect(result).toBeUndefined();
  });

  it("round-trips a written record and reports it as newly created", async () => {
    const { created } = await store.writeJson("acme", ["ledger", "deliverables", "run_1"], { body: "hello" });
    expect(created).toBe(true);

    const readBack = await store.readJson("acme", ["ledger", "deliverables", "run_1"]);
    expect(readBack).toEqual({ body: "hello" });
  });

  it("is idempotent on the caller-supplied key: same object key, created flips to false", async () => {
    const first = await store.writeJson("acme", ["ledger", "deliverables", "run_1"], { body: "v1" });
    const second = await store.writeJson("acme", ["ledger", "deliverables", "run_1"], { body: "v2" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.filePath).toBe(second.filePath);

    const entries = await store.listJson("acme", ["ledger", "deliverables"]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data).toEqual({ body: "v2" });
  });

  it("scopes reads/writes under the tenant's own object-key prefix", async () => {
    await store.writeJson("acme", ["ledger", "deliverables", "run_1"], { body: "acme's" });
    await store.writeJson("globex", ["ledger", "deliverables", "run_1"], { body: "globex's" });

    expect(await store.readJson("acme", ["ledger", "deliverables", "run_1"])).toEqual({ body: "acme's" });
    expect(await store.readJson("globex", ["ledger", "deliverables", "run_1"])).toEqual({ body: "globex's" });
  });

  it("lists all records under a prefix, sorted by id", async () => {
    await store.writeJson("acme", ["events", "evt_b"], { level: "info" });
    await store.writeJson("acme", ["events", "evt_a"], { level: "error" });

    const entries = await store.listJson("acme", ["events"]);
    expect(entries.map((e) => e.id)).toEqual(["evt_a", "evt_b"]);
  });

  it("returns an empty list for a collection that was never written", async () => {
    expect(await store.listJson("acme", ["nonexistent"])).toEqual([]);
  });

  it("rejects path segments containing '..'", async () => {
    await expect(store.writeJson("acme", ["..", "escape"], {})).rejects.toThrow(/invalid path segment/);
  });

  it("rejects path segments containing a path separator", async () => {
    await expect(store.writeJson("acme", ["a/b"], {})).rejects.toThrow(/invalid path segment/);
  });

  it("addresses records as clients/<slug>/... GCS object keys", async () => {
    const { filePath } = await store.writeJson("acme", ["client", "profile"], { name: "Acme" });
    expect(filePath).toBe("clients/acme/client/profile.json");
  });
});
