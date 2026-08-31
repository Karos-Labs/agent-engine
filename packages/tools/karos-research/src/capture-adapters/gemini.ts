import type { EngineCaptureAdapter, EngineCaptureAdapterResult } from "../capture-visibility.js";
import { analyzeAnswer } from "./analyze-answer.js";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
// `gemini-2.5-flash`, not `gemini-2.0-flash`, and the reason is billing rather
// than capability. `check-model-pricing.ts` (wired into `pretest`) hard-fails on
// any model id named in source with no row in MODEL_PRICING, and 2.0-flash has
// none — so with it here the whole test suite refuses to run. It cannot simply be
// priced either: it is absent from ai.google.dev/gemini-api/docs/pricing entirely
// (checked 2026-08-30), the same apparent-EOL state SCRUM-314 documented for
// gemini-1.5-flash, and inventing a rate is precisely what that table exists to
// prevent. 2.5-flash is priced from a checked source, is currently listed, and is
// the id every other Gemini default in this repo already uses.
const DEFAULT_MODEL = "gemini-2.5-flash";

export interface GeminiAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  model?: string;
  timeoutMs?: number;
}

interface GeminiGroundingChunk {
  web?: { uri?: string };
}
interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> };
  groundingMetadata?: { groundingChunks?: GeminiGroundingChunk[] };
}
interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
}

/**
 * `createGeminiAdapter` (T-A3/SCRUM-237): Gemini via `generateContent` with
 * `tools: [{ google_search: {} }]` — Grounding with Google Search, the
 * closest first-party equivalent this API exposes to "did an AI Overview
 * render for this query." Real HTTP, real request/response shape:
 * `candidates[0].groundingMetadata.groundingChunks` is the documented field
 * naming which grounded sources backed the answer.
 *
 * `aioAbsent: true` when `groundingChunks` came back empty/missing — Google's
 * AI-Overview-equivalent genuinely did not render for this query, a fact
 * distinct from `brandMentioned: false` (an answer DID come back, grounded or
 * not, and simply never named the brand). See `CaptureCell.aioAbsent`'s own
 * doc comment for why these must never be conflated.
 */
export function createGeminiAdapter(options: GeminiAdapterOptions): EngineCaptureAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? 60_000;

  return async ({ promptText, clientDomains, competitorRoster }): Promise<EngineCaptureAdapterResult> => {
    const response = await fetchImpl(`${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(options.apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }], tools: [{ google_search: {} }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`gemini generateContent returned ${response.status}`);
    }
    const body = (await response.json()) as GeminiGenerateContentResponse;
    const candidate = body.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("\n");
    const groundingChunks = candidate?.groundingMetadata?.groundingChunks ?? [];
    const citationUrls = groundingChunks.map((c) => c.web?.uri).filter((url): url is string => typeof url === "string");
    const aioAbsent = groundingChunks.length === 0;

    const analyzed = analyzeAnswer({ text, citationUrls, clientDomains, competitorRoster });
    return { captureTier: aioAbsent ? "MEASURED" : "MEASURED_grounded", ...analyzed, aioAbsent, rawPayload: body };
  };
}
