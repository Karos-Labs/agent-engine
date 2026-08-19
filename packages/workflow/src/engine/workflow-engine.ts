import type { RunKind } from "@agent-engine/core";
import { describeError } from "@agent-engine/telemetry";
import type { DurableStepStore, RunRecord, RunStatus, WorkflowBudget } from "../adapters/types.js";
import type { GateResponse, WorkflowContext, WorkflowRuntime } from "../primitives/context.js";
import { buildWorkflowContext, sumRunCost } from "../primitives/context.js";
import { normalizeGateId } from "../primitives/step-gate.js";
import {
  AwaitingGateSignal,
  GateAlreadyResolvedError,
  WorkflowBlockedIntake,
  WorkflowBudgetExceeded,
  WorkflowConcurrentRunError,
  WorkflowContentFailure,
  WorkflowHeld,
} from "../primitives/signals.js";

/**
 * The statuses a call into `run()` on an *existing* run is valid from —
 * everything except `running` (another execution is actively in flight right
 * now: either a genuine concurrent call, or a crashed process that never
 * updated status — either way, not safe to silently re-enter). Every other
 * status, including `completed`, is claimable: re-invoking `run()` after
 * `held`/`degraded`/`failed`/`blocked_intake` is this codebase's own
 * established retry pattern (e.g. supplying missing intake after
 * `blocked_intake`), and re-invoking it after `completed` is a safe,
 * idempotent no-op by construction — every step already checkpointed, so
 * replaying the function just re-confirms the same output without
 * re-executing anything (RFC-01 §8.1). Optimistic concurrency must not break
 * either pattern, only close the actual race: two near-simultaneous resumes
 * of the same `awaiting_gate` run, or any call racing an already-in-flight one.
 */
const RESUMABLE_FROM_STATUSES: readonly RunStatus[] = ["awaiting_gate", "completed", "degraded", "failed", "held", "blocked_intake"];

/** Every optional `RunRecord` field a terminal (or re-entrant) transition must account for — see the doc comment on `terminalPatch`. */
interface OptionalRunFields {
  pendingGateId: string | null;
  failureReason: string | null;
  reason: string | null;
}

/**
 * Every branch of the outcome switch below writes a *complete* snapshot of
 * these three fields — the one relevant to this outcome, `null` for the
 * other two — rather than relying on `updateRun`'s merge semantics to leave
 * whatever a previous transition wrote sitting there. Without this, a run
 * that once paused at a gate and then later completed (or one that failed,
 * was retried, and then completed) would report a stale `pendingGateId`/
 * `failureReason` forever (a reliability audit finding): `GET /status` on a
 * finished run would still claim it's waiting on a gate that's long resolved.
 */
function terminalRunFields(overrides: Partial<OptionalRunFields> = {}): OptionalRunFields {
  return { pendingGateId: null, failureReason: null, reason: null, ...overrides };
}

export interface RunWorkflowParams {
  runId: string;
  clientSlug: string;
  productId: string;
  runKind: RunKind;
  budget?: WorkflowBudget;
}

/**
 * The run-level outcomes (RFC-01 §6, extended by §16.2 / RFC-02 §3): the
 * original four (`completed`/`failed`/`degraded`/`awaiting_gate`) plus two
 * domain outcomes a workflow author signals explicitly — `held` ("nothing
 * honestly cleared the gates", a legitimate empty result) and
 * `blocked_intake` (missing client input, not an agent fault). Neither new
 * outcome is a flavor of `failed`/`degraded` — that collapse is exactly the
 * misclassification bug this taxonomy exists to prevent. Distinct from
 * `AgentExecutionResult.status` in `@agent-engine/core`, which is Layer 2's
 * step-execution scope.
 */
export type WorkflowRunResult<T> =
  | { status: "completed"; runId: string; output: T; totalCostUsd: number }
  | { status: "failed"; runId: string; output: null; failureReason: string; totalCostUsd: number }
  | { status: "degraded"; runId: string; output: null; failureReason: string; totalCostUsd: number }
  | { status: "awaiting_gate"; runId: string; output: null; pendingGateId: string; totalCostUsd: number }
  | { status: "held"; runId: string; output: null; reason: string; totalCostUsd: number }
  | { status: "blocked_intake"; runId: string; output: null; reason: string; totalCostUsd: number };

/**
 * Layer 1 (RFC-01 §4, §8.1): owns run identity, checkpoints, budget, and
 * ordering — and makes zero content judgments. A workflow is just an async
 * function called with a `WorkflowContext`; resuming a run means calling
 * `run()` again with the same `runId` and the same function — every
 * `step.code`/`step.agent` call that already checkpointed short-circuits, so
 * replaying the function from the top only actually re-executes the first
 * incomplete step onward (RFC-01 §8.1's "engine-level resume by
 * construction").
 */
export class WorkflowEngine {
  constructor(
    private readonly store: DurableStepStore,
    private readonly now: () => number = Date.now,
  ) {}

