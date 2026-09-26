import { z } from "zod";

/**
 * Phase 5.5, item C/D — ONE VISUAL SYSTEM PER CAROUSEL.
 *
 * ## The complaint this answers
 *
 * The owner, judging three prep posts as a CMO on 2026-09-16: *"יש קווים כאלה
 * כתומים שזה הכי סימן לפוסט שנעשה עם AI… על חלק מהשקופיות כתוב מספר ועל חלק לא…
 * לפעמים יש מרקר סגול ארוך ולפעמים קצר"*, and — about two posts for two
 * unrelated clients — *"והכי גרוע שהפוסט הזה ושל KAROS LABS רואים שאותו AI ייצר
 * אותו"*.
 *
 * Three separate defects wearing one face:
 *
 * 1. **An accent mark on every slide of every template.** `.stat-band`, the
 *    kicker rails, the panel top-rules and the field caps all painted
 *    unconditionally. An accent on three of eight slides is emphasis; on eight
 *    of eight it is wallpaper, and wallpaper is what a reader recognises as
 *    machine-made.
 * 2. **"A number on some slides and not others."** The brief blamed
 *    `GROUND_VARIATION_MIX = 0.5`. That is stale — `slides-data.ts` has read
 *    `isVariationSlot(1, …)` (a constant, one ground per post) since
 *    2026-09-14. The real cause, grepped across all eight bundled templates:
 *    the 460px outlined `.ground-glyph` existed in **two of eight**
 *    (`closer.html`, `headline-focus.html`). The inconsistency was in the
 *    template set, not in the seed.
 * 3. **Every client rendering the same fleet-wide defaults.** All three
 *    clients shipped `Fraunces, Georgia, Times New Roman, serif` for display
 *    and `Inter, system-ui` for body, because that is what the bundled
 *    templates declare and nothing per-client ever overrode it.
 *
 * ## Two layers, and the split is the whole design
 *
 * **Layer 1 — `ClientVisualSystem`, six frozen axes.** Derived once at setup by
 * `00d2-derive-visual-direction` (or by `fallbackClientVisualSystem` from the
 * brand kit, for $0), persisted on the visual-direction belief, and **never
 * re-derived inside a run**. Two clients that differ on `accentRole` and
 * `displayRegister` alone produce visibly different posts, on every run,
 * forever. This is the layer that answers "two clients must not look alike".
 *
 * **Layer 2 — `CarouselVisualSystem`, resolved per run.** A pure, seeded pick
 * from `VISUAL_SYSTEM_CATALOG` (`pickVisualSystem`), constrained by the frozen
 * axes and pushed away from what this client — and what ANY client — shipped
 * recently. This is the layer that answers "this week's post must not look like
 * last week's".
 *
 * ## Why this is a code step and not a model call
 *
 * $0.00, no turn, identical across a resume, and auditable: `pickVisualSystem`
 * returns its own `reason` and the scores it rejected. The same argument
 * `editorial-series.ts` makes about series selection — a choice a rule can make
 * is a choice a model should not be paid to make — and the same one RFC-20
 * §11.4 made about the bounded object.
 *
 * ## How the decision reaches the pixels
 *
 * `visualSystemCssBlock(system)` renders the resolved system as ONE stylesheet
 * spliced into every document through the `extraHeadHtml` channel (beside
 * `deviceCssBlock()` and `imageTreatmentCssBlock()`). It sets three switch
 * tokens on the slides that earned them:
 *
 *   --fx-accent       `block`  on the slides in `accentSlides`, unset elsewhere
 *   --fx-accent-ink   `var(--accent)` likewise, for accent-COLOURED borders
 *   --fx-pagination   `block`  on the slides in `numeralSlides`
 *
 * and every template reads them as `display: var(--fx-accent, none)` /
 * `color: var(--fx-accent-ink, transparent)`. **That inversion is the point of
 * this package**: today a template that forgets to guard a mark paints it
 * forever; after this, a mark that nobody switched on does not paint at all.
 *
 * Per-SLIDE rather than per-document because the switch has to distinguish
 * slide 3 from slide 4 inside one run, and the sheet is composed once. The
 * selector is `body[data-n="03"]` — `slideIndex` is a field every archetype
 * already emits (`contentFor`'s `base`) and is already in `LAYOUT_FIELD_KEYS`,
 * so this needs no new slot, no new layout-metadata key and no edit to a file
 * this package does not own. `slide.html` already carried `data-n`; this phase
 * adds it to the other seven.
 */

/** Which job the accent does for this client. The one axis with the most visible per-client consequence. */
export const ACCENT_ROLES = ["information", "punctuation", "mark", "field"] as const;
export type AccentRole = (typeof ACCENT_ROLES)[number];

/** The display face's register. Today every client in the fleet renders the same one, which alone makes three posts look related. */
export const DISPLAY_REGISTERS = ["humanist-serif", "grotesque", "condensed", "geometric"] as const;
export type DisplayRegister = (typeof DISPLAY_REGISTERS)[number];

/** Where the type lockup sits on the plate. Consumed as `--lockup-anchor` — see `LOCKUP_ANCHOR`. */
export const COMPOSITION_GRAMMARS = ["top-column", "bottom-column", "centre-measure", "split-band"] as const;
export type CompositionGrammar = (typeof COMPOSITION_GRAMMARS)[number];

/**
 * The grammar as a `justify-content` value on the elastic statement field.
 *
 * `split-band` is `space-between` rather than a fourth anchor because that is
 * what the name says: the statement takes the field's head and whatever follows
 * it (the body, the object) takes its foot, with the band of ground between
 * them as the composition. On a field with ONE child it degrades to
 * `flex-start`, which Chromium does for free.
 */
export const LOCKUP_ANCHOR: Record<CompositionGrammar, string> = {
  "top-column": "flex-start",
  "bottom-column": "flex-end",
  "centre-measure": "center",
  "split-band": "space-between",
};

/**
 * The grammar as the keyword the PLATES select on: written to every slide's
 * `compositionAnchor` field and carried to the template as `data-anchor`.
 *
 * A second, shorter vocabulary than `LOCKUP_ANCHOR` on purpose. That one is a
 * `justify-content` value for the elastic field; this one names the END of the
 * field the lockup is anchored to, because the plates implement the anchor with
 * a flexible pseudo-element rather than with `justify-content` — a spacer
 * survives a hidden first child and an auto margin on `:first-child` does not,
 * which is a trap this system hit three times (see `headline-focus.html`).
 *
 * EXPORTED, and that is the fix. The mapping was inline in `assembleSlidesData`
 * as a ternary, so the axes render sweep did not emit the field at all:
 * `data-anchor` reached the plate EMPTY, no anchor rule matched, all four
 * grammars rendered the default `bottom`, and the case that asserts *"the
 * grammar moves the lockup"* compared a render with itself — it read
 * `contentCentroid.y` 0.5205627983094601 under `top-column` and
 * 0.5205627983094601 under `bottom-column`, identical to sixteen decimal
 * places, which is the signature of an axis that never arrived. One spelling,
 * in the file that owns the axis.
 */
export const COMPOSITION_ANCHOR: Record<CompositionGrammar, string> = {
  "top-column": "top",
  "bottom-column": "bottom",
  "centre-measure": "centre",
  "split-band": "split",
};

/** What this client's pictures are OF. Read by the scene brief and the image vet (W2-A), carried here so it is frozen with the rest. */
export const IMAGERY_REGISTERS = ["documentary", "product-surface", "illustration", "none"] as const;
export type ImageryRegister = (typeof IMAGERY_REGISTERS)[number];

/**
 * Whether this client's slides carry an index.
 *
 * **All or none, never a subset** — that is the axis, and it is the direct
 * answer to *"על חלק מהשקופיות כתוב מספר ועל חלק לא"*. A carousel is one
 * system; the variety belongs across clients and across runs, which is exactly
 * what a frozen per-client axis gives.
 */
export const PAGINATIONS = ["none", "all"] as const;
export type Pagination = (typeof PAGINATIONS)[number];

/** How much texture the plate's ground carries. `near-ground` is the restraint reference's rule 1 ceiling: texture only at near-ground value, never a field you can read as a pattern. */
export const GROUND_TEXTURES = ["flat", "near-ground"] as const;
export type GroundTexture = (typeof GROUND_TEXTURES)[number];

/**
 * The six frozen axes.
 *
 * `basis` is required for the same reason `VisualDirectionLine.basis` is: an
 * axis with no reason behind it is a guess, and a guess frozen for 90 days is a
 * guess that steers thirteen posts. `fallbackClientVisualSystem` fills it with
 * the brand-kit token it read, never with a sentence about having no evidence.
 */
export const ClientVisualSystemSchema = z.object({
  accentRole: z.enum(ACCENT_ROLES),
  displayRegister: z.enum(DISPLAY_REGISTERS),
  compositionGrammar: z.enum(COMPOSITION_GRAMMARS),
  imageryRegister: z.enum(IMAGERY_REGISTERS),
  pagination: z.enum(PAGINATIONS),
  groundTexture: z.enum(GROUND_TEXTURES),
  /** One sentence of basis per axis, keyed by axis name. A frozen axis with no reason is a guess. */
  basis: z.record(z.string(), z.string().min(1).max(200)),
});
export type ClientVisualSystem = z.infer<typeof ClientVisualSystemSchema>;

/**
 * The display stacks, one per register.
 *
 * Every family here is either already loaded by the bundled templates
 * (`Fraunces`, `Inter`, `IBM Plex Mono`) or loaded by the one extra Google
 * Fonts `<link>` this phase adds (`Oswald`, for `condensed`). A register whose
 * family never loads degrades to the next name in its own stack rather than to
 * the browser default, which is why each one ends in a generic.
 *
 * The BODY face stays `Inter` for every register. The display face is what a
 * reader reads as "this brand"; the body face is what they read the post with,
 * and swapping it buys distinctiveness at the cost of legibility at 32px on a
 * phone. `geometric` used to move the mono face too, back when it WAS the mono,
 * because there the mono IS the display face and a second mono would be noise.
 */
