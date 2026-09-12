import { describe, expect, it } from "vitest";
import type { AgentContext } from "@agent-engine/core";
import { createKarosGatesTools } from "../src/index.js";
import { inspectNativeLanguage, type NativeLanguageFindingKind } from "../src/native-language.js";

/**
 * RFC-15 §5 — `gate.nativeLanguage`, the deterministic half.
 *
 * Every hard fail below is exercised in ISOLATION: one field, enough Hebrew
 * around the defect that the per-field coverage rule passes, so deleting the
 * rule under test is the only way to make that case go green. Several cases
 * also assert the OTHER side of the threshold (one nikud mark passes, four
 * fail; a 10-letter English field is not judged, a 12-letter one is), because
 * a test that only ever sees the failing side is asserting a constant.
 */

const ctx: AgentContext = {
  runId: "run_1",
  clientSlug: "geektime",
  productId: "instagram",
  runKind: "recurring",
  metadata: {},
};

const gates = createKarosGatesTools();

const HEBREW = { language: "Hebrew", scriptName: "Hebrew", scriptPattern: "\\p{Script=Hebrew}" } as const;

/**
 * 74 Hebrew letters, no Latin, no defect of any kind. Every single-rule
 * fixture is this sentence plus the one thing under test, so the field always
 * clears the 0.6 per-field coverage floor and the ONLY finding is the one the
 * case is named after.
 */
const CLEAN_HEBREW = "החברה הודיעה השבוע על שינוי גדול במוצר שלה, והמשתמשים כבר מרגישים את ההבדל בעבודה היומית.";

async function outcomeOf(args: unknown) {
  const tool = gates["gate.nativeLanguage"];
  if (!tool) throw new Error("gate.nativeLanguage is not registered");
  return tool.execute(args, { ctx });
}

async function verdictOf(args: unknown) {
  const outcome = await outcomeOf(args);
  if (outcome.status !== "success") throw new Error(`gate call itself failed: ${JSON.stringify(outcome)}`);
  return outcome.result as { verdict: string; evidence: string[]; reason?: string; toolVersion: string };
}

/** The structured report for one Hebrew field — what the workflow step and the native editor actually read. */
function kindsForOneField(text: string, extra: Record<string, unknown> = {}): NativeLanguageFindingKind[] {
  const report = inspectNativeLanguage({ ...HEBREW, fields: [{ id: "slide-3.body", text }], ...extra });
  return report.findings.map((f) => f.kind);
}

describe("gate.nativeLanguage — registration", () => {
  it("is registered in createKarosGatesTools", () => {
    expect(Object.keys(gates)).toContain("gate.nativeLanguage");
  });

  /**
   * `gates.test.ts`'s registry-wide "every gate reports the version it
   * declares" test calls every registered gate through its own
   * `defaultArgsFor(name)` switch, which throws for a name it has never heard
   * of. These are the arguments that switch needs; they are pinned here so the
   * one-case addition to a file this package's owner does not own is already
   * verified when it is applied.
   */
  it("answers the registry-wide version check with minimal arguments", async () => {
    const verdict = await verdictOf({
      language: "Hebrew",
      scriptName: "Hebrew",
      scriptPattern: "\\p{Script=Hebrew}",
      fields: [{ id: "caption", text: "בדיקה" }],
    });
    expect(verdict.verdict).toBe("pass");
    expect(verdict.toolVersion).toBe(gates["gate.nativeLanguage"]!.version);
  });

  it("passes a clean Hebrew post", async () => {
    const verdict = await verdictOf({
      ...HEBREW,
      fields: [
        { id: "caption", text: CLEAN_HEBREW },
        { id: "slide-1.headline", text: "מה השתנה השבוע במוצר" },
        { id: "slide-1.device.label", text: "לוח בקרה" },
      ],
    });
    expect(verdict.verdict).toBe("pass");
    expect(verdict.evidence[0]).toContain("3 field(s) checked");
    expect(verdict.toolVersion).toBe("1.0.0");
  });
});

