import type { AgentDefinitionStore, AgentToolRegistry, ModelPolicy, ModelRouter, PromptStore } from "@agent-engine/core";
import {
  DEDUPE_STEP_ID,
  DynamicAgent,
  GUARDRAIL_OUTPUT_FIELDS,
  GUARDRAIL_STEP_ID,
  GuardrailViolationError,
  buildGuardrailInput,
  buildGuardrailSystemPrompt,
  buildOutputSchema,
  evaluateDedupe,
  isCodeStage,
  readForbiddenTopics,
  toVerdict,
  type AgentDefinition,
  type AgentDefinitionCodeStage,
  type DedupeHistoryEntry,
  type GuardrailOutput,
  type GuardrailVerification,
} from "@agent-engine/core";
import { runCodeStep } from "@agent-engine/dynamic-sandbox";
import { WorkflowContentFailure, WorkflowToolingFailure, runTopicGuardrail, type WorkflowContext } from "@agent-engine/workflow";
import { buildWorkflowForProduct, isKnownProductId, type AgentRuntimeDeps, type WorkflowFn } from "./workflows.js";

/**
 * Builds a runnable workflow from a stored `AgentDefinition` (Task 2) —
 * proof that `WorkflowEngine` has no static, build-time coupling to any
 * specific product: every one of the 12 hand-written workflows is a
 * closure baked into its own npm package; this closure is built at
 * dispatch time instead, from Firestore data, and is otherwise identical
 * to them from `WorkflowEngine.run()`'s point of view.
 *
 * Stages run strictly in array order (RFC "Task 2" / Studio's own
 * `dependsOn`-must-be-empty convention).
 *
 * Each stage receives `{ runInput, previousOutput }`. Two named fields rather
 * than one merged object, for two reasons: the first stage used to receive
 * `{}`, so whatever a person typed into the run dialog never reached the agent
 * at all — an agent with an input schema was answering a question it could not
 * see; and merging the run's input into a later stage's input would let a
 * stage output key silently shadow a form field of the same name.
 *
 * `previousOutput` is null for the first stage, which is the honest encoding
 * of "nothing ran before this" — an empty object would be indistinguishable
 * from a stage that returned nothing.
 *
 * A stage whose `AgentExecutionResult.status` isn't `"completed"` resolves
 * the whole run to `failed` (content_fail) or `degraded` (tooling_error/
 * budget_exceeded) — the same rule every hand-written workflow in this
 * codebase already follows after inspecting a `step.agent` result (RFC-01
 * §4: Layer 1 makes zero content judgments itself, but the *workflow
 * author* — here, this generic builder, standing in for one — always must).
 */
export function buildDynamicWorkflow(definition: AgentDefinition, deps: { tools: AgentToolRegistry; promptStore: PromptStore; router: ModelRouter }): WorkflowFn {
  return async (wf: WorkflowContext): Promise<Record<string, unknown>> => {
    const results: Record<string, unknown> = {};
    let previousOutput: unknown = null;

    for (const stage of definition.stages) {
      if (isCodeStage(stage)) {
        previousOutput = await runStageCode(wf, stage, definition, previousOutput);
        results[stage.id] = previousOutput;
        continue;
      }

      const modelPolicy: ModelPolicy = stage.modelPolicy ?? definition.defaultModelPolicy;
      const outputSchema = buildOutputSchema(stage.outputSchema);
      const agent = new DynamicAgent(
        { tools: deps.tools, router: deps.router, promptStore: deps.promptStore },
        {
          id: stage.id,
          description: stage.description,
          allowedTools: stage.allowedTools,
          outputSchema,
          modelPolicy,
          ...(stage.maxSteps !== undefined ? { maxSteps: stage.maxSteps } : {}),
        },
        stage.systemPrompt,
      );

      const execResult = await wf.step.agent(stage.id, agent, {
        runInput: wf.input,
        previousOutput,
      });

      if (execResult.status === "content_fail") {
        throw new WorkflowContentFailure(`stage "${stage.id}" (${definition.agentId}) failed content validation`);
      }
      if (execResult.status === "tooling_error" || execResult.status === "budget_exceeded") {
        throw new WorkflowToolingFailure(`stage "${stage.id}" (${definition.agentId}) resolved to "${execResult.status}"`);
      }

      results[stage.id] = execResult.finalOutput;
      previousOutput = execResult.finalOutput;
    }

    // ── terminal: topic guardrail ──
    //
    // Appended here, never read from `definition.stages`. That is the whole
    // point: a check an admin can delete from a spec with a bin icon is a
    // convention, not a guarantee, so no Studio edit can reach it and no
    // definition can opt out.
    // Throws GuardrailViolationError on a violation, which fails the run: the
    // artifact pipeline is gated on a completed run, so a blocked one produces
    // no client-visible asset and the caller refunds it like any other failure.
    const verification = await runTopicGuardrail(wf, deps, deliverableText(results));
    if (verification) results[GUARDRAIL_STEP_ID] = verification;

    // ── terminal: output de-duplication ──
    //
    // Appended after the guardrail and outside `definition.stages` for the same
    // reason, but with the opposite consequence: this one never fails a run. It
    // also runs only when the definition opted in, and it runs AFTER the
    // guardrail so a blocked deliverable is never recorded as a precedent for
    // the next one.
    if (definition.dedupeAgainstHistory) {
      results[DEDUPE_STEP_ID] = await checkAndRecordDedupe(wf, deps, definition, deliverableText(results));
    }

    return results;
  };
}

