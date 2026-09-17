import { describe, expect, it } from "vitest";
import {
  CAPTION_MAX_EMOJI,
  CAPTION_MAX_WORDS_PER_LINE,
  checkCaptionRegister,
  checkNoCompetitorNames,
  checkTopicPlacement,
  countEmoji,
  hookOf,
  namesTopic,
  significantWords,
} from "../src/workflow/caption-craft.js";

/**
 * Phase 5.6, items B4 and B8.
 *
 * The bar these rules are calibrated against is the owner's own reference
 * accounts: short declarative lines, one idea each, at most two emoji, the
 * ask at the end. The thing being refused is what this agent was writing
 * instead — a dense analytical paragraph citing report names.
 *
 * Each rule has a pass case that is REALISTIC rather than minimal, because a
 * shape rule that only ever sees `"a"` and `"a".repeat(500)` is not calibrated
 * against anything.
 */

const REFERENCE_CAPTION = [
  "We measured every process change we made this quarter.",
  "Not one of them returned what we assumed it would.",
  "The change we almost cut saved the most time.",
  "",
  "Save this before your next planning week.",
].join("\n");

describe("hookOf", () => {
  it("is the caption's first non-empty line, which is what the feed shows before 'more'", () => {
    expect(hookOf(REFERENCE_CAPTION)).toBe("We measured every process change we made this quarter.");
  });

  it("skips leading blank lines rather than returning an empty hook", () => {
    expect(hookOf("\n\n  Real first line.\nSecond.")).toBe("Real first line.");
  });

  it("is empty for an empty caption, and does not throw", () => {
    expect(hookOf("")).toBe("");
    expect(hookOf("   \n  ")).toBe("");
  });
});

describe("countEmoji", () => {
  it("counts a ZWJ family as ONE emoji, because that is what a reader sees", () => {
    expect(countEmoji("👨‍👩‍👧‍👦")).toBe(1);
  });

  it("counts a variation-selector emoji as one", () => {
    expect(countEmoji("☀️")).toBe(1);
  });

  it("counts plainly otherwise", () => {
    expect(countEmoji("no emoji here")).toBe(0);
    expect(countEmoji("one 🙂 and two 🔥")).toBe(2);
  });
});

describe("checkCaptionRegister (item B4)", () => {
  it("passes a caption written the way the reference accounts write", () => {
    expect(checkCaptionRegister(REFERENCE_CAPTION)).toEqual({ ok: true });
  });

  it("refuses the dense analytical paragraph this agent was writing", () => {
    const paragraph =
      "We measured every process change we made this quarter instead of trusting our memory of it, " +
      "and here is what each one returned, along with which one we would do first if we were starting " +
      "the quarter over again with what we now know.";
    const finding = checkCaptionRegister(paragraph);
    expect(finding.ok).toBe(false);
    expect(finding.reason).toContain("words");
  });

  it(`allows exactly ${CAPTION_MAX_WORDS_PER_LINE} words on a line and refuses one more`, () => {
    const atLimit = Array.from({ length: CAPTION_MAX_WORDS_PER_LINE }, () => "word").join(" ");
    expect(checkCaptionRegister(atLimit).ok).toBe(true);
    expect(checkCaptionRegister(`${atLimit} more`).ok).toBe(false);
  });

  it(`allows ${CAPTION_MAX_EMOJI} emoji and refuses a third`, () => {
    expect(checkCaptionRegister("A line. 🙂\nAnother line. 🔥").ok).toBe(true);
    const finding = checkCaptionRegister("A line. 🙂\nAnother. 🔥\nA third. 🚀");
    expect(finding.ok).toBe(false);
    expect(finding.reason).toContain("3 emoji");
  });

  it("refuses a caption that is ONLY bullets — the slides again, in text", () => {
    const listOnly = ["→ Measure the change", "→ Compare to the assumption", "→ Keep the one that paid"].join("\n");
    const finding = checkCaptionRegister(listOnly);
    expect(finding.ok).toBe(false);
    expect(finding.reason).toContain("bullet");
  });

  it("ALLOWS arrow bullets among prose, which is how the reference accounts actually write", () => {
    const mixed = ["Three things moved the number this quarter.", "→ Weekly reporting", "→ One fewer approval", "Save this for your planning week."].join("\n");
    expect(checkCaptionRegister(mixed)).toEqual({ ok: true });
  });

  it("does not call two bullets a list — the rule is about the whole shape", () => {
    expect(checkCaptionRegister("→ One\n→ Two").ok).toBe(true);
  });

  it("refuses an empty caption", () => {
    expect(checkCaptionRegister("   ").ok).toBe(false);
  });
});

