/**
 * A draft is written now and published later — that is the whole shape of
 * this product. Every channel agent drafts, a human reviews, and the post
 * goes out when the person gets to it: hours later, or on a Monday after a
 * Friday run, or after a revision round. A sentence anchored to the day it
 * was written is therefore a sentence that will be wrong when it is read.
 *
 * This is not hypothetical. Karos Labs' own LinkedIn draft on 17.9.2026 led
 * with "Profound closed a $180 million Series D **yesterday**". The round
 * closed on the 15th: wrong when it was written, and wronger every day it
 * sat in review. Nothing caught it, because every check that exists asks
 * whether a claim is SOURCED, and this one was — the source simply carried
 * a date the draft then restated in a form that decays.
 *
 * ## Why this list and not a bigger one
 *
 * The lesson from `circularEndingIssues` applies here word for word: a lint
 * that fires on good drafts is a lint somebody turns off. So this catches
 * only phrases that can mean nothing BUT a specific day relative to writing:
 *
 *   yesterday · tomorrow · this morning/afternoon/evening · tonight ·
 *   last night · earlier/later today · the day before yesterday
 *
 * Bare "today" is deliberately absent, and it is the interesting exclusion.
 * "The tools available today", "founders today", "today's buyers" are all
 * ordinary, correct English meaning *nowadays*, and they outnumber the
 * day-anchored use by a wide margin in real drafts. A rule that cannot tell
 * those apart would hold most good posts. "Earlier today" and "later today"
 * ARE unambiguous, so those are listed on their own.
 *
 * Same reasoning excludes "this week" and "last week": a post published
 * three days after drafting is usually still in the same week, and "last
 * week's funding" survives the delay that kills "yesterday's funding".
 *
 * ## What a writer should do instead
 *
 * Name the date ("on September 15"), or use a frame that does not move
 * ("this month", "since the Series C"). The problem string says so, so the
 * one model redraft has somewhere to go.
 *
 * ## Why this reports a problem rather than holding the run
 *
 * Since `feat/agents-always-deliver` a failed check is a reason to fix one
 * thing, not to withhold the post. `stripRelativeDays` is the deterministic
 * floor under the model's redraft, and it is a floor worth having precisely
 * because the mechanical answer here is SAFE: deleting "yesterday" from
 * "closed its Series D yesterday" leaves a sentence that is still true, just
 * less specific. A date cannot be repaired by machine — it can only be
 * removed — and removing it is the one edit that cannot introduce a new
 * falsehood.
 */

/**
 * The phrases, as regexes with word boundaries. Ordered longest-first so
 * "earlier today" is reported as itself rather than as two findings, and so
 * a caller quoting the match shows the reader the whole phrase.
 */
const RELATIVE_DAY_PATTERNS: readonly RegExp[] = [
  /\bthe day before yesterday\b/i,
  /\b(?:earlier|later) today\b/i,
  /\bthis (?:morning|afternoon|evening)\b/i,
  /\blast night\b/i,
  /\byesterday\b/i,
  /\btomorrow\b/i,
  /\btonight\b/i,
  // ── Hebrew ──
  //
  // A post written for an Israeli client decays at exactly the same rate as an
  // English one, and this list only knew English — so "אתמול" in a LinkedIn
  // post read as clean while "yesterday" was caught. Clients writing natively
  // in Hebrew are a third of the roster.
  //
  // `\b` is useless here: it is defined on ASCII word characters, so it
  // matches on either side of every Hebrew letter and would fire inside a
  // longer word. The guard is instead that no Hebrew letter may sit on either
  // side of the match.
  //
  // The optional `[ובלמשכ]` is the closed set of single-letter Hebrew
  // prefixes — "and", "in", "to", "from/since", "that", "as" — so "מאתמול"
  // ("since yesterday") and "ומחר" ("and tomorrow") are caught as the whole
  // word they are. Written as a fixed set rather than "any one letter"
  // precisely so a longer word that merely ends in one of these stems cannot
  // slip through the front.
  //
  // "שלשום" is the day before yesterday and is first for the same
  // longest-first reason as its English counterpart.
  /(?<![֐-׿])[ובלמשכ]?שלשום(?![֐-׿])/,
  /(?<![֐-׿])[ובלמשכ]?אתמול(?![֐-׿])/,
  /(?<![֐-׿])[ובלמשכ]?מחר(?![֐-׿])/,
  /(?<![֐-׿])[ובלמשכ]?הערב(?![֐-׿])/,
  /(?<![֐-׿])[ובלמשכ]?הבוקר(?![֐-׿])/,
  /(?<![֐-׿])[ובלמשכ]?אמש(?![֐-׿])/,
  // Bare "היום" ("today") is deliberately NOT here, for the same reason bare
  // "today" is not on the English list: it is overwhelmingly used as "the day"
  // in ordinary prose ("היום שבו…"), and a floor that deletes it would edit
  // sentences that never carried a date at all. "earlier/later today" has no
  // idiomatic one-word Hebrew equivalent, so there is nothing to add for it.
];

