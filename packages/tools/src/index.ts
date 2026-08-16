import type { AgentToolRegistry } from "@agent-engine/core";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { createKarosClientTools } from "@agent-engine/tool-karos-client";
import { createKarosGatesTools } from "@agent-engine/tool-karos-gates";
import { createKarosLedgerTools } from "@agent-engine/tool-karos-ledger";
import { createKarosMemoryTools } from "@agent-engine/tool-karos-memory";
import { createKarosPublishTools } from "@agent-engine/tool-karos-publish";
import { createKarosResearchTools } from "@agent-engine/tool-karos-research";
import { createKarosTopicsTools } from "@agent-engine/tool-karos-topics";

export * from "@agent-engine/tool-common";
export * from "@agent-engine/tool-karos-client";
export * from "@agent-engine/tool-karos-gates";
export * from "@agent-engine/tool-karos-ledger";
export * from "@agent-engine/tool-karos-memory";
export * from "@agent-engine/tool-karos-publish";
export * from "@agent-engine/tool-karos-research";
export * from "@agent-engine/tool-karos-topics";

/**
 * The full Layer 3 tool registry (RFC-01 §9.2): every karos-* MCP server's
 * tools, merged into the one `AgentToolRegistry` shape `BaseAgent` expects on
 * `runtime.tools`. Each server still ships as its own workspace package —
 * this is a convenience bundle for wiring up a `BaseAgentRuntime` in one call,
 * not a new abstraction layer.
 *
 * `store` is optional and shared across every storage-backed server (all but
 * `karos-gates`, which is stateless) — omit it to fall back to each server's
 * own default (`createWorkspaceStore()`, env-configured), or pass one
 * explicitly (e.g. pointed at a temp directory) so every server reads and
 * writes the same isolated workspace, which is exactly what tests need.
 */
export function createAllKarosTools(store?: WorkspaceStoreLike): AgentToolRegistry {
  return {
    ...createKarosClientTools(store),
    ...createKarosGatesTools(),
    ...createKarosLedgerTools(store),
    ...createKarosMemoryTools(store),
    ...createKarosPublishTools(store),
    ...createKarosResearchTools(store),
    ...createKarosTopicsTools(store),
  };
}
