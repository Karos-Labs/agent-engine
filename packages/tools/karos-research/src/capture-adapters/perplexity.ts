import type { EngineCaptureAdapter, EngineCaptureAdapterResult } from "../capture-visibility.js";
import { analyzeAnswer } from "./analyze-answer.js";

const DEFAULT_BASE_URL = "https://api.perplexity.ai";
/** Perplexity's own first-party Sonar model — the source ticket's own naming ("Perplexity first-party Sonar"). */
const DEFAULT_MODEL = "sonar";

export interface PerplexityAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  model?: string;
  timeoutMs?: number;
}

interface PerplexityChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  /** Perplexity's own top-level field: source URLs behind the answer, in citation order. */
  citations?: string[];
}

/**
 * `createPerplexityAdapter` (T-A3/SCRUM-237): Perplexity's first-party Sonar
 * chat-completions API — real HTTP, real request/response shape. `citations`
 * is Perplexity's own documented top-level response field (a flat array of
 * source URLs in citation order); this adapter reads it directly rather than
 * scraping citation markers out of the answer text.
 */
export function createPerplexityAdapter(options: PerplexityAdapterOptions): EngineCaptureAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? 60_000;

  return async ({ promptText, clientDomains, competitorRoster }): Promise<EngineCaptureAdapterResult> => {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: promptText }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`perplexity chat/completions returned ${response.status}`);
    }
    const body = (await response.json()) as PerplexityChatResponse;
    const text = body.choices?.[0]?.message?.content ?? "";
    const citationUrls = Array.isArray(body.citations) ? body.citations : [];

    const analyzed = analyzeAnswer({ text, citationUrls, clientDomains, competitorRoster });
    return { captureTier: "MEASURED", ...analyzed, rawPayload: body };
  };
}
