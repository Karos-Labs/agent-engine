import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFindStockClip, pickPortraitFile, rankStockVideos } from "../src/stock-video.js";

const ctx = { ctx: { runId: "r", clientSlug: "acme", productId: "tiktok-agent", runKind: "recurring" } } as never;

function video(id: number, duration: number, w: number, h: number, files: Array<{ w: number; h: number; type?: string }>) {
  return {
    id,
    duration,
    width: w,
    height: h,
    url: `https://www.pexels.com/video/${id}/`,
    user: { name: "Someone" },
    video_files: files.map((f, i) => ({ id: id * 10 + i, quality: f.h >= 1080 ? "hd" : "sd", file_type: f.type ?? "video/mp4", width: f.w, height: f.h, link: `https://videos.pexels.com/${id}-${f.h}.mp4` })),
  };
}

function fakeFetch(pages: Record<string, unknown>, clipBytes = 1024): { fetch: typeof fetch; searches: string[]; downloads: string[] } {
  const searches: string[] = [];
  const downloads: string[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.hostname === "api.pexels.com") {
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe("key-123");
      const q = url.searchParams.get("query")!;
      searches.push(q);
      expect(url.searchParams.get("orientation")).toBe("portrait");
      const body = pages[q] ?? { videos: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    downloads.push(url.toString());
    return new Response(new Uint8Array(clipBytes), { status: 200, headers: { "content-length": String(clipBytes) } });
  }) as typeof fetch;
  return { fetch: impl, searches, downloads };
}

describe("video.findStockClip", () => {
  it("is not_available without an API key, never a throw", async () => {
    const outcome = await createFindStockClip({}).execute({ repoRoot: os.tmpdir(), runId: "r1", query: "office desk" }, ctx);
    expect(outcome.status).toBe("not_available");
  });

  it("downloads the shortest portrait clip that clears the beat, in its Full-HD file, and reports no billable usage", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "stock-"));
    try {
      const f = fakeFetch({
        "empty office desk night": {
          videos: [
            video(1, 30, 1080, 1920, [{ w: 1080, h: 1920 }, { w: 2160, h: 3840 }]),
            video(2, 9, 1080, 1920, [{ w: 540, h: 960 }, { w: 1080, h: 1920 }]), // shortest that clears 6s
            video(3, 5, 1080, 1920, [{ w: 1080, h: 1920 }]), // too short
            video(4, 12, 1920, 1080, [{ w: 1920, h: 1080 }]), // landscape
          ],
        },
      });
      const outcome = await createFindStockClip({ apiKey: "key-123", fetchImpl: f.fetch }).execute(
        { repoRoot, runId: "run-a", query: "empty office desk night", minDurationSeconds: 6, outputName: "plate-1" },
        ctx,
      );
      expect(outcome.status).toBe("success");
      if (outcome.status !== "success") throw new Error("unreachable");
      expect(outcome.result.pexelsId).toBe(2);
      expect(outcome.result.height).toBe(1920);
      expect(outcome.result.path).toBe(".media-cache/run-a/plate-1.mp4");
      expect(outcome.usage).toBeUndefined();
      expect(f.downloads).toEqual(["https://videos.pexels.com/2-1920.mp4"]);
      const written = await fs.stat(path.join(repoRoot, ".media-cache", "run-a", "plate-1.mp4"));
      expect(written.size).toBe(1024);
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("skips ids already used in this run, so two beats never show the same clip", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "stock-"));
    try {
      const f = fakeFetch({ "city street rain": { videos: [video(7, 8, 1080, 1920, [{ w: 1080, h: 1920 }]), video(8, 10, 1080, 1920, [{ w: 1080, h: 1920 }])] } });
      const outcome = await createFindStockClip({ apiKey: "key-123", fetchImpl: f.fetch }).execute(
        { repoRoot, runId: "run-b", query: "city street rain", minDurationSeconds: 4, excludeIds: [7] },
        ctx,
      );
      expect(outcome.status === "success" && outcome.result.pexelsId).toBe(8);
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("broadens the query before giving up, and reports content_fail (not an error) when nothing portrait matches", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "stock-"));
    try {
      const f = fakeFetch({});
      const outcome = await createFindStockClip({ apiKey: "key-123", fetchImpl: f.fetch }).execute(
        { repoRoot, runId: "run-c", query: "worn leather wallet receipts", minDurationSeconds: 4 },
        ctx,
      );
      expect(outcome.status).toBe("content_fail");
      expect(f.searches.length).toBeGreaterThan(1);
      expect(f.downloads).toEqual([]);
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("refuses a runId that escapes the repo root", async () => {
    const f = fakeFetch({});
    const outcome = await createFindStockClip({ apiKey: "key-123", fetchImpl: f.fetch }).execute({ repoRoot: os.tmpdir(), runId: "../../escape", query: "office" }, ctx);
    expect(outcome.status).toBe("tooling_error");
  });

  it("picks the mp4 closest to 1920 tall among the portrait files, never 4K, never landscape", () => {
    const files = [
      { link: "a", width: 2160, height: 3840, file_type: "video/mp4" },
      { link: "b", width: 720, height: 1280, file_type: "video/mp4" },
      { link: "c", width: 1080, height: 1920, file_type: "video/mp4" },
      { link: "d", width: 1920, height: 1080, file_type: "video/mp4" },
    ];
    expect(pickPortraitFile(files)?.link).toBe("c");
    // 720p portrait still qualifies (it is upscaled); below 1080 tall does not.
    expect(pickPortraitFile([files[1]!])?.link).toBe("b");
    expect(pickPortraitFile([{ link: "e", width: 540, height: 960, file_type: "video/mp4" }, files[3]!])).toBeUndefined();
  });

  it("ranks portrait, long-enough, unused videos shortest-first", () => {
    const ranked = rankStockVideos([video(1, 30, 1080, 1920, []), video(2, 9, 1080, 1920, []), video(3, 3, 1080, 1920, []), video(4, 9, 1920, 1080, [])], 6, [1]);
    expect(ranked.map((v) => v.id)).toEqual([2]);
  });
});
