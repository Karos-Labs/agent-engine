import { describe, expect, it } from "vitest";
import {
  classifyFeedbackRound,
  applyStructuralDelta,
  snapshotKeeps,
  checkKeepsViolated,
  revertFrozenViolations,
  touchedSections,
  extractExplicitHexValue,
  type DurableBuildState,
  type FeedbackRound,
} from "../src/workflow/feedback.js";

function baseRound(overrides: Partial<FeedbackRound> = {}): FeedbackRound {
  return {
    round: 1,
    client: "forge",
    reviewedBuild: "v1",
    submittedAt: "2026-06-26T14:00:00Z",
    source: "portal",
    changes: [],
    additions: [],
    removals: [],
    keeps: [],
    ...overrides,
  };
}

describe("classifyFeedbackRound", () => {
  it("classifies edit/tone as in-scope edits", () => {
    const round = baseRound({
      changes: [
        { section: "hero", op: "edit", target: "headline", note: "punchier", verbatim: "make it punchier", severity: "high" },
        { section: "global", op: "tone", target: "voice.tone", note: "warmer", verbatim: "warmer please", severity: "normal" },
      ],
    });
    const result = classifyFeedbackRound(round);
    expect(result.edits).toHaveLength(2);
    expect(result.outOfScope).toHaveLength(0);
  });

  it("classifies a token-value restyle (not identity) as in-scope", () => {
    const round = baseRound({
      changes: [{ section: "global", op: "restyle", target: "tokens.colors.ember", note: "more orange, like #FF5A1A", verbatim: "make the orange more orange", severity: "normal" }],
    });
    const result = classifyFeedbackRound(round);
    expect(result.restyles).toHaveLength(1);
    expect(result.outOfScope).toHaveLength(0);
  });

  it("classifies a font-family restyle as out-of-scope (brand identity change)", () => {
    const round = baseRound({
      changes: [{ section: "global", op: "restyle", target: "fonts.display", note: "switch to a serif", verbatim: "different font please", severity: "normal" }],
    });
    const result = classifyFeedbackRound(round);
    expect(result.restyles).toHaveLength(0);
    expect(result.outOfScope).toHaveLength(1);
    expect(result.outOfScope[0]!.reason).toMatch(/brand-identity/);
  });

  it("classifies a ground (light/dark) restyle as out-of-scope", () => {
    const round = baseRound({
      changes: [{ section: "global", op: "restyle", target: "tokens.ground", note: "make it light mode", verbatim: "go light", severity: "normal" }],
    });
    const result = classifyFeedbackRound(round);
    expect(result.outOfScope).toHaveLength(1);
  });

  it("classifies an addition to a taxonomy section as in-scope", () => {
    const round = baseRound({ additions: [{ section: "faq", reason: "refund questions", contentHints: ["refunds"], afterSection: "offering" }] });
    const result = classifyFeedbackRound(round);
    expect(result.additions).toHaveLength(1);
    expect(result.outOfScope).toHaveLength(0);
  });

  it("classifies an addition of a non-taxonomy section as out-of-scope", () => {
    const round = baseRound({ additions: [{ section: "testimonial-wall", reason: "client wants a new pattern", contentHints: [] }] });
    const result = classifyFeedbackRound(round);
    expect(result.additions).toHaveLength(0);
    expect(result.outOfScope).toHaveLength(1);
    expect(result.outOfScope[0]!.reason).toMatch(/not in the section taxonomy/);
  });

  it("classifies a removal of an optional section as in-scope", () => {
    const round = baseRound({ removals: [{ section: "proofStrip", reason: "numbers feel thin" }] });
    const result = classifyFeedbackRound(round);
    expect(result.removals).toHaveLength(1);
  });

  it("refuses to classify a removal of a required section (nav/hero/footer) as in-scope", () => {
    const round = baseRound({ removals: [{ section: "hero", reason: "client wants no hero" }] });
    const result = classifyFeedbackRound(round);
    expect(result.removals).toHaveLength(0);
    expect(result.outOfScope).toHaveLength(1);
  });

  it("never drops anything — every classified item is either in-scope or in outOfScope with a reason", () => {
    const round = baseRound({
      changes: [{ section: "global", op: "restyle", target: "fonts.display", note: "x", verbatim: "x", severity: "normal" }],
      additions: [{ section: "bogus-section", reason: "x", contentHints: [] }],
      removals: [{ section: "footer", reason: "x" }],
    });
    const result = classifyFeedbackRound(round);
    expect(result.outOfScope).toHaveLength(3);
    for (const item of result.outOfScope) expect(item.reason.length).toBeGreaterThan(0);
  });
});

