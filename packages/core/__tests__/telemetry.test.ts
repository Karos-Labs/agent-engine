import { describe, expect, it } from "vitest";
import { computeStepCostUsd, summarizeStepTelemetry, type AgentStepTelemetry } from "../src/index.js";

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

  it("falls back to the default pricing row for an unlisted model", () => {
    const known = computeStepCostUsd("claude-sonnet-4-6", { cached: 0, uncached: 1_000_000 }, 1_000_000);
    const unknown = computeStepCostUsd("some-future-model-nobody-priced-yet", { cached: 0, uncached: 1_000_000 }, 1_000_000);
    expect(unknown).toBeCloseTo(known, 6);
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
