import { similarity } from "@agent-engine/core";
import type { ResearchFact, ResearchFactKind } from "./types.js";

/**
 * Fact cards — the deduped, ordered evidence set the angle step, the copy
 * prompt and step 07's source check all read (RFC-13 §J, Phase 1).
 *
 * ## The defect this closes
 *
 * Deep research (`04a2-research-pull-deep`) asks eight queries across three
 * lanes and merges 14-20 documents. Those documents overlap heavily by
 * design: a study, the press release about the study, and three articles
 * restating the press release all carry the same figure. The extraction step
 * reads them all and returns a card per mention, so a carousel drafted from
 * that set gets the SAME number offered to it four times — and the audit's
 * prep runs show what a writer does with four copies of one fact: it puts the
 * figure on two slides and attributes it to the weakest of the four sources.
 *
 * ## The three rules, and why the third one exists
 *
 * `dedupeFactCards` treats two cards as the same claim when
 *
 * 1. their normalised text is identical, or
 * 2. their trigram overlap is >= `DUPLICATE_CLAIM_SIMILARITY` (0.8) — the
 *    lightly-reworded restatement, and
 * 3. they carry the SAME figures and share at least
 *    `DUPLICATE_TERM_OVERLAP` of their content words.
 *
 * Rule 3 is the one that does the work here, and it is not redundant with
 * rule 2: trigram overlap is deliberately unforgiving (`similarity`'s own
 * calibration puts "the same brief written afresh" under 0.2), so a genuine
 * paraphrase of one statistic — "42% of teams saved four hours a week" versus
 * "teams that automated reporting cut four hours a week, 42% of them" —
 * scores well below 0.8 while being unambiguously one claim. What makes those
 * two the same is the figure: a percentage or a money amount is the identity
 * of a statistical claim, and two cards that quote the same figure about the
 * same subject are one card. The content-word requirement is what stops that
 * from over-firing on two unrelated claims that happen to share "42%".
 *
 * Everything here is pure. No tool, no store, no model.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation
// ─────────────────────────────────────────────────────────────────────────────

/** The cap on what ships. 24 cards is already more than a 6-8 slide carousel can carry; past that a longer list only dilutes the prompt. */
export const FACT_CARD_CAP = 24;

/** How much trigram overlap makes two claims the same sentence. Matches `DEDUPE_SIMILARITY_THRESHOLD`'s posture, set higher because this compares single sentences rather than whole posts. */
export const DUPLICATE_CLAIM_SIMILARITY = 0.8;

/**
 * How much of the SHORTER claim's vocabulary two same-figure claims must
 * share before they are one claim.
 *
 * Containment (shared / smaller set) rather than Jaccard, and the asymmetry is
 * the point: coverage of a study is reliably wordier than the study's own
 * sentence ("...gave teams back four hours, according to a new benchmark,
 * with 42% of them reporting the gain" against "42% of teams that automated
 * weekly reporting saved four hours a week"). Jaccard punishes the extra
 * words and scores that pair 0.40; containment reads it as what it is — the
 * shorter claim's subject, restated with more words around it — and scores
 * 0.67.
 */
export const DUPLICATE_TERM_CONTAINMENT = 0.6;

/**
 * Words that carry no subject. Short and English/Hebrew only on purpose: this
 * list exists to stop "of the" from counting as shared subject matter in rule
 * 3, not to stem a language.
 */
const STOPWORDS = new Set<string>([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for", "from", "had", "has", "have", "in", "into", "is", "it", "its",
  "of", "on", "or", "per", "said", "says", "than", "that", "the", "their", "them", "then", "they", "this", "to", "was", "were", "which",
  "while", "who", "will", "with", "after", "before", "about", "more", "most", "over", "under", "up", "out", "new",
  "של", "את", "עם", "על", "אל", "כי", "זה", "הוא", "היא", "הם", "אבל", "או", "גם", "כל", "לא", "יש", "אין", "מה",
]);

/**
 * Currency symbols folded to their letter code, and `%` to `pct`, BEFORE the
 * strip to letters/digits/space — otherwise "$5" and "5%" both normalise to
 * "5" and two different claims compare equal. The code goes AFTER the digits
 * ("5 usd") so the figure extractor below reads left to right the way the
 * magnitude suffixes already do.
 */
const CURRENCY_CODES: ReadonlyArray<[symbol: RegExp, code: string]> = [
  [/\$\s?(\d[\d.]*[kmbt]?)/gu, "$1 usd"],
  [/€\s?(\d[\d.]*[kmbt]?)/gu, "$1 eur"],
  [/£\s?(\d[\d.]*[kmbt]?)/gu, "$1 gbp"],
  [/₪\s?(\d[\d.]*[kmbt]?)/gu, "$1 ils"],
];

