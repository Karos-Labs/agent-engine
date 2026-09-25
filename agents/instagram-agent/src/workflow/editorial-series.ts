import type { InstagramSlideCopy } from "./types.js";

/**
 * RFC-21 Part 3 — THE SERIES LAYER. The story picks the series; the series
 * picks the composition.
 *
 * ## The ruling this implements
 *
 * The owner, 2026-09-14: at run time the model does **not** author HTML/CSS
 * from scratch. It performs **dynamic composition from validated building
 * blocks** — slot-based assembly of typography and surfaces that have each
 * passed validation. A genuinely new archetype is saved as a CANDIDATE for CI
 * calibration and never goes straight to production.
 *
 * ## Why a SERIES rather than a better per-slide menu
 *
 * The original audit finding was eight fixed archetypes, identical for every
 * client. The fix that suggests itself is more archetypes, and it is the wrong
 * one: `instagram-copy@18` §7 already hands the writer a nine-item menu and
 * asks it to "pick the archetype the content already is", slide by slide. That
 * produces variety WITHIN a carousel and none at all ACROSS runs, because the
 * same prompt, the same menu and a similar story pick a similar sequence every
 * week. `skeleton-memory.ts` exists precisely because that happened; it can
 * refuse a repeat but it cannot propose an alternative.
 *
 * The reference feed the owner supplied solves it a different way, and it is
 * the shape this module copies — the SHAPE, never the content. That account
 * runs NAMED EDITORIAL SERIES, and the series is the archetype: each one
 * carries its own layout family over ONE shared brand system. Variety comes
 * from the series; finish comes from the system. Five or six layout families,
 * one brand.
 *
 * So the unit of choice moves up a level. The writer is no longer asked "what
 * layout is this slide", a question it answers locally and therefore
 * repetitively. It is asked nothing at all: **the run picks a series from the
 * story's own evidence, and the series supplies the skeleton.** That is a
 * question the evidence can actually answer, and the answer changes when the
 * evidence does.
 *
 * ## Why this is deterministic and free
 *
 * No model call. `selectSeries` reads the angle the run already chose, the
 * fact cards it already fetched, and the skeletons it already recorded. $0.00,
 * no prompt tokens, no extra turn, and identical across a resume — which is
 * the same cost profile RFC-20 §11.4 specified for the bounded object, and for
 * the same reason: a choice a rule can make is a choice a model should not be
 * paid to make.
 *
 * It also makes the rotation guarantee checkable. "Do not repeat last week's
 * skeleton" is an instruction to a model and a REFUSAL in `skeleton-memory`;
 * here it is an exclusion in a pure function, so a test can prove that two
 * consecutive runs on the same story get different compositions.
 *
 * ## What this module is NOT
 *
 * It is not a template. Every layout it names is one of the validated
 * archetypes the repo already renders and calibrates — this file adds no
 * markup, no CSS and no new file to the template pool. That is the ruling's
 * "composition from validated building blocks" stated as an import boundary:
 * this module imports a type and nothing else, and the only strings it emits
 * are layout names that already exist.
 *
 * It is also not the reference account's series list. Those names are that
 * publisher's editorial identity and belong to them; what transfers is that a
 * story-shaped trigger selects a layout family. The six below are generic
 * editorial formats any client can carry, named for what they DO.
 */

/** The layouts a series may compose from — every one an archetype the repo already validates and calibrates. */
export type SeriesLayout = Extract<
  InstagramSlideCopy["layout"],
  "photo" | "stat_callout" | "quote_card" | "comparison_card" | "list_takeaway" | "headline_focus" | "text_only"
>;

export const EDITORIAL_SERIES_IDS = ["by_the_numbers", "head_to_head", "the_breakdown", "the_playbook", "field_notes", "in_their_words", "the_list"] as const;
export type EditorialSeriesId = (typeof EDITORIAL_SERIES_IDS)[number];

export interface EditorialSeries {
  id: EditorialSeriesId;
  /** The small-caps tag the brand system prints. Rendered through the existing `seriesBadge` slot — see `seriesBadgeFor`. */
  badge: string;
  /** One line naming the kind of story this format is for. Goes into the writer's directive verbatim. */
  premise: string;
  /**
   * The middle of the carousel, in order. `cover` and `closer` are positional
   * and every carousel has exactly one of each, so they are NOT listed here —
   * `skeletonFor` adds them. A skeleton longer than the run needs is TRUNCATED
   * from the end rather than sampled, so a six-slide post is the first four of
   * this list and reads as the same format at a shorter length.
   */
  middle: readonly SeriesLayout[];
  /** How the copy is written for this format. One or two sentences; it reaches the writer, so it is instruction rather than description. */
  register: string;
}

/**
 * The bundled six.
 *
 * Chosen to span the shapes a business story actually takes rather than to be
 * a pretty set: a number-led story, a two-sided story, a teardown, a rule-set,
 * an account of something that happened, and a story carried by what someone
 * said. Every `middle` is built from validated archetypes and every one leads
 * with a DIFFERENT archetype, which is what makes the rotation below produce a
 * visibly different post rather than a re-ordered one.
 */
