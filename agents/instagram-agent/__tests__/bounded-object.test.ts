import { describe, expect, it } from "vitest";
import {
  BOUNDED_OBJECT_LAYOUTS,
  boundedObjectFor,
  composeBoundedObjects,
  type BoundedObjectFactCard,
} from "../src/workflow/bounded-object.js";
import type { InstagramCopyOutput, InstagramSlideCopy, InstagramSlideLayout } from "../src/workflow/types.js";
import { goodCopyOutput, SIX_RESEARCH_FACTS } from "./test-helpers.js";

/**
 * # THE BOUNDED OBJECT — RFC-20 §11.4
 *
 * The module's own header carries the argument. What this file has to hold is
 * narrower and harder: **that nothing here can invent a number.**
 *
 * Prep run `pubsub-21839432908803804` shipped a display numeral reading `2`,
 * pulled out of the middle of the word `B2B`, labelled with the claim minus
 * that digit, and sourced to `salesforce.com` on the cover. Every other defect
 * in this system makes a post look bad; that one made it WRONG, with a
 * citation. This module is the compose-time caller of the same extractor, so
 * every case below that begins "never" is that incident.
 */

const FACTS: readonly BoundedObjectFactCard[] = SIX_RESEARCH_FACTS.map((f) => ({ claim: f.claim, source: f.source }));

/** One slide, with the fixture's own claim as its `sourceRef` so the source lookup hits the way a real draft's does. */
function slide(over: Record<string, unknown> = {}): InstagramSlideCopy {
  return {
    n: 3,
    headline: "Triage on arrival, not once the queue is deep",
    body: "Sorting tickets the moment they land resolved 30% more of them.",
    visualNeed: "a small team gathered around a table reviewing printed charts",
    sourceRef: SIX_RESEARCH_FACTS[1]!.claim,
    layout: "headline_focus",
    ...over,
  } as InstagramSlideCopy;
}

function copyOf(...slides: InstagramSlideCopy[]): InstagramCopyOutput {
  return { ...goodCopyOutput(), slides };
}

describe("boundedObjectFor: the object a statement plate can honestly carry", () => {
  it("builds a figure device from a figure already in the slide's own copy, sourced to the card the slide cites", () => {
    const device = boundedObjectFor(slide(), FACTS);
    expect(device).toEqual({
      kind: "figure",
      value: "30%",
      // The rest of the figure's own sentence, with the figure cut out by
      // position. Not a manufactured label.
      label: "Sorting tickets the moment they land resolved more of them.",
      source: "support dashboard export",
    });
  });

  it("reads the HEADLINE as well as the body, because a statement plate often puts its figure in the statement", () => {
    const device = boundedObjectFor(
      slide({ headline: "Five rounds of revisions became 2", body: "Writing the constraint into the brief is what did it.", sourceRef: SIX_RESEARCH_FACTS[4]!.claim }),
      FACTS,
    );
    expect(device?.value).toBe("2");
    expect(device?.source).toBe("design ops retro notes");
  });

  // ───────────────────────────────────────────────────────────────────────
  // The four refusals. Each one is a way this module could have shipped a
  // number nobody wrote.
  // ───────────────────────────────────────────────────────────────────────

  it("NEVER pulls a figure out of a product name — the `B2B` incident, at the compose path this time", () => {
    for (const headline of ["Inbound pipeline loss is not a B2B product problem", "Web3 did not fix distribution", "5G changed nothing about intake", "GPT-4 writes the brief, not the strategy"]) {
      expect(boundedObjectFor(slide({ headline, body: "The teams that fixed it changed how work arrives." }), FACTS), headline).toBeUndefined();
    }
  });

  it("NEVER builds a device from a slide that cites no source, because an unsourced figure is the shape of a claim a reader should distrust", () => {
    expect(boundedObjectFor(slide({ sourceRef: undefined }), FACTS)).toBeUndefined();
    expect(boundedObjectFor(slide({ sourceRef: "   " }), FACTS)).toBeUndefined();
    // And a `sourceRef` that matches no card is the same case: the citation is
    // there in the copy and the run cannot stand behind it.
    expect(boundedObjectFor(slide({ sourceRef: "a claim no fact card carries" }), FACTS)).toBeUndefined();
  });

  it("NEVER builds one from copy with no figure in it at all — the plate goes to the floor as it is", () => {
    expect(boundedObjectFor(slide({ headline: "The team reworked its process end to end", body: "Nothing about the tooling changed." }), FACTS)).toBeUndefined();
  });

  it("NEVER reads a bare year as a statistic", () => {
    expect(boundedObjectFor(slide({ headline: "2026 was the year agencies stopped discounting", body: "The ones that held price kept their margin." }), FACTS)).toBeUndefined();
  });
});

