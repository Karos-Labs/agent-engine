import type { ZodSchema } from "../types/agent-step.js";
import type { ModelPolicy } from "../types/model-policy.js";
import { resolveModelVendor, type ModelVendor } from "../types/model-policy.js";
import type { ModelAlias } from "./aliases.js";
import { resolveModelAlias } from "./aliases.js";
import type { CompletionRequest, CompletionResult, ModelAdapter } from "./adapters/types.js";

export interface RouterCompleteOptions {
  system?: string;
  maxTokens?: number;
}

/**
 * One `ModelAdapter` per vendor (`ModelVendor`, `types/model-policy.ts`) —
 * the same adapter instance may back every tier (`pinned`/`portable`/
 * `commodity`) of that vendor, since tier governs fallback semantics, not
 * which adapter answers the call.
 *
 * `anthropic` is the only required entry: it's the default every
 * `ModelPolicy` resolves to when `vendor` is unset (every step written
 * before vendor selection existed), so a router with no Anthropic adapter at
 * all could never serve a single existing agent. Every other vendor is
 * optional — wired only when `create-model-router-from-env.ts` finds enough
 * configuration to build it, exactly like the pre-existing
 * `OPENAI_COMPATIBLE_BASE_URL` opt-in this generalizes.
 */
export interface ModelRouterAdapters {
  anthropic: ModelAdapter;
  gemini?: ModelAdapter;
  "model-garden"?: ModelAdapter;
  "openai-compatible"?: ModelAdapter;
}

function describeMissingVendorAdapter(vendor: ModelVendor): string {
  switch (vendor) {
    case "gemini":
      return 'no Gemini adapter is configured — set GEMINI_VERTEX_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) for the Agent Platform route, or GEMINI_API_KEY for the direct Gemini API route';
    case "model-garden":
      return "no Model Garden adapter is configured — set MODEL_GARDEN_PROJECT_ID (deliberately not GOOGLE_CLOUD_PROJECT — see create-model-router-from-env.ts) to reach Agent Platform's Model-as-a-Service endpoint";
    case "openai-compatible":
      return "no OpenAI-compatible adapter is configured — set OPENAI_COMPATIBLE_BASE_URL";
    case "anthropic":
      return "no Anthropic adapter is configured — this should be impossible, since it's the router's required default vendor";
  }
}

/**
 * `llm.complete(prompt, schema, tier)` from RFC-01 §5.4: no tool, workflow,
 * or agent ever hardcodes a provider — it declares a `ModelPolicy` (its tier,
 * a concrete model, and optionally a `vendor`) and the router resolves the
 * rest.
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

  private adapterForVendor(vendor: ModelVendor): ModelAdapter {
    const adapter = this.adapters[vendor];
    if (!adapter) {
      throw new Error(`DefaultModelRouter: ${describeMissingVendorAdapter(vendor)}`);
    }
    return adapter;
  }

  async complete<TOutput>(
    prompt: string,
    schema: ZodSchema<TOutput>,
    policy: ModelPolicy,
    opts?: RouterCompleteOptions,
  ): Promise<CompletionResult<TOutput>> {
    const adapter = this.adapterForVendor(resolveModelVendor(policy));
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
      // Same vendor, fallback model id — a fallback is a cheaper/smaller
      // variant of the same call shape, never a different structured-output
      // mechanism swapped in mid-failure.
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
