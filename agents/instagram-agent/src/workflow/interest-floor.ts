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

  /*
   * ── RFC-17's five, and why every one of them is OPTIONAL here ──────────
   *
   * `measureSlidePng` emits all five on every measured slide, unconditionally
   * — so on the carousel path they are always present and the `?? 0` defaults
   * below are never taken. The optionality is for the OTHER caller: the
   * Template Studio (`template-studio.ts`) keeps its own narrower structural
   * mirror of these same numbers and hands it to `checkInterestFloor` for a
   * one-slide validation render, and requiring fields that mirror does not
   * declare would make a per-client template's validation depend on a metric
   * the studio never asked for.
   *
   * It is not a weakening, and the probe half below is the reason: a consumer
   * that does not measure mark runs reports no mark runs, and a clause about
   * marks MUST abstain on a document that declares none. Absent and zero mean
   * the same thing here on purpose — "nobody asked for emphasis on this
   * plate" — and both abstain. See `marks-missing`.
   */

  /**
   * Cells that are COVERED, FLAT, off the ground and off the supplied ink
   * token — painted emphasis (RFC-17 §5.6). 0 when the renderer was handed no
   * `foregroundHex`, because without the ink token a display stroke's
   * interior is indistinguishable from a highlighter swatch.
   */
  markedShare?: number | undefined;
  /**
   * Distinct 5-bit colours among those cells, counting bins holding at least
   * 16 cells.
   *
   * **It is not a gate and it must not become one**, and the control that
   * settles the argument is in RFC-17 finding 5: the owner's grey screen with
   * two marks stuck on it scores 2, and a third takes it to 3. A floor of 3
   * would sit one mark above the very defect the floor exists to catch. It
   * feeds `marks-not-visible`, which is a warning.
   */
  markColourCount?: number | undefined;
  /**
   * The ink-weighted centre of mass, as FRACTIONS of the frame. Composition
   * evidence, compared against nothing — see `composition-evidence`.
   */
  contentCentroid?: { x: number; y: number } | undefined;
  /** The bounding box of every ink-carrying cell, in DESIGN px. Zero-area when nothing painted. */
  contentBBox?: { x: number; y: number; w: number; h: number } | undefined;
  /** WCAG ratio between the measured ground and the SUPPLIED `--fg`, in [1,21]. 0 when none was supplied. */
  groundInkContrast?: number | undefined;
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
  /**
   * Elements carrying the `mk` class — the emphasis runs the DOCUMENT ASKED
   * FOR, whether or not anything painted them.
   *
   * **0 is a fact, never a fault.** A client on a Template Studio template
   * with no `*Runs` slot emits no runs and can never be refused by the clause
   * below; that is what makes the clause DOM-anchored rather than
   * copy-anchored, and it is why it can only ever refuse MORE than today.
   *
   * Optional for the same reason the five metrics above are — a consumer with
   * its own narrower probe mirror (the Template Studio) reports no mark runs,
   * and absent is treated exactly like 0: abstain.
   */
  markRuns?: number | undefined;
  /** Of those, the ones a computed style actually paints — a background image, or a transparent colour clipped to the text. */
  markRunsPainted?: number | undefined;
  /**
   * The largest rendered font size on the plate, as a fraction of frame
   * height. See `probePage` for why typography needed an instrument of its
   * own: contrast and imagery were both already measured and type scale was
   * not, so one enormous confident line and the same words at caption size
   * were indistinguishable to every clause in this file.
   *
   * Optional on the same contract as the marks above — a consumer with a
   * narrower probe mirror reports none, and a test about type scale must
   * abstain on a document that never measured it.
   */
  displayTypeScale?: number | undefined;
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
 *
 * ## 2026-09-14, RFC-20: IT DOES NOT MOVE, AND THE COVER IS WHY IT LOOKS LIKE
 *    IT SHOULD
 *
 * With the full-bleed screens deleted (RFC-20 §5.2) the cover fails this
 * clause at `largestEmptyRectShare` **0.2361** against 0.22, and the failing
 * rectangle is NAMED: `{x: 0, y: 236, w: 1080, h: 376}` — a full-width band
 * between the ramp's foot and the lockup's head, inside `.cov-field`. That is
 * a HOLE at a named rectangle, not a threshold that is too tight, and the two
 * independent statements of the same rule agree with each other to within four
 * pixels: the legacy DEAD-SPACE rule says "no empty horizontal band over
 * 380px" and the measurement says 376. **Both disagree with the template.**
 *
 * With a device in `.cov-device` the band closes to 228px and the same plate
 * passes at `largestEmptyRectShare` 0.1583. The remedy is therefore
 * composition, it is free, and it already exists — `interest-relayout.ts`'s
 * `coverRemedy` builds a device from the strongest sourced figure by regex, at
 * $0.00 and no model call. RFC-20 gives the `dead-space` remedy a cover limb
 * so that path is reached from THIS clause and not only from clause E.
 *
 * Moving 0.22 to 0.24 to admit 0.2361 would be exactly the relaxation that
 * produced the defect RFC-20 exists to close: a bar that cannot refuse the
 * thing it was built for. The screen that used to paint over this hole is what
 * took the same plate to 0.0750.
 *
 * That sentence used to end "while contributing 0.22 points of clause E it did
 * not earn", and **that clause was wrong in both halves.** 0.22 is this
 * constant's own cover value, not a clause-E reading — the section was priced
 * with the number it was defending. And the sign is inverted: deleting the
 * screen RAISES `imageryOrDeviceShare` from 14.09% to 17.12%, which `:~900`
 * below states correctly, so the screen's clause-E contribution was about
 * MINUS three points. It was suppressing the ramp's own device share by adding
 * a fourth distinct colour to the ramp's cells and pushing them out of the
 * `graphic` bucket, while simultaneously disarming this clause. One layer,
 * two clauses, both harmed.
 *
 * ## 2026-09-14, eighth pass: MEASURED, THE COVER NOW CLEARS THIS CLAUSE
 *
 * The 0.2361 above is a MEASURED-EDGE reading of an intermediate state. On the
 * tree as it stands, the gate-zero sweep renders the cover 19 times (3 copy
 * lengths x 3 type scales x {en ltr, he rtl}, photoless and deviceless) and
 * `largestEmptyRectShare` comes back at **0.0750-0.1469** — every row under
 * 0.22, worst row 1.50x clear of it. The hole the ramp left is closed by the
 * composition that landed with it. **No ceiling moved to achieve that**, which
 * is the only interesting thing about the number.
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
 *
 * ## 2026-09-14, RFC-20: THE VALUES HOLD AND THE TABLE ABOVE IS STALE
 *
 * **The constants do not move.** What moves is the band table, and re-stating
 * it is a DOCUMENTATION DUTY rather than a re-calibration — a comment and the
 * tree disagreeing about the fact they both describe is the same defect this
 * file caught in `.local/band-sweep.mjs` and it is worth no less here.
 *
 * The row "populated `headline_focus`, two-line headline + body ≈ 0.135" is
 * wrong on the shipped tree by a factor of more than two. MEASURED-HERE
 * through the real `measureSlidePng`, the shipped `headline-focus.html` with
 * its full-bleed 45° screen reports `contentOccupiedShare` **0.3128** — and it
 * reports that on a plate whose ONLY content is the same two-line headline.
 * The cause is cell aliasing rather than coverage, and RFC-20 §3.1 has the
 * arithmetic: `.copy-art`'s hatch paints `--fg` at 22% on a 2px/9px pitch, a
 * stripe pixel sits 47.39 from the ground and the NOMINAL cell mean sits at
 * 10.53 — under `INK_DELTA` — but a 4-design-px cell's footprint along a 45°
 * gradient is 5.66 of a 9-unit period, so the per-cell duty cycle runs from
 * ~0 to ~50% and the high-duty cells cross the ink line on their MEAN. The
 * alpha sweep is the proof, because coverage would be flat and this is not:
 *
 *   hatch @ 10%   COCC 0.0379  (= the type alone)     LER 0.4861
 *   hatch @ 14%   COCC 0.0930                         LER 0.0009
 *   hatch @ 18%   COCC 0.2578                         LER 0.0003
 *   hatch @ 22%   COCC 0.3128   <- shipped            LER 0.0001
 *   hatch @ 30%   COCC 0.4183                         LER 0.0000
 *
 * So clause G is DISARMED on the shipped statement templates: a decorated
 * plate with nothing on it scores 0.3185, five times an interior's floor.
 * **That is a template defect and not a threshold one** — RFC-20's Ground Rule
 * (§5.0) removes every full-bleed ink-carrying layer, after which `COCC ≈
 * occupiedShare` because there is no sub-covered paint left to separate them,
 * and the band becomes the one `OCCUPIED_SHARE_FLOOR` below now carries:
 * populated-with-plinth ≈ **0.2620**, the owner's grey screen ≈ **0.0311**,
 * every slot empty **0.0000**. 0.06 and 0.09 refuse the right side of that
 * band untouched, at 4.4x and 2.9x under the populated end.
 *
 * The rows above are kept rather than deleted for the reason the fourth-pass
 * table is kept beside `IMAGERY_OR_DEVICE_FLOOR`: they are the evidence that
 * this band moves when the grounds move. **The gate-zero sweep
 * (`interest-floor-calibration.test.ts`) publishes `contentOccupiedShare` on
 * every row it renders, and the table that replaces these numbers is its
 * output, not an argument.**
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
 * rule. 0.30 was about a full-width 432px band fully used: the editorial "a
 * third of the plate, plus margins". The audit slide measures ≈0.18.
 *
 * Cover and closer were at 0.42 for the same reason their empty-rect ceiling
 * is tighter — they are the thumbnail and the save moment.
 *
 * Pinned by the calibration test with a required margin of at least 0.08 over
 * every bundled archetype. An archetype that cannot clear its floor with
 * margin is either a wrong constant or a genuinely boring template, and both
 * of those are findings.
 *
 * ── 2026-09-14, RFC-20: THE ONE RE-CALIBRATION OF THAT PHASE, AND IT IS A
 *    RE-CALIBRATION AND NOT A RELAXATION. ──
 *
 * ## Why the old numbers cannot stand
 *
 * They were measured on a tree where a FULL-BLEED DECORATION was counted as
 * occupancy. `occupiedShare` marks a cell when any 4 of its 64 samples are
 * ink, so `headline-focus.html`'s 45° hairline screen marked every cell it
 * crossed, and the plate's occupancy stopped being a fact about the
 * composition at all. MEASURED-HERE through the real `measureSlidePng`, on the
 * shipped screen:
 *
 *   shipped hatch, 3-line headline + body (a GOOD plate)   occ 0.6688  LER 0.0000  → C pass, D pass
 *   shipped hatch, ONE SHORT HEADLINE (the grey screen)    occ 0.6324  LER 0.0000  → C pass, D pass
 *
 * **A properly composed plate and the owner's grey screen are indistinguishable
 * — 0.6688 against 0.6324 — and both PASS.** A floor of 0.30 on that mask is
 * not a strict number, it is a number measuring the wrong thing; the decoration
 * clears it on a plate with nothing on it.
 *
 * RFC-20 §5.0's Ground Rule removes every full-bleed ink-carrying layer, so
 * `occupiedShare` goes back to describing the composition. The SAME two plates
 * on the material ground read occ 0.2620 against 0.0311 and LER 0.3611 against
 * 0.5111 — which is a band. **The old constants were calibrated against a
 * disarmed instrument; these are calibrated against a working one.**
 *
 * ## The band each number comes from — MEASURED-HERE, material ground, peak 11
 *
 * POPULATED
 *   type only, 3-line headline + 4-line body        occ 0.1083  flat 0.9237  LER 0.3889  iod 0.0593
 *   + the content-guarded plinth 888x400            occ 0.2620  flat 0.7529  LER 0.3611  iod 0.2383
 *   + plinth 888x560                                occ 0.3198  flat 0.6802  LER 0.3611  iod 0.3198
 *   + plinth 888x560 + a bounded device             occ 0.3660  flat 0.6340  LER 0.2500  iod 0.3660
 *   ── the gap: 0.2620 down to 0.0311 ──
 * NEGLECTED
 *   the owner's grey screen, one short headline     occ 0.0106  flat 0.9917  LER 0.5259  iod 0.0073
 *   the same + its guard-ON plinth                  occ 0.0311  flat 0.9696  LER 0.5111  iod 0.0297
 *   every copy slot empty (guard G2)                occ 0.0000  flat 1.0000  LER 1.0000  iod 0.0000
 *
 *   interior  0.30 -> 0.12  midpoint of the 0.2620/0.0311 gap is 0.1466, taken
 *                           DOWN to 0.12 to protect short-copy plates, which
 *                           are the populated band's true floor. 2.2x under
 *                           the populated end, 3.9x over the neglected one.
 *   cover     0.42 -> 0.18  MEASURED-EDGE: the cover on its bounded ramp alone
 *                           reaches iod 0.1651-0.1880 and the ramp is 480 of
 *                           1440 design px (33%) before any type. 0.42 was met
 *                           by the DELETED screen, never by the ramp. 0.18
 *                           keeps >= 1.15x over the ramp-only case and still
 *                           refuses a ramp-less cover.
 *   closer    0.42 -> 0.30  MEASURED-EDGE: the closer with every ground layer
 *                           suppressed measures occ 0.4504 — a 1.07x margin
 *                           over 0.42, under the 1.15x gate this phase adopts.
 *                           0.30 restores 1.5x on a plate that clears clause E
 *                           by 28 points.
 *
 * ## ── SUPERSEDED, 2026-09-14 (eighth pass). THE THREE ROWS ABOVE WERE SET
 *    FROM SYNTHETIC PLATES AND TWO OF THEM CITED THE WRONG QUANTITY. ──
 *
 * The rows above are kept because they are the evidence that 0.42/0.30 were
 * calibrated against a disarmed instrument, which remains true. They are NOT
 * the band any constant below is set from, and two of them do not survive
 * contact with a real render:
 *
 *   * The `cover` row quotes `imageryOrDeviceShare` to justify a constant that
 *     gates `occupiedShare`. `iod` cells are a strict SUBSET of occupied cells
 *     (`slide-metrics.ts`: `covered` implies `carriesInk`), so the quoted range
 *     is a lower bound on a quantity nobody had measured. Its "keeps >= 1.15x"
 *     is also false on its own numbers: 0.18/0.1880 = 0.96x, and 0.1651 is
 *     BELOW the floor it is offered as headroom over.
 *   * The `closer` row moves a live gate 1.4x on a single reading of a plate
 *     that PASSED the old floor (0.4504 > 0.42). A thin margin on a passing
 *     plate is a reason to re-sweep, not to loosen.
 *   * The `interior` row's NEGLECTED figure (0.0311) was a hand-painted plate
 *     carrying a small guard-ON plinth. On a real render the same case measures
 *     occ **0.2791**, nine times that — the plinth on a one-line headline at
 *     display size is a 888x400 card, not the sliver the synthetic assumed.
 *
 * ## THE BAND THE CONSTANTS BELOW ARE ACTUALLY SET FROM
 *
 * MEASURED-EDGE, `interest-floor-calibration.test.ts`'s own gate-zero sweep
 * (§5.8.1) driven through the REAL pipeline — `assembleSlidesData` -> real
 * `createRenderCarousel({probe, measure})` -> real `measureSlidePng` — over
 * 8 archetypes x 3 copy lengths x 3 type scales x {en ltr, he rtl}, on
 * documents carrying ALL FOUR production head sheets including the ground
 * material (which that harness was missing until this pass, and whose absence
 * is why no earlier number here describes a document a client receives).
 * 160 rows, 152 POPULATED and 8 NEGLECTED:
 *
 *                    POPULATED occ        NEGLECTED occ     rule-1 midpoint
 *   cover     n=19   0.2690 - 0.3517      0.0006 (empty)    0.1348 -> 0.13
 *   interior  n=114  0.2895 - 0.6364      0.0000 - 0.3004   see below
 *   closer    n=19   0.5722 - 0.6633      0.0000 (empty)    0.2861 -> 0.29
 *
 * **Clause D is a CONJUNCTION and that is what makes the interior row work.**
 * The occupancy limb is only ever reached on a plate that is ALSO over
 * `FLAT_BACKGROUND_CEILING`, so the band that matters is the flat-gated one.
 *
 * ## THE INTERIOR BAND HAS TWO READINGS AND THE DIFFERENCE IS ONE CSS GUARD
 *
 * Measured first with `.hf-plate`'s guard asked of the HEADLINE, which is how
 * the plinth shipped into this branch:
 *
 *   interior, flat > 0.70   POPULATED min 0.3121   NEGLECTED max 0.3004
 *
 * A gap **0.0117 wide**. That is not a band; it is two numbers that happen not
 * to have crossed. The cause is that the plinth painted on a plate carrying
 * nothing but a headline, so the owner's grey screen was wearing a 888x400
 * filled card and reporting occ 0.2791-0.3004 and `iod` 0.2763-0.3152 — **the
 * grey screen was claiming to carry a drawn device.** Defect 1, rebuilt out of
 * the object that was supposed to close it.
 *
 * `headline-focus.html`'s guard now asks for the BODY as well, which is what
 * the plinth's own justification always implied (it converts copy VOLUME into
 * area, and a headline alone is not volume). Re-measured on that tree, real
 * pipeline, both ground variants x three type scales:
 *
 *   the owner's grey screen   occ 0.0285-0.0746  flat 0.9463-0.9790
 *                             LER 0.3611-0.4056  iod 0.0166-0.0412
 *   composed, short copy      occ 0.2928-0.3545  flat 0.6646-0.7163
 *                             LER 0.2222-0.2778  iod 0.2739-0.3199
 *
 *   interior, flat > 0.70   POPULATED min 0.3121   NEGLECTED max 0.0746
 *
 * A gap **0.2375 wide** — twenty times the first reading, and the whole of the
 * difference is one `:has()`. `min(POPULATED) > max(NEGLECTED)`, so §5.6
 * decision rule 1 applies: the constant is the midpoint rounded to 0.01 toward
 * NEGLECTED, (0.3121 + 0.0746) / 2 = 0.1934 -> **0.19**.
 *
 * TWO MEASUREMENTS FEED THAT NEGLECTED FIGURE AND THE HIGHER ONE IS USED, which
 * is worth saying because the sweep prints the lower. The gate-zero sweep
 * renders its neglected controls at the `m` type scale only and its eight rows
 * top out at `occ` **0.0584**; the dedicated grey-screen probe renders both
 * ground variants at s, m and l and tops out at **0.0746** (glyph ground, `l`).
 * 0.0746 is the max over both, so it is what the midpoint is taken from — a
 * NEGLECTED ceiling set from the smaller of two measurements would be a floor
 * set from the more flattering one, which is the move this whole comment
 * exists to refuse. Using the sweep's 0.0584 would give 0.1852 -> 0.19 anyway;
 * the two agree on the answer and only one of them is the conservative route
 * to it.
 *
 *   cover     0.42 -> 0.18  MEASURED-EDGE occupancy, 19 rows: POPULATED
 *                           0.2690-0.3517, NEGLECTED (every slot empty) 0.0006.
 *                           0.42 is ABOVE the populated floor and false-refuses
 *                           all 19 rows, which is why it cannot stand. Rule 1's
 *                           midpoint is 0.13; 0.18 is taken ABOVE it — i.e.
 *                           deliberately stricter than the rule requires — and
 *                           still leaves **1.49x** over the measured populated
 *                           floor (0.2690/0.18) and 300x over the neglected one.
 *   interior  0.30 -> 0.19  Rule 1 on the band above. Margin **1.64x** under
 *                           the populated floor and **2.55x** over the
 *                           neglected ceiling, both clear of the 1.15x gate
 *                           this phase adopts. Measured false-refusals at 0.19
 *                           over all 114 interior POPULATED rows: **zero** —
 *                           and that holds without the flat gate, since the
 *                           lowest interior row of any kind is 0.2895.
 *                           0.30 would also produce no measured false refusal,
 *                           but only at a **1.04x** margin over 0.3121, which
 *                           is the "clears its floor by a hair" case this
 *                           file's own calibration margin exists to refuse.
 *                           **0.19 is the stricter choice, not the looser one:**
 *                           it is the value that still refuses the grey screen
 *                           (0.0285-0.0746) and `boringSlideMetrics` (0.18)
 *                           while leaving a real plate room to be a real plate.
 *   closer    0.42 -> 0.30  MEASURED-EDGE occupancy, 19 rows: POPULATED
 *                           0.5722-0.6633, NEGLECTED (every slot empty) 0.0000.
 *                           Rule 1's midpoint is 0.29; 0.30 is taken above it.
 *                           Margin **1.91x** over the measured populated floor.
 *                           0.42 would also have been safe here (1.36x); 0.30 is
 *                           what the pre-committed rule gives, and the rule was
 *                           written before the sweep ran precisely so this row
 *                           could not be argued either way after the fact.
 *
 * **None of the three is a relaxation and each says which direction it moved
 * against what.** Against `main`: cover and closer come down, interior comes
 * down. Against the BRANCH these numbers replace: interior goes UP, 0.12 ->
 * 0.19, because 0.12 rested on a hand-painted NEGLECTED plate (0.0311) that a
 * real render does not reproduce (0.0746 with the guard fixed, 0.3004 without).
 *
 * **Standing caveat, and it is not a formality.** These rows are MEASURED-EDGE:
 * the system Edge channel, because the bundled Playwright Chromium on the
 * authoring machine is a broken install (a `chrome.dll` with no `chrome.exe`).
 * Edge is Chromium-family and shapes text with the same engine, but it is NOT
 * the binary CI runs. **CI is the authority for every figure above** and the
 * same sweep prints them on every run.
 *
 * ## THESE THREE ARE PROVISIONAL AND CI-GATED, AND THE DECISION RULE IS
 *    WRITTEN HERE BEFORE THE SWEEP RUNS
 *
 * They are set from synthetic plates driven through the real instrument. The
 * gate-zero sweep in `interest-floor-calibration.test.ts` sets the FINAL values
 * from the max over `{en, he}` x 3 copy lengths x 3 type scales x 2 ground
 * variants, on real Chromium. The rule is fixed in advance so the sweep's
 * outcome cannot be argued backwards into a relaxation:
 *
 *   1. If `min(POPULATED) > max(NEGLECTED)`, the constant is the MIDPOINT of
 *      the gap, rounded to 0.01 **toward NEGLECTED**.
 *   2. If `min(POPULATED) <= the floor`, **the first remedy is the TEMPLATE** —
 *      the plinth grows, or the archetype gains its device. The constant does
 *      not move on a first failure.
 *   3. If the bands **OVERLAP**, clause D's occupancy limb cannot separate a
 *      composed plate from a neglected one on typographic plates. It is then
 *      **DEMOTED TO REPORTING-ONLY** for the `headline_focus`/heroless-`slide`
 *      family and clause C carries the refusal — which it does decisively, at
 *      LER 0.5111-0.5259 on the grey screen against a 0.28 interior ceiling.
 *      **A limb that cannot refuse the thing it was built for is REMOVED, not
 *      lowered.**
 *   4. **Under no outcome is a floor lowered to make a specific plate pass.**
 *
 * ## What the move costs, said plainly rather than banked
 *
 * ── SUPERSEDED by the eighth pass. This paragraph described the branch's 0.12
 *    and is kept only so the reversal is legible. ──
 *
 * At 0.12, `boringSlideMetrics` — the 2026-09-08 audit slide as numbers, occ
 * 0.18 — stopped tripping clause D at the interior role, because 0.18 is over
 * 0.12. That loss was recorded rather than hidden, and it was a real loss: the
 * new floor landed exactly on the canonical bad plate's own occupancy.
 *
 * **At the measured 0.19 the loss does not happen.** 0.18 < 0.19, so the audit
 * slide trips clause D again alongside clause C, and `interest-floor.test.ts`
 * pins both. A re-calibration that had cost the suite its canonical refusal
 * would have been the wrong number by that fact alone, and this is the check
 * that says so. The margin is one point and it is stated rather than glossed:
 * what keeps the audit slide refused is clause C at `LER` 0.556 against 0.28,
 * and clause D is the corroborating signature.
 *
 * The `cover` row is the one place a plate can now pass that could not before,
 * and the size of that window is stated rather than left to be discovered:
 * 0.42 -> 0.18 newly admits a cover whose occupancy sits in [0.18, 0.42). Every
 * measured cover row sits at 0.2690-0.3517, i.e. INSIDE that window — which is
 * the point, because at 0.42 all 19 of them were refused. A cover under 0.18 is
 * still refused, and a cover that is empty measures 0.0006.
 */
