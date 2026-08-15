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
  "claude-3-5-sonnet-20241022": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-3-opus-20240229": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-3-haiku-20240307": { inputPer1M: 0.25, outputPer1M: 1.25 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "gemini-2.5-flash": { inputPer1M: 0.3, outputPer1M: 2.5 },
  "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10.0 },
};

export const DEFAULT_MODEL_PRICING: ModelPricing = { inputPer1M: 3.0, outputPer1M: 15.0 };

export function pricingForModel(modelName: string): ModelPricing {
  return MODEL_PRICING[modelName] ?? DEFAULT_MODEL_PRICING;
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
