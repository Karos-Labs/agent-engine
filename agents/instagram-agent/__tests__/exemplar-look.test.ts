import { describe, expect, it } from "vitest";
import { exemplarLook } from "../src/workflow/exemplar-look.js";
import type { ExemplarLibrary } from "../src/workflow/exemplar-library.js";
import { pickVisualSystem, VISUAL_SYSTEM_CATALOG, fallbackClientVisualSystem } from "../src/workflow/visual-system.js";

const entry = (dna: Record<string, string>, craft = 5, role: "reference" | "client" = "reference") => ({
  handle: "ref", role, format: "carousel", frameCount: 6, lift: 3, craft, dna, standout: "s", hook: "h", storedFrames: [],
});
const library = (entries: ReturnType<typeof entry>[]): ExemplarLibrary => ({ version: 1, builtAt: "2026-09-25T00:00:00Z", status: "built", problems: [], accounts: [], entries });

/**
 * The owner: setup harvests hundreds of posts and takes the best as the
 * templates. The library's DNA now ranks the catalog `04p` draws from.
 */
describe("exemplarLook", () => {
  it("states the axes a plurality of the strongest exemplars share, with the votes behind each", () => {
    const look = exemplarLook(library([
      entry({ groundStyle: "flat-dark", emphasis: "highlight-block", textDensity: "low" }),
      entry({ groundStyle: "flat-light", emphasis: "highlight-block", textDensity: "low" }),
      entry({ groundStyle: "texture", emphasis: "underline", textDensity: "medium" }),
    ]))!;
    expect(look.ground).toBe("flat");
    expect(look.accentForm).toBe("band");
    expect(look.typeScale).toBe("display");
    expect(look.basis[0]).toMatch(/ground flat \(2 of 3/u);
  });

  it("says nothing on a tie, a thin library, the client's own posts only, or a failed build", () => {
    expect(exemplarLook(library([entry({ groundStyle: "flat-dark" }), entry({ groundStyle: "texture" })]))).toBeUndefined();
    expect(exemplarLook(library([entry({ groundStyle: "flat-dark" })]))).toBeUndefined();
    expect(exemplarLook(library([entry({ groundStyle: "flat-dark" }, 5, "client"), entry({ groundStyle: "flat-dark" }, 5, "client")]))).toBeUndefined();
    expect(exemplarLook({ ...library([]), status: "failed" })).toBeUndefined();
    expect(exemplarLook(undefined)).toBeUndefined();
  });
});

describe("pickVisualSystem with the exemplars' preference", () => {
  // An `information` accent role can carry grid and band systems, so the preference has something to choose.
  const base = { clientSlug: "acme", paletteSeed: "run-1", slideCount: 8, client: { ...fallbackClientVisualSystem(), accentRole: "information" as const } };

  it("draws only among the systems matching the most preferred axes", () => {
    for (const seed of ["a", "b", "c", "d", "e", "f"]) {
      const got = pickVisualSystem({ ...base, paletteSeed: seed, preferred: { ground: "grid", accentForm: "band" } });
      expect(got.ground, seed).toBe("grid");
      expect(got.accentForm, seed).toBe("band");
      expect(got.reason).toMatch(/matches 2 axis/u);
    }
  });

  it("never overrides the variety holds: a held system stays held even when it matches", () => {
    const grids = VISUAL_SYSTEM_CATALOG.filter((e) => e.ground === "grid" && e.accentForm === "band").map((e) => e.id);
    const got = pickVisualSystem({ ...base, preferred: { ground: "grid", accentForm: "band" }, recentOwnSystemIds: grids });
    expect(grids).not.toContain(got.systemId);
  });

  it("no preference is today's draw, byte for byte", () => {
    expect(pickVisualSystem({ ...base })).toEqual(pickVisualSystem({ ...base, preferred: undefined }));
  });
});
