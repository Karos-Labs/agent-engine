# RFC-24 — Instagram imagery: what the two prep carousels of 2026-09-18 showed

**Status:** SHIPPED, on `feat/instagram-phase56b`.

Two prep runs on 2026-09-18 were the first to exercise Phase 5.6 against live
models: Karos Labs (`nMRVFcpVMoHq4SRSMqjk`) and Geektime
(`otTqj66DUCHbYesbxiR9`). They shipped with **two pictures and none**.

The owner's verdict was that this is the single biggest defect in the agent,
and that the picture is not decoration: *"אמרנו שזה מאוד חשוב ומוסיף ולמרות זה
בKAROS יש 2 ופה בGEEKTIME יש רק 0! ... זה מחדל"*.

This document records the four causes, the two rulings that came out of it,
and the things that are still open.

---

## 1. THE THREE RULINGS

**No resolution floor.** *"למה אי אפשר גם תמונות קטנות יותר... תוריד את
ההגבלה הזאת"*, repeated as *"חייב להוריד מגבלות כאלה לתמונות"*. A logo or a
figure inside a plate was never asked to cover 1080 pixels, so refusing it for
failing to is refusing a picture for a job it was not given. Size decides
**placement**, never admission.

**A picture does not have to be the background.** *"לא כל התמונות צריכות
להופיע כרקע, תמונות יכולות להופיע בתוך הפוסט כחלק ממנו, גם אם זה חלק לא גדול...
כשזה חלק פשוט זה ממש חשוב"*.

This does **not** reverse the 2026-09-16 ruling that a generic stock photograph
filling a plate is not a picture. The two are about different placements and
both are in force: `MIN_SUBJECT_MATCH` is still 4 for a ground, and a candidate
that misses it is now placed in a bounded band instead of discarded.

**Generated conceptual visuals are wanted**, not only stock: *"אולי חסרות
תמונות מגניבות, איזה ג'ינרוט AI של flow כזה של מה שאנחנו עושים"*.

---

## 2. THE FOUR CAUSES

### The floor spent money and then threw the result away

The same generated 896x1200 frame was refused **six times** across the two
runs, every refusal after the image charge had been booked, and in the
Geektime run the retries walked into a `429 RESOURCE_EXHAUSTED`. Against a
1080 canvas, 896 is a 1.21x enlargement.

`placementFor` replaces the floor. It maps a short side to the largest job it
can hold (`full-bleed` / `inset` / `accent`) and is **total**, so a caller can
always place what it is handed. `fullBleedUpscale` rides on the facts, so a
soft slide is explained rather than guessed at.

Refusal survives for two things that are not sizes: bytes no container parser
recognises, and a CMYK separation, which renders with shifted colour.

Preference does the work refusal used to. A thumbnail provider used to lose by
having its result discarded; it now loses by being ranked below a picture that
covers the frame, and the pixel size is written into the description because
that is the only field the vetting agent reads.

### The draft asked for pictures on two slides of eight

Both copy drafts wrote `source: "none"` on six slides. The copy prompt already
told the writer that a carousel of `"none"` reads as cheap, and then exempted
`stat_callout`, `comparison_card`, `quote_card`, `list_takeaway`, `cover` and
`closer` from the cost it attached. That is every archetype in the set, so
`"none"` was free.

### The floor could measure the shortfall and not reach it

`06h-imagery-floor-check` refills `selections.filter(isUnfillable)`: slides
that ASKED for a picture and did not get one. A `"none"` slide produces no
selection, so it was invisible. The step recorded, both times, *"no slide is
still without a picture, so there is nothing to fill"* — true of everything it
could see, false of the post.

`planImageBackfill` supplies the rest. Bounded plates first (the second
ruling), a briefed scene before a derived one, a layout with no image slot
skipped rather than paid for, and never the closer, because a picture behind
the ask competes with the ask.

`MIN_GENERATED_IMAGES_PER_RUN` moved 2 to 3. It could not satisfy
`MIN_PICTURE_SLIDES` from zero, which is arithmetic and not judgement.

### An unfilled slot painted its frame anyway

