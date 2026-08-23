import { asString, fetchJson, type ImageSearchHit, type ImageSearchProvider } from "../providers.js";
import { broadeningVariants, isBlockedImageUrl } from "../quality.js";

const COMMONS_ENDPOINT = "https://commons.wikimedia.org/w/api.php";

/**
 * Wikimedia asks API consumers to identify themselves; an anonymous
 * high-volume caller gets throttled. This is a courtesy, not a credential.
 */
const USER_AGENT = "KarosAgentEngine/1.0 (media.findImages; https://karoslabs.com)";

interface CommonsPage {
  title?: unknown;
  imageinfo?: unknown;
}

interface CommonsImageInfo {
  url?: unknown;
  descriptionshorturl?: unknown;
  extmetadata?:
    | {
        LicenseShortName?: { value?: unknown } | undefined;
        Artist?: { value?: unknown } | undefined;
        ImageDescription?: { value?: unknown } | undefined;
      }
    | undefined;
}

/** Commons descriptions and artist fields are HTML fragments. The vetting agent reads plain text. */
function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Wikimedia Commons — keyless, and every file carries explicit licence
 * metadata in `extmetadata`, which is why it clears the same rights gate
 * Unsplash was chosen for.
 *
 * Uses `generator=search` in the `File:` namespace and asks for `imageinfo`
 * in one round trip, rather than search-then-resolve. Commons is strict about
 * phrasing, so it walks the same broadening ladder as Openverse.
 *
 * Rated `attributable`: Commons licences are real and commercial-friendly,
 * but nearly all require credit, and the licence string carries the specific
 * `LicenseShortName` so the gate is judging the actual terms.
 */
export function createWikimediaProvider(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): ImageSearchProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  return {
    name: "wikimedia",
    async search(query: string, limit: number): Promise<ImageSearchHit[]> {
      for (const variant of broadeningVariants(query)) {
        const url = new URL(COMMONS_ENDPOINT);
        url.searchParams.set("action", "query");
        url.searchParams.set("format", "json");
        url.searchParams.set("origin", "*");
        url.searchParams.set("generator", "search");
        url.searchParams.set("gsrsearch", variant);
        url.searchParams.set("gsrnamespace", "6"); // File:
        url.searchParams.set("gsrlimit", String(Math.min(Math.max(limit, 1), 20)));
        url.searchParams.set("prop", "imageinfo");
        url.searchParams.set("iiprop", "url|extmetadata");
        url.searchParams.set("iiurlwidth", "1600");

        let body: { query?: { pages?: unknown } };
        try {
          body = (await fetchJson(fetchImpl, url, {
            provider: "wikimedia",
            query: variant,
            timeoutMs,
            headers: { "User-Agent": USER_AGENT },
          })) as { query?: { pages?: unknown } };
        } catch {
          continue;
        }

        const pages = body.query?.pages;
        // `pages` is an object keyed by page id, not an array.
        const entries = pages && typeof pages === "object" ? Object.values(pages as Record<string, unknown>) : [];
        const hits: ImageSearchHit[] = [];

        for (const raw of entries) {
          const page = raw as CommonsPage;
          const info = (Array.isArray(page.imageinfo) ? page.imageinfo[0] : undefined) as CommonsImageInfo | undefined;
          const href = asString(info?.url);
          const title = asString(page.title);
          if (!href || !title || isBlockedImageUrl(href)) continue;

          const meta = info?.extmetadata;
          const licenseName = asString(meta?.LicenseShortName?.value) ?? "see Commons file page";
          const artistRaw = asString(meta?.Artist?.value);
          const credit = artistRaw ? stripHtml(artistRaw) : "unknown";
          const describedRaw = asString(meta?.ImageDescription?.value);
          // `File:Some_Thing.jpg` reads badly to a vetting model; the
          // description field is better when present.
          const described = describedRaw ? stripHtml(describedRaw) : title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "");

          hits.push({
            id: title,
            url: href,
            description: `${described} (by ${credit} on Wikimedia Commons)`,
            license: `${licenseName} — via Wikimedia Commons, credit "${credit}"`,
            licenseConfidence: "attributable",
            credit,
            ...(asString(info?.descriptionshorturl) ? { pageUrl: asString(info?.descriptionshorturl)! } : {}),
          });

          if (hits.length >= limit) break;
        }

        if (hits.length > 0) return hits;
      }

      return [];
    },
  };
}
