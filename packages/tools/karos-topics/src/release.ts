import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { contentFail, defineTool, notAvailable, success } from "@agent-engine/tool-common";
import { readCatalog, reservationSegments, writeCatalog, type ReservationRecord } from "./catalog.js";

const TOOL_VERSION = "1.0.0";

export const ReleaseInputSchema = z.object({ reservationKey: z.string().min(1) });
export type ReleaseInput = z.infer<typeof ReleaseInputSchema>;

export interface ReleaseResult {
  reservationKey: string;
  alreadyReleased: boolean;
}

/** Returns a reservation's topics to the available floor (e.g. the run that reserved them failed). Idempotent: releasing twice is a no-op. */
export function createRelease(store: WorkspaceStoreLike) {
  return defineTool<ReleaseInput, ReleaseResult>({
    name: "topics.release",
    version: TOOL_VERSION,
    inputSchema: ReleaseInputSchema,
    async execute({ reservationKey }, { ctx }) {
      const reservation = await store.readJson<ReservationRecord>(ctx.clientSlug, reservationSegments(reservationKey));
      if (!reservation) {
        return notAvailable<ReleaseResult>(`no reservation found for key "${reservationKey}"`);
      }
      if (reservation.status === "released") {
        return success<ReleaseResult>({ reservationKey, alreadyReleased: true });
      }
      if (reservation.status === "committed") {
        return contentFail<ReleaseResult>(`reservation "${reservationKey}" has already been committed and cannot be released`);
      }

      const normalizedTopics = new Set(reservation.topics.map((t) => t.trim().toLowerCase()));
      const catalog = await readCatalog(store, ctx.clientSlug);
      for (const record of catalog) {
        if (record.reservationKey === reservationKey && normalizedTopics.has(record.normalized)) {
          record.status = "available";
          delete record.reservationKey;
        }
      }
      await writeCatalog(store, ctx.clientSlug, catalog);

      reservation.status = "released";
      await store.writeJson(ctx.clientSlug, reservationSegments(reservationKey), reservation);

      return success<ReleaseResult>({ reservationKey, alreadyReleased: false });
    },
  });
}
