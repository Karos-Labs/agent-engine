import { describe, expect, it } from "vitest";
import { repairMergedEntriesDeep, repairMergedListEntries } from "../src/repair-merged-entries.js";

/**
 * The string below is verbatim from prep run `pubsub-21214555443299035`
 * (karoslabs, 2026-09-17) — the first real run of `intel-report-craft@7`. It
 * is the ONE artifact in 82,427 characters of otherwise excellent output, and
 * it is a data-loss bug rather than a cosmetic one: the brand's banned-terms
 * list lost `cutting-edge` entirely and gained an entry no writer could act on.
 */
const MERGED_FROM_PREP = 'AI-powered" (without a specific business outcome attached),\n      "cutting-edge';

describe("repairMergedListEntries", () => {
  it("splits the entry that prep actually produced, recovering the lost term", () => {
    const banned = ["leveraging machine learning", MERGED_FROM_PREP, "synergy", "seamless"];

    const repaired = repairMergedListEntries(banned);

    expect(repaired).toContain("cutting-edge");
    expect(repaired).toContain("AI-powered (without a specific business outcome attached)");
    // Nothing else moved.
    expect(repaired[0]).toBe("leveraging machine learning");
    expect(repaired.slice(-2)).toEqual(["synergy", "seamless"]);
    expect(repaired).toHaveLength(5);
  });

  /**
   * The guard on the guard. A repair that fires on healthy entries would
   * quietly shred every list in the report, and these lists are read by every
   * publishing agent — so the cases it must NOT touch are pinned harder than
   * the case it must.
   */
  it("leaves a quoted phrase alone — a quote is not the signature, the pair is", () => {
    const phrases = ['"Not a tool. A system." — quoted from site-audit: homepage', 'He said "no" and meant it'];
    expect(repairMergedListEntries(phrases)).toBe(phrases);
  });

  it("leaves a multi-line entry with no quote alone", () => {
    const rules = ["Open on the number.\nNever on the product."];
    expect(repairMergedListEntries(rules)).toBe(rules);
  });

  it("returns the very same array when nothing matched, so a caller can tell", () => {
    const clean = ["synergy", "seamless"];
    expect(repairMergedListEntries(clean)).toBe(clean);
  });

  it("never empties a list, even when a match cleans down to nothing", () => {
    const debris = ['",\n   "'];
    expect(repairMergedListEntries(debris)).toEqual(debris);
  });
});

describe("repairMergedEntriesDeep", () => {
  it("reaches a string array nested inside the report's blocks", () => {
    const report = {
      brandVoiceSpec: {
        bannedTerms: ["leveraging machine learning", MERGED_FROM_PREP],
        platformVoice: [{ platform: "LinkedIn", guidance: 'Say "no" to generic thought leadership' }],
      },
      overallScore: 71,
      competitors: [{ company: "Northwind", keyStrengths: ["scale"] }],
    };

    const out = repairMergedEntriesDeep(report);

    expect(out.brandVoiceSpec.bannedTerms).toContain("cutting-edge");
    // Everything that is not a string array is untouched, including a quote
    // inside an object's string field.
    expect(out.overallScore).toBe(71);
    expect(out.brandVoiceSpec.platformVoice[0]!.guidance).toBe('Say "no" to generic thought leadership');
    expect(out.competitors[0]!.keyStrengths).toEqual(["scale"]);
  });
});
