# RFC-20 - Instagram agent: a ground that reads as ground, and a ring that admits what its instrument can see (Phase 7)

Status: specced. Follows RFC-13 (Phase 0/1), RFC-14 (Phase 2/3), RFC-15 (Phase 4), RFC-16, RFC-17 (Phase 5),
RFC-18 and RFC-19, all merged to main and deployed to prep.
Amends RFC-14 item L (the painted grounds), RFC-17 finding 1 (the closer's clause-E share) and RFC-17 §5.2
(the mark ring). Worktree `C:\Users\1\Documents\KarosLabs\agent-engine-igdesign`, branch
`feat/instagram-floor-and-ring`, cut from `origin/main` @ 5f15bdf. Files are CRLF.

This phase exists because Phase 6 measured two defects it deliberately recorded rather than fixed, and said
each deserved its own phase. This is that phase. Two architects specced it independently — one by changing the
GROUND, one by changing the INSTRUMENT. This document is the adjudication and the resulting design.

---

# Part 1 - Brief

## The complaint this phase still serves

The owner's original words, unchanged since RFC-14 quoted them:

> *"צריך ליצור טמפלייטים אבל יש גם טמפלייטים משעממים, למשל בKAROS LABS אתה רואה מסך אפור ברובו, אלה פוסטים
> שאנשים לא ירצו. בנוסף בגלל שזה חזרתי זה נראה AI."*

**A mostly-grey slide is a defect nobody saves.** Phase 2 built a pixel interest floor to refuse exactly that.

**It does not refuse it.** Not on a decorated plate, which is every plate we ship. That is defect 1.

## THE TOPIC RULE, WHICH OVERRIDES EVERY OTHER RULE IN THIS DOCUMENT

**Reference EXECUTION transfers. Reference SUBJECT MATTER never does.**

This phase takes three things from the reference pixels: a paper ground quiet enough to read as ground, emphasis
that is allowed to be a saturated highlighter, and one bounded object carrying the device floor. It takes no
topic. Every reference account in the survey posts about AI, design or marketing; a client that does neither
inherits a paper stock and a highlighter, never a subject. **A beautiful post about something the client does
not do is the original audit failure repeating with better art.** Nothing in this phase touches topic
selection, angle selection or the research query, and no prompt string changes — which is also why it costs
$0.00 (Part 6).

## Binding owner decisions, carried forward

- **Run cost: target $1.00, hard max $1.50. NO OPUS IN A RUN.** `copyAttempt` is 0.181 and a cold Hebrew plan
  lands at $0.9983 against the $1.00 target. **0.182 is a cliff that costs a drafting attempt.**
- **Budgets adapt, never hold.** Every failure in this phase degrades to plain type or to a reported finding.
  None of them can hold a run.
- **NEVER WEAKEN A THRESHOLD TO MAKE SOMETHING PASS.** A bar that cannot refuse the thing it was built for is
  worthless. Any change to a constant is a RE-CALIBRATION with a measured band behind it, stated as such.
- Harvesting is ScrappyCoco only. No Apify, no new vendor. Engine-native throughout.
- **Hebrew is first-class.** Everything holds in RTL and in the Phase 0 script fonts, and Phase 4's bidi
  isolation must not regress.

---

# Part 2 - Provenance: what is MEASURED here, and by whom

**Chromium renders performed for this document: ZERO.** Chromium-gated tests self-skip on this machine; no
attempt was made to install it. Every figure below is labelled:

- **MEASURED-HERE** — hand-painted PNGs at the production 1080×1440 design canvas / 2160×2880 device canvas,
  run through the real shipped `packages/tools/karos-publish/dist/slide-metrics.js` → `measureSlidePng`. This is
  the same method `slide-metrics.test.ts` uses for its own fixtures and the same method `floor-today` used.
  Probes: `scratchpad/copyart-probe.mjs`, `scratchpad/decide.mjs`, `scratchpad/plinth.mjs`, `scratchpad/ring.mjs`.
- **MEASURED-EDGE** — inherited from the `clause-e-dependency` measurer, who drove the real production path
  (`assembleSlidesData` → real `createRenderCarousel({probe,measure})`) through the system Edge channel.
- **INHERITED** — from a previous phase's doc comment or report, not re-verified.

`git status --porcelain` on the worktree was unchanged throughout; every probe lives in the scratchpad.
**Cost of all measurement in this document: $0.00.** No model call.

**Standing caveat: CI is the only authority for a pixel claim.** Every number here must be re-read in CI, and
every guard is reported PASSED or SKIPPED separately, never merged into one green.

## ⚠ Part 2 addendum, 2026-09-14 — the sweeps were run, and the instrument had a hole in it

"Chromium renders performed for this document: ZERO" was true when it was written and is no longer. §5.8's own
note records that `chromium.launch({ channel: "msedge" })` works on this machine; that was taken up, and the
gate-zero sweep (§5.8.1) and G1/G2/G5 were run **as a local pre-flight** by redirecting the renderer's launch onto
the system Edge channel from a scratch config. Nothing in the tree was changed to do it and no such config is
committed. Every figure added in this pass is therefore **MEASURED-EDGE**, and Edge is not the binary CI runs.

It found something no arithmetic could have. `interest-floor-calibration.test.ts`'s `materialize()` spliced
`deviceCssBlock()`, the script-font sheet and `markCssBlock()` — **three of the four sheets production emits.** It
omitted `groundMaterialCssBlock`, which `headExtras()` puts on every rendered document unconditionally. The
harness's own docstring asserted the invariant it was violating ("a calibration that left it out would be
measuring a document no client receives"), and §5.6 nominates this file as the authority that sets three live
gates. **The authority was measuring a bare plate.** That is fixed in this pass, with an A/B case that renders the
same archetype with and without the sheet and pins all six shares equal, so the claim that the material is inert is
now checked on a real render rather than on a hand-painted one.

Running the suite that way also turned **13 of 22 calibration cases red**, which is what the rest of these
corrections are about. Cost of all measurement in this pass: **$0.00**. No model call.

---

# Part 3 - Adjudication: the ground, not the instrument

Two specs. **Spec A** deletes the full-bleed painted screens and replaces them with a sub-ink material ground,
re-arming the existing clauses. **Spec B** leaves the screens and teaches `slide-metrics.ts` a new
`TREATMENT_AMPLITUDE_RATIO` discriminator, adding a second limb to clause C on a refined content mask.

## 3.1 First: a mechanism both specs got wrong, and it matters

Both specs report `contentOccupiedShare ≈ 30` on a shipped `headline_focus`. Neither explains it, and the
template's own comment says the opposite should happen: *"A decorative texture clears `carriesInk` in every cell
it covers and moves none of their means, so it fills `empty` while leaving `emptyOfContent` untouched."*

The arithmetic agrees with the comment. `.copy-art`'s hatch paints `--fg` at 22% on a 2px/9px pitch. A stripe
pixel sits 47.39 from the ground — ink. But the *cell* mean sits at **10.53**, under `tol.ink = 18`, so
`nonGroundMean` is false and the cell is not content. MEASURED-HERE, the arithmetic:

| hatch alpha | stripe pixel distance | cell mean distance | `tol.ink` |
|---|---|---|---|
| 14% | 30.16 | 6.70 | 18 |
| 22% (shipped) | 47.39 | **10.53** | 18 |
| 30% | 64.62 | 14.36 | 18 |
| 55% | 118.47 | 26.33 | 18 |

And yet MEASURED-HERE, the same plate through the real instrument reports `contentOccupiedShare` **0.3128**.

**The resolution is aliasing, and it is a third defect neither spec names.** A measurement cell is 4 design px;
at 45° its footprint along the gradient axis is 5.66 units of a 9-unit period. Per-cell duty cycle therefore
varies from ~0 to ~50% rather than sitting at the nominal 22%, and the high-duty cells cross `tol.ink` on their
mean while the low-duty cells do not. The proof is the alpha sweep — if `covered` drove this it would be flat,
because a stripe pixel is ink at every alpha in the table:

```
hatch @ 10%   COCC=0.0379   (= the type alone)      LECR=0.4861
hatch @ 14%   COCC=0.0930                           LECR=0.0009
hatch @ 18%   COCC=0.2578                           LECR=0.0003
hatch @ 22%   COCC=0.3128   <- shipped              LECR=0.0001
hatch @ 30%   COCC=0.4183                           LECR=0.0000
```

COCC rises monotonically with alpha, so the driver is `nonGroundMean` on a **varying** duty cycle. This is the
same phase-fragility `floor-today` found independently on `occupiedShare` (0.4217 at one decoration phase,
0.3163 at the next, on identical `inkShare`).

**Why this decides Part 3:** Spec B's discriminator reads the mean of a cell's *ink* pixels, which recovers the
CSS alpha (0.22) regardless of duty, and thresholds it at 0.375. That works — MEASURED-HERE, B's refinement takes
the shipped plate from COCC 0.3489 → 0.0828 and restores LECR 0.0001 → 0.2778, and both of B's controls hold (a
12%-of-`--fg` COVERED fill stays content at 0.0941 → 0.0941; a 55% source line stays content at 0.0454 → 0.0454).
**Spec B's instrument change is sound and I am not rejecting it because it fails.** I am rejecting it for the
four reasons below.

## 3.2 Ruling: Spec A is the spine

**1. Spec B leaves two shipped metrics dead forever.** MEASURED-HERE, on the shipped plate with B's refinement
applied, `largestEmptyRectShare` is still **0.0000** and `occupiedShare` is still **0.6641**. B adds a parallel
limb on a parallel mask and leaves the originals as corpses that every future clause inherits. B's own §4 proves
it cannot ever fix clause D. Under Spec A the same plate reads `LER` **0.4861** and `occ` **0.0426** — the
original instruments are alive and clauses C, D and G are re-armed by one change.

**2. Spec B's threshold is calibrated against the templates being fixed.** B sets 0.375 as the midpoint of a
valley between 0.35 (our loudest bundled ground — `slide.html`'s dot screen, raised to 30% in the fifth pass
*because it had become invisible*) and 0.40 (the quietest real type). B says so: *"narrower than I would like …
because one template's ground is loud."* A per-client Template Studio template that paints at 40% is silently
reclassified as content and the defect returns with no signature. **A discriminator whose lower wall is set by
the artefact it is discriminating against is circular**, and Template Studio is exactly the surface B claims as
its advantage.

**3. Spec B costs a MAJOR version bump on a shared package.** `TOOL_VERSION` 1.4.0 → 2.0.0, because two published
fields return different values for the same PNG. Spec A touches no file in `packages/tools/karos-publish` and
bumps no tool version.

**4. Spec B does not change what the client sees.** The owner's complaint was visual. Under B the plate still
renders a 22% hatch over everything and still looks like a grey screen; we have only taught the instrument to
ignore it. Under A the plate changes, toward the reference execution.

**Grafted from B onto A, because B is right about these:**

- B's measurement that `occupiedShare` **cannot** separate short-copy populated plates from neglected ones on
  type alone (6.74 vs 6.69). That is the honest constraint that makes the plinth load-bearing rather than
  decorative, and it forces the one recalibration in Part 5 that Spec A refused to guess.
- B's sequencing discipline: the templates are fixed in the **same PR** as the re-armed floor, because a false
  refusal costs a $0.181 drafting attempt out of three.
- B's emission-point assertion and `MarkDrop` in `resolveSlideMarks` (belt and braces over A's admission-time
  bound), and B's two-sided pin as the ring's sharpest falsification.
- B's insistence that `he` rows are mandatory in every sweep and that a ceiling is set from the max over both
  languages.