export const DISPLAY_REGISTER_STACKS: Record<DisplayRegister, { display: string; weight: string; tracking: string; twinBleed: string }> = {
  "humanist-serif": { display: "'Fraunces', Georgia, 'Times New Roman', serif", weight: "600", tracking: "-0.012em", twinBleed: "0em" },
  grotesque: { display: "'Inter', system-ui, -apple-system, sans-serif", weight: "700", tracking: "-0.028em", twinBleed: "0em" },
  // 0.22em measured, 0.3em shipped — the same ~1.35x margin `.14em` already
  // carries over Fraunces' 0.10em, because the ladder picks a line-height per
  // copy length and the fallback face (`Arial Narrow`) has its own metrics.
  condensed: { display: "'Oswald', 'Arial Narrow', 'Inter', sans-serif", weight: "600", tracking: "-0.004em", twinBleed: "0.3em" },
  // ── WHY THIS REGISTER IS NO LONGER A MONOSPACE. ──
  //
  // It used to be `'IBM Plex Mono', ui-monospace, monospace`, and it was a
  // quarter of all clients. Rendered at the display step it is the loudest
  // machine-made tell in the set: a 94px headline set in a terminal face reads
  // as code rather than as a brand, and the owner's standing complaint about
  // these carousels is precisely that they look AI-made. A mono face earns its
  // place at the micro step — the eyebrow, the source line and the handle are
  // all still set in one — and nowhere else.
  //
  // `Space Grotesk` replaces it because it is GEOMETRIC rather than humanist,
  // so it stays visibly distinct from `grotesque`'s Inter at a glance, which is
  // the only reason to carry four registers at all.
  //
  // The 0.34em twin bleed went with the mono. That number was explicitly "a
  // margin, not a measurement": it was sized against whatever `ui-monospace`
  // resolves to on a CI runner, because the face the stack named was never
  // fetched. This register's face IS fetched, so the bleed is a measurement on
  // the face the plate actually gets.
  geometric: { display: "'Space Grotesk', 'Inter', system-ui, sans-serif", weight: "600", tracking: "-0.02em", twinBleed: "0.06em" },
};

/**
 * ── WHICH SCRIPTS A REGISTER'S LEADING FAMILY ACTUALLY CARRIES. ──
 *
 * The four registers above reason carefully about content-area overshoot,
 * tracking and weight, and not once about GLYPH COVERAGE. All four leading
 * families are Latin-script faces: `script-fonts.ts`'s own module header
 * records the measurement — *"every bundled template hardcodes Google Fonts
 * `Fraunces | Inter | IBM Plex Mono` … Neither of those has a single Hebrew
 * glyph"* — and `Oswald` (Latin/Cyrillic/Vietnamese as Google serves it) is
 * the same class of face. So the honest table is the conservative one: **no
 * register covers a non-Latin script**, and a register is admitted for one
 * only by adding it here against a measurement, never by assumption.
 *
 * What went wrong without it, rendered on this tree: geektime's kit
 * (`"news, bold"` / `"loud"`) resolves deterministically to `condensed`, and
 * `clientVisualSystemCss` emitted `--f-display: 'Oswald', …` with no script
 * condition at all. On a Hebrew carousel that is a display face for a script
 * it cannot set — the Latin words Israeli tech copy is full of (Code, AI,
 * ChatGPT, CTOs) take Oswald and the Hebrew beside them falls through to a
 * wide sans, two typefaces inside one headline, on the client the owner judged
 * hardest. Slide 7's *"כנס Code. מפגש הקהילה השנתי."* is the plate.
 *
 * In production `script-fonts.ts` declares its stack on `body`, which beats
 * this sheet's `:root` for `--f-display` — so the axis was INERT there, while
 * still claiming on the gate payload to be frozen and working. What it was not
 * inert about is the tracking: its Latin `--display-tracking` is emitted on the
 * same display selectors from a fragment composed AFTER the script sheet, so it
 * won every equal-specificity tie. Measured in real Chrome on the geektime kit,
 * a Hebrew plate's `.headline`: `letter-spacing: -0.360974px` before this gate,
 * `normal` after — and negative tracking walks Hebrew's final forms (ך ן ף ץ),
 * whose whole job is to mark a word's end, into the next word.
 * `ScriptTypography.letterSpacing` says exactly that, in that file, about that
 * value. The axis was inert where it was supposed to work and live where it was
 * not, and nothing said either.
 *
 * @see resolveDisplayRegisterForScript
 */
export const DISPLAY_REGISTER_SCRIPTS: Record<DisplayRegister, readonly string[]> = {
  "humanist-serif": ["Latin"],
  grotesque: ["Latin"],
  condensed: ["Latin"],
  geometric: ["Latin"],
};

/**
 * What the run's display register resolves to once the target script is known.
 *
 * `substitutedFor` is the whole point of the record: an axis that quietly
 * stops applying is worse than one that does not exist, because the gate
 * payload keeps claiming it. This travels to `visualDirection.system` so a
 * reviewer reads *"condensed set aside on a Hebrew run"* instead of looking at
 * a plate that does not match the axis it is told is frozen.
 */
export interface DisplayRegisterResolution {
  /** The frozen axis, unchanged — the client's decision is never rewritten. */
  register: DisplayRegister;
  /** `"Latin"` when the run needs no script pack; otherwise the script name from `language-gate.ts`'s own table. */
  script: string;
  /** Whether `register`'s leading family carries `script`. */
  covers: boolean;
  /** Present exactly when it does not: which script forced the face to be set aside, for the payload. */
  substitutedFor?: string;
}

/**
 * Pure, and deliberately taking the script NAME rather than a language or a
 * `ScriptTypography`.
 *
 * `script-fonts.ts` imports `brand-render-tokens.ts`, which imports this file;
 * a dependency the other way would close the cycle. The one caller that knows
 * the run's language (`buildScriptFontHeadForLanguage`'s neighbour in the
 * workflow) resolves the script and passes a string, which also makes this
 * testable without a font table.
 */
export function resolveDisplayRegisterForScript(register: DisplayRegister, script: string | undefined): DisplayRegisterResolution {
  const named = script === undefined || script.trim() === "" ? "Latin" : script.trim();
  const covers = named === "Latin" || DISPLAY_REGISTER_SCRIPTS[register].includes(named);
  return { register, script: named, covers, ...(covers ? {} : { substitutedFor: named }) };
}

/**
 * ── AND WHAT THE REGISTER SETS INSTEAD, WHEN ITS OWN FACE CANNOT SET THE
 *    SCRIPT. WITHHOLDING THE FACE WAS HALF THE FIX. ──
 *
 * `DISPLAY_REGISTER_SCRIPTS` above stops a Latin face being named for a script
 * it has no glyph for, and `clientVisualSystemCss` withholds `--f-display`
 * accordingly. What stands in its place is `script-fonts.ts`'s stack, and that
 * module orders it *client family first, script families next* — deliberately,
 * so *"per-glyph fallback keeps the brand face for Latin loanwords"*.
 *
 * On a BODY paragraph that is a reasonable trade. On a HEADLINE it is the
 * defect the round-1 review names, and it is visible in one glance: measured on
 * this tree through the production composition, every display host of a Hebrew
 * carousel for a kitted client reports its first family setting the Latin run
 * and NOT the Hebrew one — *"הקונים מגבשים העדפה בתוך תשובות AI"* sets `AI` in
 * the brand's Inter and the eleven Hebrew words beside it in Heebo. Two
 * typefaces, different widths, different weights, inside one line of one
 * headline, on every plate.
 *
 * So the register names a face for the script instead of standing down
 * entirely — ONE face for the whole line, chosen to stay as close to the
 * register's own voice as a real Hebrew face allows:
 *
 *   humanist-serif  Frank Ruhl Libre  a Hebrew serif with a full Latin set
 *   grotesque       Heebo             Roboto's Latin, extended to Hebrew
 *   condensed       Heebo             SEE BELOW
 *   geometric       Rubik             `SCRIPT_TYPOGRAPHY.Hebrew.mono`'s own pick
 *
 * `condensed` IS A SUBSTITUTION AND IT IS RECORDED AS ONE. No Hebrew face in
 * the curated set carries the register's width claim, and inventing one would
 * be a typographic assertion about a script on no evidence — the refusal this
 * file's neighbours already practise. It takes the grotesque's face, and
 * `DisplayRegisterResolution.substitutedFor` is what tells the reviewer the
 * axis was set aside rather than silently applied.
 *
 * EVERY FAMILY HERE CARRIES BOTH SCRIPTS, which is the property that makes one
 * face possible at all: Heebo and Rubik ship full Latin, and Frank Ruhl Libre's
 * Latin is part of the same design. A script with no row is not guessed at —
 * the entry is simply absent and today's behaviour (the script pack's stack,
 * client family first) stands, which is the same posture `SCRIPT_TYPOGRAPHY`
 * takes towards a tracking nobody has measured.
 *
 * The stacks are written out rather than imported from `script-fonts.ts` for
 * the reason `resolveDisplayRegisterForScript`'s own note gives: that module
 * imports this one, and a dependency the other way closes the cycle.
 */
export const DISPLAY_REGISTER_SCRIPT_FACES: Readonly<Record<DisplayRegister, Readonly<Record<string, { family: string; stack: string }>>>> = {
  "humanist-serif": { Hebrew: { family: "Frank Ruhl Libre", stack: "'Frank Ruhl Libre', 'Heebo', Georgia, serif" } },
  grotesque: { Hebrew: { family: "Heebo", stack: "'Heebo', 'Rubik', system-ui, sans-serif" } },
  condensed: { Hebrew: { family: "Heebo", stack: "'Heebo', 'Rubik', system-ui, sans-serif" } },
  geometric: { Hebrew: { family: "Rubik", stack: "'Rubik', 'Heebo', system-ui, sans-serif" } },
};

/**
 * The ONE display face this run's headlines are set in, when the register's own
 * cannot set the script. `undefined` on every Latin run and on any script with
 * no row — both mean "change nothing", and a Latin run's sheet stays
 * byte-identical.
 */
