import type Anthropic from "@anthropic-ai/sdk";
import type { CompletionRequest, CompletionResult, ModelAdapter } from "./types.js";
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
const DEFAULT_MAX_TOKENS = 16384;

/**
 * Direct-to-Anthropic adapter for the `pinned` tier (RFC-01 §3, §5.4) —
 * cache-optimized, never routed through a gateway. Structured output is
 * forced via a single tool call whose input schema is the step's own schema,
 * since the Messages API has no separate "response_format" mechanism the way
 * OpenAI does.
 *
 * The Messages API requires that tool `input_schema` to have an object root —
 * a union root is rejected with `input_schema does not support oneOf, allOf,
 * or anyOf at the top level`. `BaseAgent` always hands down a discriminated
 * union (`tool_call` | `final`), so the conversion goes through
 * `toRootObjectJsonSchema`, which nests a non-object root under a single
 * property; `unwrapRootPayload` takes it back off before parsing.
 *
 * The client is constructor-injected so this adapter is testable without a
 * network call and without an API key. The API call itself is wrapped in a
 * bounded exponential-backoff retry (RetryOptions, default 3 attempts) for
 * transient 429/5xx/network failures — retrying the same pinned model, never
 * swapping it, so this doesn't violate §5.4's "a pinned step never silently
 * swaps models" rule.
 */
export class AnthropicAdapter implements ModelAdapter {
  readonly providerId = "anthropic";

  constructor(
    private readonly client: Anthropic,
    private readonly retryOptions: RetryOptions = {},
  ) {}

  async complete<TOutput>(req: CompletionRequest<TOutput>): Promise<CompletionResult<TOutput>> {
    const { schema: jsonSchema, wrapped } = toRootObjectJsonSchema(req.schema);

    const response = await withRetry(
      () =>
        this.client.messages.create({
          model: req.model,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(req.system !== undefined ? { system: req.system } : {}),
          messages: [{ role: "user", content: req.prompt }],
          tools: [
            {
              name: STRUCTURED_OUTPUT_TOOL_NAME,
              description: "Return the final structured output for this step.",
              input_schema: jsonSchema as unknown as Anthropic.Tool.InputSchema,
            },
          ],
          tool_choice: { type: "tool", name: STRUCTURED_OUTPUT_TOOL_NAME },
        }),
      this.retryOptions,
    );

    // A truncated response is not a partial answer — the structured output is
    // cut mid-JSON and unparseable. Say so precisely instead of surfacing the
    // downstream schema error, which points nowhere near the real problem.
    if (response.stop_reason === "max_tokens") {
      throw new Error(
        `AnthropicAdapter: model "${req.model}" hit the ${req.maxTokens ?? DEFAULT_MAX_TOKENS}-token output limit before completing its structured output — ` +
          "raise the step's `maxTokens` (AgentStepConfig) or narrow its outputSchema",
      );
    }

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === STRUCTURED_OUTPUT_TOOL_NAME,
    );
    if (!toolUse) {
      throw new Error(`AnthropicAdapter: model "${req.model}" did not return a "${STRUCTURED_OUTPUT_TOOL_NAME}" tool_use block`);
    }

    const output = req.schema.parse(unwrapRootPayload(toolUse.input, wrapped));
    const usage = response.usage;

    return {
      output,
      modelUsed: response.model,
      inputTokens: {
        cached: usage.cache_read_input_tokens ?? 0,
        uncached: usage.input_tokens,
      },
      outputTokens: usage.output_tokens,
    };
  }
}
