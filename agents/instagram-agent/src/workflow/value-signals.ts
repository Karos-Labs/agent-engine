import type { ClientBrief } from "@agent-engine/tools";
import type { FactCardForPrompt } from "./fact-cards.js";
import { resolveExpectedScript } from "./language-gate.js";
import { sniffDominantScript } from "./target-language.js";
import type { InstagramCopyOutput, SlidesDataSelfCheck } from "./types.js";

/**
 * Instagram Phase 5 (RFC-18 §4.1) — `07i-value-signals`, the FREE half of the
 * value gate.
 *
 * ## What this is for
 *
 * The 2026-09-08 audit's charge was that no step asks "will anyone save
 * this?". RFC-18 answers it with a judge (`value-gate.ts`), and a judge is
 * $0.003 an attempt. Everything a machine can decide is decided here first,
 * for nothing, and the judge adjudicates only what a regex cannot: RFC-18
 * §2's ordering doctrine, which is the workflow's own — *cheapest rejection
 * first, every free rejection before any paid one*.
 *
 * Five checks, each returning the house `SlidesDataSelfCheck` shape so a
 * failure routes into step 07's existing redraft loop exactly like a
 * `checkSlidesData` or a `checkCraftHygiene` failure:
 *
 * 1. `sourceProse`  — the ban on reproducing the source's prose (prompt §27).
 * 2. `namedSpecifics` — category nouns are not specifics (prompt §24).
 * 3. `coverTension` — the hedged cover, the single most common AI tell (§25).
 * 4. `payloadShape` — the declared `payloadKind` against the actual structure.
 * 5. `rhythm` — the two MECHANICAL halves of prompt §26.
 *
 * ## Why a local module and not a `gate.valueFloor` tool in `karos-gates`
 *
 * `craft-hygiene.ts` is the precedent: local logic, calling a shared gate when
 * it needs one. Registering a tool would mean a shared-package edit and a
 * `TOOL_VERSION` story during a parallel-package cycle, plus a `KNOWN_GATES`
 * entry `check-prompts.ts` cross-checks against `createKarosGatesTools()` —
 * for a checker with exactly ONE caller that reads instagram-specific types
 * (`FactCardForPrompt`, `ClientBrief`, `InstagramCopyOutput`). Nothing is
 * gained. **No `TOOL_VERSION` is bumped anywhere in this PR.**
 *
 * ## Never a hold
 *
 * Every refusal here names a slide and a remedy, and the caller returns the
 * draft to step 05 — except on the final attempt, where RFC-18 §5.7's
 * `isFinalAttempt` guard ships the draft marked `below-bar` rather than
 * `continue`-ing into `WorkflowHeld`. Nothing in this module throws.
 */

// ─────────────────────────────────────────────────────────────────────────
// Tokenising, shared by every check
// ─────────────────────────────────────────────────────────────────────────

/**
 * Hebrew and Arabic diacritics, stripped before any comparison.
 *
 * Only these two ranges, deliberately. Nikud is decoration a writer may add or
 * drop without changing a word, so leaving it in would let a lifted sentence
 * escape the 8-gram rule by pointing one word. Stripping ALL `\p{Mn}` would be
 * wrong in the other direction: in Devanagari and Thai the combining marks are
 * vowels, and folding them away would make unrelated words collide and turn
 * this check into a source of false refusals — and a false refusal here costs
 * a whole drafting attempt.
 */
const RTL_DIACRITICS = /[֑-ׇً-ْٰ]/gu;

/** Punctuation and symbols at a token's edges. Stripped so `coil.` and `coil` are the same token to the n-gram rule. */
const EDGE_PUNCTUATION = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;

/** Whitespace tokens, case-folded, edge-punctuation and RTL diacritics removed. Empty tokens dropped. */
export function valueTokens(text: string): string[] {
  return text
    .replace(RTL_DIACRITICS, "")
    .split(/\s+/u)
    .map((t) => t.replace(EDGE_PUNCTUATION, "").toLocaleLowerCase())
    .filter((t) => t.length > 0);
}