export function displayFaceForScript(register: DisplayRegister, script: string | undefined): { family: string; stack: string } | undefined {
  const resolution = resolveDisplayRegisterForScript(register, script);
  if (resolution.covers) return undefined;
  return DISPLAY_REGISTER_SCRIPT_FACES[register][resolution.script];
}

/**
 * ## Why a display face carries a BLEED, and why a new face is a new set of metrics
 *
 * An INLINE box's border box is the FONT's content area (ascent + descent),
 * not its line box, so a `<span>` wrapping a display line starts ABOVE its
 * host's content box — and `probePage`'s block-start limb reports that as an
 * overflowing element, which interest-floor clause B turns into a hard
 * `clipped` finding whose steer ("shorten the headline") cannot fix a font
 * metric. `emphasis-marks.ts` pays for it with `--mk-twin-bleed`, whose
 * `.14em` was measured against **Fraunces and Inter alone**, because until
 * this phase every client in the fleet rendered one of those two.
 *
 * `condensed` broke that. Measured on real Chrome — the content-area
 * overshoot above the line box, at the line-heights the eight bundled
 * templates declare (1.04-1.20), identical at weights 400/500/600/700:
 *
 *   Fraunces        0.02 - 0.10em     <= .14em, pays nothing
 *   Inter           0.01 - 0.09em     <= .14em, pays nothing
 *   IBM Plex Mono   0.06 - 0.14em     AT the limit at lh 1.04
 *   Oswald          0.14 - 0.22em     OVER it at every lh below 1.20
 *
 * Reproduced before the fix: with the Oswald `<link>` present, `cover.html`,
 * `slide.html`, `headline-focus.html` and `closer.html` all reported
 * `probe.overflow` with `["span.mk-runs","span.mk-plain"]`, and the same
 * eight plates under `grotesque` reported none.
 *
 * The face's share is published as `--mk-face-bleed` and combined with the
 * SCRIPT's share at the consumption site with `max()`: Hebrew's `.22em` and
 * Oswald's `.3em` are two independent reasons for the same padding, and the
 * plate needs whichever is larger rather than whichever sheet lands last.
 *
 * `interest-floor-register-sweep.test.ts` renders all eight archetypes once
 * per register and asserts `probe.overflow === false`, which is the guard
 * that did not exist when `condensed` was added.
 */
export const TWIN_BLEED_DECLARATION = "padding-block-start: max(var(--mk-twin-bleed, .22em), var(--mk-face-bleed, 0em));";

/** The one extra family this phase asks Chromium to fetch, and only for the one register that needs it. Its own `<link>`, never appended to the templates' existing three-family request: css2 fails the WHOLE request when any family in a batch is unknown. */
export const CONDENSED_DISPLAY_FONT_FAMILY = "Oswald";

/**
 * ── THE FACE A REGISTER NEEDS FETCHED, WHEN IT IS NOT ONE THE TEMPLATES LOAD. ──
 *
 * The bundled plates request three families. Two registers name a fourth, and
 * a register whose face is never fetched silently renders in its fallback —
 * which is how `condensed` and `grotesque` could come out as the same face on a
 * runner with no Arial Narrow, and two clients then looked like one client.
 *
 * This is a MAP rather than the `if (register === "condensed")` it replaces,
 * because that shape is what made adding `geometric` a chance to reintroduce
 * the same defect: a register added without a line here has no face.
 */
export const REGISTER_DISPLAY_FONT_FAMILY: Partial<Record<DisplayRegister, string>> = {
  condensed: CONDENSED_DISPLAY_FONT_FAMILY,
  geometric: "Space Grotesk",
};

// ─────────────────────────────────────────────────────────────────────────
// The type scale
// ─────────────────────────────────────────────────────────────────────────

/**
 * ONE scale, shared by every archetype, a plate picking a step BY ROLE rather
 * than by which file the writer's layout landed on.
 *
 * Counted on this tree before the change: the eight bundled templates declare
 * **45 distinct `font-size` values** between them (17, 19, 22, 24, 26, 27, 28,
 * 29, 30, 31, 32, 33, 34, 36, 40, 42, 44, 46, 50, 52, 54, 64, 66, 68, 74, 76,
 * 80, 84, 86, 88, 96, 100, 104, 110, 118, 124, 128, 132, 140, 150, 170, 180,
 * 220, 300, 460px). The same semantic element — a kicker, a body paragraph, a
 * source credit — set at a different size in every file. The reference plates
 * the owner supplied use two or three sizes per plate and about six across a
 * whole account (`docs/instagram-restraint-reference.md`).
 *
 * Six steps, and a ladder may only step DOWN the scale: a long headline becomes
 * `t-statement` where a short one is `t-display`. That keeps a length ladder —
 * which every plate needs — inside the system instead of inventing a size.
 *
 * `--ts` (the reviewer's type-scale control) is folded into the VALUES here, so
 * a template reads `font-size: var(--t-display)` and still honours the control.
 * `default-template-render.test.ts` pins that no template carries a bare px
 * `font-size`; this keeps that guarantee while removing the per-file literals.
 */
export const TYPE_SCALE_PX = {
  /** source credit, handle, pagination index */
  micro: 22,
  /** body, list body, caption */
  label: 32,
  /** list item title, comparison label, cover sub-line */
  lead: 46,
  /** interior headline, closer line */
  statement: 84,
  /** cover title, headline-focus statement */
  display: 124,
  /** the one number on a plate that has one */
  figure: 220,
} as const;
export type TypeStep = keyof typeof TYPE_SCALE_PX;

/**
 * The per-run scale flavour. A multiplier on the DISPLAY end of the scale only
 * — `micro` and `label` are reading sizes and do not move, because a body
 * paragraph that shrinks to suit a visual system is a visual system charging
 * the reader for its own variety.
 *
 * `display` 1.00 · `editorial` 0.86 (quieter, more measure, the register the
 * restraint reference plates sit in) · `condensed` 1.12 (a poster). Three
 * values, chosen so the extremes are a visible 30% apart on the same plate and
 * the middle is not a rounding error.
 */
export const TYPE_SCALE_FLAVOURS = ["display", "editorial", "condensed"] as const;
export type TypeScaleFlavour = (typeof TYPE_SCALE_FLAVOURS)[number];
export const TYPE_SCALE_FLAVOUR_MULTIPLIER: Record<TypeScaleFlavour, number> = { display: 1, editorial: 0.86, condensed: 1.12 };

/**
 * The scale as CSS declarations, for a `:root` block.
 *
 * Emitted by every template (so a bare, brandless render is self-contained —
 * the invariant `materialize.ts`'s `extraHeadHtml` note records) and overridden
 * per run by `visualSystemCssBlock`. `lead` and up take the flavour multiplier;
 * `micro` and `label` never do.
 */
export function typeScaleDeclarations(flavour: TypeScaleFlavour = "display"): string[] {
  const k = TYPE_SCALE_FLAVOUR_MULTIPLIER[flavour];
  const step = (name: TypeStep, scaled: boolean): string => {
    const px = Math.round(TYPE_SCALE_PX[name] * (scaled ? k : 1));
    return `  --t-${name}: calc(${px}px * var(--ts, 1));`;
  };
  return [step("micro", false), step("label", false), step("lead", true), step("statement", true), step("display", true), step("figure", true)];
}

// ─────────────────────────────────────────────────────────────────────────
// The brand mark's reserved zone (item F)
// ─────────────────────────────────────────────────────────────────────────

/**
 * The corner the brand mark owns, in CSS px at 1080x1440, and the arithmetic
 * behind both numbers.
 *
 * `size` 132: the mark is capped at `BRAND_MARK_MAX_WIDTH_PX` (65px) and its
 * height follows the asset's own aspect ratio, so a 1:2 portrait mark is 130px
 * tall — 132 is the smallest square that contains any mark this system will
 * render, plus its scrim padding.
 *
 * `inset` 28 against the mark's own 44px inset: the zone therefore extends
 * 16px past the mark on the two outer edges, which is the clearance a
 * neighbouring element needs before a reader reads the two as touching.
 *
 * The owner: *"יש למעלה לוגו שלהם שזה מעולה… אבל הוא דורס כותרת"* — the mark is
 * wanted and it must own its corner. A corner PREFERENCE (which is all
 * `planBrandLogoPlacement` has ever expressed) is not the same as a reserved
 * zone: the preference was computed from the client's STANDING badge while the
 * SERIES badge was written later in the run, so on geektime both landed in
 * `top-start` and the disc sat on the badge.
 */
export const BRAND_MARK_ZONE = { size: 132, inset: 28 } as const;

/**
 * How far into the zone an element has to reach before it is a finding.
 *
 * §7 F4's number. 4px rather than 0 because the probe's boxes are laid-out
 * rects at sub-pixel precision and a glyph's optical hang routinely puts a
 * box a pixel or two past a declared edge — the same tolerance
 * `probePage`'s block-start limb carries, and for the same reason.
 */
export const BRAND_MARK_ZONE_INTRUSION_PX = 4;

/**
 * The mark's rendered width ceiling: 6% of the 1080px canvas.
 *
 * `planBrandLogoPlacement` asks for 150px — 13.9% of the canvas width — and on
 * geektime the white disc was the brightest and largest non-type object on
 * every plate. A brand mark should be present, not dominant. Clamped at the CSS
 * emitter (`brandLogoCss`) rather than in `brand-logo.ts`, because that file is
 * shared with `tiktok-agent`'s video cover surface, where 150px is correct and
 * this ceiling is not.
 */
export const BRAND_MARK_MAX_WIDTH_PX = 65;

/**
 * Where the mark's opacity drops, and why there is a rule at all.
 *
 * When the mark out-contrasts the HEADLINE against the same ground, the eye
 * lands on the logo first — which is the owner's *"הוא דורס כותרת"* read as an
 * art-direction problem rather than a geometry one. 0.9 rather than something
 * lower because the mark must stay legible brand furniture: this is a nudge in
 * the reading order, not a fade.
 */
