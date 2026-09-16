import { describe, expect, it } from "vitest";
import {
  UNSPECIFIED_FIX_TARGET,
  VALUE_AXES,
  normaliseValueVerdict,
  valueDraftText,
  valueSteerFor,
  type RawValueVerdict,
  type ValueAxis,
} from "../src/workflow/value-gate.js";

/**
 * Phase 5.5 (spec §6 G7) — A MALFORMED POINTER USED TO LAUNDER A REFUSAL INTO
 * A PASS.
 *
 * `FIX_TARGET` was `^(cover|caption|slide:[1-8])$`. On 2026-09-16
 * thepitchbydeel's `07j-value-judge-attempt-3` answered `payload: "weak"` with
 * `fixTargets: ["declaredStructure"]` — a word the rubric's OWN payload
 * question puts in the judge's mouth. It matched nothing, the fix was dropped,
 * rule 2 found the axis with no fix and set it back to `pass`, `decideValue`
 * returned `keepable`, and the post shipped.
 *
 * Two changes are pinned here. The target vocabulary now includes the names the
 * rubric uses, and — the load-bearing half — a fix survives on its INSTRUCTION
 * rather than on its target. A judge that named the remedy and could not name
 * the place has still made a judgement.
 *
 * Every fixture below is the deel verdict verbatim out of the run document.
 */

// ─────────────────────────────────────────────────────────────────────────
// deel's 07j-value-judge-attempt-3, verbatim
// ─────────────────────────────────────────────────────────────────────────

const DEEL_CAPTION = "Most competitions score you on a feeling.";

const DEEL_SLIDES = [
  { headline: "Most competitions score you on a feeling.", body: "Five criteria, two layers. Not a vibe check." },
  { headline: "What we score", body: "product strength, market opportunity, team capability, traction, scalability" },
  {
    headline: "Do this today",
    body:
      "Pull up your pitch deck and mark which slide addresses each of the five criteria. " +
      "Reply with the one you think is weakest. I will tell you whether it is actually the one that loses rounds.",
  },
];

const DEEL_07J: RawValueVerdict = {
  newFact: "pass",
  position: "pass",
  payload: "weak",
  action: "pass",
  newFactQuote: "product strength, market opportunity, team capability, traction, scalability",
  positionQuote: "Most competitions score you on a feeling.",
  actionQuote:
    "Pull up your pitch deck and mark which slide addresses each of the five criteria. " +
    "Reply with the one you think is weakest. I will tell you whether it is actually the one that loses rounds.",
  fixAxes: ["payload"],
  fixTargets: ["declaredStructure"],
  fixInstructions: [
    "The declared structure is 'ranking'; either build a clear ranking of competitions or evaluation methods, " +
      "or declare a structure that accurately reflects the content, such as 'walkthrough: how The Pitch by Deel evaluates applications'.",
  ],
  keepLine: "A founder would save this to understand how The Pitch by Deel evaluates applications and how to prepare their pitch deck for it.",
};

const DEEL_DRAFT_TEXT = valueDraftText(DEEL_CAPTION, DEEL_SLIDES);

// ─────────────────────────────────────────────────────────────────────────

describe("deel's 07j verdict, verbatim", () => {
  it("keeps the payload axis WEAK: the judge named a remedy, so the axis is not laundered into a pass", () => {
    const result = normaliseValueVerdict(DEEL_07J, DEEL_DRAFT_TEXT);

    // The premise: the three quoted axes really are in the draft, so rule 1 is
    // not what is doing the work here. Without this the case would pass for the
    // wrong reason if the span rule started downgrading everything.
    expect(result.axes.newFact).toBe("pass");
    expect(result.axes.position).toBe("pass");
    expect(result.axes.action).toBe("pass");

    expect(result.axes.payload).toBe("weak");
    expect(result.fixes).toEqual([
      { axis: "payload", target: "declaredStructure", instruction: DEEL_07J.fixInstructions![0] },
    ]);
  });

  it("`declaredStructure` is now a recognised place, because the rubric's payload question names it", () => {
    const result = normaliseValueVerdict(DEEL_07J, DEEL_DRAFT_TEXT);
    expect(result.fixes[0]!.target).toBe("declaredStructure");
    expect(result.fixes[0]!.target).not.toBe(UNSPECIFIED_FIX_TARGET);
    // And it reaches the writer as a place, not as the word "unspecified".
    const steer = valueSteerFor({ status: "below-bar", rubricVersion: "1", ...result });
    expect(steer).toContain("[payload] declaredStructure:");
  });

  it("one weak axis is still keepable — the bar did not move, only the path to it", () => {
    // This is the honest half. deel's post was not saved by keeping the axis
    // weak: `VALUE_WEAK_FAIL_COUNT` is 2 and one weak has always shipped. What
    // changed is that the axis, the fix and the instruction now reach the gate
    // payload, where the reviewer can read them, instead of being erased.
    const result = normaliseValueVerdict(DEEL_07J, DEEL_DRAFT_TEXT);
    expect(result.keepable).toBe(true);
    expect(result.fixes).toHaveLength(1);
  });
});