**Where they disagree, decided in one line each:**

| Disagreement | Decision | Why |
|---|---|---|
| Change the ground or the instrument | **Ground** | B leaves `LER` at 0.0000 and `occ` at 0.66 permanently; A restores both, MEASURED-HERE. |
| `TOOL_VERSION` 2.0.0 | **No bump** | A does not edit `slide-metrics.ts`; nothing's behaviour changes. |
| Clause E re-calibration | **Does not move** | The plinth measures `iod` **0.2383** against a 0.10 floor, MEASURED-HERE. |
| `OCCUPIED_SHARE_FLOOR` | **It moves — this is the phase's one recalibration** | A refused to guess; B proved no floor works on type alone. The plinth makes a floor work, and Part 5 has the band. |
| `markKindsFor` union vs per-member | **Per-member `kindsByIndex`** | The pairing is what must be legible, so it is checked where the pairing is made. |
| Promote the five composition metrics | **No** | Both specs agree; deliberate emptiness stays refused. |

---

# Part 4 - What the reference pixels actually do

Read, not reasoned from a description. `rf-11-terms/slide-01`, `rf-05-ailook/slide-01`, `rf-08-packaging/slide-01`.

1. **rf-11 and rf-05 share one ground: a light paper with a fine tooth and a soft cloudiness, and it
   contributes nothing.** It is not a pattern; there is no visible repeat. Under our instrument it measures zero
   everywhere. That is what "sub-ink material" means, and it is why those plates' *composition* is legible as
   composition rather than as wallpaper.
2. **Clause E is carried by exactly one bounded object.** rf-05 S1: the stitched photograph, and nothing else.
   The bare paper below-left is large and unapologetic — **clause C would rightly refuse that plate if the
   photograph were removed.** That is the floor working.
3. **rf-11 S1 has no object at all** — ten highlighter blocks and a rule, ≈6% of the frame. **Our clause E at
   10% would refuse rf-11's own cover.** We do not adopt that composition and we do not move clause E to
   accommodate it; it is recorded as the honest limit of "take their execution."
4. **The highlighters are saturated and there are ten of them in four colours on one plate.** That is the exact
   treatment our ring refuses today (Part 6).

---

# Part 5 - The design

## 5.0 THE GROUND RULE

> Every painted layer in a bundled template is exactly one of:
>
> **(a) MATERIAL** — bounded in amplitude below `FLAT_TOL`, contributing **zero** to `inkShare`,
> `occupiedShare`, `contentOccupiedShare`, `imageryOrDeviceShare` and `textShare`, and removing **nothing** from
> the empty-rectangle mask. It may be full-bleed precisely because it is invisible to the instrument.
>
> **(b) AN OBJECT** — bounded in extent, its extent a function of the **content** and never of the leftover
> space, and switched off by a `body:has(…)` guard when that content is absent.
>
> **Nothing in between. No full-bleed layer may carry ink.**

The structural fact behind it, read out of `slide-metrics.ts:866-919` rather than measured: `covered` (48/64)
implies `carriesInk` (4/64), so `imageryOrDeviceShare ⊆ contentOccupiedShare ⊆ occupiedShare`, cell for cell.
**There is no amplitude, pitch, tint or grain at which paint is visible to clause E and invisible to clauses C
and D.** The only free variable is *where* the paint is. The rule is spatial because the conflict is spatial.

It is testable, not aspirational: render each archetype with every copy slot empty; a template that paints
anything unconditionally measures occupied and fails. That is guard G2.

## 5.1 The material ground

New module **`agents/instagram-agent/src/workflow/ground-material.ts`**, exporting
`groundMaterialCssBlock(tokens, seedKey)`, spliced through the existing `extraHeadHtml` channel alongside
`deviceCssBlock()` and `markCssBlock()`. Not per-template CSS: every bundled template carries `<div
class="ground">`, so the studio and custom-archetype paths get the material for free.

**The primitive.** A tiled SVG `feTurbulence` as a `data:image/svg+xml` background-image; `stitchTiles="stitch"`,
tile 256 design px, `type="fractalNoise"`, `numOctaves="3"`. Turbulence rather than Gaussian noise is a
correctness requirement: `feTurbulence` is bounded in [0,1] by construction, so an alpha-scaled tint is
hard-clamped and the peak deviation is a number we set. A Gaussian has an unbounded tail — the grain sweep
(MEASURED-EDGE) showed σ=4 taking `largestEmptyRectShare` from 100.00 to 41.11 while contributing 0.00 to
everything else, which is the worst possible failure: it disarms clause C and pays for nothing.

**The amplitude is computed, never chosen.** `color-mix`/`rgba` compositing in gamma-encoded sRGB is a
channel-wise lerp, so `markColourDistance(painted, ground) = alpha · markColourDistance(tint, ground)` exactly.
Therefore `alpha(T) = MATERIAL_PEAK_DELTA / markColourDistance(T, groundHex)` — ≈**5.1%** ink-on-ground for the
bundled dark kit (`#17181C`/`#F4F2EC`, distance 215.4) and ≈**5.0%** for a paper kit (`#F0EAE6`/`#12100E`,
distance 218.2). That is the amplitude real paper tooth sits at, and it falls out of the kit.

A useful identity, pinned by a test: for an achromatic deviation `d` on all three channels,
`sqrt(2d²+4d²+3d²)/3 = d`. **A neutral grain's metric distance is exactly its 8-bit level deviation**, so the
material is specified in metric units and read back in levels with no conversion.

**Three layers**, all `repeat`, emitted onto `.ground`:

1. **Tooth (dark)** — turbulence alpha → tint `--fg` at `alpha(fg)/2`, `baseFrequency` from the stock ladder.
2. **Tooth (light)** — the same turbulence with `feComponentTransfer` inverting alpha, tinted the lift, at
   `alpha(lift)/2`. Two opposed layers keep the material **symmetric about the ground**, so the modal cell colour
   does not drift and `backgroundHex` cannot flip — the failure that invalidated every grain-sweep row above
   σ≈14, where `backgroundHex` flipped to the *ink* and every share was then measured against a wrong anchor.
3. **Cloud** — a second turbulence at `baseFrequency` 0.02–0.05, `numOctaves="2"`, at `alpha/3`. This is rf-11's
   visible unevenness; it is what stops the plate reading as screen noise.

Enforced at emit time and asserted over a kit corpus: `Σ_layers alpha_L · markColourDistance(tint_L, ground) ≤
MATERIAL_PEAK_DELTA`, summed because two layers can co-peak in one pixel.

**Per-client determinism.** Everything keys off `fnv1a32(clientSlug)`, the hash `paletteForSlide` already uses.
The turbulence `seed` comes from it, so **the same client always gets the same paper and two clients never get
the same paper**. `MATERIAL_STOCKS` is a four-entry ladder picked by `hash % 4` — *laid* (bf 0.90), *wove*
(0.75), *board* (0.55, coarser cloud), *canvas* (0.42, 4 octaves). **Constant across the carousel**: rf-11 and
rf-05 both keep one stock across eight slides, and a paper that changed between slides would read as a rendering
bug. This is the one place in this agent where variation is deliberately refused. Cost: one hash, $0.00.

### 5.1a MEASURED-HERE: the material really is invisible, and 11 is on a plateau

Bundled dark kit, a two-line headline on a material ground, all through the real `measureSlidePng`. The first
row is the bare plate with no material at all:

| plate | `inkShare` | `occ` | `COCC` | `LER` | `flat` |
|---|---|---|---|---|---|
| **bare + headline (reference)** | 0.0335 | 0.0426 | 0.0426 | 0.4861 | 0.967 |
| material peak 6 | 0.0335 | 0.0426 | 0.0426 | 0.4861 | 0.967 |
| material peak 9 | 0.0335 | 0.0426 | 0.0426 | 0.4861 | 0.967 |
| **material peak 11 (proposed)** | **0.0335** | **0.0426** | **0.0426** | **0.4861** | **0.967** |
| material peak 13 | 0.0335 | 0.0426 | 0.0426 | 0.4861 | 0.967 |
| material peak 16 | 0.0335 | 0.0426 | 0.0426 | 0.4861 | **0.961** ← first movement |
| material peak 20 | 0.0335 | 0.0427 | 0.0426 | **0.2513** | **0.920** ← cliff |

And material-only, with no type at all — the G2 empty-plate case:

| plate | `inkShare` | `occ` | `iod` | `LER` | `flat` |
|---|---|---|---|---|---|
| material peak 11, EMPTY | **0.0000** | **0.0000** | **0.0000** | **1.0000** | **1.0000** |
| material peak 16, EMPTY | 0.0000 | 0.0000 | 0.0000 | 1.0000 | 0.994 |
| material peak 20, EMPTY | 0.0001 | 0.0001 | 0.0000 | **0.3754** | 0.952 |

**At peak 11 every metric is byte-identical to the bare plate**, and an empty material plate measures
`largestEmptyRectShare = 1.0000` exactly.

> **⚠ Correction, 2026-09-14: "byte-identical" holds for four of the five shares on a REAL render, not all five.**
> MEASURED-EDGE, the same archetype rendered with and without `groundMaterialCssBlock` through the real pipeline:
> `inkShare`, `occupiedShare`, `largestEmptyRectShare` and `flatBackgroundShare` are identical to 3 dp.
> `contentOccupiedShare` moves **0.01 points** and `imageryOrDeviceShare` **0.14 points** (0.3439 → 0.3453).
> The cause is a threshold rather than an amplitude: `graphicShare` is `covered && distinct <= 3` and
> `contentOccupiedShare` reads a cell MEAN against `tol.ink`, so a sub-ink grain that changes no pixel's ink status
> can still tip individual cells across a count or a mean — on the plinth's flat fill, where cells sit exactly on
> the `distinct` boundary. That is noise around a boundary, not a contribution: 0.14 points is **20× under** the
> 0.10 clause-E floor it would have to reach to change a verdict. The table above was measured on hand-painted
> plates, where the effect cannot appear because there is no boundary-sitting fill to tip. The rendered A/B case
> pins the four at equality and the two at a 0.005 bound.
>
> **⚠ SECOND INSTANCE, 2026-09-14, ON A DIFFERENT LIMB — and both belong in one place, because the mechanism is
> one mechanism.** CI 34804038775 spliced the same sheet onto a plate wearing `.copy-art`'s 22% hatch and
> `flatBackgroundShare` moved **0.123 points** (0.7962 against 0.7974) where the A/B case bounds it at 0.0005.
> The bound was NOT widened. Read it next to the `iod` case above: a sub-ink grain changes no pixel's ink status,
> but it can tip a cell whose MEAN sits exactly on a threshold — `tol.ink` for `contentOccupiedShare`, the
> `distinct` count for `graphicShare`, `FLAT_TOL` for `flatBackgroundShare`. **The material is inert on a plate
> with no boundary-sitting cells and not on one that has tens of thousands of them**, which is what a flat fill
> (the plinth) or a hatch (`.copy-art`) is. So "the material is invisible to the instrument" is a claim about a
> BARE ground, and `groundMaterialCssBlock` now says so in its own selector: `body:not(:has(.copy-art))`. That is
> the Ground Rule's condition asked of the document, not a template allowlist, and it comes out in the same PR as
> the screens. Anyone adding a ground layer needs both instances, and this is where they are.
>
> The `iod` reading also locates the cliff:
`flatBackgroundShare` moves first at ~16, and `inkShare`/`LER` break between 16 and 20 — at `tol.ink = 18`, which
is the correct and predictable place, because a material whose peak deviation is under 18 produces **no ink
pixel at all**. `MATERIAL_PEAK_DELTA = 11` therefore sits mid-plateau with 7 units of headroom, not on an edge.
Spec A's §7.2 band sweep is answered in advance; it still runs in CI to confirm on real Chromium.

