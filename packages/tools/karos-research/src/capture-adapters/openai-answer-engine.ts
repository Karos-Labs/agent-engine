import type { EngineCaptureAdapter, EngineCaptureAdapterResult } from "../capture-visibility.js";
import { analyzeAnswer } from "./analyze-answer.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const RESPONSES_PATH = "/responses";

/**
 * `gpt-4o`, not `gpt-4o-mini`, and not a newer id.
 *
 * `check-model-pricing.ts` (wired into `pretest`) hard-fails on any model id
 * named in source with no row in `MODEL_PRICING`, and the table currently
 * prices exactly two OpenAI models. Between them, the larger one is the right
 * default here: this step's whole job is to reproduce what a person sees when
 * they ask ChatGPT a question, and a cheaper model that searches less thoroughly
 * measures something the client is not experiencing. Overridable per call site.
 */
const DEFAULT_MODEL = "gpt-4o";

export interface OpenAiAnswerEngineAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  model?: string;
  timeoutMs?: number;
}

/** The slice of the Responses API payload this adapter reads. */
interface OpenAiResponsesBody {
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{ type?: string; url?: string }>;
    }>;
  }>;
}

/**
 * ChatGPT visibility capture, through OpenAI's Responses API with the
 * server-side `web_search` tool.
 *
 * ## Why this exists, and what it is not
 *
 * The previous route was `createScrappyCocoAnswerEngineAdapter`, which posted
 * `{source: "chatgpt", capability: "answer_query"}` to ScrappyCoco. Its own
 * comment recorded that the route name was never verified against a live
 * account. It is wrong: ScrappyCoco's `/scrapers` catalogue lists 52
 * capabilities across `web`/`x`/`reddit`/`instagram`/`tiktok`/`filings`, with
 * no `chatgpt` source, no `copilot`, and no `answer_query`. Every ChatGPT and
 * Copilot capture slot therefore threw, and the workflow's `completedOutputs`
 * dropped the failed slots — so both engines silently vanished from the report
 * rather than appearing as unmeasured.
 *
 * **This is the API, not the ChatGPT product.** The answers and especially the
 * citations will not match what a person sees in the ChatGPT UI: different
 * retrieval, different ranking, no personalization, no memory. It is the
 * closest first-party signal obtainable without browser automation, and it is
 * a real measurement of a real OpenAI surface — but a client comparing it
 * against their own ChatGPT window will find differences, and that is expected
 * rather than a defect. `copilot` has no equivalent route at all and stays
 * unwired.
 *
 * The tier is `MEASURED` when the model answered without searching and
 * `MEASURED_grounded` when it cited sources — matching `gemini.ts`'s split, so
 * the two grounded engines mean the same thing by the same word.
 */
export function createOpenAiAnswerEngineAdapter(options: OpenAiAnswerEngineAdapterOptions): EngineCaptureAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? 120_000;

  return async ({ promptText, clientDomains, competitorRoster }): Promise<EngineCaptureAdapterResult> => {
    const response = await fetchImpl(`${baseUrl}${RESPONSES_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      // `tool_choice` is not optional decoration — VERIFIED against the live
      // API on 2026-09-03. Offering the tool without forcing it, the model
      // answered this exact prompt from training data: no `web_search_call` in
      // `output`, zero `url_citation` annotations, 511 characters. Forced, the
      // same prompt searched and returned 6090 characters with real publisher
      // citations. Unforced, this adapter would measure the model's MEMORY of
      // the web rather than what ChatGPT tells a person today, and
      // `brandCited` would be false for every client on every cell — the same
      // silent zero the ScrappyCoco route produced, arriving by a different
      // road.
      body: JSON.stringify({
        model,
        input: promptText,
        tools: [{ type: "web_search" }],
        tool_choice: { type: "web_search" },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // Body included: a 400 here is usually "this model does not support
      // web_search", which the status alone hides behind a generic failure.
      const detail = await response.text().catch(() => "");
      throw new Error(`openai responses returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    }

    const body = (await response.json()) as OpenAiResponsesBody;

    // `output` interleaves `web_search_call` entries with the `message` that
    // carries the answer, so the text is gathered from the message content
    // blocks rather than from `output[0]`.
    const blocks = (body.output ?? []).flatMap((item) => item.content ?? []);
    const text = blocks
      .filter((b) => b.type === "output_text")
      .map((b) => b.text ?? "")
      .join("\n");
    const citationUrls = blocks
      .flatMap((b) => b.annotations ?? [])
      .filter((a) => a.type === "url_citation")
      .map((a) => a.url)
      .filter((url): url is string => typeof url === "string");

    const analyzed = analyzeAnswer({ text, citationUrls, clientDomains, competitorRoster });
    return {
      captureTier: citationUrls.length > 0 ? "MEASURED_grounded" : "MEASURED",
      ...analyzed,
      rawPayload: body,
    };
  };
}
