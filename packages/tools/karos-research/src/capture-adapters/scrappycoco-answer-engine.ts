import type { EngineCaptureAdapter, EngineCaptureAdapterResult } from "../capture-visibility.js";
import { analyzeAnswer } from "./analyze-answer.js";

const DEFAULT_BASE_URL = "https://api.scrappycoco.ai/api/v1";
const EXECUTE_PATH = "/scrapers/execute";

/** The three ScrappyCoco capabilities this adapter can back — one instance per capability, wired in `capture-adapters/index.ts`. */
export type ScrappyCocoAnswerEngineCapability = "ask_chatgpt" | "ask_copilot" | "ask_google_ai_mode";

export interface ScrappyCocoAnswerEngineAdapterOptions {
  apiKey: string;
  capability: ScrappyCocoAnswerEngineCapability;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Injectable so a test's Idempotency-Key is deterministic. */
  idempotencyKey?: () => string;
}

interface ScrappyCocoAnswerCitation {
  url?: unknown;
}

interface ScrappyCocoAnswerRecord {
  text?: unknown;
  outputs?: { citations?: ScrappyCocoAnswerCitation[] };
}

interface ScrappyCocoExecuteResponse {
  status?: unknown;
  records?: unknown;
}

/**
 * ChatGPT / Copilot / Google-AI-Mode visibility capture, through ScrappyCoco's
 * `web.ask_chatgpt` / `web.ask_copilot` / `web.ask_google_ai_mode`.
 *
 * ## Why this exists, and why the earlier ChatGPT/Copilot route did not
 *
 * The previous ScrappyCoco route for ChatGPT/Copilot posted
 * `{source: "chatgpt", capability: "answer_query"}` against an account whose
 * live catalogue had no such capability at all — every cell threw and both
 * engines silently vanished from the report rather than reporting
 * `UNAVAILABLE` (see `openai-answer-engine.ts`'s header). That was replaced by
 * OpenAI's own Responses API for ChatGPT; Copilot was left unwired for lack of
 * any route.
 *
 * Verified live against the account on 2026-09-20: it now has three real
 * capabilities answering this shape — `web.ask_chatgpt`, `web.ask_copilot`,
 * `web.ask_google_ai_mode` — each returning a real answer (`record.text`) plus
 * citations (`record.outputs.citations[].url`). This is what makes Copilot
 * capturable for the first time (it has never had a working route before
 * this), and gives ChatGPT a second, comparable source — see
 * `AI_VISIBILITY_CHATGPT_SOURCE` in `capture-adapters/index.ts`, meant to run
 * both sources for a while before picking one.
 *
 * `google_aio` (Google's AI-Overview SERP feature, a DIFFERENT product from AI
 * Mode) is NOT backed by this adapter: the capability catalogue's own
 * description claims `web.search_web` takes a `provider`/`include.aioverview`
 * pair for it, but the account's live input schema rejects both
 * (`additionalProperties: false`, verified 422 on 2026-09-20) — the same "the
 * docs describe a route that does not actually work" pattern the old
 * ChatGPT/Copilot route was. Gemini's Grounding-with-Google-Search adapter
 * remains this environment's real signal for that engine.
 *
 * **This measures the vendor's own reconstruction of the product's answer,
 * not a browser session against the real ChatGPT/Copilot/AI-Mode UI** — the
 * same caveat `openai-answer-engine.ts` carries, for the same reason: no route
 * here involves browser automation against a logged-in account. A client
 * comparing this against what they see in the product will find differences,
 * and that is expected rather than a defect.
 *
 * Tiering matches every other adapter in this directory: `MEASURED_grounded`
 * when the answer carried at least one citation, `MEASURED` when it did not.
 */
export function createScrappyCocoAnswerEngineAdapter(options: ScrappyCocoAnswerEngineAdapterOptions): EngineCaptureAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 120_000;
  let counter = 0;
  const nextKey = options.idempotencyKey ?? (() => `karos-aivis-${Date.now()}-${++counter}`);

  return async ({ promptText, clientDomains, competitorRoster, clientBrandName, clientBrandAliases }): Promise<EngineCaptureAdapterResult> => {
    const response = await fetchImpl(`${baseUrl}${EXECUTE_PATH}`, {
      method: "POST",
      headers: { "X-API-Key": options.apiKey, "Content-Type": "application/json", "Idempotency-Key": nextKey() },
      body: JSON.stringify({ source: "web", capability: options.capability, input: { query: promptText }, limit: 1 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // Body included: a 402/429 here needs a different fix than a 4xx schema
      // rejection, which the status code alone does not distinguish.
      const detail = await response.text().catch(() => "");
      throw new Error(`scrappycoco web.${options.capability} returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    }

    const body = (await response.json()) as ScrappyCocoExecuteResponse;
    const status = typeof body.status === "string" ? body.status : undefined;
    // A 200 carrying a terminal non-success status is still a failure — see
    // `karos-scraper/src/scrappycoco.ts`'s identical check and its own comment
    // on why this must not be read as "a query that found nothing."
    if (status !== undefined && status !== "completed" && status !== "partial") {
      throw new Error(`scrappycoco web.${options.capability} finished as "${status}"`);
    }

    const records = Array.isArray(body.records) ? (body.records as ScrappyCocoAnswerRecord[]) : [];
    const record = records[0];
    // No record at all is a real, successful capture of "this engine had
    // nothing to say" — analyzeAnswer("") below reports it honestly as
    // brandMentioned: false, exactly like every other adapter's empty case.
    const text = typeof record?.text === "string" ? record.text : "";
    const citationUrls = (record?.outputs?.citations ?? [])
      .map((c) => c?.url)
      .filter((url): url is string => typeof url === "string");

    const analyzed = analyzeAnswer({
      text,
      citationUrls,
      clientDomains,
      competitorRoster,
      ...(clientBrandName ? { clientBrandName } : {}),
      ...(clientBrandAliases && clientBrandAliases.length > 0 ? { clientBrandAliases } : {}),
    });
    return {
      captureTier: citationUrls.length > 0 ? "MEASURED_grounded" : "MEASURED",
      ...analyzed,
      rawPayload: body,
    };
  };
}
