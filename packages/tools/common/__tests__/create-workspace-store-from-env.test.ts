import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  GcsWorkspaceStore,
  WorkspaceStore,
  createWorkspaceStoreFromEnv,
  type GcsBucketLike,
  type GcsFileLike,
} from "../src/index.js";

function fakeGcsBucket(): GcsBucketLike {
  const objects = new Map<string, Buffer>();
  return {
    file(objectPath: string): GcsFileLike {
      return {
        name: objectPath,
        async exists() {
          return [objects.has(objectPath)];
        },
        async download() {
          const buf = objects.get(objectPath);
          if (!buf) throw new Error("not found");
          return [buf];
        },
        async save(data: string) {
          objects.set(objectPath, Buffer.from(data, "utf8"));
        },
      };
    },
    async getFiles() {
      return [[]];
    },
  };
}

describe("createWorkspaceStoreFromEnv", () => {
  it("defaults to a file-backed WorkspaceStore when GCS_WORKSPACE_BUCKET is unset", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-store-env-"));
    try {
      const store = createWorkspaceStoreFromEnv({ env: { KAROS_WORKSPACE_ROOT: rootDir } });
      expect(store).toBeInstanceOf(WorkspaceStore);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("throws when GCS_WORKSPACE_BUCKET is set but gcsBucketFactory is missing", () => {
    expect(() => createWorkspaceStoreFromEnv({ env: { GCS_WORKSPACE_BUCKET: "acme-workspace" } })).toThrow(/gcsBucketFactory/);
  });

  it("constructs a GcsWorkspaceStore, passing the configured bucket name to the factory", () => {
    const gcsBucketFactory = vi.fn(fakeGcsBucket);
    const store = createWorkspaceStoreFromEnv({ env: { GCS_WORKSPACE_BUCKET: "acme-workspace" }, gcsBucketFactory });

    expect(store).toBeInstanceOf(GcsWorkspaceStore);
    expect(gcsBucketFactory).toHaveBeenCalledWith("acme-workspace");
  });

  it("the resulting GcsWorkspaceStore is actually wired to the factory-supplied bucket", async () => {
    const store = createWorkspaceStoreFromEnv({ env: { GCS_WORKSPACE_BUCKET: "acme-workspace" }, gcsBucketFactory: fakeGcsBucket });

    const { created } = await store.writeJson("acme", ["client", "profile"], { name: "Acme Corp" });
    expect(created).toBe(true);
    expect(await store.readJson("acme", ["client", "profile"])).toEqual({ name: "Acme Corp" });
  });
});
