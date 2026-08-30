import { describe, expect, it } from "vitest";
import { checkLanguageFidelity, dominantScript, EVAL_LANGUAGES, scriptProfile } from "../src/language.js";

/**
 * The deterministic half of rung 4 (SCRUM-308 / AU25).
 *
 * The case this exists for is concrete: prep job `hcf9ymPGJC7mDS5pcEQ4`
 * (geektime, a Hebrew-only outlet) received an entirely English carousel and
 * it passed every check that existed, because no check anywhere had a
 * language dimension. Every assertion below is a shape of that failure.
 */
const ENGLISH_POST =
  "We looked at attendance data across our hybrid client base this quarter, and the pattern surprised us. " +
  "Teams with a fixed two-day in-office schedule reported meaningfully fewer scheduling conflicts.";

const HEBREW_POST =
  "בדקנו את נתוני הנוכחות אצל הלקוחות ההיברידיים שלנו ברבעון האחרון, והתבנית שהתגלתה הפתיעה אותנו. " +
  "צוותים עם שני ימי משרד קבועים בשבוע דיווחו על פחות התנגשויות ביומן.";

describe("scriptProfile / dominantScript", () => {
  it("counts letters by script and ignores digits and punctuation", () => {
    // "68%" is not evidence of any language, and a text made only of numbers
    // must not be read as belonging to whichever script the caller expected.
    expect(scriptProfile("68% — 12,000 (!!)")).toEqual({ hebrew: 0, latin: 0, scripted: 0 });
    expect(dominantScript("68% 12,000")).toBe("other");
  });

  it("sees Hebrew in Hebrew and Latin in English", () => {
    expect(dominantScript(HEBREW_POST)).toBe("hebrew");
    expect(dominantScript(ENGLISH_POST)).toBe("latin");
  });

  it("counts extended Hebrew blocks, not just the base range", () => {
    // Presentation-form Hebrew (U+FB2A). A hardcoded 0x05D0-0x05EA range
    // misses it, which is the mistake `\p{Script=Hebrew}` exists to avoid.
    expect(scriptProfile("שׁשׂ").hebrew).toBe(2);
  });
});

describe("checkLanguageFidelity", () => {
  it("passes a Hebrew post for a Hebrew client", () => {
    const result = checkLanguageFidelity(HEBREW_POST, "he");
    expect(result.verdict).toBe("pass");
    expect(result.scriptShare).toBe(1);
  });

  it("FAILS an English post for a Hebrew client — the AU32 incident, made mechanical", () => {
    const result = checkLanguageFidelity(ENGLISH_POST, "he");
    expect(result.verdict).toBe("content_fail");
    expect(result.observedScript).toBe("latin");
    expect(result.scriptShare).toBe(0);
    expect(result.reason).toMatch(/client language is Hebrew/);
  });

  it("fails a Hebrew post for an English client too — the check is symmetric, not a Hebrew special case", () => {
    const result = checkLanguageFidelity(HEBREW_POST, "en");
    expect(result.verdict).toBe("content_fail");
    expect(result.scriptShare).toBe(0);
  });

  it("tolerates the Latin a real Hebrew post carries: product names, URLs, English hashtags", () => {
    const mixed = `${HEBREW_POST}\n\nhttps://karoslabs.com #HybridWork`;
    const result = checkLanguageFidelity(mixed, "he");
    expect(result.verdict).toBe("pass");
    expect(result.scriptShare).toBeGreaterThan(EVAL_LANGUAGES.he.minScriptShare);
    expect(result.scriptShare).toBeLessThan(1);
  });

  it("fails a half-and-half draft rather than splitting the difference", () => {
    // The realistic partial failure: a model that answered the language
    // directive for the body and forgot it for everything else.
    const result = checkLanguageFidelity(`${HEBREW_POST}\n\n${ENGLISH_POST}`, "he");
    expect(result.verdict).toBe("content_fail");
    expect(result.scriptShare).toBeLessThan(EVAL_LANGUAGES.he.minScriptShare);
  });

  it("fails text with nothing gradeable in it rather than passing it vacuously", () => {
    const result = checkLanguageFidelity("68% 12,000 ###", "he");
    expect(result.verdict).toBe("content_fail");
    expect(result.reason).toMatch(/no Hebrew \(or any other\) script-bearing characters/);
  });

  it("reports the threshold it applied, so a verdict can be argued with rather than only believed", () => {
    expect(checkLanguageFidelity(ENGLISH_POST, "en").requiredScriptShare).toBe(EVAL_LANGUAGES.en.minScriptShare);
    expect(checkLanguageFidelity(HEBREW_POST, "he").requiredScriptShare).toBe(EVAL_LANGUAGES.he.minScriptShare);
  });
});