/**
 * ── NINTH PASS, 2026-09-14. `interior` IS BACK AT 0.30, AND THE REASON IS A
 *    CI RENDER THAT FALSIFIED THE BAND IT WAS SET FROM. ──
 *
 * PROVENANCE, and it is the whole point of this block: everything above is
 * MEASURED-EDGE — the system Edge channel on the authoring machine. Everything
 * here is a CI RENDER on the binary CI actually uses (runs 34800700580 and
 * 34802291959), which is the only authority for a pixel claim on this project.
 * Where they disagree, these numbers win.
 *
 * The 0.19 above was taken from a POPULATED interior band whose minimum was
 * 0.3121. That number was not the type; it was `.hf-plate`, the filled card
 * RFC-20 §5.3 put behind the statement. The card was built to be
 * `covered && distinct <= 3` — which is the literal definition of
 * `graphicShare` — so **a decoration was being counted as the very drawn
 * device whose absence clause E exists to detect.** On CI it measured `iod`
 * 32.0-51.4% on plates carrying no imagery and no device, against the 0.10
 * floor in `IMAGERY_OR_DEVICE_FLOOR`, and `headline_focus` was accepted as a
 * COVER at every type scale on both grounds. It is the hatch's defect one
 * clause over, and it will be re-introduced by the next person who adds a
 * painted panel unless this paragraph is read first.
 *
 * With the card's fill removed and the same 160-row sweep re-run on CI:
 *
 *   role      POPULATED min occ     NEGLECTED max occ    rule branch
 *   cover     0.2670 (n=19)         0.0562 (n=8)         1 — midpoint 0.16
 *   closer    0.5722 (n=19)         0.0562               1 — midpoint 0.31
 *   interior  0.0383 (n=114)        0.0562               NONE — see below
 *
 * The interior minimum is BELOW the neglected ceiling. It is not a panel
 * archetype — `stat-callout`, `quote-card`, `comparison-card` and
 * `list-takeaway` measure 0.31-0.61 — it is `headline_focus` (0.0544-0.1252)
 * and heroless `slide.html` (0.0383-0.0942), at `flat` 0.92-0.97. Composed to
 * the Ground Rule with no paint on them, **those two archetypes measure as
 * neglected plates, because that is what they are**: type on ground and
 * nothing else. The grey screen carrying its maximum mark load sits at 0.0864,
 * inside their composed band.
 *
 * So `interior` has no measured band to be set from, and it returns to 0.30 —
 * the value the tree shipped with — rather than to a number argued backwards
 * out of a card. `headline_focus` and heroless `slide.html` are OUT OF SCOPE
 * for RFC-20 and keep their existing paint unchanged, so no live run pays a
 * false refusal for this. The fix those two need is a real bounded object from
 * their own copy (RFC-20 §5.5's `deviceFromText`, $0.00, no model call), and it
 * is specced as RFC-20 Part 11 rather than built here.
 *
 * `cover` stays at **0.18** and is deliberately NOT relaxed to the derived
 * 0.16: a constant taken above its own decision rule's answer refuses strictly
 * more than the rule requires, so it cannot be a bar moved to make something
 * green. 1.48x over 19 populated rows, 4.75x over the neglected ceiling.
 *
 * ── TENTH PASS: `closer` DOES NOT MOVE EITHER, BECAUSE ITS PLATE LEFT. ──
 *
 * 0.31 was derived from 19 CI rows off a `closer.html` this PR restructured.
 * RFC-20 Part 11 then reverted that file to its shipped state — it holds a
 * 0.2278 (en) / 0.2306 (he) rectangle at `(0,0)`, an unearned hole the deleted
 * screen had been painting over — so the plate the band was measured on is not
 * a plate this PR changes any more. **A constant re-derived from a plate this
 * PR no longer touches has no business moving**, and 0.42 stands until the
 * closer comes back with §11.4's bounded object and a fresh sweep. The band is
 * recorded rather than banked: POPULATED 0.5722-0.6681 over 19 rows, NEGLECTED
 * ceiling 0.0024, rule-1 midpoint 0.28.
 *
 * That also retires the trap noted here in the ninth pass — that 0.31's basis
 * included `#takeaway`'s plinth, the same `covered && distinct <= 3` object as
 * `.hf-plate`. The plinth left with the file, and so did the constant.
 *
 * ── `cover` IS THE ONE CONSTANT THIS PHASE MOVES, AND IT IS DELIBERATELY
 *    STRICTER THAN ITS OWN DERIVATION. ──
 *
 * 0.42 -> **0.18**. CI (34805932618), 19 rendered cover rows, POPULATED
 * `occ` 0.2670-0.3517 against a NEGLECTED ceiling of 0.0024 over six
 * empty-slot controls. **Rule 1's own answer is the midpoint, 0.13. 0.18 is
 * taken above it on purpose: a constant set stricter than the rule that
 * derived it refuses strictly more than the rule requires, so it cannot be a
 * bar moved to make something green — and the visible cost of that choice is
 * 1.48x of headroom instead of 2.05x.** At 0.42 all 19 rendered cover rows
 * were falsely refused, which is what makes this a re-calibration rather than
 * a relaxation.
 */
