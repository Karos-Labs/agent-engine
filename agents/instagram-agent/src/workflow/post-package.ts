import { z } from "zod";
import type { AgentContext, AgentToolRegistry, GateVerdict } from "@agent-engine/core";
import { HEBREW_BANNED_PHRASES } from "./craft-hygiene.js";
import { resolveExpectedScript } from "./language-gate.js";
import type { RegisterCard, RegisterTermPair } from "./language-register.js";
import type { SlidesDataSelfCheck } from "./types.js";

/**
 * Instagram Phase 5 (RFC-18 §6): THE WHOLE POST.
 *
 * A carousel of eight PNGs and a caption has never had the parts of a post
 * that a reader and a screen reader actually meet: hashtags (today there are
 * NONE at all), alt text, a first comment carrying the sourcing, and a timing
 * constraint. This module is the typed shape of those parts, everything about
 * them a machine can decide for $0, and — the load-bearing half — the
 * boundary between what a model may author and what only code may build.
 *
 * ## The one structural decision this file exists to make
 *
 * **`firstComment.text` is written by the model. `firstComment.sources` is
 * built by CODE** (`buildFirstCommentSources`), from the fact cards the
 * SHIPPED slides' `sourceRef`s trace to. The packager's own output is not an
 * input to that function and cannot be: its parameters are the slides and the
 * run's fact cards, full stop.
 *
 * So an invented URL is **structurally unrepresentable, not merely
 * forbidden** — the same move Phase 4 made when it put `sourceRef`,
 * `stat.figure` and every `source` out of reach of the correction schema
 * (`native-corrections.ts`, rule 4). A prompt that says "do not invent URLs"
 * is a request. A builder that never reads the model's output is a guarantee,
 * and the guarantee costs nothing.
 *
 * `PostPackageSchema` carries the other half of it: the packager returns
 * PROSE ONLY. There is no `sources` field, no `url` field and nowhere for a
 * URL to legally sit, and `checkPackageRules` refuses one written into the
 * prose anyway.
 *
 * ## Everything here is free
 *
 * `checkPackageRules` is pure and synchronous — no tools, no model, no I/O.
 * `checkPostPackage` adds exactly two already-registered gates
 * (`gate.nativeLanguage`, `gate.lintPost`), both of which cost nothing. The
 * ordering doctrine is the workflow's own: every free rejection before any
 * paid one, and the paid re-ask (`08c-package-post-retry`) is bought only
 * after all of this has said no.
 *
 * ## Fail-open, whole
 *
 * Nothing in this module can hold a run. Every field it describes is
 * additive; a packager that does not complete leaves `post: undefined` and
 * the carousel ships exactly as it does today (RFC-18 §6.1). There is no
 * state in which the whole post costs us the post.
 */

// ─────────────────────────────────────────────────────────────────────────
// The packager's output contract — PROSE ONLY
// ─────────────────────────────────────────────────────────────────────────

/** RFC-18 §6.3: three to five, never zero. "Today there are no hashtags at all" is the defect this closes. */
export const MIN_HASHTAGS = 3;
export const MAX_HASHTAGS = 5;

/**
 * Instagram truncates alt text around here, and the field is READ ALOUD.
 * A 300-character alt is a screen-reader user listening to a paragraph
 * where they asked for a picture.
 */
export const ALT_TEXT_MAX_CHARS = 125;

/** Long enough for a sourced note, short enough that it is a comment and not a second caption. */
export const FIRST_COMMENT_MAX_CHARS = 600;

/** Past four, a first comment is a bibliography. The cards are ranked, so the cap keeps the best four. */
export const FIRST_COMMENT_MAX_SOURCES = 4;

/**
 * The platform's own tag grammar: letters, digits and underscore, in any
 * script. `\p{L}` and never `[A-Za-z]` — a Hebrew tag is a tag, and
 * `language-register.ts:614` already COUNTS the client's own Hebrew tags with
 * the same Unicode-property shape.
 *
 * Two is the floor because a one-character tag is not a search term; forty is
 * the ceiling because a concatenated multiword Hebrew concept is long and the
 * platform still indexes it.
 */
export const HASHTAG_GRAMMAR = /^[\p{L}\p{N}_]{2,40}$/u;