/**
 * Every relative-day phrase in `text`, lowercased and de-duplicated, in the
 * order the patterns are declared. Empty for a draft that carries none —
 * which is the normal case, and why this is cheap to run on every draft.
 *
 * Takes the WHOLE post: on X that means the main text plus every thread
 * part, because part 4 of a thread is published at the same moment as part 1
 * and decays identically.
 */
export function relativeDayIssues(text: string): string[] {
  const found: string[] = [];
  // Each match is blanked out of the working copy before the shorter
  // patterns run, so "the day before yesterday" is one finding rather than
  // that phrase plus a bare "yesterday" sitting inside it. Replaced with
  // spaces rather than removed so no two words are accidentally joined into
  // a third that a later pattern could then match.
  let remaining = text;
  for (const pattern of RELATIVE_DAY_PATTERNS) {
    const global = new RegExp(pattern.source, "gi");
    let match: RegExpExecArray | null;
    while ((match = global.exec(remaining)) !== null) {
      const phrase = match[0].toLowerCase();
      if (!found.includes(phrase)) found.push(phrase);
      remaining = remaining.slice(0, match.index) + " ".repeat(match[0].length) + remaining.slice(match.index + match[0].length);
    }
  }
  return found;
}

/**
 * One problem string per phrase found, shared so both channels tell the
 * redrafting model the same thing and a reviewer reads the same words in the
 * run report.
 *
 * ONE ENTRY PER PHRASE, never a lumped verdict: `runCheckWithRepair` keeps a
 * repair only when strictly fewer problems remain, so a draft carrying
 * "yesterday" and "tonight" that loses one of them must count as progress.
 *
 * Each string names the phrase AND what to write instead — told only "fix
 * the date", a redraft picks a different wrong date.
 */
export function relativeDayProblems(text: string, craftRule: string): string[] {
  return relativeDayIssues(text).map(
    (phrase) =>
      `the draft says "${phrase}", which anchors it to the day it was written — it is reviewed and published later, ` +
      `so this is wrong by the time anyone reads it (${craftRule}); name the date instead ("on September 15") ` +
      `or use a frame that does not move ("this month", "since the Series C")`,
  );
}

/**
 * The deterministic floor: delete the phrase.
 *
 * Not a rewrite — nothing here knows what date was meant, and inventing one
 * would be the very failure this rule exists to prevent. Deleting leaves a
 * true sentence: "closed its Series D yesterday" becomes "closed its Series
 * D". Less specific, never false.
 *
 * Tidies the seam it leaves: a double space closes up, and a space stranded
 * before punctuation goes, so the repair does not read as a repair. Returns
 * the text unchanged when it carries no phrase, so a caller can compare
 * identity to know whether anything happened.
 */
export function stripRelativeDays(text: string): string {
  let out = text;
  for (const pattern of RELATIVE_DAY_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, "gi"), "");
  }
  if (out === text) return text;
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
