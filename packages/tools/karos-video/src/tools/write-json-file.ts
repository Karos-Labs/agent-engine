import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool, success, toolingError } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const WriteJsonFileInputSchema = z.object({
  path: z.string().min(1),
  data: z.unknown(),
});
export type WriteJsonFileInput = z.infer<typeof WriteJsonFileInputSchema>;

export interface WriteJsonFileResult {
  path: string;
  bytesWritten: number;
}

/**
 * `video.writeJsonFile`: the one real-disk write this package owns. Every
 * `assets/engine/*.py` script reads a `--profile`/`--job`/`--transcript`
 * PATH, never a value passed on the CLI, and this repo's abstract
 * `WorkspaceStore` (RFC-01 §9.1) has no notion of "a local path a Python
 * subprocess can `open()`" — it's a JSON-document store, potentially
 * GCS-backed with no local path at all. Rather than have workflow code
 * reach around the Layer 1/Layer 3 boundary and call `node:fs` directly
 * (breaking the "all I/O through tools" convention every other migrated
 * agent's workflow follows), this tool is the thin, explicit Layer 3 seam
 * for it — real disk, one job, matching RFC-06 §3's own observation that
 * this product needs "real disk and CPU/time budget" no other tool in this
 * bundle requires.
 */
export function createWriteJsonFile() {
  return defineTool<WriteJsonFileInput, WriteJsonFileResult>({
    name: "video.writeJsonFile",
    version: TOOL_VERSION,
    inputSchema: WriteJsonFileInputSchema,
    async execute({ path, data }) {
      const json = JSON.stringify(data, null, 2);
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, json, "utf8");
      } catch (err) {
        return toolingError(`failed to write "${path}": ${err instanceof Error ? err.message : String(err)}`);
      }
      return success<WriteJsonFileResult>({ path, bytesWritten: Buffer.byteLength(json, "utf8") });
    },
  });
}
