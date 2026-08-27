import { computeToolCostUsd, extractToolUsage } from "@agent-engine/core";
import { describeError, withWorkflowStepSpan } from "@agent-engine/telemetry";
import { isCheckpointedStepStatus, type StepRecord, type StepRecordStatus } from "../adapters/types.js";
import type { WorkflowRuntime } from "./context.js";
import { markStepRunning, scopedStepId } from "./context.js";

/**
 * `step.code(id, fn)` (RFC-01 §8.1/§8.2): a deterministic step, checkpointed
 * before the next step runs. Resuming a run whose `id` already completed
 * returns the checkpointed output without calling `fn` again — this is the
 * whole resumability story for deterministic steps, no separate "list the
 * folder and find the lowest missing number" logic needed (RFC-01 §8.1).
 *
 * Inside a `fanout` slot, `id` is namespaced by the slot (RFC-01 §5.5's
 * per-slot isolation) — sibling slots calling `step.code("prep", ...)` each
 * get their own checkpoint, never one overwriting the other.
 */
/**
 * Translates a tool's four-outcome result (RFC-01 §6) into the step status that
 * describes it (AU67 / SCRUM-365).
 *
 * This is the missing translation. Tools report failure as a RETURNED VALUE;
 * this recorder only ever listened for exceptions. A correctly-reported failure
 * therefore arrived as a successful return and was written down as `completed`.
 *
 * Shape-driven, like the rest of this file's inspection of `output`, and for
 * the same reason: an opt-in would only catch the call sites someone
 * remembered, leaving the default wrong — which is the failure being fixed. A
 * body returning something that is not a tool outcome (most of them) is
 * `completed`, and that is now a measurement rather than an assumption.
 *
 * Deliberately NOT collapsed to `failed`: `not_available` is a designed,
 * expected state and `content_fail` is a real content judgment a revision loop
 * asks for. Flattening them into "failed" would be the same conflation this
 * function exists to remove, one level up.
 */
function statusFromOutcome(output: unknown): StepRecordStatus {
  if (typeof output !== "object" || output === null) return "completed";
  const status = (output as { status?: unknown }).status;
  if (status === "content_fail" || status === "not_available" || status === "tooling_error") return status;
  return "completed";
}

/**
 * The tool's own `reason`, promoted onto the step record.
 *
 * Without it a non-success step records a status and nothing else, so the run
 * report can say THAT a step failed but not why. Same argument as
 * `AgentStepTelemetry.error`, which exists for exactly this.
 */
function describeOutcomeReason(output: unknown): { error?: string } {
  if (typeof output !== "object" || output === null) return {};
  const { status, reason } = output as { status?: unknown; reason?: unknown };
  if (status === "success" || typeof reason !== "string") return {};
  return { error: reason };
}

export async function runStepCode<T>(runtime: WorkflowRuntime, id: string, fn: () => T | Promise<T>): Promise<T> {
  const stepId = scopedStepId(runtime, id);
  const existing = await runtime.store.getStep(runtime.runId, stepId);
  if (existing && isCheckpointedStepStatus(existing.status)) {
    return existing.output as T;
  }

  return withWorkflowStepSpan(
    {
      runId: runtime.runId,
      clientSlug: runtime.clientSlug,
      productId: runtime.productId,
      ...(runtime.slotId !== undefined ? { slotId: runtime.slotId } : {}),
      stepId,
      stepKind: "code",
    },
    async () => {
      const startedAt = runtime.now();
      await markStepRunning(runtime, stepId, "code", startedAt);
      try {
        const output = await fn();
        const completedAt = runtime.now();
        // the per-unit cost work — shipped without a Jira ticket. This used to be the literal constant 0, and that was the
        // whole of the ~14% understatement a measured Instagram run carried:
        // `06d-generate-images` calls `image.generate`, a TOOL, and every tool
        // call recorded $0.000000 by construction. Not a lookup that missed —
        // there was no cost path from a tool at all.
        //
        // Shape-driven rather than opt-in, deliberately: see `extractToolUsage`.
        // A step whose body is ordinary computation still records 0, which is
        // now a measurement rather than an assumption.
        const unitUsage = extractToolUsage(output);
        const record: StepRecord = {
          stepId,
          kind: "code",
          // AU67: the step now says what its tool actually reported. It still
          // RAN, so it stays checkpointed and resume is unchanged — see
          // `isCheckpointedStepStatus`.
          status: statusFromOutcome(output),
          output,
          costUsd: computeToolCostUsd(unitUsage),
          ...(unitUsage.length > 0 ? { unitUsage: unitUsage.map((u) => ({ ...u })) } : {}),
          durationMs: completedAt - startedAt,
          startedAt,
          completedAt,
          ...describeOutcomeReason(output),
        };
        await runtime.store.saveStep(runtime.runId, record);
        return output;
      } catch (err) {
        const completedAt = runtime.now();
        const record: StepRecord = {
          stepId,
          kind: "code",
          status: "failed",
          output: null,
          // A thrown step produced no outcome to read units from. Distinct from
          // a `content_fail`/`not_available` outcome, which returns normally
          // above and correctly carries no `usage` either.
          costUsd: 0,
          durationMs: completedAt - startedAt,
          startedAt,
          completedAt,
          error: describeError(err),
        };
        await runtime.store.saveStep(runtime.runId, record);
        throw err;
      }
    },
  );
}
