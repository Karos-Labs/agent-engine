import type { DedupeHistoryEntry } from "@agent-engine/core";

/**
 * THE REPETITION THAT LEXICAL DE-DUPLICATION CANNOT SEE.
 *
 * `evaluateDedupe` measures trigram overlap, and by that measure this fleet
 * looks healthy — its scores sit comfortably below the threshold across every
 * channel. The audit of 2026-09-21 sampled the approved deliverables anyway
 * and found the formula a reader actually recognises:
 *
 *   - five of five TikTok posts for one client were a single paragraph, a
 *     single line, and EXACTLY four hashtags; three closed on a sentence that
 *     was identical word for word;
 *   - five of five LinkedIn posts carried the same two-to-three hashtags and
 *     the same call to action, verbatim;
 *   - three of five Instagram posts for another client opened on the word
 *     "Most" or "Founders".
 *
 * None of that moves a trigram score, because the WORDS differ every time. The
 * shape does not. A reader who sees four of these in a row has learned the
 * template, and once a template is visible the writing reads as generated
 * whatever the sentences say.
 *
 * ## What this measures, and why these five
 *
 * Each dimension below is one the audit actually caught repeating. They are
 * cheap, they are language-independent (a Hebrew post has paragraphs and
 * hashtags too), and every one of them is something a writer can vary on
 * purpose once told.
 *
 * ## What it does NOT do
 *
 * It does not hold, throw, or fail a run — the same policy `evaluateDedupe`
 * states for itself. Structure repeating is evidence, not a verdict: a
 * channel whose format genuinely is one paragraph and four hashtags is not
 * broken, and a fixed rule is not entitled to overrule the human gate. This
 * produces a steer for the next draft and a line for the reviewer.
 */

/** The shape of one post, reduced to the things that repeat. */
export interface StructuralSignature {
  /** Blank-line-separated blocks. A five-beat post and a one-block post read differently before a word is read. */
  paragraphs: number;
  /** Non-empty lines. Distinct from paragraphs: a list is one paragraph and many lines. */
  lines: number;
  /** `#tag` count. "Exactly four, every time" was the single most visible tell in the sample. */
  hashtags: number;
  /**
   * The first word, lowercased.
   *
   * ONE word, not two: the audit found three of five posts opening on "Most"
   * or "Founders", and the second word differed every time — a two-word key
   * would have matched none of them and reported the client clean.
   */
  opening: string;
  /** The last sentence, normalised. Three posts in one sample closed identically. */
  closing: string;
}

/** One dimension that the draft shares with most of its recent history. */
export interface StructuralEcho {
  dimension: keyof StructuralSignature;
  /** The value being repeated, as it appears in the draft. */
  value: string;
  /** How many of the compared posts share it, and out of how many. */
  matched: number;
  of: number;
}

/**
 * How much of the history has to share a value before it counts as a template
 * rather than a coincidence.
 *
 * Two thirds, and never on fewer than three prior posts. Two posts that happen
 * to open the same way are two posts; four out of six is a habit. Set this
 * lower and every second run reports an echo, which trains people to ignore
 * the field — the failure mode that matters more than missing one.
 */
const ECHO_SHARE = 2 / 3;
const MIN_HISTORY = 3;

/** How many recent posts are compared. The same bound `dedupeDirective` uses, for the same reason. */
const COMPARE_LIMIT = 8;

