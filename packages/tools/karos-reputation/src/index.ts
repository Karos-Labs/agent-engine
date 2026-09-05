import type { AgentToolRegistry } from "@agent-engine/core";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { createReputationTriage } from "./triage/index.js";
import { createReputationCapture, type CreateReputationCaptureOptions } from "./capture/index.js";
import { createReputationDoctrineGate } from "./doctrine/index.js";
import { createDiscoverGbpLocations, createSaveRoster } from "./setup/index.js";

export * from "./triage/index.js";
export * from "./capture/index.js";
export * from "./doctrine/index.js";
export * from "./setup/index.js";

export interface CreateKarosReputationToolsOptions extends CreateReputationCaptureOptions {
  /**
   * The client workspace, for `reputation.saveRoster` — the one reputation
   * tool that writes. Without a store the registry still carries every
   * read/compute tool (triage, capture, doctrine gate, GBP discovery) and
   * simply lacks the writer, so a composition with no workspace (the
   * golden-fixture tests) is unchanged.
   */
  store?: WorkspaceStoreLike;
}

export function createKarosReputationTools(options: CreateKarosReputationToolsOptions = {}): AgentToolRegistry {
  const { store, ...io } = options;
  return {
    "reputation.triage": createReputationTriage(),
    "reputation.capture": createReputationCapture(io),
    "reputation.doctrineGate": createReputationDoctrineGate(),
    "reputation.discoverGbpLocations": createDiscoverGbpLocations(io),
    ...(store ? { "reputation.saveRoster": createSaveRoster(store) } : {}),
  };
}
