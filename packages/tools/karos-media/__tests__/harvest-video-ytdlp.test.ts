import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HarvestVideoInputSchema,
  createHarvestVideo,
  createKarosMediaTools,
  createYtDlpHarvestProvider,
  type ProcessResultLike,
  type ProcessRunnerLike,
  type YtDlpFlatEntry,
} from "../src/index.js";

/**
 * `media.harvestVideo` on its first real backend.
 *
 * The load-bearing tests here are the two refusals: an empty `allowedSources`
 * runs NOTHING (asserted by the absence of a runner call, not by an empty
 * result — a provider that searched the open web and then discarded the hits
 * would also return empty), and a hit from a channel the client cannot clip
 * is dropped even when it is the best topical match. Those two are what make
 * "rights-restricted" a property of the code rather than of the prompt.
 */

const CTX = { ctx: {} as never };

function input(overrides: Partial<Record<string, unknown>> = {}) {
  return HarvestVideoInputSchema.parse({
    repoRoot: "/tmp",
    runId: "run1",
    query: "AI agents replacing junior developers",
    allowedSources: ["Lenny's Podcast"],
    ...overrides,
  });
}

/** A flat entry as yt-dlp emits one: `url` always agrees with `id`, the way a real search result does. */
function entry(partial: YtDlpFlatEntry): YtDlpFlatEntry {
  const id = partial.id ?? "vid";
  return { id, url: `https://www.youtube.com/watch?v=${id}`, ...partial };
}

/** What `yt-dlp "ytsearch8:…" --dump-single-json --flat-playlist` prints for one search. */
function searchJson(entries: YtDlpFlatEntry[]): string {
  return JSON.stringify({ _type: "playlist", entries });
}

const OK: ProcessResultLike = { stdout: "", stderr: "", exitCode: 0 };

/**
 * A runner that answers searches from a canned map (keyed by allowed source)
 * and, on a download, actually writes the file the `-o` template names — so
 * the tool's own existence/size/extension checks run against real bytes.
 */
function fakeRunner(
  searches: Record<string, YtDlpFlatEntry[] | ProcessResultLike>,
  download: { exitCode?: number; stderr?: string; bytes?: Buffer | null; ext?: string } = {},
) {
  const calls: string[][] = [];
  const runner: ProcessRunnerLike = async (command, args) => {
    calls.push([command, ...args]);
    const first = args[0] ?? "";
    if (first.startsWith("ytsearch")) {
      const source = Object.keys(searches).find((name) => first.includes(name));
      const canned = source !== undefined ? searches[source]! : [];
      if (Array.isArray(canned)) return { ...OK, stdout: searchJson(canned) };
      return canned;
    }
    if (download.exitCode !== undefined && download.exitCode !== 0) {
      return { stdout: "", stderr: download.stderr ?? "ERROR: [youtube] vid: Video unavailable", exitCode: download.exitCode };
    }
    if (download.bytes !== null) {
      const template = args[args.indexOf("-o") + 1]!;
      await fs.writeFile(template.replace("%(ext)s", download.ext ?? "mp4"), download.bytes ?? Buffer.from("fake-mp4-bytes"));
    }
    return OK;
  };
  return { runner, calls };
}

const LENNY_HIT = entry({
  id: "abc",
  url: "https://www.youtube.com/watch?v=abc",
  title: "Will AI agents replace junior developers? — with a CTO",
  uploader: "Lenny's Podcast",
  channel: "Lenny's Podcast",
  duration: 3600,
  upload_date: "20260801",
});

