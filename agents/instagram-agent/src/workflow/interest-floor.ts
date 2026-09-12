/**
 * The visual-interest floor — the editorial half of RFC-14 item L.
 *
 * ## The defect this closes
 *
 * The owner's words, 2026-09-10: *"צריך ליצור טמפלייטים אבל יש גם טמפלייטים
 * משעממים, למשל בKAROS LABS אתה רואה מסך אפור ברובו, אלה פוסטים שאנשים לא
 * ירצו"* — "you see a mostly-grey screen; nobody wants those posts." The
 * Karos Labs prep runs render a headline in the lower third of an otherwise
 * empty plate. Every check that existed passed it: the copy was compliant,
 * the palette was in the kit, the contrast cleared its floor, the judge had
 * no render rule to fail it against. **"Technically correct and empty" has to
 * fail, not pass**, and the only place the emptiness actually exists is in
 * the rendered pixels.
 *
 * `packages/tools/karos-publish`'s `measureSlidePng` does the physics and
 * holds no opinion (it is adoptable as-is by tiktok/linkedin/x). This module
 * is the opinion: the thresholds, the per-role policy, and the sentences a
 * failure sends back to the writer. Editorial policy for one channel, so it
 * sits beside `visual-qa-pre-checks.ts` rather than in a package — the same
 * split `checkDefaultRenderRules` (policy here) and `publish.renderCarousel`
 * (mechanism there) already use.
 *
 * ## The clause split is the whole argument
 *
 * A single flat-background ceiling cannot work. The bundled typographic
 * archetypes legitimately measure 0.62–0.88 flat at canonical copy, and the
 * audit slide measures 0.93 — so a ceiling low enough to fail the audit slide
 * also fails a good Swiss type poster, and one high enough to pass the poster
 * passes the defect. The defect is not "flat". It is **flat AND idle**, or **a
 * hole**, and those are two different measurements taken together (clauses C
 * and D below). Everything else here is either render integrity or the
 * opposite failure (a wall of text).
 *
 * ## What it must never do
 *
 * Become a fourth hold cause. `__tests__/zero-held-guarantee.test.ts` opens
 * with "a carousel must never fail to ship because of a picture", and an
 * interest-floor failure is a picture/layout problem. So: while attempts
 * remain the finding returns the draft to `05-write-copy` with the measured
 * numbers; on the final attempt the post ships `degraded` with the finding on
 * the gate, the deliverable and a ledger warn. An unmeasurable PNG is a fact,
 * never a verdict.
 *
 * Everything here is pure — no tool, no store, no model, no I/O.
 */

// ─────────────────────────────────────────────────────────────────────────
// The measurement's shape, mirrored structurally
// ─────────────────────────────────────────────────────────────────────────

/**
 * What `measureSlidePng` (`@agent-engine/tool-karos-publish`) reports for one
 * slide, declared here structurally rather than imported.
 *
 * Deliberate, and it costs nothing: this module is pure editorial policy over
 * a bag of numbers, so depending on the render package's build to typecheck
 * a threshold comparison buys no safety. What DOES check the join is the
 * workflow call site — `checkInterestFloor(entry.metrics, …)` is handed the
 * renderer's own `SlideMetrics`, so a field that gets renamed or dropped in
 * the package fails to compile there, which is exactly where a mismatch
 * matters. (It also means this policy can be unit-tested against hand-built
 * numbers without a Chromium render or a package rebuild.)
 *
 * Every share is a fraction of the full 1080×1440 design frame, in `[0, 1]`.
 */
export interface SlideMetrics {
  /** The modal quantised colour of the slide's flat cells — the ground the shares below are measured against. */
  backgroundHex: string;
  /** True when the caller supplied `expected.ground` and the measured mode agreed with it within `FLAT_TOL`. Anchoring matters: on a full-bleed photograph the modal colour is the photograph. */
  backgroundMatchesBrandGround: boolean;
  /** Full-res pixels within `FLAT_TOL` of `backgroundHex`. */
  flatBackgroundShare: number;
  /** Full-res pixels beyond `INK_DELTA` of `backgroundHex`. */
  inkShare: number;
  /**
   * Grid cells carrying a MARK of any kind — ink in 4 of 64 samples, or a
   * non-ground mean. Area occupied, not glyph ink.
   *
   * A decorative ground satisfies this: a hairline field clears 4/64 in every
   * cell it crosses. That is the right answer for "did anything paint" and
   * the wrong one for "is there anything here to read", which is why the
   * content mask below exists and why clause G reads it.
   */
  occupiedShare: number;
  /** Cells whose MEAN colour has visibly left the ground, or that are substantially covered — content, with a ground treatment excluded by construction. */
  contentOccupiedShare: number;
  /** The maximal axis-aligned all-ground rectangle, in DESIGN px (1080×1440), quantised to the 4px cell grid. */
  largestEmptyRect: { x: number; y: number; w: number; h: number };
  largestEmptyRectShare: number;
  /** The same rectangle over the CONTENT mask: the largest region of the plate with nothing to read in it. A ground treatment does not shrink it. */
  largestEmptyContentRect: { x: number; y: number; w: number; h: number };
  largestEmptyContentRectShare: number;
  /** Cells that look like a photograph (many distinct colours, real variance). */
  imageryShare: number;
  /** Cells that look like a drawn device (dense ink, few colours) — a bar, a big numeral's stroke, a colour block. */
  graphicShare: number;
  /** `imageryShare + graphicShare` — "does this slide carry something other than type". */
  imageryOrDeviceShare: number;
  /** Ink cells that are neither imagery nor graphic: glyphs. */
  textShare: number;
  /** 0 when the caller supplied no accent. */
  accentShare: number;
  accentPresent: boolean;
  /** `edgePixels / inkPixels` — high ink with no edges is a solid wash, not content. */
  edgeDensity: number;
  /** 5-bit colours holding at least 0.5% weight. */
  quantisedColourCount: number;
  /** Ink inside an 8-design-px band at any canvas edge. */
  clippedEdgeShare: number;
}

/**
 * The one `page.evaluate` the renderer runs per slide while the page is still
 * open, mirrored here for the same reason as `SlideMetrics` above.
 *
 * Not decoration. `headline-focus.html` and `stat-callout.html` size their
 * display type from an in-page `textContent.length` breakpoint (`> 60 →
 * tiny`, `> 32 → small`), and Hebrew's different average glyph width means
 * that breakpoint can pick a size that overflows with no pixel signature at
 * all beyond a clipped edge. `fontFamiliesUsed` is also the first real proof
 * that a Phase 0 script font actually LOADED, rather than that its `<link>`
 * was emitted.
 */
export interface SlideProbe {
  n: number;
  /** Any element whose scroll box exceeds its client box by more than 1px. */
  overflow: boolean;
  /** Up to six selectors, so the steer can name the element that overflowed. */
  overflowing: string[];
  /** Boxes escaping the 1080×1440 canvas. */
  offscreen: string[];
  elementCount: number;
  textBoxShare: number;
  /** The families actually resolved in the page, not the ones requested. */
  fontFamiliesUsed: string[];
}

// ─────────────────────────────────────────────────────────────────────────
// Roles
// ─────────────────────────────────────────────────────────────────────────

/**
 * A slide's job in the sequence.
 *
 * `cover` is the grid thumbnail — the only slide most of the audience ever
 * sees — and `closer` is the save moment. Both are held to tighter numbers
 * than an interior slide, and both must carry something other than type
 * (clause E). One quiet all-type turn mid-carousel is good design, which is
 * why interiors are exempt from that clause entirely.
 */
export type SlideRole = "cover" | "interior" | "closer";

/**
 * Slide 1 is the cover, the last slide is the closer, everything between is
 * interior. A one-slide post (`format: "single"`) is a cover: it is the
 * thumbnail and there is no sequence for it to close.
 */
export function slideRoleFor(index: number, slideCount: number): SlideRole {
  if (index <= 0) return "cover";
  return index >= slideCount - 1 ? "closer" : "interior";
}

// ─────────────────────────────────────────────────────────────────────────
// Measurement tolerances — the physics' parameters, owned here
// ─────────────────────────────────────────────────────────────────────────

