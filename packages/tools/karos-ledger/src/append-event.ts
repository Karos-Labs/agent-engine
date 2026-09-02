import { z } from "zod";
import type { IdempotentWriteResult, WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const AppendEventInputSchema = z.object({
  // No existing TSDoc on these three fields to transcribe (SCRUM-293 flag) — synthesized from the tool's own doc comment and execute()'s usage.
  runId: z.string().min(1).describe("The run this event belongs to."),
  eventId: z.string().min(1).describe("Caller-minted idempotency key for this one event."),
  // "warn" added by IGSTYLE-3/IGSTYLE-8 (agent-engine — the instagram-agent
  // style-directive-refusal and contrast-below-floor ledger events, each on
  // its own independent branch): a fact worth a reviewer's attention that
  // does not rise to "error" (nothing failed; the run still completed) and
  // is not "success" either. Purely additive — no existing exhaustive switch
  // over this enum's members exists anywhere in this repo (checked before
  // adding), so no other caller's behavior changes.
  level: z.enum(["info", "warn", "error", "success"]).describe("This event's severity/kind."),
  message: z.string().min(1).describe("The human-readable event text."),
});
export type AppendEventInput = z.infer<typeof AppendEventInputSchema>;

/** Idempotent on `(runId, eventId)` — an append-only run event log with no duplicate rows on replay. */
export function createAppendEvent(store: WorkspaceStoreLike) {
  return defineTool<AppendEventInput, IdempotentWriteResult>({
    name: "ledger.appendEvent",
    description: "Idempotent on (runId, eventId) — appends one entry to a run's event log with no duplicate rows on replay.",
    version: TOOL_VERSION,
    inputSchema: AppendEventInputSchema,
    async execute({ runId, eventId, level, message }, { ctx }) {
      const segments = ["ledger", "events", runId, eventId];
      const { created } = await store.writeJson(ctx.clientSlug, segments, {
        runId,
        eventId,
        level,
        message,
        at: Date.now(),
      });
      return success<IdempotentWriteResult>({ id: `${runId}__${eventId}`, created });
    },
  });
}