describe("createYtDlpHarvestProvider — search", () => {
  it("refuses with no allowed sources WITHOUT running anything — never the open web", async () => {
    const { runner, calls } = fakeRunner({});
    const provider = createYtDlpHarvestProvider({ runner });
    const found = await provider.findVideo({ query: "x", allowedSources: [], maxBytes: 1, minDurationSeconds: 90, maxDurationSeconds: 10_800 });
    expect(found.candidate).toBeNull();
    expect((found as { reason: string }).reason).toMatch(/no allowed sources/);
    expect(calls).toHaveLength(0);
  });

  it("filters out hits from other channels even when they match the topic better", async () => {
    const { runner } = fakeRunner({
      "Lenny's Podcast": [
        entry({ id: "other", title: "AI agents replacing junior developers — full breakdown", uploader: "Some Reaction Channel", channel: "Some Reaction Channel", duration: 1200 }),
        LENNY_HIT,
      ],
    });
    const provider = createYtDlpHarvestProvider({ runner });
    const found = await provider.findVideo(input());
    expect(found.candidate?.sourceUrl).toBe("https://www.youtube.com/watch?v=abc");
    expect(found.candidate?.channel).toBe("Lenny's Podcast");
    expect(found.candidate?.durationSeconds).toBe(3600);
  });

  it("skips Shorts and anything over the duration ceiling, and refuses when nothing on-channel remains", async () => {
    const { runner } = fakeRunner({
      "Lenny's Podcast": [
        entry({ id: "short", title: "AI agents (short)", uploader: "Lenny's Podcast", duration: 45 }),
        entry({ id: "marathon", title: "AI agents 12h livestream", uploader: "Lenny's Podcast", duration: 12 * 3600 }),
        entry({ id: "nodur", title: "AI agents", uploader: "Lenny's Podcast" }),
      ],
    });
    const provider = createYtDlpHarvestProvider({ runner });
    const found = await provider.findVideo(input());
    expect(found.candidate).toBeNull();
    expect((found as { reason: string }).reason).toMatch(/3 outside 90–10800s/);
  });

  it("ranks by query-token overlap with the title, then newest", async () => {
    const { runner } = fakeRunner({
      "Lenny's Podcast": [
        entry({ id: "old-best", title: "AI agents replacing junior developers", uploader: "Lenny's Podcast", duration: 2000, upload_date: "20250101" }),
        entry({ id: "new-best", title: "AI agents replacing junior developers", uploader: "Lenny's Podcast", duration: 2000, upload_date: "20260101" }),
        entry({ id: "weak", title: "Product roadmaps", uploader: "Lenny's Podcast", duration: 2000, upload_date: "20260901" }),
      ],
    });
    const found = await createYtDlpHarvestProvider({ runner }).findVideo(input());
    expect(found.candidate?.sourceUrl).toContain("v=new-best");
  });

  it("runs one search per allowed source in order and stops at the first that yields", async () => {
    const { runner, calls } = fakeRunner({ "Show A": [], "Show B": [entry({ id: "b", title: "AI agents", uploader: "Show B", duration: 600 })], "Show C": [] });
    const found = await createYtDlpHarvestProvider({ runner }).findVideo(input({ allowedSources: ["Show A", "Show B", "Show C"] }));
    expect(found.candidate?.sourceUrl).toContain("v=b");
    expect(calls.map((c) => c[1])).toEqual(["ytsearch8:Show A AI agents replacing junior developers", "ytsearch8:Show B AI agents replacing junior developers"]);
    expect(calls[0]).toEqual(expect.arrayContaining(["--dump-single-json", "--flat-playlist", "--no-warnings", "--skip-download"]));
  });

  it("passes --cookies when a cookies file is configured (option or YT_DLP_COOKIES_FILE) and honours YT_DLP_BIN", async () => {
    const { runner, calls } = fakeRunner({ "Lenny's Podcast": [LENNY_HIT] });
    await createYtDlpHarvestProvider({ runner, env: { YT_DLP_COOKIES_FILE: "/secrets/cookies.txt", YT_DLP_BIN: "/opt/yt-dlp" } }).findVideo(input());
    expect(calls[0]![0]).toBe("/opt/yt-dlp");
    expect(calls[0]!.slice(1)).toEqual(expect.arrayContaining(["--cookies", "/secrets/cookies.txt"]));

    const plain = fakeRunner({ "Lenny's Podcast": [LENNY_HIT] });
    await createYtDlpHarvestProvider({ runner: plain.runner }).findVideo(input());
    expect(plain.calls[0]![0]).toBe("yt-dlp");
    expect(plain.calls[0]).not.toContain("--cookies");
  });

  it("a search that yt-dlp itself fails is thrown (tooling), not reported as 'nothing to clip'", async () => {
    const { runner } = fakeRunner({ "Lenny's Podcast": { stdout: "", stderr: "ERROR: Sign in to confirm you're not a bot", exitCode: 1 } });
    await expect(createYtDlpHarvestProvider({ runner }).findVideo(input())).rejects.toThrow(/not a bot/);
  });
});

