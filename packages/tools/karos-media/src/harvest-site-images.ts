import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, toolingError } from "@agent-engine/tool-common";
import { ScraperError, fetchHtmlViaFetch, type ScraperProvider } from "@agent-engine/tool-karos-scraper";
import { MEDIA_CACHE_PREFIX, downloadImage, type FindImagesCandidate } from "./find-images.js";

// 1.0.0 — new (2026-09-24): the client's OWN website as an image source.
const TOOL_VERSION = "1.0.0";

/**
 * The licence line recorded on a picture taken from the client's own website.
 *
 * Stated as what it is and no more: the client published this image on its
 * own site, and it is used on the client's own channel. The owner approved
 * that use on 2026-09-24 (the product-campaign stage already works from the
 * client's real product photograph). It is NOT a claim that the client
 * commissioned every frame — a reviewer who knows a hero image is licensed
 * stock can still refuse it at the gate — and it is never offered for anyone
 * else's post, because only the client's own library ever holds it.
 *
 * Exported so the Instagram workflow files library rows under the SAME words
 * the tool wrote on the candidate: two spellings of one licence is how a rights
 * reader ends up treating the same picture two ways.
 */
export const CLIENT_SITE_LICENCE = "the client's own published website imagery, used on the client's own channel";

/** Short side, in pixels, under which a downloaded picture is page furniture (an icon, a swatch, a payment badge) rather than a picture of anything. NOT a quality floor: size decides placement, never admission, for real pictures. */
export const SITE_IMAGE_FURNITURE_MAX_SIDE = 160;

/** How long one page read may take. A homepage that has not answered in 15s is not going to answer in 30. */
const PAGE_TIMEOUT_MS = 15_000;

export const HarvestSiteImagesInputSchema = z.object({
  repoRoot: z.string().min(1).describe("Bounds root. Every returned path is relative to this and provably inside it."),
  runId: z.string().min(1).describe("Namespaces the cache directory, exactly as the other media tools do."),
  siteUrl: z.string().url().describe("The client's own website (its homepage). Images are read from this page and from up to `followLinks` shop/collection/product pages it links to on the same site."),
  maxImages: z.number().int().min(1).max(12).default(8).describe("How many pictures to download at most. Each one is a download and, downstream, one image in a vision call."),
  followLinks: z
    .number()
    .int()
    .min(0)
    .max(2)
    .default(2)
    .describe("How many shop/collection/product pages linked from the homepage to read as well. Those pages are where the client's product photographs actually live."),
  excludeImageUrls: z
    .array(z.string().min(1))
    .max(500)
    .default([])
    .describe("Image URLs already filed from this site. Skipped before download, so a re-harvest never pays twice for the same picture."),
});
export type HarvestSiteImagesInput = z.input<typeof HarvestSiteImagesInputSchema>;

/** One picture found on the client's site, before download. */
export interface SiteImageRef {
  /** Absolute image URL, resolved against the page it was found on. */
  url: string;
  /** The page's own words for the picture: `alt`, or `og:image:alt`, or the page's `og:title` for the social-card image. */
  alt?: string;
  pageUrl: string;
  pageTitle?: string;
  /** `meta`: the page's og:image/twitter:image. `img`: an `<img>` in the body. */
  origin: "meta" | "img";
}

/** A downloaded picture from the client's site. */
export interface SiteImageCandidate extends FindImagesCandidate {
  /** The image's own URL — the durable location a later run re-fetches it from. */
  imageUrl: string;
  pageUrl: string;
  pageTitle?: string;
  altText?: string;
}

export interface HarvestSiteImagesResult {
  candidates: SiteImageCandidate[];
  /** Every page read, how, and how many pictures it offered after filtering. */
  pagesRead: Array<{ url: string; via: "direct" | "scraper"; found: number }>;
  /** Pages or pictures that could not be used, named. Never silently dropped. */
  notes: string[];
  /** Billed scraper calls this harvest made (0 when the direct read worked), for the caller's cost meter. */
  scraperCalls: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure HTML reading
// ─────────────────────────────────────────────────────────────────────────────

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };

/** The handful of entities that actually appear in attribute values and titles. Not a full decoder, and it does not need to be. */
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = decodeEntities(value).replace(/\s+/gu, " ").trim();
  return text.length > 0 ? text : undefined;
}

