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
 * `modelUsed` alone cannot answer this: the primary and secondary Claude hops
 * return the SAME model id on different transports, so a deliverable produced
 * after a failover is indistinguishable from one produced normally. Nobody
 * holding a client report can currently tell which route generated it.
 */
export interface ModelProvenance {
  /** `primary` when nothing failed over — the overwhelmingly common case. */
  readonly hop: "primary" | "secondary" | "tertiary";
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
