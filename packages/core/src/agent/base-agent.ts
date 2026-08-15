import { z } from "zod";
import type { AgentContext } from "../types/agent-context.js";
import type {
  AgentExecutionResult,
  AgentExecutionStatus,
  AgentStepConfig,
  AgentStepTelemetry,
  StepStatus,
  ZodSchema,
} from "../types/agent-step.js";
import { GateVerdictSchema } from "../types/gate.js";
import { computeStepCostUsd, summarizeStepTelemetry } from "../telemetry/pricing.js";
import type { RouterCompleteOptions } from "../router/model-router.js";
import type { AgentToolOutcome } from "./tool.js";
import { enforceWriteFence } from "./write-fence.js";
import { parseSkillRef } from "./prompt-store.js";
import { describeError } from "./errors.js";
import type { BaseAgentRuntime, ReActTurn, TranscriptEntry } from "./types.js";

type TurnOutcome<TOutput> =
  | { kind: "tool_call"; telemetry: AgentStepTelemetry; toolName: string; args: unknown; outcome: AgentToolOutcome<unknown> }
  | { kind: "final"; telemetry: AgentStepTelemetry; output: TOutput }
  | { kind: "tooling_error"; telemetry: AgentStepTelemetry };

type GateCheckOutcome =
  | { kind: "pass"; telemetry: AgentStepTelemetry }
  | { kind: "content_fail"; telemetry: AgentStepTelemetry; reason: string; evidence: string[] }
  | { kind: "tooling_error"; telemetry: AgentStepTelemetry };

/**
 * The class every concrete agent (`XAgent`, `LinkedInAgent`, `ResearchAgent`,
 * …) inherits from (RFC-01 §5). `run()` implements the bounded ReAct loop
 * from §5.3: every turn is one call through the injected `ModelRouter`
 * deciding either to call one tool from `config.allowedTools` (Action) or to
 * produce the step's terminal output.
 *
 * Layer 2 has no I/O except through Layer 3 tools (RFC-01 §4's invariant) —
 * this class never touches a filesystem, network, or database directly;
 * `runtime.tools` and `runtime.router` are the only channels out.
 */
export abstract class BaseAgent<TOutput> {
  protected abstract readonly config: AgentStepConfig<TOutput>;

  constructor(protected readonly runtime: BaseAgentRuntime) {}

  async run(ctx: AgentContext, input: unknown): Promise<AgentExecutionResult<TOutput>> {
    const maxSteps = this.config.maxSteps ?? 8;
    const steps: AgentStepTelemetry[] = [];
    const transcript: TranscriptEntry[] = [{ role: "input", content: input }];

    let systemPrompt: string | undefined;
    try {
      systemPrompt = await this.loadSystemPrompt(ctx);
    } catch {
      // A PromptStore lookup failure is a tooling problem (a broken/misconfigured
      // skillRef), never a content judgment — same rule as every other failure
      // mode in this loop (RFC-01 §6).
      steps.push({
        stepIndex: 0,
        modelUsed: this.config.modelPolicy.model,
        inputTokens: { cached: 0, uncached: 0 },
        outputTokens: 0,
        durationMs: 0,
        costUsd: 0,
        status: "tooling_error",
      });
      return this.finish(steps, null, "tooling_error");
    }

    let stepIndex = 0;

    while (stepIndex < maxSteps) {
      const turn = await this.runOneTurn(ctx, input, transcript, systemPrompt, stepIndex);
      steps.push(turn.telemetry);
      stepIndex++;

      if (turn.kind === "tooling_error") {
        return this.finish(steps, null, "tooling_error");
      }

      if (turn.kind === "tool_call") {
        // Observation: append the typed result (or typed error) and keep looping —
        // content_fail/not_available from a regular tool is real signal the model
        // incorporates into its next Thought, not a fatal condition.
        transcript.push({ role: "tool_call", tool: turn.toolName, args: turn.args });
        transcript.push({ role: "observation", tool: turn.toolName, outcome: turn.outcome });
        continue;
      }

      // turn.kind === "final" — the output schema's terminal condition has been met.
      return this.resolveFinalOutput(ctx, input, transcript, systemPrompt, steps, stepIndex, maxSteps, turn.output);
    }

    return this.finish(steps, null, "budget_exceeded");
  }

  /**
   * Craft-policy skill content for the system prompt (RFC-01 §5.2 step 2).
   * `skillRef` resolves as `promptId@version` through `runtime.promptStore`
   * (RFC-01 §16.1) — never a hardcoded string literal embedded in the step
   * config itself. A step with no `skillRef`, or a runtime with no
   * `promptStore` configured, simply gets no system prompt.
   */
  protected async loadSystemPrompt(_ctx: AgentContext): Promise<string | undefined> {
    if (!this.config.skillRef || !this.runtime.promptStore) {
      return undefined;
    }
    const { promptId, version } = parseSkillRef(this.config.skillRef);
    return this.runtime.promptStore.getPrompt(promptId, version);
  }

