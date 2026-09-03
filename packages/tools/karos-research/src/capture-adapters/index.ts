import type { EngineCaptureAdapter } from "../capture-visibility.js";
import type { VisibilityEngine } from "../capture-visibility.js";
import { createPerplexityAdapter } from "./perplexity.js";
import { createClaudeAdapter } from "./claude.js";
import { createGeminiAdapter, createGeminiVertexAdapter } from "./gemini.js";
import { createOpenAiAnswerEngineAdapter } from "./openai-answer-engine.js";

export * from "./analyze-answer.js";
export * from "./perplexity.js";
export * from "./claude.js";
export * from "./gemini.js";
export * from "./openai-answer-engine.js";

export interface CreateDefaultCaptureAdaptersOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /**
   * Resolves an ADC `Authorization` header for the Vertex route, when one is
   * reachable. Supplied by the composition root
   * (`createKarosResearchTools` -> `createAllKarosTools`) so this package needs
   * no `google-auth-library` dependency of its own; omitted, the Vertex Gemini
   * route is simply not wired, exactly like a missing API key.
   */
  vertexAuthorize?: () => Promise<string>;
}

/**
 * Builds `research.captureVisibility`'s per-engine adapter map from
 * environment credentials (T-A3/SCRUM-237) — the same "wired unconditionally,
 * honest per call" rule every other credentialed capability in this repo
 * follows (`media.*`, `video.*`, `landing.*`, `research.pull`'s own scraper):
 * an engine with no key configured here is simply absent from the returned
 * map, which `createCaptureVisibility` already treats as "no adapter wired"
 * — an honest `UNAVAILABLE` cell, never a construction-time throw.
 *
 * Deliberately reuses `ANTHROPIC_API_KEY`/`GEMINI_API_KEY` rather than minting
 * more credentials for capabilities this repo already configures those for.
 * `PERPLEXITY_API_KEY` and `OPENAI_API_KEY` are this map's own (see
 * `.env.example` and the `CAPABILITY_CATALOGUE` entries).
 *
 * `SCRAPPYCOCO_API_KEY` is no longer read here. It still backs
 * `research.pull`'s scraper; it never backed answer-engine capture, because
 * ScrappyCoco has no answer-engine capability — see the ChatGPT block below.
 *
 * ## What "absent" costs, and why it is still right
 *
 * An engine with no credential is absent from this map and every one of its
 * cells reports `UNAVAILABLE`/`no_adapter_wired`. That is honest, and it is
 * also load-bearing: `dataCoveragePct` and the N_e denominator both count it
 * as unmeasured rather than as a zero score, so an unconfigured engine lowers
 * confidence without inventing a bad result. What it must never become is a
 * SILENT absence — see `create-seo-geo-agent-workflow.ts` step 07, where a
 * throwing adapter's slot is dropped by `completedOutputs` and the engine
 * disappears from the report entirely instead of reporting `UNAVAILABLE`.
 * That is why an unroutable engine is left unwired here rather than wired to
 * a route that will throw.
 */
export function createDefaultCaptureAdapters(options: CreateDefaultCaptureAdaptersOptions = {}): Partial<Record<VisibilityEngine, EngineCaptureAdapter>> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl;
  const adapters: Partial<Record<VisibilityEngine, EngineCaptureAdapter>> = {};

  const perplexityKey = env["PERPLEXITY_API_KEY"]?.trim();
  if (perplexityKey) adapters.perplexity = createPerplexityAdapter({ apiKey: perplexityKey, ...(fetchImpl ? { fetchImpl } : {}) });

  const anthropicKey = env["ANTHROPIC_API_KEY"]?.trim();
  if (anthropicKey) adapters.claude = createClaudeAdapter({ apiKey: anthropicKey, ...(fetchImpl ? { fetchImpl } : {}) });

  // Gemini has two routes to the same capture, and the direct key wins when
  // both are present — it is the cheaper call and needs no token round trip.
  // The Vertex fallback matters because a deployment can easily have working
  // Google credentials and no `GEMINI_API_KEY` at all, which is exactly prep's
  // situation: 25 of 125 cells came back `no_adapter_wired` every run while
  // `GEMINI_VERTEX_PROJECT_ID` sat configured on the same service.
  const geminiKey = env["GEMINI_API_KEY"]?.trim();
  const vertexProject = (env["GEMINI_VERTEX_PROJECT_ID"] ?? env["GOOGLE_CLOUD_PROJECT"])?.trim();
  const vertexLocation = env["VERTEX_AI_LOCATION"]?.trim() || "us-central1";
  if (geminiKey) {
    adapters.gemini = createGeminiAdapter({ apiKey: geminiKey, ...(fetchImpl ? { fetchImpl } : {}) });
  } else if (options.vertexAuthorize && vertexProject) {
    adapters.gemini = createGeminiVertexAdapter({
      projectId: vertexProject,
      location: vertexLocation,
      authorize: options.vertexAuthorize,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  // ChatGPT via OpenAI's own Responses API + `web_search`.
  //
  // This REPLACES the ScrappyCoco answer-engine route, which never worked and
  // could not: that adapter posted `capability: "answer_query"` against a
  // vendor whose live `/scrapers` catalogue has no such capability and no
  // `chatgpt`/`copilot` source at all (52 capabilities, all web/social/filings
  // scraping). Its own comment recorded the route as unverified. `copilot` has
  // no first-party equivalent, so it stays unwired and reports the honest
  // `no_adapter_wired` rather than failing every slot.
  const openAiKey = env["OPENAI_API_KEY"]?.trim();
  if (openAiKey) adapters.chatgpt = createOpenAiAnswerEngineAdapter({ apiKey: openAiKey, ...(fetchImpl ? { fetchImpl } : {}) });

  // SerpApi's `google_ai_overview` capability is deliberately OFF, not built
  // (the source ticket's own instruction) — no adapter, no env var, no
  // catalogue row for it. Gemini's own Grounding-with-Google-Search adapter
  // above is this environment's real signal for Google's AI-Overview
  // equivalent (see `gemini.ts`'s `aioAbsent` doc comment).

  return adapters;
}
