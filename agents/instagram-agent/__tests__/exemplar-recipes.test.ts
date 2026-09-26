import { describe, expect, it } from "vitest";
import type { ExemplarLibrary } from "../src/workflow/exemplar-library.js";
import { exemplarRecipes, MAX_RECIPES, MAX_RECIPES_PER_ACCOUNT, pickRecipe, recipeBasis } from "../src/workflow/exemplar-recipes.js";

/** Templates from the harvest (2026-09-26): each run styled after one strong, high-traffic harvested post. */
const entry = (handle: string, dna: Record<string, string>, craft = 5, lift = 5, role: "reference" | "competitor" | "client" = "reference") => ({
  handle, role, format: "carousel", frameCount: 6, lift, craft, dna, standout: `technique of ${handle}`, hook: "h", storedFrames: [`gs://b/${handle}.jpg`],
});
const library = (entries: ReturnType<typeof entry>[]): ExemplarLibrary => ({ version: 1, builtAt: "2026-09-26T00:00:00Z", status: "built", problems: [], accounts: [], entries });

describe("exemplarRecipes", () => {
  it("turns the strongest posts into render axes, ranked by what they earned and how well they are made", () => {
    const rs = exemplarRecipes(library([
      entry("a16z", { groundStyle: "flat-dark", emphasis: "highlight-block", textDensity: "low", coverType: "photo-framed" }, 5, 9),
      entry("small", { groundStyle: "texture", emphasis: "underline", textDensity: "high", coverType: "typographic" }, 4, 1),
    ]));
    expect(rs[0]!.handle).toBe("a16z");
    expect(rs[0]).toMatchObject({ ground: "flat", accentForm: "band", typeScale: "display", cover: "sandwich" }); // photo-framed votes framed and sandwich equally; the tie is the picture-over-type sandwich
    expect(recipeBasis(rs[0]!)).toMatch(/styled after @a16z \(reference, 9\.0x its account's median, craft 5\)/u);
  });

  it("never takes a weak post, and caps one account so the rotation spans the category", () => {
    const many = Array.from({ length: 5 }, (_, i) => entry("one", { groundStyle: i % 2 ? "flat-dark" : "texture", emphasis: ["underline", "highlight-block", "colour-word", "weight", "none"][i]!, textDensity: "low", coverType: "product" }));
    const rs = exemplarRecipes(library([...many, entry("weak", { groundStyle: "flat-dark", emphasis: "underline", textDensity: "low", coverType: "product" }, 3)]));
    expect(rs.filter((r) => r.handle === "one").length).toBe(MAX_RECIPES_PER_ACCOUNT);
    expect(rs.some((r) => r.handle === "weak")).toBe(false);
    expect(rs.length).toBeLessThanOrEqual(MAX_RECIPES);
  });

  it("picks one recipe per run, seeded, and different runs draw different templates", () => {
    const rs = exemplarRecipes(library([
      entry("a", { groundStyle: "flat-dark", textDensity: "low", coverType: "product" }),
      entry("b", { groundStyle: "texture", textDensity: "medium", coverType: "photo-full-bleed" }),
      entry("c", { groundStyle: "flat-light", textDensity: "high", coverType: "photo-framed" }),
    ]));
    expect(pickRecipe(rs, "run-x")).toEqual(pickRecipe(rs, "run-x"));
    const handles = new Set(Array.from({ length: 30 }, (_, i) => pickRecipe(rs, `pubsub-2${i}`)!.handle));
    expect(handles.size).toBeGreaterThan(1);
    expect(pickRecipe([], "x")).toBeUndefined();
    expect(exemplarRecipes(undefined)).toEqual([]);
  });
});
