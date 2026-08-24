import { asString, searchWithBroadening, type ImageSearchHit, type ImageSearchProvider } from "../providers.js";
import { ImageProviderError } from "../providers.js";
import { broadeningVariants, isBlockedImageUrl } from "../quality.js";

const PEXELS_ENDPOINT = "https://api.pexels.com/v1/search";

/**
 * Every Pexels photo ships under the same royalty-free licence: free for
 * commercial use, no permission or attribution needed. Same shape as
 * Unsplash's, so this ranks `blanket` for the same reason.
 */
const PEXELS_LICENSE = "Pexels License — free for commercial use, no attribution required";

interface PexelsPhoto {
  id?: unknown;
  alt?: unknown;
  url?: unknown;
  photographer?: unknown;
  src?: { large2x?: unknown; large?: unknown; original?: unknown } | undefined;
}

/**
 * Pexels — a second broad, royalty-free stock library alongside Unsplash.
 *
 * Widening the pool the way this ask intends: Unsplash and Pexels overlap in
 * style (curated, editorial) but not in catalogue, so a query that comes up
 * short on one routinely hits on the other. Same reason it ranks `blanket`
 * and sits beside Unsplash in the chain rather than behind Openverse's
 * attribution-bearing CC pool.
 *
 * Needs a free API key (`PEXELS_API_KEY`) — Pexels has no public unauthenticated
 * endpoint. Scraping its HTML to avoid that would be more fragile than the DDG
 * provider already is and adds a second web-scrape dependency for no real gain
 * over registering a free key, so this follows Unsplash's pattern instead.
 */
export function createPexelsProvider(options: {
  apiKey: string;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Below the workflow's own step budget on purpose. */
  timeoutMs?: number;
}): ImageSearchProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  return {
    name: "pexels",
    async search(query: string, limit: number): Promise<ImageSearchHit[]> {
      // Broadened, for the same reason as Unsplash: a long scene description
      // returns near-arbitrary matches rather than nothing.
      return searchWithBroadening(query, broadeningVariants(query), (variant) => searchOnce(variant, limit));
    },
  };

  async function searchOnce(query: string, limit: number): Promise<ImageSearchHit[]> {
      const url = new URL(PEXELS_ENDPOINT);
      url.searchParams.set("query", query);
      // Pexels caps per_page at 80; asking for more 400s rather than clamping.
      url.searchParams.set("per_page", String(Math.min(Math.max(limit, 1), 80)));
      url.searchParams.set("orientation", "landscape");

      let response: Response;
      try {
        response = await fetchImpl(url, {
          // No "Bearer" prefix — the Pexels API takes the raw key.
          headers: { Authorization: options.apiKey },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new ImageProviderError(`pexels search failed for "${query}": ${(error as Error).message}`);
      }

      if (!response.ok) {
        const hint = response.status === 429 ? " (rate limited)" : response.status === 401 ? " (invalid API key)" : "";
        throw new ImageProviderError(`pexels search for "${query}" returned ${response.status}${hint}`);
      }

      let body: { photos?: unknown };
      try {
        body = (await response.json()) as { photos?: unknown };
      } catch (error) {
        throw new ImageProviderError(`pexels returned a non-JSON body for "${query}": ${(error as Error).message}`);
      }

      const photos = Array.isArray(body.photos) ? body.photos : [];
      const hits: ImageSearchHit[] = [];

      for (const raw of photos) {
        const photo = raw as PexelsPhoto;
        // Pexels returns `id` as a JSON number, unlike Openverse/Unsplash's
        // string ids — asString() alone would drop every hit here.
        const id = typeof photo.id === "number" ? String(photo.id) : asString(photo.id);
        const href = asString(photo.src?.large2x) ?? asString(photo.src?.large) ?? asString(photo.src?.original);
        if (!id || !href || isBlockedImageUrl(href)) continue;

        const credit = asString(photo.photographer) ?? "unknown";
        const described = asString(photo.alt) ?? `photo matching "${query}"`;

        hits.push({
          id,
          url: href,
          description: `${described} (photo by ${credit} on Pexels)`,
          license: PEXELS_LICENSE,
          licenseConfidence: "blanket",
          credit,
          ...(asString(photo.url) ? { pageUrl: asString(photo.url)! } : {}),
        });

        if (hits.length >= limit) break;
      }

    return hits;
  }
}
