import { describeError } from "@agent-engine/telemetry";
import type { SlotRecord } from "../adapters/types.js";
import type { SlotOutcome, WorkflowContext, WorkflowRuntime } from "./context.js";
import { buildWorkflowContext } from "./context.js";
import { AwaitingGateSignal, WorkflowBlockedIntake, WorkflowBudgetExceeded, WorkflowHeld } from "./signals.js";
import { isCheckpointedStepStatus } from "../adapters/types.js";

const RUN_LEVEL_SIGNALS = [AwaitingGateSignal, WorkflowBudgetExceeded, WorkflowHeld, WorkflowBlockedIntake] as const;

/**
 * `fanout(id, items, fn)` (RFC-01 §8.1/§8.2): one checkpointed slot per item,
 * with positional slot ids, run concurrently. Each fan-out unit of work is
 * isolated the way RFC-01 §5.5 describes — a slot's own failure is captured
 * as that slot's outcome, not a crash of its siblings, giving per-slot retry
 * and per-slot cost attribution.
 *
 * `AwaitingGateSignal`/`WorkflowBudgetExceeded`/`WorkflowHeld`/
 * `WorkflowBlockedIntake` are the exceptions to that isolation: each is a
 * run-level condition (a gate, a budget ceiling, or a domain outcome per
 * RFC-01 §16.2 that describes the whole batch, not one item), so all four
 * are re-thrown rather than captured as a slot failure. `WorkflowContentFailure`/
 * `WorkflowToolingFailure` are deliberately NOT in this list — thrown inside
 * a slot, they stay that slot's own failure, exactly like any other error.
 *
 * Phase 1 simplification: if one slot rethrows, `Promise.all` rejects
 * immediately while sibling slots may still be mid-flight in the
 * background — their results are simply discarded, not cancelled. Fine at
 * the fan-out sizes this phase targets (tens of slots); revisit if that
 * changes.
 */
export async function runFanout<TItem, TResult>(
  runtime: WorkflowRuntime,
  id: string,
  items: readonly TItem[],
  fn: (item: TItem, slotCtx: WorkflowContext, index: number) => Promise<TResult>,
): Promise<Array<SlotOutcome<TResult>>> {
  return Promise.all(
    items.map(async (item, index): Promise<SlotOutcome<TResult>> => {
      const slotId = `${id}__slot_${index}`;
      const existing = await runtime.store.getSlot(runtime.runId, slotId);
      if (existing && isCheckpointedStepStatus(existing.status)) {
        return { slotId, status: "completed", output: existing.output as TResult };
      }

      const slotRuntime: WorkflowRuntime = { ...runtime, slotId };
      const slotCtx = buildWorkflowContext(slotRuntime);
      const startedAt = runtime.now();

      try {
        const output = await fn(item, slotCtx, index);
        const completedAt = runtime.now();
        const record: SlotRecord = {
          slotId,
          fanoutId: id,
          status: "completed",
          output,
          durationMs: completedAt - startedAt,
          startedAt,
          completedAt,
        };
        await runtime.store.saveSlot(runtime.runId, record);
        return { slotId, status: "completed", output };
      } catch (err) {
        if (RUN_LEVEL_SIGNALS.some((SignalClass) => err instanceof SignalClass)) {
          throw err;
        }
        const completedAt = runtime.now();
        const reason = describeError(err);
        const record: SlotRecord = {
          slotId,
          fanoutId: id,
          status: "failed",
          output: null,
          durationMs: completedAt - startedAt,
          startedAt,
          completedAt,
          error: reason,
        };
        await runtime.store.saveSlot(runtime.runId, record);
        return { slotId, status: "failed", reason };
      }
    }),
  );
}
