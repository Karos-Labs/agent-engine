import { FinishReason, type GoogleGenAI } from "@google/genai";
import type { CompletionRequest, CompletionResult, ModelAdapter } from "./types.js";
import { toRootObjectJsonSchema, unwrapRootPayload } from "./root-object-schema.js";
import { withRetry, type RetryOptions } from "./retry.js";

/**
 * Output-token ceiling when a step doesn't set its own `maxTokens`. Same
 * value as the Anthropic-route default (`messages-api-adapter.ts`) for the
 * same reason: comfortably fits this system's longest output schema while
 * staying well under any served model's own ceiling.
 */
export const GEMINI_DEFAULT_MAX_TOKENS = 16384;

/**
 * A client per canonical model id. Needed for the same reason
 * `AgentPlatformAdapter` keys Claude's client by region: Gemini on Vertex
 * bakes location into the client's request path, and not every Gemini model
 * is served on every location — a per-model region pin means a second
 * client, not a second argument. For the direct Gemini Developer API route
 * (no Vertex, no region) every model id resolves to the same client.
 */
export type GeminiClientResolver = (canonicalModelId: string) => GoogleGenAI;

export interface GeminiAdapterOptions {
  client: GoogleGenAI | GeminiClientResolver;
  retryOptions?: RetryOptions;
}

/**
 * Google's Gemini models — reached either via Agent Platform (Vertex AI
 * backend, ADC) or the direct Gemini Developer API (`GEMINI_API_KEY`),
 * per `GEMINI_ROUTE` in `../create-model-router-from-env.ts`. Both routes
 * share this one adapter: the `@google/genai` SDK exposes an identical
 * `generateContent` call shape regardless of which backend `GoogleGenAI` was
 * constructed against (`vertexai: true` vs `apiKey`) — the route decision
 * lives entirely in how the client passed in here was built, never in this
 * class.
 *
 * Unlike Claude's Agent Platform route, Gemini model ids need **no**
 * translation between the two backends — `gemini-2.5-pro` is the same
 * string on the Developer API and on Vertex, so `modelUsed` is reported
 * as-is and resolves directly against `telemetry/pricing.ts`'s existing
 * `gemini-2.5-pro`/`gemini-2.5-flash` rows.
 *
 * Structured output uses `responseMimeType: "application/json"` plus
 * `responseJsonSchema` — Gemini's one JSON Schema-native structured-output
 * mechanism (as opposed to `responseSchema`, which wants Gemini's own
 * OpenAPI-3.0-subset `Schema` type instead of a JSON Schema object; the
 * SDK's own doc comment on `responseSchema` says to reach for
 * `responseJsonSchema` when the two don't align, so this adapter always
 * does). Gemini's JSON mode still delivers that JSON as a text part —
 * there is no separate tool-call-shaped return the way Anthropic/OpenAI
 * structured output works — so `response.text` is parsed directly. The
 * request goes through the same object-root wrapping every adapter in this
 * system uses (`toRootObjectJsonSchema`) for uniformity, even though
 * `responseJsonSchema` can in fact accept a union (`anyOf`/`oneOf`) root
 * unlike the other two providers — consistency here is worth more than
 * exploiting one provider's looser rule.
 */
export class GeminiAdapter implements ModelAdapter {
  readonly providerId = "google-gemini";

  private readonly resolveClient: GeminiClientResolver;
  private readonly retryOptions: RetryOptions;

  constructor(options: GeminiAdapterOptions) {
    this.resolveClient = typeof options.client === "function" ? options.client : () => options.client as GoogleGenAI;
    this.retryOptions = options.retryOptions ?? {};
  }

  async complete<TOutput>(req: CompletionRequest<TOutput>): Promise<CompletionResult<TOutput>> {
    const { schema: jsonSchema, wrapped } = toRootObjectJsonSchema(req.schema);
    const client = this.resolveClient(req.model);
    const maxOutputTokens = req.maxTokens ?? GEMINI_DEFAULT_MAX_TOKENS;

    const response = await withRetry(
      () =>
        client.models.generateContent({
          model: req.model,
          contents: req.prompt,
          config: {
            ...(req.system !== undefined ? { systemInstruction: req.system } : {}),
            responseMimeType: "application/json",
            responseJsonSchema: jsonSchema,
            maxOutputTokens,
          },
        }),
      this.retryOptions,
    );

    // Mirrors every other adapter's truncation handling: a cut-off response
    // is not a partial answer, the JSON is unparseable mid-object, and the
    // schema-violation error this would otherwise surface points nowhere
    // near the real cause.
    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason === FinishReason.MAX_TOKENS) {
      throw new Error(
        `google-gemini: model "${req.model}" hit the ${maxOutputTokens}-token output limit before completing its structured output — ` +
          "raise the step's `maxTokens` (AgentStepConfig) or narrow its outputSchema",
      );
    }

    const raw = response.text;
    if (raw === undefined) {
      const blockReason = response.promptFeedback?.blockReason;
      throw new Error(
        `google-gemini: model "${req.model}" returned no text content` +
          (blockReason ? ` — blocked: ${blockReason}` : finishReason ? ` — finishReason: ${finishReason}` : ""),
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new Error(`google-gemini: model "${req.model}" returned non-JSON text despite responseMimeType=application/json: ${raw.slice(0, 200)}`);
    }

    const output = req.schema.parse(unwrapRootPayload(parsedJson, wrapped));
    const usage = response.usageMetadata;
    const cached = usage?.cachedContentTokenCount ?? 0;
    const prompt_ = usage?.promptTokenCount ?? 0;

    return {
      output,
      modelUsed: req.model,
      inputTokens: { cached, uncached: Math.max(prompt_ - cached, 0) },
      outputTokens: usage?.candidatesTokenCount ?? 0,
    };
  }
}
