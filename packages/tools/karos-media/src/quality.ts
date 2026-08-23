/**
 * Provider-independent quality gates, ported from the legacy engine's
 * `config.yaml sourcing.blocklists` + `sources.py::_simplify`.
 *
 * These live outside every provider because they are properties of the *web*,
 * not of any one API: a watermarked stock domain is watermarked whichever
 * connector surfaced it, and a ten-word descriptive query under-matches on
 * every strict library API alike.
 */

/**
 * Hosts that serve watermarked previews, or whose licence cannot support
 * commercial use. A hit from one of these can never honestly clear
 * `instagram-agent` step 06's `watermarkFree` / `rightsUsable` verdict, so it
 * is dropped at source rather than downloaded and rejected later.
 *
 * Ported verbatim from the legacy blocklist, which earned these entries the
 * hard way — the comment on `focusedcollection.com` ("caught 2026-06-10:
 * tiled FOCUSED watermark") is the shape of how this list grew.
 *
 * `plus.unsplash.com` is on it deliberately: Unsplash+ is the paid tier and
 * its previews *are* watermarked, so it must be filtered even though plain
 * `unsplash.com` is our cleanest source.
 */
export const WATERMARK_DOMAINS: readonly string[] = [
  "focusedcollection.com",
  "dreamstime.com",
  "alamy.com",
  "shutterstock.com",
  "istockphoto.com",
  "gettyimages.com",
  "gettyimages.co.uk",
  "depositphotos.com",
  "123rf.com",
  "rf123.com",
  "stock.adobe.com",
  "adobestock.com",
  "fotolia.com",
  "vectorstock.com",
  "canstockphoto.com",
  "agefotostock.com",
  "stocksy.com",
  "bigstockphoto.com",
  "imago-images.com",
  "imago-images.de",
  "newscom.com",
  "zuma.com",
  "zumapress.com",
  "lookphotos.com",
  "fineartamerica.com",
  "pixsy.com",
  "pond5.com",
  "stocksubmitter.com",
  "latitude.to",
  "footage.framepool.com",
  "freepik.com",
  "freepik.es",
  "img.freepik.com",
  "rawpixel.com",
  "vecteezy.com",
  "pixabay.com",
  "pikist.com",
  "needpix.com",
  "publicdomainpictures.net",
  "stockphoto.com",
  "stockfreeimages.com",
  "picryl.com",
  "storyblocks.com",
  "envato.com",
  "elements.envato.com",
  "creativemarket.com",
  "dissolve.com",
  "colourbox.com",
  "colorbox.com",
  "designbundles.net",
  "deposit.com",
  "yayimages.com",
  "fotosearch.com",
  "lightboxes.com",
  "graphicriver.net",
  "westend61.de",
  "westend61.com",
  "imagebroker.com",
  "imagebroker.de",
  "plus.unsplash.com",
];

const BLOCKED = new Set(WATERMARK_DOMAINS.map((d) => d.toLowerCase()));

/**
 * True when a URL's host is blocklisted. Matches the host itself and any
 * subdomain of it, so `images.shutterstock.com` is caught by the
 * `shutterstock.com` entry without needing its own line.
 *
 * An unparseable URL is treated as blocked: something we cannot even resolve
 * to a host is not something to hand a rights gate.
 */
export function isBlockedImageUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  if (BLOCKED.has(host)) return true;
  for (const domain of BLOCKED) {
    if (host.endsWith(`.${domain}`)) return true;
  }
  return false;
}

/** Filler words dropped first when broadening a query. */
const STOP_WORDS = new Set([
  "a", "an", "and", "the", "of", "on", "in", "at", "to", "for", "with", "from", "by", "as", "is", "are", "be",
  "into", "onto", "over", "under", "above", "below", "through", "shot", "shots", "photo", "photograph", "image",
  "picture", "showing", "shows", "featuring", "close", "up", "closeup", "view", "angle", "that", "this", "its",
  "it", "or", "but", "very", "some", "any", "one", "two", "three",
]);

/**
 * Reduces a query to its `k` most salient words, preserving order.
 *
 * Library APIs (Openverse, Wikimedia) match strictly: a slide's `visualNeed`
 * is written for a human ("a close-up of an unplugged ethernet or power cable
 * on a desk") and returns nothing verbatim. The legacy engine solved this by
 * retrying progressively shorter queries until one hit, and
 * `broadeningVariants` below reproduces that.
 *
 * Falls back to the raw words when every word is a stop word, so this can
 * never return an empty query for a non-empty input.
 */
export function simplifyQuery(query: string, k: number): string {
  const words = query.match(/[A-Za-z0-9]+/g) ?? [];
  const salient = words.filter((w) => !STOP_WORDS.has(w.toLowerCase()));
  return (salient.length > 0 ? salient : words).slice(0, k).join(" ");
}

/**
 * The query ladder a strict provider walks: the full text first (most
 * precise), then 3 salient words, then 2. Deduplicated case-insensitively,
 * so a query that is already two words produces exactly one attempt rather
 * than three identical ones.
 */
export function broadeningVariants(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of [query, simplifyQuery(query, 3), simplifyQuery(query, 2)]) {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
