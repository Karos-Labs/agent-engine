import type { AgentContext, AgentExecutionResult, BaseAgent } from "@agent-engine/core";
import { recordCostAndTokens, withWorkflowStepSpan } from "@agent-engine/telemetry";
import type { StepRecord } from "../adapters/types.js";
import type { WorkflowRuntime } from "./context.js";
import { markStepRunning, scopedStepId, sumRunCost } from "./context.js";
import { WorkflowBudgetExceeded, WorkflowStepTimeout } from "./signals.js";
import { isCheckpointedStepStatus } from "../adapters/types.js";

/**
 * The bound on a single `step.agent` call absent an explicit
 * `WorkflowRuntime.agentStepTimeoutMs`.
 *
 * Sized off real vetting-step durations, not guessed: the largest observed
 * candidate-pool vet in prep (`06-vet-images-attempt-1`,
 * pubsub-21543794087429035) took ~182s. 10 minutes is generous headroom
 * above that while still bounding a genuinely wedged call to something far
 * short of "forever".
 */
export const DEFAULT_AGENT_STEP_TIMEOUT_MS = 10 * 60_000;

/**
 * The key on `AgentContext.metadata` carrying the step's abort signal
 * (AU5 / SCRUM-316).
 *
 * `metadata` rather than a new top-level `AgentContext` field because
 * `AgentContext` is a zod schema in `@agent-engine/core` and this ticket's
 * surface is `packages/workflow/src/primitives`; `metadata` is already
 * `Record<string, unknown>` and already reaches both `BaseAgent.run` and
 * every Layer 3 tool's `ToolExecuteOptions.ctx`, which is exactly the set of
 * places that can act on a cancellation.
 */
export const STEP_ABORT_SIGNAL_METADATA_KEY = "abortSignal";

/**
 * Reads the abort signal the engine attached to this step, if any.
 *
 * Returns `undefined` rather than a never-firing dummy on purpose. A stand-in
 * `new AbortController().signal` would let a consumer wire up cancellation
 * that CANNOT fire and look wired-up forever — the repeating defect in this
 * repo, one layer over. `undefined` forces the caller to notice it is running
 * outside a `step.agent` and decide.
 */
export function stepAbortSignal(ctx: AgentContext): AbortSignal | undefined {
  const candidate = ctx.metadata[STEP_ABORT_SIGNAL_METADATA_KEY];
  return candidate instanceof AbortSignal ? candidate : undefined;
}

/**
 * Races `run` against a timer, rejecting with `WorkflowStepTimeout` if the
 * timer wins — and, when it does, ABORTING `controller` with that same
 * `WorkflowStepTimeout` as the abort reason (AU5 / SCRUM-316).
 *
 * Before this, the timeout only stopped the engine WAITING: the model call
 * behind `run` kept going and kept billing, with its result simply never
 * observed. Firing the controller is the propagation half — `controller.signal`
 * is handed to the agent on `AgentContext.metadata` (see
 * {@link STEP_ABORT_SIGNAL_METADATA_KEY}), so a `BaseAgent` between ReAct
 * turns and any Layer 3 tool holding `ctx` can see the step has given up and
 * stop.
 *
 * LIMIT, stated plainly: firing a signal cancels nothing by itself. Today
 * `BaseAgent.runReActLoop` does not check it, so an in-flight provider call
 * still runs to completion; consuming the signal is a `@agent-engine/core`
 * change and is NOT in this ticket's surface. What lands here is the signal
 * being created, fired, and delivered — verified by test — not the consumer.
 */
function withStepTimeout<T>(run: Promise<T>, stepId: string, timeoutMs: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const timeout = new WorkflowStepTimeout(stepId, timeoutMs);
      // Abort BEFORE rejecting: the rejection unwinds this step synchronously
      // through its caller, and a consumer that reacts to the rejection should
      // find the signal already fired rather than racing it.
      controller.abort(timeout);
      reject(timeout);
    }, timeoutMs);
    run.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * `step.agent(id, agent, input)` (RFC-01 §8.1/§8.2): invokes a `BaseAgent`,
 * checkpointing its full `AgentExecutionResult`. The step's own status is
 * always `"completed"` once the agent call returns without throwing — the
 * agent's *content* verdict (`completed`/`content_fail`/`tooling_error`/
 * `budget_exceeded`) lives inside the checkpointed `output`, for the
 * workflow author to inspect. Layer 1 never inspects it itself (RFC-01 §4).
 *
 * `agent.run()` is raced against `DEFAULT_AGENT_STEP_TIMEOUT_MS` (override via
 * `WorkflowRuntime.agentStepTimeoutMs`) — a call that never settles throws
 * `WorkflowStepTimeout` instead of leaving this step, and the whole run, at
 * `"running"` forever. On timeout the step's `AbortSignal` — delivered to the
 * agent on `ctx.metadata[STEP_ABORT_SIGNAL_METADATA_KEY]`, readable via
 * `stepAbortSignal(ctx)` — is aborted with that same `WorkflowStepTimeout` as
 * its reason (AU5 / SCRUM-316).
 *
 * Inside a `fanout` slot, `id` is namespaced by the slot (RFC-01 §5.5's
 * per-slot isolation) — sibling slots calling `step.agent("draft", ...)`
 * each get their own checkpoint, never one overwriting the other.
 */
