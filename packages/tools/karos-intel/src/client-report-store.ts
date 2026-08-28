import { CLIENT_REPORTS_COLLECTION, type ClientReport } from "./types.js";

/**
 * The slice of Firestore this store uses, declared structurally so the package
 * takes no dependency on `firebase-admin` — the same seam
 * `@agent-engine/tool-karos-templates`'s `FirestoreLike` declares, for the same
 * reason: the composition root owns the SDK, the package owns the behaviour,
 * and the whole store stays testable with a plain object.
 */
export interface FirestoreLike {
  collection(name: string): {
    doc(id: string): {
      get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
      set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
    };
  };
}

/**
 * Where an Intel Report lands so the PORTAL can read it.
 *
 * SCRUM-267's first defect in one line: `intel.writeReport` wrote to the
 * engine's workspace store and nowhere else, so a completed intel run left the
 * portal's `getClientReport()` returning exactly what it returned before the
 * run — null. Tomer's 2026-08-28 decision 5 turns that from a reporting gap
 * into an onboarding dependency: "the output must be written in EXACTLY the
 * same shape, to EXACTLY the same Firestore location the system already reads
 * from. The wrapper and every existing query stay identical."
 *
 * So this interface is deliberately narrow — one document per client, keyed by
 * the portal's clientId. There is no query surface here because the portal's
 * queries are not changing.
 */
export interface ClientReportStore {
  /** For diagnostics/telemetry — which backend actually took the write. */
  readonly name: string;
  read(clientId: string): Promise<ClientReport | undefined>;
  write(report: ClientReport): Promise<void>;
}

/**
 * Firestore-backed store writing to the collection and document id the portal
 * reads from, reproducing `upsertClientReport` (`karosCMO/src/lib/data.ts`
 * lines 1374-1376) exactly:
 * ```
 * await col.clientReports().doc(data.clientId).set({ id: data.clientId, ...data });
 * ```
 * Two details are load-bearing and are why this is not a `merge: true` write:
 *  - the document id is the clientId, not an auto-id, so a regeneration
 *    overwrites the one report rather than appending a second;
 *  - `set` WITHOUT merge is a full replace, which is what legacy did. Merging
 *    would leave stale sections from a previous report alive underneath a new
 *    one — a report that is half last month's is worse than no report, because
 *    nothing about it looks wrong.
 */
export function createFirestoreClientReportStore(db: FirestoreLike, collectionName: string = CLIENT_REPORTS_COLLECTION): ClientReportStore {
  return {
    name: `firestore:${collectionName}`,
    async read(clientId) {
      const snap = await db.collection(collectionName).doc(clientId).get();
      if (!snap.exists) return undefined;
      const data = snap.data();
      return data === undefined ? undefined : ({ id: clientId, ...data } as unknown as ClientReport);
    },
    async write(report) {
      await db
        .collection(collectionName)
        .doc(report.clientId)
        .set({ ...(report as unknown as Record<string, unknown>), id: report.clientId });
    },
  };
}

/** In-memory store — tests, evals and local demo runs. Never a deployment default: see `createKarosIntelTools`. */
export function createMemoryClientReportStore(): ClientReportStore & { docs: Map<string, ClientReport> } {
  const docs = new Map<string, ClientReport>();
  return {
    name: "memory",
    docs,
    async read(clientId) {
      return docs.get(clientId);
    },
    async write(report) {
      docs.set(report.clientId, { ...report });
    },
  };
}
