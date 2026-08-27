import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import type { ZodSchema } from "../../types/agent-step.js";

export interface CompletionRequest<TOutput> {
  prompt: string;
  schema: ZodSchema<TOutput>;
  model: string;
  system?: string;
  maxTokens?: number;
}

/**
 * Which hop of a fallback chain actually served a completion (AU61 /
 * SCRUM-360).
 *
 * `modelUsed` alone was never enough. Before SCRUM-358 that was because the
 * primary and secondary Claude hops returned the SAME model id on different
 * transports. Now it is the opposite problem and a worse one: the only
 * remaining fallback serves a DIFFERENT model family, so `modelUsed` changes
 * under you with nothing to say why.
 *
 * `"secondary"` is absent here on purpose. Nothing can produce it any more —
 * SCRUM-358 deleted the direct-Anthropic hop — so the PRODUCER type refuses
 * to name it. The persisted READER type
 * (`AgentStepTelemetrySchema.servedBy.hop`) still accepts all three, because
 * step records written before that deletion exist and must stay readable.
 * Narrow what you write, keep wide what you read.
 */
export interface ModelProvenance {
  /** `primary` when nothing failed over — the overwhelmingly common case. */
  readonly hop: "primary" | "tertiary";
  /** The adapter that answered, e.g. `agent-platform`, `anthropic`, `gemini`. */
  readonly servedBy: string;
  /** Each hop that failed before this one, in order, with why. */
  readonly failedOver: readonly { readonly from: string; readonly errorClass: string; readonly status?: number }[];
}

export interface CompletionResult<TOutput> {
  output: TOutput;
  modelUsed: string;
  inputTokens: { cached: number; uncached: number };
  outputTokens: number;
  /**
   * Optional so every adapter that never falls over is unchanged. Set by
   * `ResilientClaudeAdapter`; absent means "served directly, no chain".
   */
  provenance?: ModelProvenance;
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
