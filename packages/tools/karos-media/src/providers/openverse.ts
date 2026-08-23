import { asString, fetchJson, type ImageSearchHit, type ImageSearchProvider } from "../providers.js";
import { broadeningVariants, isBlockedImageUrl } from "../quality.js";

const OPENVERSE_ENDPOINT = "https://api.openverse.org/v1/images/";

interface OpenverseResult {
  id?: unknown;
  url?: unknown;
  foreign_landing_url?: unknown;
  title?: unknown;
  license?: unknown;
  license_version?: unknown;
  creator?: unknown;
  source?: unknown;
}

/**
 * Openverse — the best keyless source, and the legacy engine's default.
 *
 * It aggregates Flickr, Wikimedia and museum collections, and every result
 * carries a real CC licence plus a creator, which is exactly what step 06's
 * `rightsUsable` verdict needs to be able to say yes to. Rated
 * `attributable` rather than `blanket`: CC licences are genuinely usable
 * commercially (CC0/BY/BY-SA) but generally require credit, so the licence
 * string names the specific licence rather than making a blanket claim.
 *
 * `mature=false` is set on every request. This feeds a client's public social
 * feed; there is no use case here for the alternative.
 */
export function createOpenverseProvider(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): ImageSearchProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  return {
    name: "openverse",
    async search(query: string, limit: number): Promise<ImageSearchHit[]> {
      // Progressive broadening, ported from the legacy connector: Openverse
      // matches strictly, so a slide's human-written `visualNeed` usually
      // returns nothing verbatim. First variant that hits wins.
      for (const variant of broadeningVariants(query)) {
        const url = new URL(OPENVERSE_ENDPOINT);
        url.searchParams.set("q", variant);
        url.searchParams.set("page_size", String(Math.min(Math.max(limit, 1), 20)));
        url.searchParams.set("mature", "false");
        // Excludes the CC licences that forbid commercial use outright — no
        // point downloading what the rights gate must then refuse.
        url.searchParams.set("license_type", "commercial");

        let body: { results?: unknown };
        try {
          body = (await fetchJson(fetchImpl, url, { provider: "openverse", query: variant, timeoutMs })) as {
            results?: unknown;
          };
        } catch {
          // A failed variant is not a failed provider — try the next, broader
          // one. Only an exhausted ladder returns empty, and the chain then
          // demotes to the next source.
          continue;
        }

        const results = Array.isArray(body.results) ? body.results : [];
        const hits: ImageSearchHit[] = [];

        for (const raw of results) {
          const result = raw as OpenverseResult;
          const href = asString(result.url);
          const id = asString(result.id) ?? href;
          if (!href || !id || isBlockedImageUrl(href)) continue;

          const creator = asString(result.creator) ?? "unknown";
          const source = asString(result.source);
          const licenseName = asString(result.license)?.toUpperCase() ?? "CC";
          const licenseVersion = asString(result.license_version);
          const title = asString(result.title) ?? `image matching "${variant}"`;

          hits.push({
            id,
            url: href,
            description: `${title} (by ${creator}${source ? ` via ${source}` : ""} on Openverse)`,
            license: `CC ${licenseName}${licenseVersion ? ` ${licenseVersion}` : ""} — commercial use permitted, credit "${creator}"`,
            licenseConfidence: "attributable",
            credit: creator,
            ...(asString(result.foreign_landing_url) ? { pageUrl: asString(result.foreign_landing_url)! } : {}),
          });

          if (hits.length >= limit) break;
        }

        if (hits.length > 0) return hits;
      }

      return [];
    },
  };
}
