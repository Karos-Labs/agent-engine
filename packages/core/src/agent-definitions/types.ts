import { z } from "zod";
import { ModelPolicySchema } from "../types/model-policy.js";

/**
 * A dynamic agent's output schema, in the deliberately small DSL this
 * module supports (flat named fields, primitive types) rather than
 * arbitrary JSON Schema. `BaseAgent.config.outputSchema` needs a real Zod
 * schema (RFC-01 §5.1) — translating arbitrary JSON Schema into Zod at
 * runtime is a real, separate piece of engineering (correctly handling
 * unions, refs, formats, nested objects) this module does not attempt.
 * This flat DSL covers what a Studio-authored stage plausibly needs
 * (structured facts back from a model turn) without that scope; extending
 * it to nested objects/arrays-of-objects is a natural, additive next step
 * if a real stage needs one.
 */
export const AgentDefinitionFieldSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "field name must be a valid identifier"),
  type: z.enum(["string", "number", "boolean", "string[]"]),
  description: z.string().optional(),
  optional: z.boolean().default(false),
});
export type AgentDefinitionField = z.infer<typeof AgentDefinitionFieldSchema>;

/** Builds the real Zod object schema `AgentStepConfig.outputSchema` needs from a stage's stored field list. */
export function buildOutputSchema(fields: readonly AgentDefinitionField[]): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    let base: z.ZodTypeAny;
    switch (field.type) {
      case "string":
        base = z.string();
        break;
      case "number":
        base = z.number();
        break;
      case "boolean":
        base = z.boolean();
        break;
      case "string[]":
        base = z.array(z.string());
        break;
    }
    if (field.description) base = base.describe(field.description);
    shape[field.name] = field.optional ? base.optional() : base;
  }
  return z.object(shape);
}

/**
 * One stage of a dynamic agent — one `BaseAgent` ReAct loop (RFC-01 §5.3),
 * executed via `wf.step.agent` inside the generated workflow
 * (`build-dynamic-workflow.ts`). Stages run strictly in array order, each
 * one's `finalOutput` becoming the next stage's `input` — the same
 * sequential-only model Studio's own `DynamicAgentStepDef` already commits
 * to today (its `dependsOn` field is reserved but rejected if non-empty).
 */
export const AgentDefinitionStageSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "stage id must be lowercase-and-hyphens"),
  description: z.string().min(1),
  /** This stage's own system prompt — stored inline, not resolved via `skillRef`/`PromptStore` (see `DynamicAgent`'s own doc comment for why). */
  systemPrompt: z.string().optional(),
  /** Tool names this stage's ReAct loop may call — must already be registered in the server's live `AgentToolRegistry`; naming an unregistered tool is a run-time `tooling_error` on first use, not a definition-time error (mirrors every hand-written agent's own `allowedTools` contract). */
  allowedTools: z.array(z.string().min(1)).default([]),
  outputSchema: z.array(AgentDefinitionFieldSchema).min(1),
  /** Overrides `AgentDefinition.defaultModelPolicy` for just this stage. */
  modelPolicy: ModelPolicySchema.optional(),
  maxSteps: z.number().int().positive().optional(),
});
export type AgentDefinitionStage = z.infer<typeof AgentDefinitionStageSchema>;

/**
 * A dynamic agent's full stored definition (Task 2) — `agentId` is also the
 * `productId` used to dispatch it once registered (see
 * `apps/agent-server/src/wiring/dynamic-workflows.ts`), so it's validated
 * against the same charset every other product id in this codebase uses.
 */
export const AgentDefinitionSchema = z.object({
  agentId: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "agentId must be lowercase-and-hyphens"),
  name: z.string().min(1),
  description: z.string().min(1),
  defaultModelPolicy: ModelPolicySchema,
  stages: z.array(AgentDefinitionStageSchema).min(1),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Bumped by the store on every successful update — the one "version" concept this module has, matching `DynamicAgentSpec.version`'s own whole-spec-integer convention rather than a per-field history. */
  version: z.number().int().positive(),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/** What a caller supplies to create/update a definition — the store stamps `createdAt`/`updatedAt`/`version`. */
export const AgentDefinitionInputSchema = AgentDefinitionSchema.omit({ createdAt: true, updatedAt: true, version: true });
export type AgentDefinitionInput = z.infer<typeof AgentDefinitionInputSchema>;