export const OCCUPIED_SHARE_FLOOR: Readonly<Record<SlideRole, number>> = { cover: 0.18, interior: 0.3, closer: 0.42 };

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
 * `headline_focus` carrying a three-row bars device measures 7.5 / 9.2 / 11.1%
 * at `s` / `m` / `l`, so it straddles the floor: refused at `s` and `m`,
 * admitted at `l`. `band-sweep.mjs` used to count it in the TYPE-ONLY family,
 * so the script printed a ceiling of 9.4% and a margin of 0.6 points while
 * this comment printed 7.7% and 2.3 — the same number arrived at two ways,
 * which is a comment and a tool disagreeing about the fact they are both
 * describing. The script now classifies it as its own `device` family and
 * reports all three bands, so "loudest TYPE-ONLY plate" there and "ceiling"
 * here are the same row. Run it and the two agree line for line.
 *
 * WHY IT IS ITS OWN FAMILY RATHER THAN PART OF THE CEILING: this plate's
 * device slot is FILLED. Clause E asks whether a slide carries imagery or a
 * drawn device, and this one does, so clause E accepting it at a positional
 * role is the clause working rather than failing — it does not belong in a
 * ceiling that exists to describe plates carrying NOTHING but type.
 *
 * ── 2026-09-12, sixth pass: THE BARS ARE FILLED NOW, AND THE BAND MOVED
 *    WITHOUT THE CONSTANT MOVING. ──
 *
 * This paragraph used to read "at 9.4% the bars plate is still 0.6 points
 * UNDER the floor … the fix, when somebody wants it, is in `dv-bars-block` —
 * filled bar tracks rather than outlined ones — not here." Somebody wanted it.
 * `slide-devices.ts` now paints the track and the quiet fill as OPAQUE plates
 * (`color-mix(… var(--bg))`) instead of 8%/22% washes over `transparent`, for
 * a reader's reason rather than a metric's: on `headline_focus`'s dash screen
 * the ground's accent hairlines ran straight through the bars and the quiet
 * fill measured 1.04:1 against its own track, so the three lengths a bar chart
 * exists to compare could not be compared. That file carries the sampled
 * colours and the choice between three candidate mixes.
 *
 * The band followed: 5.3 / 7.1 / 9.3% before, 7.5 / 9.2 / 11.1% after
 * (`.local/band-sweep.mjs`, this tree). The two ceilings either side of the
 * floor did not move at all — 7.9% type-only, 11.9% field — because no
 * type-only plate has a device on it and no field-bearing archetype uses
 * `dv-bars-block`. 0.10 is untouched and is still 2.1 points above the
 * type-only ceiling.
 *
 * WHAT IS STILL OPEN, SAID PLAINLY RATHER THAN BURIED: at `s` and `m` the
 * bars plate is 7.5% and 9.2%, so it is STILL refused at a positional role
 * even though its device slot is filled. The false refusal is narrowed, not
 * closed — one of three scales now passes where none did. It cannot be closed
 * by moving 0.10: raising the floor to admit 7.5% re-admits every type-only
 * plate the floor exists to refuse (the ceiling is 7.9%). Closing it properly
 * means more drawn AREA in the device — a taller track, or bars that fill the
 * measure — which is a typographic decision about the device and not a
 * threshold decision about the floor. No guard in the suite requires this
 * plate to be refused, and the cover sweep renders `headline_focus` with an
 * EMPTY device slot precisely so that what it measures is the ground.
 *
 * AND THE NUMBERS IN THE PARAGRAPH THIS REPLACED WERE MEASURED THROUGH A
 * BROKEN INSTRUMENT. `5.1 / 7.1 / 9.4%` came out of the `.local` probes, whose
 * shared `deviceCss()` helper returned `deviceCssBlock()`'s whole
 * `<style>…</style>` element and whose every caller then wrapped it in a
 * second `<style>`. Inside a style element `<style>` is raw text, so the CSS
 * parser hit a stray token, error-recovered by discarding the qualified rule
 * up to the next `{…}` block, and the rule it ate was the first in the sheet:
 * `.dv { --dv-quiet: … }`. Every non-accent device part — bar fills, rules,
 * timeline dots, versus borders, unit cells — computed to the
 * guaranteed-invalid value and painted TRANSPARENT in every local probe, while
 * production painted them. The helper unwraps now (both copies carry the
 * note). Corrected on the pre-fix templates the band was 5.3 / 7.1 / 9.3%, so
 * the conclusion the old paragraph drew survives its instrument by luck;
 * nothing else in this file's tables touches a device slot.
 *
 * ── THE PARAGRAPH BELOW IS SUPERSEDED IN TWO OF ITS THREE CLAIMS BY THE
 *    RFC-20 PASS. READ THE CORRECTION UNDER IT BEFORE CITING ANY FIGURE. ──
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
 * ## THE CORRECTION, 2026-09-14 (RFC-20, eighth pass)
 *
 * Claim 1, the photoless cover at "18.0-20.8%, now a constant of the
 * template": **the figure moved and the reason it was a constant is gone.**
 * The full-bleed hairline screen that pinned it was deleted (RFC-20 §5.2) and
 * the ramp was re-bounded; the seventh-pass addendum below measures the same
 * plate at `iod` **0.1409 -> 0.1712**, and the gate-zero sweep's 19 cover rows
 * sit in that region. It still clears 0.10. It is no longer "a constant of the
 * template", and nothing downstream may treat it as one.
 *
 * Claim 3, `headline_focus` reporting `no-device` at every type scale on
 * either ground: **FALSE on this tree, and it is a BLOCKING finding rather
 * than a correction.** `headline-focus.html` gained `.hf-plate`, a filled
 * plinth, and a filled card is `covered` with `distinct <= 3`, so it lands in
 * the `graphic` bucket by construction. MEASURED-EDGE over the same six
 * combinations the paragraph above cites: **32.5-41.3%**, against a 0.10
 * floor. Every one of them now reports NOTHING.
 *
 * This is not a number that can be argued down. RFC-20 §5.0's own structural
 * reading of `slide-metrics.ts:866-919` — `covered` implies `carriesInk`, so
 * `imageryOrDeviceShare` is a subset of `occupiedShare` cell for cell — says
 * there is **no amplitude, tint or pitch at which paint is visible to clauses
 * C and D and invisible to clause E**. A plinth that closes an empty rectangle
 * necessarily carries clause E. So `headline_focus` may have a filled plinth
 * OR it may remain `default:cover-carries-device`'s one intentional exception,
 * and it cannot have both.
 *
 * **That is an editorial decision about the archetype's identity, owned by
 * RFC-14/RFC-17, and it is deliberately NOT taken here.** RFC-20 Part 8 item 2
 * committed this phase to no clause-E re-calibration; reversing a shipped
 * product rule (`visual-qa-pre-checks.ts`'s `default:cover-carries-device`) as
 * a side effect of a fill colour is exactly the move that rule exists to stop.
 * `interest-floor-calibration.test.ts`'s two assertions are left asserting the
 * shipped guarantee, and they are RED until the decision is taken. A red guard
 * that states the truth is worth more than a green one that was edited to
 * match the thing it was meant to police.
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
 * `headline_focus + a three-row bars device` used to sit inside the TYPE-ONLY
 * band while carrying a rendered device, because the bars were strokes and
 * washes rather than filled area and the metric correctly declined to score
 * them as one. That is why the constant is stated as a floor on IMAGERY OR
 * DEVICE SHARE and not as "does this slide have a device slot": a device the
 * pixels cannot see is not one. Filling the tracks (sixth pass, above) moved
 * that row from 5.3-9.3% to 7.5-11.1%, which is the anomaly answering to the
 * same physics rather than to a threshold. And `comparison_card` is the
 * quietest field-bearing archetype because its two cards are outlined rather
 * than filled; it is the row that sets this constant's ceiling, so a revision
 * that lightens those cards lowers the ceiling rather than raising the floor.
 * (A revision that FILLS them the way the bars are now filled raises the field
 * floor instead, which widens this gap — the same change, the other direction.)
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
 *
 * ── 2026-09-14, RFC-20, SEVENTH PASS: IT DOES NOT MOVE, AND THE PHASE THAT
 *    BUDGETED FOR MOVING IT SAYS SO. ──
 *
 * RFC-20's brief scoped a clause-E re-calibration as the PRICE of deleting the
 * painted grounds, on the strength of the fifth-pass row above — "cover,
 * colour field, no hero 18.0-20.8%", with the note that the figure "is now a
 * constant of the template". Deleting a template's paint and then keeping a
 * floor that the paint was clearing is exactly the shape of a threshold that
 * has to move. **The measurement says it does not, and the reason is that the
 * paint was never what cleared it.**
 *
 *   MEASURED-HERE, the content-guarded plinth ALONE            iod 0.2383
 *   MEASURED-EDGE, cover.html with the field screen DELETED    iod 0.1409 -> 0.1712
 *   MEASURED-EDGE, closer.html, every ground layer suppressed  iod 0.3863 (28.6 points clear)
 *   MEASURED-EDGE, the four panel archetypes, paint suppressed unchanged to 2 dp
 *                  quote-card 0.4730  stat-callout 0.3459  list-takeaway 0.3358  comparison-card 0.1939
 *
 * The cover row is the one worth reading twice: deleting the hairline screen
 * RAISES `imageryOrDeviceShare` from 14.09% to 17.12%, because the hairlines
 * were adding a fourth distinct colour to the ramp's own cells and pushing
 * them out of the `graphic` bucket (`covered && distinct <= 3`). **The screen
 * was suppressing the ramp's clause-E contribution by ~3 points while
 * disarming clause C.** It cost on both sides and paid on neither.
 *
 * And RFC-17 line 70's claim that the closer's clause-E share IS `.cl-art` is
 * FALSE on this tree: MEASURED-EDGE, `.cl-art` is worth 1.01 points of 38.63
 * (2.6%). It quotes a third-pass number from an intermediate that never
 * shipped. The closer's share is its recap strip, ask band and accent rule —
 * all content-guarded — so the closer costs that phase nothing here either.
 *
 * The honest limit of "take the reference's execution" is recorded rather than
 * accommodated: `rf-11`'s own cover is ten highlighter blocks and a rule,
 * about 6% of the frame, and **this clause at 0.10 would rightly refuse it.**
 * That composition is not adopted, and 0.10 is not lowered to admit it.
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
 *
 * ## 2026-09-14, RFC-20: IT DOES NOT MOVE — THE 0.6132 READING WAS A BUG
 *
 * MEASURED-HERE, the shipped `headline-focus.html` carrying a two-line
 * headline and a body measures `textShare` **0.6132** and trips this clause.
 * Nothing on that plate is a wall of text. `textShare` counts ink cells that
 * are neither imagery nor graphic — glyphs — and the full-bleed 45° hatch
 * marks a cell in every position it crosses at a duty cycle too low to look
 * `covered`, so **the decoration was scored as type**. On the material ground
 * the same plate measures **0.0490**.
 *
 * A false `text-wall` finding costs a $0.181 redraft out of three and sends
 * the writer to cut copy that fits. **A bug fixed in the template, not a
 * threshold moved here** — raising 0.55 to admit 0.6132 would have made the
 * clause unable to see the failure it exists for, on the same plate.
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
export type InterestFailureKind = "render-integrity" | "marks-missing" | "clipped" | "dead-space" | "empty" | "no-device" | "text-wall";

/** Facts a reviewer and `08b` should see, that must never fail an attempt. */
export type InterestWarningKind =
  | "low-occupancy"
  | "accent-out-of-band"
  | "background-not-brand-ground"
  | "low-colour-count"
  | "low-edge-density"
  | "marks-not-visible"
  | "composition-evidence";

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
  /**
   * The mark kinds `markKindsFor` admitted for this slide's effective ground
   * (`assembleSlidesData`'s `markReportOut.kindsBySlide`).
   *
   * Supplied so `marks-not-visible` can tell "the marks did not paint" from
   * "the instrument cannot see this kind of mark" — see
   * `MARK_AREA_PAINTING_KINDS`. Absent leaves the warning's old,
   * unconditional behaviour, which is right for a caller that has no plan to
   * report from.
   */
  markKinds?: readonly string[] | undefined;
}

