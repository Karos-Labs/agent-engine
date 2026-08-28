import { describe, expect, it } from "vitest";
import { createOfflineScraper, createScrappyCocoScraper, isPathDisallowed, parseRobotsTxt, parseSitemapXml } from "../src/index.js";

/**
 * Crawl capabilities (T-A1): `fetchStatus`, `fetchRobots`, `fetchSitemap`,
 * `crawlSite`. Unlike the five capabilities in scrappycoco.test.ts these are
 * plain-`fetch` mechanics, not billed ScrappyCoco executions — the mock
 * transport below is a URL-keyed router over ordinary HTTP responses, not a
 * `POST /scrapers/execute` body.
 */

function routedFetch(routes: Record<string, { status?: number; body?: string; headers?: Record<string, string>; redirectedTo?: string } | ((init?: RequestInit) => Response)>) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    if (typeof route === "function") return route(init);
    const response = new Response(route.body ?? "", { status: route.status ?? 200, headers: route.headers ?? {} });
    if (route.redirectedTo) Object.defineProperty(response, "url", { value: route.redirectedTo });
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const provider = (fetchImpl: typeof fetch) => createScrappyCocoScraper({ apiKey: "scrappy_test", fetchImpl });

describe("fetchStatus", () => {
  it("returns status, ok, and lower-cased headers from a HEAD request", async () => {
    const { fetchImpl, calls } = routedFetch({
      "https://example.com/a": { status: 200, headers: { "X-Robots-Tag": "noindex", "Content-Type": "text/html" } },
    });
    const status = await provider(fetchImpl).fetchStatus!("https://example.com/a");

    expect(status).toMatchObject({ url: "https://example.com/a", status: 200, ok: true });
    expect(status!.headers["x-robots-tag"]).toBe("noindex");
    expect(calls[0]).toEqual({ url: "https://example.com/a", method: "HEAD" });
  });

  it("falls back to GET when a server rejects HEAD", async () => {
    const { fetchImpl, calls } = routedFetch({
      "https://example.com/b": (init) => new Response("", { status: init?.method === "HEAD" ? 405 : 200 }),
    });
    const status = await provider(fetchImpl).fetchStatus!("https://example.com/b");

    expect(status!.status).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(["HEAD", "GET"]);
  });

  it("reports a 404 as data, not a thrown error — the page really is unreachable, not the transport", async () => {
    const { fetchImpl } = routedFetch({});
    const status = await provider(fetchImpl).fetchStatus!("https://example.com/missing");
    expect(status).toMatchObject({ status: 404, ok: false });
  });
});

describe("parseRobotsTxt", () => {
  it("expands a shared block across every named agent, and collects Sitemap: lines", () => {
    const body = [
      "User-agent: Googlebot",
      "User-agent: Bingbot",
      "Disallow: /admin",
      "Allow: /admin/public",
      "",
      "User-agent: *",
      "Disallow: /private",
      "",
      "Sitemap: https://example.com/sitemap.xml",
      "Sitemap: https://example.com/sitemap-news.xml",
    ].join("\n");

    const info = parseRobotsTxt("https://example.com/robots.txt", 200, body);

    expect(info.groups).toEqual([
      { userAgent: "Googlebot", disallow: ["/admin"], allow: ["/admin/public"] },
      { userAgent: "Bingbot", disallow: ["/admin"], allow: ["/admin/public"] },
      { userAgent: "*", disallow: ["/private"], allow: [] },
    ]);
    expect(info.sitemaps).toEqual(["https://example.com/sitemap.xml", "https://example.com/sitemap-news.xml"]);
  });

  it("ignores comments and rule lines with no preceding User-agent", () => {
    const info = parseRobotsTxt("https://example.com/robots.txt", 200, "# a comment\nDisallow: /orphan\nUser-agent: *\nDisallow: /x # trailing comment");
    expect(info.groups).toEqual([{ userAgent: "*", disallow: ["/x"], allow: [] }]);
  });
});

describe("isPathDisallowed", () => {
  const info = parseRobotsTxt(
    "https://example.com/robots.txt",
    200,
    ["User-agent: Googlebot", "Disallow: /admin", "Allow: /admin/public", "", "User-agent: *", "Disallow: /private"].join("\n"),
  );

  it("checks the named agent's rules first, falling back to *", () => {
    expect(isPathDisallowed(info, "/admin/secrets", "Googlebot")).toBe(true);
    expect(isPathDisallowed(info, "/private", "Googlebot")).toBe(false); // Googlebot has its own block; * does not apply to it
    expect(isPathDisallowed(info, "/private", "OtherBot")).toBe(true); // falls back to *
  });

  it("longest matching rule wins, so a nested Allow overrides a broader Disallow", () => {
    expect(isPathDisallowed(info, "/admin/public/x", "Googlebot")).toBe(false);
  });

  it("an agent named in the file with no rules at all disallows nothing", () => {
    expect(isPathDisallowed(info, "/anything", "Googlebot")).toBe(false);
  });
});

