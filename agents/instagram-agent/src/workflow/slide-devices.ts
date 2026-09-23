import { z } from "zod";

/**
 * Phase 2, item M — the number-device library.
 *
 * ## Typed copy in, code-built markup out
 *
 * A device is a small designed element that carries a figure: a big numeral,
 * a before/after pair, a bar set, a timeline, a versus split, a unit grid.
 * The copy model authors the DATA (a typed object on the slide) and this
 * module authors the MARKUP. That split is not a style preference — it is the
 * same boundary `assertSafeMarkup` draws when it refuses `{{html:...}}` from
 * model content: the `{{html:}}` substitution form is deliberately
 * unescaped, so the only safe producers are first-party fragment builders
 * like this one and `buildListRows`. Letting a copy field carry device markup
 * would make every copy field an injection point, and the copy step reads
 * scraped research text nobody on this team reviewed.
 *
 * ## Where the rules come from
 *
 * The engineering rules are carried across from the legacy `_cf-devices`
 * reference — the RULES only, no code and no CSS ported:
 *
 * | Rule | Where it lives here |
 * |---|---|
 * | A figure never breaks mid-number | `white-space: nowrap` on `.dv-figure` |
 * | Length-based autosize, three steps | `figureSizeClass`, IN CODE (see below) |
 * | Labels wrap BENEATH, in the text face | `.dv-label { font-family: var(--f-body) }` |
 * | A figure is a compact token, <= 12 chars | the schema's `max(12)` on every value/display |
 * | A bar's value rides INSIDE the fill at >= 72% of its track | `DEVICE_VALUE_INSIDE_BAR_THRESHOLD` |
 * | Complementary shares never end flush | `barMaxFor` — 100 when the rows sum to 100, else 1.15x the largest |
 * | Exactly ONE accent element per fragment | the single `dv-accent` marker class |
 * | Every figure names its source | `source` is REQUIRED on figure/figure_pair/bars |
 * | An illustrative device says so | `.dv-note`, localised by `ILLUSTRATIVE_NOTE` |
 *
 * The autosize step is picked in code rather than by an in-page script, which
 * is a deliberate departure from `stat-callout.html`/`headline-focus.html`.
 * Two reasons: we already hold the string, so measuring it in the page buys
 * nothing; and one fewer in-page script is one fewer thing that can race the
 * `__CAROUSEL_READY__` screenshot. The 12-character cap is what makes this
 * safe — it is also what makes the "about 50 to 60%" overflow defect
 * unrepresentable rather than merely discouraged.
 *
 * ## RTL and script fonts
 *
 * LOGICAL PROPERTIES ONLY — `margin-inline-*`, `padding-inline-*`,
 * `inset-inline-*`, `border-inline-start`, `text-align: start`; never
 * `left`/`right`. `dir="rtl"` then mirrors every device with no second
 * stylesheet, and `__tests__/slide-devices-rtl.test.ts` source-scans both the
 * stylesheet and every emitted fragment to keep it that way.
 *
 * Every size is `calc(Npx * var(--ts, 1))` so it composes with BOTH the
 * reviewer's `body.ts-s`/`body.ts-l` classes and `script-fonts.ts`'s
 * per-script `typeScale` (Hebrew 0.94, Arabic 0.92) — the composition trap
 * that a bare `font-size: 30px` would silently sit outside of.
 */

/**
 * The share of its own track a bar has to reach before its value moves
 * INSIDE the fill.
 *
 * Below this the value sits after the track and reads as a label; above it,
 * the value would either collide with the canvas edge or be squeezed into a
 * sliver of remaining track. 0.72 is the legacy reference's own number, and
 * it is a layout fact rather than taste: at 72% of a ~700px track the
 * remaining 196px cannot hold a 12-character mono value at 24px plus its
 * inset padding.
 */
export const DEVICE_VALUE_INSIDE_BAR_THRESHOLD = 0.72;

/** At or below this many characters a figure is set at the big step. */
export const DEVICE_FIGURE_BIG_MAX_CHARS = 3;
/** At or below this many characters a figure is set at the middle step; longer is the small step. */
export const DEVICE_FIGURE_MID_MAX_CHARS = 6;

/**
 * Headroom above the largest bar when the rows are NOT complementary shares,
 * so no bar ever ends flush against the end of its track — a bar that fills
 * its track reads as "100%" whatever its label says.
 */
export const DEVICE_BAR_HEADROOM = 1.15;

/** How far a bar set's values may sum from 100 and still be read as complementary shares of a whole. */
export const DEVICE_COMPLEMENTARY_SUM_TOLERANCE = 1;

const FigureValue = z.string().min(1).max(12);
const DeviceSource = z.string().min(1).max(120);

/**
 * The six device shapes.
 *
 * A discriminated union rather than one wide optional-everything object: a
 * device arrives from the copy model, and `kind` is the one field that says
 * which of its siblings are load-bearing. `SlideDeviceSchema.optional()` on
 * the slide copy means a model that omits it costs nothing, which is the
 * same posture the archetype content blocks already take.
 *
 * `source` is REQUIRED on the three shapes that assert a measurement
 * (`figure`, `figure_pair`, `bars`) and absent from the three that can
 * legitimately be illustrative (`timeline`, `versus`, `unit_grid`) — a big
 * unattributed number is exactly the shape of a claim a reader should
 * distrust, and the legacy system's rule was "every figure names its source
 * on the slide". A `timeline` or `unit_grid` that carries no measurement says
 * so in the rendered fragment instead (see `ILLUSTRATIVE_NOTE`).
 */
