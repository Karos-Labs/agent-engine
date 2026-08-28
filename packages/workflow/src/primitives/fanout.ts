import { describeError } from "@agent-engine/telemetry";
import type { SlotRecord, SlotRecordStatus } from "../adapters/types.js";
import type { SlotOutcome, WorkflowContext, WorkflowRuntime } from "./context.js";
import { buildWorkflowContext } from "./context.js";
import { AwaitingGateSignal, WorkflowBlockedIntake, WorkflowBudgetExceeded, WorkflowHeld } from "./signals.js";
import { isCheckpointedStepStatus } from "../adapters/types.js";
import { describeOutcomeReason, statusFromOutcome } from "./outcome-status.js";

/**
 * The in-memory `SlotOutcome` for a recorded slot status, so the value the
 * workflow author sees and the value persisted for the run record are derived
 * in one place from one fact.
 *
 * Splitting them is how AU67/AU68 happened in the first place, one layer down:
 * a record saying `tooling_error` while the returned outcome said `completed`
 * would just move the lie rather than remove it.
 */
function slotOutcome<TResult>(slotId: string, status: SlotRecordStatus, output: TResult, error: string | undefined): SlotOutcome<TResult> {
  if (status === "completed") return { slotId, status, output };
  if (status === "failed") return { slotId, status, reason: error ?? "slot failed" };
  return { slotId, status, output, reason: error ?? `slot resolved to "${status}"` };
}

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
        // AU68: replay the RECORDED verdict, not a blanket `completed`. A slot
        // that resolved to `tooling_error` must resume as `tooling_error` —
        // otherwise the resume path would quietly reintroduce the very lie the
        // first-run path just stopped telling.
        return slotOutcome(slotId, existing.status, existing.output as TResult, existing.error);
      }

      const slotRuntime: WorkflowRuntime = { ...runtime, slotId };
      const slotCtx = buildWorkflowContext(slotRuntime);
      const startedAt = runtime.now();

      try {
        const output = await fn(item, slotCtx, index);
        const completedAt = runtime.now();
        // AU68 / SCRUM-366, having been checked as a PRODUCER in AU67 and found
        // NOT structurally safe (unlike `step.gate`): `fn` is arbitrary caller
        // code exactly like `step.code`'s body, so a slot handing back a tool
        // outcome recorded `completed` for a `tooling_error` — the same defect,
        // in the same shape, one primitive over.
        //
        // It misreported nothing at the time, and that was a property of the
        // six call sites rather than of this function: campaign-orchestrator's
        // slots run whole channel workflows, whose inner steps record correctly
        // on their own. "fanout is fine" was true and would have stopped being
        // true the first time someone fanned out over a tool call.
        //
        // The same translation `step.code` uses, from the same module, so the
        // two cannot drift.
        const status = statusFromOutcome(output);
        const reason = describeOutcomeReason(output);
        const record: SlotRecord = {
          slotId,
          fanoutId: id,
          status,
          output,
          durationMs: completedAt - startedAt,
          startedAt,
          completedAt,
          ...reason,
        };
        await runtime.store.saveSlot(runtime.runId, record);
        return slotOutcome(slotId, status, output, reason.error);
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
