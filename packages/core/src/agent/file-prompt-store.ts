import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { PromptStore } from "./prompt-store.js";

function sanitizeSegment(segment: string): string {
  if (!segment || segment.includes("..") || segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
    throw new Error(`FilePromptStore: invalid path segment "${segment}"`);
  }
  return segment;
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "ENOENT";
}

/**
 * A file-backed `PromptStore` — one Markdown/text file per version, laid out
 * as `<rootDir>/<promptId>/<version>.md`, with `<rootDir>/<promptId>/
 * latest.md` as the explicit "no version requested" default. This is the
 * file+git equivalent of `packages/tools/common`'s `WorkspaceStore`: real
 * files a human edits and reviews, ready to swap for a Firestore/Vertex
 * `PromptStore` later without changing any call site (RFC-01 §16.1).
 */
export class FilePromptStore implements PromptStore {
  constructor(private readonly rootDir: string) {}

  async getPrompt(promptId: string, version?: string): Promise<string> {
    const promptDir = path.join(this.rootDir, sanitizeSegment(promptId));
    const fileName = version !== undefined ? `${sanitizeSegment(version)}.md` : "latest.md";

    try {
      return await fs.readFile(path.join(promptDir, fileName), "utf8");
    } catch (err) {
      if (isNotFound(err)) {
        const label = version !== undefined ? `"${promptId}@${version}"` : `"${promptId}" (latest)`;
        throw new Error(`FilePromptStore: no prompt found for ${label}`);
      }
      throw err;
    }
  }
}
