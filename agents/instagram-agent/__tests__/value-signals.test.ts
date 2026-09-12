import { describe, expect, it } from "vitest";
import type { FactCardForPrompt } from "../src/workflow/fact-cards.js";
import type { InstagramCopyOutput, InstagramSlideCopy } from "../src/workflow/types.js";
import {
  SOURCE_PROSE_TOKENS,
  SOURCE_PROSE_TOKENS_RTL,
  checkCoverTension,
  checkNamedSpecifics,
  checkPayloadShape,
  checkRhythm,
  checkSourceProse,
  checkValueSignals,
  hasNamedSpecific,
  isRtlPost,
  namedSpecificsRequired,
  valueTokens,
} from "../src/workflow/value-signals.js";

/**
 * RFC-18 §4.1 — `07i-value-signals`, the FREE half of the value gate.
 *
 * Every guard here was written by breaking the code and watching the test
 * refuse. The four the RFC names by hand are marked GUARD PROOF below; each
 * one says, in the test, what to break to make it go green.
 *
 * The client is a servicer of commercial kitchen equipment for independent
 * restaurants — the RFC's own neutral trade, chosen so no example here can
 * teach a topic to a client that does not have one. The reference accounts
 * the owner supplied post about AI and marketing; their EXECUTION transfers,
 * their SUBJECT MATTER never does, and a fixture is one of the places that
 * rule is easiest to break silently.
 */

const KITCHEN_BRIEF = {
  coreTerms: ["walk-in", "condenser", "service contract", "refrigeration"],
  offers: [{ name: "Quarterly coil service", summary: "Four visits a year, parts included." }],
};

function slide(n: number, headline: string, body: string, extra: Partial<InstagramSlideCopy> = {}): InstagramSlideCopy {
  return {
    n,
    headline,
    body,
    visualNeed: "a technician opening the condenser panel on a walk-in cooler",
    sourceRef: "fixture",
    layout: "photo",
    ...extra,
  } as InstagramSlideCopy;
}

function copy(slides: InstagramSlideCopy[], overrides: Partial<InstagramCopyOutput> = {}): InstagramCopyOutput {
  return {
    format: "carousel",
    caption: "What a quarterly coil clean is actually worth on a two horsepower compressor, and how to tell whether yours needs one.",
    slides,
    ...overrides,
  } as InstagramCopyOutput;
}

function card(claim: string, extra: Partial<FactCardForPrompt> = {}): FactCardForPrompt {
  return { claim, kind: "stat", source: "ASHRAE field study", date: "2026-03-01", ...extra };
}

/** Six slides that clear every check — the base every single-check test perturbs. */
function goodPost(): InstagramCopyOutput {
  return copy([
    slide(1, "Your walk-in is not dying of old age.", "It is dying of a dirty condenser coil, and that is a 20 dollar brush, not a 6000 dollar compressor."),
    slide(2, "Dust is an insulator.", "A coated coil makes the compressor run longer for the same cabinet temperature, so you pay for cooling the dust first."),
    slide(3, "Quarterly beats annually.", "A coil cleaned four times a year draws about 12 percent less power than one cleaned once, which is roughly 40 dollars a month on a 2 HP compressor."),
    slide(4, "Check the discharge line.", "If it is too hot to hold for three seconds, the head pressure is already high and the coil is the first thing to rule out."),
    slide(5, "Most service contracts bill this separately.", "Read what the quarterly visit actually includes before you renew, because coil cleaning is often an add on."),
    slide(6, "One photo tells you.", "Open the panel, photograph the coil, and reply with it if you want a straight answer on whether it needs a clean this month."),
  ]);
}

describe("valueTokens — the tokenising every check shares", () => {
  it("folds case, strips edge punctuation, and drops empties", () => {
    expect(valueTokens("  A coil, cleaned QUARTERLY.  ")).toEqual(["a", "coil", "cleaned", "quarterly"]);
  });

  /**
   * Nikud is decoration a writer may add or drop without changing a word, so
   * a lifted Hebrew sentence must not escape the n-gram rule by being
   * pointed. Devanagari and Thai combining marks are VOWELS and are left
   * alone, which is why the strip is two ranges rather than `\p{Mn}`.
   */
  it("strips Hebrew diacritics so a pointed lift still matches an unpointed card", () => {
    expect(valueTokens("שָׁלוֹם עוֹלָם")).toEqual(valueTokens("שלום עולם"));
    expect(valueTokens("हिन्दी")).toEqual(["हिन्दी"]);
  });
});

