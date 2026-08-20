import type { GoogleAuth } from "google-auth-library";

/**
 * Agent Platform's own OpenAI-compatible Model-as-a-Service (MaaS) endpoint
 * — the mechanism Google uses to serve third-party/open Model Garden models
 * (Llama, Mistral, and similar) through a Chat Completions-shaped API,
 * confirmed against Google's own `model_garden_openai_api_llama3_1` sample
 * notebook:
 *
 *   https://{region}-aiplatform.googleapis.com/v1/projects/{projectId}/locations/{region}/endpoints/openapi
 *
 * This is still Agent Platform, still ADC — it is deliberately NOT the same
 * vendor as `openai-compatible` (a real external OpenAI-shaped endpoint:
 * OpenAI itself, or a self-hosted LiteLLM gateway). The two happen to share
 * an adapter class (`OpenAICompatibleAdapter` — the wire shape is identical)
 * but not a credential, a base URL, or a vendor identity.
 */
export function vertexModelGardenBaseUrl(projectId: string, region: string): string {
  return `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/endpoints/openapi`;
}

/**
 * The `openai` client's `apiKey` constructor option wants a static string;
 * Agent Platform wants a live ADC bearer token that expires roughly hourly.
 * Reconciled the same way `AnthropicVertex` reconciles it internally: the
 * constructor gets a placeholder `apiKey` that is never actually sent (see
 * `create-model-router-from-env.ts`'s call site), and THIS `fetch` override
 * replaces the `Authorization` header on every request immediately before it
 * reaches the network. `GoogleAuth`/`AuthClient` cache the underlying token
 * themselves and only refresh it once it's actually expired, so calling
 * `getRequestHeaders()` per request is the documented, cheap way to do
 * this — not a hand-rolled cache this file has to get right.
 */
export function createVertexModelGardenFetch(auth: GoogleAuth): typeof fetch {
  return async (input, init) => {
    const authClient = await auth.getClient();
    const authHeaders = await authClient.getRequestHeaders();
    const headers = new Headers(init?.headers as Record<string, string> | undefined);
    const bearer = authHeaders.get("authorization");
    if (bearer) headers.set("authorization", bearer);
    return fetch(input, { ...init, headers });
  };
}