export const BUNDLED_SERIES: readonly EditorialSeries[] = [
  {
    id: "by_the_numbers",
    badge: "by the numbers",
    premise: "The story IS the figures: the reader leaves knowing three numbers they did not know.",
    middle: ["stat_callout", "photo", "stat_callout", "headline_focus", "stat_callout", "list_takeaway"],
    register:
      "Lead every interior slide with the figure, not the framing. Each number carries its own source. The headline_focus turn is the one place you say what the numbers MEAN, in one sentence, without a number in it.",
  },
  {
    id: "head_to_head",
    badge: "head to head",
    premise: "Two things set against each other, and the reader should be able to say which won and why.",
    middle: ["comparison_card", "photo", "comparison_card", "stat_callout", "headline_focus", "list_takeaway"],
    register:
      "Keep the same two sides in the same order on every comparison, so the reader never has to re-learn which column is which. The right side carries the accent, so the later or recommended state goes right. Do not declare a winner before the closer.",
  },
  {
    id: "the_breakdown",
    badge: "the breakdown",
    premise: "One thing taken apart: what it is, what it cost, what made it work, what to copy.",
    middle: ["photo", "stat_callout", "list_takeaway", "quote_card", "headline_focus", "photo"],
    register:
      "Move from the thing to the mechanism to the lesson. The list is the mechanism, not a summary of the post. Do not restate the cover on the last interior slide — it is the last thing before the takeaway and it should be the sharpest thing.",
  },
  {
    id: "the_playbook",
    badge: "the playbook",
    premise: "A rule-set the reader can act on: a small number of moves, stated as moves.",
    middle: ["list_takeaway", "headline_focus", "list_takeaway", "stat_callout", "photo", "list_takeaway"],
    register:
      "Every item is an instruction in the imperative, not a topic. A rule that cannot be done tomorrow is an observation and does not belong. The stat exists to prove ONE of the rules, so put it next to the rule it proves.",
  },
  {
    id: "field_notes",
    badge: "field notes",
    premise: "An account of something that happened, told in the order it happened.",
    // Opens on the statement rather than the photograph, and the reason is a
    // property the test below asserts: every series must open on a DIFFERENT
    // archetype, or a rotation produces a post that reads the same on the one
    // slide after the cover. `the_breakdown` already opens on `photo`.
    // Editorially it is also the better order for an account of something that
    // happened — set the scene in one line, then show it.
    middle: ["headline_focus", "photo", "quote_card", "stat_callout", "list_takeaway", "photo"],
    register:
      "Keep the sequence chronological and say when each thing happened. The opening line sets the scene and does not editorialise. The quote is a participant, not a commentator. The numbers come after the events they describe, never before.",
  },
  {
    id: "in_their_words",
    badge: "in their words",
    premise: "The story is carried by what people actually said.",
    middle: ["quote_card", "photo", "quote_card", "headline_focus", "stat_callout", "photo"],
    register:
      "Every quote is verbatim from a card, attributed, and long enough to carry a thought. Your own lines between them are connective tissue and stay short — if your line is more interesting than the quote after it, you have chosen the wrong quote.",
  },
  // 2026-09-23, stage 6 of the owner's reference-looks plan: the list people
  // save. The reference got 6,166 shares on its promise and its cover, and
  // its eleven-row slides were the part nobody could read on a phone, so the
  // owner asked for the promise without the rows: ONE item per slide, each
  // with its big number (`itemOrdinal`), the count on the cover equal to the
  // item slides, and a closer that asks for the save. Every item slide is a
  // headline_focus on purpose: the list's rhythm IS the repetition, which is
  // why this is the one series allowed to share its opening archetype.
  {
    id: "the_list",
    badge: "the list",
    premise: "A countable promise kept one item at a time: N moves, one per slide, worth saving.",
    // 2026-09-25: items alternate a PHOTO plate and a text plate. Six text
    // plates in a row could not carry a picture, so a list post shipped two
    // pictures against a floor of three (Hanky Panky, KAROS, prep batch of
    // 2026-09-25) and read as one slide shown six times.
    middle: ["photo", "headline_focus", "photo", "headline_focus", "photo", "headline_focus"],
    register:
      "The cover states the count, and the count equals the number of item slides after it. Each item slide is ONE item: the item itself as the headline in a few words, then one short line on why it matters as the body, nothing else, no list inside it. The closer asks the reader to save the post or comment, in a few words.",
  },
];

/** Positional, and every carousel has exactly one of each — so they are added by `skeletonFor`, never listed in a series. */
const COVER: InstagramSlideCopy["layout"] = "cover";
const CLOSER: InstagramSlideCopy["layout"] = "closer";

/** The shortest carousel a series can shape. Below this there is a cover, a closer and at most one interior, and the format is not legible. */
export const MIN_SERIES_SLIDES = 4;

