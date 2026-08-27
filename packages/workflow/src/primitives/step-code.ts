import { computeToolCostUsd, extractToolUsage } from "@agent-engine/core";
import { describeError, withWorkflowStepSpan } from "@agent-engine/telemetry";
import type { StepRecord } from "../adapters/types.js";
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
  if (existing && existing.status === "completed") {
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
        // SCRUM-361. This used to be the literal constant 0, and that was the
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
          status: "completed",
          output,
          costUsd: computeToolCostUsd(unitUsage),
          ...(unitUsage.length > 0 ? { unitUsage: unitUsage.map((u) => ({ ...u })) } : {}),
          durationMs: completedAt - startedAt,
          startedAt,
          completedAt,
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
