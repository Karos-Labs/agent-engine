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
 * A short allowlist of common acronyms that are legitimately ALL-CAPS in
 * sentence case ("Our AI tool saved 4 hours a week" is fine; "AMAZING
 * RESULTS" is not). Deliberately short — this is a heuristic, not a
 * dictionary, and false negatives here (a real acronym not on the list
 * getting flagged) are an accepted, documented limitation.
 */
const ACRONYM_ALLOWLIST = new Set([
  "AI", "API", "CEO", "CFO", "CTO", "COO", "VP", "HR", "PR", "IT", "ID",
  "ROI", "FAQ", "DIY", "PDF", "URL", "SEO", "SEO", "B2B", "B2C",
  "US", "USA", "UK", "EU", "TV", "OK", "Q1", "Q2", "Q3", "Q4",
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
 * 1. An ALL-CAPS word outside the acronym allowlist ("STOP scrolling") —
 *    the clearest, lowest-false-positive signal available without real NLP.
 * 2. Title-Case spam ("Five Ways To Grow Your Team This Quarter") — most
 *    non-stopword words after the first one are capitalized. This WILL
 *    false-positive on a sentence with several legitimate proper nouns/brand
 *    names in it; it cannot distinguish "a headline written in Title Case"
 *    from "a sentence that happens to name several proper nouns." It is a
 *    reasonable heuristic, not a substitute for a human style read.
 */
export function checkSentenceCase(text: string): { ok: true } | { ok: false; reason: string } {
  const words = text.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];

  const shoutingWord = words.find((w) => w.length >= 2 && w === w.toUpperCase() && !ACRONYM_ALLOWLIST.has(w));
  if (shoutingWord) {
    return { ok: false, reason: `contains an ALL-CAPS word outside the acronym allowlist: "${shoutingWord}"` };
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
    const text = `${slide.headline} ${slide.body}`;

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