/**
 * The ordered layouts for a post of `slideCount` slides: cover, the first
 * `slideCount - 2` of the series' middle, closer.
 *
 * TRUNCATED rather than sampled, on purpose. A sampled middle would give the
 * same series a different rhythm at every length, which is the opposite of
 * what a series is for — a reader should recognise the format at six slides
 * and at eight. Truncation means the first four slides of an eight-slide
 * `the_playbook` and of a six-slide one are identical.
 *
 * A count longer than the middle REPEATS the middle's last entry rather than
 * failing, because a series is a preference and never a reason to refuse a
 * post. In practice `slides_max` is 8 and every middle holds 6, so the repeat
 * arm is unreachable from the shipped canvas — it exists so a wider canvas
 * cannot turn this into a throw.
 */
export function skeletonFor(series: EditorialSeries, slideCount: number): InstagramSlideCopy["layout"][] {
  // `Math.max(4, NaN)` is NaN, so the finite check comes FIRST and not as a
  // clamp afterwards. Without it a run whose slide count arrived unparsed got
  // a two-slide skeleton — a cover and a closer with no post between them —
  // which is a shape no clause would have refused because every plate on it is
  // fine. Found by the test below, which is why the test passes a NaN.
  const requested = Number.isFinite(slideCount) ? Math.floor(slideCount) : MIN_SERIES_SLIDES;
  const count = Math.max(MIN_SERIES_SLIDES, requested);
  const interiors = count - 2;
  const middle: SeriesLayout[] = [];
  for (let i = 0; i < interiors; i++) middle.push(series.middle[Math.min(i, series.middle.length - 1)]!);
  return [COVER, ...middle, CLOSER];
}

/**
 * Which slides are wearing the layout THE SERIES gave them, by slide number.
 *
 * ## Why this exists
 *
 * `slides-data.ts` degrades any archetype a second slide in the same carousel
 * asks for. That rule was written against a writer that repeated `stat_callout`
 * on its own initiative, and it is right about that case — but four of the six
 * bundled series direct a repeat ON PURPOSE (`by_the_numbers` is three
 * `stat_callout`s; `the_playbook` three `list_takeaway`s; `head_to_head` and
 * `in_their_words` two each), so those four formats could not ship without
 * degraded plates. karoslabs' 2026-09-16 `by_the_numbers` post rendered slides
 * 4, 5 and 6 on the client's bare base template for exactly this reason.
 * `resolveLayout`'s `seriesDirected` parameter carries this set and skips the
 * repeat check for its members.
 *
 * ## Why a MATCH rather than "every slide, because a series ran"
 *
 * The exemption is for a repeat the series asked for, not for every layout on
 * a run that happens to have a series. A writer that ignores the skeleton and
 * puts a third `comparison_card` where the series asked for a photo is the
 * case the singleton rule was built for, and it keeps binding. So a slide is
 * directed only where its own requested layout EQUALS the skeleton's entry for
 * its position.
 *
 * Compared by POSITION in the drafted array rather than by `n`, because the
 * skeleton is positional (`skeletonFor` truncates from the end) and `n` is a
 * model-authored field: a draft that numbers its slides 1,2,2,4 would silently
 * exempt the wrong plate. The RETURNED numbers are each slide's own `n`,
 * because that is what `resolveLayout` sees.
 *
 * Pure, total, $0 — and it needs the drafted slides, so it is called after
 * `05` rather than at selection time.
 */
export function seriesDirectedSlides(
  series: EditorialSeries,
  slides: readonly { n: number; layout?: InstagramSlideCopy["layout"] | undefined }[],
): ReadonlySet<number> {
  const skeleton = skeletonFor(series, slides.length);
  const directed = new Set<number>();
  slides.forEach((slide, index) => {
    if (slide.layout !== undefined && slide.layout === skeleton[index]) directed.add(slide.n);
  });
  return directed;
}

/** The evidence a series is chosen from — all of it already on the run before this step. */
export interface SeriesEvidence {
  /** The angle the run chose, if `04i` produced one. Absent on a run whose angle step failed open. */
  angleId?: "wrong-assumption" | "surprising-number" | "what-it-means" | undefined;
  /** The kinds of the fact cards the ANGLE rests on — the evidence the post is actually built from, not everything fetched. */
  restsOnKinds: readonly ("stat" | "quote" | "event" | "definition")[];
  /** How many distinct named entities the angle sets against each other. 2 or more is what makes a story two-sided. */
  comparedEntities?: number | undefined;
  /** The series used by the previous shipped posts, newest first. Read from `skeleton-memory`. */
  recentSeriesIds?: readonly string[] | undefined;
  /**
   * Phase 5.5, item D2 — the series **other clients** shipped in the fleet's
   * last few posts, newest first. From `crossClientSeriesIds(...)` in
   * `visual-system.ts`, which reads the agent-level
   * `CROSS_CLIENT_FORMAT_BELIEF_KEY`.
   *
   * The owner's sharpest complaint about the 2026-09-16 batch was not that a
   * client repeated itself — it was that two different clients' posts were
   * recognisably one machine's output on the same day. `skeleton-memory` is
   * per-client and structurally cannot see that: karoslabs and thepitchbydeel
   * both landed `by_the_numbers` for two unrelated stories and neither
   * client's own history said anything was wrong.
   *
   * Absent or empty means NO PENALTY. The belief is fleet-scoped and optional;
   * an unreadable one must cost a post nothing.
   */
  crossClientSeriesIds?: readonly string[] | undefined;
}

