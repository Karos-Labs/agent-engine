import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const UpdateBeliefsInputSchema = z.object({
  diff: z.record(z.string(), z.unknown()),
});
export type UpdateBeliefsInput = z.infer<typeof UpdateBeliefsInputSchema>;

export interface UpdateBeliefsResult {
  beliefs: Record<string, unknown>;
}

/**
 * Shallow-merges `diff` into the current beliefs document. Unlike the
 * append-style tools above, this is a genuine mutation on every call by
 * design — "update" means "apply this diff now", not "record this once".
 * It's naturally idempotent only when called twice with the identical diff
 * (the merge result is the same either way), which needs no special handling
 * — there's no caller-supplied key to dedupe against here.
 */
export function createUpdateBeliefs(store: WorkspaceStoreLike) {
  return defineTool<UpdateBeliefsInput, UpdateBeliefsResult>({
    name: "memory.updateBeliefs",
    version: TOOL_VERSION,
    inputSchema: UpdateBeliefsInputSchema,
    async execute({ diff }, { ctx }) {
      const segments = ["memory", "beliefs"];
      const current = (await store.readJson<Record<string, unknown>>(ctx.clientSlug, segments)) ?? {};
      const merged = { ...current, ...diff };
      await store.writeJson(ctx.clientSlug, segments, merged);
      return success<UpdateBeliefsResult>({ beliefs: merged });
    },
  });
}
