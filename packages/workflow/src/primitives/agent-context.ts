import type { AgentContext } from "@agent-engine/core";
import type { WorkflowContext } from "./context.js";

/**
 * Derives the `AgentContext` every Layer 3 tool call and `BaseAgent` step
 * needs (RFC-01 §9.1) from the workflow's own run identity. `metadata` starts
 * empty — any step that needs to thread something through it copies this
 * object and adds to it, never mutates the shared one.
 *
 * Lifted out of the fifteen per-agent workflow files that each defined this
 * byte-for-byte (AU16 / SCRUM-300).
 */
export function toAgentContext(wf: WorkflowContext): AgentContext {
  return {
    runId: wf.runId,
    clientSlug: wf.clientSlug,
    productId: wf.productId,
    runKind: wf.runKind,
    ...(wf.slotId !== undefined ? { slotId: wf.slotId } : {}),
    metadata: {},
  };
}
