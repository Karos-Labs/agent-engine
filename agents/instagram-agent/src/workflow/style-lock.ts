import { HEX_COLOR } from "@agent-engine/core";
import { z } from "zod";
import { ACCENT_GROUND_CONTRAST_FLOOR, contrastRatio, DEFAULT_TEMPLATE_GROUND } from "./brand-render-tokens.js";

/**
 * Phase 3, item S — the style lock: ONE generation style per run, and ONE
 * renderer treatment per client.
 *
 * Two halves, both deterministic, both free.
 *
 * 1. GENERATION. `resolveGenerationStyle` freezes a single style line out of
 *    the client's visual direction (item Q) once per run. Step
 *    `04k-freeze-generation-style` checkpoints it BEFORE the attempt loop, so
 *    every `image.generate` call in every attempt and every revision passes
 *    the identical `art.styleLock`. The defect this fixes is a set of
 *    generated images that were each individually plausible and collectively
 *    looked like four different photographers: one line, one source, every
 *    frame.
 *
 * 2. RENDERING. `pickImageTreatment` picks one filter treatment PER CLIENT —
 *    never per slide, which is the whole point. A per-slide choice would be
 *    the same "repetition-shaped variety" tell item P exists to kill, only
 *    inverted: images that differ from each other for no editorial reason
 *    read as an accident, not as a set.
 *
 * Everything here is pure: no clock, no randomness, no I/O. The same inputs
 * always produce the same style and the same CSS, which is what makes the
 * checkpoint replay in `style-lock.test.ts` a real assertion rather than a
 * tautology, and what lets a visual diff between two runs of one post mean
 * something (the same rule `paletteForSlide` states for the accent ring).
 *
 * ## Why the direction arrives structurally typed
 *
 * `resolveGenerationStyle` takes the parts of item Q's `VisualDirection` it
 * actually reads, declared as its own narrow interfaces rather than imported
 * from `visual-direction.ts`. A `VisualDirection` and a `ClientBrief`
 * satisfy them structurally, so the integrator passes them straight through;
 * the style lock in exchange has no import edge on the direction module, no
 * opinion about how the direction was derived, and nothing to change when
 * that schema grows a field. This module is the same "physics, no policy"
 * shape `measureSlidePng` has on the other side of the render.
 */

// ────────────────────────────────────────────────────────────────────────────
// The renderer treatment
// ────────────────────────────────────────────────────────────────────────────

/**
 * The treatments, in ascending order of how much they change a photograph.
 *
 * `none` is the default and the only value a client can reach without both a
 * brand kit that has colour to spare and a direction that asked for a look.
 * Doing nothing is a legitimate house style, and it is the one option that
 * cannot make a photograph worse.
 */
export const IMAGE_TREATMENTS = ["none", "warm-desaturate", "duotone-scrim"] as const;

export const ImageTreatmentSchema = z.enum(IMAGE_TREATMENTS);
export type ImageTreatment = z.infer<typeof ImageTreatmentSchema>;

/**
 * The CSS `filter` each treatment paints on the photograph itself.
 *
 * `warm-desaturate` is the legacy taste rules' own recommendation, quoted in
 * the spec: "a light desaturation and warm tone… never crush it to flat
 * monochrome". The numbers are deliberately gentle — `saturate(0.82)` is a
 * perceptible unification, `sepia(0.06)` a warm cast rather than a tone map,
 * and `contrast(1.03)` recovers the small amount of snap desaturation costs.
 *
 * `duotone-scrim` desaturates harder (`saturate(0.55)`) because the accent
 * tint painted over it is what supplies the colour back; at 0.82 the two
 * hues would fight. It is still NOT `grayscale(1)`: a duotone over a
 * completely flattened frame is the "crushed to monochrome" failure with an
 * extra step, and — measured — it is also what would drop a correct photo
 * slide under item L's `quantisedColourCount`.
 */
export const IMAGE_TREATMENT_FILTERS: Readonly<Record<ImageTreatment, string>> = {
  none: "none",
  "warm-desaturate": "saturate(0.82) sepia(0.06) contrast(1.03)",
  "duotone-scrim": "saturate(0.55)",
};