export const BRAND_MARK_QUIET_OPACITY = 0.9;

// ─────────────────────────────────────────────────────────────────────────
// Layer 2 — the per-run resolved system
// ─────────────────────────────────────────────────────────────────────────

/** Which ground the plates paint. Only the treatments the bundled templates actually implement — see `VISUAL_SYSTEM_CATALOG`'s note on why this list is three long and not five. */
export const SYSTEM_GROUNDS = ["flat", "grid", "glyph"] as const;
export type SystemGround = (typeof SYSTEM_GROUNDS)[number];

/** The shape the accent takes where it is allowed to appear at all. */
export const ACCENT_FORMS = ["rule", "band", "tint", "field", "none"] as const;
export type AccentForm = (typeof ACCENT_FORMS)[number];

/** What the cover leads with. Read by the cover template and (W2-C) by the `coverSubject` clause. */
/**
 * `news-frame` (2026-09-23) is the one form NO catalog entry carries: the
 * Geektime news flash, a brand-coloured frame and a boxed headline. A frame
 * is a signature, and a signature that turned up at random would be a tic, so
 * it is reachable only through `pickVisualSystem`'s `forcedCoverForm`, which
 * the workflow passes for a client in news mode on a single-image post.
 */
export const COVER_FORMS = ["portrait", "object", "figure", "typographic-poster", "news-frame"] as const;
export type CoverForm = (typeof COVER_FORMS)[number];

/**
 * The mark's shape, decided ONCE per carousel by the accent form.
 *
 * Published as `--fx-accent-w` / `--fx-accent-h`, which every accent bar in the
 * bundled set now reads with its own literal as the fallback. Until this
 * shipped, `accentForm` was persisted, held out across clients, printed on the
 * gate payload — and `rule`, `band` and `bracket` were pixel-identical, because
 * the bar's LENGTH was a property of whichever template the slide landed on:
 * 64px on a quote card, 200px on a stat plate, 240px on a closer. Three slides
 * carry a mark and they carried three shapes, which is the owner's *"sometimes
 * a long purple marker and sometimes a short one"*.
 *
 * `none` never reaches a plate (`accentSlidesFor` returns no slides for it) and
 * is listed so the record is total rather than because a value is needed.
 */
export const ACCENT_FORM_GEOMETRY: Record<AccentForm, { w: string; h: string }> = {
  /** A measured rule: long enough to read as a line, short enough to be punctuation. */
  rule: { w: "calc(240px * var(--ts, 1))", h: "calc(10px * var(--ts, 1))" },
  /** A band across most of the measure — the loudest mark short of a surface. */
  band: { w: "calc(560px * var(--ts, 1))", h: "calc(16px * var(--ts, 1))" },
  /** `tint` paints no mark — it spends the colour on the numerals and labels the
   *  plate already carries — so its geometry is zero by construction, not by
   *  omission. Listed so the record stays total. */
  tint: { w: "0", h: "0" },
  /** The full measure, set as a surface edge. `field` takes ONE slide per carousel (see `accentSlidesFor`). */
  field: { w: "100%", h: "calc(24px * var(--ts, 1))" },
  none: { w: "0", h: "0" },
};

/**
 * How tall the cover's masthead band is, per cover form.
 *
 * `coverForm` was chosen, persisted, held out across clients and printed on the
 * gate payload while changing nothing at all — `grep coverForm` outside
 * `visual-system.ts` returned one comment line, and the copy prompt never saw
 * it either. This is the axis reaching the one plate it names.
 *
 * A `typographic-poster` cover has no subject but its title, so the band IS the
 * composition. Every other form expects something in frame — a photograph, a
 * drawn object, a figure device — so the band claims less of the plate and
 * leaves the subject the room. Read by `cover.html` as `var(--cover-band,
 * 600px)`, where it is both the flex CEILING and, since the plate stopped
 * parking free space in a spacer, the only item that can absorb it.
 *
 * ── THE BAND WAS THE CEILING THE COVER KEPT HITTING (2026-09-18). ──
 *
 * These were 600/420/380/300, and at those values the cover could not close
 * its own hole on short copy. The plate has ~1214px between the mark band and
 * the foot; a short-copy lockup takes 350-450px of it; so the band needs to be
 * able to reach ~760-860px or the remainder has nowhere to go and lands as a
 * refused rectangle. Measured on the real-Chromium end-to-end carousel at 420:
 * `interest:dead-space (slide 1) — an empty rectangle covered 35% of the plate
 * (0,932 to 1080,1440)`, a full-width 508px strip at the foot, against a 22%
 * cover ceiling. Every earlier attempt moved that strip — to the head, to the
 * middle under `space-between`, to a column beside the copy — because the
 * spacers, the anchor and the measure all decide WHERE the air goes and only
 * this number decides whether anything can absorb it.
 *
 * The ordering and the axis are unchanged, and none of them is a screen: the
 * band still shrinks to nothing for a long headline (`flex-shrink: 1`,
 * `min-block-size: 0` — the copy never clips for the decoration), still paints
 * one `no-repeat` ramp, and at 57% of the canvas at its tallest still leaves
 * the lower third of every cover to the words. RFC-20 §5.6 rule 4 is not in
 * play: no floor, ceiling or gate moved for this — the composition did.
 */
export const COVER_FORM_BAND_PX: Record<CoverForm, number> = {
  "typographic-poster": 900,
  figure: 820,
  object: 780,
  portrait: 700,
  // The news frame hides the band (`cov-field`) outright: the box and the
  // photograph are the whole composition, so nothing reads this value.
  "news-frame": 0,
};

export interface CarouselVisualSystem {
  /** Stable across a resume, written to skeleton memory and to the cross-client belief. */
  systemId: string;
  /**
   * The client's composition grammar, carried on the RESOLVED system so the
   * slide data can hand it to the plate as a selectable keyword. It was
   * published only as `--lockup-anchor`, and a custom property cannot be used
   * in a selector — so all four grammars put the lockup at the same y.
   */
  compositionGrammar: CompositionGrammar;
  ground: SystemGround;
  /**
   * THE ONLY slides on which any template may paint an accent rule, band or
   * bar. **At most three**, always including slide 1 and the last slide.
   */
  accentSlides: readonly number[];
  accentForm: AccentForm;
  /**
   * The slides carrying the pagination index: **every interior slide, or
   * none.** Never a subset — that is the defect this axis exists to remove.
   * The cover is excluded by role (§4.5: the cover carries no furniture at
   * all), which is a role rule and not a subset.
   */
  numeralSlides: readonly number[];
  /** Replaces the series badge. Topical, written by the copy agent as the slide's `kicker`, or absent. */
  eyebrow: { kind: "none" } | { kind: "topical"; slides: readonly number[] };
  coverForm: CoverForm;
  typeScale: TypeScaleFlavour;
  gutter: "wide" | "tight";
  /** Why this system, for the gate payload and the trace. */
  reason: string;
}

/**
 * A catalog entry: everything about a system that does NOT depend on the run's
 * slide count or the client's frozen axes.
 */
export interface VisualSystemEntry {
  id: string;
  ground: SystemGround;
  accentForm: AccentForm;
  coverForm: CoverForm;
  typeScale: TypeScaleFlavour;
  gutter: "wide" | "tight";
  /** Which frozen `accentRole`s this system is legible under. A `punctuation` client may not take a `field` system: the axis would contradict itself on the plate. */
  accentRoles: readonly AccentRole[];
}

/**
 * Twelve systems.
 *
 * ## Why twelve and why these
 *
 * Four accent forms x three cover forms is the grid that actually changes what
 * a plate looks like; twelve is that grid with the combinations a reader could
 * not tell apart removed and the remaining slots spread across the three
 * grounds and three type flavours. With the per-client `accentRole` filter,
 * a typical client sees six or seven of them, and the rotation rules below
 * mean a weekly client does not repeat one for about six weeks.
 *
 * ## Why `ground` has three values and not the five the work package listed
 *
 * `panel` and `duotone` are not implemented anywhere in the bundled template
 * set, and `duotone` is already `style-lock.ts`'s `imageTreatment` — a second
 * spelling of it here would be two sources for one decision, which is the drift
 * this repo refuses on principle. Emitting a ground token no template paints is
 * exactly the defect this phase found in `groundStyle`: a treatment named in
 * the data and absent from six of eight files. Three grounds, all three of
 * which a template actually renders.
 *
 * ## Why `imageTreatment` is not a field here
 *
 * Same reason. The run's one frozen treatment is resolved by `04k` through
 * `style-lock.ts` and reaches every document through `imageTreatmentCssBlock`.
 * W2-A extends it to retrieved stock. A copy of it on this interface would be a
 * second opinion that can disagree with the sheet the document was built from.
 */
