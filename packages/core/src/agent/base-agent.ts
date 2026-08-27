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
import { applyStageModelOverride } from "../router/step-model-policy.js";
import type { ModelPolicy } from "../types/model-policy.js";
// Both are pure, I/O-free schema helpers, so reaching into `router/adapters`
// from here doesn't give Layer 2 a second channel out (RFC-01 §4) — and
// `toRootObjectJsonSchema` in particular has to be *the same* function the
// adapters call, or the envelope described to the model could drift from the
// one on the wire.
import { toRootObjectJsonSchema } from "../router/adapters/root-object-schema.js";
import { StructuredOutputValidationError } from "../router/adapters/structured-output.js";
import type { AgentToolOutcome, AgentToolRegistry } from "./tool.js";
import { enforceWriteFence } from "./write-fence.js";
import { parseSkillRef } from "./prompt-store.js";
import { describeError } from "./errors.js";
import type { BaseAgentRuntime, ReActTurn, TranscriptEntry } from "./types.js";

type TurnOutcome<TOutput> =
  | { kind: "tool_call"; telemetry: AgentStepTelemetry; toolName: string; args: unknown; outcome: AgentToolOutcome<unknown> }
  | { kind: "final"; telemetry: AgentStepTelemetry; output: TOutput }
  | { kind: "tooling_error"; telemetry: AgentStepTelemetry }
  /** The model answered, but in a shape the turn schema rejects — recoverable by re-prompting, unlike every other failure here. */
  | { kind: "malformed_turn"; telemetry: AgentStepTelemetry; reason: string; rawPayload: string };

/** Step-scoped loop counters, shared by the draft phase and every revision so neither can reset the other's bound. */
interface LoopState {
  stepIndex: number;
  malformedTurns: number;
}

