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
 * How many fan-out slots run at once when a call site does not say (AU5 /
 * SCRUM-316).
 *
 * Be honest about what this number is: a POLICY choice, not a measurement.
 * Nothing in this repo records how many simultaneous slots a downstream API
 * tolerates, and inventing a run id to justify a constant would be worse than
 * saying so. It is picked to be small enough that a fan-out over a
 * rate-limited third-party route cannot open an unbounded burst by default,
 * and large enough that today's call sites — campaign-orchestrator's channel
 * fan-out, reputation's draft cycles, seo-geo's crawl — are not serialised.
 *
 * A call site with a real per-route budget states it: `{ concurrency: 3 }`.
 */
export const DEFAULT_FANOUT_CONCURRENCY = 8;

/** Per-call options for `fanout` (AU5 / SCRUM-316). */
export interface FanoutOptions {
  /**
   * Maximum slots in flight at once. Must be an integer >= 1.
   *
   * There is deliberately NO value meaning "unbounded": `Infinity` is
   * rejected, so is `0`, so is a negative or fractional number. The cap this
   * ticket exists to add would be worth nothing if it shipped with a switch
   * that turns it off — that is the shape of every defect in this repo's
   * repeating family (an allowlist that meant "anyone"). A call site that
   * genuinely wants every item at once says `items.length` and says it out
   * loud at the call site.
   *
   * Defaults to {@link DEFAULT_FANOUT_CONCURRENCY}.
   */
  concurrency?: number;
}

/**
 * Resolves and VALIDATES the effective cap.
 *
 * What makes this guard fail (the house rule): any `concurrency` that is not
 * a finite integer >= 1. `Number.isInteger` is false for `Infinity`, `NaN`,
 * `2.5` and every non-number, so the only inputs that survive are real caps.
 * Thrown, not clamped: a call site that asked for `0` or `Infinity` has a
 * wrong belief about its own rate budget, and silently substituting a default
 * would hide exactly the mistake worth surfacing.
 */
function resolveConcurrency(id: string, options: FanoutOptions | undefined): number {
  const requested = options?.concurrency ?? DEFAULT_FANOUT_CONCURRENCY;
  if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1) {
    throw new TypeError(
      `fanout("${id}"): concurrency must be an integer >= 1 (there is no "unbounded" value), got ${String(requested)}`,
    );
  }
  return requested;
}

/**
 * `fanout(id, items, fn, options?)` (RFC-01 §8.1/§8.2): one checkpointed slot
 * per item, with positional slot ids, run concurrently up to a bounded cap.
 * Each fan-out unit of work is isolated the way RFC-01 §5.5 describes — a
 * slot's own failure is captured as that slot's outcome, not a crash of its
 * siblings, giving per-slot retry and per-slot cost attribution.
 *
 * `AwaitingGateSignal`/`WorkflowBudgetExceeded`/`WorkflowHeld`/
 * `WorkflowBlockedIntake` are the exceptions to that isolation: each is a
 * run-level condition (a gate, a budget ceiling, or a domain outcome per
 * RFC-01 §16.2 that describes the whole batch, not one item), so all four
 * are re-thrown rather than captured as a slot failure. `WorkflowContentFailure`/
 * `WorkflowToolingFailure` are deliberately NOT in this list — thrown inside
 * a slot, they stay that slot's own failure, exactly like any other error.
 *
 * CONCURRENCY (AU5 / SCRUM-316). This used to be an unbounded `Promise.all`:
 * every item started in the same tick. Survivable while the slot bodies were
 * model calls behind our own quota; not survivable the moment a slot body is
 * a rate-limited third-party route and `items` is "N prompts x 5 engines".
 * Slots are now pulled from a shared index by a fixed pool of at most
 * `concurrency` workers. Results stay in ITEM ORDER regardless of the order
 * they finish, so the returned array indexes the same way `Promise.all`'s did.
 *
 * A run-level signal from any slot also stops the pool ADMITTING new slots —
 * the old `Promise.all` had already started everything, so a gate raised by
 * slot 0 could not prevent slot 40 from spending. Slots already in flight are
 * awaited (never abandoned mid-write) and then the first run-level signal is
 * re-thrown.
 */
export async function runFanout<TItem, TResult>(
  runtime: WorkflowRuntime,
  id: string,
  items: readonly TItem[],
  fn: (item: TItem, slotCtx: WorkflowContext, index: number) => Promise<TResult>,
  options?: FanoutOptions,
): Promise<Array<SlotOutcome<TResult>>> {
  const concurrency = resolveConcurrency(id, options);

  async function runSlot(item: TItem, index: number): Promise<SlotOutcome<TResult>> {
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
  }

  const outcomes = new Array<SlotOutcome<TResult>>(items.length);
  let nextIndex = 0;
  let runLevelSignal: { err: unknown } | undefined;

  async function worker(): Promise<void> {
    while (runLevelSignal === undefined) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        outcomes[index] = await runSlot(items[index] as TItem, index);
      } catch (err) {
        // Only a run-level signal reaches here — `runSlot` captures everything
        // else as that slot's own outcome. First one wins; the rest of the
        // pool drains without admitting new slots.
        runLevelSignal ??= { err };
        return;
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (runLevelSignal !== undefined) {
    throw runLevelSignal.err;
  }
  return outcomes;
}
