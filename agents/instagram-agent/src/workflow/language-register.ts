import { resolveExpectedScript, scriptTableEntries } from "./language-gate.js";
import { SINGLE_LANGUAGE_SCRIPTS, bcp47For, isEnglishTarget, sniffDominantScript } from "./target-language.js";
import type { ContentMode } from "@agent-engine/workflow";
import type { ClientBrief } from "@agent-engine/tools";

/**
 * The payload of step `04l-language-register` (Instagram Phase 4, RFC-15 §3):
 * the persona the copy is written in, the register card it is written against,
 * the term policy the deterministic gate checks, and six things this client
 * actually published in the target language.
 *
 * **Pure, synchronous, model-free, network-free. $0.00.** Everything it reads
 * (`targetLanguage`, the Client Brief, the profile, `crossChannel.entries`) is
 * already in scope and already checkpointed. The few-shot in particular is
 * FRAMING, NOT FETCHING: `readCrossChannelHistory` already calls
 * `research.socialHistory` on the client's own accounts at `04e` and stores
 * the full excerpt on each entry, tagged `origin: "social"`. This module
 * spends nothing to use them.
 *
 * ## The gap this closes
 *
 * Phase 0 gave the writer a LANGUAGE REQUIREMENT ("write entirely in
 * Hebrew") and Phase 0/2 gave the renderer the fonts. Neither says anything
 * about how the language should SOUND. A model told "write in Hebrew" writes
 * an English draft rendered clause by clause: grammatical, in the right
 * script, and instantly recognisable to a native reader as a translation.
 * That draft passes the script check, passes the fluency judge's easy cases,
 * and is the actual defect the 2026-09-08 audit found.
 *
 * ## Three layers, most specific first
 *
 * 1. **Measured** — computed here, in code, over the client's own in-script
 *    posts. The strongest layer because it is not an opinion about Hebrew, it
 *    is a measurement of THIS client's Hebrew.
 * 2. **Pack** — `LANGUAGE_REGISTER_PACKS`, keyed through
 *    `resolveExpectedScript` so it can never drift from `SCRIPT_TABLE` (the
 *    discipline `script-fonts.ts` already follows for its typography rows).
 *    Hebrew is populated first-class; every other language gets the UNIVERSAL
 *    rows only and **says nothing where we do not know**. An English fallback
 *    beats a guessed translation, and a pack invented for a language nobody
 *    here reads would fail correct drafts forever.
 * 3. **`brief.language.register`** — the client's stated tone, verbatim, last.
 *
 * ## hardFail vs softTell
 *
 * Every row carries one or the other, and the split is not a matter of taste.
 * A row is `hardFail` ONLY when a regex can decide it with no judgment at all
 * — the `הינו` copula, the Academy purisms, curly quotation marks,
 * Eastern-Arabic digits, nikud, a Latin month name. Calques, hyphen mixing
 * and register density are `softTell`: measured, handed to the judge as
 * CANDIDATE evidence, and never on their own a gate failure. Under the
 * never-relax-a-threshold rule the answer to an uncertain signal is not a
 * loose threshold — it is no threshold and a judge.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** `hardFail`: a regex decides it. `softTell`: only a native reader decides it, and the judge is given it as a candidate. */
export type RegisterSeverity = "hardFail" | "softTell";

/** A term this pack rules out, with what to write instead. `hardFail` rows' pairs become `gate.nativeLanguage`'s `forbiddenTransliterations`. */
export interface RegisterTermPair {
  wrong: string;
  right: string;
}

export interface RegisterRow {
  /** Stable identifier, quoted in gate evidence and in the judge's findings. */
  key: string;
  /** Short human label for the rendered card. */
  label: string;
  /** The rule, as the writer reads it. Transcribed from RFC-15 §3.2 for Hebrew. */
  guidance: string;
  severity: RegisterSeverity;
  /** Present only where the rule IS a term list. */
  terms?: readonly RegisterTermPair[];
}

/**
 * One language's conventions — the same object `gate.nativeLanguage` checks
 * against, so the writer and the gate can never be told two different things.
 */
export interface ConventionPack {
  /**
   * The `LANGUAGE_REGISTER_PACKS` key that produced this pack: a
   * `SCRIPT_TABLE` script name (`"Hebrew"`), or `"universal"` when no
   * first-class pack existed. Persisted as the belief's `registerKey`.
   */
  key: string;
  /** Display name for prose ("Hebrew"). */
  language: string;
  rows: readonly RegisterRow[];
  /** Terms that must stay in Latin letters and are never transliterated. */
  staysInLatin: readonly string[];
  /** Loanwords whose transliteration into this script is standard in the trade press. */
  transliterationOk: readonly string[];
  /**
   * The `hardFail` term list for `gate.nativeLanguage` — the WHOLE PAIR, not
   * just the wrong half.
   *
   * The gate emits `right` verbatim in its steer (`Replace "יישומון" with
   * "אפליקציה"`), which is the difference between a finding a writer can act
   * on and a finding that costs a redraft to guess at. Flattening to
   * `.map((t) => t.wrong)` here used to leave `RegisterTermPair.right` with
   * no readers at all, repo-wide.
   *
   * Empty for a universal pack: no pack, no opinion.
   */
  forbiddenTransliterations: readonly RegisterTermPair[];
  /** True when only the universal rows are known — the gate must degrade to "no opinion", never to "fail every draft". */
  universalOnly: boolean;
}

