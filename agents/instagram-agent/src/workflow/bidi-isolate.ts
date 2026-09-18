/**
 * Unicode bidi ISOLATES for Latin/digit runs embedded in right-to-left copy
 * (RFC-15 §7.3, Phase 4 — plan item 3, "bidi for Latin terms embedded in
 * Hebrew").
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────
 *
 * Today the only bidi isolation anywhere in this agent is the templates'
 * `<bdi dir="ltr">{{brandHandle}}</bdi>` furniture. A Latin technical term
 * inside Hebrew body copy has none, so the Unicode Bidirectional Algorithm
 * resolves the neutrals AROUND it against the paragraph's RTL embedding
 * level and:
 *
 *   - `…השיק את Gemini 3.`   puts the full stop on the wrong side of the line
 *   - `(GPT-4)`              mirrors its brackets around the Latin run
 *   - `2020-2024`            reads back to front next to Hebrew words
 *
 * The fix is one isolate per ADJACENT RUN of Latin/digit tokens, never one
 * per token — see `markedOrForeignPattern` for why per-token isolation is worse
 * than no isolation at all.
 *
 * None of that is a font problem, a template problem or a copy problem — the
 * model wrote the right string and the reader sees the wrong one.
 *
 * ── WHY ISOLATES AND NOT `<bdi>` ─────────────────────────────────────────
 *
 * - Copy fields reach a template through the ESCAPED `{{key}}` substitution
 *   form; there is no raw form for them, and the privileged `{{html:...}}`
 *   slots are a closed set (`["device","recap","itemRows"]`) enforced by
 *   Template Studio gate 3. **The markup channel is unavailable**, and
 *   opening one for copy would be a new injection surface for exactly the
 *   model-authored strings the escaped channel exists to contain.
 * - U+2068/U+2069 are ordinary characters as far as HTML escaping is
 *   concerned, so they survive `fillTemplate` untouched and need no new
 *   privileged slot.
 * - They reach EVERY archetype at once, including device labels and
 *   model-authored `customArchetype.fields` values, which markup wrapping
 *   would have to reach one slot at a time.
 * - They are `\p{Cf}` format characters, NOT `\p{L}`, so `checkExpectedScript`
 *   (`language-gate.ts`) counts exactly the same letters with them present as
 *   without, and `detectDirection` is likewise untouched. That is what lets
 *   this run on the RENDERED copy while every gate keeps reading the model's
 *   original — see `contentFor` in `slides-data.ts` for the scope rule.
 *
 * FSI (First Strong Isolate) rather than LRI: FSI takes the direction from
 * the run's own first strong character, so a run that is in fact digits-only
 * or punctuation-led is not forced into a direction it does not have.
 *
 * Model/cost: none. Gate: none. Pure string functions.
 */

/** U+2068 FIRST STRONG ISOLATE — opens a run whose direction is read from its own first strong character. */
export const FSI = "⁨";
/** U+2069 POP DIRECTIONAL ISOLATE — closes the innermost open isolate. */
export const PDI = "⁩";

/**
 * One foreign (Latin/digit) TOKEN: the unbroken piece, no spaces.
 *
 * Greedy on the INSIDE so that `gpt-4o`, `api.stripe.com` and `50%` each stay
 * one piece. Anchored at both ends on an alphanumeric (or `%`) so a trailing
 * sentence period, comma or closing bracket stays OUTSIDE and keeps taking
 * the paragraph's own direction, which is what puts it on the correct side of
 * the line.
 * ── THE COMMA IS IN THE INSIDE CLASS, AND LEAVING IT OUT REVERSED NUMBERS. ──
 *
 * Geektime's prep slide 6 printed `מול 500,1 מפתחים` where the draft said
 * `מול 1,500 מפתחים`. Without the comma, `1,500` is not one token: `1` matches
 * alone, is one character, and falls under `MIN_ISOLATED_RUN_CHARS`, so it
 * ships bare — while `500` matches separately and IS isolated. An FSI..PDI
 * sequence is opaque to the bidi algorithm by design, which is the whole
 * reason this module uses it, so UAX#9's W4 (EN CS EN collapses to one
 * number) can no longer see across the boundary. The two halves become
 * separate runs and RTL order puts them back the wrong way round.
 *
 * So the isolation CAUSED the defect. Plain bidi renders `1,500` correctly in
 * a Hebrew paragraph, and this module broke it by cutting the number in half.
 * The end anchor still keeps a SENTENCE comma outside, because a token may
 * not end on one.
 */
const FOREIGN_TOKEN = String.raw`[A-Za-z0-9](?:[A-Za-z0-9.,@/&+#'’_-]*[A-Za-z0-9%])?`;

