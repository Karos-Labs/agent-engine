import { logError } from "@agent-engine/telemetry";

/**
 * Refuse to boot on an unrecognised `FIRESTORE_DATABASE_ID` (AU60 / SCRUM-359).
 *
 * ## What this one string decides
 *
 * Prep and production are ONE Firestore project (`karoscmo`) with TWO databases
 * — `(default)` and `prep`. The separation between prep data and live client
 * data is this variable and nothing else: the same credential reaches both, so
 * there is no credential boundary behind it.
 *
 * It is read in eight places. Five construct a Firestore client and every one
 * of them defaults the same way:
 *
 *   wiring/durable-store.ts:33            ?? "(default)"
 *   wiring/agent-definitions-store.ts:27  ?? "(default)"
 *   wiring/template-store.ts:38           ?? "(default)"
 *   core/create-prompt-store-from-env.ts  ?? "(default)"  (x2)
 *
 * Three more derive meaning from it rather than a database:
 *
 *   wiring/auth.ts:55        isProduction — gates the dev-token auth bypass
 *   telemetry/tracer.ts:87   the environment label on every span
 *   diagnostics/capability-report.ts:135  the environment the report claims
 *
 * ## The failure direction, observed rather than assumed
 *
 *   absent        -> "(default)" -> REACHABLE, silently reads/writes PRODUCTION
 *   empty string  -> "(default)" -> same: `??`/`||` treat "" as absent
 *   misspelled    -> NOT_FOUND at first use — fails loudly, which is fine
 *
 * So a typo fails safe and an ABSENT variable fails toward production. That is
 * the wrong way round, and it is the case a dropped env var in a deploy, or a
 * new service that never knew to set it, actually produces.
 *
 * Worse, the two boundaries move in OPPOSITE safety directions on the same
 * absent value: `isProduction` becomes true (dev-token bypass correctly
 * refused) while the database silently becomes production. One of those is
 * fail-closed and the other is fail-open, from the same missing string.
 *
 * ## Why refuse to boot
 *
 * A service that will not start is far cheaper than one writing to the wrong
 * database, and unlike a wrong write it is impossible to miss. This is the
 * only place the variable is validated at all.
 *
 * Scoped to deployments that actually reach Firestore: with no
 * `GOOGLE_CLOUD_PROJECT` every store falls back to its in-memory
 * implementation (`createDurableStoreFromEnv` returns `MemoryDurableStepStore`),
 * so local development without GCP credentials keeps working untouched.
 */

/** The databases that exist. `gcloud firestore databases list --project=karoscmo` returns exactly these two. */
export const KNOWN_FIRESTORE_DATABASE_IDS = ["(default)", "prep"] as const;

export class FirestoreDatabaseIdError extends Error {}

/**
 * Throws unless `FIRESTORE_DATABASE_ID` names a database that exists — or
 * unless this deployment has no GCP project at all, in which case nothing
 * talks to Firestore and there is nothing to protect.
 */
export function assertFirestoreDatabaseId(env: Record<string, string | undefined> = process.env): void {
  const project = env["GOOGLE_CLOUD_PROJECT"] ?? env["GCLOUD_PROJECT"];
  if (!project || project.trim().length === 0) return;

  const raw = env["FIRESTORE_DATABASE_ID"];

  if (raw === undefined || raw.trim().length === 0) {
    throw new FirestoreDatabaseIdError(
      `FIRESTORE_DATABASE_ID is ${raw === undefined ? "not set" : "empty"} while GOOGLE_CLOUD_PROJECT="${project}" is. ` +
        `Every Firestore client in this service would silently fall back to "(default)" — production client data — and ` +
        `wiring/auth.ts would additionally read this deployment as production. ` +
        `Set it explicitly to one of: ${KNOWN_FIRESTORE_DATABASE_IDS.join(", ")}.`,
    );
  }

  if (!(KNOWN_FIRESTORE_DATABASE_IDS as readonly string[]).includes(raw)) {
    throw new FirestoreDatabaseIdError(
      `FIRESTORE_DATABASE_ID="${raw}" is not a database that exists. ` +
        `A misspelling fails at first use with NOT_FOUND rather than at startup, which is late and looks like an outage. ` +
        `Valid values: ${KNOWN_FIRESTORE_DATABASE_IDS.join(", ")}.`,
    );
  }
}

/** Entry-point wrapper: assert, and on failure log the reason before exiting rather than dying on an unhandled throw. */
export function assertFirestoreDatabaseIdOrExit(env: Record<string, string | undefined> = process.env): void {
  try {
    assertFirestoreDatabaseId(env);
  } catch (err) {
    logError("refusing to start: FIRESTORE_DATABASE_ID is not a database that exists", err);
    process.exit(1);
  }
}
