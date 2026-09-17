import { describe, expect, it } from "vitest";
import { MODEL_CAPABILITIES, MODEL_PRICING, type AgentContext, type ModelPolicy } from "@agent-engine/core";
import type { WorkflowContext } from "@agent-engine/workflow";
import type { FactCardForPrompt } from "../src/workflow/fact-cards.js";
import type { InstagramCopyOutput, InstagramSlideCopy } from "../src/workflow/types.js";
import {
  UNSPECIFIED_FIX_TARGET,
  VALUE_AXES,
  VALUE_FIX_MAX_CHARS,
  VALUE_KEEP_QUOTE_CHARS,
  VALUE_MAX_RETURNS,
  VALUE_OUTPUT_FIELDS,
  VALUE_RUBRIC_VERSION,
  VALUE_WEAK_FAIL_COUNT,
  axesMovement,
  buildValueSystemPrompt,
  decideValue,
  normaliseValueVerdict,
  runValueJudge,
  valueDegradedEvent,
  valueDraftText,
  valueFailureReason,
  valueSlidesFor,
  valueSteerFor,
  type BelowBarVerdict,
  type RawValueVerdict,
  type ValueAxes,
  type ValueJudgeInput,
} from "../src/workflow/value-gate.js";
import { fakeRouterSequence, finalTurn, makePromptStore } from "./test-helpers.js";

/**
 * Instagram Phase 5 (RFC-18 §5) — THE VALUE GATE, the gate that is missing
 * between *correct* and *good*.
 *
 * Reverting P1 deletes `value-gate.ts`, which is the module every case here
 * imports, so the whole suite fails rather than silently passing against
 * nothing.
 *
 * Three guards the RFC names by hand are marked GUARD PROOF; each says, in the
 * test, exactly what to break to make it go green, and each was made green
 * that way before being trusted:
 *
 * 1. one weak passes and two refuse — flip `VALUE_WEAK_FAIL_COUNT` to 3;
 * 2. a `positionQuote` that paraphrases the draft downgrades that axis —
 *    delete the substring check in rule 1;
 * 3. a `position: "fail"` with no surviving fix reverts to `pass` — delete
 *    rule 2.
 *
 * The client throughout is RFC-18 §5.6's own: a servicer of commercial kitchen
 * equipment for independent restaurants. A neutral trade on purpose. The
 * reference accounts the owner supplied post about AI and marketing; their
 * EXECUTION transfers and their SUBJECT MATTER never does, and a fixture is
 * one of the easiest places to break that rule silently.
 */

// ─────────────────────────────────────────────────────────────────────────
// Fixtures — RFC-18 §5.6's worked PASS and its worked REFUSAL
// ─────────────────────────────────────────────────────────────────────────

function slide(n: number, headline: string, body: string, extra: Partial<InstagramSlideCopy> = {}): InstagramSlideCopy {
  return {
    n,
    headline,
    body,
    visualNeed: "a technician opening the condenser panel on a walk-in cooler",
    sourceRef: "card 4: a coil cleaned quarterly draws about 12 percent less power",
    layout: n === 1 ? "cover" : "photo",
    ...extra,
  } as InstagramSlideCopy;
}

const KEEPABLE_CAPTION =
  "Open the panel, take a photo of your coil, and reply with it. I will tell you whether it needs a clean this month or in six.";

/** §5.6's PASS: a position on the cover, a figure with its period, a consequence, an engineered ask. */
function keepablePost(): InstagramCopyOutput {
  return {
    format: "carousel",
    caption: KEEPABLE_CAPTION,
    slides: [
      slide(1, "Your walk-in is not dying of old age. It is dying of a dirty condenser coil.", "The part that fails is almost never the part that was neglected."),
      slide(2, "Dust is an insulator.", "A coated coil makes the compressor run longer for the same cabinet temperature, so you pay to cool the dust first."),
      slide(
        3,
        "Quarterly beats annually.",
        "A coil cleaned quarterly draws about 12 percent less power than one cleaned once a year. On a 2 HP compressor that is roughly 40 dollars a month you are paying to keep dust warm.",
      ),
      slide(4, "Check the discharge line.", "Too hot to hold for three seconds means the head pressure is already high, and the coil is the first thing to rule out."),
    ],
  } as InstagramCopyOutput;
}

/** §5.6's REFUSAL: the post every gate that exists today passes. Grounded, on-brief, fluent, and worthless. */
function worthlessPost(): InstagramCopyOutput {
  return {
    format: "carousel",
    caption: "Let us know your thoughts.",
    slides: [
      slide(1, "Preventive maintenance matters more than ever for modern kitchens.", "Looking after your equipment is part of running a professional operation."),
      slide(2, "Servicing helps.", "Regular servicing can help reduce unexpected downtime and extend equipment lifespan."),
      slide(3, "Plan ahead.", "Thinking about service before the busy season starts is generally a good idea."),
    ],
  } as InstagramCopyOutput;
}

function card(claim: string, extra: Partial<FactCardForPrompt> = {}): FactCardForPrompt {
  return { claim, kind: "stat", source: "ASHRAE field study", date: "2026-03-01", ...extra };
}

const SPECIFIC_CARDS: FactCardForPrompt[] = [
  card("A condenser coil cleaned quarterly draws about 12 percent less power than one cleaned annually."),
  card("A 2 HP commercial compressor costs roughly 40 dollars a month more to run behind a fouled coil."),
];

/** Four cards that are definitions: nothing a redraft could turn into a named specific. */
const DEFINITION_CARDS: FactCardForPrompt[] = [
  card("A condenser coil rejects heat from the refrigerant to the surrounding air.", { kind: "definition" }),
  card("Preventive maintenance means servicing on a schedule rather than on failure.", { kind: "definition" }),
];

/** All four axes pass unless a test says otherwise — the base every bar test perturbs by exactly one axis. */
function ax(overrides: Partial<ValueAxes> = {}): ValueAxes {
  return { newFact: "pass", position: "pass", payload: "pass", action: "pass", ...overrides };
}

/** The judge's answer for §5.6's PASS: four passes, four spans that really occur in the draft. */
function keepableRaw(overrides: Partial<RawValueVerdict> = {}): RawValueVerdict {
  const post = keepablePost();
  return {
    newFact: "pass",
    position: "pass",
    payload: "pass",
    action: "pass",
    newFactQuote: "about 12 percent less power than one cleaned once a year",
    positionQuote: "Your walk-in is not dying of old age.",
    payloadQuote: post.slides[2]!.body,
    actionQuote: "Open the panel, take a photo of your coil, and reply with it.",
    keepLine: "A restaurant owner would keep this to decide whether the quarterly service contract is worth its price.",
    ...overrides,
  };
}

