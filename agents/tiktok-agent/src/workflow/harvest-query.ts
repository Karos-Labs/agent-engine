import type { TopicCandidate } from "./types.js";

/**
 * What to type into a podcast search.
 *
 * ## The gap this fills
 *
 * The harvest tier has always been handed `query: claim.topic` — the catalog
 * row and nothing else. Under the ALLOWLIST posture that was fine: the search
 * was `ytsearchN:<show name> <topic>`, so the show did the narrowing and the
 * topic only had to pick an episode out of one feed.
 *
 * Open discovery (RFC-25) removes the show, and a catalog row on its own is a
 * poor search of the whole of YouTube. "AI marketing budgets" returns clip
 * farms, re-uploads, conference B-roll and a decade of unrelated uploads. The
 * topic row is written to be a good SUBJECT for a short, not a good QUERY for
 * a video search — they are different jobs and nothing was doing the second.
 *
 * ## Deterministic, and a separate step on purpose
 *
 * No model. The inputs are all strings the run already holds, the output is a
 * search string, and both are checkpointed — so when a prep run comes back
 * with a bad clip, the query that found it is readable in the trace rather
 * than reconstructed from the topic and a guess about what was appended.
 *
 * It is also the lever. RFC-25 §3 says search quality is the real risk here
 * and that only real runs will tell us whether this is good enough; a pure
 * function with its own tests is the cheapest thing to change when they do.
 */

/**
 * Words that make a topic row read as an editorial angle rather than as
 * something a person said out loud on a podcast.
 *
 * A catalog row is written for a human planning content — "why X is
 * reshaping Y", "the hidden cost of Z" — and those framing words are exactly
 * the ones absent from the title of a real episode. Stripping them leaves the
 * nouns a podcast would actually put in its title.
 */
const ANGLE_WORDS = new Set([
  "why", "how", "what", "when", "the", "a", "an", "of", "in", "on", "for", "to", "and", "or", "is", "are",
  "new", "hidden", "real", "truth", "about", "behind", "rise", "fall", "future", "death", "end", "era",
  "reshaping", "changing", "transforming", "disrupting", "rethinking", "reimagining", "unpacking",
  "guide", "playbook", "lessons", "takeaways", "everything", "need", "know", "should", "must",
]);

/** A word worth searching for: long enough to carry meaning, not a framing word. */
function contentWords(text: string, limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || ANGLE_WORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

export interface HarvestQueryInput {
  /** The run's claimed topic — a catalog row, a typed request, or a discovered candidate's subject. */
  topic: string;
  /** The client's declared industry, when their profile states one. */
  industry?: string | undefined;
  /** The scout's grounded candidate, when this topic came from discovery: its angle is closer to how a person would say it. */
  discovered?: TopicCandidate | undefined;
}

/**
 * How many words of the topic survive into the query.
 *
 * Long queries do not narrow a video search, they starve it: every extra term
 * is another thing a title has to contain, and podcast titles are short.
 * Four subject words plus the format anchor is about the shape of a real
 * episode title.
 */
export const MAX_TOPIC_WORDS = 4;
/** And from the angle, which is a sentence rather than a title — two words, to colour the subject rather than replace it. */
export const MAX_ANGLE_WORDS = 2;

/**
 * The format anchor.
 *
 * Without it, an open search on a business subject returns news segments,
 * ads, webinar recordings and lecture captures — none of which is a
 * conversation, and the commentary format needs someone SAYING something.
 * `podcast` is the one word that reliably selects for that on YouTube, and it
 * is appended rather than woven in so the test can prove it is always there.
 */
export const FORMAT_ANCHOR = "podcast";

/**
 * Builds the open-discovery search string.
 *
 * Deliberately NOT the client's name or handle: the client is not in the
 * footage and searching for them returns their own channel, which is the one
 * place this tier must not go (their own footage is Tier 2a, and clipping
 * yourself as if it were commentary is a different product).
 */
export function buildHarvestQuery(input: HarvestQueryInput): string {
  const subject = contentWords(input.topic, MAX_TOPIC_WORDS);
  // The angle only contributes what the subject did not already say.
  const angle = input.discovered?.angle !== undefined ? contentWords(input.discovered.angle, MAX_ANGLE_WORDS + subject.length).filter((w) => !subject.includes(w)) : [];
  // The industry is the widest term here, so it goes last and only when the
  // subject is thin enough to need it: on a specific topic it would pull the
  // search back towards generic industry commentary.
  const industry = subject.length < MAX_TOPIC_WORDS && input.industry !== undefined ? contentWords(input.industry, 2).filter((w) => !subject.includes(w)) : [];

  const terms = [...subject, ...angle.slice(0, MAX_ANGLE_WORDS), ...industry];
  // Nothing usable in any of them — a topic of pure framing words. The anchor
  // alone is a bad search, so the raw topic is better than nothing.
  if (terms.length === 0) return `${input.topic.trim()} ${FORMAT_ANCHOR}`.trim();
  return `${terms.join(" ")} ${FORMAT_ANCHOR}`;
}
