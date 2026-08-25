import { asString, searchWithBroadening, type ImageSearchHit, type ImageSearchProvider } from "../providers.js";
import { ImageProviderError } from "../providers.js";
import { broadeningVariants, isBlockedImageUrl } from "../quality.js";

const PIXABAY_ENDPOINT = "https://pixabay.com/api/";

/**
 * Pixabay's Content License: free for commercial use, no attribution
 * required, redistribution of the unmodified file itself excepted (not a
 * concern here — every image goes into a rendered carousel slide, never
 * shipped as a standalone file).
 */
const PIXABAY_LICENSE = "Pixabay Content License — free for commercial use, no attribution required";

interface PixabayHit {
  id?: unknown;
  tags?: unknown;
  pageURL?: unknown;
  largeImageURL?: unknown;
  webformatURL?: unknown;
  user?: unknown;
  /** Pixabay's own flags. Verified present on live responses 2026-08-24. */
  isAiGenerated?: unknown;
  isLowQuality?: unknown;
}

/**
 * Pixabay's `tags` is a comma-separated string that repeats heavily — a live
 * response carried "journal, write, ... writing, writing, writing, writing".
 * The vetting agent reads this as the picture's description, so duplicates are
 * pure noise in a prompt that is charged by the token.
 */
function cleanTags(raw: string): string {
  const seen = new Set<string>();
  for (const tag of raw.split(",")) {
    const trimmed = tag.trim().toLowerCase();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen].slice(0, 12).join(", ");
}

/**
 * Pixabay — a third broad, royalty-free stock library, alongside Unsplash
 * and Pexels.
 *
 * Same rationale as Pexels: a distinct catalogue under the same permissive,
 * no-attribution licence, so it widens the pool rather than duplicating what
 * Unsplash/Pexels already cover. Needs a free API key (`PIXABAY_API_KEY`) —
 * Pixabay's search has no public unauthenticated endpoint either.
 */
export function createPixabayProvider(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ImageSearchProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  return {
    name: "pixabay",
    async search(query: string, limit: number): Promise<ImageSearchHit[]> {
      // Broadened, same reasoning as Unsplash/Pexels.
      return searchWithBroadening(query, broadeningVariants(query), (variant) => searchOnce(variant, limit));
    },
  };

  async function searchOnce(query: string, limit: number): Promise<ImageSearchHit[]> {
      const url = new URL(PIXABAY_ENDPOINT);
      url.searchParams.set("key", options.apiKey);
      url.searchParams.set("q", query);
      url.searchParams.set("image_type", "photo");
      url.searchParams.set("orientation", "horizontal");
      url.searchParams.set("safesearch", "true");
      // Pixabay's minimum is 3, its cap is 200; below 3 is a 400, not a clamp.
      url.searchParams.set("per_page", String(Math.min(Math.max(limit, 3), 200)));

      let response: Response;
      try {
        response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        throw new ImageProviderError(`pixabay search failed for "${query}": ${(error as Error).message}`);
      }

      if (!response.ok) {
        const hint = response.status === 429 ? " (rate limited)" : response.status === 400 ? " (invalid API key or query)" : "";
        throw new ImageProviderError(`pixabay search for "${query}" returned ${response.status}${hint}`);
      }

      let body: { hits?: unknown };
      try {
        body = (await response.json()) as { hits?: unknown };
      } catch (error) {
        throw new ImageProviderError(`pixabay returned a non-JSON body for "${query}": ${(error as Error).message}`);
      }

      const rawHits = Array.isArray(body.hits) ? body.hits : [];
      const hits: ImageSearchHit[] = [];

      for (const raw of rawHits) {
        const hit = raw as PixabayHit;
        // Pixabay returns `id` as a JSON number — asString() alone would
        // drop every hit here.
        const id = typeof hit.id === "number" ? String(hit.id) : asString(hit.id);
        const href = asString(hit.largeImageURL) ?? asString(hit.webformatURL);
        if (!id || !href || isBlockedImageUrl(href)) continue;

        // Pixabay's own quality flag. A hit it labels low-quality itself is
        // not worth a vetting-agent token to reject.
        if (hit.isLowQuality === true) continue;

        // `user` is a display name, but a live response returned a numeric one
        // ("6689062"), which `asString` alone would drop to "unknown".
        const credit = (typeof hit.user === "number" ? String(hit.user) : asString(hit.user)) ?? "unknown";
        const tags = asString(hit.tags);
        const described = tags ? cleanTags(tags) : `photo matching "${query}"`;
        // Stated because the rights gate reads this line and AI-generated
        // stock is a different provenance question from a photograph, even
        // when the library licence over it is identical.
        const aiNote = hit.isAiGenerated === true ? "; AI-generated stock image, per Pixabay's own flag" : "";

        hits.push({
          id,
          url: href,
          description: `${described} (photo by ${credit} on Pixabay${aiNote})`,
          license: PIXABAY_LICENSE,
          licenseConfidence: "blanket",
          credit,
          ...(asString(hit.pageURL) ? { pageUrl: asString(hit.pageURL)! } : {}),
        });

        if (hits.length >= limit) break;
      }

    return hits;
  }
}
