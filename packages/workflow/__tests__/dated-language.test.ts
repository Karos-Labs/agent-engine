import { describe, expect, it } from "vitest";
import { relativeDayHeldReason, relativeDayIssues } from "../src/primitives/dated-language.js";

describe("relativeDayIssues", () => {
  it("catches the sentence that shipped: a funding round that closed 'yesterday'", () => {
    // Karos Labs' LinkedIn draft, 17.9.2026. The round closed on the 15th.
    const issues = relativeDayIssues("Profound closed a $180 million Series D yesterday at a $1.8 billion valuation.");
    expect(issues).toEqual(["yesterday"]);
  });

  it("catches every phrase that can only mean one day", () => {
    expect(relativeDayIssues("We ship tomorrow.")).toEqual(["tomorrow"]);
    expect(relativeDayIssues("Announced this morning.")).toEqual(["this morning"]);
    expect(relativeDayIssues("The keynote is tonight.")).toEqual(["tonight"]);
    expect(relativeDayIssues("It broke last night.")).toEqual(["last night"]);
    expect(relativeDayIssues("Filed earlier today.")).toEqual(["earlier today"]);
    expect(relativeDayIssues("More later today.")).toEqual(["later today"]);
    expect(relativeDayIssues("Signed the day before yesterday.")).toEqual(["the day before yesterday"]);
  });

  /**
   * The exclusions are the whole design. Each of these is ordinary, correct
   * English that a good draft uses, and a lint that held them would be
   * switched off inside a week.
   */
  it("leaves bare 'today' alone, because it usually means nowadays", () => {
    expect(relativeDayIssues("The tools available today do not track this.")).toEqual([]);
    expect(relativeDayIssues("Founders today form opinions in ChatGPT.")).toEqual([]);
    expect(relativeDayIssues("Today's buyers ask an AI first.")).toEqual([]);
  });

  it("leaves week-scale frames alone, because they survive a few days in review", () => {
    expect(relativeDayIssues("Last week's citation data says otherwise.")).toEqual([]);
    expect(relativeDayIssues("This week we published the methodology.")).toEqual([]);
    expect(relativeDayIssues("This month, three of them repriced.")).toEqual([]);
  });

  it("does not fire on a word that merely contains one", () => {
    // No \b-less substring matching: these are real words in real drafts.
    expect(relativeDayIssues("Tomorrowland is a festival.")).toEqual([]);
    expect(relativeDayIssues("Midnight is not a day anchor here.")).toEqual([]);
  });

  it("reports the whole phrase once, not its parts, and not twice", () => {
    expect(relativeDayIssues("Earlier today, and again earlier today.")).toEqual(["earlier today"]);
    // "the day before yesterday" is reported as itself; the bare "yesterday"
    // inside it is the same finding and must not be listed a second time.
    expect(relativeDayIssues("Signed the day before yesterday.")).toEqual(["the day before yesterday"]);
  });

  it("finds a phrase anywhere in the text, including a later thread part", () => {
    const thread = ["SEO ranks your page.", "GEO shapes what AI says.", "They announced it yesterday."].join("\n\n");
    expect(relativeDayIssues(thread)).toEqual(["yesterday"]);
  });

  it("is empty for a draft that names the date, which is the fix", () => {
    expect(relativeDayIssues("Profound closed a $180 million Series D on September 15.")).toEqual([]);
  });
});

describe("relativeDayHeldReason", () => {
  it("quotes what it found and says what to write instead", () => {
    const reason = relativeDayHeldReason(["yesterday"], "linkedin-craft §12");
    expect(reason).toContain('"yesterday"');
    expect(reason).toContain("linkedin-craft §12");
    // A revision told only "fix the date" picks a different wrong date.
    expect(reason).toContain("name the date instead");
  });
});