/**
 * What a series costs for having been used by ANOTHER client recently.
 *
 * Two points, and the number is chosen against the live scores rather than
 * picked. `scoreOf` ranges 0-5, and on the three 2026-09-16 runs the winning
 * margins were 5 (`by_the_numbers`, two stat cards plus the matching angle)
 * against `the_breakdown`'s standing 1. A 2-point penalty moves that to 3
 * against 1 — **a story that genuinely is number-led still gets the
 * number-led format**, which is the property the test pins. What 2 points DO
 * decide is the case where the evidence is thin and two formats are within a
 * point of each other, which is exactly when two clients land on the same one.
 *
 * A penalty rather than an exclusion, for the same reason `SERIES_ROTATION_HOLD`
 * is only two posts long: a forced format is a worse post than a repeated one.
 */
export const CROSS_CLIENT_SERIES_PENALTY = 2;

export interface SeriesChoice {
  series: EditorialSeries;
  /** Why this one, in the words a reviewer reads on the gate payload. */
  reason: string;
  /** The ids excluded by rotation, so "why not the obvious one" is answerable without re-deriving it. */
  rotatedAway: EditorialSeriesId[];
  /** Every series' score BEFORE the cross-client penalty, for the trace. A choice nobody can audit is a choice nobody can correct. */
  scores: Record<EditorialSeriesId, number>;
  /** The ids another client shipped recently, each of which lost `CROSS_CLIENT_SERIES_PENALTY`. Empty when the fleet belief was absent, unreadable or silent. */
  crossClientPenalised: EditorialSeriesId[];
}

/**
 * How many recent posts a series is held out for.
 *
 * Two. One would let a format alternate A/B/A/B forever, which is a rut with
 * two rooms in it; three over six series starts to forbid half the menu on a
 * client whose stories genuinely are all number-led, and a forced format is a
 * worse post than a repeated one. Two is the smallest number that guarantees a
 * third consecutive post cannot be the same shape.
 */
export const SERIES_ROTATION_HOLD = 2;

/**
 * Score each series against the story, exclude the recently used, take the
 * best. Deterministic, total, and never throws.
 *
 * ## The scoring, and why it is a score rather than a rule chain
 *
 * An `if/else if` chain over the same signals would be shorter and would hide
 * the thing a reviewer needs: how close the second-best format was. A run that
 * picked `the_breakdown` at 1 point over a `by_the_numbers` at 0 is a default
 * wearing a decision's clothes, and `scores` says so on the payload.
 *
 * ## Ties, and the one place determinism has to be stated rather than assumed
 *
 * Ties break by the order of `BUNDLED_SERIES`, which puts `the_breakdown`
 * third: it is the general teardown and the sanest default, but it is
 * deliberately NOT first, so a story with a genuine number or comparison
 * signal beats it rather than tying with it.
 */
