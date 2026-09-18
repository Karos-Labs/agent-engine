import { describe, expect, it } from "vitest";
import {
  DEFAULT_TARGET_LANGUAGE,
  MIN_PROSE_LETTERS,
  checkDraftLanguage,
  isJudgeableLanguage,
  languageFromClientProse,
  languageRedraftDirective,
  resolveTargetLanguage,
} from "../src/workflow/target-language.js";

/**
 * The language layer, as a unit.
 *
 * The workflow-level behaviour it drives — a wrong-script draft going back to
 * the writer once and then shipping flagged — is pinned in
 * `original-short.test.ts`. What is pinned HERE is the two decisions that
 * layer makes on its own: where the language comes from, and what the check
 * can and cannot prove.
 */

const HEBREW = "אף אחד לא מספר לך שהעובד הראשון הוא זה שתפטר. אתה מגייס לחברה שיש לך היום.";
const ENGLISH = "Nobody tells you the first hire is the one you fire. You hire for the company you have today.";

describe("resolveTargetLanguage", () => {
  it("takes the client's configured voiceLanguage over everything else", () => {
    const resolved = resolveTargetLanguage({ configuredLanguage: "he-IL", brandLanguage: "en-US", clientProse: ENGLISH });
    expect(resolved).toMatchObject({ tag: "he-IL", source: "client-config", assumed: false });
  });

  it("falls back to the brand kit's language when the product is not configured", () => {
    const resolved = resolveTargetLanguage({ brandLanguage: "he", clientProse: ENGLISH });
    expect(resolved).toMatchObject({ tag: "he", source: "brand-kit", assumed: false });
  });

  it("reads the client's OWN prose when nothing is configured — the Hebrew client nobody filled in", () => {
    // The case this exists for. Before 2026-09-18 this client's short was
    // written in whatever language the model felt like, and nothing checked.
    const resolved = resolveTargetLanguage({ clientProse: HEBREW });
    expect(resolved).toMatchObject({ tag: "he", source: "client-prose", assumed: false });
    expect(resolved.reason).toContain("Hebrew");
  });

  it("defaults, and says it is an assumption, when nothing settles it", () => {
    const resolved = resolveTargetLanguage({ clientProse: ENGLISH });
    expect(resolved).toMatchObject({ tag: DEFAULT_TARGET_LANGUAGE, source: "default", assumed: true });
  });

  it("treats a blank or whitespace configuration as absent, not as a language", () => {
    expect(resolveTargetLanguage({ configuredLanguage: "   ", brandLanguage: "he" }).source).toBe("brand-kit");
    expect(resolveTargetLanguage({ configuredLanguage: "", brandLanguage: "" }).source).toBe("default");
  });
});

describe("languageFromClientProse", () => {
  it("names Hebrew from Hebrew prose", () => {
    expect(languageFromClientProse(HEBREW)).toMatchObject({ tag: "he", script: "Hebrew" });
  });

  it("has no opinion on Latin prose, rather than answering English", () => {
    // "No opinion" and "English" are different answers, and conflating them is
    // how a French client gets an English short with nothing recorded.
    expect(languageFromClientProse(ENGLISH)).toBeUndefined();
  });

  it("has no opinion on an ambiguous script, however much of it there is", () => {
    // Cyrillic is Russian, Ukrainian, Bulgarian, Serbian, Belarusian or
    // Macedonian. Reading the letters and answering "Russian" is a coin toss
    // with a Ukrainian client's name on it.
    const russian = "Никто не говорит вам, что первый сотрудник это тот, кого вы уволите первым.";
    expect(russian.match(/\p{L}/gu)!.length).toBeGreaterThanOrEqual(MIN_PROSE_LETTERS);
    expect(languageFromClientProse(russian)).toBeUndefined();
  });

  it("has no opinion on too little prose to judge", () => {
    expect(languageFromClientProse("שלום")).toBeUndefined();
  });

  it("survives a Hebrew client whose copy is full of Latin product names", () => {
    const loanworded = `${HEBREW} HubSpot, Salesforce, Google Analytics, Notion, Figma.`;
    expect(languageFromClientProse(loanworded)).toMatchObject({ tag: "he" });
  });
});

describe("checkDraftLanguage", () => {
  const hebrewTarget = resolveTargetLanguage({ configuredLanguage: "he-IL" });

  it("catches the failure it exists for: an entirely English short for a Hebrew client", () => {
    const verdict = checkDraftLanguage(ENGLISH, hebrewTarget);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toContain("Hebrew");
    expect(verdict.reason).toContain("0%");
  });

  it("passes a Hebrew draft, including one carrying Latin product names", () => {
    expect(checkDraftLanguage(HEBREW, hebrewTarget).ok).toBe(true);
    expect(checkDraftLanguage(`${HEBREW} HubSpot ו-Salesforce.`, hebrewTarget).ok).toBe(true);
  });

  it("cannot tell one Latin language from another, and says so by passing", () => {
    // The stated limit, pinned as a test so nobody later reads a passing
    // English-target run as evidence the draft was in English. A writing
    // system is all this proves; anything finer needs a model that reads.
    const englishTarget = resolveTargetLanguage({ configuredLanguage: "en-US" });
    const french = "Personne ne vous dit que la première embauche est celle que vous licencierez en premier.";
    expect(checkDraftLanguage(french, englishTarget).ok).toBe(true);
  });

  it("has no opinion on a language the shared table has never heard of", () => {
    const unknown = resolveTargetLanguage({ configuredLanguage: "xx-YY" });
    expect(isJudgeableLanguage(unknown.tag)).toBe(false);
    expect(checkDraftLanguage(ENGLISH, unknown).ok).toBe(true);
  });
});

describe("languageRedraftDirective", () => {
  it("names the language, the evidence and every field the viewer meets", () => {
    // A model that has just produced 300 English words has demonstrably not
    // understood the instruction it already had, so the note carries what went
    // wrong rather than repeating that instruction verbatim.
    const target = resolveTargetLanguage({ configuredLanguage: "he-IL" });
    const verdict = checkDraftLanguage(ENGLISH, target);
    if (verdict.ok) throw new Error("expected a failure to describe");
    const directive = languageRedraftDirective(target, verdict.reason);
    expect(directive).toContain("he-IL");
    expect(directive).toContain("on-screen text");
    expect(directive).toContain("Hebrew");
    // …and it protects the one thing that legitimately stays put.
    expect(directive).toContain("Product names");
  });
});
