import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHarvestPodcast, createItunesPodcastProvider, parseItunesDuration, readFeedEpisodes, readItunesShows } from "../src/index.js";

/**
 * `media.harvestPodcast` — podcasts from the place podcasts actually live.
 *
 * `media.harvestVideo` finds an episode by searching YouTube, which is a
 * second-hand index of podcasts and is defended against exactly this kind of
 * automated download: prep run `pubsub-21908845348121079` found a real
 * podcast and was answered *"Sign in to confirm you're not a bot"*. A show's
 * own RSS feed has no such defence, because serving the audio to whoever asks
 * IS what a podcast feed is for.
 *
 * The load-bearing tests here are the ones about what this refuses. A feed is
 * an untrusted external boundary: it can hand back HTML where audio was
 * promised, an `<item>` with no enclosure, a single item that parses as an
 * object rather than an array, or a duration in three different notations.
 * Every one of those is a real shape, and none may become a downloaded file
 * that later fails inside `video.transcribe`.
 */

const CTX = { ctx: {} as never };

function feed(showTitle: string, items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${showTitle}</title>
    ${items}
  </channel>
</rss>`;
}

function item(opts: { title: string; url?: string; link?: string; duration?: string; pubDate?: string; type?: string }): string {
  return `<item>
      <title>${opts.title}</title>
      ${opts.link !== undefined ? `<link>${opts.link}</link>` : ""}
      ${opts.pubDate !== undefined ? `<pubDate>${opts.pubDate}</pubDate>` : ""}
      ${opts.duration !== undefined ? `<itunes:duration>${opts.duration}</itunes:duration>` : ""}
      ${opts.url !== undefined ? `<enclosure url="${opts.url}" type="${opts.type ?? "audio/mpeg"}" length="42"/>` : ""}
    </item>`;
}

describe("parseItunesDuration", () => {
  it("reads the three notations feeds actually use", () => {
    expect(parseItunesDuration("3753")).toBe(3753);
    expect(parseItunesDuration("62:33")).toBe(3753);
    expect(parseItunesDuration("1:02:33")).toBe(3753);
    expect(parseItunesDuration(3753)).toBe(3753);
  });

  it("returns undefined rather than a wrong number for anything else", () => {
    // `undefined` is meaningful downstream: an episode with no declared
    // duration is KEPT, where an episode with a bad one would be judged
    // against bounds it never stated.
    for (const bad of ["", "   ", "about an hour", "1:2:3:4", "-5", null, undefined, {}]) {
      expect(parseItunesDuration(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("readFeedEpisodes", () => {
  it("reads a normal feed, preferring the episode page over the audio URL for the credit", () => {
    const episodes = readFeedEpisodes(
      feed("Some Business Podcast", item({ title: "Ep 12 — why CFOs cut AI budgets", url: "https://cdn.example/ep12.mp3", link: "https://show.example/ep12", duration: "48:10", pubDate: "Wed, 17 Sep 2026 09:00:00 GMT" })),
      "fallback",
    );
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      title: "Ep 12 — why CFOs cut AI budgets",
      showTitle: "Some Business Podcast",
      mediaUrl: "https://cdn.example/ep12.mp3",
      sourceUrl: "https://show.example/ep12",
      durationSeconds: 2890,
    });
  });

  it("handles a feed with exactly ONE episode, which parses as an object and not an array", () => {
    // The single-item feed is the shape that breaks a naive `items.map`.
    const episodes = readFeedEpisodes(feed("Solo Show", item({ title: "The only episode", url: "https://cdn.example/only.mp3" })), "fallback");
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.title).toBe("The only episode");
  });

  it("drops an item with no enclosure, and one with no title", () => {
    // A `<item>` with no `<enclosure>` is a blog post in a podcast feed —
    // real, common, and nothing this tool can download.
    const episodes = readFeedEpisodes(
      feed("Mixed", [item({ title: "A written note with no audio" }), item({ title: "", url: "https://cdn.example/x.mp3" }), item({ title: "Real one", url: "https://cdn.example/real.mp3" })].join("\n")),
      "fallback",
    );
    expect(episodes.map((e) => e.title)).toEqual(["Real one"]);
  });

  it("refuses an enclosure that is not http(s)", () => {
    const episodes = readFeedEpisodes(feed("Odd", item({ title: "Local file", url: "file:///etc/passwd" })), "fallback");
    expect(episodes).toEqual([]);
  });

  it("falls back to the directory's show name when the channel has no title", () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>${item({ title: "Ep", url: "https://cdn.example/e.mp3" })}</channel></rss>`;
    expect(readFeedEpisodes(xml, "Name From The Directory")[0]!.showTitle).toBe("Name From The Directory");
  });

  it("returns nothing for input that is not an RSS document, instead of throwing", () => {
    // A feed URL that now serves a parking page reaches here as HTML. One bad
    // feed must cost that feed, never the search.
    for (const junk of ["<html><body>Domain for sale</body></html>", "not xml at all", "", "<rss><channel/></rss>"]) {
      expect(readFeedEpisodes(junk, "x"), junk.slice(0, 20)).toEqual([]);
    }
  });
});

