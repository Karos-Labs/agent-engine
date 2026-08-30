import { describe, expect, it } from "vitest";
import {
  computeStepCostUsd,
  pricingForModel,
  assertModelPriced,
  summarizeStepTelemetry,
  type AgentStepTelemetry,
} from "../src/index.js";

describe("computeStepCostUsd", () => {
  it("matches karosCMO's flat computeCostUsd when there are no cached tokens", () => {
    // karosCMO/src/lib/models/usage-log.ts: (1_000_000 * 3.00 + 500_000 * 15.00) / 1_000_000 = 10.5
    const cost = computeStepCostUsd("claude-sonnet-4-6", { cached: 0, uncached: 1_000_000 }, 500_000);
    expect(cost).toBeCloseTo(10.5, 6);
  });

  it("applies the ~90% prompt-cache discount to cached input tokens", () => {
    const full = computeStepCostUsd("claude-sonnet-4-6", { cached: 0, uncached: 1_000_000 }, 0);
    const cached = computeStepCostUsd("claude-sonnet-4-6", { cached: 1_000_000, uncached: 0 }, 0);
    expect(cached).toBeCloseTo(full * 0.1, 6);
  });

  it("refuses an unpriced model at SELECTION time, before any spend (AU36, via main's assertModelPriced)", () => {
    // AU36 originally made `pricingForModel` itself throw. `main` had already
    // landed a deliberately different answer to the same problem, and kept it:
    // `pricingForModel` runs AFTER the model call, from `computeStepCostUsd`,
    // so throwing there destroys a completed step's output while the money
    // stays spent. The refusal belongs at model SELECTION instead, which is
    // where `assertModelPriced` puts it — before the call happens.
    expect(() => assertModelPriced("some-future-model-nobody-priced-yet", "test")).toThrow(/no pricing row/);
    // ...and the post-spend path stays non-fatal but loud (see unpricedFallback).
    expect(() => pricingForModel("some-future-model-nobody-priced-yet")).not.toThrow();
  });

  it("still resolves the two id-translation fallbacks (canonical @-date, undated base) before giving up", () => {
    // Agent Platform's own spelling of a dated Haiku snapshot.
    expect(pricingForModel("claude-haiku-4-5@20251001").inputPer1M).toBe(0.8);
    // A dated id whose exact row is missing but whose undated base is priced.
    expect(pricingForModel("claude-haiku-4-5-20301231").inputPer1M).toBe(0.8);
  });

  it("prices the previously-missing rows: Opus 5, Sonnet 5, and the Gemini tertiary-fallback default", () => {
    // gemini-1.5-flash is `CLAUDE_FALLBACK_GEMINI_MODEL`'s default in
    // create-model-router-from-env.ts — the one automatic model-identity
    // change in the whole router (ResilientClaudeAdapter's tertiary hop) —
    // so it must resolve to its own real row rather than the Sonnet-rate default.
    expect(() => pricingForModel("gemini-1.5-flash")).not.toThrow();
    expect(pricingForModel("gemini-1.5-flash")).toEqual({ inputPer1M: 0.075, outputPer1M: 0.3 });
    expect(pricingForModel("claude-opus-5")).toEqual({ inputPer1M: 15.0, outputPer1M: 75.0 });
    expect(pricingForModel("claude-sonnet-5")).toEqual({ inputPer1M: 3.0, outputPer1M: 15.0 });
  });

  it("prices the Vertex/Agent-Platform Gemini models already wired through GeminiAdapter", () => {
    expect(pricingForModel("gemini-2.5-pro")).toEqual({ inputPer1M: 1.25, outputPer1M: 10.0 });
    expect(pricingForModel("gemini-2.5-flash")).toEqual({ inputPer1M: 0.3, outputPer1M: 2.5 });
  });

  it("rounds to 6 decimal places", () => {
    const cost = computeStepCostUsd("claude-haiku-4-5-20251001", { cached: 333, uncached: 777 }, 111);
    expect(cost).toBe(Math.round(cost * 1_000_000) / 1_000_000);
  });
});

describe("summarizeStepTelemetry", () => {
  const step = (overrides: Partial<AgentStepTelemetry>): AgentStepTelemetry => ({
    stepIndex: 0,
    modelUsed: "claude-sonnet-4-6",
    inputTokens: { cached: 0, uncached: 0 },
    outputTokens: 0,
    durationMs: 0,
    costUsd: 0,
    status: "success",
    ...overrides,
  });

  it("sums cost and token totals across every step", () => {
    const steps = [
      step({ stepIndex: 0, inputTokens: { cached: 100, uncached: 200 }, outputTokens: 50, costUsd: 0.01 }),
      step({ stepIndex: 1, inputTokens: { cached: 0, uncached: 300 }, outputTokens: 20, costUsd: 0.02 }),
    ];

    const totals = summarizeStepTelemetry(steps);

    expect(totals.totalCostUsd).toBeCloseTo(0.03, 6);
    expect(totals.totalTokens).toEqual({ input: 600, output: 70 });
  });

  it("returns zeroed totals for an empty step list", () => {
    expect(summarizeStepTelemetry([])).toEqual({ totalCostUsd: 0, totalTokens: { input: 0, output: 0 } });
  });
});
