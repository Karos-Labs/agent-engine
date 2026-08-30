import { z } from "zod";

/**
 * The languages the eval ladder can grade in (SCRUM-308 / AU25, rung 4).
 *
 * English and Hebrew are the floor the ticket names, and the pair exists for
 * one specific reason: the AU32 class of failure. A Hebrew-only client
 * (geektime — prep jobs `hcf9ymPGJC7mDS5pcEQ4` and `9qkTWlg7e9ZLiVIZUok4`)
 * received an entirely English carousel, and it passed every check that
 * existed, because NO CHECK ANYWHERE HAD A LANGUAGE DIMENSION. SCRUM-309
 * (AU31) gave the brand kit a structured `language` field and threaded it
 * into every copy prompt, which is the *input* half of the fix; this is the
 * *measurement* half. Without it "the Hebrew client got English" stays an
 * anecdote somebody has to notice by eye.
 *
 * Deliberately a small closed enum, not free text. `ClientBrand.language`
 * (`@agent-engine/tool-karos-client`) is free text on purpose — its job is to
 * stop being free text elsewhere — and *here* is the elsewhere: a golden run
 * declares which of these it is graded as, and an unrecognized value fails at
 * fixture-load time rather than silently grading nothing.
 */
export const EvalLanguageSchema = z.enum(["en", "he"]);
export type EvalLanguage = z.infer<typeof EvalLanguageSchema>;

/** The Unicode scripts this module can tell apart. `other` is everything the two below do not claim. */
export type TextScript = "latin" | "hebrew" | "other";

export interface EvalLanguageProfile {
  readonly code: EvalLanguage;
  /** How the language is named to a judge model, in English. */
  readonly englishName: string;
  /** How the language names itself — carried into the judge prompt so the rubric is legible to a native reader. */
  readonly endonym: string;
  /** The script fluent copy in this language is written in. */
  readonly script: Exclude<TextScript, "other">;
  readonly direction: "ltr" | "rtl";
  /**
   * The minimum share of script-bearing characters that must belong to
   * `script` for the text to count as written in this language.
   *
   * Not 1.0, and not the same number for both: real copy in either language
   * carries some of the other script. A Hebrew post legitimately contains
   * Latin product names, URLs and English hashtags, so the Hebrew floor is
   * the looser one; an English post has no comparable reason to carry Hebrew,
   * so its floor is tighter. Both are far above the value an entirely
   * wrong-language draft can reach, which is what the check has to separate.
   */
  readonly minScriptShare: number;
}

export const EVAL_LANGUAGES: Readonly<Record<EvalLanguage, EvalLanguageProfile>> = {
  en: { code: "en", englishName: "English", endonym: "English", script: "latin", direction: "ltr", minScriptShare: 0.9 },
  he: { code: "he", englishName: "Hebrew", endonym: "עברית", script: "hebrew", direction: "rtl", minScriptShare: 0.6 },
};

export function evalLanguageProfile(language: EvalLanguage): EvalLanguageProfile {
  return EVAL_LANGUAGES[language];
}

/**
 * Hebrew letters, including the presentation-form and extended blocks.
 *
 * `\p{Script=Hebrew}` rather than a hardcoded codepoint range, for the same
 * reason `agents/instagram-agent/src/workflow/slides-data.ts` uses it for RTL
 * detection: a range misses the extended blocks, and a Hebrew draft that
 * happens to use one would be read as containing no Hebrew at all.
 */
const HEBREW_LETTER = /\p{Script=Hebrew}/gu;
const LATIN_LETTER = /\p{Script=Latin}/gu;

export interface ScriptProfile {
  hebrew: number;
  latin: number;
  /** hebrew + latin. Digits, punctuation, emoji and whitespace are counted by neither and belong to no language. */
  scripted: number;
}

/** Counts the script-bearing characters in `text`. Digits and punctuation are excluded: "68%" is not evidence of any language. */
export function scriptProfile(text: string): ScriptProfile {
  const hebrew = (text.match(HEBREW_LETTER) ?? []).length;
  const latin = (text.match(LATIN_LETTER) ?? []).length;
  return { hebrew, latin, scripted: hebrew + latin };
}

/** The script the majority of `text`'s script-bearing characters belong to. `other` when there are none at all. */
export function dominantScript(text: string): TextScript {
  const { hebrew, latin, scripted } = scriptProfile(text);
  if (scripted === 0) return "other";
  return hebrew > latin ? "hebrew" : "latin";
}

export interface LanguageFidelityResult {
  /** Same three-value vocabulary every `karos-gates` verdict uses, so this composes with `DeterministicAssertionResult`. */
  verdict: "pass" | "content_fail";
  expected: EvalLanguage;
  expectedScript: Exclude<TextScript, "other">;
  observedScript: TextScript;
  /** Share of script-bearing characters that belong to `expectedScript`, 0–1, rounded to 4dp. */
  scriptShare: number;
  requiredScriptShare: number;
  reason?: string;
}

/**
 * The deterministic half of language grading (SCRUM-308 rung 4): is this text
 * even written in the script the client's language uses?
 *
 * Zero model cost, zero judgement, and it is the check that would have caught
 * the geektime carousel outright — an English draft for a Hebrew client scores
 * a Hebrew share of ~0. It answers "is this the right language", NOT "is this
 * fluent, idiomatic copy a native speaker would accept": a machine-translated
 * Hebrew post is in the right script and passes here. Fluency is the rubric
 * judge's `languageFidelity` dimension, which is why the two run together and
 * neither is presented as sufficient alone.
 */
export function checkLanguageFidelity(text: string, expected: EvalLanguage): LanguageFidelityResult {
  const profile = evalLanguageProfile(expected);
  const counts = scriptProfile(text);
  const share = counts.scripted === 0 ? 0 : (profile.script === "hebrew" ? counts.hebrew : counts.latin) / counts.scripted;
  const scriptShare = Math.round(share * 10_000) / 10_000;
  const observedScript = dominantScript(text);

  const base = {
    expected,
    expectedScript: profile.script,
    observedScript,
    scriptShare,
    requiredScriptShare: profile.minScriptShare,
  } as const;

  if (counts.scripted === 0) {
    return { verdict: "content_fail", ...base, reason: `text contains no ${profile.englishName} (or any other) script-bearing characters to grade` };
  }
  if (scriptShare < profile.minScriptShare) {
    return {
      verdict: "content_fail",
      ...base,
      reason:
        `client language is ${profile.englishName} (${profile.endonym}) but only ${(scriptShare * 100).toFixed(1)}% of the ` +
        `script-bearing characters are ${profile.script} — required at least ${(profile.minScriptShare * 100).toFixed(0)}%`,
    };
  }
  return { verdict: "pass", ...base };
}
