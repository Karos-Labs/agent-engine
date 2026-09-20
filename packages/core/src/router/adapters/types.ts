import type { Message, MessageCreateParamsNonStreaming, MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages";
import type { ZodSchema } from "../../types/agent-step.js";

export interface CompletionRequest<TOutput> {
  prompt: string;
  schema: ZodSchema<TOutput>;
  model: string;
  system?: string;
  maxTokens?: number;
  /**
   * A ceiling on the model's INTERNAL REASONING, in tokens, for models that
   * bill it as output.
   *
   * ## The run that made this necessary
   *
   * `06-vet-images` on `pubsub-21905062348134898` (2026-09-20) billed 9,757,
   * 24,895 and 42,873 output tokens across three attempts, on a job whose
   * ANSWER was four selections and 3,232 characters of JSON -- about 800
   * tokens. Roughly 98% of the third call was reasoning. The vetting alone
   * came to $1.30 of a $2.17 run against a $1.00 target.
   *
   * The input was already cached (2,201 and 2,370 UNCACHED tokens on attempts
   * 2 and 3), so the intuitive fix -- stop re-sending candidates the vet has
   * already scored -- would have saved almost nothing. The pool was never the
   * cost.
   *
   * Only adapters whose provider exposes such a control read it; the rest
   * ignore it, which is why it is optional rather than a required field with
   * a sentinel. `gemini-adapter` maps it to `thinkingConfig.thinkingBudget`.
   *
   * It is NOT `maxTokens`. On Gemini thoughts count against `maxOutputTokens`
   * as well, so a shared ceiling forces a choice between room to think and
   * room to answer -- which is how `04b-research-extract-facts` truncated on
   * geektime with only 3,059 visible tokens returned. Two ceilings, two jobs.
   */
  thinkingBudget?: number;
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
    /**
     * The streaming route, used in preference to `create` whenever a client
     * provides one — which every real one does (both `Anthropic` and
     * `AnthropicVertex` expose `messages.stream`).
     *
     * Optional ONLY so a hand-written test double may implement `create`
     * alone; it is not an optional capability in production. The SDK refuses a
     * non-streaming request outright, before sending anything, when
     * `max_tokens` is high enough that the response could take more than ten
     * minutes — `intel-report-agent` asks for 32k and so failed 100% of the
     * time, in 4ms, for zero tokens and zero cost, with "Streaming is required
     * for operations that may take longer than 10 minutes".
     *
     * `finalMessage()` resolves to the identical `Message` `create` returns,
     * which is what lets one adapter body serve both.
     */
    stream?(body: MessageCreateParamsStreaming): { finalMessage(): Promise<Message> };
  };
}
