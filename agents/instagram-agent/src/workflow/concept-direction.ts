import { z } from "zod";
import type { TrendCandidate } from "@agent-engine/workflow";
import type { ClientBrief } from "@agent-engine/tools";
import { cardKey, factCardKind, type AngleFactCard, type AngleId } from "./angle-selection.js";
import { claimFigures, normalizeClaim } from "./fact-cards.js";
import { isPlaceholderBriefValue, PLACEHOLDER_CORE_TERM } from "./client-brief.js";
import type { SpendPosture } from "./run-budget.js";

/**
 * Phase 4, RFC-16 §1-§3 and §6.3 — CONCEPT DIRECTION: the pure half.
 *
 * ## What this module is for
 *
 * Phase 3 solved STYLE (what an image looks like) with per-client art
 * direction and a run-wide style lock. It did not solve CONCEPT (what the
 * image IS OF). Nothing in the pipeline asked "what is the visual metaphor
 * for this story?", which is the property the reference account's arresting
 * slides actually share: a subject recognised instantly, placed in an
 * unexpected situation that IS the headline.
 *
 * This file is everything about that mode that can be decided WITHOUT a model
 * call: which stories earn it, what a concept may be about, and whether the
 * one a model wrote is legible, grounded and safe. The model step (`04m`),
 * the consent tool and the workflow wiring live elsewhere; nothing here
 * imports them.
 *
 * ## The three constraints it exists to enforce
 *
 * **(a) Sometimes, not always.** `conceptEligibility` is the whole selector
 * and it is deterministic: a 7-term score over properties of the STORY, a
 * recognition gate, a grounding floor, a cooldown, and six more hard
 * preconditions. Never a coin flip, never a model's opinion of its own
 * story. Design-intent rate ~1 post in 6; the cooldown alone caps it at 1 in
 * 4 whatever the stories look like.
 *
 * **(b) Brand colours and client topics still govern.** `L1` ties the concept
 * to a fact card this run actually fetched; `L2` ties its SUBJECT to a token
 * out of the client's own brief (`conceptSubjectPalette`); `L8` requires a
 * brand colour to obey. The original audit failure — a real-estate carousel
 * generated for an AI marketing agency, because a step took a request
 * verbatim as a web query with no client grounding — is unreachable here: the
 * concept step is handed no request, no query and no web access, and the pair
 * it names is re-checked in code.
 *
 * **(c) Third-party likeness is a policy decision.** Every function that
 * could widen what may be drawn takes a `ConceptLikenessPermit` as a PLAIN
 * TYPED ARGUMENT and treats `undefined` as "nothing is permitted". There is
 * no default that grants anything, and this module has no way to read a
 * consent record — it is handed one or it is not.
 *
 * ## Purity
 *
 * The `scene-brief.ts` discipline: this module imports zod, two type-only
 * workflow types and three pure sibling helpers, and NOTHING from
 * `create-instagram-agent-workflow.ts`. Every workflow-side fact the selector
 * needs (the budget posture, the media source, whether a brand colour
 * survived `buildArtDirection`) arrives as a typed field on the input, so the
 * whole selector is exercisable in a unit test with no harness.
 *
 * ## Hebrew
 *
 * Hebrew is a first-class target language, so no gate in this file may rest
 * on capitalisation. `HEADING_HAS_PROPER_NOUN` (`topic-engines.ts:370`) is
 * case-based and its own comment admits it is silent in Hebrew; a selector
 * keyed on it would fire for English clients and never for `geektime`, which
 * is a defect, not a policy. Recognition is therefore built from fact-card
 * `source` fields and registrable hostnames (§1.3), and the contest term is a
 * contrast LEXICON, not a shape heuristic. The one place a Latin-case rule is
 * used is `checkConceptRendered`, and it is legitimate there for a reason
 * stated at the call site.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants — the selector's five brakes, as numbers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Of a SHIPPED ceiling of 7 (§1.4), not the 10 the term table adds up to.
 *
 * `scoreConcept` defines four 1-point terms, but `distance` is never supplied
 * by the workflow — `04l` deliberately omits it rather than approximate the
 * scout's per-candidate novelty onto the claim — so only three of them are
 * reachable and they sum to 3. `reversal` and `scale` are both keyed on
 * `signals.angleId` and are therefore mutually exclusive, which caps the
 * 2-point half at 4.
 *
 * The consequence, stated plainly because it decides the measured rate: a
 * story with no trend attached reads `hot-news`, `interest>=4` and `numbers`
 * as absent and maxes out at 2, so it can never clear this threshold on the
 * `auto` path. The selector is TIGHTER than §1.6's ~17% design intent — the
 * safe direction for "sometimes, not always", and the first prep sweep's
 * measured rate should be read against 7, not 10.
 */
export const CONCEPT_MIN_SCORE = 5;

/** Mirrors `TREND_JACK_MIN_BRAND_FIT` (`topic-selection.ts:78`) — the trend-jack band, already the minority of scouted stories. */
export const CONCEPT_MIN_BRAND_FIT = 4;

/** The floor on `angleFit` when a trend did NOT take the topic slot (`angle-selection.ts:247-250`). */
export const CONCEPT_MIN_ANGLE_FIT = 0.6;

/** No concept within three shipped posts. A cooldown states a guarantee ("never two in a row"); a bare window permits a burst. Arithmetic ceiling: 25% of posts. */
export const CONCEPT_COOLDOWN_POSTS = 3;

/** The second ceiling's width, in shipped posts. */
export const CONCEPT_WINDOW = 8;

/** At most two concepts in the last `CONCEPT_WINDOW` posts. */
export const CONCEPT_MAX_IN_WINDOW = 2;

/** `scene` replaces a `SlideVisualNeed.scene`, so it has to round-trip `SlideVisualNeedSchema`'s own ceiling. L10. */
export const MAX_CONCEPT_SCENE_CHARS = 240;

/** How many recognised entities travel into the prompt and the verdict. A lexicon, not a corpus. */
export const MAX_CONCEPT_ENTITIES = 8;

/** How many subject tokens the palette offers the model. Enough to choose from, few enough to read. */
export const MAX_SUBJECT_PALETTE_TOKENS = 24;

// ─────────────────────────────────────────────────────────────────────────────
// The pattern vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Closed for exactly the reason `ANGLE_IDS` is closed
 * (`angle-selection.ts:61-67`): an open field lets a model propose three
 * flavours of the same move. The model never sees all seven either — `04l`
 * computes the eligible subset in code (`eligibleConceptPatterns`) and hands
 * only that over, the same discipline as `selectAngle` checking `restsOn`
 * against the cards that actually exist.
 */
export const CONCEPT_PATTERNS = [
  "rivalry", // two forces, one prize
  "reversal", // the thing everyone believed, upended
  "scale", // one number made physical
  "before-after", // one frame holding both states
  "the-outsider", // the one who does not belong, and does
  "the-crown", // who holds the position, and how precariously
  "the-race", // the moment before, or the moment of passing
] as const;

export const ConceptPatternSchema = z.enum(CONCEPT_PATTERNS);
export type ConceptPattern = z.infer<typeof ConceptPatternSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The permit — RFC-16 §5, as this module sees it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a client's `generatedLikeness` consent record permits, flattened to
 * the three lists this module actually checks.
 *
 * A PLAIN TYPED ARGUMENT on purpose. The consent document is read by
 * `media.getLikenessConsent` at `00e`, and the reader (`likeness-consent.ts`)
 * fails closed on every path that is not an explicit yes. Taking the result
 * as an argument rather than reading it here means this file has no way to
 * grant anything to itself, no dependency on that tool, and no default that
 * is not "nothing".
 *
 * `undefined` and `NO_LIKENESS_PERMIT` are the same answer: today's shipped
 * behaviour for the entire fleet.
 */
export interface ConceptLikenessPermit {
  /** Named third-party marks. An allowlist, never a blanket yes. */
  readonly thirdPartyMarks: readonly string[];
  /** Named public figures. A separate list because it is a separate body of law. */
  readonly publicFigures: readonly string[];
  /** Whether the CLIENT'S OWN marks may be drawn. False even by default. */
  readonly ownMarks: boolean;
}

/** The permit every client has until an owner writes a consent record. */
export const NO_LIKENESS_PERMIT: ConceptLikenessPermit = { thirdPartyMarks: [], publicFigures: [], ownMarks: false };

function permitOf(permit: ConceptLikenessPermit | undefined): ConceptLikenessPermit {
  return permit ?? NO_LIKENESS_PERMIT;
}

// ─────────────────────────────────────────────────────────────────────────────
// The inputs — all of it already typed, checkpointed and in scope (§1.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One fact card as this module reads it.
 *
 * §1.2 names `AngleFactCard`, and this extends it rather than replacing it:
 * recognition (§1.3) reads the card's `source` and `url`, which
 * `AngleFactCard` deliberately does not carry (the angle scorer has no use
 * for them). A `ResearchFact` satisfies this shape as-is; so does a
 * hand-written card with neither field.
 */
export interface ConceptFactCard extends AngleFactCard {
  /** `ResearchFactSchema.source` (`types.ts:353`) — the organisation that published the claim. */
  source?: string | undefined;
  url?: string | undefined;
}

/** The trend fields the SCORE reads. */
export type ConceptTrendSignals = Pick<TrendCandidate, "mode" | "interest" | "brandFit" | "hasNumbers" | "headline" | "whyNow" | "angle">;