/**
 * Hebrew nikud and Arabic harakat.
 *
 * A pointed tag is a DIFFERENT STRING from the one anyone searches, so it is
 * a tag nobody will ever reach — and `gate.nativeLanguage` already treats
 * nikud as a finding in prose. Checked by its own rule, ahead of
 * `HASHTAG_GRAMMAR` (which would also reject it, since a combining mark is
 * neither `\p{L}` nor `\p{N}`), so the reason a reviewer reads names the
 * actual problem instead of "illegal character".
 */
const NIKUD = /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u064B-\u0652\u0670]/u;

/**
 * A hash that OPENS A TAG — `#` followed by a letter.
 *
 * Deliberately not a bare `#`: "#1 cause of walk-in failure" is ordinary
 * English and ordinary alt text, and a rule that refuses it is a
 * false-positive generator sitting in front of a re-ask we have to pay for.
 * What must not appear is a tag, because the tags are a typed field the
 * portal renders itself and the placement is decided in code.
 */
const TAG_HASH = /#\p{L}/u;

/**
 * A URL in prose, in the three shapes a model actually writes.
 *
 * The bare-domain arm is bounded to a TLD list rather than `\.\w+` so a
 * Hebrew sentence ending in an abbreviation is not read as a hostname.
 */
const URL_IN_PROSE = /(https?:\/\/|www\.|\b[\p{L}][\p{L}\p{N}-]*\.(?:com|net|org|io|ai|co|gov|edu|il|uk|de)\b)/iu;

/** Alt text that opens by announcing it is a picture. The field is ALREADY announced as an image; this is 12 wasted characters read aloud, every slide. */
const ALT_REDUNDANT_OPENERS: readonly string[] = [
  "image of",
  "an image of",
  "a image of",
  "picture of",
  "a picture of",
  "photo of",
  "a photo of",
  "photograph of",
  "a photograph of",
  "screenshot of",
  "a screenshot of",
  "graphic of",
  "illustration of",
  "an illustration of",
  // The same tell in Hebrew. A rule that only fires in English is a rule this
  // client segment does not have.
  "תמונה של",
  "צילום של",
  "איור של",
  "תצלום של",
];

/**
 * What the packager returns, and the whole of what it returns.
 *
 * No `sources`, no `url`, no `hashtagPlacement`, no `timing`. Each of those
 * is built in code from something the model cannot reach — the fact cards,
 * the register card's measurement, the dated claims — and every one of them
 * would be a place for the model to invent instead.
 *
 * `hashtags` are stored BARE, with no leading `#`: the portal prepends its
 * own (`asset-card.tsx:635`, `copy-caption-button.tsx:24`). LinkedIn's
 * fixture at `materialize.test.ts:278` stores them WITH the hash and
 * therefore double-hashes every tag in the UI today. Do not copy that.
 */
export const PostPackageSchema = z.object({
  hashtags: z.array(z.string().min(2).max(40)).min(MIN_HASHTAGS).max(MAX_HASHTAGS),
  altText: z
    .array(z.object({ n: z.number().int().min(1).max(8), alt: z.string().min(1).max(ALT_TEXT_MAX_CHARS) }))
    .min(1)
    .max(8),
  /** Prose only. The model never writes a URL, and there is nowhere in this schema for one to go. */
  firstCommentText: z.string().min(1).max(FIRST_COMMENT_MAX_CHARS),
});
export type PostPackage = z.infer<typeof PostPackageSchema>;

/** One sourced line of the first comment. Built by `buildFirstCommentSources` and by nothing else. */
export interface FirstCommentSource {
  /** `"<source>, <date>"` — the human attribution the card already carries, never a re-worded one. */
  readonly label: string;
  readonly url: string;
}

/** Where the tags go. Decided from the client's OWN measured behaviour, never from the model (§6.3 decision 2). */
export type HashtagPlacement = "caption" | "firstComment";

/** `08c3`'s output: the one thing about publishing time the engine knows and the portal cannot compute. */
export interface PostTimingNote {
  readonly basis: "event-dated" | "evergreen";
  /** ISO 8601. Present on `event-dated` only. */
  readonly staleAfter?: string;
  readonly reason: string;
}

// ─────────────────────────────────────────────────────────────────────────
// The inputs these builders read — structural, so a fixture is a literal
// ─────────────────────────────────────────────────────────────────────────

