import { extractHttpStatus } from "./retry.js";
import type { CompletionRequest, CompletionResult, ModelAdapter } from "./types.js";

/**
 * A 429 (quota exhausted) or 404 (model/region not served) from a transport
 * that already ran its own internal `withRetry` (every `ModelAdapter` in
 * this package does) means retrying that SAME transport again would just
 * fail the same way a third time — the only thing worth trying next is a
 * DIFFERENT transport. Any other error (a schema the model can't satisfy, a
 * genuine 4xx auth/request problem) is a real failure, not a routing
 * problem, and must propagate as-is.
 */
function isFailoverWorthy(err: unknown): boolean {
  const status = extractHttpStatus(err);
  return status === 429 || status === 404;
}

export interface ResilientClaudeAdapterOptions {
  /** Vertex AI Model Garden / Agent Platform — the default ADC-only route. */
  primary: ModelAdapter;
  /** Direct Anthropic API (`ANTHROPIC_API_KEY`) — tried on a 429/404 from `primary`. Same model id, different transport. */
  secondary?: ModelAdapter;
  /**
   * Vertex AI Gemini — the last-resort fallback once BOTH Claude routes are
   * exhausted. A genuinely different model family, unlike the primary/
   * secondary hop above: `tertiaryModel` is sent instead of `req.model`
   * (asking Gemini to serve a Claude model id would just be a third,
   * differently-shaped failure).
   */
  tertiary?: ModelAdapter;
  tertiaryModel?: string;
}

/**
 * Wraps the `anthropic` vendor's own adapter(s) with a dual-layer transport
 * fallback: Vertex AI Model Garden primary, direct Anthropic API on a
 * 429/404, Vertex AI Gemini as an absolute last resort. Lives entirely
 * inside the single `anthropic` `ModelAdapter` slot `create-model-router-
 * from-env.ts` builds — `ModelPolicy`, `DefaultModelRouter`, and every
 * step's own `vendor`/`model` selection are unaware this exists.
 *
 * This does not weaken RFC-01 §5.4's "a pinned step never silently swaps
 * models" guarantee: the primary->secondary hop is the SAME model id on a
 * different transport (Vertex is explicitly "a second route to the same
 * pinned models", not a fourth tier — see `ClaudeRoute`'s own doc comment).
 * Only the secondary->tertiary hop changes model identity, and only after
 * every same-model option has already failed.
 */
export class ResilientClaudeAdapter implements ModelAdapter {
  readonly providerId = "anthropic-resilient";

  constructor(private readonly options: ResilientClaudeAdapterOptions) {}

  async complete<TOutput>(req: CompletionRequest<TOutput>): Promise<CompletionResult<TOutput>> {
    try {
      return await this.options.primary.complete(req);
    } catch (primaryErr) {
      if (!this.options.secondary || !isFailoverWorthy(primaryErr)) throw primaryErr;

      try {
        return await this.options.secondary.complete(req);
      } catch (secondaryErr) {
        if (!this.options.tertiary || !isFailoverWorthy(secondaryErr)) throw secondaryErr;
        return await this.options.tertiary.complete({ ...req, model: this.options.tertiaryModel ?? req.model });
      }
    }
  }
}
