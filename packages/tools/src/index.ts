import type { AgentToolRegistry } from "@agent-engine/core";
import type { WorkspaceStoreLike, GcsArtifactStoreLike } from "@agent-engine/tool-common";
import { createKarosClientTools } from "@agent-engine/tool-karos-client";
import { createKarosGatesTools } from "@agent-engine/tool-karos-gates";
import { createKarosIntelTools } from "@agent-engine/tool-karos-intel";
import { createKarosLedgerTools } from "@agent-engine/tool-karos-ledger";
import { createKarosMemoryTools } from "@agent-engine/tool-karos-memory";
import { createKarosPublishTools } from "@agent-engine/tool-karos-publish";
import { createKarosReputationTools } from "@agent-engine/tool-karos-reputation";
import { createKarosResearchTools } from "@agent-engine/tool-karos-research";
import { createKarosSeoGeoTools } from "@agent-engine/tool-karos-seo-geo";
import { createKarosTopicsTools } from "@agent-engine/tool-karos-topics";

export * from "@agent-engine/tool-common";
export * from "@agent-engine/tool-karos-client";
export * from "@agent-engine/tool-karos-gates";
export * from "@agent-engine/tool-karos-intel";
export * from "@agent-engine/tool-karos-landing";
export * from "@agent-engine/tool-karos-ledger";
export * from "@agent-engine/tool-karos-memory";
export * from "@agent-engine/tool-karos-publish";
export * from "@agent-engine/tool-karos-reputation";
export * from "@agent-engine/tool-karos-research";
export * from "@agent-engine/tool-karos-seo-geo";
export * from "@agent-engine/tool-karos-topics";
export * from "@agent-engine/tool-karos-video";

/**
 * The full Layer 3 tool registry (RFC-01 §9.2): every karos-* MCP server's
 * tools, merged into the one `AgentToolRegistry` shape `BaseAgent` expects on
 * `runtime.tools`. Each server still ships as its own workspace package —
 * this is a convenience bundle for wiring up a `BaseAgentRuntime` in one call,
 * not a new abstraction layer.
 *
 * `store` is optional and shared across every storage-backed server (all but
 * `karos-gates` and `karos-seo-geo`, which are both stateless/pure) — omit
 * it to fall back to each server's own default (`createWorkspaceStore()`,
 * env-configured), or pass one explicitly (e.g. pointed at a temp directory)
 * so every server reads and writes the same isolated workspace, which is
 * exactly what tests need.
 *
 * `reputation.publish` is deliberately absent from `karos-reputation`'s own
 * registry and therefore from this bundle too (RFC-08 §9: "the tool exists,
 * the door stays locked" — it is built and wired only inside
 * `agents/reputation-agent`'s own workflow, permanently gated, never handed
 * out as an always-available Layer 3 capability).
 *
 * `video.*` (`@agent-engine/tool-karos-video`, RFC-06 §3) is exported from
 * this package but deliberately excluded from `createAllKarosTools()`: every
 * other server here needs at most an optional `store`, but the video tools
 * require a real Python engine checkout (`BRANDED_SHORTS_ENGINE_DIR`) and
 * carry a CPU/time execution profile no other tool in this bundle has — a
 * caller that hasn't made that vendoring decision should get "no such tool
 * registered" rather than a registry entry that silently `tooling_error`s on
 * every call. `agents/branded-shorts-agent` wires `createKarosVideoTools()`
 * in explicitly, alongside this bundle.
 *
 * `landing.*` (`@agent-engine/tool-karos-landing`, RFC-07 §7) is exported
 * from this package for the same reason and excluded the same way: every
 * write-capable `landing.*` tool is bound at construction to a concrete
 * `templateRoot`/`engineClientsRoot`/`bundlesRoot` (there is no safe
 * zero-config default for "where is the FORGE-proven template kit checked
 * out"), so a caller that hasn't made that deployment decision should get
 * "no such tool registered," not a registry entry that fails on every call.
 * `agents/landing-builder-agent` wires `createKarosLandingTools(config)` (or
 * `createLandingEngineConfigFromEnv()`) in explicitly, alongside this bundle.
 *
 * `mediaStore` (Task 1, RFC-01's GCS media store) is optional, mirroring
 * `store`: wire it (via `GCS_MEDIA_BUCKET` at your composition root) to make
 * `publish.renderCarousel` upload rendered PNGs to GCS instead of local
 * scratch paths — omit it to keep that tool's exact prior local-disk
 * behavior. `video.*`/`landing.*`'s own media/artifact stores are configured
 * separately, alongside their own bundles, for the reason given above.
 */
export function createAllKarosTools(store?: WorkspaceStoreLike, mediaStore?: GcsArtifactStoreLike): AgentToolRegistry {
  return {
    ...createKarosClientTools(store),
    ...createKarosGatesTools(),
    ...createKarosIntelTools(store),
    ...createKarosLedgerTools(store),
    ...createKarosMemoryTools(store),
    ...createKarosPublishTools(store, mediaStore),
    ...createKarosReputationTools(),
    ...createKarosResearchTools(store),
    ...createKarosSeoGeoTools(),
    ...createKarosTopicsTools(store),
  };
}
