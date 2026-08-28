import type { AgentContext, AgentExecutionResult, AgentExecutionStatus, BaseAgent } from "@agent-engine/core";
import { recordCostAndTokens, withWorkflowStepSpan } from "@agent-engine/telemetry";
import type { StepRecord } from "../adapters/types.js";
import type { WorkflowRuntime } from "./context.js";
import { markStepRunning, scopedStepId, sumRunCost } from "./context.js";
import { WorkflowBudgetExceeded, WorkflowStepTimeout } from "./signals.js";
import { isCheckpointedStepStatus, type StepRecordStatus } from "../adapters/types.js";

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
 * The agent's terminal verdict, as the status a checkpoint records
 * (AU68 / SCRUM-366).
 *
 * All four `AgentExecutionStatus` values are members of `StepRecordStatus`, so
 * this is an identity mapping — and that is the point rather than an accident.
 * `budget_exceeded` was added to `StepRecordSchema` for this function instead
 * of being folded into `tooling_error`, because a loop that hit its configured
 * turn ceiling did not malfunction. Writing this as a total mapping (rather
 * than `result.status as StepRecordStatus`) is what makes the compiler, not a
 * reviewer, the thing that catches a fifth value being added upstream.
 */
function stepStatusFromAgentStatus(status: AgentExecutionStatus): StepRecordStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "content_fail":
      return "content_fail";
    case "tooling_error":
      return "tooling_error";
    case "budget_exceeded":
      return "budget_exceeded";
  }
}

/**
 * The agent's own reason for a non-`completed` verdict, promoted onto the
 * record — same argument as `step.code`'s `describeOutcomeReason`. A record
 * that says THAT a step failed but not why makes an auth failure, a schema
 * violation and a wedged tool look identical in a run report.
 *
 * The LAST turn carrying an error is the one that ended the loop; earlier ones
 * were retried past.
 */
function describeAgentOutcome(result: AgentExecutionResult<unknown>): { error?: string } {
  if (result.status === "completed") return {};
  const turnError = [...result.steps].reverse().find((step) => step.error !== undefined)?.error;
  return { error: turnError === undefined ? `agent step resolved to "${result.status}"` : `agent step resolved to "${result.status}": ${turnError}` };
}

/**
 * `step.agent(id, agent, input)` (RFC-01 §8.1/§8.2): invokes a `BaseAgent`,
 * checkpointing its full `AgentExecutionResult`. The step's recorded status IS
 * the agent's terminal `AgentExecutionStatus` — `completed`/`content_fail`/
 * `tooling_error`/`budget_exceeded` — since AU68 (SCRUM-366).
 *
 * It used to be hardcoded `"completed"` whenever the call returned without
 * throwing, which is AU67's defect one primitive over: a `BaseAgent` reports
 * failure as a RETURNED status, never as an exception, so every failed agent
 * step was persisted as a completed one. The verdict was not even unavailable
 * to the recorder — it is read a few lines below for telemetry and set as a
 * span attribute, then was dropped on the floor for the record.
 *
 * This is NOT Layer 1 making a content judgment (RFC-01 §4). It makes none: it
 * copies down the verdict the agent itself reached, verbatim and unflattened,
 * exactly as `step.code` copies down a tool's outcome. The workflow author
 * still reads `result.status` from the returned value to decide control flow;
 * nothing about that changed.
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
  if (existing && isCheckpointedStepStatus(existing.status)) {
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
      // SCRUM-361 item 3 precondition. `servedBy` is per-TURN; a step is
      // attributed to the fallback if ANY of its turns was, because that is the
      // question the reconciliation asks — was any part of this cost billed by
      // someone other than Google. The last such turn wins for the adapter
      // name, matching how `model` already picks the last turn's model.
      const fellOver = result.steps.filter((step) => step.servedBy && step.servedBy.hop !== "primary");
      const servedBy = fellOver.at(-1)?.servedBy;

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
        ...(servedBy ? { servedByHop: servedBy.hop, servingAdapter: servedBy.adapter } : {}),
      });
      span.setAttribute("agent_status", result.status);

      const record: StepRecord = {
        stepId,
        kind: "agent",
        // AU68: the step now says what the agent actually reported. It still
        // RAN and its output is still replayable, so it stays checkpointed and
        // resume is unchanged — see `isCheckpointedStepStatus`.
        status: stepStatusFromAgentStatus(result.status),
        output: result,
        costUsd: result.totalCostUsd,
        durationMs: completedAt - startedAt,
        startedAt,
        completedAt,
        ...describeAgentOutcome(result),
      };
      await runtime.store.saveStep(runtime.runId, record);
      return result;
    },
  );
}
