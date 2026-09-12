import { describe, expect, it } from "vitest";
import {
  EMPTY_SKELETON_HISTORY,
  MIN_SKELETON_DISTANCE,
  SKELETON_AVOID_WINDOW,
  SKELETON_BELIEF_KEY,
  SKELETON_HISTORY_LIMIT,
  SKELETON_RULE_SENTENCE,
  adjacentRepeatWarnings,
  archetypeTokenFor,
  buildSkeletonEntry,
  checkSkeletonVariety,
  previousSkeleton,
  readSkeletonHistory,
  recordSkeleton,
  rolesForSlideCount,
  skeletonAvoidList,
  skeletonDistance,
  skeletonGateFacts,
  skeletonSignature,
  type SkeletonEntry,
  type SkeletonHistory,
} from "../src/workflow/skeleton-memory.js";
import { topicDecisionSummary } from "../src/workflow/topic-selection.js";

/** Six slides: cover, a stat, two photos, a quote, a closer — the canonical shape. */
function sixSlides(): Array<{ n: number; template: string; hasImage?: boolean }> {
  return [
    { n: 1, template: "cover.html", hasImage: true },
    { n: 2, template: "stat-callout.html" },
    { n: 3, template: "slide.html", hasImage: true },
    { n: 4, template: "slide.html", hasImage: true },
    { n: 5, template: "quote-card.html" },
    { n: 6, template: "closer.html" },
  ];
}

function entry(overrides: Partial<SkeletonEntry> & { runId: string; signature: string }): SkeletonEntry {
  return {
    at: "2026-09-01T00:00:00.000Z",
    archetypes: [],
    deviceKinds: [],
    roles: [],
    occupancy: [],
    edited: false,
    ...overrides,
  };
}

function historyOf(...entries: SkeletonEntry[]): SkeletonHistory {
  return { version: 1, entries };
}

describe("skeleton-memory (item P): the signature", () => {
  it("keeps ORDER and DUPLICATES, which is exactly what topicDecisionSummary's archetype set throws away", () => {
    const signature = skeletonSignature(sixSlides());
    expect(signature).toBe("cover:cover>interior:stat_callout>interior:photo>interior:photo>interior:quote_card>closer:closer");

    // The contrast is the whole argument for a new belief key rather than
    // reformatting the decision summary (spec P: A's reformat was rejected).
    // The summary de-duplicates, so the two photo slides collapse into one
    // token and a four-slide post and a six-slide post can render the same
    // segment.
    const summary = topicDecisionSummary({
      topic: "x",
      mode: "deep-value",
      source: "trend",
      archetypes: ["cover", "stat_callout", "photo", "photo", "quote_card", "closer"],
    });
    const archetypeSegment = summary.split(";").find((s) => s.includes("archetypes"))!;
    expect(archetypeSegment.match(/photo/gu)).toHaveLength(1);
    expect(skeletonSignature(sixSlides()).match(/photo/gu)).toHaveLength(2);
  });

  it("strips `-inv` and the extension through templateBasename, so IGSTYLE-10's inversion is not a different design", () => {
    expect(archetypeTokenFor("stat-callout-inv.html")).toBe("stat_callout");
    expect(archetypeTokenFor("/abs/path/to/quote-card.html")).toBe("quote_card");
    expect(archetypeTokenFor("list-takeaway")).toBe("list_takeaway");
    expect(
      skeletonSignature([
        { n: 1, template: "cover-inv.html", hasImage: true },
        { n: 2, template: "assets/templates/default/stat-callout-inv.html" },
      ]),
    ).toBe("cover:cover>closer:stat_callout");
  });

  it("separates `photo` from `text_only` on the client's shared base template by whether an image landed", () => {
    // Both layouts resolve to the client's own `slideTemplate`, so the
    // filename cannot tell them apart and they are the two commonest slides.
    expect(archetypeTokenFor("slide.html", true)).toBe("photo");
    expect(archetypeTokenFor("slide.html", false)).toBe("text_only");
    expect(archetypeTokenFor("some-client-base.html")).toBe("text_only");
  });

  it("keeps a custom design's own id, because auto-promotion depends on telling two custom designs apart", () => {
    expect(archetypeTokenFor("custom-bold-diagonal.html")).toBe("custom_bold_diagonal");
  });

  it("appends the device kind, so moving a device is a real way to satisfy the variety rule", () => {
    const withDevice = skeletonSignature(sixSlides(), rolesForSlideCount(6), [undefined, "bars", "", "", "", ""]);
    expect(withDevice).toContain("interior:stat_callout+bars");
    expect(skeletonDistance({ signature: withDevice }, { signature: skeletonSignature(sixSlides()) })).toBeGreaterThan(0);
  });

  it("puts slide 1 at cover, the last slide at closer, and a one-slide post at cover", () => {
    expect(rolesForSlideCount(6)).toEqual(["cover", "interior", "interior", "interior", "interior", "closer"]);
    expect(rolesForSlideCount(1)).toEqual(["cover"]);
    expect(rolesForSlideCount(2)).toEqual(["cover", "closer"]);
    expect(rolesForSlideCount(0)).toEqual([]);
  });
});

