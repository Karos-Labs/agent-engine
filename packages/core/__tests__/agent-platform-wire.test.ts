import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { AgentPlatformAdapter } from "../src/router/adapters/agent-platform-adapter.js";
import type { MessagesApiClient } from "../src/router/adapters/types.js";

/**
 * Wire-level contract test against the *real* `AnthropicVertex` client, with
 * only `fetch` faked out. This is the one thing the unit tests around
 * `AgentPlatformAdapter` cannot prove on their own: those inject a fake
 * client, so they verify what this codebase hands the SDK — not what the SDK
 * then puts on the network.
 *
 * That gap matters here, because Agent Platform's request shape genuinely
 * differs from the direct API's in ways nothing in this repo controls: the
 * model id moves out of the JSON body and into the URL path, an
 * `anthropic_version` field is added, and auth becomes a bearer token rather
 * than an `x-api-key` header. If a future SDK version changes any of that, a
 * mocked-client test stays green and every real run 404s.
 *
 * A stub `AuthClient` stands in for Application Default Credentials, so this
 * test needs no GCP project and makes no network call. Note that the SDK's
 * `accessToken` constructor option does NOT work for this: as of
 * `@anthropic-ai/vertex-sdk@0.19.5` it is stored on the client and then never
 * read — every request resolves an `AuthClient` regardless — which is also
 * why `create-model-router-from-env.ts` offers no access-token branch.
 */
describe("Agent Platform wire contract (real AnthropicVertex, faked fetch)", () => {
  async function callThrough(model: string, region = "global") {
    const captured: { url?: string; body?: Record<string, unknown>; authorization?: string | null } = {};

    const fakeFetch = async (url: unknown, init: { body: string; headers: unknown }): Promise<Response> => {
      captured.url = String(url);
      captured.body = JSON.parse(init.body) as Record<string, unknown>;
      captured.authorization = new Headers(init.headers as Record<string, string>).get("authorization");
      // SSE, not a JSON body: the adapter streams every call now (see
      // `MessagesApiAdapter.complete`), so the real SDK is parsing a real
      // event stream here. That is the point of this file — a faked JSON
      // response would prove the request shape while testing a code path
      // production no longer takes, and the SDK rejects one outright
      // ("request ended without sending any chunks").
      //
      // The events below assemble to exactly the message the non-streaming
      // body used to return: same model spelling, same tool_use block, same
      // usage. `input_tokens`/`cache_creation_input_tokens` arrive on
      // `message_start` and `output_tokens` on `message_delta`, which is the
      // wire's own split and worth reproducing rather than flattening.
      const events: Array<[string, unknown]> = [
        [
          "message_start",
          {
            type: "message_start",
            message: {
              id: "msg_1",
              type: "message",
              role: "assistant",
              // Agent Platform echoes back its own @-dated spelling.
              model: "claude-haiku-4-5@20251001",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 12, output_tokens: 0, cache_creation_input_tokens: 900, cache_read_input_tokens: 0 },
            },
          },
        ],
        [
          "content_block_start",
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "emit_output", input: {} } },
        ],
        [
          "content_block_delta",
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"body":"hi"}' } },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "message_delta",
          { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } },
        ],
        ["message_stop", { type: "message_stop" }],
      ];
      const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };

    // Stands in for ADC. `getRequestHeaders` is the only method the SDK's
    // request path calls on it.
    const stubAuthClient = {
      projectId: "karos-labs-prep",
      getRequestHeaders: async () => new Headers({ authorization: "Bearer fake-adc-token" }),
    };

    const client = new AnthropicVertex({
      projectId: "karos-labs-prep",
      region,
      authClient: stubAuthClient as never,
      fetch: fakeFetch as unknown as typeof fetch,
    }) as unknown as MessagesApiClient;

    const adapter = new AgentPlatformAdapter({
      clientForRegion: () => client,
      defaultRegion: region,
      // Fail fast: an auth error surfaces as the SDK's own APIConnectionError,
      // which `withRetry` correctly classifies as retryable — useful in
      // production, just slow in a test that is asserting the request shape.
      retryOptions: { maxAttempts: 1 },
    });
    const result = await adapter.complete({
      prompt: "draft it",
      schema: z.object({ body: z.string() }),
      model,
      system: "the craft policy for this step",
    });

    return { captured, result };
  }

  it("puts the @-dated model in the URL path, not the body", async () => {
    const { captured } = await callThrough("claude-haiku-4-5-20251001");

    expect(captured.url).toContain("/projects/karos-labs-prep/locations/global/publishers/anthropic/models/");
    expect(captured.url).toContain("claude-haiku-4-5@20251001");
    // The canonical `-`-dated spelling must never reach the wire: Agent
    // Platform answers that with a 404 that names no cause.
    expect(captured.url).not.toContain("claude-haiku-4-5-20251001");
    expect(captured.body).not.toHaveProperty("model");
  });

  it("sends the bearer token from ADC, and no x-api-key — no model credential is in play", async () => {
    const { captured } = await callThrough("claude-haiku-4-5-20251001");
    expect(captured.authorization).toBe("Bearer fake-adc-token");
  });

  it("carries the structured-output tool and the cache-broken system prompt through unchanged", async () => {
    const { captured } = await callThrough("claude-haiku-4-5-20251001");

    expect(captured.body).toHaveProperty("anthropic_version");
    expect(captured.body!["system"]).toEqual([
      { type: "text", text: "the craft policy for this step", cache_control: { type: "ephemeral" } },
    ]);
    const tools = captured.body!["tools"] as Array<{ name: string; input_schema: { type: string } }>;
    expect(tools[0]!.name).toBe("emit_output");
    expect(tools[0]!.input_schema.type).toBe("object");
    expect(captured.body!["tool_choice"]).toEqual({ type: "tool", name: "emit_output" });
  });

  it("asks Agent Platform to stream, which is what a 32k-maxTokens step requires", async () => {
    // On the wire, not just in the adapter's arguments. `intel-report-agent`
    // asks for 32k output tokens; without this field the SDK refuses to send
    // the request at all, which is how every one of its runs failed in 4ms.
    const { captured } = await callThrough("claude-haiku-4-5-20251001");
    expect(captured.body!["stream"]).toBe(true);
  });

  it("parses the response and reports the canonical model id plus cache-write tokens", async () => {
    const { result } = await callThrough("claude-haiku-4-5-20251001");

    expect(result.output).toEqual({ body: "hi" });
    expect(result.modelUsed).toBe("claude-haiku-4-5-20251001");
    expect(result.inputTokens).toEqual({ cached: 0, uncached: 912 });
    expect(result.outputTokens).toBe(3);
  });

  it("targets a regional host when a region is pinned instead of the global endpoint", async () => {
    const { captured } = await callThrough("claude-haiku-4-5-20251001", "us-east5");
    expect(captured.url).toContain("us-east5");
    expect(captured.url).toContain("/locations/us-east5/");
  });

  it("leaves a dateless model id alone on the wire", async () => {
    const { captured } = await callThrough("claude-sonnet-4-6");
    expect(captured.url).toContain("claude-sonnet-4-6");
    expect(captured.url).not.toContain("@");
  });
});
