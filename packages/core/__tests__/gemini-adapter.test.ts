import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FinishReason, BlockedReason, type GoogleGenAI } from "@google/genai";
import { GeminiAdapter, GEMINI_DEFAULT_MAX_TOKENS } from "../src/router/adapters/gemini-adapter.js";
import type { CompletionRequest } from "../src/router/adapters/types.js";

// A discriminated union at the schema root, exactly the shape
// `BaseAgent.buildTurnSchema()` produces — forces `toRootObjectJsonSchema` to
// wrap the root under `turn`, exercising the same wrap/unwrap path a real
// agent step relies on.
const OutputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool_call"), name: z.string() }),
  z.object({ type: z.literal("final"), text: z.string() }),
]);
type Output = z.infer<typeof OutputSchema>;

function request(overrides: Partial<CompletionRequest<Output>> = {}): CompletionRequest<Output> {
  return { prompt: "draft something", schema: OutputSchema, model: "gemini-2.5-pro", ...overrides };
}

function goodResponse(usage: Record<string, number> = {}) {
  return {
    candidates: [{ finishReason: FinishReason.STOP }],
    text: JSON.stringify({ turn: { type: "final", text: "hello world" } }),
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, ...usage },
  };
}

function fakeClient(generateContent: ReturnType<typeof vi.fn>): GoogleGenAI {
  return { models: { generateContent } } as unknown as GoogleGenAI;
}

