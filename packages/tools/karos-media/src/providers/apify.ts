import { asString, fetchJson, type ImageSearchHit, type ImageSearchProvider } from "../providers.js";
import { isBlockedImageUrl } from "../quality.js";

/**
 * Apify actor presets, ported from the legacy engine's `_APIFY_PRESETS`.
 *
 * Actor ids are the common public actors the legacy config shipped with. They
 * are overridable per preset because an Apify account may host its own fork —
 * the legacy CONNECTORS.md carried the same warning ("verify/adjust the actor
 * ids to the actors on your Apify account").
 */
export interface ApifyPreset {
  /** Apify actor id, `user~actor-name`. */
  readonly actor: string;
  /** Builds the actor input for one query. */
  readonly input: (query: string, limit: number) => Record<string, unknown>;
  /** Item fields holding a single image URL. */
  readonly imageKeys: readonly string[];
  /** Item fields holding an array of image URLs (or `{url}` objects). */
  readonly listKeys: readonly string[];
}

export const APIFY_PRESETS: Record<string, ApifyPreset> = {
  apify_google_maps: {
    actor: "compass~google-maps-extractor",
    input: (query, limit) => ({
      searchStringsArray: [query],
      maxImages: limit,
      maxCrawledPlacesPerSearch: 1,
      language: "en",
    }),
    imageKeys: ["imageUrl"],
    listKeys: ["imageUrls", "images"],
  },
  apify_instagram_location: {
    actor: "apify~instagram-scraper",
    input: (query, limit) => ({ search: query, searchType: "place", resultsLimit: limit, searchLimit: 1 }),
    imageKeys: ["displayUrl", "imageUrl"],
    listKeys: ["images"],
  },
  apify_instagram: {
    actor: "apify~instagram-scraper",
    input: (query, limit) => ({
      search: query,
      searchType: "hashtag",
      resultsLimit: limit,
      searchLimit: 1,
      addParentData: false,
    }),
    imageKeys: ["displayUrl", "imageUrl"],
    listKeys: ["images"],
  },
  apify_pinterest: {
    actor: "apify~pinterest-scraper",
    input: (query, limit) => ({ query, maxItems: limit }),
    imageKeys: ["imageUrl", "image", "imageLargeUrl"],
    listKeys: [],
  },
};

export type ApifyPresetName = keyof typeof APIFY_PRESETS;

/**
 * Apify actor-backed image sourcing — real photos of real places and real
 * aesthetics, from Google Maps, Instagram and Pinterest.
 *
 * These are the legacy engine's highest-value venue connectors and the reason
 * its `named_venue` route worked: an Instagram location tag or a Maps place
 * listing gives visitor photography of a specific venue that no stock library
 * carries.
 *
 * Rated `licenseConfidence: "unknown"` — deliberately, and this is the whole
 * caveat. These are user-generated posts. The uploader holds the copyright,
 * and "found it on the venue's location tag" is not a commercial licence.
 * Step 06 should and will refuse most of them on `rightsUsable`. They are
 * wired in because the legacy system had them and because they are genuinely
 * right for a *reference* or a human-reviewed pick, not because a UGC photo
 * is safe to publish unreviewed.
 *
 * `run-sync-get-dataset-items` blocks until the actor finishes, so the
 * timeout here is deliberately generous — an actor cold start alone can take
 * tens of seconds. It still sits well inside the workflow's step budget.
 */
export function createApifyProvider(options: {
  token: string;
  preset: ApifyPresetName;
  /** Overrides the preset's default actor id. */
  actor?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ImageSearchProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const preset = APIFY_PRESETS[options.preset]!;
  const actor = options.actor ?? preset.actor;

  return {
    name: options.preset,
    async search(query: string, limit: number): Promise<ImageSearchHit[]> {
      const url = new URL(`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items`);
      url.searchParams.set("token", options.token);
      url.searchParams.set("clean", "true");

      let items: unknown;
      try {
        items = await fetchJson(fetchImpl, url, {
          provider: options.preset,
          query,
          timeoutMs,
          init: {
            method: "POST",
            body: JSON.stringify(preset.input(query, limit)),
            headers: { "Content-Type": "application/json" },
          },
        });
      } catch {
        // An actor that errors, times out, or is missing from this account
        // demotes to the next source. Actor availability is an account
        // configuration detail, not a run failure.
        return [];
      }

      if (!Array.isArray(items)) return [];

      const hits: ImageSearchHit[] = [];
      const seen = new Set<string>();

      const push = (href: string | undefined, item: Record<string, unknown>): void => {
        if (href === undefined || hits.length >= limit) return;
        if (seen.has(href) || isBlockedImageUrl(href)) return;
        seen.add(href);

        const caption = asString(item["caption"]) ?? asString(item["title"]) ?? asString(item["name"]);
        const page = asString(item["url"]) ?? asString(item["postUrl"]) ?? asString(item["link"]);
        const owner = asString(item["ownerUsername"]) ?? asString(item["ownerFullName"]) ?? "the original poster";

        hits.push({
          id: href,
          url: href,
          description: `${caption ?? `photo related to "${query}"`} (user-generated, via ${options.preset})`,
          license: `UGC — copyright retained by ${owner}; no commercial licence granted, credit creator/venue`,
          licenseConfidence: "unknown",
          credit: owner,
          ...(page ? { pageUrl: page } : {}),
        });
      };

      for (const raw of items) {
        if (typeof raw !== "object" || raw === null) continue;
        const item = raw as Record<string, unknown>;

        for (const key of preset.imageKeys) push(asString(item[key]), item);

        for (const key of preset.listKeys) {
          const list = item[key];
          if (!Array.isArray(list)) continue;
          for (const entry of list) {
            const href =
              typeof entry === "string"
                ? asString(entry)
                : typeof entry === "object" && entry !== null
                  ? asString((entry as Record<string, unknown>)["url"])
                  : undefined;
            push(href, item);
          }
        }
      }

      return hits;
    },
  };
}
