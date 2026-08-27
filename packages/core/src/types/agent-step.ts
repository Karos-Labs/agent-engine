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
  /**
   * Output-token ceiling for one model turn. Long-form steps (a blog post, a
   * newsletter edition, an intel report) need far more room than a short
   * social post, and a turn that runs out of room is not a partial answer —
   * the provider returns a truncated, unparseable structured output and the
   * whole step fails. Omit to take the adapter's own default.
   */
  maxTokens: z.number().int().positive().optional(),
  /**
   * How many times a turn may come back malformed — a missing `type`
   * discriminator, a bare `output` object, a stringified payload — before the
   * step gives up. Each such turn is re-prompted once with the validation
   * error and its own offending payload attached, which is the one failure the
   * model can actually fix when told; every retry still consumes a `maxSteps`
   * turn, so this only ever tightens the existing bound. Default 1: real
   * failures observed in production were single malformed turns in otherwise
   * healthy runs, and a model looping on the same shape mistake is a config
   * problem to surface, not to spend tokens on. 0 restores the old
   * fail-on-first-malformed-turn behaviour.
   */
  maxMalformedTurns: z.number().int().nonnegative().default(1),
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
  /** Output-token ceiling for one model turn; omit for the adapter default. See `AgentStepConfigSchema`. */
  maxTokens?: number;
  /** Bounded repair budget for malformed model turns. Default 1, `0` to fail on the first. See `AgentStepConfigSchema`. */
  maxMalformedTurns?: number;
  modelPolicy: ModelPolicy;
  skillRef?: string;
  selfCritique?: {
    gateTool: string;
    maxRevisions?: number;
    gateArgs?: Record<string, unknown>;
  };
}

export const TokenUsageSchema = z.object({
  /** Cache READS — billed at 0.1x base input. */
  cached: z.number().int().nonnegative(),
  /** Ordinary input — billed at 1x. */
  uncached: z.number().int().nonnegative(),
  /**
   * Cache WRITES — billed at 1.25x base input for the 5-minute TTL this
   * codebase uses (`cache_control: { type: "ephemeral" }`).
   *
   * Defaulted rather than required, deliberately: every step record persisted
   * before SCRUM-361b has two fields, not three, and must keep parsing.
   * Narrow what you write, keep wide what you read — the same rule
   * `ModelProvenance.hop` follows.
   *
   * Until this existed, cache writes were FOLDED INTO `uncached` and billed at
   * 1x. That understated every cached run slightly, and — the part worth
   * noticing — the error erased its own evidence: no sink stored the split, so
   * the size of the error could not be recovered from our own telemetry. It
   * had to be bounded from above instead.
   */
  cacheWrite: z.number().int().nonnegative().default(0),
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
  /**
   * Why a non-success turn failed, in plain text — the provider error, the
   * schema violation, the missing prompt. Optional because a successful turn
   * has nothing to explain. Without it a failed step reports only its status,
   * which makes an auth failure, a malformed request, and a broken prompt
   * store all look identical in a run report.
   */
  error: z.string().optional(),
  /**
   * Which hop of the Claude fallback chain served this turn (AU61 /
   * SCRUM-360). Absent means "served directly, no chain involved" — the
   * overwhelmingly common case, and the reason this is optional rather than
   * defaulted.
   *
   * `modelUsed` cannot answer this on its own. Before SCRUM-358 that was
   * because the primary and secondary hops returned the SAME model id on
   * different transports; now it is because the one remaining fallback serves
   * a DIFFERENT model family. Same principle as the SEO/GEO capture tiers,
   * applied to model provenance.
   *
   * `"secondary"` stays in this enum although nothing can write it any more:
   * SCRUM-358 deleted the direct-Anthropic hop, but step records written
   * before that exist and must stay parseable. This is the READER; the
   * producer type (`ModelProvenance` in `router/adapters/types.ts`) is
   * narrowed to what can actually happen today.
   */
  servedBy: z
    .object({
      hop: z.enum(["primary", "secondary", "tertiary"]),
      adapter: z.string().min(1),
      failedOver: z.array(z.object({ from: z.string(), errorClass: z.string(), status: z.number().int().optional() })),
    })
    .optional(),
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