describe("GeminiAdapter", () => {
  it("returns the parsed structured output on a first-attempt success, unwrapping the object-root wrapper", async () => {
    const generateContent = vi.fn().mockResolvedValue(goodResponse());
    const adapter = new GeminiAdapter({ client: fakeClient(generateContent), retryOptions: { delay: () => Promise.resolve() } });

    const result = await adapter.complete(request());

    expect(result.output).toEqual({ type: "final", text: "hello world" });
    expect(generateContent).toHaveBeenCalledTimes(1);
    const sent = generateContent.mock.calls[0]![0];
    expect(sent.model).toBe("gemini-2.5-pro");
    expect(sent.config.responseMimeType).toBe("application/json");
    // Union root got wrapped under "turn" as a legal object schema.
    expect(sent.config.responseJsonSchema.type).toBe("object");
    expect(sent.config.responseJsonSchema.required).toEqual(["turn"]);
  });

  it("reports the provider id", () => {
    const adapter = new GeminiAdapter({ client: fakeClient(vi.fn()) });
    expect(adapter.providerId).toBe("google-gemini");
  });

  it("sends the step's system prompt as systemInstruction when provided, and omits it otherwise", async () => {
    const generateContent = vi.fn().mockResolvedValue(goodResponse());
    const adapter = new GeminiAdapter({ client: fakeClient(generateContent), retryOptions: { delay: () => Promise.resolve() } });

    await adapter.complete(request({ system: "the craft policy for this step" }));
    expect(generateContent.mock.calls[0]![0].config.systemInstruction).toBe("the craft policy for this step");

    generateContent.mockClear();
    await adapter.complete(request());
    expect(generateContent.mock.calls[0]![0].config.systemInstruction).toBeUndefined();
  });

  it("uses the step's maxTokens when set, and the shared default otherwise", async () => {
    const generateContent = vi.fn().mockResolvedValue(goodResponse());
    const adapter = new GeminiAdapter({ client: fakeClient(generateContent), retryOptions: { delay: () => Promise.resolve() } });

    await adapter.complete(request());
    expect(generateContent.mock.calls[0]![0].config.maxOutputTokens).toBe(GEMINI_DEFAULT_MAX_TOKENS);

    generateContent.mockClear();
    await adapter.complete(request({ maxTokens: 500 }));
    expect(generateContent.mock.calls[0]![0].config.maxOutputTokens).toBe(500);
  });

  it("throws a clear, actionable error when the model hits MAX_TOKENS before completing", async () => {
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [{ finishReason: FinishReason.MAX_TOKENS }],
      text: undefined,
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 500 },
    });
    const adapter = new GeminiAdapter({ client: fakeClient(generateContent), retryOptions: { delay: () => Promise.resolve() } });

    await expect(adapter.complete(request())).rejects.toThrow(
      new RegExp(`google-gemini.*gemini-2\\.5-pro.*${GEMINI_DEFAULT_MAX_TOKENS}-token output limit`, "s"),
    );
  });

  it("throws a clear error naming the block reason when the response has no text at all", async () => {
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [],
      text: undefined,
      promptFeedback: { blockReason: BlockedReason.SAFETY },
    });
    const adapter = new GeminiAdapter({ client: fakeClient(generateContent), retryOptions: { delay: () => Promise.resolve() } });

    await expect(adapter.complete(request())).rejects.toThrow(/google-gemini.*returned no text content.*blocked: SAFETY/s);
  });

  it("throws a clear error naming the finish reason when there is no text and no block reason", async () => {
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [{ finishReason: FinishReason.OTHER }],
      text: undefined,
    });
    const adapter = new GeminiAdapter({ client: fakeClient(generateContent), retryOptions: { delay: () => Promise.resolve() } });

    await expect(adapter.complete(request())).rejects.toThrow(/google-gemini.*returned no text content.*finishReason: OTHER/s);
  });

  it("throws a clear error when the model returns non-JSON text despite the JSON response mode", async () => {
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [{ finishReason: FinishReason.STOP }],
      text: "not actually json",
    });
    const adapter = new GeminiAdapter({ client: fakeClient(generateContent), retryOptions: { delay: () => Promise.resolve() } });

    await expect(adapter.complete(request())).rejects.toThrow(/google-gemini.*returned non-JSON text/s);
  });

  it("accounts usage tokens, splitting cachedContentTokenCount out of the prompt total", async () => {
    const generateContent = vi.fn().mockResolvedValue(goodResponse({ promptTokenCount: 120, cachedContentTokenCount: 20, candidatesTokenCount: 15 }));
    const adapter = new GeminiAdapter({ client: fakeClient(generateContent), retryOptions: { delay: () => Promise.resolve() } });

    const result = await adapter.complete(request());

    expect(result.inputTokens).toEqual({ cached: 20, uncached: 100 });
    expect(result.outputTokens).toBe(15);
    expect(result.modelUsed).toBe("gemini-2.5-pro");
  });

  it("reports zeroed usage when usageMetadata is absent rather than throwing", async () => {
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [{ finishReason: FinishReason.STOP }],
      text: JSON.stringify({ turn: { type: "final", text: "ok" } }),
    });
    const adapter = new GeminiAdapter({ client: fakeClient(generateContent), retryOptions: { delay: () => Promise.resolve() } });

    const result = await adapter.complete(request());
    expect(result.inputTokens).toEqual({ cached: 0, uncached: 0 });
    expect(result.outputTokens).toBe(0);
  });

  it("retries a transient failure and succeeds on the next attempt", async () => {
    const generateContent = vi.fn().mockRejectedValueOnce({ status: 429 }).mockResolvedValueOnce(goodResponse());
    const adapter = new GeminiAdapter({ client: fakeClient(generateContent), retryOptions: { delay: () => Promise.resolve() } });

    const result = await adapter.complete(request());

    expect(result.output).toEqual({ type: "final", text: "hello world" });
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("does not retry a genuine 4xx client error", async () => {
    const err = { status: 400 };
    const generateContent = vi.fn().mockRejectedValue(err);
    const adapter = new GeminiAdapter({ client: fakeClient(generateContent), retryOptions: { delay: () => Promise.resolve() } });

    await expect(adapter.complete(request())).rejects.toBe(err);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("accepts a client-resolver function, calling it with the request's canonical model id", async () => {
    const generateContentA = vi.fn().mockResolvedValue(goodResponse());
    const generateContentB = vi.fn().mockResolvedValue(goodResponse());
    const clientA = fakeClient(generateContentA);
    const clientB = fakeClient(generateContentB);
    const resolveClient = vi.fn((model: string) => (model === "gemini-2.5-flash" ? clientB : clientA));

    const adapter = new GeminiAdapter({ client: resolveClient, retryOptions: { delay: () => Promise.resolve() } });

    await adapter.complete(request({ model: "gemini-2.5-flash" }));

    expect(resolveClient).toHaveBeenCalledWith("gemini-2.5-flash");
    expect(generateContentB).toHaveBeenCalledTimes(1);
    expect(generateContentA).not.toHaveBeenCalled();
  });
});