export const VISUAL_SYSTEM_CATALOG: readonly VisualSystemEntry[] = [
  { id: "quiet-rule", ground: "flat", accentForm: "rule", coverForm: "typographic-poster", typeScale: "editorial", gutter: "wide", accentRoles: ["punctuation", "information"] },
  { id: "quiet-figure", ground: "flat", accentForm: "none", coverForm: "figure", typeScale: "display", gutter: "wide", accentRoles: ["punctuation", "mark", "information"] },
  { id: "quiet-portrait", ground: "flat", accentForm: "tint", coverForm: "portrait", typeScale: "editorial", gutter: "tight", accentRoles: ["punctuation", "mark"] },
  { id: "ruled-object", ground: "grid", accentForm: "rule", coverForm: "object", typeScale: "display", gutter: "wide", accentRoles: ["information", "punctuation"] },
  { id: "ruled-poster", ground: "grid", accentForm: "band", coverForm: "typographic-poster", typeScale: "condensed", gutter: "tight", accentRoles: ["field", "information"] },
  { id: "ruled-portrait", ground: "grid", accentForm: "tint", coverForm: "portrait", typeScale: "editorial", gutter: "wide", accentRoles: ["mark", "punctuation"] },
  { id: "glyph-figure", ground: "glyph", accentForm: "rule", coverForm: "figure", typeScale: "display", gutter: "tight", accentRoles: ["information", "punctuation"] },
  { id: "glyph-poster", ground: "glyph", accentForm: "field", coverForm: "typographic-poster", typeScale: "condensed", gutter: "wide", accentRoles: ["field"] },
  { id: "glyph-object", ground: "glyph", accentForm: "band", coverForm: "object", typeScale: "display", gutter: "wide", accentRoles: ["field", "information"] },
  // The one system with NO standing accent at all: a `mark` client spends its
  // colour inside the type (`emphasis-marks.ts`), so a bar under the headline
  // would be the same idea said twice — restraint-reference rule 4, *colour is
  // information or punctuation, never a surface*, and punctuation repeated is
  // not punctuation.
  { id: "marked-portrait", ground: "flat", accentForm: "none", coverForm: "portrait", typeScale: "display", gutter: "tight", accentRoles: ["mark"] },
  { id: "banded-object", ground: "grid", accentForm: "band", coverForm: "object", typeScale: "editorial", gutter: "tight", accentRoles: ["field", "mark"] },
  { id: "bracketed-figure", ground: "glyph", accentForm: "tint", coverForm: "figure", typeScale: "condensed", gutter: "wide", accentRoles: ["punctuation", "mark", "information"] },
];

/**
 * How many recent systems are held out, per scope.
 *
 * OWN 4: a weekly client should not see the same plate shape within a month.
 * CROSS-CLIENT 5: the owner's complaint was about two posts on the SAME DAY,
 * so the window has to be wide enough to catch a day's batch and narrow enough
 * that a twelve-entry catalog never empties.
 */
export const SYSTEM_OWN_HOLD = 4;
export const SYSTEM_CROSS_CLIENT_HOLD = 5;

/** FNV-1a, the same hash `slides-data.ts` uses for its seeded walks. Pure: the seed is the only input. */
function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface PickVisualSystemParams {
  clientSlug: string;
  /** The run id, as everywhere else in this agent's seeded walks. Absent is treated as an empty seed — deterministic, just not varied. */
  paletteSeed?: string | undefined;
  /** How many slides the draft actually has. Decides `accentSlides`' middle entry and the pagination set. */
  slideCount: number;
  /** The frozen axes. Absent means a client whose setup has never produced them — `fallbackClientVisualSystem` is what the caller passes instead of nothing. */
  client: ClientVisualSystem;
  /** The run's series, so the same story on the same seed does not resolve the same system for two different formats. */
  seriesId?: string | undefined;
  /** This client's own recently shipped `systemId`s, newest first (skeleton memory). */
  recentOwnSystemIds?: readonly string[] | undefined;
  /** Every client's recently shipped `systemId`s, newest first (`CROSS_CLIENT_FORMAT_BELIEF_KEY`). Unreadable means an empty list — never a hold. */
  recentCrossClientSystemIds?: readonly string[] | undefined;
  /**
   * A cover form this run MUST use, overriding the catalog entry's (2026-09-23).
   * Only `news-frame` is ever passed, by a client in news mode on a single
   * post; everything else about the system is still picked as it always was.
   */
  forcedCoverForm?: CoverForm | undefined;
  /**
   * The axes the client's exemplar library agrees on (`exemplarLook`,
   * 2026-09-26). Applied AFTER the variety holds: among the systems still in
   * the pool, the ones matching the most axes are kept and the seed draws
   * among them. Absent, or matching nothing, leaves today's uniform draw.
   */
  preferred?: { ground?: SystemGround | undefined; accentForm?: AccentForm | undefined; typeScale?: TypeScaleFlavour | undefined } | undefined;
}

/**
 * The run's visual system. Pure, seeded, total, and never throws.
 *
 * ## The filter ladder, and why it fails open at every rung
 *
 * 1. the systems this client's `accentRole` can carry;
 * 2. minus the ones this client shipped in its last `SYSTEM_OWN_HOLD` posts;
 * 3. minus the ones ANY client shipped in the last `SYSTEM_CROSS_CLIENT_HOLD`
 *    posts.
 *
 * Each rung is dropped rather than enforced when it would empty the pool, in
 * that order (cross-client first, then own, then the role filter). A variety
 * rule that can refuse to produce a system is a variety rule that can hold a
 * run, and the owner's standing rule is that a run adapts and delivers.
 *
 * ## Determinism
 *
 * The seed is `clientSlug:paletteSeed:seriesId`, so the same run resolves the
 * same system on a resume and on a re-render, and two clients on the same day
 * with the same story resolve different ones. Nothing here reads a clock.
 */