  /** Serializes the step's task, this run's identity, and the transcript so far. Override for real prompt engineering. */
  protected buildTurnPrompt(ctx: AgentContext, input: unknown, transcript: readonly TranscriptEntry[]): string {
    return JSON.stringify(
      {
        stepId: this.config.id,
        description: this.config.description,
        allowedTools: this.config.allowedTools,
        context: { runId: ctx.runId, clientSlug: ctx.clientSlug, productId: ctx.productId, slotId: ctx.slotId },
        input,
        transcript,
      },
      null,
      2,
    );
  }

  private buildTurnSchema(): ZodSchema<ReActTurn<TOutput>> {
    return z.discriminatedUnion("type", [
      z.object({ type: z.literal("tool_call"), thought: z.string().optional(), tool: z.string().min(1), args: z.unknown() }),
      z.object({ type: z.literal("final"), thought: z.string().optional(), output: this.config.outputSchema }),
    ]);
  }

  private clock(): number {
    return this.runtime.now ? this.runtime.now() : Date.now();
  }

  private async runOneTurn(
    ctx: AgentContext,
    input: unknown,
    transcript: TranscriptEntry[],
    systemPrompt: string | undefined,
    stepIndex: number,
  ): Promise<TurnOutcome<TOutput>> {
    const turnSchema = this.buildTurnSchema();
    const prompt = this.buildTurnPrompt(ctx, input, transcript);
    const opts: RouterCompleteOptions | undefined = systemPrompt !== undefined ? { system: systemPrompt } : undefined;

    const startedAt = this.clock();
    let completion;
    try {
      completion = await this.runtime.router.complete(prompt, turnSchema, this.config.modelPolicy, opts);
    } catch (err) {
      return {
        kind: "tooling_error",
        telemetry: {
          stepIndex,
          modelUsed: this.config.modelPolicy.model,
          inputTokens: { cached: 0, uncached: 0 },
          outputTokens: 0,
          durationMs: this.clock() - startedAt,
          costUsd: 0,
          status: "tooling_error",
        },
      };
    }
    const durationMs = this.clock() - startedAt;
    const costUsd = computeStepCostUsd(completion.modelUsed, completion.inputTokens, completion.outputTokens);
    const turn = completion.output;

    if (turn.type === "final") {
      return {
        kind: "final",
        output: turn.output,
        telemetry: {
          stepIndex,
          ...(turn.thought !== undefined ? { thought: turn.thought } : {}),
          modelUsed: completion.modelUsed,
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          durationMs,
          costUsd,
          status: "success",
        },
      };
    }

    // turn.type === "tool_call" — Action: exactly one tool call, arguments validated before execution.
    const fence = enforceWriteFence(ctx, turn.tool, turn.args);
    if (!fence.allowed) {
      transcript.push({ role: "write_fence_block", tool: turn.tool, reason: fence.reason });
      return {
        kind: "tooling_error",
        telemetry: {
          stepIndex,
          ...(turn.thought !== undefined ? { thought: turn.thought } : {}),
          toolCall: { name: turn.tool, args: turn.args, result: { blocked: true, reason: fence.reason }, toolVersion: "write-fence" },
          modelUsed: completion.modelUsed,
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          durationMs,
          costUsd,
          status: "tooling_error",
        },
      };
    }

    const tool = this.runtime.tools[turn.tool];
    if (!tool) {
      return {
        kind: "tooling_error",
        telemetry: {
          stepIndex,
          ...(turn.thought !== undefined ? { thought: turn.thought } : {}),
          toolCall: { name: turn.tool, args: turn.args, result: { error: `no tool registered as "${turn.tool}"` }, toolVersion: "unknown" },
          modelUsed: completion.modelUsed,
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          durationMs,
          costUsd,
          status: "tooling_error",
        },
      };
    }

    const parsedArgs = tool.inputSchema.safeParse(turn.args);
    if (!parsedArgs.success) {
      return {
        kind: "tooling_error",
        telemetry: {
          stepIndex,
          ...(turn.thought !== undefined ? { thought: turn.thought } : {}),
          toolCall: { name: tool.name, args: turn.args, result: { error: "arguments failed the tool's input schema" }, toolVersion: tool.version },
          modelUsed: completion.modelUsed,
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          durationMs,
          costUsd,
          status: "tooling_error",
        },
      };
    }

    const outcome = await tool.execute(parsedArgs.data, { ctx });
    const status: StepStatus = outcome.status === "tooling_error" ? "tooling_error" : outcome.status === "content_fail" ? "content_fail" : "success";
    const telemetry: AgentStepTelemetry = {
      stepIndex,
      ...(turn.thought !== undefined ? { thought: turn.thought } : {}),
      toolCall: { name: tool.name, args: parsedArgs.data, result: outcome, toolVersion: tool.version },
      modelUsed: completion.modelUsed,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      durationMs,
      costUsd,
      status,
    };

    if (outcome.status === "tooling_error") {
      return { kind: "tooling_error", telemetry };
    }

    return { kind: "tool_call", telemetry, toolName: tool.name, args: parsedArgs.data, outcome };
  }

