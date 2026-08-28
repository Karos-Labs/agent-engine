import { getFirestore } from "firebase-admin/firestore";
import { createFirestoreClientReportStore, type ClientReportStore } from "@agent-engine/tools";
import { getSharedFirebaseApp } from "./firebase-app.js";

/**
 * The portal-facing Intel Report store (SCRUM-267 / T-A18): the
 * `clientReports` collection the portal's `getClientReport()` reads, document
 * id = clientId.
 *
 * Returns `undefined` when no GCP project is configured, and that is a
 * DELIBERATE hole rather than a memory fallback: `intel.writeReport` then
 * reports `not_available` and an intel run fails visibly. A memory fallback
 * here would reproduce exactly the failure SCRUM-267 exists to remove — a run
 * that succeeds at every step and leaves the portal's read path empty — and it
 * would do it in whichever deployment forgot the env var, which is the one
 * place nobody is looking.
 *
 * Uses Application Default Credentials via the same shared app every other
 * Firestore consumer here does (`durable-store.ts`, `prompt-store.ts`,
 * `template-store.ts`), so it adds no new credential. The engine's Firestore
 * access is ADC; the portal's GCS is not, and nothing about that transfers.
 *
 * `FIRESTORE_DATABASE_ID` selects prep vs prod: ONE project (`karoscmo`), TWO
 * databases — `(default)` is production client data, `prep` is prep. That is
 * why `assertFirestoreDatabaseIdOrExit` runs at startup; this function is
 * downstream of it and reads the same variable every other Firestore client in
 * this service reads.
 */
export function createServerClientReportStore(env: Record<string, string | undefined> = process.env): ClientReportStore | undefined {
  const project = env["GOOGLE_CLOUD_PROJECT"] ?? env["GCLOUD_PROJECT"];
  if (!project) return undefined;
  const databaseId = env["FIRESTORE_DATABASE_ID"] ?? "(default)";
  const db = getFirestore(getSharedFirebaseApp(project), databaseId);
  // The narrowed `FirestoreLike` seam the tool package declares is structurally
  // satisfied by the real SDK handle.
  return createFirestoreClientReportStore(db as unknown as Parameters<typeof createFirestoreClientReportStore>[0]);
}
