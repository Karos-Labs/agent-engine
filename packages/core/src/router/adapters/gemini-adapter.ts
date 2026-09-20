import { FinishReason, GoogleGenAI } from "@google/genai";
import type { CompletionRequest, CompletionResult, ModelAdapter } from "./types.js";
import { toRootObjectJsonSchema } from "./root-object-schema.js";
// `OutputLimitExceededError` is ONE type across every route on purpose:
// `BaseAgent` discriminates on it both to raise the ceiling and to book a
// cut-off turn's spend, and a per-adapter copy would mean the Gemini leg
// silently kept reporting $0 the day the Anthropic leg was fixed.
import { OutputLimitExceededError, parseStructuredOutput, parseStructuredOutputText } from "./structured-output.js";
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
  /**
   * Overrides `providerId` for a second instance of this adapter pointed at a
   * different Google backend. Defaults to `"google-gemini"`, which is what
   * every existing caller gets.
   *
   * It exists because `providerId` is what a failover log line and a step's
   * `servedBy.adapter` field are made of, and `ResilientGeminiAdapter` puts
   * two `GeminiAdapter`s in one chain: without this, a Vertex-to-direct
   * failover would record `google-gemini -> google-gemini`, which names the
   * hop that happened and tells an operator nothing about WHICH transport is
   * now serving the run.
   */
  providerId?: string;
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
  readonly providerId: string;

  private readonly resolveClient: GeminiClientResolver;
  private readonly retryOptions: RetryOptions;

  constructor(options: GeminiAdapterOptions) {
    this.resolveClient = typeof options.client === "function" ? options.client : () => options.client as GoogleGenAI;
    this.retryOptions = options.retryOptions ?? {};
    this.providerId = options.providerId ?? "google-gemini";
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
            // Bounds the reasoning this model bills as output. See
            // `CompletionRequest.thinkingBudget` for the run that made it
            // necessary: a vet whose answer was 800 tokens billed 42,873.
            // Absent means unbounded, which is the behaviour every caller had
            // before this field existed.
            ...(req.thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: req.thinkingBudget } } : {}),
          },
        }),
      this.retryOptions,
    );

    const finishReason = response.candidates?.[0]?.finishReason;

    const usage = response.usageMetadata;
    const cached = usage?.cachedContentTokenCount ?? 0;
    const prompt_ = usage?.promptTokenCount ?? 0;

    // Resolved before ANY failure branch below, so a turn that fails still
    // reports its real spend rather than the zeros a post-validation read
    // leaves behind. Ordering is the whole mechanism here — see the sibling
    // comment in `messages-api-adapter.ts`.
    //
    // `candidatesTokenCount` excludes `thoughtsTokenCount`, and thinking
    // tokens are billed at the same output rate AND count against
    // `maxOutputTokens` — which is how `04b-research-extract-facts` truncated
    // on geektime (prep run pubsub-21868533047825082) while its three
    // successful siblings returned only 3,059-3,263 visible output tokens on
    // 65k-76k of input. Folding thoughts in is what makes the reported figure
    // match the invoice on a thinking model, and it is also the only evidence
    // a future truncation leaves behind.
    const reportedUsage = {
      modelUsed: req.model,
      inputTokens: { cached, uncached: Math.max(prompt_ - cached, 0) },
      outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    };

    // Mirrors every other adapter's truncation handling: a cut-off response
    // is not a partial answer, the JSON is unparseable mid-object, and the
    // schema-violation error this would otherwise surface points nowhere
    // near the real cause. Typed so `BaseAgent` can re-ask with more room
    // instead of ending the step on a ceiling it is allowed to raise — and
    // carrying the usage of the truncated attempt, which is a full ceiling's
    // worth of output tokens and was previously recorded as zero.
    //
    // It carries `reportedUsage` rather than re-reading `usageMetadata` here,
    // because only `reportedUsage` folds `thoughtsTokenCount` in — and a
    // thinking model that truncates spent most of the ceiling on thoughts, so
    // a branch that re-derived the usage locally would under-report exactly the
    // call it exists to account for.
    if (finishReason === FinishReason.MAX_TOKENS) {
      throw new OutputLimitExceededError(
        `google-gemini: model "${req.model}" hit the ${maxOutputTokens}-token output limit before completing its structured output`,
        { attemptedMaxTokens: maxOutputTokens, usage: reportedUsage },
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

    const parseContext = { providerId: "google-gemini", model: req.model, usage: reportedUsage };

    const output = parseStructuredOutput(req.schema, parseStructuredOutputText(raw, parseContext), wrapped, parseContext);

    return { output, ...reportedUsage };
  }
}

/**
 * The Gemini Developer API (`GEMINI_API_KEY`) as a SECOND TRANSPORT to the
 * same models — not as a route.
 *
 * AU59 (SCRUM-358) deleted the `new GoogleGenAI({ apiKey })` construction
 * from `create-model-router-from-env.ts` along with the whole direct model
 * route, and that decision is not reopened here: `GEMINI_ROUTE=direct` still
 * builds no vendor adapter, and `vertex-only-router.test.ts` still pins that.
 * What AU59 left behind is a different, narrower gap — the Vertex route is
 * now the ONLY way a Gemini step can be served, so one infrastructure fault
 * on it takes every Gemini step in the engine with it. On 2026-09-13/14 a
 * Vertex 403 (`Lightning dunning decision is deny for project`) did exactly
 * that: research extraction and image vetting both died, the run shipped
 * all-typographic, and the human gate approved it.
 *
 * Claude has had the symmetric answer since AU61 — Agent Platform primary,
 * direct Anthropic API on a 429/404/403 (`ResilientClaudeAdapter`). This is
 * the factory that lets `ResilientGeminiAdapter` do the same for Gemini. It
 * is deliberately here, in the adapter's own module, rather than back in
 * `create-model-router-from-env.ts`: a failover transport and a selectable
 * route are different things, and putting the construction back where AU59
 * removed it would be an invitation to re-wire it as a route by accident.
 *
 * Model ids need no translation between the two backends (see the class
 * comment above), so the SAME `req.model` is sent on both — this hop never
 * changes model identity, exactly like Claude's primary->secondary hop, and
 * so does not weaken RFC-01 §5.4's "a pinned step never silently swaps
 * models".
 */
export function createDirectGeminiAdapter(apiKey: string, options: { retryOptions?: RetryOptions } = {}): ModelAdapter {
  if (apiKey.trim() === "") {
    throw new Error("createDirectGeminiAdapter: GEMINI_API_KEY is empty — pass a key or leave the failover transport unconfigured");
  }
  const client = new GoogleGenAI({ apiKey });
  return new GeminiAdapter({
    client,
    providerId: "google-gemini-direct",
    ...(options.retryOptions !== undefined ? { retryOptions: options.retryOptions } : {}),
  });
}
