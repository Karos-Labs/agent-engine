import type { AgentStepTelemetry, TokenUsage } from "../types/agent-step.js";

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  /** Defaults to `inputPer1M * CACHE_READ_DISCOUNT` when absent. */
  cachedInputPer1M?: number;
}

/**
 * Anthropic prompt-cache reads run at roughly a 90% discount off the base
 * input price (RFC-01 §5.4) — applied to `AgentStepTelemetry.inputTokens.cached`
 * for every model, since providers behind the `portable`/`commodity` tiers
 * that support prompt caching follow the same order-of-magnitude discount.
 */
export const CACHE_READ_DISCOUNT = 0.1;

/**
 * USD per 1M tokens, cross-referenced against
 * `karosCMO/src/lib/models/usage-log.ts`'s `MODEL_PRICING` so a step's cost
 * here matches what the same call would cost through the portal's own
 * ledger. Update alongside that table when vendor pricing changes.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-8": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-opus-4-7": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-haiku-4-5-20251001": { inputPer1M: 0.8, outputPer1M: 4.0 },
  // Undated base ids: the fallback target of `pricingForModel`, and the
  // spelling Agent Platform uses verbatim for the 4.6-and-later generation
  // (where a dateless id is itself a pinned snapshot, not a moving pointer).
  "claude-haiku-4-5": { inputPer1M: 0.8, outputPer1M: 4.0 },
  "claude-3-5-sonnet-20241022": { inputPer1M: 3.0, outputPer1M: 15.0 },
  // v2 refresh (Oct 2024) — same published pricing as the original 3.5 Sonnet
  // above, but a distinct model id, so `pricingForModel`'s undated-fallback
  // (which only strips a trailing date) would never reach the row above.
  "claude-3-5-sonnet-v2-20241022": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-3-5-haiku-20241022": { inputPer1M: 0.8, outputPer1M: 4.0 },
  "claude-3-opus-20240229": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-3-haiku-20240307": { inputPer1M: 0.25, outputPer1M: 1.25 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "gemini-2.5-flash": { inputPer1M: 0.3, outputPer1M: 2.5 },
  "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10.0 },
  // Model Garden Model-as-a-Service (`vendor: "model-garden"`) partner
  // models, confirmed against cloud.google.com/vertex-ai/generative-ai/pricing
  // (checked 2026-08-20). Keyed by the exact model id string a step's
  // `modelPolicy.model` would pass through — verify it against that pricing
  // page (ids/names shift) before wiring a new Model Garden model into any
  // agent, and add its row here in the same change: an unrecognized id
  // silently falls back to `DEFAULT_MODEL_PRICING` (Sonnet's $3/$15), which
  // is a materially wrong number for most Model Garden partner models rather
  // than an obviously-broken one — worth catching in review, not billing.
  "llama-3.3-70b-instruct-maas": { inputPer1M: 0.72, outputPer1M: 0.72 },
  "mistral-small-2503": { inputPer1M: 0.1, outputPer1M: 0.3 },
  "mistral-medium-3": { inputPer1M: 0.4, outputPer1M: 2.0 },
  // Llama 3.1 405B and Mistral Large were NOT listed on Google's pricing page
  // as of the date above (delisted, renamed, or priced only on request) —
  // deliberately omitted rather than guessed. Confirm current pricing before
  // adding either.
};

export const DEFAULT_MODEL_PRICING: ModelPricing = { inputPer1M: 3.0, outputPer1M: 15.0 };

/**
 * Resolves the pricing row for a model id, tolerating the two spellings the
 * same model has on the two routes to it.
 *
 * Google Cloud's Agent Platform (formerly Vertex AI) dates a pinned snapshot
 * with `@` where the Claude API uses `-` (`claude-haiku-4-5@20251001` vs
 * `claude-haiku-4-5-20251001`), and returns its own spelling in
 * `response.model`. `AgentPlatformAdapter` already normalizes that before it
 * reaches telemetry (see `router/adapters/agent-platform-model-ids.ts`), so
 * this is the second line of defence, not the first — but a pricing miss
 * falls back to `DEFAULT_MODEL_PRICING` *silently*, which would bill Opus
 * work at Sonnet's $3/$15 in every per-step cost report (RFC-01 §11). A
 * plausible-looking wrong number is the worst failure mode available here, so
 * the lookup absorbs both spellings and, failing that, falls back to the
 * undated base id (`claude-haiku-4-5-20251001` -> `claude-haiku-4-5`) before
 * giving up.
 */
export function pricingForModel(modelName: string): ModelPricing {
  const direct = MODEL_PRICING[modelName];
  if (direct) return direct;

  const canonical = modelName.replace(/@(\d{8})$/, "-$1");
  const canonicalMatch = MODEL_PRICING[canonical];
  if (canonicalMatch) return canonicalMatch;

  const undated = canonical.replace(/-\d{8}$/, "");
  return MODEL_PRICING[undated] ?? DEFAULT_MODEL_PRICING;
}

/** 6-decimal rounding, matching `karosCMO`'s own `computeCostUsd`. */
function roundCostUsd(raw: number): number {
  return Math.round(raw * 1_000_000) / 1_000_000;
}

/** Computes one step's cost from its cached/uncached input split and output tokens. */
export function computeStepCostUsd(modelName: string, inputTokens: TokenUsage, outputTokens: number): number {
  const pricing = pricingForModel(modelName);
  const cachedRate = pricing.cachedInputPer1M ?? pricing.inputPer1M * CACHE_READ_DISCOUNT;
  const raw =
    (inputTokens.uncached * pricing.inputPer1M + inputTokens.cached * cachedRate + outputTokens * pricing.outputPer1M) /
    1_000_000;
  return roundCostUsd(raw);
}

export interface TelemetryTotals {
  totalCostUsd: number;
  totalTokens: { input: number; output: number };
}

/** Rolls up a completed run's per-step telemetry into `AgentExecutionResult`'s totals. */
export function summarizeStepTelemetry(steps: readonly AgentStepTelemetry[]): TelemetryTotals {
  let totalCostUsd = 0;
  let input = 0;
  let output = 0;

  for (const step of steps) {
    totalCostUsd += step.costUsd;
    input += step.inputTokens.cached + step.inputTokens.uncached;
    output += step.outputTokens;
  }

  return { totalCostUsd: roundCostUsd(totalCostUsd), totalTokens: { input, output } };
}
