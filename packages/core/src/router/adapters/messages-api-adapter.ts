import type { Message, MessageCreateParamsNonStreaming, Tool } from "@anthropic-ai/sdk/resources/messages";
import type { CompletionRequest, CompletionResult, MessagesApiClient, ModelAdapter } from "./types.js";
import { toRootObjectJsonSchema, unwrapRootPayload } from "./root-object-schema.js";
import { withRetry, type RetryOptions } from "./retry.js";

const STRUCTURED_OUTPUT_TOOL_NAME = "emit_output";

/**
 * Output-token ceiling when a step doesn't set its own `maxTokens`.
 *
 * The previous 4096 silently broke every long-form agent: a blog draft ran
 * past it, the API returned `stop_reason: "max_tokens"` with a truncated
 * (literally empty) tool_use payload, and the step died on a confusing
 * "expected object" schema error far from the real cause. 16k comfortably
 * fits the longest output schema in this system while staying well under
 * Sonnet's own ceiling; a step needing more sets `maxTokens` explicitly.
 */
export const DEFAULT_MAX_TOKENS = 16384;

/**
 * Translates model ids between this codebase's canonical Claude API spelling
 * and one provider's own. Identity for the direct Anthropic route; a real
 * rewrite for Google Cloud's Agent Platform (see
 * `./agent-platform-model-ids.ts`).
 */
export interface ModelIdCodec {
  toProvider(canonicalModelId: string): string;
  toCanonical(providerModelId: string): string;
}

export const IDENTITY_MODEL_ID_CODEC: ModelIdCodec = {
  toProvider: (id) => id,
  toCanonical: (id) => id,
};

/** A client per canonical model id — Agent Platform bakes region into the client's base URL, so a per-model region pin means a second client, not a second argument. */
export type MessagesApiClientResolver = (canonicalModelId: string) => MessagesApiClient;

export interface MessagesApiAdapterOptions {
  providerId: string;
  client: MessagesApiClient | MessagesApiClientResolver;
  retryOptions?: RetryOptions;
  modelIds?: ModelIdCodec;
  /**
   * Whether to place a prompt-cache breakpoint on the stable prefix
   * (tools + system). Default true. `false` mirrors Anthropic's own
   * `DISABLE_PROMPT_CACHING` escape hatch, for isolating a caching-related
   * behaviour change during debugging.
   */
  promptCaching?: boolean;
}

/**
 * One structured-output call against the Anthropic Messages API, shared by
 * every route that speaks it — direct-to-Anthropic (`AnthropicAdapter`) and
 * Google Cloud's Agent Platform (`AgentPlatformAdapter`). The request shape
 * is identical on both; only the client, the model-id spelling, and the
 * `providerId` differ, which is exactly what this class takes as options.
 *
 * Structured output is forced via a single tool call whose input schema is
 * the step's own schema, since the Messages API has no separate
 * "response_format" mechanism the way OpenAI does.
 *
 * The Messages API requires that tool `input_schema` to have an object root —
 * a union root is rejected with `input_schema does not support oneOf, allOf,
 * or anyOf at the top level`. `BaseAgent` always hands down a discriminated
 * union (`tool_call` | `final`), so the conversion goes through
 * `toRootObjectJsonSchema`, which nests a non-object root under a single
 * property; `unwrapRootPayload` takes it back off before parsing.
 *
 * The client is constructor-injected so this is testable without a network
 * call, without an API key, and without GCP credentials. The API call itself
 * is wrapped in a bounded exponential-backoff retry (`RetryOptions`, default
 * 3 attempts) for transient 429/5xx/network failures — retrying the same
 * model, never swapping it, so this doesn't violate RFC-01 §5.4's "a pinned
 * step never silently swaps models" rule.
 */
export class MessagesApiAdapter implements ModelAdapter {
  readonly providerId: string;

  private readonly resolveClient: MessagesApiClientResolver;
  private readonly retryOptions: RetryOptions;
  private readonly modelIds: ModelIdCodec;
  private readonly promptCaching: boolean;

  constructor(options: MessagesApiAdapterOptions) {
    this.providerId = options.providerId;
    this.resolveClient = typeof options.client === "function" ? options.client : () => options.client as MessagesApiClient;
    this.retryOptions = options.retryOptions ?? {};
    this.modelIds = options.modelIds ?? IDENTITY_MODEL_ID_CODEC;
    this.promptCaching = options.promptCaching ?? true;
  }