describe("composeBoundedObjects: which plates get one, and what is recorded", () => {
  it("composes on the two statement archetypes and leaves every other one alone", () => {
    // EVERY layout, driven through the real function rather than asserted
    // against the constant — a membership test that reads the same Set the
    // code reads cannot fail.
    const layouts: InstagramSlideLayout[] = ["photo", "text_only", "stat_callout", "quote_card", "comparison_card", "list_takeaway", "headline_focus", "cover", "closer", "custom"];
    const { copy, decisions } = composeBoundedObjects(copyOf(...layouts.map((layout, i) => slide({ n: i + 1, layout }))), FACTS);
    const composed = copy.slides.filter((s) => s.device !== undefined).map((s) => s.layout);
    expect(composed.sort()).toEqual(["headline_focus", "text_only"]);
    expect(decisions.map((d) => d.layout).sort()).toEqual(["headline_focus", "text_only"]);
    expect([...BOUNDED_OBJECT_LAYOUTS].sort()).toEqual(["headline_focus", "text_only"]);
  });

  it("`photo` is excluded even though it renders the same file as `text_only`, because its subject is its photograph", () => {
    // Stated as its own case rather than folded into the sweep above: the
    // asymmetry is a decision, and an unexplained exclusion is the kind of
    // thing a later pass tidies away. The two slides below differ in exactly
    // one field and the outcome is opposite.
    const { copy } = composeBoundedObjects(copyOf(slide({ n: 1, layout: "photo" }), slide({ n: 2, layout: "text_only" })), FACTS);
    expect(copy.slides[0]!.device).toBeUndefined();
    expect(copy.slides[1]!.device).toBeDefined();
  });

  it("KEEPS a device the writer composed, because an explicit authorial decision beats a derived one", () => {
    const authored = { kind: "unit_grid", filled: 73, of: 100, label: "of teams file intake by hand" } as const;
    const { copy, decisions } = composeBoundedObjects(copyOf(slide({ n: 1, device: authored })), FACTS);
    expect(copy.slides[0]!.device).toEqual(authored);
    expect(decisions[0]).toMatchObject({ outcome: "kept" });
    // The reason names the kind, which is the point of keeping it: this
    // function only knows how to build a `figure`, and the writer reached for
    // a device it cannot express.
    expect(decisions[0]!.reason).toContain("unit_grid");
  });

  it("RECORDS a refusal with the reason, and the two reasons are different because the remedies are", () => {
    const { copy, decisions } = composeBoundedObjects(
      copyOf(
        slide({ n: 1, headline: "The team reworked its process end to end", body: "Nothing about the tooling changed." }),
        slide({ n: 2, sourceRef: undefined }),
      ),
      FACTS,
    );
    expect(copy.slides.every((s) => s.device === undefined)).toBe(true);
    expect(decisions.map((d) => d.outcome)).toEqual(["refused", "refused"]);
    expect(decisions[0]!.reason).toContain("no standalone figure");
    expect(decisions[0]!.reason).toContain("nothing was invented");
    expect(decisions[1]!.reason).toContain("cites no source");
  });

  it("returns a NEW draft and mutates nothing, so three assemblies of one attempt see the same input", () => {
    // `assembleForAttempt` runs up to three times per attempt (07c, the
    // typographic fallback at 08a, the free re-layout's re-render at 08a1c).
    // If this mutated, the second assembly would be a function of the first.
    const before = copyOf(slide({ n: 1 }));
    const snapshot = JSON.stringify(before);
    const first = composeBoundedObjects(before, FACTS);
    const second = composeBoundedObjects(before, FACTS);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(first.copy).not.toBe(before);
    expect(first.copy.slides[0]!.device).toEqual(second.copy.slides[0]!.device);
  });

  it("is idempotent: composing over its own output keeps the device and reports it as the writer's", () => {
    // This is the property `planInterestRelayout` depends on. It is handed the
    // COMPOSED copy so that it does not re-offer a device the plate already
    // wears; that only works if a second pass leaves the first one's work
    // alone, which is `kept` rather than `composed`.
    const once = composeBoundedObjects(copyOf(slide({ n: 1 })), FACTS);
    const twice = composeBoundedObjects(once.copy, FACTS);
    expect(twice.copy.slides[0]!.device).toEqual(once.copy.slides[0]!.device);
    expect(once.decisions[0]!.outcome).toBe("composed");
    expect(twice.decisions[0]!.outcome).toBe("kept");
  });

  it("records nothing at all for a post with no statement plate, so an empty array means 'no such slide' and never 'nothing happened'", () => {
    const { decisions } = composeBoundedObjects(copyOf(slide({ n: 1, layout: "cover" }), slide({ n: 2, layout: "closer" })), FACTS);
    expect(decisions).toEqual([]);
  });

  it("carries the composed figure's own value on the decision, so the trace says WHICH number reached the plate", () => {
    const { decisions } = composeBoundedObjects(copyOf(slide({ n: 1 })), FACTS);
    expect(decisions[0]).toMatchObject({ slide: 1, outcome: "composed", value: "30%" });
  });
});