/**
 * How far a pixel may sit from `backgroundHex` and still count as ground, on
 * the 0-255 weighted-RGB scale `measureSlidePng` uses.
 *
 * 12, because Chromium's anti-aliasing plus the templates' own
 * `color-mix(in srgb, var(--fg) 78%, transparent)` overlays put
 * ground-adjacent tones a few units off ground, and a headless 8-bit
 * screenshot carries no dithering — AA is the only noise source and it stays
 * inside ±10. It cannot merge two brand neutrals: the derived ground/fg pairs
 * are separated by at least 24 by the contrast floor's own construction, and
 * the bundled `#17181C`/`#F4F2EC` pair by 220.
 */
export const FLAT_TOL = 12;

/**
 * How far beyond ground a pixel must sit to count as ink. Outside `FLAT_TOL`,
 * so no pixel can be both ground and ink, and below the smallest deliberate
 * tonal step in the token system.
 */
export const INK_DELTA = 18;

/**
 * Accent-match tolerance. Wider than `FLAT_TOL` because an accent renders
 * through `color-mix`/opacity in several places (`.stat-band`, `.eyebrow`,
 * hairlines); measured only at 100% opacity it would under-count itself.
 */
export const ACCENT_TOL = 20;

/** A cell is flat when its 64 samples vary by less than one AA step. */
export const FLAT_CELL_STDDEV = 6 / 255;

/**
 * The bundle to hand `measureSlidePng` (or the render tool's `measure`
 * input), so the numbers this module judges and the numbers the renderer
 * produces can never drift apart in two files.
 */
export const SLIDE_METRIC_TOLERANCES = {
  flatTol: FLAT_TOL,
  inkDelta: INK_DELTA,
  accentTol: ACCENT_TOL,
  flatCellStddev: FLAT_CELL_STDDEV,
} as const;

// ─────────────────────────────────────────────────────────────────────────
// The thresholds
// ─────────────────────────────────────────────────────────────────────────

/**
 * The largest contiguous all-ground rectangle a slide may carry, as a share
 * of the frame. **Inherited, not invented.**
 *
 * The legacy design system's `DEAD-SPACE` rule, which the owner already
 * accepted, reads: "no empty horizontal band over 380px on a slide with no
 * background photograph." 380 of 1440 is 0.264; 0.28 is that same rule
 * restated as an area share with ~6% slack for the 64px margin frame plus one
 * line gap. Cover and closer tighten to 0.22.
 *
 * This is the clause that names the owner's actual complaint. "A large empty
 * upper area" is one CONTIGUOUS block, and a slide can pass a flat-share
 * ceiling while carrying one, because texture elsewhere dilutes the total.
 * Today's `headline-focus.html` with a two-line headline measures ≈0.555 and
 * the audit slides ≈0.61 — this clause alone fails them, which is why item
 * M's ground rework ships in the same PR.
 */
export const LARGEST_EMPTY_RECT_CEILING: Readonly<Record<SlideRole, number>> = { cover: 0.22, interior: 0.28, closer: 0.22 };

/**
 * Clause G's floor: how much of the frame must carry something to READ, with
 * decoration excluded.
 *
 * ## Why clause C and clause D were not enough
 *
 * Both read masks in which a decorative ground counts. `occupiedShare` calls
 * a cell occupied when any 4 of its 64 samples are ink, and a full-frame
 * hairline field clears that in every cell it covers — so a plate carrying
 * ONLY its ground decoration, with no headline, no body, no kicker, no
 * device, no content of any kind, measures `inkShare` 0.079, `occupiedShare`
 * 0.42 and a largest empty rectangle of 0.015, and passes clauses A, C, D and
 * F. That is not a threshold being generous; it is the instrument being
 * unable to tell a full slide from a blank one, which is the one thing an
 * emptiness measurement has to do. It also silently disarmed clause A for
 * these templates: a font that failed to load or a slot that came through
 * empty leaves 7.9% ink and no content, and 7.9% is five times clause A's
 * floor.
 *
 * So this clause reads `contentOccupiedShare` — cells whose MEAN colour has
 * visibly left the ground, or that are substantially covered
 * (`slide-metrics.ts`'s "CONTENT vs DECORATION"). Decoration cannot satisfy
 * it at any opacity that keeps it decoration.
 *
 * ## Where the numbers come from
 *
 * They are the measured band between a populated plate and a blank one, and
 * the gap is more than an order of magnitude, which is what makes this a
 * discriminator rather than a taste threshold:
 *
 *   populated `headline_focus`, two-line headline + body   ≈ 0.135
 *   the same plate with only its decorative ground          ≈ 0.00
 *   a stat callout's figure + label + band                  ≈ 0.10-0.18
 *   a full-bleed photograph                                 ≈ 1.0
 *
 * 0.06 for an interior sits at better than 2x below the sparsest populated
 * typographic plate the bundled set makes and better than 6x above a blank
 * one. Cover and closer take 0.09 for the same reason their empty-rect
 * ceiling is tighter — they are the thumbnail and the save moment — while
 * staying under the same 1.5x of headroom.
 *
 * Deliberately NOT set anywhere near `OCCUPIED_SHARE_FLOOR`'s 0.30: this
 * clause answers "is anything here", not "is a third of the plate used".
 * Conflating the two is what would make it a hidden font-weight rule, which
 * is the trap `OCCUPIED_SHARE_FLOOR`'s own comment names.
 */
export const CONTENT_OCCUPIED_SHARE_FLOOR: Readonly<Record<SlideRole, number>> = { cover: 0.09, interior: 0.06, closer: 0.09 };

/**
 * Clause G's second limb: the DOM's own answer to "did any type paint at
 * all".
 *
 * The pixel limb above cannot cover every template on its own, and
 * `cover.html` is the proof: its accent ground block is painted
 * unconditionally at ~29% of the frame, so a cover whose slots ALL came
 * through empty still measures 0.29 of content and clears the floor. That is
 * not a threshold problem — a solid block genuinely is content, in pixels —
 * it is a question pixels cannot answer.
 *
 * `probe.textBoxShare` is the summed area of the text-bearing leaf boxes, and
 * the templates hide every empty slot (`:empty { display: none }`), so a
 * render whose copy never arrived has no text leaves and measures 0. A
 * populated slide's copy lockup alone is 0.1-0.4.
 *
 * 0.01 rather than a bare `> 0` because one template's ground layer IS a text
 * node — `headline-focus.html`'s `gr-glyph` variant sets `{{slideIndex}}` as
 * a 760px display numeral — so the honest reading of a tiny non-zero share is
 * "furniture, not copy". The limb is deliberately calibrated to produce false
 * PASSES rather than false failures: it is one of two limbs, and a clause
 * that can fail a populated slide is worse than one that misses a blank one.
 */
export const PROBE_TEXT_BOX_SHARE_FLOOR = 0.01;

/**
 * Deliberately **a trigger, not a verdict** — half of clause D, never a
 * failure on its own.
 *
 * The bundled typographic archetypes at canonical copy sit roughly 0.62–0.88;
 * a photo slide 0.05–0.20. 0.70 therefore sits INSIDE the legitimate
 * typographic range, and failing on it alone would kill a good Swiss type
 * poster. Above 0.70 a slide has to prove it carries its frame another way
 * (`OCCUPIED_SHARE_FLOOR`). The audit slide is ≈0.93 **and** idle, and it is
 * the conjunction that makes it a defect rather than a style.
 */
export const FLAT_BACKGROUND_CEILING = 0.7;

/**
 * How much of the frame must actually be OCCUPIED — area, not glyph ink.
 *
 * Ink is typeface-dependent (a display face covers ~25–30% of its own text
 * block, a body face ~12–18%), so an ink floor would be a hidden font-weight
 * rule. 0.30 is about a full-width 432px band fully used: the editorial "a
 * third of the plate, plus margins". The audit slide measures ≈0.18.
 *
 * Cover and closer at 0.42 for the same reason their empty-rect ceiling is
 * tighter — they are the thumbnail and the save moment.
 *
 * Pinned by the calibration test with a required margin of at least 0.08 over
 * every bundled archetype. An archetype that cannot clear its floor with
 * margin is either a wrong constant or a genuinely boring template, and both
 * of those are findings.
 */
export const OCCUPIED_SHARE_FLOOR: Readonly<Record<SlideRole, number>> = { cover: 0.42, interior: 0.3, closer: 0.42 };

