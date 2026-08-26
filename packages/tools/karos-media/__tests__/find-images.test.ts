import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildProviderRegistry,
  createKarosMediaTools,
  createUnsplashProvider,
  ImageProviderError,
  type ImageSearchHit,
} from "../src/index.js";

const CTX = { runId: "run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" } as never;

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "karos-media-"));
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

function jpeg(bytes = 64): Response {
  return new Response(Buffer.alloc(bytes, 1), {
    status: 200,
    headers: { "content-type": "image/jpeg" },
  });
}

function fakeProvider(hits: ImageSearchHit[], onSearch?: (q: string) => void) {
  return {
    name: "fake",
    async search(query: string, limit: number) {
      onSearch?.(query);
      return hits.slice(0, limit);
    },
  };
}

const HIT: ImageSearchHit = {
  id: "abc123",
  url: "https://images.example/abc123.jpg",
  description: "a flat white on a walnut counter",
  license: "Unsplash License — free for commercial use, no attribution required",
  credit: "Dana",
};

describe("media.findImages", () => {
  it("downloads candidates and returns repo-relative paths that exist on disk", async () => {
    const tools = createKarosMediaTools({ provider: fakeProvider([HIT]), fetchImpl: async () => jpeg() });

    const outcome = await tools["media.findImages"]!.execute(
      { repoRoot, runId: "run_1", perNeed: 1, needs: [{ n: 1, query: "coffee" }] },
      { ctx: CTX },
    );

    expect(outcome.status).toBe("success");
    const result = (outcome as { result: { candidates: { path: string; description: string }[] } }).result;
    expect(result.candidates).toHaveLength(1);

    const rel = result.candidates[0]!.path;
    expect(path.isAbsolute(rel)).toBe(false);
    expect(rel.startsWith(".media-cache/run_1/")).toBe(true);
    // The renderer reads these off disk; a path that does not resolve to real
    // bytes is the failure this whole tool exists to prevent.
    await expect(fs.stat(path.resolve(repoRoot, rel))).resolves.toBeTruthy();
  });

  it("carries the licence into the description, which is all the vetting agent sees", async () => {
    const tools = createKarosMediaTools({ provider: fakeProvider([HIT]), fetchImpl: async () => jpeg() });

    const outcome = await tools["media.findImages"]!.execute(
      { repoRoot, runId: "run_1", needs: [{ n: 2, query: "coffee" }] },
      { ctx: CTX },
    );

    const { candidates } = (outcome as { result: { candidates: { description: string }[] } }).result;
    // Step 06 must record a real `license` per selection and holds the post
    // when it cannot justify one. If the licence never reaches the prompt the
    // agent can only guess, so this is a contract, not a formatting detail.
    expect(candidates[0]!.description).toContain("Unsplash License");
    expect(candidates[0]!.description).toContain("slide 2");
  });

  it("reports unmet needs instead of silently returning a thinner pool", async () => {
    const provider = {
      name: "fake",
      async search(query: string) {
        return query === "findable" ? [HIT] : [];
      },
    };
    const tools = createKarosMediaTools({ provider, fetchImpl: async () => jpeg() });

    const outcome = await tools["media.findImages"]!.execute(
      {
        repoRoot,
        runId: "run_1",
        needs: [
          { n: 1, query: "findable" },
          { n: 2, query: "nothing matches this" },
        ],
      },
      { ctx: CTX },
    );

    const result = (outcome as { result: { candidates: unknown[]; unmet: { n: number }[] } }).result;
    expect(result.candidates).toHaveLength(1);
    expect(result.unmet.map((u) => u.n)).toEqual([2]);
  });

  it("content-fails when nothing at all could be sourced, so the caller gets a reason not an empty pool", async () => {
    const tools = createKarosMediaTools({ provider: fakeProvider([]), fetchImpl: async () => jpeg() });

    const outcome = await tools["media.findImages"]!.execute(
      { repoRoot, runId: "run_1", needs: [{ n: 1, query: "x" }] },
      { ctx: CTX },
    );

    expect(outcome.status).toBe("content_fail");
    expect((outcome as { reason: string }).reason).toContain("no candidate images");
  });

  it("surfaces a provider outage as tooling_error, never as an editorial hold", async () => {
    const provider = {
      name: "fake",
      async search(): Promise<ImageSearchHit[]> {
        throw new ImageProviderError("unsplash search for \"x\" returned 503");
      },
    };
    const tools = createKarosMediaTools({ provider, fetchImpl: async () => jpeg() });

    const outcome = await tools["media.findImages"]!.execute(
      { repoRoot, runId: "run_1", needs: [{ n: 1, query: "x" }] },
      { ctx: CTX },
    );

    // The distinction matters: content_fail means "no image fits", which is a
    // real editorial answer a human should see. An outage is not that.
    expect(outcome.status).toBe("tooling_error");
    expect((outcome as { reason: string }).reason).toContain("503");
  });

  it("refuses a non-image response rather than saving an error page as .jpg", async () => {
    const tools = createKarosMediaTools({
      provider: fakeProvider([HIT]),
      fetchImpl: async () => new Response("<html>rate limited</html>", { status: 200, headers: { "content-type": "text/html" } }),
    });

    const outcome = await tools["media.findImages"]!.execute(
      { repoRoot, runId: "run_1", needs: [{ n: 1, query: "x" }] },
      { ctx: CTX },
    );

    expect(outcome.status).toBe("content_fail");
    await expect(fs.readdir(path.join(repoRoot, ".media-cache", "run_1"))).resolves.toEqual([]);
  });

  it("refuses an oversized image", async () => {
    const tools = createKarosMediaTools({
      provider: fakeProvider([HIT]),
      fetchImpl: async () =>
        new Response(Buffer.alloc(16 * 1024 * 1024, 1), { status: 200, headers: { "content-type": "image/jpeg" } }),
    });

    const outcome = await tools["media.findImages"]!.execute(
      { repoRoot, runId: "run_1", needs: [{ n: 1, query: "x" }] },
      { ctx: CTX },
    );

    expect(outcome.status).toBe("content_fail");
  });

  it("cannot be made to write outside repoRoot via runId", async () => {
    const tools = createKarosMediaTools({ provider: fakeProvider([HIT]), fetchImpl: async () => jpeg() });

    const outcome = await tools["media.findImages"]!.execute(
      { repoRoot, runId: "../../escaped", needs: [{ n: 1, query: "x" }] },
      { ctx: CTX },
    );

    expect(outcome.status).toBe("tooling_error");
    expect((outcome as { reason: string }).reason).toContain("escaped repoRoot");
  });

  it("namespaces by runId so two concurrent runs never collide", async () => {
    const tools = createKarosMediaTools({ provider: fakeProvider([HIT]), fetchImpl: async () => jpeg() });

    const a = await tools["media.findImages"]!.execute({ repoRoot, runId: "run_a", needs: [{ n: 1, query: "x" }] }, { ctx: CTX });
    const b = await tools["media.findImages"]!.execute({ repoRoot, runId: "run_b", needs: [{ n: 1, query: "x" }] }, { ctx: CTX });

    const pathA = (a as { result: { candidates: { path: string }[] } }).result.candidates[0]!.path;
    const pathB = (b as { result: { candidates: { path: string }[] } }).result.candidates[0]!.path;
    expect(pathA).not.toEqual(pathB);
  });
});

