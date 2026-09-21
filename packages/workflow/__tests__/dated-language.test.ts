import { describe, expect, it } from "vitest";
import { relativeDayIssues, relativeDayProblems, stripRelativeDays } from "../src/primitives/dated-language.js";

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

describe("relativeDayProblems", () => {
  it("quotes what it found and says what to write instead", () => {
    const [problem] = relativeDayProblems("Closed its Series D yesterday.", "linkedin-craft §12a");
    expect(problem).toContain('"yesterday"');
    expect(problem).toContain("linkedin-craft §12a");
    // A redraft told only "fix the date" picks a different wrong date.
    expect(problem).toContain("name the date instead");
  });

  it("reports ONE entry per phrase, so a partial fix counts as progress", () => {
    // `runCheckWithRepair` keeps a repair only when strictly fewer problems
    // remain. Lumped into one string, losing "tonight" but keeping
    // "yesterday" would look like no fix at all and be discarded.
    expect(relativeDayProblems("It closed yesterday. We announce tonight.", "x-craft §12b")).toHaveLength(2);
  });

  it("is empty for a clean draft", () => {
    expect(relativeDayProblems("It closed on September 15.", "x-craft §12b")).toEqual([]);
  });
});

describe("stripRelativeDays", () => {
  /**
   * The floor is deletion, never substitution: nothing here knows what date
   * was meant, and inventing one is the failure the rule exists to prevent.
   */
  it("leaves a sentence that is still true, just less specific", () => {
    expect(stripRelativeDays("Profound closed its Series D yesterday.")).toBe("Profound closed its Series D.");
  });

  it("closes the seam it leaves — no double space, no space before punctuation", () => {
    expect(stripRelativeDays("It broke last night, and again after.")).toBe("It broke, and again after.");
    expect(stripRelativeDays("Announced this morning and shipped.")).toBe("Announced and shipped.");
  });

  it("clears every phrase in one call, including across thread parts", () => {
    const out = stripRelativeDays("It closed yesterday.\n\nWe announce tonight.");
    expect(relativeDayIssues(out)).toEqual([]);
  });

  it("returns the text unchanged when there is nothing to strip", () => {
    const clean = "Founders today ask an AI first.";
    expect(stripRelativeDays(clean)).toBe(clean);
  });

  it("converges: what it returns never trips the detector again", () => {
    for (const draft of [
      "Signed the day before yesterday.",
      "Earlier today, and again later today.",
      "Tonight we ship; tomorrow we measure.",
    ]) {
      expect(relativeDayIssues(stripRelativeDays(draft))).toEqual([]);
    }
  });
});

describe("Hebrew relative-day phrases", () => {
  /**
   * A post written for an Israeli client decays at exactly the same rate as an
   * English one, and this list only knew English — so "אתמול" read as clean
   * while "yesterday" was caught. Clients writing natively in Hebrew are a
   * third of the roster.
   */
  it("catches the Hebrew word for yesterday", () => {
    expect(relativeDayIssues("החברה גייסה סבב חדש אתמול.")).toEqual(["אתמול"]);
  });

  it("catches tomorrow, last night, this morning, this evening and the day before yesterday", () => {
    for (const [text, word] of [
      ["ההשקה מחר בבוקר.", "מחר"],
      ["ההודעה פורסמה אמש.", "אמש"],
      ["הבוקר יצאה הגרסה החדשה.", "הבוקר"],
      ["נדבר על זה הערב.", "הערב"],
      ["זה קרה שלשום.", "שלשום"],
    ] as const) {
      expect(relativeDayIssues(text), text).toEqual([word]);
    }
  });

  it("matches a stem carrying a Hebrew prefix, reporting the whole word", () => {
    // "מאתמול" is "since yesterday" and "ומחר" is "and tomorrow" — the same
    // decay. Hebrew has no ASCII word boundary, so the guard is that no Hebrew
    // letter sits on either side of the match, plus the closed set of
    // single-letter prefixes on the front.
    expect(relativeDayIssues("מאתמול אנחנו רואים עלייה.")).toEqual(["מאתמול"]);
    expect(relativeDayIssues("היום ומחר יש לנו אירועים.")).toEqual(["ומחר"]);
  });

  it("does not fire inside a longer Hebrew word that merely contains a stem", () => {
    // "מחריף" contains "מחר". The lookahead is what stops it, and a rule that
    // fires on good drafts is a rule somebody turns off.
    expect(relativeDayIssues("הדוח מחריף את המגמה.")).toEqual([]);
  });

  it("leaves bare 'today' alone, exactly as the English list does", () => {
    // "היום" is overwhelmingly "the day" in ordinary prose, and bare "today"
    // is deliberately not on the English list either. A floor that deleted it
    // would edit sentences that never carried a date.
    expect(relativeDayIssues("היום שבו השקנו את המוצר היה ארוך.")).toEqual([]);
  });

  it("strips a Hebrew phrase and tidies the spacing it leaves behind", () => {
    const stripped = stripRelativeDays("החברה גייסה סבב חדש אתמול.");
    expect(stripped).not.toContain("אתמול");
    // The sentence is still true, just less specific — which is the whole
    // argument for a mechanical floor here.
    expect(stripped).toContain("החברה גייסה סבב חדש");
  });

  it("does not disturb a Hebrew post that carries no relative day", () => {
    const clean = "השקנו מוצר חדש והקהילה הגיבה יפה.";
    expect(relativeDayIssues(clean)).toEqual([]);
    expect(stripRelativeDays(clean)).toBe(clean);
  });
});