/** The trend fields RECOGNITION reads. Every field optional so a hand-built fixture (and a run with no trend) is a legal input. */
export interface ConceptTrendText {
  topic?: string | undefined;
  headline?: string | undefined;
  whyNow?: string | undefined;
  angle?: string | undefined;
  evidenceRefs?: readonly string[] | undefined;
  sourceUrls?: readonly string[] | undefined;
}

/** The chosen angle's own words, as recognition and L4 read them. */
export interface ConceptAngleText {
  title?: string | undefined;
  rememberLine?: string | undefined;
  whyThisClient?: string | undefined;
}

/**
 * The brief surfaces this module reads.
 *
 * A structural view rather than `ClientBrief` itself so a test can build one
 * in six lines — and so `brandName`, which the brief has no field for (it is
 * a BRAND TOKEN, not a brief fact), can ride along without inventing a
 * schema field for it. A real `ClientBrief` is assignable to this as-is.
 */
export interface ConceptBriefView {
  positioning: Pick<ClientBrief["positioning"], "oneLiner" | "whatWeSell" | "differentiators">;
  icp: Pick<ClientBrief["icp"], "summary" | "roles">;
  offers: ClientBrief["offers"];
  coreTerms: ClientBrief["coreTerms"];
  ownAssets: ClientBrief["ownAssets"];
  forbidden: ClientBrief["forbidden"];
  /** The client's OWN brand name, when the run has brand tokens carrying one. Enters the palette only when the permit says `ownMarks`. */
  brandName?: string | undefined;
}

/** Everything the score reads. Nothing here is new: no field on `TrendCandidate`, no re-priced scout, no model call to classify the story. */
export interface ConceptSignals {
  /** `angleDecision.chosen.id` (`angle-selection.ts:67`). */
  angleId?: AngleId | undefined;
  /** `angleDecision.chosen.briefFit` (`:83`). */
  briefFit?: number | undefined;
  /** `angleFit(...)` (`:247-250`). */
  angleFit?: number | undefined;
  trend?: ConceptTrendSignals | undefined;
  /** `RankComponents.distance` (`topic-selection.ts:95-103`). */
  distance?: number | undefined;
  /** `promptFacts` — the SAME list `04i` and `05` read. */
  facts: readonly ConceptFactCard[];
  /** `namedEntities(...).entities`, §1.3. */
  entities: readonly string[];
  /** `namedEntities(...).basis`, carried so the verdict can say where recognition came from. */
  entityBasis?: string | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation — one set of primitives, used by every rule below
// ─────────────────────────────────────────────────────────────────────────────

/** Whitespace collapse. The one normalisation every recorded string here goes through, exactly as `angle-selection.ts:158` does it. */
function collapse(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Lowercase, punctuation to spaces, whitespace collapsed. Unicode-aware:
 * `\w` would drop Hebrew entirely, which is the bug this whole file is
 * written around.
 *
 * NOTE it removes `#`, so anything matching on `#1` must use `soften`
 * instead — see `CROWN_CUES`.
 */
function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Lowercase and whitespace-collapsed, punctuation INTACT — the `style-lock.ts:216-218` matcher, and the only one that can see a `#1`. */
function soften(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, " ").trim();
}

/** True when `phrase` appears in `haystack` as a whole word or whole phrase. Both arguments must already be `norm`ed. */
function containsPhrase(haystack: string, phrase: string): boolean {
  if (phrase.length === 0) return false;
  return ` ${haystack} `.includes(` ${phrase} `);
}

function tokensOf(normalized: string): string[] {
  return normalized.length === 0 ? [] : normalized.split(" ");
}

/**
 * A deliberately small English stopword list, for the one job
 * `contentTokens` does: deciding whether two sentences share a word that
 * MEANS something.
 *
 * It is not imported from `fact-cards.ts` because that one is private to that
 * module, and it is not re-exported from there because the two lists answer
 * different questions and a shared list that drifts is worse than two honest
 * ones. Hebrew needs no entries: its function words are one and two letters
 * and are already below the length floor.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "than",
  "then",
  "they",
  "them",
  "their",
  "there",
  "have",
  "has",
  "had",
  "was",
  "were",
  "are",
  "but",
  "not",
  "its",
  "it's",
  "out",
  "one",
  "two",
  "you",
  "your",
  "our",
  "who",
  "how",
  "why",
  "what",
  "when",
  "where",
  "all",
  "any",
  "can",
  "will",
  "just",
  "more",
  "most",
  "over",
  "under",
  "about",
  "after",
  "before",
  "been",
  "being",
  "does",
  "did",
  "now",
]);

/** Words long enough and common enough to carry meaning. Three letters is the floor: Hebrew roots are short. */
function contentTokens(normalized: string): Set<string> {
  const out = new Set<string>();
  for (const token of tokensOf(normalized)) {
    if (token.length < 3 || STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// §1.3 Recognition — `namedEntities`, and why it is not a proper-noun regex
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tokens that appear in a `source` field because of what a source IS, not
 * because of who published it. Removing them turns "Apple Newsroom" into
 * "apple" and "internal client survey" into nothing at all, which is the
 * correct answer for both.
 */
const PUBLISHER_NOISE: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "of",
  "and",
  "news",
  "newsroom",
  "press",
  "release",
  "releases",
  "blog",
  "post",
  "report",
  "reports",
  "magazine",
  "journalism",
  "daily",
  "weekly",
  "monthly",
  "media",
  "official",
  "online",
  "www",
  "com",
  "co",
  "inc",
  "ltd",
  "llc",
  "plc",
  "gmbh",
  "corp",
  "corporation",
  "company",
  "group",
  "holdings",
]);

/**
 * The Hebrew equivalent: nouns that describe a KIND of source. Hebrew carries
 * no case, so the "is this token a name?" test below cannot use
 * capitalisation for it and uses "is it not one of these" instead.
 */
const HEBREW_SOURCE_NOISE: ReadonlySet<string> = new Set(["סקר", "דוח", "דו", "מחקר", "נתונים", "פנימי", "פנימית", "בלוג", "הודעה", "לעיתונות", "מאמר", "כתבה"]);

/** Second-level labels that are part of the suffix rather than the name: `samsung.co.uk` is `samsung`, not `co`. */
const PUBLIC_SLDS: ReadonlySet<string> = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "or", "ne", "go"]);

/**
 * The registrable label of a host or URL: `https://www.apple.com/newsroom` →
 * `apple`, `news.samsung.co.uk` → `samsung`. `undefined` for anything that is
 * not host-shaped — `evidenceRefs` legitimately carries things like
 * `market-strategy#pricing` (`social-trend-scout.ts:338-343`), and a document
 * heading is not an organisation.
 */
export function registrableLabel(ref: string): string | undefined {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return undefined;
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "");
  const hostPart = withoutScheme.split(/[/?#]/u)[0] ?? "";
  const host = hostPart.split("@").pop() ?? "";
  const bare = host.split(":")[0] ?? "";
  if (!/^[\p{L}\p{N}.-]+$/u.test(bare)) return undefined;
  const labels = bare
    .toLowerCase()
    .split(".")
    .filter((l) => l.length > 0 && l !== "www");
  if (labels.length < 2) return undefined;
  let index = labels.length - 2;
  if (index > 0 && PUBLIC_SLDS.has(labels[index]!)) index -= 1;
  const label = labels[index];
  return label !== undefined && label.length >= 2 ? label : undefined;
}

/** True for a token that reads as a NAME rather than as a noun: Latin and capitalised, or a script with no case at all and not source-kind noise. */
function looksLikeNameToken(raw: string): boolean {
  const token = raw.replace(/[^\p{L}\p{N}]/gu, "");
  if (token.length < 2) return false;
  const lower = token.toLowerCase();
  if (PUBLISHER_NOISE.has(lower) || HEBREW_SOURCE_NOISE.has(lower)) return false;
  const first = [...token][0]!;
  const hasCase = first.toLowerCase() !== first.toUpperCase();
  if (!hasCase) return true; // Hebrew, Arabic, CJK: no case to read, so "not noise" is the whole test.
  return first === first.toUpperCase() && /\p{L}/u.test(first);
}

/**
 * The organisation a fact card's `source` names, or nothing.
 *
 * Two shapes, both language-independent in the way that matters: a host
 * (`apple.com`) yields its registrable label, and a prose source yields the
 * runs of name-shaped tokens inside it with the source-kind nouns removed.
 * "internal client survey" yields nothing, which is right — a survey is not
 * an organisation a reader recognises.
 */
export function entitiesFromSource(source: string): string[] {
  const trimmed = source.trim();
  if (trimmed.length === 0) return [];
  if (!/\s/u.test(trimmed) && trimmed.includes(".")) {
    const label = registrableLabel(trimmed);
    return label === undefined ? [] : [label];
  }
  const out: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length > 0) {
      const phrase = norm(run.slice(0, 4).join(" "));
      if (phrase.length >= 2) out.push(phrase);
      run = [];
    }
  };
  for (const raw of trimmed.split(/\s+/u)) {
    if (looksLikeNameToken(raw)) run.push(raw);
    else flush();
  }
  flush();
  return out;
}

/**
 * Capitalised names in the story's own prose — source 4, and ADDITIVE ONLY:
 * it may add an entity, never withhold one, because it is exactly the
 * capitalisation heuristic that is silent in Hebrew. Sentence-initial tokens
 * are skipped, so "Everything changed this week" contributes nothing.
 */