describe("applyStructuralDelta", () => {
  function state(): DurableBuildState {
    return {
      manifest: ["nav", "hero", "proofStrip", "offering", "footer"],
      content: { nav: {}, hero: {}, proofStrip: { stats: [1, 2, 3] }, offering: {}, footer: {} },
    };
  }

  it("removes an in-scope section from the manifest and drops its content", () => {
    const round = baseRound({ removals: [{ section: "proofStrip", reason: "thin numbers" }] });
    const classified = classifyFeedbackRound(round);
    const result = applyStructuralDelta(state(), classified);
    expect(result.manifest).not.toContain("proofStrip");
    expect(result.content["proofStrip"]).toBeUndefined();
    expect(result.removedSections).toEqual(["proofStrip"]);
  });

  it("adds a new taxonomy section, clamped before the trailing footer slot", () => {
    const round = baseRound({ additions: [{ section: "faq", reason: "refund questions", contentHints: [], afterSection: "offering" }] });
    const classified = classifyFeedbackRound(round);
    const result = applyStructuralDelta(state(), classified);
    expect(result.manifest).toEqual(["nav", "hero", "proofStrip", "offering", "faq", "footer"]);
    expect(result.addedSections).toEqual(["faq"]);
  });

  it("never inserts a new section after the trailing footer slot", () => {
    const round = baseRound({ additions: [{ section: "faq", reason: "x", contentHints: [], afterSection: "footer" }] });
    const classified = classifyFeedbackRound(round);
    const result = applyStructuralDelta(state(), classified);
    expect(result.manifest[result.manifest.length - 1]).toBe("footer");
  });

  it("is idempotent when applied twice with the same classified delta (fixed order guarantees the same result)", () => {
    const round = baseRound({ removals: [{ section: "proofStrip", reason: "x" }], additions: [{ section: "faq", reason: "x", contentHints: [] }] });
    const classified = classifyFeedbackRound(round);
    const once = applyStructuralDelta(state(), classified);
    const twice = applyStructuralDelta(once, classified);
    expect(twice.manifest).toEqual(once.manifest);
  });

  it("reorders an array field within a section's own content — never a silent no-op", () => {
    const withPlans: DurableBuildState = {
      manifest: ["nav", "hero", "offering", "footer"],
      content: {
        offering: {
          plans: [
            { name: "Starter", price: "$0" },
            { name: "Pro", price: "$12" },
            { name: "Elite", price: "$29" },
          ],
        },
      },
    };
    const round = baseRound({ changes: [{ section: "offering", op: "reorder", target: "plans[]:Elite,Pro,Starter", note: "lead with Elite", verbatim: "put Elite first", severity: "normal" }] });
    const classified = classifyFeedbackRound(round);
    const result = applyStructuralDelta(withPlans, classified);
    expect((result.content["offering"] as { plans: Array<{ name: string }> }).plans.map((p) => p.name)).toEqual(["Elite", "Pro", "Starter"]);
    expect(result.unresolvedReorders).toHaveLength(0);
  });

  it("appends unmentioned array elements at the end, in their original order", () => {
    const withPlans: DurableBuildState = {
      manifest: ["nav", "hero", "offering", "footer"],
      content: { offering: { plans: [{ name: "Starter" }, { name: "Pro" }, { name: "Elite" }] } },
    };
    const round = baseRound({ changes: [{ section: "offering", op: "reorder", target: "plans[]:Elite", note: "x", verbatim: "x", severity: "normal" }] });
    const classified = classifyFeedbackRound(round);
    const result = applyStructuralDelta(withPlans, classified);
    expect((result.content["offering"] as { plans: Array<{ name: string }> }).plans.map((p) => p.name)).toEqual(["Elite", "Starter", "Pro"]);
  });

  it("surfaces an unresolved reorder (unknown target syntax) instead of silently dropping it", () => {
    const round = baseRound({ changes: [{ section: "offering", op: "reorder", target: "plans", note: "move Elite tier first", verbatim: "x", severity: "normal" }] });
    const classified = classifyFeedbackRound(round);
    const before = state();
    const result = applyStructuralDelta(before, classified);
    expect(result.unresolvedReorders).toHaveLength(1);
    expect(result.unresolvedReorders[0]!.note).toBe("move Elite tier first");
  });

  it("surfaces an unresolved reorder when the named field isn't an array on that section", () => {
    const round = baseRound({ changes: [{ section: "offering", op: "reorder", target: "notAnArrayField[]:x,y", note: "x", verbatim: "x", severity: "normal" }] });
    const classified = classifyFeedbackRound(round);
    const result = applyStructuralDelta(state(), classified);
    expect(result.unresolvedReorders).toHaveLength(1);
  });
});

