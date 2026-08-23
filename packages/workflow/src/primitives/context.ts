import type { AgentExecutionResult, BaseAgent, Gate, RunKind } from "@agent-engine/core";
import type { DurableStepStore, StepKind, WorkflowBudget } from "../adapters/types.js";
import { runStepCode } from "./step-code.js";
import { runStepAgent } from "./step-agent.js";
import { runStepGate } from "./step-gate.js";
import { runFanout } from "./fanout.js";

export type GateDefinition = Pick<Gate, "kind" | "payload" | "requiredRole" | "timeout">;
export type GateResponse = NonNullable<Gate["response"]>;

export type SlotOutcome<TResult> =
  | { slotId: string; status: "completed"; output: TResult }
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
  store: DurableStepStore;
  budget?: WorkflowBudget;
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

  step: {
    /** A deterministic, checkpointed function call. Re-running an already-completed `id` returns the checkpointed output without calling `fn` again. */
    code<T>(id: string, fn: () => T | Promise<T>): Promise<T>;
    /** Invokes a `BaseAgent`, checkpointing its full `AgentExecutionResult`. Layer 1 never inspects `.status` itself — that judgment is the workflow author's (RFC-01 §4). */
    agent<TOutput>(id: string, agent: BaseAgent<TOutput>, input: unknown): Promise<AgentExecutionResult<TOutput>>;
    /** Registers (or resolves) a human/policy gate (RFC-01 §8.3). Throws `AwaitingGateSignal` until a response is recorded via `WorkflowEngine.resolveGate`. */
    gate(id: string, def: GateDefinition): Promise<GateResponse>;
  };

  /** Runs `fn` once per item, each in its own checkpointed slot (RFC-01 §8.1/§8.2) — per-slot retry and cost attribution, isolated from its siblings. */
  fanout<TItem, TResult>(
    id: string,
    items: readonly TItem[],
    fn: (item: TItem, slotCtx: WorkflowContext, index: number) => Promise<TResult>,
  ): Promise<Array<SlotOutcome<TResult>>>;
}

/** Sums every checkpointed `step.agent` call's cost for a run — the single source of truth for budget enforcement, so a resumed run counts correctly. `?? 0`: a `"running"` step (real-time progress reporting) has no `costUsd` yet. */
export async function sumRunCost(store: DurableStepStore, runId: string): Promise<number> {
  const steps = await store.listSteps(runId);
  return steps.reduce((sum, step) => sum + (step.costUsd ?? 0), 0);
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
    step: {
      code: (id, fn) => runStepCode(runtime, id, fn),
      agent: (id, agent, input) => runStepAgent(runtime, id, agent, input),
      gate: (id, def) => runStepGate(runtime, id, def),
    },
    fanout: (id, items, fn) => runFanout(runtime, id, items, fn),
  };
}
