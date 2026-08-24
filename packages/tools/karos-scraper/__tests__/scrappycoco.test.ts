import { describe, expect, it } from "vitest";
import { createScrappyCocoScraper, createScraperProvider, ScraperError } from "../src/index.js";

/**
 * `ScrappyCocoScraper` against a mocked transport.
 *
 * The response fixtures below are trimmed from real `POST /scrapers/execute`
 * responses captured from the live account, not invented: the normalised record
 * shape (`url`/`title`/`text`/`published_at`/`author`/`engagement`/`outputs`)
 * is what the API actually returns for every capability, which is the property
 * the whole mapping layer depends on.
 */

/** Captures each request so the request contract is assertable, not just the parsing. */
function mockTransport(handler: (body: Record<string, unknown>, headers: Record<string, string>) => unknown, status = 200) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(input), body, headers });
    const payload = handler(body, headers);
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const scraper = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  createScrappyCocoScraper({ apiKey: "scrappy_test", fetchImpl, idempotencyKey: () => "fixed-key", ...extra });

const webSearchResponse = {
  status: "completed",
  selected_provider: "exa",
  records: [
    {
      id: "https://example.com/a",
      url: "https://example.com/a",
      title: "AI adoption outpaces marketing operations",
      text: "76% of global marketing leaders spend at least three hours per week fact-checking.",
      published_at: "2026-07-29T00:00:00.000Z",
      author: null,
      engagement: null,
      capability: "search_web",
      metadata: { rank: 1, domain: "example.com" },
      outputs: {},
    },
  ],
};

describe("ScrappyCocoScraper — request contract", () => {
  it("authenticates with X-API-Key and sends an Idempotency-Key on every billable execution", async () => {
    const { fetchImpl, calls } = mockTransport(() => webSearchResponse);
    await scraper(fetchImpl).searchKeyword("ai marketing", { limit: 2 });

    expect(calls[0]!.url).toBe("https://api.scrappycoco.ai/api/v1/scrapers/execute");
    expect(calls[0]!.headers["X-API-Key"]).toBe("scrappy_test");
    // The API requires this on billable POSTs; without it a retry double-charges.
    expect(calls[0]!.headers["Idempotency-Key"]).toBe("fixed-key");
    expect(calls[0]!.body).toMatchObject({ source: "web", capability: "search_web", input: { query: "ai marketing" }, limit: 2 });
  });

  it("passes country and domain filters through only when supplied", async () => {
    const { fetchImpl, calls } = mockTransport(() => webSearchResponse);
    const s = scraper(fetchImpl);

    await s.searchKeyword("q", { country: "us", includeDomains: ["a.com"] });
    expect(calls[0]!.body["input"]).toEqual({ query: "q", country: "us", include_domains: ["a.com"] });

    await s.searchKeyword("q");
    // Absent rather than null: the API rejects unexpected properties.
    expect(calls[1]!.body["input"]).toEqual({ query: "q" });
  });

  it("routes each social platform to the capability that actually answers its history question", async () => {
    const { fetchImpl, calls } = mockTransport(() => ({ status: "completed", records: [] }));
    const s = scraper(fetchImpl);

    await s.socialHistory({ platform: "x", username: "@karoslabs", limit: 5 });
    await s.socialHistory({ platform: "reddit", username: "someone" });

    expect(calls[0]!.body).toMatchObject({ source: "x", capability: "account_posts", input: { username: "karoslabs" }, limit: 5 });
    // Reddit has no account_posts capability; user_activity is its equivalent.
    expect(calls[1]!.body).toMatchObject({ source: "reddit", capability: "user_activity" });
  });

  it("strips a leading @ from handles, which every provider rejects", async () => {
    const { fetchImpl, calls } = mockTransport(() => ({ status: "completed", records: [] }));
    await scraper(fetchImpl).socialHistory({ platform: "instagram", username: "@@someone" });
    expect((calls[0]!.body["input"] as Record<string, string>)["username"]).toBe("someone");
  });
});

