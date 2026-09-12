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
]);
export type SlideDevice = z.infer<typeof SlideDeviceSchema>;
export type SlideDeviceKind = SlideDevice["kind"];

/** Every device kind, for a caller enumerating them (a prompt's menu, a test's table). */
export const SLIDE_DEVICE_KINDS: readonly SlideDeviceKind[] = ["figure", "figure_pair", "bars", "timeline", "versus", "unit_grid"];

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
  }
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
        `<div class="dv-rule dv-accent"></div>` +
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

.dv-rule {
  inline-size: calc(132px * var(--ts, 1)); block-size: calc(12px * var(--ts, 1));
  background: var(--dv-ink, var(--dv-quiet)); margin-block-start: calc(26px * var(--ts, 1));
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
</style>`;
}