/** A tag's attributes, lower-cased names, entity-decoded values. */
function attributesOf(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const pattern = /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu;
  for (const match of tag.matchAll(pattern)) {
    const name = match[1]!.toLowerCase();
    if (out.has(name)) continue;
    out.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return out;
}

/** The largest candidate in a `srcset`, by its `w` (or `x`) descriptor; the last one when none carries a descriptor. */
export function largestFromSrcset(srcset: string): string | undefined {
  let best: { url: string; size: number } | undefined;
  // Split on commas that END a candidate (followed by whitespace), so a URL
  // carrying a comma in its query (Cloudinary's `w_400,h_300`) survives.
  for (const part of srcset.split(/,\s+/u)) {
    const [url, descriptor] = part.trim().split(/\s+/u);
    if (url === undefined || url.length === 0) continue;
    const size = descriptor === undefined ? 0 : Number.parseFloat(descriptor);
    const weight = descriptor?.endsWith("x") ? size * 1000 : size;
    if (best === undefined || (Number.isFinite(weight) ? weight : 0) >= best.size) best = { url, size: Number.isFinite(weight) ? weight : 0 };
  }
  return best?.url;
}

/** Resolves `raw` against `base` into an absolute http(s) URL, or `undefined`. Shopify's `{width}` placeholder is filled with a slide-sized width. */
function resolveUrl(raw: string | undefined, base: string): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().replace(/\{width\}/gu, "1080");
  if (trimmed.length === 0 || /^(?:data|blob|javascript):/iu.test(trimmed) || trimmed.includes("{")) return undefined;
  try {
    const url = new URL(trimmed, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Hosts and host prefixes that serve tracking pixels, never pictures. */
const TRACKER_HOSTS = /(?:^|\.)(?:facebook\.com|facebook\.net|google-analytics\.com|googletagmanager\.com|doubleclick\.net|bat\.bing\.com|analytics\.[^.]+\.[^.]+|pixel\.[^.]+\.[^.]+|scorecardresearch\.com|hotjar\.com|klaviyo\.com)$/iu;

/** Path words that name page furniture rather than a picture of anything. Matched as whole path tokens, so `starry-night.jpg` is not a "star". */
const FURNITURE_TOKENS =
  /(?:^|[/_\-.])(?:logos?|icons?|favicon|sprites?|pixel|spacer|blank|transparent|placeholder|badges?|avatars?|payments?|flags?|loader|loading|spinner|arrows?|chevron|close|hamburger|menu|cart|search|social|facebook|instagram|twitter|tiktok|pinterest|youtube|linkedin|whatsapp|stars?|rating|swatch(?:es)?|trustpilot|klarna|paypal|visa|mastercard|amex|apple-pay|google-pay)(?=$|[/_\-.\d])/iu;

/** Formats a slide never places: vector marks, animations, icon containers. */
const UNPLACEABLE_EXTENSION = /\.(?:svg|gif|ico|bmp|tiff?|avif)$/iu;

/**
 * Why a found picture is NOT worth downloading, or `undefined` when it is.
 *
 * Every rule here is about what the picture IS (a logo, a tracking pixel, an
 * icon), never about how good it is: a small real product photograph is still
 * a product photograph, and the owner's standing ruling is that size decides
 * placement, not admission. The declared-size rule only catches markup that
 * says outright the element is icon-sized.
 */
export function siteImageRejection(ref: Pick<SiteImageRef, "url" | "alt">, declared: { width?: number; height?: number } = {}): string | undefined {
  let url: URL;
  try {
    url = new URL(ref.url);
  } catch {
    return "not a URL";
  }
  if (!isPublicHost(url.hostname)) return "not a public host";
  if (TRACKER_HOSTS.test(url.hostname)) return "a tracking host";
  const pathname = decodeURIComponentSafe(url.pathname);
  if (UNPLACEABLE_EXTENSION.test(pathname)) return "a vector, animated or icon format";
  if (FURNITURE_TOKENS.test(pathname)) return "page furniture (logo, icon, badge or similar) by its file name";
  if (ref.alt !== undefined && /\blogo\b/iu.test(ref.alt)) return "page furniture (the page calls it a logo)";
  const small = [declared.width, declared.height].filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0);
  if (small.some((n) => n < SITE_IMAGE_FURNITURE_MAX_SIDE)) return `declared icon-sized (${small.join("x")})`;
  return undefined;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * True for a hostname that is plausibly on the public internet.
 *
 * The site URL comes from a client profile a human typed, so a worker must not
 * be talked into reading its own metadata server or a private address through
 * it. A literal check, not DNS resolution: it stops the obvious cases, and the
 * pages this tool reads are ordinary public websites.
 */
export function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host.length === 0 || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return false;
  if (host === "metadata" || host === "metadata.google.internal") return false;
  if (host.includes(":")) return false; // IPv6 literal: never a client homepage
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224) return false;
  }
  return host.includes(".");
}

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The page's `<title>`, falling back to `og:title`. */
export function extractPageTitle(html: string): string | undefined {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1];
  const fromTitle = clean(title);
  if (fromTitle !== undefined) return fromTitle.slice(0, 160);
  for (const tag of html.match(/<meta\b[^>]*>/giu) ?? []) {
    const attrs = attributesOf(tag);
    if ((attrs.get("property") ?? attrs.get("name"))?.toLowerCase() === "og:title") return clean(attrs.get("content"))?.slice(0, 160);
  }
  return undefined;
}