/**
 * A cover or a closer must carry imagery or a drawn device. Interiors are
 * **exempt**.
 *
 * ## 2026-09-11: moved from 0.03 to 0.10, and the old number was simply wrong
 *
 * This constant used to read: "a full-bleed photo measures ≈1.0, a scrimmed
 * photo panel ≈0.45, the smallest legitimate device the bundled set can make
 * (a 300px figure plus the 132×12 accent band) ≈0.04–0.06, and a headline-only
 * cover ≤0.01 — the accent band alone is 0.001 of the frame." The last claim
 * is the load-bearing one, and it is false on a real render.
 *
 * `graphicShare` counts a cell as a drawn device when the cell is COVERED
 * (48 of its 64 samples are ink) and carries at most three distinct colours.
 * A display face at 100px+ has stems that cover whole 4×4-px cells, so a plate
 * carrying nothing but a headline scores several per cent of "drawn device"
 * out of its own typography. Measured through the real `measureSlidePng` over
 * real Chromium renders of the bundled set (the same instrument the
 * calibration test uses, one plate per row) — THIS TABLE IS THE FIRST PASS,
 * against the templates as they stood before the visual rework, and it is
 * kept because it is the evidence that 0.03 was the wrong number. The table
 * that describes the CURRENT tree is the third-pass sweep further down; where
 * the two disagree, the later one is the measurement:
 *
 *   headline_focus, type + texture only, short / medium / long   3.7% 4.4% 6.1%
 *   headline_focus, glyph ground variant                              5.2%
 *   headline_focus, Hebrew                                            3.0%
 *   headline_focus + a three-row bars device                          5.5%
 *   slide.html, heroless                                              3.2%
 *   slide.html, a 1×1 TRANSPARENT hero (the prep defect)              2.8%
 *   headline_focus with every slot empty                              1.5%
 *   ── the gap ──
 *   comparison_card, two cards                                       19.9%
 *   closer, footer band, no recap strip                              23.4%
 *   list_takeaway, rows panel                                        26.2%
 *   quote_card, pull-quote panel                                     28.8%
 *   cover, colour field, no hero                                     33.1%
 *   closer, footer band + recap panel                                35.7%
 *   stat_callout, stat slab                                          36.3%
 *   a full-bleed photograph                                         ~100%
 *
 * At 0.03 the clause sat INSIDE the type-only band: whether an all-type plate
 * was judged to "carry a device" came down to how many characters the headline
 * happened to have. That is not a rule, and it is why the old grounds were
 * built invisible — the only way to keep a statement slide under a 3% floor
 * was to make sure nothing on it could be seen. 0.10 sits in the real gap, so
 * the clause now says what it means: **a cover or a closer carries a
 * photograph or a filled field, not just big words.**
 *
 * ## 2026-09-11, second pass: "unconditionally" was the wrong word
 *
 * This note used to end "a cover or closer rendered from
 * `cover.html`/`closer.html` clears it unconditionally (33% and 22-36%,
 * because both paint a colour field whatever the copy does)". That was an
 * accurate description of those two files and a bad property for them to
 * have: a colour field painted *whatever the copy does* is a field measuring
 * the template rather than the slide. Rendered with every slot empty, the old
 * `cover.html` reported 29.7% here and 55.8% occupied — clearing the cover
 * role's 10% device floor and its 42% occupancy floor on a plate with nothing
 * on it at all. An instrument that scores its own decoration is the same
 * defect this module exists to catch, one level down.
 *
 * Both files now bind their field to the content that justifies it (see
 * `cover.html`'s header for the rule the whole directory keeps).
 *
 * ## 2026-09-12, fourth pass: THE GAP HAS CLOSED, AND THE FLOOR IS INSIDE IT
 *
 * Every earlier pass sampled the type-only family thinly — one or two copy
 * lengths, one ground variant, and (before the third pass) only the `m` type
 * scale. The type-only CEILING is the number this constant has to clear, so a
 * thin sample there is the one place a sweep cannot afford to be thin: a
 * single un-rendered combination is all it takes to put the floor inside the
 * band it claims to sit above. Swept exhaustively instead — both bundled
 * type-only archetypes x three copy lengths x three type scales x both ground
 * variants x both slide-index parities, plus Hebrew, the bars device and the
 * empty/hollow guards, against the field-bearing family at all three scales —
 * that is exactly what had happened.
 *
 * The measurement, through the repo's own `measureSlidePng` over real
 * Chromium (2026-09-12, this working tree). Only the two ends are reproduced;
 * the rows in the middle are uncontested:
 *
 *   ── the loud end of TYPE AND TEXTURE ONLY ──
 *   headline_focus, short copy, `l`, glyph ground          9.1-9.2%
 *   headline_focus + a three-row bars device, `l`              9.4%
 *   headline_focus, medium copy, `l`, glyph ground       10.7-10.8%
 *   slide.html heroless, long copy, `l`, index even      10.8%
 *   headline_focus, long copy, `l`, glyph ground         11.0-11.1%
 *   slide.html heroless, long copy, `l`, index odd            11.7%  <- ceiling
 *   ── the gap, such as it is: 11.7% to 11.9% ──
 *   comparison_card, Hebrew, `s`                              11.9%  <- floor
 *   comparison_card, `s`                                      13.4%
 *   comparison_card, Hebrew, `m`                              14.2%
 *   cover, colour field, no hero, `l`                         14.6%
 *
 * **0.10 no longer sits in a gap. It sits 1.7 points BELOW the type-only
 * ceiling**, and EIGHT type-only plates now measure at or above it — every one
 * of them at the reviewer's `l` type scale:
 *
 *   10.7  headline_focus medium `l` glyph      11.0  headline_focus long `l` glyph
 *   10.8  headline_focus medium `l` glyph i04  11.1  headline_focus long `l` glyph i04
 *   10.8  slide.html long `l` grid i04         11.7  slide.html long `l` grid
 *   10.8  slide.html long `l` glyph i04        11.7  slide.html long `l` glyph
 *
 * That is precisely the condition the move from 0.03 to 0.10 existed to end:
 * whether an all-type plate is judged to "carry a device" is once again
 * decided by how large the type happens to be rather than by whether anything
 * was drawn. At `m` the loudest type-only plate is 8.3% and at `s` it is 5.7%,
 * so the defect is localised to `l` — which is also why three passes missed
 * it.
 *
 * THE CONSTANT IS NOT THE THING TO MOVE, and the attribution says why. A bare
 * document painting nothing but this ground and the same headline/body type
 * measures 5.8% at `l` (2.7% at `s`, 3.9% at `m`) — typography alone does NOT
 * clear the floor. `slide.html` heroless at `l` measures 11.7%, so about 5.9
 * of those points are the template's own ground layers. The plates are the
 * movable part, exactly as the standing rule requires: the `l`-scale grounds
 * on `slide.html` and on `headline_focus`'s glyph variant have to give back
 * ~2 points to restore any gap at all, and ~4 to restore one worth the name.
 * Raising 0.10 to clear 11.7% would be manufacturing the margin out of the
 * constant, and would re-admit every plate the floor exists to refuse.
 *
 * ## 2026-09-12, fifth pass: THE GROUNDS GAVE THE POINTS BACK
 *
 * They did, and the cause turned out to be one line of CSS repeated in two
 * files rather than a density that needed tuning. Every length in both
 * `l`-scale offenders — `headline-focus.html`'s dash tile and its numeral,
 * `slide.html`'s dot tile — was written `calc(Npx * var(--ts))`, so the
 * reviewer's TYPE scale resized the GROUND along with the copy. A measurement
 * cell is 4 DESIGN px and does not scale: at `--ts: 1.18` a 2.6px dash becomes
 * 3.07px, 77% of a cell's rows instead of 65%, and where the mark crosses a
 * glyph stem the two SUM past the 48-of-64 coverage that makes a cell count as
 * drawn. The marks are now in fixed px in both files (each file's own note
 * carries the argument and the per-scale numbers), `slide.html`'s heroless
 * statement gained the length ladder it was the only archetype missing, and
 * both grounds' contrast was re-chosen by READING them at feed size rather
 * than by the metric — `headline-focus.html`'s dash screen down from 34% of
 * `--fg` to 22%, `slide.html`'s dot screen up from 22% to 30% (it had become
 * invisible, which is a defect in the other direction). The measurement is
 * indifferent to both moves: a mark pixel is INK at 18 units off the ground,
 * and 22% of `--fg` is 47 units while 30% is 64.
 *
 * `slide.html`'s heroless mark also moved from the whole plate to a FIELD
 * with real margins in the same pass, which is why its rows below sit a
 * little differently from the fourth-pass table: see that file's own note for
 * the reason (its `largestEmptyRectShare` was a constant 1.5% on every
 * heroless render it could produce) and for the dot tile's phase arithmetic.
 *
 * The same exhaustive sweep, re-run on this tree (`.local/band-sweep.mjs`,
 * 141 plates: both type-only archetypes x three copy lengths x three type
 * scales x both ground variants x both index parities, plus Hebrew, the bars
 * device and the empty/hollow guards, against the field-bearing family at all
 * three scales):
 *
 *   ── TYPE AND TEXTURE ONLY, and NO device slot ──
 *   slide.html heroless, long, `s`, index odd / even     3.4 / 4.5%
 *   headline_focus, long, `s`, grid / glyph              4.9 / 5.2%
 *   slide.html heroless, long, `m`, index odd / even     5.1 / 5.8%
 *   headline_focus, long, `m`, grid / glyph              6.7 / 6.9%
 *   headline_focus, long, `l`, grid / glyph              7.0 / 7.1%
 *   slide.html heroless, long, `l`, index odd                  7.4%
 *   slide.html heroless, long, `l`, index even                 7.9%  <- ceiling
 *   ── the gap: 7.9% to 11.9%, and 0.10 is inside it ──
 *   comparison_card, Hebrew, `s`                              11.9%  <- floor
 *   comparison_card, `s` / Hebrew `m`                   13.4 / 14.2%
 *   comparison_card, `l` / `m` / Hebrew `l`             15.6-16.1%
 *   cover, colour field, no hero, `s` / `m` / `l`       18.0-20.8%
 *   stat_callout, quote_card, closer, list_takeaway     21.5-44.0%
 *   a full-bleed photograph                                  ~100%
 *
 * 0.10 is 2.1 points above the type-only ceiling (a factor of 1.27) and 1.9
 * points below the quietest field-bearing plate (a factor of 1.19). That is
 * a real gap rather than a generous one, and the row that keeps it narrow at
 * the top is the same one it always was — see the note on `comparison_card`
 * below.
 *
 * A THIRD FAMILY, AND THE SUMMARY ABOVE DELIBERATELY EXCLUDES IT. A
 * `headline_focus` carrying a three-row bars device measures 5.1 / 7.1 / 9.4%
 * at `s` / `m` / `l` — it crosses most of the gap without crossing the floor.
 * `band-sweep.mjs` used to count it in the TYPE-ONLY family, so the script
 * printed a ceiling of 9.4% and a margin of 0.6 points while this comment
 * printed 7.7% and 2.3 — the same number arrived at two ways, which is a
 * comment and a tool disagreeing about the fact they are both describing. The
 * script now classifies it as its own `device` family and reports all three
 * bands, so "loudest TYPE-ONLY plate" there and "ceiling" here are the same
 * row. Run it and the two agree line for line.
 *
 * WHY IT IS ITS OWN FAMILY RATHER THAN PART OF THE CEILING: this plate's
 * device slot is FILLED. Clause E asks whether a slide carries imagery or a
 * drawn device, and this one does, so clause E accepting it at a positional
 * role is the clause working rather than failing — it does not belong in a
 * ceiling that exists to describe plates carrying NOTHING but type.
 *
 * WHAT THAT LEAVES OPEN, SAID PLAINLY RATHER THAN BURIED: at 9.4% the bars
 * plate is still 0.6 points UNDER the floor, so a slide whose device slot is
 * filled with bars is refused at a positional role anyway — the metric
 * declines to score strokes and labels as drawn area (see the `comparison_card`
 * note below, which is the same physics). That is a false refusal and it is
 * the one this band cannot fix by moving 0.10: raising the floor to admit it
 * re-admits every type-only plate the floor exists to refuse. The fix, when
 * somebody wants it, is in `dv-bars-block` — filled bar tracks rather than
 * outlined ones — not here. No guard in the suite requires this plate to be
 * refused, and the cover sweep renders `headline_focus` with an EMPTY device
 * slot precisely so that what it measures is the ground.
 *
 * The three things this must not break all hold now. A cover or closer with
 * copy on it clears the floor (18.0-20.8% for a photoless cover at s/m/l, and
 * that figure is now a constant of the template rather than a function of how
 * little copy arrived — see `cover.html`'s third-pass note). A hero that
 * contributed no pixels is still caught. And `headline_focus` judged at the
 * cover role — the pixel half of `default:cover-carries-device` — reports
 * `no-device` at EVERY type scale on EITHER ground: replayed through
 * `assembleSlidesData` + `measureSlidePng` + `checkInterestFloor` + the
 * shipped `probePage`, the six combinations measure 4.9 / 6.7 / 7.0% on the
 * grid ground and 5.2 / 6.9 / 7.1% on the glyph ground at s / m / l, and all
 * six report the clause.
 *
 * Kept for the record, the THIRD-PASS sweep (2026-09-11, 56 plates, an
 * intermediate state of the directory that never shipped). It is the evidence
 * that this band moves when the grounds move, which is the whole reason it
 * has to be re-measured rather than remembered:
 *
 *   ── TYPE AND TEXTURE ONLY (no field, no photograph) ──
 *   every slot empty (cover / closer / headline_focus)   0.2%
 *   headline_focus with an empty statement               0.7%
 *   headline_focus, Hebrew                               2.7%
 *   slide.html, a 1x1 TRANSPARENT hero (the prep defect) 2.7%
 *   slide.html heroless, Hebrew                          3.4%
 *   headline_focus, short copy                           3.6%
 *   headline_focus, medium copy / judged as a cover      4.8%
 *   headline_focus at the `s` type scale                 4.9%
 *   headline_focus, glyph ground variant                 5.7%
 *   slide.html, heroless                                 6.1%
 *   headline_focus, long copy                            6.7%
 *   headline_focus at the `l` type scale                 7.0%
 *   headline_focus + a three-row bars device             7.1%
 *   ── the gap: 7.1% to 13.5%, and 0.10 is inside it ──
 *   comparison_card at `s`                              13.5%
 *   comparison_card, Hebrew                             14.1%
 *   cover at `l`                                        14.2%
 *   comparison_card in position 1 / at `l`         15.4/15.6%
 *   closer with a hollowed takeaway                     18.2%
 *   closer, Hebrew                                      19.8%
 *   closer, no recap strip (pale kit / reference) 21.6/21.7%
 *   closer, glyph ground variant                        21.9%
 *   cover, colour field, no hero                        26.9%
 *   closer at `s` / with a badge / cover at `s`    29.7-30.7%
 *   closer, footer band + recap strip                   31.2%
 *   stat_callout at `s`                                 31.6%
 *   cover, Hebrew / at `l` / pale kit / short copy 32.7-34.0%
 *   cover + a figure device                             34.4%
 *   stat_callout (slab), quote_card (panel)        34.7-46.7%
 *   list_takeaway (rows panel)                     37.5-44.1%
 *   a full-bleed photograph (dark / light plate)   58.0/64.2%
 *
 * At that intermediate state the band was bipartite with nothing between 7.1%
 * and 13.5%. The fourth-pass sweep above is the state that produced the
 * defect, and the fifth-pass sweep is the state of this tree — that one is the
 * one to read.
 *
 * TWO ROWS THAT LOOK LIKE ANOMALIES AND ARE NOT, in every sweep.
 * `headline_focus + a three-row bars device` sits high in the TYPE-ONLY half
 * while carrying a rendered device — the bars are strokes and labels rather
 * than filled area, so the metric correctly declines to score them as one.
 * That is why the constant is stated as a floor on IMAGERY OR DEVICE SHARE
 * and not as "does this slide have a device slot": a device the pixels cannot
 * see is not one. And `comparison_card` is the quietest field-bearing
 * archetype because its two cards are outlined rather than filled; it is the
 * row that sets this constant's ceiling, so a revision that lightens those
 * cards lowers the ceiling rather than raising the floor.
 *
 * WHAT WOULD PUT THE FLOOR BACK INSIDE THE BAND, stated so the next revision
 * can see it coming: any change that makes a type-only plate's GROUND cover
 * more of a measurement cell. The two that did it were expressed in `--ts`;
 * a heavier stroke weight on a display face does it too (`headline-focus.html`
 * records measuring 3.9% of drawn device from its typography alone at weight
 * 600, which is why it sets 500). The check is one command —
 * `.local/band-sweep.mjs` prints the two ceilings and names every type-only
 * plate at or above the floor — and the guard that fails in CI if it is
 * skipped is the cover sweep in `interest-floor-calibration.test.ts`.
 */
