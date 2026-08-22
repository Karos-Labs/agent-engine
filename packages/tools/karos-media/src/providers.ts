/**
 * The image-search backend seam.
 *
 * `media.findImages` knows nothing about any particular provider — it takes
 * one of these, asks for hits, and downloads them. Swapping Unsplash for
 * another library is a new implementation of this interface, not a change to
 * the tool.
 *
 * Why Unsplash is the default and not a general web image search: step 06 of
 * `instagram-agent` has to record a real `license` / `rightsUsable` /
 * `watermarkFree` verdict per image, and holds the entire post when it cannot
 * (`ImageSelectionSchema` in that agent's `workflow/types.ts`). A general web
 * search returns images of unknown provenance, so an honest vetting agent
 * would mark nearly all of them `rightsUsable: false` and every run would
 * hold — the current failure mode with extra network calls in front of it. A
 * library with one blanket commercial licence and no watermarks is what lets
 * that gate actually pass.
 */

/** One provider result, before anything has been downloaded. */
export interface ImageSearchHit {
  /** Direct URL to the image bytes. */
  readonly url: string;
  /** What the picture shows, for the vetting agent to judge against a slide's `visualNeed`. */
  readonly description: string;
  /** Human-readable licence basis, recorded verbatim on the selection. */
  readonly license: string;
  /** Who made it — carried into the description so attribution is possible even when not required. */
  readonly credit: string;
  /** Provider's own id, used to build a stable filename. */
  readonly id: string;
}

export interface ImageSearchProvider {
  readonly name: string;
  /** Returns at most `limit` hits. An empty array is a valid answer, not an error. */
  search(query: string, limit: number): Promise<ImageSearchHit[]>;
}

/** Thrown for a provider-side failure the tool should surface as `tooling_error`. */
export class ImageProviderError extends Error {}

const UNSPLASH_ENDPOINT = "https://api.unsplash.com/search/photos";

/**
 * The Unsplash License covers commercial use without permission or
 * attribution, and Unsplash does not watermark. Recorded on every hit so the
 * vetting agent has a real basis for its verdict rather than a guess.
 *
 * Kept as one constant because it is the licence for the whole library — if a
 * provider is ever added whose terms vary per asset, that provider reports it
 * per hit and this stays local to Unsplash.
 */
const UNSPLASH_LICENSE = "Unsplash License — free for commercial use, no attribution required";

interface UnsplashPhoto {
  id?: unknown;
  description?: unknown;
  alt_description?: unknown;
  urls?: { regular?: unknown; small?: unknown; full?: unknown } | undefined;
  user?: { name?: unknown } | undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * `accessKey` is read at construction rather than per call so an unconfigured
 * deployment is detectable before a run starts — see `createKarosMediaTools`,
 * which returns a tool that reports `not_available` instead of constructing
 * this at all.
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

      for (const raw of results.slice(0, limit)) {
        const photo = raw as UnsplashPhoto;
        const id = asString(photo.id);
        const href = asString(photo.urls?.regular) ?? asString(photo.urls?.small) ?? asString(photo.urls?.full);
        if (!id || !href) continue; // A malformed entry is skipped, not fatal.

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
          credit,
        });
      }

      return hits;
    },
  };
}