## 5.2 What comes OUT of the templates

| file | layer deleted | justification |
|---|---|---|
| `cover.html` | `.cov-field`'s full-bleed hairline screen | MEASURED-EDGE: **solely** responsible for `LER` 40.00 → 7.50. Deleting it *raises* `iod` 14.09 → 17.12, because the hairlines were adding a fourth distinct colour to the ramp's own cells and pushing them out of the `graphic` bucket (`distinct <= 3`). **It suppressed the ramp's clause-E contribution by ~3 points while disarming clause C.** ⚠ This cell used to open "carries **0.22 points** of clause E", which contradicted its own next sentence: if deleting the screen *raises* `iod` by 3.03 points then the screen contributed about **minus three**, not plus 0.22. 0.22 is `LARGEST_EMPTY_RECT_CEILING.cover` — the section was priced with the number it was defending. Clause removed here and in `interest-floor.ts`. The ramp-only `iod` band is **16.51–17.12** throughout this document; an earlier "16.51–18.80" in §5.6 was the same band mis-transcribed. |
| `headline-focus.html` | `.copy-art`'s full-bleed 45° screen (2px/9px at `--fg` 22%) | MEASURED-HERE: it alone takes `COCC` to 0.3128, `occ` to 0.6426, `textShare` to 0.6132 and `LER` to 0.0000. It disarms clauses C, D **and** G, and trips clause F as a false positive. |
| `slide.html` | the heroless-path full-bleed texture | Same shape; MEASURED-EDGE `iod` 4.53 → 3.39 without it, i.e. it never paid clause E either. |
| `closer.html` | `.cl-art`, `.ground-glyph` | **RFC-17 line 70's claim that the closer's clause-E share IS `.cl-art` is FALSE on this tree.** MEASURED-EDGE: `.cl-art` is worth **1.01 points of 38.63 (2.6%)**; it quotes a third-pass number from an intermediate that never shipped. The closer's share is its recap strip, ask band and accent rule, all content-guarded. ⚠ **This row used to end "the closer costs this phase nothing" and that was wrong** — see the correction below. |

> **⚠ §5.2 correction, 2026-09-14: the closer is not cleanup.** The shipped diff also moves `.cl-field` from
> `justify-content: flex-end` to `center`, adds a filled `#takeaway` plinth (`padding-inline: 44px; padding-block:
> 48px`, a 10–15% gradient fill, 64/96 at `body.ts-s`), adds a fourth `.headline.micro` type step with a new
> `at(150, 80)` branch in the fit script, and adds two guards (`body:not(:has(.eyebrow:not(:empty))) .cl-rail`,
> `body:not(:has(#takeaway > span:not(:empty))) .cl-rule`). A table cell saying a file costs nothing, next to a file
> that gained a plinth and a type step, is how the next phase inherits a wrong premise.
>
> The consequence is not cosmetic: `OCCUPIED_SHARE_FLOOR.closer` was originally moved off the single figure `occ
> 0.4504`, **measured on the closer before any of this landed**. The re-derivation above replaces it with 19 rows
> off the restructured file (0.5722–0.6633). It also surfaces a finding the old basis hid — the restructured closer
> measures `LER` **0.2278** against its 0.22 ceiling at short copy, a §5.6 rule-2 template failure that is **open**.
| the four panel archetypes | nothing | `quote-card` 47.30, `stat-callout` 34.59, `list-takeaway` 33.58, `comparison-card` 19.39 — MEASURED-EDGE unchanged to 2 dp with all ground paint suppressed. They are already built to the Ground Rule. |

Also audited against the Ground Rule in build: `coverRemedy`'s step-3 fallback `colour-block-ground`. A colour
block that is full-bleed and unguarded is the same defect wearing a different name.

## 5.3 What goes back IN — the plinth, and why it is load-bearing

The statement archetypes lose their texture and gain a **plinth**: a bounded filled card behind the statement.

- `inline-size: fit-content`, capped at `calc(100% - 2*var(--mx))`; `block-size: fit-content`; `align-self:
  start` in the column flex — **it hugs the copy and cannot absorb leftover space.** `flex: 1 1 auto` on this box
  would reproduce the cover's second-pass defect verbatim.
- Fill `color-mix(in srgb, var(--fg) 12%, var(--bg))` — 25.8 units from the bundled ground, clear of the 18-unit
  ink line with margin for AA, so `covered && distinct <= 3` and it reads as a drawn device, which is what it is.
- Guarded: `body:not(:has(#headline > span:not(:empty))) .hf-plate { background: none; }` — the exact guard form
  `cover.html` already uses, asked of the twin's children rather than the host, for the reason that file records.
- Logical properties throughout (`inline-size`, `margin-inline`, `padding-inline`), so it hugs the copy on both
  sides of the mirror. No `left`/`right`, no `deg` on its fill.

**The plinth is not decoration to satisfy a clause. It is the mechanism that makes "how much was written"
measurable as area.** Spec B's strongest measurement is that `occupiedShare` on *type alone* cannot separate a
short populated plate (6.74) from a neglected one (6.69). That is true and it is why a floor on bare type is
hopeless. A content-guarded `fit-content` plinth converts copy volume into covered area, and the bands separate.

## 5.4 MEASURED-HERE: the clause-D band, and the acceptance condition

Material ground at peak 11, screens deleted, interior role. Clause C fires at `LER > 0.28`; clause D fires at
`flat > 0.70 AND occ < floor`.

**POPULATED**

| plate | `occ` | `flat` | `LER` | `iod` | `text` |
|---|---|---|---|---|---|
| type only, 3-line headline + 4-line body | 0.1083 | 0.9237 | 0.3889 | 0.0593 | 0.0490 |
| **+ plinth 888×400** | **0.2620** | 0.7529 | 0.3611 | **0.2383** | 0.0237 |
| + plinth 888×560 | 0.3198 | 0.6802 | 0.3611 | 0.3198 | 0.0000 |
| + plinth 888×560 + bounded device | 0.3660 | 0.6340 | **0.2500** | 0.3660 | 0.0000 |

**NEGLECTED**

| plate | `occ` | `flat` | `LER` | `iod` |
|---|---|---|---|---|
| **the owner's grey screen** — one short headline | **0.0106** | 0.9917 | **0.5259** | 0.0073 |
| the same + its guard-ON plinth | **0.0311** | 0.9696 | 0.5111 | 0.0297 |
| every slot empty (G2) | 0.0000 | 1.0000 | 1.0000 | 0.0000 |

**THE SAME PLATES ON THE SHIPPED HATCH — this is the defect, on my own pixels**

| plate | `occ` | `flat` | `LER` | clause C | clause D |
|---|---|---|---|---|---|
| shipped hatch, 3-line headline + body (a *good* plate) | 0.6688 | 0.7183 | 0.0000 | **pass** | **pass** |
| shipped hatch, **one short headline** (the grey screen) | 0.6324 | 0.7712 | 0.0000 | **pass** | **pass** |

**A properly composed plate and the owner's grey screen are indistinguishable today — 0.6688 vs 0.6324 on
occupancy, 0.0000 vs 0.0000 on the empty rectangle — and both PASS.** That is defect 1, reproduced
independently of both specs' reports, and it is this phase's acceptance condition. On the material ground the
same pair reads 0.2620 vs 0.0311 on occupancy and 0.3611 vs 0.5111 on the empty rectangle.

Three consequences, all of which shape Part 5:

1. **`iod` needs no re-calibration and the plinth pays it.** The plinth alone measures `iod` **0.2383** against
   a 0.10 floor. Spec A and Spec B both concluded clause E does not move; I now confirm it on my own pixels
   rather than inheriting it. The plinth answers clause D's occupancy **and** clause E's device floor with one
   object.
2. **`OCCUPIED_SHARE_FLOOR = 0.30` cannot stand.** A composed plate with its plinth measures 0.2620. The
   constant's own note argues 0.30 is "about a full-width 432px band fully used"; it was calibrated on a tree
   where a full-bleed hatch was counted as content. It is the one constant this phase re-calibrates (§5.6).
3. **Clause C still refuses composed plates until the templates are fixed.** `LER` 0.3611 with a plinth, against
   a 0.28 interior ceiling. **The ceiling does not move — the template is the bug**, and the remedy already
   exists (§5.5). This is why P2 and P3 must land in one PR.

## 5.5 The cover's hole, and the remedy that already exists

MEASURED-EDGE, and confirmed by two independent methods: with the screen deleted, the cover fails clause C at
`LER` **23.61** against 22.00, and the failing rectangle is named — `{x:0, y:236, w:1080, h:376}`, a full-width
band between the ramp's foot and the lockup's head. That is the legacy `DEAD-SPACE` rule's own shape ("no empty
horizontal band over 380px"); the rule and the measurement agree with each other and disagree with the template.
**The cover has a real hole and the screen has been painting over it.** With a device in `.cov-device` the band
closes to 228px and the plate passes at `LER` **15.83**.

So the remedy is composition, and `interest-relayout.ts` already contains it: `coverRemedy` builds a device from
the strongest `kind: "stat"` fact card via `deviceFromText` — deterministic regex over copy the run already
holds, **$0.00, no model call**. Today it is reached only on a `no-device` finding.

- **Change:** the `dead-space` remedy gains a cover limb. A `dead-space` finding on a cover whose failing
  rectangle lies inside `.cov-field`'s extent takes the same device remedy, ahead of the existing ladder.
- If the post carries no figure, the eyebrow rail takes a bounded plinth, guarded on the eyebrow being non-empty.
- If it has neither, **the cover fails clause C and that is correct.** Near-empty, ramp only: `LER` 40.00, FAIL.
  The floor discriminates between a cover that has something to say and one that does not — for the first time.

## 5.6 THE RE-CALIBRATION TABLE

### Constants that MOVE — exactly one, and its two siblings

| constant | old | new | the measurement behind it |
|---|---|---|---|
| `OCCUPIED_SHARE_FLOOR.interior` | **0.30** | ~~0.12~~ → **0.19** | See the re-derivation below. |
| `OCCUPIED_SHARE_FLOOR.cover` | **0.42** | **0.18** | See the re-derivation below. |
| `OCCUPIED_SHARE_FLOOR.closer` | **0.42** | **0.30** | See the re-derivation below. |

### ⚠ §5.6 RE-DERIVED, 2026-09-14 — the three rows above were set from synthetic plates

The table as first written set three live gates from hand-painted PNGs, and two of its three justifications do not
survive contact with a real render. Kept above rather than deleted, because the record of *how* a constant was
argued is worth as much as the constant:

- **The `cover` row quoted the wrong metric.** `iod` is `imageryOrDeviceShare`; the constant gates `occupiedShare`.
  `iod` cells are a strict subset of occupied cells, so the quoted 16.51–18.80 was a lower bound on a quantity
  nobody had measured. Its "keeps ≥1.15×" is also false on its own numbers: 0.18/0.1880 = **0.96×**, and 0.1651 is
  *below* the floor it is offered as headroom over.
- **The `closer` row loosened a live gate 1.4× on one reading of a plate that PASSED the old floor** (0.4504 > 0.42).
  A thin margin on a passing plate is a reason to re-sweep, not to loosen. Its basis was also stale: `closer.html`
  was restructured in the same pass (see §5.2).
- **The `interior` row's NEGLECTED figure was wrong by 9×.** 0.0311 was a synthetic carrying a token plinth. On a
  real render the same plate measures `occ` **0.2791**, because the plinth on a one-line headline at display size
  is a 888×400 card and not a sliver.

