import { describe, expect, it } from "vitest";
import { CLIP_SOURCE_TIERS, clipLicenseConfidence, type ClipSourceTier } from "../src/workflow/types.js";

/**
 * Whose recording the clip is of, at the gate that decides whether to publish
 * forty seconds of it.
 *
 * RFC-25 rests its whole case on `11-clip-review` being "the real protection"
 * for a clip of somebody else's podcast — the allowlist was "a second line,
 * not the first". A gate is only a protection if the thing being protected
 * against is legible at it, and on the day open discovery shipped the gate
 * carried the source TIER and nothing else. `web-harvest` read identically
 * whether the show was one the client clears every week or one a search
 * turned up ninety seconds earlier.
 *
 * These tests pin the two facts that separate those cases, because the
 * separation is the entire point of the field.
 */
describe("clipLicenseConfidence", () => {
  it("separates a cleared show from an open search, on the SAME tier", () => {
    // The pair the field exists for. Both are `web-harvest`; only one of them
    // is footage somebody decided in advance was theirs to clip.
    expect(clipLicenseConfidence("web-harvest", "allowlist")).toBe("client-cleared");
    expect(clipLicenseConfidence("web-harvest", "open")).toBe("unknown");
  });

  it("calls a pasted link unknown, even though the client chose it", () => {
    // The row most likely to read as a bug. Choosing a recording is not the
    // same as holding a right to republish part of it: somebody pasting a
    // link to a show they like has decided what to clip, not what they may
    // clip. The reviewer is better served knowing which of the two they have.
    expect(clipLicenseConfidence("user-asset", "pasted")).toBe("unknown");
  });

  it("calls the client's own file theirs", () => {
    // An upload, and a hand-dispatched sourcePath, both arrive with no
    // discovery at all — there was no search to have a posture about.
    expect(clipLicenseConfidence("user-asset", undefined)).toBe("client-provided");
    expect(clipLicenseConfidence("owned-footage", undefined)).toBe("client-provided");
  });

  it("calls stock and generated footage licensed", () => {
    expect(clipLicenseConfidence("stock", undefined)).toBe("stock-licensed");
    expect(clipLicenseConfidence("generated", undefined)).toBe("stock-licensed");
  });

  it("is a total map — every tier crossed with every posture, written out", () => {
    // Asserting "the answer is one of the four" would pass for any function
    // at all, because the return TYPE already says that. So the whole grid is
    // written out instead: twenty rows, each the value this run would show a
    // reviewer. A tier or a posture added later has no row here and fails,
    // which is the point — the alternative is a new tier quietly inheriting
    // the `unknown` default and a client's own footage being labelled as
    // somebody else's.
    const grid: Array<[ClipSourceTier, "allowlist" | "open" | "pasted" | undefined, string]> = [
      ["user-asset", undefined, "client-provided"],
      ["user-asset", "allowlist", "client-provided"],
      ["user-asset", "open", "client-provided"],
      ["user-asset", "pasted", "unknown"],
      ["owned-footage", undefined, "client-provided"],
      ["owned-footage", "allowlist", "client-provided"],
      ["owned-footage", "open", "client-provided"],
      ["owned-footage", "pasted", "client-provided"],
      ["web-harvest", undefined, "unknown"],
      ["web-harvest", "allowlist", "client-cleared"],
      ["web-harvest", "open", "unknown"],
      ["web-harvest", "pasted", "unknown"],
      ["podcast-feed", undefined, "unknown"],
      ["podcast-feed", "allowlist", "client-cleared"],
      ["podcast-feed", "open", "unknown"],
      ["podcast-feed", "pasted", "unknown"],
      ["stock", undefined, "stock-licensed"],
      ["stock", "allowlist", "stock-licensed"],
      ["stock", "open", "stock-licensed"],
      ["stock", "pasted", "stock-licensed"],
      ["generated", undefined, "stock-licensed"],
      ["generated", "allowlist", "stock-licensed"],
      ["generated", "open", "stock-licensed"],
      ["generated", "pasted", "stock-licensed"],
    ];
    for (const [tier, posture, expected] of grid) {
      expect(clipLicenseConfidence(tier, posture), `${tier} / ${posture ?? "no posture"}`).toBe(expected);
    }
    // The grid is a hand-written list, so on its own it would simply not
    // mention a tier added later. Checking it against the exported tier
    // values is what turns "no row" into a failure — the thing the paragraph
    // above claims and, until 2026-09-21, did not do.
    expect([...new Set(grid.map(([tier]) => tier))].sort()).toEqual([...CLIP_SOURCE_TIERS].sort());
  });
});
