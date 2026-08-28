import { sanitizeSegment, type WorkspaceStoreLike, type WorkspaceStoreListEntry, type WorkspaceStoreWriteResult } from "../file-git/workspace-store.js";
import type { GcsBucketLike } from "./gcs-types.js";

/**
 * The cloud-native `WorkspaceStoreLike` backend (RFC-01 §9.2): the same
 * `<clientSlug>/<segments...>.json`-per-record layout as the file+git
 * `WorkspaceStore`, addressed as GCS object keys under `clients/` instead of
 * local filesystem paths — so any stateless Cloud Run instance can read a
 * client's profile/topics/memory/ledger state and any instance can resume a
 * paused run, without them ever having shared a local disk.
 *
 * Idempotent by the same construction as the file store: the caller-supplied
 * key becomes the deterministic object key, so a retried write is just
 * another `file.save()` to the same key — no separate compare-and-set layer.
 * `created` is derived from an `exists()` check immediately before the
 * write, the same best-effort (not lock-free-atomic) guarantee the file
 * store already makes under concurrent writers.
 */
export class GcsWorkspaceStore implements WorkspaceStoreLike {
  constructor(
    private readonly bucket: GcsBucketLike,
    private readonly prefix: string = "clients",
  ) {}

  private objectPath(clientSlug: string, segments: readonly string[]): string {
    const parts = [clientSlug, ...segments].map(sanitizeSegment);
    return [this.prefix, ...parts].join("/") + ".json";
  }

  private dirPrefix(clientSlug: string, segments: readonly string[]): string {
    const parts = [clientSlug, ...segments].map(sanitizeSegment);
    return [this.prefix, ...parts].join("/") + "/";
  }

  async exists(clientSlug: string, segments: readonly string[]): Promise<boolean> {
    const [exists] = await this.bucket.file(this.objectPath(clientSlug, segments)).exists();
    return exists;
  }

  async readJson<T>(clientSlug: string, segments: readonly string[]): Promise<T | undefined> {
    const file = this.bucket.file(this.objectPath(clientSlug, segments));
    const [exists] = await file.exists();
    if (!exists) {
      return undefined;
    }
    const [buf] = await file.download();
    return JSON.parse(buf.toString("utf8")) as T;
  }

  async writeJson<T>(clientSlug: string, segments: readonly string[], data: T): Promise<WorkspaceStoreWriteResult> {
    const objectPath = this.objectPath(clientSlug, segments);
    const file = this.bucket.file(objectPath);
    const [existedBefore] = await file.exists();
    await file.save(`${JSON.stringify(data, null, 2)}\n`, { contentType: "application/json" });
    return { filePath: objectPath, created: !existedBefore };
  }

  /**
   * AU12 conformance fix: two divergences from `WorkspaceStore.listJson`
   * closed here (see `workspace-store-conformance.test.ts`, which runs the
   * same operations against both backends and fails if they disagree
   * again).
   *
   * 1. LISTING SCOPE. GCS has no real directories — `getFiles({prefix})`
   *    matches any object key under the prefix, however deeply "nested" —
   *    while `WorkspaceStore.listJson` reads one filesystem directory
   *    non-recursively via `fs.readdir`. Left alone, a record ever written
   *    one segment deeper than callers list at would appear on GCS and
   *    silently vanish on the file store. Filtered out here so both
   *    backends only ever return DIRECT children of the listed segments,
   *    matching every current `karos-*` caller's one-level-deep layout.
   * 2. SORT ORDER. `.sort((a,b) => a.name.localeCompare(b.name))` is
   *    locale-aware (case-insensitive-ish collation); `WorkspaceStore`'s
   *    bare `.sort()` on filenames is a byte-order comparison. The two
   *    disagree on mixed-case ids (e.g. `"Zebra"` sorts before `"apple"`
   *    under `localeCompare`, after it under byte order), so replaced with
   *    the same byte-order comparison the file store gets from `.sort()`.
   */
  async listJson<T>(clientSlug: string, segments: readonly string[]): Promise<Array<WorkspaceStoreListEntry<T>>> {
    const prefix = this.dirPrefix(clientSlug, segments);
    const [files] = await this.bucket.getFiles({ prefix });

    const direct = files.filter((f) => {
      if (!f.name.endsWith(".json")) return false;
      const id = f.name.slice(prefix.length, -".json".length);
      return id.length > 0 && !id.includes("/");
    });
    direct.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const entries: Array<WorkspaceStoreListEntry<T>> = [];
    for (const file of direct) {
      const [buf] = await file.download();
      const id = file.name.slice(prefix.length, -".json".length);
      entries.push({ id, data: JSON.parse(buf.toString("utf8")) as T });
    }
    return entries;
  }
}
