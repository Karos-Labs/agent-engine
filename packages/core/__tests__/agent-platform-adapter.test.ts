import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AgentPlatformAdapter,
  AnthropicAdapter,
  computeStepCostUsd,
  pricingForModel,
  regionEnvVarNamesFor,
  toAgentPlatformModelId,
  toCanonicalModelId,
} from "../src/index.js";
import type { CompletionRequest, MessagesApiClient } from "../src/router/adapters/types.js";

const OutputSchema = z.object({ body: z.string() });
type Output = z.infer<typeof OutputSchema>;

function request(overrides: Partial<CompletionRequest<Output>> = {}): CompletionRequest<Output> {
  return { prompt: "draft something", schema: OutputSchema, model: "claude-haiku-4-5-20251001", ...overrides };
}

/** Mirrors what Agent Platform returns: its own `@`-dated spelling in `model`. */
function response(model: string, usage: Record<string, number> = {}) {
  return {
    model,
    content: [{ type: "tool_use", name: "emit_output", input: { body: "hello world" } }],
    usage: { input_tokens: 100, output_tokens: 20, ...usage },
  };
}

function clientCapturing(create: ReturnType<typeof vi.fn>): MessagesApiClient {
  return { messages: { create } } as unknown as MessagesApiClient;
}

describe("Agent Platform model ids", () => {
  it("rewrites a Claude API dated snapshot into the @-dated Agent Platform spelling", () => {
    expect(toAgentPlatformModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5@20251001");
    expect(toAgentPlatformModelId("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5@20250929");
  });

  it("leaves a dateless id untouched — those are byte-identical on both surfaces", () => {
    for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-opus-4-8"]) {
      expect(toAgentPlatformModelId(id)).toBe(id);
    }
  });

  it("is idempotent, so an id already authored in Agent Platform form is not mangled", () => {
    expect(toAgentPlatformModelId("claude-haiku-4-5@20251001")).toBe("claude-haiku-4-5@20251001");
  });

  it("round-trips back to the canonical spelling the rest of this system speaks", () => {
    const canonical = "claude-haiku-4-5-20251001";
    expect(toCanonicalModelId(toAgentPlatformModelId(canonical))).toBe(canonical);
    expect(toCanonicalModelId("claude-opus-5")).toBe("claude-opus-5");
  });

  it("does not treat a trailing number that isn't a date as a version suffix", () => {
    expect(toAgentPlatformModelId("some-model-v2")).toBe("some-model-v2");
    expect(toAgentPlatformModelId("some-model-1234")).toBe("some-model-1234");
  });

  it("derives both the dated and undated VERTEX_REGION_* names, most specific first", () => {
    expect(regionEnvVarNamesFor("claude-haiku-4-5-20251001")).toEqual([
      "VERTEX_REGION_CLAUDE_HAIKU_4_5_20251001",
      "VERTEX_REGION_CLAUDE_HAIKU_4_5",
    ]);
    expect(regionEnvVarNamesFor("claude-sonnet-4-6")).toEqual(["VERTEX_REGION_CLAUDE_SONNET_4_6"]);
  });
});

describe("AgentPlatformAdapter", () => {
  function adapter(create: ReturnType<typeof vi.fn>, opts: { regionForModel?: (m: string) => string | undefined; promptCaching?: boolean } = {}) {
    const clientForRegion = vi.fn((_region: string) => clientCapturing(create));
    const built = new AgentPlatformAdapter({
      clientForRegion,
      defaultRegion: "global",
      ...(opts.regionForModel ? { regionForModel: opts.regionForModel } : {}),
      ...(opts.promptCaching !== undefined ? { promptCaching: opts.promptCaching } : {}),
      retryOptions: { delay: () => Promise.resolve() },
    });
    return { adapter: built, clientForRegion };
  }

  it("sends the Agent Platform spelling on the wire while the caller keeps using canonical ids", async () => {
    const create = vi.fn().mockResolvedValue(response("claude-haiku-4-5@20251001"));
    const { adapter: a } = adapter(create);

    await a.complete(request());

    expect(create.mock.calls[0]![0].model).toBe("claude-haiku-4-5@20251001");
  });

  it("normalizes response.model back to canonical form, so cost telemetry resolves the right pricing row", async () => {
    const create = vi.fn().mockResolvedValue(response("claude-haiku-4-5@20251001"));
    const { adapter: a } = adapter(create);

    const result = await a.complete(request());

    expect(result.modelUsed).toBe("claude-haiku-4-5-20251001");
    // The bug this guards: an un-normalized id misses MODEL_PRICING and falls
    // back to Sonnet's $3/$15 silently — 3.75x Haiku's real input rate.
    expect(pricingForModel(result.modelUsed).inputPer1M).toBe(0.8);
  });

  it("prices a Haiku run as Haiku even if a provider-spelled id reaches the cost calculator directly", () => {
    const asHaiku = computeStepCostUsd("claude-haiku-4-5@20251001", { cached: 0, uncached: 1_000_000 }, 0);
    const asCanonical = computeStepCostUsd("claude-haiku-4-5-20251001", { cached: 0, uncached: 1_000_000 }, 0);
    expect(asHaiku).toBe(asCanonical);
    expect(asHaiku).toBe(0.8);
  });

  it("reports the provider id, not Anthropic's, so telemetry can tell the two routes apart", () => {
    const { adapter: a } = adapter(vi.fn());
    expect(a.providerId).toBe("google-agent-platform");
  });

  it("uses the default region unless a model is explicitly pinned elsewhere", async () => {
    const create = vi.fn().mockResolvedValue(response("claude-haiku-4-5@20251001"));
    const { adapter: a, clientForRegion } = adapter(create, {
      regionForModel: (m) => (m === "claude-haiku-4-5-20251001" ? "us-east5" : undefined),
    });

    await a.complete(request({ model: "claude-sonnet-4-6" }));
    expect(clientForRegion).toHaveBeenLastCalledWith("global");

    await a.complete(request({ model: "claude-haiku-4-5-20251001" }));
    expect(clientForRegion).toHaveBeenLastCalledWith("us-east5");
  });

  it("retries a transient 429 against the same model, never swapping it (RFC-01 §5.4)", async () => {
    const create = vi.fn().mockRejectedValueOnce({ status: 429 }).mockResolvedValueOnce(response("claude-haiku-4-5@20251001"));
    const { adapter: a } = adapter(create);

    const result = await a.complete(request());

    expect(result.output).toEqual({ body: "hello world" });
    expect(create).toHaveBeenCalledTimes(2);
    expect(new Set(create.mock.calls.map((c) => c[0].model))).toEqual(new Set(["claude-haiku-4-5@20251001"]));
  });

  it("names the route in a truncation error, so a failing run says which path produced it", async () => {
    const create = vi.fn().mockResolvedValue({ ...response("claude-haiku-4-5@20251001"), stop_reason: "max_tokens" });
    const { adapter: a } = adapter(create);

    await expect(a.complete(request())).rejects.toThrow(/google-agent-platform.*output limit/s);
  });
});

describe("prompt caching", () => {
  const create = () => vi.fn().mockResolvedValue(response("claude-sonnet-4-6"));

  it("puts one cache breakpoint on the system prompt, covering the whole stable tools+system prefix", async () => {
    const c = create();
    const a = new AnthropicAdapter(clientCapturing(c));

    await a.complete(request({ model: "claude-sonnet-4-6", system: "the craft policy for this step" }));

    const sent = c.mock.calls[0]![0];
    expect(sent.system).toEqual([
      { type: "text", text: "the craft policy for this step", cache_control: { type: "ephemeral" } },
    ]);
    // Exactly one breakpoint: a second one on the tool would cache a prefix
    // that is almost certainly below the minimum cacheable length anyway.
    expect(sent.tools[0].cache_control).toBeUndefined();
  });

  it("falls back to caching the tool definition when a step has no system prompt", async () => {
    const c = create();
    const a = new AnthropicAdapter(clientCapturing(c));

    await a.complete(request({ model: "claude-sonnet-4-6" }));

    const sent = c.mock.calls[0]![0];
    expect(sent.system).toBeUndefined();
    expect(sent.tools[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("sends no cache_control at all when caching is disabled", async () => {
    const c = create();
    const a = new AnthropicAdapter(clientCapturing(c), {}, false);

    await a.complete(request({ model: "claude-sonnet-4-6", system: "the craft policy for this step" }));

    const sent = c.mock.calls[0]![0];
    expect(sent.system).toBe("the craft policy for this step");
    expect(sent.tools[0].cache_control).toBeUndefined();
  });

  it("counts cache-write tokens as input rather than dropping them from the bill entirely", async () => {
    const c = vi
      .fn()
      .mockResolvedValue(response("claude-sonnet-4-6", { input_tokens: 10, cache_creation_input_tokens: 4_000, cache_read_input_tokens: 0 }));
    const a = new AnthropicAdapter(clientCapturing(c));

    const result = await a.complete(request({ model: "claude-sonnet-4-6", system: "x" }));

    // `input_tokens` excludes both cache reads and cache writes; reading it
    // alone would report 10 input tokens for a 4,010-token billed request.
    //
    // SCRUM-361b changed what "counting" means here. Writes used to be FOLDED
    // into `uncached` and billed at 1x; they cost 1.25x, so this assertion
    // previously encoded a deliberate 25% under-report. They now have their own
    // tier, and the difference is real money: 4,000 write tokens at Sonnet's
    // $3/1M cost $0.012 at 1x and $0.015 at 1.25x.
    expect(result.inputTokens).toEqual({ cached: 0, uncached: 10, cacheWrite: 4_000 });
  });

  it("keeps reporting cache reads separately, so the 90% read discount still lands", async () => {
    const c = vi.fn().mockResolvedValue(response("claude-sonnet-4-6", { input_tokens: 50, cache_read_input_tokens: 4_000 }));
    const a = new AnthropicAdapter(clientCapturing(c));

    const result = await a.complete(request({ model: "claude-sonnet-4-6", system: "x" }));

    expect(result.inputTokens).toEqual({ cached: 4_000, uncached: 50, cacheWrite: 0 });
  });
});
