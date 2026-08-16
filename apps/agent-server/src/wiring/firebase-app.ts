import { getApps, initializeApp, applicationDefault, type App } from "firebase-admin/app";

/**
 * One shared `firebase-admin` `App` per process — both the durable step
 * store and the Firestore prompt store (if configured) need a Firestore
 * client, and `initializeApp()` throws if called twice for the same default
 * app. Application Default Credentials only: `gcloud auth
 * application-default login` locally, or the attached Service Account in
 * Cloud Run/GKE — no key file is ever read from an env var here.
 */
export function getSharedFirebaseApp(projectId: string): App {
  const existing = getApps()[0];
  if (existing) {
    return existing;
  }
  return initializeApp({ credential: applicationDefault(), projectId });
}
