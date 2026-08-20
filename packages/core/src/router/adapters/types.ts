import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import type { ZodSchema } from "../../types/agent-step.js";

export interface CompletionRequest<TOutput> {
  prompt: string;
  schema: ZodSchema<TOutput>;
  model: string;
  system?: string;
  maxTokens?: number;
}

export interface CompletionResult<TOutput> {
  output: TOutput;
  modelUsed: string;
  inputTokens: { cached: number; uncached: number };
  outputTokens: number;
}

/**
 * A single backing model call, structured-output-forced via each provider's
 * own tool/schema mechanism. Adapters never decide tier or fallback — that's
 * `ModelRouter`'s job (RFC-01 §5.4) — they only execute one concrete model.
 */
export interface ModelAdapter {
  readonly providerId: string;
  complete<TOutput>(req: CompletionRequest<TOutput>): Promise<CompletionResult<TOutput>>;
}

/**
 * The narrow slice of the Anthropic Messages API an adapter actually calls.
 *
 * Expressed as a local structural interface rather than as the concrete
 * `Anthropic` class so that the *same* adapter code serves both routes to
 * the same models: `Anthropic` (direct) and `AnthropicVertex` (Google
 * Cloud's Agent Platform, formerly Vertex AI). `AnthropicVertex` is not
 * assignable to `Anthropic` — it extends `BaseAnthropic` and deliberately
 * omits the resources Agent Platform doesn't serve (`messages.batches`) —
 * but both satisfy this.
 *
 * Same discipline as `agent/gcp-types.ts`'s `FirestoreLike`: depend on the
 * narrowest shape the call site needs, never on a third-party class.
 */
export interface MessagesApiClient {
  messages: {
    create(body: MessageCreateParamsNonStreaming): Promise<Message>;
  };
}