/**
 * A shipped slide, as this module reads it.
 *
 * Structural rather than `InstagramSlideCopy` on purpose: everything here
 * needs is the number, the headline it must not duplicate, and the
 * `sourceRef` that traces to a card. A narrower read is a narrower blast
 * radius, and it means a test fixture is three fields instead of eight.
 */
export interface PackagedSlide {
  readonly n: number;
  readonly headline: string;
  /** A step-04 fact's `claim`, VERBATIM — `checkSlidesData` has already proven that by the time this runs. */
  readonly sourceRef: string;
}

/** A fact card, as this module reads it. `ResearchFact` and `FactCardForPrompt` both satisfy it. */
export interface PackagedFactCard {
  readonly claim: string;
  readonly source: string;
  readonly date: string;
  readonly url?: string | undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// buildFirstCommentSources — the structural guarantee
// ─────────────────────────────────────────────────────────────────────────

/**
 * The first comment's sources, built from the SHIPPED SLIDES and the RUN'S
 * FACT CARDS. The model's output is not a parameter.
 *
 * That is the whole design. `checkSlidesData` has already proven every
 * slide's `sourceRef` matches some fact card's `claim` verbatim, so the
 * mapping is a lookup rather than a judgment, and the URL that reaches a
 * reader is one that reached us from research. An invented URL is not
 * refused here; it has no way in.
 *
 * Ordering is SLIDE ORDER — the order the reader met the claims — and never
 * the fact-card array's own, which is research-extraction order and means
 * nothing to a reader. Deduped by URL, because two slides resting on the same
 * study is normal and two identical lines in a comment is not. Capped at
 * `FIRST_COMMENT_MAX_SOURCES`.
 *
 * A card with no `url` is silently absent: the label alone would be a
 * citation a reader cannot follow, and this comment exists precisely so the
 * carousel's sourcing becomes FOLLOWABLE. `fact-cards.ts:241` already ranks a
 * card that carries a url above one that does not, so the cards most likely
 * to be cited are the ones most likely to survive this.
 */
export function buildFirstCommentSources(
  slides: readonly PackagedSlide[],
  factCards: readonly PackagedFactCard[],
): FirstCommentSource[] {
  const byClaim = new Map<string, PackagedFactCard>();
  for (const card of factCards) {
    // First card wins: `dedupeFactCards` has already chosen which of two
    // same-claim cards is the stronger one, and it is the one it kept.
    if (!byClaim.has(card.claim)) byClaim.set(card.claim, card);
  }

  const out: FirstCommentSource[] = [];
  const seen = new Set<string>();
  for (const slide of slides) {
    const card = byClaim.get(slide.sourceRef);
    const url = card?.url?.trim();
    if (card === undefined || url === undefined || url.length === 0) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ label: `${card.source.trim()}, ${card.date.trim()}`, url });
    if (out.length >= FIRST_COMMENT_MAX_SOURCES) break;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// resolveHashtagPlacement — the honest use of a measurement
// ─────────────────────────────────────────────────────────────────────────

/**
 * Where this client's tags go, from what this client's own feed actually
 * does (RFC-18 §6.3, decision 2).
 *
 * `language-register.ts:128` MEASURES `hashtagsPerPost` from the client's
 * recent posts, counted at `:614` with `/(?:^|\s)#[\p{L}\p{N}_]+/gu`. An
 * account whose own posts never carry a tag does not suddenly acquire a tag
 * block under its caption — the tags go in the first comment, where they
 * still work and still reach the portal's chip row and its Copy button.
 *
 * **The measurement decides PLACEMENT, never EXISTENCE.** Tags are always
 * authored, 3 to 5. A measured zero is evidence about where this account puts
 * them, not evidence that this account should have none; and the previous
 * escape hatch (`latest.md:53`, "unless the client's own style config asks")
 * pointed at a field that does not exist anywhere in `karos-client`, so it
 * has never once fired.
 *
 * No measurement at all means the corpus was empty — a fact about the scrape,
 * not about the client (`RegisterCard.measured`'s own comment) — so it
 * decides nothing and the platform default stands.
 */
export function resolveHashtagPlacement(register: Pick<RegisterCard, "measured"> | undefined): HashtagPlacement {
  const measured = register?.measured;
  if (measured === undefined) return "caption";
  return measured.hashtagsPerPost === 0 ? "firstComment" : "caption";
}

// ─────────────────────────────────────────────────────────────────────────
// buildTimingNote — 08c3, $0, no model
// ─────────────────────────────────────────────────────────────────────────

/** A claim this fresh makes the post news; past it, the post is a topic. */
export const EVENT_DATED_WINDOW_DAYS = 7;

/** How long a news hook stays a news hook. Three days, after which the post still reads but the "this just happened" framing does not. */
export const STALE_AFTER_HOURS = 72;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether this post perishes, and when.
 *
 * **Deliberately NOT an authored publishing timestamp.** The portal already
 * computes one and computes it better: `PLATFORM_SCHEDULES.instagram` has two
 * weekday windows, `recommendPublishTimeWithDensity` respects `MAX_PER_DAY`
 * and a 90-minute gap against the client's BOOKED assets, and it is already
 * applied to every agent-engine asset at `materialize.ts:993`. The engine
 * cannot see that calendar, and an engine-authored timestamp would be a worse
 * number competing with a better one.
 *
 * What the engine alone knows is PERISHABILITY. The portal keeps owning the
 * slot; this tells it the one thing it could not compute. (RFC-18 §6.4 — a
 * partial, deliberate decline of plan item 3.)
 *
 * The FRESHEST dated card in the window decides it, not the earliest: the
 * freshest claim is the one that makes the post read as news, so it is the
 * one whose staleness the hook actually rides on. A `staleAfter` already in
 * the past is a legitimate answer and is reported as one — the post rests on
 * a five-day-old claim and the hook has already gone off.
 *
 * A `date` this cannot parse is not a dated claim as far as this function is
 * concerned. Fact-card dates are free text ("2026-09-01", "September 2026",
 * "Q3"), and guessing at one would put a fabricated constraint on a real
 * calendar.
 */
export function buildTimingNote(factCards: readonly PackagedFactCard[], now: Date = new Date()): PostTimingNote {
  const nowMs = now.getTime();
  let freshest: { card: PackagedFactCard; at: number } | undefined;

  for (const card of factCards) {
    const at = Date.parse(card.date.trim());
    if (!Number.isFinite(at)) continue;
    // Within the window looking BACK, and any date in the future — an
    // announced event that has not happened yet is the most perishable hook
    // there is.
    if (nowMs - at > EVENT_DATED_WINDOW_DAYS * DAY_MS) continue;
    if (freshest === undefined || at > freshest.at) freshest = { card, at };
  }

  if (freshest === undefined) {
    return { basis: "evergreen", reason: "no dated claim — no timing constraint" };
  }

  const staleAfter = new Date(freshest.at + STALE_AFTER_HOURS * 60 * 60 * 1000).toISOString();
  return {
    basis: "event-dated",
    staleAfter,
    reason: `rests on ${freshest.card.source.trim()}, ${freshest.card.date.trim()}; the hook goes stale after that`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// The free checks — 08c1, $0, pure
// ─────────────────────────────────────────────────────────────────────────

/**
 * A tag's script GROUPS, for the intra-tag mixing rule.
 *
 * Japanese is Han + Hiragana + Katakana at once and Korean mixes Hangul with
 * Han, so those are ONE group: treating them as several would refuse ordinary
 * Japanese tags. A letter belonging to no listed group is ignored rather than
 * counted as a group of its own — the house asymmetry, applied here too: a
 * script this list has never heard of must degrade to "no opinion", never to
 * "refuse every tag this client writes".
 */
const SCRIPT_GROUPS: ReadonlyArray<{ readonly name: string; readonly test: RegExp }> = [
  { name: "Latin", test: /\p{Script=Latin}/u },
  { name: "Hebrew", test: /\p{Script=Hebrew}/u },
  { name: "Arabic", test: /\p{Script=Arabic}/u },
  { name: "Cyrillic", test: /\p{Script=Cyrillic}/u },
  { name: "Greek", test: /\p{Script=Greek}/u },
  { name: "Devanagari", test: /\p{Script=Devanagari}/u },
  { name: "Thai", test: /\p{Script=Thai}/u },
  { name: "Armenian", test: /\p{Script=Armenian}/u },
  { name: "Georgian", test: /\p{Script=Georgian}/u },
  { name: "CJK", test: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u },
];

/** Every script group a string's LETTERS belong to. Digits and underscore belong to none and are invisible here. */
function scriptGroupsOf(text: string): string[] {
  const found: string[] = [];
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    const group = SCRIPT_GROUPS.find((g) => g.test.test(ch));
    if (group && !found.includes(group.name)) found.push(group.name);
  }
  return found;
}

/** Case-folded, NFC-normalised, stripped to tag grammar — the form two tags are "the same tag" in, and the form a `coreTerm` becomes a tag in. */
function tagKey(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]/gu, "");
}

