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
