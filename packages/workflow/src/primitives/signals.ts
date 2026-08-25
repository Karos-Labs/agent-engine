/**
 * "Throw to pause": a `step.gate` call with no response yet throws this,
 * unwinding the whole workflow function. `WorkflowEngine.run()` catches it
 * at the top and returns `awaiting_gate` — RFC-01 §8.1's "a multi-day wait
 * does not hold a process open" taken literally: the process really does
 * return, and resume is a fresh `run()` call later, after `resolveGate()`
 * has recorded a response. On resume, every earlier `step.code`/`step.agent`
 * call short-circuits via checkpoint, so replaying the function from the top
 * is cheap.
 */
export class AwaitingGateSignal extends Error {
  constructor(public readonly gateId: string) {
    super(`awaiting gate response for "${gateId}"`);
    this.name = "AwaitingGateSignal";
  }
}

/**
 * Thrown by workflow code (never by `step.agent` itself — Layer 1 makes zero
 * content judgments, RFC-01 §4) to explicitly resolve the run to `failed`
 * after inspecting a `step.agent` result's `content_fail` status. Accepts an
 * optional `cause` (RFC-01 §16.4) so the underlying error, if any, survives
 * into `WorkflowEngine`'s `describeError`-based reporting rather than being
 * dropped at the point this is thrown.
 */
export class WorkflowContentFailure extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkflowContentFailure";
  }
}

/**
 * Thrown by workflow code to explicitly resolve the run to `degraded` after
 * inspecting a `step.agent` result's `tooling_error`/`budget_exceeded`
 * status — RFC-01 §6: never recorded as a content verdict. Accepts an
 * optional `cause` (RFC-01 §16.4) for the same reason as `WorkflowContentFailure`.
 */
export class WorkflowToolingFailure extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkflowToolingFailure";
  }
}

/** A per-run dollar ceiling was hit before the next `step.agent` call — enforced before spend, not audited after (RFC-01 §8.1). */
export class WorkflowBudgetExceeded extends Error {
  constructor(
    public readonly runId: string,
    public readonly spentUsd: number,
    public readonly maxUsd: number,
  ) {
    super(`run "${runId}" budget ceiling exceeded: spent $${spentUsd.toFixed(6)} of a $${maxUsd.toFixed(6)} ceiling`);
    this.name = "WorkflowBudgetExceeded";
  }
}

/**
 * Thrown by workflow code when the pipeline ran cleanly to completion but
 * nothing honestly cleared its content gates — RFC-01 §16.2 / RFC-02 §3's
 * `held` outcome. This is a legitimate, non-failure empty result: resolves
 * the run to `held`, never `failed` — conflating the two is exactly the
 * misclassification this outcome exists to prevent.
 */
export class WorkflowHeld extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options);
    this.name = "WorkflowHeld";
  }
}

/**
 * Thrown by workflow code when the client hasn't supplied required intake
 * yet — RFC-01 §16.2 / RFC-02 §3's `blocked_intake` outcome. A client-side
 * gap, not an agent fault: resolves the run to `blocked_intake`, never
 * `failed`/`degraded`.
 */
export class WorkflowBlockedIntake extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options);
    this.name = "WorkflowBlockedIntake";
  }
}

/**
 * Thrown by `WorkflowEngine.run()` itself (never by workflow code) when a
 * resume attempt loses the optimistic-concurrency claim on an existing run —
 * its current status wasn't one of the statuses a resume is valid from (most
 * commonly: two near-simultaneous resumes of the same `awaiting_gate` run,
 * or a resume attempted while the run is still actively `running`). Callers
 * at the HTTP boundary should map this to `409 Conflict`, not `500` — this
 * is a legitimate, expected race outcome, not an unexpected server error.
 */
export class WorkflowConcurrentRunError extends Error {
  constructor(
    public readonly runId: string,
    public readonly actualStatus: string,
    public readonly allowedFromStatuses: readonly string[],
  ) {
    super(
      `run "${runId}" could not be claimed for this call: its current status is "${actualStatus}", ` +
        `not one of [${allowedFromStatuses.join(", ")}] — another writer is already handling it`,
    );
    this.name = "WorkflowConcurrentRunError";
  }
}

/**
 * Thrown by `runStepAgent` itself when `agent.run()` does not settle within
 * `WorkflowRuntime.agentStepTimeoutMs` (default `DEFAULT_AGENT_STEP_TIMEOUT_MS`).
 *
 * Before this existed, a slow or wedged model call left the step's
 * checkpoint at `"running"` forever and, because nothing ever threw, the
 * *run* itself never left `"running"` either — `RESUMABLE_FROM_STATUSES`
 * deliberately excludes `"running"` (it can't tell a genuine hang from a
 * concurrent call), so nothing could even resume it. prep run
 * `pubsub-21543515035218714` sat wedged in exactly this state at
 * `06c-vet-scrape-attempt-2` for hours.
 *
 * Uncaught here on purpose: it reaches `WorkflowEngine.run()`'s generic
 * catch-all exactly like any other tooling failure and resolves the run to
 * `degraded` — which *is* resumable, so a retry can actually happen instead
 * of requiring someone to notice and hand-fix the Firestore doc. The
 * agent call itself is not cancelled (there is no cooperative cancellation
 * path through a ReAct loop's tool calls), so this bounds how long a run can
 * be wedged rather than freeing whatever resource the hung call was using.
 */
export class WorkflowStepTimeout extends Error {
  constructor(
    public readonly stepId: string,
    public readonly timeoutMs: number,
  ) {
    super(`step "${stepId}" did not complete within ${timeoutMs}ms — treating it as a tooling failure rather than waiting indefinitely`);
    this.name = "WorkflowStepTimeout";
  }
}

/**
 * Thrown by `WorkflowEngine.resolveGate` when the target gate already
 * carries a response — a human decision's audit trail must never be
 * silently overwritten by a second resolve (a reliability audit finding).
 * Callers at the HTTP boundary should map this to `409 Conflict`.
 */
export class GateAlreadyResolvedError extends Error {
  constructor(
    public readonly runId: string,
    public readonly gateId: string,
    public readonly existingDecision: string,
  ) {
    super(`gate "${gateId}" on run "${runId}" was already resolved (decision: "${existingDecision}") — a resolved gate cannot be resolved again`);
    this.name = "GateAlreadyResolvedError";
  }
}
