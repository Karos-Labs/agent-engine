/**
 * Reading the cancellation the workflow engine hands a step.
 *
 * `step.agent` races the agent against a timeout and, when the timer wins,
 * aborts an `AbortController` whose signal it put on
 * `AgentContext.metadata` — then stops waiting and records the step as a
 * `tooling_error`. Until 2026-09-22 nothing read that signal, which the
 * workflow package said so plainly in its own doc comments: "the cancellation
 * is now PROPAGATED, not yet CONSUMED". The agent kept going — more
 * turns, more model calls, more tool purchases — producing a result that
 * by construction nobody would ever look at. On an instagram or tiktok step
 * that is images and footage bought for a step that has already been written
 * off.
 *
 * The key lives HERE, in core, rather than in the workflow package that writes
 * it, because the reader and the writer must agree on one string and a
 * duplicated literal is a drift waiting to happen. `@agent-engine/workflow`
 * depends on core, so it re-exports this constant; core cannot depend on
 * workflow.
 */
export const ABORT_SIGNAL_METADATA_KEY = "abortSignal";

/**
 * The step's abort signal, if it is running inside one.
 *
 * `undefined` rather than a never-firing stand-in, for the same reason
 * `stepAbortSignal` gives: a dummy signal lets a consumer look wired up while
 * being unable to fire.
 */
export function agentAbortSignal(ctx: { metadata: Record<string, unknown> }): AbortSignal | undefined {
  const candidate = ctx.metadata[ABORT_SIGNAL_METADATA_KEY];
  return candidate instanceof AbortSignal ? candidate : undefined;
}

/**
 * Why this step was cancelled, or `undefined` while it is still wanted.
 *
 * The reason the engine aborts with is the `WorkflowStepTimeout` itself, so
 * the message names the step and its bound — worth carrying into the
 * transcript and the telemetry instead of a bare "aborted", because the two
 * cases a reader has to tell apart are "this agent was stopped" and "this
 * agent failed", and only the reason distinguishes them.
 */
export function agentAbortReason(ctx: { metadata: Record<string, unknown> }): string | undefined {
  const signal = agentAbortSignal(ctx);
  if (signal === undefined || !signal.aborted) return undefined;
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason.message;
  return typeof reason === "string" && reason.length > 0 ? reason : "the step was cancelled";
}
