import type { EngineCaptureAdapter } from "../capture-visibility.js";
import type { VisibilityEngine } from "../capture-visibility.js";
import { createPerplexityAdapter } from "./perplexity.js";
import { createClaudeAdapter } from "./claude.js";
import { createGeminiAdapter } from "./gemini.js";
import { createScrappyCocoAnswerEngineAdapter } from "./scrappycoco-answer-engine.js";

export * from "./analyze-answer.js";
export * from "./perplexity.js";
export * from "./claude.js";
export * from "./gemini.js";
export * from "./scrappycoco-answer-engine.js";

export interface CreateDefaultCaptureAdaptersOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
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
 * Deliberately reuses `ANTHROPIC_API_KEY`/`GEMINI_API_KEY`/`SCRAPPYCOCO_API_KEY`
 * rather than minting three more credentials for capabilities this repo
 * already configures those three for — `PERPLEXITY_API_KEY` is the one new
 * one this ticket adds (see `.env.example` and the `CAPABILITY_CATALOGUE`
 * entry this ticket also added).
 */
export function createDefaultCaptureAdapters(options: CreateDefaultCaptureAdaptersOptions = {}): Partial<Record<VisibilityEngine, EngineCaptureAdapter>> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl;
  const adapters: Partial<Record<VisibilityEngine, EngineCaptureAdapter>> = {};

  const perplexityKey = env["PERPLEXITY_API_KEY"]?.trim();
  if (perplexityKey) adapters.perplexity = createPerplexityAdapter({ apiKey: perplexityKey, ...(fetchImpl ? { fetchImpl } : {}) });

  const anthropicKey = env["ANTHROPIC_API_KEY"]?.trim();
  if (anthropicKey) adapters.claude = createClaudeAdapter({ apiKey: anthropicKey, ...(fetchImpl ? { fetchImpl } : {}) });

  const geminiKey = env["GEMINI_API_KEY"]?.trim();
  if (geminiKey) adapters.gemini = createGeminiAdapter({ apiKey: geminiKey, ...(fetchImpl ? { fetchImpl } : {}) });

  const scrappyCocoKey = env["SCRAPPYCOCO_API_KEY"]?.trim();
  if (scrappyCocoKey) {
    adapters.chatgpt = createScrappyCocoAnswerEngineAdapter("chatgpt", { apiKey: scrappyCocoKey, ...(fetchImpl ? { fetchImpl } : {}) });
    adapters.copilot = createScrappyCocoAnswerEngineAdapter("copilot", { apiKey: scrappyCocoKey, ...(fetchImpl ? { fetchImpl } : {}) });
  }

  // SerpApi's `google_ai_overview` capability is deliberately OFF, not built
  // (the source ticket's own instruction) — no adapter, no env var, no
  // catalogue row for it. Gemini's own Grounding-with-Google-Search adapter
  // above is this environment's real signal for Google's AI-Overview
  // equivalent (see `gemini.ts`'s `aioAbsent` doc comment).

  return adapters;
}
