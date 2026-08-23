import type { AgentDefinitionStore, AgentToolRegistry, ModelPolicy, ModelRouter, PromptStore } from "@agent-engine/core";
import {
  DynamicAgent,
  GUARDRAIL_OUTPUT_FIELDS,
  GUARDRAIL_STEP_ID,
  GuardrailViolationError,
  buildGuardrailInput,
  buildGuardrailSystemPrompt,
  buildOutputSchema,
  readForbiddenTopics,
  toVerdict,
  type AgentDefinition,
  type GuardrailOutput,
  type GuardrailVerification,
} from "@agent-engine/core";
import { WorkflowContentFailure, WorkflowToolingFailure, type WorkflowContext } from "@agent-engine/workflow";
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
    const verification = await verifyGuardrails(wf, deps, results);
    if (verification) {
      results[GUARDRAIL_STEP_ID] = verification;
      if (verification.status === "violation") {
        // Fails the run. The artifact pipeline is gated on a completed run, so
        // a blocked one produces no client-visible asset, and the caller
        // refunds it like any other failure. Deliberately not `held`, which
        // means "nothing honestly cleared the gates" — a legitimate empty
        // result a human might publish anyway. This output exists and must
        // not ship.
        throw new GuardrailViolationError(verification);
      }
    }

    return results;
  };
}

/** The deliverable the guardrail judges: the last stage's output, as text. */
function deliverableText(results: Record<string, unknown>): string {
  const values = Object.values(results);
  const last = values[values.length - 1];
  if (typeof last === "string") return last;
  return JSON.stringify(last ?? {}, null, 2);
}

/**
 * Runs the verifier, or returns `undefined` when there is nothing to verify.
 *
 * `undefined` means the client forbids no topics — a real and common state,
 * not a misconfiguration. A `status: "error"` result is returned rather than
 * thrown: a verifier that could not do its job must not block good output,
 * but the failure is recorded so a human can see the check did not run.
 */
async function verifyGuardrails(
  wf: WorkflowContext,
  deps: { tools: AgentToolRegistry; promptStore: PromptStore; router: ModelRouter },
  results: Record<string, unknown>,
): Promise<GuardrailVerification | undefined> {
  const ctx = {
    runId: wf.runId,
    clientSlug: wf.clientSlug,
    productId: wf.productId,
    runKind: wf.runKind,
    metadata: {},
  };

  // From the client's own stored configuration, not the job payload: a
  // payload-supplied topic list is one a caller can omit.
  const configTool = deps.tools["client.getConfig"];
  if (!configTool) return undefined;
  const configOutcome = await wf.step.code(`${GUARDRAIL_STEP_ID}-load-topics`, async () =>
    configTool.execute({}, { ctx }),
  );
  const forbiddenTopics =
    configOutcome.status === "success" ? readForbiddenTopics(configOutcome.result) : [];
  if (forbiddenTopics.length === 0) return undefined;

  const verifier = new DynamicAgent(
    { tools: deps.tools, router: deps.router, promptStore: deps.promptStore },
    {
      id: GUARDRAIL_STEP_ID,
      description: "Check the finished draft against the topics this client does not engage with.",
      // No tools: this is a judgment over text already in hand, and a verifier
      // that can call tools is a verifier that can be steered.
      allowedTools: [],
      outputSchema: buildOutputSchema([...GUARDRAIL_OUTPUT_FIELDS]),
      // "commodity" is this codebase's own tier for "embeddings,
      // classification, dedupe" (model-policy.ts), which is exactly what
      // checking a draft against a fixed list is. It also keeps the cost of
      // having guardrails on at all close to nothing.
      modelPolicy: { policy: "commodity", model: "claude-haiku-4-5-20251001" },
      maxSteps: 1,
    },
    buildGuardrailSystemPrompt(forbiddenTopics),
  );

  const exec = await wf.step.agent(
    GUARDRAIL_STEP_ID,
    verifier,
    buildGuardrailInput(deliverableText(results)),
  );

  if (exec.status !== "completed" || !exec.finalOutput) {
    return {
      status: "error",
      violatedTopics: [],
      error: `guardrail verification did not complete (${exec.status})`,
    };
  }
  return toVerdict(exec.finalOutput as GuardrailOutput, forbiddenTopics);
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
