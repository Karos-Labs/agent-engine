import { describe, expect, it } from "vitest";
import type { ClientClassification } from "@agent-engine/workflow";
import { compileInstagramDna } from "../src/workflow/compile-dna.js";
import { seriesLibraryFor } from "../src/workflow/editorial-series.js";
import { planHarvest } from "../src/workflow/exemplar-library.js";

const classification = (over: Partial<ClientClassification>): ClientClassification => ({
  archetype: "brand",
  category: "fashion-intimates",
  involvement: "low",
  audience: "B2C",
  locale: "en",
  rationale: {},
  source: "research-2026-09-25",
  classifiedAt: "2026-09-25T00:00:00Z",
  version: 1,
  ...over,
});

describe("compileInstagramDna (v0: series affinity, imagery, peers)", () => {
  it("Kindly Yours becomes photo-first with intimates peers (was: no category, reputeforge/semrush/buffer)", () => {
    const dna = compileInstagramDna(classification({}));
    expect(dna.imagery).toBe("photo-first");
    expect(dna.peers).toContain("aerie");
    expect(dna.seriesAffinity).toEqual(["head_to_head", "by_the_numbers"]);
  });

  it("Don Techno reads music peers, not the news row", () => {
    const dna = compileInstagramDna(classification({ archetype: "publisher", category: "music-nightlife", involvement: "none" }));
    expect(dna.peers).toEqual(expect.arrayContaining(["boilerroomtv", "defected", "mixmag"]));
    expect(dna.peers).not.toContain("mixmagmagazine");
  });

  it("a pack that is not photo-led says nothing about imagery, so the library rung still decides", () => {
    expect(compileInstagramDna(classification({ archetype: "business", category: "marketing-advertising" })).imagery).toBeUndefined();
  });

  it("a category with no pack keeps the legacy fallbacks", () => {
    const dna = compileInstagramDna(classification({ archetype: "place", category: "food-restaurants" }));
    expect(dna.imagery).toBeUndefined();
    expect(dna.peers).toEqual([]);
    expect(dna.seriesAffinity).toEqual(["field_notes", "the_list"]);
  });
});

describe("the consumers read the DNA and keep the regex for the unclassified", () => {
  it("series library leans on the archetype, not the segment regex", () => {
    const withAffinity = seriesLibraryFor({ clientSlug: "karoslabs", segments: ["marketing agency"], affinity: { prefers: ["in_their_words", "the_breakdown"], basis: "business · marketing-advertising" } });
    expect(withAffinity.rule).toContain("business · marketing-advertising");
    expect(withAffinity.series.map((s) => s.id)).toEqual(expect.arrayContaining(["in_their_words", "the_breakdown"]));
    const legacy = seriesLibraryFor({ clientSlug: "karoslabs", segments: ["marketing agency"] });
    expect(legacy.segment).toBe("agency-creator");
  });

  it("harvest peers come from the pack ahead of the industry regex", () => {
    const plan = planHarvest({ ownAccounts: [], referenceAccounts: [], competitors: [], industry: "News", peers: ["boilerroomtv", "defected"] });
    // The pack's peers lead; the industry benchmarks top them up to four (2026-09-25).
    expect(plan.accounts.map((a) => a.handle).slice(0, 2)).toEqual(["boilerroomtv", "defected"]);
    expect(plan.accounts).toHaveLength(4);
    const legacy = planHarvest({ ownAccounts: [], referenceAccounts: [], competitors: [], industry: "News" });
    expect(legacy.accounts.map((a) => a.handle)).toContain("wired");
  });
});
