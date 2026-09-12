import { z } from "zod";
import type { GateVerdict } from "@agent-engine/core";
import { defineTool, success, toolingError } from "@agent-engine/tool-common";

/**
 * RFC-15 §5 — the deterministic half of `gate.nativeLanguage`.
 *
 * The owner's plan names ONE component ("a judge with a rubric and examples
 * that returns to writing"). The `karos-gates` registry's own contract is
 * "deterministic validators, no model calls" — an invariant six other tools
 * rest on. So the plan's single named component is built as two, keeping both
 * contracts: this tool decides everything about nativeness that is
 * MECHANICALLY decidable, for $0.00, and `instagram-native-editor` (a Gemini
 * step, RFC-15 §6) judges idiom and register and writes the corrections.
 *
 * **No model call. No network. $0.00.** It is the gate that runs first
 * precisely because it is free: a free rejection before the $0.002 relevance
 * judge and the $0.014 native editor.
 *
 * ## This tool owns no script table
 *
 * `scriptName` and `scriptPattern` are passed IN by the caller, which resolves
 * them through `agents/instagram-agent/src/workflow/language-gate.ts`'s
 * `SCRIPT_TABLE` — the single source of truth for "which writing system is
 * this language written in", and deliberately agent-local (RFC-13). A second
 * copy of that table here is a copy that drifts, and a language the gate knows
 * but the inference does not (or vice versa) is a client whose gate silently
 * never runs.
 *
 * What this tool DOES own is the convention pack: the per-writing-system rows
 * that say which quotation marks, digits, diacritics and tokens are native.
 * Those are properties of the writing system, not of the language table.
 */

export const TOOL_VERSION = "1.0.0";

// ─────────────────────────────────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────────────────────────────────

/**
 * Hard fail 1. Below this many letters a single field carries no signal — a
 * three-word kicker of proper nouns is not evidence of anything. Lower than
 * `language-gate.ts`'s `MIN_LETTERS_TO_JUDGE` (24) on purpose: that constant
 * guards a judgment about a WHOLE POST, this one guards a judgment about one
 * headline, and a headline is short by design.
 */
export const MIN_FIELD_LETTERS_TO_JUDGE = 12;

/**
 * Hard fail 1. Per-FIELD floor, and the defect this tool exists to close
 * (RFC-15 finding 8). `checkExpectedScript` measures one concatenated blob
 * against 0.3, so a carousel with two English slides out of eight measures
 * ~0.75 aggregate and passes. Per field, those two slides score 0.00.
 *
 * Higher than the aggregate floor because the reason the aggregate floor is
 * low does not apply to a single field: a post as a whole can be 30% Latin
 * and correct (product names, model numbers, URLs spread across eight
 * slides), but one 40-letter body that is 50% Latin is not a Hebrew body.
 */
export const MIN_FIELD_SCRIPT_RATIO = 0.6;

/** Hard fail 2. Kept verbatim from `language-gate.ts` as the catastrophic floor, so nothing Phase 0 caught stops being caught. */
export const MIN_AGGREGATE_SCRIPT_RATIO = 0.3;

/** Hard fail 2. The same "not enough signal to judge" bar `language-gate.ts`'s `MIN_LETTERS_TO_JUDGE` sets, applied to the same concatenated text. */
export const MIN_AGGREGATE_LETTERS_TO_JUDGE = 24;

/**
 * Hard fail 3. A Latin run longer than this inside a field written in the
 * target script is an English sentence smuggled into a target-language slide.
 * 24 characters clears every real product name, model number and protocol
 * token ("Gemini 3 Pro", "claude-opus-4-8", "OpenTelemetry") and does not
 * clear a clause.
 */
export const MAX_UNEXPLAINED_LATIN_RUN = 24;

/** Hard fail 7. Nikud/harakat are never used in body copy; a stray mark or two is a typo, a sprinkling is a vowelised text. */
export const MAX_COMBINING_MARK_SHARE = 0.02;

/** Soft tell. Above this, a literary connective is doing work `ש־` should be doing. */
export const MAX_ASHER_PER_100_WORDS = 1.5;

/** Soft tell. A post whose sentences run this much longer than the client's own measured mean is not writing the way this client writes. */
export const MAX_SENTENCE_LENGTH_MULTIPLE = 1.6;

/** Evidence strings quote the offending sentence; a whole 2,000-character custom field would drown the finding it is attached to. */
const MAX_EXCERPT_CHARS = 180;

// ─────────────────────────────────────────────────────────────────────────
// Patterns
// ─────────────────────────────────────────────────────────────────────────

