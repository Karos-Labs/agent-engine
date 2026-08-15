import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  DefaultModelRouter,
  MODEL_ALIASES,
  resolveModelAlias,
  type CompletionRequest,
  type CompletionResult,
  type ModelAdapter,
} from "../src/index.js";

const OutputSchema = z.object({ text: z.string() });

function fakeAdapter(providerId: string, impl?: (req: CompletionRequest<unknown>) => Promise<CompletionResult<unknown>>): ModelAdapter {
  return {
    providerId,
    complete: vi.fn(
      impl ??
        (async (req: CompletionRequest<unknown>) => ({
          output: { text: `${providerId}:${req.model}` },
          modelUsed: req.model,
          inputTokens: { cached: 0, uncached: 10 },
          outputTokens: 5,
        })),
    ),
  } as unknown as ModelAdapter;
}

describe("resolveModelAlias (RFC-01 §7.3)", () => {
  it("maps haiku to the commodity tier on the real haiku model id", () => {
    expect(resolveModelAlias("haiku")).toEqual({ policy: "commodity", model: "claude-haiku-4-5-20251001" });
  });

  it("maps sonnet to the pinned tier on the real sonnet model id", () => {
    expect(resolveModelAlias("sonnet")).toEqual({ policy: "pinned", model: "claude-sonnet-4-6" });
  });

  it("maps opus to the pinned (premium) tier on the real opus model id", () => {
    expect(resolveModelAlias("opus")).toEqual({ policy: "pinned", model: "claude-opus-4-8" });
  });

  it("exposes exactly the three Studio aliases", () => {
    expect(Object.keys(MODEL_ALIASES).sort()).toEqual(["haiku", "opus", "sonnet"]);
  });
});

describe("DefaultModelRouter", () => {
  it("dispatches a pinned policy to the pinned adapter", async () => {
    const pinned = fakeAdapter("anthropic-pinned");
    const portable = fakeAdapter("anthropic-portable");
    const commodity = fakeAdapter("gateway-commodity");
    const router = new DefaultModelRouter({ pinned, portable, commodity });

    const result = await router.complete("draft this post", OutputSchema, {
      policy: "pinned",
      model: "claude-sonnet-4-6",
    });

    expect(pinned.complete).toHaveBeenCalledTimes(1);
    expect(portable.complete).not.toHaveBeenCalled();
    expect(commodity.complete).not.toHaveBeenCalled();
    expect(result.output).toEqual({ text: "anthropic-pinned:claude-sonnet-4-6" });
  });

  it("dispatches a commodity policy to the commodity adapter", async () => {
    const pinned = fakeAdapter("anthropic-pinned");
    const portable = fakeAdapter("anthropic-portable");
    const commodity = fakeAdapter("gateway-commodity");
    const router = new DefaultModelRouter({ pinned, portable, commodity });

    await router.complete("classify this", OutputSchema, {
      policy: "commodity",
      model: "claude-haiku-4-5-20251001",
    });

    expect(commodity.complete).toHaveBeenCalledTimes(1);
    expect(pinned.complete).not.toHaveBeenCalled();
  });

  it("completeAlias resolves the alias before dispatching", async () => {
    const pinned = fakeAdapter("anthropic-pinned");
    const portable = fakeAdapter("anthropic-portable");
    const commodity = fakeAdapter("gateway-commodity");
    const router = new DefaultModelRouter({ pinned, portable, commodity });

    await router.completeAlias("classify this", OutputSchema, "haiku");

    expect(commodity.complete).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5-20251001" }),
    );
  });

  it("retries a portable/commodity call on its fallbackModel after the primary model fails", async () => {
    let calls = 0;
    const commodity = fakeAdapter("gateway-commodity", async (req) => {
      calls += 1;
      if (req.model === "claude-haiku-4-5-20251001") {
        throw new Error("primary model unavailable");
      }
      return {
        output: { text: `fallback:${req.model}` },
        modelUsed: req.model,
        inputTokens: { cached: 0, uncached: 1 },
        outputTokens: 1,
      };
    });
    const router = new DefaultModelRouter({
      pinned: fakeAdapter("anthropic-pinned"),
      portable: fakeAdapter("anthropic-portable"),
      commodity,
    });

    const result = await router.complete("classify this", OutputSchema, {
      policy: "commodity",
      model: "claude-haiku-4-5-20251001",
      fallbackModel: "gpt-4o-mini",
    });

    expect(calls).toBe(2);
    expect(result.output).toEqual({ text: "fallback:gpt-4o-mini" });
  });

  it("never falls back a pinned policy, even if a fallback model were supplied", async () => {
    const pinned = fakeAdapter("anthropic-pinned", async () => {
      throw new Error("model overloaded");
    });
    const router = new DefaultModelRouter({
      pinned,
      portable: fakeAdapter("anthropic-portable"),
      commodity: fakeAdapter("gateway-commodity"),
    });

    await expect(
      router.complete("draft this post", OutputSchema, {
        policy: "pinned",
        model: "claude-sonnet-4-6",
      } as never),
    ).rejects.toThrow("model overloaded");
    expect(pinned.complete).toHaveBeenCalledTimes(1);
  });

  it("propagates the error when a portable/commodity call fails with no fallbackModel set", async () => {
    const commodity = fakeAdapter("gateway-commodity", async () => {
      throw new Error("gateway timeout");
    });
    const router = new DefaultModelRouter({
      pinned: fakeAdapter("anthropic-pinned"),
      portable: fakeAdapter("anthropic-portable"),
      commodity,
    });

    await expect(
      router.complete("classify this", OutputSchema, {
        policy: "commodity",
        model: "claude-haiku-4-5-20251001",
      }),
    ).rejects.toThrow("gateway timeout");
  });
});