  private zeroCostTelemetry(stepIndex: number, toolName: string, toolVersion: string, result: unknown, status: StepStatus, durationMs: number): AgentStepTelemetry {
    return {
      stepIndex,
      toolCall: { name: toolName, args: undefined, result, toolVersion },
      modelUsed: this.config.modelPolicy.model,
      inputTokens: { cached: 0, uncached: 0 },
      outputTokens: 0,
      durationMs,
      costUsd: 0,
      status,
    };
  }

  /** Self-critique (RFC-01 §5.6): a mandatory call to a typed gate tool, never a free-text "check your work". */
  private async runGateCheck(ctx: AgentContext, gateToolName: string, draft: TOutput, stepIndex: number): Promise<GateCheckOutcome> {
    const startedAt = this.clock();
    const gateTool = this.runtime.tools[gateToolName];

    if (!gateTool) {
      return {
        kind: "tooling_error",
        telemetry: this.zeroCostTelemetry(stepIndex, gateToolName, "unknown", { error: `no gate tool registered as "${gateToolName}"` }, "tooling_error", this.clock() - startedAt),
      };
    }

    let outcome: AgentToolOutcome<unknown>;
    try {
      outcome = await gateTool.execute(draft, { ctx });
    } catch (err) {
      outcome = { status: "tooling_error", reason: describeError(err) };
    }
    const durationMs = this.clock() - startedAt;

    if (outcome.status !== "success") {
      return { kind: "tooling_error", telemetry: this.zeroCostTelemetry(stepIndex, gateTool.name, gateTool.version, outcome, "tooling_error", durationMs) };
    }

    const verdictParse = GateVerdictSchema.safeParse(outcome.result);
    if (!verdictParse.success) {
      return {
        kind: "tooling_error",
        telemetry: this.zeroCostTelemetry(stepIndex, gateTool.name, gateTool.version, { error: "gate tool returned a malformed GateVerdict" }, "tooling_error", durationMs),
      };
    }

    const verdict = verdictParse.data;
    // A tooling_error verdict is never recorded as a content verdict (RFC-01 §5.6) — same status either way.
    const telemetry = this.zeroCostTelemetry(stepIndex, gateTool.name, gateTool.version, verdict, verdict.verdict === "pass" ? "success" : verdict.verdict, durationMs);

    if (verdict.verdict === "pass") {
      return { kind: "pass", telemetry };
    }
    if (verdict.verdict === "tooling_error") {
      return { kind: "tooling_error", telemetry };
    }
    return { kind: "content_fail", telemetry, reason: verdict.reason, evidence: verdict.evidence };
  }

  private async resolveFinalOutput(
    ctx: AgentContext,
    input: unknown,
    transcript: TranscriptEntry[],
    systemPrompt: string | undefined,
    steps: AgentStepTelemetry[],
    stepIndexAfterDraft: number,
    maxSteps: number,
    draft: TOutput,
  ): Promise<AgentExecutionResult<TOutput>> {
    if (!this.config.selfCritique) {
      return this.validateAndFinish(steps, draft);
    }

    const gateToolName = this.config.selfCritique.gateTool;
    const maxRevisions = this.config.selfCritique.maxRevisions ?? 1;
    let attempt = 0;
    let currentDraft = draft;
    let stepIndex = stepIndexAfterDraft;

    for (;;) {
      const gateResult = await this.runGateCheck(ctx, gateToolName, currentDraft, stepIndex);
      steps.push(gateResult.telemetry);
      stepIndex++;

      if (gateResult.kind === "tooling_error") {
        // Never masked as a content failure; the unverified draft is preserved, not discarded.
        return this.finish(steps, currentDraft, "tooling_error");
      }

      if (gateResult.kind === "pass") {
        return this.validateAndFinish(steps, currentDraft);
      }

      // content_fail — the gate returns to the producer with the reason; the producer revises (bounded), never silently.
      if (attempt >= maxRevisions) {
        return this.finish(steps, null, "content_fail");
      }
      if (stepIndex >= maxSteps) {
        return this.finish(steps, null, "budget_exceeded");
      }

      attempt++;
      transcript.push({ role: "gate_feedback", gateTool: gateToolName, reason: gateResult.reason, evidence: gateResult.evidence });

      const revisionTurn = await this.runOneTurn(ctx, input, transcript, systemPrompt, stepIndex);
      steps.push(revisionTurn.telemetry);
      stepIndex++;

      if (revisionTurn.kind !== "final") {
        // A revision turn is expected to produce a revised terminal output directly (Phase 1 scope).
        return this.finish(steps, null, "tooling_error");
      }

      currentDraft = revisionTurn.output;
    }
  }

  private validateAndFinish(steps: AgentStepTelemetry[], draft: TOutput): AgentExecutionResult<TOutput> {
    const parsed = this.config.outputSchema.safeParse(draft);
    if (!parsed.success) {
      return this.finish(steps, null, "content_fail");
    }
    return this.finish(steps, parsed.data, "completed");
  }

  private finish(steps: AgentStepTelemetry[], finalOutput: TOutput | null, status: AgentExecutionStatus): AgentExecutionResult<TOutput> {
    const totals = summarizeStepTelemetry(steps);
    return { finalOutput, steps, totalCostUsd: totals.totalCostUsd, totalTokens: totals.totalTokens, status };
  }
}
