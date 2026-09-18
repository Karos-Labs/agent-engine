import { describe, expect, it } from "vitest";
import { describeRepairs, repairDashes, repairMechanicalTells } from "../src/workflow/mechanical-repair.js";
import { lintPost } from "@agent-engine/tool-karos-gates";
import type { InstagramCopyOutput, InstagramSlideCopy } from "../src/workflow/types.js";

/**
 * $1.14 of a $2.39 run went on three copy attempts, and one of the rejections
 * that bought a whole new eight-slide carousel was a single em dash.
 *
 * The assertions that matter here are the last two: the repair has to satisfy
 * the REAL gate (or it changed nothing and the redraft still happens), and it
 * has to leave judgement alone (or it is quietly rewriting the post).
 */

const slide = (n: number, over: Partial<InstagramSlideCopy> = {}): InstagramSlideCopy =>
  ({ n, headline: `Headline ${n}`, body: `Body ${n}.`, sourceRef: "a claim", layout: "photo", visualNeed: "a desk", ...over }) as InstagramSlideCopy;

const copyOf = (caption: string, slides: InstagramSlideCopy[]): InstagramCopyOutput =>
  ({ caption, slides, format: "carousel" }) as unknown as InstagramCopyOutput;

describe("repairDashes", () => {
  it("replaces each banned dash with a comma", () => {
    expect(repairDashes("We shipped it — and it worked")).toBe("We shipped it, and it worked");
    expect(repairDashes("We shipped it – and it worked")).toBe("We shipped it, and it worked");
    expect(repairDashes("We shipped it -- and it worked")).toBe("We shipped it, and it worked");
  });

  it("works unspaced, which is how a model usually emits one", () => {
    expect(repairDashes("onboarding—14 days")).toBe("onboarding, 14 days");
  });

  it("deletes an EDGE dash instead of leaving a stray comma", () => {
    // A field that opens or closes on a dash has no clause on one side of it.
    expect(repairDashes("— a note")).toBe("a note");
    expect(repairDashes("a note —")).toBe("a note");
  });

  it("does not stack punctuation where the model already punctuated around it", () => {
    expect(repairDashes("We shipped it, — and it worked")).toBe("We shipped it, and it worked");
    expect(repairDashes("We shipped it —. Then we stopped.")).toBe("We shipped it. Then we stopped.");
  });

  it("leaves an ordinary hyphen completely alone", () => {
    // A single hyphen is not on the banned list, and compound words are
    // everywhere in this copy. Touching them would be a rewrite.
    for (const kept of ["state-of-the-art tooling", "a go-to-market plan", "twenty-four hours", "gpt-4o"]) {
      expect(repairDashes(kept), kept).toBe(kept);
    }
  });

  it("leaves clean text byte-identical, which is the case on most attempts", () => {
    const clean = "Sorting tickets the moment they land resolved 30% more of them.";
    expect(repairDashes(clean)).toBe(clean);
  });
});

describe("repairMechanicalTells", () => {
  it("reaches every field a gate reads, not just the caption", () => {
    const { copy, repairs } = repairMechanicalTells(
      copyOf("A caption — with a dash", [
        slide(1, { headline: "A headline — with one", body: "A body — with one" }),
        slide(2, {
          items: [{ title: "An item — title", note: "A note — here" }],
          stat: { figure: "30%", subLabel: "a label — here", source: "a source" },
        }),
      ]),
    );
    expect(repairs.map((r) => r.field)).toEqual([
      "caption",
      "slide 1 headline",
      "slide 1 body",
      "slide 2 item 1 title",
      "slide 2 item 1 note",
      "slide 2 stat label",
    ]);
    expect(JSON.stringify(copy)).not.toContain("—");
  });

  it("SATISFIES THE REAL GATE — or the redraft still happens and this bought nothing", async () => {
    // The whole point, asserted against `gate.lintPost` itself rather than
    // against this module's own idea of what the gate wants.
    const dirty = "Most teams test on your brand first — we did not. Onboarding fell -- from 14 days to 3.";
    const before = await lintPost.execute({ text: dirty, platform: "instagram", checkAntiSlop: true, maxExclamationMarks: 1, bannedPhrases: [], parts: [] }, { ctx: {} as never });
    expect(JSON.stringify(before), "the premise: this text must actually fail the gate").toMatch(/dash|hyphen/i);

    const after = await lintPost.execute({ text: repairDashes(dirty), platform: "instagram", checkAntiSlop: true, maxExclamationMarks: 1, bannedPhrases: [], parts: [] }, { ctx: {} as never });
    expect(JSON.stringify(after)).not.toMatch(/em dash|en dash|double hyphen/i);
  });

  it("repairs NOTHING that requires reading the argument", () => {
    // Three of the rejections that cost a redraft on 2026-09-18 were "slides
    // 4, 5, 8 all open with the word the", "the cover headline has no tension"
    // and "the caption reproduces 6 consecutive words of a fact card". Each is
    // writing, and a repair that touched them would be this module quietly
    // rewriting the post.
    const judgement = copyOf("The claim reproduces a fact card exactly as written.", [
      slide(1, { headline: "The first thing", body: "The second thing." }),
      slide(2, { headline: "The third thing", body: "The fourth thing." }),
    ]);
    const { copy, repairs } = repairMechanicalTells(judgement);
    expect(repairs).toEqual([]);
    expect(copy).toEqual(judgement);
  });

  it("says what it changed, so a reviewer reads a comma they did not write", () => {
    const { repairs } = repairMechanicalTells(copyOf("A — B", [slide(1)]));
    expect(describeRepairs(repairs)).toContain("caption");
    expect(describeRepairs(repairs)).toContain("rather than buying a redraft");
    expect(describeRepairs([])).toBe("");
  });
});
