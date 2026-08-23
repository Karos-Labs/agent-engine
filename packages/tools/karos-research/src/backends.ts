/**
 * The external-research seam.
 *
 * `research.pull` owns caching, freshness and verbatim persistence; it knows
 * nothing about where facts come from. A backend is the part that actually
 * leaves the building.
 *
 * ## Why this exists
 *
 * `research.pull` shipped with no egress at all — its "fetch" was a
 * deterministic stand-in returning `{note: "Phase 1 stand-in...", query}`, so
 * the caching and freshness contract was real while the search was not. That
 * was a reasonable staging decision that became invisible: prep run
 * pubsub-21066191524607951 shows the consequence, with the extraction agent
 * dutifully reporting the only fact available to it ("the research payload for
 * this run is a Phase 1 stand-in with no real external data fetched") and the
 * copy agent then writing a client-facing carousel about the broken pipeline
 * ("This carousel couldn't be written yet"). Every content agent in the engine
 * was drafting from nothing, and nothing about the output said so.
 */

/** One retrieved source, in the shape a fact-extraction agent can trace a claim back to. */
export interface ResearchDocument {
  /** Page title, or the search result's title when the page had none. */
  readonly title: string;
  /** Canonical URL. This is what a claim's `source` field cites. */
  readonly url: string;
  /** Search-result snippet or page description. Short, always present when the provider gives one. */
  readonly description?: string;
  /** Page text as markdown, truncated. The substance a claim is actually drawn from. */
  readonly content?: string;
  /** When the page was published or last loaded, if the provider reports it. Feeds a claim's `date`. */
  readonly retrievedAt?: string;
}

/** The payload persisted verbatim by `research.pull` and handed to the extraction agent. */
export interface ResearchPayload {
  /** Which backend answered, e.g. `apify/rag-web-browser`. Recorded so a stale run is attributable. */
  readonly provider: string;
  readonly query: string;
  /** ISO 8601. The extraction agent needs a real date to attach to claims. */
  readonly fetchedAt: string;
  readonly documents: ResearchDocument[];
  /** Set when the backend answered but found nothing, so an empty result is never mistaken for a failure. */
  readonly note?: string;
}

export interface ResearchSearchBackend {
  readonly name: string;
  /** Returns at most `limit` documents. An empty array is a valid answer, not an error. */
  search(query: string, limit: number): Promise<ResearchDocument[]>;
}

/** Thrown for a backend-side failure `research.pull` should surface as `tooling_error`. */
export class ResearchBackendError extends Error {}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Per-document markdown ceiling.
 *
 * This payload is injected whole into the extraction agent's prompt, so its
 * size is a token bill on every research-backed run. A few thousand
 * characters is plenty to pull a sourced claim from; a full article is mostly
 * navigation chrome and footer.
 */
export const DEFAULT_CONTENT_CHARS = 4000;

const RAG_WEB_BROWSER_ACTOR = "apify~rag-web-browser";

/**
 * Apify's RAG Web Browser — searches, opens the top results, and returns each
 * page as markdown.
 *
 * Chosen over `apify/google-search-scraper` deliberately. A SERP scraper
 * returns titles, URLs and snippets; the extraction agent is required to
 * attach a **source and a date** to every claim
 * (`agents/instagram-agent/prompts/instagram-research/1.md` §2), and a snippet
 * supports neither reliably. Page content does.
 *
 * `run-sync-get-dataset-items` blocks until the actor finishes, so the timeout
 * is generous: a search plus several page loads legitimately takes tens of
 * seconds. It still sits inside the workflow's own step budget.
 */
export function createApifyResearchBackend(options: {
  token: string;
  /** Overridable: an Apify account may host its own fork of the actor. */
  actor?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  contentChars?: number;
}): ResearchSearchBackend {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const contentChars = options.contentChars ?? DEFAULT_CONTENT_CHARS;
  const actor = options.actor ?? RAG_WEB_BROWSER_ACTOR;

  return {
    name: `apify/${actor.replace("~", "/")}`,
    async search(query: string, limit: number): Promise<ResearchDocument[]> {
      const url = new URL(`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items`);
      // The token rides in the query string because that is the only auth this
      // endpoint accepts. It is never persisted: only the mapped documents
      // below reach the run record.
      url.searchParams.set("token", options.token);
      url.searchParams.set("clean", "true");

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query,
            maxResults: limit,
            outputFormats: ["markdown"],
            requestTimeoutSecs: 40,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new ResearchBackendError(`apify research search failed for "${query}": ${(error as Error).message}`);
      }

      if (!response.ok) {
        // 402 is the one worth naming: Apify returns it when the account is out
        // of credit, which reads nothing like a bad query and needs a
        // completely different fix.
        const hint = response.status === 402 ? " (Apify account out of credit)" : response.status === 401 ? " (invalid APIFY_TOKEN)" : "";
        throw new ResearchBackendError(`apify research search for "${query}" returned ${response.status}${hint}`);
      }

      let items: unknown;
      try {
        items = await response.json();
      } catch (error) {
        throw new ResearchBackendError(`apify returned a non-JSON body for "${query}": ${(error as Error).message}`);
      }
      if (!Array.isArray(items)) return [];

      const documents: ResearchDocument[] = [];
      const seen = new Set<string>();

      for (const raw of items) {
        if (typeof raw !== "object" || raw === null) continue;
        const item = raw as Record<string, unknown>;
        const metadata = (item["metadata"] ?? {}) as Record<string, unknown>;
        const searchResult = (item["searchResult"] ?? {}) as Record<string, unknown>;
        const crawl = (item["crawl"] ?? {}) as Record<string, unknown>;

        // Field names have moved between actor versions, so each value is read
        // from every place it has been known to live rather than one path.
        const href = asString(metadata["url"]) ?? asString(searchResult["url"]) ?? asString(item["url"]);
        if (href === undefined || seen.has(href)) continue;
        seen.add(href);

        const title = asString(metadata["title"]) ?? asString(searchResult["title"]) ?? href;
        const description = asString(metadata["description"]) ?? asString(searchResult["description"]);
        const markdown = asString(item["markdown"]) ?? asString(item["text"]);
        const retrievedAt =
          asString(metadata["loadedTime"]) ?? asString(crawl["loadedAt"]) ?? asString(metadata["publishedTime"]);

        documents.push({
          title,
          url: href,
          ...(description ? { description } : {}),
          ...(markdown
            ? {
                content:
                  markdown.length > contentChars
                    ? `${markdown.slice(0, contentChars)}\n\n[truncated at ${contentChars} characters]`
                    : markdown,
              }
            : {}),
          ...(retrievedAt ? { retrievedAt } : {}),
        });

        if (documents.length >= limit) break;
      }

      return documents;
    },
  };
}