/**
 * Runs one code stage out-of-process.
 *
 * The flag is checked here, at the moment of execution, and a code stage under
 * a disabled flag is a tooling failure rather than a skip. Skipping would
 * produce a deliverable missing a transform the author declared, and nothing
 * downstream would know a step was dropped.
 *
 * The script sees `{ runInput, previousOutput }` — exactly what an AI stage
 * sees, serialized onto its stdin. It has no tools, no registry, and no
 * client-config access, so a code stage cannot reach anything an AI stage in
 * the same definition could not.
 */
async function runStageCode(
  wf: WorkflowContext,
  stage: AgentDefinitionCodeStage,
  definition: AgentDefinition,
  previousOutput: unknown,
): Promise<Record<string, unknown>> {
  // Everything that can fail this stage happens INSIDE the `wf.step.code`
  // callback, so a failure is recorded against the stage itself. Checking the
  // result afterwards instead would checkpoint a broken script as a completed
  // step and then fail the run around it — a green step inside a failed run,
  // which is exactly the wrong thing to hand someone debugging it.
  //
  // The callback is this repo's own trusted code; the authored script inside
  // it runs in a separate process, which is the distinction that matters. Its
  // return value is checkpointed, so a resumed run replays the result rather
  // than executing the script a second time.
  const checkpoint = await wf.step.code(stage.id, async () => {
    // Inside the step for the same reason as everything else here: a refused
    // stage should be visible AS a failed stage, not as a run that died with
    // no indication of which stage caused it.
    if (!codeStepsEnabled()) {
      throw new WorkflowToolingFailure(
        `stage "${stage.id}" (${definition.agentId}) is a code step, and DYNAMIC_CODE_STEPS_ENABLED is not set on this deployment`,
      );
    }

    const result = await runCodeStep({
      language: stage.language,
      code: stage.code,
      context: { runInput: wf.input, previousOutput },
      ...(stage.timeoutMs !== undefined ? { timeoutMs: stage.timeoutMs } : {}),
    });

    if (!result.ok) {
      // A script that threw, timed out, or printed something that is not a
      // JSON object. Tooling rather than content: the step did not run to
      // completion, so there is no output to judge.
      // `error` is the sandbox's own verdict ("exited with code 1"); the
      // script's actual exception is in `stderr`. Both, because the first
      // without the second is not something anyone can debug from.
      const detail = [result.error ?? "no detail", result.stderr?.trim()].filter(Boolean).join(" — ");
      throw new WorkflowToolingFailure(
        `stage "${stage.id}" (${definition.agentId}) ${result.timedOut ? "timed out" : "failed"}: ${detail}`,
      );
    }

    const output = result.output as Record<string, unknown>;
    if (!stage.outputSchema) return result;

    // Declared, so enforced — the same content judgment an AI stage's schema
    // gets, for the same reason: a next stage reading a field that isn't there
    // fails further from the cause.
    const parsed = buildOutputSchema(stage.outputSchema).safeParse(output);
    if (!parsed.success) {
      throw new WorkflowContentFailure(
        `stage "${stage.id}" (${definition.agentId}) returned output that does not match its declared schema: ${parsed.error.message}`,
      );
    }
    // The validated value replaces the raw one, so defaults land in the
    // checkpoint too and a resumed run sees what the first attempt saw. The
    // rest of the record -- `tier`, `stderr` -- is kept as the audit trail of
    // how this step actually ran.
    return { ...result, output: parsed.data };
  });

  return checkpoint.output as Record<string, unknown>;
}