/**
 * The mark kinds that can paint an area `markedShare` / `markColourCount` are
 * able to measure — which is `block`, the highlighter swatch, and only it.
 *
 * A marked CELL is COVERED (48 of 64 samples off-ground) AND FLAT
 * (`slide-metrics.ts`). `underline` is .07em tall, `double` is .09em + .04em,
 * `swish` is .20em and `ink` fills the glyphs themselves — none can cover 48
 * of 64 samples of a 4px cell, and a glyph fill is not flat. So on any ground
 * darker than its ink, where `markKindsFor` refuses `block` outright, both
 * metrics are STRUCTURALLY 0 on every slide however well the marks painted.
 *
 * Measured on a production-shaped eight-slide carousel on the bundled
 * `#17181C` ground: every slide reported `markedShare 0, markColourCount 0`
 * while the DOM probe reported `markRuns 2, markRunsPainted 2` and the marks
 * were plainly visible in the PNG. The warning below fired on all of them.
 *
 * A warning that always fires is one reviewers learn to ignore, and this
 * project already has the rule for its dual: a guard that cannot fail is a
 * defect. Naming the capable kinds is what makes the warning mean something
 * on a pale kit and stay silent on a dark one. It is NOT a floor and nothing
 * gates on it — `slide-metrics.ts` is right that `markColourCount` must not.
 */