/**
 * The accent tint's opacity under `mix-blend-mode: multiply`.
 *
 * 12% is the largest value that still reads as "this set was graded" rather
 * than "this photo is orange": multiply at 12% moves a mid-tone by roughly
 * the same amount the `warm-desaturate` sepia does, so the two treatments are
 * siblings in strength rather than a gentle option and a drastic one.
 */
export const DUOTONE_TINT_ALPHA = 0.12;

/**
 * The grain layer's opacity.
 *
 * 5% is a tooth, not a texture. Above roughly 8% the dither starts showing as
 * a pattern at 2x device scale instead of as film stock, and — the reason the
 * number is a constant and not a taste call — it starts contributing its own
 * edges to item L's `edgeDensity`, which would make a measurement of the
 * SLIDE partly a measurement of this sheet.
 */
export const GRAIN_ALPHA = 0.05;

/**
 * The grain pattern, token-derived and asset-free.
 *
 * A `repeating-conic-gradient` tiled at 3px is a 2x2 dither of the foreground
 * token — at `canvas.scale: 2` that is a 6-device-pixel cell, which is the
 * coarsest tile that still disappears into a photograph at Instagram's
 * display size. It is honestly a fine dither rather than photographic grain;
 * real grain is an image plate, and an image plate means a `url()`, which
 * `assertSafeMarkup` refuses in template CSS and which would make a rendered
 * slide depend on a fetch. A dither that adds tooth and costs nothing beats a
 * texture that cannot ship.
 */
export const GRAIN_TILE_PX = 3;

/** Which treatments paint the grain layer: every treatment that paints anything at all. */
const GRAIN_TREATMENTS: ReadonlySet<ImageTreatment> = new Set<ImageTreatment>(["warm-desaturate", "duotone-scrim"]);

/**
 * What the treatment decision needs from the client's derived render tokens.
 *
 * Deliberately the same narrow `{ cssVars, palette }` shape the template
 * studio's `studioKit` already passes (`create-instagram-agent-workflow.ts`),
 * widened by the ring anchor. `BrandRenderTokens` satisfies it structurally.
 *
 * It is the DERIVED kit and not the configured `BrandTokens`, because both
 * gates below need values only derivation produces: the ground the slide
 * actually renders on (`--bg`), and the accent ring, whose length is the only
 * honest signal this codebase has for "does this brand have colour to spend".
 */
export interface TreatmentKit {
  cssVars: Record<string, string>;
  /** The accent rotation ring. `[0]` is the brand anchor — see `buildAccentRing`. */
  palette: readonly string[];
  brandAccent?: string | undefined;
}

/** Why a treatment was chosen or refused. Always reported, so the trace never has to guess. */
export interface ImageTreatmentDecision {
  treatment: ImageTreatment;
  reason: string;
  /** The single frozen accent the duotone tint is painted in. Only set for `duotone-scrim`. */
  tintHex?: string;
}

/**
 * The words that ask for a duotone, matched case-insensitively as substrings
 * of the frozen style text.
 *
 * Substring matching is safe here only because every cue is long enough to be
 * a word: the shortest, `tint`, cannot appear inside an unrelated English
 * word that would describe a photograph. `mono` is deliberately NOT a cue —
 * it is a font classification in this codebase (`--f-mono`) and a direction
 * line mentioning a mono face must not re-grade every photograph.
 */
const DUOTONE_CUES: readonly string[] = ["duotone", "duo-tone", "two-tone", "twotone", "bitone", "monochrome", "tint", "colour wash", "color wash"];

/**
 * The words that ask for the gentle grade. Film and stock references land
 * here on purpose: "documentary 35 mm, single warm light source, muted
 * terracotta and bone palette, fine grain" — the spec's own example line —
 * is asking for a grade, not for a duotone.
 */
const WARM_CUES: readonly string[] = [
  "grain",
  "film",
  "35mm",
  "35 mm",
  "analog",
  "analogue",
  "desaturat",
  "muted",
  "faded",
  "matte",
  "sepia",
  "warm",
  "vintage",
  "documentary",
  "washed",
];

/**
 * The phrases that VETO every treatment.
 *
 * The veto reads item Q's `forbid` list — the only channel a client has for
 * "do not do this to our pictures" — and a forbid list is not advisory here
 * the way it is to an image model: this half is our own CSS, so we can simply
 * obey it. Matched against `forbid` entries only, never against the style
 * line, so a line that mentions a filter in order to describe one is not read
 * as a prohibition.
 *
 * Every cue but `duotone` is a PHRASE rather than a word, and deliberately:
 * the fallback veto source is `brief.forbidden.topics`, which holds subject
 * matter ("spam filters", "grading rubrics"), and a bare `filter` or `grade`
 * there would silently strip a client's treatment over a topic that has
 * nothing to do with photographs.
 */