describe("createKarosMediaTools without a key", () => {
  // The behaviour this asserts is the point of the multi-source port. It used
  // to return `not_available` with no key, which is what held every prep
  // Instagram run while UNSPLASH_ACCESS_KEY sat unprovisioned — even though
  // three keyless providers were available in the legacy engine all along.
  it("still has a working keyless chain, and never reports not_available", async () => {
    // A stub transport, deliberately: this assertion is about the registry
    // having a backend without a key, not about the open internet. It used to
    // call openverse/wikimedia/ddg for real and timed out at 5s the moment the
    // network was slow, which made a behavioural guarantee look like a flake.
    const emptyJson = (async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const tools = createKarosMediaTools({ env: {}, fetchImpl: emptyJson });
    expect(tools["media.findImages"]).toBeDefined();

    const outcome = await tools["media.findImages"]!.execute(
      { repoRoot, runId: "run_1", needs: [{ n: 1, query: "x" }] },
      { ctx: CTX },
    );

    // The providers honestly found nothing, which is content. "This deployment
    // has no backend" is no longer one of the possible answers.
    expect(outcome.status).not.toBe("not_available");
    expect(outcome.status).toBe("content_fail");
  });

  it("builds the keyless providers with no env at all, and adds keyed ones only when their key is set", () => {
    expect([...buildProviderRegistry({ env: {} }).keys()]).toEqual(["openverse", "wikimedia", "ddg_images"]);

    const keyed = [...buildProviderRegistry({ env: { UNSPLASH_ACCESS_KEY: "k", GOOGLE_PLACES_KEY: "p" } }).keys()];
    expect(keyed).toContain("unsplash");
    expect(keyed).toContain("google_places");
  });

  it("reports not_available only for an explicitly empty source", async () => {
    const tools = createKarosMediaTools({ source: { chainFor: () => [], available: [] } });
    const outcome = await tools["media.findImages"]!.execute(
      { repoRoot, runId: "run_1", needs: [{ n: 1, query: "x" }] },
      { ctx: CTX },
    );

    expect(outcome.status).toBe("not_available");
  });
});

describe("unsplash provider", () => {
  it("sends the access key as a Client-ID and asks for landscape results", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const provider = createUnsplashProvider({
      accessKey: "KEY123",
      fetchImpl: async (input, init) => {
        seen = { url: String(input), headers: (init?.headers ?? {}) as Record<string, string> };
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    await provider.search("cold brew", 3);

    expect(seen?.headers.Authorization).toBe("Client-ID KEY123");
    expect(seen?.url).toContain("query=cold+brew");
    expect(seen?.url).toContain("orientation=landscape");
    expect(seen?.url).toContain("content_filter=high");
  });

  it("clamps per_page to Unsplash's maximum of 30 instead of sending a 400", async () => {
    let seen = "";
    const provider = createUnsplashProvider({
      accessKey: "K",
      fetchImpl: async (input) => {
        seen = String(input);
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    await provider.search("x", 500);

    expect(seen).toContain("per_page=30");
  });

  it("calls out a 403 as rate-limit-or-bad-key, since those need different fixes", async () => {
    const provider = createUnsplashProvider({
      accessKey: "K",
      fetchImpl: async () => new Response("nope", { status: 403 }),
    });

    await expect(provider.search("x", 1)).rejects.toThrow(/rate limit or invalid access key/);
  });

  it("falls back through description -> alt_description -> the query itself", async () => {
    const provider = createUnsplashProvider({
      accessKey: "K",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            results: [
              { id: "a", urls: { regular: "https://i/a.jpg" }, description: "authored caption", user: { name: "Dana" } },
              { id: "b", urls: { regular: "https://i/b.jpg" }, alt_description: "unsplash alt", user: { name: "Sam" } },
              { id: "c", urls: { regular: "https://i/c.jpg" }, user: { name: "Kim" } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const hits = await provider.search("latte art", 3);

    expect(hits[0]!.description).toContain("authored caption");
    expect(hits[1]!.description).toContain("unsplash alt");
    expect(hits[2]!.description).toContain('photo matching "latte art"');
    expect(hits[0]!.description).toContain("photo by Dana");
  });

  it("skips a malformed result rather than failing the whole search", async () => {
    const provider = createUnsplashProvider({
      accessKey: "K",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ results: [{ id: "a" }, { id: "b", urls: { regular: "https://i/b.jpg" }, user: { name: "Sam" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const hits = await provider.search("x", 5);

    expect(hits.map((h) => h.id)).toEqual(["b"]);
  });
});