/** RFC-18 §6.3 decision 4: at most two of five, on a non-Latin target. */
export const MAX_LATIN_TAGS_FOR_NON_LATIN_TARGET = 2;

/** Everything the free package checks read. Every field is something already computed earlier in the run. */
export interface PostPackageCheckInput {
  readonly pkg: PostPackage;
  /** The SHIPPED slides — alt text is required for each, and none may simply restate its headline. */
  readonly slides: readonly PackagedSlide[];
  /** `brief.coreTerms`: already lowercase and hashtag-free. At least one tag must come from here. */
  readonly coreTerms: readonly string[];
  /** `languageBrief.terms.allowedLatinTerms` — the SAME per-client list that governs which English words stay English in prose. */
  readonly allowedLatinTerms?: readonly string[];
  /** The run's resolved target language, or `undefined` for an English/no-target client. */
  readonly targetLanguage?: string | undefined;
}

/**
 * RFC-18 §6.3 and §6.4, in code: everything about the whole post a machine
 * can decide, decided for $0 before any re-ask is paid for.
 *
 * Pure and synchronous. The two gate calls live in `checkPostPackage`, which
 * runs this first — every free rejection before any other work, the
 * workflow's own ordering doctrine.
 *
 * Order within the hashtag rules is chosen so the REASON names the real
 * problem: the leading-`#` rule and the nikud rule both sit ahead of
 * `HASHTAG_GRAMMAR`, which would reject either of them anyway with a message
 * that says nothing a packager could act on.
 */