describe("ScrappyCocoScraper — record mapping", () => {
  it("maps a web search hit into a citable record", async () => {
    const { fetchImpl } = mockTransport(() => webSearchResponse);
    const [record] = await scraper(fetchImpl).searchKeyword("ai marketing");

    expect(record).toMatchObject({
      id: "https://example.com/a",
      url: "https://example.com/a",
      title: "AI adoption outpaces marketing operations",
      publishedAt: "2026-07-29T00:00:00.000Z",
      capability: "search_web",
    });
    // A null author must not become the string "null".
    expect(record!.author).toBeUndefined();
    expect(record!.engagement).toBeUndefined();
  });

  it("collects image URLs from a social post, including nested carousel images", async () => {
    const { fetchImpl } = mockTransport(() => ({
      status: "completed",
      records: [
        {
          id: "p1",
          url: "https://www.instagram.com/reel/X/",
          published_at: "2026-04-29T15:28:03.000Z",
          author: "someone",
          engagement: { likes: 470, comments: 3, views: null },
          outputs: {
            json: {
              display_url: "https://cdn.example.com/main.jpg",
              thumbnail_src: "https://cdn.example.com/thumb.jpg",
              nested: { images: [{ src: "https://cdn.example.com/carousel-2.png" }] },
            },
          },
        },
      ],
    }));

    const [record] = await scraper(fetchImpl).searchSocial("instagram", "empty desk");

    expect(record!.imageUrls).toContain("https://cdn.example.com/main.jpg");
    expect(record!.imageUrls).toContain("https://cdn.example.com/thumb.jpg");
    // Found by serialising the payload, so the mapper need not model every provider's nesting.
    expect(record!.imageUrls).toContain("https://cdn.example.com/carousel-2.png");
    // `views: null` must not survive as a key.
    expect(record!.engagement).toEqual({ likes: 470, comments: 3 });
  });

  it("honours limit even when the provider over-returns", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, url: `https://example.com/${i}` }));
    const { fetchImpl } = mockTransport(() => ({ status: "completed", records: many }));
    expect(await scraper(fetchImpl).searchKeyword("q", { limit: 3 })).toHaveLength(3);
  });

  it("drops a record with neither id nor url rather than emitting a broken one", async () => {
    const { fetchImpl } = mockTransport(() => ({ status: "completed", records: [{ title: "no identity" }, { id: "ok", url: "https://ok" }] }));
    const records = await scraper(fetchImpl).searchKeyword("q");
    expect(records.map((r) => r.id)).toEqual(["ok"]);
  });

  it("returns undefined from extractUrl when the provider yields nothing", async () => {
    const { fetchImpl } = mockTransport(() => ({ status: "completed", records: [] }));
    expect(await scraper(fetchImpl).extractUrl("https://example.com")).toBeUndefined();
  });

  it("exposes raw text and html through fetchRaw", async () => {
    const { fetchImpl } = mockTransport(() => ({
      status: "completed",
      records: [{ id: "x", url: "https://example.com", title: "T", text: "body", outputs: { html: "<html>body</html>" } }],
    }));
    expect(await scraper(fetchImpl).fetchRaw("https://example.com")).toEqual({
      url: "https://example.com",
      title: "T",
      text: "body",
      html: "<html>body</html>",
    });
  });
});