describe("significantWords / namesTopic (item B8)", () => {
  it("drops the words that prove nothing by appearing", () => {
    expect(significantWords("How to fix your onboarding")).toEqual(["fix", "onboarding"]);
  });

  it("drops a Hebrew particle for the same reason it drops \"of\"", () => {
    expect(significantWords("זמן קליטה של עובדים")).toEqual(["זמן", "קליטה", "עובדים"]);
  });

  it("survives ordinary editing: a headline that says \"cut\" still names \"cutting onboarding time\"", () => {
    // One of the two cases that set the bar. A majority rule scores this 1 in
    // 3 and refuses a cover any reader would say is about exactly this topic.
    expect(namesTopic("We cut onboarding from 14 days to 3", "cutting onboarding time")).toBe(true);
  });

  it("survives a topic sentence whose longest word is not its subject", () => {
    // The other case, taken from this repo's own fixture. A
    // longest-word-is-the-subject rule picks "automated" here and refuses a
    // correct cover; length is not subjecthood.
    const topic = "automated weekly reporting is replacing the Monday status meeting";
    expect(namesTopic("Stop hand-building the weekly report", topic)).toBe(true);
  });

  it("refuses text that carries none of them", () => {
    expect(namesTopic("Our pricing page converts better now", "cutting onboarding time")).toBe(false);
  });

  it("matches across a Hebrew prefix particle, which a word-boundary match would miss", () => {
    expect(namesTopic("שיפרנו את הקליטה של העובדים החדשים", "קליטה עובדים")).toBe(true);
  });

  it("has no opinion when the phrase carries no significant words at all", () => {
    expect(namesTopic("anything", "the a of")).toBe(true);
    expect(significantWords("the a of")).toEqual([]);
  });
});

describe("checkTopicPlacement (item B8) — the finding the craft gate REPORTS", () => {
  const ok = {
    phrase: "onboarding time",
    coverText: "We cut onboarding time in half",
    caption: "Onboarding time was our worst number.\nHere is what moved it.",
  };

  it("passes when the phrase is in both places", () => {
    expect(checkTopicPlacement(ok)).toEqual({ ok: true });
  });

  it("names BOTH places when both miss it, not just the first", () => {
    const finding = checkTopicPlacement({ phrase: "onboarding time", coverText: "We fixed it", caption: "A better quarter.\nHere is how." });
    expect(finding.ok).toBe(false);
    expect(finding.reason).toContain("slide 1");
    expect(finding.reason).toContain("first line");
  });

  it("reads the caption's FIRST LINE only — that is the part the feed shows", () => {
    const buried = { ...ok, caption: "Our worst number last quarter.\nIt was onboarding time." };
    const finding = checkTopicPlacement(buried);
    expect(finding.ok).toBe(false);
    expect(finding.reason).toContain("first line");
    expect(finding.reason).not.toContain("slide 1");
  });

  it("does NOT look at alt text, which the packager writes from words the copy step already chose", () => {
    // The specification names alt text alongside these two. It is left out
    // because no step can act on a finding about it: by the time alt text is
    // written the caption and the cover are final.
    expect(Object.keys(ok)).toEqual(["phrase", "coverText", "caption"]);
  });

  it("has no opinion when no topic was passed — a missing topic is a fact about the caller", () => {
    expect(checkTopicPlacement({ ...ok, phrase: "  " })).toEqual({ ok: true });
  });
});

describe("checkNoCompetitorNames (item C5)", () => {
  const rivals = ["Northwind Logistics", "Acme Freight", "Kestrel"];
  const texts = (t: string) => ({ texts: [t] });

  it("passes a post that names nobody", () => {
    expect(checkNoCompetitorNames(rivals, texts("Three things that moved our delivery times."))).toEqual({ ok: true });
  });

  it("refuses a post that names a competitor, and says which", () => {
    const finding = checkNoCompetitorNames(rivals, texts("Unlike Northwind Logistics, we publish our on-time rate."));
    expect(finding.ok).toBe(false);
    expect(finding.reason).toContain("Northwind Logistics");
  });

  it("looks at EVERY public surface, not only the caption", () => {
    const finding = checkNoCompetitorNames(rivals, { texts: ["A clean caption.", "A clean slide.", "alt: a lorry in Kestrel livery"] });
    expect(finding.ok).toBe(false);
  });

  it("matches a whole word only — a competitor called Kestrel does not fire on Kestrels Ltd's own word", () => {
    expect(checkNoCompetitorNames(["Kestrel"], texts("The kestrelcam we built last year")).ok).toBe(true);
    expect(checkNoCompetitorNames(["Kestrel"], texts("We beat Kestrel on price")).ok).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(checkNoCompetitorNames(["Kestrel"], texts("we beat KESTREL on price")).ok).toBe(false);
  });

  it("matches across a Hebrew word boundary, where a JavaScript \b does nothing", () => {
    expect(checkNoCompetitorNames(["Kestrel"], texts("ניצחנו את Kestrel במחיר")).ok).toBe(false);
  });

  it("ignores a name too short to be distinctive", () => {
    expect(checkNoCompetitorNames(["AWS"], texts("The aws of the matter")).ok).toBe(true);
  });

  it("ignores a competitor whose name is an ordinary word — that judgement belongs to the prompt", () => {
    expect(checkNoCompetitorNames(["Apple"], texts("An apple a day, as the saying goes")).ok).toBe(true);
    expect(checkNoCompetitorNames(["Monday"], texts("Your Monday status meeting")).ok).toBe(true);
  });

  it("has no opinion when the client tracks no competitors", () => {
    expect(checkNoCompetitorNames([], texts("Anything at all"))).toEqual({ ok: true });
  });

  it("does not let a regex-shaped name break the matcher", () => {
    expect(checkNoCompetitorNames(["C++ Freight (UK)"], texts("a clean line")).ok).toBe(true);
    expect(checkNoCompetitorNames(["C++ Freight (UK)"], texts("we beat C++ Freight (UK) on price")).ok).toBe(false);
  });
});