const MARK_AREA_PAINTING_KINDS: ReadonlySet<string> = new Set(["block"]);

/**
 * The share of the frame a plate's type has to reach to be its own subject.
 *
 * PROVISIONAL, and deliberately reported before it gates anything: the sweep
 * prints `displayTypeScale` for every archetype at every type scale, and this
 * number is set from that table rather than from an eye. 0.055 of frame height
 * on a 1440px canvas is ~79px — comfortably above body copy at every shipped
 * `fontScale` and below every display slot — but "comfortably" is a claim the
 * table has to settle, which is why `plateSubject` reports WHICH limb carried
 * a plate.
 */
export const DISPLAY_TYPE_SCALE_FLOOR = 0.055;

/**
 * How far above `IMAGERY_OR_DEVICE_FLOOR` a plate's imagery has to sit before
 * it earns its quiet.
 *
 * 1.0 — the same floor clause E uses, and no higher. A plate carrying enough
 * of a subject to clear clause E is carrying enough of a subject to be allowed
 * an empty corner; inventing a second, stricter number here would be two bars
 * for one question, and the next person to move one would not know to move the
 * other.
 */
export const SUBJECT_IMAGERY_MULTIPLE = 1.0;

/**
 * The canvas every bundled template declares, in design px.
 *
 * A literal rather than a parameter because `largestEmptyRect` is already
 * reported in these units and every template hard-codes
 * `html, body { width: 1080px; height: 1440px }`. `interest-floor.test.ts`
 * asserts that against the template files, so a canvas that ever changes fails
 * here rather than silently re-scaling a geometry test.
 */
export const DESIGN_CANVAS = { w: 1080, h: 1440 } as const;

