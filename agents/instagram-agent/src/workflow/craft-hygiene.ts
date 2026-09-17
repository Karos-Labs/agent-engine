import type { AgentContext, AgentToolRegistry, GateVerdict } from "@agent-engine/core";
import { WorkflowToolingFailure } from "@agent-engine/workflow";
import { resolveExpectedScript } from "./language-gate.js";
import { isEnglishTarget } from "./target-language.js";
import type { InstagramCopyOutput, SlidesDataSelfCheck } from "./types.js";
import { checkCaptionRegister, checkNoCompetitorNames, hookOf, namesTopic } from "./caption-craft.js";

/**
 * P0 parity-audit Fix 3: carousel-agent-v2 SKILL.md's "core rules, baked in"
 * (lines ~64-80) are universal and non-configurable — they "outrank client
 * style rules where they conflict." Before this fix, em dashes / exclamation
 * marks / sentence case were only ever enforced through whatever a given
 * client's own `banned_words`/`banned_chars` happened to include, so a
 * client with an empty `banned_chars` list got none of these guarantees.
 * This module makes them unconditional: every slide, every client, every run.
 */

/**
 * Acronyms that are legitimately ALL-CAPS in sentence case ("Our AI tool saved
 * 4 hours a week" is fine; "AMAZING RESULTS" is not).
 *
 * It was described as "deliberately short", with a missing acronym written off
 * as an accepted limitation. A live prep run priced that limitation: two
 * perfectly good drafts were rejected over "DTC", the run burned its whole
 * retry budget re-drafting and re-sourcing images, and it held having produced
 * nothing — about $0.69 and eleven minutes for a word every marketing agency
 * uses daily.
 *
 * So the marketing vocabulary this agent actually writes in is covered. The
 * list stays a heuristic rather than a dictionary — what it cannot afford is to
 * be missing the terms these agents emit constantly, because each miss is a
 * whole failed run rather than one flagged word.
 *
 * ONLY PURE-LETTER ENTRIES BELONG HERE. `checkSentenceCase` tokenises with
 * `\p{L}[\p{L}'’-]*` (letters in any script; digits and slashes are not
 * letters), so "GA4" arrives as "GA", "A/B" as two single letters, and
 * anything of length 1 is skipped before the lookup. The pre-existing
 * `B2B`/`B2C`/`Q1`-`Q4` entries are unreachable for that reason and left only
 * to avoid churn — do not add more in that shape, they read as protection that
 * is not there. Mixed-case terms ("SaaS") never trip the check either, since
 * it tests `w === w.toUpperCase()`.
 */
const ACRONYM_ALLOWLIST = new Set([
  // Roles and general business
  "AI", "API", "CEO", "CFO", "CTO", "COO", "CMO", "VP", "HR", "PR", "IT", "ID",
  "US", "USA", "UK", "EU", "TV", "OK", "Q1", "Q2", "Q3", "Q4",
  "FAQ", "DIY", "PDF", "URL", "B2B", "B2C", "DTC", "SMB",
  // Marketing measurement — the vocabulary these agents write in every run
  "ROI", "ROAS", "CPA", "CPC", "CPM", "CTR", "CAC", "LTV", "AOV", "KPI",
  "MQL", "SQL", "CRM", "CMS", "CDP", "DSP", "SEM", "SEO", "GEO", "UGC",
  "PPC", "SERP", "GA", "UTM", "NPS", "MRR", "ARR", "GMV",
  // Privacy, compliance and legal — prep run pubsub-21545408480430711 burned
  // its whole retry budget and held on "GDPR", the same way an earlier run did
  // on "DTC". Regulation is a standing topic for these agents, so the terms
  // they reach for constantly belong here.
  "GDPR", "CCPA", "HIPAA", "SOC", "PCI", "DSA", "COPPA", "FTC", "ICO", "NDA",
  "TOS", "SLA", "PII", "DPA",
  // Platforms and formats these agents name constantly.
  "SMS", "RSS", "CSV", "HTML", "CSS", "SDK", "CDN", "OTP", "QR", "AR", "VR",
  "LLM", "GPT", "OCR", "IOS",
]);

/**
 * Words that, in ALL CAPS, really are emphasis rather than an acronym.
 *
 * Small on purpose, and the direction matters: see `checkSentenceCase`'s note
 * on why this list exists instead of relying on the allowlist alone.
 */
const EMPHASIS_DENYLIST = new Set([
  "STOP", "NOW", "FREE", "NEW", "BEST", "MUST", "NEVER", "ALWAYS", "EVERY",
  "HUGE", "MASSIVE", "AMAZING", "INCREDIBLE", "URGENT", "WARNING", "ATTENTION",
  "READ", "LOOK", "WATCH", "DON'T", "DONT", "YOU", "YOUR", "ALL", "ONLY",
  "REALLY", "VERY", "SO", "BIG", "TOP", "HOT", "WOW", "YES", "NO", "GO",
  "LIMITED", "EXCLUSIVE", "GUARANTEED", "PROVEN", "SECRET", "INSANE",
]);

/**
 * English function words that, in ALL CAPS, can only be shouting — no acronym
 * is spelled "IS" or "THE". The adjacency rule below normally needs three-plus
 * letters on both sides so a two-letter acronym pair ("UX UI", "NYC VC") is
 * never read as shouting; a caps function word is the one two-letter shape
 * that carries no such doubt, and it is what real shouting is made of
 * ("GDPR IS BROKEN", "THIS IS THE MOMENT"). Before this set existed the
 * allowlist's own comment promised "GDPR IS BROKEN" would flag, and it never
 * did.
 */
