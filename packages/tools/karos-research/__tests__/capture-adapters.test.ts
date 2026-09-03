import { describe, expect, it, vi } from "vitest";
import { createPerplexityAdapter } from "../src/capture-adapters/perplexity.js";
import { createClaudeAdapter } from "../src/capture-adapters/claude.js";
import { createGeminiAdapter, createGeminiVertexAdapter } from "../src/capture-adapters/gemini.js";
import { createOpenAiAnswerEngineAdapter } from "../src/capture-adapters/openai-answer-engine.js";

const REQUEST = {
  promptId: "prompt_01",
  promptText: "What are the best B2B SaaS companies to work with in 2026?",
  clientDomains: ["acme.example"],
  competitorRoster: ["Rivalco"],
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("T-A3/SCRUM-237: real per-engine capture adapters, mocked at the HTTP boundary", () => {
  it("Perplexity: parses choices[0].message.content and the top-level citations array (Perplexity's real response shape)", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.perplexity.ai/chat/completions");
      const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> };
      expect(body.model).toBe("sonar");
      expect(body.messages[0]?.content).toBe(REQUEST.promptText);
      return jsonResponse({
        choices: [{ message: { content: "Acme Corp and Rivalco are both well-regarded B2B SaaS vendors." } }],
        citations: ["https://acme.example/reviews", "https://thirdparty.example/roundup"],
      });
    });
    const adapter = createPerplexityAdapter({ apiKey: "pplx-test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await adapter({ ...REQUEST, engine: "perplexity" });

    expect(result.captureTier).toBe("MEASURED");
    expect(result.brandMentioned).toBe(true);
    expect(result.brandCited).toBe(true);
    expect(result.competitorsNamed).toEqual([{ brandId: "Rivalco", charOffset: expect.any(Number) }]);
    expect(result.citations).toEqual([
      { domain: "acme.example", ordinal: 1 },
      { domain: "thirdparty.example", ordinal: 2 },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("Claude: parses content[].text and content[].citations[].url from a web_search-grounded Messages API response", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("ant-test");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      const body = JSON.parse(String(init?.body)) as { model: string; tools: Array<{ type: string }> };
      // Haiku-class, never the report/narrative model.
      expect(body.model).toBe("claude-haiku-4-5-20251001");
      expect(body.tools[0]?.type).toBe("web_search_20250305");
      return jsonResponse({
        content: [
          {
            type: "text",
            text: "Acme Corp is frequently recommended.",
            citations: [{ type: "web_search_result_location", url: "https://acme.example/about" }],
          },
        ],
      });
    });
    const adapter = createClaudeAdapter({ apiKey: "ant-test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await adapter({ ...REQUEST, engine: "claude" });

    expect(result.captureTier).toBe("MEASURED_grounded");
    expect(result.brandMentioned).toBe(true);
    expect(result.brandCited).toBe(true);
    expect(result.citations).toEqual([{ domain: "acme.example", ordinal: 1 }]);
  });

  it("Claude: an ungrounded answer (no citations at all) is MEASURED, not MEASURED_grounded", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ content: [{ type: "text", text: "Rivalco is a known name in the space." }] }));
    const adapter = createClaudeAdapter({ apiKey: "ant-test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await adapter({ ...REQUEST, engine: "claude" });
    expect(result.captureTier).toBe("MEASURED");
    expect(result.brandMentioned).toBe(false);
  });

  it("Gemini: distinguishes an AIO-absent cell (no groundingChunks at all) from an ordinary brand-absent cell", async () => {
    const groundedNoBrand = vi.fn(async () =>
      jsonResponse({
        candidates: [
          {
            content: { parts: [{ text: "Several B2B SaaS vendors serve this space, including Rivalco." }] },
            groundingMetadata: { groundingChunks: [{ web: { uri: "https://thirdparty.example/roundup" } }] },
          },
        ],
      }),
    );
    const groundedAdapter = createGeminiAdapter({ apiKey: "gem-test", fetchImpl: groundedNoBrand as unknown as typeof fetch });
    const brandAbsentButGrounded = await groundedAdapter({ ...REQUEST, engine: "gemini" });
    // Grounding DID render (an AI-Overview-equivalent answer exists) — it just didn't name the brand.
    expect(brandAbsentButGrounded.aioAbsent).toBe(false);
    expect(brandAbsentButGrounded.brandMentioned).toBe(false);
    expect(brandAbsentButGrounded.captureTier).toBe("MEASURED_grounded");

    const ungrounded = vi.fn(async () =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: "I'm not sure, I don't have specific information." }] } }] }),
    );
    const ungroundedAdapter = createGeminiAdapter({ apiKey: "gem-test", fetchImpl: ungrounded as unknown as typeof fetch });
    const aioAbsentCell = await ungroundedAdapter({ ...REQUEST, engine: "gemini" });
    // No grounding chunks at all — Google's AI-Overview equivalent genuinely did not render.
    expect(aioAbsentCell.aioAbsent).toBe(true);
    expect(aioAbsentCell.brandMentioned).toBe(false);
    expect(aioAbsentCell.captureTier).toBe("MEASURED");

    // The two cells must be VERIFIABLY DISTINCT — never collapsed into
    // "brandMentioned: false" meaning the same thing in both cases.
    expect(brandAbsentButGrounded.aioAbsent).not.toBe(aioAbsentCell.aioAbsent);
  });

  it("Gemini: request includes the google_search grounding tool", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toContain("generativelanguage.googleapis.com");
      const body = JSON.parse(String(init?.body)) as { tools: Array<{ google_search?: unknown }> };
      expect(body.tools[0]?.google_search).toEqual({});
      return jsonResponse({ candidates: [{ content: { parts: [{ text: "answer" }] }, groundingMetadata: { groundingChunks: [] } }] });
    });
    const adapter = createGeminiAdapter({ apiKey: "gem-test", fetchImpl: fetchImpl as unknown as typeof fetch });
    await adapter({ ...REQUEST, engine: "gemini" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("Gemini: cites the real publisher, not Google's grounding redirect", async () => {
    // The live Vertex response shape, verified 2026-09-03. Every `uri` is a
    // vertexaisearch.cloud.google.com/grounding-api-redirect/... wrapper and
    // the real publisher is in `domain`. Reading `uri` alone would hand
    // analyzeAnswer a list of Google hosts, so `brandCited` could never be
    // true for any client — a permanent, silent "your brand is never cited".
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        candidates: [
          {
            content: { parts: [{ text: "Acme Corp is one option." }] },
            groundingMetadata: {
              groundingChunks: [
                {
                  web: {
                    uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHllhoV1yut",
                    title: "acme.example",
                    domain: "acme.example",
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    const adapter = createGeminiVertexAdapter({
      projectId: "karoscmo-prep",
      location: "us-central1",
      authorize: async () => "Bearer test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await adapter({ ...REQUEST, engine: "gemini" });

    expect(result.captureTier).toBe("MEASURED_grounded");
    expect(result.brandCited).toBe(true);
    expect(result.citations.map((c) => c.domain)).toEqual(["acme.example"]);
  });

  it("Gemini: falls back to the uri when a chunk carries no domain or hostname title", async () => {
    // A payload shape neither route promises must still contribute something
    // rather than dropping the citation entirely.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        candidates: [
          {
            content: { parts: [{ text: "answer" }] },
            groundingMetadata: { groundingChunks: [{ web: { uri: "https://real.example/page", title: "A Page Title" } }] },
          },
        ],
      }),
    );
    const adapter = createGeminiVertexAdapter({
      projectId: "p",
      location: "us-central1",
      authorize: async () => "Bearer test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await adapter({ ...REQUEST, engine: "gemini" });

    expect(result.citations.map((c) => c.domain)).toEqual(["real.example"]);
  });

  it("ChatGPT via OpenAI Responses: gathers text and url_citation annotations across output items", async () => {
    // `output` interleaves the `web_search_call` with the `message`, which is
    // why the adapter flattens content blocks instead of reading output[0].
    const fetchImpl = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string>; body?: unknown }) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["authorization"]).toBe("Bearer sk-test");
      const body = JSON.parse(String(init?.body)) as { model: string; input: string; tools: Array<{ type: string }> };
      expect(body.input).toBe(REQUEST.promptText);
      expect(body.tools).toEqual([{ type: "web_search" }]);
      return jsonResponse({
        output: [
          { type: "web_search_call" },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Acme Corp shows up in several recommendations.",
                annotations: [{ type: "url_citation", url: "https://acme.example/" }],
              },
            ],
          },
        ],
      });
    });
    const adapter = createOpenAiAnswerEngineAdapter({ apiKey: "sk-test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await adapter({ ...REQUEST, engine: "chatgpt" });

    expect(result.captureTier).toBe("MEASURED_grounded");
    expect(result.brandMentioned).toBe(true);
    expect(result.brandCited).toBe(true);
  });

  it("ChatGPT via OpenAI Responses: an ungrounded answer is MEASURED, not MEASURED_grounded", async () => {
    // The same split gemini.ts makes, so the two grounded engines mean the
    // same thing by the same word.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "I am not sure." }] }] }),
    );
    const adapter = createOpenAiAnswerEngineAdapter({ apiKey: "sk-test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await adapter({ ...REQUEST, engine: "chatgpt" });

    expect(result.captureTier).toBe("MEASURED");
    expect(result.brandCited).toBe(false);
  });

  it("ChatGPT via OpenAI Responses: a real HTTP failure throws and names the cause", async () => {
    // The body matters: a 400 here is usually "this model does not support
    // web_search", which the status alone hides.
    const fetchImpl = vi.fn(async () => new Response('{"error":{"message":"tool web_search unsupported"}}', { status: 400 }));
    const adapter = createOpenAiAnswerEngineAdapter({ apiKey: "sk-test", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(adapter({ ...REQUEST, engine: "chatgpt" })).rejects.toThrow(/returned 400.*web_search unsupported/);
  });
});