/**
 * One foreign RUN: a maximal sequence of foreign tokens separated by SINGLE
 * SPACES.
 *
 * ── WHY THE SPACE IS IN HERE, AND WHY LEAVING IT OUT WAS A REGRESSION ────
 *
 * The first cut of this module matched tokens only, so `API v2` became two
 * isolates — `⁨API⁩ ⁨v2⁩` — and a multi-token Latin phrase inside Hebrew
 * rendered BACKWARDS. That is strictly worse than doing nothing at all:
 * `API v2`, `Gemini 3`, `S&P 500` and `iPhone 17 Pro Max` all render
 * correctly with no isolation whatsoever, and reversed once each token is
 * isolated on its own.
 *
 * UAX#9 is why. An FSI..PDI sequence is OPAQUE to the isolating run sequence
 * that contains it: rule X6a replaces the whole isolate with a neutral, so
 * `⁨API⁩ ⁨v2⁩` between two Hebrew runs resolves as ON-ON-ON, N1 gives all
 * three the surrounding R direction, I1 leaves them at the paragraph's odd
 * level 1, and L2 reverses them — the reader sees `v2 API`. Unisolated, the
 * same phrase is L, neutral, L (the `2` picks up L from W7's last-strong
 * rule), N1 makes the space L, the whole phrase sits at level 2 and displays
 * in logical order. **One isolate per adjacent run, not one per token**, is
 * what preserves both the inner order and the outer placement.
 *
 * Single-character tokens are ABSORBED when they sit inside such a run —
 * `Gemini 3` is one isolate — but a run that is a lone character all by
 * itself is left bare: a single character has nothing to reorder against
 * itself, and wrapping every stray digit would double the character count of
 * a numeral-heavy stat line for nothing. That is the `length >= 2` test in
 * `isolateForeignRuns`, not a second alternative in the pattern, because the
 * decision is about the whole match and regexes are bad at saying so.
 *
 * Built per call rather than held at module scope: a `g`-flagged regex
 * carries `lastIndex` across calls, which is a classic source of
 * every-other-call misses (`visual-qa-pre-checks.ts` records the same rule).
 */

/**
 * A marked token: a hashtag or a handle, in ANY script.
 *
 * ## The defect
 *
 * Geektime's prep cover of 2026-09-18 printed `#תוכן מקודם הוא לא פרט שולי.`
 * with the `#` at the far LEFT of the line, detached from the word it marks.
 * `#` is a bidi NEUTRAL: it has no direction of its own and takes one from
 * whatever sits around it, which at a line boundary is not the word it belongs
 * to.
 *
 * Every template already wraps the `@handle` slot in a `<bdi>` and its comment
 * says why, in these words: *"an @handle, a URL and a #hashtag are LTR strings
 * whose leading character is a bidi neutral"*. The handle is a slot and got
 * the fix. A hashtag arrives inside the COPY and never did.
 *
 * ## Why FSI and not LRI
 *
 * The comment above is half right: a hashtag is not always an LTR string.
 * `#תוכן` is a Hebrew word with a marker in front of it, and forcing it LTR
 * would reverse the word in order to fix the marker. FSI takes the direction
 * from the token's own first strong character, so `#RoadToIPO` stays LTR and
 * `#תוכן` stays RTL, and in both cases the marker travels with its word.
 */
const MARKED_TOKEN = String.raw`[#@][\p{L}\p{N}_][\p{L}\p{N}_.\u2019'-]*`;

function markedOrForeignPattern(): RegExp {
  return new RegExp(`${MARKED_TOKEN}|${FOREIGN_TOKEN}(?: ${FOREIGN_TOKEN})*`, "gu");
}

/**
 * A run has to be at least this long to be worth an isolate. One character
 * cannot be misordered against itself.
 */
const MIN_ISOLATED_RUN_CHARS = 2;

/**
 * Wrap each Latin/digit run of `text` in FSI…PDI, for a carousel that renders
 * right-to-left. A NO-OP for `"ltr"` — an LTR document's Latin runs are
 * already at the paragraph direction and isolating them would add invisible
 * characters to every English post for no effect at all.
 *
 * Caller contract, stated here because it is the whole safety argument: this
 * is applied to RENDERED SLIDE TEXT ONLY, at composition time, and never to
 * anything a gate reads or anything that is published as text (the caption,
 * `sourceRef`, `checkCraftHygiene`'s input, the dedupe corpus, the language
 * judge's fields). See `slides-data.ts`'s `contentFor`.
 */
export function isolateForeignRuns(text: string, dir: "rtl" | "ltr"): string {
  if (dir !== "rtl") return text;
  if (text.length === 0) return text;
  // ONE pass, with the marked token as the first alternative. Two passes do
  // not work and the first draft of this proved it: the marked pass wraps
  // `#RoadToIPO`, and the foreign pass then matches `RoadToIPO` inside it and
  // wraps it again, which produces a nested isolate around a marker that is
  // now separated from its word by an isolate boundary. The same defect,
  // moved. A single alternation cannot double-wrap because a match consumes
  // its own text.
  return text.replace(markedOrForeignPattern(), (match) =>
    /^[#@]/u.test(match) || match.length >= MIN_ISOLATED_RUN_CHARS ? `${FSI}${match}${PDI}` : match,
  );
}

/** Strip every isolate this module inserts — for a test, a log line or a trace that wants the model's own bytes back. */
export function stripIsolates(text: string): string {
  return text.replace(/[⁨⁩]/g, "");
}