/** `DYNAMIC_CODE_STEPS_ENABLED`, read at call time so a test can set it per-case. */
function codeStepsEnabled(): boolean {
  const raw = process.env.DYNAMIC_CODE_STEPS_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * Scores this run's deliverable against the agent's recent output for this
 * client, then records the deliverable so the next run has it.
 *
 * The whole thing is one `wf.step.code`, and that is deliberate: its
 * checkpointed output IS the verdict, which is what puts it in the run's step
 * list and therefore in front of a person. A verdict returned only into the
 * workflow's result object would be computed, discarded, and useless — and
 * "a signal for a human to weigh" that no human can see is not a signal.
 *
 * Nothing inside throws. A missing tool or an unreadable history yields an
 * `error` verdict, because a run whose deliverable is fine must not die over a
 * similarity score — but the failure is recorded rather than swallowed, so it
 * is visible that the check did not actually run.
 */
async function checkAndRecordDedupe(
  wf: WorkflowContext,
  deps: { tools: AgentToolRegistry },
  definition: AgentDefinition,
  deliverable: string,
): Promise<unknown> {
  return wf.step.code(DEDUPE_STEP_ID, async () => {
    const ctx = { runId: wf.runId, clientSlug: wf.clientSlug, productId: wf.productId, runKind: wf.runKind, metadata: {} };
    const list = deps.tools["ledger.listOutputExcerpts"];
    const record = deps.tools["ledger.recordOutputExcerpt"];
    if (!list || !record) {
      return { status: "error", error: "ledger output-history tools are not registered on this deployment" };
    }

    // `excludeRunId` matters on resume: without it a run that already recorded
    // its excerpt before a gate would come back and score 1.0 against itself.
    const listed = await list.execute({ agentId: definition.agentId, excludeRunId: wf.runId }, { ctx });
    if (listed.status !== "success") {
      return { status: "error", error: "could not read this agent's output history" };
    }

    const entries = (listed.result as { entries?: DedupeHistoryEntry[] }).entries ?? [];
    const verdict = evaluateDedupe(deliverable, entries);

    // Recorded after scoring, never before — otherwise this run is in its own
    // comparison set. The result is deliberately not checked: failing to store
    // an excerpt costs the NEXT run some history, which is not a reason to
    // change this run's verdict.
    await record.execute({ agentId: definition.agentId, runId: wf.runId, excerpt: deliverable }, { ctx });

    return verdict;
  });
}

/** The deliverable the guardrail judges: the last stage's output, as text. */
function deliverableText(results: Record<string, unknown>): string {
  const values = Object.values(results);
  const last = values[values.length - 1];
  if (typeof last === "string") return last;
  return JSON.stringify(last ?? {}, null, 2);
}

/**
 * Thrown by `resolveWorkflowFn` when `productId` matches neither a fixed
 * product nor a registered dynamic agent — a distinct class (not a bare
 * `Error`) so `startRunJob` can report it as a client error (bad/unknown
 * product id — HTTP 400 at `/runs/start`) rather than folding it into the
 * generic `"error"` outcome (HTTP 500), which is reserved for an
 * unexpected failure actually running the workflow.
 */
export class UnknownProductError extends Error {
  constructor(productId: string, reason: string) {
    super(`"${productId}" ${reason}`);
    this.name = "UnknownProductError";
  }
}

/**
 * Resolves a `productId` string to a runnable workflow, checking the 12
 * hand-written products first (`KNOWN_PRODUCT_IDS`) and falling back to a
 * dynamic agent definition (Task 2) when it isn't one of those — the one
 * place `startRunJob` (and therefore every entry point: `/runs/start`, the
 * Pub/Sub push route, the pull consumer) learns whether a request names a
 * fixed or a dynamic agent. Throws `UnknownProductError` (never returns
 * `undefined`) on no match, so a caller with a typo'd or unregistered id
 * gets a specific, actionable error instead of a silently-empty run.
 */
export async function resolveWorkflowFn(productId: string, deps: AgentRuntimeDeps, agentDefinitionStore?: AgentDefinitionStore): Promise<WorkflowFn> {
  if (isKnownProductId(productId)) {
    return buildWorkflowForProduct(productId, deps);
  }
  if (!agentDefinitionStore) {
    throw new UnknownProductError(productId, "is not one of the fixed products, and no AgentDefinitionStore is configured to look up a dynamic agent");
  }
  const definition = await agentDefinitionStore.get(productId);
  if (!definition) {
    throw new UnknownProductError(productId, `is neither a known product id nor a registered dynamic agent (no agentDefinitions/${productId} doc)`);
  }
  return buildDynamicWorkflow(definition, deps);
}
