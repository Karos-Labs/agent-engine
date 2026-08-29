import { computeToolCostUsd, extractToolUsage } from "@agent-engine/core";
import { describeError, recordWorkflowStepMetric, withWorkflowStepSpan } from "@agent-engine/telemetry";
import { isCheckpointedStepStatus, type StepRecord } from "../adapters/types.js";
// AU67's translation, shared with `fanout` since AU68 (SCRUM-366) — see that module.
import { describeOutcomeReason, statusFromOutcome } from "./outcome-status.js";
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
    async (_span, markOutcome) => {
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
        const status = statusFromOutcome(output);
        const record: StepRecord = {
          stepId,
          kind: "code",
          // AU67: the step now says what its tool actually reported. It still
          // RAN, so it stays checkpointed and resume is unchanged — see
          // `isCheckpointedStepStatus`.
          status,
          output,
          costUsd: computeToolCostUsd(unitUsage),
          ...(unitUsage.length > 0 ? { unitUsage: unitUsage.map((u) => ({ ...u })) } : {}),
          durationMs: completedAt - startedAt,
          startedAt,
          completedAt,
          ...describeOutcomeReason(output),
        };
        await runtime.store.saveStep(runtime.runId, record);
        recordWorkflowStepMetric({ stepKind: "code", status });
        // AU42/SCRUM-326. `fn()` returning normally is not the same as the step
        // succeeding — `statusFromOutcome` can read `"tooling_error"` straight
        // off a NON-thrown return value (RFC-01 §6's whole point: a tool
        // reports a broken call BY RETURNING that status, an exception is
        // reserved for something the tool didn't even manage to structure a
        // response for). Before this call, a `tooling_error` step and a
        // genuinely successful one produced an identical `OK` span — the trace
        // agreed with the bug, not the record. See `markOutcome`'s own doc
        // comment.
        //
        // `content_fail`/`not_available` deliberately do NOT mark the span an
        // error, for the same reason `WorkflowHeld`/`WorkflowBlockedIntake`
        // don't at the run level (`workflow-engine.ts`): both are the tool's
        // own content judgment or a designed "nothing to do here" state, not a
        // malfunction — Layer 1 makes zero content judgments (RFC-01 §4), and
        // neither should its telemetry.
        if (status === "tooling_error") {
          markOutcome(true, describeOutcomeReason(output).error ?? `step.code resolved to "${status}"`);
        }
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
        recordWorkflowStepMetric({ stepKind: "code", status: "failed" });
        throw err;
      }
    },
  );
}