export const IMAGERY_OR_DEVICE_FLOOR = 0.1;

/**
 * **Not taste — render integrity.** A single 74px headline line on its own
 * measures ≈0.015–0.02 ink; below that there is no readable content at all,
 * which means a font failed to load, a slot came through empty, or the
 * screenshot caught the page before it painted. Its message says "the render
 * looks broken, not boring" and its remedy is a re-render, not a redraft.
 */
export const INK_SHARE_FLOOR = 0.015;

/**
 * The opposite failure of everything else here, and cheap to catch: above
 * ~55% glyph-bearing cells the slide is a wall of text and is illegible at
 * feed size.
 */
export const TEXT_SHARE_CEILING = 0.55;

/**
 * A cross-check reported as evidence and **never gating alone**: high ink
 * with almost no edges is a solid wash, not content. Kept out of the clause
 * list on purpose — a legitimate full-bleed colour-block cover is exactly
 * "lots of ink, few edges", and failing it would refuse a design the system
 * deliberately makes.
 */
export const EDGE_DENSITY_FLOOR = 0.06;

/**
 * The accent band. **Warn only, both ends.**
 *
 * 0.0008 is about the 132×12 band — the smallest accent moment the system
 * intends. Below it the accent did not paint, which is the accent-drift
 * symptom Phase 0 chased structurally at `resolveSlideAccent`. Above 0.45 the
 * accent has become the ground, which is sometimes deliberate. Neither can
 * hold a run: brand furniture must never be able to, the invariant
 * `assessBrandAssetPresence` already states.
 *
 * ## Why 0.45 is a real band and not decoration, as of 2026-09-11
 *
 * A warning nothing can ever trip is worse than no warning, and a warning
 * that trips on every slide a whole client ever ships is worse still: it
 * trains the reviewer to ignore the one signal that says the brand colour ran
 * away with the plate. The previous `cover.html` was 4.3 points under this
 * ceiling on the reference kit (40.0% against 45%) with a flat
 * `color-mix(accent 88%, bg)` field across the top half — and OVER it on a
 * pale accent the palette walk admits without complaint: rendered at
 * `#EFC75E`, whose only gate is `ACCENT_GROUND_CONTRAST_FLOOR = 3` against
 * the ground, the same cover measured 45.7%. Every cover that client shipped
 * would have carried `accent-out-of-band`.
 *
 * `cover.html`'s field is now a graded ramp rather than a flat fill, and only
 * its head is within `accent` tolerance of the token. Re-measured over real
 * Chromium on both kits:
 *
 *   cover, no hero, reference `#C4552F`     3.7-4.9%
 *   cover, no hero, pale `#EFC75E`               2.2%
 *   stat_callout / quote_card / closer, pale 0.7-1.9%
 *
 * — mid-band on both ends for both kits, which is what makes a reading near
 * 45% mean something again. `interest-floor-calibration.test.ts` renders the
 * pale-accent row so the band table covers the range the palette walk
 * actually permits rather than the one reference hex.
 */
