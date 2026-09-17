import type { Message, MessageCreateParamsNonStreaming, Tool } from "@anthropic-ai/sdk/resources/messages";
import type { CompletionRequest, CompletionResult, MessagesApiClient, ModelAdapter } from "./types.js";
import { toRootObjectJsonSchema } from "./root-object-schema.js";
import { OutputLimitExceededError, parseStructuredOutput } from "./structured-output.js";
import { withRetry, type RetryOptions } from "./retry.js";

const STRUCTURED_OUTPUT_TOOL_NAME = "emit_output";

// A turn the provider cut off at the output ceiling is `OutputLimitExceededError`
// (`./structured-output.js`), which carries the provider's own usage resolved
// BEFORE the throw. Phase 5.5 reached the same defect from the Instagram side —
// across the six prep runs of 2026-09-16, seventeen truncated calls booked
// `costUsd: 0` for turns that had spent their entire output budget, ≈$0.57 a run
// the meter could not see — and proposed a second error type for it. One type
// that both carries the spend and lets `BaseAgent` re-ask with a raised ceiling
// is strictly better than two that each do half, so there is only the one.

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
 * property; `parseStructuredOutput` takes it back off before validating, and
 * turns any shape mismatch into a repairable `StructuredOutputValidationError`
 * rather than a fatal one.
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

    const request = this.buildRequest(req, providerModel, maxTokens, jsonSchema);

    // STREAM WHENEVER THE CLIENT CAN, which in production is always.
    //
    // The SDK refuses a non-streaming request outright — client-side, before
    // a byte leaves the process — once `max_tokens` is high enough that the
    // response could run past ten minutes. `intel-report-agent` asks for 32k
    // (`INTEL_REPORT_DRAFT_MAX_TOKENS`, sized deliberately in that agent's own
    // comment), so every single one of its runs died in ~4ms for zero tokens
    // and zero cost with "Streaming is required for operations that may take
    // longer than 10 minutes" — a `tooling_error` that looked like a tool
    // problem and was really this line.
    //
    // Streaming unconditionally rather than above some `max_tokens` threshold:
    // the threshold is the SDK's, it is vendor- and model-dependent, and a
    // copy of it here would be a second place to get it wrong. It also retires
    // the same class of failure the portal already hit from the other side —
    // see `karosCMO`'s deleted Phase A, which used `streamText` and not
    // `generateText` because a long non-streaming turn blew undici's
    // five-minute headers timeout.
    //
    // `finalMessage()` resolves to the same `Message` `create` returns, so
    // everything below this line is unchanged and unaware.
    const send = client.messages.stream
      ? () => client.messages.stream!({ ...request, stream: true }).finalMessage()
      : () => client.messages.create(request);

    const response = await withRetry(send, this.retryOptions);

    const usage = response.usage;

    // `input_tokens` counts neither cache reads nor cache *writes*. Cache
    // writes are real, billed input tokens at 1.25x the base rate: they are
    // folded into `uncached` (base rate) AND reported as `cacheWrite`, from
    // which `computeStepCostUsd` adds the premium. Until 2026-09-08 only the
    // fold happened, and every step's first turn understated its input by
    // the premium on its whole system prompt and tool list.
    const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;

    // Resolved before the payload is inspected, not after, so a malformed OR
    // truncated turn still reports what it actually burned. Reading usage only
    // on the success path is what made every schema failure record 0 tokens
    // and $0 — the one number that would have shown these turns are neither
    // free nor cheap. A turn that hit its ceiling burned every output token of
    // that ceiling, so it is the most expensive failure of the lot.
    //
    // Every branch that can throw sits BELOW this line; adding a new one above
    // it would put the hole straight back.
    const reportedUsage = {
      // Normalized back to canonical form — `computeStepCostUsd` looks this
      // up in `MODEL_PRICING`, and a provider-spelled miss now throws rather
      // than silently falling back to Sonnet's rate. See `./agent-platform-model-ids.ts`.
      modelUsed: this.modelIds.toCanonical(response.model),
      inputTokens: {
        cached: usage.cache_read_input_tokens ?? 0,
        uncached: usage.input_tokens + cacheWriteTokens,
        ...(cacheWriteTokens > 0 ? { cacheWrite: cacheWriteTokens } : {}),
      },
      outputTokens: usage.output_tokens,
    };

    // A truncated response is not a partial answer — the structured output is
    // cut mid-JSON and unparseable. Say so precisely instead of surfacing the
    // downstream schema error, which points nowhere near the real problem, and
    // say it in a type `BaseAgent` can act on: this is the one failure whose
    // fix is knowable from the failure itself, so it is re-asked with a raised
    // ceiling rather than reported to a human who will read it next week. The
    // error carries `reportedUsage`, so the step books the ~$0.32 an exhausted
    // 16k ceiling on Sonnet actually costs instead of $0.
    if (response.stop_reason === "max_tokens") {
      throw new OutputLimitExceededError(
        `${this.providerId}: model "${req.model}" hit the ${maxTokens}-token output limit before completing its structured output` +
          describeTruncatedFields(response.content),
        { attemptedMaxTokens: maxTokens, usage: reportedUsage },
      );
    }

    const toolUse = response.content.find(
      (block): block is Extract<Message["content"][number], { type: "tool_use" }> =>
        block.type === "tool_use" && block.name === STRUCTURED_OUTPUT_TOOL_NAME,
    );
    if (!toolUse) {
      throw new Error(`${this.providerId}: model "${req.model}" did not return a "${STRUCTURED_OUTPUT_TOOL_NAME}" tool_use block`);
    }

    const output = parseStructuredOutput(req.schema, toolUse.input, wrapped, {
      providerId: this.providerId,
      model: req.model,
      usage: reportedUsage,
    });

    return { output, ...reportedUsage };
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