export function checkPackageRules(input: PostPackageCheckInput): SlidesDataSelfCheck {
  const { pkg, slides, coreTerms } = input;

  // ── Hashtags ──────────────────────────────────────────────────────────
  if (pkg.hashtags.length < MIN_HASHTAGS || pkg.hashtags.length > MAX_HASHTAGS) {
    return { ok: false, reason: `the post carries ${pkg.hashtags.length} hashtags; it must carry ${MIN_HASHTAGS} to ${MAX_HASHTAGS}` };
  }

  const seenTags = new Set<string>();
  for (const tag of pkg.hashtags) {
    if (tag.startsWith("#")) {
      return { ok: false, reason: `hashtag "${tag}" carries a leading "#" — tags are stored BARE and the portal prepends its own` };
    }
    if (NIKUD.test(tag)) {
      return { ok: false, reason: `hashtag "${tag}" carries nikud — a pointed tag is a different string from the one anyone searches` };
    }
    if (!HASHTAG_GRAMMAR.test(tag)) {
      return { ok: false, reason: `hashtag "${tag}" is not a legal tag: letters, digits and underscore only, 2 to 40 characters` };
    }
    const groups = scriptGroupsOf(tag);
    if (groups.length > 1) {
      return { ok: false, reason: `hashtag "${tag}" mixes ${groups.join(" and ")} within one tag; a tag is written in one script` };
    }
    const key = tagKey(tag);
    if (seenTags.has(key)) {
      return { ok: false, reason: `hashtag "${tag}" repeats an earlier tag after case folding` };
    }
    seenTags.add(key);
  }

  // Derivation, not invention (§6.3). At least one tag has to come from the
  // client's OWN vocabulary, which is what stops a post about a kitchen
  // servicer from inheriting a reference account's subject matter with a "#"
  // in front of it. Containment in either direction: "restaurants" is
  // derived from the core term "restaurant", and so is "kitchenequipment"
  // from "kitchen equipment".
  const coreKeys = coreTerms.map(tagKey).filter((k) => k.length >= 3);
  const tagKeys = pkg.hashtags.map(tagKey);
  const hasCoreTerm = coreKeys.length === 0 || tagKeys.some((t) => coreKeys.some((c) => t.includes(c) || c.includes(t)));
  if (!hasCoreTerm) {
    return {
      ok: false,
      reason: `no hashtag is derived from this client's own core terms (${coreTerms.slice(0, 6).join(", ")}) — tags are derived from the brief, never invented`,
    };
  }

  // §6.3 decision 4: Latin tags on a non-Latin target are a bounded, named
  // exception, not a reach strategy. A Hebrew audience does not search in
  // English, and a tag nobody searches is decoration.
  const expected = input.targetLanguage ? resolveExpectedScript(input.targetLanguage) : undefined;
  if (expected !== undefined && expected.name !== "Latin") {
    const allowedKeys = new Set([...(input.allowedLatinTerms ?? []).map(tagKey), ...coreKeys]);
    const latin = pkg.hashtags.filter((tag) => scriptGroupsOf(tag).includes("Latin"));
    if (latin.length > MAX_LATIN_TAGS_FOR_NON_LATIN_TARGET) {
      return {
        ok: false,
        reason:
          `${latin.length} of ${pkg.hashtags.length} hashtags are Latin-script for a ${expected.name}-script client ` +
          `(${latin.join(", ")}); at most ${MAX_LATIN_TAGS_FOR_NON_LATIN_TARGET} may be`,
      };
    }
    const unsanctioned = latin.find((tag) => {
      const key = tagKey(tag);
      return ![...allowedKeys].some((allowed) => key === allowed || key.includes(allowed) || allowed.includes(key));
    });
    if (unsanctioned !== undefined) {
      return {
        ok: false,
        reason: `Latin-script hashtag "${unsanctioned}" is not on this client's allowedLatinTerms or coreTerms, so it has no reason to be in Latin letters`,
      };
    }
  }

  // ── Alt text ──────────────────────────────────────────────────────────
  const altByN = new Map<number, string>();
  for (const entry of pkg.altText) {
    if (altByN.has(entry.n)) return { ok: false, reason: `slide ${entry.n} has two alt texts` };
    altByN.set(entry.n, entry.alt);
  }
  for (const slide of slides) {
    const alt = altByN.get(slide.n);
    if (alt === undefined || alt.trim().length === 0) {
      return { ok: false, reason: `slide ${slide.n} has no alt text — every slide a reader can see needs one a reader who cannot can hear` };
    }
    if (alt.length > ALT_TEXT_MAX_CHARS) {
      return { ok: false, reason: `slide ${slide.n}'s alt text is ${alt.length} characters, past the ${ALT_TEXT_MAX_CHARS}-character cap` };
    }
    if (tagKey(alt) === tagKey(slide.headline)) {
      return {
        ok: false,
        reason: `slide ${slide.n}'s alt text only restates its headline — alt text describes what the picture shows, and the headline is already on the plate`,
      };
    }
    const opener = ALT_REDUNDANT_OPENERS.find((o) => alt.trim().toLowerCase().startsWith(o));
    if (opener !== undefined) {
      return { ok: false, reason: `slide ${slide.n}'s alt text opens with "${opener}" — the field is already announced as an image and those characters are read aloud` };
    }
    if (URL_IN_PROSE.test(alt)) {
      return { ok: false, reason: `slide ${slide.n}'s alt text carries a URL; alt text is read aloud and a URL is unreadable` };
    }
    if (TAG_HASH.test(alt)) {
      return { ok: false, reason: `slide ${slide.n}'s alt text carries a hashtag; the tags are a typed field and their placement is decided in code` };
    }
  }
  for (const n of altByN.keys()) {
    if (!slides.some((slide) => slide.n === n)) {
      return { ok: false, reason: `alt text was written for slide ${n}, which is not in the shipped carousel` };
    }
  }

  // ── First comment ─────────────────────────────────────────────────────
  const comment = pkg.firstCommentText;
  if (comment.trim().length === 0) return { ok: false, reason: "the first comment is empty" };
  if (comment.length > FIRST_COMMENT_MAX_CHARS) {
    return { ok: false, reason: `the first comment is ${comment.length} characters, past the ${FIRST_COMMENT_MAX_CHARS}-character cap` };
  }
  if (URL_IN_PROSE.test(comment)) {
    // The load-bearing one. The sources are built in code from the run's own
    // fact cards; a URL in the model's prose is a URL nothing verified, and
    // it would sit beside four that were.
    return {
      ok: false,
      reason: "the first comment's prose carries a URL — the packager writes prose only, and the source links are built in code from this run's fact cards",
    };
  }
  if (TAG_HASH.test(comment)) {
    return { ok: false, reason: "the first comment carries a hashtag; the tags are a typed field and their placement is decided in code" };
  }

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────
// The package's prose, as the language machinery sees it
// ─────────────────────────────────────────────────────────────────────────

/**
 * Every judged field of the package, with the id a correction anchors to.
 *
 * `comment` and `alt-3` — the same shape as `languageGateFields`' `caption`
 * and `slide-3.headline`, and the vocabulary `native-corrections.ts` resolves
 * back to a field. One vocabulary, two contexts (RFC-18 §6.5).
 *
 * **Hashtags are deliberately absent.** Phase 4's correction contract is
 * span-based (an exact substring, 1-240 chars), and a one-word tag has no
 * span to anchor a correction into; a judge asked about tags would produce
 * findings the parser and then the patcher would discard anyway. The tag
 * rules above are deterministic and free, which is the correct instrument for
 * them — and `checkPackageRules` has already run by the time anything is
 * paid for.
 */
export function packageLanguageGateFields(pkg: PostPackage): Array<{ id: string; text: string }> {
  const fields: Array<{ id: string; text: string }> = [];
  if (pkg.firstCommentText.trim().length > 0) fields.push({ id: "comment", text: pkg.firstCommentText });
  for (const entry of pkg.altText) {
    if (entry.alt.trim().length > 0) fields.push({ id: `alt-${entry.n}`, text: entry.alt });
  }
  return fields;
}

/** The package's prose as one string, for an aggregate script check. Tags excluded, for `packageLanguageGateFields`' reason. */
export function packageLanguageGateText(pkg: PostPackage): string {
  return packageLanguageGateFields(pkg)
    .map((f) => f.text)
    .join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────
// checkPostPackage — the free rules plus the two free gates
// ─────────────────────────────────────────────────────────────────────────

/** `gate.lintPost` names a failing continuation part as "thread part K: …" with K = 2 for `parts[0]`. */
const THREAD_PART_PREFIX = /^thread part (\d+): /;

/** What `checkPostPackage` needs beyond the free rules, to run `gate.nativeLanguage` the way `07e2` runs it. */
export interface PostPackageGateInput extends PostPackageCheckInput {
  /**
   * The literal `\p{Script=Xxxx}` pattern from `SCRIPT_TABLE`, or
   * `undefined`. Constrained to that exact form and re-validated inside the
   * tool, so a caller that cannot produce it must not call the gate at all —
   * `SCRIPT_TABLE`'s Japanese and Korean rows are alternations and get no
   * native-language gate rather than a guessed pattern.
   */
  readonly scriptPattern?: string | undefined;
  readonly scriptName?: string | undefined;
  readonly forbiddenTransliterations?: readonly RegisterTermPair[];
}

/**
 * `08c1-package-checks`: all of §6.5's free half, in one call.
 *
 * 1. `checkPackageRules` — the hashtag grammar and script rules, the alt-text
 *    rules, the first comment's prose-only rule. Pure, and first, because it
 *    is the cheapest thing here and because its reasons are the most specific.
 * 2. `gate.nativeLanguage` over every package prose field — per-field script
 *    coverage, transliterations, nikud, foreign digits, curly quotes, bidi
 *    control characters. All of which apply to a Hebrew alt text exactly as
 *    they apply to a headline.
 * 3. `gate.lintPost` over `firstCommentText` as `text` and the alt texts as
 *    `parts` — one call, not N, and a failing part is named by its slide.
 *
 * Both gates are FREE, and both degrade to "no opinion" when they cannot run:
 * a missing tool (~30 partial test registries), a non-success outcome, or a
 * `tooling_error` verdict. There is no spend here to justify failing a draft
 * over a gate that could not form a view — `07e2`'s posture exactly.
 *
 * A `content_fail` from any of the three is a real refusal, and the caller
 * turns it into ONE re-ask under a DISTINCT step id
 * (`08c-package-post-retry`), because `step.agent` replays a checkpointed
 * `content_fail` and a re-call under the same id returns the first failure
 * without touching the model. Then it ships whatever survives with the
 * failing field dropped. **Nothing is ever thrown on any path through this
 * module** — not `WorkflowHeld` and not `WorkflowToolingFailure`. The only two
 * values it can produce are "the package is fine" and "the package is not, and
 * here is the reason a re-ask gets to read".
 */
export async function checkPostPackage(
  tools: AgentToolRegistry,
  ctx: AgentContext,
  input: PostPackageGateInput,
): Promise<SlidesDataSelfCheck> {
  const rules = checkPackageRules(input);
  if (!rules.ok) return rules;

  const fields = packageLanguageGateFields(input.pkg);

  const nativeGate = tools["gate.nativeLanguage"];
  if (nativeGate !== undefined && input.targetLanguage && input.scriptName && input.scriptPattern && fields.length > 0) {
    const outcome = await nativeGate.execute(
      {
        language: input.targetLanguage,
        scriptName: input.scriptName,
        scriptPattern: input.scriptPattern,
        fields,
        allowedLatinTerms: input.allowedLatinTerms ?? [],
        forbiddenTransliterations: input.forbiddenTransliterations ?? [],
      },
      { ctx },
    );
    if (outcome.status === "success") {
      const verdict = outcome.result as GateVerdict;
      if (verdict.verdict === "content_fail") {
        return { ok: false, reason: `the post package failed the deterministic ${input.targetLanguage} conventions gate: ${verdict.reason}` };
      }
    }
  }

  const lintTool = tools["gate.lintPost"];
  if (lintTool === undefined) {
    // Unlike `checkCraftHygiene`, which throws: that gate runs inside the
    // drafting loop on copy that must not ship unchecked, and its absence is
    // a wiring bug. This one runs after the loop has already broken, on
    // additive fields whose whole failure mode is "the post ships without
    // them". Throwing here would turn a missing tool into a lost package.
    return { ok: true };
  }

  const altTexts = input.pkg.altText.map((entry) => entry.alt);
  const lintOutcome = await lintTool.execute(
    // The same Hebrew supplement `checkCraftHygiene` passes, for the same
    // reason: the first comment is where a lazy ask goes when the caption is
    // clean, and `gate.lintPost`'s own bank cannot see a Hebrew one. Shared
    // constant so the caption's bar and the first comment's bar cannot drift.
    { text: input.pkg.firstCommentText, parts: altTexts, platform: "instagram", checkAntiSlop: true, maxExclamationMarks: 0, bannedPhrases: [...HEBREW_BANNED_PHRASES] },
    { ctx },
  );
  // A non-success outcome is the same "no opinion" as a missing tool, and for
  // the same reason `checkCraftHygiene` — which DOES throw here — is the wrong
  // precedent: that gate runs inside the drafting loop on copy that must not
  // ship unchecked, so an outage there is a wiring failure worth stopping for.
  // This one runs after the loop has already broken, on additive fields whose
  // whole failure mode is "the post ships without them". A thrown
  // `WorkflowToolingFailure` out of `08c1` would take a run that already has an
  // approved, gated, rendered carousel and end it on a lint outage — the exact
  // state RFC-18 §6.1 says cannot exist ("there is no state in which the whole
  // post costs us the post").
  if (lintOutcome.status !== "success") return { ok: true };
  const verdict = lintOutcome.result as GateVerdict;
  // Same posture as `07e2`: a gate that could not form a view has not refused.
  if (verdict.verdict === "tooling_error") return { ok: true };
  if (verdict.verdict === "content_fail") {
    const part = THREAD_PART_PREFIX.exec(verdict.reason);
    if (part) {
      const entry = input.pkg.altText[Number(part[1]) - 2];
      return { ok: false, reason: `slide ${entry?.n ?? "?"}'s alt text failed the post lint: ${verdict.reason.slice(part[0].length)}` };
    }
    return { ok: false, reason: `the first comment failed the post lint: ${verdict.reason}` };
  }

  return { ok: true };
}