/** Every contiguous run of `n` tokens, joined by single spaces. Empty when the text is shorter than `n`. */
function ngrams(tokens: readonly string[], n: number): string[] {
  if (n <= 0 || tokens.length < n) return [];
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i++) out.push(tokens.slice(i, i + n).join(" "));
  return out;
}

/**
 * Scripts written right to left, by `SCRIPT_TABLE` name — the same two rows
 * `language-register.ts`'s own private `RTL_SCRIPTS` names. It is private
 * there, and this is a two-name set over a table both read through
 * `resolveExpectedScript`, so there is no third table here to drift: a new RTL
 * row in `SCRIPT_TABLE` adds its name in both places.
 */
const RTL_SCRIPT_NAMES: ReadonlySet<string> = new Set(["Hebrew", "Arabic"]);

/**
 * Is this post written right to left?
 *
 * The DECLARED target language decides it when there is one — that is the
 * field every other language step in this agent reads. With no declared
 * language the post's own letters decide, through the shared sniffer rather
 * than a private regex, so a Hebrew draft for a client whose language was
 * never set still gets the Hebrew threshold.
 */
export function isRtlPost(targetLanguage: string | undefined, sample: string): boolean {
  if (targetLanguage !== undefined && targetLanguage.trim().length > 0) {
    const expected = resolveExpectedScript(targetLanguage);
    if (expected !== undefined) return RTL_SCRIPT_NAMES.has(expected.name);
  }
  const sniff = sniffDominantScript(sample);
  return sniff.kind === "resolved" && RTL_SCRIPT_NAMES.has(sniff.script);
}

// ─────────────────────────────────────────────────────────────────────────
// The inputs
// ─────────────────────────────────────────────────────────────────────────

/**
 * The eight payload shapes prompt §12 asks the writer to declare.
 *
 * Carried here rather than imported because `InstagramCopyOutputSchema`'s
 * `payloadKind` field is a `types.ts` change this package does not own (see
 * the NEEDED FROM in the PR body). The eight literals are the same eight.
 * When the schema field lands, `types.ts` becomes the single source and this
 * list is deleted rather than kept as a second copy to drift.
 */
export const VALUE_PAYLOAD_KINDS = [
  "glossary",
  "ranking",
  "comparison",
  "checklist",
  "timeline",
  "myth-vs-fact",
  "walkthrough",
  "single-claim",
] as const;
export type ValuePayloadKind = (typeof VALUE_PAYLOAD_KINDS)[number];

export function isValuePayloadKind(value: unknown): value is ValuePayloadKind {
  return typeof value === "string" && (VALUE_PAYLOAD_KINDS as readonly string[]).includes(value);
}

/** Everything the free floor reads. All of it is already in hand at `07i`; nothing here fetches, and nothing here costs money. */
export interface ValueSignalsInput {
  copy: InstagramCopyOutput;
  /** The run's deduped cards, as the writer saw them — `claim` and `quote` are what the prose ban is measured against. */
  factCards: readonly FactCardForPrompt[];
  /** `coreTerms` and `offers` are the client's own named specifics; the rest of the brief is not read here. */
  brief?: Pick<ClientBrief, "coreTerms" | "offers">;
  /** The resolved target language, verbatim ("Hebrew", "he-IL"). Decides the 8-vs-6 token threshold. */
  targetLanguage?: string;
  /**
   * `copy.payloadKind` once `types.ts` carries it. `undefined` means the
   * writer declared nothing, and `checkPayloadShape` then has no opinion
   * rather than an invented one.
   */
  payloadKind?: string;
}

/** A slide's reader-facing prose, minus the three fields that are SUPPOSED to be verbatim (see `checkSourceProse`). */
interface SlideText {
  n: number;
  label: string;
  text: string;
}

