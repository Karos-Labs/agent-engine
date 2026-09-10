import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildRelevancePrompt, createFindStockClip, FindStockClipInputSchema, pickPortraitFile, rankStockVideos, lexicalFit, pexelsTitleWords, titleSimilarity } from "../src/stock-video.js";
import type { VisionAnalysisClient } from "../src/visual-patterns.js";

const ctx = { ctx: { runId: "r", clientSlug: "acme", productId: "tiktok-agent", runKind: "recurring" } } as never;

function video(id: number, duration: number, w: number, h: number, files: Array<{ w: number; h: number; type?: string }>, title?: string) {
  return {
    id,
    duration,
    width: w,
    height: h,
    url: title === undefined ? `https://www.pexels.com/video/${id}/` : `https://www.pexels.com/video/${title}-${id}/`,
    image: `https://images.pexels.com/videos/${id}/poster.jpeg`,
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
    if (url.hostname === "images.pexels.com") {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    downloads.push(url.toString());
    return new Response(new Uint8Array(clipBytes), { status: 200, headers: { "content-length": String(clipBytes) } });
  }) as typeof fetch;
  return { fetch: impl, searches, downloads };
}

/** A vision client that answers with the given scores per ref and records what it was shown. */
function fakeVision(scores: Record<string, number>, opts: { fail?: boolean } = {}): { client: VisionAnalysisClient; prompts: string[]; imagesShown: number[] } {
  const prompts: string[] = [];
  const imagesShown: number[] = [];
  const client: VisionAnalysisClient = {
    models: {
      async generateContent(request) {
        const parts = request.contents[0]!.parts;
        prompts.push(parts.filter((p): p is { text: string } => "text" in p).map((p) => p.text).join("\n"));
        imagesShown.push(parts.filter((p) => "inlineData" in p).length);
        if (opts.fail) throw new Error("vision backend down");
        const refs = [...(prompts[prompts.length - 1]!.match(/Candidate ref: (c\d+)/g) ?? [])].map((m) => m.replace("Candidate ref: ", ""));
        return {
          candidates: [{ content: { parts: [{ text: JSON.stringify({ scores: refs.map((ref) => ({ ref, score: scores[ref] ?? 1, reason: `${ref} looks ${scores[ref] ?? 1}` })) }) }] } }],
          usageMetadata: { promptTokenCount: 2100, candidatesTokenCount: 90 },
        };
      },
    },
  };
  return { client, prompts, imagesShown };
}

