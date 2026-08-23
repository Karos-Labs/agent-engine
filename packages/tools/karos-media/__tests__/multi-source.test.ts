import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildProviderRegistry,
  createDdgImagesProvider,
  createGooglePlacesProvider,
  createImageSource,
  createKarosMediaTools,
  createOpenverseProvider,
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
    expect(ROUTE_CHAINS.named_venue[0]).toBe("apify_google_maps");
    expect(ROUTE_CHAINS.mood[0]).toBe("unsplash");

    // On mood/default, ranking is by licence defensibility, so unknown-
    // provenance web search comes dead last.
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
    expect(source.chainFor("mood").map((p) => p.name)).toEqual(["openverse", "wikimedia", "ddg_images"]);
  });

  it("puts Unsplash at the head of the mood chain once its key exists", () => {
    const source = createImageSource(buildProviderRegistry({ env: { UNSPLASH_ACCESS_KEY: "k" } }));
    expect(source.chainFor("mood").map((p) => p.name)).toEqual(["unsplash", "openverse", "wikimedia", "ddg_images"]);
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

  const run = (chain: ImageSearchProvider[], needs: Array<{ n: number; query: string }>) =>
    createKarosMediaTools({
      source: { chainFor: () => chain, available: chain.map((p) => p.name) },
      fetchImpl: jpeg,
    })["media.findImages"]!.execute({ repoRoot, runId: "r1", needs }, { ctx: {} as never });

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

  it("stops at the first provider that delivers, rather than merging the whole chain", async () => {
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

    expect(secondCalled).toBe(false);
    expect((outcome as { result: { candidates: unknown[] } }).result.candidates).toHaveLength(1);
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