describe("a target the gate does not recognise", () => {
  const unknownTarget = (target: string): RawValueVerdict => ({ ...DEEL_07J, fixTargets: [target] });

  it("keeps the axis non-pass and records the fix against 'unspecified', with a note saying so", () => {
    for (const target of ["the whole thing", "slide:9", "", "SLIDE:2", "declaredstructure"]) {
      const result = normaliseValueVerdict(unknownTarget(target), DEEL_DRAFT_TEXT);
      expect(result.axes.payload).toBe("weak");
      expect(result.fixes).toEqual([
        { axis: "payload", target: UNSPECIFIED_FIX_TARGET, instruction: DEEL_07J.fixInstructions![0] },
      ]);
      expect(result.notes.some((n) => /is not a place in this post/u.test(n))).toBe(true);
    }
  });

  it("reads to the writer as 'the post', which is the wording the no-fix fallback already uses", () => {
    const result = normaliseValueVerdict(unknownTarget("the whole thing"), DEEL_DRAFT_TEXT);
    const steer = valueSteerFor({ status: "below-bar", rubricVersion: "1", ...result });
    expect(steer).toContain("[payload] the post:");
    expect(steer).not.toContain(UNSPECIFIED_FIX_TARGET);
  });

  it("A MALFORMED TARGET NO LONGER TURNS TWO REFUSALS INTO A PASS — the case that would have shipped a fail", () => {
    // Two weak axes refuse (`VALUE_WEAK_FAIL_COUNT = 2`). Under the old rule
    // both fixes were discarded for their targets, both axes reverted to pass,
    // and the verdict came back keepable. This is the shape deel's run was one
    // axis away from.
    const twoWeak: RawValueVerdict = {
      ...DEEL_07J,
      payload: "weak",
      action: "fail",
      fixAxes: ["payload", "action"],
      fixTargets: ["declaredStructure", "the end of the caption"],
      fixInstructions: [DEEL_07J.fixInstructions![0]!, "Ask for one thing the reader can do in a minute and say what they get back for doing it."],
    };
    const result = normaliseValueVerdict(twoWeak, DEEL_DRAFT_TEXT);
    expect(result.axes.payload).toBe("weak");
    expect(result.axes.action).toBe("fail");
    expect(result.keepable).toBe(false);
  });
});

describe("rule 2 still forbids the shape it was written for", () => {
  it("a non-pass with NO instruction reverts to pass: 'report without proposing' is still unrepresentable", () => {
    const noInstruction: RawValueVerdict = { ...DEEL_07J, fixInstructions: [""] };
    expect(normaliseValueVerdict(noInstruction, DEEL_DRAFT_TEXT).axes.payload).toBe("pass");

    const noFixAtAll: RawValueVerdict = { ...DEEL_07J, fixAxes: [], fixTargets: [], fixInstructions: [] };
    expect(normaliseValueVerdict(noFixAtAll, DEEL_DRAFT_TEXT).axes.payload).toBe("pass");
  });

  it("a fix for an axis the judge itself passed is still discarded, whatever its target", () => {
    const secondOpinion: RawValueVerdict = {
      ...DEEL_07J,
      fixAxes: ["position"],
      fixTargets: ["nowhere at all"],
      fixInstructions: ["Sharpen the cover."],
    };
    const result = normaliseValueVerdict(secondOpinion, DEEL_DRAFT_TEXT);
    expect(result.axes.position).toBe("pass");
    expect(result.fixes).toEqual([]);
    // The payload axis had no fix of its own in this fixture, so rule 2 does
    // what it always did.
    expect(result.axes.payload).toBe("pass");
  });

  it("an axis name outside the four is still discarded, so a typo cannot invent a fifth question", () => {
    const badAxis: RawValueVerdict = { ...DEEL_07J, fixAxes: ["structure"], fixTargets: ["post"], fixInstructions: ["Build the ranking."] };
    const result = normaliseValueVerdict(badAxis, DEEL_DRAFT_TEXT);
    expect(result.fixes).toEqual([]);
    expect(VALUE_AXES as readonly string[]).not.toContain("structure");
  });
});

describe("the widened vocabulary", () => {
  it("accepts every name the rubric hands the judge, and nothing else", () => {
    const accepted = ["cover", "caption", "closer", "hook", "cta", "declaredStructure", "post", "slide:1", "slide:8"];
    for (const target of accepted) {
      const result = normaliseValueVerdict({ ...DEEL_07J, fixTargets: [target] }, DEEL_DRAFT_TEXT);
      expect(result.fixes[0]!.target, target).toBe(target);
    }
    // Still bounded: nothing open-ended got in with them.
    for (const target of ["slide:0", "slide:12", "everywhere", "Cover"]) {
      const result = normaliseValueVerdict({ ...DEEL_07J, fixTargets: [target] }, DEEL_DRAFT_TEXT);
      expect(result.fixes[0]!.target, target).toBe(UNSPECIFIED_FIX_TARGET);
    }
  });

  it("the axis-by-axis behaviour is unchanged for every axis, not only payload", () => {
    for (const axis of VALUE_AXES) {
      const raw: RawValueVerdict = {
        newFact: "pass",
        position: "pass",
        payload: "pass",
        action: "pass",
        [axis]: "fail",
        fixAxes: [axis],
        fixTargets: ["a place that does not exist"],
        fixInstructions: ["Write the thing the post is missing."],
      } as RawValueVerdict & Record<ValueAxis, string>;
      const result = normaliseValueVerdict(raw, DEEL_DRAFT_TEXT);
      expect(result.axes[axis], axis).toBe("fail");
      expect(result.keepable).toBe(false);
    }
  });
});