**What replaced them.** The gate-zero sweep (§5.8.1) was run as a local pre-flight through the real pipeline —
`assembleSlidesData` → real `createRenderCarousel({probe, measure})` → real `measureSlidePng` — over 8 archetypes ×
3 copy lengths × 3 type scales × {en ltr, he rtl}, **on documents carrying all four production head sheets**. That
last clause is the load-bearing one: the harness was splicing three of the four and omitting `groundMaterialCssBlock`,
so every number it had ever printed described a document no client receives. 160 rows:

| role | POPULATED `occ` | NEGLECTED `occ` | rule-1 midpoint | **set to** | margin |
|---|---|---|---|---|---|
| cover (n=19) | 0.2690 – 0.3517 | 0.0006 (empty) | 0.13 | **0.18** | 1.49× over populated |
| interior (n=114) | 0.3121 (flat-gated min) | 0.0746 (grey screen) | 0.19 | **0.19** | 1.64× / 2.55× |
| closer (n=19) | 0.5722 – 0.6633 | 0.0000 (empty) | 0.29 | **0.30** | 1.91× over populated |

Clause D is a **conjunction**, so the only rows its occupancy limb can reach are those also over
`FLAT_BACKGROUND_CEILING`; the interior row is therefore the flat-gated band. Measured false-refusals at 0.19 over
all 114 interior rows: **zero** — and that holds without the flat gate, since the lowest interior row of any kind is
0.2895. At 0.42: two.

**The interior band is a band only because of a one-line template fix, and that is the most important number in
this document.** With `.hf-plate` guarded on the HEADLINE — as it shipped into this branch — the flat-gated gap is
`0.3121` populated against `0.3004` neglected: **0.0117 wide**, which is not a band, it is two numbers that happen
not to have crossed. The cause is that the plinth painted on a plate carrying nothing but a headline, so the
owner's grey screen wore a filled card and reported `occ` 0.2791–0.3004 and `iod` 0.2763–0.3152 — **inside the
composed band on both, and over clause E's floor.** The grey screen was claiming to carry a drawn device. Guarding
the plinth on the BODY — which is what its own justification always implied, since it exists to convert copy
*volume* into area and a headline alone is not volume — moves the same plate to `occ` 0.0285–0.0746 and `iod`
0.0166–0.0412, and the gap to **0.2375 wide**. Zero new false refusals: a composed plate keeps its card unchanged
to 4 dp.

**Standing caveat.** These are MEASURED-EDGE: the system Edge channel, because the bundled Playwright Chromium on
the authoring machine is a broken install. Edge is Chromium-family and shapes text with the same engine, but it is
not the binary CI runs. **CI is the authority for every figure here.**

**These three are PROVISIONAL and CI-gated.** They are set from synthetic plates through the real instrument;
the gate-zero sweep (§5.8) sets the final values from the max over `{en, he}` × 3 copy lengths × 3 type scales ×
2 ground variants. **The rule is fixed before the sweep runs so its outcome cannot be argued backwards into a
relaxation:**

1. If `min(POPULATED) > max(NEGLECTED)`, the constant is the midpoint of the gap, rounded to 0.01 **toward
   NEGLECTED**.
2. If `min(POPULATED) ≤` the proposed floor, **the first remedy is the template** — the plinth grows or the
   archetype gains its device. The constant does not move on the first failure.
3. If the bands **overlap**, clause D's occupancy limb cannot separate composed from neglected on typographic
   plates. It is then **demoted to reporting-only** for the `headline_focus`/heroless-`slide` family, and clause
   C carries the refusal — which it does decisively at `LER` 0.5111–0.5259 on the grey screen. **A limb that
   cannot refuse the thing it was built for is removed, not lowered.**

   > **⚠ RULE 3 IS REFUSED, 2026-09-14, AND THE MEASUREMENT THAT KILLS IT IS G5.** The bands DID overlap on CI
   > (Part 11), so this branch is exactly the case rule 3 was written for — and the remedy it prescribes is
   > wrong, because its premise is false. Rule 3 says *"clause C carries the refusal."* **It does not.** CI run
   > 34802291959, G5: the owner's grey screen carrying its maximum mark load measures `largestEmptyRectShare`
   > **0.2278** against the 0.28 interior ceiling — under it. **Clause C admits the marked grey screen. The only
   > clause that refuses it is clause D, on occupancy (occ 0.0864).** Demoting D's occupancy limb would let the
   > owner's original complaint through the gate on any plate carrying emphasis, which every plate we ship does.
   > Nobody reaches for this lever again without answering that number.
4. **Under no outcome is a floor lowered to make a specific plate pass.** The band and the full table go into the
   constant's doc comment in the form the existing comments use.

### Constants that DO NOT move, each with the measurement that keeps it

| constant | value | why it holds |
|---|---|---|
| `IMAGERY_OR_DEVICE_FLOOR` | 0.10 | MEASURED-HERE: the plinth alone measures `iod` **0.2383**. MEASURED-EDGE: the closer clears it by **28.18 points** with every ground layer suppressed; the four panels are indifferent to 2 dp; the cover clears it on its bounded ramp alone at 16.51–17.12. **The brief scoped a clause-E re-calibration as this phase's price. The measurement says clause E does not need one.** |
| `LARGEST_EMPTY_RECT_CEILING` | 0.22 / 0.28 / 0.22 | The cover's 23.61 is a **hole at a named rectangle**, closed to 15.83 by filling the slot the template already has. Moving 0.22 to 0.24 to admit it would be exactly the relaxation that produced defect 1. The legacy DEAD-SPACE rule (380px) and the measured band (376px) agree with each other. |
| `FLAT_BACKGROUND_CEILING` | 0.70 | Untouched, and deliberately **not** rescued by putting the material in the 12–18 band. See `MATERIAL_PEAK_DELTA`. |
| `CONTENT_OCCUPIED_SHARE_FLOOR` | 0.09 / 0.06 / 0.09 | MEASURED-HERE: with no sub-covered paint left, `COCC ≈ occ`, so populated-with-plinth ≈ 0.2620 and neglected ≈ 0.0311. The floors refuse the right side of that band unchanged. Their doc-comment band table is **stale** (it cites populated ≈0.135 / decorated-blank ≈0.00 against a measured 0.3128 today) and is **re-stated from the sweep** — a documentation duty, not a constant move. |
| `TEXT_SHARE_CEILING` | 0.55 | MEASURED-HERE: the shipped hatch measures `textShare` **0.6132** — decoration scored as a wall of type, a false positive. On the material ground the same plate measures **0.0490**. **A bug fixed, not a threshold moved.** |
| `INK_SHARE_FLOOR`, `CLIPPED_EDGE_SHARE_CEILING`, `EDGE_DENSITY_FLOOR`, `ACCENT_MIN/MAX_SHARE`, `FULL_BLEED_IMAGERY_SHARE` | — | Untouched, unaffected. |
| `MARK_TOL` 20, `MARK_GROUND_CONTRAST_FLOOR` 3, `MARK_TEXT_CONTRAST_FLOOR` 4.5, `ACCENT_EXCLUSION` 40, `MARK_SEPARATION` 40, `MARK_RING_MAX` 6 | — | **The ring fix moves no constant at all.** It is a change of quantifier. Part 6. |
| `FLAT_TOL` 12, `INK_DELTA` 18, `CELL_INK_SHARE`, `CELL_COVERED_INK_SHARE` | — | `slide-metrics.ts` is not edited. **No `TOOL_VERSION` bump.** |

### Constants INTRODUCED (new parameters, not re-calibrations)

| constant | value | why that number |
|---|---|---|
| `MATERIAL_PEAK_DELTA` | **11** | MEASURED-HERE §5.1a. Strictly below `FLAT_TOL = 12`, and the measured plateau runs to 13 with the cliff at 18–20 (= `tol.ink`). Chosen at the *flat* line rather than the *ink* line deliberately: a material in the 12–18 band would take `flatBackgroundShare` under 0.70 and **disarm clause D's first limb on every plate that wears it** — defect 1 again, one clause over. |
| `MATERIAL_TILE_PX` | 256 | Rasterised once by Chromium rather than at full 2160×2880. At bf ≥ 0.42 the feature size is ≤ 2.4px and a 256px `stitch`ed repeat is not perceptible. |
| `MATERIAL_STOCKS` | 4 entries | §5.1. Four physical stocks, none of them a pattern. |

## 5.7 The guards — and each one broken before it is trusted

**G1 — the owner's grey screen** (Chromium-gated; CI is the authority). Render `headline_focus` through the
real pipeline with one short headline and nothing else, at interior **and** cover roles; assert `ok === false`
and `dead-space` among the findings. **This test fails today**: MEASURED-EDGE, `Y0 s2` is that exact plate and
returns `ok: true`; MEASURED-HERE, the same shape returns `LER` 0.0000 and passes C and D. It fails for a real
reason, on the shipped ground, with nothing manufactured.

**G2 — the empty plate** (Chromium-gated). For every bundled archetype × every role, render with **every copy
slot empty**; assert `ok === false`, `occupiedShare < 0.01` and `largestEmptyRectShare > 0.90`. This is the
Ground Rule made executable and it is G1's general form. MEASURED-HERE the material-only plate gives exactly
0.0000 / 1.0000.

**G3 — the material is sub-ink** (Chromium-FREE; PASSES locally, no excuse for a skip). Hand-paint a 2160×2880
plate from the alphas `groundMaterialCssBlock` actually emits, for a kit corpus (bundled dark, paper, one mono,
one pale-accent); run the real `measureSlidePng`; assert `inkShare === 0`, `occupiedShare === 0`,
`contentOccupiedShare === 0`, `imageryOrDeviceShare === 0`, `largestEmptyRectShare === 1` and `backgroundHex ===
groundHex`. That last is not decoration: a loud material flips `backgroundHex` to the *ink*, after which every
share is measured against a wrong anchor and `backgroundMatchesBrandGround` is only a warning.

**G4 — the alpha invariant** (Chromium-free). `Σ alpha·distance ≤ MATERIAL_PEAK_DELTA` over the same corpus,
plus the achromatic identity `distance(d,d,d) === d`.

**G5 — marks cannot close the hole** (Chromium-gated). The grey screen carrying the maximum mark load
(`MAX_MARKS_PER_SLIDE = 5`, all `block`) must **still** fail clause C. This is a guard rather than a formality
because a `block` mark is `covered`, flat and ≤3 distinct colours, so **painted marks land in `graphicShare` and
count toward clause E** — MEASURED-EDGE, one `swish` on the cover moved `iod` 14.09 → 14.37. The ring fix
multiplies the mark load on paper kits, and this phase does not ship arguments about pixels.

**Breaking the code to watch each guard refuse — required before any is trusted:**

- G1/G2: restore the `.copy-art` screen → both must go red.
- G3: multiply the emitted alpha by 2 → `inkShare` must leave zero. (MEASURED-HERE: peak 22 is past the cliff.)
- G3: set the light-tooth alpha to 0 (asymmetric material) → the `backgroundHex` assertion must fire.
- G5: shrink `LARGEST_EMPTY_RECT_CEILING` to 0.9 → must go red, proving the assertion is reached at all.

## 5.8 The sweeps

**§5.8.0 — the settling render, first, before any code is written.** Render `headline_focus` on the **shipped**
tree with every copy slot empty and read `contentOccupiedShare`. MEASURED-HERE the synthetic answer is **0.3185**
(hatch + bands, no headline), i.e. clause G *is* disarmed on the shipped templates and the material ground is a
**repair**, not an improvement. `floor-today` flagged this as the one thing it could not settle; it costs one
render to confirm on real Chromium.

