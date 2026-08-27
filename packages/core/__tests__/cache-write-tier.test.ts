import { describe, expect, it } from "vitest";
import { computeStepCostUsd, CACHE_READ_DISCOUNT, CACHE_WRITE_PREMIUM, MODEL_PRICING } from "../src/telemetry/pricing.js";
import { TokenUsageSchema } from "../src/types/agent-step.js";

/**
 * SCRUM-361b: three input tiers, three prices.
 *
 * Cache writes were folded into `uncached` and billed at 1x. They cost 1.25x.
 * The 25% is not what makes this one interesting — THE ERROR ERASED ITS OWN
 * EVIDENCE. The adapter merged writes into uncached before any sink saw them,
 * Firestore stored `costUsd` and no token counts, and BigQuery merged cached
 * and uncached into a single column. Three collapses stacked, so the size of
 * the error could not be recovered from our own telemetry at all — it could
 * only be bounded from above.
 */
describe("the cache-write tier", () => {
  const sonnet = MODEL_PRICING["claude-sonnet-4-6"]!;

  it("bills a write at 1.25x base input, not 1x", () => {
    const write = computeStepCostUsd("claude-sonnet-4-6", { cached: 0, uncached: 0, cacheWrite: 1_000_000 }, 0);
    expect(write).toBeCloseTo(sonnet.inputPer1M * CACHE_WRITE_PREMIUM, 6);
    // The regression: this used to equal the plain-input price exactly.
    const plain = computeStepCostUsd("claude-sonnet-4-6", { cached: 0, uncached: 1_000_000, cacheWrite: 0 }, 0);
    expect(write).toBeGreaterThan(plain);
    expect(write / plain).toBeCloseTo(1.25, 6);
  });

  it("keeps the three tiers genuinely distinct — one price each", () => {
    // A guard that only checked writes-vs-plain would pass if reads silently
    // became writes. All three must differ, in the right order.
    const one = (tier: "cached" | "uncached" | "cacheWrite"): number =>
      computeStepCostUsd("claude-sonnet-4-6", { cached: 0, uncached: 0, cacheWrite: 0, [tier]: 1_000_000 }, 0);

    expect(one("cached")).toBeCloseTo(sonnet.inputPer1M * CACHE_READ_DISCOUNT, 6);
    expect(one("cached")).toBeLessThan(one("uncached"));
    expect(one("uncached")).toBeLessThan(one("cacheWrite"));
  });

  it("costs a record written BEFORE this change without throwing", () => {
    // The compatibility direction. Records persisted with two fields must keep
    // costing — the same rule `ModelProvenance.hop` follows: narrow what you
    // write, keep wide what you read.
    const legacy = computeStepCostUsd("claude-sonnet-4-6", { cached: 100, uncached: 900 }, 250);
    const explicit = computeStepCostUsd("claude-sonnet-4-6", { cached: 100, uncached: 900, cacheWrite: 0 }, 250);
    expect(legacy).toBe(explicit);
  });

  it("parses a two-field record into a three-field one, defaulting the tier that did not exist", () => {
    expect(TokenUsageSchema.parse({ cached: 5, uncached: 10 })).toEqual({ cached: 5, uncached: 10, cacheWrite: 0 });
  });

  it("sizes the correction on the run that could not be measured", () => {
    // The measured run (pubsub-21560857620229716) reported 87,233 input tokens
    // with no split stored anywhere, so its cache-write share was unknowable.
    // What WAS computable is the ceiling — if every input token had been a
    // write. That number is what this fix makes unnecessary to guess again.
    const asAllWrites = computeStepCostUsd("claude-sonnet-4-6", { cached: 0, uncached: 0, cacheWrite: 87_233 }, 0);
    const asAllPlain = computeStepCostUsd("claude-sonnet-4-6", { cached: 0, uncached: 87_233, cacheWrite: 0 }, 0);
    expect(asAllWrites - asAllPlain).toBeCloseTo(0.065, 3);
  });
});
