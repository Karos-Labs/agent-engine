import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type OpenAI from "openai";
import { OpenAICompatibleAdapter } from "../src/router/adapters/openai-compatible-adapter.js";
import type { CompletionRequest } from "../src/router/adapters/types.js";

const OutputSchema = z.object({ body: z.string() });

function baseRequest(): CompletionRequest<z.infer<typeof OutputSchema>> {
  return { prompt: "draft something", schema: OutputSchema, model: "gpt-4o-mini" };
}

function goodResponse() {
  return {
    model: "gpt-4o-mini",
    choices: [{ message: { content: JSON.stringify({ body: "hello world" }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };
}

function fakeClient(create: ReturnType<typeof vi.fn>): OpenAI {
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

describe("OpenAICompatibleAdapter", () => {
  it("returns the parsed structured output on a first-attempt success", async () => {
    const create = vi.fn().mockResolvedValue(goodResponse());
    const adapter = new OpenAICompatibleAdapter(fakeClient(create), "openai", { delay: () => Promise.resolve() });
    const result = await adapter.complete(baseRequest());

    expect(result.output).toEqual({ body: "hello world" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 429 and succeeds on the second attempt", async () => {
    const create = vi.fn().mockRejectedValueOnce({ status: 429 }).mockResolvedValueOnce(goodResponse());
    const adapter = new OpenAICompatibleAdapter(fakeClient(create), "openai", { delay: () => Promise.resolve() });
    const result = await adapter.complete(baseRequest());

    expect(result.output).toEqual({ body: "hello world" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("retries a network timeout error and gives up after the default 3 attempts", async () => {
    const err = { code: "ETIMEDOUT" };
    const create = vi.fn().mockRejectedValue(err);
    const adapter = new OpenAICompatibleAdapter(fakeClient(create), "openai", { delay: () => Promise.resolve() });

    await expect(adapter.complete(baseRequest())).rejects.toBe(err);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("does not retry a genuine 4xx client error", async () => {
    const err = { status: 400 };
    const create = vi.fn().mockRejectedValue(err);
    const adapter = new OpenAICompatibleAdapter(fakeClient(create), "openai", { delay: () => Promise.resolve() });

    await expect(adapter.complete(baseRequest())).rejects.toBe(err);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the model responds successfully but with no message content", async () => {
    const create = vi.fn().mockResolvedValue({ model: "gpt-4o-mini", choices: [{ message: {} }], usage: { prompt_tokens: 10, completion_tokens: 0 } });
    const adapter = new OpenAICompatibleAdapter(fakeClient(create), "openai", { delay: () => Promise.resolve() });

    await expect(adapter.complete(baseRequest())).rejects.toThrow(/returned no message content/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("defaults providerId to 'openai' when not supplied, still accepting injected retry options positionally", async () => {
    const create = vi.fn().mockResolvedValue(goodResponse());
    const adapter = new OpenAICompatibleAdapter(fakeClient(create));
    expect(adapter.providerId).toBe("openai");
    const result = await adapter.complete(baseRequest());
    expect(result.output).toEqual({ body: "hello world" });
  });
});
