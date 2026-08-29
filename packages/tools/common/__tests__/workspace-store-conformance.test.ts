import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceStore, GcsWorkspaceStore, type WorkspaceStoreLike, type GcsBucketLike, type GcsFileLike } from "../src/index.js";

/**
 * AU12 — "GCS / file store divergence": the two backends are meant to be
 * interchangeable (RFC-01 §9.2 — no `karos-*` tool package is supposed to
 * know or care which one it's talking to), but `gcs-workspace-store.ts` and
 * `file-git/workspace-store.ts` were independently written and had drifted
 * in listing scope and sort order. This suite runs the identical operations
 * against both backends and asserts identical `listJson` results, so a
 * future edit to either adapter that reintroduces a divergence fails here
 * instead of surfacing later as "T-P0b found the wrong store in prod and the
 * symptom was subtle."
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

describe("WorkspaceStore vs GcsWorkspaceStore — cross-backend conformance", () => {
  let rootDir: string;
  let fileStore: WorkspaceStoreLike;
  let gcsStore: WorkspaceStoreLike;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "karos-conformance-"));
    fileStore = new WorkspaceStore(rootDir);
    gcsStore = new GcsWorkspaceStore(new FakeGcsBucket());
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  /** Writes the same records to both backends via the shared `WorkspaceStoreLike` contract. */
  async function seedBoth(writes: Array<{ segments: string[]; data: unknown }>): Promise<void> {
    for (const { segments, data } of writes) {
      await fileStore.writeJson("acme", segments, data);
      await gcsStore.writeJson("acme", segments, data);
    }
  }

  it("lists a flat directory with identical ids, in identical order, on both backends", async () => {
    await seedBoth([
      { segments: ["events", "evt_b"], data: { level: "info" } },
      { segments: ["events", "evt_a"], data: { level: "error" } },
      { segments: ["events", "evt_c"], data: { level: "warn" } },
    ]);

    const fileEntries = await fileStore.listJson("acme", ["events"]);
    const gcsEntries = await gcsStore.listJson("acme", ["events"]);

    expect(gcsEntries.map((e) => e.id)).toEqual(fileEntries.map((e) => e.id));
    expect(gcsEntries.map((e) => e.data)).toEqual(fileEntries.map((e) => e.data));
  });

  it("SORT ORDER: agrees on mixed-case ids — this is the divergence localeCompare introduced", async () => {
    // Byte-order ("Z" < "a") and locale-aware collation ("a" < "Z") disagree
    // on this exact pair. Before the fix, GcsWorkspaceStore used
    // localeCompare and returned ["apple", "Zebra"]; WorkspaceStore's plain
    // `.sort()` returns ["Zebra", "apple"]. This must not depend on which
    // store production happens to have wired up.
    await seedBoth([
      { segments: ["events", "Zebra"], data: { n: 1 } },
      { segments: ["events", "apple"], data: { n: 2 } },
    ]);

    const fileIds = (await fileStore.listJson("acme", ["events"])).map((e) => e.id);
    const gcsIds = (await gcsStore.listJson("acme", ["events"])).map((e) => e.id);

    expect(gcsIds).toEqual(fileIds);
  });

  it("LISTING SCOPE: neither backend surfaces a record written one segment deeper than the list target", async () => {
    // GCS's getFiles({prefix}) matches any object key under the prefix,
    // however "deep" — there are no real directories. fs.readdir only
    // returns direct children. Before the fix, a record written at
    // events/sub/nested.json appeared in the GCS listing of ["events"] and
    // was invisible in the file-store listing of the same segments.
    await fileStore.writeJson("acme", ["events", "top"], { n: 1 });
    await gcsStore.writeJson("acme", ["events", "top"], { n: 1 });
    await fileStore.writeJson("acme", ["events", "sub", "nested"], { n: 2 });
    await gcsStore.writeJson("acme", ["events", "sub", "nested"], { n: 2 });

    const fileIds = (await fileStore.listJson("acme", ["events"])).map((e) => e.id);
    const gcsIds = (await gcsStore.listJson("acme", ["events"])).map((e) => e.id);

    expect(gcsIds).toEqual(fileIds);
    expect(gcsIds).toEqual(["top"]);
  });

  it("both report an empty list for a collection that was never written", async () => {
    expect(await fileStore.listJson("acme", ["nonexistent"])).toEqual([]);
    expect(await gcsStore.listJson("acme", ["nonexistent"])).toEqual([]);
  });

  it("both scope listJson to the tenant's own segment prefix", async () => {
    await fileStore.writeJson("acme", ["events", "e1"], { who: "acme" });
    await gcsStore.writeJson("acme", ["events", "e1"], { who: "acme" });
    await fileStore.writeJson("globex", ["events", "e1"], { who: "globex" });
    await gcsStore.writeJson("globex", ["events", "e1"], { who: "globex" });

    const fileAcme = await fileStore.listJson("acme", ["events"]);
    const gcsAcme = await gcsStore.listJson("acme", ["events"]);
    expect(gcsAcme.map((e) => e.data)).toEqual(fileAcme.map((e) => e.data));
    expect(fileAcme.map((e) => e.data)).toEqual([{ who: "acme" }]);
  });
});
