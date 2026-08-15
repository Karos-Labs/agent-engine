import type { ZodSchema } from "../types/agent-step.js";
import type { ModelPolicy, ProviderPolicy } from "../types/model-policy.js";
import type { ModelAlias } from "./aliases.js";
import { resolveModelAlias } from "./aliases.js";
import type { CompletionRequest, CompletionResult, ModelAdapter } from "./adapters/types.js";

export interface RouterCompleteOptions {
  system?: string;
  maxTokens?: number;
}

/** One `ModelAdapter` per tier (RFC-01 §5.4) — the same adapter instance may back more than one tier. */
export interface ModelRouterAdapters {
  pinned: ModelAdapter;
  portable: ModelAdapter;
  commodity: ModelAdapter;
}

/**
 * `llm.complete(prompt, schema, tier)` from RFC-01 §5.4: no tool, workflow,
 * or agent ever hardcodes a provider — it declares a `ModelPolicy` (its tier
 * plus a concrete model) and the router resolves the rest.
 */
export interface ModelRouter {
  complete<TOutput>(
    prompt: string,
    schema: ZodSchema<TOutput>,
    policy: ModelPolicy,
    opts?: RouterCompleteOptions,
  ): Promise<CompletionResult<TOutput>>;

  /** Resolves a Dynamic Agent Studio alias (RFC-01 §7.3) before delegating to `complete`. */
  completeAlias<TOutput>(
    prompt: string,
    schema: ZodSchema<TOutput>,
    alias: ModelAlias,
    opts?: RouterCompleteOptions,
  ): Promise<CompletionResult<TOutput>>;
}

export class DefaultModelRouter implements ModelRouter {
  constructor(private readonly adapters: ModelRouterAdapters) {}

  private adapterForTier(tier: ProviderPolicy): ModelAdapter {
    return this.adapters[tier];
  }

  async complete<TOutput>(
    prompt: string,
    schema: ZodSchema<TOutput>,
    policy: ModelPolicy,
    opts?: RouterCompleteOptions,
  ): Promise<CompletionResult<TOutput>> {
    const adapter = this.adapterForTier(policy.policy);
    const baseReq: CompletionRequest<TOutput> = {
      prompt,
      schema,
      model: policy.model,
      ...(opts?.system !== undefined ? { system: opts.system } : {}),
      ...(opts?.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    };

    if (policy.policy === "pinned") {
      // A pinned step never silently swaps models, even if a fallback were present.
      return adapter.complete(baseReq);
    }

    try {
      return await adapter.complete(baseReq);
    } catch (err) {
      if (!policy.fallbackModel) {
        throw err;
      }
      return adapter.complete({ ...baseReq, model: policy.fallbackModel });
    }
  }

  completeAlias<TOutput>(
    prompt: string,
    schema: ZodSchema<TOutput>,
    alias: ModelAlias,
    opts?: RouterCompleteOptions,
  ): Promise<CompletionResult<TOutput>> {
    return this.complete(prompt, schema, resolveModelAlias(alias), opts);
  }
}