**§5.8.1 — the gate-zero clause-C/D sweep.** `POPULATED` = 8 archetypes × 3 copy lengths × 2 directions × 3 type
scales × `{en, he}`, composed to the Ground Rule. `NEGLECTED` = the grey screen, `Y0 s2`, and each archetype's
empty-slot render. Report `occupiedShare`, `flatBackgroundShare`, `largestEmptyRectShare` and
`contentOccupiedShare` for both limbs; clause D is a conjunction and a band for one limb is not a band for the
clause. **Land only if every real plate clears its role ceiling with ≥1.15× margin**; any real plate over the
ceiling is a template finding, fixed and re-swept, never admitted by raising a ceiling.

**§5.8.2 — the material band sweep.** `MATERIAL_PEAK_DELTA` ∈ {6, 9, 11, 13, 16, 20} × 4 stocks × 3 kits,
reading all five shares and `backgroundHex`. MEASURED-HERE this already returns a plateau to 13 and a cliff at
18–20; the sweep confirms it on real Chromium so the next revision inherits a band rather than a value.

**On the instrument.** The clause-E measurer established that the bundled Playwright Chromium here is a *broken
install* (a 250 MB `chrome.dll` with **no `chrome.exe`**) and that `chromium.launch({ channel: "msedge" })`
works. That makes these sweeps runnable as a local pre-flight for the first time. It does not change who the
authority is.

## 5.9 RTL and Hebrew

- **The material is direction-free** — tiled, `stitch`ed, statistically isotropic, contributing nothing in either
  direction. Any directional layer (the cloud, if it carries an axis) takes the `--mk-ink-angle` treatment
  verbatim: a custom property flipped by `[dir="rtl"]`, because a `deg` angle does not mirror under `dir` the way
  logical properties do.
- **Hebrew gets highlighters for the first time, and that is the point.** `HEBREW_GEOMETRY` already carries
  `--mk-block-h: .44em` / `--mk-block-y: .60em` — shorter and lower, because Hebrew has no ascenders and a full
  letter body. **Those constants have shipped and been unreachable on every dark kit**, since `block` was refused
  by ground luminance (MEASURED-HERE: block-capable 0/16 on the bundled kit, before and after). The ring fix makes
  them live on a paper kit, so they must now be **verified rather than assumed** — the band sweep against measured
  cap height that RFC-17 §5.3 test 12 already specifies, run for real.
- **Phase 4's bidi isolation is untouched.** No change to `buildMarkedRuns`, `isolateForeignRuns`, or the
  twin-slot pair. `--mk-twin-bleed` keeps its `.22em` Hebrew value and its `.22em` var() fallback — the asymmetry
  is deliberate and `bidi-isolation.test.ts` is what found it. **If `emphasis-marks-rtl.test.ts` needs editing,
  the change was wrong.**
- Every sweep runs `ltr × rtl` with the Phase-0 script fonts loaded, and `probe.fontFamiliesUsed` is asserted
  non-fallback on every row — the check that caught fallback-metrics contamination in the clause-E work.

---

# Part 6 - The ring: kind-aware admission

## 6.1 The defect, verified in code and reproduced in arithmetic

`buildRingAgainstGrounds` (`emphasis-marks.ts:372-401`) culls on `contrastRatio(hex, ground) >= 3` **before any
kind exists**. `markKindsFor` (`:502-539`) then takes `ring.hexes` as *input* and admits `block` only when
**every** member clears `contrastRatio(ink, hex) >= 4.5` on a ground lighter than the ink. Confirmed at all
three call sites (`slides-data.ts:1202`, `template-studio.ts:1414`,
`create-instagram-agent-workflow.ts:2335/:4409`): **kind selection cannot re-admit anything the cull removed.**

**The squeeze:** the ring admits on "far from the paper"; `block` demands "far from the black ink". On paper
those are **opposite directions on one luminance axis**, and a highlighter is by definition at the paper end.
The first test is not a weaker version of the second; it is the wrong test. And `every()` means one dark member
vetoes `block` for the entire run.

**MEASURED-HERE**, running the shipped formulae over 16 plausible brand colours (four of them sampled from the
reference pixels):

| kit | today | after |
|---|---|---|
| paper `#F0EAE6`/`#12100E` | ring **3/16**, block-capable **1/16** (`#C06868`, a muted red pencil); whole-kit ring `[#C06868, #E11D48, #1D4ED8]` → **block 0/16** under `every()` | ring **15/16**, block-capable **13/16** — including `#FFEB3B`, `#F0E810`, `#C8F888`, `#B8E8E0`, the exact treatment rf-11 paints ten of |
| bundled dark `#17181C`/`#F4F2EC` | ring **15/16**, block **0/16** | ring **15/16**, block **0/16** — **unchanged** |

The dark row matters as much as the paper one: **on our shipped ground the ring was never the binding
constraint**, so this change is inert on every client we run today and switches on for paper and light kits —
which is exactly where a sub-ink material ground moves clients. **Defects 1 and 2 meet here.**

## 6.2 The change

**Admission becomes per-capability, and the capability set travels with the member.**

1. **`markColourDistance > MARK_TOL` from every ground and from the ink stays exactly as it is**, ahead of
   everything. This is the metric's own test and the honest cull. MEASURED-HERE, `#E8D4F0` (rf-11's lilac) sits
   at **16.2** from the paper and stays refused — **the pixel metric could not see it either.** Keeping this cull
   unchanged is what stops the fix being a general loosening.
2. A candidate is admitted if it is legible as **at least one kind**:
   - `block` — `refuseBlock !== true && groundIsLighterThanInk(ground, ink) && contrastRatio(ink, hex) >= 4.5`
   - `underline` / `swish` / `double` — `contrastRatio(hex, ground) >= 3`
   - `ink` — `contrastRatio(hex, ground) >= 4.5`

   A candidate whose capability set is empty is dropped, and its note names **every** test it failed.
3. `MarkRing` gains `kindsByIndex: readonly (readonly MarkKind[])[]`, parallel to `hexes`, computed once at
   admission where both the colour and the grounds are known.
4. `markKindsFor` stops being the gate. It keeps its name, signature and `refuseBlock` option, returns the
   **union**, and is used for reporting and the studio's kind inventory. **`every()` is gone.**
5. **`markRotation` draws the kind from the selected colour's own set.** This is the bound: *the pairing is what
   has to be legible, and the pairing is checked at the point it is made.* No (colour, kind) pair can exist that
   the colour cannot carry. Its two published invariants survive.
6. **`resolveSlideMarks` re-asserts the pair against its own kind's floor at the point of emission** and drops
   the run with a `MarkDrop` if it fails. A drop is reported, never a hold. (Grafted from Spec B — belt and
   braces over the admission-time bound.)
7. **`ringIndexesFor` gains the slide's kind constraints** and excludes a member whose surviving set is empty for
   that slide. Load-bearing: on `quote_card`, `refuseBlock` strips `block`, and a block-only highlighter would
   otherwise be selected with **no kind at all**. Its existing `parseHex` guard — the one whose absence silently
   killed the whole feature — is untouched.
8. **Ground inversion improves.** `groundMayInvert` currently intersects two *membership* sets, finds them empty
   on any kit with real contrast, falls back to the primary ground and leans on `every()` to blank inverted
   slides. It now intersects **capability** sets per member, so a colour that can carry `block` on the light
   ground and `underline` on the dark one keeps both. The existing fallback stays as a last resort.

## 6.3 Why this cannot admit an unreadable mark

- **No constant moves.** 3:1, 4.5:1, 20, 40, 40, 6 — all unchanged. This is a change of **quantifier**, not of
  threshold: today a colour is judged by one kind's test and then used as another.
- For `block`, the change **replaces a test that measures nothing relevant with the correct one, and the correct
  one is stricter** (4.5 vs 3). `contrastRatio(hex, ground) >= 3` on a highlighter is not a weak legibility test;
  it is a test of the wrong pair. What must be readable behind a swatch is the ink on the swatch.
- ~~The admitted PAIR set is a **superset of today's by construction**~~ — see the correction below. Every added
  pair passes its own kind's floor against the exact ground the slide renders, including post-inversion.
- The only colours newly admitted are those that pass a WCAG-AA test they were never given.

> **⚠ Correction, 2026-09-14: the pair set is a superset EXCEPT in one direction, and that direction is stricter.**
> `block` admission measured `contrastRatio(fgHex, hex)` — the ink token on the swatch. No bundled archetype paints
> its body ink neat: `.body-text` is `color-mix(in srgb, var(--fg) 92%, transparent)` on `cover.html`,
> `headline-focus.html` and `slide.html`, `.cl-cta` is 94% on `closer.html`, and `stat-callout.html` is 90%. Over a
> block swatch that composites the glyphs **toward the swatch** — toward the very colour they have to contrast with
> — so the shipped ratio is strictly below the one admission measured.
>
> MEASURED, 3-step RGB sweep on the paper kit `#F0EAE6`/`#12100E`: **22,876 of 379,493** block-capable candidates
> render below 4.5 on a 92% host; worst `#8A7B3C`, admitted at 4.501:1, renders at **4.16:1**. PIXEL-CONFIRMED
> through the real `markCssBlock` + `buildMarkedRuns` output: a `#FFEB3B` block's glyphs render `rgb(37,33,18)`
> rather than `rgb(18,16,14)` and measured contrast falls 15.55:1 → 13.18:1.
>
> `markCapabilitiesFor` now composites at `MARK_HOST_INK_ALPHA = 0.90` (the **minimum** over the bundled set, since
> admission runs once per run and cannot know the host) before applying the same 4.5. **No threshold moved** — the
> colour the 4.5 is measured on did. `#FFEB3B` still clears by 2.9×. The property sweep's superset assertion now
> states the corrected invariant and *checks* the exception: a dropped pair must be a `block`, must have cleared 4.5
> on the neat token, and must fail 4.5 on the composited ink. A `template-mark-slots.test.ts` scan fails if any
> mark-bearing host ever softens its ink below the constant.

## 6.4 The falsification

**The two-sided pin, MEASURED-HERE on the paper kit — if both hold, the two squeezes are provably independent:**

```
#FFEB3B  CR(hex,paper)=1.02  CR(ink,hex)=15.55  ->  [block]                        ADMITTED for block, REFUSED for underline
#1D4ED8  CR(hex,paper)=5.62  CR(ink,hex)= 2.83  ->  [underline,swish,double,ink]   ADMITTED for underline, REFUSED for block
```

**Four breaks, each of which must turn a guard red:**

1. Rotation drawn from the union instead of the member's own set → the paper kit must produce `(#FFEB3B,
   underline)` at 1.02:1 against the paper, and the pairing guard must refuse it. *If it does not, the guard is
   the bug.*
2. `MARK_TEXT_CONTRAST_FLOOR` → 1 → an unreadable `block` must be admitted and the admission guard must fire.
3. Drop the `groundIsLighterThanInk` conjunct → `block` must appear on the `#17181C` kit and the dark-ground
   guard must refuse it.
4. Drop the `MARK_TOL` cull → `#E8D4F0` at 16.2 from the paper must be admitted and the metric-separability
   guard must refuse it.

**Plus a property sweep** (~4,000 synthetic kits, both luminance polarities, with and without `refuseBlock` and
inversion): every emitted `(hex, kind)` pair satisfies that kind's own floor; the pair set is a superset of
today's; no colour inside `MARK_TOL` of ground or ink is ever admitted for any kind.

