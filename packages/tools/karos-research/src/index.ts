import type { AgentToolRegistry } from "@agent-engine/core";
import { createWorkspaceStore, type WorkspaceStoreLike } from "@agent-engine/tool-common";
import { createPull } from "./pull.js";
import { createGetRuns } from "./get-runs.js";
import { createWriteRun } from "./write-run.js";
import { createCheckFreshness } from "./check-freshness.js";
import { createCaptureVisibility, type CreditProbe, type EngineCaptureAdapter, type VisibilityEngine } from "./capture-visibility.js";
import { createDefaultCaptureAdapters } from "./capture-adapters/index.js";
import { createCrawlTechnicalSeo } from "./crawl-technical-seo.js";
import { createScraperProvider, type ScraperProvider } from "@agent-engine/tool-karos-scraper";

export * from "./runs.js";
export * from "./pull.js";
export * from "./get-runs.js";
export * from "./write-run.js";
export * from "./check-freshness.js";
export * from "./capture-visibility.js";
export * from "./capture-adapters/index.js";
export * from "./crawl-technical-seo.js";
export * from "./payload.js";

export interface KarosResearchToolsOptions {
  env?: Record<string, string | undefined>;
  /** Overrides the env-derived scraper. Tests pass a fake; `null` forces the unconfigured path. */
  scraper?: ScraperProvider | null;
  fetchImpl?: typeof fetch;
  /**
   * Injected pre-flight credit probe for `research.captureVisibility`
   * (RFC-04 §5's "Pre-flight credit probe AND per-cell 402 handling").
   * Omitted (the default) means every cell probes `{ ok: true }` — today's
   * stand-in behavior is unchanged until a real provider client is wired up
   * and supplies one. Tests pass a fake to exercise the 402 path.
   */
  visibilityCreditProbe?: CreditProbe;
  /**
   * Overrides `createDefaultCaptureAdapters`' env-derived per-engine adapter
   * map (T-A3/SCRUM-237). Omitted (the default) derives real adapters from
   * `options.env`/`process.env` (`PERPLEXITY_API_KEY`/`ANTHROPIC_API_KEY`/
   * `GEMINI_API_KEY`/`OPENAI_API_KEY`, plus the Vertex Gemini route when
   * `vertexAuthorize` is supplied) — an engine with no credential is simply
   * absent, same "honest per call" rule as `scraper`. Tests pass a fake map;
   * `null` forces every engine to the unconfigured path regardless of
   * `process.env`.
   */
  visibilityAdapters?: Partial<Record<VisibilityEngine, EngineCaptureAdapter>> | null;
  /**
   * Resolves an ADC `Authorization` header, enabling Gemini capture through
   * Vertex when no `GEMINI_API_KEY` is configured. Passed straight through to
   * `createDefaultCaptureAdapters`; ignored when `visibilityAdapters` is given.
   */
  vertexAuthorize?: () => Promise<string>;
}

/**
 * Resolves the scraper backing `research.pull`, or undefined when none is
 * configured — in which case the tool reports `not_available` rather than
 * returning a placeholder. Same rule as every other credentialed capability
 * here (`media.*`, `video.*`, `landing.*`): registered unconditionally, honest
 * per call.
 */
/** The `karos-research` MCP server's tool registry (RFC-01 §9.2) — egress-bound, cached, freshness-enforced. */
export function createKarosResearchTools(
  store: WorkspaceStoreLike = createWorkspaceStore(),
  options: KarosResearchToolsOptions = {},
): AgentToolRegistry {
  const scraper = createScraperProvider({
    ...(options.env ? { env: options.env } : {}),
    ...(options.scraper !== undefined ? { provider: options.scraper } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  // `null` forces every engine to the unconfigured path regardless of
  // `process.env` (same convention as `scraper: null` above); `undefined`
  // (the default) derives real per-engine adapters from `options.env`/
  // `process.env` — T-A3/SCRUM-237.
  const visibilityAdapters =
    options.visibilityAdapters === null
      ? {}
      : (options.visibilityAdapters ??
        createDefaultCaptureAdapters({
          ...(options.env ? { env: options.env } : {}),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          ...(options.vertexAuthorize ? { vertexAuthorize: options.vertexAuthorize } : {}),
        }));
  return {
    "research.pull": createPull(store, scraper),
    "research.getRuns": createGetRuns(store),
    "research.writeRun": createWriteRun(store),
    "research.checkFreshness": createCheckFreshness(store),
    "research.captureVisibility": createCaptureVisibility(store, {
      ...(options.visibilityCreditProbe ? { creditProbe: options.visibilityCreditProbe } : {}),
      adapters: visibilityAdapters,
    }),
    "research.crawlTechnicalSeo": createCrawlTechnicalSeo(scraper),
  };
}
