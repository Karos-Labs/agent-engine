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
 * A stage of a dynamic agent, of either kind, is identified the same way — the
 * id is namespaced into the run's checkpoint keys, so it uses the same charset
 * every other id in this codebase does.
 *
 * Stages run strictly in array order, each one's output becoming the next
 * one's `previousOutput` — the same sequential-only model Studio's own
 * `DynamicAgentStepDef` commits to today (its `dependsOn` field is reserved
 * but rejected if non-empty).
 */
const StageIdSchema = z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "stage id must be lowercase-and-hyphens");

/**
 * An AI stage — one `BaseAgent` ReAct loop. The original and still the default:
 * a stored stage with no `kind` parses as this one, so every definition written
 * before code steps existed keeps working untouched.
 */
export const AgentDefinitionAiStageSchema = z.object({
  kind: z.literal("ai").default("ai"),
  id: StageIdSchema,
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
export type AgentDefinitionAiStage = z.infer<typeof AgentDefinitionAiStageSchema>;

/** Upper bound on an authored script, mirroring Studio's own `MAX_CODE_CHARS`. */
export const MAX_STAGE_CODE_CHARS = 20_000;

/**
 * A code stage — an admin-authored script, run out-of-process by
 * `@agent-engine/dynamic-sandbox` rather than by a model.
 *
 * It exists because a deterministic transform between two AI stages should be
 * deterministic. Reformatting a date, picking the top three of a list, or
 * reshaping one stage's output into the next stage's input are all things a
 * model does probabilistically and a five-line script does exactly, and paying
 * a model to do them buys variance rather than judgment.
 *
 * The script is untrusted input. It arrives from a Firestore document an admin
 * edited, so it is executed in a separate process behind a guard, never with
 * `wf.step.code` — that primitive runs trusted, compiled, in-repo workflow code
 * in this process, and handing an authored string to it would be handing it the
 * server. The whole capability stays behind `DYNAMIC_CODE_STEPS_ENABLED`
 * (default off) pending a security review of that sandbox; a definition
 * containing a code stage is refused at dispatch while the flag is off, rather
 * than silently skipping the stage and producing a deliverable that is missing
 * a step nobody was told about.
 *
 * `outputSchema` is optional here and required on AI stages. The flat DSL
 * describes named primitive fields, which is what a model can be asked to
 * return; a transform legitimately returns nested data the DSL cannot express.
 * Declared, it is enforced exactly as on an AI stage. Absent, the sandbox's
 * JSON object is passed through as-is — the sandbox already guarantees it IS a
 * JSON object, so the next stage still receives something well-formed.
 */
export const AgentDefinitionCodeStageSchema = z.object({
  kind: z.literal("code"),
  id: StageIdSchema,
  description: z.string().min(1),
  language: z.enum(["node", "python"]),
  code: z.string().min(1).max(MAX_STAGE_CODE_CHARS),
  /** Wall-clock budget for the script. The sandbox caps this at its own hard ceiling. */
  timeoutMs: z.number().int().positive().optional(),
  outputSchema: z.array(AgentDefinitionFieldSchema).optional(),
});
export type AgentDefinitionCodeStage = z.infer<typeof AgentDefinitionCodeStageSchema>;

/**
 * One stage, either kind.
 *
 * A plain union rather than `z.discriminatedUnion`, because the discriminator
 * has a default: a stage stored before code steps existed carries no `kind` at
 * all, and a discriminated union rejects it outright instead of reading it as
 * the AI stage it is.
 */
export const AgentDefinitionStageSchema = z.union([AgentDefinitionAiStageSchema, AgentDefinitionCodeStageSchema]);
export type AgentDefinitionStage = z.infer<typeof AgentDefinitionStageSchema>;

/** Narrowing helper — the runner branches on this rather than re-testing the literal. */
export function isCodeStage(stage: AgentDefinitionStage): stage is AgentDefinitionCodeStage {
  return stage.kind === "code";
}

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
  /**
   * Opt in to scoring this agent's deliverable against its own recent output
   * for the same client.
   *
   * Off by default, and only ever a flag: unlike the topic guardrail, which
   * fails a run because publishing a forbidden topic is a breach, a repeated
   * theme is a signal for a human to weigh. Some agents are supposed to
   * revisit the same subject.
   */
  dedupeAgainstHistory: z.boolean().default(false),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Bumped by the store on every successful update — the one "version" concept this module has, matching `DynamicAgentSpec.version`'s own whole-spec-integer convention rather than a per-field history. */
  version: z.number().int().positive(),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/** What a caller supplies to create/update a definition — the store stamps `createdAt`/`updatedAt`/`version`. */
export const AgentDefinitionInputSchema = AgentDefinitionSchema.omit({ createdAt: true, updatedAt: true, version: true });
export type AgentDefinitionInput = z.infer<typeof AgentDefinitionInputSchema>;