/**
 * How much of an axis a hole has to cross before it is CUTTING THE PLATE IN
 * TWO rather than sitting at its margin.
 *
 * 0.9, and the two cases it separates are both real plates:
 *
 *   * `@semrush`'s reference cover leaves its whole lower-left quadrant empty —
 *     roughly two thirds of the width and half the height — and the quiet is
 *     what lets its four-node diagram read. That hole touches two edges and
 *     crosses neither axis.
 *   * `closer.html` with a hollow middle puts an eyebrow at the top, a CTA at
 *     the foot and NOTHING between them. Measured on real Chromium at
 *     `largestEmptyRectShare` 0.5556, full width. That hole separates content
 *     from content, and the plate reads as two disconnected pieces.
 *
 * **Same share, opposite meaning, and the difference is position.** The rect
 * has carried its own corners since the clause was written, for the re-layout
 * planner; this is the second reader of them.
 */
export const SPANNING_HOLE_AXIS_SHARE = 0.9;

/**
 * Whether an empty rectangle crosses the frame rather than sitting against it.
 *
 * A hole at a margin is composition. A hole that spans the plate is a gap in
 * the middle of the reading order, whatever else is in frame — which is why
 * this is checked BEFORE `plateSubject` can waive anything.
 */
export function holeSpansFrame(rect: SlideMetrics["largestEmptyRect"], canvas: { w: number; h: number } = DESIGN_CANVAS): boolean {
  return rect.w >= canvas.w * SPANNING_HOLE_AXIS_SHARE || rect.h >= canvas.h * SPANNING_HOLE_AXIS_SHARE;
}

/**
 * What this plate carries, if anything, that earns it a quiet region — or
 * `undefined` when it carries neither.
 *
 * The two limbs are the owner's own words, 2026-09-14: *"interest comes from
 * bold typography, excellent contrast and strong visuals."* Contrast is
 * already gated elsewhere (`TEXT_CONTRAST_FLOOR` at derivation, and
 * `groundInkContrast` reported here), so the two that decide emptiness are
 * VISUALS and TYPE.
 *
 * Returns the reason rather than a boolean, because a waived finding that
 * cannot say which limb waived it is a finding nobody can audit.
 */
