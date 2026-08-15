import { z } from "zod";
import type OpenAI from "openai";
import type { CompletionRequest, CompletionResult, ModelAdapter } from "./types.js";

/**
 * Adapter for any OpenAI-compatible chat-completions endpoint — the real
 * OpenAI API, or a self-hosted LiteLLM gateway fronting DeepSeek/Qwen/etc
 * (RFC-01 §3, §5.4). LiteLLM's whole point is exposing that same
 * OpenAI-shaped endpoint, so one adapter covers both the `portable` and
 * `commodity` tiers — point `client.baseURL` at the gateway for either.
 *
 * Structured output uses `response_format: json_schema` (native OpenAI
 * Structured Outputs, which LiteLLM also proxies), converting the step's
 * `outputSchema` with zod v4's `z.toJSONSchema`.
 */
export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly providerId: string;

  constructor(
    private readonly client: OpenAI,
    providerId = "openai",
  ) {
    this.providerId = providerId;
  }

  async complete<TOutput>(req: CompletionRequest<TOutput>): Promise<CompletionResult<TOutput>> {
    const jsonSchema = z.toJSONSchema(req.schema);

    const response = await this.client.chat.completions.create({
      model: req.model,
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      messages: [
        ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
        { role: "user" as const, content: req.prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "step_output", schema: jsonSchema, strict: true },
      },
    });

    const choice = response.choices[0];
    const raw = choice?.message.content;
    if (!raw) {
      throw new Error(`OpenAICompatibleAdapter: model "${req.model}" returned no message content`);
    }

    const output = req.schema.parse(JSON.parse(raw));
    const usage = response.usage;
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;

    return {
      output,
      modelUsed: response.model,
      inputTokens: {
        cached,
        uncached: (usage?.prompt_tokens ?? 0) - cached,
      },
      outputTokens: usage?.completion_tokens ?? 0,
    };
  }
}
