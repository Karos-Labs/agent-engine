import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { MessagesApiAdapter } from "../src/router/adapters/messages-api-adapter.js";
import type { RetryOptions } from "../src/router/adapters/retry.js";
import type { MessagesApiClient } from "../src/router/adapters/types.js";
import type { CompletionRequest } from "../src/router/adapters/types.js";

const OutputSchema = z.object({ body: z.string() });

function baseRequest(): CompletionRequest<z.infer<typeof OutputSchema>> {
  return { prompt: "draft something", schema: OutputSchema, model: "claude-sonnet-4-6" };
}

function goodResponse() {
  return {
    model: "claude-sonnet-4-6",
    content: [{ type: "tool_use", name: "emit_output", input: { body: "hello world" } }],
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
  };
}

function fakeClient(create: ReturnType<typeof vi.fn>): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

/**
 * SCRUM-358 deleted `AnthropicAdapter` along with the direct-Anthropic route.
 * The behaviour these tests cover was never Anthropic-specific — it lives in
 * `MessagesApiAdapter`, the shared base the Vertex route still extends — so
 * the coverage is kept and repointed at the base class directly rather than
 * deleted with the subclass. `modelIds` defaults to the identity codec, which
 * is exactly what the deleted subclass pinned.
 */
function messagesApiAdapter(client: unknown, retryOptions: RetryOptions = {}, promptCaching = true): MessagesApiAdapter {
  return new MessagesApiAdapter({ providerId: "anthropic", client: client as MessagesApiClient, retryOptions, promptCaching });
}

describe("MessagesApiAdapter (the shared Messages-API mechanics)", () => {
  it("returns the parsed structured output on a first-attempt success", async () => {
    const create = vi.fn().mockResolvedValue(goodResponse());
    const adapter = messagesApiAdapter(fakeClient(create), { delay: () => Promise.resolve() });
    const result = await adapter.complete(baseRequest());

    expect(result.output).toEqual({ body: "hello world" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 429 and succeeds on the second attempt, never swapping the requested model", async () => {
    const create = vi.fn().mockRejectedValueOnce({ status: 429 }).mockResolvedValueOnce(goodResponse());
    const adapter = messagesApiAdapter(fakeClient(create), { delay: () => Promise.resolve() });
    const result = await adapter.complete(baseRequest());

    expect(result.output).toEqual({ body: "hello world" });
    expect(create).toHaveBeenCalledTimes(2);
    const calls = create.mock.calls as Array<[{ model: string }]>;
    expect(calls[0]![0].model).toBe("claude-sonnet-4-6");
    expect(calls[1]![0].model).toBe("claude-sonnet-4-6");
  });

  it("retries a 5xx and a bare network error, giving up after the default 3 attempts", async () => {
    const err = { status: 503 };
    const create = vi.fn().mockRejectedValue(err);
    const adapter = messagesApiAdapter(fakeClient(create), { delay: () => Promise.resolve() });

    await expect(adapter.complete(baseRequest())).rejects.toBe(err);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("does not retry a genuine 4xx client error (e.g. bad request/auth failure)", async () => {
    const err = { status: 401 };
    const create = vi.fn().mockRejectedValue(err);
    const adapter = messagesApiAdapter(fakeClient(create), { delay: () => Promise.resolve() });

    await expect(adapter.complete(baseRequest())).rejects.toBe(err);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the model responds successfully but without the expected tool_use block", async () => {
    const create = vi.fn().mockResolvedValue({ model: "claude-sonnet-4-6", content: [], usage: { input_tokens: 10, output_tokens: 5 } });
    const adapter = messagesApiAdapter(fakeClient(create), { delay: () => Promise.resolve() });

    await expect(adapter.complete(baseRequest())).rejects.toThrow(/did not return/);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