describe("video.findStockClip relevance (2026-09-09)", () => {
  const pool = {
    "empty conference stage": {
      videos: [
        video(11, 9, 1080, 1920, [{ w: 1080, h: 1920 }]), // shortest: the guitarist
        video(12, 14, 1080, 1920, [{ w: 1080, h: 1920 }]), // the actual empty stage
        video(13, 20, 1080, 1920, [{ w: 1080, h: 1920 }]),
      ],
    },
  };

  it("shows the vision model the candidates' poster frames with the narration, downloads the best FIT rather than the shortest, and bills the tokens", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "stock-rel-"));
    try {
      const f = fakeFetch(pool);
      const vision = fakeVision({ c11: 2, c12: 9, c13: 6 });
      const outcome = await createFindStockClip({ apiKey: "key-123", fetchImpl: f.fetch, visionClient: vision.client }).execute(
        FindStockClipInputSchema.parse({
          repoRoot,
          runId: "run-rel",
          query: "empty conference stage",
          minDurationSeconds: 6,
          relevance: { brief: "Wide shot of an empty grand-hall stage, rows of vacant chairs", narration: "We give our winner one million dollars." },
        }),
        ctx,
      );
      expect(outcome.status).toBe("success");
      if (outcome.status !== "success") throw new Error("unreachable");
      expect(outcome.result.pexelsId).toBe(12);
      expect(outcome.result.relevanceScore).toBe(9);
      expect(outcome.result.relevanceNote).toBe("c12 looks 9");
      expect(outcome.result.candidatesConsidered).toBe(3);
      expect(vision.imagesShown).toEqual([3]);
      expect(vision.prompts[0]).toContain('What is said over this shot: "We give our winner one million dollars."');
      expect(outcome.usage).toEqual([
        { model: "gemini-2.5-flash-vision-analysis-input-token", unit: "input-token", quantity: 2100 },
        { model: "gemini-2.5-flash-vision-analysis-output-token", unit: "output-token", quantity: 90 },
      ]);
      expect(f.downloads).toEqual(["https://videos.pexels.com/12-1920.mp4"]);
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("nothing over the floor on the precise query moves on to the broader one; nothing anywhere is a content_fail that says the clips did not fit", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "stock-rel-"));
    try {
      const f = fakeFetch({ ...pool, "empty conference": { videos: [video(21, 8, 1080, 1920, [{ w: 1080, h: 1920 }])] } });
      const vision = fakeVision({ c11: 2, c12: 3, c13: 1, c21: 8 });
      const outcome = await createFindStockClip({ apiKey: "key-123", fetchImpl: f.fetch, visionClient: vision.client }).execute(
        FindStockClipInputSchema.parse({ repoRoot, runId: "run-rel2", query: "empty conference stage", minDurationSeconds: 6, relevance: { brief: "an empty stage", narration: "a line" } }),
        ctx,
      );
      expect(outcome.status).toBe("success");
      if (outcome.status !== "success") throw new Error("unreachable");
      expect(outcome.result.pexelsId).toBe(21);
      expect(outcome.result.query).toBe("empty conference");
      expect(f.searches).toEqual(["empty conference stage", "empty conference"]);

      const none = fakeVision({ c11: 2, c12: 3, c13: 1, c21: 2 });
      const miss = await createFindStockClip({ apiKey: "key-123", fetchImpl: fakeFetch({ ...pool, "empty conference": { videos: [video(21, 8, 1080, 1920, [{ w: 1080, h: 1920 }])] } }).fetch, visionClient: none.client }).execute(
        FindStockClipInputSchema.parse({ repoRoot, runId: "run-rel3", query: "empty conference stage", minDurationSeconds: 6, relevance: { brief: "an empty stage", narration: "a line" } }),
        ctx,
      );
      expect(miss.status).toBe("content_fail");
      if (miss.status !== "content_fail") throw new Error("unreachable");
      expect(miss.reason).toContain("none fit the beat");
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("without a vision backend the clip whose TITLE matches the query is taken over a shorter mismatch, and the note says so", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "stock-rel-"));
    try {
      const titled = {
        "empty open plan office dusk": {
          videos: [
            video(21, 9, 1080, 1920, [{ w: 1080, h: 1920 }], "a-road-in-the-desert-at-sunset"),
            video(22, 15, 1080, 1920, [{ w: 1080, h: 1920 }], "empty-office-at-dusk"),
          ],
        },
      };
      const outcome = await createFindStockClip({ apiKey: "key-123", fetchImpl: fakeFetch(titled).fetch }).execute(
        FindStockClipInputSchema.parse({ repoRoot, runId: "run-rel6", query: "empty open plan office dusk", minDurationSeconds: 6, relevance: { brief: "b", narration: "n" } }),
        ctx,
      );
      expect(outcome.status).toBe("success");
      if (outcome.status !== "success") throw new Error("unreachable");
      expect(outcome.result.pexelsId).toBe(22);
      expect(outcome.result.relevanceNote).toContain("title best matched");
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("degrades to shortest-first, with a note, when there is no vision backend or the scoring call fails", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "stock-rel-"));
    try {
      const noBackend = await createFindStockClip({ apiKey: "key-123", fetchImpl: fakeFetch(pool).fetch }).execute(
        FindStockClipInputSchema.parse({ repoRoot, runId: "run-rel4", query: "empty conference stage", minDurationSeconds: 6, relevance: { brief: "b", narration: "n" } }),
        ctx,
      );
      expect(noBackend.status).toBe("success");
      if (noBackend.status !== "success") throw new Error("unreachable");
      expect(noBackend.result.pexelsId).toBe(11);
      expect(noBackend.result.relevanceNote).toContain("no vision backend");
      expect(noBackend.usage).toBeUndefined();

      const broken = fakeVision({}, { fail: true });
      const failed = await createFindStockClip({ apiKey: "key-123", fetchImpl: fakeFetch(pool).fetch, visionClient: broken.client }).execute(
        FindStockClipInputSchema.parse({ repoRoot, runId: "run-rel5", query: "empty conference stage", minDurationSeconds: 6, relevance: { brief: "b", narration: "n" } }),
        ctx,
      );
      expect(failed.status).toBe("success");
      if (failed.status !== "success") throw new Error("unreachable");
      expect(failed.result.pexelsId).toBe(11);
      expect(failed.result.relevanceNote).toContain("relevance scoring failed");
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("the prompt names the narration, the brief and every ref, and asks for JSON scores", () => {
    const prompt = buildRelevancePrompt({ brief: "a stage", narration: "a line" }, ["c1", "c2"]);
    expect(prompt).toContain("a stage");
    expect(prompt).toContain('"a line"');
    expect(prompt).toContain("Candidate refs, in order: c1, c2.");
    expect(prompt).toContain('"scores"');
  });
});