describe("hard fail 1 — per-field script coverage (the live defect)", () => {
  /**
   * The proof that this rule is NEW. Six Hebrew fields (223 letters) and two
   * English slide bodies (105 letters) measure 0.68 aggregate, comfortably
   * over `language-gate.ts`'s 0.3 blob floor — which is exactly why
   * `checkExpectedScript` passes this carousel today. Per field, the two
   * English bodies score 0.00.
   */
  const twoEnglishSlides = {
    ...HEBREW,
    fields: [
      { id: "caption", text: CLEAN_HEBREW },
      { id: "slide-1.headline", text: "מה השתנה השבוע במוצר" },
      { id: "slide-2.body", text: "המשתמשים מדווחים על שיפור ניכר בזמני התגובה" },
      { id: "slide-3.body", text: "הצוות פרסם נתונים חדשים על השימוש היומי" },
      { id: "slide-4.body", text: "The team shipped a new dashboard for every customer this week" },
      { id: "slide-5.body", text: "הכלי החדש מקצר את זמן העבודה בחצי" },
      { id: "slide-6.body", text: "הלקוחות הראשונים כבר מקבלים גישה מלאה" },
      { id: "slide-7.body", text: "Nobody expected the rollout to land before the end of the quarter" },
    ],
  };

  it("fails a carousel with two English slides out of eight, naming exactly those two fields", async () => {
    const report = inspectNativeLanguage(twoEnglishSlides);
    expect(report.findings.map((f) => f.field)).toEqual(["slide-4.body", "slide-7.body"]);
    expect(report.findings.every((f) => f.kind === "script-coverage")).toBe(true);

    const verdict = await verdictOf(twoEnglishSlides);
    expect(verdict.verdict).toBe("content_fail");
    expect(verdict.evidence.some((e) => e.startsWith("slide-4.body ["))).toBe(true);
    expect(verdict.evidence.some((e) => e.startsWith("slide-7.body ["))).toBe(true);
    // Nothing else in the carousel is named.
    expect(verdict.evidence.filter((e) => e.includes("[script-coverage]"))).toHaveLength(2);
  });

  it("the SAME carousel clears the aggregate floor — which is why it passes today", () => {
    const report = inspectNativeLanguage(twoEnglishSlides);
    expect(report.findings.some((f) => f.kind === "script-coverage-aggregate")).toBe(false);
  });

  it("each finding hands the writer an actionable steer, not a complaint", () => {
    const report = inspectNativeLanguage(twoEnglishSlides);
    for (const finding of report.findings) {
      expect(finding.steer).toContain("Rewrite this field in Hebrew");
      expect(finding.sentence.length).toBeGreaterThan(0);
    }
  });

  it("does not judge a field too short to carry signal (11 letters), and does judge a 12-letter one", () => {
    expect(kindsForOneField("Ten letter")).toEqual([]); // 9 letters
    expect(kindsForOneField("Exactly twelv")).toEqual(["script-coverage"]); // 12 letters
  });
});

describe("hard fail 2 — the catastrophic aggregate floor, kept verbatim", () => {
  it("fails a post whose fields are each too short to judge but which is wholly out of script", async () => {
    const args = {
      ...HEBREW,
      fields: [
        { id: "slide-1.kicker", text: "Hello there" },
        { id: "slide-2.kicker", text: "Hello there" },
        { id: "slide-3.kicker", text: "Hello there" },
        { id: "slide-4.kicker", text: "Hello there" },
      ],
    };
    const report = inspectNativeLanguage(args);
    // Per-field never fires: 10 letters each, under the 12-letter bar.
    expect(report.findings.map((f) => f.kind)).toEqual(["script-coverage-aggregate"]);
    expect(report.findings[0]!.field).toBe("post");
    expect((await verdictOf(args)).verdict).toBe("content_fail");
  });
});

