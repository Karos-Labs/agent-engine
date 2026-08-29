import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { WorkflowToolingFailure } from "./signals.js";
import type { WorkflowContext } from "./context.js";

/**
 * The persist-triple every agent workflow performs once it has a finished,
 * approved deliverable (RFC-01 §8.2): write the deliverable to the ledger,
 * snapshot it onto the run's dashboard manifest, and — best-effort, via
 * {@link recordOutputExcerpt} — record an excerpt for future anti-repetition
 * dedup.
 *
 * Lifted out of the eight per-agent workflow files that each hand-rolled the
 * first two of those three steps byte-for-byte (AU16 / SCRUM-300) — "did this
 * agent record its output excerpt" was previously something you checked by
 * reading eight workflows; now it is "does this call site also call
 * `recordOutputExcerpt`".
 *
 * Preserves the exact two-step checkpoint shape every caller already had:
 * `persistDeliverableStepId` and `persistManifestStepId` are the same
 * `step.code` ids the pre-refactor code used at each call site, so a run
 * resuming across this change lands on identical checkpoints (see the
 * `resume-idempotency` suites' exact `stepRecords` length assertions). The
 * output-excerpt call is deliberately NOT folded in here and not given its own
 * step — none of the eight callers isolated it either; it happens inside
 * their broader "commit-and-record" step alongside `memory.appendDecision`
 * and similar. Call `recordOutputExcerpt` there directly, same as before.
 */
export async function finalizeDeliverable(
  wf: WorkflowContext,
  tools: AgentToolRegistry,
  ctx: AgentContext,
  opts: {
    /** The `step.code` id the pre-refactor "persist deliverable" step used. */
    persistDeliverableStepId: string;
    /** The `step.code` id the pre-refactor "persist manifest" step used. */
    persistManifestStepId: string;
    /** `ledger.writeDeliverable`'s `kind` discriminator for this agent. */
    kind: string;
    /** The deliverable payload, when building it has no side effects worth deferring. Mutually exclusive with `buildDeliverable`. */
    deliverable?: unknown;
    /**
     * Builds the deliverable payload instead of passing it directly. Use this
     * when building it does something non-repeatable — e.g. stamping
     * `new Date()` — that must happen exactly once, on the run that actually
     * persists it: this only ever runs inside this step's own `step.code`
     * callback, so — like the rest of the step — it is skipped entirely on
     * resume, exactly as it was before this was lifted out of the call site.
     */
    buildDeliverable?: () => unknown | Promise<unknown>;
    /** Built from the resolved `deliverableId` — most callers fold it into their own snapshot shape. */
    snapshot: (deliverableId: string) => Record<string, unknown>;
  },
): Promise<string> {
  const deliverableId = await wf.step.code(opts.persistDeliverableStepId, async (): Promise<string> => {
    const deliverable = opts.buildDeliverable ? await opts.buildDeliverable() : opts.deliverable;
    const outcome = await tools["ledger.writeDeliverable"]!.execute({ runId: wf.runId, kind: opts.kind, deliverable }, { ctx });
    if (outcome.status !== "success") throw new WorkflowToolingFailure(`ledger.writeDeliverable failed: ${outcome.status}`);
    return (outcome.result as { id: string }).id;
  });

  await wf.step.code(opts.persistManifestStepId, async () => {
    await tools["ledger.dashboardSnapshot"]!.execute({ runId: wf.runId, snapshot: opts.snapshot(deliverableId) }, { ctx });
  });

  return deliverableId;
}

/**
 * The best-effort third leg of the persist-triple: recording an output
 * excerpt for the anti-repetition dedup window. Never isolated in its own
 * `step.code` by any caller — losing an excerpt costs future dedup signal,
 * never the already-delivered output, so a failure here is logged and
 * swallowed rather than thrown or checkpointed.
 */
export async function recordOutputExcerpt(tools: AgentToolRegistry, ctx: AgentContext, runId: string, agentId: string, excerpt: string): Promise<void> {
  try {
    await tools["ledger.recordOutputExcerpt"]?.execute({ agentId, runId, excerpt }, { ctx });
  } catch (error) {
    console.error("recordOutputExcerpt: could not record the output excerpt for future dedup", error);
  }
}