describe("fetchRobots", () => {
  it("fetches {origin}/robots.txt for the given URL and parses it", async () => {
    const { fetchImpl, calls } = routedFetch({
      "https://example.com/robots.txt": { body: "User-agent: *\nDisallow: /x\nSitemap: https://example.com/sitemap.xml" },
    });
    const info = await provider(fetchImpl).fetchRobots!("https://example.com/some/deep/page");

    expect(info).toMatchObject({ url: "https://example.com/robots.txt", status: 200 });
    expect(info!.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
    expect(calls[0]!.url).toBe("https://example.com/robots.txt");
  });
});

describe("parseSitemapXml", () => {
  it("extracts url + lastmod pairs from a <urlset>", () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://example.com/a</loc><lastmod>2026-01-15</lastmod></url>
      <url><loc>https://example.com/b</loc></url>
    </urlset>`;
    const result = parseSitemapXml("https://example.com/sitemap.xml", 200, xml);
    expect(result.entries).toEqual([{ url: "https://example.com/a", lastModified: "2026-01-15" }, { url: "https://example.com/b" }]);
    expect(result.childSitemaps).toBeUndefined();
  });

  it("returns childSitemaps, not entries, for a <sitemapindex>", () => {
    const xml = `<sitemapindex><sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap><sitemap><loc>https://example.com/sitemap-2.xml</loc></sitemap></sitemapindex>`;
    const result = parseSitemapXml("https://example.com/sitemap.xml", 200, xml);
    expect(result.entries).toEqual([]);
    expect(result.childSitemaps).toEqual(["https://example.com/sitemap-1.xml", "https://example.com/sitemap-2.xml"]);
  });
});

describe("fetchSitemap", () => {
  it("returns undefined for a 404 — no sitemap, not an empty one", async () => {
    const { fetchImpl } = routedFetch({});
    expect(await provider(fetchImpl).fetchSitemap!("https://example.com/sitemap.xml")).toBeUndefined();
  });

  it("follows a sitemap index and merges child entries, bounded by limit", async () => {
    const { fetchImpl } = routedFetch({
      "https://example.com/sitemap.xml": {
        body: `<sitemapindex><sitemap><loc>https://example.com/s1.xml</loc></sitemap><sitemap><loc>https://example.com/s2.xml</loc></sitemap></sitemapindex>`,
      },
      "https://example.com/s1.xml": {
        body: `<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>`,
      },
      "https://example.com/s2.xml": {
        body: `<urlset><url><loc>https://example.com/c</loc></url></urlset>`,
      },
    });

    const full = await provider(fetchImpl).fetchSitemap!("https://example.com/sitemap.xml", { limit: 50 });
    expect(full!.entries.map((e) => e.url)).toEqual(["https://example.com/a", "https://example.com/b", "https://example.com/c"]);

    const bounded = await provider(fetchImpl).fetchSitemap!("https://example.com/sitemap.xml", { limit: 1 });
    expect(bounded!.entries).toHaveLength(1);
  });
});

describe("crawlSite", () => {
  it("prefers the sitemap over link-following when one resolves", async () => {
    const { fetchImpl, calls } = routedFetch({
      "https://example.com/robots.txt": { body: "Sitemap: https://example.com/sitemap.xml" },
      "https://example.com/sitemap.xml": {
        body: `<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>`,
      },
      "https://example.com/a": { status: 200 },
      "https://example.com/b": { status: 404 },
    });

    const result = await provider(fetchImpl).crawlSite!("https://example.com/");

    expect(result.sitemap?.entries.map((e) => e.url)).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(result.pages).toEqual([
      { url: "https://example.com/a", status: 200 },
      { url: "https://example.com/b", status: 404 },
    ]);
    expect(result.truncated).toBe(false);
    // Never fell back to fetching the seed page for links, since the sitemap already answered.
    expect(calls.some((c) => c.url === "https://example.com/" && c.method === "GET")).toBe(false);
  });

  it("falls back to following same-origin links when no sitemap exists", async () => {
    const { fetchImpl } = routedFetch({
      "https://example.com/": { body: `<a href="/about">About</a> <a href="https://other.com/x">off-site</a>` },
      "https://example.com/about": { status: 200 },
    });

    const result = await provider(fetchImpl).crawlSite!("https://example.com/", { maxDepth: 1, limit: 10 });

    expect(result.sitemap).toBeUndefined();
    const urls = result.pages.map((p) => p.url);
    expect(urls).toContain("https://example.com/");
    expect(urls).toContain("https://example.com/about");
    // sameOriginOnly defaults to true.
    expect(urls).not.toContain("https://other.com/x");
  });

  it("records an unreachable page as status 0 rather than dropping it", async () => {
    const { fetchImpl } = routedFetch({
      "https://example.com/sitemap.xml": { body: `<urlset><url><loc>https://example.com/dead</loc></url></urlset>` },
      "https://example.com/dead": () => {
        throw new Error("network unreachable");
      },
    });
    const result = await provider(fetchImpl).crawlSite!("https://example.com/");
    expect(result.pages).toEqual([{ url: "https://example.com/dead", status: 0 }]);
  });
});

describe("offline scraper — crawl capabilities", () => {
  it("labels every synthetic record so a leak into a real run is obvious", async () => {
    const offline = createOfflineScraper();

    const status = await offline.fetchStatus!("https://client.example/");
    expect(status).toMatchObject({ status: 200, ok: true });

    const robots = await offline.fetchRobots!("https://client.example/");
    expect(robots!.url).toBe("https://client.example/robots.txt");
    expect(robots!.sitemaps).toEqual(["https://client.example/sitemap.xml"]);

    const sitemap = await offline.fetchSitemap!("https://client.example/");
    expect(sitemap!.entries.length).toBeGreaterThan(0);
    for (const entry of sitemap!.entries) expect(entry.url).toContain("client.example");

    const crawl = await offline.crawlSite!("https://client.example/");
    expect(crawl.seedUrl).toBe("https://client.example/");
    expect(crawl.pages.length).toBeGreaterThan(1);
    expect(crawl.truncated).toBe(false);
  });

  it("is never returned by the live factory — opt-in only, same rule as the original five capabilities", async () => {
    const { createScraperProvider } = await import("../src/index.js");
    const built = createScraperProvider({ env: {} });
    expect(built).toBeUndefined();
  });
});