/**
 * Case, punctuation and figure spelling folded so that two writings of one
 * claim compare equal.
 *
 * The number folding mirrors `karos-gates`' own `numbersSourced` normaliser
 * (its rules are empirical — "$1 billion", "$1 bn" and "$1B" all have to
 * compare equal), reimplemented rather than imported because that one is
 * private to the gate tool and folds whitespace away entirely, which would
 * destroy the word boundaries the trigram and content-word rules need.
 *
 * Order matters, and every step below is where it is because the next one
 * would break it: currency WORDS become symbols while the following digit is
 * still adjacent, thousands separators go while the digits are still adjacent
 * ("1,200" and "1200" are one figure), magnitude words fold while their `\b`
 * still means something AND while the digit is still next to them (so
 * "$1 billion" is "$1b" before the symbol moves), currency symbols then move
 * behind their figure as letter codes, and only after all of that is
 * everything that is not a letter, a digit or a space removed.
 */
export function normalizeClaim(text: string): string {
  let out = text.toLowerCase().replace(/×/gu, "x");
  out = out
    .replace(/\busd\s?(?=\d)/gu, "$")
    .replace(/\beur\s?(?=\d)/gu, "€")
    .replace(/\bgbp\s?(?=\d)/gu, "£")
    .replace(/(\d),(?=\d{3}(?!\d))/gu, "$1")
    .replace(/(\d)\s?(?:trillion|tn)\b/gu, "$1t")
    .replace(/(\d)\s?(?:billion|bn)\b/gu, "$1b")
    .replace(/(\d)\s?(?:million|mn)\b/gu, "$1m")
    .replace(/(\d)\s?thousand\b/gu, "$1k")
    .replace(/(\d)\s?%/gu, "$1 pct");
  for (const [pattern, code] of CURRENCY_CODES) out = out.replace(pattern, code);
  out = out.replace(/[‐-―]/gu, "-");
  return (
    out
      // Everything that is not a letter, a digit, a space or a dot goes. The
      // dot survives this pass and is dropped in the next one UNLESS it sits
      // between two digits — otherwise "4.2x" normalises to "4 2x" and reads
      // as two figures instead of one.
      .replace(/[^\p{L}\p{N}\s.]/gu, " ")
      .replace(/(?<!\d)\.|\.(?!\d)/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

/**
 * The figures a normalised claim asserts: a number plus whatever unit was
 * folded onto it ("42 pct", "5 busd", "4 x", or a bare "1200").
 *
 * Years are excluded. "2026" in "2026 was the year agencies stopped
 * discounting" is a date, not the claim's figure, and treating it as one made
 * every card about the same year look like the same statistic.
 */
export function claimFigures(normalized: string): string[] {
  const figures = new Set<string>();
  const pattern = /(\d[\d.]*)\s?(pct|usd|eur|gbp|ils|[kmbt]|x)?\b/gu;
  for (const match of normalized.matchAll(pattern)) {
    const digits = match[1]!;
    const unit = match[2] ?? "";
    if (unit === "" && /^(?:19|20)\d{2}$/u.test(digits)) continue;
    figures.add(`${digits}${unit}`);
  }
  return [...figures].sort();
}

/** Content words — what rule 3 measures "same subject" with. */
function contentTerms(normalized: string): Set<string> {
  const terms = new Set<string>();
  for (const word of normalized.split(" ")) {
    if (word.length < 3 || STOPWORDS.has(word) || /^\d/u.test(word)) continue;
    terms.add(word);
  }
  return terms;
}

/** Shared terms as a fraction of the SMALLER set — see `DUPLICATE_TERM_CONTAINMENT`. */
function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  return shared / Math.min(a.size, b.size);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dedupe
// ─────────────────────────────────────────────────────────────────────────────

/** One card, pre-normalised once so an O(n²) comparison over 30 cards stays a handful of string ops. */
interface ScoredCard {
  fact: ResearchFact;
  normalized: string;
  figures: string;
  terms: Set<string>;
  /** Position in the extraction output. The tie-break of last resort: the model listed its strongest card first. */
  index: number;
}

export interface DroppedFactCard {
  /** The claim that was dropped, verbatim. */
  claim: string;
  /** The claim that was kept instead, verbatim — so a reviewer can check the judgment rather than trust it. */
  duplicateOf: string;
  /** Which rule fired. */
  rule: "identical" | "reworded" | "same-figure";
}

export interface DedupeFactCardsResult {
  /** What ships, in extraction order, capped at `FACT_CARD_CAP`. */
  facts: ResearchFact[];
  dropped: DroppedFactCard[];
  /** How many distinct cards the cap itself removed (never a duplicate — those are in `dropped`). */
  truncated: number;
}

function score(fact: ResearchFact, index: number): ScoredCard {
  const normalized = normalizeClaim(fact.claim);
  return { fact, normalized, figures: claimFigures(normalized).join("|"), terms: contentTerms(normalized), index };
}

/** Which rule (if any) makes these two cards the same claim. */
function duplicateRule(a: ScoredCard, b: ScoredCard): DroppedFactCard["rule"] | undefined {
  if (a.normalized === b.normalized) return "identical";

  // TWO DIFFERENT FIGURES ARE TWO DIFFERENT CLAIMS, whatever the sentences
  // around them look like. "42% of teams automated reporting in 2026" and
  // "51% of teams automated reporting in 2026" share every word but the one
  // that matters, and a purely lexical rule would eventually merge them —
  // silently deleting the comparison a carousel was going to be built on.
  const figuresDisagree = a.figures.length > 0 && b.figures.length > 0 && a.figures !== b.figures;
  if (figuresDisagree) return undefined;

  if (similarity(a.normalized, b.normalized) >= DUPLICATE_CLAIM_SIMILARITY) return "reworded";
  if (a.figures.length > 0 && a.figures === b.figures && containment(a.terms, b.terms) >= DUPLICATE_TERM_CONTAINMENT) return "same-figure";
  return undefined;
}

/**
 * Of two cards making the same claim, the one worth keeping: the primary
 * source, then the one that can be traced (has a `url`), then the earlier —
 * which is the extraction step's own ranking, and the only signal left.
 *
 * `true` when `challenger` should replace `held`.
 */
function beats(challenger: ScoredCard, held: ScoredCard): boolean {
  const primary = (c: ScoredCard): number => (c.fact.primary === true ? 1 : 0);
  if (primary(challenger) !== primary(held)) return primary(challenger) > primary(held);
  const traceable = (c: ScoredCard): number => (typeof c.fact.url === "string" && c.fact.url.length > 0 ? 1 : 0);
  if (traceable(challenger) !== traceable(held)) return traceable(challenger) > traceable(held);
  return challenger.index < held.index;
}

/**
 * One card per claim, capped at `FACT_CARD_CAP`, with every drop recorded.
 *
 * Order is the extraction step's own: a card that survives keeps its original
 * position (a replacement takes the position of the card it replaced), so the
 * model's ranking is not silently re-sorted here. `factCardsForPrompt` is
 * where primaries move to the front, for the one consumer that wants them
 * there.
 */
export function dedupeFactCards(facts: readonly ResearchFact[]): DedupeFactCardsResult {
  const kept: ScoredCard[] = [];
  const dropped: DroppedFactCard[] = [];

  for (const [index, fact] of facts.entries()) {
    const candidate = score(fact, index);
    let duplicateAt = -1;
    let rule: DroppedFactCard["rule"] | undefined;
    for (let i = 0; i < kept.length; i++) {
      const found = duplicateRule(candidate, kept[i]!);
      if (found !== undefined) {
        duplicateAt = i;
        rule = found;
        break;
      }
    }

    if (duplicateAt === -1) {
      kept.push(candidate);
      continue;
    }

    const held = kept[duplicateAt]!;
    if (beats(candidate, held)) {
      // The stronger card takes the weaker one's SLOT, so a primary source
      // arriving late does not also jump the running order.
      kept[duplicateAt] = candidate;
      dropped.push({ claim: held.fact.claim, duplicateOf: candidate.fact.claim, rule: rule! });
    } else {
      dropped.push({ claim: candidate.fact.claim, duplicateOf: held.fact.claim, rule: rule! });
    }
  }

  return {
    facts: kept.slice(0, FACT_CARD_CAP).map((c) => c.fact),
    dropped,
    truncated: Math.max(0, kept.length - FACT_CARD_CAP),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The prompt-facing view
// ─────────────────────────────────────────────────────────────────────────────

/** How many cards a drafting or angle prompt sees. More than this and the model starts writing a summary of the research instead of a post. */
export const FACT_CARDS_FOR_PROMPT = 14;

/**
 * One card as a prompt sees it. An object rather than a prose block (which is
 * what `briefForPrompt` returns) because the copy agent has always received
 * `facts` as a JSON array and step 07 matches `sourceRef` against `claim`
 * verbatim — rendering these as prose would put a formatting layer between
 * the claim the model copies and the claim the gate checks.
 */
export interface FactCardForPrompt {
  claim: string;
  kind: ResearchFactKind;
  source: string;
  date: string;
  url?: string;
  quote?: string;
  primary?: true;
}

/**
 * The top `max` cards, primary sources first, otherwise in extraction order.
 *
 * Primary-first because that ordering is itself an instruction: the model
 * reaches for what it reads first, and what it should reach for is the study
 * rather than the blog post about the study.
 */
export function factCardsForPrompt(facts: readonly ResearchFact[], max = FACT_CARDS_FOR_PROMPT): FactCardForPrompt[] {
  const ordered = [...facts.entries()].sort((a, b) => {
    const primary = (entry: [number, ResearchFact]): number => (entry[1].primary === true ? 0 : 1);
    return primary(a) - primary(b) || a[0] - b[0];
  });
  return ordered.slice(0, max).map(([, fact]) => ({
    claim: fact.claim,
    kind: fact.kind ?? "stat",
    source: fact.source,
    date: fact.date,
    ...(fact.url ? { url: fact.url } : {}),
    ...(fact.quote ? { quote: fact.quote } : {}),
    ...(fact.primary === true ? { primary: true as const } : {}),
  }));
}