**Plus the pixel proof, CI only:** a paper-kit slide carrying a `block` must report `markRunsPainted ===
markRuns` and `markColourCount` equal to the number of distinct ring colours used. Today those are structurally
0 on every dark kit, so **this is the first render in which the mark metric can fail at all.**

---

# Part 7 - Cost

| item | per-attempt token delta | $ |
|---|---|---|
| `ground-material.ts` — a hash, arithmetic, a CSS string | 0 | **$0.00** |
| Template edits (delete screens, add plinths + guards) | 0 | **$0.00** |
| `emphasis-marks.ts` — kind-aware admission | 0 | **$0.00** |
| `interest-relayout.ts` — `dead-space` cover limb via `deviceFromText` (deterministic regex over copy in hand) | 0 | **$0.00** |
| `interest-floor.ts` — three constants | 0 | **$0.00** |
| Tests and sweeps | 0 (CI compute) | **$0.00** |
| **total** | **0** | **$0.00** |

**The arithmetic that makes this zero rather than small:** the copy model never sees this vocabulary.
`MARK_KINDS` is chosen in code (`emphasis-marks.ts:137`); the model declares emphasis *spans* and nothing else.
The ground material is CSS spliced at materialisation time through `extraHeadHtml`, which no prompt describes.
The relayout remedy is regex. **Not one prompt string changes**, so every attempt is byte-identical to today's
and `copyAttempt` stays at exactly **0.181**.

Stated so they can be checked rather than believed:

- The cold Hebrew plan stays at **$0.9983** against the $1.00 target, with **three** drafting attempts. The
  planner was not run because there is no input to it that differs; the claim is *the prompts are unchanged*,
  which is verifiable statically. The check: `prompt-registry.ts` and `copy-prompt-v17.test.ts` appear in neither
  the diff nor the CI prompt-hash job.
- **No prompt bump** → the five-step checklist does not apply and `scripts/prompt-registry.ts` is not touched.
- **No `TOOL_VERSION` bump.** `slide-metrics.ts` and `render-carousel.ts` are not edited; no tool's behaviour
  changes. `render-carousel.ts` stays at 1.4.0. **This is the largest single saving from choosing Spec A over
  Spec B**, which required 1.4.0 → 2.0.0 on a shared package.
- **NEEDED FROM another package: nothing.** Every file this phase touches is owned by `agents/instagram-agent`.

**The one place a cost could appear, named so it is watched.** A re-armed floor that refuses a *good* plate costs
a `$0.181` redraft out of three, and there is **$0.0017** of headroom. This is why §5.4's finding — clause C
still firing at `LER` 0.3611 on a composed plate — is a **blocking** finding and why the templates land in the
same PR as the constants. The mitigation is structural, not budgetary: the plinth and the device are
template-side and content-guarded, so they paint on the **first** render and no clause-D or clause-C finding is
generated for the redraft loop to answer. If the sweep shows otherwise, that is a §5.6 outcome-2 result — the
template is wrong — and it is resolved before merge, not at runtime.

> **⚠ Correction, 2026-09-14: that mitigation is true of the plinth and FALSE of the cover's device.** The plinth
> is template-side and paints on the first render. The cover's device is not: `interest-relayout.ts`'s new cover
> limb runs at **relayout** time — i.e. after a render has already failed — and only when `coverRemedy` finds an
> image or a `kind: "stat"` fact card. `cover.html` says so itself ("the remedy really is the one §5.5 names … and
> this file is not where it lands"). For a post carrying neither, a deviceless cover that fails clause C costs a
> full `$0.181` attempt, which $0.0017 of headroom cannot absorb.
>
> **The measured exposure, which is the reason this is a correction and not a retraction.** The sweep renders the
> cover 19 times photoless and deviceless and `LER` comes back at **0.0750–0.1469** — every row under the 0.22
> ceiling, worst row 1.50× clear. `cover.html`'s own table ("no device — 15 of 18 rows over, worst 43.06") describes
> an intermediate state and is stale. **On the tree as it stands the cover exposure is zero rows**, so the cost
> stays $0.00. What has to be watched is that it stays that way, which is what the sweep's cover rows are for.
>
> The open per-attempt exposure is elsewhere and is named rather than netted off: `slide.html` measures `LER` up to
> 0.2944 against 0.28 on **10 of 19 rows**, `closer.html` 0.2278 against 0.22, `stat-callout.html` 0.2889 against
> 0.28, and `headline_focus` is over the *margin-adjusted* ceiling on 7 of 18. Each of those is a §5.6 rule-2
> template finding and each one that survives to runtime is a $0.181 attempt. **They are the reason this branch is
> not mergeable as it stands**, and none of them is fixed by moving a ceiling.

---

# Part 8 - What is deliberately NOT built

1. **No change to `slide-metrics.ts`, and no `TREATMENT_AMPLITUDE_RATIO`.** Spec B's discriminator works
   (MEASURED-HERE, COCC 0.3489 → 0.0828 with both controls holding) and is rejected on architecture, not on
   evidence: it leaves `largestEmptyRectShare` and `occupiedShare` dead forever, and its threshold is calibrated
   against the templates it is meant to police.
2. **No clause-E re-calibration.** The brief scoped it as this phase's price. MEASURED-HERE the plinth alone
   measures `iod` 0.2383 against a 0.10 floor, and MEASURED-EDGE the closer clears it by 28 points with every
   ground layer suppressed. **RFC-17 line 70's claim that the closer's clause-E share IS `.cl-art` is false on
   this tree** — 1.01 of 38.63. The scope shrank; that is reported, not quietly banked.

   ⚠ **And that is exactly why the plinth's effect on clause E is a BLOCKING, UNRESOLVED finding rather than a
   quiet win.** Whenever `.hf-plate` paints, `headline_focus` judged at the cover role measures `iod`
   **32.5–41.3%** against the 0.10 floor, so `no-device` goes silent and a statement slide is **accepted as a
   cover** — reversing `default:cover-carries-device` (`visual-qa-pre-checks.ts`), a shipped product rule whose one
   intentional exception this archetype is.

   It cannot be tuned away. §5.0's own structural reading of `slide-metrics.ts:866-919` — `covered` implies
   `carriesInk`, so `imageryOrDeviceShare ⊆ occupiedShare` cell for cell — says **there is no amplitude, tint or
   pitch at which paint is visible to clauses C and D and invisible to clause E.** A plinth that closes an empty
   rectangle necessarily carries clause E. So `headline_focus` may have a filled plinth **or** it may keep its
   `no-device` exception, and not both.

   **That is an RFC-14/RFC-17 decision about what a `headline_focus` slide is, and this phase does not take it.**
   The two assertions in `interest-floor-calibration.test.ts` are deliberately left asserting the shipped
   guarantee, and they are **RED** until it is taken. A red guard that states the truth is worth more than a green
   one edited to match the thing it was meant to police. An earlier revision of `headline-focus.html` called the
   reversal "a deliberate change of editorial identity" in a template comment; that has been withdrawn.
3. **No promotion of the five reporting-only composition metrics.** Deliberate emptiness stays refused. The last
   run found no measurable separation between a considered near-empty plate and a neglected one and wrote down
   the CI sweep that would justify revisiting. That sweep is newly **possible** — the Edge-channel launch makes a
   local pre-flight viable — and §5.8.1 collects four of the five over the same matrix at $0.00 as a side effect.
   **Proposed as its own phase. Not performed by assertion.**
4. ~~**The `.ground` tonal wash is NOT touched, and it is a live defect.**~~ ⚠ **This item is WRONG about what
   shipped.** It sits in the 12–18 band by design and is what takes `flatBackgroundShare` from ~0.88 to under 0.70 —
   **clause D's flat limb is disarmed by decoration on every plate that wears it.** Same class of defect, one clause
   over. The plan was to record it and not fix it, on the grounds that re-arming the limb would move the §5.6 band
   this phase is calibrating.

   **What actually shipped: `headline-focus.html` lost its wash.** `.ground` there is now bare
   (`position: absolute; inset: 0; z-index: 0`) and the file says why — the plinth made the wash unaffordable, so
   "recorded, not fixed" became impossible for that one archetype. The other five that wash (`cover.html`,
   `closer.html`, `quote-card.html`, `stat-callout.html`, `list-takeaway.html`, `comparison-card.html`) still do.
   **One archetype re-armed and five disarmed is a state nobody chose**, and it is recorded here as such.

   The removal is the RIGHT direction and the measurement says so: on `headline_focus` the flat limb is now live,
   and it is half of what refuses the owner's grey screen (`flat` 0.9463–0.9790 against a 0.70 ceiling, with `occ`
   0.0285–0.0746 under the floor). **The other five follow in their own phase**, because pulling five washes at once
   moves every row of the §5.6 band in the same commit that sets the constants from it.

   Two figures in this document describe the same quantity on the same plate and cannot both be it: §5.6's original
   band recorded populated `flat 0.7529` while `headline-focus.html` reports composed plates at 0.5715–0.6725. The
   re-derivation above supersedes both — the sweep's own flat column is the number.
5. **rf-11's photoless cover composition is NOT adopted.** Ten highlighters and a rule measure ≈6% of the frame
   and our clause E at 10% would refuse it. Emulating it would mean lowering clause E, so the bounded ramp stays
   as the cover's object. The reference's *execution* is adopted; its composition on that one slide is not, and
   none of its subject matter is.
6. **Chromium was not installed and no attempt was made.** No pixel claim is asserted from a local green run.
   Every guard is labelled PASSED-locally or SKIPPED-locally and every sweep number is CI's to produce.

---

# Part 9 - For the PR body