const SENTENCE_END = /[.!?…]+\s*$/;

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Reduces one post to the five things that repeat. Pure, and safe on empty text. */
export function structuralSignature(text: string): StructuralSignature {
  const trimmed = text.trim();
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const paragraphs = trimmed.length === 0 ? 0 : trimmed.split(/\r?\n\s*\r?\n/).filter((p) => p.trim().length > 0).length;
  // `#` followed by a letter, so a bare "#" or a markdown heading is not a
  // hashtag. Unicode-aware: a Hebrew hashtag counts.
  const hashtags = (trimmed.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;

  const words = normalise(trimmed).split(" ").filter(Boolean);
  const opening = words[0] ?? "";

  // The last sentence, taken from the last non-empty line so a trailing
  // hashtag block does not become "the closing line".
  const withoutTags = lines.filter((l) => !/^\s*(#[\p{L}\p{N}_]+\s*)+$/u.test(l));
  const lastLine = withoutTags.at(-1) ?? "";
  const sentences = lastLine.split(/(?<=[.!?…])\s+/).filter((s) => s.trim().length > 0);
  const closing = normalise(sentences.at(-1) ?? lastLine).replace(SENTENCE_END, "");

  return { paragraphs, lines: lines.length, hashtags, opening, closing };
}

/**
 * Which dimensions of the draft repeat what this client's recent posts already
 * did.
 *
 * Returns `[]` when there is too little history to judge, which is the common
 * case for a new client and must read as "nothing to say" rather than "all
 * clear".
 */
export function structuralEchoes(draft: string, history: readonly DedupeHistoryEntry[]): StructuralEcho[] {
  const recent = history.slice(-COMPARE_LIMIT);
  if (recent.length < MIN_HISTORY) return [];

  const draftSignature = structuralSignature(draft);
  const prior = recent.map((entry) => structuralSignature(entry.excerpt));
  const echoes: StructuralEcho[] = [];

  for (const dimension of ["paragraphs", "lines", "hashtags", "opening", "closing"] as const) {
    const value = draftSignature[dimension];
    // An empty opening or closing is an absence, not a repetition.
    if (typeof value === "string" && value.length === 0) continue;
    const matched = prior.filter((p) => p[dimension] === value).length;
    if (matched / prior.length >= ECHO_SHARE) {
      echoes.push({ dimension, value: String(value), matched, of: prior.length });
    }
  }
  return echoes;
}

/**
 * The dimensions on which this client's recent posts are ALREADY uniform,
 * before a word of the new one is written.
 *
 * This is the form that actually fires. `structuralEchoes` needs a draft to
 * compare, and the only place a draft gets compared today is the de-duplication
 * retry loop — which triggers on LEXICAL similarity, the very thing these posts
 * do not have. A steer wired only there would be unreachable for exactly the
 * clients that need it: five TikTok posts with different words and identical
 * shape never reach that branch.
 *
 * So the question is asked of the history alone, before drafting, and the
 * answer goes into the drafting prompt the same way `dedupeDirective`'s does.
 * A client with no template gets nothing and their prompt is unchanged.
 */
export function historyShapeEchoes(history: readonly DedupeHistoryEntry[]): StructuralEcho[] {
  const recent = history.slice(-COMPARE_LIMIT);
  if (recent.length < MIN_HISTORY) return [];

  const signatures = recent.map((entry) => structuralSignature(entry.excerpt));
  const echoes: StructuralEcho[] = [];

  for (const dimension of ["paragraphs", "lines", "hashtags", "opening", "closing"] as const) {
    // The most common value on this dimension, and how many share it.
    const counts = new Map<string, number>();
    for (const sig of signatures) {
      const key = String(sig[dimension]);
      if (key.length === 0) continue; // absence is not a template
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let best = "";
    let matched = 0;
    for (const [value, n] of counts) {
      if (n > matched) {
        best = value;
        matched = n;
      }
    }
    if (matched > 0 && matched / signatures.length >= ECHO_SHARE) {
      echoes.push({ dimension, value: best, matched, of: signatures.length });
    }
  }
  return echoes;
}

/** How each dimension reads to a writer who has to do something about it. */
const DIMENSION_STEER: Record<keyof StructuralSignature, (value: string) => string> = {
  paragraphs: (v) => `every recent post is ${v} paragraph(s) long — change the block structure`,
  lines: (v) => `every recent post runs to ${v} line(s) — change the line breaks`,
  hashtags: (v) => `every recent post carries exactly ${v} hashtag(s) — vary the count, or drop them`,
  opening: (v) => `recent posts open on the word "${v}" — open somewhere else entirely`,
  closing: (v) => `recent posts close on "${v}" — write a different last line`,
};

/**
 * The steer for the next draft. `undefined` when nothing repeats, so a caller
 * spreads it conditionally and an unaffected run's prompt stays byte-identical
 * — the contract `dedupeDirective` and `revisionDirective` both keep.
 */
export function structuralEchoDirective(echoes: readonly StructuralEcho[]): string | undefined {
  if (echoes.length === 0) return undefined;
  return [
    "This client's recent posts share a SHAPE, and a reader notices a shape before they read a word. Your draft repeats it:",
    ...echoes.map((e) => `- ${DIMENSION_STEER[e.dimension](e.value)} (${e.matched} of the last ${e.of})`),
    "Vary the structure, not just the words. Same facts, different form.",
  ].join("\n");
}

/** One line for the gate, so a reviewer sees the template too. `undefined` when there is nothing to say. */
export function structuralEchoLine(echoes: readonly StructuralEcho[]): string | undefined {
  if (echoes.length === 0) return undefined;
  return `repeats the recent shape: ${echoes.map((e) => `${e.dimension} (${e.matched}/${e.of})`).join(", ")}`;
}
