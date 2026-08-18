import type { AgentToolRegistry } from "@agent-engine/core";
import { createReputationTriage } from "./triage/index.js";
import { createReputationCapture, type CreateReputationCaptureOptions } from "./capture/index.js";
import { createReputationDoctrineGate } from "./doctrine/index.js";

export * from "./triage/index.js";
export * from "./capture/index.js";
export * from "./doctrine/index.js";

/** The `karos-reputation` tool registry (RFC-08). `reputation.publish` is deliberately NOT included here — it is built and locked at the workflow layer (`agents/reputation-agent`), never registered as an always-available tool, per RFC-08 §9's "the tool exists, the door stays locked" instruction. */
export function createKarosReputationTools(captureOptions?: CreateReputationCaptureOptions): AgentToolRegistry {
  return {
    "reputation.triage": createReputationTriage(),
    "reputation.capture": createReputationCapture(captureOptions),
    "reputation.doctrineGate": createReputationDoctrineGate(),
  };
}
