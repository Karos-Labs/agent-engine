import type { AgentToolRegistry } from "@agent-engine/core";
import { createWorkspaceStore, type WorkspaceStoreLike, type GcsArtifactStoreLike } from "@agent-engine/tool-common";
import { createDraft } from "./draft.js";
import { createSchedule } from "./schedule.js";
import { createStatus } from "./status.js";
import { createRenderCarousel } from "./render-carousel.js";

export * from "./types.js";
export * from "./draft.js";
export * from "./schedule.js";
export * from "./status.js";
export * from "./render-carousel.js";

/**
 * `mediaStore`, when supplied (wire it via `GCS_MEDIA_BUCKET` at your
 * composition root, e.g. `apps/agent-server/src/wiring`), routes
 * `publish.renderCarousel`'s output PNGs to GCS instead of local scratch
 * paths — omitted, this package's behavior is exactly what it was before
 * Task 1 (RFC-01's GCS media/artifact store).
 */
export function createKarosPublishTools(store: WorkspaceStoreLike = createWorkspaceStore(), mediaStore?: GcsArtifactStoreLike): AgentToolRegistry {
  return {
    "publish.draft": createDraft(store),
    "publish.schedule": createSchedule(store),
    "publish.status": createStatus(store),
    "publish.renderCarousel": createRenderCarousel(mediaStore),
  };
}
