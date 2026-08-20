import { afterEach, describe, expect, it } from "vitest";
import type { GoogleAuth } from "google-auth-library";
import { createVertexModelGardenFetch, vertexModelGardenBaseUrl } from "../src/router/adapters/vertex-model-garden-client.js";

const realGlobalFetch = globalThis.fetch;

/**
 * Wire-contract test for `createVertexModelGardenFetch`: proves the returned
 * `fetch` override actually injects a live bearer token from `GoogleAuth`
 * into the `Authorization` header of every outgoing request, overwriting
 * whatever placeholder the OpenAI SDK put there — the same kind of gap
 * `agent-platform-wire.test.ts` closes for `AnthropicVertex`. No real ADC or
 * network call: `GoogleAuth` is a stub whose only method the fetch override
 * calls is `getClient().getRequestHeaders()`.
 */
describe("createVertexModelGardenFetch", () => {
  afterEach(() => {
    globalThis.fetch = realGlobalFetch;
  });

  function stubAuth(bearer: string, opts: { getClientCalls?: string[] } = {}): GoogleAuth {
    const authClient = {
      getRequestHeaders: async () => new Headers({ authorization: bearer }),
    };
    return {
      getClient: async () => {
        opts.getClientCalls?.push("called");
        return authClient;
      },
    } as unknown as GoogleAuth;
  }

  it("injects the live bearer token into the Authorization header", async () => {
    const auth = stubAuth("Bearer live-token-1");
    const fetchImpl = createVertexModelGardenFetch(auth);

    let capturedAuth: string | null = null;
    const fakeFetch: typeof fetch = async (_input, init) => {
      capturedAuth = new Headers(init?.headers as Record<string, string>).get("authorization");
      return new Response("{}", { status: 200 });
    };
    globalThis.fetch = fakeFetch;

    await fetchImpl("https://example.invalid/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer placeholder-never-sent", "content-type": "application/json" },
      body: "{}",
    });

    expect(capturedAuth).toBe("Bearer live-token-1");
  });

  it("overwrites a placeholder Authorization header rather than merely adding one", async () => {
    const auth = stubAuth("Bearer real-adc-header");
    const fetchImpl = createVertexModelGardenFetch(auth);

    const seenHeaders: Headers[] = [];
    const realFetch = async (_input: unknown, init?: RequestInit): Promise<Response> => {
      seenHeaders.push(new Headers(init?.headers as Record<string, string>));
      return new Response("{}", { status: 200 });
    };
    globalThis.fetch = realFetch as typeof fetch;

    await fetchImpl("https://example.invalid/v1/chat/completions", {
      headers: { authorization: "Bearer adc" },
    });

    expect(seenHeaders[0]!.get("authorization")).toBe("Bearer real-adc-header");
  });

  it("calls getClient (and thus getRequestHeaders) fresh on every request, letting GoogleAuth handle its own refresh/caching", async () => {
    const calls: string[] = [];
    const auth = stubAuth("Bearer live-token-2", { getClientCalls: calls });
    const fetchImpl = createVertexModelGardenFetch(auth);
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

    await fetchImpl("https://example.invalid/v1/chat/completions", {});
    await fetchImpl("https://example.invalid/v1/chat/completions", {});

    expect(calls).toHaveLength(2);
  });

  it("preserves the rest of the request (method, body, non-auth headers) unchanged", async () => {
    const auth = stubAuth("Bearer live-token-3");
    const fetchImpl = createVertexModelGardenFetch(auth);

    let captured: { method?: string | undefined; body?: unknown; contentType?: string | null } = {};
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      captured = {
        method: init?.method,
        body: init?.body,
        contentType: new Headers(init?.headers as Record<string, string>).get("content-type"),
      };
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await fetchImpl("https://example.invalid/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "meta/llama-3.1-70b-instruct-maas" }),
    });

    expect(captured.method).toBe("POST");
    expect(captured.body).toBe(JSON.stringify({ model: "meta/llama-3.1-70b-instruct-maas" }));
    expect(captured.contentType).toBe("application/json");
  });
});

describe("vertexModelGardenBaseUrl", () => {
  it("builds Agent Platform's Model Garden OpenAI-compatible endpoint URL", () => {
    expect(vertexModelGardenBaseUrl("karos-labs-prep", "us-central1")).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/karos-labs-prep/locations/us-central1/endpoints/openapi",
    );
  });

  it("scopes the region into both the hostname and the locations path segment", () => {
    const url = vertexModelGardenBaseUrl("some-project", "europe-west4");
    expect(url).toBe(
      "https://europe-west4-aiplatform.googleapis.com/v1/projects/some-project/locations/europe-west4/endpoints/openapi",
    );
  });
});
