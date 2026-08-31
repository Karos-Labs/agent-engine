import { recordGateMetric, recordGateSpan } from "@agent-engine/telemetry";
import type { GateRecord, StepRecord } from "../adapters/types.js";
import type { GateDefinition, GateResponse, WorkflowRuntime } from "./context.js";
import { markStepRunning, scopedStepId } from "./context.js";
import { AwaitingGateSignal } from "./signals.js";
import { isCheckpointedStepStatus } from "../adapters/types.js";

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
 * When this gate's step first became the run's current step.
 *
 * PRESERVED ACROSS REPLAYS, and that is the only reason this read exists.
 * `runStepGate` is re-entered on every `run()` call that replays past this
 * point — once to register the gate, then again on each resume attempt — so
 * stamping `runtime.now()` unconditionally would reset the clock every time and
 * report a 24-hour human review as however long the final replay took. The
 * whole point of a gate's duration is the wait.
 */
async function gateStepStartedAt(runtime: WorkflowRuntime, stepId: string): Promise<number> {
  const existing = await runtime.store.getStep(runtime.runId, stepId);
  return existing?.startedAt ?? runtime.now();
}

/**
 * `GateResponse.at` is an ISO string written by whoever resolved the gate, and
 * it is a better answer than `now()` for when the step actually finished — a
 * resume can land minutes or hours after the approval. Falls back to the
 * runtime clock for a response whose timestamp is unparseable, and never
 * accepts one that would make the step finish before it started.
 */
function gateCompletedAt(runtime: WorkflowRuntime, response: GateResponse, startedAt: number): number {
  const parsed = Date.parse(response.at);
  return Number.isFinite(parsed) && parsed >= startedAt ? parsed : runtime.now();
}

/**
 * Checkpoints a resolved gate as a completed step, so the decision, its actor
 * and how long the wait took all land in the same `steps` subcollection every
 * other step writes to.
 *
 * Written on the replay pass that first SEES the response rather than by
 * `resolveGate` itself, which keeps the gate's own record the single source of
 * truth for whether it is resolved — this is a projection of that record, and a
 * crash before the projection lands just means the next replay writes it.
 * Skipped once the record is already `"completed"`, so a run replayed ten times
 * after approval issues one write, not ten.
 *
 * Best-effort by the same rule as `markStepRunning`: a checkpoint is reporting,
 * and a reporting failure must never turn an approved gate into a stalled run.
 *
 * Also where the gate's span is recorded (AU42/SCRUM-326) — see
 * `recordGateSpan`'s own doc comment for why it is an explicitly-timed span
 * rather than a live one, and why it belongs on this exact code path: this
 * function only reaches the `saveStep` below once, on the replay that first
 * sees the resolution (the early return above is what makes that true), so
 * the span is recorded exactly once too, backdated to `startedAt` and ended
 * at `completedAt` — the same two timestamps the checkpoint itself uses.
 */
async function recordResolvedGateStep(runtime: WorkflowRuntime, stepId: string, gateId: string, response: GateResponse): Promise<void> {
  try {
    const existing = await runtime.store.getStep(runtime.runId, stepId);
    if (existing && isCheckpointedStepStatus(existing.status)) return;
    const startedAt = existing?.startedAt ?? runtime.now();
    const completedAt = gateCompletedAt(runtime, response, startedAt);
    recordGateSpan(
      {
        runId: runtime.runId,
        clientSlug: runtime.clientSlug,
        productId: runtime.productId,
        stepId,
        gateId,
        decision: response.decision,
        actor: response.actor,
      },
      startedAt,
      completedAt,
    );
    recordGateMetric({ decision: response.decision });
    const record: StepRecord = {
      stepId,
      kind: "gate",
      // AU67 checked this primitive as a PRODUCER, not only as a resume
      // consumer, and it is structurally incapable of the step.code defect:
      // the output below is a CLOSED SHAPE THIS FUNCTION CONSTRUCTS ITSELF
      // from a `GateResponse`, never a value returned from a tool. There is no
      // `status` field arriving from elsewhere that could disagree with this
      // one.
      //
      // `completed` on a REJECTED gate is correct and deliberate, not the same
      // bug in disguise. It means the gate was RESOLVED. A rejection is a human
      // decision, carried in `output.decision` and surfaced at run level as
      // `held` with a reason — recording it as a step failure would say the
      // step malfunctioned when it did exactly its job, which is to capture a
      // "no".
      status: "completed",
      // The decision IS this step's output — the same shape `apps/agent-server`'s
      // report builder used to synthesize for a resolved gate, now recorded at
      // the source instead of reconstructed downstream.
      output: {
        decision: response.decision,
        actor: response.actor,
        at: response.at,
        // Mandatory on a reject by `GateResponseSchema`'s own refinement, absent
        // on most approvals — so spread rather than written unconditionally.
        ...(response.reason !== undefined ? { reason: response.reason } : {}),
      },
      costUsd: 0,
      durationMs: completedAt - startedAt,
      startedAt,
      completedAt,
    };
    await runtime.store.saveStep(runtime.runId, record);
  } catch (err) {
    console.error(`runStepGate: failed to checkpoint resolved gate "${stepId}" (run "${runtime.runId}") — continuing, the gate record itself is authoritative`, err);
  }
}