/**
 * Which fields the model had actually written when the budget ran out, and
 * how big each one had got.
 *
 * A truncation used to report only the ceiling it hit, which says nothing
 * about whether the answer was genuinely too large or the model was rambling
 * into a field nobody reads. Those need opposite fixes — more room versus
 * less prose — and telling them apart the first time took a Firestore query
 * against a *succeeding* run (`05-write-copy-attempt-1`, prep
 * pubsub-21868183257380937: 50,520 characters of `thought` against 8,348
 * characters of delivered post). This puts that measurement in the error
 * itself, so the next one is a read rather than an investigation.
 *
 * Partial input is best-effort by nature: the SDK's streaming accumulator
 * leaves whatever parsed, and a field cut mid-string may be missing entirely.
 * An empty or unreadable accumulator therefore adds nothing to the message
 * rather than guessing — a diagnostic must never be the thing that throws.
 */
function describeTruncatedFields(content: Message["content"]): string {
  try {
    const toolUse = content.find(
      (block): block is Extract<Message["content"][number], { type: "tool_use" }> =>
        block.type === "tool_use" && block.name === STRUCTURED_OUTPUT_TOOL_NAME,
    );
    const root = toolUse?.input;
    if (typeof root !== "object" || root === null) return "";
    // `toRootObjectJsonSchema` nests the turn under `turn` for a wrapped
    // schema; unwrap it here so the fields named are the turn's own.
    const record = root as Record<string, unknown>;
    const turn = typeof record["turn"] === "object" && record["turn"] !== null ? (record["turn"] as Record<string, unknown>) : record;
    const sizes = Object.entries(turn)
      .map(([key, value]) => [key, typeof value === "string" ? value.length : JSON.stringify(value)?.length] as const)
      .filter((entry): entry is readonly [string, number] => typeof entry[1] === "number" && entry[1] > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([key, chars]) => `${key} ${chars} chars`);
    return sizes.length > 0 ? ` — written when it ran out: ${sizes.join(", ")}` : "";
  } catch {
    return "";
  }
}