export const ACCENT_MIN_SHARE = 0.0008;
export const ACCENT_MAX_SHARE = 0.45;

/**
 * About 6,200px of ink inside the 8px bleed band — roughly one clipped line
 * of body text. Below that, edge ink is a deliberate full-bleed element.
 */
export const CLIPPED_EDGE_SHARE_CEILING = 0.004;

/** Fewer distinct colours than this and the render is probably missing a layer. Warn only — a strict two-colour poster is a real design. */
export const MIN_QUANTISED_COLOUR_COUNT = 3;

/**
 * Above this much imagery, a low `quantisedColourCount` says nothing.
 *
 * `measureSlidePng` counts 5-bit colours holding at least half a percent of
 * the frame — the slide's PALETTE, not its colour range — and a photograph
 * spreads its pixels so thinly across bins that none clears that floor,
 * scoring 0. 0.10 is comfortably above the largest incidental imagery a
 * typographic slide picks up (a logo, a hairline texture) and far below the
 * ~0.45 a scrimmed photo panel measures.
 */
export const IMAGERY_SHARE_FOR_PALETTE_WARNING = 0.1;

/**
 * Above this much imagery-or-graphic coverage, ink in the bleed band is a
 * FULL-BLEED ELEMENT rather than clipped type — so clause B's pixel limb goes
 * inert. Its `probe.overflow` limb does not; see `checkInterestFloor`.
 *
 * Measured, not assumed: the real `measureSlidePng` over a synthetic
 * full-frame photograph reports `clippedEdgeShare` **2.57%** against a 0.4%
 * ceiling — six times over — with `imageryShare` 82.9%. A photograph puts
 * ink in the 8-design-px bleed band BY DEFINITION, so without this every
 * photo slide and every hero-bearing cover would fail the interest floor on
 * every attempt, return to copy, and ship degraded: the opposite of the
 * intent, and it would read as "the floor does not work" rather than as a
 * threshold bug.
 *
 * 0.5 rather than something lower, because half the frame is the share at
 * which an element cannot be a panel sitting inside the 64px margin frame —
 * it has to be reaching the edges. The two bands this deliberately leaves
 * INSIDE the rule are the ones where clipped type is the likelier
 * explanation: the smallest legitimate device (0.04-0.06) and a scrimmed
 * photo PANEL (~0.45), neither of which bleeds.
 */
export const FULL_BLEED_IMAGERY_SHARE = 0.5;

// ─────────────────────────────────────────────────────────────────────────
// Findings
// ─────────────────────────────────────────────────────────────────────────

/**
 * Which clause failed. One kind per clause, so the free re-layout planner
 * (`interest-relayout.ts`) can switch on it and the ledger row can be
 * grouped by it.
 */
export type InterestFailureKind = "render-integrity" | "clipped" | "dead-space" | "empty" | "no-device" | "text-wall";

/** Facts a reviewer and `08b` should see, that must never fail an attempt. */
export type InterestWarningKind = "accent-out-of-band" | "background-not-brand-ground" | "low-colour-count" | "low-edge-density";

export interface InterestFinding {
  slide: number;
  role: SlideRole;
  kind: InterestFailureKind;
  /** The measured numbers this finding rests on, keyed by their `SlideMetrics` field name — so the gate payload carries the evidence, not just the verdict. */
  measured: Record<string, number>;
  /** The single number the clause compared against, for the role. */
  threshold: number;
  /** The measured fact, one sentence, naming the slide, the number and the threshold. */
  sentence: string;
  /** The remedy, naming a mechanism the WRITER controls — `device`, `visualNeed`, an archetype, a merge — never an aesthetic. */
  steer: string;
  /** Set when clause E was waived because this attempt lost the slide's photograph to sourcing. Reported, never failed. */
  waivedReason?: string;
}

export interface InterestWarning {
  slide: number;
  role: SlideRole;
  kind: InterestWarningKind;
  measured: Record<string, number>;
  sentence: string;
}

export interface InterestFloorOptions {
  /** This slide's carousel position. Every finding names it, and the waiver is keyed on it. */
  slide: number;
  /**
   * `downgradedForImagesThisAttempt` from the workflow — which slides THIS
   * attempt shipped text-only for want of a picture.
   *
   * Clause E is waived for a slide in this set, mirroring `07h`'s waiver of
   * `default:cover-carries-device` for exactly the same reason: a redraft
   * cannot conjure a photograph the tiers could not find, and holding for it
   * would be the "held because of a picture" this workflow promises never to
   * do. The waived finding is still reported.
   */
  downgradedForImages?: ReadonlySet<number> | undefined;
  /** The archetype this slide rendered through (`stat-callout`, `custom-pull_rail`) — named in the sentence when known, so item O's custom layouts are identifiable in the ledger. */
  archetype?: string | undefined;
}

/** One slide's verdict. `ok` is `findings.length === 0`; a waived finding does not fail. */
export interface InterestVerdict {
  slide: number;
  role: SlideRole;
  ok: boolean;
  findings: InterestFinding[];
  /** Clause-E findings suppressed by the image-sourcing waiver. Never counted in `ok`. */
  waived: InterestFinding[];
  warnings: InterestWarning[];
  /** Echoed so the gate payload, the deliverable and `08b`'s input carry the numbers the verdict rests on. */
  metrics: SlideMetrics;
}