export function selectSeries(evidence: SeriesEvidence, catalogue: readonly EditorialSeries[] = BUNDLED_SERIES): SeriesChoice {
  const kinds = evidence.restsOnKinds ?? [];
  const count = (k: "stat" | "quote" | "event" | "definition"): number => kinds.filter((entry) => entry === k).length;
  const stats = count("stat");
  const quotes = count("quote");
  const events = count("event");
  const definitions = count("definition");
  const compared = Math.max(0, Math.floor(evidence.comparedEntities ?? 0));

  const scoreOf = (series: EditorialSeries): number => {
    switch (series.id) {
      // A number-led story is the least ambiguous signal there is, so it
      // scores highest when the angle AGREES with the cards. The angle alone
      // is worth less than the cards: `surprising-number` is a framing, and a
      // framing with one stat behind it is a `the_breakdown` with a number in
      // it.
      case "by_the_numbers":
        return (stats >= 2 ? 3 : 0) + (evidence.angleId === "surprising-number" ? 2 : 0) + (stats === 1 ? 1 : 0);
      // Two-sidedness is STRUCTURAL, and this is the one series whose signal
      // is a gate rather than a sum. Every other format can be written from
      // any story — a playbook needs rules, and rules can be drawn out of
      // anything. A comparison card cannot be filled without two things to
      // compare, so a `wrong-assumption` framing with nothing on either side
      // would hand the writer a skeleton it has to break.
      //
      // Written as a gate after the test caught the sum: the angle bonus alone
      // scored 2 against `the_breakdown`'s standing 1 and won, which is the
      // framing choosing a format the evidence cannot render.
      case "head_to_head":
        return compared >= 2 ? 3 + (evidence.angleId === "wrong-assumption" ? 2 : 0) : 0;
      // A rule-set. `definition` cards are what a playbook is made of, and
      // `what-it-means` is the angle that asks for one.
      case "the_playbook":
        return (definitions >= 1 ? 2 : 0) + (evidence.angleId === "what-it-means" ? 2 : 0) + (definitions >= 2 ? 1 : 0);
      // A list worth saving: three or more defined things, the shape of "N
      // moves". It needs MORE definitions than the playbook does, so a story
      // with one or two rules keeps the playbook's denser form.
      case "the_list":
        return (definitions >= 3 ? 4 : 0) + (definitions >= 3 && evidence.angleId === "what-it-means" ? 2 : 0);
      // Something that happened.
      case "field_notes":
        return (events >= 1 ? 3 : 0) + (events >= 2 ? 1 : 0);
      // Carried by what people said. Two quotes is a format; one is a
      // `the_breakdown` with a quote slide in it, which is what that series
      // already has.
      case "in_their_words":
        return (quotes >= 2 ? 3 : 0) + (quotes === 1 ? 1 : 0);
      // The default, and it scores a standing 1 so it wins only when nothing
      // else has a real signal. A default that scored 0 would tie with five
      // other zeroes on an evidence-free run and be chosen by array order,
      // which reads the same and means something different.
      case "the_breakdown":
        return 1;
    }
  };

  const scores = Object.fromEntries(catalogue.map((series) => [series.id, scoreOf(series)])) as Record<EditorialSeriesId, number>;
  const held = new Set((evidence.recentSeriesIds ?? []).slice(0, SERIES_ROTATION_HOLD));
  const rotatedAway = catalogue.filter((series) => held.has(series.id)).map((series) => series.id);

  // ── Item D2: the fleet's own recent formats. ──
  //
  // A PENALTY on a separate ladder rather than a term inside `scoreOf`, and
  // the separation is the point: `scores` stays the answer to "what does this
  // STORY fit", which is what a reviewer reads, and the penalty is a visible
  // second column. Folding it in would make a story's fit look weaker than it
  // is on the payload and there would be no way to tell the two apart.
  const crossClient = new Set(evidence.crossClientSeriesIds ?? []);
  const crossClientPenalised = catalogue.filter((series) => crossClient.has(series.id)).map((series) => series.id);
  const adjustedOf = (id: EditorialSeriesId): number => scores[id]! - (crossClient.has(id) ? CROSS_CLIENT_SERIES_PENALTY : 0);

  const eligible = catalogue.filter((series) => !held.has(series.id));
  // Every series held out is possible only on a catalogue of two or fewer.
  // The post still ships: rotation is a preference, and a repeated format is
  // better than no format at all.
  const pool = eligible.length > 0 ? eligible : catalogue;
  let best = pool[0]!;
  for (const series of pool) if (adjustedOf(series.id) > adjustedOf(best.id)) best = series;
  const runnerUp = pool.filter((series) => series.id !== best.id).sort((a, b) => adjustedOf(b.id) - adjustedOf(a.id))[0];
  const margin = runnerUp === undefined ? undefined : adjustedOf(best.id) - adjustedOf(runnerUp.id);
  const why =
    scores[best.id]! <= 1
      ? "no format had a signal in this story's own evidence, so the general teardown was taken"
      : `the story's evidence fits it${margin !== undefined ? ` by ${margin} over ${runnerUp!.id}` : ""}`;

  return {
    series: best,
    reason:
      `series "${best.id}": ${why}` +
      `${rotatedAway.length > 0 ? ` (held out as recently used: ${rotatedAway.join(", ")})` : ""}` +
      `${crossClientPenalised.length > 0 ? ` (-${CROSS_CLIENT_SERIES_PENALTY} each, shipped by another client this week: ${crossClientPenalised.join(", ")})` : ""}`,
    rotatedAway,
    scores,
    crossClientPenalised,
  };
}

/**
 * How many things the angle's own title sets against each other: 2 when it
 * carries a comparison connective with text on both sides, 0 otherwise.
 *
 * ## Why a connective list and not a proper-noun count
 *
 * The obvious implementation is "count the capitalised spans". It is also a
 * defect with a language attached: Hebrew and Arabic have no capitals, so a
 * capitalisation heuristic would silently deny `head_to_head` to every RTL
 * client and hand them `the_breakdown` forever — the same shape of bug as
 * calibrating a colour metric on one brand's palette, in a different
 * dimension. This project has already shipped one metric that penalised
 * Hebrew structurally; it is not shipping a second.
 *
 * ## What this IS, and the limit stated rather than hidden
 *
 * A small list of comparison connectives per script, matched with non-empty
 * text on both sides. It is deliberately conservative: a language not on the
 * list returns 0, which falls through to `the_breakdown` — a general teardown
 * is a safe answer for a two-sided story, while a `head_to_head` with nothing
 * on one side is a skeleton the writer has to break. **Wrong toward the
 * default, never toward the format that cannot be filled.**
 *
 * Extending it is adding a string to `COMPARISON_MARKERS` and a case to its
 * test. That is the whole contract.
 */