  async run<T>(workflowFn: (wf: WorkflowContext) => Promise<T>, params: RunWorkflowParams): Promise<WorkflowRunResult<T>> {
    const existingRun = await this.store.getRun(params.runId);
    // A resumed run keeps its originally-set budget ceiling unless this call explicitly
    // supplies a new one — previously, only params.budget was ever consulted here, so the
    // ceiling silently vanished for the entire post-gate half of every run (a reliability
    // audit finding: RFC-01 §8.1's "budget enforced before spend" was structurally present
    // but inert for any resumed run).
    const budget = params.budget ?? existingRun?.budget;

    if (!existingRun) {
      const newRun: RunRecord = {
        runId: params.runId,
        clientSlug: params.clientSlug,
        productId: params.productId,
        runKind: params.runKind,
        status: "running",
        createdAt: this.now(),
        updatedAt: this.now(),
        ...(budget !== undefined ? { budget } : {}),
      };
      await this.store.createRunIfNotExists(newRun);
    } else {
      // Optimistic-concurrency claim (a reliability audit finding): two near-simultaneous
      // resumes of the same awaiting_gate run, or a resume racing an already-in-flight
      // run, must not both proceed past the same checkpoint. Only the caller that actually
      // wins this atomic transition continues; everyone else gets a distinct, catchable
      // error instead of silently double-executing.
      const claim = await this.store.claimRun(params.runId, RESUMABLE_FROM_STATUSES, { status: "running", updatedAt: this.now() });
      if (!claim.claimed) {
        throw new WorkflowConcurrentRunError(params.runId, claim.run.status, RESUMABLE_FROM_STATUSES);
      }
    }

    const runtime: WorkflowRuntime = {
      runId: params.runId,
      clientSlug: params.clientSlug,
      productId: params.productId,
      runKind: params.runKind,
      store: this.store,
      now: this.now,
      ...(budget !== undefined ? { budget } : {}),
    };
    const wf = buildWorkflowContext(runtime);

    try {
      const output = await workflowFn(wf);
      const totalCostUsd = await sumRunCost(this.store, params.runId);
      await this.store.updateRun(params.runId, { status: "completed", updatedAt: this.now(), totalCostUsd, ...terminalRunFields() });
      return { status: "completed", runId: params.runId, output, totalCostUsd };
    } catch (err) {
      const totalCostUsd = await sumRunCost(this.store, params.runId);

      if (err instanceof AwaitingGateSignal) {
        await this.store.updateRun(params.runId, {
          status: "awaiting_gate",
          updatedAt: this.now(),
          totalCostUsd,
          ...terminalRunFields({ pendingGateId: err.gateId }),
        });
        return { status: "awaiting_gate", runId: params.runId, output: null, pendingGateId: err.gateId, totalCostUsd };
      }

      if (err instanceof WorkflowContentFailure || err instanceof WorkflowBudgetExceeded) {
        const failureReason = describeError(err);
        await this.store.updateRun(params.runId, { status: "failed", updatedAt: this.now(), totalCostUsd, ...terminalRunFields({ failureReason }) });
        return { status: "failed", runId: params.runId, output: null, failureReason, totalCostUsd };
      }

      if (err instanceof WorkflowHeld) {
        const reason = describeError(err);
        await this.store.updateRun(params.runId, { status: "held", updatedAt: this.now(), totalCostUsd, ...terminalRunFields({ reason }) });
        return { status: "held", runId: params.runId, output: null, reason, totalCostUsd };
      }

      if (err instanceof WorkflowBlockedIntake) {
        const reason = describeError(err);
        await this.store.updateRun(params.runId, { status: "blocked_intake", updatedAt: this.now(), totalCostUsd, ...terminalRunFields({ reason }) });
        return { status: "blocked_intake", runId: params.runId, output: null, reason, totalCostUsd };
      }

      // WorkflowToolingFailure, or any other uncaught error: something broke — never recorded as a content verdict (RFC-01 §5.6/§6).
      // describeError walks the whole .cause chain (RFC-01 §16.4) — the network/tooling
      // failure actually at fault must stay legible, not flatten into one opaque message.
      const failureReason = describeError(err);
      await this.store.updateRun(params.runId, { status: "degraded", updatedAt: this.now(), totalCostUsd, ...terminalRunFields({ failureReason }) });
      return { status: "degraded", runId: params.runId, output: null, failureReason, totalCostUsd };
    }
  }

  /**
   * Records a human/policy decision against a pending gate (RFC-01 §8.3) —
   * call `run()` again afterward to resume past it. `id` may be either the
   * workflow-local id or the fully qualified store key (`normalizeGateId`
   * accepts both — a gate-lifecycle audit finding: the engine used to hand
   * out the qualified id as `pendingGateId` but only accept the local one
   * here, so round-tripping its own response 404'd). Throws
   * `GateAlreadyResolvedError` rather than overwriting an existing response
   * — a human decision's audit trail must never be silently replaced.
   */
  async resolveGate(runId: string, id: string, response: GateResponse): Promise<void> {
    const gateId = normalizeGateId(runId, id);
    const gate = await this.store.getGate(gateId);
    if (!gate) {
      throw new Error(`WorkflowEngine.resolveGate: no gate found for id "${id}" on run "${runId}"`);
    }
    if (gate.response) {
      throw new GateAlreadyResolvedError(runId, gateId, gate.response.decision);
    }
    await this.store.saveGate({ ...gate, response });
  }
}