describe("hard fails 3-11, each in isolation", () => {
  it("3. an unexplained Latin run longer than 24 characters inside Hebrew copy", () => {
    expect(kindsForOneField(`${CLEAN_HEBREW} הצוות כתב the new model is now available for everyone בעדכון.`)).toEqual([
      "unexplained-latin-run",
    ]);
  });

  it("3. a short Latin run (a product name) is not a finding", () => {
    expect(kindsForOneField(`${CLEAN_HEBREW} הכלי נקרא Gemini 3 Pro בלבד.`)).toEqual([]);
  });

  it("4. a forbidden transliteration present as a substring", () => {
    expect(
      kindsForOneField(`${CLEAN_HEBREW} הצוות מעדיף סופטוור פתוח.`, { forbiddenTransliterations: ["סופטוור"] }),
    ).toEqual(["forbidden-transliteration"]);
  });

  /**
   * THE STEER NAMES THE REPLACEMENT the pack already holds.
   *
   * `RegisterTermPair` has carried `{ wrong, right }` since it was written,
   * and the boundary used to flatten it to `wrong` alone — so the pack knew
   * `יישומון` → `אפליקציה` and the writer was told only "use the word this
   * niche actually says". That breaks this phase's own "every finding carries
   * a correction" contract on exactly the findings that cost nothing to
   * produce. The judge rubric holds ITSELF to the opposite standard
   * (`1.md`: "A finding without a replacement is not a finding here").
   *
   * Break it by mapping the input back to `wrong` and the first case fails.
   */
  it("4. names the replacement when the pack has one, and falls back to the generic steer when it does not", () => {
    const withRight = inspectNativeLanguage({
      ...HEBREW,
      fields: [{ id: "slide-3.body", text: `${CLEAN_HEBREW} הצוות בנה יישומון חדש.` }],
      forbiddenTransliterations: [{ wrong: "יישומון", right: "אפליקציה" }],
    });
    expect(withRight.findings.map((f) => f.kind)).toEqual(["forbidden-transliteration"]);
    expect(withRight.findings[0]!.steer).toContain('Replace "יישומון" with "אפליקציה"');

    // A pair with no `right`, and the legacy bare-string form, both still
    // work and both get the generic sentence.
    for (const forbidden of [[{ wrong: "יישומון" }], ["יישומון"]]) {
      const generic = inspectNativeLanguage({
        ...HEBREW,
        fields: [{ id: "slide-3.body", text: `${CLEAN_HEBREW} הצוות בנה יישומון חדש.` }],
        forbiddenTransliterations: forbidden as never,
      });
      expect(generic.findings.map((f) => f.kind), JSON.stringify(forbidden)).toEqual(["forbidden-transliteration"]);
      expect(generic.findings[0]!.steer, JSON.stringify(forbidden)).toContain("with the word this niche actually says");
      expect(generic.findings[0]!.steer, JSON.stringify(forbidden)).not.toContain('with "');
    }
  });

  it("5. curly quotation marks in Hebrew body copy", () => {
    expect(kindsForOneField(`${CLEAN_HEBREW} המנכ״ל אמר “זה רק ההתחלה”.`)).toEqual(["curly-quotes"]);
  });

  it("5. straight quotes are fine", () => {
    expect(kindsForOneField(`${CLEAN_HEBREW} המנכ״ל אמר "זה רק ההתחלה".`)).toEqual([]);
  });

  it("6. the hypercorrect copula הינו as a standalone token", () => {
    expect(kindsForOneField(`${CLEAN_HEBREW} המוצר הינו הכלי המרכזי.`)).toEqual(["hypercorrection"]);
  });

  it("6. the same letters inside a longer word are not the copula", () => {
    // הינוקא is a word that merely starts with the same letters; a `\b` check
    // cannot see a Hebrew word boundary, which is why the rule uses letter
    // lookarounds.
    expect(kindsForOneField(`${CLEAN_HEBREW} הכינוי הינוקא נשאר בשימוש.`)).toEqual([]);
  });

  it("7. nikud over 2% of the Hebrew letters", () => {
    // Two vowelised words: 4 combining marks over 82 Hebrew letters (4.9%).
    const vowelised = "שָלוֹם";
    expect(kindsForOneField(`${CLEAN_HEBREW} ${vowelised} ${vowelised}.`)).toEqual(["nikud"]);
  });

  it("7. a single stray mark is under the ceiling and is not a finding", () => {
    expect(kindsForOneField(`${CLEAN_HEBREW} שָלום.`)).toEqual([]);
  });

  it("8. Eastern-Arabic digits", () => {
    expect(kindsForOneField(`${CLEAN_HEBREW} מספר ٣٤ מהמשתמשים.`)).toEqual(["foreign-digits"]);
  });

  it("8. Western digits are what the register asks for", () => {
    expect(kindsForOneField(`${CLEAN_HEBREW} מספר 34 מהמשתמשים.`)).toEqual([]);
  });

  it("9. a Latin month name inside Hebrew copy", () => {
    expect(kindsForOneField(`${CLEAN_HEBREW} הדוח פורסם ב January 2026.`)).toEqual(["latin-month-name"]);
  });

  it("10. an impossible date order", () => {
    expect(kindsForOneField(`${CLEAN_HEBREW} הכנס ייערך ב 25.13.2026.`)).toEqual(["impossible-date-order"]);
  });

  it("10. an AMBIGUOUS date is deliberately not flagged", () => {
    expect(kindsForOneField(`${CLEAN_HEBREW} הכנס ייערך ב 03.04.2026.`)).toEqual([]);
  });

  it("11. a bidi embedding/override control anywhere in the copy", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE, written as an escape: a literal control
    // character in a source file reverses everything after it in an editor.
    expect(kindsForOneField(`${CLEAN_HEBREW} \u202Eהפוך.`)).toEqual(["bidi-control"]);
  });

  it("11. the U+2068/U+2069 isolates the renderer inserts LATER are never flagged", () => {
    // `isolateForeignRuns` runs after this gate (RFC-15 §7.3). Flagging its
    // output would fail the fix.
    expect(kindsForOneField(`${CLEAN_HEBREW} המודל \u2068GPT-4\u2069 שוחרר.`)).toEqual([]);
  });

  it("11. a bidi control is caught even in a field that is not in the target script", () => {
    const report = inspectNativeLanguage({
      ...HEBREW,
      fields: [{ id: "slide-2.device.label", text: "Dashboard\u202A" }],
    });
    expect(report.findings.map((f) => f.kind)).toContain("bidi-control");
  });
});