export const COMPARISON_MARKERS: readonly string[] = [
  // English
  " vs ",
  " vs. ",
  " versus ",
  " against ",
  " beats ",
  " or ",
  " over ",
  // Hebrew — `מול` (facing/against), `לעומת` (compared with), `נגד` (against), `או` (or)
  " מול ",
  " לעומת ",
  " נגד ",
  " או ",
  // Script-neutral
  " → ",
];

export function countComparedEntities(title: string | undefined): number {
  const text = ` ${(title ?? "").trim()} `;
  if (text.trim().length === 0) return 0;
  for (const marker of COMPARISON_MARKERS) {
    const at = text.indexOf(marker);
    // Text on BOTH sides, not just the marker's presence: a title that opens
    // with "Or why nobody..." is not a comparison, and neither is one that
    // trails off after it.
    if (at > 0 && text.slice(0, at).trim().length > 0 && text.slice(at + marker.length).trim().length > 0) return 2;
  }
  return 0;
}

/**
 * The length the directive states its order at.
 *
 * The CANVAS maximum, because the writer decides the slide count (prompt §3
 * makes it follow the structure) and the run cannot know it before the draft
 * exists. The directive gives the full order and the truncation rule, so a
 * shorter post is its prefix and the format reads the same at every length.
 */
export const SERIES_DIRECTIVE_SLIDES = 8;

/**
 * The badge the brand system prints for this run.
 *
 * The `seriesBadge` slot already exists on every bundled template and in
 * `LAYOUT_FIELD_KEYS`; until now it carried a per-CLIENT string frozen at
 * setup (`template-studio.ts` seeds it as "playbook"), so the hook the
 * reference feed uses was in the tree with nothing choosing it. It becomes
 * per-RUN here.
 *
 * A client that set its own badge KEEPS it — an explicit brand decision beats
 * a derived one, the same precedence every other token in this system uses —
 * and gets the series' composition regardless. The badge is how the format is
 * announced; it is not what the format IS.
 */
export function seriesBadgeFor(choice: SeriesChoice, clientBadge?: string | undefined): string {
  const explicit = clientBadge?.trim();
  return explicit !== undefined && explicit.length > 0 ? explicit : choice.series.badge;
}

/**
 * The directive the writer receives, as prose rather than JSON.
 *
 * The skeleton is given as an ORDER, with each slide's layout named, because
 * that is the thing the writer must not re-decide. Everything else in the copy
 * prompt still applies: the writer chooses what each slide SAYS and which
 * archetype-specific object it fills, and the archetype-fit rules in §7 still
 * govern whether the content it wrote actually belongs in the layout it was
 * given — a `stat_callout` with no number is still a fault, and the slide
 * still degrades through the existing path.
 *
 * That last point is the whole safety argument for handing the writer a
 * skeleton. The series constrains the SEQUENCE; the existing per-archetype
 * requirements constrain the FIT; and where they disagree the fit wins,
 * because a layout with nothing to put in it renders as a hole.
 */