describe("skeleton-memory (item P): distance", () => {
  const base = skeletonSignature(sixSlides());

  function swap(n: number, template: string): string {
    const slides = sixSlides();
    slides[n - 1] = { n, template };
    return skeletonSignature(slides);
  }

  it("is 0 for identical, ~0.17 for one swap in six, and >= MIN_SKELETON_DISTANCE for two", () => {
    expect(skeletonDistance({ signature: base }, { signature: base })).toBe(0);
    expect(skeletonDistance({ signature: base }, { signature: swap(2, "list-takeaway.html") })).toBe(0.17);

    const slides = sixSlides();
    slides[1] = { n: 2, template: "list-takeaway.html" };
    slides[4] = { n: 5, template: "comparison-card.html" };
    const twoSwaps = skeletonSignature(slides);
    expect(skeletonDistance({ signature: base }, { signature: twoSwaps })).toBe(0.34);
    // The constant's own claim: 0.34 means "at least two of six positions
    // must differ". One swap is below it, two is not.
    expect(skeletonDistance({ signature: base }, { signature: swap(2, "list-takeaway.html") })).toBeLessThan(MIN_SKELETON_DISTANCE);
    expect(skeletonDistance({ signature: base }, { signature: twoSwaps })).toBeGreaterThanOrEqual(MIN_SKELETON_DISTANCE);
  });

  it("counts a length difference as a mismatch per surplus position", () => {
    const seven = skeletonSignature([...sixSlides(), { n: 7, template: "closer.html" }]);
    // Position 6 changes (closer becomes interior) and position 7 exists in
    // only one of the two: 2 mismatches over 7 positions, reported as 0.29.
    expect(skeletonDistance({ signature: base }, { signature: seven })).toBe(0.29);
  });

  it("is 1 when nothing agrees, and 0 when both are empty", () => {
    expect(skeletonDistance({ signature: "cover:cover" }, { signature: "cover:photo" })).toBe(1);
    expect(skeletonDistance({ signature: "" }, { signature: "" })).toBe(0);
  });
});

