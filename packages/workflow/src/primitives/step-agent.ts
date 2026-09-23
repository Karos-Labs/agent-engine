import { ABORT_SIGNAL_METADATA_KEY, computeToolCostUsd, runInToolUsageScope, type AgentContext, type AgentExecutionResult, type AgentExecutionStatus, type BaseAgent, type ToolUnitUsage } from "@agent-engine/core";
import { recordCostAndTokens, recordWorkflowStepMetric, withWorkflowStepSpan } from "@agent-engine/telemetry";
import type { StepRecord } from "../adapters/types.js";
import type { WorkflowRuntime } from "./context.js";
import { markStepRunning, recordRunCost, runCostSoFar, scopedStepId } from "./context.js";
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
 * How many step timeouts one run will ABSORB (as returned `tooling_error`
 * results) before the next one is thrown and ends the run.
 *
 * The cap exists because the two failure shapes this guard covers are
 * genuinely different, and only one of them is worth absorbing:
 *
 *  - ONE step crossing its bound while its siblings finish — a slow template,
 *    a provider hiccup, a single retry storm. Absorbing it costs one step and
 *    the run still delivers. This is the common case and the case AU72 was
 *    written for.
 *  - EVERY step crossing its bound — a wedged provider, a dead network leg.
 *    Absorbing those costs `timeoutMs` EACH, so a 40-step workflow would sit
 *    there for hours and still deliver nothing. The lease heartbeat renews
 *    while a run executes, so nothing else would stop it.
 *
 * Three rather than one because the whole point is to survive isolated
 * faults, and rather than ten because past three the "isolated" reading is no
 * longer available. Override per run with `WorkflowRuntime.maxAbsorbedStepTimeouts`.
 */
export const MAX_ABSORBED_STEP_TIMEOUTS = 3;

