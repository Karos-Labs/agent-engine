import type { AgentExecutionResult, BaseAgent, Gate, RunKind } from "@agent-engine/core";
import type { DurableStepStore, StepKind, WorkflowBudget } from "../adapters/types.js";
import { runStepCode } from "./step-code.js";
import { runStepAgent, type StepAgentOptions } from "./step-agent.js";
import { runStepGate } from "./step-gate.js";
import { runFanout, type FanoutOptions } from "./fanout.js";

export type GateDefinition = Pick<Gate, "kind" | "payload" | "requiredRole" | "timeout">;
export type GateResponse = NonNullable<Gate["response"]>;

/**
 * What one fan-out slot resolved to, as the workflow author sees it.
 *
 * The three middle statuses arrived with AU68 (SCRUM-366), mirroring
 * `SlotRecord.status`: a slot body that hands back a tool outcome now reports
 * that outcome instead of being flattened to `completed`. They keep `output`
 * because the outcome IS the value — a caller that wants to inspect the tool's
 * own payload still can, exactly as before.
 *
 * `failed` remains what it always meant: the slot body THREW, so there is no
 * output at all, only a reason.
 *
 * The practical consequence for existing callers is that
 * `status === "completed"` is now a strictly narrower claim than "did not
 * throw" — which is the point. Code branching on `status === "failed"` to mean
 * "anything but success" is now wrong and should ask `!== "completed"`.
 */
export type SlotOutcome<TResult> =
  | { slotId: string; status: "completed"; output: TResult }
  | { slotId: string; status: "content_fail" | "not_available" | "tooling_error"; output: TResult; reason: string }
  | { slotId: string; status: "failed"; reason: string };

/** Engine-internal state threaded through every primitive call — never exposed to workflow authors directly. */
export interface WorkflowRuntime {
  runId: string;
  clientSlug: string;
  productId: string;
  runKind: RunKind;
  slotId?: string;
  input: Readonly<Record<string, unknown>>;
  /** Per-stage model overrides for this run, passed straight to each step's `AgentContext`. */
  stageModels?: Readonly<Record<string, string>>;
  /**
   * The language this client publishes in (AU31/SCRUM-309's BrandKit
   * `language` field), read once at dispatch and passed straight to each
   * step's `AgentContext`. Drives AU34/SCRUM-312's per-client model policy for
   * copy steps; absent leaves every step on its compiled model.
   */
  contentLanguage?: string;
  store: DurableStepStore;
  budget?: WorkflowBudget;
  /** Overrides `DEFAULT_AGENT_STEP_TIMEOUT_MS` for every `step.agent` call in this run. */
  agentStepTimeoutMs?: number;
  /** Overrides `MAX_ABSORBED_STEP_TIMEOUTS` for this run. */
  maxAbsorbedStepTimeouts?: number;
  /**
   * How many `step.agent` timeouts this run has already absorbed as returned
   * `tooling_error`s, against that cap.
   *
   * A mutable box rather than a number because the cap is a RUN-level budget
   * and `fanout` hands each slot `{ ...runtime, slotId }` — a plain counter
   * would be copied per slot, so six concurrent slots would each get the full
   * allowance and the run could absorb 6xN. The object survives the spread by
   * reference, which is the whole reason it is one.
   */
  absorbedStepTimeouts?: { count: number };

  /**
   * What this run has spent so far, carried in memory instead of re-summed
   * from the store on every step.
   *
   * A mutable box for exactly the reason `absorbedStepTimeouts` above is one:
   * `fanout` hands each slot `{ ...runtime, slotId }`, so a plain number would
   * be copied per slot and two concurrent slots would each believe the run had
   * spent only what IT spent. The object survives the spread by reference.
   *
   * `totalUsd` is null until the first read seeds it from the store, because a
   * resumed run has to count what a previous process already spent. A cost
   * recorded while it is still null is deliberately NOT accumulated (see
   * `recordRunCost`) — the next read re-sums from the store and picks it up
   * there, which is what keeps the two paths from double-counting.
   */
  costLedger?: RunCostLedger;
  now(): number;
}

/**
 * What a workflow function actually receives (RFC-01 §8.1/§8.2): the run's
 * identity plus the four primitives — `step.code`/`step.agent`/`step.gate`
 * grouped under `step`, `fanout` standing alone, matching the RFC's own
 * pseudocode grouping.
 */
export interface WorkflowContext {
  runId: string;
  clientSlug: string;
  productId: string;
  runKind: RunKind;
  slotId?: string;

