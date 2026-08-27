import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ResilientClaudeAdapter, type CompletionRequest, type CompletionResult, type ModelAdapter } from "../src/index.js";

const OutputSchema = z.object({ text: z.string() });

function httpError(status: number, message = "boom"): Error {
  return Object.assign(new Error(message), { status });
}

function fakeAdapter(providerId: string, impl: (req: CompletionRequest<unknown>) => Promise<CompletionResult<unknown>>): ModelAdapter {
  return { providerId, complete: vi.fn(impl) } as unknown as ModelAdapter;
}

function okResult(providerId: string, model: string): CompletionResult<unknown> {
  return { output: { text: `${providerId}:${model}` }, modelUsed: model, inputTokens: { cached: 0, uncached: 10 }, outputTokens: 5 };
}

const baseReq: CompletionRequest<unknown> = { prompt: "hi", schema: OutputSchema, model: "claude-sonnet-4-6" };

describe("ResilientClaudeAdapter", () => {
  it("returns the primary's result directly when it succeeds — no fallback touched", async () => {
    const primary = fakeAdapter("primary", async (req) => okResult("primary", req.model));
    const secondary = fakeAdapter("secondary", async () => {
      throw new Error("should never be called");
    });
    const adapter = new ResilientClaudeAdapter({ primary, secondary });

    const result = await adapter.complete(baseReq);
    expect(result.output).toEqual({ text: "primary:claude-sonnet-4-6" });
    expect(secondary.complete).not.toHaveBeenCalled();
  });

  it("falls over to secondary on a 429 from primary, using the SAME model id", async () => {
    const primary = fakeAdapter("primary", async () => {
      throw httpError(429, "quota exceeded");
    });
    const secondary = fakeAdapter("secondary", async (req) => okResult("secondary", req.model));
    const adapter = new ResilientClaudeAdapter({ primary, secondary });

    const result = await adapter.complete(baseReq);
    expect(result.output).toEqual({ text: "secondary:claude-sonnet-4-6" });
    expect(secondary.complete).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-sonnet-4-6" }));
  });

  it("falls over to secondary on a 404 from primary", async () => {
    const primary = fakeAdapter("primary", async () => {
      throw httpError(404, "model not found");
    });
    const secondary = fakeAdapter("secondary", async (req) => okResult("secondary", req.model));
    const adapter = new ResilientClaudeAdapter({ primary, secondary });

    const result = await adapter.complete(baseReq);
    expect(result.output).toEqual({ text: "secondary:claude-sonnet-4-6" });
  });

  it("does NOT fall over on a non-failover-worthy error (e.g. a 400) — propagates it as-is", async () => {
    const primary = fakeAdapter("primary", async () => {
      throw httpError(400, "bad request");
    });
    const secondary = fakeAdapter("secondary", async (req) => okResult("secondary", req.model));
    const adapter = new ResilientClaudeAdapter({ primary, secondary });

    await expect(adapter.complete(baseReq)).rejects.toThrow("bad request");
    expect(secondary.complete).not.toHaveBeenCalled();
  });

  it("propagates the primary's error unchanged when no secondary is configured", async () => {
    const primary = fakeAdapter("primary", async () => {
      throw httpError(429, "quota exceeded");
    });
    const adapter = new ResilientClaudeAdapter({ primary });

    await expect(adapter.complete(baseReq)).rejects.toThrow("quota exceeded");
  });

  it("falls all the way through to tertiary (Gemini) when BOTH Claude routes are exhausted, using tertiaryModel not the Claude model id", async () => {
    const primary = fakeAdapter("primary", async () => {
      throw httpError(429, "vertex quota exceeded");
    });
    const secondary = fakeAdapter("secondary", async () => {
      throw httpError(429, "direct api quota exceeded");
    });
    const tertiary = fakeAdapter("tertiary", async (req) => okResult("tertiary", req.model));
    const adapter = new ResilientClaudeAdapter({ primary, secondary, tertiary, tertiaryModel: "gemini-1.5-flash" });

    const result = await adapter.complete(baseReq);
    expect(result.output).toEqual({ text: "tertiary:gemini-1.5-flash" });
    expect(tertiary.complete).toHaveBeenCalledWith(expect.objectContaining({ model: "gemini-1.5-flash" }));
  });

  it("does not touch tertiary when secondary succeeds", async () => {
    const primary = fakeAdapter("primary", async () => {
      throw httpError(429);
    });
    const secondary = fakeAdapter("secondary", async (req) => okResult("secondary", req.model));
    const tertiary = fakeAdapter("tertiary", async () => {
      throw new Error("should never be called");
    });
    const adapter = new ResilientClaudeAdapter({ primary, secondary, tertiary, tertiaryModel: "gemini-1.5-flash" });

    await adapter.complete(baseReq);
    expect(tertiary.complete).not.toHaveBeenCalled();
  });

  it("propagates secondary's error unchanged when it fails with a non-failover-worthy status", async () => {
    const primary = fakeAdapter("primary", async () => {
      throw httpError(429);
    });
    const secondary = fakeAdapter("secondary", async () => {
      throw httpError(401, "invalid api key");
    });
    const tertiary = fakeAdapter("tertiary", async (req) => okResult("tertiary", req.model));
    const adapter = new ResilientClaudeAdapter({ primary, secondary, tertiary, tertiaryModel: "gemini-1.5-flash" });

    await expect(adapter.complete(baseReq)).rejects.toThrow("invalid api key");
    expect(tertiary.complete).not.toHaveBeenCalled();
  });
});