/** Per-`step.agent` overrides. Today just the timeout — see {@link runStepAgent}. */
export interface StepAgentOptions {
  /**
   * Overrides `WorkflowRuntime.agentStepTimeoutMs` / `DEFAULT_AGENT_STEP_TIMEOUT_MS`
   * for THIS call.
   *
   * For steps whose honest p99 is known to sit near the default and which are
   * not worth losing to it — a template-studio design turn takes 275–500s
   * measured, and doubles again whenever every Sonnet call is failing over
   * from Vertex to Anthropic on a 429. Raising the global default to cover
   * them would un-bound every cheap step in the fleet; this raises the bound
   * only where the measurement says it belongs.
   */
  timeoutMs?: number;
}

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
export const STEP_ABORT_SIGNAL_METADATA_KEY = ABORT_SIGNAL_METADATA_KEY;

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
 * The consumer landed 2026-09-22 (`agentAbortReason` in
 * `@agent-engine/core`): `BaseAgent.runReActLoop` checks the signal before and
 * after every turn and before every tool execution, and stops. What is still
 * NOT cancelled is the single provider call already in flight when the timer
 * fires — no `ModelAdapter.complete()` accepts a signal — so that
 * one call runs to completion and bills. Everything after it does not.
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
 * `agent.run()` is raced against `DEFAULT_AGENT_STEP_TIMEOUT_MS` (override per
 * run via `WorkflowRuntime.agentStepTimeoutMs`, per call via
 * `options.timeoutMs`) — a call that never settles resolves the step instead
 * of leaving it, and the whole run, at `"running"` forever. On timeout the
 * step's `AbortSignal` — delivered to the agent on
 * `ctx.metadata[STEP_ABORT_SIGNAL_METADATA_KEY]`, readable via
 * `stepAbortSignal(ctx)` — is aborted with that same `WorkflowStepTimeout` as
 * its reason (AU5 / SCRUM-316).
 *
 * A timeout RETURNS `status: "tooling_error"`; it does not throw (AU72).
 *
 * It used to throw, and that is the defect this fixes. prep run
 * `pubsub-21224757585884749` (instagram-agent, thepitchbydeel, 2026-09-18)
 * designed five of six studio templates successfully and then lost the whole
 * run — $1.57 spent, no deliverable — because the sixth,
 * `00c4-design-template-quote_card`, crossed 600s while every `claude-sonnet-4-6`
 * turn in that window was 429-ing on Vertex and failing over to Anthropic.
 * The Instagram workflow ALREADY handles a failed designer turn: it drops
 * that one archetype, records the reason, and ships the rest ("Nothing here
 * may throw. Setup never blocks a run", `create-instagram-agent-workflow.ts`).
 * The throw walked straight past that handling and every other author's like
 * it, because an exception cannot be branched on by code that reads
 * `result.status`.
 *
 * So the timeout is now reported the way EVERY other agent failure in this
 * engine is reported: as a returned status. `BaseAgent` already reports a
 * dead tool, a schema violation and an unpriced model as `tooling_error`
 * rather than as an exception — a step that ran out of time is the same kind
 * of fact about the same call, and it is the workflow author's to act on
 * (RFC-01 §4). Callers already branching on `status !== "completed"` — which
 * is the convention across the fleet — pick this up with no change.
 *
 * The result is synthetic, and honest about it: `steps: []` and
 * `totalCostUsd: 0`, because the tokens the timed-out call was billing are
 * genuinely unknown to us (it is still running; we stopped waiting, and
 * `BaseAgent` does not consume the abort signal yet). Tool units metered
 * before the bound DO survive — `consumed` is mutated in place by
 * `runInToolUsageScope` — so generative media already paid for is still
 * counted rather than silently written off. The step record carries the
 * timeout message as its `error` and the span is marked failed, so an
 * absorbed timeout is loud in the trace and in the run report, never silent.
 *
 * Absorbing is capped per run at `MAX_ABSORBED_STEP_TIMEOUTS` — past that the
 * timeout throws as before. See that constant for why.
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
  options?: StepAgentOptions,
): Promise<AgentExecutionResult<TOutput>> {
  const stepId = scopedStepId(runtime, id);
  const existing = await runtime.store.getStep(runtime.runId, stepId);
  if (existing && isCheckpointedStepStatus(existing.status)) {
    return existing.output as AgentExecutionResult<TOutput>;
  }

  if (runtime.budget?.maxTotalCostUsd !== undefined) {
    const spentSoFar = await runCostSoFar(runtime);
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
    // Same reasoning, one level up: the client's stated content language is
    // read once per run (the store is only in hand at dispatch — Layer 2 has
    // no I/O of its own), and every agent step in the engine is constructed
    // here, so this is the one place it has to be attached for all of them.
    ...(runtime.contentLanguage !== undefined ? { contentLanguage: runtime.contentLanguage } : {}),
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
    async (span, markOutcome) => {
      const startedAt = runtime.now();
      await markStepRunning(runtime, stepId, "agent", startedAt);
      // Precedence: the RUN-level override outranks the per-call one, which
      // outranks the default. That order is deliberate and it is the less
      // obvious of the two.
      //
      // `options.timeoutMs` is a statement about one step relative to the
      // DEFAULT ("this designer turn honestly needs longer than ten
      // minutes"). `runtime.agentStepTimeoutMs` is a statement by whoever
      // dispatched the run about the whole run, and it is set by exactly two
      // kinds of caller: an operator bounding a run, and a test. If the
      // per-call value won, a run-wide bound would silently not apply to the
      // steps most likely to hit it — the run's own setting would be a lie —
      // and no test could bound such a step at all without waiting out its
      // real timeout.
      const timeoutMs = runtime.agentStepTimeoutMs ?? options?.timeoutMs ?? DEFAULT_AGENT_STEP_TIMEOUT_MS;
      // Tools the agent calls inside its ReAct loop (image.generate,
      // video.visualQaGate, a self-critique gate that spends Gemini tokens)
      // bill per unit, and `result.totalCostUsd` only ever counted the
      // model's tokens — see `tool-usage-scope.ts`.
      const consumed: ToolUnitUsage[] = [];
      // The timeout is CAUGHT and converted, not propagated — see this
      // function's doc comment. `timedOut` is what makes the difference
      // visible downstream: the synthetic result carries no turn telemetry, so
      // `describeAgentOutcome` alone would record the useless
      // `agent step resolved to "tooling_error"` in place of the one fact a
      // reader needs, which is that it ran out of time and after how long.
      let timedOut: WorkflowStepTimeout | undefined;
      const result = await runInToolUsageScope(consumed, () => withStepTimeout(agent.run(ctx, input), stepId, timeoutMs, abortController)).catch(
        (error: unknown): AgentExecutionResult<TOutput> => {
          if (!(error instanceof WorkflowStepTimeout)) throw error;
          // Past the cap this is a systemic wedge, not one flaky step. Rethrow
          // BEFORE recording a checkpoint: `tooling_error` is a checkpointed
          // status, so a record written here would make the step replay as a
          // permanent failure on resume — the opposite of what a retry needs
          // once the provider recovers.
          // No counter threaded (a runtime built directly, which today means a
          // primitive-level unit test) means no run-level budget to spend, so
          // the timeout is absorbed. Fail-open toward delivering: `WorkflowEngine.run`
          // always provides one, so the cap is live everywhere it is load-bearing.
          const absorbed = (runtime.absorbedStepTimeouts?.count ?? 0) + 1;
          const cap = runtime.maxAbsorbedStepTimeouts ?? MAX_ABSORBED_STEP_TIMEOUTS;
          if (absorbed > cap) throw error;
          if (runtime.absorbedStepTimeouts !== undefined) runtime.absorbedStepTimeouts.count = absorbed;
          timedOut = error;
          return { finalOutput: null, steps: [], totalCostUsd: 0, totalTokens: { input: 0, output: 0 }, status: "tooling_error" };
        },
      );
      const toolCostUsd = computeToolCostUsd(consumed);
      const costUsd = Math.round((result.totalCostUsd + toolCostUsd) * 1_000_000) / 1_000_000;
      const completedAt = runtime.now();

      // AgentExecutionResult.totalTokens.input is already the cached+uncached sum
      // (RFC-01 §5.1) — recover the split from the per-turn telemetry for the span.
      const inputTokensCached = result.steps.reduce((sum, step) => sum + step.inputTokens.cached, 0);
      const inputTokensUncached = result.steps.reduce((sum, step) => sum + step.inputTokens.uncached, 0);
      // Already inside `uncached` for costing — the adapter folds it there at
      // the base rate and `computeStepCostUsd` adds the 1.25x premium — and
      // reported separately so the BI table can say what filling the cache
      // cost against what reading it saved.
      const inputTokensCacheWrite = result.steps.reduce((sum, step) => sum + (step.inputTokens.cacheWrite ?? 0), 0);
      // SCRUM-361 item 3, precondition 1. `servedBy` is per-TURN
      // (AgentStepTelemetry.servedBy, AU61/SCRUM-360) and is present only when
      // a turn was NOT primary-served. A step is attributed to the fallback if
      // ANY of its turns was — deliberately NOT the last-turn rule `model`
      // uses above — because the question the reconciliation asks is "was any
      // part of this cost billed by someone other than Google", and a single
      // Anthropic-served turn makes the answer yes. Among the fallback-served
      // turns the last one names the adapter, so a step that failed over twice
      // reports the vendor that actually finished the work.
      const fellOver = result.steps.filter((step) => step.servedBy !== undefined && step.servedBy.hop !== "primary");
      const servedBy = fellOver.at(-1)?.servedBy;
      recordCostAndTokens(span, {
        runId: runtime.runId,
        clientId: runtime.clientSlug,
        agentId: runtime.productId,
        // A ReAct loop can in principle route different turns to different
        // models (ModelRouter's choice) — the last turn's model is the most
        // representative single value for one BigQuery row per agent run.
        model: result.steps.at(-1)?.modelUsed ?? "unknown",
        costUsd,
        inputTokensCached,
        inputTokensUncached,
        ...(inputTokensCacheWrite > 0 ? { inputTokensCacheWrite } : {}),
        outputTokens: result.totalTokens.output,
        durationMs: completedAt - startedAt,
        status: result.status,
        // Discriminator columns (2026-08) — `runId` above is the WHOLE
        // workflow run's id, shared by every step.agent() call inside it, so
        // without `stepId` two rows from the same run can't be told apart.
        jobId: runtime.runId,
        stepId,
        operation: "workflow_step_agent",
        // Spread rather than `servedByHop: servedBy?.hop`: `exactOptionalPropertyTypes`
        // is on, and an explicit `undefined` is not the same as an absent key.
        ...(servedBy ? { servedByHop: servedBy.hop, servingAdapter: servedBy.adapter } : {}),
      });
      span.setAttribute("agent_status", result.status);
      recordWorkflowStepMetric({ stepKind: "agent", status: result.status });
      // AU42/SCRUM-326 — same fix as `runStepCode`'s, for the same reason.
      // `agent.run()` returning normally is not the same as the step
      // succeeding: AU68 (SCRUM-366, see this function's own doc comment)
      // made the checkpoint say what the agent actually reported, but the
      // SPAN still only went `ERROR` if something threw. An unpriced-model
      // turn (`assertModelPriced`, `packages/core/src/telemetry/pricing.ts`)
      // is exactly this shape: `BaseAgent.runOneTurn` catches it and returns a
      // `tooling_error` turn rather than throwing, so before this line the
      // resulting step span read `OK` — a pricing refusal that fails loudly
      // in the logs and in the checkpoint, and silently in the trace.
      //
      // `content_fail` and `budget_exceeded` deliberately stay `OK`-status:
      // per `stepStatusFromAgentStatus`'s own doc comment, neither is a
      // malfunction — `content_fail` is the agent's content verdict (a
      // revision-loop signal, Layer 1 makes zero content judgments per
      // RFC-01 §4) and `budget_exceeded` is a designed turn-ceiling stop, not
      // a broken call. Only `tooling_error` is an actual failure worth a
      // trace saying so.
      // An absorbed timeout is a real malfunction and gets a failed span like
      // any other `tooling_error` — absorbing it changes who DECIDES what
      // happens next, never whether it is reported.
      const outcomeError = timedOut?.message ?? describeAgentOutcome(result).error;
      if (result.status === "tooling_error") {
        markOutcome(true, outcomeError ?? `agent step resolved to "${result.status}"`);
      }

      const record: StepRecord = {
        stepId,
        kind: "agent",
        // AU68: the step now says what the agent actually reported. It still
        // RAN and its output is still replayable, so it stays checkpointed and
        // resume is unchanged — see `isCheckpointedStepStatus`.
        //
        // EXCEPT on an absorbed timeout (AU72), which records `failed` rather
        // than the `tooling_error` it hands the caller. The two are not the
        // same claim and the difference is the whole point:
        //
        //   - The RESULT is `tooling_error` because that is the vocabulary a
        //     workflow author branches on, and every `status !== "completed"`
        //     check in the fleet already reads it correctly.
        //   - The RECORD is `failed` because `failed` is the one status
        //     meaning "no output, nothing to replay" — and `failed` is not a
        //     checkpointed status (`isCheckpointedStepStatus`), so a later
        //     resume RE-ATTEMPTS this step instead of replaying a permanent
        //     failure.
        //
        // Recording `tooling_error` here would checkpoint it, and a run that
        // timed out once because Vertex was throttling would then carry that
        // step as dead forever, across every future resume. That is the exact
        // "an internal fault decides the outcome" failure this change exists
        // to remove, moved one layer down. The agent never reached a verdict;
        // we stopped waiting for one.
        status: timedOut !== undefined ? "failed" : stepStatusFromAgentStatus(result.status),
        output: result,
        costUsd,
        ...(consumed.length > 0 ? { unitUsage: consumed.map((u) => ({ ...u })) } : {}),
        durationMs: completedAt - startedAt,
        startedAt,
        completedAt,
        ...describeAgentOutcome(result),
        ...(outcomeError !== undefined ? { error: outcomeError } : {}),
      };
      await runtime.store.saveStep(runtime.runId, record);
      recordRunCost(runtime, record.costUsd ?? 0);
      return result;
    },
  );
}
