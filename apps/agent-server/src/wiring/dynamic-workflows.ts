import type { AgentDefinitionStore, AgentToolRegistry, ModelPolicy, ModelRouter, PromptStore } from "@agent-engine/core";
import { DynamicAgent, buildOutputSchema, type AgentDefinition } from "@agent-engine/core";
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
 * `dependsOn`-must-be-empty convention) — each stage's `finalOutput`
 * becomes the next stage's `input`, so a later stage can build on an
 * earlier one's structured result without a fan-out/DAG scheduler.
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
    let input: unknown = {};

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

      const execResult = await wf.step.agent(stage.id, agent, input);

      if (execResult.status === "content_fail") {
        throw new WorkflowContentFailure(`stage "${stage.id}" (${definition.agentId}) failed content validation`);
      }
      if (execResult.status === "tooling_error" || execResult.status === "budget_exceeded") {
        throw new WorkflowToolingFailure(`stage "${stage.id}" (${definition.agentId}) resolved to "${execResult.status}"`);
      }

      results[stage.id] = execResult.finalOutput;
      input = execResult.finalOutput;
    }

    return results;
  };
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
