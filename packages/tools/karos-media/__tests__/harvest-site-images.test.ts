import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ScraperError, type ScraperProvider } from "@agent-engine/tool-karos-scraper";
import {
  CLIENT_SITE_LICENCE,
  createKarosMediaTools,
  extractCatalogueLinks,
  extractPageTitle,
  extractSiteImages,
  imageIdentity,
  interleaveSiteImages,
  isPublicHost,
  largestFromSrcset,
  siteImageRejection,
  type ImageSearchProvider,
  type SiteImageCandidate,
} from "../src/index.js";
import { realJpeg, realPng } from "./image-fixtures.js";

/**
 * `media.harvestSiteImages` — the client's OWN website as an image source.
 *
 * Hanky Panky's 2026-09-23 carousel shipped with zero pictures because the
 * product the copy named existed as a picture only on the client's own site.
 * These tests pin the two halves that decide whether that site is usable: the
 * HTML reading (which pictures on a real shop page are pictures of the product,
 * and which are logos, icons and tracking pixels), and the tool's degrade path
 * (a site that refuses a read is a note, never a thrown failure).
 */

const CTX = { runId: "run_site", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" } as never;
const NO_HITS: ImageSearchProvider = { name: "none", async search() { return []; } };

let repoRoot: string;
beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "karos-site-"));
});
afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

const HOME_HTML = `<!doctype html><html><head>
<title>Hanky Panky &amp; Co | Lingerie</title>
<meta property="og:title" content="Hanky Panky">
<meta property="og:image" content="https://cdn.shop.test/files/hero-signature-lace.jpg?v=12">
<link rel="icon" href="/favicon.ico">
<script src="https://www.googletagmanager.com/gtm.js"></script>
</head><body>
<a href="/"><img src="/assets/logo-hanky.png" alt="Hanky Panky logo" width="180" height="40"></a>
<img src="https://www.facebook.com/tr?id=1&ev=PageView" width="1" height="1">
<img src="/icons/cart.svg" alt="cart">
<img srcset="//cdn.shop.test/files/signature-lace-thong_360x.jpg 360w, //cdn.shop.test/files/signature-lace-thong_1080x.jpg 1080w" alt="Signature Lace Original Rise Thong">
<img data-src="//cdn.shop.test/files/bralette_{width}x.jpg" alt="Signature Lace Bralette" src="data:image/gif;base64,R0lGOD">
<img src="//cdn.shop.test/files/signature-lace-thong_720x.jpg" alt="duplicate rendition">
<img src="/files/swatch-black.jpg" width="40" height="40" alt="Black">
<a href="/collections/signature-lace">Shop Signature Lace</a>
<a href="/products/original-rise-thong">Original Rise</a>
<a href="/cart">Cart</a>
<a href="https://elsewhere.test/collections/x">Partner</a>
</body></html>`;

