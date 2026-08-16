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

  async listJson<T>(clientSlug: string, segments: readonly string[]): Promise<Array<WorkspaceStoreListEntry<T>>> {
    const prefix = this.dirPrefix(clientSlug, segments);
    const [files] = await this.bucket.getFiles({ prefix });

    const entries: Array<WorkspaceStoreListEntry<T>> = [];
    for (const file of files.filter((f) => f.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
      const [buf] = await file.download();
      const id = file.name.slice(prefix.length, -".json".length);
      entries.push({ id, data: JSON.parse(buf.toString("utf8")) as T });
    }
    return entries;
  }
}