const TREATMENT_VETO_CUES: readonly string[] = [
  "duotone",
  "image filter",
  "photo filter",
  "instagram filter",
  "colour filter",
  "color filter",
  "colour grading",
  "color grading",
  "heavy editing",
  "heavy-handed editing",
  "post-processing",
  "postprocessing",
  "filter presets",
];

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function mentionsAny(haystack: string, cues: readonly string[]): boolean {
  return cues.some((cue) => haystack.includes(cue));
}

/**
 * The ground a treatment's legibility is judged against: the kit's derived
 * ground when it has one, the default templates' own `#17181C` otherwise.
 *
 * A client with no derived `--bg` still renders on THAT, so checking against
 * nothing (or against a guessed white) would be the check quietly not
 * happening — the same reasoning `planBrandLogo` gives for reading the same
 * fallback.
 */
function groundFor(kit: TreatmentKit): string {
  const derived = kit.cssVars["--bg"];
  return derived !== undefined && HEX_COLOR.test(derived) ? derived : DEFAULT_TEMPLATE_GROUND;
}

/** The one accent a duotone may be painted in: the ring anchor, never a per-slide rotation member. */
function anchorAccent(kit: TreatmentKit): string | undefined {
  const anchor = kit.palette[0] ?? kit.brandAccent;
  return anchor !== undefined && HEX_COLOR.test(anchor) ? anchor : undefined;
}

/**
 * Picks the client's treatment, WITH the reasoning attached.
 *
 * The ladder, in order, and each rung is a refusal rather than a preference:
 *
 * 1. **A forbid entry naming image manipulation** → `none`. The client said
 *    no; this half of the pipeline is ours to obey rather than to ask.
 * 2. **No kit at all** → `none`. A brandless client has told us nothing about
 *    how it wants photographs handled, and inventing a grade for it is the
 *    "never silently invent a hex" rule wearing a different hat.
 * 3. **A one-colour ring** → `none`. This is the "no treatment latitude"
 *    case: a kit whose ring could not promote a second colour (see
 *    `buildAccentRing`, where every non-anchor candidate must clear
 *    `ACCENT_GROUND_CONTRAST_FLOOR`) is a kit with one mark and nothing
 *    spare. Grading its photographs spends colour it does not have.
 * 4. **No cue in the frozen style text** → `none`. Silence is not consent to
 *    grade; the direction has to ask.
 * 5. **A duotone asked for, but the anchor accent fails
 *    `ACCENT_GROUND_CONTRAST_FLOOR` against the ground** → demoted to
 *    `warm-desaturate`. A tint that close to the ground would pull the
 *    photograph toward the background exactly where the scrim already sits,
 *    which is how a treatment makes type illegible. Demoting rather than
 *    dropping to `none` keeps the set reading as ONE set, which is the
 *    requirement; it just reads as one quieter set.
 */
export function explainImageTreatment(kit: TreatmentKit | undefined, styleLock?: string, options: { forbid?: readonly string[] } = {}): ImageTreatmentDecision {
  const forbidden = (options.forbid ?? []).map(normalise).find((entry) => mentionsAny(entry, TREATMENT_VETO_CUES));
  if (forbidden !== undefined) return { treatment: "none", reason: `forbidden by the client's visual direction: "${forbidden}"` };

  if (kit === undefined) return { treatment: "none", reason: "no derived brand kit, so no treatment latitude" };
  if (kit.palette.length < 2) return { treatment: "none", reason: "a one-colour accent ring has no treatment latitude" };

  const text = normalise(styleLock ?? "");
  if (text.length === 0) return { treatment: "none", reason: "no frozen generation style to take a treatment cue from" };

  const wantsDuotone = mentionsAny(text, DUOTONE_CUES);
  const wantsWarm = mentionsAny(text, WARM_CUES);
  if (!wantsDuotone && !wantsWarm) return { treatment: "none", reason: "the frozen style asks for no image treatment" };

  if (!wantsDuotone) return { treatment: "warm-desaturate", reason: "the frozen style asks for a film/desaturated grade" };

  const anchor = anchorAccent(kit);
  if (anchor === undefined) return { treatment: "warm-desaturate", reason: "a duotone was asked for but the kit has no usable anchor accent to tint with" };

  const ground = groundFor(kit);
  const ratio = contrastRatio(anchor, ground);
  if (ratio < ACCENT_GROUND_CONTRAST_FLOOR) {
    return {
      treatment: "warm-desaturate",
      reason: `a duotone was asked for but ${anchor} sits at ${ratio.toFixed(2)}:1 against the ground ${ground}, under the ${ACCENT_GROUND_CONTRAST_FLOOR}:1 accent floor`,
    };
  }

  return { treatment: "duotone-scrim", reason: `the frozen style asks for a duotone and ${anchor} clears the accent floor at ${ratio.toFixed(2)}:1`, tintHex: anchor };
}