export async function runStepAgent<TOutput>(
  runtime: WorkflowRuntime,
  id: string,
  agent: BaseAgent<TOutput>,
  input: unknown,
): Promise<AgentExecutionResult<TOutput>> {
  const stepId = scopedStepId(runtime, id);
  const existing = await runtime.store.getStep(runtime.runId, stepId);
  if (existing && isCheckpointedStepStatus(existing.status)) {
    return existing.output as AgentExecutionResult<TOutput>;
  }

  if (runtime.budget?.maxTotalCostUsd !== undefined) {
    const spentSoFar = await sumRunCost(runtime.store, runtime.runId);
    if (spentSoFar >= runtime.budget.maxTotalCostUsd) {
      throw new WorkflowBudgetExceeded(runtime.runId, spentSoFar, runtime.budget.maxTotalCostUsd);
    }
  }

  // One controller per step.agent call. It is fired by `withStepTimeout` and
  // by nothing else — there is no other path that aborts a step today, so a
  // consumer seeing `signal.aborted` knows it means "this step timed out".
  const abortController = new AbortController();

  const ctx: AgentContext = {
    runId: runtime.runId,
    clientSlug: runtime.clientSlug,
    productId: runtime.productId,
    runKind: runtime.runKind,
    ...(runtime.slotId !== undefined ? { slotId: runtime.slotId } : {}),
    // Every agent step in the engine is constructed here, so this is the one
    // place a per-run model choice has to be attached for all of them.
    ...(runtime.stageModels !== undefined ? { stageModels: runtime.stageModels } : {}),
    metadata: { [STEP_ABORT_SIGNAL_METADATA_KEY]: abortController.signal },
  };

  return withWorkflowStepSpan(
    {
      runId: runtime.runId,
      clientSlug: runtime.clientSlug,
      productId: runtime.productId,
      ...(runtime.slotId !== undefined ? { slotId: runtime.slotId } : {}),
      stepId,
      stepKind: "agent",
    },
    async (span) => {
      const startedAt = runtime.now();
      await markStepRunning(runtime, stepId, "agent", startedAt);
      const timeoutMs = runtime.agentStepTimeoutMs ?? DEFAULT_AGENT_STEP_TIMEOUT_MS;
      const result = await withStepTimeout(agent.run(ctx, input), stepId, timeoutMs, abortController);
      const completedAt = runtime.now();

      // AgentExecutionResult.totalTokens.input is already the cached+uncached sum
      // (RFC-01 §5.1) — recover the split from the per-turn telemetry for the span.
      const inputTokensCached = result.steps.reduce((sum, step) => sum + step.inputTokens.cached, 0);
      const inputTokensUncached = result.steps.reduce((sum, step) => sum + step.inputTokens.uncached, 0);
      recordCostAndTokens(span, {
        runId: runtime.runId,
        clientId: runtime.clientSlug,
        agentId: runtime.productId,
        // A ReAct loop can in principle route different turns to different
        // models (ModelRouter's choice) — the last turn's model is the most
        // representative single value for one BigQuery row per agent run.
        model: result.steps.at(-1)?.modelUsed ?? "unknown",
        costUsd: result.totalCostUsd,
        inputTokensCached,
        inputTokensUncached,
        outputTokens: result.totalTokens.output,
        durationMs: completedAt - startedAt,
        status: result.status,
        // Discriminator columns (2026-08) — `runId` above is the WHOLE
        // workflow run's id, shared by every step.agent() call inside it, so
        // without `stepId` two rows from the same run can't be told apart.
        jobId: runtime.runId,
        stepId,
        operation: "workflow_step_agent",
      });
      span.setAttribute("agent_status", result.status);

      const record: StepRecord = {
        stepId,
        kind: "agent",
        status: "completed",
        output: result,
        costUsd: result.totalCostUsd,
        durationMs: completedAt - startedAt,
        startedAt,
        completedAt,
      };
      await runtime.store.saveStep(runtime.runId, record);
      return result;
    },
  );
}
