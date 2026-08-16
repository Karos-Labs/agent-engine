import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { contentFail, defineTool, success } from "@agent-engine/tool-common";
import { normalizeTopic, readCatalog, reservationSegments, writeCatalog, type ReservationRecord } from "./catalog.js";

const TOOL_VERSION = "1.0.0";

export const ReserveInputSchema = z.object({
  /** Caller-supplied idempotency key (RFC-01 §9.1 rule 2) — replaying it returns the same reservation, never a second one. */
  reservationKey: z.string().min(1),
  count: z.number().int().positive(),
  excludeTopics: z.array(z.string()).default([]),
});
export type ReserveInput = z.infer<typeof ReserveInputSchema>;

export interface ReserveResult {
  reservationKey: string;
  topics: string[];
  created: boolean;
}

/**
 * Reserves `count` topics off the no-repeat catalog floor. Idempotent on
 * `reservationKey`: a retried call with the same key returns the exact same
 * reservation instead of consuming more of the catalog.
 */
export function createReserve(store: WorkspaceStoreLike) {
  return defineTool<ReserveInput, ReserveResult>({
    name: "topics.reserve",
    version: TOOL_VERSION,
    inputSchema: ReserveInputSchema,
    async execute({ reservationKey, count, excludeTopics }, { ctx }) {
      const existing = await store.readJson<ReservationRecord>(ctx.clientSlug, reservationSegments(reservationKey));
      if (existing) {
        return success<ReserveResult>({ reservationKey, topics: existing.topics, created: false });
      }

      const excluded = new Set(excludeTopics.map(normalizeTopic));
      const catalog = await readCatalog(store, ctx.clientSlug);
      const available = catalog.filter((r) => r.status === "available" && !excluded.has(r.normalized));

      if (available.length < count) {
        return contentFail<ReserveResult>(
          `only ${available.length} of the ${count} requested topics are available on the catalog floor`,
        );
      }

      const chosen = available.slice(0, count);
      const chosenNormalized = new Set(chosen.map((r) => r.normalized));
      for (const record of catalog) {
        if (chosenNormalized.has(record.normalized)) {
          record.status = "reserved";
          record.reservationKey = reservationKey;
        }
      }
      await writeCatalog(store, ctx.clientSlug, catalog);

      const topics = chosen.map((r) => r.topic);
      const reservation: ReservationRecord = { reservationKey, topics, status: "reserved" };
      await store.writeJson(ctx.clientSlug, reservationSegments(reservationKey), reservation);

      return success<ReserveResult>({ reservationKey, topics, created: true });
    },
  });
}