export function plateSubject(metrics: SlideMetrics, probe: SlideProbe | undefined): string | undefined {
  if (metrics.imageryOrDeviceShare >= IMAGERY_OR_DEVICE_FLOOR * SUBJECT_IMAGERY_MULTIPLE) {
    return `it carries imagery or a drawn device over ${pct(metrics.imageryOrDeviceShare)} of the frame`;
  }
  // ── THE TYPE LIMB IS WITHDRAWN. IT WAIVED THE PLATE THIS PHASE EXISTS TO
  //    REFUSE, AND THE SWEEP IS WHAT CAUGHT IT. ──
  //
  // It read: *a plate whose type is set at display scale is its own subject*,
  // and `DISPLAY_TYPE_SCALE_FLOOR` shipped PROVISIONAL with its own comment
  // saying the gate-zero table had to settle it rather than an eye. The table
  // settled it, on CI 34960136572, and the answer is no.
  //
  //     headline-focus @ fontScale s   displayTypeScale  0.2715
  //     DISPLAY_TYPE_SCALE_FLOOR                         0.055
  //     the owner's GREY SCREEN                          the same 0.2715
  //
  // **The grey screen is one short headline in a display face.** It reads the
  // same `displayTypeScale` as a fully composed statement plate, because it is
  // the same type at the same size — so the limb waived it, and G1 reported
  // `LER 0.3337` against a 0.28 ceiling with the verdict PASS. A bar that
  // cannot refuse the thing it was built for is worthless, and a waiver that
  // excuses it is worse: it makes the bar look like it works.
  //
  // This is the sixth separator this project has proposed and measured away
  // (`instagram-floor-candidates-falsified` holds the other five), and it
  // fails for the family reason: **a property the good plate and the bad plate
  // share cannot separate them.** The owner's words it was built on —
  // *interest comes from bold typography, excellent contrast and strong
  // visuals* — are about what makes a plate GOOD, and the grey screen has the
  // typography. What it has not got is anything else.
  //
  // So the imagery-or-device limb stands alone, and that is the reading RFC-20
  // §4 recorded from the reference plates in the first place: *the reference
  // execution is an OBJECT on a quiet ground.* `@semrush`'s empty lower-left
  // is earned by a four-node diagram, not by the size of its headline.
  //
  // `DISPLAY_TYPE_SCALE_FLOOR` is kept and still printed by the sweep, because
  // the measurement is worth having and because a constant deleted is a
  // constant somebody re-invents. Nothing reads it as a gate.
  void DISPLAY_TYPE_SCALE_FLOOR;
  void probe;
  return undefined;
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

  // ── A2 — the emphasis stylesheet did not arrive. ──
  //
  // RFC-17 §5.6. The ONE new failing clause this phase adds, and everything
  // about its shape is chosen so it can never refuse a plate that is fine.
  //
  // DOM-ANCHORED, NOT COPY-ANCHORED. It compares what the document ASKED for
  // against what a computed style PAINTS. A template with no `*Runs` slot —
  // every Template Studio template a client authored before this phase, and
  // `stat-callout`/`comparison-card`, which deliberately have none — emits
  // `markRuns === 0` and the clause abstains. A slide whose copy simply
  // carried no emphasis does the same. **This clause can only ever refuse
  // MORE than today; it removes nothing and it exempts nothing.**
  //
  // It does NOT short-circuit the way clause A does, and the difference is
  // real: clause A fires when nothing painted, so every other share is
  // measured against a frame that never rendered and reporting them would be
  // three findings about one defect. Here the plate rendered fully and
  // measured honestly — only its emphasis is missing — so a hole or a wall of
  // text on the same slide is a separate, true fact the writer should get in
  // the same steer.
  //
  // ITS REMEDY IS A RE-RENDER, clause A's posture rather than clause C's. The
  // copy is correct: the writer named the right words and `resolveSlideMarks`
  // found them, or there would be no runs in the DOM to count. What failed is
  // `markCssBlock()` reaching `extraHeadHtml`, and no redraft can fix that.
  // It is also the cheap direction — a re-render is $0 against a $0.171
  // redraft.
  //
  // The PIXEL half of the same question ships as a warning and not as a
  // second limb here: see `marks-not-visible`, and RFC-17 finding 5 for why
  // `markColourCount` cannot gate until CI has published the band.
  const markRuns = probe?.markRuns ?? 0;
  const markRunsPainted = probe?.markRunsPainted ?? 0;
  const markedShare = metrics.markedShare ?? 0;
  const markColourCount = metrics.markColourCount ?? 0;
  if (markRuns > 0 && markRunsPainted === 0) {
    findings.push({
      slide,
      role,
      kind: "marks-missing",
      measured: { markRuns, markRunsPainted, markedShare, markColourCount },
      // Not a share and not a ceiling: the comparison is "none of them", and
      // 0 is the number the clause actually compared against.
      threshold: 0,
      sentence: `${where} — ${markRuns} emphasis run(s) are in the document and none of them painted (markedShare ${pct(markedShare)}, ${markColourCount} mark colour(s)); the mark stylesheet did not reach the page.`,
      steer: `Do not rewrite slide ${slide}: the words to emphasise are correct and they are in the markup. The mark stylesheet did not arrive — re-render it.`,
    });
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
  // ── THE SUBJECT TEST, WHICH GOVERNS CLAUSE C ──
  //
  // The owner, 2026-09-14, after reading a real render: *"the difference
  // between clean design and bad design is not the absence of interest, it is
  // the absence of NOISE. Interest comes from bold typography, excellent
  // contrast and strong visuals -- not from extra layers, random gradients or
  // invented numbers."*
  //
  // Both plates in `docs/instagram-restraint-reference.md` are built exactly
  // that way, and BOTH would fail this clause as it stood. `@semrush`'s entire
  // lower-left quadrant is empty, and it is empty ON PURPOSE: the plate carries
  // a four-node diagram, and the quiet is what lets the diagram read. The
  // owner's grey screen has a hole of the same size and nothing in it.
  //
  // **The difference is not the size of the hole. It is whether the plate
  // carries a SUBJECT.** A plate that carries one is allowed its quiet.
  //
  // WHY THIS IS NOT A LOWERED BAR. A plate with neither imagery nor display
  // type is refused exactly as before -- the grey screen measures `iod` 0.004
  // and has no display slot, so it still fails here and at clause E. What
  // changes is that a plate which EARNED its emptiness stops being told to
  // fill it, and that matters because the remedy for this finding is
  // `planInterestRelayout` attaching a device -- which on a live run
  // fabricated the digit `2` out of the word `B2B`.
  //
  // AND A SUBJECT DOES NOT EXCUSE A HOLE THAT SPANS THE FRAME. Measured on CI
  // 34897578476: `closer.html` with an eyebrow at the top, a CTA at the foot
  // and nothing between them carries a hero image, so it has a subject, and it
  // was WAIVED — a genuinely hollow plate passing because of a picture at the
  // other end of it. `@semrush`'s hole and that one measure almost the same
  // share; one sits in a corner and the other cuts the plate in two. See
  // `holeSpansFrame`.
  const subject = holeSpansFrame(metrics.largestEmptyRect) ? undefined : plateSubject(metrics, probe);
  const rectCeiling = LARGEST_EMPTY_RECT_CEILING[role];
  if (metrics.largestEmptyRectShare > rectCeiling) {
    // WAIVED rather than skipped when the plate carries a subject. The hole
    // is real either way and the reviewer, the judge and the ledger should
    // all still see it with the reason it was allowed -- the same posture
    // clause E's image-downgrade waiver takes. A clause that silently does
    // not run is a clause nobody can audit.
    (subject === undefined
      ? (finding: InterestFinding) => findings.push(finding)
      : (finding: InterestFinding) => waived.push({ ...finding, waivedReason: `waived: slide ${slide} earned its quiet — ${subject}` }))({
      slide,
      role,
      kind: "dead-space",
      measured: {
        largestEmptyRectShare: metrics.largestEmptyRectShare,
        largestEmptyContentRectShare: metrics.largestEmptyContentRectShare,
        occupiedShare: metrics.occupiedShare,
        // ── WHERE the hole is, not only how big it is. ──
        //
        // The sentence has carried the rectangle's corners since this clause
        // was written, because a designer reads them; nothing downstream
        // could. `interest-relayout.ts`'s cover limb needs the EXTENT — a
        // full-width band between `.cov-field`'s head and the lockup is a
        // slot the template already has and a device closes for free, while
        // a hole over the lockup is a different defect with a different
        // remedy — and parsing it back out of an English sentence would be a
        // second, lossy encoding of a number this object already holds.
        //
        // Four scalars rather than the rect object because `measured` is
        // `Record<string, number>`, which is what makes it safe to put on a
        // gate payload and a ledger row. They are named for the
        // `SlideMetrics` field they decompose, so the join stays readable.
        largestEmptyRectX: metrics.largestEmptyRect.x,
        largestEmptyRectY: metrics.largestEmptyRect.y,
        largestEmptyRectW: metrics.largestEmptyRect.w,
        largestEmptyRectH: metrics.largestEmptyRect.h,
      },
      threshold: rectCeiling,
      sentence: `${where} — an empty rectangle covered ${pct(metrics.largestEmptyRectShare)} of the plate (${rectSpan(metrics.largestEmptyRect)}); the ceiling is ${pct(rectCeiling)} for ${roleNoun(role)}.`,
      steer:
        role === "cover"
          ? `A cover carries a photograph, a title card over a graphic ground, or a figure device — a headline on flat ground is not a cover. Give slide ${slide} a real visualNeed, or ${deviceSteer("a device built from the strongest number in this post")}.`
          : `Fill the hole with something the slide already has: ${deviceSteer("a device built from its own figure")}, a second content element, or one more line of body. If neither exists, merge slide ${slide} into ${slide > 1 ? `slide ${slide - 1}` : "the next slide"} and let the carousel be one slide shorter.`,
    });
  }

  // ── D — DEMOTED TO REPORTING-ONLY, 2026-09-14 ──
  //
  // This clause asked whether enough of the frame was COVERED, and the whole
  // of RFC-21 Part 2 is the record of that being the wrong question. Two
  // measurements settle it.
  //
  // **It demands decoration.** RFC-20 §11.3 recorded that seven of eight
  // bundled templates cannot clear this floor without a paint layer covering
  // for them. Demonstrated from the other side on CI 34861097819: quieting one
  // texture from 22% to 8% opacity dropped the identical plate from
  // `occupiedShare` 0.5094 to 0.1300 and turned `slide.html`, Hebrew
  // `closer.html`, the marked-emphasis case and the whole gate-zero sweep red.
  // **The texture WAS the occupancy** — roughly 38 of those 51 points.
  //
  // **And what it demands, it will accept from anywhere.** The remedy for an
  // emptiness finding is `planInterestRelayout` attaching a device, and on run
  // `pubsub-21839432908803804` that remedy fabricated the digit `2` out of the
  // middle of the word `B2B`, labelled it with the claim minus that digit, and
  // sourced it to a real company. A gate that cannot be satisfied honestly
  // will be satisfied dishonestly.
  //
  // RFC-20 §5.6 rule 3 named this outcome in advance — *"clause D's occupancy
  // limb is DEMOTED TO REPORTING-ONLY and clause C carries the refusal"* — as
  // the branch to take if the bands ever overlapped. They do worse than
  // overlap: the metric rewards the defect it was built to catch.
  //
  // THE MEASUREMENT IS KEPT. It still rides every slide, the gate payload and
  // the sweep; it stops being a refusal. What refuses a genuinely neglected
  // plate is clause C (a hole with no subject in frame), clause E (a cover or
  // closer carrying nothing but type) and clause G (nothing to read). The
  // owner's grey screen fails all three, which `interest-floor.test.ts`
  // asserts rather than assumes.
  const occupiedFloor = OCCUPIED_SHARE_FLOOR[role];
  const lowOccupancy = metrics.flatBackgroundShare > FLAT_BACKGROUND_CEILING && metrics.occupiedShare < occupiedFloor;
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
  //
  // ── 2026-09-15: THE DOM LIMB DECIDES, AND THE PIXEL LIMB REPORTS. ──
  //
  // This clause had two limbs and they asked the same question twice, once
  // off the pixels (`contentOccupiedShare`) and once off the document
  // (`probe.textBoxShare`). Three measurements say the DOM limb is the one
  // that should carry the refusal, and none of them is a preference.
  //
  // **1. The pixel limb is not colour-agnostic, and the owner required that
  // it be.** His instruction, 2026-09-14: *"every company has completely
  // different brand colours — make sure the metrics are agnostic to colour
  // and rest on the absence of elements, structure and contrast rather than
  // on thresholds fitted to one palette."* Measured on PR #124 across four
  // brand palettes from 4.54:1 to 17.4:1: on a QUIET plate
  // `contentOccupiedShare` spreads **0.032** with the brand and nothing else
  // changed. The floor it is compared against is **0.06**. A threshold whose
  // palette spread is half its own value is not a threshold; it is a coin
  // weighted by the client's brand book. Every mask in `slide-metrics.ts` is
  // cut at an ABSOLUTE distance, and on a plate whose ink is glyph
  // antialiasing the length of that ramp IS the ground-to-ink distance.
  //
  // **2. The pixel limb was measuring the decoration.** `.copy-art`'s hatch
  // at 22% took a plate whose only content was a two-line headline to
  // `contentOccupiedShare` 0.3128; the same plate at 10% reads 0.0379, which
  // is the type alone. The whole alpha sweep is in
  // `CONTENT_OCCUPIED_SHARE_FLOOR`'s own comment. RFC-20 §11.1 states the
  // class: *any full-frame painted layer that a plate has not earned will be
  // scored by some clause as the evidence that clause was built to look for.*
  // This is that sentence about this clause. **The hatch is deleted now
  // (§11.4), so the number this limb reads has lost the thing that was
  // holding it up** — and the honest response to that is to stop gating on
  // it, not to re-fit it to the plate that is left.
  //
  // **3. The DOM limb separates far better.** `textBoxShare` is the summed
  // area of the text-bearing leaf boxes: a populated slide's copy lockup
  // alone measures 0.1-0.4 and a render whose copy never arrived measures 0,
  // because every template hides its empty slots. That is a 10-40x band
  // against `PROBE_TEXT_BOX_SHARE_FLOOR`, where the pixel limb's own debt row
  // sat at 0.0414 against 0.06 — inside its palette spread.
  //
  // WHAT THIS COSTS, STATED RATHER THAN GLOSSED. `PROBE_TEXT_BOX_SHARE_FLOOR`
  // was calibrated as ONE OF TWO limbs and deliberately biased toward false
  // PASSES (its own comment says so). Carrying the refusal alone, it is a
  // weaker clause than the pair was, and **that constant is not raised here
  // to compensate** — RFC-20 §5.6 rule 4 forbids moving a floor to suit a
  // plate, and it forbids it in this direction too. What ships instead is the
  // measurement that would let it move honestly: the gate-zero sweep now
  // prints `textBoxShare` on every row and summarises its band per role, so
  // the next pass sets this floor from a table rather than from an argument.
  //
  // THE PIXEL LIMB IS KEPT AS A FALLBACK, not deleted, for the one case the
  // DOM cannot answer: a caller with no probe. `checkInterestFloor` takes
  // `probe` as optional and several call sites pass none, and a clause that
  // silently stops running for them would be worse than a palette-dependent
  // one. On that path the finding says which limb spoke.
  const contentFloor = CONTENT_OCCUPIED_SHARE_FLOOR[role];
  const typeShare = probe?.textBoxShare;
  const noType = typeShare !== undefined && typeShare < PROBE_TEXT_BOX_SHARE_FLOOR;
  const noContentPixels = typeShare === undefined && metrics.contentOccupiedShare < contentFloor;
  if (noType || noContentPixels) {
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
        : `${where} — measured on the PIXELS because this render carried no DOM probe: only ${pct(metrics.contentOccupiedShare)} of the frame carries anything to read ` +
          `(floor ${pct(contentFloor)} for ${roleNoun(role)}), against ${pct(metrics.occupiedShare)} of the frame carrying a mark of any kind, and the largest region with no content in it covers ${pct(metrics.largestEmptyContentRectShare)}. ` +
          `This limb is palette-dependent (spread 0.032 across brand palettes) and runs only when the probe is absent.`,
      steer:
        `Slide ${slide} is a decorated empty plate: its ground treatment is painting and its content is not. ` +
        `Check that the headline and body actually reached it, then give it something a reader can take away — ${deviceSteer("a device built from its own figure")}, a second content element — or merge it into ${slide > 1 ? `slide ${slide - 1}` : "the next slide"}.`,
    });
  }

  return { slide, role, ok: findings.length === 0, findings, waived, warnings: interestWarningsFor(metrics, role, slide, probe, opts.markKinds), metrics };
}

