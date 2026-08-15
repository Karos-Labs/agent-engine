import type { GateRecord } from "../adapters/types.js";
import type { GateDefinition, GateResponse, WorkflowRuntime } from "./context.js";
import { AwaitingGateSignal } from "./signals.js";

/** Namespaces a workflow-author-supplied local gate id into the store's globally-unique `agentEngineGates/{gateId}` key. */
export function qualifyGateId(runId: string, id: string): string {
  return `${runId}__${id}`;
}

/**
 * `step.gate(id, def)` (RFC-01 §8.1/§8.3): registers the gate on first call,
 * then throws `AwaitingGateSignal` until `WorkflowEngine.resolveGate` records
 * a response — at which point a later `run()` call replays up to this same
 * point and returns the response, letting the workflow continue.
 */
export async function runStepGate(runtime: WorkflowRuntime, id: string, def: GateDefinition): Promise<GateResponse> {
  const gateId = qualifyGateId(runtime.runId, id);
  const existing = await runtime.store.getGate(gateId);

  if (existing?.response) {
    return existing.response;
  }

  if (!existing) {
    const record: GateRecord = {
      gateId,
      runId: runtime.runId,
      kind: def.kind,
      payload: def.payload,
      requiredRole: def.requiredRole,
      timeout: def.timeout,
      ...(runtime.slotId !== undefined ? { slotId: runtime.slotId } : {}),
    };
    await runtime.store.saveGate(record);
  }

  throw new AwaitingGateSignal(gateId);
}
