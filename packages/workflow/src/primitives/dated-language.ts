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
 * ("this month", "since the Series C"). The held message says so, so the
 * revision has somewhere to go.
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
 * The held message, shared so both channels say the same thing to the model
 * on revision and to the reviewer in the run report. Names the phrases it
 * found and what to write instead — a revision prompt that only said "fix
 * the date" would get a different wrong date.
 */
export function relativeDayHeldReason(issues: readonly string[], craftRule: string): string {
  const quoted = issues.map((issue) => `"${issue}"`).join(", ");
  return (
    `the draft anchors itself to the day it was written (${quoted}) — a draft is reviewed and published later, ` +
    `so this is wrong by the time anyone reads it (${craftRule}); name the date instead ("on September 15") ` +
    `or use a frame that does not move ("this month", "since the Series C")`
  );
}