describe("skeleton-memory (item P): the history", () => {
  it("skeletonAvoidList returns the newest SKELETON_AVOID_WINDOW signatures, newest first", () => {
    const history = historyOf(...Array.from({ length: 8 }, (_, i) => entry({ runId: `run_${i}`, signature: `sig_${i}` })));
    const list = skeletonAvoidList(history);
    expect(list).toHaveLength(SKELETON_AVOID_WINDOW);
    expect(list[0]).toBe("sig_7");
    expect(list.at(-1)).toBe("sig_3");
  });

  it("recordSkeleton caps at SKELETON_HISTORY_LIMIT and is IDEMPOTENT per runId, so a resumed delivery cannot double-write", () => {
    let history: SkeletonHistory = { ...EMPTY_SKELETON_HISTORY, entries: [] };
    for (let i = 0; i < SKELETON_HISTORY_LIMIT + 4; i += 1) {
      history = recordSkeleton(history, entry({ runId: `run_${i}`, signature: `sig_${i}` }));
    }
    expect(history.entries).toHaveLength(SKELETON_HISTORY_LIMIT);
    expect(history.entries[0]!.runId).toBe("run_4");

    const before = history;
    const replayed = recordSkeleton(history, entry({ runId: "run_13", signature: "a different signature for the same run" }));
    expect(replayed).toBe(before);
    expect(previousSkeleton(replayed)!.signature).toBe("sig_13");
  });

  it("readSkeletonHistory round-trips through the belief key and survives anything a hand edit left there", () => {
    const written = recordSkeleton({ version: 1, entries: [] }, buildSkeletonEntry({
      runId: "run_a",
      at: "2026-09-09T10:00:00.000Z",
      slides: sixSlides(),
      devices: [undefined, "bars"],
      occupancy: [0.4567, 0.512, 0.33, 0.31, 0.44, 0.48],
      edited: true,
    }));
    const roundTripped = readSkeletonHistory({ [SKELETON_BELIEF_KEY]: written });
    expect(roundTripped).toEqual(written);
    expect(roundTripped.entries[0]!.occupancy[0]).toBe(0.46);
    expect(roundTripped.entries[0]!.deviceKinds).toEqual(["", "bars", "", "", "", ""]);
    expect(roundTripped.entries[0]!.edited).toBe(true);

    expect(readSkeletonHistory(undefined).entries).toEqual([]);
    expect(readSkeletonHistory({ [SKELETON_BELIEF_KEY]: "nonsense" }).entries).toEqual([]);
    expect(readSkeletonHistory({ [SKELETON_BELIEF_KEY]: { entries: [{ nope: 1 }, { runId: "r", signature: "s" }] } }).entries).toEqual([
      { runId: "r", at: "", signature: "s", archetypes: [], deviceKinds: [], roles: [], occupancy: [], edited: false },
    ]);
  });

  it("buildSkeletonEntry leaves occupancy EMPTY rather than zero-filled when nothing was measured", () => {
    // A reader of the history has to be able to tell "flat" from
    // "unmeasured": a zero-filled row would look like six empty slides.
    const built = buildSkeletonEntry({ runId: "run_b", at: "now", slides: sixSlides(), edited: false });
    expect(built.occupancy).toEqual([]);
    expect(built.archetypes).toEqual(["cover", "stat_callout", "photo", "photo", "quote_card", "closer"]);
    expect(built.roles).toEqual(rolesForSlideCount(6));
  });
});