export const SlideDeviceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("figure"),
    value: FigureValue,
    label: z.string().min(1).max(80),
    source: DeviceSource,
  }),
  z.object({
    kind: z.literal("figure_pair"),
    before: z.object({ value: z.string().max(12), label: z.string().max(40) }),
    after: z.object({ value: z.string().max(12), label: z.string().max(40) }),
    source: DeviceSource,
  }),
  z.object({
    kind: z.literal("bars"),
    /** The value the longest bar is drawn against. Omit and it is derived — see `barMaxFor`. */
    max: z.number().positive().optional(),
    rows: z
      .array(z.object({ label: z.string().min(1).max(40), value: z.number(), display: z.string().min(1).max(12) }))
      .min(2)
      .max(5),
    source: DeviceSource,
  }),
  z.object({
    kind: z.literal("timeline"),
    points: z.array(z.object({ at: z.string().max(12), what: z.string().max(60) })).min(2).max(4),
  }),
  z.object({
    kind: z.literal("versus"),
    left: z.object({ label: z.string().max(40), body: z.string().max(120) }),
    right: z.object({ label: z.string().max(40), body: z.string().max(120) }),
    winner: z.enum(["left", "right", "neither"]),
  }),
  z.object({ kind: z.literal("unit_grid"), filled: z.number().int().min(1).max(99), of: z.literal(100), label: z.string().max(80) }),
  // 2026-09-23 (stage 1 of the reference-looks plan). Where each option sits
  // on two axes of judgement: the Karos Labs feed's "how a drink asks to be
  // understood" map. Always illustrative, because a position is an argument
  // and not a measurement, so it carries no `source` and always prints the note.
  z.object({
    kind: z.literal("position_map"),
    xAxis: z.object({ low: z.string().min(1).max(24), high: z.string().min(1).max(24) }),
    yAxis: z.object({ low: z.string().min(1).max(24), high: z.string().min(1).max(24) }),
    /** 0 = the axis's `low` end, 100 = its `high` end. Exactly one point is the subject. */
    points: z
      .array(
        z.object({
          label: z.string().min(1).max(28),
          x: z.number().int().min(0).max(100),
          y: z.number().int().min(0).max(100),
          subject: z.boolean().default(false),
        }),
      )
      .min(2)
      .max(5),
  }),
  // 2026-09-23. A few named terms and their values: Deel's "What was on the
  // table". A value may be prose ("two minutes") as much as a number, so the
  // cap is a short phrase rather than the 12-character figure rule, and
  // `source` is optional: section 19 of the copy guide requires one when a
  // value asserts a measurement, like any other figure.
  z.object({
    kind: z.literal("spec_table"),
    rows: z.array(z.object({ label: z.string().min(1).max(32), value: z.string().min(1).max(48) })).min(2).max(4),
    source: DeviceSource.optional(),
  }),
]);
export type SlideDevice = z.infer<typeof SlideDeviceSchema>;
export type SlideDeviceKind = SlideDevice["kind"];

/** Every device kind, for a caller enumerating them (a prompt's menu, a test's table). */
export const SLIDE_DEVICE_KINDS: readonly SlideDeviceKind[] = ["figure", "figure_pair", "bars", "timeline", "versus", "unit_grid", "position_map", "spec_table"];

/**
 * "Illustrative, not measured", per target language.
 *
 * Keyed by the language names `resolveTargetLanguage` (`target-language.ts`)
 * resolves — the same spellings the language gate and `script-fonts.ts`
 * already use, so there is one vocabulary for "what language is this post
 * in" rather than a second one owned by this module. An unknown or absent
 * language falls back to English rather than guessing at a translation: a
 * mistranslated note baked into a rendered slide is worse than an English
 * one, and this note is the only string in the device library that is not
 * either a numeral or model-authored copy.
 */
export const ILLUSTRATIVE_NOTE: Readonly<Record<string, string>> = {
  English: "Illustrative, not measured",
  Hebrew: "להמחשה בלבד, לא נמדד",
  Arabic: "توضيحي فقط، غير مُقاس",
  Spanish: "Ilustrativo, no medido",
  French: "Illustratif, non mesuré",
  German: "Illustrativ, nicht gemessen",
  Portuguese: "Ilustrativo, não medido",
};

/** The illustrative note for one target language, English when the language is unknown or absent. */
export function illustrativeNoteFor(targetLanguage?: string): string {
  const key = (targetLanguage ?? "").trim();
  if (key.length === 0) return ILLUSTRATIVE_NOTE["English"]!;
  const normalized = key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
  return ILLUSTRATIVE_NOTE[normalized] ?? ILLUSTRATIVE_NOTE["English"]!;
}

/**
 * Escapes a value for interpolation into a `{{html:...}}` fragment.
 *
 * A byte-for-byte mirror of `slides-data.ts`'s own `esc` (itself a mirror of
 * `karos-publish`'s `escapeHtmlText`), duplicated rather than imported for
 * one specific reason: `slides-data.ts` imports THIS module to build its
 * device fragments, so importing its `esc` back would close an import cycle
 * around two modules that both build markup. Five string replacements is a
 * cheaper price than a cycle, and the escaping is load-bearing enough that it
 * belongs beside the builder that depends on it.
 */
function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The type step a figure of this length is set at — in code, never in the page. See the module header. */
export function figureSizeClass(value: string): "dv-figure--big" | "dv-figure--mid" | "dv-figure--small" {
  const length = value.trim().length;
  if (length <= DEVICE_FIGURE_BIG_MAX_CHARS) return "dv-figure--big";
  if (length <= DEVICE_FIGURE_MID_MAX_CHARS) return "dv-figure--mid";
  return "dv-figure--small";
}

/**
 * The value a bar set's longest bar is drawn against.
 *
 * Three cases, in order: the model said so (`max`); the rows are
 * complementary shares of a whole, so the whole is 100 and the bars read as
 * parts of it; or the set is a comparison of unrelated magnitudes, in which
 * case the scale gets `DEVICE_BAR_HEADROOM` of slack so the largest bar does
 * NOT end flush against its track — a flush bar reads as "all of it"
 * regardless of what its label says.
 */
export function barMaxFor(device: Extract<SlideDevice, { kind: "bars" }>): number {
  if (device.max !== undefined) return device.max;
  const values = device.rows.map((r) => r.value);
  const sum = values.reduce((total, v) => total + v, 0);
  if (Math.abs(sum - 100) <= DEVICE_COMPLEMENTARY_SUM_TOLERANCE) return 100;
  return Math.max(...values) * DEVICE_BAR_HEADROOM;
}

/**
 * Whether this device can be rendered honestly, and why not when it cannot.
 *
 * Separate from the schema because these are RELATIONSHIPS between fields,
 * not field shapes: a bar whose value equals its own scale, a before/after
 * pair with no values, a bar set that is all zeroes. A device that fails here
 * is DROPPED from the render (`contentFor` emits no fragment) and reported as
 * a fact — never a gate. Devices are furniture, and the invariant this
 * pipeline states repeatedly is that furniture must not be able to hold a
 * run; a redraft loop over a decorative element would burn the whole
 * self-check budget on a slide whose copy was fine.
 */