function latinProperNouns(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/[.!?;:\n]+/u)) {
    const words = sentence.trim().split(/\s+/u).filter((w) => w.length > 0);
    let run: string[] = [];
    const flush = (): void => {
      if (run.length > 0) {
        const phrase = norm(run.slice(0, 3).join(" "));
        if (phrase.length >= 3 && !STOPWORDS.has(phrase)) out.push(phrase);
        run = [];
      }
    };
    for (let i = 0; i < words.length; i++) {
      const word = words[i]!;
      const letters = word.replace(/[^\p{L}]/gu, "");
      const first = [...letters][0];
      const capitalised = letters.length >= 3 && first !== undefined && first.toLowerCase() !== first.toUpperCase() && first === first.toUpperCase();
      if (i > 0 && capitalised && !PUBLISHER_NOISE.has(letters.toLowerCase())) run.push(word);
      else flush();
    }
    flush();
  }
  return out;
}

/** Where the recognised entities came from, in the precedence order §1.3 states. */
export type EntityBasis = "fact-card sources" | "evidence hostnames" | "the client's own brief terms" | "capitalised names in the story";

export interface NamedEntityFinding {
  /** Normalised, deduped, precedence-ordered, capped at `MAX_CONCEPT_ENTITIES`. */
  entities: string[];
  /** The sentence the verdict shows a reviewer: "fact-card sources + evidence hostnames". */
  basis: string;
  bases: EntityBasis[];
}

/**
 * The recognition signal — item 1 of the observed recipe, and the gate the
 * selector leans on hardest.
 *
 * A lexicon built in this precedence, then intersected with the story's own
 * artefacts:
 *
 * 1. organisations named in fact-card `source` fields;
 * 2. registrable host labels from `trend.evidenceRefs`, `trend.sourceUrls`
 *    and fact-card `url`s;
 * 3. `brief.coreTerms`, `brief.offers[].name` and the client's own brand
 *    name — but ONLY when the story itself says them. A core term the story
 *    never mentions is not something a reader recognises IN THIS POST, and
 *    admitting it ungated would make `entities.length > 0` true for every
 *    story ever scouted (the schema requires at least one core term), which
 *    would turn the recognition gate into a no-op;
 * 4. a Latin proper-noun regex, additive only.
 *
 * 1 and 2 are language-independent, which is the entire point: a Hebrew story
 * about Apple and Samsung recognises Apple and Samsung because its SOURCES
 * say so, not because its headline is capitalised.
 */
