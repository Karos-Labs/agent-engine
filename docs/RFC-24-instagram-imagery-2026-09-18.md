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