/**
 * Every picture on one page worth downloading, in the order a reader meets
 * them: the page's own social-card image first (the picture the client chose
 * to represent the page), then the body's `<img>` elements. Filtered by
 * `siteImageRejection` and de-duplicated by image identity (the same file at
 * two widths is one picture).
 */
export function extractSiteImages(html: string, pageUrl: string): SiteImageRef[] {
  const pageTitle = extractPageTitle(html);
  const out: SiteImageRef[] = [];
  const seen = new Set<string>();
  const push = (ref: SiteImageRef, declared?: { width?: number; height?: number }) => {
    const key = imageIdentity(ref.url);
    if (seen.has(key)) return;
    if (siteImageRejection(ref, declared) !== undefined) return;
    seen.add(key);
    out.push(ref);
  };

  let ogTitle: string | undefined;
  let ogAlt: string | undefined;
  const metaImages: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/giu) ?? []) {
    const attrs = attributesOf(tag);
    const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
    const content = attrs.get("content");
    if (key === "og:title") ogTitle = clean(content);
    else if (key === "og:image:alt" || key === "twitter:image:alt") ogAlt ??= clean(content);
    else if (["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"].includes(key)) {
      const url = resolveUrl(content, pageUrl);
      if (url !== undefined) metaImages.push(url);
    }
  }
  for (const url of metaImages) {
    const alt = ogAlt ?? ogTitle;
    push({ url, pageUrl, ...(pageTitle !== undefined ? { pageTitle } : {}), ...(alt !== undefined ? { alt } : {}), origin: "meta" });
  }

  for (const tag of html.match(/<img\b[^>]*>/giu) ?? []) {
    const attrs = attributesOf(tag);
    const srcset = attrs.get("data-srcset") ?? attrs.get("srcset");
    const raw =
      (srcset !== undefined ? largestFromSrcset(srcset) : undefined) ??
      attrs.get("data-zoom-src") ??
      attrs.get("data-src") ??
      attrs.get("data-original") ??
      attrs.get("data-lazy-src") ??
      attrs.get("src");
    const url = resolveUrl(raw, pageUrl);
    if (url === undefined) continue;
    const alt = clean(attrs.get("alt"))?.slice(0, 200);
    const width = positiveInt(attrs.get("width"));
    const height = positiveInt(attrs.get("height"));
    push(
      { url, pageUrl, ...(pageTitle !== undefined ? { pageTitle } : {}), ...(alt !== undefined ? { alt } : {}), origin: "img" },
      { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) },
    );
  }
  return out;
}

/**
 * One picture's identity for de-duplication: host + path, plus the `url`
 * parameter an image proxy (Next.js `/_next/image?url=…`) carries the real
 * file in. Width/version query parameters are ignored, and so is a rendition
 * size written into the file name (Shopify's `_360x`, `_1080x1350`, a
 * `@2x`), so the 360w and 1080w renditions of one photograph are one picture.
 */