describe("reading a shop page — which pictures are pictures of something", () => {
  it("keeps the social-card image and the product photographs, drops logos, pixels, icons and swatches", () => {
    const found = extractSiteImages(HOME_HTML, "https://hankypanky.test/");
    const urls = found.map((f) => f.url);
    expect(urls[0]).toBe("https://cdn.shop.test/files/hero-signature-lace.jpg?v=12");
    expect(found[0]!.origin).toBe("meta");
    // Largest srcset rendition, protocol-relative resolved against the page.
    expect(urls).toContain("https://cdn.shop.test/files/signature-lace-thong_1080x.jpg");
    // Shopify's lazy `{width}` placeholder filled, the data: placeholder ignored.
    expect(urls).toContain("https://cdn.shop.test/files/bralette_1080x.jpg");
    expect(urls.some((u) => u.includes("logo"))).toBe(false);
    expect(urls.some((u) => u.includes("facebook.com"))).toBe(false);
    expect(urls.some((u) => u.endsWith(".svg"))).toBe(false);
    expect(urls.some((u) => u.includes("swatch"))).toBe(false);
    expect(urls.some((u) => u.startsWith("data:"))).toBe(false);
  });

  it("carries the page's own caption — the client's product name — with each picture", () => {
    const found = extractSiteImages(HOME_HTML, "https://hankypanky.test/");
    const thong = found.find((f) => f.url.includes("signature-lace-thong"));
    expect(thong?.alt).toBe("Signature Lace Original Rise Thong");
    expect(thong?.pageTitle).toBe("Hanky Panky & Co | Lingerie");
    expect(thong?.pageUrl).toBe("https://hankypanky.test/");
    // The social-card image has no alt of its own, so the page's og:title names it.
    expect(found[0]!.alt).toBe("Hanky Panky");
  });

  it("treats two renditions of one file as one picture", () => {
    expect(imageIdentity("https://cdn.test/a/b.jpg?width=360")).toBe(imageIdentity("https://cdn.test/a/b.jpg?width=1080&v=2"));
    expect(imageIdentity("https://site.test/_next/image?url=%2Fa.jpg&w=640")).not.toBe(imageIdentity("https://site.test/_next/image?url=%2Fb.jpg&w=640"));
    const found = extractSiteImages(HOME_HTML, "https://hankypanky.test/");
    expect(found.filter((f) => f.url.includes("signature-lace-thong")).length).toBe(1);
  });

  it("picks the largest srcset candidate, by width or density", () => {
    expect(largestFromSrcset("a.jpg 320w, b.jpg 1280w, c.jpg 640w")).toBe("b.jpg");
    expect(largestFromSrcset("a.jpg 1x, b.jpg 2x")).toBe("b.jpg");
    expect(largestFromSrcset("https://res.test/w_400,h_300/a.jpg 400w, https://res.test/w_800,h_600/a.jpg 800w")).toBe("https://res.test/w_800,h_600/a.jpg");
  });

  it("names why a picture is refused, and refuses on WHAT it is, never on how good it is", () => {
    expect(siteImageRejection({ url: "https://cdn.test/files/brand-logo.png" })).toMatch(/furniture/);
    expect(siteImageRejection({ url: "https://cdn.test/files/product.jpg", alt: "Company Logo" })).toMatch(/logo/);
    expect(siteImageRejection({ url: "https://cdn.test/files/product.jpg" }, { width: 64, height: 64 })).toMatch(/icon-sized/);
    expect(siteImageRejection({ url: "http://169.254.169.254/latest/meta-data/x.jpg" })).toMatch(/public/);
    // A small-but-real product photograph is NOT refused: size decides placement, not admission.
    expect(siteImageRejection({ url: "https://cdn.test/files/product.jpg" }, { width: 400, height: 300 })).toBeUndefined();
    // Whole path tokens only — "starry" is not a "star".
    expect(siteImageRejection({ url: "https://cdn.test/files/starry-night-set.jpg" })).toBeUndefined();
  });

  it("refuses private and metadata hosts", () => {
    expect(isPublicHost("hankypanky.com")).toBe(true);
    expect(isPublicHost("localhost")).toBe(false);
    expect(isPublicHost("metadata.google.internal")).toBe(false);
    expect(isPublicHost("10.0.0.4")).toBe(false);
    expect(isPublicHost("192.168.1.1")).toBe(false);
    expect(isPublicHost("8.8.8.8")).toBe(true);
  });

  it("follows one listing page and one product page on the same site, never the cart or another site", () => {
    expect(extractCatalogueLinks(HOME_HTML, "https://hankypanky.test/", 2)).toEqual([
      "https://hankypanky.test/collections/signature-lace",
      "https://hankypanky.test/products/original-rise-thong",
    ]);
    expect(extractCatalogueLinks(HOME_HTML, "https://hankypanky.test/", 0)).toEqual([]);
  });

  it("reads a title from <title>, falling back to og:title", () => {
    expect(extractPageTitle("<title> A &amp; B </title>")).toBe("A & B");
    expect(extractPageTitle('<meta property="og:title" content="Only OG">')).toBe("Only OG");
  });

  it("interleaves pages so a cap spans the homepage and the product pages", () => {
    const ref = (url: string) => ({ url, pageUrl: "https://s.test/", origin: "img" as const });
    const merged = interleaveSiteImages([[ref("https://s.test/h1.jpg"), ref("https://s.test/h2.jpg")], [ref("https://s.test/p1.jpg")]]);
    expect(merged.map((m) => m.url)).toEqual(["https://s.test/h1.jpg", "https://s.test/p1.jpg", "https://s.test/h2.jpg"]);
  });
});