describe("allowedLatinTerms", () => {
  it("exempts a long Latin term the client's own posts leave in Latin (rule 3)", () => {
    const text = `${CLEAN_HEBREW} הצוות בנה Retrieval Augmented Generation למערכת.`;
    // 30 characters of Latin: a finding on its own...
    expect(kindsForOneField(text)).toEqual(["unexplained-latin-run"]);
    // ...and nothing at all once the client is known to write it that way.
    expect(kindsForOneField(text, { allowedLatinTerms: ["Retrieval Augmented Generation"] })).toEqual([]);
  });

  it("exempts a term that is on both lists (rule 4)", () => {
    const text = `${CLEAN_HEBREW} הצוות משתמש ב Copilot יומיום.`;
    expect(kindsForOneField(text, { forbiddenTransliterations: ["Copilot"] })).toEqual(["forbidden-transliteration"]);
    expect(kindsForOneField(text, { forbiddenTransliterations: ["Copilot"], allowedLatinTerms: ["Copilot"] })).toEqual([]);
  });

  it("does not let an allowlisted term smuggle a whole English clause through", () => {
    // The allowed term is removed and the REST of the run is still measured.
    const text = `${CLEAN_HEBREW} הצוות כתב Copilot now writes most of the boilerplate for us בעדכון.`;
    expect(kindsForOneField(text, { allowedLatinTerms: ["Copilot"] })).toEqual(["unexplained-latin-run"]);
  });
});

