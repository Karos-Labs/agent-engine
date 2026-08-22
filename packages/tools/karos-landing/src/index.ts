import type { AgentToolRegistry } from "@agent-engine/core";
import type { GcsArtifactStoreLike, WorkspaceStoreLike } from "@agent-engine/tool-common";
import type { LandingEngineConfig } from "./config.js";
import { createReadBundle } from "./read-bundle/read-bundle-tool.js";
import { createCopyTemplate } from "./copy-template/copy-template-tool.js";
import { createWriteSiteFile } from "./write-file/write-file-tool.js";
import { createReadSiteFile } from "./write-file/read-file-tool.js";
import { createLandingGate } from "./gate/gate-tool.js";
import { createRenderCheck } from "./render-check/render-check-tool.js";
import { createUpdateBrandFeedback } from "./update-brand-feedback/update-brand-feedback-tool.js";
import { createUploadSiteBundle } from "./upload-site-bundle/upload-site-bundle-tool.js";
import { createRestoreSiteBundle } from "./site-staging/restore-site-bundle-tool.js";
import { createStageSiteBundle } from "./site-staging/stage-site-bundle-tool.js";

export * from "./config.js";
export * from "./create-landing-engine-config-from-env.js";
export * from "./generated-paths.js";
export * from "./types.js";
export * from "./sandbox/site-sandbox.js";
export * from "./read-bundle/read-bundle-tool.js";
export * from "./copy-template/copy-template-tool.js";
export * from "./write-file/write-file-tool.js";
export * from "./write-file/read-file-tool.js";
export * from "./gate/shared.js";
export * from "./gate/carry-forward.js";
export * from "./gate/gate-tool.js";
export * from "./render-check/render-check-tool.js";
export * from "./update-brand-feedback/update-brand-feedback-tool.js";
export * from "./upload-site-bundle/upload-site-bundle-tool.js";
export * from "./site-staging/manifest.js";
export * from "./site-staging/stage-site-bundle-tool.js";
export * from "./site-staging/restore-site-bundle-tool.js";

/**
 * The Landing Builder (s6, RFC-07) tool registry. Every write-capable tool
 * here (`landing.copyTemplate`, `landing.writeSiteFile`) is bound at
 * construction time to `config`'s three roots — `templateRoot` (read-only),
 * `engineClientsRoot` (each client's `OUTPUT_PATH`), `bundlesRoot` (each
 * client's `INPUT_BUNDLE`) — never to a caller-supplied path, so the write
 * fence RFC-07 §4/§7 requires is structural, not conventional. `landing.gate`
 * is the deterministic Layer 1 floor (token drift/font fidelity/brand lint/
 * structure/carry-forward completeness); `landing.renderCheck` is the
 * Playwright render battery. The Layer 3 craft-verdict judgment pass is
 * deliberately NOT a tool here — RFC-07 §7 calls it "likely a bounded agent
 * step rather than a tool, since it is a judgment call" — it lives in
 * `agents/landing-builder-agent` as a `BaseAgent` subclass instead.
 */
/**
 * `artifactStore`, when supplied (wire it via `GCS_ARTIFACTS_BUCKET` at your
 * composition root), registers `landing.uploadSiteBundle` — see that tool's
 * own doc comment for what it does and does not upload today. Omitted, this
 * package's behavior is exactly what it was before Task 1 (RFC-01's GCS
 * artifact store).
 *
 * `workspaceStore`, when supplied, makes `landing.readBundle` read a
 * client's `brand.json`/`intake.md` from there instead of local disk
 * (agent-engine#3's fix — see `read-bundle-tool.ts`'s own doc comment).
 * `apps/agent-server`'s real wiring always supplies one; omitting it keeps
 * this tool's original local-disk-only behavior, which is exactly what unit
 * tests still exercise.
 */
export function createKarosLandingTools(config: LandingEngineConfig, artifactStore?: GcsArtifactStoreLike, workspaceStore?: WorkspaceStoreLike): AgentToolRegistry {
  return {
    "landing.readBundle": createReadBundle(config, workspaceStore),
    "landing.copyTemplate": createCopyTemplate(config),
    "landing.writeSiteFile": createWriteSiteFile(config),
    "landing.readSiteFile": createReadSiteFile(config),
    "landing.gate": createLandingGate(config),
    "landing.renderCheck": createRenderCheck(),
    "landing.updateBrandFeedback": createUpdateBrandFeedback(config),
    // All three need the artifact store, so they appear and disappear
    // together: a deployment without GCS_ARTIFACTS_BUCKET keeps the exact
    // pre-staging behaviour rather than half-enabling the gate-pause fix.
    ...(artifactStore
      ? {
          "landing.uploadSiteBundle": createUploadSiteBundle(config, artifactStore),
          "landing.stageSiteBundle": createStageSiteBundle(config, artifactStore),
          "landing.restoreSiteBundle": createRestoreSiteBundle(config, artifactStore),
        }
      : {}),
  };
}