/**
 * What the client's own in-script posts measure. Two fields are optional
 * because they need a pack-supplied detector and a language without one gets
 * silence rather than a guess.
 */
export interface MeasuredRegister {
  /** In-script posts the statistics were computed over — the WHOLE filtered set, not just the six exemplars. */
  posts: number;
  meanSentenceWords: number;
  meanCaptionChars: number;
  questionsPerPost: number;
  emojiPerPost: number;
  hashtagsPerPost: number;
  /**
   * Share of sentences whose first word is a verb form the pack recognises.
   * A LOWER BOUND, never a claim of completeness: the detector is a curated
   * list of unambiguous forms, not a part-of-speech tagger, so it under-counts
   * and is rendered as "at least". `undefined` when the pack has no detector.
   */
  verbOpeningShare?: number;
  /** First/second-person pronouns per 100 words. `undefined` when the pack has no pronoun list. */
  personPer100Words?: number;
}

export interface RegisterCard {
  /** Layer 1. Absent when the corpus was empty — which is a fact about the scrape, not about the client. */
  measured?: MeasuredRegister;
  /** Layer 2. Always present; universal-only for a language with no first-class pack. */
  pack: ConventionPack;
  /** Layer 3: `brief.language.register` verbatim, or the client's own voice rules when the brief carries none. */
  clientStated?: string;
  /** All three layers, most specific first, prompt-ready. */
  rendered: string;
}

export interface TermPolicy {
  /**
   * Terms this client's copy may leave in Latin letters: the pack's
   * stays-in-Latin list UNION every Latin token that appears in this client's
   * own in-script posts. Handed to `gate.nativeLanguage` as
   * `allowedLatinTerms` so a term the client themselves uses in English is
   * never flagged as an unexplained Latin run.
   */
  allowedLatinTerms: readonly string[];
  transliterationOk: readonly string[];
  /** The pack's `hardFail` terms AND their replacements, for `gate.nativeLanguage`'s `forbiddenTransliterations`. */
  forbiddenTransliterations: readonly RegisterTermPair[];
}

export interface FewShotPost {
  /** The post, whitespace-normalised and clamped to `FEW_SHOT_CHARS`. */
  text: string;
  /** `"instagram"`, `"x"`, … — the client's own account this came from. */
  channel: string;
  url?: string;
  publishedAt?: string;
}