- State **PASSED vs SKIPPED per suite**, never merged. The Chromium-gated suites (G1, G2, G5, §5.8's sweeps, the
  ring's pixel proof) **SKIP locally and are CI's claim alone**. G3 and G4 are Chromium-free and must PASS
  locally — a skip there is a defect.
- Quote the §5.6 table in full: three constants move, each with its band; every other constant is listed with
  the measurement that keeps it.
- Quote the acceptance condition as a before/after pair: *shipped hatch, one short headline — `occ` 0.6324,
  `LER` 0.0000, clauses C and D **pass**; material ground, same copy — `occ` 0.0106, `LER` 0.5259, clauses C and
  D **fire**.*
- Record that **no prompt changed, no tool version bumped, and `copyAttempt` is still 0.181.**
- Record the two standing findings this phase does not fix: the `.ground` tonal wash (Part 8 item 4) and the
  cell-aliasing sensitivity of `nonGroundMean` on any periodic ground (§3.1), which is the general form of the
  decoration-phase fragility `floor-today` found and which the Ground Rule makes unreachable for bundled
  templates but not for Template Studio.

---

# Part 10 - OPEN, MEASURED, AND BLOCKING MERGE

Added 2026-09-14 after the gate-zero sweep was run for the first time (Part 2 addendum). **This branch is not
mergeable as it stands**, and the reason is not that the work is unfinished in the abstract — it is that seven
named assertions are red on real pixels and each one is a §5.6 decision-rule-2 result: *the first remedy is the
template, and the constant does not move.* None of them can be closed by touching a threshold, and none of them
is closed here.

| # | what is red | measured | rule |
|---|---|---|---|
| 1 | `headline_focus` accepted as a cover — clause E silent | `iod` **32.5–41.3%** vs a 0.10 floor, all 6 combinations | Part 8 item 2. A filled plinth necessarily carries clause E (§5.0's structural fact). **Editorial decision owed to RFC-14/17**, not a code fix. |
| 2 | `slide.html` over the interior ceiling | `LER` up to **0.2944** vs 0.28, **10 of 19 rows** | rule 2 — template |
| 3 | `closer.html` over the closer ceiling | `LER` **0.2278** vs 0.22, short copy, and again in Hebrew | rule 2 — template |
| 4 | `stat-callout.html` over the interior ceiling | `LER` **0.2750–0.2889** vs 0.28 | rule 2 — template |
| 5 | `headline_focus` over the MARGIN-adjusted interior ceiling | 7 of 18 rows over 0.20 (= 0.28 − `CALIBRATION_MARGIN`) | rule 2 — template |
| 6 | G2 — a template paints on a plate with no content | `cover.html` empty measures `flat` 0.9374, not 1.0000 | Ground Rule (b) — an unguarded layer |
| 7 | G5 — marks close the hole | the grey screen at max mark load measures a **22.78%** rectangle | painted `block` marks land in `graphicShare`; §5.7 anticipated this and the guard is doing its job |

Plus one that is not a template failure: a 1×1 **transparent** hero on `slide.html` measures `iod` **0.3707**
against an assertion of ≤0.027, i.e. the prep defect is no longer caught by that case. That is a fixture whose
premise moved, and it needs re-arguing rather than re-numbering.

**Every failing rectangle in rows 2–5 is at `y = 0`, full width, 328–424px tall** — the band between the top of
the plate and the first content, on archetypes whose eyebrow slot is empty in the fixture. That is one defect with
four faces, and it wants one composition answer, not four. Naming it here so the next phase starts from the shape
rather than from the symptoms.

---

# Part 11 — THE CUT, 2026-09-14: what shipped, what was cut, and the one finding that forced it

**Provenance, first, because it is what makes this part trustworthy.** Parts 1–10 are `MEASURED-HERE` (hand-painted
plates through the real `measureSlidePng`) and `MEASURED-EDGE` (the system Edge channel on the authoring machine).
Everything in Part 11 is a **CI RENDER** — runs [34800700580](https://github.com/Karos-Labs/agent-engine/actions/runs/34800700580)
and [34802291959](https://github.com/Karos-Labs/agent-engine/actions/runs/34802291959), on the binary CI actually
uses. §2's standing caveat says CI is the only authority for a pixel claim. It exercised that authority and
falsified three of this document's conclusions. Where Part 11 and any earlier part disagree, **Part 11 wins.**

## 11.1 THE FINDING: a decoration was being counted as the device whose absence clause E detects

`.hf-plate` — the plinth §5.3 introduced to make "how much was written" measurable as area — was built to be
`covered && distinct <= 3`. Its own comment said so approvingly: *"every cell stays COVERED … the card stays in the
`graphic` bucket."*

`slide-metrics.ts:906` is `const isGraphic = covered && !isImagery && distinct <= GRAPHIC_MAX_DISTINCT_COLOURS`,
and `imageryOrDeviceShare = imageryShare + graphicShare`. **That is not a description of a side effect; it is the
literal definition of the metric clause E reads.** The plinth was therefore, by construction, indistinguishable
from a photograph or a drawn device to the one clause whose entire job is to notice that a plate has neither.

Measured on CI, one object disarmed four clauses at once:

| clause | constant | what the card measured, on plates carrying NO imagery and NO device |
|---|---|---|
| **E `no-device`** | `IMAGERY_OR_DEVICE_FLOOR` 0.10 | `iod` **32.0–51.4%** — 3–5× over. `headline_focus` was **ACCEPTED as a cover** at every type scale on both grounds, and `default:cover-carries-device` lost its pixel teeth. |
| **D, first limb** | `FLAT_BACKGROUND_CEILING` 0.70 | `flat` **48.5–65.4%** on plates that are 92–97% bare ground. The limb cannot fire on a plate wearing the card. |
| **F `text-wall`** | `TEXT_SHARE_CEILING` 0.55 | `textShare` **1.0–1.8%**, down from ~33%: the card swallows its own type into `graphicShare`. |
| **B `clipped`** | `CLIPPED_EDGE_SHARE_CEILING` | at `fontScale l` the card still won `backgroundHex`'s modal vote, re-labelled the real ground as ink, and **false-fired**. |

It also took the 1×1 **transparent-hero** fixture — the prep defect with no symptom — to `iod` **37.2%** against a
guard expecting under 3.5%, because `onerror` empties `.bg` and the heroless card then paints.

**THIS IS A CLASS OF DEFECT, NOT AN INCIDENT, AND IT IS THE SECOND TIME IT HAS BITTEN THIS PROJECT: any
full-frame painted layer that a plate has not earned will be scored by some clause as the evidence that clause was
built to look for — the hatch was scored as type (clause F, `textShare` 0.6132) and the plinth was scored as a
drawn device (clause E, `iod` up to 0.514) — so a new painted panel is a change to the INSTRUMENT and must be
measured against every share before it is measured against the eye.**

§5.2 deleted `.copy-art` because it "disarms clauses C, D and G and trips F as a false positive". The plinth that
replaced it disarms B, D, E and F. The mechanism is identical — a large unearned painted area — and the phase
walked into it because it was measuring the card's *contribution to occupancy* and never its contribution to
`graphicShare`. **The next painted panel will be added by someone who never read this PR. This paragraph is what
they need to hit first.**

**It is not repairable by choosing a different percentage, and that is a proof rather than a measurement.** §5.0's
own structural fact is that `imageryOrDeviceShare ⊆ contentOccupiedShare ⊆ occupiedShare`, cell for cell. So:

- a fill at or over `tol.ink` = **18** units is `covered`, therefore `graphic`, therefore clause E;
- a fill under `FLAT_TOL` = **12** is invisible to every share, and to the eye it is paper tooth;
- the 12–18 band between them is closed by `MATERIAL_PEAK_DELTA`'s own note, because it takes
  `flatBackgroundShare` under 0.70 and disarms clause D on every plate that wears it.

**There is no plinth that pays clause D without disarming clause E.** Any future painted panel behind copy meets
this paragraph first.

## 11.2 What the sweep then said, with the card gone

160 rows, 8 archetypes × 3 copy lengths × 3 type scales × {en ltr, he rtl}, plus 8 neglected controls.
**NEGLECTED ceiling `occ` 0.0562.**

| role | POPULATED min `occ` | n | §5.6 rule branch |
|---|---|---|---|
| cover | 0.2670 | 19 | **1** — bands separate; midpoint **0.16** |
| closer | 0.5722 | 19 | **1** — bands separate; midpoint **0.31** |
| interior | **0.0383** | 114 | **none** — the minimum is *below* the neglected ceiling |

The interior minimum is not a panel archetype: `stat-callout`, `quote-card`, `comparison-card` and
`list-takeaway` measure 0.31–0.61 and are indifferent to all of this. It is `headline_focus` (0.0544–0.1252) and
heroless `slide.html` (0.0383–0.0942), at `flat` 0.92–0.97. The grey screen carrying its maximum mark load sits at
**0.0864 — inside their composed band.**

> **Stated as plainly as it can be: two of our eight archetypes ARE the mostly-grey screen the owner complained
> about, and the decoration was hiding that from our own gate.** Composed to the Ground Rule with nothing painted
> on them they are type on ground and nothing else, and no occupancy floor can separate them from a neglected
> plate because there is nothing to separate. They do not need a better background. They need something on them.

## 11.3 THE CUT

**SHIPPED.** The material ground (§5.1, proven inert on a real A/B render), the kind-aware ring (Part 6), the
Ground-Rule furniture guards on `stat-callout`, `comparison-card`, `cover` and `closer`, the four panel
archetypes, and two re-calibrations with CI bands behind them:

| constant | was | **now** | provenance |
|---|---|---|---|
| `OCCUPIED_SHARE_FLOOR.cover` | 0.42 | **0.18** | CI, 19 rows, POPULATED 0.2670–0.3517 vs NEGLECTED 0.0562. Rule-1 midpoint is **0.16**; 0.18 is kept **deliberately above it**. A constant taken above its own decision rule's answer refuses strictly more than the rule requires, so it cannot be a bar moved to make something green. 1.48× / 4.75×. |
| `OCCUPIED_SHARE_FLOOR.closer` | 0.42 | **0.31** | CI, 19 rows, POPULATED 0.5722–0.6681. Rule-1 literal, and **stricter** than the 0.30 this branch proposed off Edge numbers. 1.85×. |

**CUT.** `OCCUPIED_SHARE_FLOOR.interior` stays at **0.30**. Its 0.19 was the midpoint of a band whose lower wall
was the plinth's own area, which is §3.2's circularity objection to Spec B turning up inside Spec A.

**CUT.** `headline_focus` and heroless `slide.html` are **untouched by this PR** — their existing paint, their
existing floor. Not because their screens are defensible (§5.2's measurements stand) but because deleting them
without giving those plates something to carry refuses them in production: a false refusal costs a **$0.181**
drafting attempt out of three against **$0.0017** of headroom on the $1.00 target. *A partial ship that makes live
runs more expensive is worse than a smaller one.*

**REFUSED.** §5.6 rule 3's demotion — see the box beside the rule itself. G5 measures the marked grey screen at
`LER` 0.2278 against a 0.28 ceiling, so clause C does **not** carry the refusal and clause D's occupancy limb is
the only thing standing between the owner's complaint and the gate.

## 11.4 THE FOLLOW-UP — costed, and the real fix

**`headline_focus` and heroless `slide.html` get a real bounded OBJECT derived from their own copy.** Not more
ground. §5.5's `coverRemedy` already builds exactly this: `deviceFromText` reads the strongest `kind: "stat"` fact
card with a deterministic regex over copy the run already holds. **$0.00, no model call, no prompt string changes**
— the same cost profile as this whole phase.

It is also what the reference plates do, and §4 recorded it without following it: rf-05's near-empty cover carries
one stitched photograph and nothing else; rf-11's statement slide carries ten saturated highlighter blocks. **The
reference execution is an object on a quiet ground. We took the quiet ground and skipped the object.**

Scope, so the next phase starts costed rather than from scratch:

1. Extend the `dead-space` remedy's cover limb (§5.5) to the **interior** role for the two statement archetypes.
2. A plate whose copy carries no figure gets the eyebrow-rail plinth fallback, and a plate with neither **fails
   clause C, correctly** — that is the floor discriminating, not a regression.
3. Only then delete `.copy-art` from both files, and only in the same PR as the object.
4. Re-run the gate-zero sweep and set `OCCUPIED_SHARE_FLOOR.interior` from the band it prints — **from CI, and from
   a tree where the populated rows are objects rather than decoration.**
5. Remove `groundMaterialCssBlock`'s `body:not(:has(.copy-art))` guard, which exists only because those two files
   still carry a screen (§11.6), and re-run the A/B case at its unchanged 0.0005 bound.

### The guards that travelled out of PR #114 with this work, by name

**They were not deleted. They are travelling.** Each one renders `headline_focus` or heroless `slide.html` as its
subject, so on the cut tree each was a red light with nothing behind it. Every one comes back **unweakened —
that is the only way any of them may come back** — in the same PR as the bounded object:

| test | file | what it holds | its value on the cut tree |
|---|---|---|---|
| `G1 — the owner's grey screen is REFUSED at the interior AND cover roles, on either ground` | `interest-floor-calibration.test.ts` | **the phase's acceptance condition** | RED: `occ` 0.5090, `LER` 0.0778 — the grey screen PASSES |
| `G2 — every bundled archetype with every copy slot empty measures as EMPTY, on either ground and in both directions` | `interest-floor-calibration.test.ts` | the Ground Rule made executable | RED on the restored screens |
| `G5 — the grey screen carrying its maximum mark load still fails clause C` | `interest-floor-calibration.test.ts` | marks must not close the hole | RED: rectangle 3.33% |
| `G5: the grey screen carrying the MAXIMUM mark load still fails clause C` | `interest-floor-marks.test.ts` | the same guard on the paper-ground ring | RED: `LER` 0.0889 |
| `the ground material moves no share on a real archetype render` | `interest-floor-calibration.test.ts` | the material is inert | RED over a hatch: `flat` 0.123 points vs a 0.0005 bound |

The **gate-zero sweep** keeps running and keeps rendering all eight archetypes — a render that degrades one
archetype into another is a real failure and that check is untouched — but it no longer SCORES the two cut files in
either band (`OUT_OF_SCOPE` in that file). Scoring them would make both bands dishonest in the same direction:
their POPULATED occupancy is their hatch rather than their copy, which is the circularity §3.2 rejects Spec B for,
and their NEGLECTED row is the grey screen that currently passes. **Both bands, and `OCCUPIED_SHARE_FLOOR.interior`
with them, are re-derived when the two files come back — never inherited.**

## 11.5 Still open, all named, none of them guessed at

1. **`stat-callout.html`**, `LER` 0.2750 at `en ltr short s`, rectangle `(0,0 → 1080,340)` — over the sweep's 1.15×
   margin, under the 0.28 ceiling. Exposed by this branch's own `.sc-rail` guard: the rail used to break the top
   band on every render, including empty ones, and now that it is content-guarded a fixture with no eyebrow leaves
   the band whole. The guard is right; the composition owes the top of the plate something.
2. **`closer.html`**, `LER` 0.2278 (en) / 0.2306 (he), rectangle `(0,0 → 1080,328/332)` — genuinely over the 0.22
   closer ceiling.
3. **G2, `cover.html` with every copy slot empty**: `occ` **0.06%**, `LER` **51.67%**. The occupancy limb passes;
   the rectangle limb does not. 0.06% is ≈58 cells of 97,200, and 51.67% is the algebraic signature of a handful of
   cells near the plate's mid-line — one obstruction at the centroid halves the largest empty rectangle. It is the
   same shape `.stat-band` produced on `stat-callout` before it was guarded. **Naming the element needs one render
   with a cell map; it is not guessed at here.**
4. **`closer.html`'s `#takeaway` plinth is the same object as `.hf-plate`** and has not been re-examined against
   §11.1. The closer clears clause E on its recap strip and ask band regardless, so no guard is currently blind —
   but its `occ` band of 0.5722–0.6681, which `OCCUPIED_SHARE_FLOOR.closer = 0.31` is derived from, **includes the
   plinth's area.** If a later pass removes it, 0.31 must be re-derived from a fresh sweep and not inherited.

Every failing rectangle in 1 and 2 is at `y = 0`, full width, 328–340px tall: the band between the top of the plate
and the first content, on archetypes whose eyebrow slot is empty in the fixture. One defect, two faces, one
composition answer — which is the same answer §11.4 gives the statement archetypes.

## 11.6 THE COST OF THE CUT, MEASURED — CI 34804038775

The cut was pushed and rendered. **12 failures, and the headline one is this phase's own acceptance condition:**

```
G1 — THE OWNER'S GREY SCREEN PASSED THE FLOOR at the interior role on the grid ground
     occ 0.5090, LER 0.0778, COCC 0.3301, ink 0.2142
```

With `headline_focus` reverted its hatch is back, and the hatch is what makes a one-line grey screen measure `occ`
0.51 and `LER` 0.078. G5 measures the marked grey screen's rectangle at **3.33%**; G2 fails on the restored
screens. **This is not a regression the cut introduced — it is `main`'s behaviour, which is exactly what "keep
today's behaviour" means.** It still has to be written down in one sentence: *as cut, this phase ships no pixel
proof about the owner's original complaint, because every such proof is a test of the two archetypes it cut.*

One finding is new. The material-ground A/B case reports **`flatBackgroundShare` moving 0.123 points** (0.79617
against 0.79740, bound 0.0005) when `groundMaterialCssBlock` is spliced in. The material is inert on the six
shipped archetypes and **NOT inert over `.copy-art`'s hatch** — the same boundary-tipping mechanism §5.1a already
recorded for `iod` on a flat fill, now on the flatness limb. **The bound was not widened.** So the material sheet
either has to be withheld from the two cut templates, or those templates come along.

**The decision this leaves open, stated for the owner rather than taken here.** G1, G2, G5 and the A/B case are
new in this branch and were written to prove the two cut archetypes were fixed. Either those archetypes come back
into scope and get their bounded object (§11.4), or those four guards leave the PR with the work they test. **They
cannot be made green on a tree that keeps the hatch, and they must not be weakened to try.** Cutting a guard
alongside the feature it tests is coherent; cutting it alone is not.

## 11.7 THE SWEEP RE-RUN ON THE SHIPPED TREE — CI 34805932618

The bands in §11.2 were measured with `headline_focus` and heroless `slide.html` still in both bands. With those
two held out (`OUT_OF_SCOPE`) the sweep is re-run over what actually ships, and the numbers move. **These are the
provenance for the two constants this phase changes; §11.2's are the provenance for the CUT.**

```
NEGLECTED ceiling: occ 0.0024  COCC 0.0024  (over 6 controls, all empty-slot renders)
cover     POPULATED n= 19  min occ 0.2670 (floor 0.18, 1.48x)  max LER 0.1469 (ceiling 0.22, 1.50x)
          -> RULE 1 - bands separate; midpoint 0.13
closer    POPULATED n= 19  min occ 0.5722 (floor 0.31, 1.85x)  max LER 0.2028 (ceiling 0.22, 1.08x)
          -> RULE 1 - bands separate; midpoint 0.28
interior  POPULATED n= 76  min occ 0.2857 (floor 0.30, 0.95x)  max LER 0.2889 (ceiling 0.28, 0.97x)
          -> RULE 2 - the FIRST remedy is the TEMPLATE
```

**Both shipped constants are now MORE conservative than the rule's own answer, not less**: `cover` 0.18 against a
midpoint of 0.13, `closer` 0.31 against 0.28. The earlier "0.31 is the rule-1 literal" was true of the sweep that
included the cut archetypes as controls; on the shipped control set it is one rung stricter, which is the safe
direction and is why it is not moved down to match.

**And one finding that is new, and belongs to whoever merges this.** At `interior` = 0.30 the lowest composed row
on a SHIPPED archetype is `comparison-card` at `en ltr short s`, **occ 0.2857 — 0.95x the floor.** Clause D is a
conjunction and that plate measures `flat` 0.6592, under `FLAT_BACKGROUND_CEILING` 0.70, so **the occupancy limb is
never reached and no live run is refused for this.** But the sweep's 1.15x gate is not met, and by §5.6 rule 2 that
is a TEMPLATE finding on `comparison-card` rather than a reason to move 0.30. It is latent behind the
`stat-callout` rectangle failure in the same loop and will surface the moment that one is fixed. **0.30 is the
value the tree shipped with and it is not moved here; the plate is the bug.**

## 11.8 THE RULE, GENERALISED — and it reaches every archetype

The `(0,0)` rectangles were never introduced by this phase. **The holes were always there; the deleted screens
were painting over them.** That is the fourth instance of one sentence in one phase — the hatch, the plinth, the
two statement archetypes, and now the panels — so it stops being a case list and becomes the rule:

> **An archetype gets the material ground only when its own composition clears the floor without paint. Any plate
> with an unearned hole keeps today's behaviour, byte-identical to `origin/main`, and comes back with §11.4.**

Applied to all eight on CI renders, it reaches all eight:

| archetype | why it keeps today's behaviour | measured |
|---|---|---|
| `headline-focus` | composes below a neglected plate | `occ` 0.0544–0.1252 at `flat` 0.92–0.97 vs a 0.0562 control |
| `slide` (heroless) | same | `occ` 0.0383–0.0942, `LER` up to 0.3750 |
| `stat-callout` | unearned hole at `(0,0)` | `LER` **0.2750**, rect `(0,0 → 1080,340)` |
| `closer` | unearned hole at `(0,0)` | `LER` **0.2278** (en) / **0.2306** (he) |
| `comparison-card` | under its floor once its furniture is guarded | `occ` **0.2857**, 0.95× |
| `cover` | **changes** — composition clears at `LER` 0.0750–0.1469 | its open item is the G2 cell map (§11.5) |
| `quote-card`, `list-takeaway` | clear without paint | `LER` 0.0667–0.1778 |

That leaves `quote-card` and `list-takeaway` as the only plates the material could mount on. **A material ground
that ships on two plates because those two happen not to have a hole yet is not a material ground, it is a
coincidence.** So it ships nowhere: `GROUND_MATERIAL_MOUNTED = false` in `ground-material.ts`, one flag in one
place rather than a per-template list that rots, with the rule in its doc comment.

**Nothing about the material is deleted or weakened.** `groundMaterialPlan`, `groundMaterialCssBlock` and their
nineteen Chromium-free guards all run and all pass, and the three call sites keep their plumbing so the mount is
proven wiring rather than unwritten code. `ground-fg-inversion.test.ts` mirrors the flag rather than dropping its
assertion, so flipping it restores the check in the same commit that restores the behaviour.

**And `OCCUPIED_SHARE_FLOOR.closer` goes back to 0.42 with its plate.** 0.31 was derived from 19 CI rows off a
`closer.html` this PR no longer changes, and a constant re-derived from a plate that left has no business moving.
Its band is recorded for §11.4 (POPULATED 0.5722–0.6681, NEGLECTED ceiling 0.0024, rule-1 midpoint 0.28) and
re-derived there, not inherited. That also retires the `#takeaway`-plinth trap: the plinth left with the file.

**`cover` 0.18 is the one constant this phase moves, and it is deliberately stricter than its own derivation** —
rule 1's answer is 0.13, and a constant set above the rule that derived it refuses strictly more than the rule
requires, so it cannot be a bar moved to make something green. The visible cost of that choice is 1.48× of
headroom instead of 2.05×. At 0.42 all 19 rendered cover rows were falsely refused.

### What this leaves, and it is not nothing

**The kind-aware mark ring (Part 6) is the user-visible change in this PR and it stands entirely on its own.** On
a paper kit it takes brand colours from **3/16 admitted to 15/16**, and block-capable from **1/16 to 13/16** —
the saturated-highlighter class every reference plate is built on, unreachable until now because the ring culled
on "far from the paper" and then asked `block` for "far from the ink", which are opposite directions on one
luminance axis. **No constant moves for it**; it is a change of quantifier. On the bundled dark kit it is inert
(15/16 → 15/16, block 0/16 → 0/16), so nothing we run today changes shape.

### The cases that travelled out with the templates, by name

Added to §11.4's table. Same terms: **not deleted, returning unweakened, in the same PR as the work.**

| case | file | what it holds |
|---|---|---|
| `the full-bleed screens RFC-20 §5.2 deleted do not paint again` | `template-mark-slots.test.ts` | `.copy-art` ×2 and `.cl-art` stay deleted |
| `the two panel archetypes withhold their standing furniture from an empty plate` | `template-mark-slots.test.ts` | five rows: `.sc-rail`/`.eyebrow`, `.stat-band`/`#figure`, `.cmp-rail`/`.eyebrow`, `.cmp-rule`/`.cmp-label`, `.cmp-col`/`.cmp-label` |

The second is **removed, not left looping over an empty table** — an empty loop passes, and a green case that
asserts nothing is the same defect as a guard left behind testing work that is not there.