/** A fetch that serves pages and images from a table, and records what was asked for. */
function siteFetch(table: Record<string, { body: string | Buffer; type: string; status?: number }>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(url);
    const hit = table[url];
    if (hit === undefined) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    return new Response(hit.body, { status: hit.status ?? 200, headers: { "content-type": hit.type } });
  }) as unknown as typeof fetch;
}

function tool(fetchImpl: typeof fetch, scraper: ScraperProvider | null = null) {
  return createKarosMediaTools({ provider: NO_HITS, fetchImpl, scraper })["media.harvestSiteImages"]!;
}

const PAGES = {
  "https://hankypanky.test/": { body: HOME_HTML, type: "text/html; charset=utf-8" },
  "https://hankypanky.test/collections/signature-lace": {
    body: `<title>Signature Lace Collection</title><img src="https://cdn.shop.test/files/sl-collection-1.jpg" alt="Signature Lace Retro Thong">`,
    type: "text/html",
  },
  "https://hankypanky.test/products/original-rise-thong": {
    body: `<title>Original Rise Thong | Hanky Panky</title><img src="https://cdn.shop.test/files/signature-lace-thong_1080x.jpg" alt="Signature Lace Original Rise Thong">`,
    type: "text/html",
  },
  "https://cdn.shop.test/files/hero-signature-lace.jpg?v=12": { body: realJpeg(1600, 900), type: "image/jpeg" },
  "https://cdn.shop.test/files/signature-lace-thong_1080x.jpg": { body: realJpeg(1080, 1350), type: "image/jpeg" },
  "https://cdn.shop.test/files/bralette_1080x.jpg": { body: realPng(96, 96), type: "image/png" },
  "https://cdn.shop.test/files/sl-collection-1.jpg": { body: realJpeg(600, 750), type: "image/jpeg" },
};

