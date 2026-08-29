import { z } from "zod";
import { readFile } from "node:fs/promises";
import { defineTool, success, toolingError } from "@agent-engine/tool-common";
import { resolveRuntime, type KarosVideoToolOptions } from "../config.js";
import { assertNoTraversalOrNul, assertWithinTenantWorkRoot } from "../sandbox.js";

const TOOL_VERSION = "1.0.0";

export const ReadJsonFileInputSchema = z.object({
  // No existing TSDoc on this field to transcribe (SCRUM-293 flag) — synthesized from the tool's own doc comment.
  path: z.string().min(1).describe("Path to the on-disk JSON file to read (e.g. a brand-profile.json a Python engine script also reads by path)."),
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
 *
 * Security-audit finding: same unfenced-path issue as `video.writeJsonFile`
 * — every `path` is traversal/NUL-checked unconditionally, and confined to
 * `<workRoot>/<ctx.clientSlug>/…` when a `workRoot` is configured. See
 * `../sandbox.js`.
 */
export function createReadJsonFile(options: KarosVideoToolOptions = {}) {
  const runtime = resolveRuntime(options);

  return defineTool<ReadJsonFileInput, ReadJsonFileResult>({
    name: "video.readJsonFile",
    description:
      "The read-side companion to video.writeJsonFile: loads a client's real brand-profile.json (or any other on-disk JSON the Python engine also reads by path) through a Layer 3 tool. Every path is traversal/NUL-checked, and confined to the tenant's work root when one is configured.",
    version: TOOL_VERSION,
    inputSchema: ReadJsonFileInputSchema,
    async execute({ path }, { ctx }) {
      if (runtime.workRoot !== undefined) {
        await assertWithinTenantWorkRoot(runtime.workRoot, ctx.clientSlug, path, "path");
      } else {
        assertNoTraversalOrNul(path, "path");
      }

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
