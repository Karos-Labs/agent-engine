import { describe, expect, it, vi } from "vitest";
import { createPerplexityAdapter } from "../src/capture-adapters/perplexity.js";
import { createClaudeAdapter } from "../src/capture-adapters/claude.js";
import { createGeminiAdapter } from "../src/capture-adapters/gemini.js";
import { createScrappyCocoAnswerEngineAdapter } from "../src/capture-adapters/scrappycoco-answer-engine.js";

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

  it("ScrappyCoco answer-engine (chatgpt/copilot): posts to /scrapers/execute with the engine as `source`", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.scrappycoco.ai/api/v1/scrapers/execute");
      const headers = init?.headers as Record<string, string>;
      expect(headers["X-API-Key"]).toBe("sc-test");
      const body = JSON.parse(String(init?.body)) as { source: string; capability: string; input: { query: string } };
      expect(body.source).toBe("chatgpt");
      expect(body.input.query).toBe(REQUEST.promptText);
      return jsonResponse({
        status: "completed",
        records: [{ text: "Acme Corp shows up in several recommendations.", outputs: { citations: ["https://acme.example/"] } }],
      });
    });
    const adapter = createScrappyCocoAnswerEngineAdapter("chatgpt", { apiKey: "sc-test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await adapter({ ...REQUEST, engine: "chatgpt" });
    expect(result.captureTier).toBe("MEASURED");
    expect(result.brandMentioned).toBe(true);
    expect(result.brandCited).toBe(true);
  });

  it("ScrappyCoco answer-engine: a real HTTP failure throws (tooling_error at the tool boundary), never a fabricated cell", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    const adapter = createScrappyCocoAnswerEngineAdapter("copilot", { apiKey: "sc-test", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(adapter({ ...REQUEST, engine: "copilot" })).rejects.toThrow(/returned 500/);
  });
});
