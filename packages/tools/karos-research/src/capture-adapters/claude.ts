import type { EngineCaptureAdapter, EngineCaptureAdapterResult } from "../capture-visibility.js";
import { analyzeAnswer } from "./analyze-answer.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
/**
 * A haiku-class model, deliberately — NEVER the report/narrative model
 * (`claude-sonnet-4-6`, pinned for `seo-geo-narrative`/`seo-geo-fix-draft`).
 * The source ticket's own instruction: capture is a cheap, high-volume,
 * per-(prompt x engine) call (N prompts x 1 engine, every run), and pinning
 * it to the same model the report itself uses would multiply the
 * expensive model's spend by the size of the whole capture matrix for a
 * task that needs "did the model mention/cite the brand," not report-grade
 * prose quality.
 */
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
/** Anthropic's server-side web-search tool version string, current as of this port. */
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";

export interface ClaudeAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

interface AnthropicCitation {
  type?: string;
  url?: string;
}
interface AnthropicContentBlock {
  type?: string;
  text?: string;
  citations?: AnthropicCitation[];
}
interface AnthropicMessagesResponse {
  content?: AnthropicContentBlock[];
}

/**
 * `createClaudeAdapter` (T-A3/SCRUM-237): Claude via the Anthropic Messages
 * API with the `web_search` server tool enabled — real HTTP, real
 * request/response shape (`content[].citations[].url` on text blocks is the
 * documented shape for a web-search-grounded citation). Pinned to a
 * haiku-class model — see `DEFAULT_MODEL`'s own doc comment for why.
 */
export function createClaudeAdapter(options: ClaudeAdapterOptions): EngineCaptureAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxTokens = options.maxTokens ?? 1024;

  return async ({ promptText, clientDomains, competitorRoster, clientBrandName }): Promise<EngineCaptureAdapterResult> => {
    const response = await fetchImpl(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": options.apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: promptText }],
        tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: "web_search", max_uses: 3 }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`anthropic /v1/messages returned ${response.status}`);
    }
    const body = (await response.json()) as AnthropicMessagesResponse;
    const textBlocks = (body.content ?? []).filter((b) => b.type === "text");
    const text = textBlocks.map((b) => b.text ?? "").join("\n");
    const citationUrls = textBlocks
      .flatMap((b) => b.citations ?? [])
      .map((c) => c.url)
      .filter((url): url is string => typeof url === "string");

    const analyzed = analyzeAnswer({ text, citationUrls, clientDomains, competitorRoster, ...(clientBrandName ? { clientBrandName } : {}) });
    // `web_search` was offered on every call; whether it was actually used is
    // exactly "did any citation come back" — a call that answered from the
    // model's own knowledge with zero searches is a real, honestly ungrounded
    // MEASURED cell, not MEASURED_grounded.
    return { captureTier: citationUrls.length > 0 ? "MEASURED_grounded" : "MEASURED", ...analyzed, rawPayload: body };
  };
}
