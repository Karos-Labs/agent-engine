import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MessagesApiAdapter } from "../src/router/adapters/messages-api-adapter.js";
import type { CompletionRequest, MessagesApiClient } from "../src/router/adapters/types.js";

/**
 * THE MODEL CALL STREAMS, SO A LARGE `maxTokens` STEP CAN RUN AT ALL.
 *
 * `intel-report-agent` sets `maxTokens: 32_000` and failed 100% of the time on
 * prep — in about 4ms, for zero tokens and zero cost — with:
 *
 *   model call failed: Streaming is required for operations that may take
 *   longer than 10 minutes.
 *
 * That refusal is the SDK's, raised client-side before the request is sent,
 * for any non-streaming call whose `max_tokens` could run past ten minutes.
 * It surfaced as a `tooling_error` on step `02-generate-report`, which reads
 * like a tool problem and was really the adapter never calling
 * `messages.stream`.
 *
 * The first test below is the regression itself: a client whose `create`
 * raises exactly that error and whose `stream` works. It fails against the
 * adapter as it was, and cannot pass by accident.
 */

const OutputSchema = z.object({ body: z.string() });

function request(maxTokens?: number): CompletionRequest<z.infer<typeof OutputSchema>> {
  return {
    prompt: "draft something",
    schema: OutputSchema,
    model: "claude-sonnet-4-6",
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

function goodMessage() {
  return {
    model: "claude-sonnet-4-6",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", name: "emit_output", input: { body: "hello world" } }],
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
  };
}

/** The SDK's real refusal, verbatim from the failed prep run. */
const STREAMING_REQUIRED = new Error(
  "Streaming is required for operations that may take longer than 10 minutes. " +
    "See https://github.com/anthropics/anthropic-sdk-typescript#long-requests for more details",
);

function client(parts: {
  create: ReturnType<typeof vi.fn>;
  stream?: ReturnType<typeof vi.fn>;
}): MessagesApiClient {
  return {
    messages: { create: parts.create, ...(parts.stream ? { stream: parts.stream } : {}) },
  } as unknown as MessagesApiClient;
}

function adapterFor(c: MessagesApiClient) {
  return new MessagesApiAdapter({ providerId: "anthropic", client: c, retryOptions: { delay: () => Promise.resolve() } });
}

describe("MessagesApiAdapter — streaming", () => {
  it("streams a 32k-maxTokens step that a non-streaming call refuses outright", async () => {
    const create = vi.fn().mockRejectedValue(STREAMING_REQUIRED);
    const stream = vi.fn().mockReturnValue({ finalMessage: () => Promise.resolve(goodMessage()) });

    const result = await adapterFor(client({ create, stream })).complete(request(32_000));

    expect(result.output).toEqual({ body: "hello world" });
    expect(create).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("sends stream: true and preserves the request the non-streaming path built", async () => {
    const create = vi.fn();
    const stream = vi.fn().mockReturnValue({ finalMessage: () => Promise.resolve(goodMessage()) });

    await adapterFor(client({ create, stream })).complete(request(32_000));

    const [body] = stream.mock.calls[0] as [Record<string, unknown>];
    expect(body["stream"]).toBe(true);
    expect(body["max_tokens"]).toBe(32_000);
    expect(body["model"]).toBe("claude-sonnet-4-6");
    // The structured-output contract is the whole point of this adapter; a
    // streaming route that dropped the tool would return prose.
    expect(body["tool_choice"]).toEqual({ type: "tool", name: "emit_output" });
  });

  it("streams every call, not only the large ones", async () => {
    // The threshold that triggers the refusal is the SDK's, and it moves with
    // vendor and model. Re-deriving it here would be a second place to get it
    // wrong, so the rule is simply "stream when the client can".
    const create = vi.fn();
    const stream = vi.fn().mockReturnValue({ finalMessage: () => Promise.resolve(goodMessage()) });

    await adapterFor(client({ create, stream })).complete(request());

    expect(stream).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("falls back to create for a client that implements no stream", async () => {
    // Hand-written test doubles elsewhere in this repo implement `create`
    // alone. They must keep working; production clients all have `stream`.
    const create = vi.fn().mockResolvedValue(goodMessage());

    const result = await adapterFor(client({ create })).complete(request(32_000));

    expect(result.output).toEqual({ body: "hello world" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure on the streaming route too", async () => {
    const create = vi.fn();
    const stream = vi
      .fn()
      .mockImplementationOnce(() => {
        throw { status: 429 };
      })
      .mockReturnValue({ finalMessage: () => Promise.resolve(goodMessage()) });

    const result = await adapterFor(client({ create, stream })).complete(request(32_000));

    expect(result.output).toEqual({ body: "hello world" });
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it("still reports a truncated turn precisely when streaming", async () => {
    const create = vi.fn();
    const stream = vi
      .fn()
      .mockReturnValue({ finalMessage: () => Promise.resolve({ ...goodMessage(), stop_reason: "max_tokens" }) });

    await expect(adapterFor(client({ create, stream })).complete(request(32_000))).rejects.toThrow(
      /hit the 32000-token output limit/,
    );
  });
});