describe("readItunesShows", () => {
  it("keeps only rows that carry both a name and a usable feed URL", () => {
    const shows = readItunesShows({
      results: [
        { collectionName: "Good Show", feedUrl: "https://feeds.example/good" },
        { collectionName: "No Feed" },
        { feedUrl: "https://feeds.example/nameless" },
        { collectionName: "Bad Scheme", feedUrl: "ftp://feeds.example/bad" },
        "not an object",
      ],
    });
    expect(shows).toEqual([{ collectionName: "Good Show", feedUrl: "https://feeds.example/good" }]);
  });

  it("is empty for a payload that is not a search result", () => {
    for (const junk of [null, undefined, {}, { results: "nope" }, []]) {
      expect(readItunesShows(junk)).toEqual([]);
    }
  });
});

/** Answers Apple's search, the feeds, and the audio download from canned maps. */
function fakeNetwork(opts: { shows?: unknown; feeds?: Record<string, string>; audio?: Record<string, { status?: number; type?: string; bytes?: Uint8Array }> }) {
  const fetched: string[] = [];
  const fetchImpl = (async (url: string) => {
    fetched.push(url);
    if (url.startsWith("https://itunes.apple.com/search")) {
      return { ok: true, status: 200, async json() { return opts.shows ?? { results: [] }; } } as unknown as Response;
    }
    const feed = opts.feeds?.[url];
    if (feed !== undefined) {
      return { ok: true, status: 200, async text() { return feed; } } as unknown as Response;
    }
    const audio = opts.audio?.[url];
    if (audio !== undefined) {
      const status = audio.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? (audio.type ?? "audio/mpeg") : null) },
        async arrayBuffer() { return (audio.bytes ?? new Uint8Array([1, 2, 3, 4])).buffer; },
      } as unknown as Response;
    }
    return { ok: false, status: 404, async text() { return ""; }, async json() { return {}; } } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, fetched };
}

const BASE = { minDurationSeconds: 90, maxDurationSeconds: 10_800, maxBytes: 5_000_000 };

