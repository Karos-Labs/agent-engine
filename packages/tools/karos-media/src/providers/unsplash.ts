import { asString, type ImageSearchHit, type ImageSearchProvider } from "../providers.js";
import { ImageProviderError } from "../providers.js";
import { isBlockedImageUrl } from "../quality.js";

const UNSPLASH_ENDPOINT = "https://api.unsplash.com/search/photos";

/**
 * The Unsplash License covers commercial use without permission or
 * attribution, and Unsplash does not watermark the free tier. Recorded on
 * every hit so the vetting agent has a real basis for its verdict rather than
 * a guess.
 *
 * Kept as one constant because it is the licence for the whole free library.
 * Unsplash+ (the paid tier) *is* watermarked in preview and is filtered by
 * host in `quality.ts` instead — a licence string cannot express "except for
 * that CDN".
 */
const UNSPLASH_LICENSE = "Unsplash License — free for commercial use, no attribution required";

interface UnsplashPhoto {
  id?: unknown;
  description?: unknown;
  alt_description?: unknown;
  urls?: { regular?: unknown; small?: unknown; full?: unknown } | undefined;
  links?: { html?: unknown } | undefined;
  user?: { name?: unknown } | undefined;
}

/**
 * Unsplash — the highest-confidence source in the chain, and the only one
 * whose licence needs no attribution at all.
 *
 * `accessKey` is read at construction rather than per call so an
 * unconfigured deployment is detectable before a run starts: `buildProviderChain`
 * simply omits this provider when the key is absent, and the keyless sources
 * carry the run instead of it holding.
 */
export function createUnsplashProvider(options: {
  accessKey: string;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Below the workflow's own step budget on purpose. */
  timeoutMs?: number;
}): ImageSearchProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  return {
    name: "unsplash",
    async search(query: string, limit: number): Promise<ImageSearchHit[]> {
      const url = new URL(UNSPLASH_ENDPOINT);
      url.searchParams.set("query", query);
      // Unsplash caps per_page at 30; asking for more is a 400, not a clamp.
      url.searchParams.set("per_page", String(Math.min(Math.max(limit, 1), 30)));
      // Landscape suits a carousel slide better than the mixed default, and
      // narrowing here beats downloading portraits and discarding them.
      url.searchParams.set("orientation", "landscape");
      url.searchParams.set("content_filter", "high");

      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: {
            Authorization: `Client-ID ${options.accessKey}`,
            "Accept-Version": "v1",
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new ImageProviderError(`unsplash search failed for "${query}": ${(error as Error).message}`);
      }

      if (!response.ok) {
        // 403 from Unsplash is nearly always the hourly rate limit rather than
        // a bad key, and the two need different fixes, so say which it is.
        const hint = response.status === 403 ? " (rate limit or invalid access key)" : "";
        throw new ImageProviderError(`unsplash search for "${query}" returned ${response.status}${hint}`);
      }

      let body: { results?: unknown };
      try {
        body = (await response.json()) as { results?: unknown };
      } catch (error) {
        throw new ImageProviderError(`unsplash returned a non-JSON body for "${query}": ${(error as Error).message}`);
      }

      const results = Array.isArray(body.results) ? body.results : [];
      const hits: ImageSearchHit[] = [];

      for (const raw of results) {
        const photo = raw as UnsplashPhoto;
        const id = asString(photo.id);
        const href = asString(photo.urls?.regular) ?? asString(photo.urls?.small) ?? asString(photo.urls?.full);
        if (!id || !href) continue; // A malformed entry is skipped, not fatal.
        // Catches Unsplash+ CDN hosts, whose previews carry a watermark.
        if (isBlockedImageUrl(href)) continue;

        const credit = asString(photo.user?.name) ?? "unknown";
        // `description` is the photographer's caption and is usually null;
        // `alt_description` is Unsplash's own and is usually present. Neither
        // is guaranteed, and the vetting agent needs *something* to judge, so
        // the query itself is the last resort.
        const described = asString(photo.description) ?? asString(photo.alt_description) ?? `photo matching "${query}"`;

        hits.push({
          id,
          url: href,
          description: `${described} (photo by ${credit} on Unsplash)`,
          license: UNSPLASH_LICENSE,
          licenseConfidence: "blanket",
          credit,
          ...(asString(photo.links?.html) ? { pageUrl: asString(photo.links?.html)! } : {}),
        });

        if (hits.length >= limit) break;
      }

      return hits;
    },
  };
}