/**
 * The facts that ride along and never fail an attempt.
 *
 * Separated from the clause list rather than mixed into it, so "this can hold
 * a run" is answerable by reading which function a threshold appears in.
 */
export function interestWarningsFor(
  metrics: SlideMetrics,
  role: SlideRole,
  slide: number,
  probe?: SlideProbe | undefined,
  /** RFC-17 — this slide's admitted mark kinds. See `InterestFloorOptions.markKinds` and `MARK_AREA_PAINTING_KINDS`. */
  markKinds?: readonly string[] | undefined,
): InterestWarning[] {
  const warnings: InterestWarning[] = [];
  // ── The demoted occupancy measurement (clause D until 2026-09-14). ──
  //
  // FIRST in this list on purpose: it is the number a reader of an old gate
  // payload will go looking for, and finding it reported rather than missing
  // is the difference between "the metric was deleted" and "the metric stopped
  // refusing". See the clause-D block in `checkInterestFloor` for why.
  const occupiedFloor = OCCUPIED_SHARE_FLOOR[role];
  if (metrics.flatBackgroundShare > FLAT_BACKGROUND_CEILING && metrics.occupiedShare < occupiedFloor) {
    warnings.push({
      slide,
      role,
      kind: "low-occupancy",
      measured: { flatBackgroundShare: metrics.flatBackgroundShare, occupiedShare: metrics.occupiedShare, formerFloor: occupiedFloor },
      sentence:
        `slide ${slide} — ${pct(metrics.flatBackgroundShare)} of the pixels were the background colour and only ${pct(metrics.occupiedShare)} of the frame was occupied ` +
        `(the floor this used to fail at was ${pct(occupiedFloor)} for ${roleNoun(role)}); reported since 2026-09-14, gates nothing.`,
    });
  }
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
  // ── The PIXEL half of the emphasis question, and it is a warning. ──
  //
  // The clause above proves the stylesheet ARRIVED (a computed style paints).
  // This proves the marks are VISIBLE (they left a colour in the frame the
  // ground and the ink do not account for), and the two are provably
  // different instruments: set every ring colour to the ground hex and the
  // computed styles still paint — `markRunsPainted === markRuns`, the clause
  // abstains — while nothing lands more than `INK_DELTA` off the ground and
  // this warning fires.
  //
  // It cannot be promoted to a second limb of the clause until CI has
  // published the per-kind/per-scale band, and RFC-17 finding 5 records the
  // control that says why: a grey screen with two marks stuck on it scores 2
  // on `markColourCount`, so any floor that admits a real plate also admits
  // that one.
  const markRuns = probe?.markRuns ?? 0;
  const markRunsPainted = probe?.markRunsPainted ?? 0;
  const markedShare = metrics.markedShare ?? 0;
  const markColourCount = metrics.markColourCount ?? 0;
  // ABSTAIN WHEN THE INSTRUMENT COULD NOT HAVE SEEN THEM. A slide whose kind
  // set holds nothing that paints an area reports `markColourCount === 0` by
  // arithmetic, not by failure, and saying "the marks may be the ground, the
  // ink, or too small to read" about a correctly painted cyan underline is a
  // false sentence printed on every slide of every dark-kit run. With no kind
  // set supplied nothing is known, so nothing is assumed and the warning
  // keeps its old reach.
  const instrumentCanSeeMarks = markKinds === undefined || markKinds.some((k) => MARK_AREA_PAINTING_KINDS.has(k));
  if (markRuns > 0 && markColourCount === 0 && instrumentCanSeeMarks) {
    warnings.push({
      slide,
      role,
      kind: "marks-not-visible",
      measured: { markRuns, markRunsPainted, markedShare, markColourCount },
      sentence:
        `slide ${slide} — ${markRuns} emphasis run(s) are in the document and ${markRunsPainted} of them paint, ` +
        `but no mark colour holds a measurable area of the frame (markedShare ${pct(markedShare)}); the marks may be the ground, the ink, or too small to read at feed size.`,
    });
  }
  // ── Composition evidence: five numbers, compared against NOTHING. ──
  //
  // RFC-17 §3.3. Emitted on every MEASURED slide — every plate the carousel
  // path put through `measureSlidePng`, which emits all five on every slide
  // unconditionally, so on that path this row is always present. That is what
  // the band needs: the passing plates in it as much as the failing ones. A
  // warning cannot admit a grey screen, which is the property that made
  // shipping these free.
  //
  // IT ABSTAINS WHEN NOTHING WAS MEASURED, and that is not a softening — it
  // is the only way the row means anything. A consumer with its own narrower
  // metrics mirror (`template-studio.ts`, which validates a per-client
  // template from a structural summary rather than a decoded PNG) supplies
  // none of the five, and the `??` defaults below would then print
  // `centroid 0.500,0.500, content box 0x0, ground/ink contrast 0.00:1` — five
  // defaults dressed as measurements, which is exactly the failure
  // `groundHex`'s own comment names elsewhere in this system: an anchor that
  // matches no document turns a share into a fact about nothing. A band
  // assembled from those rows would be poisoned by synthetic zeros from a
  // caller that never measured a pixel.
  //
  // It is also the same posture the two mark instruments above already take,
  // for the same reason: absent is treated as "nobody asked", and a warning
  // about a measurement abstains on a consumer that did not take it.
  //
  // What they are for is stated in §3.4 so a later phase cannot move the
  // goalposts: collect this across eight archetypes x three type scales x
  // LTR/RTL on real Chromium PNGs for one release, and only then argue about
  // whether "empty with one perfect line" is separable from "empty because
  // nothing was said". Two candidates were tested against controls and both
  // failed — `imageryOrDeviceShare / contentOccupiedShare` scored the owner's
  // decorated grey screen BETTER than both good reference plates, and a
  // content-span ratio read 1.00 on every real reference plate. Until a third
  // survives its controls, **no threshold in this file moves.**
  //
  // `probe.elementCount` rides along because it is the "few elements placed
  // with intent" half, it has been measured on every slide since 1.1.0, and
  // until now it was read by nobody.
  const centroid = metrics.contentCentroid ?? { x: 0.5, y: 0.5 };
  const bbox = metrics.contentBBox ?? { x: 0, y: 0, w: 0, h: 0 };
  const groundInkContrast = metrics.groundInkContrast ?? 0;
  // ANY of the five is enough: a consumer that measured composition at all
  // gets a row, with the defaults standing in for whatever it did not send.
  // A consumer that measured none of it gets no row.
  const compositionMeasured =
    metrics.contentCentroid !== undefined ||
    metrics.contentBBox !== undefined ||
    metrics.groundInkContrast !== undefined ||
    metrics.markedShare !== undefined ||
    metrics.markColourCount !== undefined;
  if (compositionMeasured) warnings.push({
    slide,
    role,
    kind: "composition-evidence",
    measured: {
      centroidX: centroid.x,
      centroidY: centroid.y,
      contentBBoxX: bbox.x,
      contentBBoxY: bbox.y,
      contentBBoxW: bbox.w,
      contentBBoxH: bbox.h,
      groundInkContrast,
      markedShare,
      markColourCount,
      ...(probe !== undefined ? { elementCount: probe.elementCount, markRuns, markRunsPainted } : {}),
    },
    sentence:
      `slide ${slide} — composition evidence (gates nothing): centroid ${centroid.x.toFixed(3)},${centroid.y.toFixed(3)}, ` +
      `content box ${bbox.w}x${bbox.h} at ${bbox.x},${bbox.y}, ` +
      `ground/ink contrast ${groundInkContrast.toFixed(2)}:1, ${markColourCount} mark colour(s) over ${pct(markedShare)} of the frame` +
      `${probe !== undefined ? `, ${probe.elementCount} elements` : ""}.`,
  });
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
  opts: {
    downgradedForImages?: ReadonlySet<number> | undefined;
    archetypeBySlide?: ReadonlyMap<number, string> | undefined;
    /** RFC-17 — `assembleSlidesData`'s `markReportOut.kindsBySlide`. See `InterestFloorOptions.markKinds`. */
    markKindsBySlide?: ReadonlyMap<number, readonly string[]> | undefined;
  } = {},
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
    const markKinds = opts.markKindsBySlide?.get(slide.n);
    perSlide.push(
      checkInterestFloor(slide.metrics, slide.probe, role, {
        slide: slide.n,
        ...(opts.downgradedForImages !== undefined ? { downgradedForImages: opts.downgradedForImages } : {}),
        ...(archetype !== undefined ? { archetype } : {}),
        ...(markKinds !== undefined ? { markKinds } : {}),
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
