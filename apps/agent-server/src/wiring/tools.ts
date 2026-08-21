import type { AgentToolRegistry } from "@agent-engine/core";
import type { WorkspaceStoreLike } from "@agent-engine/tools";
import { createAllKarosTools, createKarosVideoTools, createKarosLandingTools, createLandingEngineConfigFromEnv } from "@agent-engine/tools";
import { createServerMediaStore, createServerArchiveStore } from "./gcs-artifact-stores.js";

/**
 * The full tools registry this server can dispatch against — every
 * `createAllKarosTools()` entry plus `video.*`/`landing.*`, which that
 * bundle deliberately excludes (see its own doc comment: neither has a safe
 * zero-config default — a Python engine checkout, a template-kit root).
 * Required for `branded-shorts-agent`/`landing-builder-agent` to be
 * dispatchable at all (RFC-06/07); harmless to merge in unconditionally for
 * every other product, since `video.*`/`landing.*` tools degrade to a
 * per-call `tooling_error` — never a construction-time throw — when their
 * own env vars (`BRANDED_SHORTS_ENGINE_DIR`, `LANDING_ENGINE_*_ROOT`) aren't
 * set, exactly like every other env-configured tool in this codebase.
 *
 * `mediaStore`/`archiveStore` (Task 1/Task 2, RFC-01's GCS media/artifact
 * store) are `undefined` unless `GCS_MEDIA_BUCKET`/`GCS_ARTIFACTS_BUCKET`
 * are set — every affected tool (`publish.renderCarousel`,
 * `video.uploadDeliverable`, `landing.uploadSiteBundle`) then keeps its
 * exact pre-GCS local-only behavior.
 */
export function createServerTools(workspaceStore: WorkspaceStoreLike, env: Record<string, string | undefined> = process.env): AgentToolRegistry {
  const mediaStore = createServerMediaStore(env);
  const archiveStore = createServerArchiveStore(env);
  return {
    ...createAllKarosTools(workspaceStore, mediaStore),
    ...createKarosVideoTools({ env, ...(mediaStore ? { mediaStore } : {}) }),
    ...createKarosLandingTools(createLandingEngineConfigFromEnv({ env }), archiveStore, workspaceStore),
  };
}