/**
 * The treatment alone — `explainImageTreatment` without the reasoning, for
 * callers that only need the id. Pure and stable: the same `(kit, styleLock)`
 * always returns the same treatment.
 */
export function pickImageTreatment(kit: TreatmentKit | undefined, styleLock?: string, options: { forbid?: readonly string[] } = {}): ImageTreatment {
  return explainImageTreatment(kit, styleLock, options).treatment;
}

// ────────────────────────────────────────────────────────────────────────────
// The frozen generation style
// ────────────────────────────────────────────────────────────────────────────

/**
 * The per-run frozen style. Checkpointed once at
 * `04k-freeze-generation-style`, before the attempt loop, and read by every
 * later step — so an attempt-2 redraft and a round-3 revision generate
 * against the same line as attempt 1 did.
 */
export const GenerationStyleSchema = z.object({
  /** Stable identity for the trace and the gate payload. `"unset"` when there is no direction to freeze. */
  id: z.string().min(1).max(40),
  /**
   * The single line passed as `art.styleLock` on every `image.generate` call.
   * ABSENT means absent: the tool then builds exactly the brief it built
   * before item S existed, byte for byte.
   */
  line: z.string().min(1).max(200).optional(),
  source: z.enum(["direction", "none"]),
  /** Per client, never per slide. See `pickImageTreatment`. */
  treatment: ImageTreatmentSchema,
  /** Why that treatment — always present, including for `none`. */
  treatmentReason: z.string().min(1),
  /** The frozen accent the duotone tint paints in. Only set for `duotone-scrim`. */
  tintHex: z.string().regex(HEX_COLOR).optional(),
});
export type GenerationStyle = z.infer<typeof GenerationStyleSchema>;

/** The parts of item Q's `VisualDirection` the style lock reads. A `VisualDirection` satisfies it structurally. */
export interface GenerationStyleDirection {
  styleLock?: { id: string; line: string } | undefined;
  /** The direction's treatment lines — where a "muted duotone in brand terracotta" actually gets written. */
  treatment?: readonly string[] | undefined;
  /** The direction's forbid list — the veto channel. */
  forbid?: readonly string[] | undefined;
}

/** The parts of the client brief the style lock reads. A `ClientBrief` satisfies it structurally. */
export interface GenerationStyleBrief {
  forbidden?: { topics?: readonly string[] | undefined } | undefined;
}

/** Style lines are capped where `VisualDirectionSchema` caps them, so a frozen line always round-trips through the schema. */
const STYLE_LINE_MAX = 200;
const STYLE_ID_MAX = 40;

function tidyLine(line: string | undefined): string | undefined {
  if (line === undefined) return undefined;
  const collapsed = line.replace(/\s+/g, " ").trim();
  return collapsed.length === 0 ? undefined : collapsed.slice(0, STYLE_LINE_MAX);
}

/**
 * Freezes this run's generation style.
 *
 * The LINE comes from one place only — the direction's own `styleLock` — and
 * is never synthesised from brand tokens. With no direction the style is
 * absent and behaviour is exactly today's, which matters because item Q's
 * `fallbackVisualDirection` already guarantees a direction for any client
 * with either a brand kit or a brief: manufacturing a second, lower-quality
 * fallback here would only ever fire for clients who have neither, and would
 * give them a line derived from nothing.
 *
 * The TREATMENT reads a wider haystack than the line alone — the style lock
 * plus the direction's `treatment` lines — because that is where an art
 * director actually writes "muted duotone in the brand terracotta", while the
 * style lock tends to carry the subject and the light. Both are frozen
 * together so the gate payload shows one decision, not two.
 *
 * `brief` is read only for its forbidden topics, and only as the second-hand
 * veto channel for a run whose direction step was skipped by a setup-budget
 * lever: item Q derives the direction's `forbid` from exactly this field, so
 * when a direction IS present its list is the better copy and is used first.
 */