/**
 * The texts the prose ban reads, per RFC-18 §4.1 #1.
 *
 * Excluded, each for its own reason:
 * - `sourceRef` — a citation. Prompt §4 requires it to carry a card's `claim`
 *   character for character, so scanning it would fail every correct draft.
 * - `stat.figure` and `stat.source` — a figure is not prose and prompt §7's
 *   rule at `:230` forbids paraphrasing one; the source line is a citation.
 * - a `quote_card`'s `quote.text` — the quotation IS the slide and the speaker
 *   is named on it, which is the one place a reader is TOLD these are somebody
 *   else's words. Its headline and attribution are still read.
 */
function slideProseTexts(slide: InstagramCopyOutput["slides"][number]): SlideText[] {
  const out: SlideText[] = [
    { n: slide.n, label: `slide ${slide.n}'s headline`, text: slide.headline },
    { n: slide.n, label: `slide ${slide.n}'s body`, text: slide.body },
  ];
  if (slide.kicker) out.push({ n: slide.n, label: `slide ${slide.n}'s kicker`, text: slide.kicker });
  if (slide.quote && slide.layout !== "quote_card") {
    out.push({ n: slide.n, label: `slide ${slide.n}'s pull quote`, text: slide.quote.text });
  }
  if (slide.stat) out.push({ n: slide.n, label: `slide ${slide.n}'s stat label`, text: slide.stat.subLabel });
  if (slide.comparison) {
    out.push({ n: slide.n, label: `slide ${slide.n}'s left column`, text: `${slide.comparison.leftLabel} ${slide.comparison.leftBody}` });
    out.push({ n: slide.n, label: `slide ${slide.n}'s right column`, text: `${slide.comparison.rightLabel} ${slide.comparison.rightBody}` });
  }
  if (slide.items) {
    for (const [i, item] of slide.items.entries()) {
      out.push({ n: slide.n, label: `slide ${slide.n}'s list row ${i + 1}`, text: `${item.title} ${item.note ?? ""}` });
    }
  }
  if (slide.customArchetype) {
    for (const [key, value] of Object.entries(slide.customArchetype.fields)) {
      out.push({ n: slide.n, label: `slide ${slide.n}'s "${key}"`, text: value });
    }
  }
  return out.filter((t) => t.text.trim().length > 0);
}

function proseTextsFor(copy: InstagramCopyOutput): SlideText[] {
  const caption: SlideText[] = copy.caption.trim().length > 0 ? [{ n: 0, label: "the caption", text: copy.caption }] : [];
  return [...caption, ...copy.slides.flatMap(slideProseTexts)];
}

// ─────────────────────────────────────────────────────────────────────────
// 1. sourceProse — the ban on reproducing the source's prose
// ─────────────────────────────────────────────────────────────────────────

/** The shared-run length that refuses, in whitespace tokens, for a left-to-right script. */
export const SOURCE_PROSE_TOKENS = 8;

/**
 * The same rule for Hebrew and Arabic: SIX tokens, not eight.
 *
 * Hebrew fuses articles, conjunctions and prepositions into clitics — `ו`,
 * `ה`, `ב`, `ל`, `ש` are all prefixes rather than words — so six Hebrew words
 * carry roughly the information of eight English ones. An 8-gram rule applied
 * to Hebrew is a rule that never fires, which is worse than no rule: it reads
 * as protection that is not there.
 */
export const SOURCE_PROSE_TOKENS_RTL = 6;

/** Every card's `claim` and `quote` — the two fields a lift comes out of. */
function cardTexts(cards: readonly FactCardForPrompt[]): string[] {
  const out: string[] = [];
  for (const card of cards) {
    if (card.claim.trim().length > 0) out.push(card.claim);
    if (card.quote && card.quote.trim().length > 0) out.push(card.quote);
  }
  return out;
}

