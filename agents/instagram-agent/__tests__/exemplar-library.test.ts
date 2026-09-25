import { describe, expect, it } from "vitest";
import {
  buildExemplarLibrary,
  exemplarLibraryAction,
  exemplarPatternEvidence,
  exemplarStudioNotes,
  failedLibrary,
  planHarvest,
  postsToJudge,
  readExemplarLibrary,
  type HarvestedExemplar,
} from "../src/workflow/exemplar-library.js";

/** RFC-26 Phase 3: the exemplar library setup builds and the studio and art director read. */

const exemplar = (url: string, overrides: Partial<HarvestedExemplar> = {}): HarvestedExemplar => ({
  url,
  handle: "semrush",
  role: "reference",
  format: "carousel",
  frames: ["https://cdn/x.jpg"],
  frameCount: 6,
  hook: "3 reasons AI isn't mentioning your brand",
  likes: 100,
  comments: 5,
  percentile: 0.9,
  ...overrides,
});

describe("which accounts setup harvests", () => {
  it("takes the client's Instagram accounts, the brief's Instagram references and the competitors' sites, deduplicated", () => {
    const plan = planHarvest({
      ownAccounts: [
        { platform: "instagram", username: "@HankyPanky" },
        { platform: "x", username: "hankypanky" },
      ],
      referenceAccounts: [
        { platform: "instagram", handle: "https://www.instagram.com/reputeforge/" },
        { platform: "instagram", handle: "hankypanky" },
        { platform: "tiktok", handle: "someone" },
      ],
      competitors: [{ name: "Commando", website: "wearcommando.com" }, { name: "No site" }, { name: "Bad", website: "not a url at all" }],
    });
    expect(plan.accounts).toEqual([
      { handle: "hankypanky", role: "client" },
      { handle: "reputeforge", role: "reference" },
    ]);
    expect(plan.competitorSites).toEqual([{ name: "Commando", website: "https://wearcommando.com" }]);
  });
});

describe("what the judge sees", () => {
  it("breakouts first, stills before reels", () => {
    const picked = postsToJudge(
      [exemplar("a", { outlier: false }), exemplar("b", { outlier: true, format: "reel", liftOverBaseline: 9 }), exemplar("c", { outlier: true, liftOverBaseline: 3 })],
      2,
    ).map((e) => e.url);
    expect(picked).toEqual(["c", "b"]);
  });
});

describe("the library", () => {
  const harvest = {
    accounts: [{ handle: "semrush", role: "reference" as const, posts: 100, medianCarouselFrames: 6 }],
    exemplars: [exemplar("a", { liftOverBaseline: 3.2, outlier: true }), exemplar("b"), exemplar("c", { handle: "hankypanky", role: "client" })],
    problems: [],
  };
  const dna = { coverType: "typographic", picturePlacement: "inset", elementGroupsPerSlide: 3, textDensity: "low", emphasis: "highlight-block", device: "figure", groundStyle: "flat-light" };
  const judged = {
    judged: [
      { ref: "a", craft: 5, dna, standout: "one highlighted word per headline", storedFrames: ["gs://m/a1.jpg"], exemplar: true },
      { ref: "b", craft: 2, dna, standout: "x", storedFrames: [], exemplar: false },
      { ref: "c", craft: 4, dna: { ...dna, picturePlacement: "full-bleed" }, standout: "product in a real room", storedFrames: [], exemplar: true },
    ],
    calibration: { anchors: 10, shift: 1, note: "moved up 1" },
  };

  it("keeps only judged exemplars, best craft first, with techniques and never captions beyond the hook", () => {
    const library = buildExemplarLibrary({ now: new Date("2026-09-25T00:00:00Z"), harvest, judged });
    expect(library.status).toBe("built");
    expect(library.entries.map((e) => e.craft)).toEqual([5, 4]);
    expect(library.entries[0]!.lift).toBe(3.2);
    expect(library.calibration?.shift).toBe(1);
    expect(readExemplarLibrary(JSON.parse(JSON.stringify(library)))?.entries).toHaveLength(2);
  });

  it("tells the studio what proven posts are made of, as descriptions", () => {
    const notes = exemplarStudioNotes(buildExemplarLibrary({ now: new Date(), harvest, judged }));
    expect(notes[0]).toContain("picture inset");
    expect(notes[0]).toContain("3.2x its account's usual engagement");
    expect(notes[0]).toContain("one highlighted word per headline");
  });

  it("gives the art director the client's own breakouts apart from the niche's", () => {
    const evidence = exemplarPatternEvidence(buildExemplarLibrary({ now: new Date(), harvest, judged }))!;
    expect(evidence.reference).toContain("The client's own breakouts (1 judged breakouts)");
    expect(evidence.reference).toContain("Breakouts across the niche");
    expect(evidence.templateHints).toContain("product in a real room");
  });

  it("reuses a fresh library, waits after a failure, rebuilds when stale", () => {
    const now = new Date("2026-09-25T00:00:00Z");
    const built = buildExemplarLibrary({ now: new Date("2026-09-10T00:00:00Z"), harvest, judged });
    expect(exemplarLibraryAction(built, now)).toBe("reuse");
    expect(exemplarLibraryAction(buildExemplarLibrary({ now: new Date("2026-08-01T00:00:00Z"), harvest, judged }), now)).toBe("build");
    expect(exemplarLibraryAction(failedLibrary(new Date("2026-09-22T00:00:00Z"), ["no accounts"]), now)).toBe("wait");
    expect(exemplarLibraryAction(failedLibrary(new Date("2026-09-10T00:00:00Z"), ["no accounts"]), now)).toBe("build");
    expect(exemplarLibraryAction(undefined, now)).toBe("build");
    expect(exemplarStudioNotes(failedLibrary(now, ["x"]))).toEqual([]);
  });
});