Geektime's cover opened on a 1080x620 grey-green gradient rectangle where the
photograph should have been. `fillTemplate` erases a slot nobody filled, so
the markup renders `<img src="">` and the element is still laid out, still
painting its container's background.

The bundled plates have collapsed `.sc-figure-band` on this since it shipped
there once already. Studio templates are MODEL-AUTHORED, so there is no class
to hang the rule on and it had to go structurally into `buildTemplateShell` —
the one shell code owns.

---

## 3. WHAT THE FLOOR COST THE BUDGET

The generation guarantee of 3 removes the bottom rung of the image ladder,
which was 4 → 3 → 2 and is now 4 → 3. On a hot client the ladder can no longer
bring a run under the $1.80 target: three pictures cost more than the target
leaves. The run proceeds over target and says so in its own note.

That is `quality-before-cost` and `budgets-adapt-never-hold` meeting, and the
test asserts it rather than asserting the fit it used to.

`IMAGE_CAP_STEPS` is derived from the floor now. Listed as
`[4, 3, MIN_GENERATED_IMAGES_PER_RUN]` it read `[4, 3, 3]` the moment the floor
moved, and the budget sweep caught a ladder with the same rung twice.

---

## 4. FOUR DEFECTS READ OFF THE PLATES THEMSELVES

Not imagery, but found in the same two carousels:

- **A sentence shipped with its value missing.** Karos slide 3 printed *"Error
  stacks at every step, dropping accuracy to ."* `deviceFromText` splices the
  figure out by position, and when the figure completes a prepositional clause
  the preposition is left holding nothing.
- **The same sentence printed twice on one plate**, as the caption under a
  number and again in the paragraph below it.
- **The closer recapped itself 01 / 03 / 05 / 07** — source slide numbers, in a
  format where no slide carries a visible number.
- **`"1,500"` printed `"500,1"`** in Hebrew. `FOREIGN_TOKEN` had no comma, so
  the number was two matches: a bare `1,` under the isolate minimum and an
  isolated `500`. FSI..PDI is opaque by design, so UAX#9's W4 could not
  collapse `EN CS EN` across it. Plain bidi renders `1,500` correctly; the
  isolation broke it.

---

## 5. TWO THINGS I GOT WRONG, RECORDED BECAUSE THE SHAPE REPEATS

**The connector rule was worse than the bug.** The first version tested the
preposition alone and cut wherever it matched, which threw the rest of the
sentence away on every mid-sentence figure: *"Every team that handed it to the
tool got about 4 hours a week back, which is most of a working morning"* became
*"Every team that handed it to the tool got"*. This repo's own fixtures
falsified it in one run, and eight workflow tests caught it as a **second
render** — the interest floor buying a re-layout to fill the holes the rule had
made. It fires only when the figure ends the clause now.

**A helper answered a question it had not been asked.** `isUnfillable` opens
with `if (!photoSlideNs.has(s.n)) return false`, and a `"none"` slide is not in
that set. So for exactly the slides the backfill fills, it answered "not
unfillable" about a verdict it had not looked at. The first append loop I wrote
skipped those slides on the belief that they had no selection to replace, which
would have generated a frame, vetted it, approved it and dropped it — the exact
waste the floor fix exists to stop. `resolveRescuedSelection` is that rule,
extracted so it can be asserted rather than argued for in a comment.

---

## 6. WHAT IS STILL OPEN

**The one-sentence body still duplicates.** Where a slide's body is a single
sentence and that sentence becomes the device's label, both print. `body` is
`z.string().min(1)`, so closing it means suppressing the render SLOT in
`slides-data.ts` rather than editing the copy. Refusing the device instead was
tried and is worse: every fixture body in this repo is one sentence, so it
removed the device from essentially every statement plate.

**The pixel items.** A1 (the 4:5 canvas, and re-calibrating every interest-floor
threshold against it), A2, A3, A5, A6, A9, A12, B6, B7. Each needs a render
sweep, and local Chrome disagrees with CI about pixels, so they want a session
with the sweep in front of them.

**C6, E3, E4** are separate surfaces (a topic-approval gate, Stories, the 9:16
re-render). They do not change what a feed post looks like.

