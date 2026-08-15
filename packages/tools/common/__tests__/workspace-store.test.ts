import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceStore } from "../src/index.js";

describe("WorkspaceStore", () => {
  let rootDir: string;
  let store: WorkspaceStore;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-workspace-store-"));
    store = new WorkspaceStore(rootDir);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
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

  it("is idempotent on the caller-supplied key: same path, no duplicate side effects, created flips to false", async () => {
    const first = await store.writeJson("acme", ["ledger", "deliverables", "run_1"], { body: "v1" });
    const second = await store.writeJson("acme", ["ledger", "deliverables", "run_1"], { body: "v2" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.filePath).toBe(second.filePath);

    const entries = await store.listJson("acme", ["ledger", "deliverables"]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data).toEqual({ body: "v2" });
  });

  it("scopes reads/writes under the tenant's own directory", async () => {
    await store.writeJson("acme", ["ledger", "deliverables", "run_1"], { body: "acme's" });
    await store.writeJson("globex", ["ledger", "deliverables", "run_1"], { body: "globex's" });

    expect(await store.readJson("acme", ["ledger", "deliverables", "run_1"])).toEqual({ body: "acme's" });
    expect(await store.readJson("globex", ["ledger", "deliverables", "run_1"])).toEqual({ body: "globex's" });
  });

  it("lists all records in a directory sorted by id", async () => {
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
});