export function resolveGenerationStyle(
  direction: GenerationStyleDirection | undefined,
  kit: TreatmentKit | undefined,
  brief?: GenerationStyleBrief | undefined,
): GenerationStyle {
  const line = tidyLine(direction?.styleLock?.line);
  const id = line !== undefined ? (tidyLine(direction?.styleLock?.id) ?? "style").slice(0, STYLE_ID_MAX) : "unset";

  // The direction's forbid list when it has one; the brief's forbidden topics
  // otherwise. Never both concatenated: item Q derives the former FROM the
  // latter, so concatenating would double-count one client's single sentence.
  const forbid = direction?.forbid !== undefined && direction.forbid.length > 0 ? direction.forbid : (brief?.forbidden?.topics ?? []);

  const cueText = [line, ...(direction?.treatment ?? [])].filter((part): part is string => part !== undefined && part.length > 0).join(". ");
  const decision = explainImageTreatment(kit, cueText, { forbid });

  return {
    id,
    ...(line !== undefined ? { line } : {}),
    source: line !== undefined ? "direction" : "none",
    treatment: decision.treatment,
    treatmentReason: decision.reason,
    ...(decision.tintHex !== undefined ? { tintHex: decision.tintHex } : {}),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// What the renderer receives
// ────────────────────────────────────────────────────────────────────────────

/** The per-slide field name the treatment is reported through. */
export const IMAGE_TREATMENT_FIELD = "imageTreatment";

/**
 * The per-slide fields the treatment contributes, for `assembleSlidesData` to
 * spread into every slide's `fields`.
 *
 * EMPTY for `none`, which is what keeps the no-treatment path byte-identical:
 * a client with no treatment produces the same `fields` object it produced
 * before item S existed, so every existing `slides-data` fixture stays
 * turn-for-turn and byte-for-byte true.
 *
 * The same value on every slide is the point, not a redundancy — a per-slide
 * field is simply where the render contract puts per-slide facts, and a
 * template or a studio row that wants to read `{{imageTreatment}}` (to, say,
 * drop its own scrim a notch under a duotone) can.
 */
export function imageTreatmentFields(style: Pick<GenerationStyle, "treatment">): Record<string, string> {
  return style.treatment === "none" ? {} : { [IMAGE_TREATMENT_FIELD]: style.treatment };
}

/**
 * The custom properties the treatment sheet declares.
 *
 * Emitted as part of `imageTreatmentCssBlock` rather than through
 * `buildBrandHeadHtml`, and that is a deliberate correction of the obvious
 * design: the brand head fragment only exists when `deriveBrandRenderTokens`
 * returned tokens, so routing shared render rules through it is the exact
 * trap `materialize.ts`'s `extraHeadHtml` doc comment records for the device
 * sheet. Here the vars and the rules that read them travel together, so they
 * cannot arrive apart.
 *
 * Exported on its own because the gate payload and the trace want the values
 * as data, not as a stylesheet.
 */
export function imageTreatmentVars(style: Pick<GenerationStyle, "treatment" | "tintHex">): Record<string, string> {
  if (style.treatment === "none") return {};
  const vars: Record<string, string> = {
    "--img-treatment": IMAGE_TREATMENT_FILTERS[style.treatment],
    // Token-derived: the dither is the foreground colour, so it inherits a
    // client's ink and an inverted slide's ink alike. No `url()`, nothing
    // fetched, nothing for `assertSafeMarkup` to refuse.
    "--img-grain": "repeating-conic-gradient(var(--fg) 0% 25%, transparent 0% 50%)",
  };
  if (style.treatment === "duotone-scrim" && style.tintHex !== undefined && HEX_COLOR.test(style.tintHex)) {
    vars["--img-tint"] = style.tintHex;
  }
  return vars;
}

/**
 * The code-owned treatment stylesheet, for the `extraHeadHtml` channel item M
 * added to `composeDocument` / `composeRawDocument` / `materializeTemplates`.
 *
 * Returns `""` for `none`, so a client with no treatment receives a document
 * that is byte-identical to the one it received before item S.
 *
 * ## Why this is a stylesheet and not a `.hero-treatment` element in each template
 *
 * The treatment has to reach `slide.html`, `cover.html`, every future studio
 * row and every run-authored custom archetype. A layer element could only be
 * added to the files we own, so the two kinds of template a client is most
 * likely to actually ship — its own, and its generated set — would be the
 * ones missing the grade. Riding the channel the device sheet already rides
 * reaches all of them from one place, and it keeps the whole treatment
 * deletable in one function when a client turns it off.
 *
 * ## The three selector groups, and why they differ
 *
 * The FILTER is universal: every hero a run renders is substituted as a
 * `file://` URL by `render-carousel.ts`, while the brand logo arrives as a
 * data URI, so `img[src^="file://"]` grades every photograph in every
 * template and cannot touch the mark. (`:not(.brand-logo)` is belt and
 * braces for a template that ever serves its logo from disk.)
 *
 * The TINT and GRAIN overlays need a positioned ancestor to fill, so they
 * name the three ground containers this codebase actually builds: `.bg`
 * (`slide.html`), `.ground` (`cover.html`) and a `.hero` wrapper (the shape a
 * studio row declaring `{{image:hero}}` produces). Each is already
 * `position: absolute; inset: 0` with a `z-index`, so the pseudo-elements
 * fill the frame and blend INSIDE that stacking context — against the
 * photograph, never against the page. A studio row that invents a fourth
 * container name still gets the filter, which is the bulk of the look.
 *
 * The `:has(> img[src]:not([src=""]))` guard is what keeps the tint off a
 * slide whose photograph never arrived: an unfilled `{{image:hero}}` is
 * substituted as `src=""` (`render-carousel.ts:193`), and a 12% accent wash
 * over a bare ground is a defect rather than a grade.
 */
export function imageTreatmentCssBlock(style: Pick<GenerationStyle, "treatment" | "tintHex">): string {
  if (style.treatment === "none") return "";

  const vars = imageTreatmentVars(style);
  const varLines = Object.entries(vars).map(([name, value]) => `  ${name}: ${value};`);

  // The containers whose pseudo-elements carry the overlays. `.hero` covers a
  // wrapper div; `img.hero` (cover.html) is itself the image and grows no
  // pseudo-elements, which is why `.ground` is listed too.
  const grounds = ['.bg:has(> img[src]:not([src=""]))', '.ground:has(> img[src]:not([src=""]))', '.hero:has(> img[src]:not([src=""]))'];

  const rules: string[] = [
    `:root {\n${varLines.join("\n")}\n}`,
    `/* The grade itself, on the photograph. Every rendered hero is a file:// URL; the brand mark is a data URI. */`,
    `img[src^="file://"]:not(.brand-logo) { filter: var(--img-treatment, none); }`,
  ];

  if (GRAIN_TREATMENTS.has(style.treatment)) {
    rules.push(
      `/* Grain. z-index 1 because a pseudo-element is the FIRST child in the box tree and would otherwise sit under the photograph. */`,
      `${grounds.map((g) => `${g}::before`).join(",\n")} {`,
      `  content: ""; position: absolute; inset: 0; z-index: 1; pointer-events: none;`,
      `  background-image: var(--img-grain); background-size: ${GRAIN_TILE_PX}px ${GRAIN_TILE_PX}px;`,
      `  mix-blend-mode: overlay; opacity: ${GRAIN_ALPHA};`,
      `}`,
    );
  }

  if (style.treatment === "duotone-scrim" && vars["--img-tint"] !== undefined) {
    rules.push(
      `/* The accent tint. Multiply inside the ground container's own stacking context, so it grades the photograph and nothing else. */`,
      `${grounds.map((g) => `${g}::after`).join(",\n")} {`,
      `  content: ""; position: absolute; inset: 0; z-index: 2; pointer-events: none;`,
      `  background-color: var(--img-tint);`,
      `  mix-blend-mode: multiply; opacity: ${DUOTONE_TINT_ALPHA};`,
      `}`,
    );
  }

  return `<style>\n/* instagram-agent image treatment (Phase 3, item S) — built by style-lock.ts. */\n${rules.join("\n")}\n</style>`;
}