// ─────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * A share as a percentage a human reads without decoding. One decimal below
 * 10% (a `clippedEdgeShare` of 0.006 is "0.6%", not "1%"), whole numbers
 * above it (0.93 is "93%", not "93.0%").
 */
export function pct(share: number): string {
  const value = share * 100;
  return value < 10 ? `${Math.round(value * 10) / 10}%` : `${Math.round(value)}%`;
}

/** `{x, y, w, h}` as the two corners a designer would point at. */
function rectSpan(rect: SlideMetrics["largestEmptyRect"]): string {
  return `${rect.x},${rect.y} to ${rect.x + rect.w},${rect.y + rect.h}`;
}

/** "a cover" / "an interior slide" / "a closer" — the article matters in the sentences below. */
function roleNoun(role: SlideRole): string {
  return role === "interior" ? "an interior slide" : `a ${role}`;
}

// ─────────────────────────────────────────────────────────────────────────
// The rule
// ─────────────────────────────────────────────────────────────────────────

/**
 * One slide's interest verdict, clauses evaluated in the order below.
 *
 * Clause A (integrity) SHORT-CIRCUITS: if a slide carries almost no ink then
 * every other share is measured against a frame that never painted, so
 * reporting "it is also empty and also has a hole" would be three findings
 * about one broken render and would send a redraft after copy that was never
 * the problem. Clauses B–G are all evaluated and collected, because a slide
 * genuinely can carry more than one defect and the writer should be told
 * about all of them in one steer rather than rediscovering them one redraft
 * at a time.
 *
 * Warnings are computed on every path except A and never affect `ok`.
 */
/**
 * Template basenames whose file declares a slot a `SlideDevice` fragment
 * paints into.
 *
 * `cover.html` and `headline-focus.html` carry `{{html:device}}`;
 * `closer.html` carries `{{html:recap}}`, which `contentFor` fills with a
 * device when there is no recap strip to build. A `custom-*` archetype is
 * model-authored markup and may declare either, so it is treated as capable —
 * the same "a template path cannot tell us, so do not refuse" posture
 * `checkDefaultRenderRules` takes for a custom cover.
 *
 * Duplicated here rather than imported: `slides-data.ts`'s
 * `DEVICE_SLOT_LAYOUTS` is module-private and keyed by layout,
 * `visual-qa-pre-checks.ts`'s `DEVICE_SLOT_BASENAMES` is keyed by basename,
 * and this module is meant to be readable on its own. All three are pinned
 * against each other by `interest-floor.test.ts`.
 */
const DEVICE_SLOT_BASENAMES: ReadonlySet<string> = new Set(["cover", "headline-focus", "closer"]);

/** Whether a steer may honestly offer this slide a `device`. Unknown archetype → yes: silence is not evidence of an absent slot. */
export function canPaintDevice(archetype: string | undefined): boolean {
  if (archetype === undefined) return true;
  const base = archetype.replace(/\.html$/u, "").replace(/-inv$/u, "");
  return DEVICE_SLOT_BASENAMES.has(base) || base.startsWith("custom-");
}