describe("soft tells — evidence on a PASS, never a failure", () => {
  const calqued =
    "בסוף היום, המוצר אשר פותח כאן אשר נבדק אשר שוחרר, נועד על מנת לעזור לצוותים קטנים לעבוד מהר יותר בלי להוסיף עוד כלי לניהול.";

  it("returns calque, connective-density and literary-phrase tells without failing", async () => {
    const args = { ...HEBREW, fields: [{ id: "caption", text: calqued }] };
    const report = inspectNativeLanguage(args);
    expect(report.findings).toEqual([]);
    expect(report.softTells.map((t) => t.kind).sort()).toEqual(["calque", "connective-density", "literary-phrase"]);

    const verdict = await verdictOf(args);
    expect(verdict.verdict).toBe("pass");
    expect(verdict.evidence.filter((e) => e.startsWith("soft tell |")).length).toBeGreaterThan(0);
  });

  it("flags sentences far longer than the client's own measured mean, and says nothing without one", () => {
    const longSentences = {
      ...HEBREW,
      fields: [
        {
          id: "caption",
          text: "החברה הודיעה השבוע על שינוי גדול במוצר שלה והמשתמשים כבר מרגישים את ההבדל בעבודה היומית שלהם בכל צוות. הצוות פרסם נתונים חדשים על השימוש היומי במערכת ועל הדרך שבה הלקוחות הראשונים בנו את התהליך שלהם. הכלי החדש מקצר את זמן העבודה בחצי ומאפשר לצוותים קטנים להגיע לאותה תפוקה בלי להוסיף אנשים.",
        },
      ],
    };
    expect(inspectNativeLanguage(longSentences).softTells.map((t) => t.kind)).toEqual([]);
    expect(inspectNativeLanguage({ ...longSentences, clientMeanSentenceWords: 8 }).softTells.map((t) => t.kind)).toEqual([
      "long-sentences",
    ]);
  });

  it("flags a post that mixes the maqaf with the ASCII hyphen", () => {
    const mixed = {
      ...HEBREW,
      fields: [
        { id: "caption", text: `${CLEAN_HEBREW} הכלי הוא כלי בית־ספר.` },
        { id: "slide-2.body", text: "המערכת היא רב-לשונית ומשרתת צוותים בכל העולם ובכל שעה." },
      ],
    };
    expect(inspectNativeLanguage(mixed).softTells.map((t) => t.kind)).toEqual(["mixed-hyphen"]);
    expect(inspectNativeLanguage(mixed).findings).toEqual([]);
  });
});

describe("the unknown-language rule", () => {
  it("passes with an explicit no-opinion evidence line when no convention pack exists", async () => {
    const verdict = await verdictOf({
      language: "Klingon",
      scriptName: "Klingon",
      scriptPattern: "\\p{Script=Latin}",
      fields: [{ id: "caption", text: "Qapla' batlh je. nuqneH, wo' vIneH jIH." }],
    });
    expect(verdict.verdict).toBe("pass");
    expect(verdict.evidence).toEqual(["no convention pack for Klingon"]);
  });

  it("a Latin-script language gets no opinion rather than a gate that fails correct drafts", async () => {
    // Curly quotes and "may" are perfectly native in Spanish; there is
    // deliberately no Latin pack.
    const verdict = await verdictOf({
      language: "Spanish",
      scriptName: "Latin",
      scriptPattern: "\\p{Script=Latin}",
      fields: [{ id: "caption", text: "El equipo dijo “esto es solo el principio” y nadie lo discutió." }],
    });
    expect(verdict.verdict).toBe("pass");
  });

  it("Arabic keeps its own digits — rule 8 is a property of the writing system, not a universal", () => {
    const arabic = {
      language: "Arabic",
      scriptName: "Arabic",
      scriptPattern: "\\p{Script=Arabic}",
      fields: [{ id: "caption", text: "أعلنت الشركة هذا الأسبوع عن تغيير كبير في منتجها ويشعر ٣٤ من المستخدمين بالفرق." }],
    };
    expect(inspectNativeLanguage(arabic).findings.map((f) => f.kind)).toEqual([]);
  });
});

describe("scriptPattern cannot be weakened", () => {
  const weakened = {
    language: "Hebrew",
    scriptName: "Hebrew",
    scriptPattern: ".",
    fields: [{ id: "caption", text: "The team shipped a new dashboard for every customer this week" }],
  };

  it("the tool REFUSES rather than running a check that passes everything", async () => {
    // With "." every character counts as in-script, so a weakened gate would
    // return `pass` on wholly English copy. It must not return a verdict at
    // all.
    const outcome = await outcomeOf(weakened);
    expect(outcome.status).toBe("tooling_error");
    if (outcome.status === "tooling_error") expect(outcome.reason).toContain("Script=");
  });

  it("the pure function throws too, so a direct caller cannot bypass the schema", () => {
    expect(() => inspectNativeLanguage(weakened)).toThrow(/refusing to run a weakened script check/);
  });

  it("an unconstructable script name is a tooling error, never a pass", async () => {
    const outcome = await outcomeOf({
      language: "Klingon",
      scriptName: "Klingon",
      scriptPattern: "\\p{Script=Klingon}",
      fields: [{ id: "caption", text: "Qapla' batlh je." }],
    });
    expect(outcome.status).toBe("tooling_error");
  });
});