describe("ScrappyCocoScraper — failure classification", () => {
  const cases: Array<[number, RegExp]> = [
    [401, /invalid or unauthorised SCRAPPYCOCO_API_KEY/],
    [402, /account out of credit/],
    [429, /rate limited/],
  ];

  for (const [status, expected] of cases) {
    it(`names the cause of an HTTP ${status}, because each needs a different fix`, async () => {
      const { fetchImpl } = mockTransport(() => ({ error: "nope" }), status);
      await expect(scraper(fetchImpl).searchKeyword("q")).rejects.toThrow(expected);
    });
  }

  it("carries the status on the error so callers can branch without parsing the message", async () => {
    const { fetchImpl } = mockTransport(() => ({}), 402);
    await expect(scraper(fetchImpl).searchKeyword("q")).rejects.toMatchObject({ status: 402 });
  });

  it("treats a 200 carrying a terminal non-success status as a failure, not an empty result", async () => {
    // Otherwise a broken run is indistinguishable from a query that found nothing,
    // which is exactly how a dead research pipeline stayed invisible for months.
    const { fetchImpl } = mockTransport(() => ({ status: "failed", records: [] }));
    await expect(scraper(fetchImpl).searchKeyword("q")).rejects.toThrow(/finished as "failed"/);
  });

  it("accepts a partial status, since some records are better than none", async () => {
    const { fetchImpl } = mockTransport(() => ({ status: "partial", records: [{ id: "a", url: "https://a" }] }));
    expect(await scraper(fetchImpl).searchKeyword("q")).toHaveLength(1);
  });

  it("surfaces a transport failure as ScraperError rather than a raw fetch error", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(scraper(fetchImpl).searchKeyword("q")).rejects.toBeInstanceOf(ScraperError);
  });

  it("surfaces a non-JSON body with the capability named", async () => {
    const fetchImpl = (async () => new Response("<html>gateway</html>", { status: 200 })) as unknown as typeof fetch;
    await expect(scraper(fetchImpl).searchKeyword("q")).rejects.toThrow(/non-JSON body/);
  });
});

describe("createScraperProvider factory", () => {
  it("builds a provider when the key is present and returns undefined when it is not", () => {
    expect(createScraperProvider({ env: { SCRAPPYCOCO_API_KEY: "scrappy_x" } })?.name).toBe("scrappycoco");
    // undefined, never a stub that answers politely with nothing.
    expect(createScraperProvider({ env: {} })).toBeUndefined();
    expect(createScraperProvider({ env: { SCRAPPYCOCO_API_KEY: "   " } })).toBeUndefined();
  });

  it("lets a caller inject a provider, and force the unconfigured path with null", () => {
    const fake = { name: "fake" } as never;
    expect(createScraperProvider({ provider: fake })).toBe(fake);
    expect(createScraperProvider({ provider: null, env: { SCRAPPYCOCO_API_KEY: "scrappy_x" } })).toBeUndefined();
  });

  it("honours a base-URL override, for a proxy or a staging host", async () => {
    const { fetchImpl, calls } = mockTransport(() => ({ status: "completed", records: [] }));
    const provider = createScraperProvider({
      env: { SCRAPPYCOCO_API_KEY: "scrappy_x", SCRAPPYCOCO_BASE_URL: "https://proxy.internal/api/v1/" },
      fetchImpl,
    })!;
    await provider.searchKeyword("q");
    // Trailing slash normalised, so the path is not doubled.
    expect(calls[0]!.url).toBe("https://proxy.internal/api/v1/scrapers/execute");
  });
});

/**
 * Live interface check. Skipped unless `SCRAPPYCOCO_LIVE_TEST=1` and a real key
 * are both present, because each execution is billed (~$0.007 for a web
 * search) and a suite that silently spends money on every CI run is a suite
 * people learn to distrust.
 *
 * Run with:
 *   SCRAPPYCOCO_LIVE_TEST=1 SCRAPPYCOCO_API_KEY=scrappy_... npx vitest run
 */
const liveKey = process.env["SCRAPPYCOCO_API_KEY"];
const liveEnabled = process.env["SCRAPPYCOCO_LIVE_TEST"] === "1" && typeof liveKey === "string" && liveKey.length > 0;

describe.skipIf(!liveEnabled)("ScrappyCocoScraper — live", () => {
  it("returns real, citable records from a real web search", async () => {
    const provider = createScrappyCocoScraper({ apiKey: liveKey! });
    const records = await provider.searchKeyword("AI marketing bottleneck 2026", { limit: 2 });

    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.url).toMatch(/^https?:\/\//);
      // A record with no text supports no claim, which is the only thing the
      // research pipeline wants these for.
      expect((record.text ?? "").length).toBeGreaterThan(0);
    }
  }, 180_000);
});
