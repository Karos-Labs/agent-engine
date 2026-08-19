import type { GateRecord } from "../adapters/types.js";
import type { GateDefinition, GateResponse, WorkflowRuntime } from "./context.js";
import { AwaitingGateSignal } from "./signals.js";

/** Namespaces a workflow-author-supplied local gate id into the store's globally-unique `agentEngineGates/{gateId}` key. */
export function qualifyGateId(runId: string, id: string): string {
  return `${runId}__${id}`;
}

/**
 * Accepts either id shape a caller might reasonably hold: the workflow-local
 * id (`"15-batch-review"`) or the fully qualified store key
 * (`"${runId}__15-batch-review"`, exactly what `WorkflowRunResult`'s own
 * `pendingGateId` and `GET /status` hand back). Round-tripping the qualified
 * id the API itself returned used to double-qualify it
 * (`"${runId}__${runId}__..."`) and 404 — a gate-lifecycle audit finding.
 * `WorkflowEngine.resolveGate` calls this instead of `qualifyGateId` so both
 * shapes resolve to the same record.
 */
export function normalizeGateId(runId: string, id: string): string {
  const prefix = `${runId}__`;
  return id.startsWith(prefix) ? id : qualifyGateId(runId, id);
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