**Nothing here has run in prep.** The bar is [[instagram-definition-of-done]]:
three prep posts the owner would publish.

---

# PART TWO — the owner's review of three more carousels, 2026-09-18 evening

Three prep runs (`yLrcpz…` Karos, `aR7hPT…` Geektime, `Y6fH6Q…` Pitch by Deel)
cost $2.39, $2.93 and $4.27. The owner's notes, and what each turned out to be.

## 6. THE IMAGES WERE NOT "GENERIC". THEY WERE LITERAL.

| headline | picture |
|---|---|
| "Two **clocks** run your marketing" | a gold pocket watch |
| "Buyers open their **window** when they're ready" | a lit doorway in a wall |
| "…on a publishing **schedule**" | a watch on a desk |

Each illustrates a WORD from its own headline. It is the oldest failure in
stock photography and this pipeline caused it: section 22 demands "a concrete
noun phrase a photo library would index" and says nothing about WHICH noun, so
the model returns the most concrete one in the sentence. The rule was written
to stop abstract nouns (`"precision"`, `"trust"`) and over-corrected.

`instagram-copy@25` states the opposite half, and `literalIllustrationOf`
reports it back as a NOTE when the subject noun repeats a content word from the
headline. A note and not a refusal: a slide about a real conference genuinely
is about a stage, and no matcher tells that apart from a metaphor.

## 7. MY OWN EXCLUSION LIST WAS WHY EVERY MADE FRAME WAS BORING

The owner: *"generic AI images are boring, mostly because it is repetitive"*,
and he was right about the cause as well as the symptom. The list I wrote that
morning banned people, logos, brands and products outright, so the only thing
left to draw was `"geometric forms, layered planes and connective lines"`.
That is generic AI filler, eight times a carousel, and I wrote it.

**The line is not the subject. It is whether the image could be read as a
record of something that happened.** An illustrated figure in a declared
register is commentary and every serious publication runs one weekly. A
photorealistic frame of the same person is a fabricated photograph.

- `ALWAYS_EXCLUDED`: no text, no staged event, nothing mocking.
- `PHOTOREAL_ONLY_EXCLUDED`: no identifiable real person, no real brand mark.
- Seven `ILLUSTRATION_REGISTERS`, one chosen per RUN, because one house style
  repeated IS the repetition.
- A named subject may appear only when there is a register to draw it in.

**Where I pushed back and was half right.** A generated brand logo comes out as
a smeared near-miss, so *rendering* a trademark is still refused. The route to
"cool image with a real logo" is to generate the scene and composite the real
mark over it. That half is NOT built; the entity press-kit tier exists and the
compositing does not.

## 8. THERE WAS ONLY EVER ONE BOUNDED PLACEMENT

A full-bleed ground on `cover`/`photo`, and `.sc-figure-band` on the four
panels: 300px, full width, at the top, every time. Every picture in all three
carousels was one of those two.

Four shapes ship: `band`, `tall`, `foot`, `bleed`. The interest-floor
calibration sweep refused `side`/`side-end` four times over, and the last
refusal is the interesting one: `_ds-fit.js` sizes type against the FIELD, and
a side variant changes the field's width without telling it. The CSS is
correct and stays; nothing selects it until the fit ladder knows about it.

## 9. RECENCY WAS A TIE-BREAKER, SO IT NEVER REACHED A RANKING

`publishedAt` appeared once in `rankTopicCandidates`: in the comparator, after
the score and after `hasNumbers`. Two candidates with different scores never
got that far. An evergreen abstraction beat anything that happened this week,
every time, and all three carousels opened on one.

`freshnessBonus` is a term in the score now. Undated is neutral (most good
evergreen ideas have no date, and an absent one is not evidence of age); a
future date is a clock skew; five weeks old competes as the evergreen idea it
has become. It is a nudge at 1.35, not a veto.

This one is upstream of the images: a post about a real, named, recent thing
gives the picture something real to show.

## 10. THE THREE ATTEMPTS

$1.14 of a $2.39 run. What bought the second and third: a banned em dash,
*"slides 4, 5, 8 all open with the word the"*, six words quoted from a fact
card. Each is a targeted edit; each bounced an eight-slide carousel to be
written again from nothing.

