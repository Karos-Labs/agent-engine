import type { EngineCaptureAdapter, EngineCaptureAdapterResult } from "../capture-visibility.js";
import { analyzeAnswer } from "./analyze-answer.js";

/**
 * ScrappyCoco's synchronous execution endpoint — same one
 * `@agent-engine/tool-karos-scraper`'s `createScrappyCocoScraper` uses
 * (`EXECUTE_PATH`'s own doc comment there: probed directly against the
 * account, since the published docs only describe the async job queue).
 * Deliberately NOT imported from that package: answering "what does ChatGPT
 * say" is not a scrape-a-page or read-a-social-account capability
 * (`ScraperProvider`'s own five methods), and RFC-01 §4's tool-package
 * independence convention is what already governs `CaptureCell` being
 * duplicated between this package and `karos-seo-geo` rather than shared —
 * the same reasoning applies here to a second, answer-engine-flavored HTTP
 * client rather than widening `ScraperProvider` for one caller.
 */
const DEFAULT_BASE_URL = "https://api.scrappycoco.ai/api/v1";
const EXECUTE_PATH = "/scrapers/execute";

/**
 * The capability name this adapter calls for a ChatGPT/Copilot answer-engine
 * query. UNVERIFIED against live ScrappyCoco docs (same caveat
 * `createScrappyCocoScraper`'s own `EXECUTE_PATH` comment carries for that
 * endpoint) — the most plausible extension of the vendor's existing
 * `{source, capability, input}` convention (`web.search_web`,
 * `x.account_posts`, ...) to "ask this answer engine a question and give me
 * back its response plus citations," but this repo has no confirmed route
 * name for it. Named here as one constant so it is the one thing to correct
 * once the real route is confirmed against a live account.
 */
const ANSWER_QUERY_CAPABILITY = "answer_query";

export type ScrappyCocoAnswerEngine = "chatgpt" | "copilot";

export interface ScrappyCocoAnswerEngineAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  idempotencyKey?: () => string;
}

interface ScrappyCocoAnswerEngineResponse {
  status?: string;
  records?: Array<{ text?: string; outputs?: { citations?: string[] } }>;
}

/**
 * `createScrappyCocoAnswerEngineAdapter` (T-A3/SCRUM-237): ChatGPT and
 * Copilot both go through ScrappyCoco's CLI-driven browser automation route
 * (`source: "chatgpt" | "copilot"`) — neither has a first-party API for
 * "what did your answer-engine UI actually show," so a routed execution is
 * the only real capture path. The workflow's own fanout caps this route at
 * concurrency 3 (`create-seo-geo-agent-workflow.ts` step 07) — a CLI-driven
 * browser automation route is the one of the 5 engines least able to
 * tolerate a large burst.
 */
export function createScrappyCocoAnswerEngineAdapter(engine: ScrappyCocoAnswerEngine, options: ScrappyCocoAnswerEngineAdapterOptions): EngineCaptureAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 120_000;
  let counter = 0;
  const nextKey = options.idempotencyKey ?? (() => `karos-seo-geo-capture-${Date.now()}-${++counter}`);

  return async ({ promptText, clientDomains, competitorRoster }): Promise<EngineCaptureAdapterResult> => {
    const response = await fetchImpl(`${baseUrl}${EXECUTE_PATH}`, {
      method: "POST",
      headers: { "X-API-Key": options.apiKey, "Content-Type": "application/json", "Idempotency-Key": nextKey() },
      body: JSON.stringify({ source: engine, capability: ANSWER_QUERY_CAPABILITY, input: { query: promptText }, limit: 1 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`scrappycoco ${engine}.${ANSWER_QUERY_CAPABILITY} returned ${response.status}`);
    }
    const body = (await response.json()) as ScrappyCocoAnswerEngineResponse;
    if (body.status !== undefined && body.status !== "completed" && body.status !== "partial") {
      throw new Error(`scrappycoco ${engine}.${ANSWER_QUERY_CAPABILITY} finished as "${body.status}"`);
    }
    const record = body.records?.[0];
    const text = record?.text ?? "";
    const citationUrls = record?.outputs?.citations ?? [];

    const analyzed = analyzeAnswer({ text, citationUrls, clientDomains, competitorRoster });
    return { captureTier: "MEASURED", ...analyzed, rawPayload: body };
  };
}
