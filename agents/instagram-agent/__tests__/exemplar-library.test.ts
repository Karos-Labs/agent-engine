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
  });
});
