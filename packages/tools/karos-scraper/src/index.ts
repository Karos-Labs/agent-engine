import { createScrappyCocoScraper } from "./scrappycoco.js";
import type { ScraperProvider } from "./provider.js";

export * from "./provider.js";
export * from "./crawl.js";
export * from "./scrappycoco.js";
export * from "./offline.js";

export interface ScraperFactoryOptions {
  env?: Record<string, string | undefined>;
  /** Overrides the env-derived provider. Tests pass a fake; `null` forces the unconfigured path. */
  provider?: ScraperProvider | null;
  fetchImpl?: typeof fetch;
}

/**
 * Builds the configured scraper, or `undefined` when none is available.
 *
 * Returning `undefined` rather than a no-op stub is the whole point. A stub
 * that answers politely with nothing is what `research.pull` used to be, and
 * every content agent drafted from it for months without a single error
 * surfacing. A caller that gets `undefined` has to decide what to do about it,
 * which is the decision that was previously skipped.
 */
export function createScraperProvider(options: ScraperFactoryOptions = {}): ScraperProvider | undefined {
  if (options.provider !== undefined) return options.provider ?? undefined;

  const env = options.env ?? process.env;
  const apiKey = env["SCRAPPYCOCO_API_KEY"]?.trim();
  if (!apiKey) return undefined;

  return createScrappyCocoScraper({
    apiKey,
    ...(env["SCRAPPYCOCO_BASE_URL"]?.trim() ? { baseUrl: env["SCRAPPYCOCO_BASE_URL"]!.trim() } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}
