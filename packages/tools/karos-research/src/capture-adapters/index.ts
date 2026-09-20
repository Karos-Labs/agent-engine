import type { EngineCaptureAdapter } from "../capture-visibility.js";
import type { VisibilityEngine } from "../capture-visibility.js";
import { createPerplexityAdapter } from "./perplexity.js";
import { createClaudeAdapter } from "./claude.js";
import { createGeminiAdapter, createGeminiVertexAdapter } from "./gemini.js";
import { createOpenAiAnswerEngineAdapter } from "./openai-answer-engine.js";
import { createScrappyCocoAnswerEngineAdapter } from "./scrappycoco-answer-engine.js";

export * from "./analyze-answer.js";
export * from "./perplexity.js";
export * from "./claude.js";
export * from "./gemini.js";
export * from "./openai-answer-engine.js";
export * from "./scrappycoco-answer-engine.js";

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
 * `SCRAPPYCOCO_API_KEY` backs `copilot` and `aimode` here as of 2026-09-20
 * (verified live capabilities — see `scrappycoco-answer-engine.ts`'s header
 * for what changed and why it did not work before), in addition to its
 * existing job backing `research.pull`'s scraper. It can also back `chatgpt`
 * instead of OpenAI's route, but only when asked — see the ChatGPT block
 * below.
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
  // `global`, not `VERTEX_AI_LOCATION` (which is `us-central1` in both
  // deployments): since the 3.x migration this adapter asks for
  // `gemini-3.8-flash`, and every 3.x id 404s at `us-central1` while answering
  // on `global` — probed 2026-09-17 as the worker's own service account.
  // GEMINI_CAPTURE_LOCATION overrides if Google ever regionalises them.
  const vertexLocation = env["GEMINI_CAPTURE_LOCATION"]?.trim() || "global";
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

  // ChatGPT: OpenAI's own Responses API + `web_search` by default.
  //
  // ScrappyCoco's `web.ask_chatgpt` route USED to be unusable — it posted
  // `capability: "answer_query"` against a vendor whose live `/scrapers`
  // catalogue had no such capability at all. That has changed: verified
  // live on 2026-09-20, `web.ask_chatgpt` is a real, working capability (see
  // `scrappycoco-answer-engine.ts`'s header). `AI_VISIBILITY_CHATGPT_SOURCE`
  // lets a caller switch to it explicitly — meant for running both sources
  // for a while and comparing the persisted cells before picking one, not as
  // a silent fallback. Unset (or any other value) keeps today's default.
  const openAiKey = env["OPENAI_API_KEY"]?.trim();
  const scrappyCocoKey = env["SCRAPPYCOCO_API_KEY"]?.trim();
  const chatgptSource = env["AI_VISIBILITY_CHATGPT_SOURCE"]?.trim().toLowerCase();
  if (chatgptSource === "scrappycoco" && scrappyCocoKey) {
    adapters.chatgpt = createScrappyCocoAnswerEngineAdapter({ apiKey: scrappyCocoKey, capability: "ask_chatgpt", ...(fetchImpl ? { fetchImpl } : {}) });
  } else if (openAiKey) {
    adapters.chatgpt = createOpenAiAnswerEngineAdapter({ apiKey: openAiKey, ...(fetchImpl ? { fetchImpl } : {}) });
  }

  // Copilot: ScrappyCoco's `web.ask_copilot` — verified live on 2026-09-20.
  // Copilot has never had a working route in this build before now; it is a
  // pure addition, not a replacement of anything.
  if (scrappyCocoKey) adapters.copilot = createScrappyCocoAnswerEngineAdapter({ apiKey: scrappyCocoKey, capability: "ask_copilot", ...(fetchImpl ? { fetchImpl } : {}) });

  // Google AI Mode: ScrappyCoco's `web.ask_google_ai_mode` — verified live on
  // 2026-09-20, a real answer plus citations. A DIFFERENT Google product from
  // the AI-Overview SERP feature (`google_aio`, still unwired — see below).
  if (scrappyCocoKey) adapters.aimode = createScrappyCocoAnswerEngineAdapter({ apiKey: scrappyCocoKey, capability: "ask_google_ai_mode", ...(fetchImpl ? { fetchImpl } : {}) });

  // `google_aio` (Google's AI-Overview SERP feature) stays unwired. Its own
  // capability's description text claims `web.search_web` takes a
  // `provider`/`include.aioverview` pair to surface it, but the account's live
  // input schema rejects both with a 422 ("Extra inputs are not permitted"),
  // verified 2026-09-20 — the documented route does not actually exist, the
  // same way the old ChatGPT/Copilot route did not. SerpApi's own
  // `google_ai_overview` capability is separately, deliberately OFF (the
  // source ticket's own instruction) — no adapter, no env var, no catalogue
  // row for it either. Gemini's own Grounding-with-Google-Search adapter
  // above remains this environment's real signal for Google's AI-Overview
  // equivalent (see `gemini.ts`'s `aioAbsent` doc comment).

  return adapters;
}
