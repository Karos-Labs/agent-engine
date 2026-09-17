/**
 * The caption's own craft rules — the ones about SHAPE, which code can hold,
 * as distinct from the ones about voice, which live in the copy prompt.
 *
 * ## What the owner's reference accounts actually do
 *
 * Short declarative lines, one idea per line, second person, an occasional
 * arrow list, at most two emoji, then the call to action. What this agent has
 * been writing instead is a dense analytical paragraph that cites report
 * names — correct, sourced, and nothing like a caption someone reads on a
 * phone.
 *
 * ## What is here and what deliberately is not
 *
 * Three things are measurable and are measured: how many emoji a caption
 * carries, whether its lines are lines or paragraphs, and whether the whole
 * thing is a bullet list that re-reads the slides. Everything else about
 * register — whether a sentence sounds like a person, whether the second
 * person is used well — is a judgement, and a regular expression pretending
 * to make it would refuse good captions and pass bad ones with equal
 * confidence. Those stay in the prompt.
 *
 * The arrow list is NOT banned, and that is a deliberate reading of the
 * evidence rather than of the specification. The owner's own reference posts
 * use arrow bullets. What reads as machine-made is a caption that is ONLY a
 * list — the slides again, in text — and that is what `checkCaptionRegister`
 * refuses.
 */

/**
 * At most two, per the specification. Counted as grapheme-ish units — a ZWJ
 * family or a flag is one emoji to a reader, and counting its code points
 * would refuse a caption carrying one.
 */
export const CAPTION_MAX_EMOJI = 2;

/**
 * Where a line stops being a line.
 *
 * Counted in WORDS rather than characters because this agent writes in
 * English and in Hebrew, and a character bound calibrated on one is wrong on
 * the other — Hebrew says the same thing in visibly fewer characters. Thirty
 * is deliberately generous: the reference captions run six to fourteen words
 * a line, and the thing being refused is the forty-word analytical sentence,
 * not a line that ran slightly long.
 */
export const CAPTION_MAX_WORDS_PER_LINE = 30;

const EMOJI = /\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*/gu;

/** Bullet-ish line openers, including the arrow the reference accounts use. */
const BULLET_OPENER = /^\s*(?:[-*•▪◦→⇒»>]|\d+[.)])\s+/u;

export interface CraftFinding {
  ok: boolean;
  /** Written for the redraft prompt: what is wrong and what to do, never a code. */
  reason?: string;
}

const CLEAN: CraftFinding = { ok: true };

