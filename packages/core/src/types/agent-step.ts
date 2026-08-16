import { z, ZodType } from "zod";
import { ModelPolicySchema, type ModelPolicy } from "./model-policy.js";

/** Alias matching the RFC-01 §5.1 text (zod v4 no longer exports `ZodSchema`). */
export type ZodSchema<T> = ZodType<T>;

const isZodSchema = (val: unknown): val is ZodType => val instanceof ZodType;

/**
 * Structural validation for `AgentStepConfig` — everything except the
 * generic `outputSchema` field itself, which is validated only for *being* a
 * Zod schema (its own generic output type is erased at runtime, same as any
 * schema-holding config).
 */
export const AgentStepConfigSchema = z.object({
  /** e.g. "draft-post", "derive-voice". */
  id: z.string().min(1),
  description: z.string().min(1),
  /** Narrow, explicit MCP tool names — never a blanket allowlist. */
  allowedTools: z.array(z.string().min(1)),
  outputSchema: z.custom<ZodType<unknown>>(isZodSchema, { message: "outputSchema must be a Zod schema" }),
  /** Bounds runaway loops and token spend. Default 8 (RFC-01 §5.3). */
  maxSteps: z.number().int().positive().default(8),
  modelPolicy: ModelPolicySchema,
  /** Craft-policy skill this step loads. */
  skillRef: z.string().min(1).optional(),
  selfCritique: z
    .object({
      /** e.g. "gate.brand_compliance". */
      gateTool: z.string().min(1),
      maxRevisions: z.number().int().positive().default(1),
      /**
       * Static fields merged onto the draft before it's sent to the gate tool,
       * winning over anything the model happened to include (e.g. `{platform: "x"}`
       * for `gate.lintPost`) — the draft's own schema defaults don't apply until
       * *after* self-critique runs, so a gate that branches on a field like
       * `platform` cannot rely on the raw draft alone.
       */
      gateArgs: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

/** A single `BaseAgent` step's configuration (RFC-01 §5.1). */
export interface AgentStepConfig<TOutput> {
  id: string;
  description: string;
  allowedTools: string[];
  outputSchema: ZodSchema<TOutput>;
  maxSteps?: number;
  modelPolicy: ModelPolicy;
  skillRef?: string;
  selfCritique?: {
    gateTool: string;
    maxRevisions?: number;
    gateArgs?: Record<string, unknown>;
  };
}

export const TokenUsageSchema = z.object({
  cached: z.number().int().nonnegative(),
  uncached: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/** Per-tool-call record captured in the ReAct loop's Observation phase. */
export const ToolCallRecordSchema = z.object({
  name: z.string().min(1),
  args: z.unknown(),
  result: z.unknown(),
  toolVersion: z.string().min(1),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

/**
 * The status of a single ReAct loop turn. Distinct from the four run-level
 * outcomes in RFC-01 §6 (`completed`/`failed`/`degraded`/`awaiting_gate`),
 * which describe a whole Layer 1 workflow, not one BaseAgent step turn.
 */
export const StepStatusSchema = z.enum(["success", "content_fail", "tooling_error"]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const AgentStepTelemetrySchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  thought: z.string().optional(),
  toolCall: ToolCallRecordSchema.optional(),
  modelUsed: z.string().min(1),
  inputTokens: TokenUsageSchema,
  outputTokens: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  status: StepStatusSchema,
});
export type AgentStepTelemetry = z.infer<typeof AgentStepTelemetrySchema>;

/**
 * The terminal status of one `BaseAgent.run()` call (RFC-01 §5.1). This is
 * step-execution scope, not the run-level outcome taxonomy in §6.
 */
export const AgentExecutionStatusSchema = z.enum(["completed", "content_fail", "tooling_error", "budget_exceeded"]);
export type AgentExecutionStatus = z.infer<typeof AgentExecutionStatusSchema>;

/** Structural validation for the parts of `AgentExecutionResult` that don't depend on `TOutput`. */
export const AgentExecutionResultShapeSchema = z.object({
  steps: z.array(AgentStepTelemetrySchema),
  totalCostUsd: z.number().nonnegative(),
  totalTokens: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }),
  status: AgentExecutionStatusSchema,
});

/** Builds a full schema for `AgentExecutionResult<TOutput>` once the step's output schema is known. */
export function agentExecutionResultSchema<TOutput>(outputSchema: ZodSchema<TOutput>) {
  return AgentExecutionResultShapeSchema.extend({
    finalOutput: outputSchema.nullable(),
  });
}

export interface AgentExecutionResult<TOutput> {
  finalOutput: TOutput | null;
  steps: AgentStepTelemetry[];
  totalCostUsd: number;
  totalTokens: { input: number; output: number };
  status: AgentExecutionStatus;
}