export function checkInterestFloor(
  metrics: SlideMetrics,
  probe: SlideProbe | undefined,
  role: SlideRole,
  opts: InterestFloorOptions,
): InterestVerdict {
  const slide = opts.slide;
  const findings: InterestFinding[] = [];
  const waived: InterestFinding[] = [];
  const where = opts.archetype !== undefined ? `slide ${slide} ("${opts.archetype}")` : `slide ${slide}`;
  // Every steer that offers a `device` has to say so honestly: only
  // `cover.html`, `headline-focus.html` and `closer.html` declare a slot a
  // device fragment paints into (`DEVICE_SLOT_BASENAMES` in
  // `visual-qa-pre-checks.ts`, `DEVICE_SLOT_LAYOUTS` in `slides-data.ts`), and
  // `contentFor` drops the fragment everywhere else without a word. Telling
  // the writer of a `list_takeaway` plate to "give this slide a device" is an
  // unenforced instruction dressed as an enforced one — it redrafts, sets the
  // field, and measures exactly the same. So the phrase names the archetype
  // switch when one is needed, which is a mechanism the writer also controls.
  const deviceSteer = (what: string): string =>
    canPaintDevice(opts.archetype)
      ? what
      : `${what} (slide ${slide} renders as "${opts.archetype ?? "an archetype with no device slot"}", which paints no device — set its layout to cover, headline_focus or closer at the same time)`;

  // ── A — integrity. Nothing painted, so nothing else is measurable. ──
  if (metrics.inkShare < INK_SHARE_FLOOR) {
    return {
      slide,
      role,
      ok: false,
      waived,
      warnings: [],
      metrics,
      findings: [
        {
          slide,
          role,
          kind: "render-integrity",
          measured: { inkShare: metrics.inkShare },
          threshold: INK_SHARE_FLOOR,
          sentence: `${where} — only ${pct(metrics.inkShare)} of the frame carries any ink at all (floor ${pct(INK_SHARE_FLOOR)}); the render looks broken, not boring.`,
          steer: `Do not rewrite slide ${slide}: a frame with no ink means a font did not load, a slot came through empty, or the screenshot caught the page before it painted. Re-render it.`,
        },
      ],
    };
  }

  // ── B — clipped. The type does not fit at the size the template chose. ──
  //
  // TWO limbs, and only one of them is exemptible. `probe.overflow` is a DOM
  // fact — an element whose content is wider or taller than its own box —
  // and it is the half that catches Hebrew type running off the plate at a
  // size an in-page `textContent.length` breakpoint picked for Latin glyph
  // widths. It fires whatever the slide is carrying.
  //
  // `clippedEdgeShare` is a PIXEL fact, and on a full-bleed element it is not
  // a defect at all: a photograph reaching the frame edge measures ~2.6% ink
  // in the bleed band against a ceiling set at "about one clipped line of
  // body text". See `FULL_BLEED_IMAGERY_SHARE` for the measurement and for
  // why the exemption starts at half the frame rather than lower.
  const overflowing = probe?.overflowing ?? [];
  const bleedsByDesign = metrics.imageryOrDeviceShare >= FULL_BLEED_IMAGERY_SHARE;
  if (probe?.overflow === true || (!bleedsByDesign && metrics.clippedEdgeShare > CLIPPED_EDGE_SHARE_CEILING)) {
    const named = overflowing.length > 0 ? ` (${overflowing.slice(0, 3).join(", ")})` : "";
    findings.push({
      slide,
      role,
      kind: "clipped",
      measured: { clippedEdgeShare: metrics.clippedEdgeShare, ...(probe ? { overflowingElements: overflowing.length } : {}) },
      threshold: CLIPPED_EDGE_SHARE_CEILING,
      sentence:
        probe?.overflow === true
          ? `${where} — ${overflowing.length || 1} element(s) overflow their own box${named}, and ${pct(metrics.clippedEdgeShare)} of the frame is ink inside the 8px bleed band (ceiling ${pct(CLIPPED_EDGE_SHARE_CEILING)}).`
          : `${where} — ${pct(metrics.clippedEdgeShare)} of the frame is ink inside the 8px bleed band (ceiling ${pct(CLIPPED_EDGE_SHARE_CEILING)}); type is running off the plate.`,
      // The templates size display type from the string's own length, so a
      // handful of characters fewer changes the step the layout picks.
      steer: `Shorten slide ${slide}'s headline or body so the type fits at the size its own length picks — the display sizes step on character count, so a few characters fewer is enough. Or drop this slide's fontScale one step.`,
    });
  }

  // ── C — dead space. One contiguous hole, the owner's actual complaint. ──
  //
  // Read on the MARK mask, where a ground treatment counts, and that is
  // faithful to the rule this ceiling was inherited from: the legacy
  // DEAD-SPACE rule reads "no empty horizontal band over 380px on a slide
  // with no background photograph", i.e. it is about BARE ground. A slide
  // whose upper third carries a hairline field or a low-contrast glyph wash
  // has a background; whether that background is INTERESTING is a different
  // question, and clause G below is the one that asks it. The content
  // rectangle rides along in `measured` either way, so the gate payload shows
  // both numbers and a reviewer can see when the hole is filled by decoration
  // alone.
  const rectCeiling = LARGEST_EMPTY_RECT_CEILING[role];
  if (metrics.largestEmptyRectShare > rectCeiling) {
    findings.push({
      slide,
      role,
      kind: "dead-space",
      measured: {
        largestEmptyRectShare: metrics.largestEmptyRectShare,
        largestEmptyContentRectShare: metrics.largestEmptyContentRectShare,
        occupiedShare: metrics.occupiedShare,
      },
      threshold: rectCeiling,
      sentence: `${where} — an empty rectangle covered ${pct(metrics.largestEmptyRectShare)} of the plate (${rectSpan(metrics.largestEmptyRect)}); the ceiling is ${pct(rectCeiling)} for ${roleNoun(role)}.`,
      steer:
        role === "cover"
          ? `A cover carries a photograph, a title card over a graphic ground, or a figure device — a headline on flat ground is not a cover. Give slide ${slide} a real visualNeed, or ${deviceSteer("a device built from the strongest number in this post")}.`
          : `Fill the hole with something the slide already has: ${deviceSteer("a device built from its own figure")}, a second content element, or one more line of body. If neither exists, merge slide ${slide} into ${slide > 1 ? `slide ${slide - 1}` : "the next slide"} and let the carousel be one slide shorter.`,
    });
  }

  // ── D — substance. Flat AND idle: the conjunction is the defect. ──
  const occupiedFloor = OCCUPIED_SHARE_FLOOR[role];
  if (metrics.flatBackgroundShare > FLAT_BACKGROUND_CEILING && metrics.occupiedShare < occupiedFloor) {
    findings.push({
      slide,
      role,
      kind: "empty",
      measured: { flatBackgroundShare: metrics.flatBackgroundShare, occupiedShare: metrics.occupiedShare },
      threshold: occupiedFloor,
      sentence: `${where} — ${pct(metrics.flatBackgroundShare)} of the pixels were the background colour and only ${pct(metrics.occupiedShare)} of the frame was occupied (floor ${pct(occupiedFloor)} for ${roleNoun(role)}).`,
      steer: `Either ${deviceSteer(`give slide ${slide} a device (figure, bars, before/after, timeline, versus)`)} or merge it into ${slide > 1 ? `slide ${slide - 1}` : "the next slide"} and let the carousel be one slide shorter.`,
    });
  }

  // ── E — a cover or a closer carries something other than type. ──
  if (role !== "interior" && metrics.imageryOrDeviceShare < IMAGERY_OR_DEVICE_FLOOR) {
    const finding: InterestFinding = {
      slide,
      role,
      kind: "no-device",
      measured: { imageryOrDeviceShare: metrics.imageryOrDeviceShare, imageryShare: metrics.imageryShare, graphicShare: metrics.graphicShare },
      threshold: IMAGERY_OR_DEVICE_FLOOR,
      sentence: `${where} — imagery and drawn devices cover ${pct(metrics.imageryOrDeviceShare)} of the frame (floor ${pct(IMAGERY_OR_DEVICE_FLOOR)} for ${roleNoun(role)}); this is type on ground and nothing else.`,
      steer:
        role === "cover"
          ? `A cover carries a photograph, a title card over a graphic ground, or a figure device — a headline on flat ground is not a cover. Give slide ${slide} a real visualNeed, or ${deviceSteer("a device built from the strongest number in this post")}.`
          : `The closer is the save moment: recap this post's own figures as a strip, or ask a question the reader can answer, or ${deviceSteer("carry a device")}. A near-empty last plate is what a reader scrolls past.`,
    };
    if (opts.downgradedForImages?.has(slide) === true) {
      waived.push({
        ...finding,
        waivedReason: `waived: slide ${slide} lost its photograph to image sourcing this attempt, which is never a hold — left to the judge and the reviewer`,
      });
    } else {
      findings.push(finding);
    }
  }

  // ── F — wall of text. The opposite failure, and cheap to catch. ──
  if (metrics.textShare > TEXT_SHARE_CEILING) {
    findings.push({
      slide,
      role,
      kind: "text-wall",
      measured: { textShare: metrics.textShare },
      threshold: TEXT_SHARE_CEILING,
      sentence: `${where} — ${pct(metrics.textShare)} of the frame is glyph-bearing (ceiling ${pct(TEXT_SHARE_CEILING)}); at feed size this reads as a wall of text.`,
      steer: `Cut slide ${slide} to one idea: move the body's last sentence to the caption, or split the slide in two. Do not shrink the type to make it fit.`,
    });
  }

  // ── G — decoration is not content. ──
  //
  // The clause that can tell a full slide from a blank one, and the reason it
  // exists is in `CONTENT_OCCUPIED_SHARE_FLOOR`'s comment: every other clause
  // reads a mask a decorative ground satisfies on its own, so a plate
  // carrying nothing but its own texture passed all of them. Unlike clause D
  // this has no flat-background limb — it does not need one. "There is
  // nothing here to read" is a defect whatever the ground is doing, and a
  // busy ground is exactly the case the conjunction in D lets through.
  const contentFloor = CONTENT_OCCUPIED_SHARE_FLOOR[role];
  const typeShare = probe?.textBoxShare;
  const noType = typeShare !== undefined && typeShare < PROBE_TEXT_BOX_SHARE_FLOOR;
  if (metrics.contentOccupiedShare < contentFloor || noType) {
    findings.push({
      slide,
      role,
      kind: "empty",
      measured: {
        contentOccupiedShare: metrics.contentOccupiedShare,
        occupiedShare: metrics.occupiedShare,
        largestEmptyContentRectShare: metrics.largestEmptyContentRectShare,
        inkShare: metrics.inkShare,
        ...(typeShare !== undefined ? { textBoxShare: typeShare } : {}),
      },
      threshold: noType ? PROBE_TEXT_BOX_SHARE_FLOOR : contentFloor,
      sentence: noType
        ? `${where} — the document carries no text box at all (${pct(typeShare ?? 0)} of the plate, floor ${pct(PROBE_TEXT_BOX_SHARE_FLOOR)}) while ${pct(metrics.occupiedShare)} of the frame is painted: the ground layers rendered and the copy did not.`
        : `${where} — only ${pct(metrics.contentOccupiedShare)} of the frame carries anything to read (floor ${pct(contentFloor)} for ${roleNoun(role)}), ` +
          `against ${pct(metrics.occupiedShare)} of the frame carrying a mark of any kind: the difference is ground decoration, and the largest region with no content in it covers ${pct(metrics.largestEmptyContentRectShare)}.`,
      steer:
        `Slide ${slide} is a decorated empty plate: its ground treatment is painting and its content is not. ` +
        `Check that the headline and body actually reached it, then give it something a reader can take away — ${deviceSteer("a device built from its own figure")}, a second content element — or merge it into ${slide > 1 ? `slide ${slide - 1}` : "the next slide"}.`,
    });
  }

  return { slide, role, ok: findings.length === 0, findings, waived, warnings: interestWarningsFor(metrics, role, slide), metrics };
}

/**
 * The facts that ride along and never fail an attempt.
 *
 * Separated from the clause list rather than mixed into it, so "this can hold
 * a run" is answerable by reading which function a threshold appears in.
 */