  /**
   * What this particular run was asked to do -- the portal brief, a requested
   * topic, a chosen lane.
   *
   * Distinct from `client.getConfig()`, which is the client's STANDING
   * configuration. Both were previously read from the same place, which meant
   * a per-run request had to be written into client-level config before
   * dispatch: two runs for one client would then race, and the second would
   * silently draft against the first's brief.
   *
   * Always present, `{}` when the caller sent nothing, so a workflow never has
   * to guard for undefined before reading a key.
   */
  input: Readonly<Record<string, unknown>>;

  /**
   * The run's cost ceiling, when the dispatcher set one (`WorkflowBudget`).
   * Exposed so a workflow can size its OWN plan against it before spending —
   * a script with five beats that would each buy footage is a different
   * decision under a $2 ceiling than under none — rather than discovering the
   * ceiling only when `step.code`/`step.agent` refuse the next step.
   */
  budget?: WorkflowBudget;

  /**
   * What this run has spent so far, in USD, summed over every checkpointed
   * step (the same `sumRunCost` the budget check uses, so the two never
   * disagree). Served from the run's in-memory ledger, so calling it from
   * inside a per-beat loop costs nothing. Lets a workflow write an honest
   * "spent so far / estimated total" onto a gate payload instead of leaving
   * the reviewer to find the number after the fact.
   */
  costSoFarUsd(): Promise<number>;

  step: {
    /** A deterministic, checkpointed function call. Re-running an already-completed `id` returns the checkpointed output without calling `fn` again. */
    code<T>(id: string, fn: () => T | Promise<T>): Promise<T>;
    /**
     * Invokes a `BaseAgent`, checkpointing its full `AgentExecutionResult`.
     * Layer 1 never inspects `.status` itself — that judgment is the workflow
     * author's (RFC-01 §4), and since AU72 that includes a step that ran out
     * of time, which resolves to `tooling_error` here rather than throwing.
     */
    agent<TOutput>(id: string, agent: BaseAgent<TOutput>, input: unknown, options?: StepAgentOptions): Promise<AgentExecutionResult<TOutput>>;
    /** Registers (or resolves) a human/policy gate (RFC-01 §8.3). Throws `AwaitingGateSignal` until a response is recorded via `WorkflowEngine.resolveGate`. */
    gate(id: string, def: GateDefinition): Promise<GateResponse>;
  };

  /**
   * Runs `fn` once per item, each in its own checkpointed slot (RFC-01
   * §8.1/§8.2) — per-slot retry and cost attribution, isolated from its
   * siblings.
   *
   * At most `options.concurrency` slots are in flight at once, defaulting to
   * `DEFAULT_FANOUT_CONCURRENCY` (AU5 / SCRUM-316). Results are returned in
   * ITEM ORDER, not completion order. A call site fanning out over a
   * rate-limited third-party route should state its own budget explicitly:
   * `wf.fanout(id, items, fn, { concurrency: 3 })`.
   */
  fanout<TItem, TResult>(
    id: string,
    items: readonly TItem[],
    fn: (item: TItem, slotCtx: WorkflowContext, index: number) => Promise<TResult>,
    options?: FanoutOptions,
  ): Promise<Array<SlotOutcome<TResult>>>;
}

/**
 * A run's accumulated spend, held by reference so every slot of a `fanout`
 * and every step primitive reads and writes the SAME number. See
 * `WorkflowRuntime.costLedger`.
 */
export interface RunCostLedger {
  /** USD spent so far, or null when nothing has seeded it from the store yet. */
  totalUsd: number | null;
}

/** Sums every checkpointed `step.agent` call's cost for a run — the single source of truth for budget enforcement, so a resumed run counts correctly. `?? 0`: a `"running"` step (real-time progress reporting) has no `costUsd` yet. */
export async function sumRunCost(store: DurableStepStore, runId: string): Promise<number> {
  const steps = await store.listSteps(runId);
  return steps.reduce((sum, step) => sum + (step.costUsd ?? 0), 0);
}