export function validateDevice(device: SlideDevice): { ok: true } | { ok: false; reason: string } {
  switch (device.kind) {
    case "figure":
      return device.value.trim().length > 0 ? { ok: true } : { ok: false, reason: "a figure device with a blank value has nothing to set" };
    case "figure_pair": {
      if (device.before.value.trim().length === 0 || device.after.value.trim().length === 0) {
        return { ok: false, reason: "a before/after device needs a value on BOTH sides — one side alone is a figure, not a pair" };
      }
      return { ok: true };
    }
    case "bars": {
      for (const row of device.rows) {
        if (!Number.isFinite(row.value)) return { ok: false, reason: `bar "${row.label}" has a non-finite value` };
        if (row.value < 0) return { ok: false, reason: `bar "${row.label}" has a negative value (${row.value}) — a bar cannot be shorter than nothing` };
      }
      const max = barMaxFor(device);
      if (!(max > 0)) return { ok: false, reason: "a bar set whose values are all zero draws no bars" };
      const flush = device.rows.find((row) => row.value >= max);
      if (flush !== undefined) {
        return {
          ok: false,
          reason:
            `bar "${flush.label}" (${flush.value}) fills its whole track against a scale of ${max} — a bar that ends flush reads as "all of it". ` +
            `Give the set an explicit max above the largest value, or make the rows complementary shares that sum to 100.`,
        };
      }
      return { ok: true };
    }
    case "timeline": {
      const blank = device.points.find((p) => p.at.trim().length === 0 || p.what.trim().length === 0);
      return blank === undefined ? { ok: true } : { ok: false, reason: "every timeline point needs both a when and a what" };
    }
    case "versus": {
      if (device.left.label.trim().length === 0 || device.right.label.trim().length === 0) {
        return { ok: false, reason: "a versus device needs a label on both sides" };
      }
      return { ok: true };
    }
    case "unit_grid":
      return device.label.trim().length > 0 ? { ok: true } : { ok: false, reason: "a unit grid with no label states a proportion of nothing" };
    case "position_map": {
      const subjects = device.points.filter((p) => p.subject).length;
      if (subjects !== 1) {
        return {
          ok: false,
          reason: `a positioning map marks exactly one point as its subject (it marked ${subjects}); the map exists to show where ONE option sits against the rest`,
        };
      }
      for (const [i, a] of device.points.entries()) {
        const crowded = device.points.find((b, j) => j > i && Math.abs(a.x - b.x) < 12 && Math.abs(a.y - b.y) < 12);
        if (crowded !== undefined) return { ok: false, reason: `"${a.label}" and "${crowded.label}" sit on top of each other; spread them at least 12 apart on one axis` };
      }
      return { ok: true };
    }
    case "spec_table": {
      const blank = device.rows.find((row) => row.label.trim().length === 0 || row.value.trim().length === 0);
      return blank === undefined ? { ok: true } : { ok: false, reason: "every table row needs both a label and a value" };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 5.5, item G4 — the cover's figure device
// ─────────────────────────────────────────────────────────────────────────

/**
 * ## The plate this exists to refuse
 *
 * karoslabs, 2026-09-16, on two posts with different topics:
 *
 * ```
 *   7.2%
 *   Only of organizations respond to inbound leads within five minutes, meaning
 *   The Inbound Pipeline
 * ```
 *
 * Four defects in one device, on the one slide the whole audience sees. The
 * label opens with a subordinator and ends on `meaning` — it is the middle of
 * somebody else's sentence with the figure cut out of it. The figure is not
 * from this post's argument at all (the post is about GEO and AI answers; the
 * card is about inbound lead response time). And **the same 7.2% appeared on
 * two posts about different subjects**, because it came from whichever fact
 * card the re-layout reached first rather than from the angle.
 *
 * `interest-relayout.ts` no longer builds a cover device from an arbitrary
 * fact card — that limb is deleted. This is the belt-and-braces half, for a
 * device the WRITER declares: four rules, $0, deterministic, returning a
 * finding to `05` and never holding a run. Devices are furniture and furniture
 * must not be able to hold a run; what it can do is go back to the writer with
 * the reason.
 */
export const COVER_FIGURE_LABEL_MAX_CHARS = 90;

/**
 * Words that cannot open a complete clause, in the two languages this
 * pipeline actually ships.
 *
 * A label beginning with one of these is a fragment of a longer sentence:
 * "Only of organizations respond…" is what "Only 7.2% of organizations
 * respond…" becomes when the figure is cut out by position, which is exactly
 * how `deviceFromText` builds a label. The deterministic test for "did
 * somebody cut a number out of the middle of a sentence" is that the sentence
 * no longer starts.
 *
 * **`of` is deliberately NOT here, and that is the one that had to be
 * checked.** A device reads as a figure and then its label — `90%` over
 * "of CMOs say buyer discovery now happens inside AI-generated answers" is
 * the correct, idiomatic composition, and it is what `contentFor` puts in a
 * stat callout's `subLabel` on every good plate in the live runs. Refusing it
 * would refuse the shape the system is supposed to produce. The same applies
 * to Hebrew `של`. The tell is `Only`, not the preposition after it.
 */
export const LABEL_SUBORDINATOR_OPENERS: readonly string[] = [
  "only",
  "that",
  "which",
  "who",
  "whom",
  "whose",
  "than",
  "but",
  "and",
  "or",
  "because",
  "while",
  "whereas",
  "though",
  "although",
  // Hebrew: "רק" (only), "אשר" (which), "כי" (because), "אבל" (but), "בעוד"
  // (while) — and NOT "של", for the reason above. The prefixed forms (־ש, ־ו)
  // are attached to the next word, so a label opening with one reads as the
  // same fragment and is caught by the same test.
  "רק",
  "אשר",
  "כי",
  "אבל",
  "בעוד",
];

/**
 * Words a complete clause does not end on. Same defect from the other end:
 * `…within five minutes, meaning` is a sentence that was truncated at the
 * label's character budget rather than written to fit it.
 */
export const LABEL_DANGLING_TAILS: readonly string[] = [
  "meaning",
  "because",
  "and",
  "or",
  "but",
  "of",
  "to",
  "for",
  "with",
  "that",
  "which",
  "than",
  "the",
  "a",
  "an",
  // Hebrew: "כלומר" (meaning), "כי" (because), "של" (of), "עם" (with), "אל" (to).
  "כלומר",
  "כי",
  "של",
  "עם",
  "אל",
];

/**
 * Whether a device label reads as a whole clause rather than as the middle of
 * somebody else's sentence.
 *
 * Deliberately NOT a grammar check. Two string tests — does it start, does it
 * finish — each of which fires on the exact shape a positional cut produces,
 * and neither of which can fire on a label a writer composed. A label is
 * lower-cased and stripped of its punctuation before the comparison so
 * `"Only"`, `"only,"` and `"ONLY"` are one case.
 */
export function isCompleteClause(label: string): { ok: true } | { ok: false; reason: string } {
  const words = label
    .trim()
    .split(/\s+/u)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase())
    .filter((word) => word.length > 0);
  if (words.length === 0) return { ok: false, reason: "the label is empty" };
  // BOTH ENDS, in one reason. The karoslabs label fails at both — it opens
  // with `Only` because the figure was cut out by position and ends on
  // `meaning` because what was left was then truncated to fit — and a check
  // that stopped at the first would send the writer back to fix half of it.
  const problems: string[] = [];
  const first = words[0]!;
  if (LABEL_SUBORDINATOR_OPENERS.indexOf(first) !== -1) {
    problems.push(`the label opens with "${first}", so it is the middle of a sentence with the figure cut out of it, not a clause`);
  }
  const last = words[words.length - 1]!;
  if (LABEL_DANGLING_TAILS.indexOf(last) !== -1) {
    problems.push(`the label ends on "${last}", so it was truncated rather than written to fit`);
  }
  return problems.length === 0 ? { ok: true } : { ok: false, reason: problems.join("; and ") };
}

/** What a cover figure has to be checked against. Structural, so `ResearchFact`, `FactCardForPrompt` and a hand-written card all satisfy it. */
export interface CoverFigureEvidence {
  /**
   * The fact-card claims THIS post's angle rests on, verbatim (`Angle.restsOn`).
   *
   * Empty means the caller could not say, and the check then falls back to
   * every card it was given — weaker, and stated rather than silent. It never
   * abstains entirely: a cover figure that appears in NO card at all is
   * unsourced whatever the angle says.
   */
  citedClaims: readonly string[];
  factCards: readonly { claim: string; source?: string | undefined }[];
  /** The figure this client's PREVIOUS post put on its cover, from skeleton memory. */
  previousCoverFigure?: string | undefined;
}

/** The digits a figure carries, separators and units stripped — `"7.2%"` and `"7.2 %"` compare equal. Mirrors `visual-qa-pre-checks.ts`'s `digitsOf`. */
function figureDigits(value: string): string {
  return value.replace(/[^\d]/gu, "");
}

/**
 * The four rules a writer-declared COVER figure device has to pass, all of
 * them $0 and none of them able to hold a run.
 *
 * Returns every reason rather than the first, because the remedy is one
 * redraft and a writer told about one defect at a time spends three.
 *
 * Applies to the `figure` kind only: `figure_pair`, `bars`, `timeline`,
 * `versus` and `unit_grid` carry their own labels per row and are not the
 * shape this defect takes — a positional cut produces a figure and the
 * sentence it was cut out of.
 */
export function checkCoverFigureDevice(device: SlideDevice, evidence: CoverFigureEvidence): { ok: true } | { ok: false; reasons: string[] } {
  if (device.kind !== "figure") return { ok: true };
  const reasons: string[] = [];
  const digits = figureDigits(device.value);

  // 1. THE FIGURE COMES FROM A CARD THIS POST'S ANGLE RESTS ON.
  const cited = evidence.citedClaims.length > 0 ? evidence.citedClaims : evidence.factCards.map((card) => card.claim);
  const fromAngle = digits.length > 0 && cited.some((claim) => figureDigits(claim).includes(digits));
  if (!fromAngle) {
    const anywhere = digits.length > 0 && evidence.factCards.some((card) => figureDigits(card.claim).includes(digits));
    reasons.push(
      anywhere
        ? `the figure "${device.value}" comes from a fact card this post's angle does not rest on — a cover figure has to be the number THIS post is arguing about`
        : `the figure "${device.value}" does not appear in any fact card, so nothing sources it`,
    );
  }

  // 2 and 3. THE LABEL IS A WHOLE CLAUSE, AND IT FITS.
  const complete = isCompleteClause(device.label);
  if (!complete.ok) reasons.push(`${complete.reason} ("${device.label}")`);
  if (device.label.length > COVER_FIGURE_LABEL_MAX_CHARS) {
    reasons.push(`the label is ${device.label.length} characters (max ${COVER_FIGURE_LABEL_MAX_CHARS}); a cover figure's label is read in one glance`);
  }

  // 4. NOT THE SAME NUMBER THIS CLIENT'S LAST POST LED WITH.
  //
  // Two posts on unrelated topics carrying the identical cover figure is the
  // owner's *"רואים שאותו AI ייצר אותו"* in its most literal form.
  if (evidence.previousCoverFigure !== undefined && figureDigits(evidence.previousCoverFigure) === digits && digits.length > 0) {
    reasons.push(`this client's previous post put the same figure "${device.value}" on its cover; a cover figure is this post's own strongest number`);
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * The figure tokens a device actually PAINTS, in reading order.
 *
 * Read by `default:numbers-are-devices` (`visual-qa-pre-checks.ts`) to answer
 * "does this slide render the figure its headline opens with as a device, or
 * as prose?" — which is why it returns what appears in the pixels rather than
 * every number in the object.
 */
export function deviceFigureValues(device: SlideDevice): string[] {
  switch (device.kind) {
    case "figure":
      return [device.value];
    case "figure_pair":
      return [device.before.value, device.after.value];
    case "bars":
      return device.rows.map((row) => row.display);
    case "timeline":
      return device.points.map((point) => point.at);
    case "versus":
      // A versus split carries no figure of its own; its two sides are prose.
      return [];
    case "unit_grid":
      return [String(device.filled)];
    case "position_map":
      // Positions are an argument drawn as geometry; no numeral is painted.
      return [];
    case "spec_table":
      // The values that open with a figure are the numbers a reader sees.
      return device.rows.map((row) => row.value).filter((value) => /^[^\p{L}]*\d/u.test(value));
  }
}

/**
 * One device as a markup fragment, ready for a `{{html:device}}` slot.
 *
 * Pure and fully escaped. `dir` is used for exactly one thing — which way the
 * before/after arrow points — because everything else mirrors itself through
 * logical properties. Picking the glyph here rather than mirroring it with a
 * `transform` in CSS keeps the stylesheet free of any direction-aware rule at
 * all, which is the property the RTL source scan pins.
 *
 * `targetLanguage` only reaches the illustrative note; it is optional so the
 * two-argument call in the spec stays valid, and an absent language yields
 * the English note rather than no note (an unsourced device must always say
 * it is unsourced).
 */
export function buildDeviceFragment(device: SlideDevice, dir: "ltr" | "rtl", targetLanguage?: string): string {
  const note = `<div class="dv-note">${esc(illustrativeNoteFor(targetLanguage))}</div>`;
  const source = (value: string): string => `<div class="dv-source">${esc(value)}</div>`;

  switch (device.kind) {
    case "figure": {
      return (
        `<div class="dv dv-figure-block">` +
        `<div class="dv-figure ${figureSizeClass(device.value)}">${esc(device.value)}</div>` +
        // `dv-accent` came off this element with the rule that read it (see
        // `.dv-rule`'s note in the sheet below). A class name no selector uses
        // is markup kept alive to satisfy a reader, which is the same defect
        // one file over that kept `.cl-rule` declared for a test to find.
        `<div class="dv-rule"></div>` +
        `<div class="dv-label">${esc(device.label)}</div>` +
        source(device.source) +
        `</div>`
      );
    }
    case "figure_pair": {
      // The arrow is a reading-order glyph, not a layout property — see the
      // doc comment above for why this is the one thing `dir` decides.
      const arrow = dir === "rtl" ? "←" : "→";
      const cell = (side: { value: string; label: string }, accent: boolean): string =>
        `<div class="dv-pair-cell">` +
        `<div class="dv-figure ${figureSizeClass(side.value)}${accent ? " dv-accent" : ""}">${esc(side.value)}</div>` +
        `<div class="dv-label">${esc(side.label)}</div>` +
        `</div>`;
      // The single accent goes to the AFTER value: a before/after device's
      // argument is the second number, and the arrow stays quiet furniture.
      return (
        `<div class="dv dv-pair-block">` +
        `<div class="dv-pair">` +
        cell(device.before, false) +
        `<div class="dv-pair-arrow" aria-hidden="true">${arrow}</div>` +
        cell(device.after, true) +
        `</div>` +
        source(device.source) +
        `</div>`
      );
    }
    case "bars": {
      const max = barMaxFor(device);
      // The single accent goes to the largest row — the one the reader's eye
      // lands on first, and the one the slide is usually about.
      let accentIndex = 0;
      device.rows.forEach((row, index) => {
        if (row.value > device.rows[accentIndex]!.value) accentIndex = index;
      });
      const rows = device.rows
        .map((row, index) => {
          const share = max > 0 ? Math.min(Math.max(row.value / max, 0), 1) : 0;
          const inset = share >= DEVICE_VALUE_INSIDE_BAR_THRESHOLD;
          const accent = index === accentIndex;
          // The percentage is computed here from a number the schema already
          // validated, so this inline `inline-size` can never carry model
          // text — and `inline-size`, not `width`, is what makes the fill
          // grow from the reading-start edge in both directions.
          const fill =
            `<div class="dv-bar-fill${accent ? " dv-accent" : ""}" style="inline-size:${(share * 100).toFixed(1)}%">` +
            (inset ? `<span class="dv-bar-value">${esc(row.display)}</span>` : "") +
            `</div>`;
          return (
            `<div class="dv-bar-row${inset ? " dv-bar-row--inset" : ""}">` +
            `<div class="dv-bar-label">${esc(row.label)}</div>` +
            `<div class="dv-bar-track">${fill}</div>` +
            (inset ? "" : `<span class="dv-bar-value">${esc(row.display)}</span>`) +
            `</div>`
          );
        })
        .join("");
      return `<div class="dv dv-bars-block"><div class="dv-bars">${rows}</div>${source(device.source)}</div>`;
    }
    case "timeline": {
      const lastIndex = device.points.length - 1;
      const points = device.points
        .map((point, index) => {
          // The accent lands on the last point: a timeline's argument is
          // where it ends up.
          const dot = `<div class="dv-tl-dot${index === lastIndex ? " dv-accent" : ""}"></div>`;
          return (
            `<div class="dv-tl-point">${dot}` +
            `<span class="dv-tl-at">${esc(point.at)}</span>` +
            `<span class="dv-tl-what">${esc(point.what)}</span>` +
            `</div>`
          );
        })
        .join("");
      // No `source` on the schema, so an unmeasured timeline must say so.
      return `<div class="dv dv-timeline-block"><div class="dv-timeline">${points}</div>${note}</div>`;
    }
    case "versus": {
      const cell = (side: { label: string; body: string }, accent: boolean): string =>
        `<div class="dv-vs-cell${accent ? " dv-accent" : ""}">` +
        `<div class="dv-vs-label">${esc(side.label)}</div>` +
        `<div class="dv-vs-body">${esc(side.body)}</div>` +
        `</div>`;
      // Exactly one accent element in every case: the winning side, or the
      // mark itself when the point is that neither side wins.
      const neither = device.winner === "neither";
      return (
        `<div class="dv dv-versus-block"><div class="dv-versus">` +
        cell(device.left, device.winner === "left") +
        `<div class="dv-vs-mark${neither ? " dv-accent" : ""}">vs</div>` +
        cell(device.right, device.winner === "right") +
        `</div></div>`
      );
    }
    case "unit_grid": {
      // The accent marker sits on the CONTAINER, so `--dv-ink` inherits down
      // to every filled unit and the fragment still carries exactly one
      // accent element — a hundred separately-marked units would be a
      // hundred places for the rule to drift.
      const units =
        `<span class="dv-unit dv-unit--on"></span>`.repeat(device.filled) +
        `<span class="dv-unit"></span>`.repeat(device.of - device.filled);
      return (
        `<div class="dv dv-units-block">` +
        `<div class="dv-units dv-accent">${units}</div>` +
        `<div class="dv-label">${esc(device.label)}</div>` +
        note +
        `</div>`
      );
    }
    case "position_map": {
      // Geometry from validated integers only (0 to 100), so the inline style
      // can never carry model text. `inset-inline-start`, not `left`: the map
      // mirrors with its labels under `dir="rtl"`, like every other device.
      const points = device.points
        .map(
          (point) =>
            `<div class="dv-pm-point${point.subject ? " dv-accent" : ""}" style="inset-inline-start:${point.x}%;inset-block-end:${point.y}%">` +
            `<span class="dv-pm-mark"></span>` +
            `<span class="dv-pm-label">${esc(point.label)}</span>` +
            `</div>`,
        )
        .join("");
      return (
        `<div class="dv dv-pm-block">` +
        `<div class="dv-pm">` +
        `<div class="dv-pm-axis dv-pm-axis--x"></div><div class="dv-pm-axis dv-pm-axis--y"></div>` +
        `<span class="dv-pm-end dv-pm-end--x-low">${esc(device.xAxis.low)}</span>` +
        `<span class="dv-pm-end dv-pm-end--x-high">${esc(device.xAxis.high)}</span>` +
        `<span class="dv-pm-end dv-pm-end--y-high">${esc(device.yAxis.high)}</span>` +
        `<span class="dv-pm-end dv-pm-end--y-low">${esc(device.yAxis.low)}</span>` +
        points +
        `</div>` +
        note +
        `</div>`
      );
    }
    case "spec_table": {
      const rows = device.rows
        .map((row) => `<div class="dv-st-row"><span class="dv-st-label">${esc(row.label)}</span><span class="dv-st-value">${esc(row.value)}</span></div>`)
        .join("");
      // No accent: a table is information in the ink, and the plate's one
      // accent is spent by the archetype's own mark.
      return `<div class="dv dv-st-block"><div class="dv-st">${rows}</div>${device.source !== undefined ? source(device.source) : ""}</div>`;
    }
  }
}

/**
 * The shared device stylesheet, as a complete `<style>` element.
 *
 * Delivered as an element rather than a bare rule body so it can be handed
 * straight to `composeDocument`/`composeRawDocument`/`materializeTemplates`'s
 * `extraHeadHtml` parameter, exactly as `buildBrandHeadHtml`'s fragment is —
 * one splice channel, one shape.
 *
 * Deliberately NOT folded into the brand head fragment: that fragment only
 * exists when a client has a derivable brand kit, so brandless clients — the
 * ones already rendering on the bare default tokens — would have been exactly
 * the ones whose devices lost their CSS, with nothing anywhere saying so.
 *
 * Every colour is a token or a `color-mix` off one, and every size is
 * `calc(Npx * var(--ts, 1))`, so a client's brand sheet and a script's type
 * scale both still reach these classes.
 */
export function deviceCssBlock(): string {
  return `<style>
/* instagram-agent number devices (Phase 2, item M) — built by slide-devices.ts. */
.dv {
  --dv-quiet: color-mix(in srgb, var(--fg) 22%, transparent);
  margin-block-start: calc(30px * var(--ts, 1));
}
/* The ONE accent-bearing element in a fragment sets the ink every accented
   part reads, so "exactly one accent per device" is a single marker class
   rather than a rule spread across six builders. */
.dv-accent { --dv-ink: var(--accent); }

.dv-figure {
  font-family: var(--f-display); font-weight: 600;
  /* A figure never breaks mid-number. */
  white-space: nowrap;
  line-height: 0.95; letter-spacing: -0.02em;
  font-size: calc(200px * var(--ts, 1));
  /* Not cosmetic, and not slack. A display face's glyph box is TALLER than a
     line box under about 1.15, so a figure set at 0.95 reports
     \`scrollHeight > clientHeight\` — and the renderer's DOM probe reports any
     such element as overflowing, which fails clause B of the interest floor
     (\`probe.overflow\` is a limb no amount of imagery exempts). Measured: a
     150px figure's line box is 143px against 163px of content. A tight line
     height is the right typography for a standalone numeral, so the fix is to
     give the box the descender room rather than to loosen the leading. In
     \`em\`, so it tracks all three size steps and every per-script type scale. */
  padding-block-end: 0.16em;
}
.dv-figure--mid { font-size: calc(150px * var(--ts, 1)); }
.dv-figure--small { font-size: calc(108px * var(--ts, 1)); }
/* The accented figure — the "after" half of a before/after pair. */
.dv-figure.dv-accent { color: var(--dv-ink); }

/* ── THE FIGURE'S RULE IS THE RUN'S MARK, AT THE RUN'S GEOMETRY AND UNDER THE
      RUN'S SWITCH. ──
   It was a 132x12 literal painted in \`var(--accent)\` on every plate carrying
   a figure device, outside \`--fx-accent\` entirely. Measured through the
   production composition (\`karoslabs\`, \`bracket\` on slides [1,4,8], \`m\`):
   \`div.dv-rule 132x12\` in the full accent on the cover, on \`headline-focus\`
   and on \`slide\` — two of which the run's own system did NOT switch the accent
   on for — beside a 96x18 mark on the plates it did. Two lengths and two
   permissions for one object inside one carousel, which is the owner's
   *"sometimes a long marker and sometimes a short one"* measured rather than
   argued.

   So: the GEOMETRY comes from \`--fx-accent-w\`/\`--fx-accent-h\` (the literals
   stay as the var() fallbacks, so a document composed without a run sheet is
   byte-identical), and the INK comes from \`--fx-accent-ink\` with the quiet
   tone as its fallback — so on a plate the system did not switch on the rule
   is still there as composition, in the same 22% grey every other unaccented
   part of a device uses, rather than disappearing and leaving a hole.

   \`.dv-rule\` only, NOT \`.dv-accent\` itself: that marker also colours the
   winning half of a \`figure_pair\`, a bar's fill and a \`vs\` cell, and those
   are \`accentRole: "information"\` — they say WHICH SIDE WON, and an
   accent-off slide that lost them would be unreadable as a comparison.

   ── AND THEN THE INK CAME OFF IT TOO, BECAUSE ONE OBJECT MAY NOT HAVE TWO
      COLOURS IN ONE CAROUSEL. ──
   Taking the GEOMETRY from the run fixed the two lengths and left the two
   colours. Measured across the 198 renders of this tree's probe sweep,
   \`div.dv-rule\` came back in exactly two tones: the brand accent on 18 plates
   (every cover, 6 per client over both scripts and three scales) and
   \`color(srgb … / 0.22)\` — the neutral foreground tone — on 54. On
   thepitchbydeel en m that is \`cover div.dv-rule 240x10 rgb(89, 56, 183)\`
   beside \`headline-focus div.dv-rule 240x10 color(srgb 0.164706 0.121569
   0.301961 / 0.22)\`: identical geometry, the same object, two colours, one
   carousel. On geektime's slide 7 the neutral form is a grey bar on a grey
   ground doing no work at all.
   A reader reads the figure device as ONE object, and this rule is a PART of
   that object — the line between the figure and its label, the same class of
   thing \`headline-focus.html\`'s rule block calls *the EDGE of an object … not
   a rule*. So it is structurally neutral on every plate, and the plate's
   accent is spent where the set spends it: on the one free-standing mark the
   archetype declares (\`.hf-field\`'s cap, \`.cl-art\`'s cap, \`.stat-band\`),
   which is already under \`--fx-accent\`. One object, one colour; the accent
   switch still decides whether the PLATE carries an accent at all. */
.dv-rule {
  inline-size: var(--fx-accent-w, calc(132px * var(--ts, 1)));
  /* The one \`accentForm\` whose width is \`100%\` is \`field\`, and a rule that
     fills the device's own box is still the run's decision about its mark. The
     cap is on the SLOT's measure, not on the literal, so nothing overflows. */
  max-inline-size: 100%;
  block-size: var(--fx-accent-h, calc(12px * var(--ts, 1)));
  background: var(--dv-quiet); margin-block-start: calc(26px * var(--ts, 1));
}
/* Labels wrap BENEATH the figure, in the text face — never the display or mono face. */
.dv-label {
  font-family: var(--f-body); font-weight: 400; font-size: calc(30px * var(--ts, 1));
  line-height: 1.45; text-wrap: pretty; text-align: start;
  margin-block-start: calc(20px * var(--ts, 1)); max-inline-size: calc(760px * var(--ts, 1));
  color: color-mix(in srgb, var(--fg) 88%, transparent);
}
.dv-source {
  font-family: var(--f-body); font-weight: 400; font-size: calc(16px * var(--ts, 1)); line-height: 1.6;
  margin-block-start: calc(18px * var(--ts, 1)); color: color-mix(in srgb, var(--fg) 55%, transparent);
}
.dv-note {
  font-family: var(--f-mono); font-weight: 500; font-size: calc(15px * var(--ts, 1));
  letter-spacing: 0.12em; text-transform: uppercase; margin-block-start: calc(18px * var(--ts, 1));
  color: color-mix(in srgb, var(--fg) 45%, transparent);
}

.dv-pair { display: flex; align-items: flex-start; gap: calc(34px * var(--ts, 1)); }
.dv-pair-cell { flex: 0 1 auto; }
.dv-pair-arrow {
  align-self: center; font-family: var(--f-body); font-size: calc(56px * var(--ts, 1));
  color: color-mix(in srgb, var(--fg) 45%, transparent);
}

.dv-bars { display: flex; flex-direction: column; gap: calc(22px * var(--ts, 1)); }
.dv-bar-row { display: flex; align-items: center; gap: calc(20px * var(--ts, 1)); }
.dv-bar-label {
  flex: 0 0 calc(300px * var(--ts, 1)); font-family: var(--f-body); font-size: calc(26px * var(--ts, 1));
  line-height: 1.35; text-wrap: pretty; text-align: start;
}
/* ── 2026-09-12: THE TRACKS AND THE QUIET FILLS ARE OPAQUE PLATES NOW, NOT
      WASHES. ──
   Every other device in this sheet is a MARK — a 12px rule, a 14px dot, a 6px
   cell border — and a translucent \`color-mix(…, transparent)\` is the right
   treatment for a mark: the plate's own texture reading through a hairline is
   the brand showing, not a defect. A bar chart is the one device made of
   AREA, and the reader's whole job on it is to compare three lengths at a
   glance. Painted at 8% and 22% OVER TRANSPARENT, both the track and the
   non-accent fill let the archetype's ground through — on \`headline-focus\`'s
   dash screen the accent hairlines run straight across the bars — and the
   quiet fill ends up within 2:1 of the track it is supposed to stand out of.

   THE NUMBER, from the guard rather than from a sample. The pixel case in
   \`interest-floor-calibration.test.ts\` ("a bar's fill stands out of its own
   track") renders the same slide twice with one row at 21 and at 40 and takes
   the median of the ~17,400 pixels that are bare track in one frame and fill
   in the other. It measures 1.94:1 on the washes (fill #585759 on track
   #2c2c30) and 3.41:1 on these plates (fill #8a8988 on track #363739); both
   figures are from running that case on this tree, the second as it stands
   and the first with these two lines reverted.

   The candidates, read at feed size and sampled point-wise alongside
   (\`.local/px-bars.mjs\`, real Chromium 1080x1440 @2, the last row's fill and
   its track on headline-focus):

     track / fill mix        fill         track        fill vs track
     8% / 22% over transp.   88,87,89     85,85,86*     1.04:1   <- as shipped
     10% / 46% over --bg     125,124,124  45,46,49      3.26:1
     14% / 52% over --bg     138,137,136  54,55,57      3.41:1   <- this
     18% / 60% over --bg     156,155,153  63,63,65      3.78:1
     (* a single-point sample, and at \`m\` that point lands where a ground
      hairline crosses the track — which is the defect stated as a number:
      the ground is INSIDE the bar. The guard's median, 1.94:1, is the honest
      figure for the washes; this row is why the median was needed.)

   14/52 rather than 18/60 by reading the plates at feed size: at 18/60 the
   grey fills start competing with the accent bar for the eye, and exactly one
   accent per device is this sheet's rule. Mixed with \`var(--bg)\` rather than
   with \`transparent\` so a client's own ground token still sets the tone and
   the ground stops at the track's edge.

   The metric follows the reading rather than leading it: the same plate moves
   from 5.3 / 7.1 / 9.3% imagery-or-device at s/m/l to 7.5 / 9.2 / 11.1%, and
   \`interest-floor.ts\`'s note on IMAGERY_OR_DEVICE_FLOOR — which named this
   exact change as the fix for a device the pixels could not see — carries the
   consequence. No threshold moved. */
.dv-bar-track { flex: 1 1 auto; block-size: calc(40px * var(--ts, 1)); background: color-mix(in srgb, var(--fg) 14%, var(--bg)); }
.dv-bar-fill {
  block-size: 100%; background: var(--dv-ink, color-mix(in srgb, var(--fg) 52%, var(--bg)));
  display: flex; align-items: center; justify-content: flex-end;
  padding-inline-end: calc(14px * var(--ts, 1)); color: var(--bg);
}
/* A VALUE RIDING INSIDE A FILL IS GROUND-COLOURED, whichever fill it is —
   the one place a device inverts.
   It used to be the accent fill alone, with the near-white
   \`color-mix(--fg 92%)\` above covering the quiet one. That was right while
   the quiet fill was a 22%-over-transparent wash (near-white on a composited
   88,87,89 measures 6.0:1) and is wrong now that it is a 52% plate: white on
   138,137,136 is 3.03:1, under the 4.5:1 a 24px mono value wants, while the
   ground token on the same plate is 5.1:1. Both fills are now solid and both
   are light, so both take dark type. The accent pairing is unchanged and is
   still a reported fact (assessContrastFacts) rather than a hope.
   Only \`.dv-bar-row--inset\` rows put a value inside the fill at all
   (share >= DEVICE_VALUE_INSIDE_BAR_THRESHOLD); every other value sits on the
   plate outside the track and keeps the \`--fg\` 80% below. */
.dv-bar-value { font-family: var(--f-mono); font-weight: 600; font-size: calc(24px * var(--ts, 1)); white-space: nowrap; }
.dv-bar-row:not(.dv-bar-row--inset) .dv-bar-value { color: color-mix(in srgb, var(--fg) 80%, transparent); }

.dv-timeline { display: flex; gap: calc(24px * var(--ts, 1)); }
.dv-tl-point {
  flex: 1 1 0; border-block-start: 3px solid color-mix(in srgb, var(--fg) 18%, transparent);
  padding-block-start: calc(20px * var(--ts, 1));
}
.dv-tl-dot {
  inline-size: calc(14px * var(--ts, 1)); block-size: calc(14px * var(--ts, 1));
  background: var(--dv-ink, var(--dv-quiet)); margin-block-end: calc(16px * var(--ts, 1));
}
.dv-tl-at { display: block; font-family: var(--f-mono); font-size: calc(22px * var(--ts, 1)); letter-spacing: 0.1em; }
.dv-tl-what {
  display: block; font-family: var(--f-body); font-size: calc(25px * var(--ts, 1)); line-height: 1.4;
  margin-block-start: calc(10px * var(--ts, 1)); text-wrap: pretty;
  color: color-mix(in srgb, var(--fg) 82%, transparent);
}

.dv-versus { display: flex; align-items: stretch; gap: calc(26px * var(--ts, 1)); }
.dv-vs-cell {
  flex: 1 1 0; border-inline-start: calc(6px * var(--ts, 1)) solid var(--dv-ink, var(--dv-quiet));
  padding-inline-start: calc(24px * var(--ts, 1));
}
.dv-vs-label { font-family: var(--f-display); font-weight: 600; font-size: calc(34px * var(--ts, 1)); line-height: 1.25; }
.dv-vs-body {
  font-family: var(--f-body); font-size: calc(25px * var(--ts, 1)); line-height: 1.45;
  margin-block-start: calc(12px * var(--ts, 1)); text-wrap: pretty;
  color: color-mix(in srgb, var(--fg) 82%, transparent);
}
.dv-vs-mark {
  align-self: center; font-family: var(--f-mono); font-size: calc(26px * var(--ts, 1));
  letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--dv-ink, color-mix(in srgb, var(--fg) 45%, transparent));
}

.dv-units { display: flex; flex-wrap: wrap; gap: calc(9px * var(--ts, 1)); max-inline-size: calc(730px * var(--ts, 1)); }
.dv-unit {
  inline-size: calc(26px * var(--ts, 1)); block-size: calc(26px * var(--ts, 1));
  background: color-mix(in srgb, var(--fg) 16%, transparent);
}
.dv-unit--on { background: var(--dv-ink, var(--accent)); }

/* position_map (2026-09-23): two crossing hairlines, four end labels and up
   to five points. A fixed aspect, so the geometry means the same thing on every
   plate; the subject is the one accented diamond. */
.dv-pm {
  position: relative; inline-size: 100%; max-inline-size: calc(820px * var(--ts, 1));
  aspect-ratio: 4 / 3; margin-block-start: calc(10px * var(--ts, 1));
}
.dv-pm-axis { position: absolute; background: color-mix(in srgb, var(--fg) 24%, transparent); }
.dv-pm-axis--x { inset-inline: 0; inset-block-start: 50%; block-size: 2px; }
.dv-pm-axis--y { inset-block: calc(34px * var(--ts, 1)); inset-inline-start: 50%; inline-size: 2px; }
.dv-pm-end {
  position: absolute; font-family: var(--f-mono); font-size: calc(17px * var(--ts, 1));
  letter-spacing: 0.12em; text-transform: uppercase; white-space: nowrap;
  color: color-mix(in srgb, var(--fg) 55%, transparent);
}
.dv-pm-end--x-low { inset-inline-start: 0; inset-block-start: calc(50% + 12px); }
.dv-pm-end--x-high { inset-inline-end: 0; inset-block-start: calc(50% + 12px); }
.dv-pm-end--y-high { inset-block-start: 0; inset-inline-start: calc(50% + 14px); }
.dv-pm-end--y-low { inset-block-end: 0; inset-inline-start: calc(50% + 14px); }
.dv-pm-point {
  position: absolute; display: flex; flex-direction: column; align-items: center;
  gap: calc(8px * var(--ts, 1)); translate: -50% 50%;
}
[dir="rtl"] .dv-pm-point { translate: 50% 50%; }
.dv-pm-mark {
  display: block; inline-size: calc(20px * var(--ts, 1)); block-size: calc(20px * var(--ts, 1));
  /* A clipped diamond, not a rotated square: a rotation grows the box by
     root two and the render probe reads that as the mark overflowing. */
  clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
  background: var(--dv-ink, color-mix(in srgb, var(--fg) 55%, var(--bg)));
}
.dv-pm-point.dv-accent .dv-pm-mark { inline-size: calc(30px * var(--ts, 1)); block-size: calc(30px * var(--ts, 1)); }
.dv-pm-label {
  font-family: var(--f-body); font-size: calc(22px * var(--ts, 1)); line-height: 1.2; white-space: nowrap;
  color: color-mix(in srgb, var(--fg) 80%, transparent);
}
.dv-pm-point.dv-accent .dv-pm-label { color: var(--fg); font-weight: 600; }

/* spec_table (2026-09-23): label at the start in the small mono step, value
   at the end in the display face, one hairline between rows. */
.dv-st { display: flex; flex-direction: column; max-inline-size: calc(900px * var(--ts, 1)); }
.dv-st-row {
  display: flex; align-items: baseline; justify-content: space-between; gap: calc(28px * var(--ts, 1));
  padding-block: calc(20px * var(--ts, 1));
  border-block-start: 2px solid color-mix(in srgb, var(--fg) 16%, transparent);
}
.dv-st-row:last-child { border-block-end: 2px solid color-mix(in srgb, var(--fg) 16%, transparent); }
.dv-st-label {
  flex: 0 1 40%; font-family: var(--f-mono); font-size: calc(18px * var(--ts, 1));
  letter-spacing: 0.12em; text-transform: uppercase; line-height: 1.4;
  color: color-mix(in srgb, var(--fg) 60%, transparent);
}
.dv-st-value {
  flex: 1 1 60%; text-align: end; font-family: var(--f-display); font-weight: 600;
  font-size: calc(34px * var(--ts, 1)); line-height: 1.2; text-wrap: balance;
}
</style>`;
}
