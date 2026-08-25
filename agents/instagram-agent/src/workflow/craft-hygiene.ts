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
 * `[A-Za-z][A-Za-z'-]*`, so digits and slashes never reach this set: "GA4"
 * arrives as "GA", "A/B" as two single letters, and anything of length 1 is
 * skipped before the lookup. The pre-existing `B2B`/`B2C`/`Q1`-`Q4` entries are
 * unreachable for that reason and left only to avoid churn — do not add more in
 * that shape, they read as protection that is not there. Mixed-case terms
 * ("SaaS") never trip the check either, since it tests `w === w.toUpperCase()`.
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
 *   never does.
 *
 * `ACRONYM_ALLOWLIST` is kept as a fast path: a known acronym is never even
 * considered for the adjacency rule, so "our GDPR and CCPA obligations" is
 * clean while "GDPR IS BROKEN" still flags.
 */
export function checkSentenceCase(text: string): { ok: true } | { ok: false; reason: string } {
  const words = text.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];

  const isCaps = (w: string) => w.length >= 2 && w === w.toUpperCase();
  /** Caps words that are not a recognised acronym — candidates for shouting. */
  const unknownCaps = words.map((w, i) => ({ w, i })).filter(({ w }) => isCaps(w) && !ACRONYM_ALLOWLIST.has(w));

  const emphasis = unknownCaps.find(({ w }) => EMPHASIS_DENYLIST.has(w));
  if (emphasis) {
    return { ok: false, reason: `contains an ALL-CAPS emphasis word: "${emphasis.w}"` };
  }

  // Two adjacent unknown caps words (three-plus letters each, so an initial
  // or a single letter cannot trip it) reads as shouting rather than as
  // terminology.
  for (let k = 1; k < unknownCaps.length; k++) {
    const prev = unknownCaps[k - 1]!;
    const cur = unknownCaps[k]!;
    if (cur.i === prev.i + 1 && prev.w.length >= 3 && cur.w.length >= 3) {
      return { ok: false, reason: `contains consecutive ALL-CAPS words, which reads as shouting: "${prev.w} ${cur.w}"` };
    }
  }

  const candidateWords = words.slice(1).filter((w) => w.length > 3 && !SENTENCE_CASE_STOPWORDS.has(w.toLowerCase()));
  const capitalizedCount = candidateWords.filter((w) => /^[A-Z][a-z]/.test(w)).length;
  if (candidateWords.length >= 4 && capitalizedCount / candidateWords.length > 0.6) {
    return {
      ok: false,
      reason: `reads as Title Case rather than sentence case (${capitalizedCount}/${candidateWords.length} eligible words capitalized)`,
    };
  }

  return { ok: true };
}

/**
 * The mechanical, unconditional craft-hygiene gate (Fix 3): zero tolerance
 * for em dashes/double hyphens and exclamation marks (reusing the shared
 * `gate.lintPost` tool's already-correct anti-slop check, rather than
 * re-implementing the same regex a second time and risking drift between the
 * two), plus the sentence-case heuristic above. Runs against every slide's
 * `headline`+`body`, regardless of what the client's own style config says —
 * this is intentionally NOT wired to `styleConfig.banned_chars` at all. A
 * failure here is routed into step 07's existing self-check retry loop
 * exactly like a `checkSlidesData` failure (see `create-instagram-agent-workflow.ts`).
 */
export async function checkCraftHygiene(tools: AgentToolRegistry, ctx: AgentContext, copy: InstagramCopyOutput): Promise<SlidesDataSelfCheck> {
  for (const slide of copy.slides) {
    // A custom archetype's own slot values are real on-image text too — this
    // gate is "unconditional... outranks client rules" (see the module doc
    // comment), and that has to hold for every archetype, not just the six
    // whose text happens to live in `headline`/`body`.
    const text = [slide.headline, slide.body, ...(slide.customArchetype ? Object.values(slide.customArchetype.fields) : [])].join(" ");

    const lintTool = tools["gate.lintPost"];
    if (!lintTool) {
      throw new WorkflowToolingFailure(`"gate.lintPost" is not registered — the craft-hygiene gate cannot run without it`);
    }
    const lintOutcome = await lintTool.execute(
      { text, platform: "instagram", checkAntiSlop: true, maxExclamationMarks: 0, bannedPhrases: [] },
      { ctx },
    );
    if (lintOutcome.status !== "success") {
      throw new WorkflowToolingFailure(`gate.lintPost failed: ${lintOutcome.status}`);
    }
    const verdict = lintOutcome.result as GateVerdict;
    if (verdict.verdict !== "pass") {
      return { ok: false, reason: `slide ${slide.n} failed the mechanical craft-hygiene gate: ${verdict.verdict === "content_fail" ? verdict.reason : "gate.lintPost tooling error"}` };
    }

    const sentenceCase = checkSentenceCase(text);
    if (!sentenceCase.ok) {
      return { ok: false, reason: `slide ${slide.n} failed the sentence-case check: ${sentenceCase.reason}` };
    }
  }

  return { ok: true };
}