/**
 * The ONLY shape `scriptPattern` may take. Enforced twice — once by the input
 * schema (so a malformed call never reaches `execute`) and once inside
 * `inspectNativeLanguage` immediately before the `RegExp` is constructed (so a
 * direct caller, a future refactor that loosens the schema, or a model that
 * finds another way in cannot weaken the gate either).
 *
 * A caller that could pass `.` would make every character "in script" and turn
 * every coverage check into an unconditional pass — a gate that always passes
 * is worse than no gate, because it reports a verdict.
 */
export const SCRIPT_PATTERN_SHAPE = /^\\p\{Script=[A-Za-z]+\}$/;

/** Curly English quotation marks (hard fail 5) — an import tell in body copy that should use straight quotes. */
const CURLY_QUOTES = /[\u201C\u201D\u2018\u2019\u201E]/gu;

/** Eastern-Arabic (U+0660–U+0669) and extended-Arabic/Persian (U+06F0–U+06F9) digits (hard fail 8). */
const EASTERN_ARABIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/gu;

/** Hard fail 9 — a date that was never localised. */
const LATIN_MONTH_NAME = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi;

/**
 * Hard fail 10 — an UNAMBIGUOUSLY wrong month/day order: both leading numbers
 * are >12, so neither position can be a month whichever convention is read.
 * The ambiguous cases (`03/04/2026`) are deliberately not flagged: half of
 * them are correct and a gate cannot tell which half.
 */
const IMPOSSIBLE_DATE_ORDER = /\b(1[3-9]|2\d|3[01])[./](1[3-9]|2\d|3[01])[./]/g;

/**
 * Hard fail 11 — the bidi EMBEDDING and OVERRIDE controls (U+202A LRE,
 * U+202B RLE, U+202C PDF, U+202D LRO, U+202E RLO).
 *
 * Deliberately NOT U+2068/U+2069 (the first-strong isolate pair): those are
 * inserted by `isolateForeignRuns` at render time, AFTER this gate has run
 * (RFC-15 §7.3), and flagging them would fail the fix. This gate only ever
 * sees raw model copy, where a bidi control is either a leak from a copied
 * source or an attempt to hack the layout.
 */
const BIDI_CONTROLS = /[\u202A-\u202E]/gu;

/**
 * One maximal run of Latin-script text, allowed to carry the digits, spaces
 * and punctuation that belong INSIDE an English phrase, so "the new model is
 * now available" is measured as one run rather than six. Never crosses a
 * newline: two Latin words on two different lines are not one clause.
 */