/** Non-empty lines, trimmed. The unit every rule below counts in. */
function linesOf(caption: string): string[] {
  return caption
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * The hook: the caption's first non-empty line.
 *
 * On Instagram the hook is not a separate field — the caption's opening IS
 * the hook, because that is what the feed shows before "more". Deriving it
 * here is therefore reading the real thing, not inferring it: there is no
 * separate field for a draft to satisfy while the shipped text says
 * something else.
 */
export function hookOf(caption: string): string {
  return linesOf(caption)[0] ?? "";
}

/** How many emoji a string carries, counting a ZWJ sequence as one. */
export function countEmoji(text: string): number {
  const found = text.match(EMOJI);
  EMOJI.lastIndex = 0;
  return found?.length ?? 0;
}

/**
 * The three shape rules.
 *
 * Returns the FIRST failure rather than all of them, matching how every other
 * craft check in this agent reports: a redraft that is handed three
 * complaints at once tends to fix the one it understands.
 */
export function checkCaptionRegister(caption: string): CraftFinding {
  const lines = linesOf(caption);
  if (lines.length === 0) return { ok: false, reason: "the caption is empty" };

  const emoji = countEmoji(caption);
  if (emoji > CAPTION_MAX_EMOJI) {
    return {
      ok: false,
      reason: `the caption carries ${emoji} emoji and the limit is ${CAPTION_MAX_EMOJI} — an emoji should mark one thing, not punctuate every line`,
    };
  }

  const longest = lines.reduce<{ words: number; line: string }>(
    (worst, line) => {
      const words = line.split(/\s+/).filter(Boolean).length;
      return words > worst.words ? { words, line } : worst;
    },
    { words: 0, line: "" },
  );
  if (longest.words > CAPTION_MAX_WORDS_PER_LINE) {
    return {
      ok: false,
      reason:
        `one caption line runs to ${longest.words} words ("${longest.line.slice(0, 60)}…") — ` +
        `break it into short declarative lines of one idea each; the limit is ${CAPTION_MAX_WORDS_PER_LINE} words a line`,
    };
  }

  // A caption that is ONLY a list is the slides again, in text. One or two
  // arrow bullets among prose is how the reference accounts write, so the
  // rule is about the whole shape, not about the bullet.
  const bulleted = lines.filter((l) => BULLET_OPENER.test(l)).length;
  if (lines.length >= 3 && bulleted === lines.length) {
    return {
      ok: false,
      reason:
        `every one of the caption's ${lines.length} lines is a bullet — the caption is re-reading the slides; ` +
        "it should say something the carousel does not, then ask for the action",
    };
  }

  return CLEAN;
}

// ─────────────────────────────────────────────────────────────────────────
// The topic phrase, where a reader and an index both look for it
// ─────────────────────────────────────────────────────────────────────────

/**
 * Words too common to prove anything by appearing.
 *
 * English only, and short on purpose. This list exists so that a two-word
 * topic like "the playbook" is not judged on "the"; it is not an attempt at
 * real stop-word handling. A Hebrew topic keeps every word this list does not
 * name, minus the ones under three characters — which removes the particles
 * (של, את, עם) for the same reason the English list removes "of".
 */
const WEAK_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "with", "your", "you", "our", "is", "are", "how", "why", "what",
]);

/** The words of a topic phrase that carry its meaning. */
export function significantWords(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !WEAK_WORDS.has(w));
}

/**
 * Whether `text` is about the topic at all: does it carry ANY of the topic's
 * significant words.
 *
 * ## Why the bar is this low, arrived at by failing twice
 *
 * The first rule here wanted a MAJORITY of the phrase's words. Its own test
 * falsified it: the topic "cutting onboarding time" against a cover reading
 * "We cut onboarding from 14 days to 3" scores one in three and is refused,
 * while any reader can see the slide is about exactly that. "cutting" versus
 * "cut", and a unit word a good headline replaces with a number — both are
 * what correct editing DOES.
 *
 * The second rule wanted the phrase's most DISTINCTIVE word, taken as its
 * longest. A fixture in this repo falsified that one too: for "automated
 * weekly reporting is replacing the Monday status meeting" the longest word
 * is "automated", and a perfectly good cover reading "Stop hand-building the
 * weekly report" does not contain it. Length is not subjecthood.
 *
 * So: any significant word. That is a weak claim and it is deliberately the
 * claim being made. What this check can honestly prove is that a caption, a
 * cover or an alt text is not about a COMPLETELY different subject — which
 * is the defect actually seen in prep, where slides carried a series name and
 * alt text restated the furniture. It cannot prove emphasis, and a rule that
 * pretended to would refuse correct posts over morphology.
 *
 * The asymmetry is the same one this workflow already applies to a closing
 * call to action: code can prove a thing is present and cannot prove it is
 * absent, so the bar sits where a false refusal is impossible rather than
 * where a false pass is.
 *
 * Substring matching rather than word matching is deliberate: it is what
 * makes this usable in Hebrew, where the same noun appears with prefixed
 * particles (ב, ל, ה) that a word-boundary match would miss entirely.
 */
export function namesTopic(text: string, phrase: string): boolean {
  const words = significantWords(phrase);
  if (words.length === 0) return true; // nothing to look for; not the text's fault
  const haystack = text.toLowerCase();
  return words.some((w) => haystack.includes(w));
}

// ─────────────────────────────────────────────────────────────────────────
// Competitors, named in a client's own post (item C5)
// ─────────────────────────────────────────────────────────────────────────

