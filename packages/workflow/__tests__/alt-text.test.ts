import { describe, expect, it } from "vitest";
import { ALT_TEXT_MAX, altTextFor, mediaForDeliverable, type SocialMediaAsset } from "../src/index.js";

/**
 * ALT TEXT IS CLIENT-FACING COPY ON A PUBLIC POST.
 *
 * Instagram has carried per-slide alt text since it shipped; X and LinkedIn
 * attach a picture and say nothing, which the 2026-09-21 audit listed as an
 * agent-level gap. The gap never shows up in review because the reviewer can
 * see the image.
 *
 * The care is entirely in what is REFUSED. Half the strings on
 * `asset.description` are provenance rather than description -- "an image the
 * client attached to this run (no vision backend to describe it)", "generated
 * as a last resort" -- and this repo has shipped engine machinery into
 * client-visible text before. A blind reader hearing about our media cache is
 * worse than a blind reader hearing nothing, so nothing is what they get.
 */

function asset(over: Partial<SocialMediaAsset> = {}): SocialMediaAsset {
  return {
    path: ".media-cache/x/1.png",
    description: "a stock photograph of a warehouse aisle",
    provider: "pexels",
    licenseConfidence: "licensed",
    requiresCredit: false,
    ...over,
  };
}

describe("what a reader who cannot see the picture is told", () => {
  it("uses what the vision tool SAW, which is what alt text is", () => {
    const text = altTextFor(
      asset({
        inspection: { description: "Two warehouse workers scanning boxes on a pallet under fluorescent light.", subjects: ["warehouse", "pallet"] },
      }),
    );
    expect(text).toBe("Two warehouse workers scanning boxes on a pallet under fluorescent light.");
  });

  it("falls back to the subjects when the description is missing", () => {
    expect(altTextFor(asset({ description: "x", inspection: { subjects: ["bar chart", "laptop"] } }))).toBe("bar chart, laptop");
  });

  it("uses the asset's own description when it describes the picture", () => {
    expect(altTextFor(asset())).toBe("a stock photograph of a warehouse aisle");
  });
});

describe("what it refuses to say", () => {
  it("never reads out the RUN instead of the picture", () => {
    // Every one of these is a real string this pipeline produces.
    for (const description of [
      "an image the client attached to this run (no vision backend to describe it)",
      "an image the client attached to this run",
      "generated as a last resort: the post needed a visual and no real source supplied one",
      "a licensed stock photograph matching the brief",
      "the cited article's own lead image, credited",
    ]) {
      expect(altTextFor(asset({ description })), description).toBeUndefined();
    }
  });

  it("refuses a provenance sentence even when it came from the vision tool", () => {
    expect(altTextFor(asset({ description: "also provenance: attached to this run", inspection: { description: "generated as a last resort" } }))).toBeUndefined();
  });

  it("emits nothing rather than an empty string", () => {
    expect(altTextFor(asset({ description: "   ", inspection: { description: "" } }))).toBeUndefined();
  });
});

describe("the shape of the string", () => {
  it("is one line, unquoted", () => {
    const text = altTextFor(asset({ inspection: { description: '  "A man\n  holding a black bottle."  ' } }));
    expect(text).toBe("A man holding a black bottle.");
  });

  it("clamps on a word boundary, so no platform truncates it mid-word", () => {
    const long = `${"a cyclist riding past a red brick wall ".repeat(20)}end`;
    const text = altTextFor(asset({ inspection: { description: long } }))!;
    expect(text.length).toBeLessThanOrEqual(ALT_TEXT_MAX + 1);
    expect(text.endsWith("\u2026")).toBe(true);
    // CUT AT A WORD BOUNDARY: the kept text must be a prefix of the original
    // that ends where a word ends. A short last word is fine; a severed one
    // is what a reader hears as a mistake.
    const kept = text.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long.charAt(kept.length)).toBe(" ");
  });
});

describe("what the deliverable carries", () => {
  it("puts the alt text beside the picture", () => {
    const block = mediaForDeliverable({
      status: "stock",
      rationale: "r",
      attempts: [],
      asset: asset({ inspection: { description: "A cyclist waiting at a crossing." } }),
    }) as { media: Record<string, unknown> };
    expect(block.media["altText"]).toBe("A cyclist waiting at a crossing.");
  });

  it("omits the key entirely when there was nothing honest to say", () => {
    // Not an empty string: a publisher reading `altText: ""` would send an
    // empty description, which is worse than sending none.
    const block = mediaForDeliverable({
      status: "attached",
      rationale: "r",
      attempts: [],
      asset: asset({ description: "an image the client attached to this run" }),
    }) as { media: Record<string, unknown> };
    expect("altText" in block.media).toBe(false);
  });

  it("says nothing at all when the post has no picture", () => {
    const block = mediaForDeliverable({ status: "none", rationale: "no visual", attempts: [] }) as Record<string, unknown>;
    expect(block["media"]).toBeUndefined();
  });
});