describe("media.harvestVideo with the yt-dlp provider", () => {
  it("downloads into .media-cache/<runId>/ with --max-filesize and the dest template, and returns a repo-relative path", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harvest-"));
    const { runner, calls } = fakeRunner({ "Lenny's Podcast": [LENNY_HIT] });
    const tool = createHarvestVideo({ provider: createYtDlpHarvestProvider({ runner }) });

    const outcome = await tool.execute(input({ repoRoot, maxBytes: 50_000_000 }), CTX);
    expect(outcome.status).toBe("success");
    const result = (outcome as { result: { path: string; sourceUrl: string; channel?: string; provider: string; durationSeconds?: number } }).result;
    expect(result.path).toBe(".media-cache/run1/harvested-clip.mp4");
    expect(result.sourceUrl).toBe("https://www.youtube.com/watch?v=abc");
    expect(result.channel).toBe("Lenny's Podcast");
    expect(result.provider).toBe("yt-dlp");
    expect(result.durationSeconds).toBe(3600);
    await expect(fs.stat(path.join(repoRoot, result.path))).resolves.toBeTruthy();

    const download = calls.find((c) => c[1] === "https://www.youtube.com/watch?v=abc")!;
    expect(download).toEqual(expect.arrayContaining(["--max-filesize", "50000000", "--merge-output-format", "mp4", "--no-playlist", "-o"]));
    expect(download[download.indexOf("-o") + 1]).toBe(path.join(repoRoot, ".media-cache", "run1", "harvested-clip.%(ext)s"));
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("a download yt-dlp fails is a content_fail naming the URL, never a hold-worthy tooling error", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harvest-"));
    const { runner } = fakeRunner({ "Lenny's Podcast": [LENNY_HIT] }, { exitCode: 1, stderr: "ERROR: [youtube] abc: Video unavailable" });
    const outcome = await createHarvestVideo({ provider: createYtDlpHarvestProvider({ runner }) }).execute(input({ repoRoot }), CTX);
    expect(outcome.status).toBe("content_fail");
    expect((outcome as { reason: string }).reason).toContain("https://www.youtube.com/watch?v=abc");
    expect((outcome as { reason: string }).reason).toContain("Video unavailable");
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("a --max-filesize skip (exit 0, no file written) is a content_fail too", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harvest-"));
    const { runner } = fakeRunner({ "Lenny's Podcast": [LENNY_HIT] }, { bytes: null });
    const outcome = await createHarvestVideo({ provider: createYtDlpHarvestProvider({ runner }) }).execute(input({ repoRoot }), CTX);
    expect(outcome.status).toBe("content_fail");
    expect((outcome as { reason: string }).reason).toMatch(/max-filesize/);
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("a file over maxBytes is refused and removed even when yt-dlp wrote it", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harvest-"));
    const { runner } = fakeRunner({ "Lenny's Podcast": [LENNY_HIT] }, { bytes: Buffer.alloc(2048) });
    const outcome = await createHarvestVideo({ provider: createYtDlpHarvestProvider({ runner }) }).execute(input({ repoRoot, maxBytes: 1024 }), CTX);
    expect(outcome.status).toBe("content_fail");
    await expect(fs.stat(path.join(repoRoot, ".media-cache", "run1", "harvested-clip.mp4"))).rejects.toThrow();
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("the provider's own refusal (no allowed sources) surfaces as content_fail, with its reason", async () => {
    const { runner, calls } = fakeRunner({});
    const outcome = await createHarvestVideo({ provider: createYtDlpHarvestProvider({ runner }) }).execute(input({ allowedSources: [] }), CTX);
    expect(outcome.status).toBe("content_fail");
    expect((outcome as { reason: string }).reason).toMatch(/never searches the open web/);
    expect(calls).toHaveLength(0);
  });

  it("a runId that escapes repoRoot is refused before any search runs", async () => {
    const { runner, calls } = fakeRunner({ "Lenny's Podcast": [LENNY_HIT] });
    const outcome = await createHarvestVideo({ provider: createYtDlpHarvestProvider({ runner }) }).execute(input({ runId: "../../etc" }), CTX);
    expect(outcome.status).toBe("content_fail");
    expect(calls).toHaveLength(0);
  });

  it("a provider that throws on search is a tooling_error — the question was never asked", async () => {
    const { runner } = fakeRunner({ "Lenny's Podcast": { stdout: "", stderr: "yt-dlp: command not found", exitCode: 127 } });
    const outcome = await createHarvestVideo({ provider: createYtDlpHarvestProvider({ runner }) }).execute(input(), CTX);
    expect(outcome.status).toBe("tooling_error");
  });
});

describe("createKarosMediaTools wiring", () => {
  it("registers media.harvestVideo as not_available without VIDEO_HARVEST_PROVIDER, and behind yt-dlp when set", async () => {
    const off = createKarosMediaTools({ env: {}, generationClient: null, videoGenerationClient: null, visionClient: null, scraper: null });
    const offOutcome = await off["media.harvestVideo"]!.execute(input(), CTX);
    expect(offOutcome.status).toBe("not_available");

    // With the switch on, the tool is live: an empty allowed-sources list is the
    // provider's own refusal (content_fail), proving the yt-dlp provider — not
    // the stub — answered, without spawning a binary the test host may lack.
    const on = createKarosMediaTools({
      env: { VIDEO_HARVEST_PROVIDER: "yt-dlp" },
      generationClient: null,
      videoGenerationClient: null,
      visionClient: null,
      scraper: null,
    });
    const onOutcome = await on["media.harvestVideo"]!.execute(input({ allowedSources: [] }), CTX);
    expect(onOutcome.status).toBe("content_fail");
    expect((onOutcome as { reason: string }).reason).toMatch(/no allowed sources/);
  });

  it("an injected videoHarvestProvider still wins over the env switch, exactly as before", async () => {
    let asked = 0;
    const registry = createKarosMediaTools({
      env: { VIDEO_HARVEST_PROVIDER: "yt-dlp" },
      generationClient: null,
      videoGenerationClient: null,
      visionClient: null,
      scraper: null,
      videoHarvestProvider: {
        name: "fake",
        async findVideo() {
          asked += 1;
          return { candidate: null, reason: "fake says no" };
        },
      },
    });
    const outcome = await registry["media.harvestVideo"]!.execute(input(), CTX);
    expect(outcome.status).toBe("content_fail");
    expect((outcome as { reason: string }).reason).toContain("fake says no");
    expect(asked).toBe(1);
  });
});