The price is the smaller half. **A rewrite is a new random draw**, and in two of
the three runs attempt 2 fixed the finding and broke something else. The loop
was resampling, not converging, which is why every run reached its cap.

- `repairMechanicalTells` fixes a dash in code. It is a trace step, not a
  finding: a degrade marker asks a reviewer to weigh a defect, and this one
  cost nothing.
- `05r-revise-copy` edits the previous draft through a patch of named paths.
  `applyCopyEdits` resolves every path against the draft that exists, so what
  the gates accepted is untouched **by construction**. The full redraft stays
  behind it for the findings no edit answers.

## 11. HEBREW

- `#` is a bidi neutral and landed at the far left of its line, detached from
  its word. Every template already wraps the `@handle` SLOT in a `<bdi>`; a
  hashtag arrives inside the copy and never did.
- `instagram-native-editor@3` names three calques the editor ran over and
  passed: `נחתך בחצי`, `מודיעין` for market intel, `שקופה` for candour.

## 12. WHAT PART TWO DID NOT DO

- **Logo compositing.** Generate the scene, place the real mark.
- **The side-by-side figure**, pending a field-aware fit ladder.
- **A one-sentence body still duplicates its device label** (Part One §6).
- **Nothing has run in prep.** The bar is three posts the owner would publish.


# PART THREE — the owner's review of two more carousels, 2026-09-19

Two carousels, `ZGT0oH1aQOuLhur0bzP6` (Karos) and `V9gmy8j2J2vtioHZueGj`
(Geektime), and four notes. They are written here in the order the fixes
landed, with the mechanism first and the fix second, because in three of the
four the mechanism was ours and had been written down as a rule.

## 13. A PLATE WAS LEGAL BLOCK BY BLOCK AND WAS STILL A PAGE

> *"there are slides with too much copy for one slide and type that is too
> small"*, and then, when I raised the type question separately: *"a lot of
> copy on one page is not good either, regardless of small type"*.

Slide 4 of the Karos carousel: a headline and four items, each with a two or
three line note. About a hundred words.

Every check passed it, and each was right about its own question. Every block
was under `MAX_WORDS_PER_BLOCK` (20). The statement was under its own limit.
Clause F's `TEXT_SHARE_CEILING` measures the share of the FRAME the type
covers, and a hundred words set small covers the same share as fifty words set
large — the second is a slide and the first is a page, and text share cannot
tell them apart. `slide-word-budget.ts` had explicitly delegated this case to
clause F, in its own comment: *"a `list_takeaway` with four 20-word rows is 80
words on the plate and passes here; that is intentional and it is the pixel
gates' question, not this one's"*. The delegation was reasonable and it did
not hold.

**Fixed:** `MAX_WORDS_PER_SLIDE_TOTAL = 60`, checked on the whole plate with
every block counted together, and `instagram-copy@26` §7 says so to the
writer.

**And the count of rows is NOT the defect**, which I got wrong in the first
draft of both the prompt paragraph and my summary. The owner pushed back —
*"what are you talking about, maybe four is not too much"* — and he is right:
four short rows come to about 46 words and read perfectly well. What does not
fit is four rows each carrying a two-line note. The word budget refuses the
volume and admits every good four-row plate; a row-count rule would have
refused the good version of the same slide. The prompt now says *"cut the
words, not the points"*.

## 14. THE LADDER KNEW THE COPY WAS TOO LONG AND TOLD NOBODY

The second half of the same note was about type size, and the answer was
already in the repo.

`_ds-fit.js` shrinks a plate's type one step of the scale at a time until it
fits, and stops at two. Its own comment says what the last rung means: *"a
plate that still does not fit at step 2 is a copy-length problem that the
content-weight floor should refuse rather than something type can hide"*. It
writes the rung it used to `document.body[data-fit-step]`, and the comment
beside that line says why: *"so a render check, the interest floor and a
failing test can all see which rung was used without re-deriving it"*.

Nothing read it. `data-fit-step` appears in the eight plate templates, in the
ladder, and in one test of the type scale. In no production file, for the
whole life of the design system. The ladder shrank the Karos plate to its
floor, wrote down that it had, and the post shipped.