describe("media.harvestSiteImages — the tool", () => {
  it("downloads the client's pictures with their page, caption and the client-site licence, dropping icon-sized ones", async () => {
    const outcome = await tool(siteFetch(PAGES)).execute({ repoRoot, runId: "run_site", siteUrl: "https://hankypanky.test/" }, { ctx: CTX });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    const result = outcome.result as { candidates: SiteImageCandidate[]; pagesRead: Array<{ url: string; via: string }>; notes: string[]; scraperCalls: number };
    expect(result.pagesRead.map((p) => p.url)).toEqual([
      "https://hankypanky.test/",
      "https://hankypanky.test/collections/signature-lace",
      "https://hankypanky.test/products/original-rise-thong",
    ]);
    expect(result.scraperCalls).toBe(0);
    const thong = result.candidates.find((c) => c.imageUrl.includes("signature-lace-thong"));
    expect(thong).toBeDefined();
    expect(thong!.altText).toBe("Signature Lace Original Rise Thong");
    expect(thong!.description).toContain("Signature Lace Original Rise Thong");
    expect(thong!.description).toContain(`[licence: ${CLIENT_SITE_LICENCE}]`);
    expect(thong!.provider).toBe("client-site");
    expect(thong!.licenseConfidence).toBe("client-supplied");
    await expect(fs.stat(path.join(repoRoot, thong!.path))).resolves.toBeTruthy();
    // The 96px bralette is a real image but icon-sized: dropped as furniture and removed from disk.
    expect(result.candidates.some((c) => c.imageUrl.includes("bralette"))).toBe(false);
    expect(result.notes.join(" ")).toMatch(/icon-sized/);
    // A smaller-than-slide real photograph is kept (measured, not refused).
    expect(result.candidates.some((c) => c.imageUrl.includes("sl-collection-1"))).toBe(true);
    // Every staged file is under the run's media cache.
    for (const c of result.candidates) expect(c.path.startsWith(".media-cache/run_site/")).toBe(true);
  });

  it("never downloads a picture already filed", async () => {
    const seen: string[] = [];
    const outcome = await tool(siteFetch(PAGES, seen)).execute(
      { repoRoot, runId: "run_site", siteUrl: "https://hankypanky.test/", excludeImageUrls: ["https://cdn.shop.test/files/signature-lace-thong_1080x.jpg"] },
      { ctx: CTX },
    );
    expect(outcome.status).toBe("success");
    expect(seen).not.toContain("https://cdn.shop.test/files/signature-lace-thong_1080x.jpg");
  });

  it("respects maxImages", async () => {
    const outcome = await tool(siteFetch(PAGES)).execute({ repoRoot, runId: "run_site", siteUrl: "https://hankypanky.test/", maxImages: 1 }, { ctx: CTX });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect((outcome.result as { candidates: unknown[] }).candidates).toHaveLength(1);
  });

  it("falls back to the scraper for a homepage that refuses a direct read, and counts the billed call", async () => {
    const blocked = siteFetch({ ...PAGES, "https://hankypanky.test/": { body: "forbidden", type: "text/html", status: 403 } });
    const scraper: ScraperProvider = {
      name: "stub",
      async extractUrl() {
        return undefined;
      },
      async searchKeyword() {
        return [];
      },
      async socialHistory() {
        return [];
      },
      async fetchRaw(url: string) {
        return { url, html: HOME_HTML };
      },
    } as unknown as ScraperProvider;
    const outcome = await tool(blocked, scraper).execute({ repoRoot, runId: "run_site", siteUrl: "https://hankypanky.test/", followLinks: 0 }, { ctx: CTX });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    const result = outcome.result as { pagesRead: Array<{ via: string }>; scraperCalls: number; candidates: unknown[] };
    expect(result.pagesRead[0]!.via).toBe("scraper");
    expect(result.scraperCalls).toBe(1);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it("asks the scraper to render a homepage whose plain read carried no pictures (a script-rendered shell)", async () => {
    const shell = siteFetch({ ...PAGES, "https://hankypanky.test/": { body: "<html><body><div id=root></div></body></html>", type: "text/html" } });
    let rendered = 0;
    const scraper = {
      name: "stub",
      async fetchRaw(url: string) {
        rendered += 1;
        return { url, html: HOME_HTML };
      },
    } as unknown as ScraperProvider;
    const outcome = await tool(shell, scraper).execute({ repoRoot, runId: "run_site", siteUrl: "https://hankypanky.test/", followLinks: 0 }, { ctx: CTX });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    const result = outcome.result as { pagesRead: Array<{ via: string; found: number }>; scraperCalls: number; candidates: unknown[] };
    expect(rendered).toBe(1);
    expect(result.scraperCalls).toBe(1);
    expect(result.pagesRead[0]).toMatchObject({ via: "scraper" });
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it("an unreadable site is a content_fail with the reason, never a throw", async () => {
    const scraper = {
      name: "stub",
      async fetchRaw() {
        throw new ScraperError("vendor down");
      },
    } as unknown as ScraperProvider;
    const outcome = await tool(siteFetch({}), scraper).execute({ repoRoot, runId: "run_site", siteUrl: "https://hankypanky.test/" }, { ctx: CTX });
    expect(outcome.status).toBe("content_fail");
    expect("reason" in outcome ? outcome.reason : "").toMatch(/could not be read/);
  });

  it("refuses a private host without fetching it", async () => {
    const seen: string[] = [];
    const outcome = await tool(siteFetch({}, seen)).execute({ repoRoot, runId: "run_site", siteUrl: "http://127.0.0.1:8080/" }, { ctx: CTX });
    expect(outcome.status).toBe("content_fail");
    expect(seen).toEqual([]);
  });
});