export interface LanguageBrief {
  /** The run's target language, verbatim as resolved — `"Hebrew"` or `"he-IL"`. */
  target: string;
  /** From `resolveExpectedScript` — never a second table. `""` when the shared table has no opinion. */
  script: string;
  direction: "rtl" | "ltr";
  /** `"he"`. Absent when the shared table cannot name a tag honestly (see `bcp47For`); the `{{lang}}` slot then emits nothing rather than a wrong tag. */
  bcp47?: string;
  persona: string;
  register: RegisterCard;
  terms: TermPolicy;
  /** The same object as `register.pack`; named here because `gate.nativeLanguage` reads it. */
  conventions: ConventionPack;
  /** The client's real posts, in the target language. EMPTY, not faked, when none were readable. */
  fewShot: readonly FewShotPost[];
  /** Why `fewShot` is short or empty. Absent when the corpus was full. */
  corpusNote?: string;
  /**
   * In-script posts of the client's own that the measurement ran over —
   * `InstagramLanguageBelief.corpusPosts`, by the same name, so `09b` cannot
   * write a belief claiming a corpus this step did not read.
   */
  corpusPosts: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// The Hebrew pack — transcribed from RFC-15 §3.2
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two of the RFC's rows mix severities, and a row can only carry one, so each
 * is split at the seam the RFC itself draws:
 *
 * - `hypercorrections` keeps the register-density pairs (`אשר`, `על מנת`, …)
 *   as `softTell`; `copula` carries `הינו` alone as `hardFail`, because that
 *   one IS mechanically certain and is the loudest literary tell there is.
 * - `numerals` keeps the figure/percent/currency/range rules as `softTell`;
 *   `digits` (Eastern-Arabic digits) and `dates` (a Latin month name inside
 *   Hebrew copy) are `hardFail`, because a regex settles both.
 *
 * The writer sees every row either way. The split only decides what
 * `gate.nativeLanguage` is allowed to fail a draft over.
 */
const HEBREW_ROWS: readonly RegisterRow[] = [
  {
    key: "registerLevel",
    label: "Register",
    guidance: "Journalistic mid-register; not literary, not slang. Headlines carry no final period.",
    severity: "softTell",
  },
  {
    key: "copula",
    label: "Copula",
    guidance: "הינו is never a copula in this register. Write הוא / היא.",
    severity: "hardFail",
    terms: [{ wrong: "הינו", right: "הוא/היא" }],
  },
  {
    key: "hypercorrections",
    label: "Hypercorrections",
    guidance: "אשר → ש־ · על מנת → כדי · יתרה מזאת → ויותר מזה · נעשה שימוש ב → השתמשו ב · בטרם → לפני",
    severity: "softTell",
    terms: [
      { wrong: "אשר", right: "ש־" },
      { wrong: "על מנת", right: "כדי" },
      { wrong: "יתרה מזאת", right: "ויותר מזה" },
      { wrong: "נעשה שימוש ב", right: "השתמשו ב" },
      { wrong: "בטרם", right: "לפני" },
    ],
  },
  {
    key: "calques",
    label: "Calques",
    guidance:
      "English clause order and English idiom translated word for word: בסוף היום · בואו נצלול · בואו נפרק את זה · אנחנו נרגשים ל · לקחת את זה לשלב הבא · משנה את כללי המשחק · זה מה שהופך את. None of these is how anyone says it.",
    severity: "softTell",
    terms: [
      // `בשורה התחתונה` was itself a calque ("the bottom line") and
      // contradicted the judge rubric's answer for the same span. Now that
      // `right` is reader-visible (the gate names it in its steer), the pack
      // and `prompts/instagram-native-editor/1.md` give ONE answer.
      { wrong: "בסוף היום", right: "בסופו של דבר" },
      { wrong: "בואו נצלול", right: "נתחיל" },
      { wrong: "בואו נפרק את זה", right: "נפרק את זה" },
      { wrong: "אנחנו נרגשים ל", right: "השקנו" },
      { wrong: "לקחת את זה לשלב הבא", right: "להתקדם" },
      { wrong: "משנה את כללי המשחק", right: "שינוי משמעותי" },
    ],
  },
  {
    key: "purisms",
    label: "Purisms",
    guidance: "Academy coinages nobody in the trade press uses: יישומון → אפליקציה · מרשתת → אינטרנט · עסק זינוק → סטארט-אפ · אינטליגנציה מלאכותית → בינה מלאכותית · קלאוד → ענן · מחשב לוח → טאבלט",
    severity: "hardFail",
    terms: [
      { wrong: "יישומון", right: "אפליקציה" },
      { wrong: "מרשתת", right: "אינטרנט" },
      { wrong: "עסק זינוק", right: "סטארט-אפ" },
      { wrong: "אינטליגנציה מלאכותית", right: "בינה מלאכותית" },
      { wrong: "קלאוד", right: "ענן" },
      { wrong: "מחשב לוח", right: "טאבלט" },
    ],
  },
  {
    key: "transliterationOk",
    label: "Transliteration allowed",
    guidance: "Loanwords already standard in the trade press: סטארט-אפ, אפליקציה, קוד, סרבר, באג, דיפלוי.",
    severity: "softTell",
  },
  {
    key: "transliterationNo",
    label: "Transliteration refused",
    guidance: "Any word with a live Hebrew equivalent in daily use: תוכנה not סופטוור, חומרה not הארדוור.",
    severity: "hardFail",
    terms: [
      { wrong: "סופטוור", right: "תוכנה" },
      { wrong: "הארדוור", right: "חומרה" },
    ],
  },
  {
    key: "staysInLatin",
    label: "Stays in Latin letters",
    guidance:
      "AI, LLM, GPT, API, SaaS, B2B, iOS, Android, product and company names, model names, protocol/format tokens and file extensions stay in LATIN LETTERS — never transliterated into Hebrew letters. So does every Latin token this client's own posts already use.",
    severity: "softTell",
  },
  {
    key: "quotationMarks",
    label: "Quotation marks",
    guidance: 'Straight " ". NEVER the curly English pairs “ ” ‘ ’ „ — curly quotes in Hebrew body copy are an import tell.',
    severity: "hardFail",
  },
  {
    key: "abbreviation",
    label: "Abbreviation",
    guidance: "Gershayim ״ (U+05F4) before the last letter (ארה״ב, צה״ל); geresh ׳ (U+05F3) for a single-letter abbreviation (ג׳).",
    severity: "softTell",
  },
  {
    key: "numerals",
    label: "Numerals",
    guidance:
      'Western digits, left-to-right inside the Hebrew line. Decimal "." and thousands ",". Percent AFTER the figure (47%). ₪ before the figure, or ש״ח after. A numeric range is written with עד, NEVER with a dash — gate.lintPost bans en dashes, em dashes and the double hyphen outright, in every language, so a dashed range fails a gate that has nothing to do with Hebrew.',
    severity: "softTell",
  },
  {
    key: "digits",
    label: "Digits",
    guidance: "Western digits only. Eastern-Arabic digits (٠١٢٣ / ۰۱۲۳) never appear in Hebrew copy.",
    severity: "hardFail",
  },
  {
    key: "dates",
    label: "Dates",
    guidance: "DD.MM.YYYY. NEVER a Latin month name inside Hebrew copy.",
    severity: "hardFail",
  },
  {
    key: "agreement",
    label: "Agreement",
    guidance:
      "Gender and number agreement on every adjective and verb; construct state (סמיכות) where a chain of של would be clumsy; masculine plural for a mixed audience unless the brief says otherwise.",
    severity: "softTell",
  },
  {
    key: "hyphen",
    label: "Hyphen",
    guidance: "Maqaf ־ and ASCII - are both acceptable. MIXING them in one post is the tell.",
    severity: "softTell",
  },
  { key: "nikud", label: "Nikud", guidance: "None in body copy.", severity: "hardFail" },
];

/** Concrete tokens, not the categories: the categories live in the `staysInLatin` row's prose, where a writer reads them. */
const HEBREW_STAYS_IN_LATIN: readonly string[] = ["AI", "LLM", "GPT", "API", "SaaS", "B2B", "B2C", "iOS", "Android", "SDK", "GPU", "CPU", "URL", "UX", "UI"];

const HEBREW_TRANSLITERATION_OK: readonly string[] = ["סטארט-אפ", "אפליקציה", "קוד", "סרבר", "באג", "דיפלוי"];

/**
 * Sentence-opening verb forms this pack can recognise WITHOUT a
 * part-of-speech tagger: imperatives and reporting verbs that have no common
 * noun homograph in Hebrew. Deliberately short and deliberately incomplete —
 * `verbOpeningShare` is reported as a lower bound, and a list that guessed
 * would produce a register statistic the writer would be steered by and
 * nobody could check.
 */
const HEBREW_OPENING_VERBS: ReadonlySet<string> = new Set([
  "כתבו", "קראו", "שמרו", "בדקו", "נסו", "הורידו", "הסתכלו", "הקשיבו", "שאלו", "דמיינו", "שימו", "עצרו",
  "חשבו", "הצטרפו", "גלו", "ראו", "לחצו", "השוו", "תכירו", "קחו", "תנו", "הביטו", "בחרו", "התחילו",
  "השיק", "השיקה", "השיקו", "הודיע", "הודיעה", "הודיעו", "גייס", "גייסה", "גייסו", "פרסם", "פרסמה", "פרסמו",
  "רכש", "רכשה", "רכשו", "הציג", "הציגה", "הציגו", "מסתבר", "נראה", "נדמה",
]);

/**
 * First and second person, pronouns and possessives only. `את` is
 * deliberately absent: it is the accusative particle before any definite
 * object and appears in almost every Hebrew sentence, so counting it would
 * report every client as maximally second-person.
 */
const HEBREW_PERSON_WORDS: ReadonlySet<string> = new Set([
  "אני", "אנחנו", "אנו", "אתה", "אתם", "אתן", "לי", "לנו", "לך", "לכם", "לכן",
  "שלי", "שלנו", "שלך", "שלכם", "שלכן", "אותי", "אותנו", "אותך", "אותכם", "עלינו", "עליכם",
]);

/** A pack's detectors, kept off `ConventionPack` so the pack stays plain data the gate can read. */
interface PackDetectors {
  openingVerbs?: ReadonlySet<string>;
  personWords?: ReadonlySet<string>;
}

interface PackSpec {
  language: string;
  rows: readonly RegisterRow[];
  staysInLatin: readonly string[];
  transliterationOk: readonly string[];
  detectors: PackDetectors;
}

/**
 * The universal rows: the three things that are true of EVERY non-English
 * language and guessed about none of them. All `softTell` — a universal pack
 * gives `gate.nativeLanguage` no terms at all, so a language nobody here
 * reads degrades to "this gate has no opinion", never to "fail every draft".
 */
const UNIVERSAL_ROWS: readonly RegisterRow[] = [
  {
    key: "quotationMarks",
    label: "Quotation marks",
    guidance: "Use the quotation marks this language's own press uses, and one style per post. Do not mix an English pair with a local pair.",
    severity: "softTell",
  },
  {
    key: "numerals",
    label: "Numerals",
    guidance:
      "Western digits. Write a numeric range with this language's own word for \"to\" — gate.lintPost bans en dashes, em dashes and the double hyphen in every language, so a dashed range fails a gate that has nothing to do with this language.",
    severity: "softTell",
  },
  {
    key: "dates",
    label: "Dates",
    guidance: "Write dates the way this language's own press writes them, and never leave an English month name inside the copy.",
    severity: "softTell",
  },
];

/**
 * Per-language convention packs, KEYED BY `SCRIPT_TABLE` SCRIPT NAME through
 * `resolveExpectedScript`, so a key this table carries and the gate's table
 * does not is impossible by construction — the same discipline
 * `script-fonts.ts` follows for `SCRIPT_TYPOGRAPHY`.
 *
 * Hebrew is first-class because it is the language this phase was written
 * for and the one client we can actually check the output of. Adding a
 * language means adding a row here AND someone who reads it well enough to
 * argue with the rows.
 */
export const LANGUAGE_REGISTER_PACKS: Readonly<Record<string, PackSpec>> = {
  Hebrew: {
    language: "Hebrew",
    rows: HEBREW_ROWS,
    staysInLatin: HEBREW_STAYS_IN_LATIN,
    transliterationOk: HEBREW_TRANSLITERATION_OK,
    detectors: { openingVerbs: HEBREW_OPENING_VERBS, personWords: HEBREW_PERSON_WORDS },
  },
};

/** The `key` a universal pack carries, and the `registerKey` a belief records for one. */
export const UNIVERSAL_PACK_KEY = "universal";

/**
 * Scripts written right to left, by `SCRIPT_TABLE` name. Only the two the
 * shared table actually carries: Thaana, Syriac and N'Ko have no row, so
 * there is nothing here to be wrong about. A new RTL row in `SCRIPT_TABLE`
 * adds its name here and nowhere else.
 */
const RTL_SCRIPTS: ReadonlySet<string> = new Set(["Hebrew", "Arabic"]);

/**
 * A display name for the target: `"he-IL"` renders as `"Hebrew"` when the
 * shared table's row for that script carries exactly one language, and
 * verbatim otherwise. No second table, and no guess — for a row several
 * languages share (`"ru"`, `"fa"`) the tag is all we honestly have.
 */
function displayLanguage(target: string): string {
  const expected = resolveExpectedScript(target);
  if (expected === undefined) return target;
  if (SINGLE_LANGUAGE_SCRIPTS.has(expected.name)) return expected.name;
  const row = scriptTableEntries().find((e) => e.script.name === expected.name);
  return row !== undefined && row.names.length === 1 ? expected.name : target;
}

/** The pack for a target language, and the key it was found under. Never `undefined`: an unknown language gets the universal rows. */
export function registerPackFor(targetLanguage: string): ConventionPack {
  const key = resolveExpectedScript(targetLanguage)?.name ?? UNIVERSAL_PACK_KEY;
  const spec = LANGUAGE_REGISTER_PACKS[key];
  if (spec === undefined) {
    return {
      key: UNIVERSAL_PACK_KEY,
      language: displayLanguage(targetLanguage),
      rows: UNIVERSAL_ROWS,
      staysInLatin: [],
      transliterationOk: [],
      forbiddenTransliterations: [],
      universalOnly: true,
    };
  }
  return {
    key,
    language: spec.language,
    rows: spec.rows,
    staysInLatin: spec.staysInLatin,
    transliterationOk: spec.transliterationOk,
    // The PAIR crosses the boundary, not `t.wrong` alone — the gate's steer
    // names the replacement the pack already holds.
    forbiddenTransliterations: spec.rows.filter((r) => r.severity === "hardFail").flatMap((r) => r.terms ?? []),
    universalOnly: false,
  };
}

function detectorsFor(pack: ConventionPack): PackDetectors {
  return pack.universalOnly ? {} : (LANGUAGE_REGISTER_PACKS[pack.key]?.detectors ?? {});
}

// ─────────────────────────────────────────────────────────────────────────────
// The corpus — selection and measurement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One of the client's own posts, as `crossChannel.entries` carries it.
 * Structurally a `CrossChannelEntry`, declared loosely so a caller can pass
 * either that or a raw `research.socialHistory` post.
 *
 * `engagement` is optional but IS populated on the `origin: "social"` entries
 * `04e` supplies: `research.socialHistory` has always returned it, and
 * `readCrossChannelHistory` — which used to drop it on the floor while mapping
 * a `SocialHistoryPost` onto a `CrossChannelEntry` — now carries it through.
 * The ranking below therefore really does rank by reception first; it falls
 * through to prose length and recency only for a post the scraper reported no
 * engagement for, and for ledger entries, which have none by definition.
 */
export interface OwnPostEntry {
  excerpt: string;
  channel?: string;
  origin?: string;
  url?: string;
  recordedAt?: string;
  engagement?: { likes?: number; comments?: number; views?: number } | undefined;
}

/** A caption shorter than this teaches no register — three words is a label, not a voice. */
export const MIN_EXEMPLAR_CHARS = 120;
/** Exemplars for the writer. */
export const FEW_SHOT_FOR_WRITER = 6;
/** Exemplars for the native judge — the same posts, the first four, so the two never disagree about what this client sounds like. */
export const FEW_SHOT_FOR_JUDGE = 4;
/** Per-exemplar ceiling. Six of these is about 2.4k characters of prompt. */
export const FEW_SHOT_CHARS = 400;
/** Ceiling on `allowedLatinTerms`; a client with more Latin tokens than this in their own posts has an English account. */
const MAX_ALLOWED_LATIN_TERMS = 80;

/**
 * Does this post's own dominant script match the target's expected script?
 *
 * Per POST, not over the corpus: a bilingual account whose Hebrew and English
 * posts are averaged together yields a mixed exemplar set, which is the
 * plan's failure mode dressed up as its fix.
 */
function postMatchesScript(text: string, expectedScriptName: string): boolean {
  const sniff = sniffDominantScript(text);
  switch (sniff.kind) {
    case "resolved":
      return sniff.script === expectedScriptName;
    case "ambiguous":
      // "Han" is what the sniff calls Han-alone text; the table's names for
      // the same writing system are Chinese/Japanese/Korean.
      return sniff.script === expectedScriptName || (sniff.script === "Han" && (expectedScriptName === "Chinese" || expectedScriptName === "Japanese" || expectedScriptName === "Korean"));
    case "latin":
      return expectedScriptName === "Latin";
    default:
      // `insufficient` and `mixed`: no opinion, and an exemplar we cannot
      // vouch for is worse than one fewer exemplar.
      return false;
  }
}

function normaliseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Likes plus comments. Views are deliberately excluded: a view is not an endorsement, and on Instagram it dwarfs every other number. */
function engagementScore(post: OwnPostEntry): number {
  const e = post.engagement;
  if (!e) return 0;
  return (typeof e.likes === "number" ? e.likes : 0) + (typeof e.comments === "number" ? e.comments : 0);
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?…。？؟])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => /\p{L}/u.test(s));
}

