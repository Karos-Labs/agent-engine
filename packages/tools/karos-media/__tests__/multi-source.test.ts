import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildProviderRegistry,
  createDdgImagesProvider,
  createFindImages,
  createGooglePlacesProvider,
  createImageSource,
  createKarosMediaTools,
  createOpenverseProvider,
  createPexelsProvider,
  createPixabayProvider,
  createUnsplashProvider,
  createWikimediaProvider,
  ImageProviderError,
  isBlockedImageUrl,
  ROUTE_CHAINS,
  simplifyQuery,
  broadeningVariants,
  type ImageSearchHit,
  type ImageSearchProvider,
} from "../src/index.js";

/** A fetch that answers each URL substring with a canned JSON body, and records what it was asked. */
function routedFetch(routes: Array<{ match: string; body: unknown; status?: number }>) {
  const seen: string[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    seen.push(url);
    const hit = routes.find((r) => url.includes(r.match));
    if (!hit) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(hit.body), {
      status: hit.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe("quality gates", () => {
  it("blocks watermark-farm domains and their subdomains, including the Unsplash+ CDN", () => {
    expect(isBlockedImageUrl("https://images.shutterstock.com/a.jpg")).toBe(true);
    expect(isBlockedImageUrl("https://shutterstock.com/a.jpg")).toBe(true);
    expect(isBlockedImageUrl("https://plus.unsplash.com/premium_photo-1.jpg")).toBe(true);
    // The free tier is the whole point of keeping Unsplash — it must survive.
    expect(isBlockedImageUrl("https://images.unsplash.com/photo-1.jpg")).toBe(false);
  });

  it("does not block Pixabay's own image host — the authenticated API's images are not watermarked", () => {
    // pixabay.com used to be on this list from before this engine had an
    // authenticated Pixabay integration, when scraping its preview page was
    // the only way in. createPixabayProvider now uses the real API, and a
    // live response's `largeImageURL` is served from `pixabay.com` ITSELF
    // (verified 2026-08-24: https://pixabay.com/get/g49a8f...jpg), not a
    // `cdn.` subdomain — so the bare-host entry was what actually broke it.
    expect(isBlockedImageUrl("https://pixabay.com/get/g49a8f427d4bd_1280.jpg")).toBe(false);
    expect(isBlockedImageUrl("https://cdn.pixabay.com/photo/42/large.jpg")).toBe(false);
  });

  it("treats an unparseable URL as blocked rather than passing it to a rights gate", () => {
    expect(isBlockedImageUrl("not a url")).toBe(true);
  });

  it("reduces a human-written visualNeed to salient words, and ladders from precise to broad", () => {
    const need = "a close-up of an unplugged ethernet or power cable on a desk";
    expect(simplifyQuery(need, 3)).toBe("unplugged ethernet power");
    expect(broadeningVariants(need)).toEqual([need, "unplugged ethernet power", "unplugged ethernet"]);
  });

  it("collapses the ladder to one attempt when the query is already short", () => {
    expect(broadeningVariants("empty desk")).toEqual(["empty desk"]);
  });
});

describe("routing", () => {
  it("prefers geo-verified sources for a named venue and licence-clean ones for mood", () => {
    // AU51: google_places now leads named_venue — the vendor-backed UGC
    // sources that used to precede it were removed with the vendor.
    expect(ROUTE_CHAINS.named_venue[0]).toBe("google_places");
    expect(ROUTE_CHAINS.mood[0]).toBe("unsplash");

    // Unknown-provenance web search is now on every route but always LAST,
    // after every source whose licence the gate can actually clear. It was
    // excluded outright on measured evidence (11 candidates, 0 selected, prep
    // run pubsub-21535110633863323); including it became worth the cost once
    // providers were queried concurrently (a slow last place adds no serial
    // latency) and DDG started broadening its query like everything else. Its
    // candidates still lose the interleave to any better-licensed source, so
    // it only contributes where they came up short.
    for (const route of ["mood", "default"] as const) {
      expect(ROUTE_CHAINS[route].at(-1)).toBe("ddg_images");
    }

    // On named_venue it deliberately outranks the CC libraries: verification
    // beats licence for a specific real place, and a press photo of the right
    // venue is worth more than a perfectly-licensed photo of the wrong one.
    const venue = ROUTE_CHAINS.named_venue;
    expect(venue.indexOf("ddg_images")).toBeGreaterThan(venue.indexOf("google_places"));
    expect(venue.indexOf("ddg_images")).toBeLessThan(venue.indexOf("openverse"));
  });

  it("skips unconfigured providers, so a chain degrades to its keyless members", () => {
    const source = createImageSource(buildProviderRegistry({ env: {} }));
    // With no keys at all the chain is the three keyless providers, in
    // licence order with unknown-provenance web search last.
    expect(source.chainFor("mood").map((p) => p.name)).toEqual(["openverse", "wikimedia", "ddg_images"]);
  });

  it("puts Unsplash, Pexels and Pixabay at the head of the mood chain once their keys exist", () => {
    const source = createImageSource(
      buildProviderRegistry({ env: { UNSPLASH_ACCESS_KEY: "k", PEXELS_API_KEY: "k2", PIXABAY_API_KEY: "k3" } }),
    );
    expect(source.chainFor("mood").map((p) => p.name)).toEqual(["unsplash", "pexels", "pixabay", "openverse", "wikimedia", "ddg_images"]);
  });

  it("adds only the configured one of Pexels/Pixabay, leaving the other out of the chain", () => {
    const source = createImageSource(buildProviderRegistry({ env: { PEXELS_API_KEY: "k2" } }));
    expect(source.chainFor("default").map((p) => p.name)).toEqual(["pexels", "openverse", "wikimedia", "ddg_images"]);
  });

  it("never leaves an explicitly registered provider unreachable, even outside every built-in chain", () => {
    const custom: ImageSearchProvider = { name: "client_library", search: async () => [] };
    const registry = buildProviderRegistry({ env: {} });
    registry.set("client_library", custom);
    expect(createImageSource(registry).chainFor("default").map((p) => p.name)).toContain("client_library");
  });
});

describe("openverse provider", () => {
  it("maps a result to a per-asset CC licence with its creator, rated attributable", async () => {
    const { impl } = routedFetch([
      {
        match: "api.openverse.org",
        body: {
          results: [
            {
              id: "ov-1",
              url: "https://live.staticflickr.com/1/a.jpg",
              foreign_landing_url: "https://flickr.com/photos/x/1",
              title: "Empty desk",
              license: "by",
              license_version: "2.0",
              creator: "Jane Roe",
              source: "flickr",
            },
          ],
        },
      },
    ]);

    const hits = await createOpenverseProvider({ fetchImpl: impl }).search("empty desk", 3);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.licenseConfidence).toBe("attributable");
    expect(hits[0]!.license).toContain("CC BY 2.0");
    expect(hits[0]!.license).toContain("Jane Roe");
    expect(hits[0]!.pageUrl).toBe("https://flickr.com/photos/x/1");
  });

  it("asks only for commercially-licensed work, since the rights gate would refuse the rest", async () => {
    const { impl, seen } = routedFetch([{ match: "api.openverse.org", body: { results: [] } }]);
    await createOpenverseProvider({ fetchImpl: impl }).search("desk", 3);
    expect(seen[0]).toContain("license_type=commercial");
    expect(seen[0]).toContain("mature=false");
  });

  it("broadens the query when a precise one returns nothing, and stops at the first variant that hits", async () => {
    const queries: string[] = [];
    const impl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      const q = url.searchParams.get("q")!;
      queries.push(q);
      // Only the two-word variant has results.
      const results =
        q === "unplugged ethernet"
          ? [{ id: "1", url: "https://example.org/a.jpg", title: "cable", license: "cc0", creator: "A" }]
          : [];
      return new Response(JSON.stringify({ results }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const hits = await createOpenverseProvider({ fetchImpl: impl }).search(
      "a close-up of an unplugged ethernet or power cable on a desk",
      2,
    );

    expect(hits).toHaveLength(1);
    expect(queries).toHaveLength(3);
    expect(queries.at(-1)).toBe("unplugged ethernet");
  });

  it("drops a blocklisted result instead of handing it to the rights gate", async () => {
    const { impl } = routedFetch([
      {
        match: "api.openverse.org",
        body: { results: [{ id: "1", url: "https://images.shutterstock.com/x.jpg", title: "t", license: "by", creator: "c" }] },
      },
    ]);
    expect(await createOpenverseProvider({ fetchImpl: impl }).search("desk", 3)).toEqual([]);
  });
});

describe("pexels provider", () => {
  it("maps a photo to the no-attribution blanket licence, rated blanket like Unsplash", async () => {
    const { impl } = routedFetch([
      {
        match: "api.pexels.com",
        body: {
          photos: [
            {
              id: 1,
              url: "https://www.pexels.com/photo/1",
              photographer: "Jane Roe",
              alt: "Empty desk",
              src: { large2x: "https://images.pexels.com/photos/1/pexels-photo-1.jpeg" },
            },
          ],
        },
      },
    ]);

    const hits = await createPexelsProvider({ apiKey: "k", fetchImpl: impl }).search("empty desk", 3);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.licenseConfidence).toBe("blanket");
    expect(hits[0]!.license).toContain("Pexels License");
    expect(hits[0]!.description).toContain("Jane Roe");
    expect(hits[0]!.pageUrl).toBe("https://www.pexels.com/photo/1");
  });

  it("sends the raw key with no Bearer prefix, since that's what the Pexels API expects", async () => {
    let seenAuth: string | null = null;
    const impl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenAuth = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? null;
      return new Response(JSON.stringify({ photos: [] }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    await createPexelsProvider({ apiKey: "my-key", fetchImpl: impl }).search("desk", 3);
    expect(seenAuth).toBe("my-key");
  });

  it("drops a blocklisted result instead of handing it to the rights gate", async () => {
    const { impl } = routedFetch([
      {
        match: "api.pexels.com",
        body: { photos: [{ id: 1, photographer: "c", src: { large2x: "https://images.shutterstock.com/x.jpg" } }] },
      },
    ]);
    expect(await createPexelsProvider({ apiKey: "k", fetchImpl: impl }).search("desk", 3)).toEqual([]);
  });
});

describe("pixabay provider", () => {
  it("maps a hit to the no-attribution blanket licence", async () => {
    const { impl } = routedFetch([
      {
        match: "pixabay.com",
        body: {
          hits: [
            {
              id: 42,
              tags: "desk, office, empty",
              pageURL: "https://pixabay.com/photos/desk-42/",
              // The real host a live `largeImageURL` uses, not a `cdn.` one.
              largeImageURL: "https://pixabay.com/get/g49a8f427d4bd_1280.jpg",
              user: "Jane Roe",
            },
          ],
        },
      },
    ]);

    const hits = await createPixabayProvider({ apiKey: "k", fetchImpl: impl }).search("empty desk", 3);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.licenseConfidence).toBe("blanket");
    expect(hits[0]!.license).toContain("Pixabay Content License");
    expect(hits[0]!.description).toContain("desk, office, empty");
    expect(hits[0]!.pageUrl).toBe("https://pixabay.com/photos/desk-42/");
  });

  // Live responses carry all three of these; the fakes above would never have
  // caught any of them.
  it("dedupes Pixabay's heavily-repeated tag string instead of feeding it to the gate verbatim", async () => {
    const { impl } = routedFetch([
      {
        match: "pixabay.com",
        body: {
          hits: [
            {
              id: 1,
              // The real shape: a live response repeated "writing" five times.
              tags: "journal, write, notebook, writing, writing, writing, Journal",
              largeImageURL: "https://pixabay.com/get/a.jpg",
              user: "u",
            },
          ],
        },
      },
    ]);

    const hits = await createPixabayProvider({ apiKey: "k", fetchImpl: impl }).search("journal", 1);
    expect(hits[0]!.description).toContain("journal, write, notebook, writing");
    // Case-insensitively deduped, so "Journal" does not return as a second entry.
    expect(hits[0]!.description).not.toMatch(/writing, writing/);
  });

  it("keeps a numeric Pixabay username as the credit rather than dropping it to 'unknown'", async () => {
    const { impl } = routedFetch([
      // A live response really did return `user: 6689062`.
      { match: "pixabay.com", body: { hits: [{ id: 1, tags: "t", largeImageURL: "https://pixabay.com/get/a.jpg", user: 6689062 }] } },
    ]);
    const hits = await createPixabayProvider({ apiKey: "k", fetchImpl: impl }).search("t", 1);
    expect(hits[0]!.credit).toBe("6689062");
  });

  it("skips a hit Pixabay itself flags low-quality, and discloses one it flags AI-generated", async () => {
    const { impl } = routedFetch([
      {
        match: "pixabay.com",
        body: {
          hits: [
            { id: 1, tags: "bad", largeImageURL: "https://pixabay.com/get/bad.jpg", user: "u", isLowQuality: true },
            { id: 2, tags: "synthetic", largeImageURL: "https://pixabay.com/get/ai.jpg", user: "u", isAiGenerated: true },
          ],
        },
      },
    ]);

    const hits = await createPixabayProvider({ apiKey: "k", fetchImpl: impl }).search("x", 5);
    expect(hits).toHaveLength(1);
    // The rights gate reads this line; AI-generated stock is a different
    // provenance question from a photograph even under the same licence.
    expect(hits[0]!.description).toContain("AI-generated stock image");
  });

  it("clamps a below-minimum per_page request up to Pixabay's floor of 3", async () => {
    const { impl, seen } = routedFetch([{ match: "pixabay.com", body: { hits: [] } }]);
    await createPixabayProvider({ apiKey: "k", fetchImpl: impl }).search("desk", 1);
    expect(new URL(seen[0]!).searchParams.get("per_page")).toBe("3");
  });

  it("drops a blocklisted result instead of handing it to the rights gate", async () => {
    const { impl } = routedFetch([
      { match: "pixabay.com", body: { hits: [{ id: 1, user: "c", largeImageURL: "https://images.shutterstock.com/x.jpg" }] } },
    ]);
    expect(await createPixabayProvider({ apiKey: "k", fetchImpl: impl }).search("desk", 3)).toEqual([]);
  });
});

describe("wikimedia provider", () => {
  it("reads licence and artist out of extmetadata and strips its HTML", async () => {
    const { impl } = routedFetch([
      {
        match: "commons.wikimedia.org",
        body: {
          query: {
            pages: {
              "123": {
                title: "File:Server rack.jpg",
                imageinfo: [
                  {
                    url: "https://upload.wikimedia.org/a.jpg",
                    descriptionshorturl: "https://commons.wikimedia.org/w/index.php?curid=123",
                    extmetadata: {
                      LicenseShortName: { value: "CC BY-SA 4.0" },
                      Artist: { value: '<a href="/wiki/User:Bob">Bob</a>' },
                      ImageDescription: { value: "A <b>server rack</b> in a data centre" },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    ]);

    const hits = await createWikimediaProvider({ fetchImpl: impl }).search("server rack", 3);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.description).toBe("A server rack in a data centre (by Bob on Wikimedia Commons)");
    expect(hits[0]!.license).toContain("CC BY-SA 4.0");
    expect(hits[0]!.licenseConfidence).toBe("attributable");
  });

  it("falls back to a cleaned-up filename when the file carries no description", async () => {
    const { impl } = routedFetch([
      {
        match: "commons.wikimedia.org",
        body: {
          query: {
            pages: { "1": { title: "File:Cable_run.jpg", imageinfo: [{ url: "https://upload.wikimedia.org/c.jpg" }] } },
          },
        },
      },
    ]);
    const hits = await createWikimediaProvider({ fetchImpl: impl }).search("cable", 1);
    expect(hits[0]!.description).toContain("Cable_run");
  });
});

describe("google places provider", () => {
  it("builds a photo URL from the top candidate only, and carries the attribution", async () => {
    const { impl } = routedFetch([
      {
        match: "findplacefromtext",
        body: {
          candidates: [
            { place_id: "P1", photos: [{ photo_reference: "REF1", html_attributions: ['<a href="x">Ann</a>'] }] },
            { place_id: "P2", photos: [{ photo_reference: "REF2" }] },
          ],
        },
      },
    ]);

    const hits = await createGooglePlacesProvider({ apiKey: "K", fetchImpl: impl }).search("Blue Bottle Ferry", 3);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.url).toContain("photo_reference=REF1");
    expect(hits[0]!.credit).toBe("Ann");
    expect(hits[0]!.licenseConfidence).toBe("blanket");
    // The id must not leak the API key that the download URL necessarily carries.
    expect(hits[0]!.id).not.toContain("K");
  });

  it("returns nothing rather than failing the run when the lookup misses", async () => {
    const { impl } = routedFetch([{ match: "findplacefromtext", body: {}, status: 500 }]);
    expect(await createGooglePlacesProvider({ apiKey: "K", fetchImpl: impl }).search("nowhere", 3)).toEqual([]);
  });
});

describe("ddg images provider", () => {
  it("labels every hit as unestablished provenance so the rights gate stays sceptical", async () => {
    const impl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("/i.js")) {
        return new Response(JSON.stringify({ results: [{ image: "https://blog.example.com/a.jpg", title: "T", source: "blog" }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response('<script>vqd="3-123"</script>', { headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;

    const hits = await createDdgImagesProvider({ fetchImpl: impl }).search("some venue", 3);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.licenseConfidence).toBe("unknown");
    expect(hits[0]!.license).toContain("UNKNOWN");
  });

  it("returns empty rather than throwing when the token scrape breaks", async () => {
    const impl = (async () => new Response("<html>no token here</html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    // A broken last-resort provider must never fail a run the sources above it could satisfy.
    expect(await createDdgImagesProvider({ fetchImpl: impl }).search("x", 3)).toEqual([]);
  });
});

describe("chain fallback in media.findImages", () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "karos-media-chain-"));
  });
  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  const jpeg = (async () => new Response(Buffer.alloc(64, 1), { status: 200, headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;

  const hit = (id: string): ImageSearchHit => ({
    id,
    url: `https://example.org/${id}.jpg`,
    description: `d-${id}`,
    license: "L",
    credit: "c",
  });

  const run = (
    chain: ImageSearchProvider[],
    needs: Array<{ n: number; query: string }>,
    extra: Record<string, unknown> = {},
  ) =>
    createKarosMediaTools({
      source: { chainFor: () => chain, available: chain.map((p) => p.name) },
      fetchImpl: jpeg,
    })["media.findImages"]!.execute({ repoRoot, runId: "r1", needs, ...extra }, { ctx: {} as never });

  const broken = (name: string): ImageSearchProvider => ({
    name,
    search: async () => {
      throw new ImageProviderError(`${name}: 503`);
    },
  });

  it("falls through a failing provider to a healthy one and records who answered", async () => {
    const healthy: ImageSearchProvider = { name: "healthy", search: async () => [hit("a")] };

    const outcome = await run([broken("broken"), healthy], [{ n: 1, query: "x" }]);

    // The outage was absorbed by the fallback, so it is correctly forgotten.
    expect(outcome.status).toBe("success");
    const result = (outcome as { result: { providersUsed: string[]; candidates: Array<{ provider: string }> } }).result;
    expect(result.providersUsed).toEqual(["healthy"]);
    expect(result.candidates[0]!.provider).toBe("healthy");
  });

  // The reversal of the original "first provider wins" rule. prep run
  // pubsub-20632239329452475 is the evidence: Unsplash answered every generic
  // query, took all 18 slots, and openverse/wikimedia were never asked — then
  // the gate rejected 5 of 6 slides for subject mismatch, which a different
  // source might well have satisfied.
  it("merges candidates from every provider instead of stopping at the first that delivers", async () => {
    let secondCalled = false;
    const first: ImageSearchProvider = { name: "first", search: async () => [hit("a")] };
    const second: ImageSearchProvider = {
      name: "second",
      search: async () => {
        secondCalled = true;
        return [hit("b")];
      },
    };

    const outcome = await run([first, second], [{ n: 1, query: "x" }]);

    expect(secondCalled).toBe(true);
    const result = (outcome as { result: { candidates: Array<{ provider: string }>; providersUsed: string[] } }).result;
    expect(result.candidates).toHaveLength(2);
    expect(result.providersUsed).toEqual(["first", "second"]);
  });

  it("interleaves round-robin, so a small budget buys breadth rather than one provider's tail", async () => {
    const deep: ImageSearchProvider = { name: "deep", search: async () => [hit("d1"), hit("d2"), hit("d3")] };
    const shallow: ImageSearchProvider = { name: "shallow", search: async () => [hit("s1")] };

    const outcome = await run([deep, shallow], [{ n: 1, query: "x" }], { maxPerNeed: 2 });

    const providers = (outcome as { result: { candidates: Array<{ provider: string }> } }).result.candidates.map(
      (c) => c.provider,
    );
    // Not ["deep","deep"] — the shallow provider gets its pick before the
    // deep one gets a second.
    expect(providers).toEqual(["deep", "shallow"]);
  });

  it("honours maxPerNeed as a hard ceiling on the merged pool", async () => {
    const wide = (name: string): ImageSearchProvider => ({
      name,
      search: async () => [hit(`${name}1`), hit(`${name}2`), hit(`${name}3`)],
    });

    const outcome = await run([wide("a"), wide("b"), wide("c")], [{ n: 1, query: "x" }], { maxPerNeed: 4 });

    expect((outcome as { result: { candidates: unknown[] } }).result.candidates).toHaveLength(4);
  });

  it("keeps chain order as the tie-break within each round", async () => {
    const a: ImageSearchProvider = { name: "a", search: async () => [hit("a1"), hit("a2")] };
    const b: ImageSearchProvider = { name: "b", search: async () => [hit("b1"), hit("b2")] };

    const outcome = await run([a, b], [{ n: 1, query: "x" }], { maxPerNeed: 4 });

    const providers = (outcome as { result: { candidates: Array<{ provider: string }> } }).result.candidates.map(
      (c) => c.provider,
    );
    expect(providers).toEqual(["a", "b", "a", "b"]);
  });

  it("deduplicates the same image URL surfacing from two providers", async () => {
    // Openverse aggregates Wikimedia, so this is a real overlap, not a
    // hypothetical. One image must not consume two slots of the budget.
    const shared = hit("same");
    const p1: ImageSearchProvider = { name: "p1", search: async () => [shared] };
    const p2: ImageSearchProvider = { name: "p2", search: async () => [shared, hit("unique")] };

    const outcome = await run([p1, p2], [{ n: 1, query: "x" }]);

    const result = (outcome as { result: { candidates: Array<{ provider: string }> } }).result;
    expect(result.candidates).toHaveLength(2);
    // The first provider to offer it keeps it.
    expect(result.candidates.map((c) => c.provider).sort()).toEqual(["p1", "p2"]);
  });

  it("still fills a need from the survivors when one provider in the middle breaks", async () => {
    const healthy: ImageSearchProvider = { name: "healthy", search: async () => [hit("h")] };

    const outcome = await run([healthy, broken("mid"), { name: "last", search: async () => [hit("l")] }], [
      { n: 1, query: "x" },
    ]);

    expect(outcome.status).toBe("success");
    const result = (outcome as { result: { providersUsed: string[] } }).result;
    expect(result.providersUsed).toEqual(["healthy", "last"]);
  });

  it("reports an unrecovered outage as tooling_error, naming every provider that failed", async () => {
    const outcome = await run([broken("alpha"), broken("beta")], [{ n: 1, query: "x" }]);

    expect(outcome.status).toBe("tooling_error");
    const reason = (outcome as { reason: string }).reason;
    expect(reason).toContain("alpha: 503");
    expect(reason).toContain("beta: 503");
  });

  it("content-fails, naming what the chain tried, when every provider honestly has nothing", async () => {
    const empty = (name: string): ImageSearchProvider => ({ name, search: async () => [] });

    const outcome = await run([empty("openverse"), empty("wikimedia")], [{ n: 1, query: "x" }]);

    expect(outcome.status).toBe("content_fail");
    const reason = (outcome as { reason: string }).reason;
    // This string is what reaches the hold reason, and is the fix for a hold
    // that used to say only "no candidate qualified".
    expect(reason).toContain("openverse: no results");
    expect(reason).toContain("wikimedia: no results");
  });

  it("treats an outage on one slide as tooling even when other slides were filled", async () => {
    // Any unfilled slide holds the whole post downstream, so a partially
    // successful call whose gap came from a broken provider must not be
    // reported as an editorial outcome.
    const flaky: ImageSearchProvider = {
      name: "flaky",
      search: async (query) => {
        if (query === "bad") throw new ImageProviderError("flaky: 503");
        return [hit(query)];
      },
    };

    const outcome = await run([flaky], [
      { n: 1, query: "good" },
      { n: 2, query: "bad" },
    ]);

    expect(outcome.status).toBe("tooling_error");
    expect((outcome as { reason: string }).reason).toContain("slide 2");
  });
});

/**
 * Query broadening on EVERY provider, not just the strict CC libraries.
 *
 * prep run pubsub-21545408480430711 is why: its slides carried needs like "a
 * bar chart printed on paper lying flat on a desk, a person's hand pointing at
 * the page, no legible axis labels", and Unsplash answered with "Xin Jin Ping
 * Mei (2013)", "a street kiosk in Sweden" and "(King) George of the Jungle".
 * A big keyword index does not return NOTHING for a 20-word query — it returns
 * near-arbitrary matches, which is worse, because the gate pays tokens to
 * reject each one and the slide falls through to generation anyway. That run
 * filled 12 of 24 slide-slots from the generative tier while retrieval had
 * supplied 37 to 47 candidates it could not use.
 */
describe("query broadening is applied by every provider", () => {
  const NEED = "a bar chart printed on paper lying flat on a desk, a person's hand pointing at the page, no legible axis labels";

  /** Records every query a provider actually sent, answering only the shortest variant. */
  function ladderFetch(hitOn: (q: string) => boolean, body: (q: string) => unknown) {
    const queries: string[] = [];
    const impl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      const q = url.searchParams.get("query") ?? url.searchParams.get("q") ?? "";
      queries.push(q);
      return new Response(JSON.stringify(hitOn(q) ? body(q) : emptyFor(url)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { impl, queries };
  }

  function emptyFor(url: URL): unknown {
    if (url.hostname.includes("pexels")) return { photos: [] };
    if (url.hostname.includes("pixabay")) return { hits: [] };
    return { results: [] };
  }

  it("unsplash walks the ladder and stops at the variant that hits", async () => {
    const two = simplifyQuery(NEED, 2);
    const { impl, queries } = ladderFetch(
      (q) => q === two,
      () => ({ results: [{ id: "u1", urls: { regular: "https://images.unsplash.com/a.jpg" }, user: { name: "A" }, alt_description: "a bar chart" }] }),
    );

    const hits = await createUnsplashProvider({ accessKey: "k", fetchImpl: impl }).search(NEED, 3);

    expect(hits).toHaveLength(1);
    // Full text first (most precise), then progressively broader.
    expect(queries[0]).toBe(NEED);
    expect(queries.at(-1)).toBe(two);
    expect(queries.length).toBeGreaterThan(1);
  });

  it("pexels walks the ladder too", async () => {
    const two = simplifyQuery(NEED, 2);
    const { impl, queries } = ladderFetch(
      (q) => q === two,
      () => ({ photos: [{ id: 1, photographer: "A", alt: "a bar chart", src: { large2x: "https://images.pexels.com/a.jpg" } }] }),
    );
    const hits = await createPexelsProvider({ apiKey: "k", fetchImpl: impl }).search(NEED, 3);
    expect(hits).toHaveLength(1);
    expect(queries[0]).toBe(NEED);
    expect(queries.at(-1)).toBe(two);
  });

  it("pixabay walks the ladder too", async () => {
    const two = simplifyQuery(NEED, 2);
    const { impl, queries } = ladderFetch(
      (q) => q === two,
      () => ({ hits: [{ id: 1, user: "A", tags: "chart, desk", largeImageURL: "https://pixabay.com/get/a.jpg" }] }),
    );
    const hits = await createPixabayProvider({ apiKey: "k", fetchImpl: impl }).search(NEED, 3);
    expect(hits).toHaveLength(1);
    expect(queries[0]).toBe(NEED);
    expect(queries.at(-1)).toBe(two);
  });

  it("stops at the FIRST variant that hits, so a precise query is never needlessly broadened away", async () => {
    const { impl, queries } = ladderFetch(
      () => true, // the full query already answers
      () => ({ results: [{ id: "u1", urls: { regular: "https://images.unsplash.com/a.jpg" }, user: { name: "A" }, alt_description: "d" }] }),
    );
    await createUnsplashProvider({ accessKey: "k", fetchImpl: impl }).search(NEED, 3);
    expect(queries).toEqual([NEED]);
  });

  // The chain must still be able to tell an outage from an honestly-empty
  // answer: a demoted provider is absorbed, a broken one is reported.
  it("reports an outage when EVERY variant errors, rather than reading as 'no results'", async () => {
    const impl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(createUnsplashProvider({ accessKey: "k", fetchImpl: impl }).search(NEED, 3)).rejects.toThrow(ImageProviderError);
  });
});

/**
 * The merge pool is filled from EVERY provider in the chain, asked
 * CONCURRENTLY, with no source skipped or short-circuited.
 *
 * Two separate guarantees that are easy to conflate:
 *
 * 1. Across providers there is no short-circuit — the chain is a ranking
 *    order, not a stop condition. A provider answering does not stop the
 *    others being asked.
 * 2. Within one provider the broadening ladder DOES stop at the first variant
 *    that hits, which is not a skipped source: it is that provider declining
 *    to ask a broader, worse question once a precise one worked.
 */
describe("the sourcing tier queries every provider concurrently", () => {
  // Its own scratch root: `createFindImages` writes downloaded bytes under it,
  // and these tests assert on which provider a saved candidate came from.
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "karos-concurrent-"));
  });
  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  /** A provider that records when it started/finished and resolves after `delayMs`. */
  function timedProvider(name: string, delayMs: number, hits: number, log: string[]): ImageSearchProvider {
    return {
      name,
      async search(): Promise<ImageSearchHit[]> {
        log.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, delayMs));
        log.push(`end:${name}`);
        return Array.from({ length: hits }, (_, i) => ({
          id: `${name}-${i}`,
          url: `https://example.org/${name}-${i}.jpg`,
          description: `${name} hit ${i}`,
          license: "CC0",
          licenseConfidence: "blanket" as const,
          credit: name,
        }));
      },
    };
  }

  it("starts every provider before any has finished, and merges all of them", async () => {
    const log: string[] = [];
    const providers = [
      timedProvider("alpha", 40, 2, log),
      timedProvider("beta", 20, 2, log),
      timedProvider("gamma", 10, 2, log),
    ];
    const source = { chainFor: () => providers, available: providers.map((p) => p.name) };

    // A fetch that returns a real 1x1 PNG for every download.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const fetchImpl = (async () =>
      new Response(png, { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch;

    const outcome = await createFindImages(source, fetchImpl).execute(
      { repoRoot, runId: "concurrent", needs: [{ n: 1, query: "an empty desk at dawn" }], perNeed: 2, maxPerNeed: 6 },
      { ctx: { runId: "concurrent", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} } as never },
    );

    expect(outcome.status).toBe("success");
    const result = (outcome as { result: { candidates: Array<{ provider: string }>; providersUsed: string[] } }).result;

    // Every provider contributed — no source skipped once an earlier one answered.
    expect(result.providersUsed.sort()).toEqual(["alpha", "beta", "gamma"]);

    // Concurrency: all three STARTED before the first one ENDED. Sequentially
    // the log would read start,end,start,end,start,end.
    const firstEnd = log.indexOf(log.find((l) => l.startsWith("end:"))!);
    const startsBeforeFirstEnd = log.slice(0, firstEnd).filter((l) => l.startsWith("start:")).length;
    expect(startsBeforeFirstEnd).toBe(3);
  });

  it("keeps chain order for dedup precedence even though the slowest provider answers last", async () => {
    const log: string[] = [];
    // `first` is slowest but earliest in the chain, and both offer the SAME
    // url. Chain order must decide who keeps it, not who replied first.
    const shared = "https://example.org/shared.jpg";
    const dup = (name: string, delayMs: number): ImageSearchProvider => ({
      name,
      async search() {
        log.push(name);
        await new Promise((r) => setTimeout(r, delayMs));
        return [
          {
            id: `${name}-shared`,
            url: shared,
            description: `${name} shared`,
            license: "CC0",
            licenseConfidence: "blanket" as const,
            credit: name,
          },
        ];
      },
    });
    const providers = [dup("first", 30), dup("second", 5)];
    const source = { chainFor: () => providers, available: ["first", "second"] };

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const fetchImpl = (async () =>
      new Response(png, { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch;

    const outcome = await createFindImages(source, fetchImpl).execute(
      { repoRoot, runId: "dedup", needs: [{ n: 1, query: "a desk" }], perNeed: 1, maxPerNeed: 4 },
      { ctx: { runId: "dedup", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} } as never },
    );

    const result = (outcome as { result: { candidates: Array<{ provider: string }> } }).result;
    // One candidate (deduped), attributed to the EARLIER chain member.
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.provider).toBe("first");
  });

  it("absorbs one provider's outage without discarding the healthy ones", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const fetchImpl = (async () =>
      new Response(png, { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch;

    const broken: ImageSearchProvider = {
      name: "broken",
      async search(): Promise<ImageSearchHit[]> {
        throw new ImageProviderError("broken returned 503");
      },
    };
    const healthy: ImageSearchProvider = {
      name: "healthy",
      async search(): Promise<ImageSearchHit[]> {
        return [
          {
            id: "h1",
            url: "https://example.org/h1.jpg",
            description: "a desk",
            license: "CC0",
            licenseConfidence: "blanket",
            credit: "h",
          },
        ];
      },
    };
    const source = { chainFor: () => [broken, healthy], available: ["broken", "healthy"] };

    const outcome = await createFindImages(source, fetchImpl).execute(
      { repoRoot, runId: "outage", needs: [{ n: 1, query: "a desk" }], perNeed: 1, maxPerNeed: 4 },
      { ctx: { runId: "outage", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} } as never },
    );

    // The healthy provider still filled the slide, so the run proceeds.
    expect(outcome.status).toBe("success");
    const result = (outcome as { result: { candidates: Array<{ provider: string }> } }).result;
    expect(result.candidates.map((c) => c.provider)).toEqual(["healthy"]);
  });
});
