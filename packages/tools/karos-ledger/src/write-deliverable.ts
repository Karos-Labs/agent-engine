import { z } from "zod";
import type { IdempotentWriteResult, WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const WriteDeliverableInputSchema = z.object({
  // No existing TSDoc on runId/deliverable to transcribe (SCRUM-293 flag) — synthesized from execute()'s usage and the tool's own doc comment.
  runId: z.string().min(1).describe("The run that produced this deliverable."),
  slotId: z.string().min(1).optional().describe("Set when this deliverable is one unit of a fan-out."),
  kind: z.string().min(1).describe("The deliverable's type, e.g. \"linkedin-post\", \"landing-page\"."),
  deliverable: z.unknown().describe("The deliverable's content, as arbitrary JSON."),
});
export type WriteDeliverableInput = z.infer<typeof WriteDeliverableInputSchema>;

/**
 * Idempotent on `(runId, slotId, kind)` — the caller-supplied key from
 * RFC-01 §9.1 rule 2. Retrying the same write after a partial failure lands
 * on the same record, not a duplicate one.
 */
export function createWriteDeliverable(store: WorkspaceStoreLike) {
  return defineTool<WriteDeliverableInput, IdempotentWriteResult>({
    name: "ledger.writeDeliverable",
    description: "Idempotent on (runId, slotId, kind) — writes one produced deliverable. Retrying the same write after a partial failure lands on the same record, not a duplicate one.",
    version: TOOL_VERSION,
    inputSchema: WriteDeliverableInputSchema,
    async execute({ runId, slotId, kind, deliverable }, { ctx }) {
      const segments = ["ledger", "deliverables", runId, slotId ?? "_", kind];
      const { created } = await store.writeJson(ctx.clientSlug, segments, {
        runId,
        slotId,
        kind,
        deliverable,
        updatedAt: Date.now(),
      });
      return success<IdempotentWriteResult>({ id: segments.slice(2).join("__"), created });
    },
  });
}