const CAPS_FUNCTION_WORDS = new Set([
  "IS", "OR", "AT", "TO", "IN", "ON", "OF", "BY", "WE", "AN", "AS", "BE", "DO", "IF", "MY", "UP", "AM",
  "ARE", "THE", "AND", "NOT", "WAS", "FOR", "BUT", "HAS", "HAD", "CAN", "WHY", "HOW",
]);

/** Short function words excluded from the Title-Case heuristic below — capitalizing them mid-sentence isn't evidence of Title Case. */
const SENTENCE_CASE_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "in", "on", "at", "to", "for",
  "with", "from", "by", "as", "is", "are", "was", "were", "it", "its",
  "this", "that", "your", "our", "we",
]);

/**
 * A deliberately bounded sentence-case heuristic — NOT a real grammar
 * check. It catches two shapes with reasonable confidence and is honest
 * about what it misses:
 *
 * 1. Genuine ALL-CAPS emphasis ("STOP scrolling", "AMAZING RESULTS").
 * 2. Title-Case spam ("Five Ways To Grow Your Team This Quarter") — most
 *    non-stopword words after the first one are capitalized. This WILL
 *    false-positive on a sentence with several legitimate proper nouns/brand
 *    names in it; it cannot distinguish "a headline written in Title Case"
 *    from "a sentence that happens to name several proper nouns." It is a
 *    reasonable heuristic, not a substitute for a human style read.
 *
 * ## Why (1) is no longer "any word outside the acronym allowlist"
 *
 * It used to be, and that made the check FAIL-DANGEROUS: an acronym nobody
 * had listed did not flag a word, it killed a whole run. A failure here
 * routes into the step-07 retry loop, the model re-drafts, writes the same
 * perfectly correct acronym again, and the run exhausts its budget and holds
 * having produced nothing. Prep run pubsub-21545408480430711 spent 18 minutes
 * and three full drafting passes doing exactly that over "GDPR"; an earlier
 * run did it over "DTC". The allowlist's own comment recorded the first
 * incident and still treated a missing entry as an accepted limitation.
 *
 * The asymmetry is the whole argument. A missing ALLOWLIST entry costs a
 * delivered post. A missing DENYLIST entry costs one un-flagged shouty word,
 * in a check that already describes itself as a heuristic rather than a
 * substitute for a human read. So the logic now looks for evidence of
 * shouting rather than absence of evidence of an acronym:
 *
 * - a known emphasis word in caps (`EMPHASIS_DENYLIST`), or
 * - two or more consecutive ALL-CAPS words, which is what real shouting
 *   almost always looks like and which an acronym in running prose almost
 *   never does. Each must be three-plus letters or a caps function word
 *   (`CAPS_FUNCTION_WORDS`): "UX UI" is terminology, "IS BROKEN" is not.
 *
 * `ACRONYM_ALLOWLIST` is kept as a fast path: a known acronym is never even
 * considered for the adjacency rule, so "our GDPR and CCPA obligations" is
 * clean while "GDPR IS BROKEN" still flags.
 *
 * ## Scripts without case (Instagram upgrade 2026-09, brief item B)
 *
 * The tokeniser used to be `[A-Za-z][A-Za-z'-]*`, which cannot see a Hebrew,
 * Arabic or CJK letter at all — so for geektime's Hebrew copy this check read
 * only the Latin loanwords and had no opinion about the text itself. It now
 * tokenises `\p{L}`, and every case rule applies only to CASED tokens
 * (`w !== w.toLowerCase()`, i.e. the word has an upper-case form that differs
 * from itself). An uncased word — every Hebrew word — is neither "all caps"
 * (`w === w.toUpperCase()` is trivially true for it, which is exactly the
 * false positive this guards against) nor "capitalised", so Hebrew, Arabic,
 * Thai and CJK copy can never read as shouting or as Title Case, while a
 * Latin acronym embedded in Hebrew copy is judged exactly as it is in English
 * copy. Greek and Cyrillic ARE cased and are judged like Latin, which is
 * right: "ВНИМАНИЕ" is shouting.
 */
