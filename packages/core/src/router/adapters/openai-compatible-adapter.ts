import type OpenAI from "openai";
import type { CompletionRequest, CompletionResult, ModelAdapter } from "./types.js";
import { toRootObjectJsonSchema, unwrapRootPayload } from "./root-object-schema.js";
import { withRetry, type RetryOptions } from "./retry.js";

/**
 * A client per canonical model id, mirroring `MessagesApiAdapter`'s
 * `MessagesApiClientResolver` — needed by the `model-garden` vendor, whose
 * Model-as-a-Service endpoint bakes a GCP region into the client's base URL
 * (`vertex-model-garden-client.ts`), so a per-model region pin means a
 * second client, not a second argument. The plain `openai-compatible`
 * vendor (a single external gateway/API) just passes one static client.
 */
export type OpenAIClientResolver = (canonicalModelId: string) => OpenAI;

/**
 * Adapter for any OpenAI-compatible chat-completions endpoint — the real
 * OpenAI API, a self-hosted LiteLLM gateway (`openai-compatible` vendor), or
 * Agent Platform's own Model-as-a-Service endpoint for Model Garden partner
 * models (`model-garden` vendor — RFC-01 §3, §5.4, and
 * `vertex-model-garden-client.ts`). Every one of these speaks the identical
 * Chat Completions wire shape, which is the entire reason one adapter class
 * covers all three; what differs between them is only which client
 * constructed it and how that client authenticates — a vendor concern
 * decided in `create-model-router-from-env.ts`, never in here.
 *
 * Structured output uses `response_format: json_schema` (native OpenAI
 * Structured Outputs, which both LiteLLM and Agent Platform's
 * OpenAI-compatible endpoint also proxy). Structured Outputs requires the
 * schema root to be an object, so the conversion goes through the same
 * `toRootObjectJsonSchema` every adapter in this system uses — see that
 * helper for why `BaseAgent`'s turn schema needs it.
 */
export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly providerId: string;

  private readonly resolveClient: OpenAIClientResolver;
  private readonly retryOptions: RetryOptions;

  constructor(client: OpenAI | OpenAIClientResolver, providerId = "openai", retryOptions: RetryOptions = {}) {
    this.providerId = providerId;
    this.resolveClient = typeof client === "function" ? client : () => client;
    this.retryOptions = retryOptions;
  }

  async complete<TOutput>(req: CompletionRequest<TOutput>): Promise<CompletionResult<TOutput>> {
    const { schema: jsonSchema, wrapped } = toRootObjectJsonSchema(req.schema);
    const client = this.resolveClient(req.model);

    const response = await withRetry(
      () =>
        client.chat.completions.create({
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
        }),
      this.retryOptions,
    );

    const choice = response.choices[0];
    const raw = choice?.message.content;
    if (!raw) {
      throw new Error(`${this.providerId}: model "${req.model}" returned no message content`);
    }

    const output = req.schema.parse(unwrapRootPayload(JSON.parse(raw), wrapped));
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
