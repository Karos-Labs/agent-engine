import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, parseDurationMs, success, toolingError, notAvailable } from "@agent-engine/tool-common";
import { ScraperError, type ScraperProvider } from "@agent-engine/tool-karos-scraper";
import { latestRunForQuery, writeRunRecord, type RunRecord } from "./runs.js";

// 1.0.0 — new (2026-09-23): a plain web search that returns URLs. Instagram's
// entity-imagery route (`05b1`, the `official-assets` tier) has asked for
// `web.search_web` since RFC-24 to find a company's real press page, and no
// registry ever provided it, so the tier fell back to guessed `/press` paths
// on every run without a word.
const TOOL_VERSION = "1.0.0";

/** A search result travels as a pointer, not a page: the caller fetches what it picks. */
const SNIPPET_CHARS = 280;

export const SearchWebInputSchema = z.object({
  query: z.string().min(1).max(300).describe("What to search the web for, in plain words."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(8)
    .default(3)
    .describe("How many results to return. One billed search per cache window whatever the number."),
  includeDomains: z
    .array(z.string().min(1))
    .max(5)
    .optional()
    .describe("Restrict results to these domains, e.g. [\"openai.com\"]."),
  window: z
    .string()
    .min(1)
    .default("24h")
    .describe("Freshness window — the same query inside it is served from the cache."),
});
export type SearchWebInput = z.input<typeof SearchWebInputSchema>;

export interface SearchWebHit {
  url: string;
  title?: string;
  snippet?: string;
}

export interface SearchWebResult {
  results: SearchWebHit[];
  fromCache: boolean;
  fetchedAt: string;
}

const JOB = "search-web";

function cacheKey(input: z.output<typeof SearchWebInputSchema>): string {
  const domains = [...(input.includeDomains ?? [])].map((d) => d.toLowerCase()).sort().join(",");
  return `${input.query.trim().toLowerCase()} | n=${input.maxResults}${domains ? ` | in=${domains}` : ""}`;
}

/**
 * `web.search_web` — a web search that returns result URLs, titles and short
 * snippets, through the same ScrappyCoco seam as every other research read.
 *
 * It is deliberately thinner than `research.pull`: no fact extraction, no
 * payload, no social accounts. A caller that wants to find a page (a press
 * room, a newsroom, a brand-assets page) needs the address and nothing else,
 * and then fetches or harvests it with the tool built for that.
 *
 * Unconfigured (no scraper) it reports `not_available`; a provider failure is
 * a `tooling_error`, never an empty success — an empty list has to mean the
 * web had nothing, not that nobody asked it.
 */
export function createSearchWeb(store: WorkspaceStoreLike, scraper?: ScraperProvider) {
  return defineTool<SearchWebInput, SearchWebResult>({
    name: "web.search_web",
    description:
      "Search the web and get back result URLs with titles and short snippets. Use it to FIND a page (a company's press room, newsroom or brand-assets page), then fetch or harvest that page with the tool built for it. Cached per query inside `window`. Reports not_available when no scraper is configured.",
    version: TOOL_VERSION,
    inputSchema: SearchWebInputSchema,
    async execute(rawInput, { ctx }) {
      const input = rawInput as z.output<typeof SearchWebInputSchema>;
      const query = cacheKey(input);
      const windowMs = parseDurationMs(input.window);

      const cached = await latestRunForQuery(store, ctx.clientSlug, JOB, query);
      if (cached && Date.now() - cached.at <= windowMs) {
        const result = cached.result as Omit<SearchWebResult, "fromCache">;
        return success<SearchWebResult>({ ...result, fromCache: true });
      }

      if (scraper === undefined) {
        return notAvailable("web.search_web: no scraper is configured — set SCRAPPYCOCO_API_KEY so the web can be searched");
      }

      let records;
      try {
        records = await scraper.searchKeyword(input.query.trim(), {
          limit: input.maxResults,
          ...(input.includeDomains && input.includeDomains.length > 0 ? { includeDomains: input.includeDomains } : {}),
        });
      } catch (error) {
        if (error instanceof ScraperError) return toolingError(`web.search_web: the search failed — ${error.message}`);
        throw error;
      }

      const seen = new Set<string>();
      const results: SearchWebHit[] = [];
      for (const record of records) {
        const url = record.url?.trim();
        if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
        seen.add(url);
        const text = (record.text ?? "").replace(/\s+/g, " ").trim();
        results.push({
          url,
          ...(record.title ? { title: record.title.trim() } : {}),
          ...(text ? { snippet: text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS)}…` : text } : {}),
        });
        if (results.length >= input.maxResults) break;
      }

      const fetchedAt = new Date().toISOString();
      const record: RunRecord = { job: JOB, runId: `${JOB}-${Date.now()}`, query, result: { results, fetchedAt }, at: Date.now() };
      await writeRunRecord(store, ctx.clientSlug, record);
      return success<SearchWebResult>({ results, fromCache: false, fetchedAt });
    },
  });
}