describe("media.harvestPodcast", () => {
  it("finds an episode by topic, downloads it, and reports it as AUDIO", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "podcast-"));
    const net = fakeNetwork({
      shows: { results: [{ collectionName: "Margins", feedUrl: "https://feeds.example/margins" }] },
      feeds: {
        "https://feeds.example/margins": feed(
          "Margins",
          [
            item({ title: "Ep 11 — hiring", url: "https://cdn.example/11.mp3", duration: "40:00", pubDate: "Wed, 03 Sep 2026 09:00:00 GMT" }),
            item({ title: "Ep 12 — why CFOs cut AI budgets", url: "https://cdn.example/12.mp3", duration: "48:10", pubDate: "Wed, 17 Sep 2026 09:00:00 GMT" }),
          ].join("\n"),
        ),
      },
      audio: { "https://cdn.example/12.mp3": {} },
    });
    const tool = createHarvestPodcast({ provider: createItunesPodcastProvider({ fetchImpl: net.fetchImpl }), fetchImpl: net.fetchImpl });
    const outcome = await tool.execute({ ...BASE, repoRoot: dir, runId: "run-1", query: "cfo ai budgets", allowedShows: [], discovery: "open" } as never, CTX);

    expect(outcome.status).toBe("success");
    const result = (outcome as { result: { path: string; media: string; showTitle: string; title: string } }).result;
    // Ranked on TOPIC first: ep 12 shares "cfo"/"budgets" with the query and
    // ep 11 shares nothing, even though both are recent.
    expect(result.title).toContain("Ep 12");
    expect(result.showTitle).toBe("Margins");
    expect(result.media).toBe("audio");
    await expect(fs.stat(path.join(dir, result.path))).resolves.toBeTruthy();
  });

  it("searches the SHOW, not the topic, under the allowlist posture", async () => {
    // The pool names what may be clipped. Asking the directory for the topic
    // instead would return shows the client has no rights to and then discard
    // every one of them.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "podcast-"));
    const net = fakeNetwork({
      shows: { results: [{ collectionName: "Lenny's Podcast | Product | Growth", feedUrl: "https://feeds.example/lenny" }] },
      feeds: { "https://feeds.example/lenny": feed("Lenny's Podcast", item({ title: "On pricing", url: "https://cdn.example/l.mp3", duration: "50:00" })) },
      audio: { "https://cdn.example/l.mp3": {} },
    });
    const tool = createHarvestPodcast({ provider: createItunesPodcastProvider({ fetchImpl: net.fetchImpl }), fetchImpl: net.fetchImpl });
    const outcome = await tool.execute(
      { ...BASE, repoRoot: dir, runId: "run-2", query: "how to price a product", allowedShows: ["Lenny's Podcast"], discovery: "allowlist" } as never,
      CTX,
    );

    expect(outcome.status).toBe("success");
    const search = net.fetched.find((u) => u.startsWith("https://itunes.apple.com"))!;
    expect(decodeURIComponent(search)).toContain("Lenny's Podcast");
    expect(decodeURIComponent(search)).not.toContain("how to price");
  });

  it("refuses under the allowlist posture with no shows, without searching anything", async () => {
    // The same rule the video harvest follows: "found something on topic" is
    // not a rights basis. Asserted by the ABSENCE of a fetch, because a
    // provider that searched and then discarded would also return empty.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "podcast-"));
    const net = fakeNetwork({});
    const tool = createHarvestPodcast({ provider: createItunesPodcastProvider({ fetchImpl: net.fetchImpl }), fetchImpl: net.fetchImpl });
    const outcome = await tool.execute({ ...BASE, repoRoot: dir, runId: "run-3", query: "anything at all", allowedShows: [], discovery: "allowlist" } as never, CTX);

    expect(outcome.status).toBe("content_fail");
    expect(net.fetched).toEqual([]);
    // …and it says WHY, which is the part that is actually load-bearing.
    // Deleting the early refusal leaves an empty `allowedShows` producing an
    // empty search loop, so "nothing was fetched" stays true by accident and
    // an assertion that stopped there would pass for a tool that no longer
    // refuses anything. What changes is the sentence: without the refusal the
    // reason claims Apple's directory matched nothing, which says a search
    // ran and came back empty — a different, and false, story.
    expect((outcome as { reason: string }).reason).toContain("no shows on the client's sourcePool");
    expect((outcome as { reason: string }).reason).not.toContain("Apple's directory");
  });

  it("keeps an episode that declares NO duration", async () => {
    // Unlike a YouTube entry, which cannot be proven not to be a Short. A
    // podcast episode is a podcast episode; the byte cap is the real guard.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "podcast-"));
    const net = fakeNetwork({
      shows: { results: [{ collectionName: "S", feedUrl: "https://feeds.example/s" }] },
      feeds: { "https://feeds.example/s": feed("S", item({ title: "Undeclared", url: "https://cdn.example/u.mp3" })) },
      audio: { "https://cdn.example/u.mp3": {} },
    });
    const tool = createHarvestPodcast({ provider: createItunesPodcastProvider({ fetchImpl: net.fetchImpl }), fetchImpl: net.fetchImpl });
    const outcome = await tool.execute({ ...BASE, repoRoot: dir, runId: "run-4", query: "marketing budgets", allowedShows: [], discovery: "open" } as never, CTX);
    expect(outcome.status).toBe("success");
  });

  it("drops an episode outside the duration bounds", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "podcast-"));
    const net = fakeNetwork({
      shows: { results: [{ collectionName: "S", feedUrl: "https://feeds.example/s" }] },
      feeds: { "https://feeds.example/s": feed("S", [item({ title: "Trailer", url: "https://cdn.example/t.mp3", duration: "0:45" }), item({ title: "Marathon", url: "https://cdn.example/m.mp3", duration: "9:00:00" })].join("\n")) },
    });
    const tool = createHarvestPodcast({ provider: createItunesPodcastProvider({ fetchImpl: net.fetchImpl }), fetchImpl: net.fetchImpl });
    const outcome = await tool.execute({ ...BASE, repoRoot: dir, runId: "run-5", query: "marketing budgets", allowedShows: [], discovery: "open" } as never, CTX);

    expect(outcome.status).toBe("content_fail");
    expect((outcome as { reason: string }).reason).toContain("outside 90-10800s");
  });

  it("moves to the next episode when the best one's enclosure will not serve", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "podcast-"));
    const net = fakeNetwork({
      shows: { results: [{ collectionName: "S", feedUrl: "https://feeds.example/s" }] },
      feeds: {
        "https://feeds.example/s": feed(
          "S",
          [item({ title: "budgets best", url: "https://cdn.example/a.mp3", duration: "40:00" }), item({ title: "budgets second", url: "https://cdn.example/b.mp3", duration: "40:00" })].join("\n"),
        ),
      },
      audio: { "https://cdn.example/a.mp3": { status: 403 }, "https://cdn.example/b.mp3": {} },
    });
    const tool = createHarvestPodcast({ provider: createItunesPodcastProvider({ fetchImpl: net.fetchImpl }), fetchImpl: net.fetchImpl });
    const outcome = await tool.execute({ ...BASE, repoRoot: dir, runId: "run-6", query: "budgets", allowedShows: [], discovery: "open" } as never, CTX);

    expect(outcome.status).toBe("success");
    expect((outcome as { result: { title: string } }).result.title).toBe("budgets second");
  });

  it("refuses a paywall page served where audio was promised", async () => {
    // The failure this tool exists to catch at the boundary: an enclosure URL
    // that 200s with HTML. Written to disk as `.mp3` it would fail three
    // steps later inside `video.transcribe`, exactly as a YouTube watch page
    // used to (RFC-25 phase 4).
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "podcast-"));
    const net = fakeNetwork({
      shows: { results: [{ collectionName: "S", feedUrl: "https://feeds.example/s" }] },
      feeds: { "https://feeds.example/s": feed("S", item({ title: "Members only", url: "https://cdn.example/p.mp3", duration: "40:00" })) },
      audio: { "https://cdn.example/p.mp3": { type: "text/html" } },
    });
    const tool = createHarvestPodcast({ provider: createItunesPodcastProvider({ fetchImpl: net.fetchImpl }), fetchImpl: net.fetchImpl });
    const outcome = await tool.execute({ ...BASE, repoRoot: dir, runId: "run-7", query: "marketing budgets", allowedShows: [], discovery: "open" } as never, CTX);

    expect(outcome.status).toBe("content_fail");
    expect((outcome as { reason: string }).reason).toContain('refused content type "text/html"');
    await expect(fs.readdir(path.join(dir, ".media-cache", "run-7"))).resolves.toEqual([]);
  });

  it("lets one unreadable feed cost that feed, not the search", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "podcast-"));
    const net = fakeNetwork({
      shows: { results: [{ collectionName: "Dead", feedUrl: "https://feeds.example/dead" }, { collectionName: "Alive", feedUrl: "https://feeds.example/alive" }] },
      feeds: { "https://feeds.example/alive": feed("Alive", item({ title: "Still here", url: "https://cdn.example/ok.mp3", duration: "40:00" })) },
      audio: { "https://cdn.example/ok.mp3": {} },
    });
    const tool = createHarvestPodcast({ provider: createItunesPodcastProvider({ fetchImpl: net.fetchImpl }), fetchImpl: net.fetchImpl });
    const outcome = await tool.execute({ ...BASE, repoRoot: dir, runId: "run-8", query: "marketing budgets", allowedShows: [], discovery: "open" } as never, CTX);

    expect(outcome.status).toBe("success");
    expect((outcome as { result: { showTitle: string } }).result.showTitle).toBe("Alive");
  });

  it("reports not_available with no provider, so the cascade moves on rather than holding", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "podcast-"));
    const outcome = await createHarvestPodcast().execute({ ...BASE, repoRoot: dir, runId: "run-9", query: "marketing budgets", allowedShows: [], discovery: "open" } as never, CTX);
    expect(outcome.status).toBe("not_available");
  });

  it("reports a BROKEN search as a tooling error, never as nothing to clip", async () => {
    // The same rule both harvest tiers follow: a search that never ran is not
    // an editorial outcome, and the cascade must not read it as one.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "podcast-"));
    const fetchImpl = (async () => ({ ok: false, status: 503, async json() { return {}; } })) as unknown as typeof fetch;
    const tool = createHarvestPodcast({ provider: createItunesPodcastProvider({ fetchImpl }), fetchImpl });
    const outcome = await tool.execute({ ...BASE, repoRoot: dir, runId: "run-10", query: "marketing budgets", allowedShows: [], discovery: "open" } as never, CTX);

    expect(outcome.status).toBe("tooling_error");
    expect((outcome as { reason: string }).reason).toContain("503");
  });
});