  async complete<TOutput>(req: CompletionRequest<TOutput>): Promise<CompletionResult<TOutput>> {
    const { schema: jsonSchema, wrapped } = toRootObjectJsonSchema(req.schema);
    const providerModel = this.modelIds.toProvider(req.model);
    const client = this.resolveClient(req.model);
    const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;

    const response = await withRetry(
      () => client.messages.create(this.buildRequest(req, providerModel, maxTokens, jsonSchema)),
      this.retryOptions,
    );

    // A truncated response is not a partial answer — the structured output is
    // cut mid-JSON and unparseable. Say so precisely instead of surfacing the
    // downstream schema error, which points nowhere near the real problem.
    if (response.stop_reason === "max_tokens") {
      throw new Error(
        `${this.providerId}: model "${req.model}" hit the ${maxTokens}-token output limit before completing its structured output — ` +
          "raise the step's `maxTokens` (AgentStepConfig) or narrow its outputSchema",
      );
    }

    const toolUse = response.content.find(
      (block): block is Extract<Message["content"][number], { type: "tool_use" }> =>
        block.type === "tool_use" && block.name === STRUCTURED_OUTPUT_TOOL_NAME,
    );
    if (!toolUse) {
      throw new Error(`${this.providerId}: model "${req.model}" did not return a "${STRUCTURED_OUTPUT_TOOL_NAME}" tool_use block`);
    }

    const output = req.schema.parse(unwrapRootPayload(toolUse.input, wrapped));
    const usage = response.usage;

    // `input_tokens` counts neither cache reads nor cache *writes*. Cache
    // writes are real, billed input tokens (at a premium over the base rate),
    // so folding them into `uncached` under-reports their cost slightly —
    // dropping them, which is what happens if you read `input_tokens` alone,
    // under-reports it by 100%. `TokenUsage` has two fields, not three, and
    // widening it reaches every persisted `AgentStepTelemetry` record; the
    // approximation is the deliberate trade until it's worth that migration.
    const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;

    return {
      output,
      // Normalized back to canonical form — `computeStepCostUsd` looks this
      // up in `MODEL_PRICING`, and a provider-spelled miss falls back to
      // Sonnet's rate silently. See `./agent-platform-model-ids.ts`.
      modelUsed: this.modelIds.toCanonical(response.model),
      inputTokens: {
        cached: usage.cache_read_input_tokens ?? 0,
        uncached: usage.input_tokens + cacheWriteTokens,
      },
      outputTokens: usage.output_tokens,
    };
  }

  /**
   * The stable prefix of every turn in a step is `tools` + `system` (the
   * craft-policy skill body); only the user message accumulates. One
   * cache breakpoint on the *end* of that prefix therefore covers both —
   * and because the prefix is identical across every run of the same step,
   * it survives well beyond a single run.
   *
   * Placed on the system block when there is one (caching tools + system),
   * and on the tool otherwise (caching tools alone). Breakpoints below the
   * provider's minimum cacheable length are a silent no-op, never an error,
   * so a step with a short system prompt costs nothing extra.
   */
  private buildRequest<TOutput>(
    req: CompletionRequest<TOutput>,
    providerModel: string,
    maxTokens: number,
    jsonSchema: unknown,
  ): MessageCreateParamsNonStreaming {
    const cacheControl = { type: "ephemeral" } as const;
    const hasSystem = req.system !== undefined;
    const cacheOnSystem = this.promptCaching && hasSystem;
    const cacheOnTool = this.promptCaching && !hasSystem;

    const tool: Tool = {
      name: STRUCTURED_OUTPUT_TOOL_NAME,
      description: "Return the final structured output for this step.",
      input_schema: jsonSchema as Tool.InputSchema,
      ...(cacheOnTool ? { cache_control: cacheControl } : {}),
    };

    return {
      model: providerModel,
      max_tokens: maxTokens,
      ...(hasSystem
        ? {
            system: cacheOnSystem
              ? [{ type: "text" as const, text: req.system as string, cache_control: cacheControl }]
              : (req.system as string),
          }
        : {}),
      messages: [{ role: "user", content: req.prompt }],
      tools: [tool],
      tool_choice: { type: "tool", name: STRUCTURED_OUTPUT_TOOL_NAME },
    };
  }
}