/**
 * The run's spend, from the in-memory ledger when there is one and from the
 * store when there is not.
 *
 * This is what the budget pre-check in `step.code`/`step.agent` and
 * `wf.costSoFarUsd()` both call, and it exists because `sumRunCost` is not the
 * cheap read its own doc comment claimed. `listSteps` fetches every step
 * DOCUMENT of the run, and a step document carries that step's whole `output`
 * — for `step.agent` an entire `AgentExecutionResult` with every turn's
 * transcript. Calling it once per step therefore re-downloads the run's full
 * history on every step: quadratic in bytes, not just in reads. A tiktok run
 * (the one product with a `RUN_BUDGET_USD_DEFAULTS` entry, and so the one that
 * takes the pre-check today) also calls `wf.costSoFarUsd()` from inside its
 * per-beat loops, several times per beat.
 *
 * The ledger is authoritative only for what THIS process recorded; the seed
 * below is what makes a resume correct. The number written onto the run
 * document at the end of `WorkflowEngine.execute` stays a real `sumRunCost`
 * read, so the persisted total is always store-derived.
 */
export async function runCostSoFar(runtime: WorkflowRuntime): Promise<number> {
  const ledger = runtime.costLedger;
  if (ledger === undefined) return sumRunCost(runtime.store, runtime.runId);
  if (ledger.totalUsd === null) ledger.totalUsd = await sumRunCost(runtime.store, runtime.runId);
  return ledger.totalUsd;
}

/**
 * Folds a just-checkpointed step's cost into the ledger, so the next read does
 * not have to go back to the store for it.
 *
 * Called AFTER `saveStep`, on every path that writes a `costUsd` — including
 * the failure paths, because a step that threw after buying footage was still
 * billed for it.
 *
 * An unseeded ledger (`totalUsd === null`) is left alone rather than
 * initialised to this step's cost: the first read seeds from the store, which
 * by then already contains this step, so accumulating here too would count it
 * twice.
 */
export function recordRunCost(runtime: WorkflowRuntime, costUsd: number): void {
  const ledger = runtime.costLedger;
  if (ledger === undefined || ledger.totalUsd === null) return;
  ledger.totalUsd += costUsd;
}

/**
 * Real-time progress reporting: writes a transient `"running"` checkpoint
 * for `stepId` and points the run's `currentStepId` at it, both BEFORE the
 * step's own function runs — so a reader watching Firestore mid-run sees
 * "step X is in flight" instead of nothing at all until it finishes. Called
 * only after the resume skip-check (an already-`"completed"` step must never
 * flip back to `"running"`).
 *
 * Awaited, not fire-and-forget: `saveStep`'s later terminal write lands on
 * the SAME document via `set(...,{merge:true})`, so if this one were left to
 * race in the background it could complete AFTER the terminal write and
 * merge a stale `status:"running"` back over an already-`"completed"`/
 * `"failed"` record. Errors are swallowed (logged, not thrown) — this is
 * strictly a progress-reporting nicety, and must never abort the step it's
 * only reporting progress for.
 */
export async function markStepRunning(runtime: WorkflowRuntime, stepId: string, kind: StepKind, startedAt: number): Promise<void> {
  try {
    await Promise.all([
      runtime.store.saveStep(runtime.runId, { stepId, kind, status: "running", startedAt }),
      runtime.store.updateRun(runtime.runId, { currentStepId: stepId }),
    ]);
  } catch (err) {
    console.error(`markStepRunning: failed to write in-progress checkpoint for "${stepId}" (run "${runtime.runId}") — continuing without it`, err);
  }
}

/**
 * Namespaces a `step.code`/`step.agent` local id by the enclosing slot, if
 * any — RFC-01 §5.5's per-slot isolation only holds if two sibling slots
 * calling `step.agent("draft", ...)` with the *same* local id land on two
 * *different* checkpoints, not one overwriting the other. The `steps` store
 * only keys on `(runId, stepId)`, so the slot has to be folded into the id
 * itself rather than threaded through as a separate store parameter.
 */
export function scopedStepId(runtime: WorkflowRuntime, id: string): string {
  return runtime.slotId !== undefined ? `${runtime.slotId}::${id}` : id;
}

export function buildWorkflowContext(runtime: WorkflowRuntime): WorkflowContext {
  return {
    runId: runtime.runId,
    clientSlug: runtime.clientSlug,
    productId: runtime.productId,
    runKind: runtime.runKind,
    input: runtime.input,
    ...(runtime.slotId !== undefined ? { slotId: runtime.slotId } : {}),
    ...(runtime.budget !== undefined ? { budget: runtime.budget } : {}),
    costSoFarUsd: () => runCostSoFar(runtime),
    step: {
      code: (id, fn) => runStepCode(runtime, id, fn),
      agent: (id, agent, input, options) => runStepAgent(runtime, id, agent, input, options),
      gate: (id, def) => runStepGate(runtime, id, def),
    },
    fanout: (id, items, fn, options) => runFanout(runtime, id, items, fn, options),
  };
}