describe("isRtlPost", () => {
  it("reads the DECLARED language first, in either spelling", () => {
    expect(isRtlPost("Hebrew", "anything")).toBe(true);
    expect(isRtlPost("he-IL", "anything")).toBe(true);
    expect(isRtlPost("English", "שלום עולם")).toBe(false);
  });

  it("falls back to the post's own letters when no language was declared", () => {
    expect(isRtlPost(undefined, "מסעדות עצמאיות משלמות בממוצע ארבעים שקלים בחודש על מאוורר מלוכלך ולא יודעות על כך")).toBe(true);
    expect(isRtlPost(undefined, "A coil cleaned quarterly draws about twelve percent less power than one cleaned once a year.")).toBe(false);
  });
});

describe("checkSourceProse — the ban on reproducing the source's prose (§4.1 #1)", () => {
  const CLAIM = "Teams that automated their weekly reporting saved an average of four hours per week.";

  /**
   * GUARD PROOF. Lower `SOURCE_PROSE_TOKENS` to 7 and the seven-token case
   * below goes red; raise it to 9 and this one goes green. The two cases are
   * one token apart on purpose: a threshold with only one side tested is a
   * threshold nobody has checked.
   */
  it("refuses an eight-token lift and passes a seven-token overlap", () => {
    expect(SOURCE_PROSE_TOKENS).toBe(8);
    const eight = checkSourceProse(copy([slide(1, "The finding", "Teams that automated their weekly reporting saved an hour a day on top of it.")]), [card(CLAIM)]);
    expect(eight.ok).toBe(false);
    if (eight.ok) throw new Error("unreachable");
    expect(eight.reason).toContain("slide 1's body");
    expect(eight.reason).toContain("teams that automated their weekly reporting saved an");

    const seven = checkSourceProse(copy([slide(1, "The finding", "Teams that automated their weekly reporting saved roughly an hour a day.")]), [card(CLAIM)]);
    expect(seven.ok).toBe(true);
  });

  it("reads the caption too, not only the slides", () => {
    const post = copy([slide(1, "The finding", "A cleaner coil costs less to run.")], {
      caption: "Here is the number: teams that automated their weekly reporting saved an average of four hours per week.",
    });
    const verdict = checkSourceProse(post, [card(CLAIM)]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("the caption");
  });

  /**
   * `sourceRef` is a CITATION: prompt §4 requires it to carry the card's claim
   * character for character, so a check that read it would fail every
   * correctly sourced draft. Break the exclusion and this test refuses.
   */
  it("never inspects sourceRef, which is required to be verbatim", () => {
    const post = copy([slide(1, "The finding", "A cleaner coil costs less to run.", { sourceRef: CLAIM })]);
    expect(checkSourceProse(post, [card(CLAIM)]).ok).toBe(true);
  });

  const LONG_QUOTE =
    "The compressor is not usually the part that fails first on a walk in cooler, and in almost every case we open up the real cause turns out to be a condenser coil nobody has touched in a year.";

  /**
   * GUARD PROOF. A `quote_card`'s pull quote is SUPPOSED to be verbatim: the
   * quotation is the slide and the speaker is named on it, which is the one
   * place a reader is told these are somebody else's words. Delete the
   * `layout !== "quote_card"` exclusion and the first case refuses; delete the
   * scan of `body` and the second stops refusing.
   */
  it("passes a twenty-token run inside a labelled quote_card and refuses the same words in a body", () => {
    expect(valueTokens(LONG_QUOTE).length).toBeGreaterThanOrEqual(20);
    const quoted = copy([
      slide(1, "What the service manager says", "We hear this on almost every callout.", {
        layout: "quote_card",
        quote: { text: LONG_QUOTE, attribution: "Dana Weiss, service manager" },
      }),
    ]);
    expect(checkSourceProse(quoted, [card("x", { quote: LONG_QUOTE })]).ok).toBe(true);

    const lifted = copy([slide(1, "What the service manager says", LONG_QUOTE)]);
    expect(checkSourceProse(lifted, [card("x", { quote: LONG_QUOTE })]).ok).toBe(false);
  });

  const HEBREW_CLAIM = "מסעדות עצמאיות משלמות בממוצע ארבעים שקלים בחודש על קירור לא יעיל";

  /**
   * GUARD PROOF, and the reason the threshold is a pair rather than a
   * constant. Hebrew fuses articles, conjunctions and prepositions into
   * clitics, so six Hebrew words carry roughly the information of eight
   * English ones; an 8-gram rule in Hebrew is a rule that never fires. Set
   * `SOURCE_PROSE_TOKENS_RTL` to 8 and the six-token case goes green, which is
   * exactly the silent non-enforcement this pair exists to prevent.
   */
  it("refuses a Hebrew lift at SIX tokens and passes at five", () => {
    expect(SOURCE_PROSE_TOKENS_RTL).toBe(6);
    const six = copy([slide(1, "המספר", "מסעדות עצמאיות משלמות בממוצע ארבעים שקלים וזה לפני התיקון עצמו")], {
      caption: "כמה באמת עולה סליל מלוכלך במקרר תעשייתי, ומה אפשר לעשות עם זה היום.",
    });
    expect(checkSourceProse(six, [card(HEBREW_CLAIM)], { targetLanguage: "he-IL" }).ok).toBe(false);

    const five = copy([slide(1, "המספר", "מסעדות עצמאיות משלמות בממוצע ארבעים ולפעמים הרבה יותר מזה")], {
      caption: "כמה באמת עולה סליל מלוכלך במקרר תעשייתי, ומה אפשר לעשות עם זה היום.",
    });
    expect(checkSourceProse(five, [card(HEBREW_CLAIM)], { targetLanguage: "he-IL" }).ok).toBe(true);

    // And with no declared language at all: the post's own letters decide, so
    // a Hebrew client whose language was never set is not silently unchecked.
    expect(checkSourceProse(six, [card(HEBREW_CLAIM)]).ok).toBe(false);
  });
});

describe("checkNamedSpecifics — a category noun is not a specific (§4.1 #2)", () => {
  it("requires ceil(slides / 3) slides to carry one", () => {
    expect(namedSpecificsRequired(6)).toBe(2);
    expect(namedSpecificsRequired(8)).toBe(3);
    expect(namedSpecificsRequired(1)).toBe(1);
  });

  it("counts figures with units, years, prices, the client's own core terms and proper nouns", () => {
    expect(hasNamedSpecific("about 12 percent less power")).toBe(true);
    expect(hasNamedSpecific("roughly 40 dollars a month")).toBe(true);
    expect(hasNamedSpecific("the 2019 revision of the standard")).toBe(true);
    expect(hasNamedSpecific("as Carrier Transicold recommends")).toBe(true);
    expect(hasNamedSpecific("check the condenser first", ["condenser"])).toBe(true);
    // Hebrew has no case, which is why the core-terms and numeral paths are
    // not decoration: the capitalised-run path cannot fire here at all.
    expect(hasNamedSpecific("הסליל מתלכלך תוך שנה")).toBe(false);
    expect(hasNamedSpecific("הסליל מתלכלך תוך 12 חודשים")).toBe(true);
    expect(hasNamedSpecific("modern platforms and productivity tools for the industry")).toBe(false);
  });

  it("refuses a carousel of category nouns and passes once two slides carry a specific", () => {
    const vague = copy([
      slide(1, "Preventive maintenance matters", "Regular servicing can help reduce unexpected downtime."),
      slide(2, "Efficiency is important", "Well maintained equipment tends to perform better over time."),
      slide(3, "Plan ahead", "Thinking about service before the season starts is a good idea."),
      slide(4, "Talk to a professional", "An expert can advise you on what your kitchen needs."),
      slide(5, "Stay consistent", "A regular routine is better than an occasional deep clean."),
      slide(6, "Get in touch", "We are always happy to help with whatever you need."),
    ]);
    const verdict = checkNamedSpecifics(vague, KITCHEN_BRIEF);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("only 0 of 6 slides");

    expect(checkNamedSpecifics(goodPost(), KITCHEN_BRIEF).ok).toBe(true);
  });

  it("reads a stat_callout's figure, which the prose ban deliberately does not", () => {
    const post = copy([
      slide(1, "The number", "That is what a coated coil costs you.", { layout: "stat_callout", stat: { figure: "12%", subLabel: "more power drawn", source: "ASHRAE" } }),
    ]);
    expect(checkNamedSpecifics(post).ok).toBe(true);
  });
});

describe("checkCoverTension — the hedged cover (§4.1 #3)", () => {
  it("refuses a line that would be true for every business in the industry", () => {
    const verdict = checkCoverTension(copy([slide(1, "Preventive maintenance matters more than ever for modern kitchens.", "Regular servicing helps.")]), KITCHEN_BRIEF);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("no number, no named specific and no contrast");
  });

  it.each([
    ["a contrast", "Your walk-in is not dying of old age."],
    ["a refusal", "Stop paying for a compressor rebuild."],
    ["a number", "Four visits a year, one of them matters."],
    ["an instead-of", "Clean the coil instead of replacing the unit."],
  ])("accepts a cover carrying %s", (_shape, headline) => {
    expect(checkCoverTension(copy([slide(1, headline, "body")]), KITCHEN_BRIEF).ok).toBe(true);
  });

  it("accepts the Hebrew contrast markers, which a JavaScript word boundary cannot see", () => {
    // `\b` is defined over `[A-Za-z0-9_]` even under `/u`, so a Hebrew pattern
    // written with one can never match. This case is why the markers carry
    // none: break them back and it refuses.
    expect(checkCoverTension(copy([slide(1, "במקום להחליף מדחס, תנקו את הסליל", "גוף")])).ok).toBe(true);
    expect(checkCoverTension(copy([slide(1, "תפסיקו לשלם על תיקוני חירום", "גוף")])).ok).toBe(true);
    expect(checkCoverTension(copy([slide(1, "זה לא הגיל של המקרר אלא הסליל", "גוף")])).ok).toBe(true);
    expect(checkCoverTension(copy([slide(1, "תחזוקה מונעת חשובה למטבחים מודרניים", "גוף")])).ok).toBe(false);
  });

  it("reads the cover ARCHETYPE when one exists, not blindly slide 1", () => {
    const post = copy([
      slide(1, "תחזוקה מונעת חשובה", "גוף", { layout: "photo" }),
      slide(2, "Stop replacing compressors", "body", { layout: "cover" }),
    ]);
    expect(checkCoverTension(post).ok).toBe(true);
  });
});

describe("checkPayloadShape — the declared kind against the structure (§4.1 #4)", () => {
  const six = goodPost();

  it("has no opinion when nothing was declared", () => {
    expect(checkPayloadShape(six, undefined).ok).toBe(true);
    expect(checkPayloadShape(six, "").ok).toBe(true);
  });

  it("refuses a ranking with nothing a reader can count", () => {
    const verdict = checkPayloadShape(six, "ranking");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("at least 3 slides a reader can count");
  });

  it("accepts a ranking once the slides are numbered", () => {
    const ranked = copy(six.slides.map((s, i) => ({ ...s, headline: `${i + 1}. ${s.headline}` })));
    expect(checkPayloadShape(ranked, "ranking").ok).toBe(true);
  });

  it("refuses a comparison with no comparison_card and accepts one with", () => {
    expect(checkPayloadShape(six, "comparison").ok).toBe(false);
    const compared = copy([
      ...six.slides.slice(0, 5),
      slide(6, "Quarterly against annual", "The two service intervals, side by side.", {
        layout: "comparison_card",
        comparison: { leftLabel: "Quarterly", leftBody: "12 percent less power", rightLabel: "Annual", rightBody: "one visit, four seasons of dust" },
      }),
    ]);
    expect(checkPayloadShape(compared, "comparison").ok).toBe(true);
  });

  it("refuses single-claim on a carousel and accepts it on a single-image post", () => {
    expect(checkPayloadShape(six, "single-claim").ok).toBe(false);
    expect(checkPayloadShape(copy([six.slides[0]!], { format: "single" }), "single-claim").ok).toBe(true);
  });

  it("refuses a glossary that is too short to be one, and has no structural opinion about a timeline", () => {
    expect(checkPayloadShape(copy(six.slides.slice(0, 3)), "glossary").ok).toBe(false);
    expect(checkPayloadShape(six, "timeline").ok).toBe(true);
    expect(checkPayloadShape(six, "myth-vs-fact").ok).toBe(true);
  });

  it("refuses a kind nobody defined", () => {
    expect(checkPayloadShape(six, "listicle").ok).toBe(false);
  });
});

describe("checkRhythm — the two mechanical halves of prompt §26 (§4.1 #5)", () => {
  it("refuses three slides that open with the same word", () => {
    const repeated = copy([
      slide(1, "How dust costs you money", "body one"),
      slide(2, "Why the coil matters", "body two"),
      slide(3, "How the compressor reacts", "body three"),
      slide(4, "The discharge line test", "body four"),
      slide(5, "How to check it yourself", "body five"),
      slide(6, "One photo tells you", "body six"),
    ]);
    const verdict = checkRhythm(repeated);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("slides 1, 3, 5 all open with the word \"how\"");
  });

  it("refuses three consecutive headlines of the same recognisable shape", () => {
    const monotone = copy([
      slide(1, "Your coil is filthy", "body one"),
      slide(2, "Is your compressor working harder than it should?", "body two"),
      slide(3, "When did you last open the panel?", "body three"),
      slide(4, "What does a clean coil actually save?", "body four"),
      slide(5, "The discharge line test", "body five"),
      slide(6, "One photo tells you", "body six"),
    ]);
    const verdict = checkRhythm(monotone);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("three consecutive headlines built as a question");
  });

  /**
   * The `other` bucket is never counted as a repetition. This is the check's
   * own honesty rule: "imperative" is not a shape a regex can see in every
   * script, so a run of three headlines the classifier has no opinion about
   * must never cost a drafting attempt.
   */
  it("never refuses a run the classifier has no opinion about", () => {
    expect(checkRhythm(goodPost()).ok).toBe(true);
    const unclassifiable = copy([
      slide(1, "Dirty coil, dead compressor", "body one"),
      slide(2, "Twenty dollar brush", "body two"),
      slide(3, "Friday service call", "body three"),
      slide(4, "Cabinet temperature drift", "body four"),
      slide(5, "Panel off, photo taken", "body five"),
      slide(6, "Renewal season", "body six"),
    ]);
    expect(checkRhythm(unclassifiable).ok).toBe(true);
  });

  it("has nothing to say about a single-image post", () => {
    expect(checkRhythm(copy([slide(1, "Your coil is filthy", "body")], { format: "single" })).ok).toBe(true);
  });
});

describe("checkValueSignals — the step, first refusal wins", () => {
  it("passes a post that clears all five", () => {
    expect(checkValueSignals({ copy: goodPost(), factCards: [card("Condenser coils foul within a year in a commercial kitchen.")], brief: KITCHEN_BRIEF }).ok).toBe(true);
  });

  /**
   * Ordering matters to the writer, not only to the reader: a draft that
   * lifted its source's sentences is returned for THAT, not for a rhythm
   * finding it also happens to have. One reason at a time is what a redraft
   * steer can act on.
   */
  it("reports the prose lift ahead of every other finding a draft also has", () => {
    const claim = "Teams that automated their weekly reporting saved an average of four hours per week.";
    const bad = copy([
      slide(1, "Preventive maintenance matters", "Teams that automated their weekly reporting saved an hour a day."),
      slide(2, "Preventive care helps", "General guidance only."),
      slide(3, "Preventive thinking wins", "General guidance only."),
    ]);
    const verdict = checkValueSignals({ copy: bad, factCards: [card(claim)], brief: KITCHEN_BRIEF, payloadKind: "ranking" });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("reproduces 8 consecutive words");
  });

  it("returns the house SlidesDataSelfCheck shape, so a refusal routes into step 07's existing loop", () => {
    const hedged = copy([
      slide(1, "Preventive maintenance matters more than ever", "Regular servicing helps."),
      slide(2, "Efficiency is important", "Well maintained equipment performs better."),
      slide(3, "Plan ahead", "Think about service before the season."),
    ]);
    const verdict = checkValueSignals({ copy: hedged, factCards: [], brief: KITCHEN_BRIEF });
    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining("the cover headline") });
  });
});
