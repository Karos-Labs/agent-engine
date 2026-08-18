import { z } from "zod";
import { readFile } from "node:fs/promises";
import { defineTool, success, toolingError } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const ReadJsonFileInputSchema = z.object({
  path: z.string().min(1),
});
export type ReadJsonFileInput = z.infer<typeof ReadJsonFileInputSchema>;

export interface ReadJsonFileResult {
  path: string;
  data: unknown;
}

/**
 * `video.readJsonFile`: the read-side companion to `video.writeJsonFile` —
 * lets workflow code load a client's real `brand-profile.json` (or any other
 * on-disk JSON the Python engine also reads by path) through a Layer 3 tool
 * rather than a raw `node:fs` call from `step.code`, matching the "all I/O
 * through tools" convention every other migrated agent's workflow follows.
 */
export function createReadJsonFile() {
  return defineTool<ReadJsonFileInput, ReadJsonFileResult>({
    name: "video.readJsonFile",
    version: TOOL_VERSION,
    inputSchema: ReadJsonFileInputSchema,
    async execute({ path }) {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (err) {
        return toolingError(`failed to read "${path}": ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        return success<ReadJsonFileResult>({ path, data: JSON.parse(raw) });
      } catch (err) {
        return toolingError(`"${path}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}