describe("video.findStockClip", () => {
  it("is not_available without an API key, never a throw", async () => {
    const outcome = await createFindStockClip({}).execute(FindStockClipInputSchema.parse({ repoRoot: os.tmpdir(), runId: "r1", query: "office desk" }), ctx);
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
        FindStockClipInputSchema.parse({ repoRoot, runId: "run-a", query: "empty office desk night", minDurationSeconds: 6, outputName: "plate-1" }),
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
        FindStockClipInputSchema.parse({ repoRoot, runId: "run-b", query: "city street rain", minDurationSeconds: 4, excludeIds: [7] }),
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
        FindStockClipInputSchema.parse({ repoRoot, runId: "run-c", query: "worn leather wallet receipts", minDurationSeconds: 4 }),
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
    const outcome = await createFindStockClip({ apiKey: "key-123", fetchImpl: f.fetch }).execute(FindStockClipInputSchema.parse({ repoRoot: os.tmpdir(), runId: "../../escape", query: "office" }), ctx);
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

  it("reads the clip's title off its Pexels URL and counts the query words it carries, give or take a suffix", () => {
    expect(pexelsTitleWords("https://www.pexels.com/video/a-road-in-the-desert-at-sunset-1234/")).toEqual(["road", "desert", "sunset"]);
    expect(pexelsTitleWords("https://www.pexels.com/video/1234/")).toEqual([]);
    expect(pexelsTitleWords(undefined)).toEqual([]);
    expect(lexicalFit("empty open plan office dusk", "https://www.pexels.com/video/a-road-in-the-desert-at-sunset-1234/")).toBe(0);
    expect(lexicalFit("empty open plan office dusk", "https://www.pexels.com/video/empty-offices-at-night-55/")).toBe(2);
    expect(lexicalFit("calendar desk crossed days close-up", "https://www.pexels.com/video/person-crossing-days-on-a-desk-calendar-9/")).toBe(4);
    expect(lexicalFit("empty office", "https://www.pexels.com/video/9/")).toBe(0);
    // A kind of shot the line did not ask for costs a point: the warehouse from a drone loses to the forklift on the floor.
    expect(lexicalFit("warehouse concrete floor industrial lamp", "https://www.pexels.com/video/aerial-view-of-industrial-warehouse-area-37763654/")).toBe(1);
    expect(lexicalFit("warehouse concrete floor industrial lamp", "https://www.pexels.com/video/industrial-yellow-forklift-in-warehouse-scene-35595841/")).toBe(2);
    expect(lexicalFit("aerial city skyline", "https://www.pexels.com/video/aerial-view-of-a-city-skyline-1/")).toBe(3);
    expect(lexicalFit("office desk", "https://www.pexels.com/video/3d-animation-of-an-office-desk-2/")).toBe(0);
  });

  it("a near-twin of the first shot's title is skipped for the second shot, a different picture is not (prep run pubsub-21156937744383149's two clocks)", () => {
    expect(titleSimilarity("https://www.pexels.com/video/empty-classroom-with-sunlit-whiteboard-1/", "https://www.pexels.com/video/empty-classroom-with-desks-and-whiteboard-2/")).toBeCloseTo(0.6, 2);
    expect(titleSimilarity("https://www.pexels.com/video/analog-clock-on-a-wall-1/", "https://www.pexels.com/video/hands-writing-in-a-notebook-2/")).toBe(0);
    expect(titleSimilarity("https://www.pexels.com/video/1/", "https://www.pexels.com/video/analog-clock-2/")).toBe(0);
    const ranked = rankStockVideos(
      [video(1, 9, 1080, 1920, [], "empty-classroom-with-desks-and-whiteboard"), video(2, 12, 1080, 1920, [], "students-walking-a-school-corridor")],
      6,
      [],
      "empty classroom whiteboard",
      "https://www.pexels.com/video/empty-classroom-with-sunlit-whiteboard-99/",
    );
    expect(ranked.map((v) => v.id)).toEqual([2]);
  });

  it("with a query, the clip whose title matches ranks first and shortest only breaks ties (prep run pubsub-21157031361398626's desert road)", () => {
    const ranked = rankStockVideos(
      [
        video(1, 9, 1080, 1920, [], "a-road-in-the-desert-at-sunset"),
        video(2, 20, 1080, 1920, [], "empty-office-at-dusk"),
        video(3, 14, 1080, 1920, [], "modern-office-interior"),
        video(4, 12, 1080, 1920, [], "empty-office-with-lights-switching-off"),
      ],
      6,
      [],
      "empty open plan office dusk",
    );
    expect(ranked.map((v) => v.id)).toEqual([2, 4, 3, 1]);
  });
});