/**
 * A competitor's name is too short to be distinctive below this.
 *
 * Three characters or fewer catches acronyms that are also ordinary words in
 * one language or another, and the cost of that is a client's post sent back
 * over the word "אור" or "AWS" appearing in a sentence about something else.
 * Four is not a principled boundary, it is the shortest one that stops the
 * obvious false positives, and it is stated here rather than buried.
 */
const MIN_COMPETITOR_NAME_CHARS = 4;

/**
 * Competitor names that are ordinary words, which this check will not act on.
 *
 * A client whose competitor is called "Apple" or "Meta" or "Square" is a real
 * case, and refusing every post that uses the word is worse than missing the
 * one that meant the company. Those names are left to the copy prompt, which
 * has the context to tell a fruit from a firm.
 */
const COMPETITOR_NAMES_TOO_COMMON = new Set(["apple", "meta", "square", "block", "stripe", "slack", "notion", "figma", "monday", "amazon", "oracle"]);

/**
 * Whether this post names one of the client's competitors.
 *
 * ## Why this refuses rather than notes
 *
 * Unlike the topic-placement check above, this one can be RIGHT: a company
 * name either appears or it does not, and there is no morphology to lose it
 * in. The asymmetry runs the other way too — a false positive costs one
 * redraft, and a false negative ships a competitor's name in a client's own
 * post, which is the kind of thing a client notices before their agency does.
 *
 * Matched as a whole word, case-insensitively, in the copy AND the caption
 * AND the alt text AND the hashtags, because a tag is as public as a
 * headline.
 */
export function checkNoCompetitorNames(
  competitorNames: readonly string[],
  post: { readonly texts: readonly string[] },
): CraftFinding {
  const checkable = competitorNames
    .map((n) => n.trim())
    .filter((n) => n.length >= MIN_COMPETITOR_NAME_CHARS && !COMPETITOR_NAMES_TOO_COMMON.has(n.toLowerCase()));
  if (checkable.length === 0) return CLEAN;

  const haystack = post.texts.join(" \n ").toLowerCase();
  for (const name of checkable) {
    const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // `\b` does not do what it looks like it does outside Latin, so the
    // boundary is stated as "not a letter or a digit" on both sides.
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "u").test(haystack)) {
      return {
        ok: false,
        reason:
          `the post names "${name}", which is one of this client's tracked competitors — ` +
          "make the point without the name, or make it about the category",
      };
    }
  }
  return CLEAN;
}

export interface TopicPlacementInput {
  /** The chosen topic, as the topic step decided it. */
  phrase: string;
  /** Slide 1's text — headline and body together. */
  coverText: string;
  /** The whole caption; only its FIRST line is checked, which is what the feed shows. */
  caption: string;
}

/**
 * Item B8: the topic phrase belongs in slide 1 and in the caption's first
 * line.
 *
 * Instagram has been indexed by Google since July 2025 and the platform's own
 * search reads captions, so this is not a style preference — it is the
 * difference between a post that can be found and one that cannot.
 *
 * **The caller REPORTS this; it does not refuse on it.** `namesTopic`'s own
 * comment records the two heuristics that were falsified before the current
 * one, and why a phrase match cannot be trusted to prove absence. The alt
 * text, which the specification names alongside these two, is not checked at
 * all: it is written by the packager several steps later, from a slide whose
 * words the copy step already chose, so the same divergence applies with no
 * step able to act on it.
 *
 * Reported as ONE finding naming every place the phrase is missing, unlike
 * `checkCaptionRegister` above, because these are the same instruction
 * applied twice and a writer fixing one will fix both.
 */
export function checkTopicPlacement(input: TopicPlacementInput): CraftFinding {
  if (input.phrase.trim().length === 0) return CLEAN;

  const missing: string[] = [];
  if (!namesTopic(input.coverText, input.phrase)) missing.push("slide 1");
  if (!namesTopic(hookOf(input.caption), input.phrase)) missing.push("the caption's first line");

  if (missing.length === 0) return CLEAN;
  return {
    ok: false,
    reason:
      `the topic phrase "${input.phrase}" is not carried by ${missing.join(" or ")} — ` +
      "Instagram's search and Google both read those two, so naming the subject there is what makes the post findable",
  };
}