const LATIN_RUN = /\p{Script=Latin}(?:[\p{Script=Latin}\p{Nd} \t'\u2019\-.,:;\/&()+_#@%]*\p{Script=Latin})?/gu;

/** Any Unicode letter. Never `[A-Za-z]`, which cannot see a single one of the scripts this gate is for. */
const ANY_LETTER = /\p{L}/gu;

/** A non-spacing combining mark: nikud in Hebrew, harakat in Arabic. */
const COMBINING_MARK = /\p{Mn}/gu;

/** Hebrew maqaf. Mixing it with the ASCII hyphen inside one post is the soft tell; using either consistently is fine. */
const MAQAF = "\u05BE";

// ─────────────────────────────────────────────────────────────────────────
// Convention packs — keyed by WRITING SYSTEM, not by language
// ─────────────────────────────────────────────────────────────────────────

interface ForbiddenToken {
  readonly token: string;
  readonly steer: string;
}

interface DensityTell {
  readonly token: string;
  readonly maxPer100Words: number;
  readonly note: string;
}

interface ConventionPack {
  /** Hard fail 5. Only set where we KNOW curly quotes are wrong — Russian, French and Arabic all use guillemets or low-9 quotes legitimately. */
  readonly straightQuotesOnly?: boolean;
  /** Hard fail 6. Standalone tokens that are mechanically certain register breaks. */
  readonly forbiddenTokens?: readonly ForbiddenToken[];
  /** Hard fail 7. Left undefined for Devanagari, Thai and every other script where combining marks are structural rather than optional. */
  readonly maxCombiningMarkShare?: number;
  /** Hard fail 8. False for Arabic, where Eastern-Arabic digits are the native digits. */
  readonly forbidEasternArabicDigits?: boolean;
  /** Soft tell. Phrases that are grammatical and that no native writer reaches for first. */
  readonly calques?: readonly string[];
  /** Soft tell. A literary connective that is fine once and a tell five times. */
  readonly densityTells?: readonly DensityTell[];
  /** Soft tell. Present at all is enough to mention, never enough to fail. */
  readonly presenceTells?: readonly ForbiddenToken[];
  /** Soft tell. The script's own hyphen, whose MIXING with the ASCII hyphen is the tell. */
  readonly scriptHyphen?: string;
}

/**
 * Per-writing-system conventions.
 *
 * Hebrew is populated first-class because it is the language this phase was
 * opened for. Every other non-Latin script gets the universal rows only
 * (coverage, unexplained Latin runs, Latin month names, impossible dates,
 * bidi controls) and **says nothing where we do not know** — an English
 * fallback beats a guessed convention.
 *
 * There is deliberately NO Latin row. Curly quotes, `may` as a month name and
 * a long Latin run are all perfectly native in Spanish, French or German, so
 * a Latin-script client gets "this gate has no opinion" rather than a gate
 * that fails correct drafts. That is the same doctrine `SCRIPT_TABLE` records
 * for its own missing entries, applied one layer up.
 */
const CONVENTION_PACKS: Readonly<Record<string, ConventionPack>> = {
  hebrew: {
    straightQuotesOnly: true,
    forbiddenTokens: [
      {
        // The single loudest literary-register tell in Hebrew marketing copy,
        // and mechanically certain: a copula that a journalistic register
        // never uses.
        token: "\u05D4\u05D9\u05E0\u05D5", // הינו
        steer:
          "Replace the copula \u05D4\u05D9\u05E0\u05D5 with \u05D4\u05D5\u05D0 or \u05D4\u05D9\u05D0. It is literary hypercorrection, not the mid-register this publication writes in.",
      },
    ],
    maxCombiningMarkShare: MAX_COMBINING_MARK_SHARE,
    forbidEasternArabicDigits: true,
    calques: [
      "\u05D1\u05E1\u05D5\u05E3 \u05D4\u05D9\u05D5\u05DD", // בסוף היום — "at the end of the day"
      "\u05D1\u05D5\u05D0\u05D5 \u05E0\u05E6\u05DC\u05D5\u05DC", // בואו נצלול — "let's dive in"
      "\u05D1\u05D5\u05D0\u05D5 \u05E0\u05E4\u05E8\u05E7 \u05D0\u05EA \u05D6\u05D4", // בואו נפרק את זה
      "\u05D0\u05E0\u05D7\u05E0\u05D5 \u05E0\u05E8\u05D2\u05E9\u05D9\u05DD", // אנחנו נרגשים — "we are thrilled"
      "\u05DC\u05E7\u05D7\u05EA \u05D0\u05EA \u05D6\u05D4 \u05DC\u05E9\u05DC\u05D1 \u05D4\u05D1\u05D0", // לקחת את זה לשלב הבא
      "\u05DE\u05E9\u05E0\u05D4 \u05D0\u05EA \u05DB\u05DC\u05DC\u05D9 \u05D4\u05DE\u05E9\u05D7\u05E7", // משנה את כללי המשחק
      "\u05D6\u05D4 \u05DE\u05D4 \u05E9\u05D4\u05D5\u05E4\u05DA \u05D0\u05EA", // זה מה שהופך את
    ],
    densityTells: [
      {
        token: "\u05D0\u05E9\u05E8", // אשר
        maxPer100Words: MAX_ASHER_PER_100_WORDS,
        note: "\u05D0\u05E9\u05E8 is carrying work \u05E9\u05BE should be doing; at this density the copy reads as a legal notice rather than as journalism.",
      },
    ],
    presenceTells: [
      {
        token: "\u05E2\u05DC \u05DE\u05E0\u05EA", // על מנת
        steer: "\u05E2\u05DC \u05DE\u05E0\u05EA is the literary form of \u05DB\u05D3\u05D9; a native editor would write \u05DB\u05D3\u05D9.",
      },
    ],
    scriptHyphen: MAQAF,
  },
  // Universal rows only, from here down. Arabic is the one script where the
  // Eastern-Arabic digits are the NATIVE digits, so rule 8 is off for it.
  arabic: { forbidEasternArabicDigits: false, maxCombiningMarkShare: MAX_COMBINING_MARK_SHARE },
  greek: { forbidEasternArabicDigits: true },
  cyrillic: { forbidEasternArabicDigits: true },
  devanagari: { forbidEasternArabicDigits: true },
  thai: { forbidEasternArabicDigits: true },
  armenian: { forbidEasternArabicDigits: true },
  georgian: { forbidEasternArabicDigits: true },
  japanese: { forbidEasternArabicDigits: true },
  korean: { forbidEasternArabicDigits: true },
  chinese: { forbidEasternArabicDigits: true },
};

// ─────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────

export const NativeLanguageInputSchema = z.object({
  language: z.string().min(1).describe("The target language as resolved for this client (\"Hebrew\", \"he-IL\"). Used in the findings a writer reads, never to look a writing system up."),
  scriptName: z
    .string()
    .min(1)
    .describe("The expected writing system's name (\"Hebrew\"), resolved by the caller through the language gate's SCRIPT_TABLE. This is the convention pack's key."),
  scriptPattern: z
    .string()
    .regex(SCRIPT_PATTERN_SHAPE)
    .describe("The expected script's Unicode property escape, in the literal form \"\\p{Script=Hebrew}\" and no other. Re-validated inside the tool: a caller must not be able to weaken the gate by passing \".\"."),
  fields: z
    .array(
      z.object({
        id: z.string().describe("Where this text is rendered: \"caption\", \"slide-3.headline\", \"slide-3.body\", \"slide-3.kicker\", \"slide-3.fields.<slot>\", \"slide-3.device.label\"."),
        text: z.string().describe("The raw model-authored copy for that slot, before any render-time bidi isolation."),
      }),
    )
    .min(1)
    .describe("Every field a reader will actually READ, one entry per rendered slot — judged per field, not as one concatenated blob."),
  allowedLatinTerms: z
    .array(z.string())
    .default([])
    .describe("Terms this client's own posts leave in Latin (product names, model names, protocol tokens). Exempt from the unexplained-Latin-run and forbidden-term checks."),
  forbiddenTransliterations: z
    .array(
      z.union([
        z.string().describe("A term with no known replacement."),
        z.object({
          wrong: z.string().describe("The term that must never appear."),
          right: z.string().optional().describe("What to write instead, when the pack knows. Emitted verbatim in the steer — this is what makes the finding actionable."),
        }),
      ]),
    )
    .default([])
    .describe(
      "The register pack's hardFail rows for this client: purisms and wrong transliterations that must never appear, each with the replacement the pack already holds. " +
        "A bare string is accepted for callers that have no replacement to give.",
    ),
  clientMeanSentenceWords: z
    .number()
    .positive()
    .optional()
    .describe("The mean sentence length measured over this client's own published posts, when a corpus was readable. Drives one SOFT tell only; omitted means the gate has no opinion on sentence length."),
});
export type NativeLanguageInput = z.infer<typeof NativeLanguageInputSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Output — the structured report the verdict is rendered from
// ─────────────────────────────────────────────────────────────────────────

export type NativeLanguageFindingKind =
  | "script-coverage"
  | "script-coverage-aggregate"
  | "unexplained-latin-run"
  | "forbidden-transliteration"
  | "curly-quotes"
  | "hypercorrection"
  | "nikud"
  | "foreign-digits"
  | "latin-month-name"
  | "impossible-date-order"
  | "bidi-control";

export type NativeLanguageSoftTellKind = "calque" | "connective-density" | "literary-phrase" | "mixed-hyphen" | "long-sentences";

/** One hard failure: which field, what rule, the sentence it is in, and the sentence a writer can act on. */
export interface NativeLanguageFinding {
  readonly field: string;
  readonly kind: NativeLanguageFindingKind;
  readonly sentence: string;
  readonly steer: string;
}

/** One candidate finding, handed to the native editor as evidence and NEVER on its own a gate failure. */
export interface NativeLanguageSoftTell {
  readonly field: string;
  readonly kind: NativeLanguageSoftTellKind;
  readonly sentence: string;
  readonly note: string;
}

export interface NativeLanguageReport {
  /** False when no convention pack exists for this writing system — the gate has no opinion and passes. */
  readonly packApplied: boolean;
  readonly findings: readonly NativeLanguageFinding[];
  readonly softTells: readonly NativeLanguageSoftTell[];
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Re-validates the shape and compiles it. Throws rather than returning a
 * verdict: a gate that cannot build its own test has not judged anything, and
 * must never report `pass`.
 */
function compileScriptTest(scriptPattern: string): RegExp {
  if (!SCRIPT_PATTERN_SHAPE.test(scriptPattern)) {
    throw new Error(
      `scriptPattern must be the literal form "\\p{Script=Xxxx}" and was ${JSON.stringify(scriptPattern)} — refusing to run a weakened script check`,
    );
  }
  // Unsupported script names ("\p{Script=Klingon}") throw here; the caller
  // gets a tooling_error, which is the honest answer.
  return new RegExp(scriptPattern, "u");
}

function clip(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > MAX_EXCERPT_CHARS ? `${collapsed.slice(0, MAX_EXCERPT_CHARS - 1)}\u2026` : collapsed;
}

/**
 * The sentence a match sits in, so a writer is handed the clause to rewrite
 * rather than a bare offending character. Always widened far enough to
 * contain the whole match, so a date like `25.13.2026` is not returned as
 * `25.`.
 */
function excerptAround(text: string, start: number, end: number): string {
  let from = 0;
  let to = text.length;
  for (const match of text.matchAll(/[.!?\n]+\s*/gu)) {
    const boundaryStart = match.index ?? 0;
    const boundaryEnd = boundaryStart + match[0].length;
    if (boundaryEnd <= start) from = boundaryEnd;
    else if (boundaryStart >= end) {
      to = boundaryEnd;
      break;
    }
  }
  const excerpt = clip(text.slice(from, to));
  return excerpt.length > 0 ? excerpt : clip(text);
}

interface ScriptCount {
  readonly letters: number;
  readonly inScript: number;
}

function countScript(text: string, scriptTest: RegExp): ScriptCount {
  const letters = text.match(ANY_LETTER) ?? [];
  let inScript = 0;
  for (const letter of letters) if (scriptTest.test(letter)) inScript += 1;
  return { letters: letters.length, inScript };
}

/**
 * Whether a field is written in the target script AT ALL.
 *
 * One expected-script letter is enough on purpose. These conventions
 * (quotation marks, digits, month names, diacritics) are wrong only INSIDE
 * target-language copy — a deliberately English field is caught by the
 * coverage rule, and running the convention rules over it too would bury the
 * one finding that matters under six that do not.
 */
function isInScript(text: string, scriptTest: RegExp): boolean {
  return countScript(text, scriptTest).inScript > 0;
}

/** Case-insensitive substring search that tolerates the regex metacharacters a real product name carries ("C++", "Node.js"). */
function indexOfTerm(haystack: string, term: string): number {
  return haystack.toLowerCase().indexOf(term.toLowerCase());
}

function isAllowedTerm(term: string, allowedLatinTerms: readonly string[]): boolean {
  return allowedLatinTerms.some((allowed) => allowed.trim().length > 0 && allowed.trim().toLowerCase() === term.trim().toLowerCase());
}

/**
 * What is left of a Latin run once every term the client's own posts leave in
 * Latin is removed. `"Retrieval Augmented Generation"` is a 30-character run
 * and zero characters of unexplained English; `"the model shipped yesterday"`
 * is 27 characters of unexplained English whatever the allowlist says.
 *
 * Longest term first, so a longer allowed term is never destroyed by a
 * shorter one it contains.
 */
function unexplainedLatinRuns(run: string, allowedLatinTerms: readonly string[]): string[] {
  let residual = run;
  const terms = [...allowedLatinTerms].filter((t) => t.trim().length > 0).sort((a, b) => b.length - a.length);
  for (const term of terms) {
    for (;;) {
      const at = indexOfTerm(residual, term);
      if (at < 0) break;
      residual = `${residual.slice(0, at)} ${residual.slice(at + term.length)}`;
    }
  }
  return [...residual.matchAll(LATIN_RUN)].map((m) => m[0].trim()).filter((m) => m.length > 0);
}

function words(text: string): number {
  return text.split(/\s+/u).filter((w) => w.length > 0).length;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** Sentences, for the mean-sentence-length soft tell. Splits on terminal punctuation and newlines; a field with no terminator is one sentence. */
function sentencesOf(text: string): string[] {
  return text
    .split(/[.!?\n]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────
// The check itself
// ─────────────────────────────────────────────────────────────────────────

/**
 * The whole gate as a pure function, exported so the workflow step and the
 * native editor can read the STRUCTURED findings (field / kind / sentence /
 * steer) instead of parsing them back out of `evidence` strings. `execute`
 * renders exactly this report into a `GateVerdict`.
 *
 * Throws only when `scriptPattern` is not the allowlisted literal form.
 */
export function inspectNativeLanguage(input: z.input<typeof NativeLanguageInputSchema>): NativeLanguageReport {
  const scriptTest = compileScriptTest(input.scriptPattern);
  const pack = CONVENTION_PACKS[input.scriptName.trim().toLowerCase()];
  if (!pack) return { packApplied: false, findings: [], softTells: [] };

  const allowedLatinTerms = input.allowedLatinTerms ?? [];
  // A bare string is the no-replacement-known form; normalise both shapes to
  // the pair once, here, so hard fail 4 reads one thing.
  const forbiddenTransliterations: Array<{ wrong: string; right?: string | undefined }> = (input.forbiddenTransliterations ?? []).map((term) =>
    typeof term === "string" ? { wrong: term } : term,
  );
  const findings: NativeLanguageFinding[] = [];
  const softTells: NativeLanguageSoftTell[] = [];
  const { language, scriptName } = input;

  // ── Hard fail 2: the catastrophic aggregate floor, kept verbatim ────────
  const joined = input.fields.map((f) => f.text).join("\n\n");
  const aggregate = countScript(joined, scriptTest);
  if (aggregate.letters >= MIN_AGGREGATE_LETTERS_TO_JUDGE) {
    const ratio = aggregate.inScript / aggregate.letters;
    if (ratio < MIN_AGGREGATE_SCRIPT_RATIO) {
      findings.push({
        field: "post",
        kind: "script-coverage-aggregate",
        sentence: clip(joined),
        steer:
          `Write this post in ${language}. Only ${aggregate.inScript} of its ${aggregate.letters} letters (${Math.round(ratio * 100)}%) ` +
          `are in the ${scriptName} script, against a ${Math.round(MIN_AGGREGATE_SCRIPT_RATIO * 100)}% floor for the post as a whole.`,
      });
    }
  }

  for (const field of input.fields) {
    const { id, text } = field;
    if (text.trim().length === 0) continue;

    // ── Hard fail 1: per-field coverage. THE defect this tool closes ──────
    const counted = countScript(text, scriptTest);
    if (counted.letters >= MIN_FIELD_LETTERS_TO_JUDGE) {
      const ratio = counted.inScript / counted.letters;
      if (ratio < MIN_FIELD_SCRIPT_RATIO) {
        findings.push({
          field: id,
          kind: "script-coverage",
          sentence: clip(text),
          steer:
            `Rewrite this field in ${language}: only ${counted.inScript} of its ${counted.letters} letters (${Math.round(ratio * 100)}%) are ` +
            `${scriptName}, against a ${Math.round(MIN_FIELD_SCRIPT_RATIO * 100)}% floor. Every field a reader sees is written in ` +
            `${language}, not only the post as a whole.`,
        });
      }
    }

    // ── Hard fail 11: bidi controls, ANYWHERE (in-script or not) ──────────
    for (const match of text.matchAll(BIDI_CONTROLS)) {
      const at = match.index ?? 0;
      findings.push({
        field: id,
        kind: "bidi-control",
        sentence: excerptAround(text, at, at + match[0].length),
        steer:
          `Delete the bidi control character U+${match[0].codePointAt(0)!.toString(16).toUpperCase()} from this field. ` +
          `Text direction is decided at render time; copy you write carries no direction characters.`,
      });
      break; // one finding per field is enough to act on; the steer says "delete them".
    }

    // ── Hard fail 4: forbidden transliterations and purisms ───────────────
    for (const term of forbiddenTransliterations) {
      const trimmed = term.wrong.trim();
      if (trimmed.length === 0 || isAllowedTerm(trimmed, allowedLatinTerms)) continue;
      const at = indexOfTerm(text, trimmed);
      if (at < 0) continue;
      // NAME THE REPLACEMENT when the pack has one. The pack already knows
      // `יישומון` -> `אפליקציה`; telling the writer only "use the word this
      // niche actually says" throws that away and breaks this phase's own
      // "every finding carries a correction" contract on exactly the findings
      // that are free to produce. The generic sentence is the fallback for a
      // pack row that genuinely has no single right answer.
      const right = term.right?.trim();
      findings.push({
        field: id,
        kind: "forbidden-transliteration",
        sentence: excerptAround(text, at, at + trimmed.length),
        steer:
          (right !== undefined && right.length > 0
            ? `Replace "${trimmed}" with "${right}". `
            : `Replace "${trimmed}" with the word this niche actually says. `) +
          `It is on this client's do-not-use list: either a purism nobody ` +
          `uses out loud or a transliteration of a term that has a live ${language} equivalent.`,
      });
    }

    if (!isInScript(text, scriptTest)) continue;

    // ── Hard fail 3: an unexplained Latin run inside target-language copy ──
    for (const match of text.matchAll(LATIN_RUN)) {
      const raw = match[0];
      if (raw.trim().length <= MAX_UNEXPLAINED_LATIN_RUN) continue;
      for (const residual of unexplainedLatinRuns(raw, allowedLatinTerms)) {
        if (residual.length <= MAX_UNEXPLAINED_LATIN_RUN) continue;
        const at = match.index ?? 0;
        findings.push({
          field: id,
          kind: "unexplained-latin-run",
          sentence: excerptAround(text, at, at + raw.length),
          steer:
            `Write "${clip(residual)}" in ${language}. A Latin run this long inside ${scriptName} copy is an English clause left ` +
            `untranslated; only a product, company, model or protocol name this client's own posts leave in Latin stays in Latin.`,
        });
        break;
      }
    }

    // ── Hard fail 5: curly quotes ─────────────────────────────────────────
    if (pack.straightQuotesOnly === true) {
      for (const match of text.matchAll(CURLY_QUOTES)) {
        const at = match.index ?? 0;
        findings.push({
          field: id,
          kind: "curly-quotes",
          sentence: excerptAround(text, at, at + match[0].length),
          steer: `Use straight quotation marks (") instead of ${match[0]}. Curly English quotes in ${scriptName} body copy are an import tell.`,
        });
        break;
      }
    }

    // ── Hard fail 6: hypercorrection tokens ───────────────────────────────
    for (const forbidden of pack.forbiddenTokens ?? []) {
      // Standalone token only: a letter on either side means it is part of
      // another word, and `\b` cannot see a Hebrew word boundary.
      const standalone = new RegExp(`(?<![\\p{L}\\p{M}])${forbidden.token}(?![\\p{L}\\p{M}])`, "gu");
      for (const match of text.matchAll(standalone)) {
        const at = match.index ?? 0;
        findings.push({
          field: id,
          kind: "hypercorrection",
          sentence: excerptAround(text, at, at + match[0].length),
          steer: forbidden.steer,
        });
        break;
      }
    }

    // ── Hard fail 7: nikud / harakat in body copy ─────────────────────────
    if (pack.maxCombiningMarkShare !== undefined && counted.inScript > 0) {
      const marks = (text.match(COMBINING_MARK) ?? []).length;
      const share = marks / counted.inScript;
      if (share > pack.maxCombiningMarkShare) {
        findings.push({
          field: id,
          kind: "nikud",
          sentence: clip(text),
          steer:
            `Strip the vowel points: ${marks} of this field's ${counted.inScript} ${scriptName} letters carry one ` +
            `(${(share * 100).toFixed(1)}%, over a ${(pack.maxCombiningMarkShare * 100).toFixed(0)}% ceiling). Body copy carries no nikud.`,
        });
      }
    }

    // ── Hard fail 8: foreign digits ───────────────────────────────────────
    if (pack.forbidEasternArabicDigits === true) {
      for (const match of text.matchAll(EASTERN_ARABIC_DIGITS)) {
        const at = match.index ?? 0;
        findings.push({
          field: id,
          kind: "foreign-digits",
          sentence: excerptAround(text, at, at + match[0].length),
          steer: `Write the figure in Western digits (0-9) instead of "${match[0]}". ${language} copy uses Western digits, left to right inside the line.`,
        });
        break;
      }
    }

    // ── Hard fail 9: a Latin month name inside target-language copy ───────
    for (const match of text.matchAll(LATIN_MONTH_NAME)) {
      const at = match.index ?? 0;
      findings.push({
        field: id,
        kind: "latin-month-name",
        sentence: excerptAround(text, at, at + match[0].length),
        steer: `Write the date in digits (DD.MM.YYYY) instead of "${match[0]}". A Latin month name inside ${scriptName} copy is a date that was never localised.`,
      });
      break;
    }

    // ── Hard fail 10: an impossible date order ────────────────────────────
    for (const match of text.matchAll(IMPOSSIBLE_DATE_ORDER)) {
      const at = match.index ?? 0;
      findings.push({
        field: id,
        kind: "impossible-date-order",
        sentence: excerptAround(text, at, at + match[0].length),
        steer: `Rewrite "${match[0]}" as DD.MM.YYYY. Both of its leading numbers are above 12, so neither can be a month and the date cannot be read at all.`,
      });
      break;
    }

    // ── Soft tells: evidence for the native editor, never a failure ───────
    for (const calque of pack.calques ?? []) {
      const at = indexOfTerm(text, calque);
      if (at < 0) continue;
      softTells.push({
        field: id,
        kind: "calque",
        sentence: excerptAround(text, at, at + calque.length),
        note: `"${calque}" is a clause-by-clause import of an English idiom. Grammatical, and not what a native editor reaches for first.`,
      });
    }

    for (const tell of pack.densityTells ?? []) {
      const wordCount = words(text);
      if (wordCount < 20) continue; // a density measured over eight words is noise.
      const per100 = (countOccurrences(text, tell.token) / wordCount) * 100;
      if (per100 <= tell.maxPer100Words) continue;
      softTells.push({
        field: id,
        kind: "connective-density",
        sentence: clip(text),
        note: `${per100.toFixed(1)} uses of "${tell.token}" per 100 words, over ${tell.maxPer100Words}. ${tell.note}`,
      });
    }

    for (const tell of pack.presenceTells ?? []) {
      const at = indexOfTerm(text, tell.token);
      if (at < 0) continue;
      softTells.push({
        field: id,
        kind: "literary-phrase",
        sentence: excerptAround(text, at, at + tell.token.length),
        note: tell.steer,
      });
    }
  }

  // ── Soft tells measured over the WHOLE post ─────────────────────────────
  if (pack.scriptHyphen !== undefined && isInScript(joined, scriptTest)) {
    // The ASCII hyphen is counted only where it joins two letters, so a
    // minus sign, a range or a CLI flag is not read as a hyphenation choice.
    const asciiHyphen = /\p{L}-\p{L}/u.test(joined);
    if (asciiHyphen && joined.includes(pack.scriptHyphen)) {
      softTells.push({
        field: "post",
        kind: "mixed-hyphen",
        sentence: clip(joined),
        note: `This post uses both the ${scriptName} hyphen (${pack.scriptHyphen}) and the ASCII hyphen. Either is fine; mixing them in one post is the tell.`,
      });
    }
  }

  if (input.clientMeanSentenceWords !== undefined) {
    const inScriptFields = input.fields.filter((f) => isInScript(f.text, scriptTest));
    const allSentences = inScriptFields.flatMap((f) => sentencesOf(f.text));
    if (allSentences.length >= 3) {
      const mean = allSentences.reduce((sum, s) => sum + words(s), 0) / allSentences.length;
      const ceiling = input.clientMeanSentenceWords * MAX_SENTENCE_LENGTH_MULTIPLE;
      if (mean > ceiling) {
        softTells.push({
          field: "post",
          kind: "long-sentences",
          sentence: clip(allSentences.reduce((longest, s) => (words(s) > words(longest) ? s : longest), allSentences[0]!)),
          note:
            `Sentences average ${mean.toFixed(1)} words against this client's own measured ${input.clientMeanSentenceWords.toFixed(1)} ` +
            `(ceiling ${ceiling.toFixed(1)}). Long sentences are the shape a translation takes, not the shape this client writes in.`,
        });
      }
    }
  }

  return { packApplied: true, findings, softTells };
}

/** One evidence line per finding: where it is, which rule, the sentence, and what to do about it. */
function renderFinding(finding: NativeLanguageFinding): string {
  return `${finding.field} [${finding.kind}]: "${finding.sentence}" :: ${finding.steer}`;
}

function renderSoftTell(tell: NativeLanguageSoftTell): string {
  return `soft tell | ${tell.field} [${tell.kind}]: "${tell.sentence}" :: ${tell.note}`;
}

/**
 * Everything about writing natively in a non-English language that a machine
 * can decide: per-field script coverage, unexplained Latin clauses, forbidden
 * transliterations, quotation marks, diacritics, digits, dates and bidi
 * controls. Deterministic, no model call, $0.00.
 */
export const nativeLanguage = defineTool<NativeLanguageInput, GateVerdict>({
  name: "gate.nativeLanguage",
  description:
    "Everything about writing natively in a non-English language that a machine can decide: per-field script coverage, unexplained Latin clauses, forbidden transliterations, quotation marks, diacritics, digits, dates and bidi controls. Deterministic, no model call.",
  version: TOOL_VERSION,
  inputSchema: NativeLanguageInputSchema,
  async execute(input) {
    // Re-validated here, before anything is measured, so the refusal is the
    // tool's own and not only the schema's (see SCRIPT_PATTERN_SHAPE).
    if (!SCRIPT_PATTERN_SHAPE.test(input.scriptPattern)) {
      return toolingError<GateVerdict>(
        `gate.nativeLanguage: scriptPattern must be the literal form "\\p{Script=Xxxx}" and was ${JSON.stringify(input.scriptPattern)} — refusing to run a weakened script check`,
      );
    }

    const report = inspectNativeLanguage(input);

    if (!report.packApplied) {
      // The SCRIPT_TABLE doctrine, one layer up: a missing entry degrades to
      // "this gate has no opinion", NEVER to "fail every draft for this
      // client". A failure here costs a redraft attempt and, at the cap, the
      // run.
      return success<GateVerdict>({
        verdict: "pass",
        evidence: [`no convention pack for ${input.language}`],
        toolVersion: TOOL_VERSION,
      });
    }

    const softEvidence = report.softTells.map(renderSoftTell);

    if (report.findings.length > 0) {
      const kinds = [...new Set(report.findings.map((f) => f.kind))].join(", ");
      return success<GateVerdict>({
        verdict: "content_fail",
        // Soft tells ride along so the native editor sees them in the same
        // payload, but they are never what made this a failure: every entry
        // in `findings` is a hard rule, and an empty `findings` is a pass
        // however many soft tells there are.
        evidence: [...report.findings.map(renderFinding), ...softEvidence],
        reason:
          `${report.findings.length} field(s) break the ${input.language} conventions a native reader clocks immediately (${kinds}). ` +
          `Fix each named phrase in place and change no number, date, name or claim while doing it.`,
        toolVersion: TOOL_VERSION,
      });
    }

    return success<GateVerdict>({
      verdict: "pass",
      evidence: [
        `${input.fields.length} field(s) checked against the ${input.scriptName} convention pack; no mechanical ${input.language} convention breach`,
        ...softEvidence,
      ],
      toolVersion: TOOL_VERSION,
    });
  },
});