export function imageIdentity(raw: string): string {
  try {
    const url = new URL(raw);
    const inner = url.searchParams.get("url");
    const pathname = url.pathname.replace(/[_-](?:\d+x\d*|\d*x\d+)(?=\.[a-z0-9]+$)/iu, "").replace(/@\d(?:\.\d)?x(?=\.[a-z0-9]+$)/iu, "");
    return `${url.hostname.replace(/^www\./u, "")}${pathname}${inner !== null ? `?url=${inner}` : ""}`.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/** Listing pages (many products, each with its own alt text) and single product pages, by the path words shops actually use. */
const LISTING_PATH = /\/(?:collections?|shop|catalog(?:ue)?|store|category|categories|range|lookbook)(?:\/|$)/iu;
const PRODUCT_PATH = /\/(?:products?|item|p)\/[^/]+/iu;
const NOT_A_CATALOGUE = /\/(?:cart|checkout|account|login|signin|register|search|wishlist|policies|pages\/(?:contact|faq|shipping|returns))(?:\/|$)/iu;

/**
 * Up to `max` same-site catalogue pages linked from `html` — at most one
 * listing page and then one product page, so a two-page read sees both the
 * range and one product up close.
 */
export function extractCatalogueLinks(html: string, pageUrl: string, max = 2): string[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const host = base.hostname.replace(/^www\./u, "");
  const listings: string[] = [];
  const products: string[] = [];
  const seen = new Set<string>([base.pathname.replace(/\/+$/u, "") || "/"]);
  for (const tag of html.match(/<a\b[^>]*>/giu) ?? []) {
    const href = attributesOf(tag).get("href");
    const resolved = resolveUrl(href, base.toString());
    if (resolved === undefined) continue;
    const url = new URL(resolved);
    if (url.hostname.replace(/^www\./u, "") !== host) continue;
    const pathname = url.pathname.replace(/\/+$/u, "") || "/";
    if (seen.has(pathname) || NOT_A_CATALOGUE.test(pathname)) continue;
    const canonical = `${url.origin}${pathname}`;
    if (PRODUCT_PATH.test(pathname)) {
      seen.add(pathname);
      products.push(canonical);
    } else if (LISTING_PATH.test(pathname)) {
      seen.add(pathname);
      listings.push(canonical);
    }
  }
  const picked: string[] = [];
  if (listings[0] !== undefined) picked.push(listings[0]);
  if (products[0] !== undefined) picked.push(products[0]);
  for (const extra of [...listings.slice(1), ...products.slice(1)]) picked.push(extra);
  return picked.slice(0, max);
}

/**
 * Interleaves several pages' pictures, first of each page first, so an
 * eight-picture cap spans the homepage AND the product pages rather than
 * spending itself on the homepage's hero carousel.
 */
export function interleaveSiteImages(pages: ReadonlyArray<readonly SiteImageRef[]>): SiteImageRef[] {
  const out: SiteImageRef[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...pages.map((p) => p.length));
  for (let i = 0; i < longest; i++) {
    for (const page of pages) {
      const ref = page[i];
      if (ref === undefined) continue;
      const key = imageIdentity(ref.url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ref);
    }
  }
  return out;
}

/** The candidate description the vetting agent reads (until the workflow replaces it with the vision-annotated library sentence). */
export function describeSiteImage(ref: SiteImageRef): string {
  return (
    `picture published on the client's own website${ref.pageTitle !== undefined ? ` — page "${ref.pageTitle}"` : ""} (${ref.pageUrl})` +
    `${ref.alt !== undefined ? `, captioned there as "${ref.alt}"` : ""}. The client published it, so it is the client's own imagery of its own products and world. ` +
    `[licence: ${CLIENT_SITE_LICENCE}]`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The tool
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `media.harvestSiteImages` — the pictures on the client's OWN website.
 *
 * ## Why this tier exists
 *
 * On 2026-09-23 Hanky Panky's carousel shipped with zero pictures. The writer
 * named the product ("Signature Lace"); no licensed picture of it existed
 * anywhere except on the client's own site; and stock lace was, correctly,
 * refused by the image vet as an unnamed subject for a slide that names one.
 * Every client with a product has this problem, and every client with a
 * website has the answer on its own homepage.
 *
 * ## How it reads a site
 *
 * The homepage, then up to two catalogue pages it links to (one listing, one
 * product), each read with a plain GET first (free) and — for the homepage
 * only — through the configured scraper when the direct read is refused (one
 * billed call at most). Pictures come from `og:image`/`twitter:image` and the
 * body's `<img>` elements (largest `srcset` rendition, lazy-load attributes
 * included), minus page furniture. Each is downloaded through the same
 * `downloadImage` every other tier uses, on the `measure` policy: this is the
 * client's own picture, so a small one is placed smaller, never refused for
 * being small. Only pictures whose container says they are icon-sized
 * (`SITE_IMAGE_FURNITURE_MAX_SIDE`) are dropped as furniture.
 *
 * Best-effort throughout: an unreadable page is a note and the next page is
 * still read; no picture at all is a `content_fail` the caller records and
 * moves past.
 */
export function createHarvestSiteImages(options: { scraper?: ScraperProvider | undefined; fetchImpl?: typeof fetch }) {
  const fetchImpl = options.fetchImpl ?? fetch;

  return defineTool<HarvestSiteImagesInput, HarvestSiteImagesResult>({
    name: "media.harvestSiteImages",
    description:
      "Downloads pictures from the client's OWN website — its homepage and up to two shop/collection/product pages it links to — skipping logos, icons, tracking pixels and vector files. Each candidate carries the page it was found on and the page's own caption (alt text), and the licence line for the client's own published imagery used on the client's own channel.",
    version: TOOL_VERSION,
    inputSchema: HarvestSiteImagesInputSchema,
    async execute(rawInput) {
      const input = rawInput as z.output<typeof HarvestSiteImagesInputSchema>;
      const relDir = `${MEDIA_CACHE_PREFIX}/${input.runId}`;
      const absDir = path.resolve(input.repoRoot, relDir);
      const rootResolved = path.resolve(input.repoRoot);
      if (absDir !== rootResolved && !absDir.startsWith(rootResolved + path.sep)) {
        return toolingError(`media.harvestSiteImages: resolved cache dir escaped repoRoot (runId="${input.runId}")`);
      }
      let site: URL;
      try {
        site = new URL(input.siteUrl);
      } catch {
        return contentFail(`media.harvestSiteImages: "${input.siteUrl}" is not a URL`);
      }
      if (!isPublicHost(site.hostname)) {
        return contentFail(`media.harvestSiteImages: "${site.hostname}" is not a public host, so it was not read`);
      }
      try {
        await fs.mkdir(absDir, { recursive: true });
      } catch (error) {
        return toolingError(`media.harvestSiteImages: could not create ${relDir}: ${(error as Error).message}`);
      }

      const notes: string[] = [];
      const pagesRead: HarvestSiteImagesResult["pagesRead"] = [];
      let scraperCalls = 0;

      const readPage = async (url: string, allowScraper: boolean): Promise<{ html: string; finalUrl: string; via: "direct" | "scraper" } | undefined> => {
        let directProblem: string;
        try {
          const page = await fetchHtmlViaFetch(url, fetchImpl, PAGE_TIMEOUT_MS);
          if (page !== undefined && page.status >= 200 && page.status < 300 && page.html.trim().length > 0) {
            const finalUrl = isPublicHost(safeHost(page.finalUrl)) ? page.finalUrl : url;
            return { html: page.html, finalUrl, via: "direct" };
          }
          directProblem = page === undefined ? "not an HTML page" : `HTTP ${page.status}`;
        } catch (error) {
          directProblem = (error as Error).message;
        }
        if (!allowScraper || options.scraper === undefined) {
          notes.push(`${url} could not be read directly (${directProblem})`);
          return undefined;
        }
        try {
          scraperCalls += 1;
          const raw = await options.scraper.fetchRaw(url);
          if (raw?.html !== undefined && raw.html.trim().length > 0) return { html: raw.html, finalUrl: raw.url || url, via: "scraper" };
          notes.push(`${url} could not be read directly (${directProblem}) and the scraper returned no HTML`);
        } catch (error) {
          if (!(error instanceof ScraperError)) throw error;
          notes.push(`${url} could not be read directly (${directProblem}) nor through the scraper (${error.message})`);
        }
        return undefined;
      };

      const home = await readPage(site.toString(), true);
      if (home === undefined) {
        return contentFail(`media.harvestSiteImages: the client's website could not be read — ${notes.join("; ")}`);
      }
      const perPage: SiteImageRef[][] = [];
      let homeImages = extractSiteImages(home.html, home.finalUrl);
      // A homepage that answered a plain GET with no pictures at all is
      // usually a script-rendered shell; the scraper renders it. Still at most
      // one billed call per harvest, and only when the free read found nothing.
      if (homeImages.length === 0 && home.via === "direct" && options.scraper !== undefined) {
        try {
          scraperCalls += 1;
          const raw = await options.scraper.fetchRaw(site.toString());
          if (raw?.html !== undefined && raw.html.trim().length > 0) {
            const rendered = extractSiteImages(raw.html, raw.url || home.finalUrl);
            if (rendered.length > 0) {
              home.html = raw.html;
              home.via = "scraper";
              homeImages = rendered;
            }
          }
        } catch (error) {
          if (!(error instanceof ScraperError)) throw error;
          notes.push(`the homepage offered no pictures to a direct read and the scraper failed (${error.message})`);
        }
      }
      perPage.push(homeImages);
      pagesRead.push({ url: home.finalUrl, via: home.via, found: homeImages.length });

      for (const link of extractCatalogueLinks(home.html, home.finalUrl, input.followLinks)) {
        const page = await readPage(link, false);
        if (page === undefined) continue;
        const images = extractSiteImages(page.html, page.finalUrl);
        perPage.push(images);
        pagesRead.push({ url: page.finalUrl, via: page.via, found: images.length });
      }

      const excluded = new Set(input.excludeImageUrls.map(imageIdentity));
      const queue = interleaveSiteImages(perPage).filter((ref) => !excluded.has(imageIdentity(ref.url)));
      const alreadyFiled = interleaveSiteImages(perPage).length - queue.length;
      if (alreadyFiled > 0) notes.push(`${alreadyFiled} picture(s) on these pages are already filed and were not downloaded again`);

      const candidates: SiteImageCandidate[] = [];
      // Bounded attempts, so a page of forty broken images cannot turn one
      // harvest into forty downloads.
      const attempts = queue.slice(0, input.maxImages * 3);
      let furniture = 0;
      let failed = 0;
      for (const [index, ref] of attempts.entries()) {
        if (candidates.length >= input.maxImages) break;
        const saved = await downloadImage(fetchImpl, { id: `site-${ref.url}`, url: ref.url }, absDir, relDir, index + 1, "measure");
        if (!saved.ok) {
          failed += 1;
          continue;
        }
        if (saved.facts.shortSide < SITE_IMAGE_FURNITURE_MAX_SIDE) {
          // Written by the downloader before its size was known; removed so
          // nothing that trusts the directory can pick up an icon later.
          await fs.rm(path.join(input.repoRoot, saved.path), { force: true }).catch(() => undefined);
          furniture += 1;
          continue;
        }
        candidates.push({
          path: saved.path,
          pixels: saved.facts,
          ...(saved.warnings.length > 0 ? { qualityNotes: saved.warnings } : {}),
          description: describeSiteImage(ref),
          provider: "client-site",
          licenseConfidence: "client-supplied",
          imageUrl: ref.url,
          pageUrl: ref.pageUrl,
          ...(ref.pageTitle !== undefined ? { pageTitle: ref.pageTitle } : {}),
          ...(ref.alt !== undefined ? { altText: ref.alt } : {}),
        });
      }
      if (furniture > 0) notes.push(`${furniture} downloaded picture(s) were icon-sized (short side under ${SITE_IMAGE_FURNITURE_MAX_SIDE}px) and dropped as page furniture`);
      if (failed > 0) notes.push(`${failed} picture(s) could not be downloaded as a usable image`);

      if (candidates.length === 0) {
        return contentFail(
          `media.harvestSiteImages: no usable picture on ${pagesRead.map((p) => p.url).join(", ")}${notes.length > 0 ? ` — ${notes.join("; ")}` : ""}`,
        );
      }
      return success<HarvestSiteImagesResult>({ candidates, pagesRead, notes, scraperCalls });
    },
  });
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return "";
  }
}
