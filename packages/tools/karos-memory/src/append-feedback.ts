import { z } from "zod";
import type { IdempotentWriteResult, WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";

// 1.0.1 (SCRUM-296/AU11): removed the redundant re-parse of already-validated input (both tools below share this constant).
const TOOL_VERSION = "1.0.1";

export const AppendFeedbackInputSchema = z.object({
  /**
   * Caller-minted idempotency key. `${runId}-r${revision}` is the natural
   * choice: a run replayed after a crash must not append a reviewer's note
   * twice, and that key is stable across replays.
   */
  feedbackId: z.string().min(1),
  /** Which product the feedback was about, so a later run can weight its own agent's history first. */
  productId: z.string().min(1),
  decision: z.enum(["approve", "revise", "reject"]),
  actor: z.string().min(1),
  /** The reviewer's words. The whole point of the row. */
  note: z.string().min(1),
  /** Which revision round produced the output being judged. */
  revision: z.number().int().nonnegative().default(0),
  /** The run this came from, for tracing a preference back to what prompted it. */
  runId: z.string().min(1).optional(),
});
export type AppendFeedbackInput = z.input<typeof AppendFeedbackInputSchema>;

/**
 * `memory.appendFeedback` — durable review feedback, per client.
 *
 * ## Why this is not `memory.appendDecision`
 *
 * A decision is something an AGENT concluded and is recording so it stays
 * consistent with itself. This is something a PERSON asked for, and the two
 * want different treatment: feedback is read back as instruction on the next
 * run, is attributed to a human, and carries a verdict. Folding them into one
 * log would mean a later run could not tell "we decided to lead with the
 * metric" from "the client told us to stop leading with the metric".
 *
 * Written for EVERY decision including approvals, deliberately. An approving
 * reviewer who says "the shorter hooks are working" is teaching the system
 * something, and a store that only remembers complaints learns a distorted
 * version of what a client wants.
 *
 * Idempotent on `feedbackId`, so a replayed run appends one row.
 */
export function createAppendFeedback(store: WorkspaceStoreLike) {
  return defineTool<AppendFeedbackInput, IdempotentWriteResult>({
    name: "memory.appendFeedback",
    version: TOOL_VERSION,
    inputSchema: AppendFeedbackInputSchema,
    async execute(input, { ctx }) {
      const segments = ["memory", "feedback", input.feedbackId];
      const { created } = await store.writeJson(ctx.clientSlug, segments, {
        feedbackId: input.feedbackId,
        productId: input.productId,
        decision: input.decision,
        actor: input.actor,
        note: input.note,
        revision: input.revision,
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        at: Date.now(),
      });
      return success<IdempotentWriteResult>({ id: input.feedbackId, created });
    },
  });
}

export const ReadFeedbackInputSchema = z.object({
  /** Restrict to one product's history. Omit for every product's. */
  productId: z.string().min(1).optional(),
  /**
   * Newest-first cap. Bounded because this lands in a drafting prompt: a
   * client with two years of feedback would otherwise push the actual brief
   * out of the context window, which is the exact "context bloat" defect the
   * engine's own design notes call out.
   */
  limit: z.number().int().min(1).max(50).default(10),
});
export type ReadFeedbackInput = z.input<typeof ReadFeedbackInputSchema>;

export interface FeedbackEntry {
  feedbackId: string;
  productId: string;
  decision: "approve" | "revise" | "reject";
  actor: string;
  note: string;
  revision: number;
  runId?: string;
  at: number;
}

export interface ReadFeedbackResult {
  entries: FeedbackEntry[];
}

/**
 * `memory.readFeedback` — what people have asked for before, newest first.
 *
 * This is the read side of the flywheel: without it every run starts from
 * zero and the same correction gets made every week.
 */
export function createReadFeedback(store: WorkspaceStoreLike) {
  return defineTool<ReadFeedbackInput, ReadFeedbackResult>({
    name: "memory.readFeedback",
    version: TOOL_VERSION,
    inputSchema: ReadFeedbackInputSchema,
    async execute(input, { ctx }) {
      // No trailing placeholder segment: `dirPath` joins EVERY segment as a
      // directory, so `["memory","feedback","_"]` would look inside a literal
      // `_` folder and always return nothing. `appendFeedback` writes to
      // `["memory","feedback",<id>]`, so the directory to list is its parent.
      //
      // `listJson` returns `{id, data}` wrappers, so the row itself is `.data`.
      const rows = await store.listJson<FeedbackEntry>(ctx.clientSlug, ["memory", "feedback"]);
      const entries = rows
        .map((r) => r.data)
        .filter((r) => input.productId === undefined || r.productId === input.productId)
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
        .slice(0, input.limit);
      return success<ReadFeedbackResult>({ entries });
    },
  });
}
