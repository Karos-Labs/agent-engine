import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  assertModelPriced,
  computeToolCostUsd,
  extractToolUsage,
  pricingForModel,
  pricingForUnit,
  DEFAULT_MODEL_PRICING,
  UNIT_PRICING,
} from "../src/telemetry/pricing.js";
import type { AgentToolOutcome } from "../src/agent/tool.js";

/**
 * SCRUM-361 / AU66: tools can report what they consumed, and it can be priced.
 *
 * A measured Instagram run reported $0.565829. Two `gemini-2.5-flash-image`
 * invocations in its window were confirmed against Vertex's own publisher
 * metrics at $0.039 each, and the steps that made them recorded $0.000000 —
 * not a lookup that missed, but no cost path from a tool at all.
 */
describe("per-unit pricing", () => {
  it("prices images at the rate the measured run was reconciled against", () => {
    expect(computeToolCostUsd([{ model: "gemini-2.5-flash-image", unit: "image", quantity: 2 }])).toBeCloseTo(0.078, 6);
  });

  it("REFUSES a unit that is not the unit the SKU is priced in", () => {
    // Billing 30 seconds at an image rate reconciles to a number, which is
    // exactly why it has to throw: the wrong answer would look like an answer.
    expect(() => computeToolCostUsd([{ model: "gemini-2.5-flash-image", unit: "second", quantity: 30 }])).toThrow(/priced per image/);
  });

  it("REFUSES an unpriced SKU rather than defaulting", () => {
    expect(() => pricingForUnit("veo-2.0-generate-001")).toThrow(/no per-unit price/);
  });

  it("requires a checkable source on every row — an unsourced rate is a guess with a decimal point", () => {
    for (const [model, pricing] of Object.entries(UNIT_PRICING)) {
      expect(pricing.source.length, `${model} must say where its rate came from`).toBeGreaterThan(20);
      expect(pricing.usdPerUnit).toBeGreaterThan(0);
    }
  });

  it("costs nothing when a step consumed no units — a measurement, not an assumption", () => {
    expect(computeToolCostUsd([])).toBe(0);
  });
});

describe("extracting usage from what a step.code body returned", () => {
  const withUsage = (quantity: number): AgentToolOutcome<{ ok: true }> => ({
    status: "success",
    result: { ok: true },
    usage: [{ model: "gemini-2.5-flash-image", unit: "image", quantity }],
  });

  it("reads a tool outcome without the call site opting in", () => {
    // Shape-driven on purpose. An opt-in would reintroduce the bug: cost missed
    // by DEFAULT, counted only where someone remembered.
    expect(extractToolUsage(withUsage(3))).toEqual([{ model: "gemini-2.5-flash-image", unit: "image", quantity: 3 }]);
  });

  it("sums across a fanned-out step", () => {
    expect(computeToolCostUsd(extractToolUsage([withUsage(2), withUsage(1)]))).toBeCloseTo(0.117, 6);
  });

  it("finds nothing in ordinary computation, which is most step.code bodies", () => {
    for (const output of [undefined, null, 42, "text", { anything: true }, []]) {
      expect(extractToolUsage(output)).toEqual([]);
    }
  });

  it("finds nothing in a FAILED outcome — a call that did not complete consumed no units", () => {
    for (const status of ["content_fail", "tooling_error", "not_available"] as const) {
      expect(extractToolUsage({ status, reason: "x", usage: [{ model: "gemini-2.5-flash-image", unit: "image", quantity: 9 }] })).toEqual([]);
    }
  });
});

describe("an unpriced model must never produce a quiet number", () => {
  let logged: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    logged.mockRestore();
  });

  it("REFUSES at selection time, before anything is billed", () => {
    // The direction that matters. `claude-opus-9` would route fine and bill at
    // Sonnet's rate — a 5x understatement that looks entirely plausible.
    expect(() => assertModelPriced("claude-opus-9", 'resolveModelPolicy("x")')).toThrow(/no pricing row/);
  });

  it("admits every model the fleet actually declares", () => {
    // A guard that refused everything would pass the test above and be useless.
    for (const model of ["claude-sonnet-4-6", "claude-haiku-4-5-20251001", "gemini-2.5-flash"]) {
      expect(() => assertModelPriced(model, "test")).not.toThrow();
    }
  });

  it("tolerates the Agent Platform @-dated spelling of a priced model", () => {
    expect(() => assertModelPriced("claude-haiku-4-5@20251001", "test")).not.toThrow();
  });

  it("reaches a Model Garden row through a publisher prefix", () => {
    // Found by the guard itself. Model Garden ids carry `meta/` on some call
    // paths and not others, and MODEL_PRICING is keyed without it — so every
    // Model Garden model we had DELIBERATELY priced was unreachable from a
    // prefixed id and would still have billed at Sonnet's rate.
    expect(pricingForModel("meta/llama-3.3-70b-instruct-maas")).toEqual(pricingForModel("llama-3.3-70b-instruct-maas"));
    expect(() => assertModelPriced("meta/llama-3.3-70b-instruct-maas", "test")).not.toThrow();
  });

  it("still refuses a Model Garden model the table deliberately does not price", () => {
    // `pricing.ts` records that Llama 3.1 405B and Mistral Large were not on
    // Google's pricing page and were omitted rather than guessed. Prefix
    // stripping must not turn that recorded refusal into a silent default.
    expect(() => assertModelPriced("meta/llama-3.1-405b-instruct-maas", "test")).toThrow(/no pricing row/);
  });

  it("SHOUTS rather than throwing when an unpriced id reaches cost computation", () => {
    // Deliberately not fatal here: this runs after the call, so throwing would
    // destroy a completed step while the money stayed spent. Loud, not fatal.
    const pricing = pricingForModel("some-model-nobody-priced");
    expect(pricing).toEqual(DEFAULT_MODEL_PRICING);

    const lines = (logged.mock.calls as unknown[][]).map((c) => String(c[0])).filter((l) => l.includes("pricing.unpriced_model"));
    expect(lines, "a silent default is the whole failure mode").toHaveLength(1);
    expect(lines[0]).toContain("some-model-nobody-priced");
  });

  it("says nothing for a priced model — the common case must not become noise", () => {
    pricingForModel("claude-sonnet-4-6");
    expect((logged.mock.calls as unknown[][]).filter((c) => String(c[0]).includes("pricing.unpriced_model"))).toHaveLength(0);
  });
});
