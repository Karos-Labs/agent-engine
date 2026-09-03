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

export interface GeminiVertexAdapterOptions {
  projectId: string;
  location: string;
  /**
   * Resolves the `Authorization` header value for one request — an ADC bearer
   * token, live rather than static because it expires roughly hourly.
   *
   * Injected rather than resolved here so this package keeps its
   * `google-auth-library` dependency at the composition root and stays
   * testable without one, the same shape `createVertexModelGardenFetch`
   * (`@agent-engine/core`) already uses for the Model Garden client. A test
   * passes `async () => "Bearer test"`.
   */
  authorize: () => Promise<string>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  model?: string;
  timeoutMs?: number;
}

interface GeminiGroundingChunk {
  web?: { uri?: string; title?: string; domain?: string };
}

/** Looks like a bare hostname (`beomniscient.com`) rather than a page title. */
const DOMAIN_LIKE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * The publisher a grounding chunk actually points at.
 *
 * `web.uri` is NOT the source. Verified against the live Vertex endpoint on
 * 2026-09-03: every chunk's `uri` is a
 * `vertexaisearch.cloud.google.com/grounding-api-redirect/...` wrapper, and the
 * real publisher is carried separately in `web.domain` (`beomniscient.com`,
 * `thekeenfolks.com`). Reading `uri` alone therefore hands `analyzeAnswer` a
 * list of Google redirect hosts, and `brandCited` can never be true for any
 * client on this route — a permanently, silently wrong "your brand is never
 * cited" for every Gemini cell.
 *
 * `domain` first, then `title` ONLY when it is domain-shaped (the Developer
 * API often puts a hostname there where Vertex populates `domain`; it can also
 * hold a real page title, which is not a source), then the raw `uri` as a last
 * resort so a payload carrying neither still contributes something.
 * `analyzeAnswer.domainOf` parses a URL and falls back to the raw string, so a
 * bare hostname matches correctly either way.
 */
function chunkSource(chunk: GeminiGroundingChunk): string | undefined {
  const web = chunk.web;
  if (!web) return undefined;
  const domain = web.domain?.trim();
  if (domain) return domain;
  const title = web.title?.trim();
  if (title && DOMAIN_LIKE.test(title)) return title;
  return typeof web.uri === "string" && web.uri.trim() ? web.uri.trim() : undefined;
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
    return toCaptureResult(body, clientDomains, competitorRoster);
  };
}

/**
 * The same capture, through Vertex AI instead of the Gemini Developer API.
 *
 * Why it exists: on prep, `GEMINI_API_KEY` is not set, so the Developer-API
 * adapter above was simply absent from `createDefaultCaptureAdapters`' map and
 * all 25 of Gemini's cells came back `UNAVAILABLE`/`no_adapter_wired` on every
 * run — a quarter of the visibility matrix measuring nothing while the
 * deployment already had working Google credentials sitting right there
 * (`GEMINI_VERTEX_PROJECT_ID`, `VERTEX_AI_LOCATION`, and ADC on the service
 * account). This route needs no new secret.
 *
 * Two differences from the Developer API, both real:
 *   - The model id lives in the URL path under `publishers/google/models/`,
 *     and auth is an ADC bearer token rather than a `?key=` query parameter.
 *   - The grounding tool is spelled `googleSearch`, not `google_search`.
 *     Protobuf JSON accepts either spelling, but this is the documented one
 *     for Vertex and the one its own samples use.
 *
 * The response shape is identical — `candidates[0].groundingMetadata.
 * groundingChunks` — which is why both routes share `toCaptureResult` and
 * neither has its own opinion about what a captured cell looks like.
 */
export function createGeminiVertexAdapter(options: GeminiVertexAdapterOptions): EngineCaptureAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const host = options.baseUrl ?? `https://${options.location}-aiplatform.googleapis.com/v1`;
  const url = `${host.replace(/\/+$/, "")}/projects/${options.projectId}/locations/${options.location}/publishers/google/models/${model}:generateContent`;

  return async ({ promptText, clientDomains, competitorRoster }): Promise<EngineCaptureAdapterResult> => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: await options.authorize() },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: promptText }] }], tools: [{ googleSearch: {} }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // The status alone sent a reader looking in the wrong place for the
      // 429s Agent Platform actually returns under load; the body names the
      // quota. Truncated because a Vertex error body can carry a long trace.
      const detail = await response.text().catch(() => "");
      throw new Error(`gemini (vertex) generateContent returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    }
    const body = (await response.json()) as GeminiGenerateContentResponse;
    return toCaptureResult(body, clientDomains, competitorRoster);
  };
}

/** Shared by both routes — one definition of what Gemini's answer means. */
function toCaptureResult(
  body: GeminiGenerateContentResponse,
  clientDomains: readonly string[],
  competitorRoster: readonly string[],
): EngineCaptureAdapterResult {
  const candidate = body.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("\n");
  const groundingChunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const citationUrls = groundingChunks.map(chunkSource).filter((url): url is string => url !== undefined);
  const aioAbsent = groundingChunks.length === 0;

  const analyzed = analyzeAnswer({ text, citationUrls, clientDomains, competitorRoster });
  return { captureTier: aioAbsent ? "MEASURED" : "MEASURED_grounded", ...analyzed, aioAbsent, rawPayload: body };
}