export function checkSentenceCase(text: string): { ok: true } | { ok: false; reason: string } {
  const words = text.match(/\p{L}[\p{L}'’-]*/gu) ?? [];

  const isCased = (w: string) => w !== w.toLowerCase() || w !== w.toUpperCase();
  const isCaps = (w: string) => w.length >= 2 && isCased(w) && w === w.toUpperCase();
  /** Caps words that are not a recognised acronym — candidates for shouting. */
  const unknownCaps = words.map((w, i) => ({ w, i })).filter(({ w }) => isCaps(w) && !ACRONYM_ALLOWLIST.has(w));

  // The denylist is spelled with a straight apostrophe; copy is often typed
  // with the typographic one, and the tokeniser keeps both.
  const emphasis = unknownCaps.find(({ w }) => EMPHASIS_DENYLIST.has(w.replace(/’/g, "'")));
  if (emphasis) {
    return { ok: false, reason: `contains an ALL-CAPS emphasis word: "${emphasis.w}"` };
  }

  // Two adjacent unknown caps words read as shouting rather than as
  // terminology — when each is three-plus letters (so a two-letter acronym
  // pair like "UX UI" or an initial cannot trip it) OR is a caps function
  // word, which is never an acronym (see `CAPS_FUNCTION_WORDS`).
  const shoutable = (w: string) => w.length >= 3 || CAPS_FUNCTION_WORDS.has(w);
  for (let k = 1; k < unknownCaps.length; k++) {
    const prev = unknownCaps[k - 1]!;
    const cur = unknownCaps[k]!;
    if (cur.i === prev.i + 1 && shoutable(prev.w) && shoutable(cur.w)) {
      return { ok: false, reason: `contains consecutive ALL-CAPS words, which reads as shouting: "${prev.w} ${cur.w}"` };
    }
  }

  // Title Case is a property of prose in a CASED script, so the heuristic
  // runs only when most of the words are cased, and then counts only cased
  // tokens. Both halves matter: the Latin words inside a Hebrew sentence are
  // almost always brand names (Google, Anthropic, OpenAI), which is exactly
  // the "several legitimate proper nouns" false positive described above,
  // and judging them on their own would flag most Hebrew tech copy.
  const casedWords = words.filter(isCased);
  const majorityCased = words.length > 0 && casedWords.length / words.length >= 0.5;
  const candidateWords = majorityCased ? words.slice(1).filter((w) => w.length > 3 && isCased(w) && !SENTENCE_CASE_STOPWORDS.has(w.toLowerCase())) : [];
  const capitalizedCount = candidateWords.filter((w) => /^\p{Lu}\p{Ll}/u.test(w)).length;
  if (candidateWords.length >= 4 && capitalizedCount / candidateWords.length > 0.6) {
    return {
      ok: false,
      reason: `reads as Title Case rather than sentence case (${capitalizedCount}/${candidateWords.length} eligible words capitalized)`,
    };
  }

  return { ok: true };
}

/** A slide's reader-facing prose, as one string: `headline` + `body` + a custom archetype's own slot values. */
function slideProse(slide: InstagramCopyOutput["slides"][number]): string {
  // A custom archetype's own slot values are real on-image text too — this
  // gate is "unconditional... outranks client rules" (see the module doc
  // comment), and that has to hold for every archetype, not just the six
  // whose text happens to live in `headline`/`body`.
  return [slide.headline, slide.body, ...(slide.customArchetype ? Object.values(slide.customArchetype.fields) : [])].join(" ");
}

/**
 * `gate.lintPost` names a failing continuation part as "thread part K: …"
 * with K = 2 for `parts[0]`. This gate passes the slides as `parts` in order,
 * so K maps to `copy.slides[K - 2]`.
 */
const THREAD_PART_PREFIX = /^thread part (\d+): /;

/**
 * Instagram hashtags are legitimately written in whatever case the tag was
 * coined in ("#B2BMarketing", "#SaaS", "#AI") and would read as consecutive
 * caps or Title Case to a heuristic built for prose. They are stripped from
 * the caption before the sentence-case check only; the dash/exclamation/
 * length lint sees the caption whole, because a hashtag with an em dash in
 * it is still an em dash on the page.
 */
const HASHTAG = /#\S+/gu;

/**
 * The mechanical, unconditional craft-hygiene gate (Fix 3): zero tolerance
 * for em dashes/double hyphens and exclamation marks (reusing the shared
 * `gate.lintPost` tool's already-correct anti-slop check, rather than
 * re-implementing the same regex a second time and risking drift between the
 * two), plus the sentence-case heuristic above. Runs regardless of what the
 * client's own style config says — this is intentionally NOT wired to
 * `styleConfig.banned_chars` at all. A failure here is routed into step 07's
 * existing self-check retry loop exactly like a `checkSlidesData` failure
 * (see `create-instagram-agent-workflow.ts`).
 *
 * ## The caption is linted too (Instagram upgrade 2026-09, brief item B)
 *
 * This used to iterate `copy.slides` only, so the caption — the one piece of
 * copy a reader sees WITHOUT tapping through, and the only one Instagram
 * length-limits — was never read by the gate at all. It is now the `text` of
 * ONE `gate.lintPost` call whose `parts` are the slides: the caption gets the
 * platform's 2,200-character limit for free (the same limit `lintOne` applies
 * to every part, which no slide will ever approach), every text goes through
 * the same anti-slop rules, and a failing slide is still named by number via
 * the tool's own "thread part K" label. One tool call instead of N is also
 * simply cheaper on a step that runs on every attempt.
 *
 * Reasons read "caption failed …" or "slide N failed …" so the redraft
 * prompt tells the model which text to fix.
 */

/**
 * THE HEBREW HALF OF THE LAZY-ASK BANK (Phase 5, RFC-18 §4.3).
 *
 * `gate.lintPost`'s own bank (`lint-post.ts:87-105`) is ASCII English: "comment
 * below", "agree?", "thoughts?", "let me know your thoughts". It is matched as
 * a case-insensitive substring, so a Hebrew caption closing on `תגיבו למטה` or
 * `מה דעתכם?` matches NOTHING in it. Phase 5 is the phase that introduced the
 * engineered ask and told the writer, without qualification, that eighteen lazy
 * wordings "WILL fail your draft" — and on a Hebrew run that promise could not
 * fire. A rule that never fires is worse than no rule: it reads as protection
 * that is not there (`value-signals.ts`'s own words).
 *
 * The tool takes a per-call supplement and CONCATENATES it onto its own bank
 * (`lint-post.ts:267`), so this closes the gap with no shared-package edit and
 * no `TOOL_VERSION` story.
 *
 * **Passed unconditionally, not keyed off the resolved target language.** A
 * Hebrew string cannot occur in an English caption, so there is nothing to gain
 * from gating it — and gating it would reopen the hole for exactly the run this
 * is for: one whose language resolution said English and whose writer wrote
 * Hebrew anyway. Unconditional is both simpler and strictly stronger.
 *
 * Substrings are kept short enough to survive Hebrew's gender and number
 * inflection where that is cheap (`דעתכם` / `דעתכן`), and every entry is a
 * LAZY form of an ask or a pitch tell, matching the English bank's bar rather
 * than raising a new one. Every phrase here is listed verbatim in
 * `instagram-copy/17.md` §24.3 and `instagram-post-package/1.md` §5, so the
 * writer is told the rule rather than trapped by it.
 */
export const HEBREW_BANNED_PHRASES = [
  // engagement-bait: the Hebrew forms of "comment below", "thoughts?", "agree?"
  "תגיבו למטה",
  "תגיבי למטה",
  "מה דעתכם",
  "מה דעתכן",
  "מה אתם חושבים",
  "מה אתן חושבות",
  "ספרו לנו בתגובות",
  "כתבו לנו בתגובות",
  "שתפו בתגובות",
  "מסכימים?",
  "מסכימות?",
  "דעה לא פופולרית",
  "אף אחד לא מדבר על",
  // pitch tells: the Hebrew forms of "we offer", "our platform helps",
  // "check out our", "link in my bio", "don't miss out", "limited time"
  "אנחנו מציעים",
  "הפלטפורמה שלנו",
  "השירות שלנו עוזר",
  "מוזמנים לפנות אלינו",
  "מוזמנים לשלוח הודעה",
  "לינק בביו",
  "קישור בביו",
  "אל תפספסו",
  "זמן מוגבל",
  "הזדמנות אחרונה",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// WORK NOTES — the writer's working text, on a plate, in front of the reader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE work-note phrase, in one language.
 *
 * `key` is stable and is quoted in the finding, so the redraft steer names the
 * rule rather than only the sentence — the same contract `RegisterRow.key`
 * keeps in `language-register.ts`.
 */
export interface WorkNotePattern {
  key: string;
  /** What this shape IS, in the words a reviewer reads on the trace. */
  label: string;
  pattern: RegExp;
}

/**
 * The phrases that are working text in ANY run, because they are the language
 * a model narrates its own process in whatever language it was asked to write:
 * a sentence about the cards, the materials, the brief, the layout, or about
 * "this slide".
 *
 * ## The incident these are drawn from
 *
 * geektime, 2026-09-16, run `pubsub-21868533047825082`, slide 4 body, shipped
 * and human-approved:
 *
 *   `היא חלק ממנו. ההבדל הזה לא שיווקי, הוא מבני. לא נמצא ציטוט משתתף ישיר
 *    בחומרים; השקף נושא את הטענה בכותרת ובגוף.`
 *
 * ("…no direct participant quote was found in the materials; the slide carries
 * the claim in the headline and the body.") The writer was not free-associating:
 * `editorial-series.ts`'s directive told it, in as many words, to say so in the
 * slide's content when a required object could not be written. That sentence is
 * fixed at source; this is the guard that catches the next one — the instruction
 * was one channel into reader copy and a model has others.
 *
 * ## Why these are narrow, and what they deliberately miss
 *
 * A failure here costs a redraft attempt, and this module has already paid for
 * the fail-dangerous version of that argument twice (`ACRONYM_ALLOWLIST`'s own
 * note: a run burned its whole retry budget and held over "DTC"). So every
 * pattern needs the WORKING-TEXT VOCABULARY to be present — the materials, the
 * cards, the brief, the layout, the slide itself — and none of them fires on a
 * sentence that merely reports an absence.
 *
 * The control is in the same three runs: geektime's slide 6 body says
 * `לא נמצא בשאלוני שוק, הוא בדפוסי הקריאה שגיקטיים מדדה ב-17 שנה` ("it is not
 * found in market surveys, but in the reading patterns geektime has measured
 * over 17 years") — a good line, the same opening two words as the work note,
 * and it must pass. That is why `לא נמצא` is not a pattern and
 * `לא נמצא …בחומרים` is; the test pins both strings.
 *
 * ## The false-positive rate, measured rather than asserted
 *
 * These patterns were swept over every reader-facing string in the six
 * archived 2026-09 prep runs (`headline`, `body`, `caption`, list titles and
 * notes, quote text, stat sub-labels, comparison bodies, custom slots, across
 * karoslabs, thepitchbydeel and geektime, in English and in Hebrew):
 * **468 distinct strings, 1 flagged** — the work note above, and nothing else.
 * A pattern added here without re-running that sweep is a redraft attempt
 * charged to a correct draft.
 */
export const UNIVERSAL_WORK_NOTE_PATTERNS: readonly WorkNotePattern[] = [
  {
    key: "materials-absent",
    label: "an absence reported against the source materials",
    pattern: /\b(?:not|no|nothing)\b[^.!?\n]{0,48}\bin\s+the\s+(?:source\s+|research\s+|supplied\s+|provided\s+|fact\s+)?(?:materials|cards)\b/i,
  },
  { key: "cards-do-not", label: "a sentence about what the fact cards do or do not contain", pattern: /\bthe\s+(?:fact\s+)?cards\s+(?:do|did|does)\s+not\b/i },
  {
    key: "object-not-found",
    label: "a required object reported missing",
    // Up to two qualifiers between the `no` and the noun, because that is how
    // the shape actually arrives: "no DIRECT PARTICIPANT quote was found".
    pattern: /\bno\s+(?:[a-z]+\s+){0,2}?(?:quote|figure|statistic|stat|source|citation)\s+(?:was\s+|could\s+be\s+)?(?:found|available|supplied|provided)\b/i,
  },
  {
    key: "slide-self-reference",
    label: "the slide talking about itself",
    pattern: /\b(?:this|the)\s+slide\s+(?:carries|holds|states|presents|makes|therefore|instead|is\s+left|was\s+left)\b/i,
  },
  { key: "per-the-brief", label: "a reference to the brief or the directive", pattern: /\b(?:per|as\s+per|following)\s+the\s+(?:brief|directive|instructions?|skeleton)\b/i },
  { key: "as-instructed", label: "the writer reporting that it followed an instruction", pattern: /\bas\s+(?:instructed|directed)\b/i },
  { key: "cannot-be-written", label: "a sentence about what could not be written", pattern: /\b(?:cannot|could\s+not|couldn['’]t|can['’]t)\s+be\s+(?:written|filled|sourced)\b/i },
  { key: "archetype-self-reference", label: "the layout or archetype talking about itself", pattern: /\b(?:archetype|layout|template)\s+(?:requires|required|asks\s+for|asked\s+for|renders)\b/i },
];

/**
 * Hebrew work-note phrases.
 *
 * First-class because Hebrew is the language of the run that shipped one and
 * the one non-English language in the fleet we can actually read the output of
 * — the same reason `LANGUAGE_REGISTER_PACKS` populates Hebrew and nothing
 * else. Adding a language here means adding the rows AND someone who reads
 * that language well enough to argue with them; until then that language gets
 * the universal rows, and `workNotePackFor` says so rather than implying a
 * cover it does not have.
 */
export const HEBREW_WORK_NOTE_PATTERNS: readonly WorkNotePattern[] = [
  {
    key: "materials-absent-he",
    label: "an absence reported against the source materials",
    // The `בחומרים` half is load-bearing: `לא נמצא` on its own is ordinary
    // Hebrew prose (see the note above).
    pattern: /(?:לא\s+נמצא\S*|אין|לא\s+קיים\S*|לא\s+קיימ\S+)[^.;!?\n]{0,48}(?:בחומרים|בכרטיסים|בחומר\s+הגלם|בכרטיסי\s+העובדות|במקורות\s+שסופקו)/u,
  },
  {
    key: "slide-self-reference-he",
    label: "the slide talking about itself",
    pattern: /(?:השקף|השקופית)\s+(?:הזה\s+|הזו\s+|הנוכחי\S*\s+)?(?:נושא|נושאת|מציג|מציגה|מכיל|מכילה|נותר\S*|נשאר\S*)/u,
  },
  { key: "per-the-brief-he", label: "a reference to the brief or the directive", pattern: /(?:על\s+פי|לפי)\s+(?:ההנחיה|ההנחיות|הבריף|התדריך|השלד)/u },
  { key: "as-instructed-he", label: "the writer reporting that it followed an instruction", pattern: /(?:כפי\s+שהתבקש|כנדרש\s+בהנחי|כפי\s+שצוין\s+בהנחי|בהתאם\s+להנחיה)/u },
  {
    key: "cannot-be-written-he",
    label: "a sentence about what could not be written",
    pattern: /(?:לא\s+ניתן|אי[\s-]אפשר)\s+(?:היה\s+)?(?:לכתוב|למלא|לאתר|לצטט)[^.;!?\n]{0,48}(?:מהחומרים|מהכרטיסים|בחומרים|בכרטיסים)/u,
  },
];

/**
 * Per-language work-note vocabularies, KEYED BY `SCRIPT_TABLE` SCRIPT NAME
 * through `resolveExpectedScript`, exactly as `LANGUAGE_REGISTER_PACKS` is.
 *
 * The keying is the point rather than a convenience: a key this table carries
 * and the shared language table does not is impossible by construction, and a
 * target language the fleet adds cannot silently arrive with NO work-note
 * guard — it arrives with the universal rows and a `universalOnly` marker that
 * the finding prints.
 */
export const WORK_NOTE_PACKS: Readonly<Record<string, readonly WorkNotePattern[]>> = {
  Hebrew: HEBREW_WORK_NOTE_PATTERNS,
};

/** The `key` a universal-only pack reports, matching `language-register.ts`'s own. */
export const UNIVERSAL_WORK_NOTE_KEY = "universal";

/**
 * The work-note vocabulary for a run's target language: the universal rows
 * always, plus that language's own rows when we have them.
 *
 * `universalOnly` is not decoration — it is the honest statement that this
 * guard reads only English shapes on, say, a Greek post, and it is printed on
 * the finding so a thin guard is visible rather than assumed.
 */
export function workNotePackFor(targetLanguage: string | undefined): { key: string; patterns: readonly WorkNotePattern[]; universalOnly: boolean } {
  const key = targetLanguage === undefined ? undefined : resolveExpectedScript(targetLanguage)?.name;
  const pack = key === undefined ? undefined : WORK_NOTE_PACKS[key];
  if (key === undefined || pack === undefined) {
    return { key: UNIVERSAL_WORK_NOTE_KEY, patterns: UNIVERSAL_WORK_NOTE_PATTERNS, universalOnly: true };
  }
  return { key, patterns: [...UNIVERSAL_WORK_NOTE_PATTERNS, ...pack], universalOnly: false };
}

/**
 * EVERY pattern this guard knows, whatever the run's declared language.
 *
 * Unconditional for the reason `HEBREW_BANNED_PHRASES` is passed
 * unconditionally two hundred lines above: a Hebrew work note cannot occur in
 * an English draft, so keying the scan to the resolved language gains nothing
 * — and it would reopen the hole for exactly the run this guard is for, one
 * whose language resolution said English and whose writer wrote Hebrew anyway.
 * `workNotePackFor` still decides what the FINDING says about coverage.
 */
export function allWorkNotePatterns(): readonly WorkNotePattern[] {
  return [...UNIVERSAL_WORK_NOTE_PATTERNS, ...Object.values(WORK_NOTE_PACKS).flat()];
}

/**
 * Model output arrives with the odd bidi mark or zero-width joiner in it
 * (`\p{Cf}`), and a stray one between two words would walk a `\s+` clause
 * straight past a work note. Formatting characters are dropped and runs of
 * whitespace collapsed before matching; nothing else is normalised, because
 * the matched text is quoted back into the finding.
 */
function normaliseForScan(text: string): string {
  return text.replace(/\p{Cf}/gu, "").replace(/\s+/gu, " ").trim();
}

/** How much of the offending sentence the finding quotes. Long enough for the writer to find it, short enough not to fill the redraft prompt. */
const WORK_NOTE_QUOTE_CHARS = 90;

/**
 * Does this text narrate the pipeline instead of addressing the reader?
 *
 * Exported for the test, and separate from `checkWorkNotes` so the same
 * function that decides a slide can be run over a single string.
 */
export function findWorkNote(text: string): WorkNotePattern | undefined {
  const scanned = normaliseForScan(text);
  return allWorkNotePatterns().find((entry) => entry.pattern.test(scanned));
}

/**
 * THE WORK-NOTES CLAUSE (Phase 5.5, brief item G).
 *
 * Deterministic, $0, no tool, no model. A match returns `{ ok: false }` and is
 * routed by `07b`'s existing ladder — attempts 1..n−1 redraft, the final
 * attempt records the reason and ships. It NEVER holds a run: a work note on a
 * plate is a bad slide, and a held run is no slides at all.
 *
 * **What is scanned is `slideProse` — `headline`, `body` and a custom
 * archetype's own slot values — plus the caption: every string a reader can
 * see, and nothing else.** A slide's `unfillable` field (copy schema, Phase
 * 5.5 item B) is deliberately NOT scanned: it is the channel this guard exists
 * to push these notes into, and a guard that also refused the honest channel
 * would leave the writer with nowhere to report an unfillable object except
 * silence.
 */
export function checkWorkNotes(copy: InstagramCopyOutput, targetLanguage?: string): SlidesDataSelfCheck {
  const pack = workNotePackFor(targetLanguage);
  // Printed only where it is a real gap: a first-class pack, or an English
  // run, is fully covered and needs no caveat on the finding.
  const coverage =
    pack.universalOnly && targetLanguage !== undefined && targetLanguage.trim().length > 0 && !isEnglishTarget(targetLanguage)
      ? ` (no work-note vocabulary is registered for ${targetLanguage}; only the universal patterns read this draft)`
      : "";
  const refuse = (where: string, hit: WorkNotePattern, text: string): SlidesDataSelfCheck => {
    const quoted = normaliseForScan(text);
    // Quoted around the MATCH, not from the top of the slide: the note is
    // usually the last sentence of a body that opens perfectly well, and a
    // steer that quotes the good opening sends the writer to the wrong
    // sentence. None of these patterns is `/g`, so `exec` carries no
    // `lastIndex` between calls (`visual-qa-pre-checks.ts` records why that
    // matters).
    const match = hit.pattern.exec(quoted);
    const start = match === null ? 0 : Math.max(0, match.index - 16);
    const end = start + WORK_NOTE_QUOTE_CHARS;
    const excerpt = `${start > 0 ? "…" : ""}${quoted.slice(start, end)}${end < quoted.length ? "…" : ""}`;
    return {
      ok: false,
      reason:
        `${where} narrates the work instead of addressing the reader — ${hit.label} (${hit.key}): "${excerpt}". ` +
        `Report an object you cannot write in \`unfillable\`, never in the slide's own text${coverage}.`,
    };
  };

  const captionHit = findWorkNote(copy.caption);
  if (captionHit) return refuse("the caption", captionHit, copy.caption);

  for (const slide of copy.slides) {
    const prose = slideProse(slide);
    const hit = findWorkNote(prose);
    if (hit) return refuse(`slide ${slide.n}`, hit, prose);
  }
  return { ok: true };
}

/**
 * ONE ledger warn for a gate that could not form a view (RFC-19 §3, Mechanism C).
 *
 * Lives in this module because it is the leaf of the two step-07 self-check
 * gates — `slides-data.ts` imports it, nothing it imports imports back — and
 * because both gates have to say the same thing the same way: a reviewer
 * reading the run log must be able to tell "the gate looked and refused" from
 * "the gate never looked", and two independently worded warns are how those
 * two facts start reading alike.
 *
 * Idempotent on `(runId, slug)` the way every other warn in this agent is
 * (`WF:8221`, `WF:7328`), and deliberately NOT keyed by attempt: an outage
 * repeated on three attempts is one fact about the deployment, not three facts
 * about three drafts. Swallows its own failure — a bookkeeping write may not
 * cost the thing it is bookkeeping about.
 */
export async function noteGateOutage(tools: AgentToolRegistry, ctx: AgentContext, slug: string, message: string): Promise<void> {
  try {
    await tools["ledger.appendEvent"]?.execute({ runId: ctx.runId, eventId: `${ctx.runId}__${slug}`, level: "warn", message }, { ctx });
  } catch (error) {
    console.error(`${slug}: could not record the gate-outage warn`, error);
  }
}

/** The ledger/idempotency slug for the craft gate's own "no opinion" warn. Exported so a test names the same string the code writes. */
export const CRAFT_GATE_OUTAGE_SLUG = "craft-hygiene-gate-no-opinion";

/**
 * The house self-check shape, plus the ONE thing the house shape cannot say: *this check did not run*.
 *
 * `{ ok: true }` is a clean bill of health, and until this field existed a `gate.lintPost` outage returned
 * exactly that — so a post whose anti-slop half was never measured was indistinguishable, on every surface a
 * client or a reviewer can read, from one that passed it. The ledger warn `noteGateOutage` writes is not a
 * counter-example: `buildRunReport` does not surface `ledger/events` on `GET /runs/:id/status` and the `09a`
 * reviewer never sees it.
 *
 * RFC-19's honesty rule is *"the deliverable records which checks did not pass"*, and a check that did not RUN
 * is the sharpest case of that. Set ALONGSIDE `ok: true` rather than instead of it, because the outage is not
 * a refusal: the draft ships, it just stops claiming a verdict the gate never gave. Optional and absent on the
 * clean path, so a clean post carries no marker at all (`self-check-degrade.ts`'s "absent, never empty").
 *
 * Assignable to `SlidesDataSelfCheck`, so `native-corrections.ts`'s `checkHygiene` port is unchanged.
 */
export type CraftHygieneResult = SlidesDataSelfCheck & {
  outage?: string;
  /**
   * Findings that are REPORTED and do not refuse the draft.
   *
   * The distinction this carries is the one the workflow already draws about
   * a closing call to action: "code can prove a call to action is present and
   * cannot prove one is absent, so a last slide that does not close goes to
   * the judge with a note rather than back to you." Item B8's topic-placement
   * check is the same shape — a phrase match can prove the topic IS named and
   * cannot prove it is absent, because a good headline says "cut" where the
   * topic said "cutting" and drops the unit word for a number.
   */
  notes?: string[];
};

export async function checkCraftHygiene(
  tools: AgentToolRegistry,
  ctx: AgentContext,
  copy: InstagramCopyOutput,
  /**
   * The run's resolved target language (`02d`), when the caller has it. It
   * changes NOTHING about what is refused — `checkWorkNotes` scans every
   * language's patterns unconditionally (`allWorkNotePatterns`) — and only
   * what the finding says about coverage, so every existing caller keeps
   * working unchanged.
   */
  targetLanguage?: string,
  /**
   * The topic this run chose, when the caller has it. Item B8's redraftable
   * half: the caption's first line and slide 1 both have to name the subject,
   * and both are this step's own output, so a finding here is one a redraft
   * can act on.
   */
  topicPhrase?: string,
  /**
   * This client's tracked competitors, when the caller has them (item C5).
   * Empty or absent means the check has nothing to look for, which is the
   * honest reading of a client who never onboarded a competitor list.
   */
  competitorNames?: readonly string[],
): Promise<CraftHygieneResult> {
  const lintTool = tools["gate.lintPost"];
  if (!lintTool) {
    // KEPT AS A THROW (RFC-19 §6 item 8). An UNREGISTERED tool is a deploy
    // defect: there is nothing to measure the draft with and no amount of
    // re-drafting produces one. That is categorically different from the
    // REGISTERED tool that failed, handled below — the distinction Mechanism C
    // turns on.
    throw new WorkflowToolingFailure(`"gate.lintPost" is not registered — the craft-hygiene gate cannot run without it`);
  }

  const slideTexts = copy.slides.map(slideProse);
  const lintOutcome = await lintTool.execute(
    {
      text: copy.caption,
      parts: slideTexts,
      platform: "instagram",
      checkAntiSlop: true,
      maxExclamationMarks: 0,
      bannedPhrases: [...HEBREW_BANNED_PHRASES],
      // Item A10. On Instagram the hook is not a separate field — the
      // caption's first line IS what the feed shows before "more", so this
      // reads the shipped text rather than a field that could disagree with
      // it. (`lint-post.ts` passes the hook separately precisely so a draft
      // cannot satisfy the rule in one place and break it in another; here
      // there is only one place.)
      hook: hookOf(copy.caption),
    },
    { ctx },
  );
  // ── Mechanism C: A GATE THAT COULD NOT RUN HAS NO OPINION (RFC-19 §3) ──
  //
  // `07e2` already takes exactly this posture, in its own words: "A gate that
  // could not RUN is not a verdict on the draft, and this one is free — there
  // is no spend to justify failing a run over." `gate.lintPost` is free too.
  // This gate got it wrong twice and in two different ways: a non-success
  // OUTCOME threw `WorkflowToolingFailure` (a lint provider blip ended a run
  // that had already paid for its draft), and a `tooling_error` VERDICT was
  // converted into a CONTENT refusal — a sentence that says the caption
  // "failed the mechanical craft-hygiene gate" when the gate never read it.
  // That second one is the worse of the two: it fed a redraft prompt a
  // complaint the writer cannot act on, three times, and then held.
  //
  // Both are now "no opinion", ON EVERY ATTEMPT rather than only the final
  // one — an outage is not more of a verdict on attempt 1 than on attempt 3.
  // The bar does not move: `content_fail` still refuses exactly the drafts it
  // refused yesterday, and the sentence-case checks below — which are local
  // code and need no tool — still run and can still refuse this draft.
  const verdict = lintOutcome.status === "success" ? (lintOutcome.result as GateVerdict) : undefined;
  /** Set once, spread into every return BELOW this branch — the same sentence the ledger warn carries, so the two surfaces cannot drift. */
  let outage: { outage: string } | Record<string, never> = {};
  if (verdict === undefined || verdict.verdict === "tooling_error") {
    const message =
      `gate.lintPost could not form a view (${verdict === undefined ? `outcome: ${lintOutcome.status}` : `verdict: tooling_error — ${verdict.reason}`}) — ` +
      "the craft-hygiene gate's anti-slop half recorded NO OPINION on this draft; the sentence-case checks still ran";
    await noteGateOutage(tools, ctx, CRAFT_GATE_OUTAGE_SLUG, message);
    outage = { outage: message };
  } else if (verdict.verdict === "content_fail") {
    const part = THREAD_PART_PREFIX.exec(verdict.reason);
    if (part) {
      const slide = copy.slides[Number(part[1]) - 2];
      const detail = verdict.reason.slice(part[0].length);
      return { ok: false, reason: `slide ${slide?.n ?? "?"} failed the mechanical craft-hygiene gate: ${detail}` };
    }
    return { ok: false, reason: `caption failed the mechanical craft-hygiene gate: ${verdict.reason}` };
  }

  // Ahead of the sentence-case checks, because a work note is a worse defect
  // than a capital letter and the first refusal is the one the redraft prompt
  // carries: a reader who sees `לא נמצא ציטוט משתתף ישיר בחומרים` on a plate
  // is looking at the pipeline, and no amount of Title Case is that.
  const workNotes = checkWorkNotes(copy, targetLanguage);
  if (!workNotes.ok) return { ok: false, reason: workNotes.reason, ...outage };

  const captionCase = checkSentenceCase(copy.caption.replace(HASHTAG, " "));
  if (!captionCase.ok) {
    return { ok: false, reason: `caption failed the sentence-case check: ${captionCase.reason}`, ...outage };
  }

  // Item B4's measurable half: how many emoji, how long a line, and whether
  // the caption is just the slides again. The rest of register is taught in
  // the copy prompt, where a judgement belongs.
  const register = checkCaptionRegister(copy.caption);
  if (!register.ok) {
    return { ok: false, reason: `the caption does not read like a caption: ${register.reason}`, ...outage };
  }

  // ── Item C5: a competitor's name in a client's own post ──
  //
  // Refused rather than noted, unlike B8 below, because this one can be
  // right: a company name either appears or it does not. The texts checked
  // are every public surface at once — the slides, the caption and (at the
  // package step) the alt text and the tags, because a tag is as public as a
  // headline.
  if (competitorNames !== undefined && competitorNames.length > 0) {
    const competitors = checkNoCompetitorNames(competitorNames, { texts: [copy.caption, ...slideTexts] });
    if (!competitors.ok) return { ok: false, reason: competitors.reason!, ...outage };
  }

  // ── Item B8: reported, never refused ──
  //
  // The first cut of this REFUSED a draft whose caption and cover did not
  // carry the topic phrase, and running it against this repo's own fixtures
  // showed why that is wrong. The chosen topic was "5 automation wins from
  // this quarter" while the copy — correctly, following the angle — was about
  // automated weekly reporting. A reader would call those the same post. A
  // substring match cannot, and no amount of stemming makes it able to: the
  // copy step's job is to turn a topic into an argument, and the words change
  // on the way.
  //
  // So it is a note. The instruction lives in the copy prompt (§2), where a
  // judgement belongs, and this records what a machine could see — for the
  // gate payload, and for Phase 6, which will have real search data to weigh
  // it against.
  const notes: string[] = [];

  // ── Item B2: `hookPattern` is asked for, and its absence is a note ──
  //
  // This started as a refusal and was demoted on the same reasoning
  // `payloadKind` records two screens up in `types.ts`: requiring the
  // declaration of a live draft without refusing the fixtures that predate it
  // is not something this gate can tell apart, and a draft sent back for a
  // missing LABEL has spent a redraft on bookkeeping. The prompt (§29) asks
  // for it; the residual gap is the same one `payloadKind` names, and it is
  // named here rather than left to be rediscovered: a writer that omits the
  // field escapes the check, and Phase 6 will rank the posts that carried one.
  if (copy.hookPattern === undefined) {
    notes.push(
      "the draft declares no `hookPattern` — one of number_outcome, contrarian, mistake or relatable_pov; " +
        "without it this post cannot be grouped with the others when hooks are ranked by what they did",
    );
  }
  if (topicPhrase !== undefined && topicPhrase.trim().length > 0) {
    const cover = copy.slides[0];
    const coverText = cover === undefined ? "" : `${cover.headline} ${cover.body}`;
    const missing: string[] = [];
    if (!namesTopic(coverText, topicPhrase)) missing.push("slide 1");
    if (!namesTopic(hookOf(copy.caption), topicPhrase)) missing.push("the caption's first line");
    if (missing.length > 0) {
      notes.push(
        `the topic phrase "${topicPhrase}" is not carried by ${missing.join(" or ")} — ` +
          "Instagram's search and Google both read those two, so naming the subject there is what makes the post findable",
      );
    }
  }

  for (const [i, slide] of copy.slides.entries()) {
    const sentenceCase = checkSentenceCase(slideTexts[i]!);
    if (!sentenceCase.ok) {
      return { ok: false, reason: `slide ${slide.n} failed the sentence-case check: ${sentenceCase.reason}`, ...outage };
    }
  }

  return { ok: true, ...outage, ...(notes.length > 0 ? { notes } : {}) };
}
