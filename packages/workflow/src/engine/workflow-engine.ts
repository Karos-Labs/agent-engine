import type { RunKind } from "@agent-engine/core";
import { describeError } from "@agent-engine/telemetry";
import type { DurableStepStore, RunRecord, WorkflowBudget } from "../adapters/types.js";
import type { GateResponse, WorkflowContext, WorkflowRuntime } from "../primitives/context.js";
import { buildWorkflowContext, sumRunCost } from "../primitives/context.js";
import { qualifyGateId } from "../primitives/step-gate.js";
import {
  AwaitingGateSignal,
  WorkflowBlockedIntake,
  WorkflowBudgetExceeded,
  WorkflowContentFailure,
  WorkflowHeld,
} from "../primitives/signals.js";

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
    if (!existingRun) {
      const newRun: RunRecord = {
        runId: params.runId,
        clientSlug: params.clientSlug,
        productId: params.productId,
        runKind: params.runKind,
        status: "running",
        createdAt: this.now(),
        updatedAt: this.now(),
        ...(params.budget !== undefined ? { budget: params.budget } : {}),
      };
      await this.store.createRunIfNotExists(newRun);
    } else {
      await this.store.updateRun(params.runId, { status: "running", updatedAt: this.now() });
    }

    const runtime: WorkflowRuntime = {
      runId: params.runId,
      clientSlug: params.clientSlug,
      productId: params.productId,
      runKind: params.runKind,
      store: this.store,
      now: this.now,
      ...(params.budget !== undefined ? { budget: params.budget } : {}),
    };
    const wf = buildWorkflowContext(runtime);

    try {
      const output = await workflowFn(wf);
      const totalCostUsd = await sumRunCost(this.store, params.runId);
      await this.store.updateRun(params.runId, { status: "completed", updatedAt: this.now(), totalCostUsd });
      return { status: "completed", runId: params.runId, output, totalCostUsd };
    } catch (err) {
      const totalCostUsd = await sumRunCost(this.store, params.runId);

      if (err instanceof AwaitingGateSignal) {
        await this.store.updateRun(params.runId, {
          status: "awaiting_gate",
          updatedAt: this.now(),
          pendingGateId: err.gateId,
          totalCostUsd,
        });
        return { status: "awaiting_gate", runId: params.runId, output: null, pendingGateId: err.gateId, totalCostUsd };
      }

      if (err instanceof WorkflowContentFailure || err instanceof WorkflowBudgetExceeded) {
        const failureReason = describeError(err);
        await this.store.updateRun(params.runId, { status: "failed", updatedAt: this.now(), failureReason, totalCostUsd });
        return { status: "failed", runId: params.runId, output: null, failureReason, totalCostUsd };
      }

      if (err instanceof WorkflowHeld) {
        const reason = describeError(err);
        await this.store.updateRun(params.runId, { status: "held", updatedAt: this.now(), reason, totalCostUsd });
        return { status: "held", runId: params.runId, output: null, reason, totalCostUsd };
      }

      if (err instanceof WorkflowBlockedIntake) {
        const reason = describeError(err);
        await this.store.updateRun(params.runId, { status: "blocked_intake", updatedAt: this.now(), reason, totalCostUsd });
        return { status: "blocked_intake", runId: params.runId, output: null, reason, totalCostUsd };
      }

      // WorkflowToolingFailure, or any other uncaught error: something broke — never recorded as a content verdict (RFC-01 §5.6/§6).
      // describeError walks the whole .cause chain (RFC-01 §16.4) — the network/tooling
      // failure actually at fault must stay legible, not flatten into one opaque message.
      const failureReason = describeError(err);
      await this.store.updateRun(params.runId, { status: "degraded", updatedAt: this.now(), failureReason, totalCostUsd });
      return { status: "degraded", runId: params.runId, output: null, failureReason, totalCostUsd };
    }
  }

  /** Records a human/policy decision against a pending gate (RFC-01 §8.3) — call `run()` again afterward to resume past it. */
  async resolveGate(runId: string, id: string, response: GateResponse): Promise<void> {
    const gateId = qualifyGateId(runId, id);
    const gate = await this.store.getGate(gateId);
    if (!gate) {
      throw new Error(`WorkflowEngine.resolveGate: no gate found for id "${id}" on run "${runId}"`);
    }
    await this.store.saveGate({ ...gate, response });
  }
}