export function interestWarningsFor(metrics: SlideMetrics, role: SlideRole, slide: number): InterestWarning[] {
  const warnings: InterestWarning[] = [];
  if (metrics.accentShare < ACCENT_MIN_SHARE) {
    warnings.push({
      slide,
      role,
      kind: "accent-out-of-band",
      measured: { accentShare: metrics.accentShare },
      sentence: `slide ${slide} — the accent covers ${pct(metrics.accentShare)} of the frame, below the ${pct(ACCENT_MIN_SHARE)} the smallest intended accent moment measures; the accent may not have painted.`,
    });
  } else if (metrics.accentShare > ACCENT_MAX_SHARE) {
    warnings.push({
      slide,
      role,
      kind: "accent-out-of-band",
      measured: { accentShare: metrics.accentShare },
      sentence: `slide ${slide} — the accent covers ${pct(metrics.accentShare)} of the frame (over ${pct(ACCENT_MAX_SHARE)}); the accent has become the ground, which may be deliberate.`,
    });
  }
  if (!metrics.backgroundMatchesBrandGround) {
    warnings.push({
      slide,
      role,
      kind: "background-not-brand-ground",
      measured: {},
      sentence: `slide ${slide} — the dominant flat colour (${metrics.backgroundHex}) is not the brand ground the caller expected; on a full-bleed photograph this is normal.`,
    });
  }
  // Read beside `imageryShare`, per `quantisedColourCount`'s own contract: a
  // photograph spreads its pixels over so many 5-bit bins that NONE reaches
  // the 0.5% floor, so a full-bleed photo slide legitimately counts 0 colours.
  // Warning on that would fire on every good photo slide, which is the churn
  // this whole file's default-passing posture exists to avoid.
  if (metrics.quantisedColourCount < MIN_QUANTISED_COLOUR_COUNT && metrics.imageryShare < IMAGERY_SHARE_FOR_PALETTE_WARNING) {
    warnings.push({
      slide,
      role,
      kind: "low-colour-count",
      measured: { quantisedColourCount: metrics.quantisedColourCount, imageryShare: metrics.imageryShare },
      sentence: `slide ${slide} — only ${metrics.quantisedColourCount} colour(s) hold meaningful weight (under ${MIN_QUANTISED_COLOUR_COUNT}) on a slide carrying ${pct(metrics.imageryShare)} imagery; a layer may be missing.`,
    });
  }
  // Reported, never gating: a deliberate colour-block cover is exactly "lots
  // of ink, few edges", and this number is only useful next to the others.
  if (metrics.inkShare >= INK_SHARE_FLOOR && metrics.edgeDensity < EDGE_DENSITY_FLOOR) {
    warnings.push({
      slide,
      role,
      kind: "low-edge-density",
      measured: { edgeDensity: metrics.edgeDensity, inkShare: metrics.inkShare },
      sentence: `slide ${slide} — ${pct(metrics.inkShare)} ink at an edge density of ${metrics.edgeDensity.toFixed(3)} (under ${EDGE_DENSITY_FLOOR}); the ink is a solid wash rather than content.`,
    });
  }
  return warnings;
}

// ─────────────────────────────────────────────────────────────────────────
// The carousel-level report
// ─────────────────────────────────────────────────────────────────────────

/**
 * One rendered slide as the render tool hands it back, narrowed to what this
 * module reads. `metrics` is absent when `measureSlidePng` returned
 * `{ ok: false }` — an undecodable buffer, an interlaced PNG, over 16M
 * pixels — and `metricsReason` carries its own words.
 */
export interface MeasuredSlide {
  n: number;
  metrics?: SlideMetrics | undefined;
  /** `measureFailure` on the renderer's own `rendered[]` row — why measurement produced nothing when it was asked for. */
  measureFailure?: string | undefined;
  probe?: SlideProbe | undefined;
}

export interface InterestFloorReport {
  /** True when every MEASURED slide cleared its role's floor. An unmeasured slide never makes this false. */
  ok: boolean;
  perSlide: InterestVerdict[];
  /** Every failing finding across the carousel, in slide order — the list the steer, the gate payload and the ledger warn are all built from. */
  findings: InterestFinding[];
  waived: InterestFinding[];
  warnings: InterestWarning[];
  /** Slides the measurement could not read. A fact on the gate and a ledger warn, never a verdict — see `checkSlidesInterestFloor`. */
  notMeasured: Array<{ slide: number; reason: string }>;
}

/**
 * The whole attempt's verdict, roles assigned from carousel position.
 *
 * A slide with no metrics is recorded in `notMeasured` and does not fail: an
 * unmeasurable PNG is a tooling oddity, and turning one into an editorial
 * verdict would be the "held because of a picture" failure mode in a new
 * costume. `ok` therefore means "nothing MEASURED failed", which is what the
 * caller needs to decide whether to spend a redraft.
 */
export function checkSlidesInterestFloor(
  slides: readonly MeasuredSlide[],
  opts: { downgradedForImages?: ReadonlySet<number> | undefined; archetypeBySlide?: ReadonlyMap<number, string> | undefined } = {},
): InterestFloorReport {
  const perSlide: InterestVerdict[] = [];
  const notMeasured: Array<{ slide: number; reason: string }> = [];

  for (const [index, slide] of slides.entries()) {
    const role = slideRoleFor(index, slides.length);
    if (slide.metrics === undefined) {
      notMeasured.push({ slide: slide.n, reason: slide.measureFailure ?? "the renderer reported no metrics for this slide" });
      continue;
    }
    const archetype = opts.archetypeBySlide?.get(slide.n);
    perSlide.push(
      checkInterestFloor(slide.metrics, slide.probe, role, {
        slide: slide.n,
        ...(opts.downgradedForImages !== undefined ? { downgradedForImages: opts.downgradedForImages } : {}),
        ...(archetype !== undefined ? { archetype } : {}),
      }),
    );
  }

  const findings = perSlide.flatMap((v) => v.findings);
  return {
    ok: findings.length === 0,
    perSlide,
    findings,
    waived: perSlide.flatMap((v) => v.waived),
    warnings: perSlide.flatMap((v) => v.warnings),
    notMeasured,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// What the writer is told
// ─────────────────────────────────────────────────────────────────────────

/**
 * One finding's writer-facing steer: the measured fact, then the remedy.
 *
 * Three properties held deliberately, and the tests pin all three: the
 * measured number is IN the sentence (not in a payload the model never
 * reads); the remedy names a mechanism the writer controls — `device`,
 * `visualNeed`, an archetype, a merge — never an aesthetic; and the slide
 * number is named so a six-slide carousel's steer is actionable per slide.
 *
 * Takes one finding or many, because both call shapes are natural: the
 * relayout planner reasons about a single finding, the workflow hands over
 * the whole attempt's list.
 */
export function interestSteerFor(findings: readonly InterestFinding[] | InterestFinding): string {
  const list = Array.isArray(findings) ? findings : [findings];
  return list.map((f) => `${f.sentence} ${f.steer}`).join("\n");
}

/**
 * The `returnToCopyWith(...)` body — exactly what `05-write-copy-attempt-N`
 * receives as `selfCheckSteer`, which `returnToCopyWith` already writes and
 * the copy step already reads. Item L needs no new plumbing to reach the
 * redraft; it needs the right words in the existing channel.
 *
 * The "(no model call spent)" clause matches `07h`'s and `08a2`'s wording,
 * because it is the same claim: this gate runs before every paid check, so a
 * failure costs a render and nothing else.
 */
export function formatInterestFailures(findings: readonly InterestFinding[]): string {
  if (findings.length === 0) return "";
  const slides = [...new Set(findings.map((f) => f.slide))].sort((a, b) => a - b);
  return (
    `the rendered slides failed the visual-interest floor on slide(s) ${slides.join(", ")} (measured on the pixels, no model call spent):\n` +
    interestSteerFor(findings)
  );
}

/**
 * The compact one-line record — the ledger warn's message, the `degraded`
 * reason, and `lastSelfCheckReason` when a floor failure is the last thing
 * that happened. Same `id (slide N): reason` shape as
 * `formatDefaultRenderRuleFailures`, so an operator reading a run trace sees
 * one vocabulary and not two.
 *
 * Joined with ` | ` rather than that function's `; ` for one concrete reason:
 * these sentences carry their own semicolons ("…covered 41% of the plate
 * (0,0 to 1080,590); the ceiling is 22%…"), so a `; ` join would make one
 * finding look like two in the ledger.
 */
export const INTEREST_FINDING_SEPARATOR = " | ";

export function summarizeInterestFindings(findings: readonly InterestFinding[]): string {
  return findings.map((f) => `interest:${f.kind} (slide ${f.slide}): ${f.sentence}`).join(INTEREST_FINDING_SEPARATOR);
}

/**
 * The line a run ships `degraded` with when the floor never cleared, or when
 * the meter is past its hard max and escalation is suppressed.
 *
 * Past the hard max the measurement still runs — it is free — but a redraft
 * is not spent: "budgets adapt, never hold" means finishing on the cheapest
 * complete path with the finding recorded, not refusing to deliver.
 */
export function interestDegradedReason(findings: readonly InterestFinding[], opts: { pastHardMax?: boolean } = {}): string {
  const head = summarizeInterestFindings(findings);
  return opts.pastHardMax === true
    ? `interest floor: ${head} — over the run's hard max, shipped with the finding recorded rather than redrafted`
    : `interest floor: ${head} — shipped with the finding recorded after the last drafting attempt`;
}