/**
 * Parses a `GateTimeout.duration` string ("1h", "24h", "7d", "30m", "45s")
 * into milliseconds — the "Layer 1 adapter" parse `GateTimeoutSchema`'s own
 * doc comment (`packages/core/src/types/gate.ts`) says `duration` is for:
 * "parsed by the Layer 1 adapter, not this package." Deliberately a small,
 * standalone copy rather than a new `packages/workflow` -> `tool-common`
 * dependency for one regex (RFC-01 §4's package-independence convention,
 * same rule `capture-visibility.ts`/`SeoGeoCaptureCell` already cite for
 * their own duplicated shapes) — `@agent-engine/tool-common`'s
 * `parseDurationMs` is the format this mirrors, not a shared implementation.
 * Returns `undefined` for a string this can't parse, so a malformed
 * `duration` degrades to "never timed out" (falls through to the normal
 * awaiting-gate wait) rather than throwing and failing the whole run over a
 * config typo.
 */
const GATE_DURATION_RE = /^(\d+)\s*(s|m|h|d)$/i;
const GATE_DURATION_UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
function parseGateDurationMs(duration: string): number | undefined {
  const match = GATE_DURATION_RE.exec(duration.trim());
  if (!match) return undefined;
  const amount = match[1];
  const unit = match[2];
  if (!amount || !unit) return undefined;
  return Number(amount) * GATE_DURATION_UNIT_MS[unit.toLowerCase()]!;
}

/**
 * The `actor` recorded on a `GateResponse` this primitive synthesizes itself
 * (never a human) — distinct from `options.autoApprove`'s `"system"` actor
 * (an explicit opt-out a caller chose at construction time) so a review never
 * confuses "nobody looked at this by design" with "somebody was supposed to
 * look and didn't in time."
 */
const GATE_TIMEOUT_ACTOR = "system:gate-timeout";

