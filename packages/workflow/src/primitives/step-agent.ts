import type { AgentContext, AgentExecutionResult, BaseAgent } from "@agent-engine/core";
import { recordCostAndTokens, withWorkflowStepSpan } from "@agent-engine/telemetry";
import type { StepRecord } from "../adapters/types.js";
import type { WorkflowRuntime } from "./context.js";
import { markStepRunning, scopedStepId, sumRunCost } from "./context.js";
import { WorkflowBudgetExceeded, WorkflowStepTimeout } from "./signals.js";

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
 * Races `run` against a timer, rejecting with `WorkflowStepTimeout` if the
 * timer wins.
 *
 * This does not cancel `run` — there is no cooperative cancellation path
 * through a `BaseAgent`'s ReAct loop and the tool calls inside it — so a
 * call that eventually settles after the timeout fires still runs to
 * completion in the background, its result simply never observed. What this
 * buys is a bounded wait: the *step* (and therefore the run) gives up and
 * reports a tooling failure instead of sitting at `"running"` indefinitely.
 */
function withStepTimeout<T>(run: Promise<T>, stepId: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WorkflowStepTimeout(stepId, timeoutMs)), timeoutMs);
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
 * `"running"` forever.
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
  if (existing && existing.status === "completed") {
    return existing.output as AgentExecutionResult<TOutput>;
  }

  if (runtime.budget?.maxTotalCostUsd !== undefined) {
    const spentSoFar = await sumRunCost(runtime.store, runtime.runId);
    if (spentSoFar >= runtime.budget.maxTotalCostUsd) {
      throw new WorkflowBudgetExceeded(runtime.runId, spentSoFar, runtime.budget.maxTotalCostUsd);
    }
  }

  const ctx: AgentContext = {
    runId: runtime.runId,
    clientSlug: runtime.clientSlug,
    productId: runtime.productId,
    runKind: runtime.runKind,
    ...(runtime.slotId !== undefined ? { slotId: runtime.slotId } : {}),
    // Every agent step in the engine is constructed here, so this is the one
    // place a per-run model choice has to be attached for all of them.
    ...(runtime.stageModels !== undefined ? { stageModels: runtime.stageModels } : {}),
    metadata: {},
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
      const result = await withStepTimeout(agent.run(ctx, input), stepId, timeoutMs);
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
