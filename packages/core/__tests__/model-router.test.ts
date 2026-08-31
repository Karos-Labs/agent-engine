import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  DefaultModelRouter,
  MODEL_ALIASES,
  resolveModelAlias,
  type CompletionRequest,
  type CompletionResult,
  type ModelAdapter,
  type ModelPolicy,
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

describe("DefaultModelRouter — vendor dispatch", () => {
  it("dispatches a policy with no vendor set to the anthropic adapter (backward-compatible default)", async () => {
    const anthropic = fakeAdapter("anthropic");
    const gemini = fakeAdapter("gemini");
    const router = new DefaultModelRouter({ anthropic, gemini });

    const result = await router.complete("draft this post", OutputSchema, {
      policy: "pinned",
      model: "claude-sonnet-4-6",
    });

    expect(anthropic.complete).toHaveBeenCalledTimes(1);
    expect(gemini.complete).not.toHaveBeenCalled();
    expect(result.output).toEqual({ text: "anthropic:claude-sonnet-4-6" });
  });

  it("dispatches a policy with vendor: 'gemini' to the gemini adapter", async () => {
    const anthropic = fakeAdapter("anthropic");
    const gemini = fakeAdapter("gemini");
    const router = new DefaultModelRouter({ anthropic, gemini });

    await router.complete("draft this post", OutputSchema, {
      policy: "pinned",
      model: "gemini-2.5-pro",
      vendor: "gemini",
    });

    expect(gemini.complete).toHaveBeenCalledTimes(1);
    expect(anthropic.complete).not.toHaveBeenCalled();
  });

  it("dispatches vendor: 'model-garden' and vendor: 'openai-compatible' to their own distinct adapters", async () => {
    const anthropic = fakeAdapter("anthropic");
    const modelGarden = fakeAdapter("vertex-model-garden");
    const openaiCompatible = fakeAdapter("openai-compatible");
    const router = new DefaultModelRouter({ anthropic, "model-garden": modelGarden, "openai-compatible": openaiCompatible });

    await router.complete("classify this", OutputSchema, {
      policy: "commodity",
      model: "meta/llama-3.1-70b-instruct-maas",
      vendor: "model-garden",
    });
    await router.complete("classify this", OutputSchema, { policy: "commodity", model: "gpt-4o-mini", vendor: "openai-compatible" });

    expect(modelGarden.complete).toHaveBeenCalledTimes(1);
    expect(openaiCompatible.complete).toHaveBeenCalledTimes(1);
    expect(anthropic.complete).not.toHaveBeenCalled();
  });

  it("throws a specific, actionable error naming the vendor and the env var that would configure it", async () => {
    const router = new DefaultModelRouter({ anthropic: fakeAdapter("anthropic") });

    await expect(
      router.complete("draft this post", OutputSchema, { policy: "pinned", model: "gemini-2.5-pro", vendor: "gemini" }),
    ).rejects.toThrow(/GEMINI_VERTEX_PROJECT_ID|GEMINI_API_KEY/);

    await expect(
      router.complete("classify this", OutputSchema, {
        policy: "commodity",
        model: "meta/llama-3.1-70b-instruct-maas",
        vendor: "model-garden",
      }),
    ).rejects.toThrow(/MODEL_GARDEN_PROJECT_ID/);

    await expect(
      router.complete("classify this", OutputSchema, { policy: "commodity", model: "gpt-4o-mini", vendor: "openai-compatible" }),
    ).rejects.toThrow(/Vertex AI only/);
  });

  it("completeAlias resolves the alias (always anthropic, per the Studio's own table) before dispatching", async () => {
    const anthropic = fakeAdapter("anthropic");
    const router = new DefaultModelRouter({ anthropic, gemini: fakeAdapter("gemini") });

    await router.completeAlias("classify this", OutputSchema, "haiku");

    expect(anthropic.complete).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-haiku-4-5-20251001" }));
  });
});

describe("DefaultModelRouter — tier semantics (fallback / no-fallback), independent of vendor", () => {
  it("retries a portable/commodity call on its fallbackModel, against the SAME vendor adapter, after the primary model fails", async () => {
    let calls = 0;
    const gemini = fakeAdapter("gemini", async (req) => {
      calls += 1;
      if (req.model === "gemini-2.5-pro") {
        throw new Error("primary model unavailable");
      }
      return {
        output: { text: `fallback:${req.model}` },
        modelUsed: req.model,
        inputTokens: { cached: 0, uncached: 1 },
        outputTokens: 1,
      };
    });
    const router = new DefaultModelRouter({ anthropic: fakeAdapter("anthropic"), gemini });

    const result = await router.complete("classify this", OutputSchema, {
      policy: "commodity",
      model: "gemini-2.5-pro",
      fallbackModel: "gemini-2.5-flash",
      vendor: "gemini",
    });

    expect(calls).toBe(2);
    expect(result.output).toEqual({ text: "fallback:gemini-2.5-flash" });
  });

  it("never falls back a pinned policy, even if a fallback model were supplied", async () => {
    const anthropic = fakeAdapter("anthropic", async () => {
      throw new Error("model overloaded");
    });
    const router = new DefaultModelRouter({ anthropic });

    await expect(
      router.complete("draft this post", OutputSchema, { policy: "pinned", model: "claude-sonnet-4-6" } as ModelPolicy),
    ).rejects.toThrow("model overloaded");
    expect(anthropic.complete).toHaveBeenCalledTimes(1);
  });

  it("propagates the error when a portable/commodity call fails with no fallbackModel set", async () => {
    const anthropic = fakeAdapter("anthropic", async () => {
      throw new Error("gateway timeout");
    });
    const router = new DefaultModelRouter({ anthropic });

    await expect(
      router.complete("classify this", OutputSchema, { policy: "commodity", model: "claude-haiku-4-5-20251001" }),
    ).rejects.toThrow("gateway timeout");
  });
});