export function namedEntities(
  trend: ConceptTrendText | undefined,
  angle: ConceptAngleText | undefined,
  facts: readonly ConceptFactCard[],
  brief: ConceptBriefView | undefined,
): NamedEntityFinding {
  // Kept as SEPARATE segments rather than one joined string: `latinProperNouns`
  // skips the first word of a sentence, and a headline or a claim is a
  // sentence whether or not it ends in a full stop. Joining first (and
  // collapsing the separator away, which is what a `\n` joiner does under
  // `collapse`) would make "Small teams spend four hours…" contribute
  // "small" as a recognised entity.
  const storyParts = [trend?.topic, trend?.headline, trend?.whyNow, trend?.angle, angle?.title, angle?.rememberLine, angle?.whyThisClient, ...facts.map((f) => f.claim)]
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .map((t) => collapse(t));
  const storyNorm = norm(storyParts.join(" "));

  const found: Array<{ entity: string; basis: EntityBasis }> = [];
  const seen = new Set<string>();
  const add = (value: string, basis: EntityBasis): void => {
    const key = norm(value);
    if (key.length < 2 || seen.has(key)) return;
    seen.add(key);
    found.push({ entity: key, basis });
  };

  for (const fact of facts) {
    if (typeof fact.source !== "string") continue;
    for (const entity of entitiesFromSource(fact.source)) add(entity, "fact-card sources");
  }

  for (const ref of [...(trend?.evidenceRefs ?? []), ...(trend?.sourceUrls ?? []), ...facts.map((f) => f.url)]) {
    if (typeof ref !== "string") continue;
    const label = registrableLabel(ref);
    if (label !== undefined) add(label, "evidence hostnames");
  }

  if (brief !== undefined) {
    const briefTerms = [...brief.coreTerms, ...brief.offers.map((o) => o.name), brief.brandName].filter(
      (t): t is string => typeof t === "string" && !isPlaceholderBriefValue(t),
    );
    for (const term of briefTerms) {
      const key = norm(term);
      if (key.length >= 3 && containsPhrase(storyNorm, key)) add(key, "the client's own brief terms");
    }
  }

  for (const part of storyParts) for (const name of latinProperNouns(part)) add(name, "capitalised names in the story");

  // The cap is applied BEFORE the basis is derived, so `basis` describes the
  // entities a reader can actually see in the verdict rather than ones the cap
  // removed.
  const capped = found.slice(0, MAX_CONCEPT_ENTITIES);
  const bases: EntityBasis[] = [];
  for (const { basis } of capped) if (!bases.includes(basis)) bases.push(basis);
  return {
    entities: capped.map((f) => f.entity),
    basis: bases.length > 0 ? bases.join(" + ") : "no recognisable entity in the story's own sources",
    bases,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §1.4 The score
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A CONTRAST LEXICON, not a capitalisation heuristic and not a model call.
 *
 * A contrast token works in both scripts, which is the whole reason this is
 * the shape of the contest term: `HEADING_HAS_PROPER_NOUN`'s case rule would
 * score every English headline and no Hebrew one. Matched as whole words
 * against `norm`ed text, so "Apple vs. Samsung" and "אפל מול סמסונג" both
 * hit, and "battles" does not (a phrase list that stems is a phrase list that
 * fires on prose — the same reasoning `TREATMENT_VETO_CUES` gives for
 * preferring phrases to words).
 */
export const CONTEST_MARKERS: readonly string[] = ["vs", "versus", "outpaces", "overtakes", "battle", "לעומת", "מול", "נגד", "עוקף"];

/** The contrast marker this text carries, or `undefined`. Exported because the `rivalry` precondition and the verdict's `why` both need to name it. */
export function contestMarker(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const haystack = norm(text);
  for (const marker of CONTEST_MARKERS) if (containsPhrase(haystack, marker)) return marker;
  return undefined;
}

/** One term's contribution, itemised in the house style of `RankComponents` — the verdict shows the arithmetic, never just the total. */
export interface ConceptScoreTerm {
  term: string;
  points: number;
  why?: string;
}

export interface ConceptScore {
  score: number;
  /** Only the terms that SCORED, in the order §1.4 lists them. A term worth nothing is not evidence. */
  terms: ConceptScoreTerm[];
}

/** True when at least one `stat` card carries a real figure. Reuses the repo's figure extractor — a second regex here would be a second answer to "is there a number". */
function statCardWithFigure(facts: readonly ConceptFactCard[]): ConceptFactCard | undefined {
  return facts.find((f) => factCardKind(f) === "stat" && claimFigures(normalizeClaim(f.claim)).length > 0);
}

/**
 * `score(story)` per §1.4. Pure, total, never throws.
 *
 * The distribution of the three 2-point terms is the rate guarantee: a story
 * with no reversal, no figure and no contest maxes out at 4 — and at 3 in
 * production, since `distance` is never supplied — and CANNOT reach
 * `CONCEPT_MIN_SCORE`, whatever else is true of it. If the measured selection
 * rate ever comes in over the 25% ceiling, the lever is
 * `CONCEPT_MIN_SCORE = 6` — one constant, no code change.
 *
 * `distance` is kept as a term rather than deleted: it is the one novelty
 * signal the design calls for, and `04l` can begin supplying it by carrying
 * the scout's per-candidate distance onto the claim without touching this
 * function. Until it does, `CONCEPT_MIN_SCORE`'s comment is the honest
 * statement of what a run can actually score.
 */
export function scoreConcept(signals: ConceptSignals): ConceptScore {
  const terms: ConceptScoreTerm[] = [];
  const trend = signals.trend;

  if (signals.angleId === "wrong-assumption") {
    terms.push({ term: "reversal", points: 2, why: 'angle "wrong-assumption"' });
  }
  if (signals.angleId === "surprising-number") {
    const card = statCardWithFigure(signals.facts);
    if (card !== undefined) {
      terms.push({ term: "scale", points: 2, why: `a stat card carrying ${claimFigures(normalizeClaim(card.claim)).join(", ")}` });
    }
  }
  const contestFields: Array<{ field: string; text: string | undefined }> = [
    { field: "headline", text: trend?.headline },
    { field: "whyNow", text: trend?.whyNow },
    { field: "the client's angle", text: trend?.angle },
  ];
  for (const { field, text } of contestFields) {
    const marker = contestMarker(text);
    if (marker !== undefined) {
      terms.push({ term: "contest", points: 2, why: `contrast marker "${marker}" in ${field}` });
      break;
    }
  }
  if (trend?.mode === "hot-news") terms.push({ term: "hot-news", points: 1 });
  if (typeof trend?.interest === "number" && trend.interest >= 4) terms.push({ term: "interest>=4", points: 1, why: `interest ${trend.interest}` });
  if (trend?.hasNumbers === true) terms.push({ term: "numbers", points: 1 });
  if (typeof signals.distance === "number" && signals.distance >= 0.6) {
    terms.push({ term: "distance>=0.6", points: 1, why: `distance ${Math.round(signals.distance * 1000) / 1000}` });
  }

  return { score: terms.reduce((sum, t) => sum + t.points, 0), terms };
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.1 The subject palette
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `coreTerms`' own placeholder, which `isPlaceholderBriefValue` does not
 * cover.
 *
 * `client-brief.ts` writes `PLACEHOLDER_CORE_TERM` as the single core term
 * when a client has no industry, no description and no documents, and says so
 * in `gaps`. It is a STATEMENT THAT DATA IS MISSING, exactly like
 * `PLACEHOLDER_ONE_LINER` — but `isPlaceholderBriefValue` was written for the
 * two prose one-liners and does not know about it. Every token below goes
 * through `isPlaceholderBriefValue` FIRST, as §3.1 requires, and then through
 * this; pinned by a test that asserts the premise (that
 * `isPlaceholderBriefValue(PLACEHOLDER_CORE_TERM)` is false) so the extra
 * check cannot look redundant to a later reader. The literal is imported, not
 * retyped, so renaming it on the writer's side cannot silently open the hole.
 */
const EXTRA_PLACEHOLDER_TOKENS: ReadonlySet<string> = new Set([norm(PLACEHOLDER_CORE_TERM), "unknown", "n a", "none", "tbd"]);

function isPalettePlaceholder(value: string): boolean {
  return isPlaceholderBriefValue(value) || EXTRA_PLACEHOLDER_TOKENS.has(norm(value));
}

/**
 * The concrete things a concept may be ABOUT, drawn only from the client's
 * own world plus whatever the permit explicitly adds.
 *
 * This is the SUBJECT wire (§3, L2). Phase 3 grounded what a concept asserts;
 * nothing grounded what it is a picture OF, and "a cool image about something
 * the client does not do" is a subject failure, not a claim failure.
 *
 * An empty palette turns the selector OFF (precondition 5): a client with a
 * placeholder brief can never get a concept image. That is the MassHousing
 * failure — an "unnamed business: no profile description…" sentence piped
 * into a diffusion model — closed at its own root on the subject side.
 *
 * The client's OWN brand name is gated on `permit.ownMarks`, not free: an
 * anchor naming the client's mark is an instruction to DRAW that mark, and
 * `generate-image.ts`'s standing "no logos, no watermarks" line means it
 * otherwise would not be drawn anyway. §5.2 is the stricter of the two
 * readings and this follows it.
 */
export function conceptSubjectPalette(brief: ConceptBriefView | undefined, permit?: ConceptLikenessPermit): string[] {
  if (brief === undefined) return [];
  const p = permitOf(permit);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined): void => {
    if (typeof raw !== "string") return;
    const value = collapse(raw);
    if (value.length === 0 || isPalettePlaceholder(value)) return;
    const key = norm(value);
    // Two characters matches almost anything once it is looked for inside a
    // sentence, so a two-character token would make L2 a formality.
    if (key.length < 3 || seen.has(key)) return;
    seen.add(key);
    out.push(value);
  };

  for (const offer of brief.offers) push(offer.name);
  // ICP roles enter as the generic archetypes §5.1 names ("a founder", "a
  // courier") — a role is a person-shaped subject that is nobody in
  // particular, which is the safe default palette's whole idea.
  for (const role of brief.icp.roles) push(role);
  for (const term of brief.coreTerms) push(term);
  for (const asset of brief.ownAssets) push(asset.title);
  if (p.ownMarks) push(brief.brandName);
  for (const mark of p.thirdPartyMarks) push(mark);
  for (const figure of p.publicFigures) push(figure);

  return out.slice(0, MAX_SUBJECT_PALETTE_TOKENS);
}

// ─────────────────────────────────────────────────────────────────────────────
// §2.1 Pattern preconditions, computed in code
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rank and superlative cues for `the-crown`. Matched against `soften`ed text
 * rather than `norm`ed text because `norm` eats the `#` and `#1` is the
 * commonest way a claim says it.
 */
const CROWN_CUES: readonly string[] = ["#1", "largest", "first", "הגדול", "הראשון"];

function claimCarriesCrown(claim: string): boolean {
  const soft = ` ${soften(claim)} `;
  return CROWN_CUES.some((cue) => (cue === "#1" ? soft.includes("#1") : containsPhrase(norm(claim), cue)));
}

/**
 * The eligible subset of `CONCEPT_PATTERNS`, computed deterministically from
 * the story — the model never sees a pattern the story does not support.
 *
 * An empty set is a hard not-eligible (§2.1): a concept with no pattern the
 * story supports is the "cool image about nothing the client does" failure in
 * embryo.
 */
export function eligibleConceptPatterns(signals: ConceptSignals, brief: ConceptBriefView | undefined): ConceptPattern[] {
  const trend = signals.trend;
  const hasContest = [trend?.headline, trend?.whyNow, trend?.angle].some((t) => contestMarker(t) !== undefined);
  const differentiators = (brief?.positioning.differentiators ?? []).filter((d) => !isPalettePlaceholder(d));

  const out: ConceptPattern[] = [];
  if (hasContest && signals.entities.length >= 2) out.push("rivalry");
  if (signals.angleId === "wrong-assumption") out.push("reversal");
  if (statCardWithFigure(signals.facts) !== undefined) out.push("scale");
  if (signals.facts.some((f) => factCardKind(f) === "event") || collapse(trend?.whyNow ?? "").length > 0) out.push("before-after");
  if (differentiators.length > 0) out.push("the-outsider");
  if (signals.facts.some((f) => factCardKind(f) === "stat" && claimCarriesCrown(f.claim))) out.push("the-crown");
  if (trend?.mode === "hot-news") out.push("the-race");
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// §2.2 The concept itself
// ─────────────────────────────────────────────────────────────────────────────

export const ConceptSchema = z.object({
  pattern: ConceptPatternSchema,
  /** The ONE concrete, photographable, instantly-recognised thing in frame. Must name a subject-palette token. */
  anchor: z.string().min(1).max(80),
  /** The unexpected situation the anchor is in — exactly one metaphorical move. */
  situation: z.string().min(1).max(120),
  /** The full generation brief. Replaces `scene` on the GENERATION path only. <=240 so it round-trips `SlideVisualNeedSchema`. */
  scene: z.string().min(1).max(MAX_CONCEPT_SCENE_CHARS),
  /** What a reader who has NOT read the headline would say this picture is of. */
  readsAs: z.string().min(1).max(160),
  /** The sentence the picture and the headline assert together. The legibility contract. Must name an entity. */
  decodesTo: z.string().min(1).max(200),
  /** The fact-card claim this dramatises, VERBATIM. Checked by code against `promptFacts`. */
  restsOn: z.string().min(1),
  /** How the brand accent appears AS AN OBJECT OR SURFACE inside the metaphor. Required. */
  paletteRole: z.string().min(1).max(120),
  /** A RELATIVE production note — how far toward the dramatic end of the LOCKED style to push. Never a style. */
  productionNote: z.string().max(100).optional(),
  /** Third-party marks the concept uses. Empty unless the permit names them. */
  usesPermittedMarks: z.array(z.string().min(1)).max(3).default([]),
  /** The lower third the headline sits on — how it is darkened or cleared. Required. */
  typeZone: z.string().min(1).max(120),
});

/**
 * The INPUT shape, for the same reason `ResearchFact` is one
 * (`types.ts:361-373`): `usesPermittedMarks` carries a zod default, so a
 * hand-built concept (a fixture, a resumed checkpoint written by an earlier
 * shape) legitimately omits it, and every consumer is forced to handle that
 * instead of trusting a default it may not have been parsed through.
 *
 * Every function here takes `Concept`, and `ConceptOutput` is assignable to
 * it, so the workflow can pass a freshly parsed concept straight in.
 */
export type Concept = z.input<typeof ConceptSchema>;

/** What `ConceptSchema.parse` returns — the shape `04m`'s output has once it has been through the schema, with the default applied. */
export type ConceptOutput = z.output<typeof ConceptSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// §2.3 L1-L10 — the legibility guard
// ─────────────────────────────────────────────────────────────────────────────

export const CONCEPT_LEGIBILITY_CLAUSES = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10"] as const;
export type ConceptLegibilityClause = (typeof CONCEPT_LEGIBILITY_CLAUSES)[number];

/**
 * `accepted` applies the concept; `discarded` and `demoted` both leave the
 * slide with the writer's original scene brief and its retrieved candidate.
 * They are separate verdicts because they mean different things to a
 * reviewer: `discarded` is a concept that broke a rule, `demoted` (L6) is a
 * model that wrote a perfectly good literal scene and labelled it a concept.
 */
export type ConceptLegibility =
  | { verdict: "accepted" }
  | { verdict: "discarded"; clause: ConceptLegibilityClause; reason: string }
  | { verdict: "demoted"; clause: "L6"; reason: string };

export interface ConceptLegibilityContext {
  /** `promptFacts` — the cards `restsOn` must name (L1). */
  facts: readonly ConceptFactCard[];
  brief: ConceptBriefView;
  permit?: ConceptLikenessPermit | undefined;
  /** The recognised entities (L4). */
  entities: readonly string[];
  /** The chosen angle's remember line (L4). */
  rememberLine?: string | undefined;
  /** `art.forbid` as `buildArtDirection` produced it (L7). */
  forbid?: readonly string[] | undefined;
  /** L8: `buildArtDirection(...)` returned an `accentColor` or a non-empty `palette`. */
  hasBrandColour: boolean;
}

/**
 * Case- and whitespace-insensitive card matching — `angle-selection.ts`'s own
 * `cardKey`, imported rather than restated.
 *
 * It was restated while `cardKey` was private; the integrator exported it so
 * the two cannot drift at all, which is stronger than the behavioural pin.
 * The test that pins it still runs `selectAngle` end to end, so it measures
 * the matcher a real angle goes through, not this re-export. The reasoning in
 * `cardKey`'s own doc comment applies here unchanged: dropping an otherwise
 * strong concept because a model capitalised a sentence costs the run its one
 * arresting image for nothing.
 */
export function conceptCardKey(claim: string): string {
  return cardKey(claim);
}

/**
 * Anchors that are not things. `instagram-copy@15` §6 asks for this in prose;
 * on this path it is enforced in code, because a diffusion model handed
 * "momentum" draws a stock photograph of nothing in particular and the whole
 * mode is spent.
 */
export const ABSTRACT_ANCHORS: readonly string[] = [
  "trust",
  "momentum",
  "growth",
  "alignment",
  "synergy",
  "innovation",
  "transformation",
  "disruption",
  "אמון",
  "צמיחה",
  "תנופה",
  "חדשנות",
];

/** Two unexpected states joined into one sentence is two metaphors. L5. */
const SECOND_CLAUSE_MARKERS: readonly string[] = [" and ", " while ", " as ", " וגם ", " בזמן ש", " כאשר "];

/** A simile inside the scene is a second metaphor stacked on the first. L5. */
const SIMILE_MARKERS: readonly string[] = ["like a", "like an", "as if", "כמו"];

/**
 * Mark nouns matched PER WORD against the text the generator is handed (L9),
 * as opposed to `MARK_CUES`, which is matched against what a vision model says
 * it SAW.
 *
 * Deliberately narrower than `MARK_CUES`: this list runs against a brief the
 * model wrote, where "badge" and "costume" are ordinary scene furniture ("a
 * courier's badge", "a hi-vis costume") and dropping on them would cost real
 * concepts for nothing. `MARK_CUES` can afford them because by then the
 * picture exists and a drop is the last line before publication.
 */
const SCENE_MARK_CUES: readonly string[] = ["logo", "logos", "wordmark", "brand mark", "brandmark", "trademark", "crest", "emblem", "insignia", "mascot", "לוגו", "סמל"];

function forbidHit(texts: readonly string[], forbid: readonly string[]): { cue: string; text: string } | undefined {
  const cues = forbid.map((f) => soften(f)).filter((f) => f.length >= 3);
  for (const text of texts) {
    const haystack = soften(text);
    for (const cue of cues) if (haystack.includes(cue)) return { cue, text };
  }
  return undefined;
}

/**
 * L1-L10, in order, free and deterministic (§2.3).
 *
 * A concept failing ANY clause is discarded silently and the run proceeds on
 * exactly today's path: the slide keeps the writer's scene brief and its
 * retrieved picture. No retry, no hold, no second model call — the fallback
 * is the current working behaviour, which is precisely why discarding is
 * cheap enough to do freely.
 */
export function checkConceptLegibility(concept: Concept, context: ConceptLegibilityContext): ConceptLegibility {
  const permit = permitOf(context.permit);
  const anchorNorm = norm(concept.anchor);
  const restsOnNorm = normalizeClaim(concept.restsOn);

  // L1 — `restsOn` names a real card. THE CLAIM WIRE.
  const cards = new Set(context.facts.map((f) => conceptCardKey(f.claim)));
  if (!cards.has(conceptCardKey(concept.restsOn))) {
    return { verdict: "discarded", clause: "L1", reason: `it rests on a claim this run never fetched: "${collapse(concept.restsOn)}"` };
  }

  // L2 — the anchor is drawn from the client's own world. THE SUBJECT WIRE.
  const palette = conceptSubjectPalette(context.brief, permit);
  const matched = palette.find((token) => containsPhrase(anchorNorm, norm(token)));
  if (matched === undefined) {
    return {
      verdict: "discarded",
      clause: "L2",
      reason:
        palette.length === 0
          ? "the client's brief yields no subject palette at all, so no anchor can be grounded in it"
          : `its anchor "${collapse(concept.anchor)}" names nothing in the client's own brief (palette: ${palette.slice(0, 8).join(", ")})`,
    };
  }

  // L2, second half — the SCENE carries the same token the anchor was grounded
  // on.
  //
  // L2 grounds `anchor`, but `anchor` is never sent anywhere: the workflow
  // hands the generator `concept.scene` and nothing else. Without this, the
  // subject wire is checked on a field the diffusion model never sees, and
  // §3's "structurally impossible, not unlikely" is true only of a string that
  // gets thrown away. The prompt already requires `scene` to describe the
  // anchor, so this asks for nothing new of the model — it makes the rule the
  // prompt states enforceable on the field that is actually generated.
  if (!containsPhrase(norm(concept.scene), norm(matched))) {
    return {
      verdict: "discarded",
      clause: "L2",
      reason: `its anchor is grounded on "${matched}" but its scene — the only text the generator is given — never names it: "${collapse(concept.scene)}"`,
    };
  }

  // L3 — the anchor is photographable.
  const abstract = ABSTRACT_ANCHORS.find((cue) => containsPhrase(anchorNorm, cue));
  if (abstract !== undefined) {
    return { verdict: "discarded", clause: "L3", reason: `its anchor is an abstraction, not an object: "${abstract}"` };
  }

  // L4 — the decode is about this slide, and names a recognised entity.
  const decodeNorm = norm(concept.decodesTo);
  const decodeTokens = contentTokens(decodeNorm);
  const namesEntity = context.entities.some((entity) => {
    const key = norm(entity);
    return containsPhrase(decodeNorm, key) || tokensOf(key).some((t) => t.length >= 3 && decodeTokens.has(t));
  });
  if (!namesEntity) {
    return {
      verdict: "discarded",
      clause: "L4",
      reason: `its decode names none of the entities this story recognises (${context.entities.length > 0 ? context.entities.join(", ") : "none"})`,
    };
  }
  const slideTerms = new Set<string>();
  for (const token of contentTokens(norm(context.rememberLine ?? ""))) slideTerms.add(token);
  for (const term of context.brief.coreTerms) for (const token of contentTokens(norm(term))) slideTerms.add(token);
  const figures = claimFigures(restsOnNorm);
  const namesSlide = [...decodeTokens].some((t) => slideTerms.has(t)) || figures.some((f) => containsPhrase(decodeNorm, norm(f)));
  if (!namesSlide) {
    return { verdict: "discarded", clause: "L4", reason: "its decode says nothing this slide is about: no remember-line term, no core term and no figure from the claim" };
  }

  // L5 — exactly one move.
  const situationSoft = ` ${soften(concept.situation)} `;
  const secondClause = SECOND_CLAUSE_MARKERS.find((m) => situationSoft.includes(m));
  if (secondClause !== undefined) {
    return { verdict: "discarded", clause: "L5", reason: `its situation carries two clauses ("${secondClause.trim()}") where a concept gets exactly one move` };
  }
  const sceneSoft = soften(concept.scene);
  const simile = SIMILE_MARKERS.find((m) => sceneSoft.includes(m));
  if (simile !== undefined) {
    return { verdict: "discarded", clause: "L5", reason: `its scene stacks a simile ("${simile}") on top of the metaphor` };
  }

  // L6 — `readsAs` != `decodesTo`. Not an error: a literal image, correctly
  // labelled a literal image.
  if (norm(concept.readsAs) === decodeNorm) {
    return { verdict: "demoted", clause: "L6", reason: "what it reads as and what it decodes to are the same sentence, so it is a literal scene rather than a concept" };
  }

  // L7 — forbid is enforced, not advisory.
  const forbidList = [...(context.forbid ?? []), ...context.brief.forbidden.topics];
  const hit = forbidHit([concept.anchor, concept.situation, concept.scene, concept.paletteRole], forbidList);
  if (hit !== undefined) {
    return { verdict: "discarded", clause: "L7", reason: `it names something on the client's forbid list ("${hit.cue}")` };
  }

  // L8 — a brand colour to obey.
  if (collapse(concept.paletteRole).length === 0 || !context.hasBrandColour) {
    return {
      verdict: "discarded",
      clause: "L8",
      reason: context.hasBrandColour ? "it gives the brand palette no role in the frame" : "this client has no accent colour or palette for the concept to be rendered in",
    };
  }

  // L9 — safety. Code, not model judgment, is what enforces the list.
  const allowed = new Set([...permit.thirdPartyMarks, ...permit.publicFigures].map((m) => norm(m)));
  if (permit.ownMarks && typeof context.brief.brandName === "string") allowed.add(norm(context.brief.brandName));

  // L9, first half: what the GENERATOR is actually handed.
  //
  // `usesPermittedMarks` is the model's own DECLARATION, and the clause below
  // validates only that. But the only field that reaches the diffusion model
  // is `scene` (`create-instagram-agent-workflow.ts` sets `conceptPrompt =
  // concept.scene` and `generate-image.ts:495` puts it first in the brief), so
  // a concept that simply writes "the Apple logo glowing on the wall behind
  // them" into `scene` and leaves `usesPermittedMarks` empty was enforced
  // against nothing. That is not a hypothetical shape: the entity names are in
  // the model's own input, and L4 REQUIRES it to name one in `decodesTo`, so
  // they are in its working set when it writes `scene`.
  //
  // L7 does not cover this. Its matcher compares whole forbid entries as
  // substrings, and the standing entries are the sentences "logos and brand
  // marks" and "recognisable real people" — which can only fire on a scene
  // that quotes the policy phrase verbatim.
  //
  // The cue set is therefore TOKENISED and subtracted twice over: a
  // recognised entity is a cue only when the permit does not allow it AND it
  // is not part of the client's own subject palette. Both subtractions are
  // load-bearing — the client's own brand name and core terms arrive in
  // `entities` by §1.3's source 3, and the anchor is REQUIRED by L2 to name a
  // palette token, so without them L2 and L9 would contradict each other and
  // every concept would be discarded.
  const ownWorld = palette.map((token) => norm(token)).filter((token) => token.length > 0);
  const entityCues = context.entities
    .map((entity) => norm(entity))
    .filter((entity) => entity.length >= 3 && !allowed.has(entity) && !ownWorld.some((token) => containsPhrase(entity, token) || containsPhrase(token, entity)));
  // The generic mark nouns, per word, so "the Apple logo" is caught by the
  // noun even when the name is one the story never recognised. Suspended when
  // the permit grants something, on the same reasoning as `checkConceptRendered`.
  const markCues = allowed.size === 0 ? SCENE_MARK_CUES : [];
  const generationTexts = [concept.anchor, concept.situation, concept.scene, concept.paletteRole];
  for (const text of generationTexts) {
    const key = norm(text);
    const cue = [...entityCues, ...markCues].find((c) => containsPhrase(key, c));
    if (cue !== undefined) {
      return {
        verdict: "discarded",
        clause: "L9",
        reason: `what it asks the generator to draw names something this client has no permission for ("${cue}"), in "${collapse(text)}"`,
      };
    }
  }

  const unpermitted = (concept.usesPermittedMarks ?? []).find((mark) => !allowed.has(norm(mark)));
  if (unpermitted !== undefined) {
    return { verdict: "discarded", clause: "L9", reason: `it uses a mark this client has no permission for: "${collapse(unpermitted)}"` };
  }

  // L10 — length, so the rewritten need still parses `SlideVisualNeedSchema`.
  if (concept.scene.length > MAX_CONCEPT_SCENE_CHARS) {
    return { verdict: "discarded", clause: "L10", reason: `its scene is ${concept.scene.length} characters, over the ${MAX_CONCEPT_SCENE_CHARS} a visual need can carry` };
  }

  return { verdict: "accepted" };
}

/** What `image.generate`'s `art.permittedMarks` / `art.permittedFigures` should carry for one concept. */
export interface ConceptPermittedSubjects {
  readonly marks: string[];
  readonly figures: string[];
}

/**
 * Split the concept's OWN declared subjects into the two lists
 * `image.generate` 1.2.0 takes.
 *
 * ## Why this is not just `permit.thirdPartyMarks` / `permit.publicFigures`
 *
 * The permit is a CEILING — "these are the names this client MAY use". The
 * concept's `usesPermittedMarks` is the INSTRUCTION — "this is what I am
 * actually drawing". Handing the tool the ceiling instead of the instruction
 * is wrong in both directions and one of them is a rights problem:
 *
 *  - `generate-image.ts`'s `describeGenerated` writes the DESCRIPTION the
 *    image vet reads, and with a non-empty `permittedFigures` it asserts "a
 *    deliberate, recorded-permission likeness of <names>". That sentence
 *    exists because the vet has no pixels on the generate tier and therefore
 *    believes it. Passing the ceiling makes that sentence a claim that the
 *    frame contains a person the concept never asked for — the same lie the
 *    clause was written to prevent, told in the other direction, and told on
 *    EVERY need in the call, not only the concept's slide.
 *  - `buildConstraintLine` turns a non-empty list into permission ("No
 *    identifiable real person other than: <names>"), so the ceiling would
 *    licence the model to draw a figure nothing selected.
 *
 * `usesPermittedMarks` is a single list covering both kinds, because L9
 * validates it against the UNION of the two permit lists. So the partition
 * has to happen here, with L9's own `norm` comparison, or the two would
 * disagree about what counts as the same name.
 *
 * Anything L9 admitted that is not a listed public figure is a mark: that is
 * the conservative side of the split, since the marks clause confines a name
 * to "clean flat circular badges or plain wordless silhouettes, never … a
 * person's likeness", while the figures clause is what actually authorises a
 * face. Call this only on a concept that has already passed
 * `checkConceptLegibility`; on an unchecked one it silently narrows to
 * whatever the permit happens to allow rather than refusing, and refusing is
 * L9's job, not this function's.
 */
export function conceptPermittedSubjects(concept: Concept, permit?: ConceptLikenessPermit): ConceptPermittedSubjects {
  const p = permitOf(permit);
  const figureKeys = new Set(p.publicFigures.map((f) => norm(f)).filter((f) => f.length > 0));
  const marks: string[] = [];
  const figures: string[] = [];
  for (const raw of concept.usesPermittedMarks ?? []) {
    const name = collapse(raw);
    if (name.length === 0) continue;
    (figureKeys.has(norm(name)) ? figures : marks).push(name);
  }
  return { marks, figures };
}

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 The rendered check — what was actually DRAWN, against the permit
// ─────────────────────────────────────────────────────────────────────────────

/** The fields of one `media.inspectImages` result this check reads (`inspect-images.ts:100-107`). */
export interface ConceptRenderAnalysis {
  description?: string | undefined;
  subjects?: readonly string[] | undefined;
  textInImage?: readonly string[] | undefined;
  hasPeople?: boolean | undefined;
}

export type ConceptRenderCheck = { ok: true } | { ok: false; reason: string };

/**
 * Words a vision note uses when it has recognised a MARK rather than an object.
 *
 * `mascot`, `character`, `cartoon`, `figurine` and `costume` are here because
 * the reference recipe's own headline example is a MASCOT (the Duolingo owl),
 * and a mascot is a third-party mark that answers to none of the mark nouns
 * above it. They matter for the UNNAMED case — "an owl mascot" — since a named
 * one is caught by the recognition rule below whatever noun carries it.
 */
const MARK_CUES: readonly string[] = [
  "logo",
  "logos",
  "wordmark",
  "brand mark",
  "brandmark",
  "trademark",
  "crest",
  "badge",
  "emblem",
  "insignia",
  "mascot",
  "character",
  "cartoon",
  "figurine",
  "costume",
  "לוגו",
  "סמל",
];

/** Words a vision note uses when the people in frame are a SOMEBODY rather than an anybody. */
const PERSON_CUES: readonly string[] = ["person", "man", "woman", "people", "figure", "celebrity", "player", "founder", "ceo", "portrait", "face"];

/**
 * The safety half of §6.3, in code, against the pixels.
 *
 * `describeGenerated(prompt)` restates the prompt into the candidate
 * description (`generate-image.ts:184-186, :366`), so on the generate tier the
 * vet otherwise compares the brief against itself — for a concept image that
 * is fatal, because the concept would score against its own words every time.
 * One `media.inspectImages` call on the one concept candidate replaces that
 * echo; this function is what reads the result.
 *
 * Three drops, all of them things the prompt only ever ASKED for:
 * an unpermitted mark that was drawn anyway, a recognisable named person with
 * no `publicFigures` grant, and any legible lettering (badges and throne-rooms
 * invite signage, and "no text" is a standing constraint the pipeline has
 * never actually verified).
 *
 * `looksAiGenerated: true` is EXPECTED here and is deliberately not a reason.
 *
 * The person check reads Latin capitalisation, which every other gate in this
 * file refuses to do. It is legitimate exactly here and nowhere else: this
 * text is `media.inspectImages`' own output, which its instructions
 * (`inspect-images.ts:126-133`) compose in English regardless of the run's
 * target language. It is not client copy and it is not the story.
 *
 * ## Why RECOGNITION, not a cue word, is the test
 *
 * The first cut of this function required one of twelve English mark nouns to
 * appear in the same `subjects` string before it would look at the name, and
 * required a generic person noun AND a proper noun together before it would
 * drop a likeness. `inspect-images.ts:133` asks the model to "NAME what you
 * can actually recognise … and say so plainly", so the LIKELIEST output shape
 * for a recognised mark or face is a bare name — `"Tim Cook at the head of the
 * table"`, `"Nike sneakers"`, `"the Duolingo owl"` — and all three passed
 * clean. The three tests that covered it passed only because their fixtures
 * happened to embed a cue word.
 *
 * So the test is now the recognition itself: a name-shaped token run the
 * permit does not cover is a drop, whatever noun sits beside it. That is the
 * same signal §1.3 uses to decide a story HAS a recognisable entity, read here
 * against the pixels instead of the sources, and it is the only thing standing
 * between a generated third-party likeness and a paying client's feed.
 *
 * `description` is read as well as `subjects`. It was declared on the
 * interface from the first commit and never looked at, which left the whole
 * check dependent on which of the two fields the model chose to put the name
 * in.
 *
 * The conservative direction costs a run its concept image and nothing else:
 * a drop falls back to the slide's retrieved photograph, the documented and
 * already-working path. A false positive is therefore cheap and a false
 * negative is a rights problem, which is the trade this picks deliberately.
 */
export function checkConceptRendered(analysis: ConceptRenderAnalysis, permit?: ConceptLikenessPermit, ownBrandName?: string): ConceptRenderCheck {
  const p = permitOf(permit);
  const subjects = (analysis.subjects ?? []).filter((s) => typeof s === "string" && s.trim().length > 0);
  const allowedMarks = p.thirdPartyMarks.map((m) => norm(m)).filter((m) => m.length > 0);
  const allowedFigures = p.publicFigures.map((f) => norm(f)).filter((f) => f.length > 0);
  // The client's own mark is permitted here on exactly L9's condition
  // (`:1042`) and no other: `ownMarks` granted, and a brand name to compare
  // against. Without it a client that DID licence its own logo would have
  // every concept frame dropped for drawing it.
  const allowedNames = [...allowedMarks, ...allowedFigures];
  const ownKey = p.ownMarks && typeof ownBrandName === "string" ? norm(ownBrandName) : "";
  if (ownKey.length > 0) allowedNames.push(ownKey);
  /** A recognised name is permitted when it IS an allowed name or contains one ("apple" covers "apple park"). */
  const permitted = (name: string): boolean => allowedNames.some((allowed) => containsPhrase(name, allowed) || containsPhrase(allowed, name));

  const description = typeof analysis.description === "string" ? analysis.description : "";
  const notes = description.trim().length > 0 ? [...subjects, description] : [...subjects];

  for (const note of notes) {
    const key = norm(note);
    // A mark noun with no name attached — "an owl mascot", "a crest on the
    // shirt". This is the original clause, unchanged except for its wider cue
    // list: a note carrying an allowed name is exempt, because a client that
    // licensed a mark is expected to have it drawn.
    const markCue = MARK_CUES.find((cue) => containsPhrase(key, cue));
    if (markCue !== undefined && !allowedNames.some((allowed) => containsPhrase(key, allowed))) {
      return { ok: false, reason: `the rendered image shows a brand mark this client has no permission for: "${collapse(note)}"` };
    }

    const named = latinProperNouns(`x ${note}`).filter((name) => !permitted(name));
    if (named.length === 0) continue;
    // Which of the two reasons a reviewer is shown. Both are drops; the
    // sentence is the only thing that differs, and it is what tells the owner
    // whether they are looking at a likeness question or a trademark one.
    const readsAsPerson = analysis.hasPeople === true || PERSON_CUES.some((cue) => containsPhrase(key, cue));
    return readsAsPerson
      ? { ok: false, reason: `the rendered image shows a named person and this client has no likeness permission: "${collapse(note)}"` }
      : { ok: false, reason: `the rendered image shows a recognisable named subject this client has no permission for: "${collapse(note)}" (${named.join(", ")})` };
  }

  const text = (analysis.textInImage ?? []).map((t) => collapse(t)).filter((t) => t.length > 0);
  if (text.length > 0) {
    return { ok: false, reason: `the rendered image carries lettering, which the no-text constraint forbids: ${text.slice(0, 4).map((t) => `"${t}"`).join(", ")}` };
  }

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// §1.7 The ledger codec — `; concept: <n> | <pattern> | <anchor>`
// ─────────────────────────────────────────────────────────────────────────────

/** What one shipped concept leaves behind in the decision log. */
export interface ConceptLedgerEntry {
  /** The slide the concept was applied to. */
  n: number;
  pattern: ConceptPattern;
  anchor: string;
}

/** A concept this account already shipped, with how far back it was. */
export interface PastConcept extends ConceptLedgerEntry {
  /** 0 = the most recent post in the log. The cooldown counts POSTS, not concept rows, so the position has to survive the read. */
  postsAgo: number;
}

/**
 * Item E's decision summary with this run's concept appended INSIDE the
 * parenthesis, modelled line-for-line on `angleDecisionSummary`
 * (`angle-selection.ts:467-475`).
 *
 * Placed BEFORE any `angle:` fragment rather than last, which is the one
 * deliberate difference. `angleFromDecisionSummary` reads its remember line
 * to the summary's closing parenthesis and cuts it short only at a known
 * later key (`:495`) — a list that does not include `concept`. Appending last
 * would therefore glue "; concept: 3 | rivalry | …" onto every remember line
 * this codec ever coexists with, and the angle rotation measures novelty
 * against those lines. Going in front makes the order the two codecs are
 * called in irrelevant, and keeps the human sentence (the remember line) last,
 * which is the property `angleDecisionSummary`'s own comment says it wants.
 */
export function conceptDecisionSummary(base: string, chosen: ConceptLedgerEntry | undefined): string {
  if (chosen === undefined) return base;
  const anchor = collapse(chosen.anchor);
  if (anchor.length === 0) return base;
  const fragment = `concept: ${chosen.n} | ${chosen.pattern} | ${anchor}`;
  const angleAt = /[;(]\s*angle:\s/u.exec(base);
  if (angleAt !== null) {
    const at = angleAt.index;
    if (base[at] === "(") return `${base.slice(0, at + 1)}${fragment}; ${base.slice(at + 1)}`;
    return `${base.slice(0, at)}; ${fragment}${base.slice(at)}`;
  }
  const close = base.lastIndexOf(")");
  if (close === -1) return `${base} (${fragment})`;
  return `${base.slice(0, close)}; ${fragment}${base.slice(close)}`;
}

const CONCEPT_MARKER = new RegExp(`[;(]\\s*concept:\\s*(\\d+)\\s*\\|\\s*(${CONCEPT_PATTERNS.join("|")})\\s*\\|\\s*`, "u");

/** Everything that may legally follow the anchor, so an anchor is cut off rather than swallowing the rest of the row. */
const LATER_KEY = /;\s(?:archetypes|mode|source|lane|angle|concept):\s/u;

/**
 * Reads one concept back out of a decision summary, or `undefined` for a row
 * that carries none — which is every row written before this step existed and
 * every run where the selector declined. Skipped rather than defaulted, for
 * the reason `pastAnglesFromDecisions` gives: a run that declined must not
 * look like a run that shipped a `rivalry`.
 */
export function conceptFromDecisionSummary(summary: string): ConceptLedgerEntry | undefined {
  const match = CONCEPT_MARKER.exec(summary);
  if (!match) return undefined;
  const rest = summary.slice(match.index + match[0].length);
  const close = rest.lastIndexOf(")");
  let body = close === -1 ? rest : rest.slice(0, close);
  const laterKey = LATER_KEY.exec(body);
  if (laterKey) body = body.slice(0, laterKey.index);
  const anchor = collapse(body);
  if (anchor.length === 0) return undefined;
  const n = Number.parseInt(match[1]!, 10);
  return { n: Number.isFinite(n) ? n : 0, pattern: match[2] as ConceptPattern, anchor };
}

/**
 * The concepts this account already shipped, newest first, out of
 * `memory.read({ scope: "decisions" })`.
 *
 * Modelled on `pastAnglesFromDecisions` (`angle-selection.ts:510-518`) with
 * one addition it does not need: `postsAgo`, the row's POSITION among all
 * decisions. The cooldown's guarantee is "no concept within three shipped
 * POSTS", so a list that silently drops the rows in between would turn
 * "three posts ago" into "three concepts ago" and quietly lift the 25%
 * ceiling.
 */
export function pastConceptsFromDecisions(decisions: ReadonlyArray<{ at?: unknown; summary: string }>): PastConcept[] {
  const at = (d: { at?: unknown }): number => (typeof d.at === "number" ? d.at : 0);
  return [...decisions]
    .sort((a, b) => at(b) - at(a))
    .flatMap((d, index) => {
      const concept = conceptFromDecisionSummary(d.summary);
      return concept === undefined ? [] : [{ ...concept, postsAgo: index }];
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// §1.5-§1.7 The verdict
// ─────────────────────────────────────────────────────────────────────────────

/** The override ladder's vocabulary (§1.7). `"off"` at the client level is a standing opt-out and beats any per-run request. */
export const CONCEPT_MODES = ["auto", "on", "off"] as const;
export type ConceptMode = (typeof CONCEPT_MODES)[number];

export interface ConceptEligibilityInput {
  signals: ConceptSignals;
  brief: ConceptBriefView;
  permit?: ConceptLikenessPermit | undefined;
  /** `pastConceptsFromDecisions(...)`, newest first. */
  pastConcepts: readonly PastConcept[];
  /**
   * `angleDecision.status`. Anything but `"selected"` — including the
   * documented fail-open path (`angle-selection.ts:329`) — is not eligible:
   * the concept mode fails OFF, always.
   */
  angleStatus: "selected" | "no-eligible-angle" | "unavailable";
  /** True when a TREND took the topic slot, which is what decides whether the grounding floor reads `brandFit` or `briefFit` + `angleFit`. */
  trendTookSlot: boolean;
  /** §1.5.6 — `buildArtDirection(...)` returned an `accentColor` or a non-empty `palette`. */
  hasBrandColour: boolean;
  /** §1.5.7 — `budgetPlan.generatedImagesCap` (`run-budget.ts:393`). */
  generatedImagesCap: number;
  /** §1.5.7 — the LIVE meter posture, read at `04l` (`workflow:5193`). */
  meterPosture: SpendPosture;
  /** §1.5.8 — `runDirection.mediaSource` (`workflow:3463`). */
  mediaSource?: string | undefined;
  /** Override level 1: the client config `instagramConceptMode`. */
  clientMode?: ConceptMode | undefined;
  /** Override level 2: the run input `conceptMode`. */
  runMode?: ConceptMode | undefined;
}

export interface ConceptEligibility {
  eligible: boolean;
  score: number;
  threshold: number;
  terms: ConceptScoreTerm[];
  recognition: { entities: string[]; basis: string };
  grounding: { basis: "trend" | "angle" | "none"; floor: number; brandFit?: number; briefFit?: number; angleFit?: number };
  cooldown: { postsSinceLastConcept: number | null; required: number; usedInWindow: number; window: number; ceiling: number };
  /** The eligible pattern subset — the only patterns `04m` is allowed to choose from. */
  patterns: ConceptPattern[];
  /** The subject palette, so a reviewer can see what a concept was allowed to be about. */
  subjects: string[];
  /** The effective mode after the override ladder. */
  mode: ConceptMode;
  /** Present when not eligible: the one sentence that says why. */
  reason?: string;
  /** Present when a budget, plan or run-shape gate declined rather than the story — §7.3's ladder wording. */
  skipped?: string;
  /** How the verdict was reached, in the words the gate payload shows. */
  rule: string;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * The selector (§1.5), itemised (§1.7).
 *
 * Everything is computed on every run, including the runs that decline, so
 * `conceptReport` shows a reviewer the decision AND its arithmetic before
 * they approve. Pure, total, never throws.
 *
 * Order of the gates is the order of the sentences below, and it is chosen so
 * the reason a reviewer reads is the most actionable one: a run that was
 * never going to buy an image says so before it discusses the story's shape.
 *
 * `"on"` bypasses the score, the recognition gate and the cooldown. It does
 * NOT bypass the grounding floor, the palette or colour gates, the budget
 * gates, the safety policy, or the requirement that the story support at
 * least one pattern. Those are not preferences.
 */
export function conceptEligibility(input: ConceptEligibilityInput): ConceptEligibility {
  const { signals, brief } = input;
  const permit = permitOf(input.permit);
  const { score, terms } = scoreConcept(signals);
  const entities = [...signals.entities];
  const patterns = eligibleConceptPatterns(signals, brief);
  const subjects = conceptSubjectPalette(brief, permit);

  const lastConcept = input.pastConcepts[0];
  const postsSinceLastConcept = lastConcept === undefined ? null : lastConcept.postsAgo;
  const usedInWindow = input.pastConcepts.filter((c) => c.postsAgo < CONCEPT_WINDOW).length;
  const cooldown = {
    postsSinceLastConcept,
    required: CONCEPT_COOLDOWN_POSTS,
    usedInWindow,
    window: CONCEPT_WINDOW,
    ceiling: CONCEPT_MAX_IN_WINDOW,
  };

  const trend = signals.trend;
  const grounding: ConceptEligibility["grounding"] = input.trendTookSlot
    ? { basis: "trend", floor: CONCEPT_MIN_BRAND_FIT, ...(typeof trend?.brandFit === "number" ? { brandFit: trend.brandFit } : {}) }
    : {
        basis: "angle",
        floor: CONCEPT_MIN_BRAND_FIT,
        ...(typeof signals.briefFit === "number" ? { briefFit: signals.briefFit } : {}),
        ...(typeof signals.angleFit === "number" ? { angleFit: round3(signals.angleFit) } : {}),
      };

  // A run input wins over the client config, and "off" at either level wins
  // over everything. `clientMode` used to be consulted ONLY for "off", so a
  // client configured `instagramConceptMode: "on"` resolved to "auto", never
  // forced, and the verdict still reported "client config" as the deciding
  // level — a reviewer was told the config decided, and told a value the
  // config had not set. `readConceptMode` (`types.ts`) admits all three values
  // from the config, so "on" was a settable-but-dead surface.
  const mode: ConceptMode = input.clientMode === "off" ? "off" : (input.runMode ?? input.clientMode ?? "auto");
  const forced = mode === "on";

  const recognition = { entities, basis: signals.entityBasis ?? (entities.length > 0 ? "named entities" : "no recognisable entity in the story's own sources") };

  const decline = (reason: string, skipped?: string): ConceptEligibility => ({
    eligible: false,
    score,
    threshold: CONCEPT_MIN_SCORE,
    terms,
    recognition,
    grounding,
    cooldown,
    patterns,
    subjects,
    mode,
    reason,
    ...(skipped !== undefined ? { skipped } : {}),
    rule: `${ruleParts(score, entities, grounding, cooldown, forced).join(", ")} → not eligible: ${reason}`,
  });

  // ── gates that are not about the story ──
  if (mode === "off") {
    return decline(
      input.clientMode === "off" ? "this client's `instagramConceptMode` is off" : "this run asked for `conceptMode: off`",
      "concept mode is off for this run",
    );
  }
  if (input.mediaSource === "client") {
    return decline("this run publishes the client's own media", "client-media run");
  }
  if (input.generatedImagesCap <= 0) {
    return decline("the run budget bought no generated images", "generatedImagesCap 0");
  }
  if (input.meterPosture !== "normal") {
    return decline(`the run is past target (meter posture "${input.meterPosture}")`, "past target");
  }

  // ── gates that are not preferences ──
  if (input.angleStatus !== "selected") {
    return decline(`there is no selected angle (angle decision "${input.angleStatus}"), and the concept mode fails off`);
  }
  if (input.trendTookSlot) {
    const brandFit = trend?.brandFit;
    if (typeof brandFit !== "number" || brandFit < CONCEPT_MIN_BRAND_FIT) {
      return decline(`the story's brand fit ${brandFit ?? "(none)"} is under the ${CONCEPT_MIN_BRAND_FIT} grounding floor`);
    }
  } else {
    const briefFit = signals.briefFit;
    const fit = signals.angleFit;
    if (typeof briefFit !== "number" || briefFit < CONCEPT_MIN_BRAND_FIT) {
      return decline(`the angle's brief fit ${briefFit ?? "(none)"} is under the ${CONCEPT_MIN_BRAND_FIT} grounding floor`);
    }
    if (typeof fit !== "number" || fit < CONCEPT_MIN_ANGLE_FIT) {
      return decline(`the angle's fit ${fit ?? "(none)"} is under the ${CONCEPT_MIN_ANGLE_FIT} floor`);
    }
  }
  if (subjects.length === 0) {
    return decline("this client's brief yields no subject palette, so a concept has nothing of the client's own to be about");
  }
  if (!input.hasBrandColour) {
    return decline("this client has no accent colour or palette for a concept to be rendered in");
  }
  if (patterns.length === 0) {
    return decline("no concept pattern's precondition holds for this story");
  }

  // ── the story itself, which `"on"` may override ──
  if (!forced) {
    if (score < CONCEPT_MIN_SCORE) {
      return decline(`score ${score} is under the ${CONCEPT_MIN_SCORE} threshold`);
    }
    if (entities.length === 0) {
      return decline("the story's own sources name no organisation a reader would recognise");
    }
    if (postsSinceLastConcept !== null && postsSinceLastConcept < CONCEPT_COOLDOWN_POSTS) {
      return decline(
        `the last concept was ${postsSinceLastConcept === 0 ? "the most recent post" : `${postsSinceLastConcept} posts ago`}, inside the ${CONCEPT_COOLDOWN_POSTS}-post cooldown`,
      );
    }
    if (usedInWindow >= CONCEPT_MAX_IN_WINDOW) {
      return decline(`this account already ran ${usedInWindow} concepts in the last ${CONCEPT_WINDOW} posts, at the ceiling of ${CONCEPT_MAX_IN_WINDOW}`);
    }
  }

  return {
    eligible: true,
    score,
    threshold: CONCEPT_MIN_SCORE,
    terms,
    recognition,
    grounding,
    cooldown,
    patterns,
    subjects,
    mode,
    rule: `${ruleParts(score, entities, grounding, cooldown, forced).join(", ")} → eligible`,
  };
}

/** The `rule` sentence's clauses, in the `AngleScore.rule` house style: the arithmetic first, the verdict last. */
function ruleParts(
  score: number,
  entities: readonly string[],
  grounding: ConceptEligibility["grounding"],
  cooldown: ConceptEligibility["cooldown"],
  forced: boolean,
): string[] {
  const parts: string[] = [];
  parts.push(forced ? `score ${score} (bypassed by conceptMode "on")` : `score ${score} ${score >= CONCEPT_MIN_SCORE ? "≥" : "<"} ${CONCEPT_MIN_SCORE}`);
  parts.push(entities.length > 0 ? `entities(${entities.join(", ")})` : "entities(none)");
  if (grounding.basis === "trend") parts.push(`brandFit ${grounding.brandFit ?? "(none)"} ${(grounding.brandFit ?? 0) >= grounding.floor ? "≥" : "<"} ${grounding.floor}`);
  else parts.push(`briefFit ${grounding.briefFit ?? "(none)"}, angleFit ${grounding.angleFit ?? "(none)"}`);
  parts.push(
    cooldown.postsSinceLastConcept === null
      ? "no concept in the log"
      : `${cooldown.postsSinceLastConcept} posts since the last concept ${cooldown.postsSinceLastConcept >= cooldown.required ? "≥" : "<"} ${cooldown.required}`,
  );
  return parts;
}
