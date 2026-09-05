import type { AgentToolRegistry } from "@agent-engine/core";
import type { GcsArtifactStoreLike, WorkspaceStoreLike } from "@agent-engine/tool-common";
import type { LandingEngineConfig } from "./config.js";
import { createCaptureSite, type CaptureSiteDeps } from "./capture/capture-site-tool.js";
import { createCheckPage } from "./page/check-page.js";
import { createRenderPage, type RenderPageDeps } from "./render/render-page-tool.js";
import { createDeployPage, type DeployPageDeps } from "./hosting/deploy-page-tool.js";
import { createUploadPage } from "./publish/upload-page-tool.js";
import { createReadLandingIntake, createWriteLandingState } from "./state/intake-tools.js";

export * from "./config.js";
export * from "./types.js";
export * from "./page/types.js";
export * from "./page/assemble.js";
export * from "./page/check-page.js";
export * from "./capture/capture-site-tool.js";
export * from "./render/render-page-tool.js";
export * from "./hosting/firebase-hosting.js";
export * from "./hosting/deploy-page-tool.js";
export * from "./publish/upload-page-tool.js";
export * from "./state/intake-tools.js";

export interface KarosLandingToolDeps {
  /** Screenshots, the archived page and its build record go here (`GCS_ARTIFACTS_BUCKET`). Without it: no screenshots, no archive, no `landing.uploadPage`. */
  artifactStore?: GcsArtifactStoreLike;
  /** The client workspace (`GCS_WORKSPACE_BUCKET`): optional hand-curated landing inputs and the published-build state. */
  workspaceStore?: WorkspaceStoreLike;
  /** Test seams. */
  capture?: Pick<CaptureSiteDeps, "fetchImpl" | "loadChromium">;
  render?: Pick<RenderPageDeps, "loadChromium">;
  deploy?: DeployPageDeps;
}

/**
 * The Landing Builder v2 tool registry (RFC-11). Everything the workflow
 * needs beyond the shared `client.*`/`ledger.*` tools:
 *
 * - `landing.readIntake` / `landing.writeState` — the client's optional
 *   hand-curated inputs and the published-build state (workspace store).
 * - `landing.captureSite` — the client's current site, for carry-forward.
 * - `landing.checkPage` — the deterministic floor over the assembled HTML.
 * - `landing.renderPage` — headless render: metrics + screenshots.
 * - `landing.uploadPage` — archive to the artifacts bucket.
 * - `landing.deployPage` — Firebase Hosting preview channel, then live.
 *
 * Tools whose backing service is not configured are NOT registered, rather
 * than registered as stubs that answer politely with nothing: the workflow
 * reads the registry to decide what it can promise the reviewer (a `.web.app`
 * URL, a signed GCS URL, or only the checks).
 */
export function createKarosLandingTools(config: LandingEngineConfig, deps: KarosLandingToolDeps = {}): AgentToolRegistry {
  const { artifactStore, workspaceStore } = deps;
  return {
    "landing.captureSite": createCaptureSite({ ...(artifactStore ? { artifactStore } : {}), ...deps.capture }),
    "landing.checkPage": createCheckPage(),
    "landing.renderPage": createRenderPage({ ...(artifactStore ? { artifactStore } : {}), ...deps.render }),
    ...(workspaceStore ? { "landing.readIntake": createReadLandingIntake(workspaceStore), "landing.writeState": createWriteLandingState(workspaceStore) } : {}),
    ...(artifactStore ? { "landing.uploadPage": createUploadPage(artifactStore) } : {}),
    ...(config.hosting ? { "landing.deployPage": createDeployPage(config.hosting, deps.deploy ?? {}) } : {}),
  };
}