describe("freeze-and-diff on keeps", () => {
  it("detects and reverts a change that touched a frozen keep target", () => {
    const before: DurableBuildState = { manifest: ["nav", "hero", "signatureShowcase", "footer"], content: { signatureShowcase: { kind: "graph" } } };
    const snapshots = snapshotKeeps(before, [{ section: "signatureShowcase", note: "do not change the graph" }]);

    const after: DurableBuildState = { ...before, content: { ...before.content, signatureShowcase: { kind: "different-thing" } } };
    const violations = checkKeepsViolated(snapshots, after);
    expect(violations).toHaveLength(1);

    const reverted = revertFrozenViolations(after, snapshots, violations);
    expect(reverted.content["signatureShowcase"]).toEqual({ kind: "graph" });
  });

  it("reports no violation when a keep target is untouched", () => {
    const before: DurableBuildState = { manifest: ["nav", "hero", "footer"], content: { hero: { headline: "x" } } };
    const snapshots = snapshotKeeps(before, [{ section: "hero", note: "love it" }]);
    const violations = checkKeepsViolated(snapshots, before);
    expect(violations).toHaveLength(0);
  });
});

describe("touchedSections", () => {
  it("collects sections touched by edit/tone/restyle plus newly added sections, for the touched-set re-copy", () => {
    const round = baseRound({
      changes: [
        { section: "hero", op: "edit", target: "headline", note: "x", verbatim: "x", severity: "normal" },
        { section: "offering", op: "restyle", target: "tokens.colors.ember", note: "#FF5A1A", verbatim: "x", severity: "normal" },
        { section: "global", op: "tone", target: "voice.tone", note: "x", verbatim: "x", severity: "normal" },
      ],
    });
    const classified = classifyFeedbackRound(round);
    const touched = touchedSections(classified, ["faq"]);
    expect(touched).toEqual(new Set(["hero", "offering", "faq"]));
  });
});

describe("extractExplicitHexValue", () => {
  it("extracts an explicit hex value from a restyle's own prose", () => {
    const value = extractExplicitHexValue({ section: "global", op: "restyle", target: "tokens.colors.ember", note: "make it #FF5A1A", verbatim: "x", severity: "normal" });
    expect(value).toBe("#FF5A1A");
  });

  it("returns undefined when no explicit hex is given — never guesses a color from vague prose", () => {
    const value = extractExplicitHexValue({ section: "global", op: "restyle", target: "tokens.colors.ember", note: "make it more orange", verbatim: "more orange please", severity: "normal" });
    expect(value).toBeUndefined();
  });
});
