import { promises as fs } from "node:fs";
import * as path from "node:path";
import { noopGitCommitter, type GitCommitter } from "./git-committer.js";

export interface WorkspaceStoreWriteResult {
  filePath: string;
  /** False when this exact path already held a record — the idempotent-retry case. */
  created: boolean;
}

export interface WorkspaceStoreListEntry<T> {
  /** The filename (without ".json") — typically the caller-supplied idempotency key. */
  id: string;
  data: T;
}

function sanitizeSegment(segment: string): string {
  if (!segment || segment.includes("..") || segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
    throw new Error(`WorkspaceStore: invalid path segment "${segment}"`);
  }
  return segment;
}

/**
 * The "file" half of the file+git lab adapter (RFC-01 §9.2): one JSON
 * document per record, laid out under `<rootDir>/clients/<clientSlug>/...`,
 * so every read/write is structurally tenant-scoped by construction — a
 * caller can never point a path outside its own client's directory (segment
 * sanitization rejects `..`, `/`, `\`, and NUL the same way `BaseAgent`'s
 * write-fence does at Layer 2 — this is the Layer 3 half of that same
 * invariant).
 *
 * Writes are idempotent by construction: the caller-supplied key becomes the
 * deterministic path, so retrying a write is just `set(..., {merge:true})`
 * again (RFC-01 §8.4a's Firestore idiom, reproduced here without Firestore)
 * — no separate compare-and-set layer needed.
 */
export class WorkspaceStore {
  constructor(
    private readonly rootDir: string,
    private readonly gitCommitter: GitCommitter = noopGitCommitter,
  ) {}

  filePath(clientSlug: string, segments: readonly string[]): string {
    const parts = [clientSlug, ...segments].map(sanitizeSegment);
    return path.join(this.rootDir, "clients", ...parts) + ".json";
  }

  dirPath(clientSlug: string, segments: readonly string[]): string {
    const parts = [clientSlug, ...segments].map(sanitizeSegment);
    return path.join(this.rootDir, "clients", ...parts);
  }

  async exists(clientSlug: string, segments: readonly string[]): Promise<boolean> {
    try {
      await fs.access(this.filePath(clientSlug, segments));
      return true;
    } catch {
      return false;
    }
  }

  async readJson<T>(clientSlug: string, segments: readonly string[]): Promise<T | undefined> {
    try {
      const raw = await fs.readFile(this.filePath(clientSlug, segments), "utf8");
      return JSON.parse(raw) as T;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async writeJson<T>(clientSlug: string, segments: readonly string[], data: T): Promise<WorkspaceStoreWriteResult> {
    const filePath = this.filePath(clientSlug, segments);
    const created = !(await this.exists(clientSlug, segments));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await this.gitCommitter.commit(`write ${path.join("clients", clientSlug, ...segments)}.json`);
    return { filePath, created };
  }

  async listJson<T>(clientSlug: string, segments: readonly string[]): Promise<Array<WorkspaceStoreListEntry<T>>> {
    const dirPath = this.dirPath(clientSlug, segments);
    let files: string[];
    try {
      files = await fs.readdir(dirPath);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }

    const entries: Array<WorkspaceStoreListEntry<T>> = [];
    for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
      const raw = await fs.readFile(path.join(dirPath, file), "utf8");
      entries.push({ id: file.slice(0, -".json".length), data: JSON.parse(raw) as T });
    }
    return entries;
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "ENOENT";
}

/** Resolves the workspace root from an env var, falling back to a `.karos-workspace` dir under the process cwd. */
export function defaultWorkspaceRoot(): string {
  return process.env.KAROS_WORKSPACE_ROOT ?? path.join(process.cwd(), ".karos-workspace");
}

export function createWorkspaceStore(rootDir: string = defaultWorkspaceRoot(), gitCommitter?: GitCommitter): WorkspaceStore {
  return new WorkspaceStore(rootDir, gitCommitter);
}