describe("the library steers picture density (RFC-26 Phase 4a)", () => {
  it("makes a photo-led niche photo-first, and leaves a text-led or thin library alone", async () => {
    const { densityFromLibrary } = await import("../src/workflow/exemplar-library.js");
    const entry = (placement: string, cover = "typographic") => ({ handle: "h", role: "competitor" as const, format: "carousel", frameCount: 6, craft: 4, dna: { picturePlacement: placement, coverType: cover }, standout: "s", hook: "", storedFrames: [] });
    const lib = (entries: ReturnType<typeof entry>[]) => ({ version: 1 as const, builtAt: "2026-09-25T00:00:00Z", status: "built" as const, problems: [], accounts: [], entries });
    expect(densityFromLibrary(lib([entry("full-bleed"), entry("inset"), entry("none", "person"), entry("split"), entry("none")]))).toBe("photo-first");
    expect(densityFromLibrary(lib([entry("none"), entry("none"), entry("none"), entry("inset"), entry("none")]))).toBeUndefined();
    expect(densityFromLibrary(lib([entry("full-bleed"), entry("inset")]))).toBeUndefined();
    expect(densityFromLibrary(undefined)).toBeUndefined();
describe("a client with nothing on file still gets a library (2026-09-25)", () => {
  it("falls back to its industry's benchmark accounts and reads its own account off its website", async () => {
    const { benchmarksForIndustry, DEFAULT_BENCHMARKS } = await import("../src/workflow/exemplar-library.js");
    const plan = planHarvest({ ownAccounts: [], referenceAccounts: [], competitors: [], ownWebsite: "hankypanky.com", industry: "Intimate apparel and lingerie" });
    expect(plan.accounts.map((a) => a.handle)).toEqual(["aerie", "knix", "thirdlove", "wearcommando"]);
    expect(plan.competitorSites).toEqual([{ name: "the client's own site", website: "https://hankypanky.com", role: "client" }]);
    expect(benchmarksForIndustry("AI marketing agency")).toContain("reputeforge");
    expect(benchmarksForIndustry("Something unusual")).toEqual(DEFAULT_BENCHMARKS);
  });

  it("does not add benchmarks when the brief names references, nor read the site when the config names the account", () => {
    const plan = planHarvest({ ownAccounts: [{ platform: "instagram", username: "karoslabs" }], referenceAccounts: [{ platform: "instagram", handle: "semrush" }], competitors: [], ownWebsite: "karoslabs.com", industry: "AI marketing" });
    expect(plan.accounts.map((a) => a.handle)).toEqual(["karoslabs", "semrush"]);
    expect(plan.competitorSites).toEqual([]);
  });

  it("rebuilds at once over a 'nothing to harvest' marker", () => {
    const now = new Date("2026-09-25T02:00:00Z");
    expect(exemplarLibraryAction(failedLibrary(new Date("2026-09-25T00:01:00Z"), ["no Instagram account, reference account or competitor website is on file, so there was nothing to harvest"]), now)).toBe("build");
    expect(exemplarLibraryAction(failedLibrary(new Date("2026-09-25T00:01:00Z"), ["the harvest failed: scraper down"]), now)).toBe("wait");
  });
});

describe("the writer sees the niche's breakout hook shapes (RFC-26 Phase 4c)", () => {
  it("summarises shapes and techniques, never wording or handles", async () => {
    const { nicheHooksForCopy } = await import("../src/workflow/exemplar-library.js");
    const e = (hook: string, standout: string) => ({ handle: "wearcommando", role: "competitor" as const, format: "carousel", frameCount: 5, craft: 4, dna: { hookPattern: hook }, standout, hook: "Denim on denim, because one layer just isn't enough", storedFrames: [] });
    const lib = { version: 1 as const, builtAt: "2026-09-25T00:00:00Z", status: "built" as const, problems: [], accounts: [], entries: [e("number", "one highlighted word"), e("number", "numbered pastel badges"), e("question", "a real room"), e("list", "t"), e("number", "t")] };
    const text = nicheHooksForCopy(lib)!;
    expect(text).toContain("number 60%");
    expect(text).toContain("one highlighted word");
    expect(text).not.toContain("wearcommando");
    expect(text).not.toContain("Denim on denim");
    expect(nicheHooksForCopy({ ...lib, entries: lib.entries.slice(0, 3) })).toBeUndefined();
  });
});