function wordsOf(text: string): string[] {
  return text.split(/\s+/u).filter((t) => /[\p{L}\p{N}]/u.test(t));
}

/** The first word of a sentence, stripped of leading punctuation, quotes and emoji. */
function firstWord(sentence: string): string {
  const cleaned = sentence.replace(/^[^\p{L}\p{N}]+/u, "");
  return /^[\p{L}\p{N}'׳"״־-]+/u.exec(cleaned)?.[0] ?? "";
}

/** A token stripped of the punctuation a pronoun list would never carry. */
function bareWord(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * The measured layer, over the WHOLE filtered corpus — not just the six
 * exemplars, because a mean over six posts is noise and a mean over every
 * post the client published is a register.
 */
function measureRegister(posts: readonly string[], detectors: PackDetectors): MeasuredRegister | undefined {
  if (posts.length === 0) return undefined;
  let sentences = 0;
  let words = 0;
  let verbOpenings = 0;
  let personWords = 0;
  let questions = 0;
  let emoji = 0;
  let hashtags = 0;
  let chars = 0;
  for (const post of posts) {
    chars += post.length;
    questions += (post.match(/[?？؟]/gu) ?? []).length;
    emoji += (post.match(/\p{Extended_Pictographic}/gu) ?? []).length;
    hashtags += (post.match(/(?:^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
    for (const sentence of sentencesOf(post)) {
      sentences += 1;
      const tokens = wordsOf(sentence);
      words += tokens.length;
      if (detectors.openingVerbs?.has(firstWord(sentence))) verbOpenings += 1;
      if (detectors.personWords !== undefined) {
        for (const token of tokens) if (detectors.personWords.has(bareWord(token))) personWords += 1;
      }
    }
  }
  return {
    posts: posts.length,
    meanSentenceWords: sentences > 0 ? round1(words / sentences) : 0,
    meanCaptionChars: Math.round(chars / posts.length),
    questionsPerPost: round1(questions / posts.length),
    emojiPerPost: round1(emoji / posts.length),
    hashtagsPerPost: round1(hashtags / posts.length),
    ...(detectors.openingVerbs !== undefined && sentences > 0 ? { verbOpeningShare: round1(verbOpenings / sentences * 100) / 100 } : {}),
    ...(detectors.personWords !== undefined && words > 0 ? { personPer100Words: round1((personWords / words) * 100) } : {}),
  };
}

/** Every Latin token this client leaves in Latin letters inside their own in-script posts, most frequent first. */
function latinTermsIn(posts: readonly string[]): string[] {
  const counts = new Map<string, { spelling: string; n: number; first: number }>();
  let seen = 0;
  for (const post of posts) {
    for (const raw of post.match(/[A-Za-z][A-Za-z0-9.+#_-]*/gu) ?? []) {
      const token = raw.replace(/[.+#_-]+$/u, "");
      if (token.length < 2) continue;
      const key = token.toLowerCase();
      const row = counts.get(key);
      if (row) row.n += 1;
      else counts.set(key, { spelling: token, n: 1, first: seen });
      seen += 1;
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.first - b.first).map((r) => r.spelling);
}

// ─────────────────────────────────────────────────────────────────────────────
// The persona
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The role, per content mode. FIXED STRINGS, never model-authored: the whole
 * point of deriving the persona in code is that nothing in this repo gets to
 * invent who the client is.
 *
 * RFC-15 §3.1 names two — news and evergreen. `open-discussion` is a question
 * post written by the same newsroom that writes the news, so it takes the
 * staff-editor role rather than a third one nobody specified.
 */
const ROLE_BY_MODE: Readonly<Record<ContentMode, string>> = {
  "hot-news": "a staff editor",
  "deep-value": "the editor who writes the explainers",
  "open-discussion": "a staff editor",
};

const DEFAULT_ROLE = "a staff editor";
/** The last resort when a client has no company name and no positioning: generic, and never a brand somebody invented. */
const FALLBACK_PUBLICATION = "this publication";

function clamp(text: string, chars: number): string {
  const t = normaliseWhitespace(text);
  return t.length <= chars ? t : `${t.slice(0, chars).trimEnd()}…`;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The subject of the brief's positioning one-liner — "Geektime" out of
 * "Geektime is Israel's largest technology site". The clause before the first
 * copula or comma, which is what a one-liner's subject is; empty when the
 * one-liner does not start with one.
 */
const PRONOUN_SUBJECTS: ReadonlySet<string> = new Set(["we", "our", "us", "i", "they", "it", "this", "the company", "the team", "the brand"]);

function positioningSubject(oneLiner: string | undefined): string | undefined {
  if (oneLiner === undefined) return undefined;
  const head = normaliseWhitespace(oneLiner).split(/\s+(?:is|are|was|were|helps?|builds?|covers?|publishes?|makes?|runs?)\s+|,/u)[0] ?? "";
  const subject = head.trim();
  // A one-liner written in the first person ("We help teams ship faster")
  // names no publication, and "You are a staff editor at We" is worse than
  // the generic fallback.
  if (subject.length < 3 || subject.length > 60 || PRONOUN_SUBJECTS.has(subject.toLowerCase())) return undefined;
  return subject;
}

/** `profile.companyName ?? profile.name`, falling back to the brief's positioning subject. Nothing here is invented. */
export function publicationName(profile: Record<string, unknown> | undefined, brief: LanguageBriefBrief): string {
  return (
    optionalString(profile?.["companyName"]) ??
    optionalString(profile?.["name"]) ??
    positioningSubject(brief.positioning?.oneLiner) ??
    FALLBACK_PUBLICATION
  );
}

/**
 * The persona, derived entirely from the client's own record.
 *
 * For geektime this renders literally the plan's own example — "a staff
 * editor at Geektime" — with nothing in this file knowing the word Geektime.
 */
export function buildPersona(input: { profile?: Record<string, unknown> | undefined; brief: LanguageBriefBrief; mode?: ContentMode | undefined }): string {
  const publication = publicationName(input.profile, input.brief);
  const role = input.mode !== undefined ? ROLE_BY_MODE[input.mode] : DEFAULT_ROLE;
  const icp = clamp(input.brief.icp?.summary ?? "the people who work in this field", 200);
  const persona =
    `You are ${role} at ${publication}. You write for ${icp}. ` +
    `Everything you write is read by people who read ${publication} every week and would put down a post that sounds translated.`;
  const register = optionalString(input.brief.language?.register);
  return register === undefined ? persona : `${persona}\n\n${register}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildLanguageBrief
// ─────────────────────────────────────────────────────────────────────────────

/** The slice of the Client Brief this module reads. A `Pick` so a test fixture is three fields, not thirty. */
export type LanguageBriefBrief = Pick<ClientBrief, "positioning" | "icp" | "language">;

export interface BuildLanguageBriefInput {
  /** The run's adopted target language. `undefined` or English returns `undefined` — 04l is skipped, by design, at zero cost. */
  language: string | undefined;
  brief: LanguageBriefBrief;
  /** `buildClientVoiceContext`'s block. Used only as the stated-register fallback when the brief carries none. */
  clientVoiceContext?: string | undefined;
  profile?: Record<string, unknown> | undefined;
  /** `crossChannel.entries`. Only `origin === "social"` entries are the client's OWN posts. */
  ownPosts?: readonly OwnPostEntry[] | undefined;
  mode?: ContentMode | undefined;
  /** How many of the client's own accounts were asked for, so `corpusNote` can say "2 accounts, 10 posts returned, 0 in-script". Omitted when the caller does not know. */
  socialAccounts?: number | undefined;
}

/**
 * The `04l-language-register` payload. `undefined` when there is no
 * non-English target — the step does not run, the register is not rendered,
 * and nothing is spent.
 */
export function buildLanguageBrief(input: BuildLanguageBriefInput): LanguageBrief | undefined {
  const target = typeof input.language === "string" ? input.language.trim() : "";
  if (target.length === 0 || isEnglishTarget(target)) return undefined;

  const expected = resolveExpectedScript(target);
  const scriptName = expected?.name ?? "";
  const pack = registerPackFor(target);
  const label = pack.language;

  // 1. The client's own posts, in the target language.
  const social = (input.ownPosts ?? []).filter((p) => p.origin === undefined || p.origin === "social");
  const inScript = social.filter((p) => scriptName.length > 0 && postMatchesScript(p.excerpt, scriptName));
  const usable = inScript.filter((p) => normaliseWhitespace(p.excerpt).length >= MIN_EXEMPLAR_CHARS);

  const ranked = [...usable].sort(
    (a, b) =>
      engagementScore(b) - engagementScore(a) ||
      normaliseWhitespace(b.excerpt).length - normaliseWhitespace(a.excerpt).length ||
      (b.recordedAt ?? "").localeCompare(a.recordedAt ?? ""),
  );
  const fewShot: FewShotPost[] = ranked.slice(0, FEW_SHOT_FOR_WRITER).map((p) => ({
    text: clamp(p.excerpt, FEW_SHOT_CHARS),
    channel: p.channel ?? "the client's own account",
    ...(p.url !== undefined ? { url: p.url } : {}),
    ...(p.recordedAt !== undefined ? { publishedAt: p.recordedAt } : {}),
  }));

  // 2. The measured layer, over the whole usable set.
  const detectors = detectorsFor(pack);
  const measured = measureRegister(
    usable.map((p) => normaliseWhitespace(p.excerpt)),
    detectors,
  );

  // 3. The term policy: the pack's Latin list, plus every Latin token this
  //    client already leaves in Latin in their own in-script posts.
  const corpusLatin = latinTermsIn(usable.map((p) => p.excerpt));
  const allowedLatinTerms: string[] = [];
  const seen = new Set<string>();
  for (const term of [...pack.staysInLatin, ...corpusLatin]) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    allowedLatinTerms.push(term);
    if (allowedLatinTerms.length >= MAX_ALLOWED_LATIN_TERMS) break;
  }

  const clientStated = optionalString(input.brief.language?.register) ?? optionalString(input.clientVoiceContext);
  const register: RegisterCard = {
    ...(measured !== undefined ? { measured } : {}),
    pack,
    ...(clientStated !== undefined ? { clientStated: clamp(clientStated, 600) } : {}),
    rendered: "",
  };
  register.rendered = renderRegisterCard(register, label);

  const bcp47 = bcp47For(target);
  const corpusNote = buildCorpusNote({
    label,
    accounts: input.socialAccounts,
    returned: social.length,
    inScript: inScript.length,
    usable: usable.length,
  });

  return {
    target,
    script: scriptName,
    direction: RTL_SCRIPTS.has(scriptName) ? "rtl" : "ltr",
    ...(bcp47 !== undefined ? { bcp47 } : {}),
    persona: buildPersona({ profile: input.profile, brief: input.brief, mode: input.mode }),
    register,
    terms: { allowedLatinTerms, transliterationOk: pack.transliterationOk, forbiddenTransliterations: pack.forbiddenTransliterations },
    conventions: pack,
    fewShot,
    ...(corpusNote !== undefined ? { corpusNote } : {}),
    corpusPosts: usable.length,
  };
}

/** The four exemplars the native judge is shown — the same posts as the writer's, so the two can never disagree about what this client sounds like. */
export function judgeFewShot(brief: LanguageBrief): readonly FewShotPost[] {
  return brief.fewShot.slice(0, FEW_SHOT_FOR_JUDGE);
}

/**
 * Why the few-shot is short or empty — and it is NEVER read as "this client
 * has no Hebrew". `research.socialHistory` drops textless posts silently and
 * caches the empty result, so a zero here is a fact about the scrape. The
 * note carries the three counts a person debugging it needs.
 */
function buildCorpusNote(counts: { label: string; accounts?: number | undefined; returned: number; inScript: number; usable: number }): string | undefined {
  if (counts.usable >= FEW_SHOT_FOR_WRITER) return undefined;
  const accounts = counts.accounts !== undefined ? `${counts.accounts} account${counts.accounts === 1 ? "" : "s"}, ` : "";
  const tail = `(${accounts}${counts.returned} posts returned, ${counts.inScript} in-script, ${counts.usable} at least ${MIN_EXEMPLAR_CHARS} characters)`;
  if (counts.usable === 0) return `no ${counts.label} posts were readable for this client's own accounts ${tail}`;
  return `only ${counts.usable} ${counts.label} post${counts.usable === 1 ? "" : "s"} of this client's own were long enough to use as exemplars ${tail}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

const SPELLED = ["Nothing", "One", "Two", "Three", "Four", "Five", "Six"] as const;

function renderMeasured(measured: MeasuredRegister, label: string): string {
  const clauses: string[] = [`${measured.meanSentenceWords} words a sentence on average`, `${measured.meanCaptionChars} characters a post`];
  if (measured.verbOpeningShare !== undefined) clauses.push(`open with a verb in at least ${Math.round(measured.verbOpeningShare * 10)} sentences in 10`);
  clauses.push(measured.questionsPerPost === 0 ? "never ask the reader a question" : `${measured.questionsPerPost} question marks a post`);
  clauses.push(measured.emojiPerPost === 0 ? "no emoji" : `${measured.emojiPerPost} emoji a post`);
  clauses.push(measured.hashtagsPerPost === 0 ? "no hashtags" : `${measured.hashtagsPerPost} hashtags a post`);
  if (measured.personPer100Words !== undefined) clauses.push(`first- or second-person pronouns ${measured.personPer100Words} times per 100 words`);
  return `MEASURED on ${measured.posts} of this client's own ${label} posts — this is their register, not a description of one: ${clauses.join("; ")}.`;
}

function renderPack(pack: ConventionPack): string {
  const head = pack.universalOnly
    ? `CONVENTIONS for ${pack.language}. There is no first-class convention pack for this language, so only the rules that hold for every language are stated. Where this card says nothing, follow the client's own posts — an honest silence beats a guessed rule.`
    : `CONVENTIONS for ${pack.language}. A rule marked [hard] is checked mechanically by gate.nativeLanguage and fails a draft; [soft] is handed to the native editor as candidate evidence.`;
  const rows = pack.rows.map((r) => `- ${r.label} [${r.severity === "hardFail" ? "hard" : "soft"}]: ${r.guidance}`);
  return [head, ...rows].join("\n");
}

/** The three layers, most specific first. Exported through `RegisterCard.rendered`; separate so the card stays data. */
export function renderRegisterCard(card: RegisterCard, label: string): string {
  const blocks: string[] = [];
  if (card.measured !== undefined) blocks.push(renderMeasured(card.measured, label));
  blocks.push(renderPack(card.pack));
  if (card.clientStated !== undefined) blocks.push(`THE CLIENT'S OWN STATED REGISTER: ${card.clientStated}`);
  return blocks.join("\n\n");
}

/**
 * The whole `04l` payload, prompt-ready.
 *
 * The few-shot header states the tension with `recentPosts` in one sentence
 * the writer cannot misread: these are how the client SOUNDS, `recentPosts`
 * is what they have already SAID.
 */
export function renderLanguageBrief(brief: LanguageBrief): string {
  const blocks: string[] = [brief.persona, brief.register.rendered];

  if (brief.fewShot.length > 0) {
    const count = SPELLED[brief.fewShot.length] ?? String(brief.fewShot.length);
    blocks.push(
      [
        `${count} things this client actually published, in their own ${brief.register.pack.language}. This is how they SOUND — register, sentence length, which terms they leave in English, how they punctuate. Write in this voice. It is NOT a topic list: a post that reuses an exemplar's topic, hook or angle fails the dedupe gate.`,
        ...brief.fewShot.map((p, i) => `${i + 1}. ${p.text}`),
      ].join("\n"),
    );
  }
  if (brief.corpusNote !== undefined) blocks.push(`Corpus note: ${brief.corpusNote}`);
  if (brief.terms.allowedLatinTerms.length > 0) blocks.push(`Terms that stay in Latin letters: ${brief.terms.allowedLatinTerms.join(", ")}.`);
  return blocks.join("\n\n");
}
