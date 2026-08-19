import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { CompletionRequest, CompletionResult, ModelAdapter } from "./types.js";
import { withRetry, type RetryOptions } from "./retry.js";

const STRUCTURED_OUTPUT_TOOL_NAME = "emit_output";

/**
 * Direct-to-Anthropic adapter for the `pinned` tier (RFC-01 §3, §5.4) —
 * cache-optimized, never routed through a gateway. Structured output is
 * forced via a single tool call whose input schema is the step's own
 * `outputSchema` (converted with zod v4's native `z.toJSONSchema`), since the
 * Messages API has no separate "response_format" mechanism the way OpenAI
 * does. `outputSchema` must therefore be an object schema — the same
 * constraint any tool-input schema has.
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
    const jsonSchema = z.toJSONSchema(req.schema) as unknown as Anthropic.Tool.InputSchema;

    const response = await withRetry(
      () =>
        this.client.messages.create({
          model: req.model,
          max_tokens: req.maxTokens ?? 4096,
          ...(req.system !== undefined ? { system: req.system } : {}),
          messages: [{ role: "user", content: req.prompt }],
          tools: [
            {
              name: STRUCTURED_OUTPUT_TOOL_NAME,
              description: "Return the final structured output for this step.",
              input_schema: jsonSchema,
            },
          ],
          tool_choice: { type: "tool", name: STRUCTURED_OUTPUT_TOOL_NAME },
        }),
      this.retryOptions,
    );

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === STRUCTURED_OUTPUT_TOOL_NAME,
    );
    if (!toolUse) {
      throw new Error(`AnthropicAdapter: model "${req.model}" did not return a "${STRUCTURED_OUTPUT_TOOL_NAME}" tool_use block`);
    }

    const output = req.schema.parse(toolUse.input);
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
