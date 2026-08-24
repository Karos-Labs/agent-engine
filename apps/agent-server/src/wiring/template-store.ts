import * as path from "node:path";
import { getFirestore } from "firebase-admin/firestore";
import { createTemplateStore, type TemplateStore } from "@agent-engine/tool-karos-templates";
import { getSharedFirebaseApp } from "./firebase-app.js";

/**
 * Where the bundled archetype templates ship inside the image.
 *
 * Resolved against `INSTAGRAM_AGENT_REPO_ROOT` (`/app` in Cloud Run) rather
 * than the process cwd, because that is the root the whole instagram pipeline
 * is already bounds-checked against and the one the Dockerfile copies the
 * agent's `assets/` into.
 */
export function resolveBundledTemplateDir(env: Record<string, string | undefined> = process.env): string {
  const repoRoot = env["INSTAGRAM_AGENT_REPO_ROOT"] ?? ".";
  return path.resolve(repoRoot, "agents/instagram-agent/assets/templates/default");
}

/**
 * Builds the slide-template registry: the bundled files always, layered with
 * Firestore when a project is configured.
 *
 * Always returns a store, never `undefined`. Unlike an image provider or a
 * scraper there is no deployment that does not need slide templates, and the
 * bundled set ships inside the container — so the floor is always reachable
 * and a missing Firestore costs variety and the promotion path, never the
 * ability to render. That is why this has no `not_available` mode.
 *
 * Uses Application Default Credentials via the same shared app every other
 * Firestore consumer here does, so it adds no new credential.
 */
export function createServerTemplateStore(env: Record<string, string | undefined> = process.env): TemplateStore {
  const project = env["GOOGLE_CLOUD_PROJECT"] ?? env["GCLOUD_PROJECT"];
  const bundledTemplateDir = resolveBundledTemplateDir(env);
  if (!project) {
    return createTemplateStore({ bundledTemplateDir });
  }
  const databaseId = env["FIRESTORE_DATABASE_ID"] ?? "(default)";
  const db = getFirestore(getSharedFirebaseApp(project), databaseId);
  return createTemplateStore({
    bundledTemplateDir,
    // The narrowed `FirestoreLike` seam this package declares is structurally
    // satisfied by the real SDK handle.
    firestore: db as unknown as Parameters<typeof createTemplateStore>[0]["firestore"],
  });
}