/** §5.6's REFUSAL verdict, verbatim from the RFC's JSON. */
function worthlessRaw(): RawValueVerdict {
  return {
    newFact: "fail",
    position: "fail",
    payload: "weak",
    action: "fail",
    fixAxes: ["newFact", "position", "payload", "action"],
    fixTargets: ["slide:3", "cover", "slide:2", "caption"],
    fixInstructions: [
      "Fact card 4 carries the 12 percent figure for quarterly coil cleaning; put that number and its period on slide 3 and drop the general claim.",
      "Assert the cause: name the single failure this client sees most often and say plainly that age is not it.",
      "Slide 2 states a benefit with no consequence; say what the downtime costs on a Friday service, in money or in covers.",
      "Ask for one thing the reader can do in a minute and say what they get back for doing it.",
    ],
    keepLine: "Nothing here is wrong, and nothing here is worth saving: every sentence would be true for any maintenance company in any trade.",
  };
}

/**
 * `keepableRaw()` with one quote field REMOVED rather than set to `undefined`
 * — the package compiles under `exactOptionalPropertyTypes`, where an explicit
 * `undefined` is not the same thing as an absent key, and the judge's schema
 * delivers absence.
 */
function rawWithoutQuote(key: "newFactQuote" | "positionQuote" | "payloadQuote" | "actionQuote", overrides: Partial<RawValueVerdict> = {}): RawValueVerdict {
  const raw: RawValueVerdict = { ...keepableRaw(), ...overrides };
  delete raw[key];
  return raw;
}

function draftOf(post: InstagramCopyOutput): string {
  return valueDraftText(post.caption, valueSlidesFor(post));
}

/** A below-bar verdict from a raw answer, for the steer tests. */
function belowBar(raw: RawValueVerdict, post: InstagramCopyOutput = worthlessPost()): BelowBarVerdict {
  const normalised = normaliseValueVerdict(raw, draftOf(post));
  return { status: "below-bar", rubricVersion: VALUE_RUBRIC_VERSION, ...normalised };
}

// ─────────────────────────────────────────────────────────────────────────
// The rubric
// ─────────────────────────────────────────────────────────────────────────

