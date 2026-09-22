import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who a log line or a model-call span belongs to.
 *
 * Every field is optional because a scope can be entered in layers — the run
 * span sets the run's identity, the step span adds the step, a tool span adds
 * the tool — and because code that runs outside any workflow (a script, a
 * one-off agent invocation, a unit test) has no identity to report and must
 * still be able to log.
 */
export interface LogScopeFields {
  runId?: string;
  clientSlug?: string;
  productId?: string;
  runKind?: string;
  stepId?: string;
  slotId?: string;
  toolName?: string;
}

const activeScope = new AsyncLocalStorage<LogScopeFields>();

/**
 * Runs `fn` with `fields` folded into the ambient log scope, so that every
 * `logWarning`/`logError`/`logInfo` inside it — at any depth, across any
 * number of `await`s — carries them without the call site naming them.
 *
 * `AsyncLocalStorage` rather than a threaded parameter for the same reason
 * `runInToolUsageScope` is one: the lines that need the identity are the ones
 * furthest from it. The model failover warning is emitted by a
 * `ResilientClaudeAdapter` that is constructed once at process start and
 * shared by every client, several frames below `ModelRouter.complete()`, which
 * itself is handed a prompt and a policy and is told nothing about which run
 * it is serving. Threading `runId` down to it would mean widening
 * `RouterCompleteOptions`, `CompletionRequest` and every one of the adapters
 * that implements it — for a field none of them uses for anything but a log.
 *
 * Why it matters: before this, a `model.failover` warning said which model
 * hopped and to where, and nothing about WHOSE work it was. "Claude on Vertex
 * has zero quota, every run silently fails over" and "one client's run hit a
 * 429 once" produce the same log line, and the second cannot be told from the
 * first without a run id to group by. The same was true of the pricing
 * warnings (an unpriced model) and the large-context routing warning.
 *
 * Nested calls MERGE rather than replace, outermost first, so a step scope
 * entered inside a run scope keeps the run's fields.
 */
export function withLogScope<T>(fields: LogScopeFields, fn: () => T): T {
  const merged: LogScopeFields = { ...activeScope.getStore(), ...fields };
  return activeScope.run(merged, fn);
}

/** The ambient log scope, or `{}` outside any. */
export function currentLogScope(): LogScopeFields {
  return activeScope.getStore() ?? {};
}