/** How one pass of the ReAct loop ended. `budget_exceeded`/`tooling_error` map straight onto `AgentExecutionStatus`. */
type LoopExit<TOutput> = { kind: "final"; output: TOutput } | { kind: "tooling_error" } | { kind: "budget_exceeded" };

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
    } catch (err) {
      // A PromptStore lookup failure is a tooling problem (a broken/misconfigured
      // skillRef), never a content judgment — same rule as every other failure
      // mode in this loop (RFC-01 §6).
      steps.push({
        stepIndex: 0,
        modelUsed: this.effectivePolicy(ctx).model,
        inputTokens: { cached: 0, uncached: 0, cacheWrite: 0 },
        outputTokens: 0,
        durationMs: 0,
        costUsd: 0,
        status: "tooling_error",
        error: `could not resolve skillRef "${this.config.skillRef}": ${describeError(err)}`,
      });
      return this.finish(steps, null, "tooling_error");
    }

    // `stepIndex` and the malformed-turn budget are both step-scoped, not
    // phase-scoped: the draft loop and any later revision loop share one
    // `maxSteps` allowance and one repair allowance, so a revision can never
    // reset either and run the step past its bound.
    const loop: LoopState = { stepIndex: 0, malformedTurns: 0 };

    const exit = await this.runReActLoop(ctx, input, transcript, systemPrompt, steps, loop, maxSteps);
    if (exit.kind !== "final") {
      return this.finish(steps, null, exit.kind);
    }
    return this.resolveFinalOutput(ctx, input, transcript, systemPrompt, steps, loop, maxSteps, exit.output);
  }

  /**
   * The bounded ReAct loop itself (RFC-01 §5.3), shared by the draft phase and
   * by every self-critique revision.
   *
   * Sharing it is the fix for a real failure, not tidiness: the revision phase
   * used to call `runOneTurn` exactly once and treat anything but a `final` as
   * a fatal `tooling_error`. A revising model that called a tool first — to
   * re-check a length limit or re-run a gate against its new text, which is
   * precisely what a careful reviser does — killed the run, and because the
   * turn itself had succeeded, the step record showed four healthy turns and
   * no error at all (prep run pubsub-20272673526122768, newsletter-agent
   * 09-draft-post, whose turn 3 was a successful `render.preview`). Revision
   * is the same Thought → Action → Observation problem as drafting; it gets
   * the same loop, and stays bounded by the same shared `maxSteps`.
   */
  private async runReActLoop(
    ctx: AgentContext,
    input: unknown,
    transcript: TranscriptEntry[],
    systemPrompt: string | undefined,
    steps: AgentStepTelemetry[],
    loop: LoopState,
    maxSteps: number,
  ): Promise<LoopExit<TOutput>> {
    const maxMalformedTurns = this.config.maxMalformedTurns ?? 1;

    while (loop.stepIndex < maxSteps) {
      const turn = await this.runOneTurn(ctx, input, transcript, systemPrompt, loop.stepIndex);
      steps.push(turn.telemetry);
      loop.stepIndex++;

      if (turn.kind === "tooling_error") {
        return { kind: "tooling_error" };
      }

      // A rejected turn was never acted on, so nothing downstream saw it — the
      // only state it leaves is the transcript note telling the model what it
      // got wrong. Re-prompting is bounded twice over: by this budget and by
      // `maxSteps`, which this turn has already consumed.
      if (turn.kind === "malformed_turn") {
        loop.malformedTurns++;
        if (loop.malformedTurns > maxMalformedTurns) {
          return { kind: "tooling_error" };
        }
        transcript.push({ role: "malformed_turn", reason: turn.reason, rawPayload: turn.rawPayload });
        continue;
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
      return { kind: "final", output: turn.output };
    }

    return { kind: "budget_exceeded" };
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
        responseContract: this.describeResponseContract(),
        allowedTools: this.describeAllowedTools(),
        context: { runId: ctx.runId, clientSlug: ctx.clientSlug, productId: ctx.productId, slotId: ctx.slotId },
        input,
        transcript,
      },
      null,
      2,
    );
  }

  /**
   * States the ReAct envelope in the prompt instead of leaving the model to
   * infer it from the tool's JSON Schema alone.
   *
   * The schema was previously the *only* statement of this contract, and real
   * runs died on the two mistakes that invites: returning the bare `output`
   * object with no `type` at all (rejected as `Invalid discriminator value.
   * Expected 'tool_call' | 'final'`), and serializing the payload as a JSON
   * string instead of an object. Both are shape mistakes a sentence prevents
   * far more cheaply than a repair turn recovers from.
   *
   * `wrapped` is read from `toRootObjectJsonSchema` — the same pure function
   * the adapters use — rather than assumed, so this can never describe an
   * envelope different from the one actually on the wire. That is also why it
   * is derived here and not hardcoded: a step with no `allowedTools` gets an
   * object-rooted schema that is *not* wrapped, and telling it to nest under
   * `turn` would manufacture the very failure this prevents.
   */
  private describeResponseContract(): Record<string, unknown> {
    const hasTools = this.config.allowedTools.length > 0;
    const wrapped = this.turnSchemaIsWrapped(hasTools);
    const finalShape = '{"type":"final","thought":"<optional>","output":{…}}';
    const toolShape = '{"type":"tool_call","thought":"<optional>","tool":"<one of allowedTools>","args":{…}}';

    return {
      shape: wrapped
        ? 'Return {"turn": <turn-object>} — the turn object nested under a single "turn" property.'
        : "Return the turn object itself, at the root.",
      turnObject: hasTools ? `Exactly one of: ${toolShape} or ${finalShape}` : `Exactly: ${finalShape}`,
      rules: [
        '"type" is REQUIRED and must be the literal string ' +
          (hasTools ? '"tool_call" or "final"' : '"final"') +
          " — never omitted, never any other value.",
        'Never return the "output" object on its own. A finished answer is always wrapped as ' + finalShape + ".",
        "Return real JSON objects, never a JSON-encoded string in place of an object.",
        ...(hasTools ? ['"tool" must be exactly one of the advertised allowedTools names.'] : []),
      ],
    };
  }

  /**
   * Each allowed tool as `{name, inputSchema}` rather than a bare name.
   *
   * `buildTurnSchema` constrains which tool the model may *name*, but nothing
   * constrains the `args` it invents for that tool — `args` is `z.unknown()`
   * by necessity, since one turn schema has to cover every tool. So a name
   * alone still leaves the model guessing the argument shape, and real runs
   * died on it: the model called `gate.numbersSourced` with
   * `{claim, sourceText}` against a tool declaring `{text, sources[]}`.
   * Advertising each tool's own `inputSchema` closes that gap, and because it
   * *is* the tool's own schema it can never drift from what `runOneTurn`
   * validates against.
   *
   * A tool whose schema can't be represented as JSON Schema degrades to the
   * bare name instead of failing the step — a less informative prompt is not
   * a broken run. Reads through `scopedTools()` so this can only ever
   * advertise tools the loop can actually reach.
   */
  private describeAllowedTools(): Array<{ name: string; inputSchema?: unknown }> {
    const scoped = this.scopedTools();
    return this.config.allowedTools.map((name) => {
      const tool = scoped[name];
      if (!tool) return { name };
      try {
        return { name, inputSchema: z.toJSONSchema(tool.inputSchema) };
      } catch {
        return { name };
      }
    });
  }

  /**
   * Whether the turn schema will be nested under `turn` on the wire, asked of
   * `toRootObjectJsonSchema` so the prompt can never describe an envelope
   * different from the one the adapters actually send.
   *
   * The fallback matters: `z.toJSONSchema()` throws on a schema it can't
   * represent (the reason `describeAllowedTools` guards it too), and unlike
   * the adapter's identical call — which happens inside `runOneTurn`'s
   * try/catch and so degrades to a `tooling_error` — this one runs while
   * *building the prompt*, where a throw would escape `run()` entirely. A
   * prompt-shaping helper must never be the thing that crashes a step, so an
   * unrepresentable schema falls back to the rule `buildTurnSchema` already
   * guarantees: tools present means a discriminated-union root (wrapped), no
   * tools means a plain object root (not wrapped).
   */
  private turnSchemaIsWrapped(hasTools: boolean): boolean {
    try {
      return toRootObjectJsonSchema(this.buildTurnSchema()).wrapped;
    } catch {
      return hasTools;
    }
  }

  /**
   * The `tool` field is constrained to exactly `config.allowedTools` — never
   * a free-form string — so a disallowed tool name fails structured-output
   * validation at the adapter itself, before it ever reaches `runOneTurn`
   * (RFC-01 §5.5, §14 DoD: "enforces allowedTools narrowing"). When a step
   * declares no tools at all, the union drops the `tool_call` variant
   * entirely — the model can only ever produce a final output.
   */
  private buildTurnSchema(): ZodSchema<ReActTurn<TOutput>> {
    const finalVariant = z.object({ type: z.literal("final"), thought: z.string().optional(), output: this.config.outputSchema });
    if (this.config.allowedTools.length === 0) {
      return finalVariant as unknown as ZodSchema<ReActTurn<TOutput>>;
    }
    const toolVariant = z.object({
      type: z.literal("tool_call"),
      thought: z.string().optional(),
      tool: z.enum(this.config.allowedTools as [string, ...string[]]),
      args: z.unknown(),
    });
    return z.discriminatedUnion("type", [toolVariant, finalVariant]);
  }

  /**
   * Only the tools this step declared in `allowedTools` are ever reachable
   * from the ReAct loop — the execution context never exposes the full
   * registry, so a tool outside this step's declared scope cannot be
   * discovered or invoked even by an injected instruction naming it exactly.
   */
  private scopedTools(): AgentToolRegistry {
    const scoped: AgentToolRegistry = {};
    for (const name of this.config.allowedTools) {
      const tool = this.runtime.tools[name];
      if (tool) {
        scoped[name] = tool;
      }
    }
    return scoped;
  }

  /**
   * This step's model policy for THIS run: its compiled/env-resolved default
   * with any Studio per-stage override applied on top.
   */
  protected effectivePolicy(ctx: AgentContext): ModelPolicy {
    return applyStageModelOverride(this.config.id, this.config.modelPolicy, ctx.stageModels);
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
    const opts: RouterCompleteOptions | undefined =
      systemPrompt !== undefined || this.config.maxTokens !== undefined
        ? {
            ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
            ...(this.config.maxTokens !== undefined ? { maxTokens: this.config.maxTokens } : {}),
          }
        : undefined;

    const startedAt = this.clock();
    let completion;
    try {
      // The one place a per-run, per-stage model choice is applied. `ctx` is
      // in hand here and nowhere earlier, which is why the override rides on
      // the context rather than through every agent's constructor — one
      // resolution point instead of fourteen that could each be missed.
      completion = await this.runtime.router.complete(prompt, turnSchema, this.effectivePolicy(ctx), opts);
    } catch (err) {
      const durationMs = this.clock() - startedAt;
      // A malformed turn is the one model-call failure worth another turn, so
      // it is classified apart from a dead provider / bad auth / exhausted
      // output ceiling. Its usage is whatever the provider actually reported
      // (the adapter reads it before validating), which is why this doesn't
      // hardcode the zeros the generic path below still correctly uses — there
      // is no usage to report when the call never produced a response.
      if (err instanceof StructuredOutputValidationError) {
        const reason = describeError(err);
        return {
          kind: "malformed_turn",
          reason,
          rawPayload: err.rawPayloadExcerpt,
          telemetry: {
            stepIndex,
            modelUsed: err.usage?.modelUsed ?? this.effectivePolicy(ctx).model,
            inputTokens: { cached: 0, uncached: 0, cacheWrite: 0, ...err.usage?.inputTokens },
            outputTokens: err.usage?.outputTokens ?? 0,
            durationMs,
            costUsd: err.usage
              ? computeStepCostUsd(err.usage.modelUsed, err.usage.inputTokens, err.usage.outputTokens)
              : 0,
            status: "tooling_error",
            error: `malformed model turn: ${reason} — raw payload: ${err.rawPayloadExcerpt}`,
          },
        };
      }
      return {
        kind: "tooling_error",
        telemetry: {
          stepIndex,
          modelUsed: this.effectivePolicy(ctx).model,
          inputTokens: { cached: 0, uncached: 0, cacheWrite: 0 },
          outputTokens: 0,
          durationMs,
          costUsd: 0,
          status: "tooling_error",
          error: `model call failed: ${describeError(err)}`,
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
          ...(completion.provenance && completion.provenance.hop !== "primary"
            ? { servedBy: { hop: completion.provenance.hop, adapter: completion.provenance.servedBy, failedOver: [...completion.provenance.failedOver] } }
            : {}),
          inputTokens: { cacheWrite: 0, ...completion.inputTokens },
          outputTokens: completion.outputTokens,
          durationMs,
          costUsd,
          status: "success",
        },
      };
    }

    // turn.type === "tool_call" — Action: exactly one tool call, arguments validated before execution.
    // Defense-in-depth: buildTurnSchema()'s z.enum(allowedTools) already makes a
    // disallowed tool name unparseable at the adapter, but this loop must never
    // trust that every ModelRouter implementation actually re-validates the
    // model's raw output against the schema it was given (RFC-01 §5.5, §14 DoD).
    if (!this.config.allowedTools.includes(turn.tool)) {
      return {
        kind: "tooling_error",
        telemetry: {
          stepIndex,
          ...(turn.thought !== undefined ? { thought: turn.thought } : {}),
          toolCall: {
            name: turn.tool,
            args: turn.args,
            result: { error: `tool "${turn.tool}" is not in this step's allowedTools` },
            toolVersion: "allowlist",
          },
          modelUsed: completion.modelUsed,
          ...(completion.provenance && completion.provenance.hop !== "primary"
            ? { servedBy: { hop: completion.provenance.hop, adapter: completion.provenance.servedBy, failedOver: [...completion.provenance.failedOver] } }
            : {}),
          inputTokens: { cacheWrite: 0, ...completion.inputTokens },
          outputTokens: completion.outputTokens,
          durationMs,
          costUsd,
          status: "tooling_error",
        },
      };
    }

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
          ...(completion.provenance && completion.provenance.hop !== "primary"
            ? { servedBy: { hop: completion.provenance.hop, adapter: completion.provenance.servedBy, failedOver: [...completion.provenance.failedOver] } }
            : {}),
          inputTokens: { cacheWrite: 0, ...completion.inputTokens },
          outputTokens: completion.outputTokens,
          durationMs,
          costUsd,
          status: "tooling_error",
        },
      };
    }

    // Resolved against the step's own scoped registry, never the full one, so
    // a tool outside `allowedTools` is unreachable even if something names it
    // exactly. Reaching the `!tool` branch below therefore means a *declared*
    // tool is missing from the runtime registry (a wiring gap), not that the
    // model invented a name — `buildTurnSchema`'s enum already rules that out.
    //
    // Both that case and malformed `args` resolve as a normal observation the
    // model can act on next turn, still bounded by `maxSteps`, rather than
    // killing the step outright. Treating them as fatal made a single bad
    // argument guess end an otherwise-healthy run — identical inputs would
    // succeed or fail depending on how the model happened to shape one call.
    // The tool is never executed in either branch; only the feedback changed.
    const tool = this.scopedTools()[turn.tool];
    if (!tool) {
      const reason = `no tool registered as "${turn.tool}" — allowed tools for this step: ${this.config.allowedTools.join(", ") || "(none)"}`;
      return {
        kind: "tool_call",
        toolName: turn.tool,
        args: turn.args,
        outcome: { status: "tooling_error", reason },
        telemetry: {
          stepIndex,
          ...(turn.thought !== undefined ? { thought: turn.thought } : {}),
          toolCall: { name: turn.tool, args: turn.args, result: { error: reason }, toolVersion: "unknown" },
          modelUsed: completion.modelUsed,
          ...(completion.provenance && completion.provenance.hop !== "primary"
            ? { servedBy: { hop: completion.provenance.hop, adapter: completion.provenance.servedBy, failedOver: [...completion.provenance.failedOver] } }
            : {}),
          inputTokens: { cacheWrite: 0, ...completion.inputTokens },
          outputTokens: completion.outputTokens,
          durationMs,
          costUsd,
          status: "tooling_error",
        },
      };
    }

    const parsedArgs = tool.inputSchema.safeParse(turn.args);
    if (!parsedArgs.success) {
      // The concrete validation issues, so the next turn can fix the exact
      // field rather than guessing again at the same shape.
      const reason = `arguments failed the tool's input schema: ${parsedArgs.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`;
      return {
        kind: "tool_call",
        toolName: tool.name,
        args: turn.args,
        outcome: { status: "tooling_error", reason },
        telemetry: {
          stepIndex,
          ...(turn.thought !== undefined ? { thought: turn.thought } : {}),
          toolCall: { name: tool.name, args: turn.args, result: { error: reason }, toolVersion: tool.version },
          modelUsed: completion.modelUsed,
          ...(completion.provenance && completion.provenance.hop !== "primary"
            ? { servedBy: { hop: completion.provenance.hop, adapter: completion.provenance.servedBy, failedOver: [...completion.provenance.failedOver] } }
            : {}),
          inputTokens: { cacheWrite: 0, ...completion.inputTokens },
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
      inputTokens: { cacheWrite: 0, ...completion.inputTokens },
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

  /**
   * Telemetry for a turn that consumed no model tokens (a gate-tool call).
   *
   * `error` is set for every non-success status rather than left to the
   * `toolCall.result` blob: a run report renders `error`, so a gate that
   * errored used to show a bare `tooling_error` with its explanation buried
   * one level down in an untyped payload — indistinguishable at a glance from
   * a missing tool, a thrown tool, or a malformed verdict.
   */
  private zeroCostTelemetry(
    stepIndex: number,
    toolName: string,
    toolVersion: string,
    result: unknown,
    status: StepStatus,
    durationMs: number,
    error?: string,
  ): AgentStepTelemetry {
    return {
      stepIndex,
      toolCall: { name: toolName, args: undefined, result, toolVersion },
      // The step's configured model, not its effective one. This record is a
      // TOOL call: no model ran, no tokens were spent, and the field is here
      // only so a reader knows which step the call belongs to. Threading ctx
      // in to resolve an override that had no bearing on what happened would
      // be precision about nothing.
      modelUsed: this.config.modelPolicy.model,
      inputTokens: { cached: 0, uncached: 0, cacheWrite: 0 },
      outputTokens: 0,
      durationMs,
      costUsd: 0,
      status,
      ...(error !== undefined ? { error } : {}),
    };
  }

  /** Self-critique (RFC-01 §5.6): a mandatory call to a typed gate tool, never a free-text "check your work". */
  private async runGateCheck(
    ctx: AgentContext,
    gateToolName: string,
    draft: TOutput,
    stepIndex: number,
    gateArgs?: Record<string, unknown>,
  ): Promise<GateCheckOutcome> {
    const startedAt = this.clock();
    const gateTool = this.runtime.tools[gateToolName];

    if (!gateTool) {
      return {
        kind: "tooling_error",
        telemetry: this.zeroCostTelemetry(
          stepIndex,
          gateToolName,
          "unknown",
          { error: `no gate tool registered as "${gateToolName}"` },
          "tooling_error",
          this.clock() - startedAt,
          `self-critique gate "${gateToolName}" is not registered in this step's tool registry`,
        ),
      };
    }

    const args = gateArgs ? { ...draft, ...gateArgs } : draft;
    let outcome: AgentToolOutcome<unknown>;
    try {
      outcome = await gateTool.execute(args, { ctx });
    } catch (err) {
      outcome = { status: "tooling_error", reason: describeError(err) };
    }
    const durationMs = this.clock() - startedAt;

    if (outcome.status !== "success") {
      return {
        kind: "tooling_error",
        telemetry: this.zeroCostTelemetry(
          stepIndex,
          gateTool.name,
          gateTool.version,
          outcome,
          "tooling_error",
          durationMs,
          `self-critique gate "${gateTool.name}" did not return a verdict: ${outcome.status}${
            "reason" in outcome && outcome.reason ? ` — ${outcome.reason}` : ""
          }`,
        ),
      };
    }

    const verdictParse = GateVerdictSchema.safeParse(outcome.result);
    if (!verdictParse.success) {
      return {
        kind: "tooling_error",
        telemetry: this.zeroCostTelemetry(
          stepIndex,
          gateTool.name,
          gateTool.version,
          { error: "gate tool returned a malformed GateVerdict" },
          "tooling_error",
          durationMs,
          `self-critique gate "${gateTool.name}" returned a malformed GateVerdict`,
        ),
      };
    }

    const verdict = verdictParse.data;
    // A tooling_error verdict is never recorded as a content verdict (RFC-01 §5.6) — same status either way.
    const telemetry = this.zeroCostTelemetry(
      stepIndex,
      gateTool.name,
      gateTool.version,
      verdict,
      verdict.verdict === "pass" ? "success" : verdict.verdict,
      durationMs,
      verdict.verdict === "pass"
        ? undefined
        : `self-critique gate "${gateTool.name}" returned "${verdict.verdict}"${verdict.reason ? `: ${verdict.reason}` : ""}`,
    );

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
    loop: LoopState,
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

    for (;;) {
      const gateResult = await this.runGateCheck(ctx, gateToolName, currentDraft, loop.stepIndex, this.config.selfCritique.gateArgs);
      steps.push(gateResult.telemetry);
      loop.stepIndex++;

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
      if (loop.stepIndex >= maxSteps) {
        return this.finish(steps, null, "budget_exceeded");
      }

      attempt++;
      transcript.push({ role: "gate_feedback", gateTool: gateToolName, reason: gateResult.reason, evidence: gateResult.evidence });

      // The reviser gets the full loop, not one all-or-nothing turn: it may
      // call tools to check its own revision before committing to it, exactly
      // as it could while drafting. Whatever it spends here comes out of the
      // step's shared `maxSteps`.
      const revision = await this.runReActLoop(ctx, input, transcript, systemPrompt, steps, loop, maxSteps);
      if (revision.kind !== "final") {
        return this.finish(steps, null, revision.kind);
      }

      currentDraft = revision.output;
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