describe("buildValueSystemPrompt — the rubric in full (§5.2)", () => {
  const prompt = buildValueSystemPrompt();

  it("asks the four questions, and asks them as four", () => {
    expect(prompt).toContain("1. newFact: is there something here a practitioner in this field did not already know?");
    expect(prompt).toContain("2. position: does this post take a side someone could argue with?");
    expect(prompt).toContain("3. payload: is there something here a reader would keep?");
    expect(prompt).toContain("4. action: is there a specific thing the reader can do next?");
    expect(VALUE_AXES).toEqual(["newFact", "position", "payload", "action"]);
    // A fifth heading would mean an axis the output contract has no field for.
    expect(prompt.match(/^\d\. \w+: /gmu)).toHaveLength(4);
  });

  /**
   * The design's whole load-bearing move. A "will anyone save this?" judge
   * rendering TASTE is a gate that cannot fail — Flash awards 4/5 to competent
   * generic copy, which is the copy this gate exists to refuse. So the judge is
   * asked to FIND EVIDENCE against a stated test, and an axis with no findable
   * evidence is not a pass.
   */
  it("demands a quote or a remedy, and says an unquotable yes is not a yes", () => {
    expect(prompt).toContain("You are NOT scoring how good it is.");
    expect(prompt).toContain("either QUOTE the words in the post that make the answer yes, or say what to write instead");
    expect(prompt).toContain("A question you cannot quote an answer for is not a yes.");
    expect(prompt).toContain("Every quote must be copied from the post EXACTLY, character for character.");
    expect(prompt).toContain("A quote that is not in the post is treated as no quote at all.");
  });

  it("states rule 2 to the model as well as enforcing it in code", () => {
    // Phase 5.5 (spec §6 G7): "with no fix" became "with no remedy sentence".
    // A fix now survives on its instruction, not on its target, and the rubric
    // says the same thing to the model that the code enforces.
    expect(prompt).toContain("A weak or a fail with no remedy sentence is discarded and the axis is treated as a pass");
    expect(prompt).toContain("do not raise a problem you cannot say the remedy for");
  });

  it("answers with pass, weak or fail — and never with a score or a keepable flag", () => {
    expect(prompt).toContain("Answer each question with exactly one of: pass, weak, fail.");
    expect(prompt).not.toMatch(/\bkeepable\b/u);
    expect(prompt).not.toMatch(/\bout of 5\b|\bscore\b/iu);
  });

  it("confines the judge to these four questions, so it cannot re-litigate another gate's job", () => {
    expect(prompt).toContain("Not grammar, not fluency, not whether the post is on-brief, not whether the facts are true, not whether you like it.");
  });

  it("tells the judge to judge and quote in the language the post is written in", () => {
    expect(prompt).toContain("The post may be written in Hebrew, Arabic or another language.");
    expect(prompt).toContain("Judge it in the language it is written, and quote in that language.");
  });

  /**
   * GUARD against a quiet regression with a real cost. §5.2's prose writes the
   * four headings with an em dash. This judge's `fixInstructions` are handed to
   * the writer verbatim as `valueSteer`, and a prep run has already failed
   * craft hygiene on that character twice in three attempts — so a dash in the
   * rubric is a dash one rewrite away from the shipped copy. Paste §5.2's
   * headings in unaltered and this refuses.
   */
  it("carries no em dash, en dash or double hyphen, and asks the judge for the same", () => {
    expect(prompt).not.toMatch(/[–—]|--/u);
    expect(prompt).toContain("Write your fixes in plain characters: no em dash, no en dash, no double hyphen.");
  });

  it("asks for keepLine last, and allows an honest refusal to write one", () => {
    expect(prompt).toContain("Finally, write keepLine:");
    expect(prompt).toContain("If you cannot write that sentence honestly, say so in it.");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The output contract
// ─────────────────────────────────────────────────────────────────────────

describe("VALUE_OUTPUT_FIELDS — twelve flat fields (§5.3)", () => {
  it("is exactly the twelve the RFC names, in order", () => {
    expect(VALUE_OUTPUT_FIELDS.map((f) => f.name)).toEqual([
      "newFact",
      "position",
      "payload",
      "action",
      "newFactQuote",
      "positionQuote",
      "payloadQuote",
      "actionQuote",
      "fixAxes",
      "fixTargets",
      "fixInstructions",
      "keepLine",
    ]);
  });

  /**
   * `AgentDefinitionFieldSchema` is `"string" | "number" | "boolean" |
   * "string[]"` and has NO `object[]`. That is the whole reason the fixes are
   * three parallel arrays rather than one array of objects, and the reason
   * misalignment has to be distrusted in code. A field typed outside this set
   * would not survive `buildOutputSchema`.
   */
  it("uses only types the flat DSL can express, which is why the fixes are three parallel arrays", () => {
    for (const field of VALUE_OUTPUT_FIELDS) expect(["string", "number", "boolean", "string[]"]).toContain(field.type);
    expect(VALUE_OUTPUT_FIELDS.filter((f) => f.name.startsWith("fix")).map((f) => f.type)).toEqual(["string[]", "string[]", "string[]"]);
  });

  it("requires the four axes and keepLine, and nothing else", () => {
    const required = VALUE_OUTPUT_FIELDS.filter((f) => f.optional !== true).map((f) => f.name);
    expect(required).toEqual(["newFact", "position", "payload", "action", "keepLine"]);
  });

  /**
   * "There is deliberately no `keepable` field in the output contract at all."
   * The bar is computed in `decideValue` and never requested, because a rule
   * stated to a model is a request. Add the field and this refuses.
   */
  it("has no field that asks the model for the verdict itself", () => {
    const names = VALUE_OUTPUT_FIELDS.map((f) => f.name);
    expect(names).not.toContain("keepable");
    expect(names.some((n) => /keepable|verdict|score|overall/iu.test(n))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE BAR
// ─────────────────────────────────────────────────────────────────────────

describe("decideValue — THE BAR (§5.5)", () => {
  /**
   * GUARD PROOF 1. A real threshold with a real other side: one weak is a
   * competent post with one soft corner, which is a human editor's ordinary
   * output; two is a pattern, and the pattern is what this phase was
   * commissioned to catch.
   *
   * Flip `VALUE_WEAK_FAIL_COUNT` to 3 and the two-weak case below goes green.
   * That is how this test is known to be able to fail.
   */
  it("lets ONE weak through and refuses TWO", () => {
    expect(VALUE_WEAK_FAIL_COUNT).toBe(2);
    expect(decideValue(ax())).toBe(true);
    expect(decideValue(ax({ payload: "weak" }))).toBe(true);
    expect(decideValue(ax({ action: "weak" }))).toBe(true);
    expect(decideValue(ax({ payload: "weak", action: "weak" }))).toBe(false);
  });

  it("refuses on a single fail, alone, even beside three passes", () => {
    expect(decideValue(ax({ action: "fail" }))).toBe(false);
    expect(decideValue(ax({ newFact: "fail" }))).toBe(false);
  });

  /**
   * Clause (2), the audit's charge in one line: a post that is accurate,
   * on-brief, fluent, tells the reader nothing they did not know and takes no
   * position is precisely the post every existing gate passes.
   *
   * HONEST NOTE, because a guard proof that is not true is worse than none.
   * RFC-18 §5.5 says "delete clause (2) and the weak/weak case goes green". At
   * today's constants that is FALSE for the plain case: two weaks are already
   * two weaks, so clause (3) refuses this shape too and deleting clause (2)
   * changes nothing.
   *
   * Enumerating all 1,296 (axes x advisory-subset) combinations, clause (2)
   * changes the answer in exactly 16 of them, and every one of the 16 has
   * `position` ADVISORY and `newFact` not. `normaliseValueVerdict` can only
   * ever make `newFact` advisory today, so clause (2) is unreachable through
   * this module's own callers and is a ratchet held for a phase that relaxes
   * a second axis. The second case below is therefore the only configuration
   * in which the clause is load-bearing — and it is genuinely falsifiable:
   * delete clause (2) and it goes green.
   */
  it("refuses the audit's exact shape: nothing new, and no position", () => {
    expect(decideValue(ax({ newFact: "weak", position: "weak" }))).toBe(false);
    // The one configuration where clause (2), and not clause (3), is what refuses.
    expect(decideValue(ax({ newFact: "weak", position: "weak" }), ["position"])).toBe(false);
  });

  /**
   * The relaxation has to reach the DECISION, not only the record. Without the
   * advisory filter a client whose research returned four definitions fails an
   * axis no redraft can answer, three times — the unwinnable floor Phase 0
   * already had to correct once. Delete the filter and this refuses.
   */
  it("excludes an advisory axis from the count, so a thinly grounded client can still clear the bar", () => {
    expect(decideValue(ax({ newFact: "fail" }), ["newFact"])).toBe(true);
    expect(decideValue(ax({ newFact: "fail", payload: "weak" }), ["newFact"])).toBe(true);
    // The relaxation forgives ONE axis, it does not open the gate: two scored
    // weaks still refuse with `newFact` advisory.
    expect(decideValue(ax({ newFact: "fail", payload: "weak", action: "weak" }), ["newFact"])).toBe(false);
  });

  /**
   * The module's one documented refinement of §5.5's snippet. §5.4 rule 3 says
   * an advisory axis is "recorded, excluded from the decision", and clause (2)
   * IS part of the decision — reading `axes.newFact` there unconditionally
   * would re-import the unwinnable axis the relaxation exists to remove.
   * Delete the `!advisory.includes("newFact")` guard and this refuses.
   */
  it("skips clause (2) when newFact is advisory, rather than re-importing the axis it just excused", () => {
    expect(decideValue(ax({ newFact: "weak", position: "weak" }), ["newFact"])).toBe(true);
  });
});

describe("axesMovement — the no-improvement stop (§5.7)", () => {
  it("is up only when an axis moved up and none moved down", () => {
    expect(axesMovement(ax({ position: "fail" }), ax({ position: "weak" }))).toBe("up");
    expect(axesMovement(ax({ position: "fail" }), ax({ position: "pass" }))).toBe("up");
    expect(axesMovement(ax({ newFact: "weak", action: "weak" }), ax({ newFact: "pass", action: "weak" }))).toBe("up");
  });

  it("is flat when nothing moved, so a stalled writer does not buy another attempt", () => {
    expect(axesMovement(ax({ position: "weak" }), ax({ position: "weak" }))).toBe("flat");
    expect(axesMovement(ax(), ax())).toBe("flat");
  });

  /**
   * The anti-thrash case, and the reason this is not "the sum went up": the
   * classic redraft regression is fixing one axis by destroying another. A
   * trade is not an improvement.
   */
  it("is down when one axis was traded for another", () => {
    expect(axesMovement(ax({ newFact: "weak" }), ax({ newFact: "pass", position: "weak" }))).toBe("down");
    expect(axesMovement(ax({ position: "pass" }), ax({ position: "fail" }))).toBe("down");
  });

  /**
   * THE DISTINCTION THAT HAD TO EXIST, and the reason this is three-valued
   * rather than a boolean.
   *
   * `down` and `flat` were the same answer under the old `axesImproved`, and
   * the caller stalled on both. Only `flat` is a writer with nothing more to
   * give. `down` is reachable without any value return having been spent:
   * `previousValueAxes` is recorded on every judged attempt, so a `keepable`
   * attempt that `08b`'s visual QA sends back over a PIXEL and that comes back
   * `below-bar` lands here — and reading that as a stall shipped the post with
   * a value return unspent and the writer never once shown a value fix.
   *
   * GUARD PROOF: make `axesMovement` return `"flat"` for the down cases (drop
   * the `down` branch) and this case goes green while the caller silently stops
   * buying redrafts for regressions again.
   */
  it("separates a REGRESSION from a stall, so only a stall stops the loop", () => {
    // The visual-QA path: a clean attempt returned over a pixel, re-judged worse.
    expect(axesMovement(ax(), ax({ position: "fail" }))).toBe("down");
    expect(axesMovement(ax(), ax())).toBe("flat");
    // The caller's test is `=== "flat"`, so exactly one of these two stalls.
    expect(axesMovement(ax(), ax({ position: "fail" })) === "flat").toBe(false);
  });

  it("caps how much of the attempt loop value may spend", () => {
    expect(VALUE_MAX_RETURNS).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// normaliseValueVerdict
// ─────────────────────────────────────────────────────────────────────────

describe("normaliseValueVerdict rule 1 — the span rule (§5.4)", () => {
  /**
   * GUARD PROOF 2. Delete `haystack.includes(span)` and a fabricated quote
   * passes, which is the failure this rule exists for: the judge is trusted to
   * EXTRACT, and an extraction that is not in the source is an invention.
   */
  it("downgrades a pass whose quote paraphrases the draft instead of copying it", () => {
    const out = normaliseValueVerdict(
      keepableRaw({ positionQuote: "Your walk-in cooler is not failing because of its age." }),
      draftOf(keepablePost()),
    );
    expect(out.axes.position).toBe("weak");
    expect(out.verifiedQuotes.position).toBeUndefined();
    expect(out.notes.join(" ")).toContain("does not occur in the post");
    // And the un-paraphrased original still verifies, so the rule is a check
    // and not a blanket refusal.
    expect(normaliseValueVerdict(keepableRaw(), draftOf(keepablePost())).axes.position).toBe("pass");
  });

  /**
   * Downgraded to `weak`, NOT to `fail`. One paraphrased quote is a model
   * tidying whitespace; two are a judge inventing, and two weaks already
   * refuse. Make rule 1 write "fail" and the first case below goes red.
   */
  it("downgrades to weak, so one invention survives the bar and two do not", () => {
    const one = normaliseValueVerdict(keepableRaw({ positionQuote: "not in the post at all" }), draftOf(keepablePost()));
    expect(one.axes.position).toBe("weak");
    expect(one.keepable).toBe(true);

    const two = normaliseValueVerdict(
      keepableRaw({ positionQuote: "not in the post at all", actionQuote: "also not in the post" }),
      draftOf(keepablePost()),
    );
    expect(two.axes).toMatchObject({ position: "weak", action: "weak" });
    expect(two.keepable).toBe(false);
  });

  it("tolerates collapsed whitespace but nothing else, because the rubric asked for character for character", () => {
    const post = keepablePost();
    const reflowed = normaliseValueVerdict(keepableRaw({ positionQuote: "Your walk-in\n   is not dying   of old age." }), draftOf(post));
    expect(reflowed.axes.position).toBe("pass");
    // Case is NOT folded: a tidied capital is still a quote the judge did not copy.
    const recased = normaliseValueVerdict(keepableRaw({ positionQuote: "your walk-in is not dying of old age." }), draftOf(post));
    expect(recased.axes.position).toBe("weak");
  });

  it("treats a pass with no quote at all as the same failure, in the reviewer's words", () => {
    const out = normaliseValueVerdict(rawWithoutQuote("payloadQuote"), draftOf(keepablePost()));
    expect(out.axes.payload).toBe("weak");
    expect(out.notes.join(" ")).toContain("a question you cannot quote an answer for is not a yes");
  });

  it("puts only re-found quotes in verifiedQuotes, which is all the steer is ever allowed to reuse", () => {
    const out = normaliseValueVerdict(keepableRaw({ newFactQuote: "a number the post never printed" }), draftOf(keepablePost()));
    expect(Object.keys(out.verifiedQuotes).sort()).toEqual(["action", "payload", "position"]);
  });
});

describe("normaliseValueVerdict rule 2 — the fix rule (§5.4)", () => {
  /**
   * GUARD PROOF 3. Phase 4's rule (`language-gate.ts:723-736`), here for the
   * same reason: a judge that flags an axis and proposes nothing has produced a
   * hold generator. "Report without proposing" is made structurally
   * unrepresentable.
   *
   * Delete the rule and `position` stays `fail`, `keepable` goes false, and a
   * fix-less refusal becomes a returned draft the writer cannot act on.
   */
  it("reverts a fail with no surviving fix back to pass, and the bar is recomputed on the revert", () => {
    const out = normaliseValueVerdict({ ...worthlessRaw(), fixAxes: [], fixTargets: [], fixInstructions: [] }, draftOf(worthlessPost()));
    expect(out.axes).toEqual({ newFact: "pass", position: "pass", payload: "pass", action: "pass" });
    expect(out.fixes).toEqual([]);
    expect(out.keepable).toBe(true);
  });

  it("keeps the §5.6 refusal intact when every fix survives", () => {
    const out = normaliseValueVerdict(worthlessRaw(), draftOf(worthlessPost()));
    expect(out.axes).toEqual({ newFact: "fail", position: "fail", payload: "weak", action: "fail" });
    expect(out.fixes).toHaveLength(4);
    expect(out.keepable).toBe(false);
    expect(out.keepLine).toContain("nothing here is worth saving");
  });

  it.each([
    ["an axis nobody defined", { fixAxes: ["tone", "position", "payload", "action"] }],
    ["an empty instruction", { fixInstructions: ["   ", "Assert the cause.", "Say what the downtime costs.", "Ask for one thing."] }],
  ])("discards a fix carrying %s, and rule 2 then acts on the axis it left bare", (_shape, overrides) => {
    const out = normaliseValueVerdict({ ...worthlessRaw(), ...overrides }, draftOf(worthlessPost()));
    expect(out.fixes.some((f) => f.axis === "newFact")).toBe(false);
    expect(out.axes.newFact).toBe("pass");
  });

  /**
   * CHANGED BY PHASE 5.5 (spec §6 G7). A fix used to be discarded for its
   * TARGET as well as for its instruction, and a discarded fix let rule 2
   * revert the axis to `pass`. thepitchbydeel's `07j` on 2026-09-16 answered
   * `payload: "weak"` with `fixTargets: ["declaredStructure"]` — a word the
   * rubric's own payload question hands the judge — and the run shipped a
   * refusal as a pass.
   *
   * A fix now survives on its INSTRUCTION. An unrecognised target is recorded
   * as `UNSPECIFIED_FIX_TARGET` and the axis keeps the verdict the judge gave
   * it. `value-fix-target.test.ts` pins the deel verdict verbatim.
   */
  it.each([
    ["a target outside the recognised set", { fixTargets: ["slide:9", "cover", "slide:2", "caption"] }],
    ["a target written as prose", { fixTargets: ["the third slide", "cover", "slide:2", "caption"] }],
    ["no target array at all", { fixTargets: [] as string[] }],
  ])("keeps a fix carrying %s, re-pointed at 'unspecified', and the axis stays refused", (_shape, overrides) => {
    const out = normaliseValueVerdict({ ...worthlessRaw(), ...overrides }, draftOf(worthlessPost()));
    expect(out.fixes.find((f) => f.axis === "newFact")).toMatchObject({ target: UNSPECIFIED_FIX_TARGET });
    expect(out.axes.newFact).toBe("fail");
    expect(out.notes.some((n) => /is not a place in this post/u.test(n))).toBe(true);
  });

  /**
   * A fix for an axis the judge itself passed is not a remedy, it is a second
   * opinion nobody asked for — and applying it would return a draft on an axis
   * that already met the test.
   */
  it("discards a fix aimed at an axis the judge passed", () => {
    const out = normaliseValueVerdict(
      keepableRaw({ fixAxes: ["position"], fixTargets: ["cover"], fixInstructions: ["Sharpen the cover."] }),
      draftOf(keepablePost()),
    );
    expect(out.fixes).toEqual([]);
    expect(out.axes.position).toBe("pass");
  });

  it("truncates an instruction that became an essay", () => {
    const essay = "x".repeat(VALUE_FIX_MAX_CHARS + 200);
    const out = normaliseValueVerdict({ ...worthlessRaw(), fixInstructions: [essay, "b", "c", "d"] }, draftOf(worthlessPost()));
    expect(out.fixes[0]!.instruction).toHaveLength(VALUE_FIX_MAX_CHARS);
  });

  /**
   * Rule ordering is load-bearing, and the two axis rules are DISJOINT by
   * construction: rule 2 reads what the MODEL claimed, never what rule 1 wrote.
   * A span-downgraded axis has no fix (the model thought it was a pass), so a
   * rule 2 that could see the downgrade would revert it immediately and rule 1
   * would be a no-op on every input.
   *
   * Change rule 2's `claimed[axis]` to `axes[axis]` and this refuses.
   */
  it("does not let the fix rule undo a span downgrade, which would make rule 1 a no-op", () => {
    const out = normaliseValueVerdict(keepableRaw({ positionQuote: "a sentence the post never contained" }), draftOf(keepablePost()));
    expect(out.fixes.some((f) => f.axis === "position")).toBe(false);
    expect(out.axes.position).toBe("weak");
  });
});

describe("normaliseValueVerdict rules 3 and 4 — the relaxation and the lead-claim cap (§5.4)", () => {
  it("caps newFact at weak when the lead claim was not found on its own source page", () => {
    const out = normaliseValueVerdict(keepableRaw(), draftOf(keepablePost()), { leadClaim: "not-found-on-page", factCards: SPECIFIC_CARDS });
    expect(out.axes.newFact).toBe("weak");
    expect(out.notes.join(" ")).toContain("could not be found on its own source page");
    expect(out.keepable).toBe(true); // one weak alone does not refuse
  });

  /**
   * A paywall is not the writer's fault, and a confirmed claim is not a reason
   * to touch the axis either. Only `not-found-on-page` changes a verdict; make
   * any other status do so and this refuses.
   */
  it.each(["confirmed", "unreachable", "no-url"] as const)("leaves newFact alone on a %s lead claim", (leadClaim) => {
    expect(normaliseValueVerdict(keepableRaw(), draftOf(keepablePost()), { leadClaim, factCards: SPECIFIC_CARDS }).axes.newFact).toBe("pass");
  });

  it("caps, it does not raise: a failed newFact is not promoted to weak by the cap", () => {
    const out = normaliseValueVerdict(worthlessRaw(), draftOf(worthlessPost()), { leadClaim: "not-found-on-page", factCards: SPECIFIC_CARDS });
    expect(out.axes.newFact).toBe("fail");
  });

  it("relaxes newFact to advisory for a thinly grounded brief, and says so in the reviewer's words", () => {
    const out = normaliseValueVerdict(worthlessRaw(), draftOf(worthlessPost()), { thinlyGrounded: true, factCards: SPECIFIC_CARDS });
    expect(out.advisoryAxes).toEqual(["newFact"]);
    expect(out.notes.join(" ")).toContain("grounds the post in an industry rather than a business");
  });

  /**
   * The second door into the relaxation, and the one a brief cannot see: a run
   * whose research came back as definitions has no figure for any redraft to
   * put on a slide. Raise `VALUE_MIN_SPECIFIC_CARDS` and the second case here
   * changes, which is how this threshold is known to be read.
   */
  it("relaxes newFact when the run's own cards carry fewer than two specifics", () => {
    const thin = normaliseValueVerdict(worthlessRaw(), draftOf(worthlessPost()), { factCards: DEFINITION_CARDS });
    expect(thin.advisoryAxes).toEqual(["newFact"]);
    expect(thin.notes.join(" ")).toContain("only 0 of this run's fact cards carry a figure or a named thing");

    const grounded = normaliseValueVerdict(worthlessRaw(), draftOf(worthlessPost()), { factCards: SPECIFIC_CARDS });
    expect(grounded.advisoryAxes).toEqual([]);
  });

  /**
   * ABSENCE is not evidence of thinness. `factCards: undefined` means the
   * caller did not pass cards, not that the run had none — drop the
   * `!== undefined` guard and every caller that omits them gets a free
   * relaxation of the axis this whole phase is about.
   */
  it("does not relax on cards the caller never passed", () => {
    expect(normaliseValueVerdict(worthlessRaw(), draftOf(worthlessPost()), {}).advisoryAxes).toEqual([]);
    expect(normaliseValueVerdict(worthlessRaw(), draftOf(worthlessPost()), { factCards: [] }).advisoryAxes).toEqual(["newFact"]);
  });

  it("never relaxes an axis that passed on its own", () => {
    const out = normaliseValueVerdict(keepableRaw(), draftOf(keepablePost()), { thinlyGrounded: true, factCards: DEFINITION_CARDS });
    expect(out.axes.newFact).toBe("pass");
    expect(out.advisoryAxes).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// What goes back to the writer
// ─────────────────────────────────────────────────────────────────────────

describe("valueSteerFor — the fifth typed steer (§5.6)", () => {
  it("renders the §5.6 refusal as a numbered list of axis, target and remedy", () => {
    const steer = valueSteerFor(belowBar(worthlessRaw()));
    expect(steer.split("\n")[0]).toBe("The value check returned this draft. Fix these four things and change nothing else.");
    expect(steer).toContain("1. [newFact] slide:3: Fact card 4 carries the 12 percent figure");
    expect(steer).toContain("2. [position] cover: Assert the cause");
    expect(steer).toContain("3. [payload] slide:2: Slide 2 states a benefit with no consequence");
    expect(steer).toContain("4. [action] caption: Ask for one thing the reader can do in a minute");
    expect(steer.trimEnd().endsWith("KEEP AS WRITTEN: nothing yet passed.")).toBe(true);
  });

  /**
   * The anti-thrash mechanism, and the reason it is built in CODE from
   * `verifiedQuotes` rather than from the model: without it the classic redraft
   * regression is fixing one axis by destroying another, and after three rounds
   * the post is worse than attempt 1.
   */
  it("builds KEEP AS WRITTEN from the passing axes' verified quotes", () => {
    const partial = belowBar(
      {
        ...keepableRaw(),
        newFact: "fail",
        payload: "fail",
        fixAxes: ["newFact", "payload"],
        fixTargets: ["slide:3", "slide:2"],
        fixInstructions: ["Put the 12 percent figure and its period on slide 3.", "Say what the downtime costs on a Friday service."],
      },
      keepablePost(),
    );
    const steer = valueSteerFor(partial);
    expect(steer).toContain('KEEP AS WRITTEN: "Your walk-in is not dying of old age." (the position) and "Open the panel, take a photo of your coil, and reply with it." (the action).');
  });

  /**
   * GUARD with teeth. A quote that failed the span rule is not in
   * `verifiedQuotes`, so a fabricated line can never be handed back to the
   * writer as accepted text. Build the line from `raw` instead of from
   * `verifiedQuotes` and this refuses.
   */
  it("never hands a fabricated quote back to the writer as accepted text", () => {
    const fabricated = "The coil is the only part that ever fails.";
    const verdict = belowBar(
      {
        ...keepableRaw(),
        newFact: "fail",
        positionQuote: fabricated,
        fixAxes: ["newFact"],
        fixTargets: ["slide:3"],
        fixInstructions: ["Put the 12 percent figure and its period on slide 3."],
      },
      keepablePost(),
    );
    const steer = valueSteerFor(verdict);
    expect(steer).not.toContain(fabricated);
    expect(steer).toContain("KEEP AS WRITTEN:");
  });

  /**
   * The one way an axis can read `pass` and still have no verified quote: rule
   * 2 REVERTED it. The model called it weak or fail, proposed nothing, and the
   * fix rule set it back — so rule 1 never ran on it and no quote was ever
   * checked. Filter the line on `axes[a] === "pass"` alone and the writer is
   * handed `"" (the position)` and told to keep it, which is an instruction to
   * preserve nothing.
   */
  it("does not claim an axis as kept text when rule 2 reverted it and no quote was ever verified", () => {
    const verdict = belowBar(
      rawWithoutQuote("positionQuote", {
        newFact: "fail",
        position: "fail",
        fixAxes: ["newFact"],
        fixTargets: ["slide:3"],
        fixInstructions: ["Put the 12 percent figure and its period on slide 3."],
      }),
      keepablePost(),
    );
    // Rule 2 reverted `position` (no fix survived for it) — but nothing quoted it.
    expect(verdict.axes.position).toBe("pass");
    expect(verdict.verifiedQuotes.position).toBeUndefined();
    const steer = valueSteerFor(verdict);
    expect(steer).not.toContain('""');
    expect(steer).not.toContain("(the position)");
    expect(steer).toContain("(the payload)");
    expect(steer).toContain("(the action)");
  });

  /**
   * The "hold generator" shape arriving by a different door. A code-imposed
   * downgrade (rule 1, or the rule 4 cap) carries NO fix, because the model
   * believed the axis passed — so the fix list is empty and an unguarded steer
   * would be a numbered list of nothing. Delete the `VALUE_AXIS_ASKS` fallback
   * and the writer is returned a draft with no instruction at all.
   */
  it("still names an ask when code, not the model, caused the refusal", () => {
    const capped = normaliseValueVerdict(
      keepableRaw({ positionQuote: "invented", actionQuote: "also invented" }),
      draftOf(keepablePost()),
    );
    expect(capped.fixes).toEqual([]);
    expect(capped.keepable).toBe(false);
    const steer = valueSteerFor({ status: "below-bar", rubricVersion: VALUE_RUBRIC_VERSION, ...capped });
    expect(steer).toContain("[position] the post:");
    expect(steer).toContain("[action] the post:");
    expect(steer.split("\n").filter((l) => /^\d+\. /u.test(l))).toHaveLength(2);
  });

  it("does not ask the writer to fix an axis that was excused as advisory", () => {
    const normalised = normaliseValueVerdict(worthlessRaw(), draftOf(worthlessPost()), { thinlyGrounded: true });
    const steer = valueSteerFor({ status: "below-bar", rubricVersion: VALUE_RUBRIC_VERSION, ...normalised });
    // The model's own newFact fix survives as a fix; what must not happen is
    // the code-built fallback asking for an axis nobody can answer.
    expect(normalised.advisoryAxes).toEqual(["newFact"]);
    expect(steer).not.toContain("[newFact] the post:");
  });

  it("elides a long quote rather than pasting a whole slide body back", () => {
    const post = keepablePost();
    const long = post.slides[2]!.body;
    expect(long.length).toBeGreaterThan(VALUE_KEEP_QUOTE_CHARS);
    const verdict = belowBar(
      {
        ...keepableRaw(),
        newFact: "fail",
        position: "fail",
        action: "fail",
        fixAxes: ["newFact"],
        fixTargets: ["slide:3"],
        fixInstructions: ["Put the figure's period on slide 3."],
      },
      post,
    );
    const steer = valueSteerFor(verdict);
    expect(steer).toContain("...");
    expect(steer).not.toContain(long);
  });

  it("counts in words, so a single remedy does not read as a list", () => {
    const one = belowBar(
      { ...keepableRaw(), action: "fail", fixAxes: ["action"], fixTargets: ["caption"], fixInstructions: ["Ask for one thing the reader can do today."] },
      keepablePost(),
    );
    expect(valueSteerFor(one).split("\n")[0]).toBe("The value check returned this draft. Fix this one thing and change nothing else.");
  });
});

describe("valueFailureReason and valueDegradedEvent — what the trace and the ledger say", () => {
  it("names only the axes that were actually scored and actually refused", () => {
    const verdict = belowBar(worthlessRaw());
    expect(valueFailureReason(verdict)).toBe("post is below the value bar (newFact: fail, position: fail, payload: weak, action: fail)");
  });

  it("leaves an advisory axis out of the reason, so a reviewer is not shown a charge nobody could answer", () => {
    const normalised = normaliseValueVerdict(worthlessRaw(), draftOf(worthlessPost()), { thinlyGrounded: true });
    const reason = valueFailureReason({ status: "below-bar", rubricVersion: VALUE_RUBRIC_VERSION, ...normalised });
    expect(reason).not.toContain("newFact");
    expect(reason).toContain("position: fail");
  });

  /**
   * One warn per degraded delivery, keyed so a RESUME writes one row rather
   * than a second one. Drop the revision from the key and two revisions of the
   * same run collide; drop the run id and two runs do.
   */
  it("keys its one warn by run, status and revision so a resume does not write a second row", () => {
    const below = valueDegradedEvent("run_x", 2, "below-bar", "newFact: fail, position: weak");
    expect(below).toMatchObject({ eventId: "run_x__value-below-bar-r2", level: "warn" });
    expect(below.message).toContain("shipped below the value bar");
    expect(valueDegradedEvent("run_x", 3, "below-bar", "d").eventId).toBe("run_x__value-below-bar-r3");

    const unjudged = valueDegradedEvent("run_x", 1, "unjudged", "value judge did not complete (content_fail)");
    expect(unjudged.eventId).toBe("run_x__value-unjudged-r1");
    expect(unjudged.message).toContain("no redraft was spent");
  });

  /** There is no `held` and no `failed`: budgets adapt, never hold. */
  it("has no status that corresponds to a hold", () => {
    // @ts-expect-error — "held" is not a degraded value status, by design.
    expect(() => valueDegradedEvent("r", 1, "held", "d")).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The judge itself
// ─────────────────────────────────────────────────────────────────────────

const CTX: AgentContext = { runId: "run_value", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} };

/** A `WorkflowContext` whose `step.agent` runs the agent directly — enough to exercise the verdict mapping. */
function fakeWorkflowContext(): WorkflowContext {
  return {
    runId: CTX.runId,
    clientSlug: CTX.clientSlug,
    productId: CTX.productId,
    runKind: CTX.runKind,
    input: {},
    step: {
      code: async <T,>(_id: string, fn: () => T | Promise<T>) => fn(),
      agent: async (_id: string, agent: { run: (ctx: AgentContext, input: unknown) => Promise<unknown> }, input: unknown) => agent.run(CTX, input),
    },
  } as unknown as WorkflowContext;
}

function judgeInput(post: InstagramCopyOutput = keepablePost()): ValueJudgeInput {
  return {
    brief: "Client brief: a servicer of commercial kitchen equipment for independent restaurants.",
    caption: post.caption,
    slides: valueSlidesFor(post),
    factCards: SPECIFIC_CARDS,
    payloadKind: "comparison",
  };
}

function routerCall(router: ReturnType<typeof fakeRouterSequence>, i = 0): unknown[] {
  return (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[i]!;
}

describe("runValueJudge — one Flash call (§5.1)", () => {
  it("maps four verified passes to 'keepable', stamped with the rubric era", async () => {
    const router = fakeRouterSequence([finalTurn(keepableRaw())]);
    const verdict = await runValueJudge(fakeWorkflowContext(), { tools: {}, router, promptStore: makePromptStore() }, "07j-value-judge-attempt-1", judgeInput());
    expect(verdict.status).toBe("keepable");
    if (verdict.status === "error") throw new Error("unreachable");
    expect(verdict.rubricVersion).toBe(VALUE_RUBRIC_VERSION);
    expect(VALUE_RUBRIC_VERSION).toBe("1");
    expect(verdict.axes).toEqual({ newFact: "pass", position: "pass", payload: "pass", action: "pass" });
    expect(verdict.keepLine).toContain("worth its price");
  });

  /**
   * The post the audit charged nothing was catching: correct, grounded,
   * fluent, and worthless. It is now a refusal with four named remedies.
   */
  it("refuses §5.6's grounded, fluent, worthless post and carries the four remedies back", async () => {
    const router = fakeRouterSequence([finalTurn(worthlessRaw())]);
    const verdict = await runValueJudge(
      fakeWorkflowContext(),
      { tools: {}, router, promptStore: makePromptStore() },
      "07j-value-judge-attempt-1",
      judgeInput(worthlessPost()),
    );
    expect(verdict.status).toBe("below-bar");
    if (verdict.status !== "below-bar") throw new Error("unreachable");
    expect(verdict.fixes.map((f) => f.axis)).toEqual(["newFact", "position", "payload", "action"]);
    expect(valueSteerFor(verdict)).toContain("[position] cover: Assert the cause");
  });

  /**
   * An axis outside the rubric is a judge that did not follow it, and a verdict
   * built on it would be a guess dressed as a score. NEVER clamped
   * (`relevance-gate.ts:265-271`). Coerce it to `weak` instead and this
   * refuses.
   */
  it("returns 'error' rather than clamping an axis outside pass / weak / fail", async () => {
    const router = fakeRouterSequence([finalTurn({ ...keepableRaw(), position: "excellent" })]);
    const verdict = await runValueJudge(fakeWorkflowContext(), { tools: {}, router, promptStore: makePromptStore() }, "07j", judgeInput());
    expect(verdict.status).toBe("error");
    if (verdict.status !== "error") throw new Error("unreachable");
    expect(verdict.reason).toContain('returned "excellent" for position');
  });

  it("accepts the rubric's words in any casing, which is a tidy answer and not a wrong one", async () => {
    const router = fakeRouterSequence([finalTurn({ ...keepableRaw(), position: " Pass " })]);
    expect((await runValueJudge(fakeWorkflowContext(), { tools: {}, router, promptStore: makePromptStore() }, "07j", judgeInput())).status).toBe("keepable");
  });

  /**
   * Fails OPEN, and never throws: the caller records a ledger warn and the
   * draft ships unjudged with no redraft burned. Deliberate, and it is the
   * relevance judge's posture for the same reason — the subject of this verdict
   * is visible to the human reviewer at `09a`. "This post is boring" is not
   * invisible to anybody, unlike a Hebrew fluency failure, which is why `07f`
   * fails closed and this does not.
   */
  it("returns 'error' (never throws) when the judge's own output fails its schema", async () => {
    const router = fakeRouterSequence([finalTurn({ newFact: 1 }), finalTurn({ newFact: 1 }), finalTurn({ newFact: 1 })]);
    const verdict = await runValueJudge(fakeWorkflowContext(), { tools: {}, router, promptStore: makePromptStore() }, "07j", judgeInput());
    expect(verdict.status).toBe("error");
    if (verdict.status !== "error") throw new Error("unreachable");
    expect(verdict.reason).toContain("did not complete");
  });

  it("hands the judge the brief, the cards and the post — never visualNeed and never sourceRef", async () => {
    const router = fakeRouterSequence([finalTurn(keepableRaw())]);
    await runValueJudge(fakeWorkflowContext(), { tools: {}, router, promptStore: makePromptStore() }, "07j", judgeInput());
    const prompt = routerCall(router)[0] as string;
    expect(prompt).toContain("servicer of commercial kitchen equipment");
    expect(prompt).toContain("Your walk-in is not dying of old age.");
    expect(prompt).toContain("declaredStructure");
    expect(prompt).not.toContain("a technician opening the condenser panel");
    expect(prompt).not.toContain("sourceRef");
  });

  /**
   * The rubric rides on the system prompt, INLINE, not in the prompt store —
   * the reason `relevance-gate.ts:43-45` states: a check whose wording lived in
   * the same editable store as the drafting prompts could be edited to agree
   * with them. It also means no second registry entry and no second prompt bump.
   *
   * And `allowedTools` is empty on the wire, not merely in the constructor
   * argument: a judge that can call tools is a judge that can be steered.
   */
  it("sends the rubric inline as the system prompt, with no tools offered", async () => {
    const router = fakeRouterSequence([finalTurn(keepableRaw())]);
    await runValueJudge(fakeWorkflowContext(), { tools: {}, router, promptStore: makePromptStore() }, "07j", judgeInput());
    const system = (routerCall(router)[3] as { system?: string }).system!;
    expect(system).toContain(buildValueSystemPrompt());
    expect(system).toContain('"allowedTools":[]');
  });

  /**
   * The no-Opus arithmetic, checked against the REAL catalog rather than
   * restated. `contentLanguageSensitive` is deliberately ABSENT: on a Hebrew
   * run `applyClientLanguagePolicy` would silently re-point the step to a
   * multilingual-strong row and add ~$0.011 to every attempt, for nuance this
   * judge is never asked to detect (nativeness is `07f`'s job, and the rubric
   * says so). Add the flag, or repoint the model, and this refuses.
   */
  it("goes out pinned to budget-tier Flash, with no contentLanguageSensitive flag", async () => {
    const router = fakeRouterSequence([finalTurn(keepableRaw())]);
    await runValueJudge(fakeWorkflowContext(), { tools: {}, router, promptStore: makePromptStore() }, "07j", judgeInput());
    const policy = routerCall(router)[2] as ModelPolicy & { contentLanguageSensitive?: boolean };
    expect(policy).toEqual({ policy: "pinned", model: "gemini-2.5-flash", vendor: "gemini" });
    expect(policy.contentLanguageSensitive).toBeUndefined();

    const row = MODEL_CAPABILITIES[policy.model!]!;
    expect(row.costTier).not.toBe("premium");
    // The flag is unnecessary rather than merely expensive: this row is already
    // rated strong for right-to-left text, so Hebrew loses nothing by its absence.
    expect(row.rtlSupport).toBe("strong");
  });

  it("costs what the module's header says it costs, against the real pricing table", () => {
    const price = MODEL_PRICING["gemini-2.5-flash"]!;
    // Header arithmetic: in ~5,100 tokens (rubric 1,700 + brief 600 + post
    // 1,700 + card digest 800 + scaffolding 300), out ~500.
    const perAttempt = (5_100 / 1_000_000) * price.inputPer1M + (500 / 1_000_000) * price.outputPer1M;
    expect(perAttempt).toBeCloseTo(0.003, 3);
    // Across a 3-attempt run, under 1% of the $1.00 target.
    expect(perAttempt * 3).toBeLessThan(0.01);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The text the span rule reads
// ─────────────────────────────────────────────────────────────────────────

describe("valueDraftText and valueSlidesFor — the model's own bytes", () => {
  it("is the caption and every slide's headline and body, in reading order", () => {
    const post = keepablePost();
    expect(valueDraftText(post.caption, valueSlidesFor(post)).split("\n")).toEqual([
      post.caption,
      post.slides[0]!.headline,
      post.slides[0]!.body,
      post.slides[1]!.headline,
      post.slides[1]!.body,
      post.slides[2]!.headline,
      post.slides[2]!.body,
      post.slides[3]!.headline,
      post.slides[3]!.body,
    ]);
  });

  it("carries the slide number but nothing a different step owns", () => {
    expect(valueSlidesFor(keepablePost())[0]).toEqual({
      n: 1,
      headline: "Your walk-in is not dying of old age. It is dying of a dirty condenser coil.",
      body: "The part that fails is almost never the part that was neglected.",
    });
  });

  /**
   * Phase 4's bidi isolates are applied to RENDERED SLIDE TEXT ONLY and never
   * to anything a gate reads, so no stripping step is needed and none is
   * written — an exact substring test is the whole rule. A Hebrew post's own
   * words verify unchanged, and the span rule is therefore as real in Hebrew as
   * in English.
   */
  it("verifies a Hebrew quote against a Hebrew draft with no stripping step", () => {
    const hebrew = {
      format: "carousel",
      caption: "תפתחו את הפאנל, תצלמו את הסליל, ותשלחו לי את התמונה.",
      slides: [
        slide(1, "המקרר שלכם לא מת מזקנה. הוא מת מסליל מלוכלך.", "החלק שנשרף הוא כמעט אף פעם לא החלק שהוזנח."),
        slide(2, "ניקוי רבעוני חוסך חשמל.", "סליל שמנוקה ארבע פעמים בשנה צורך בערך 12 אחוז פחות חשמל מסליל שמנוקה פעם בשנה."),
      ],
    } as InstagramCopyOutput;
    const out = normaliseValueVerdict(
      {
        newFact: "pass",
        position: "pass",
        payload: "pass",
        action: "pass",
        newFactQuote: "בערך 12 אחוז פחות חשמל",
        positionQuote: "המקרר שלכם לא מת מזקנה.",
        payloadQuote: hebrew.slides[1]!.body,
        actionQuote: "תפתחו את הפאנל, תצלמו את הסליל",
        keepLine: "בעל מסעדה ישמור את זה כדי להחליט אם חוזה השירות הרבעוני שווה את המחיר.",
      },
      draftOf(hebrew),
    );
    expect(out.axes).toEqual({ newFact: "pass", position: "pass", payload: "pass", action: "pass" });
    expect(Object.keys(out.verifiedQuotes)).toHaveLength(4);
    expect(out.keepable).toBe(true);

    // And a Hebrew paraphrase is refused exactly like an English one, so the
    // rule is not quietly weaker in the language Phase 4 made first-class.
    const paraphrased = normaliseValueVerdict(
      {
        newFact: "pass",
        position: "pass",
        payload: "pass",
        action: "pass",
        newFactQuote: "בערך 12 אחוז פחות חשמל",
        positionQuote: "המקרר שלכם לא מת מזקנה אלא מסליל",
        payloadQuote: hebrew.slides[1]!.body,
        actionQuote: "תפתחו את הפאנל, תצלמו את הסליל",
        keepLine: "כדי להחליט אם חוזה השירות שווה את המחיר.",
      },
      draftOf(hebrew),
    );
    expect(paraphrased.axes.position).toBe("weak");
  });
});
