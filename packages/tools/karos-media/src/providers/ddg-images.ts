import { asString, type ImageSearchHit, type ImageSearchProvider } from "../providers.js";
import { isBlockedImageUrl } from "../quality.js";

const DDG_HTML = "https://duckduckgo.com/";
const DDG_JSON = "https://duckduckgo.com/i.js";

/** DuckDuckGo rejects requests without a browser-shaped UA. */
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

interface DdgResult {
  image?: unknown;
  title?: unknown;
  url?: unknown;
  source?: unknown;
}

/**
 * DuckDuckGo image search — broad coverage, unknown provenance, last resort.
 *
 * ## Read this before promoting it up a chain
 *
 * This is the source the original single-provider argument was actually
 * right about: DDG indexes the open web, so a hit's licence is genuinely
 * unknown. It is included because breadth is the only way to find a *named*
 * subject that no curated library has (the legacy engine leaned on it for
 * exactly that — "real venue photos from press/blogs"), and it is rated
 * `licenseConfidence: "unknown"` with a licence string that says so plainly.
 *
 * That honesty is the point. Step 06 will and should refuse most of these on
 * `rightsUsable`, and it now has the metadata to do it deliberately rather
 * than by guessing. Watermark-farm domains are filtered before download, so
 * what reaches the gate is at least not a stock preview.
 *
 * ## Fragility
 *
 * DDG has no public API. This uses the same two-step the community libraries
 * use — scrape a `vqd` token from the HTML endpoint, then call the internal
 * `i.js` JSON endpoint with it — and that can break without notice. Every
 * failure path therefore returns `[]` rather than throwing: a broken
 * last-resort provider must demote to "no results" and let the chain finish,
 * never fail a run that the sources above it could still satisfy.
 */
export function createDdgImagesProvider(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): ImageSearchProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function resolveVqd(query: string): Promise<string | undefined> {
    const url = new URL(DDG_HTML);
    url.searchParams.set("q", query);
    url.searchParams.set("iax", "images");
    url.searchParams.set("ia", "images");

    let html: string;
    try {
      const response = await fetchImpl(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return undefined;
      html = await response.text();
    } catch {
      return undefined;
    }

    // The token has been spelled several ways across DDG revisions; accept any.
    const match =
      /vqd=["']([^"']+)["']/.exec(html) ?? /vqd=([\d-]+)&/.exec(html) ?? /"vqd":\s*["']([^"']+)["']/.exec(html);
    return match?.[1];
  }

  return {
    name: "ddg_images",
    async search(query: string, limit: number): Promise<ImageSearchHit[]> {
      const vqd = await resolveVqd(query);
      if (vqd === undefined) return [];

      const url = new URL(DDG_JSON);
      url.searchParams.set("l", "us-en");
      url.searchParams.set("o", "json");
      url.searchParams.set("q", query);
      url.searchParams.set("vqd", vqd);
      url.searchParams.set("f", ",,,");
      url.searchParams.set("p", "1");

      let body: { results?: unknown };
      try {
        const response = await fetchImpl(url, {
          headers: { "User-Agent": USER_AGENT, Referer: DDG_HTML },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return [];
        body = (await response.json()) as { results?: unknown };
      } catch {
        return [];
      }

      const results = Array.isArray(body.results) ? body.results : [];
      const hits: ImageSearchHit[] = [];

      for (const raw of results) {
        const result = raw as DdgResult;
        const href = asString(result.image);
        if (!href || isBlockedImageUrl(href)) continue;

        const source = asString(result.source) ?? "the web";
        const title = asString(result.title) ?? `image matching "${query}"`;

        hits.push({
          id: href,
          url: href,
          description: `${title} (found on ${source} via web search — provenance unverified)`,
          license: "UNKNOWN — web search result, licence not established; verify before commercial use",
          licenseConfidence: "unknown",
          credit: source,
          ...(asString(result.url) ? { pageUrl: asString(result.url)! } : {}),
        });

        if (hits.length >= limit) break;
      }

      return hits;
    },
  };
}