export function pickVisualSystem(params: PickVisualSystemParams): CarouselVisualSystem {
  const role = params.client.accentRole;
  const byRole = VISUAL_SYSTEM_CATALOG.filter((entry) => entry.accentRoles.includes(role));
  const roleOk = byRole.length > 0 ? byRole : [...VISUAL_SYSTEM_CATALOG];

  const ownHeld = new Set((params.recentOwnSystemIds ?? []).slice(0, SYSTEM_OWN_HOLD));
  const crossHeld = new Set((params.recentCrossClientSystemIds ?? []).slice(0, SYSTEM_CROSS_CLIENT_HOLD));

  const notOwn = roleOk.filter((entry) => !ownHeld.has(entry.id));
  const notEither = notOwn.filter((entry) => !crossHeld.has(entry.id));
  const heldPool = notEither.length > 0 ? notEither : notOwn.length > 0 ? notOwn : roleOk;
  const relaxed = notEither.length > 0 ? undefined : notOwn.length > 0 ? "cross-client" : "own-history";
  // The category's taste narrows what the holds left, never the holds.
  const preferred = params.preferred;
  const score = (entry: (typeof VISUAL_SYSTEM_CATALOG)[number]): number =>
    preferred === undefined
      ? 0
      : (preferred.ground !== undefined && entry.ground === preferred.ground ? 1 : 0) +
        (preferred.accentForm !== undefined && entry.accentForm === preferred.accentForm ? 1 : 0) +
        (preferred.typeScale !== undefined && entry.typeScale === preferred.typeScale ? 1 : 0);
  const best = Math.max(0, ...heldPool.map(score));
  const pool = best > 0 ? heldPool.filter((entry) => score(entry) === best) : heldPool;

  const seed = `${params.clientSlug}:${params.paletteSeed ?? ""}:${params.seriesId ?? ""}`;
  const entry = pool[fnv1a32(seed) % pool.length]!;

  const count = Number.isFinite(params.slideCount) ? Math.max(2, Math.floor(params.slideCount)) : 2;
  const accentSlides = accentSlidesFor(count, entry.accentForm, seed);
  const compositionGrammar = params.client.compositionGrammar;
  const numeralSlides = params.client.pagination === "all" ? interiorSlides(count) : [];
  const eyebrow: CarouselVisualSystem["eyebrow"] = eyebrowFor(params.client, count);

  const heldNote =
    relaxed === undefined
      ? ownHeld.size + crossHeld.size > 0
        ? ` (held out: ${[...new Set([...ownHeld, ...crossHeld])].join(", ")})`
        : ""
      : ` (the ${relaxed} hold was dropped — it would have left no system, and variety never refuses a post)`;

  return {
    systemId: entry.id,
    compositionGrammar,
    ground: entry.ground,
    accentSlides,
    accentForm: entry.accentForm,
    numeralSlides,
    eyebrow,
    coverForm: params.forcedCoverForm ?? entry.coverForm,
    typeScale: entry.typeScale,
    gutter: entry.gutter,
    reason:
      `visual system "${entry.id}": ${role} accent, ${entry.ground} ground, ${params.forcedCoverForm ?? entry.coverForm} cover` +
      `${params.forcedCoverForm !== undefined ? ` (the client's news mode sets the cover; the catalog entry's is ${entry.coverForm})` : ""}${heldNote}` +
      `${best > 0 ? ` (matches ${best} axis/axes the client's best exemplars share)` : ""}`,
  };
}

/**
 * The cover, the slide carrying the argument's turn, and the closer — and
 * nothing else.
 *
 * An accent on three of eight slides is emphasis; on eight of eight it is
 * wallpaper. The middle entry is the midpoint rather than a seeded pick because
 * the turn of an argument is structurally in the middle, and a randomised third
 * mark is the within-carousel randomness this phase is removing.
 *
 * `accentForm: "field"` is the one form the spec permits **at most once per
 * carousel** (a surface behind a block is loud), so it takes the closer alone.
 * `"none"` takes nothing at all, which is a legitimate system: a client whose
 * accent role is `mark` spends its colour inside the type, where
 * `emphasis-marks.ts` puts it.
 */
export function accentSlidesFor(slideCount: number, form: AccentForm, seed = ""): number[] {
  const n = Math.max(2, Math.floor(slideCount));
  if (form === "none") return [];
  if (form === "field") return [n];

  /* ── SEEDED, BECAUSE A RULE IS WHAT A READER RECOGNISES. ──
   *
   * This used to return `[1, ceil(n/2), n]` — a pure function of the slide
   * count, so every client with an eight-plate carousel got the accent on
   * plates 1, 4 and 8, forever. Rendered side by side, three different clients
   * on three different systems all marked the same three plates, and the owner
   * named it exactly: *"יש קו כתום אופקי כזה שלרוב מעיד על AI, זה בסדר אם זה
   * פעם אחת וקורה לפעמים אבל שלא יהיה קבוע"*. A mark that appears in the same
   * place every time is not an accent, it is furniture.
   *
   * Two things change. The COUNT varies (one to three plates, not always
   * three), and the PLATES are drawn from the whole carousel without the cover
   * having any privilege — so a given run's cover carries the accent roughly as
   * often as any other plate does, and not by rule.
   */
  const head = fnv1a32(`accent:${seed}`);
  const pool: number[] = [];
  for (let slide = 1; slide <= n; slide++) pool.push(slide);

  const want = Math.min(1 + (head % 3), pool.length);
  const picked: number[] = [];
  let roll = head;
  while (picked.length < want) {
    roll = fnv1a32(`accent:${seed}:${picked.length}:${roll}`);
    picked.push(pool.splice(roll % pool.length, 1)[0]!);
  }
  return picked.sort((a, b) => a - b);
}

/** Every slide that is neither the cover nor the closer. The cover carries no furniture at all (§4.5) and the closer is a payoff, not a page in a sequence. */
export function interiorSlides(slideCount: number): number[] {
  const n = Math.max(2, Math.floor(slideCount));
  const out: number[] = [];
  for (let slide = 2; slide < n; slide++) out.push(slide);
  return out;
}

/**
 * Which slides may print a topical eyebrow.
 *
 * NEVER the cover (§4.5 — the cover's only job is to be looked at) and never
 * every slide, which is what the series badge did and what the owner read as
 * an AI tell. A `documentary`/`product-surface` client gets the eyebrow on the
 * closer plus the first two interiors, where it works as a section marker; an
 * `illustration` or `none` client gets none, because there the picture is the
 * label.
 */
export function eyebrowFor(client: ClientVisualSystem, slideCount: number): CarouselVisualSystem["eyebrow"] {
  if (client.imageryRegister === "illustration" || client.imageryRegister === "none") return { kind: "none" };
  const interiors = interiorSlides(slideCount);
  const slides = [...interiors.slice(0, 2), Math.max(2, Math.floor(slideCount))].filter((s, i, all) => all.indexOf(s) === i);
  return slides.length > 0 ? { kind: "topical", slides } : { kind: "none" };
}

// ─────────────────────────────────────────────────────────────────────────
// The fallback — every client has a system, on every run, for $0
// ─────────────────────────────────────────────────────────────────────────

/**
 * The six axes derived from the brand kit alone, with no model call.
 *
 * This is the insurance that makes the system real for a client whose setup has
 * never succeeded — which on 2026-09-16 was **all three prep clients**
 * (`00d2-derive-visual-direction` hit its 3,000-token ceiling on two of them and
 * the failure marker then locked the retry for seven days). Without it,
 * "one visual system per carousel" would be a promise that only clients with a
 * working Template Studio ever collect on, and the fleet would keep rendering
 * the identical defaults this phase exists to break.
 *
 * Every axis is derived from a token that actually varies between clients, and
 * `basis` names which one. The `clientSlug` hash is the LAST resort and is used
 * for exactly two axes, both of which are safe to vary arbitrarily (there is no
 * wrong pagination and no wrong cover grammar) — never for `imageryRegister`,
 * where a wrong guess would steer what the pictures are OF.
 */
export function fallbackClientVisualSystem(tokens?: {
  accentColor?: string | undefined;
  palette?: readonly string[] | undefined;
  aesthetic?: string | undefined;
  visualMood?: string | undefined;
  clientSlug?: string | undefined;
}): ClientVisualSystem {
  const slug = tokens?.clientSlug ?? "";
  const h = fnv1a32(`${slug}:visual-system`);
  const paletteSize = (tokens?.palette ?? []).length;
  const aesthetic = (tokens?.aesthetic ?? "").toLowerCase();
  const mood = (tokens?.visualMood ?? "").toLowerCase();

  /**
   * A client with a real palette can afford to encode meaning in colour; a
   * client with one accent cannot (every mark would be the same colour, so the
   * colour says nothing) and spends it as punctuation instead. A kit that
   * describes itself as bold or editorial takes the accent inside the type.
   */
  const accentRole: AccentRole =
    paletteSize >= 3 ? "information" : /bold|editorial|magazine|statement/.test(`${aesthetic} ${mood}`) ? "mark" : paletteSize >= 2 ? "field" : "punctuation";

  /**
   * ── AND WITH NO EVIDENCE AT ALL IT IS SEEDED, NOT CONSTANT. ──
   *
   * The three-client probe on this tree resolved `grotesque` for ALL THREE —
   * and it was right to, because every one of those kits has a one-colour
   * palette and no `aesthetic`/`visualMood`, so all three fell off the end of
   * the ladder onto a literal. Three clients then rendered the same face on
   * every plate of every post, which is one third of *"you can see the same AI
   * made both posts"* and it had nothing to do with the templates: the axis
   * reaches the pixels (`clientVisualSystemCss` sets `--f-display`, the weight
   * and the tracking off it), the DERIVATION was collapsing.
   *
   * So the no-evidence branch does what `compositionGrammar` and `pagination`
   * already do one line down: it seeds off the slug, which is stable across
   * runs and resumes and differs between clients. A different bit of the same
   * hash, so two axes cannot move in lockstep.
   *
   * Safe on every script, because the script resolution is already
   * downstream: `resolveDisplayRegisterForScript` sets a register aside when
   * its first family carries no glyph for the run's script, and
   * `script-fonts.ts`'s own stack stands. A Hebrew client seeded onto
   * `humanist-serif` therefore gets Heebo and not two typefaces in one
   * headline.
   */
  const displayRegister: DisplayRegister = /mono|technical|engineer|terminal|code/.test(`${aesthetic} ${mood}`)
    ? "geometric"
    : /bold|poster|loud|punch|news/.test(`${aesthetic} ${mood}`)
      ? "condensed"
      : /editorial|classic|warm|craft|serif/.test(`${aesthetic} ${mood}`)
        ? "humanist-serif"
        : DISPLAY_REGISTERS[(h >>> 16) % DISPLAY_REGISTERS.length]!;

  const imageryRegister: ImageryRegister = /illustrat|drawn|graphic/.test(`${aesthetic} ${mood}`)
    ? "illustration"
    : /product|screen|interface|saas|app/.test(`${aesthetic} ${mood}`)
      ? "product-surface"
      : "documentary";

  const compositionGrammar = COMPOSITION_GRAMMARS[h % COMPOSITION_GRAMMARS.length]!;
  const pagination: Pagination = (h >>> 8) % 2 === 0 ? "all" : "none";
  const groundTexture: GroundTexture = paletteSize >= 2 ? "near-ground" : "flat";

  return {
    accentRole,
    displayRegister,
    compositionGrammar,
    imageryRegister,
    pagination,
    groundTexture,
    basis: {
      accentRole: paletteSize >= 3 ? `the kit declares ${paletteSize} palette colours, so colour can carry a category` : "the kit declares one accent or none, so colour is punctuation rather than information",
      displayRegister:
        aesthetic.length > 0 || mood.length > 0
          ? `brand kit: aesthetic/visualMood ("${`${aesthetic} ${mood}`.trim().slice(0, 60)}")`
          : "no typographic tokens on file; seeded from the client slug, which is stable per client and differs between clients — a literal default here made every kit-less client render one face",
      compositionGrammar: "no evidence for a lockup position on file; seeded from the client slug, which is stable and differs per client",
      imageryRegister: aesthetic.length > 0 || mood.length > 0 ? "brand kit: aesthetic/visualMood" : "no evidence on file — documentary, the register a stock library can actually fill",
      pagination: "no evidence for an index on file; seeded from the client slug, so the choice is stable per client and differs between clients",
      groundTexture: paletteSize >= 2 ? "the kit has a second colour to derive a near-ground tone from" : "one colour in the kit — a derived texture would be the accent at low alpha, which reads as a tint rather than a material",
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Cross-client variety (item D2)
// ─────────────────────────────────────────────────────────────────────────

/**
 * The AGENT-level belief key.
 *
 * `skeleton-memory.ts` holds per-CLIENT history and has no cross-client
 * dimension, which is why karoslabs and thepitchbydeel both landed
 * `by_the_numbers` on 2026-09-16 for two unrelated stories. This key is scoped
 * to the agent rather than to a client.
 *
 * **Only the series id, the system id, the client slug and a timestamp
 * travel.** No topic, no angle, no copy, no URL — a fleet-scoped document is
 * exactly the place a client's subject matter must not leak into, and the
 * penalty this data buys does not need to know what anybody wrote about.
 */
export const CROSS_CLIENT_FORMAT_BELIEF_KEY = "instagramFormatsAcrossClients";

/** How many entries are kept. Twenty is four days of a seven-client fleet, which is the window the two holds above read from. */
export const CROSS_CLIENT_HISTORY_LIMIT = 20;

export interface CrossClientFormatEntry {
  /** ISO 8601. */
  at: string;
  clientSlug: string;
  seriesId: string;
  systemId: string;
  /** The shipped post's slide skeleton signature (`skeleton-memory.ts`), when the row carries one. Fleet rows from 2026-09-24 on do. */
  skeleton?: string;
}

export interface CrossClientFormatHistory {
  version: 1;
  entries: CrossClientFormatEntry[];
}

export const EMPTY_CROSS_CLIENT_HISTORY: Readonly<CrossClientFormatHistory> = { version: 1, entries: [] };

/**
 * Reads the fleet history, and **fails open in every direction**.
 *
 * An absent key, a malformed document, a row with a missing field, a value of
 * the wrong type: all of them yield an empty history, which means no penalty
 * and no hold. This is a variety nudge on a document nobody is required to have
 * written yet; it must never be able to refuse a post, and a `safeParse` that
 * threw on one bad row would take the whole fleet's history down with it.
 */
export function readCrossClientFormatHistory(beliefs: unknown): CrossClientFormatHistory {
  const raw = beliefs !== null && typeof beliefs === "object" ? (beliefs as Record<string, unknown>)[CROSS_CLIENT_FORMAT_BELIEF_KEY] : undefined;
  if (raw === null || typeof raw !== "object") return { version: 1, entries: [] };
  const rows = (raw as Record<string, unknown>)["entries"];
  if (!Array.isArray(rows)) return { version: 1, entries: [] };
  const entries: CrossClientFormatEntry[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const at = typeof r["at"] === "string" ? r["at"] : undefined;
    const clientSlug = typeof r["clientSlug"] === "string" ? r["clientSlug"] : undefined;
    const seriesId = typeof r["seriesId"] === "string" ? r["seriesId"] : undefined;
    const systemId = typeof r["systemId"] === "string" ? r["systemId"] : undefined;
    if (at === undefined || clientSlug === undefined || seriesId === undefined || systemId === undefined) continue;
    const skeleton = typeof r["skeleton"] === "string" && r["skeleton"].length > 0 ? r["skeleton"] : undefined;
    entries.push({ at, clientSlug, seriesId, systemId, ...(skeleton !== undefined ? { skeleton } : {}) });
  }
  return { version: 1, entries: entries.slice(-CROSS_CLIENT_HISTORY_LIMIT) };
}

/**
 * The client's own history and the FLEET's (`memory.readFleet`), as one
 * history ordered by time (2026-09-24). Before the fleet read existed the
 * cross-client readers only ever saw the calling client's own rows, excluded
 * them, and abstained on every run. Deduplicated on (clientSlug, at).
 */
export function mergeCrossClientHistories(own: CrossClientFormatHistory, fleet: CrossClientFormatHistory): CrossClientFormatHistory {
  const byKey = new Map<string, CrossClientFormatEntry>();
  for (const entry of [...own.entries, ...fleet.entries]) byKey.set(`${entry.clientSlug}|${entry.at}`, entry);
  const entries = [...byKey.values()].sort((a, b) => a.at.localeCompare(b.at));
  return { version: 1, entries: entries.slice(-CROSS_CLIENT_HISTORY_LIMIT) };
}

/** Slide skeletons OTHER clients shipped most recently, newest first, distinct. */
export function crossClientSkeletons(history: CrossClientFormatHistory, clientSlug: string, window: number): string[] {
  const out: string[] = [];
  for (const entry of [...history.entries].reverse()) {
    if (entry.clientSlug === clientSlug || entry.skeleton === undefined || out.includes(entry.skeleton)) continue;
    out.push(entry.skeleton);
    if (out.length >= Math.max(0, Math.floor(window))) break;
  }
  return out;
}

/** Appends one row and trims to the limit. Pure — the caller persists the result. */
export function recordCrossClientFormat(history: CrossClientFormatHistory, entry: CrossClientFormatEntry): CrossClientFormatHistory {
  return { version: 1, entries: [...history.entries, entry].slice(-CROSS_CLIENT_HISTORY_LIMIT) };
}

/**
 * The series ids OTHER clients shipped in the fleet's last `window` posts,
 * newest first.
 *
 * `clientSlug` is excluded because the client's own rotation is already
 * `skeleton-memory`'s job and it holds a series out for two posts; counting it
 * twice would make a client's own repeat cost 5 points, which is enough to beat
 * a genuine evidence fit.
 */
export function crossClientSeriesIds(history: CrossClientFormatHistory, clientSlug: string, window: number): string[] {
  return [...history.entries]
    .reverse()
    .filter((entry) => entry.clientSlug !== clientSlug)
    .slice(0, Math.max(0, Math.floor(window)))
    .map((entry) => entry.seriesId)
    // A run whose `04i2` failed open shipped no series and records `""`. It is
    // still a row — it holds a SYSTEM out — but it names no format, and a "" in
    // the hold list would match no catalogue id anyway. Dropped explicitly for
    // the reason `recentSeriesIds` skips its own gaps: a padded empty occupies
    // a slot in the window and silently shortens the real one.
    .filter((id) => id.length > 0);
}

/** The system ids OTHER clients shipped in the fleet's last `window` posts, newest first. Same exclusion, same reason. */
export function crossClientSystemIds(history: CrossClientFormatHistory, clientSlug: string, window: number): string[] {
  return [...history.entries]
    .reverse()
    .filter((entry) => entry.clientSlug !== clientSlug)
    .slice(0, Math.max(0, Math.floor(window)))
    .map((entry) => entry.systemId)
    .filter((id) => id.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────
// The stylesheet
// ─────────────────────────────────────────────────────────────────────────

/** `03` from slide number 3 — the form `contentFor` emits into `{{slideIndex}}` and every template's `data-n`. */
function dataN(slide: number): string {
  return String(slide).padStart(2, "0");
}

/**
 * The resolved system as CSS, spliced into every document through
 * `extraHeadHtml`.
 *
 * ## Why `extraHeadHtml` and not `buildBrandHeadHtml`
 *
 * `buildBrandHeadHtml` only runs for a client whose kit derived tokens, so
 * routing shared render rules through it is the trap `materialize.ts`'s own
 * doc comment records for the device sheet: the clients with no kit — already
 * the ones rendering on bare defaults — would be exactly the ones whose visual
 * system silently did not apply.
 *
 * ## Why this cannot lose a cascade fight
 *
 * `extraHeadHtml` lands after the template's `<style>` for a raw bundled file
 * and before it for a composed studio definition, so its ORDER is not
 * dependable. It does not need to be: this sheet only ever SETS custom
 * properties, and the templates only ever READ them through a `var()` fallback.
 * Nothing else in the system sets `--fx-*`, so there is no fight to lose.
 *
 * ## The inversion
 *
 * A token that is never set leaves every `var(--fx-accent, none)` at `none`.
 * That is deliberate and it is the mechanism of this whole package: **a mark
 * nobody switched on does not paint.** If this block is ever not spliced, the
 * posts come out quieter than designed — never louder, and never wrong.
 */
export function visualSystemCssBlock(system: CarouselVisualSystem): string {
  const rules: string[] = [];

  // ── ON `body`, NOT ON `:root`. ──
  //
  // A custom property's `var()` references are substituted at the element that
  // DECLARES it, and `--ts` — the reviewer's type-scale control — is `1` on
  // `:root` and overridden on `body.ts-s` / `body.ts-l`. A `--t-*` declared on
  // `:root` therefore resolves `var(--ts, 1)` against the root's value, always
  // 1, and inherits down already substituted: every size that reads a step
  // stopped moving with `fontScale` entirely. Measured on the calibration's own
  // s-vs-l control pair, the two covers painted identical ink (0.4175 both).
  // Declared on `body` the substitution happens where `body.ts-s` is in force.
  // The bundled templates declare their own defaults on `body` for the same
  // reason, and this sheet lands after theirs, so it wins on the tie.
  const accent = ACCENT_FORM_GEOMETRY[system.accentForm];
  rules.push(
    `body {\n${typeScaleDeclarations(system.typeScale).join("\n")}\n` +
      `  --gutter: ${system.gutter === "tight" ? "48px" : "64px"};\n` +
      `  --fx-accent-w: ${accent.w};\n` +
      `  --fx-accent-h: ${accent.h};\n` +
      `  --cover-band: ${COVER_FORM_BAND_PX[system.coverForm]}px;\n` +
      `}`,
  );

  // ── THE GROUND IS NOT EMITTED HERE, AND THAT IS DELIBERATE. ──
  //
  // `:root { --system-ground: … }` used to ride out beside these and was read
  // by nothing, because the ground already reaches the pixels by a different
  // and better route: `assembleSlidesData` writes `visualSystem.ground` into
  // every slide's `groundStyle` field, the templates carry it as the
  // `gr-glyph` / `gr-grid` body class, and each one paints its own ground off
  // that class. A second spelling of a decision that already arrives is the
  // drift this file refuses on principle everywhere else — and a token no
  // template reads is exactly the defect this phase found in `groundStyle`
  // itself. The axis is live; the duplicate is gone.

  if (system.accentSlides.length > 0) {
    const selector = system.accentSlides.map((slide) => `body[data-n="${dataN(slide)}"]`).join(",\n");
    // `block` rather than `revert`: the templates declare `display:
    // var(--fx-accent, none)` on elements that are all block-level bars, and a
    // token resolving to an invalid display value would make the whole
    // declaration invalid-at-computed-value-time and fall back to `inline`.
    // `--fx-accent-form` is NOT emitted: the form's only job is to decide the
    // mark's geometry, and that arrives as `--fx-accent-w`/`--fx-accent-h` on
    // `body` above. A second token naming the form was read by no template and
    // could only ever disagree with the geometry it was supposed to explain.
    rules.push(`${selector} {\n  --fx-accent: block;\n  --fx-accent-ink: var(--accent);\n}`);
  }

  if (system.numeralSlides.length > 0) {
    const selector = system.numeralSlides.map((slide) => `body[data-n="${dataN(slide)}"]`).join(",\n");
    rules.push(`${selector} { --fx-pagination: block; }`);
  }

  return `<style>\n/* visual system: ${system.systemId} */\n${rules.join("\n")}\n</style>`;
}

/**
 * The per-client half: the display face, and nothing else.
 *
 * Emitted from `buildBrandHeadHtml` (the brand-scoped fragment) because a
 * client's display face IS a brand decision and because that fragment already
 * owns the Google Fonts `<link>` emission a non-default family needs. A client
 * with no kit keeps the templates' own `--f-display`, which is the correct
 * degradation: the fleet default is a real face, just a shared one.
 *
 * `script` is the run's target script (`"Hebrew"`, `"Arabic"`, … — the names in
 * `language-gate.ts`'s `SCRIPT_TABLE`), or `undefined`/`"Latin"` for every
 * English run, where this function's output is byte-identical to before.
 * On a script no register covers (`DISPLAY_REGISTER_SCRIPTS`) the THREE
 * declarations that name a Latin face are withheld and `script-fonts.ts`'s
 * measured stack, tracking and leading stand alone:
 *
 *   `--f-display`        a family with no glyph for the script sets nothing,
 *                        and where it sets the run's Latin loanwords it sets
 *                        them in a SECOND typeface inside one headline.
 *   `letter-spacing`     the register's Latin tracking is emitted on the same
 *                        display selectors the script sheet uses, from a
 *                        fragment composed AFTER it, so it won on every
 *                        equal-specificity tie — a negative value on Hebrew,
 *                        which `ScriptTypography.letterSpacing` documents as
 *                        actively harmful.
 *
 * `--mk-face-bleed` is deliberately NOT withheld; see its own note below.
 *
 * The weight, the grammar and the ground texture are script-neutral and are
 * emitted unchanged: a client's display weight is a brand decision that Heebo
 * and Rubik can both honour.
 */
export function clientVisualSystemCss(
  client: Pick<ClientVisualSystem, "displayRegister" | "compositionGrammar" | "groundTexture">,
  options: { script?: string | undefined } = {},
): string {
  const stack = DISPLAY_REGISTER_STACKS[client.displayRegister];
  const resolution = resolveDisplayRegisterForScript(client.displayRegister, options.script);
  return [
    ...(resolution.covers
      ? []
      : [
          `/* display register "${client.displayRegister}" set aside for ${resolution.script}: ` +
            `${stack.display.split(",")[0]} carries no ${resolution.script} glyph, so the script pack's own display family stands. */`,
        ]),
    ":root {",
    ...(resolution.covers ? [`  --f-display: ${stack.display};`] : []),
    `  --display-weight: ${stack.weight};`,
    ...(resolution.covers ? [`  --display-tracking: ${stack.tracking};`] : []),
    /**
     * ── THE GRAMMAR, AS THE THING IT NAMES. ──
     *
     * `compositionGrammar` is *"where the type lockup sits on the plate"*, and
     * it shipped as `--system-grammar: split-band` — a string no template, no
     * prompt and no gate ever read. It now sets the block anchor of
     * `headline-focus.html`'s elastic field, which is exactly the decision the
     * axis describes and the one a reader can see: a `top-column` client's
     * statement plate sits high on the frame for every post, a `bottom-column`
     * client's sits low.
     *
     * ONE ARCHETYPE, AND THE OTHER CANDIDATE WAS MEASURED OUT. Off-centre in an
     * elastic field is a band of bare ground wherever the content is not, so
     * the axis costs dead-space share and the question is which plates can pay
     * it. Measured — same copy, same bounded object, same ground, one grammar
     * apart, against a 0.28 interior ceiling:
     *
     *   largestEmptyRectShare      slide.html   headline-focus.html
     *     centre-measure (center)    0.2917          0.2081
     *     split-band (space-between) 0.2707          0.2389
     *     top-column (flex-start)    0.3655          0.2417
     *     bottom-column (flex-end)   0.4278          0.2689
     *
     * `headline-focus` clears every anchor; the heroless `slide.html` clears
     * neither extreme, and it is the one archetype a carousel may repeat, so a
     * band it opens is a band the reader sees two or three times. The panel
     * archetypes compose around a structure whose position is not a free
     * choice.
     *
     * ── AND THE COVER IS MEASURED OUT NOW TOO, RATHER THAN ASSERTED OUT. ──
     *
     * This note used to end *"and the cover and closer have roles of their own
     * (§4.5)"*, which is an assertion where `slide.html` got a table. Phase
     * 5.5's review said so, and it was right: one template reading an axis is
     * not an axis, and the plate it was skipping is the one most of the
     * audience sees. Both of the cover's anchors were then wired up and
     * measured on this tree (karoslabs kit, production composition, four
     * grammars x {s,m,l} x {en,he}) and both are refused by the plate:
     *
     *   `.lockup` (the elastic type block)   `largestEmptyRectShare`
     *     centre-measure  he m 0.1694   <- what ships
     *     top-column      he m 0.2195
     *     split-band      he m 0.2444   <- over the 0.22 cover ceiling
     *     bottom-column   he m 0.2611   <- over, by 4 points
     *
     *   `.cov-field` (the masthead band)  a FIXED-height box with `overflow:
     *     hidden`, so `top-column` and `split-band` overflow its foot —
     *     `div.cov-field [h 697>515]` at en m, `[h 822>645]` at en l — which
     *     is clause B's hard `clipped`, with the eyebrow printing 10-21px deep
     *     into the title.
     *
     * `compositionGrammar` is frozen per client, so either wiring would refuse
     * two of its own four values on every post those clients ship. Both
     * measurements are in `cover.html`'s own rules, beside the code they are
     * about.
     *
     * WHAT WAS ACTUALLY MAKING THREE CLIENTS' COVERS IDENTICAL was one line
     * up: `displayRegister` fell to a literal `grotesque` for every kit with
     * no `aesthetic`/`visualMood`, so three clients shared a face, a weight
     * and a tracking on every plate. That branch is seeded off the slug now,
     * which is where a per-client difference belongs — in the DERIVATION, not
     * in a template's flexbox.
     */
    `  --lockup-anchor: ${LOCKUP_ANCHOR[client.compositionGrammar]};`,
    /**
     * The ground wash's alpha, and the two values are BOUNDED rather than
     * on/off for a measured reason.
     *
     * The bundled templates paint `color-mix(in srgb, var(--wash) 8%,
     * transparent)`, and that 8% is not a taste call: the wash has to land in
     * the measurement's 12-18 band (a pixel is ground within 12 of the ground
     * colour and INK beyond 18), which is what lets it bleed to the frame
     * edge without putting ink in the 8px band `clippedEdgeShare` reads. Each
     * template's `:root` carries the arithmetic.
     *
     * So `flat` is 6% and not 0. Taking the wash away entirely would drop a
     * heroless plate's `inkShare` toward clause A's 0.015 render-integrity
     * floor — a clause that exists to catch a render that did not happen — and
     * this package cannot re-measure that band without a CI pixel run. 6 and
     * 10 straddle the shipped 8 by the same margin, are a visible difference
     * on the plate, and cannot move a clause that 8 already clears.
     */
    `  --ground-texture-alpha: ${client.groundTexture === "flat" ? "6%" : "10%"};`,
    "}",
    // The display face is named by the register, so every plate's display type
    // inherits its weight and tracking from ONE place instead of from
    // whichever template it landed on — which is how the fleet ended up with
    // one face and eight tracking values.
    //
    // The selector list is `script-fonts.ts`'s own `DISPLAY_SELECTORS`, copied
    // rather than imported for the reason that module's list exists at all:
    // these are the class names the eight templates actually use, and a second
    // list invented here would be a set of selectors that matches nothing on
    // the day a template is renamed. `.num-figure` and `.dv-figure` are added
    // because a register's weight belongs on a figure too, and they are off
    // `DISPLAY_SELECTORS` only because their LEADING is designed separately.
    ".headline, .hf-headline, .quote-text, .cmp-head, .cmp-label, .me-head, .me-title, .num-label, .figure, .item-title, .num-figure, .dv-figure {",
    // The WEIGHT is script-neutral and is emitted on every run. The TRACKING is
    // not: on a script this register cannot set, the value the plate needs is
    // the one `script-fonts.ts` measured for it, and this sheet lands after
    // that one on identical specificity — so the only way to let the measured
    // value stand is not to write this declaration at all.
    resolution.covers ? "  font-weight: var(--display-weight, 600); letter-spacing: var(--display-tracking, -0.012em);" : "  font-weight: var(--display-weight, 600);",
    // THE FACE'S OWN TWIN BLEED, on the display hosts and nowhere else — see
    // `DISPLAY_REGISTER_STACKS`. Scoped to this selector list rather than set
    // on `:root` because the bleed pays for the DISPLAY face's content area,
    // and a body paragraph set in Inter would otherwise acquire 0.3em of
    // padding it has no metric reason for. Custom properties inherit, so the
    // twin host reads it from itself; `max()` at the consumption site is what
    // lets a Hebrew run and a condensed face both be satisfied.
    //
    //
    // EMITTED ON EVERY RUN, INCLUDING ONE WHOSE FACE WAS SET ASIDE, and that is
    // not an oversight. The consumption site combines the two with `max()`, so
    // this token can only ever ADD padding: withholding it is the one direction
    // that can clip. Measured when this block first did withhold it — a Hebrew
    // carousel under `condensed` dropped from `0.3em` to `--mk-twin-bleed`'s
    // `.22em` and `cover.html` reported `probe.overflow` on
    // `["span.mk-runs","span.mk-plain"]`, which clause B turns into a hard
    // `clipped` finding whose steer cannot fix a font metric. A descender
    // allowance is not a typographic claim about the script; the FACE and the
    // TRACKING are, and they are the two this gate withholds.
    `  --mk-face-bleed: ${stack.twinBleed};`,
    "}",
    // ── AND THE DEVICE'S FIGURE TAKES THE SAME ALLOWANCE, WHICH IS THE ONE
    //    DISPLAY HOST THAT HAD NO CONSUMER FOR IT. ──
    //
    // `slide-devices.ts` gives `.dv-figure` `padding-block-end: 0.16em` at
    // `line-height: 0.95`, measured on Fraunces — *"a 150px figure's line box
    // is 143px against 163px of content"*. Two of the four registers set that
    // figure in a face with a taller glyph box, and the slot then reports
    // `scrollHeight > clientHeight`, which `probePage` calls an overflowing
    // element and interest-floor clause B turns into a hard `clipped` finding
    // whose steer ("shorten the headline") cannot fix a font metric. Measured
    // on this tree through the production composition, at `m`: `condensed`
    // 203 against 186 on `headline-focus`, 243 against 222 on the cover, and
    // `geometric` the same — on the cover, `headline-focus` and `slide`,
    // i.e. every plate in the set that can carry a bounded object, at every
    // copy length and type scale.
    //
    // WHY HERE AND NOT IN THE TEMPLATES, which is where the first version of
    // this fix put it and where it was wrong: a `.hf-device .dv-figure` rule
    // outranks `script-fonts.ts`'s `.dv-figure { padding-block-end: 0.30em }`
    // — the allowance that module MEASURED for Hebrew (Heebo at 0.95 needs
    // 0.26em) — so fixing the Latin registers broke every Hebrew plate that
    // carries a figure. Measured: `div.dv-figure [h 146>134]` on three plates
    // of every Hebrew carousel. Emitted HERE the script is known, so the rule
    // is withheld on a script this register cannot set and the script pack
    // keeps the last word on the scripts it has measured. One class, so
    // `deviceCssBlock`'s own 0.16em is beaten (this fragment is composed after
    // it) and nothing else in the set moves.
    ...(resolution.covers ? [".dv-figure {", "  padding-block-end: max(0.16em, var(--mk-face-bleed, 0em));", "}"] : []),
  ].join("\n");
}