/**
 * §4.1 #1 — no run of `threshold` whitespace tokens is shared between the
 * post's own prose and any fact card's `claim` or `quote`.
 *
 * The ban is on the PROSE, never on the FIGURE: prompt §7's existing rule
 * ("do not paraphrase a statistic so a slide can be a `stat_callout`") stays
 * in force, and `stat.figure` is not read here at all.
 */
export function checkSourceProse(
  copy: InstagramCopyOutput,
  cards: readonly FactCardForPrompt[],
  opts: { targetLanguage?: string } = {},
): SlidesDataSelfCheck {
  const texts = proseTextsFor(copy);
  const rtl = isRtlPost(opts.targetLanguage, [copy.caption, ...copy.slides.map((s) => `${s.headline} ${s.body}`)].join(" "));
  const threshold = rtl ? SOURCE_PROSE_TOKENS_RTL : SOURCE_PROSE_TOKENS;

  const cardGrams = new Set<string>();
  for (const text of cardTexts(cards)) for (const gram of ngrams(valueTokens(text), threshold)) cardGrams.add(gram);
  if (cardGrams.size === 0) return { ok: true };

  for (const entry of texts) {
    for (const gram of ngrams(valueTokens(entry.text), threshold)) {
      if (cardGrams.has(gram)) {
        return {
          ok: false,
          reason:
            `${entry.label} reproduces ${threshold} consecutive words of a fact card ("${gram}"). ` +
            `A card's claim is a citation, not the post's prose: say what the card says in the words this account uses. ` +
            `The figure itself may stay exactly as the source states it.`,
        };
      }
    }
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────
// 2. namedSpecifics — a category noun is not a specific
// ─────────────────────────────────────────────────────────────────────────

/** A currency symbol beside digits, in either order. */
const CURRENCY = /(?:[$€£₪¥₽]\s?\d)|(?:\d\s?[$€£₪¥₽])/u;
/** A percentage, as a symbol or as the word, in English or Hebrew. */
const PERCENT = /\d\s?(?:%|percent|percentage|אחוז|אחוזים)/iu;
/** A four-digit year. Not any four digits: a model number is not a date. */
const YEAR = /(?:^|[^\p{Nd}])(?:19|20)\d{2}(?:[^\p{Nd}]|$)/u;
/** A numeral carrying a unit or a counted noun ("12 percent", "2 HP", "7 days", "40 dollars"). */
const NUMERAL_WITH_UNIT = /\d(?:[.,]\d+)?\s?\p{L}{1,14}/u;
/** Two adjacent capitalised words — a proper noun in a Latin-script, sentence-case post. */
const CAPITALISED_RUN = /\p{Lu}\p{Ll}+[\s-]\p{Lu}\p{Ll}+/u;

/** The client's own named things: the brief's core terms and its offer names. */
function briefTerms(brief: ValueSignalsInput["brief"]): string[] {
  if (!brief) return [];
  return [...brief.coreTerms, ...brief.offers.map((o) => o.name)]
    .map((t) => t.trim().toLocaleLowerCase())
    .filter((t) => t.length >= 3);
}

/**
 * Does this text carry something checkable?
 *
 * A figure with its unit, a year, a price, one of the client's own core terms
 * or offer names, or a proper noun. The capitalised-run path is Latin-only by
 * nature — Hebrew has no case, which is exactly why the core-terms and
 * numeral paths exist and are not decoration.
 */
export function hasNamedSpecific(text: string, terms: readonly string[] = []): boolean {
  if (CURRENCY.test(text) || PERCENT.test(text) || YEAR.test(text) || NUMERAL_WITH_UNIT.test(text)) return true;
  if (CAPITALISED_RUN.test(text)) return true;
  const folded = text.toLocaleLowerCase();
  return terms.some((t) => folded.includes(t));
}

/**
 * Does a fact card carry a specific of its own? Read by the value judge's
 * thin-grounding relaxation (RFC-18 §5.4 rule 3): a run whose research came
 * back as four definitions cannot be failed on `newFact` by any redraft, and
 * that is the unwinnable floor Phase 0 already had to correct once.
 */
export function cardCarriesSpecific(card: FactCardForPrompt): boolean {
  return hasNamedSpecific(`${card.claim} ${card.quote ?? ""}`);
}

/** How many of the post's slides must carry a named specific, per §4.1 #2. */
export function namedSpecificsRequired(slideCount: number): number {
  return Math.max(1, Math.ceil(slideCount / 3));
}

/** §4.1 #2 — at least `ceil(slides / 3)` slides carry a named, checkable specific. */
export function checkNamedSpecifics(copy: InstagramCopyOutput, brief?: ValueSignalsInput["brief"]): SlidesDataSelfCheck {
  const terms = briefTerms(brief);
  const carried: number[] = [];
  for (const slide of copy.slides) {
    // The slide's whole plate, plus the one field the prose ban excludes and
    // this check must not: `stat.figure` IS the named specific on a
    // `stat_callout`, and reading it here is the difference between "this
    // slide carries a number" and "this slide carries a number nobody looked
    // at".
    const prose = [...slideProseTexts(slide).map((t) => t.text), slide.stat?.figure ?? "", slide.quote?.text ?? ""].join(" ");
    if (hasNamedSpecific(prose, terms)) carried.push(slide.n);
  }
  const required = namedSpecificsRequired(copy.slides.length);
  if (carried.length >= required) return { ok: true };
  return {
    ok: false,
    reason:
      `only ${carried.length} of ${copy.slides.length} slides carry a named, checkable specific (${required} needed): ` +
      `a figure with its unit and its period, a named product, company, standard, price or version, or one of this client's own core terms. ` +
      `"productivity tools" and "modern platforms" are category nouns, not specifics. Put one of the fact cards' figures on a slide that has none.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 3. coverTension — the hedged cover
// ─────────────────────────────────────────────────────────────────────────

/**
 * Contrast markers, per language, from RFC-18 §4.1 #3.
 *
 * Deliberately short. This is the free half of a check the judge's `position`
 * axis also reads: a marker list long enough to recognise every shape of an
 * argument would be a grammar, and the cases it misses are paid for at $0.003
 * rather than shipped.
 */
const CONTRAST_MARKERS: readonly RegExp[] = [
  /\binstead of\b/iu,
  /\brather than\b/iu,
  /\bstop\b/iu,
  /\bnot\b[^.!?]{0,60}\bbut\b/iu,
  /\bis not\b|\bisn't\b|\bare not\b|\baren't\b/iu,
  // Hebrew: "instead of", "not ... but rather", "stop" (plural and singular
  // imperative). No `\b` anywhere in these: JavaScript's word boundary is
  // defined over `[A-Za-z0-9_]` even under `/u`, so every Hebrew letter is a
  // NON-word character to it and `\bלא\b` is a pattern that can never match.
  // A rule that never fires is worse than no rule — it reads as protection
  // that is not there.
  /במקום/u,
  /(?:^|\s)לא(?:\s|$)[^.!?]{0,60}אלא/u,
  /תפסיקו|תפסיק|די ל/u,
];

/** The slide a reader sees in the grid: the `cover` archetype, else slide 1. */
function coverSlide(copy: InstagramCopyOutput): InstagramCopyOutput["slides"][number] | undefined {
  return copy.slides.find((s) => s.layout === "cover") ?? copy.slides.find((s) => s.n === 1) ?? copy.slides[0];
}

/** §4.1 #3 — the cover headline carries a numeral, a named specific, or a contrast marker. */
export function checkCoverTension(copy: InstagramCopyOutput, brief?: ValueSignalsInput["brief"]): SlidesDataSelfCheck {
  const cover = coverSlide(copy);
  if (!cover) return { ok: true };
  const headline = cover.headline;
  if (/\p{Nd}/u.test(headline)) return { ok: true };
  if (hasNamedSpecific(headline, briefTerms(brief))) return { ok: true };
  if (CONTRAST_MARKERS.some((m) => m.test(headline))) return { ok: true };
  return {
    ok: false,
    reason:
      `the cover headline ("${headline}") has no tension in it: no number, no named specific and no contrast. ` +
      `A line that would be true for every business in this industry is a category description, not a hook. ` +
      `Give the cover a figure, a name, or an assertion someone could argue with ("X is not the reason Y happens. Z is.").`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 4. payloadShape — the declared kind against the actual structure
// ─────────────────────────────────────────────────────────────────────────

/** Slides that carry the argument: everything but the two positional archetypes. */
function contentSlides(copy: InstagramCopyOutput): InstagramCopyOutput["slides"] {
  return copy.slides.filter((s) => s.layout !== "cover" && s.layout !== "closer");
}

/** A slide a reader could count: a numbered headline, or the archetype built for ordered rows. */
function isOrdered(slide: InstagramCopyOutput["slides"][number]): boolean {
  return slide.layout === "list_takeaway" || /^\s*#?\p{Nd}+\s*[.):\-]?\s/u.test(slide.headline);
}

/**
 * §4.1 #4 — the declared `payloadKind` is consistent with the structure the
 * carousel actually has.
 *
 * No declaration means no opinion. A writer that predates the field (an
 * in-flight checkpoint, a fixture) is not refused for a field it was never
 * asked for; the schema's `.default("single-claim")` is what makes that
 * distinction reach this function at all.
 */
export function checkPayloadShape(copy: InstagramCopyOutput, payloadKind: string | undefined): SlidesDataSelfCheck {
  if (payloadKind === undefined || payloadKind.trim().length === 0) return { ok: true };
  if (!isValuePayloadKind(payloadKind)) {
    return { ok: false, reason: `payloadKind "${payloadKind}" is not one of ${VALUE_PAYLOAD_KINDS.join(", ")}` };
  }
  const content = contentSlides(copy);
  const shortfall = (need: string): SlidesDataSelfCheck => ({
    ok: false,
    reason:
      `this post declares payloadKind "${payloadKind}" and its slides are not that shape: ${need}. ` +
      `The number of slides follows from the structure a reader would keep, not the other way round: either build the structure you declared, or declare the one you built.`,
  });

  switch (payloadKind) {
    case "ranking": {
      if (content.length < 5) return shortfall("a ranking needs at least 5 content slides");
      const ordered = content.filter(isOrdered).length;
      if (ordered < 3) return shortfall(`a ranking needs at least 3 slides a reader can count (numbered headlines or list rows); ${ordered} have one`);
      return { ok: true };
    }
    case "comparison": {
      if (!copy.slides.some((s) => s.layout === "comparison_card")) return shortfall("a comparison needs at least one comparison_card slide");
      return { ok: true };
    }
    case "glossary":
    case "checklist": {
      if (content.length < 4) return shortfall(`a ${payloadKind} needs at least 4 content slides`);
      return { ok: true };
    }
    case "single-claim": {
      if (copy.format !== "single") return shortfall("a carousel is a structure; \"single-claim\" belongs to the single-image format");
      return { ok: true };
    }
    // `timeline`, `myth-vs-fact` and `walkthrough` carry no structural
    // requirement a layout can prove. Their shape lives in the prose, which is
    // the judge's `payload` axis, and inventing a mechanical proxy for them
    // here would refuse correct drafts for a rule nobody wrote.
    default:
      return { ok: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 5. rhythm — the two mechanical halves of prompt §26
// ─────────────────────────────────────────────────────────────────────────

/**
 * The opener classes this check can recognise MECHANICALLY.
 *
 * Not a grammar. A question mark, a numeral and a copula are three shapes a
 * regex can see in any script; "imperative" is not one of them, and prompt §26
 * asks for it of the writer rather than of this function. `other` is never
 * counted as a repetition, so a run of three sentences the classifier has no
 * opinion about can never be refused.
 */
type OpenerClass = "question" | "counted" | "definition" | "other";

/**
 * English and Hebrew copulas, tested only near the start of the headline —
 * "X is Y" is a shape, "... is ..." mid-sentence is not. The Hebrew half
 * carries no `\b` for the reason `CONTRAST_MARKERS` states; the tokeniser has
 * already split on whitespace, so a space-delimited alternative is the
 * boundary.
 */
const COPULA = /\b(?:is|are|means)\b|(?:^|\s)(?:הוא|היא|זה|זהו|זו)(?:\s|$)/u;

function openerClass(headline: string): OpenerClass {
  const trimmed = headline.trim();
  if (trimmed.endsWith("?") || trimmed.endsWith("؟")) return "question";
  if (/^\s*#?\p{Nd}/u.test(trimmed)) return "counted";
  const head = valueTokens(trimmed).slice(0, 5).join(" ");
  if (COPULA.test(head)) return "definition";
  return "other";
}

/** §4.1 #5 — no three slides opening with the same word, and no three consecutive slides of the same recognisable opener class. */
export function checkRhythm(copy: InstagramCopyOutput): SlidesDataSelfCheck {
  const slides = copy.slides;
  if (slides.length < 3) return { ok: true };

  const firstWords = new Map<string, number[]>();
  for (const slide of slides) {
    const first = valueTokens(slide.headline)[0];
    if (first === undefined) continue;
    firstWords.set(first, [...(firstWords.get(first) ?? []), slide.n]);
  }
  for (const [word, ns] of firstWords) {
    if (ns.length >= 3) {
      return {
        ok: false,
        reason: `slides ${ns.join(", ")} all open with the word "${word}". Vary how the slides start: three openings in a row from the same word is the cadence that makes eight slides read as one paragraph cut into eight.`,
      };
    }
  }

  const CLASS_LABEL: Record<OpenerClass, string> = { question: "a question", counted: "a number", definition: "an \"X is Y\" definition", other: "" };
  for (let i = 2; i < slides.length; i++) {
    const window = [slides[i - 2]!, slides[i - 1]!, slides[i]!];
    const classes = window.map((s) => openerClass(s.headline));
    const first = classes[0]!;
    if (first !== "other" && first === classes[1] && first === classes[2]) {
      const named = CLASS_LABEL[first];
      return {
        ok: false,
        reason: `slides ${window.map((s) => s.n).join(", ")} are three consecutive headlines built as ${named}. Vary the length and the shape of consecutive lines on purpose: at least one headline of six words or fewer, and at least one line that turns on a contrast.`,
      };
    }
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────
// The step
// ─────────────────────────────────────────────────────────────────────────

/**
 * `07i-value-signals`, whole: the five free checks in RFC-18 §4.1's order,
 * first refusal wins.
 *
 * Ordered so the most severe and the most objective refusal is reported first.
 * A draft that lifted its source's sentences is refused for that, not for a
 * rhythm finding it also happens to have — one reason at a time is what a
 * redraft steer can act on.
 */
export function checkValueSignals(input: ValueSignalsInput): SlidesDataSelfCheck {
  const prose = checkSourceProse(input.copy, input.factCards, input.targetLanguage !== undefined ? { targetLanguage: input.targetLanguage } : {});
  if (!prose.ok) return prose;
  const cover = checkCoverTension(input.copy, input.brief);
  if (!cover.ok) return cover;
  const specifics = checkNamedSpecifics(input.copy, input.brief);
  if (!specifics.ok) return specifics;
  const shape = checkPayloadShape(input.copy, input.payloadKind);
  if (!shape.ok) return shape;
  return checkRhythm(input.copy);
}
