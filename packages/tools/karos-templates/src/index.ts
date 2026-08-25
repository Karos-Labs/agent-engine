import { createBundledTemplateStore } from "./bundled-store.js";
import { createCompositeTemplateStore } from "./composite-store.js";
import { createFirestoreTemplateStore, type FirestoreLike } from "./firestore-store.js";
import type { TemplateStore } from "./types.js";

export * from "./types.js";
export * from "./memory-store.js";
export * from "./bundled-store.js";
export * from "./firestore-store.js";
export * from "./composite-store.js";
export * from "./materialize.js";
export * from "./promote.js";

export interface TemplateStoreFactoryOptions {
  /** Directory holding the bundled archetype HTML files. The read-only floor. */
  bundledTemplateDir: string;
  /**
   * A Firestore handle from the composition root. Omit and the registry is
   * bundled-only: fewer templates, no promotion, and rendering still works.
   */
  firestore?: FirestoreLike | undefined;
  collectionName?: string;
}

/**
 * Builds the layered registry: bundled files always, Firestore on top when
 * the composition root supplies a handle.
 *
 * Returns a working store in every configuration, deliberately. There is no
 * `undefined` return and no `not_available` mode, because unlike an image
 * provider or a scraper there is no such thing as a deployment that does not
 * need slide templates — the bundled set ships inside the container, so the
 * floor is always reachable. What a missing Firestore costs is variety and
 * the ability to promote, never the ability to render.
 */
export function createTemplateStore(options: TemplateStoreFactoryOptions): TemplateStore {
  const bundled = createBundledTemplateStore({ templateDir: options.bundledTemplateDir });
  if (!options.firestore) return bundled;
  return createCompositeTemplateStore([
    bundled,
    createFirestoreTemplateStore(options.firestore, options.collectionName),
  ]);
}
