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
    // S1 (2026-09-26): the client's own posts vote only when the judge graded them 4+; weaker ones never do.
    expect(exemplarLook(library([entry({ groundStyle: "flat-dark" }, 3, "client"), entry({ groundStyle: "flat-dark" }, 3, "client")]))).toBeUndefined();
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

describe("the client's own strong posts lead (S1, owner 2026-09-26: Deel's own posts are prettier)", () => {
  it("a client post graded 4+ votes twice, so two of them outvote three references", () => {
    const look = exemplarLook(library([
      entry({ groundStyle: "flat-light" }, 5, "client"),
      entry({ groundStyle: "flat-light" }, 4, "client"),
      entry({ groundStyle: "texture" }),
      entry({ groundStyle: "texture" }),
      entry({ groundStyle: "texture" }),
    ]))!;
    expect(look.ground).toBe("flat");
    expect(look.basis[0]).toMatch(/ground flat \(4 of 7/u);
  });

  it("the harvest tries the client's handle from another platform before its website's link", async () => {
    const { planHarvest } = await import("../src/workflow/exemplar-library.js");
    const plan = planHarvest({ ownAccounts: [{ platform: "x", username: "deelpitch" }], referenceAccounts: [], competitors: [], ownWebsite: "https://deel.com" });
    expect(plan.accounts.find((a) => a.role === "client")?.handle).toBe("deelpitch");
    expect(plan.competitorSites.some((c) => c.role === "client")).toBe(false);
    const fromBrief = planHarvest({ ownAccounts: [], ownHandlesElsewhere: ["deelpitch"], referenceAccounts: [], competitors: [], ownWebsite: "https://deel.com" });
    expect(fromBrief.accounts.find((a) => a.role === "client")?.handle).toBe("deelpitch");
    // An Instagram account on file still wins outright.
    const onFile = planHarvest({ ownAccounts: [{ platform: "instagram", username: "thepitch" }, { platform: "x", username: "deelpitch" }], referenceAccounts: [], competitors: [] });
    expect(onFile.accounts.filter((a) => a.role === "client").map((a) => a.handle)).toEqual(["thepitch"]);
  });
});
