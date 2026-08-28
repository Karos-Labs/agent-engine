import type { AgentToolRegistry } from "@agent-engine/core";
import type { WorkspaceStoreLike } from "@agent-engine/tools";
import {
  createAllKarosTools,
  createKarosVideoTools,
  createKarosLandingTools,
  createKarosIntakeTools,
  createKarosMediaTools,
  createLandingEngineConfigFromEnv,
} from "@agent-engine/tools";
import { createServerMediaStore, createServerArchiveStore } from "./gcs-artifact-stores.js";
import { createServerClientReportStore } from "./client-report-store.js";

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
 * `media.*` is merged in on the same terms, though it no longer needs a
 * credential at all: three of its providers (Openverse, Wikimedia, DuckDuckGo)
 * are keyless, so every deployment gets a working image chain and keys only
 * ever *add* sources. It used to report `not_available` without
 * `UNSPLASH_ACCESS_KEY`, which is exactly what held every prep Instagram run
 * while that key sat unprovisioned — see this package's README.
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
  // SCRUM-267: the portal-facing clientReports store. `undefined` with no GCP
  // project configured, which makes `intel.writeReport` report `not_available`
  // rather than write only to the workspace — see `client-report-store.ts`.
  const clientReportStore = createServerClientReportStore(env);
  return {
    // `env` threaded so `research.pull` builds its real ScrappyCoco scraper
    // from SCRAPPYCOCO_API_KEY. Without it the bundle would read process.env
    // anyway, but passing it keeps this composition root the single place a
    // deployment's configuration enters the tool graph.
    ...createAllKarosTools(workspaceStore, mediaStore, { env, ...(clientReportStore ? { clientReportStore } : {}) }),
    ...createKarosVideoTools({ env, ...(mediaStore ? { mediaStore } : {}) }),
    ...createKarosLandingTools(createLandingEngineConfigFromEnv({ env }), archiveStore, workspaceStore),
    // `mediaStore` doubles as Tier 0's gs:// reader: a client's upload lives in
    // the same bucket the deliverables do, and giving the media tools a second
    // GCS client for one read would be two credentials for one job.
    ...createKarosMediaTools({ env, ...(mediaStore ? { objectReader: mediaStore } : {}) }),
    // The write side of a client's setup documents. Merged in for every
    // product because the registry is shared, but only the setup workflows
    // name it in a step -- a drafting agent that never calls it cannot
    // rewrite the charter it is judged against.
    ...createKarosIntakeTools(workspaceStore),
  };
}