**Fixed:** `render-carousel` 1.9.0 reports `probe.fitStep`, and
`interest-floor.ts` has a fourth type-discipline limb reading it against
`FIT_STEP_CEILING = 1` — the ladder's own bound, so no threshold is invented.

**It ships DISARMED, and that is a decision.** The owner asked for two things
in one message: fix the small type, and stop burning three drafting attempts
per run because *"it is a waste of money"*. An armed clause here serves the
first and defeats the second: it fires after the render, so every firing costs
a redraft plus a second render, and it fires on plates no redraft can fix —
Hebrew sets long unbroken words and the reviewer's `ts-l` scale starts the
ladder 18% higher, either of which can reach step 2 on copy that is the right
length. The defect the owner read is refused a step earlier and for free by
§13's word budget, which runs on the draft before a pixel is rendered. So this
ships as the instrument, on the same `*_ARMED` discipline as the three limbs
beside it, and it is armed from the distribution it collects.

## 15. THE ARROWS WERE A PERMISSION THE WRITER READ AS A HABIT

> *"in every post now you do these arrows in the text that go up with the
> post, like this. Once in a while it is fine, but repetitive things like this
> look AI."*

Mine, and written down. `instagram-copy@23` §2 says, in these words, *"arrow
bullets among prose are not"* refused — written off the reference accounts,
which do use them. The writer read a permission as a recommendation and used
it every time.

A prompt sentence could not have fixed this. "Use this at most one post in
three" asks a model with no memory across runs to count something it cannot
see, which is the class of instruction this repo keeps learning not to write.

**Fixed as memory, not as a rule.** `PostPerformanceRecord.usedArrowBullets`
is measured off the caption that ships (not asked of the writer: a
self-report about one's own tics is the one label in that record worth less
than reading it), and `arrowBulletSteer` hands the next run a sentence when
two of the last three posts used the device. `instagram-copy@26` §16 takes it
as `deviceSteer`, the first steer in that section that is not about a failed
attempt.

The steer names alternatives and does not ban the arrow. A ban is the same
mistake in the other direction, and this repo has already paid for one: see
§5 of part one, where a connector rule I was sure of was falsified by the
repo's own fixtures.

## 16. ONE PICTURE, THREE SLIDES

> *"the LinkedIn combination is amazing, but you repeated the same LinkedIn
> image three times in the post. Think like a CMO."*

Every slide is vetted INDEPENDENTLY against one shared candidate pool, so the
best picture in the pool wins every slide it is offered to. The entity tiers
added in part two make this sharper rather than softer: a press kit publishes
a handful of images, so a post whose subject is one company draws the same
logo shot for every slide that names it.

There was already a dedupe and it answers a different question:
`05a-list-used-images` and `usedImagesSet` stop a picture repeating ACROSS
RUNS. Nothing stopped it repeating inside one.

**Fixed:** `06f2-one-picture-one-slide-attempt-N`. The first slide keeps the
picture — the reader meets it there and the vet's own ordering put the
strongest claim first — and the later slides are cleared into the same
unfilled path every other sourcing failure takes, which is where the backfill
and the generation guarantee already live. A cleared slide gets a DIFFERENT
picture, never none.

## 17. AND THE NAMES THE DRAFT SAYS, WHICH NOTHING WAS READING

> *"really read the names on every post and then decide, for every page that
> has a picture, what is the more interesting and more relevant picture."*

`04b3-extract-entities` runs BEFORE the copy step. It sees the topic, the
angle and the research cards, and nothing the writer introduced. The Karos
carousel put *"a buyer hears your name from ChatGPT"* in a list note and no
step ever asked for a picture of OpenAI, while its Geektime sibling carried a
real LinkedIn logo on the cover only because LinkedIn happened to be the whole
topic.

**Fixed:** `entitiesInDraft` reads the settled draft for proper nouns, merges
them into `postEntities` for the rest of the attempt, and rewrites the
`visualNeed` of any picture slide that names one and briefed no `entityRef`.
The existing sourcing tiers then do what they already do.

