import type { AgentContext, AgentToolRegistry, GateVerdict } from "@agent-engine/core";
import { WorkflowToolingFailure } from "@agent-engine/workflow";
import type { InstagramCopyOutput, SlidesDataSelfCheck } from "./types.js";

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
export async function checkCraftHygiene(tools: AgentToolRegistry, ctx: AgentContext, copy: InstagramCopyOutput): Promise<SlidesDataSelfCheck> {
  const lintTool = tools["gate.lintPost"];
  if (!lintTool) {
    throw new WorkflowToolingFailure(`"gate.lintPost" is not registered — the craft-hygiene gate cannot run without it`);
  }

  const slideTexts = copy.slides.map(slideProse);
  const lintOutcome = await lintTool.execute(
    { text: copy.caption, parts: slideTexts, platform: "instagram", checkAntiSlop: true, maxExclamationMarks: 0, bannedPhrases: [] },
    { ctx },
  );
  if (lintOutcome.status !== "success") {
    throw new WorkflowToolingFailure(`gate.lintPost failed: ${lintOutcome.status}`);
  }
  const verdict = lintOutcome.result as GateVerdict;
  if (verdict.verdict !== "pass") {
    if (verdict.verdict !== "content_fail") {
      return { ok: false, reason: "caption failed the mechanical craft-hygiene gate: gate.lintPost tooling error" };
    }
    const part = THREAD_PART_PREFIX.exec(verdict.reason);
    if (part) {
      const slide = copy.slides[Number(part[1]) - 2];
      const detail = verdict.reason.slice(part[0].length);
      return { ok: false, reason: `slide ${slide?.n ?? "?"} failed the mechanical craft-hygiene gate: ${detail}` };
    }
    return { ok: false, reason: `caption failed the mechanical craft-hygiene gate: ${verdict.reason}` };
  }

  const captionCase = checkSentenceCase(copy.caption.replace(HASHTAG, " "));
  if (!captionCase.ok) {
    return { ok: false, reason: `caption failed the sentence-case check: ${captionCase.reason}` };
  }

  for (const [i, slide] of copy.slides.entries()) {
    const sentenceCase = checkSentenceCase(slideTexts[i]!);
    if (!sentenceCase.ok) {
      return { ok: false, reason: `slide ${slide.n} failed the sentence-case check: ${sentenceCase.reason}` };
    }
  }

  return { ok: true };
}