describe("skeleton-memory (item P): 07k's verdict", () => {
  const base = skeletonSignature(sixSlides());
  const last = historyOf(entry({ runId: "run_last", signature: base }));

  it("passes and says nothing when the client has no history", () => {
    const verdict = checkSkeletonVariety({ version: 1, entries: [] }, { signature: base }, { attempt: 1, maxAttempts: 3 });
    expect(verdict).toMatchObject({ ok: true, action: "pass", repeatedPrevious: false });
    expect(verdict.previous).toBeUndefined();
    expect(verdict.recent).toEqual([]);
  });

  it("HARD clause: an exact repeat of the previous post returns to 05 naming BOTH sequences", () => {
    const verdict = checkSkeletonVariety(last, { signature: base }, { attempt: 1, maxAttempts: 3 });
    expect(verdict.ok).toBe(false);
    expect(verdict.action).toBe("return");
    expect(verdict.kind).toBe("repeat");
    expect(verdict.repeatedPrevious).toBe(true);
    expect(verdict.reason).toContain(base);
    expect(verdict.reason).toContain("identical to the previous post's");
    expect(verdict.reason).toContain("starting with the cover");
  });

  it("SOFT clause: a one-swap near-match returns on attempt 1 and only WARNS from attempt 2", () => {
    const slides = sixSlides();
    slides[1] = { n: 2, template: "list-takeaway.html" };
    const near = skeletonSignature(slides);
    expect(skeletonDistance({ signature: near }, { signature: base })).toBe(0.17);

    const first = checkSkeletonVariety(last, { signature: near }, { attempt: 1, maxAttempts: 3 });
    expect(first).toMatchObject({ ok: false, action: "return", kind: "near-repeat" });
    expect(first.reason).toContain("0.17");
    expect(first.reason).toContain(String(MIN_SKELETON_DISTANCE));

    const second = checkSkeletonVariety(last, { signature: near }, { attempt: 2, maxAttempts: 3 });
    expect(second).toMatchObject({ ok: true, action: "warn", kind: "near-repeat" });
    expect(second.reason).toContain("0.17");
  });

  it("two changed positions clear the floor and pass", () => {
    const slides = sixSlides();
    slides[1] = { n: 2, template: "list-takeaway.html" };
    slides[4] = { n: 5, template: "comparison-card.html" };
    const verdict = checkSkeletonVariety(last, { signature: skeletonSignature(slides) }, { attempt: 1, maxAttempts: 3 });
    expect(verdict).toMatchObject({ ok: true, action: "pass", repeatedPrevious: false, distance: 0.34 });
    expect(verdict.reason).toBeUndefined();
  });

  it("on the FINAL attempt even an exact repeat SHIPS: repetition must never become a fourth hold cause", () => {
    const verdict = checkSkeletonVariety(last, { signature: base }, { attempt: 3, maxAttempts: 3 });
    expect(verdict.ok).toBe(true);
    expect(verdict.action).toBe("warn");
    expect(verdict.repeatedPrevious).toBe(true);
    expect(verdict.reason).toContain("identical to the previous post's");
  });

  it("warns, never fails, on two adjacent slides that share an archetype AND an occupancy bucket", () => {
    const signature = skeletonSignature(sixSlides());
    // Slides 3 and 4 are both `photo`. Same bucket warns; different buckets do not.
    expect(adjacentRepeatWarnings(signature, [0.5, 0.4, 0.31, 0.33, 0.45, 0.5])).toEqual([
      expect.stringContaining("slides 3 and 4"),
    ]);
    expect(adjacentRepeatWarnings(signature, [0.5, 0.4, 0.31, 0.48, 0.45, 0.5])).toEqual([]);
    // Unmeasured slides produce no warning rather than a false one.
    expect(adjacentRepeatWarnings(signature, [])).toEqual([]);

    const slides = sixSlides();
    slides[1] = { n: 2, template: "list-takeaway.html" };
    slides[4] = { n: 5, template: "comparison-card.html" };
    const verdict = checkSkeletonVariety(last, { signature: skeletonSignature(slides), occupancy: [0.5, 0.4, 0.31, 0.33, 0.45, 0.5] }, { attempt: 1, maxAttempts: 3 });
    expect(verdict.ok).toBe(true);
    expect(verdict.action).toBe("warn");
    expect(verdict.warnings[0]).toContain("read as one slide shown twice");
  });

  it("skeletonGateFacts is exactly the five fields item P.3 puts on the gate payload", () => {
    const verdict = checkSkeletonVariety(last, { signature: base }, { attempt: 1, maxAttempts: 3 });
    expect(Object.keys(skeletonGateFacts(verdict)).sort()).toEqual(["distance", "previous", "recent", "repeatedPrevious", "signature"]);
    expect(skeletonGateFacts(verdict).previous).toBe(base);
  });

  it("the sentence the writer is told is the same string the code enforces", () => {
    // A prompt asking for something the code does not check, or checking
    // something the prompt never asked for, is the defect this phase keeps
    // finding. §21 of instagram-copy@14 carries this verbatim.
    expect(SKELETON_RULE_SENTENCE).toContain("Do not reproduce any of them");
    expect(SKELETON_RULE_SENTENCE).toContain("At least two positions must differ from the most recent");
    expect(SKELETON_RULE_SENTENCE).toContain("the cover's archetype must differ from last week's");
  });
});
