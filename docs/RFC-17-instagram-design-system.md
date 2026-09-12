# RFC-17 - Instagram agent: marked emphasis (Phase 5)

Status: specced. Follows RFC-13 (Phase 0/1, #84/#94), RFC-14 (Phase 2/3, #107/#108), RFC-15 (Phase 4, #109)
and RFC-16 (#110), all merged to main and deployed to prep.
Amends RFC-14 items L and N. Worktree `C:\Users\1\Documents\KarosLabs\agent-engine-igdesign`,
branch `feat/instagram-design-system`, cut from `origin/main` @ 4364b1a. Files are CRLF.

Driven by the owner's reference accounts, supplied as ground truth for what good looks like after Phase 2
answered the boring-template complaint with eight painted grounds.

---

# Part 1 - Brief

## The complaint this phase still serves

The owner's original words, unchanged since RFC-14 quoted them:

> *"צריך ליצור טמפלייטים אבל יש גם טמפלייטים משעממים, למשל בKAROS LABS אתה רואה מסך אפור ברובו, אלה פוסטים
> שאנשים לא ירצו. בנוסף בגלל שזה חזרתי זה נראה AI."*

Two halves. **A mostly-grey slide is a defect nobody saves**, and **repetition is what reads as machine-made.**
Phase 2 answered the first with a pixel interest floor that refuses an empty plate, and the second by giving
each of eight archetypes a different KIND of painted ground. The floor works. The eight grounds were the right
instinct aimed at the wrong axis, and the reference accounts show where the axis actually is.

## THE TOPIC RULE, WHICH OVERRIDES EVERY OTHER RULE IN THIS DOCUMENT

**Reference EXECUTION transfers. Reference SUBJECT MATTER never does.**

Every reference account in this survey posts about AI, design, or marketing. What this RFC takes from them is
*how a slide is made*: that emphasis is marked per word and rotates, that a block sits low over the baseline,
that one mark may span a line break, that a dark ground inverts the mechanism into the glyphs. What it must
never take is *what a slide is about*.

A client that does not do AI must never inherit an AI topic. A client that does not do marketing must never
inherit a marketing topic. Client topics come from the client's own `ClientBrief` and the five topic engines
(RFC-13), and nothing in this phase touches topic selection, angle selection, or the research query. **A
beautiful post about something the client does not do is the original audit failure repeating with better
typography**, and it would be a worse failure than the grey screen because it would look deliberate.

This rule is load-bearing on the prompt bump in particular: `instagram-copy@17` §24 tells the model which
words to mark in copy **it has already written**. It must not, anywhere, give the model a subject. The
prompt text carries that sentence explicitly (§5.3), and the §24 review checklist is the place to enforce it.

## Binding owner decisions, carried forward

- **Run cost: target $1.00, hard max $1.50. NO OPUS IN A RUN.** Setup is separate and amortised: target $2.00
  per client, hard max $3.00. Every new model step justifies its cost in a comment beside it.
- **Budgets adapt, never hold.** Estimate before the first paid call, adapt the plan, past target drop optional
  work, past the hard max finish on the cheapest complete path and DELIVER. `completed`, at worst `degraded`
  with a reason. Never `held` or `failed` for budget. Every emphasis failure in this phase degrades to plain
  type and is reported as a fact; none of them can hold a run.
- Harvesting is ScrappyCoco only. No Apify, no new vendor.
- Engine-native: agents via `wf.step.agent`, typed zod tools under `packages/tools/*`, deterministic
  orchestration in `wf.step.code`.
- **Hebrew is first-class** (client `geektime`). Every change here holds in RTL and in the Phase 0 script
  fonts, and Phase 4's bidi isolation for Latin runs inside Hebrew must not regress.

---

# Part 2 - Adjudication

Two architects specced this independently: **Spec A (emphasis-first)** and **Spec B (material-and-composition)**.
I read the reference pixels myself and re-read every code path the two disagreed on. Nine findings decided the
shape of this document.

| # | Claim under test | Verdict | Evidence |
|---|---|---|---|
| 1 | The ground should become a photographed material, and the eight painted grounds should collapse into one (B's spine) | **REFUSED — it breaks clause E on cover and closer, and B never addresses it.** `IMAGERY_OR_DEVICE_FLOOR`'s own calibration comment records `cover, colour field, no hero` at **26.9%** and states that a photoless cover clears the floor at **18.0-20.8%** and that *"that figure is now a constant of the template"*. That constant IS `.cov-field`; the closer's 18.2-21.9% IS `.cl-art`. B deletes both and replaces them with a material B itself proves is **sub-ink** (σ≤6 → `occupiedShare` 0.0000, `flatBackgroundShare` 0.9988). A sub-ink ground contributes nothing to `imageryOrDeviceShare`, so every photoless cover and every closer falls into the type-only band (0.2-7.0%) and **clause E refuses all of them at the 0.10 floor.** The same comment's own warning — *"any change that makes a type-only plate's GROUND cover more of a measurement cell"* — is the opposite direction from the one B moves in. | `interest-floor.ts:540-660` |
| 2 | A dark ground can carry a highlighter block | **FALSE, and this is the observation the whole design turns on.** I read `rf-6/slide-01.jpg`: its ground is near-black and it carries **no mark behind any word at all** — the emphasis is a yellow→orange gradient *in the glyphs* of `FOLDABLE` and `DUOLINGO JUST JUMPED IN`. Our default ground is `#17181C`. A pastel block behind near-white ink is illegible, and the reference set already shows the correct dark-ground answer. **Mark kind must be computed from ground luminance in code.** B lets the copy model choose `kind` from a three-value enum with no knowledge of the ground; that is a model choosing an illegibility. A's code-chosen kind is adopted. | `refs/rf-6/slide-01.jpg`; `brand-render-tokens.ts:838` |
| 3 | Wrapping copy in `<span>`s is free | **FALSE — A caught a real regression, B missed it entirely.** `probePage` counts a text-bearing leaf as *an element with words and no element children* (`element.children.length === 0 && text !== ""`). `<h1 class="headline">Plot <span>twist</span>.</h1>` makes the `h1` a non-leaf: its box stops counting toward `textBoxShare` (clause G limb 2, floor 0.01) and its family stops entering `fontFamiliesUsed` (the only proof a script font loaded). **Mitigation is mandatory and shapes the fragment: every run is wrapped, marked or not**, so every text node stays inside a leaf. | `render-carousel.ts:455-462` |
| 4 | `imageryOrDeviceShare / contentOccupiedShare` separates deliberate emptiness from neglect (the-floor looker's candidate, carried by A) | **FALSIFIED by B's controls, and B is right.** On real PNGs at 1080x1440 scale 2 the deliberate near-empty plate reads 0.72 and the dense list 0.74 — but the **decorated grey screen reads 2.2**, scoring better than both good plates. The ratio measures "how much of this plate is drawn in solid areas", and a full-frame decoration is nothing but solid area. **The candidate is dead.** This is the single most valuable thing either spec produced and it is why §3 rules as it does. | Spec B §0.1 controls |
| 5 | `markColourCount ≥ 3` can gate (B's clause H) | **REFUSED, on B's own evidence.** B's control **B2** — the owner's grey screen with two marks stuck on it — scores 2, and a third mark takes it to 3. A clause whose floor is one mark above the defect it exists to catch is not a gate. Worse, B admits the metric reads **434 on rf-08's photo** and **71 on rf-05's cover**, and that scoping by text-adjacency does not fix it (434 → 434). And the band has never been swept on real Chromium renders across 8 archetypes x 3 scales x LTR/RTL — `IMAGERY_OR_DEVICE_FLOOR` took **six documented calibration passes** before it was trusted. **Ships as a warning.** | Spec B §0.1-0.2; `interest-floor.ts:338-657` |
| 6 | Character offsets are a usable contract for spans | **FALSE — both specs agree, and they are right.** `iso()` inserts U+2068/U+2069 into every rendered prose field on an RTL run, two characters per foreign run, so any offset authored against the model's original string is wrong by the time it reaches the document. The Phase 4 native editor also rewrites copy after drafting. **Verbatim substrings, located by code.** | `bidi-isolate.ts:25-38`; `slides-data.ts:1012` |
| 7 | The mark colour may be chosen by a model or an art director | **FALSE.** A palette invented outside the accent ring is filtered by `filterLearnedStyleToRing` and then fails `checkPaletteWithinKit` three attempts later — a recorded $0.30 hold for nothing. **The ring is derived in code from the accent ring the kit already produces**, which is also why setup cost is exactly $0.00. Both specs reached this; A's accent-exclusion rule (a mark colour indistinguishable from accent furniture would make `markColourCount` a guard that cannot fail) is the better version and is adopted. | `brand-render-tokens.ts:657-672` |
| 8 | The expected ink colour can be inferred from the pixels | **FALSE — B measured it and B is right.** On control B the inferred-ink path picked the decoration's tint and reported a ground/ink contrast of **2.54** for a plate whose real contrast is **15.84**. `MeasureSlideExpectations` gains `ink`, supplied from the template's `--fg`, for the same reason `ground` is supplied rather than guessed. **Grafted from B.** | Spec B §3.5 |
| 9 | A straight slot swap is safe | **FALSE.** `fillTemplate` erases any slot nobody filled. A run resumed across a deploy — which has happened on this project — carries checkpointed slides data with no `*Runs` fragment, and a straight swap renders an **empty headline**. **Twin slots**: the plain field is always emitted and always the fallback, collapsed by `:has()` when the runs fragment is present. Costs two elements; also keeps `fields` byte-identical for `proseFieldsOf` / `contentElementCount` / the dedupe corpus / the reviewer's editable view. | `render-carousel.ts:216`; `slide.html:66-71` |

## Ruling

**Spec A is the spine.** It is the only one of the two whose spine survives contact with `interest-floor.ts`
(finding 1), it is the only one that caught the `probePage` regression its own design creates (finding 3), and
its emphasis system is the more complete of the two on the axis that matters — mark kind chosen from ground
luminance, which finding 2 shows is the difference between a legible dark-ground mark and an invisible one.

**Four things are grafted from B, and B is better on each:** the falsification of the ratio discriminator
(finding 4), which sets the emptiness ruling; the `markedShare` / `markColourCount` metric *definition*, whose
flat-cell and off-ink limbs are what reject antialiased glyph fringes (A's "within tolerance of an expected
hex" does not); the supplied `ink` token (finding 8); and B's observation in §3 below that our closer is
structurally not their closer.

**Two things B built are refused and recorded rather than adopted**: the material ground (finding 1) and
clause H (finding 5).

**Where they disagree on scope, one line each:**
- *Kind chosen by code vs by the model* → **code**, because the model cannot see the ground and rf-6 proves the
  ground decides (finding 2).
- *Eight grounds kept vs collapsed to one material* → **kept**, because the fields are load-bearing in clause
  E's calibration and the material is invisible to it (finding 1).
- *Composition: alignment only vs alignment + vertical migration* → **alignment only**, because vertical
  migration moves the type block relative to a fixed painted field and re-opens the clause E band; alignment
  reuses `ta-*` classes every template already has and needs zero template edits.
- *Emphasis gated on pixels vs on the DOM* → **the DOM gates, the pixels warn**, because the DOM limb cannot
  falsely refuse a Template Studio template that has no `*Runs` slot, and the pixel band is unswept.

---

# Part 3 - THE RULING ON DELIBERATE EMPTINESS

**The floor is untouched. No threshold moves. No exemption is added. Not one constant in `interest-floor.ts`
changes value.**

`LARGEST_EMPTY_RECT_CEILING`, `OCCUPIED_SHARE_FLOOR`, `CONTENT_OCCUPIED_SHARE_FLOOR`, `IMAGERY_OR_DEVICE_FLOOR`,
`FLAT_BACKGROUND_CEILING`, `TEXT_SHARE_CEILING`, `INK_SHARE_FLOOR`, `CLIPPED_EDGE_SHARE_CEILING` and
`FULL_BLEED_IMAGERY_SHARE` all keep the values they have on main.

## 3.1 The honest answer to the question I was asked

I was asked to find the measurable difference between "empty with one perfect line" and "empty because nothing
was said", and told plainly that if I could not find one I should say so and leave the floor alone.

**I did not find one. I am saying so.**

Two candidates were tested and both failed:

**Candidate 1 — `imageryOrDeviceShare / contentOccupiedShare`.** This looked genuinely strong on the reference
JPEGs: 0.022 on the audit's real karoslabs grey screen against 0.456 on rf-05 S8, a ~20x separation on two
numbers already on the wire. It **does not survive controls.** Re-measured on real PNGs at 1080x1440 scale 2
through a faithful re-implementation of `measureSlidePng`, the deliberate near-empty plate reads 0.72 and the
dense list 0.74 — but the **owner's grey screen with a Phase-2 decoration over it reads 2.2**, better than
both. The ratio measures how much of a plate is drawn in solid areas; a full-frame decoration is nothing but
solid area. It is not a deliberateness measure, and the JPEG numbers that made it look like one were an
artefact of measuring a decorated plate against an undecorated one.

**Candidate 2 — `contentBox` / content span share.** On clean synthetics it separates beautifully (deliberate
0.86, stranded caption 0.24). On the *real* reference paper it reads **1.00 on every plate**, because the
photographed vignette and page curl darken isolated corner cells and the bounding box snaps to the full canvas.

**A third, `markColourCount`, separates something real but not this.** Grey screen 0, decorated grey screen 1,
both good plates 4. It is causal and I am shipping it — but it measures whether *emphasis rendered*, not
whether *composition was considered*, and the control that proves the difference is B2: the owner's grey screen
with two marks stuck on it scores 2, and a third mark takes it to 3. **A marked plate can still be a bad
plate.** Treating `markColourCount` as licence to admit an 82%-empty plate would be laundering a decoration
check into a composition verdict, and it is exactly the move the brief named as the one outcome that fails this
work.

## 3.2 Why the reference plate stays refused, and why that is correct rather than a concession

rf-05 S8 is refused by **four clauses independently**, not one — C (`dead-space`, 0.3077 vs 0.22), D (`empty`,
occupied 0.0963 vs 0.42), E (`no-device`, 0.0176 vs 0.10) and G (`empty`, content 0.0386 vs 0.09). Admitting it
is not a threshold tweak; it is a new rendering mode with its own four-clause calibration.

And **our closer is not their closer.** rf-05 S8 carries one display line and one two-line sentence. Our
`closer` archetype carries a takeaway, a question **and** a CTA, plus the recap strip — three blocks. A real
closer with our three blocks clears the floor comfortably. **We are not refusing a design we want; we are
refusing a design our renderer cannot currently emit.** No archetype we own can draw that plate. Admitting a
plate we cannot produce buys zero pixels and costs a weakened gate immediately.

## 3.3 What ships instead: five measurements, compared against nothing

All free — every one is a single accumulator away from data `measureSlidePng` already computes and discards, or
a field `probePage` already returns and nobody reads. They exist so the next phase decides with a band instead
of an argument.

| Metric | Source | Which half of "deliberate" it encodes |
|---|---|---|
| `contentCentroid {x,y}` | one pass over `cellInk` (`slide-metrics.ts:603,651`) | **optically placed** — rf-05 S8 centres at (0.498, 0.515); the grey screen at (0.281, 0.722) |
| `contentBBox {x,y,w,h}` | same pass | **one block, not scattered** |
| `groundInkContrast` | WCAG ratio from the 32,768-bin histogram already built at `:452` and collapsed to one integer at `:722`, using the **supplied** `ink` token | **high contrast** — references 17.5-18.0, our bundled pair 15.8 |
| `markedShare` / `markColourCount` | `cellInk` + `cellMeanRGB` + `cellStddev` + `colourCount`, all already computed | **the emphasis rendered at all** |
| `probe.elementCount` | already measured, read by **nobody** today | **few elements placed with intent** |

All five ship as a single reporting-only warning, `composition-evidence`, which prints them and gates on
nothing. **A warning cannot admit a grey screen.**

## 3.4 The experiment that would justify revisiting this

Stated now so a future phase cannot move the goalposts. Ship the five metrics reporting-only for one full
release. Collect the CI band across all eight archetypes x three type scales x LTR/RTL on **real Chromium PNGs
at scale 2**. Only then propose a `closer`-scoped rule of the form: `contentOccupiedShare` may fall to X **when**
`markColourCount ≥ 4` **and** the centroid is within 5% of a frame axis **and** `groundInkContrast ≥ 12` **and**
`elementCount < 40`. If the sweep does not reproduce that separation, the mode is not shippable and the floor
stays exactly as it is.

## 3.5 Three standing findings recorded, none acted on

1. **Our Phase-2 decorations disarm clauses C and D.** The decorated-empty plate measures `largestEmptyRectShare`
   **0.0148** and `occupiedShare` **0.4217**. B's grain sweep puts the cliff between σ=6 and σ=8 and measures
   our bundled dot screen at σ≥10 behaviour. **The owner's grey screen would pass clause C today as long as it
   carried a Phase-2 decoration.** Only clause G survives a decorated ground. This is the most serious open
   defect in the floor and it deserves its own phase — a sub-ink material would *re-arm* C and D, which is the
   one genuinely strong argument for B's ground and the reason finding 1 refuses it on clause E grounds rather
   than on merit.
2. **`FULL_BLEED_IMAGERY_SHARE = 0.50` does not cover a real full-bleed photo plate.** rf-08 measures
   `imageryOrDeviceShare` 0.4655 with `clippedEdgeShare` 0.0125, so clause B fires on a correct design. The
   constant reasons from a *synthetic* frame at 0.829. This is a measurement to redo, not a number to move.
3. **`OCCUPIED_SHARE_FLOOR` refuses the dense reference list too** (0.161 vs 0.30 interior), because the metric
   counts cells and small type occupies few. The "wall of text" and the "empty plate" measure the same on it.

---

# Part 4 - What the reference pixels actually do

I read `rf-05` slides 01, 03 and 08, `rf-11-terms/slide-01` and `rf-6/slide-01` directly. Five observations
shape the design; the rest is in the reference survey.

1. **Emphasis is marked per word, and a slide mixes kinds AND colours.** rf-05 S1 carries four marks in four
   colours and at least three kinds — a lilac block behind `Anti-AI`, a red pencil rule under `clients`, a cyan
   block behind `human,`, a green underline under `AI slop`. What never repeats is the colour of two
   *consecutive* marks. rf-11 cycles yellow → chartreuse → cyan → lilac down ten rows on the same rule.
2. **The block sits LOW.** On rf-11's `Business` / `Founder` / `Know` the swatch covers the baseline and
   roughly the lower 60% of the cap, with ascenders standing clear above it. This is not a centred
   `background-color`.
3. **One mark spans a line break.** rf-05 S3's chartreuse runs across `Messy,` at the end of line 1 and resumes
   on `crossed out` at the start of line 2. `box-decoration-break: clone` is the whole trick.
4. **A dark ground inverts the mechanism.** rf-6 has no mark behind any word; the emphasis is a yellow→orange
   gradient *in the glyphs*. **Our default ground is `#17181C`, so this is our case, not an exotic one.**
5. **The number is never marked.** rf-05 S3's `2- Handwritten notes` carries a pink swish under the words only,
   and the numeral is inline in the headline at headline size — never a badge, chip or pill.

---

# Part 5 - The design

## 5.1 The copy contract

`InstagramSlideCopySchema` (`types.ts:538`) gains **one** optional field. Nothing else changes shape, so every
existing gate, dedupe corpus, language judge and hygiene check keeps reading exactly the string it reads today.

```ts
export const EMPHASIS_FIELDS = ["headline", "body", "quote", "item"] as const;

export const SlideEmphasisSchema = z.array(z.object({
  field: z.enum(EMPHASIS_FIELDS),
  /** Required when `field` is "item"; the row this span is in. */
  itemIndex: z.number().int().min(0).max(3).optional(),
  /** The exact words to mark, copied verbatim out of the field. */
  text: z.string().min(2).max(48),
})).max(8);
```

Three things about this shape are load-bearing.

**Verbatim text, never offsets** (finding 6). A span that no longer occurs is DROPPED and reported, never
resolved to the wrong words.

**The field names are the COPY's own fields, never a template slot.** The model wrote `headline`/`body` and does
not know that `contentFor` routes `headline` to `title` on a cover and `takeaway` on a closer. That mapping
stays in one place, and a layout downgrade keeps the marks working.

**`.max(8)` in the schema, `MAX_MARKS_PER_SLIDE = 5` in code.** This follows the philosophy already written into
this schema's own doc comment — *furniture must never be able to reject a draft*. A ninth mark degrades; it does
not fail. B's hard `.max(5)` would fail an entire $0.171 draft over a sixth mark.

## 5.2 Resolution, the ring, and the kinds

**`emphasis-marks.ts` (NEW).** `resolveSlideMarks(field, text, declared, ctx)` is pure, deterministic and total:

1. **Bounded first occurrence** in the ORIGINAL string, before `iso()`. Bounded on both sides by a
   non-`\p{L}\p{N}` character or a string edge — without this, `"AI"` marks the middle of `"SAID"`, which is
   this rule's falsification test.
2. **Order by position, not by the model's array order**, or "consecutive marks differ" is meaningless.
3. **Drop** a span that overlaps an accepted one, exceeds 6 words, or takes total marked characters past **35%
   of the field** — a mark covering everything marks nothing.
4. **Cap** at 3 per field, 5 per slide.
5. **RTL foreign-run boundary rule, which protects Phase 4.** If a span boundary falls inside a foreign run as
   `bidi-isolate.ts`'s run pattern defines one, extend the span to the run's own boundary when it still fits,
   drop it otherwise. Without this, marking `Gemini` inside `Gemini 3` splits one foreign run across two spans,
   each isolated separately — precisely the `⁨API⁩ ⁨v2⁩` regression `bidi-isolate.ts:72-97` documents.
6. **Split** into alternating runs, then **isolate each run independently**, then `esc()` each. Isolating before
   splitting puts an FSI on one side of a span boundary and its PDI on the other.

**The mark ring — `buildMarkRing(tokens, groundHex, fgHex, accentHex)`.** Candidates are `brandAccent` +
`palette[]` (already in-kit), minus ground and fg. Then:

- **Accent exclusion.** Any candidate within `2 x MARK_TOL` (40, weighted RGB) of this slide's resolved accent
  is removed — if a mark colour is pixel-indistinguishable from accent furniture, `markColourCount` reports "the
  mark painted" on a slide where it did not. **Measurability is a selection criterion, not an afterthought.**
- **Pairwise separability** ≥40; the later member drops otherwise.
- **Tint fallback** when fewer than 3 survive: `color-mix(in srgb, <ring member> N%, var(--bg))` at
  N ∈ {92, 74, 55}. Same hue, in-kit by construction, extremes ≥40 apart. Trace reports
  `markRotation: "tint"` instead of `"hue"`.
- **Empty ring ⇒ no marks this run.** Copy renders plain, the issue is reported, nothing fails.

**The five kinds, chosen by CODE from ground luminance (finding 2).** The model says which words matter; it
never says how they are painted — the same split `slide-devices.ts:5-17` established.

| id | What it is | Legibility precondition |
|---|---|---|
| `block` | highlighter swatch behind the run, sitting low | contrast(ink, mark) ≥ 4.5:1 **and** ground LIGHTER than ink |
| `underline` | 2-3px pencil rule | contrast(mark, ground) ≥ 3:1 |
| `swish` | 6-8px marker stroke, thick in the middle, overshooting both ends | contrast(mark, ground) ≥ 3:1 |
| `double` | two rules of different weight | contrast(mark, ground) ≥ 3:1 |
| `ink` | the run's glyphs take the mark colour (rf-6's mechanism) | contrast(mark, ground) ≥ 4.5:1 |

**On our default `#17181C`, `block` is refused by precondition and the kind set is `{underline, swish, double,
ink}`.** That is the honest answer to "the references are paper and we are not", and it is a computation, not a
taste call. A pale kit gets `block` back automatically.

**Assignment is seeded, never random**, on the `paletteForSlide` pattern:

```
b        = fnv1a32(`${brandSeed}|mk|${slide.n}`)
colour(k)= ring[(b + k) mod R]                                  // consecutive always differ when R ≥ 2
kindA    = kinds[b mod K]
kindB    = kinds[(b + 1 + ((b >>> 3) mod (K - 1))) mod K]       // ≠ kindA when K ≥ 2
kind(k)  = k even ? kindA : kindB
```

## 5.3 The CSS, RTL, and Hebrew

Delivered through **`extraHeadHtml`**, the brand-independent channel `deviceCssBlock()` already uses, so it
reaches a brandless client too. One line changes at `create-instagram-agent-workflow.ts:4164`.

Every size is in `em`, never `px`, because `--ts` scales `font-size` on every template — an `em`-based mark
scales at `s`, `m` and `l` for free and there is no second ladder to keep in sync. `box-decoration-break: clone`
is what lets one mark span a line break (Part 4 obs. 3). `margin-inline: -.06em` against `padding-inline: .06em`
lets the mark bleed past the glyphs **without moving the measure** — if it moved, a marked headline would pick a
different length-ladder class than the copy gate measured.

Six colour classes (`.mk-c1`…`.mk-c6`, matching `ACCENT_RING_MAX`) each set `--mk-c`; five kind classes consume
it. **No inline `style=` anywhere** — `assertSafeMarkup` refuses it, and correctly.

- **Logical properties only.** No `left`/`right`. A source-scan test enforces it, as
  `__tests__/slide-devices-rtl.test.ts:46-50` already does for devices.
- **`text-decoration` is deliberately unused** for every kind: its skip-ink and offset behaviour differs across
  scripts and it cannot draw the swish or the double.
- **Hebrew geometry is set, not inherited.** Hebrew has no ascenders and a full-height letter body, so a Latin
  block at `.50em/.56em` would cover the glyphs rather than sit under them. `markCssBlock("hebrew")` emits
  `--mk-block-h: .44em; --mk-block-y: .60em` and drops the underline family to `.92em`. **Hebrew keeps all five
  kinds** — first-class, not degraded. These two numbers are **starting values, calibrated in CI** by the band
  sweep, not guessed once and left.
- **`script-fonts.ts` is imported read-only.** Marks are inline spans and inherit leading and tracking from
  their container, so `DISPLAY_SELECTORS` / `BODY_SELECTORS` are **not** edited. That vocabulary is the second
  hardcoded class list in the system and every addition to it rots.

## 5.4 Templates: twin slots

Five templates change. The markup change is identical in each — one prose slot becomes a twin-slot pair
(finding 9):

```html
<h1 class="headline"><span class="mk-runs">{{html:headlineRuns}}</span><span class="mk-plain">{{headline}}</span></h1>
```

plus one collapse rule per pair in the template's own `<style>`:

```css
.headline:has(.mk-runs:not(:empty)) .mk-plain { display: none; }
```

| File | Slots added | Note |
|---|---|---|
| `cover.html` | `titleRuns`, `subtitleRuns` | `--mk-ink-default: var(--fg)` beside its existing `--badge-ink` |
| `slide.html` | `headlineRuns`, `bodyRuns` | photo path's ground is a photograph; kinds still decided in code |
| `headline-focus.html` | `headlineRuns`, `bodyRuns` | |
| `closer.html` | `takeawayRuns`, `ctaRuns`, `questionRuns` | cta and question are already mutually exclusive |
| `quote-card.html` | `quoteRuns` | `.quote-text` is italic 84px; `block` is refused here **regardless of ground**, because an italic run's background box is a parallelogram the CSS cannot follow |
| `list-takeaway.html` | **none** | `buildListRows` already emits into `itemRows`; row marks are free. This is the rf-11 case. |
| `stat-callout.html`, `comparison-card.html` | **unchanged** | labels and figures, not clauses; `.num-figure` is deliberately outside `DISPLAY_SELECTORS` |

`PRIVILEGED_HTML_SLOTS` grows from `["device","recap","itemRows"]` to include the eight `*Runs` names, passed
through `assertSafeMarkup`'s existing `allowHtmlSlots` opt-in **per template, only for archetypes that declare
them** — the permission stays a decision at one call site, which is what that option exists for. **The escape
rule does not move**: copy still reaches templates escaped, and the only new thing is that a first-party builder
writes one more kind of fragment, exactly as `buildListRows` does.

## 5.5 Composition: one change

The references' variety is (a) type-block vertical position, (b) alignment, (c) mark colour, (d) imagery — over
**one unchanging ground**. (c) is the mark system. Of the rest, exactly one is free today:

**Seeded per-slide default alignment.** `buildVariationPlan` (`slides-data.ts:330`) is already a seeded
per-slide planner and every template already has `body.ta-center` / `ta-end`. `textAlign` currently defaults to
`"start"` on every slide and only ever moves when a reviewer moves it. The plan now assigns alignment from a
seeded walk over the reference's own sequence `[start, start, center, end, center, center, start, center]`, with
**no three consecutive slides sharing an alignment** and the cover pinned to `start` or `center`. **Reviewer
overrides still win, unchanged.**

~20 lines, zero template edits, zero model calls, reproducible from the seed. **It is severable by design**: it
moves the bundled set's rendered pixels, so the Chromium calibration suite is its gate. If it eats the
`CALIBRATION_MARGIN = 0.08` headroom, it is dropped and the mark system ships alone.

**Vertical migration is not built.** It needs a `cw-*` trio in every template, moves the type block relative to
a *fixed painted field*, and re-opens the clause E band that finding 1 shows is load-bearing. It is a phase.

## 5.6 The proof: two instruments, one new failing clause

**Instrument 1 — the DOM.** `SlideProbeSchema` gains `markRuns` (elements matching `.mk`) and `markRunsPainted`
(those whose computed `backgroundImage !== "none"`, or colour transparent-with-clip). This proves the shared
stylesheet **arrived**. ≤5 `getComputedStyle` calls per slide, and testable without Chromium because
`probePage` is exported for exactly that.

**Instrument 2 — the pixels.** `MeasureSlideExpectations` gains `marks?: readonly string[]` and `ink` (finding
8). `SlideMetricsSchema` gains `markedShare` and `markColourCount`, on **B's definition**, which is the better
one: cells that are (a) covered at the existing 48/64, (b) **flat** under the existing `FLAT_CELL_STDDEV` — this
is the limb that rejects antialiased glyph fringes and photographic texture — (c) more than `tol.ink` from the
ground, **and** (d) more than `tol.ink` from the supplied **ink token**. `markColourCount` counts distinct 5-bit
bins among those cells' means holding ≥16 cells.

**The new clause — `marks-missing`, added to `InterestFailureKind`, `KIND_PRIORITY` and `UNREMEDIED_DETAIL`:**

> Fires when `probe.markRuns > 0 && probe.markRunsPainted === 0`.
> Remedy: **a re-render, not a redraft** — the copy is correct and the stylesheet did not arrive. Same posture
> as clause A.

It is **DOM-anchored, not copy-anchored**, deliberately: a client on a Template Studio template with no `*Runs`
slot has `markRuns === 0` and can never be falsely refused. **This clause can only ever refuse more than today;
it removes nothing.**

The pixel limb ships as a **warning** (`marks-not-visible`: `markRuns > 0 && markColourCount === 0`), promoted
to a second limb only once CI has published the band (finding 5).

**Falsification — each run before the guard is trusted.** Delete `markCssBlock()` from `headExtras()` → the
clause refuses every marked slide. Restore it and set every ring colour to the ground hex → the warning fires
and the clause does not. Fix `colourIndex` to a constant → the adjacency test fails. Replace `esc()` with
identity → the escaping test fails.

## 5.7 The prompt bump: `instagram-copy@16 → @17`

New §24, ≈2,600 characters:

- Name 1-5 spans per slide whose *meaning* carries the slide: the noun a list row defines, the clause carrying
  the surprise, the term the reader will screenshot. Never a whole line, never a connective, never the numeral.
- Copy the words **verbatim** out of the field you wrote. If they do not appear exactly, the mark is dropped.
- You choose **which** words. You do **not** choose colour, weight, or how the mark is drawn.
- **Do not invent a phrase in order to have something to mark**, and **do not reach for a subject the client's
  brief and topic engines did not give you** (Part 1's topic rule, stated in the prompt itself).
- Its interaction with `checkSentenceCase` / `EMPHASIS_DENYLIST` stated explicitly: **shouting is still refused;
  this is the sanctioned way to emphasise.** That sentence earns its tokens on its own — the system currently
  has a rule against emphasis and no rule for it.

**The five-step checklist, plus the re-price:**

1. `prompts/instagram-copy/17.md` — `16.md` + §24.
2. `prompts/instagram-copy/latest.md` — byte-identical to `17.md`.
3. `scripts/prompt-registry.ts` — `versions` gains `"17"`, `latestVersion: "17"`. **`requires` is unchanged**:
   §24 names no `gate.*` and does not touch §1 or the literal `clientVoiceContext`, so `languageDirective` stays
   satisfiable and claiming a new flag would be dishonest.
4. `instagram-copy-agent.ts:211` — `skillRef: "instagram-copy@17"`, with the cost note counting **both** sides.
5. `__tests__/prompt-resolution.test.ts:484,495` — both expectations.
6. **Same commit:** `run-budget.ts:162` `copyAttempt: 0.161 → 0.171`. That file's header states this rule, and
   its `@14→@15` note records what happens when an output-growing bump is priced on input alone.

---

# Part 6 - COST

Sonnet 4.6 at **$3/M input, $15/M output** — the rates `run-budget.ts:90-135` already reasons in. Verified
against the tree: `STEP_COST_ESTIMATES_USD.copyAttempt = 0.161` (`run-budget.ts:162`).

## 6.1 Per copy attempt, both halves counted

That file gets this wrong in both directions historically, so both sides are shown.

| Half | Arithmetic | $ |
|---|---|---|
| **Input** — §24 at ≈2,600 chars ≈ 650 tokens, paid on English runs too (one prompt file, no conditional) | 650 x $3/1e6 | $0.00195 |
| **Output** — the `emphasis` array: 3.6 marks/slide (the rf-05 mean) x ≈17 tokens + 4 array overhead ≈ 65 tokens/slide, x 8 slides = 520 tokens | 520 x $15/1e6 | $0.00780 |
| **Total per attempt** | | **$0.00975 → entered as $0.010** |

`STEP_COST_ESTIMATES_USD.copyAttempt`: **0.161 → 0.171**, rounded UP. An estimate that flatters itself pulls no
lever.

## 6.2 Every scope

| Scope | Delta | Arithmetic | Against | Share |
|---|---|---|---|---|
| Per run, 2 attempts (typical) | **+$0.020** | 2 x $0.010 | $1.00 target | 2.0% |
| Per run, 3 attempts (the cap) | **+$0.030** | 3 x $0.010 | $1.00 target / $1.50 max | 3.0% / **2.0%** |
| **Per client setup** | **+$0.000** | no new step, no new prompt, no art-director bump | $2.00 target / $3.00 max | **0%** |
| Render | +$0.000 | no model; ≤5 extra `getComputedStyle` per slide | — | — |
| Measurement | +$0.000 | no model; `markedShare`/`markColourCount`/the five §3.3 metrics all reuse `cellInk`, `cellMeanRGB`, `cellStddev` and `colourCount`, already computed and today discarded — one accumulator, ≈+6 ms/slide on a ~200 ms pass | — | — |
| Interest floor incl. the new clause | +$0.000 | pure Node | — | — |

**Why setup is exactly zero, and it was a deliberate choice.** The mark ring is *derived in code* from the
accent ring the kit already produces. A `markPalette` authored by the art director would be filtered out by
`filterLearnedStyleToRing` and would then fail `checkPaletteWithinKit` three attempts later — a recorded $0.30
hold, for a worse result.

**It can also save.** The `marks-missing` clause fails at `08a1` and its remedy is a **free re-render**, not a
$0.171 redraft. No number is claimed for this because the rate is unmeasured; the direction is not in doubt.

**The re-price flows into `planRunBudget`'s sums automatically**, so the adaptation levers see it before the
first paid call — which is the whole point of re-pricing in the same commit, and which is also how §6.3 below
was found rather than shipped.

**Nothing in this phase can hold or fail a run**: every emphasis failure degrades to plain type and is reported
as a fact, and the one new clause steers a re-render.

## 6.3 MEASURED: the re-price fires the ATTEMPT lever on a cold Hebrew run, and that is a HOLD

An earlier draft of this section said "budget posture unchanged". **That was wrong, and the measurement is
here instead of the claim.** Measured against the real `planRunBudget` (via `tsx`, not arithmetic by hand):

| Shape | `copyAttempt` 0.161 | `copyAttempt` 0.171 | What the extra $0.030 bought |
|---|---|---|---|
| English cold | $0.9518, **3 attempts** | $0.9818, **3 attempts** | nothing; already at images 0 |
| English warm | $0.9978, 3 attempts, images 4 | $0.9498, 3 attempts, images 2 | one more image rung |
| Hebrew warm | $0.9888, 3 attempts, images 2 | $0.9108, 3 attempts, images 0 | one more image rung |
| **Hebrew cold** | **$0.9998, 3 attempts** | **$0.7467, 2 attempts** | **a whole drafting attempt** |

Every figure above was READ OFF `planRunBudget`, at both prices, rather than inferred by adding $0.030 to the
old one. Inferring it gives the wrong answer on both warm rows — the ladder pulls a different NUMBER of image
rungs at each price, so the warm plans come out CHEAPER after the re-price, not dearer.

The cold Hebrew plan sat **$0.0002** under the target. Three attempts x $0.010 is $0.030, which takes it to
$1.0298, and rung 3 of the ladder — `maxSelfCheckAttempts` 3 → 2 — fires. The lever then **overshoots by
$0.25**, and it pays for that overshoot with a whole drafting attempt on exactly the client this project's
Phase 4 exists to serve.

That is not a smaller number in a report. `__tests__/language-compliance-gate.test.ts` returns
`status: "held"`, reason *"the run budget plan allowed one return instead of two"*, on **three** cases — two of
which are named "NEVER holds". **A budget-caused hold is forbidden outright** by the owner's 2026-09-09
amendment, which this RFC restates in Part 1.

**This was predicted.** `run-budget.ts`'s own `vetCall` doc comment declined an unrelated $0.0005 re-price for
precisely this reason and recorded the conclusion: *"the re-price itself belongs in a follow-up that lands WITH
the rung-order change, because the real finding underneath is that the attempt lever can produce a held run at
all."* This phase is that follow-up, and the prediction held to the dollar.

**The fix, measured, is to swap ladder rungs 3 and 4** in `planRunBudget`: try `optionalRevets: false` BEFORE
cutting `maxSelfCheckAttempts`. On the cold Hebrew shape the optional rescue re-vets are $0.099, which takes
$1.0298 → **$0.9308 with all three attempts intact**, and no other shape changes at all (English cold, English
warm and Hebrew warm keep the plans in the table above). It is also the owner's own wording — *"past target
drop OPTIONAL work"* — and a rescue re-vet is the thing named optional, while a drafting attempt is the
quality loop itself.

**IT IS APPLIED, in this phase's commit.** It was escalated first rather than done unilaterally — the ladder's
order is the order `run-budget.ts`'s header attributes to the owner, and reordering an owner-stated priority is
not an implementer's call — and it came back approved. **What was never acceptable is weakening the re-price to
dodge the rung**: an estimate that flatters itself pulls no lever, which is the rule the file states about
itself and the reason the honest $0.171 is entered here.

**Verified, not asserted.** With the swap in and **no edit to the test file**,
`__tests__/language-compliance-gate.test.ts` goes from 4 failures to **28/28 passing** —
green because the code stopped holding, which is the only acceptable way for those cases to be green. Asserting
a hold to make them pass would encode the owner's forbidden behaviour as intended behaviour, which is strictly
worse than a red test. `run-budget-workflow.test.ts` (8/8), `per-revision-estimate.test.ts` (3/3) and
`no-premium-models.test.ts` (8/8) also pass untouched.

**What the swap really fixes is not the price.** It is that the attempt lever could produce a held run AT ALL.
The re-price merely made the defect reachable; the swap removes the reachable held case rather than pricing
around it, and in doing so it unblocks `vetCall`'s own deferred +$0.0045 re-price for whoever takes it next.

---

# Part 7 - Tests

Reported as **PASSED vs SKIPPED separately, always.** Chromium-gated suites self-skip on this machine; **CI is
the authoritative gate for every pixel claim in this document.**

**Pure — run everywhere.**

1. `resolveSlideMarks`: position ordering; word-boundary matching (`"AI"` must NOT match inside `"SAID"`);
   overlap drop; 6-word cap; the 35% rule; per-field and per-slide caps.
2. RTL foreign-run boundary: `שוחרר Gemini 3 בגרסה` marked on `Gemini` → the output never contains `Gemini` and
   `3` in separate isolates.
3. Isolate balance: `stripIsolates(join(runs)) === original`, FSI count === PDI count.
4. `buildMarkRing`: accent exclusion, pairwise separability, per-kind contrast preconditions, tint fallback on a
   one-hue kit, empty ring ⇒ no marks + reported.
5. Escaping: a mark whose text is `<script>alert(1)</script>` renders as entities.
6. Rotation invariants: consecutive colours differ; ≥2 kinds when ≥2 marks; identical output on a repeated call.
7. Source scan of `markCssBlock`: no physical `left`/`right`; every size in `em` or `var()`; five kind classes
   and six colour classes present; the Hebrew branch emits both block variables.
8. `probePage` with a faked `document`/`getComputedStyle`: `backgroundImage: "none"` ⇒ `markRunsPainted === 0`.
9. Degradation: a template with no `*Runs` slot renders the plain field; the issue is reported; no finding.
10. Clause `marks-missing`: fires on painted 0 of N, abstains on `markRuns === 0`.

**Chromium-gated — CI is the authority.**

11. Each of the 5 changed templates x {ltr, rtl} x {s, m, l} x 3 marks: no `probe.overflow`;
    `markRuns === markRunsPainted === 3`; **`textBoxShare` and `fontFamiliesUsed` unchanged vs the same copy
    unmarked** (finding 3); rendered line count unchanged.
12. Band sweep: per kind x scale x script, the painted `markedShare` and the block band's top/bottom relative to
    measured cap height. Output is the table that sets the pixel limb's floor and corrects the two Hebrew
    numbers.
13. `interest-floor-calibration.test.ts` re-run with marks and the alignment walk on: the bundled set keeps its
    `CALIBRATION_MARGIN = 0.08` headroom and `textShare` stays clear of `TEXT_SHARE_CEILING = 0.55`.

**Two standing rules.** Photograph fixtures come from the shared `__tests__/synthetic-photograph.ts` at
**1080x1440** — a private or upscaled copy measures ~0.3% imagery against a 0.5 floor and has already cost one
red CI. And **no test ships until the code has been broken and the guard watched to refuse**; §5.6 lists the
four breakages.

---

# Part 8 - What is deliberately NOT built

1. **Any threshold change or emptiness exemption.** Part 3.
2. **A photographed material ground, and collapsing the eight grounds.** Finding 1 — it breaks clause E on cover
   and closer. Recorded with its real merit (§3.5 finding 1) for a phase that can re-calibrate clause E.
3. **Clause H as a gate.** Finding 5. The metric ships as a warning.
4. **One typeface family per post, family-as-register.** The only font channel is `brand-render-tokens.ts`'s
   `FONT_FAMILY`-gated Google Fonts name, one family per role, no weight axis, no `@font-face`
   (`safety.ts:139-141` forbids `url(` and `@import`, correctly). A second display-face channel is its own phase.
5. **Vertical type-block migration and the object counterbalance.** §5.5.
6. **Marks on `stat_callout` and `comparison_card`.** §5.4.
7. **Mark colours outside the kit ring.** Tints of ring members only. Finding 7.
8. **The wayfinding arrow that tracks the type block.** A genuine reference rule — inline after the last word on
   S1, at the top on the one slide whose type is at the top, absent on the last slide — and our templates have
   no arrow at all. Adding wayfinding is its own item.
9. **Inline headline numbering.** `list-takeaway`'s `.diamond` counter is exactly the badge the references never
   use, a real defect against the reference, but it is load-bearing in `graphicShare` calibration. Flagged.
10. **Rotation, off-canvas bleed, collage stacking.** Object-level, all dependent on a media placement planner.
11. **The reference accounts' subject matter.** Part 1. Nothing here touches topic selection.

---

# Part 9 - For the PR body

**New step ids: NONE.** Mark resolution happens inside existing `wf.step.code` composition and step `05` changes
only its resolved prompt version (`instagram-copy@16 → @17`).
**`agent-middleware/scripts/generate_engine_stages.py --check` is therefore not required after merge** — but the
PR body must say so explicitly rather than omitting the section.

**Tool version:** `publish.renderCarousel` `TOOL_VERSION 1.3.1 → 1.4.0` (`render-carousel.ts:40`) — new
`expected.ink`, new `markHexes` input, new probe fields and new metrics on the wire. `slide-metrics.ts` declares
no `TOOL_VERSION` of its own; the bump lives in `render-carousel.ts`, and the push gate diffs against the
previous PUSH.

**Prompt bump:** the five-step checklist in §5.7, plus the `run-budget.ts` re-price in the same commit.

**THE HEADLINE OF THIS PR IS NOT THE MARKING — IT IS A LATENT DEFECT THE RE-PRICE EXPOSED (§6.3).** Ladder
rungs 3 and 4 in `planRunBudget` are SWAPPED: optional rescue re-vets are now dropped BEFORE
`maxSelfCheckAttempts` is cut. The old order cut the quality loop before it cut optional work, inverting the
owner's own wording (*"past target drop OPTIONAL work"*), and the honest $0.171 re-price made it reachable — a
cold Hebrew run sat $0.0002 under target, crossed it, and came back `status: "held"` on cases named for never
holding. **The real finding is that the attempt lever could produce a held run at all**, which
`run-budget.ts`'s `vetCall` comment predicted and deferred to "a follow-up that lands WITH the rung-order
change". This is that follow-up. It was escalated before being applied, and approved.

The alternative — entering a price lower than the arithmetic to dodge the rung — was refused: an estimate that
flatters itself pulls no lever.

**Test files that pin the old price and are NOT owned by the prompt-bump package.** After the rung swap, only
ONE still fails: **`__tests__/run-budget.test.ts`** (7 cases — six price pins plus the lever-order list, whose
last two entries now swap). `__tests__/language-compliance-gate.test.ts` (28/28),
`__tests__/run-budget-workflow.test.ts` (8/8), `__tests__/per-revision-estimate.test.ts` (3/3) and
`__tests__/no-premium-models.test.ts` (8/8) all pass **untouched**.

**A REVIEW INSTRUCTION FOR WHOEVER UPDATES `run-budget.test.ts`, and it is the line between fixing a test and
quietly lowering a bar:** only the hardcoded price constants and the lever-ORDER list may change. If anyone
ever makes a "NEVER holds" case pass by asserting `status: "held"`, they have encoded the owner's forbidden
behaviour as intended behaviour, and that is strictly worse than a red test.

**Verification status of every pixel claim here:** reference observations are read directly off the supplied
JPEGs; the control measurements in Part 3 come from a faithful re-implementation of `measureSlidePng` over real
PNGs at 1080x1440 scale 2, with the JPEG caveat stated at each use of a reference figure. **Not** verified
through real Chromium — those suites self-skip on this machine. CI is the gate.