/**
 * `step.gate(id, def)` (RFC-01 §8.1/§8.3): registers the gate on first call,
 * then throws `AwaitingGateSignal` until `WorkflowEngine.resolveGate` records
 * a response — at which point a later `run()` call replays up to this same
 * point and returns the response, letting the workflow continue.
 *
 * `def.timeout.onTimeout === "auto_approve"` (SCRUM-273/T-A20) is the one
 * exception to "only a human resolves this": once `def.timeout.duration` has
 * elapsed since the gate first opened with still no response, the NEXT call
 * into this function synthesizes an `approve` decision itself — actor
 * `GATE_TIMEOUT_ACTOR`, never a fabricated human — saves it as the gate's
 * real response (so it is indistinguishable downstream from any other
 * resolved gate: same checkpoint, same audit trail, and a genuine
 * `WorkflowEngine.resolveGate` call arriving late now correctly 409s via
 * `GateAlreadyResolvedError` instead of racing it), and returns it instead of
 * throwing. This is deliberately lazy, not a background sweep: exactly like
 * every other engine-level fact here, it is discovered the next time
 * something touches this run (a resume call, a status poll that re-runs the
 * workflow function) — consistent with "resuming a run means calling run()
 * again" being this engine's only mechanism, with `runtime.now()` as the
 * sole clock a test needs to control to prove it (no fake timers, no sleep).
 * `"hold"`/`"escalate"` are unaffected — this function's behavior for them is
 * unchanged from before this ticket.
 *
 * It also CHECKPOINTS ITSELF, in both states, which it did not used to do —
 * see `StepKindSchema`'s own note for what that absence cost. Registering
 * writes a `"running"` gate step and points the run's `currentStepId` at it;
 * seeing a response writes the completed step carrying the decision. Neither
 * write changes this function's contract or its resumability: the gate record
 * remains the only thing consulted to decide whether the gate is resolved, and
 * both checkpoint writes are best-effort.
 *
 * NO LIVE TELEMETRY SPAN around this whole function, unlike
 * `runStepCode`/`runStepAgent`. A gate's elapsed time is human time, and this
 * function is re-entered once per resume attempt — a span wrapping every call
 * that ends by throwing `AwaitingGateSignal` would report a handful of
 * sub-millisecond "failures" instead of one 24-hour wait. The `"running"`
 * checkpoint plus `currentStepId` is the honest progress signal while the
 * gate is still pending; once it resolves, `recordResolvedGateStep` records
 * an explicitly-timed span backdated over the real wait (AU42/SCRUM-326) —
 * see `recordGateSpan`'s doc comment.
 */
export async function runStepGate(runtime: WorkflowRuntime, id: string, def: GateDefinition): Promise<GateResponse> {
  const gateId = qualifyGateId(runtime.runId, id);
  // `scopedStepId`, matching `step.code`/`step.agent`: two fan-out slots gating
  // the same local id get two checkpoints rather than one overwriting the other.
  // (The GATE record itself is not slot-scoped — `qualifyGateId` predates
  // fan-out gating and is left alone here; that is a separate, pre-existing gap,
  // not one this checkpoint introduces.)
  const stepId = scopedStepId(runtime, id);
  const existing = await runtime.store.getGate(gateId);

  if (existing?.response) {
    await recordResolvedGateStep(runtime, stepId, gateId, existing.response);
    return existing.response;
  }

  const record: GateRecord = existing ?? {
    gateId,
    runId: runtime.runId,
    kind: def.kind,
    payload: def.payload,
    requiredRole: def.requiredRole,
    timeout: def.timeout,
    ...(runtime.slotId !== undefined ? { slotId: runtime.slotId } : {}),
  };
  if (!existing) {
    await runtime.store.saveGate(record);
  }

  // `startedAt` PRESERVED ACROSS REPLAYS (see `gateStepStartedAt`'s own doc
  // comment) — computed once here and reused for both the timeout check
  // below and the `markStepRunning` checkpoint, so the two never disagree
  // about when this gate actually opened.
  const startedAt = await gateStepStartedAt(runtime, stepId);

  // `def.timeout?.` — optional-chained, not the `Gate` schema's own
  // guarantee: `GateDefinition.timeout` is required by that schema, but at
  // least one existing test in this suite exercises `step.gate` with a
  // deliberately-incomplete definition cast through `as never` for an
  // unrelated assertion (`run-input.test.ts`'s gate-pause case, testing input
  // persistence, not timeouts). A missing `timeout` must degrade to "never
  // auto-approves," the same as an unparseable `duration` below, not throw.
  if (def.timeout?.onTimeout === "auto_approve") {
    const durationMs = parseGateDurationMs(def.timeout.duration);
    if (durationMs !== undefined && runtime.now() - startedAt >= durationMs) {
      const response: GateResponse = { decision: "approve", actor: GATE_TIMEOUT_ACTOR, at: new Date(runtime.now()).toISOString() };
      await runtime.store.saveGate({ ...record, response });
      await recordResolvedGateStep(runtime, stepId, gateId, response);
      return response;
    }
  }

  await markStepRunning(runtime, stepId, "gate", startedAt);
  throw new AwaitingGateSignal(gateId);
}
