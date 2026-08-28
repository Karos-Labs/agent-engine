import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { contentFail, defineTool, notAvailable, success } from "@agent-engine/tool-common";
import { readCatalog, reservationSegments, writeCatalog, type ReservationRecord } from "./catalog.js";

const TOOL_VERSION = "1.0.0";

export const CommitInputSchema = z.object({
  // No existing TSDoc on this field to transcribe (SCRUM-293 flag) — synthesized from the tool's own doc comment.
  reservationKey: z.string().min(1).describe("Which reservation (from topics.reserve) to consume off the catalog floor for good."),
});
export type CommitInput = z.infer<typeof CommitInputSchema>;

export interface CommitResult {
  reservationKey: string;
  topics: string[];
  alreadyCommitted: boolean;
}

/** Consumes a reservation's topics off the catalog floor for good. Idempotent: committing twice is a no-op. */
export function createCommit(store: WorkspaceStoreLike) {
  return defineTool<CommitInput, CommitResult>({
    name: "topics.commit",
    description: "Consumes a reservation's topics off the catalog floor for good. Idempotent: committing twice is a no-op.",
    version: TOOL_VERSION,
    inputSchema: CommitInputSchema,
    async execute({ reservationKey }, { ctx }) {
      const reservation = await store.readJson<ReservationRecord>(ctx.clientSlug, reservationSegments(reservationKey));
      if (!reservation) {
        return notAvailable<CommitResult>(`no reservation found for key "${reservationKey}"`);
      }
      if (reservation.status === "committed") {
        return success<CommitResult>({ reservationKey, topics: reservation.topics, alreadyCommitted: true });
      }
      if (reservation.status === "released") {
        return contentFail<CommitResult>(`reservation "${reservationKey}" was already released and cannot be committed`);
      }

      const normalizedTopics = new Set(reservation.topics.map((t) => t.trim().toLowerCase()));
      const catalog = await readCatalog(store, ctx.clientSlug);
      for (const record of catalog) {
        if (record.reservationKey === reservationKey && normalizedTopics.has(record.normalized)) {
          record.status = "committed";
        }
      }
      await writeCatalog(store, ctx.clientSlug, catalog);

      reservation.status = "committed";
      await store.writeJson(ctx.clientSlug, reservationSegments(reservationKey), reservation);

      return success<CommitResult>({ reservationKey, topics: reservation.topics, alreadyCommitted: false });
    },
  });
}