export function seriesDirective(choice: SeriesChoice, slideCount: number): string {
  const skeleton = skeletonFor(choice.series, slideCount);
  const lines = skeleton.map((layout, index) => `  ${index + 1}. ${layout}`);
  return [
    `## This post's series: ${choice.series.badge}`,
    "",
    choice.series.premise,
    "",
    choice.series.register,
    "",
    `The layout of every slide is decided, and at the full ${skeleton.length} slides it is this:`,
    "",
    ...lines,
    "",
    // The writer, not the run, decides the slide COUNT (§3 makes it follow the
    // structure), so the directive has to state the order for the longest post
    // and say how a shorter one is taken from it. Truncation rather than
    // sampling, matching `skeletonFor` exactly: a reader should recognise the
    // format at six slides and at eight, and the first four slides of both
    // must therefore be identical.
    `If your post is shorter than ${skeleton.length} slides, take the FIRST slides of that order and finish on the closer — slide 1 is always the cover and the last slide is always the closer. Do not re-order and do not pick out of the middle of the list.`,
    "",
    // THE SENTENCE THAT REACHED A READER. Until 2026-09-16 this line ended
    // "...say so in that slide's content and leave the object out", and on
    // 2026-09-16 the writer did exactly as it was told: geektime's slide 4,
    // whose `field_notes` skeleton asks for a quote card and whose cards held
    // no quote, shipped `לא נמצא ציטוט משתתף ישיר בחומרים; השקף נושא את הטענה
    // בכותרת ובגוף` — a note to the pipeline, set at 31px in front of the
    // client's audience. The reporting channel was the defect, not the
    // reporting: a writer that cannot fill a required object MUST still say
    // so, or the run has no way to tell an empty plate from a chosen one.
    // So the channel moves off the plate, and `craft-hygiene.ts`'s
    // `work-notes` clause refuses a draft that narrates it anyway.
    //
    // The `unfillable` field is added to `InstagramSlideCopySchema` alongside
    // copy prompt @21. The second half of the sentence is what makes this
    // directive safe to ship on EITHER side of that change: a schema without
    // the field drops the value silently (the copy output schema strips
    // unknown keys), which is the right outcome — a note about the materials
    // is never reader copy, whether or not there is somewhere to put it.
    "Write to that order. Do not re-choose the layouts — section 7's menu tells you what each archetype REQUIRES, and that still binds: a slide whose content cannot fill the layout it was given is a slide whose content is wrong, not a layout to swap. If a required object genuinely cannot be written from the cards you were given, leave the object out and name it in that slide's `unfillable` field — never in `headline`, `body`, or any other text the reader sees. If your output has no `unfillable` field, leave it unsaid: a note about the cards, the materials, the brief or this slide itself is working text, and working text on a plate is a defect the reader is looking at.",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// The client's own library (Phase 5.6, item C3)
// ─────────────────────────────────────────────────────────────────────────

/**
 * The specification asks for "3 to 5 on-brand post templates (a series per
 * content type) so the feed reads as one system", per client.
 *
 * What exists is `BUNDLED_SERIES`: six series, the same six for every client,
 * whose own comment says they were chosen so "any client can carry" them.
 * That is exactly the sameness the owner named after reading two finished
 * posts side by side, and the sentence he used is the requirement: *you can
 * see the same AI made both.*
 *
 * ## What this does, and what it deliberately does not
 *
 * It gives each client a SUBSET of the six, three to five of them, chosen
 * from their own brief and stable across runs. It does not author new series.
 *
 * Authoring is the version of this that reads better in a plan and worse in
 * the code: `EditorialSeriesId` is a closed union and every downstream
 * consumer — `skeletonFor`, the rotation hold, the cross-client penalty, the
 * gate payload — is keyed on it, so a client-authored id is not a new series
 * but a new type. And a series is not a name: it is a `middle` of validated
 * archetypes whose ordering has been calibrated against the interest floor.
 * A model inventing one at setup would be inventing a layout sequence nothing
 * has rendered, which is the thing the owner's own ruling forbids ("dynamic
 * composition from validated building blocks").
 *
 * A subset delivers the property that was actually asked for. Two clients
 * with different briefs now run different editorial shapes, the feed of each
 * reads as one system because it is three to five shapes rather than six, and
 * every shape in it is one the repo already renders and calibrates.
 */
export const MIN_CLIENT_LIBRARY = 3;
export const MAX_CLIENT_LIBRARY = 5;

/**
 * The one series every library must contain.
 *
 * `selectSeries` gives `the_breakdown` a standing score of 1 so that a run
 * whose evidence says nothing still has a winner. Drop it from a library and
 * an evidence-free run picks among a set of zeroes by array order, which
 * reads like a choice and is not one.
 */
export const LIBRARY_ANCHOR: EditorialSeriesId = "the_breakdown";

/**
 * The owner's industry table, as a closed set of NAMED segments (item C4).
 *
 * It was a list of anonymous regular expressions. That worked and could not
 * be referred to, and a segment that has a name is a fact the run can carry:
 * onto the gate payload so a reviewer sees which row was applied, into the
 * performance store so Phase 6 can cut by it, and into the copy prompt, where
 * the rest of the specification's table belongs (tone, proof rules, and the
 * hard constraints each row imposes).
 *
 * `unknown` is a member rather than a failure. A brief that names no industry
 * is the ordinary state of a client onboarded from a website, and the honest
 * answer there is that nothing is known — not a guess at the commonest row.
 */
export const CLIENT_SEGMENTS = ["regulated", "b2b-saas", "agency-creator", "local-service", "consumer-dtc", "unknown"] as const;
export type ClientSegment = (typeof CLIENT_SEGMENTS)[number];

/**
 * Which series each segment leans towards.
 *
 * Read off the owner's own table: a regulated business leads with figures and
 * rules because that is what it is permitted to state; an agency or a creator
 * leads with what people said and what happened, because their proof IS the
 * account. The affinity is a NUDGE of one point, deliberately smaller than any
 * evidence signal in `selectSeries`, because a segment decides which shapes are
 * AVAILABLE to a client and never which shape a particular story takes.
 *
 * ORDER MATTERS, and `regulated` is first on purpose: a healthcare SaaS reads
 * as regulated rather than as SaaS. That is the direction a misreading should
 * run, because the constraint is the expensive half to get wrong.
 */
const SEGMENT_TABLE: ReadonlyArray<{
  readonly segment: Exclude<ClientSegment, "unknown">;
  readonly match: RegExp;
  readonly prefers: readonly EditorialSeriesId[];
}> = [
  { segment: "regulated", match: /\b(financ|bank|insur|invest|lend|mortgag|legal|complian|regulat|health|medic|pharma|clinic)/i, prefers: ["by_the_numbers", "the_playbook"] },
  { segment: "b2b-saas", match: /\b(saas|software|platform|b2b|api|developer|infrastructur|cloud|devops|analytics)/i, prefers: ["head_to_head", "the_breakdown"] },
  { segment: "agency-creator", match: /\b(agenc|consult|studio|creator|coach|freelanc|marketing|design)/i, prefers: ["in_their_words", "field_notes"] },
  { segment: "local-service", match: /\b(restaurant|hospitality|retail|shop|local|salon|gym|hotel|bakery|plumb|garage)/i, prefers: ["field_notes", "in_their_words"] },
  { segment: "consumer-dtc", match: /\b(ecommerce|e-commerce|dtc|consumer|cpg|apparel|beauty|skincare)/i, prefers: ["head_to_head", "by_the_numbers"] },
];

export interface SegmentReading {
  readonly segment: ClientSegment;
  /** The words in the brief that decided it, so the reading is checkable rather than asserted. */
  readonly matched: readonly string[];
}

/**
 * Which segment this client is, from the words their own brief carries.
 *
 * Deterministic and free, and it returns `unknown` rather than guessing.
 * Every consumer reads `unknown` as "no opinion", which is the posture this
 * workflow takes everywhere towards data a client may not have.
 */
export function readClientSegment(segments: readonly string[] | undefined): SegmentReading {
  const haystack = (segments ?? []).join(" ");
  for (const row of SEGMENT_TABLE) {
    const hit = row.match.exec(haystack);
    if (hit !== null) return { segment: row.segment, matched: [hit[0].toLowerCase()] };
  }
  return { segment: "unknown", matched: [] };
}

/** The series a segment leans towards. Empty for `unknown`, which leans nowhere. */
export function seriesPreferredBy(segment: ClientSegment): readonly EditorialSeriesId[] {
  return SEGMENT_TABLE.find((row) => row.segment === segment)?.prefers ?? [];
}

/**
 * A small stable hash of a string. Not cryptographic and does not need to be:
 * its only job is that the same client gets the same library every week and
 * two clients in the same segment do not get the same one.
 */
function stableHash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export interface ClientLibraryInput {
  /** Namespaces the library, so two clients with identical briefs still differ. */
  readonly clientSlug: string;
  /** `brief.icp.industries` and anything else that names what this client does. */
  readonly segments?: readonly string[];
}

export interface ClientLibrary {
  readonly series: readonly EditorialSeries[];
  /** Which row of the industry table this client read as, `unknown` included. */
  readonly segment: ClientSegment;
  /** One sentence for the gate payload: which shapes this client runs, and on what basis. */
  readonly rule: string;
}

/**
 * This client's three to five series, deterministically.
 *
 * Pure, free, and identical across a resume, for the reason `selectSeries`
 * states about itself: a choice a rule can make is a choice a model should not
 * be paid to make.
 */
export function seriesLibraryFor(input: ClientLibraryInput, catalogue: readonly EditorialSeries[] = BUNDLED_SERIES): ClientLibrary {
  const reading = readClientSegment(input.segments);
  const preferred = new Set<EditorialSeriesId>(seriesPreferredBy(reading.segment));

  const seed = stableHash(input.clientSlug);
  // Three, four or five, from the slug: the SIZE varies per client too, so two
  // clients that happen to match the same segment row still run libraries of
  // different shape.
  const size = MIN_CLIENT_LIBRARY + (seed % (MAX_CLIENT_LIBRARY - MIN_CLIENT_LIBRARY + 1));

  const anchor = catalogue.find((s) => s.id === LIBRARY_ANCHOR);
  const rest = catalogue
    .filter((s) => s.id !== LIBRARY_ANCHOR)
    .map((s) => ({
      series: s,
      // Affinity first, then a per-client shuffle. Adding the hash rather than
      // sorting by it keeps the affinity decisive and the tie-break stable.
      score: (preferred.has(s.id) ? 1 : 0) + (stableHash(`${input.clientSlug}:${s.id}`) % 1000) / 1000,
    }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.series);

  const series = [...(anchor === undefined ? [] : [anchor]), ...rest].slice(0, Math.max(MIN_CLIENT_LIBRARY, size));

  return {
    series,
    segment: reading.segment,
    rule:
      reading.segment === "unknown"
        ? `${series.length} series for this client; the brief named no segment this recognises, so the set is stable per client rather than steered: ${series.map((s) => s.id).join(", ")}`
        : `${series.length} series for a ${reading.segment} client, from "${reading.matched.join(", ")}" in the brief: ${series.map((s) => s.id).join(", ")}`,
  };
}
