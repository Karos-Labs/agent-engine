# RFC-21 — The owner's three rulings, 2026-09-14

**Status:** Part 1 implemented. Part 2 has one candidate falsified and the instrument that decides
the next two. Part 3 is designed and scoped as its own phase — see §3.5 for why it is not started
as a slice.
**Supersedes, in the places named:** RFC-18 §7.3 (the rung swap), RFC-19 §8.4 (the attempt-rung
guard), RFC-20 Part 11 (the interest floor's calibration).

---

# Part 0 — What this document is

On 2026-09-14, after six merged Instagram phases, the owner read the conflicts this agent had
surfaced between three standing instructions and what was already built, and ruled on all three.
The rulings are not preferences to be balanced against the existing design. They are the design,
and where the shipped code disagrees with them the shipped code is the thing that changes.

The three, in the owner's own words, with the operative decision after each.

## Ruling 1 — the $1.00 target

> *"היעד של $1 לריצה הוא מטרה ואופטימיזציה, לא hard-limit שמפיל ריצה. אם יש חריגה בריצה נתונה – תן
> לה להסתיים, תספק את הפוסט, ותרשום את החריגה כדי שנלמד ונצמצם עלויות בריצות הבאות."*

$1.00 is a TARGET. $1.60 is a hard ceiling **whose purpose is to break an infinite loop, not to fail
a run.** Between $1.00 and $1.60: deliver the post, log the overrun for investigation. Above $1.60:
**still do not fail** — *"the money is already spent, it would be a waste"* — stop doing further
work, ship what exists, and make certain we learn from it so it does not recur. **There is no cost
condition that fails a run, ever.** Immediate consequence the owner named: restore
`07i1-verify-lead-claim` for client posts. Content quality beats a $0.007 saving.

## Ruling 2 — the interest floor is the bug

> *"אם השקופית הטובה ביותר מחשבון הרפרנס נפסלת – השומר שבור ומכויל ביתר, לא התוכן."*

The floor must measure **semantic and structural value**, not dry occupancy and colour metrics
**that punish good simplicity**. The reference plates must pass cleanly. And the reference set is
not the ceiling either: the job is to understand the ELEMENTS that make a post good, then measure
and produce those.

## Ruling 3 — archetypes are dynamic, by COMPOSITION

At run time the model does not author HTML/CSS from scratch. It performs **dynamic composition from
validated building blocks** — slot-based assembly of a bounded object, typography and surfaces that
have each passed validation. A genuinely new archetype is saved as a **CANDIDATE** for CI
calibration and never goes straight to production.

---

# Part 1 — Ruling 1, implemented

## 1.1 What was actually wrong

The engine already never HELD on budget: `MAX_RUN_SPEND_USD` switched the live meter to the
cheapest complete path, and `canAfford` is documented "never a reason to hold". That half was
right and is untouched.

The wrong half was the **pre-run ladder**. `planRunBudget` adapted a plan down to the $1.00 target
in four rungs, and the fourth cut `maxSelfCheckAttempts` 3 → 2. That never failed a run — it bought
a worse post to hit a number the owner has now said is not a limit. Its own comment conceded the
point: *"LAST, because it is the only rung that makes the deliverable itself worse."*

Every distorting constraint in the 2026-09-13/14 work traces to that rung:

| Distortion | Where it is recorded | What it actually was |
|---|---|---|
| The $0.0017 headroom cliff | `run-budget.test.ts`, RFC-19 §8.4 | a margin that had to be defended by a test every time a prompt was re-priced |
| The 0.181-vs-0.182 copy price | `STEP_COST_ESTIMATES_USD.copyAttempt` | a per-attempt cost that could not be priced honestly without firing the rung |
| `07i1-verify-lead-claim` dropped on cold runs | `workflow-e2e.test.ts` step list | the only proof the cover's claim is true, traded for $0.007 |
| The e2e step list carrying a paragraph of apology | same | a product defect documented instead of fixed |

## 1.2 The changes

**(a) `MAX_RUN_SPEND_USD` 1.5 → 1.6**, re-documented as a loop-breaker. Crossing it still switches
the meter to `cheapest-path`; it still never holds and never fails.

**(b) Rung 4 is deleted.** `planRunBudget` has four rungs and no fifth: images → evidence pulls →
optional re-vets → nothing. `plan.maxSelfCheckAttempts` is 3 on every planned run. What replaces
the rung is not another lever but the RECORD — a plan that does not fit runs anyway, says so in
`note`, and `recordRunOutcome` carries estimate-vs-actual into the next run's `ewmaRatio` and
`overrunStreak`. Calibration after the fact, never a cut before it.

**(c) `07i1-verify-lead-claim` is unconditional below the hard max.** It used to share rung 3's
`optionalRevets` flag — "one flag, both rescue paths" — which meant the ladder could delete the
verification to land a $1.00 estimate. A rescue re-vet is optional by its own name; verifying the
claim the whole post rests on never was. It is now priced unconditionally too: a plan that fires
rung 3 pays for the step it is actually going to run, because an estimate that flatters the
tightest plan flatters the plan already in trouble.

## 1.3 The measured consequences, stated rather than discovered later

These are real and they are the ruling working as specified, not regressions.

| Shape | Before | After |
|---|---|---|
| Cold English, default plan | $0.9053, 3 attempts | **$0.9123**, 3 attempts (+$0.007 = `07i1`) |
| Cold Hebrew, default plan | $0.9983, 3 attempts, $0.0017 under target | **$1.0053**, 3 attempts, $0.0053 OVER target, runs anyway |
| First run for a new client (brief refresh) | fitted to ≤$1.00 by cutting an attempt | **$1.0883**, 3 attempts, note says "running anyway" |
| Tightest possible plan | $0.6647 (2 attempts) | **$0.9123** (3 attempts) |
| Saturation ratio (where the tightest plan stops fitting) | 1.50444 | **1.09613** |

**Read the last row.** Any client whose calibrated `ewmaRatio` is above ~1.10 now plans over the
$1.00 target. That is the arithmetic of "never cut a quality attempt" on a run whose tightest
honest plan is $0.91, and it is why the ruling also says to record the overrun: `ewmaRatio` is what
closes the gap, run over run, instead of the ladder closing it by deleting a draft.

The bound that still binds is the **$1.60 ceiling**, and every shape above is well under it — the
cold Hebrew plan has $0.59 of room. Nothing here puts a run on the cheapest path before it starts.

## 1.4 The guards, and what each one now catches

Two guards changed premise rather than threshold, and both got stronger.

**`run-budget.test.ts` — "RFC-19 §8.4"**. It used to pin the exact half-cent at which a drafting
attempt was sold: $0.0006 per attempt bought a $0.2676 overshoot, a quarter of the target given
back to claw a fifth of a cent. Pinning one point was the best guard available while the rung
existed. It now SWEEPS: across four orders of magnitude of added per-attempt cost, from a tenth of
a cent to a whole dollar, the plan keeps three attempts. Re-introduce any attempt lever and one of
the sweep's assertions fails. Both superseded ladders — the pre-Phase-5 order and the Phase-5 order
with the rung still at the bottom — are replayed by hand in the file, so what was deleted stays
visible and priced.

**`workflow-e2e.test.ts`** asserts `07i1-verify-lead-claim` in the cold happy path. The paragraph
that used to explain its absence is kept above it, because the note forecast this exact fix down to
the number ("English cold then keeps this step at $0.9123") and a reader should be able to see the
forecast and the outcome on the same screen.

**`grounding-gate.test.ts`** — the off-brief case ran TWO rounds because the ladder had cut an
attempt. It now runs three, the router turn count goes 13 → 16, and the enumeration says so. That
is the whole cost of the ruling on that path: one more refused drafting round, three turns.

## 1.5 Verified

`agents/instagram-agent`: 2041 passed, 105 skipped (the Chromium render tests, which self-skip
where Chromium is not installed — pixel truth comes from CI). Root `tsc --noEmit`, `check:pricing`,
`check:prompts`, `check:config` and `check:stale` all clean.

---

# Part 2 — Ruling 2, the semantic floor

**Status: candidate 3 written and FALSIFIED; the sweep now measures candidates 4 and 5.**
No threshold in `interest-floor.ts` has moved, and none may until a candidate faces its controls
(RFC-17 §3.4).

## 2.1 The evidence that the instrument is overfitted, counted

Four independent plates that are good and would fail the current floor, all from accounts the owner
supplied as ground truth:

1. `@reputeforge` — `Marketing is ___` / `Business is ___`: one line on bare paper.
2. `@reputeforge` — `An apple` / the Apple logo: two black silhouettes on white.
3. `@karoslabs` — `The playbook`: text only on white, a numbered list.
4. `@karoslabs` — `Marketing, by the numbers`: one large numeral on black.

Plus the closing plate of the anti-AI-design set: ~85% bare paper carrying one line, and the
strongest slide in its carousel.

## 2.2 The two findings from RFC-20 that point the same way

- **Our own decorations disarm the floor.** A decorated grey screen measures
  `largestEmptyRectShare` 0.0148 against a 0.22 bar, so the owner's original "mostly grey"
  complaint would PASS clause C today as long as the plate carries a decoration. Seven of eight
  shipped templates cannot clear the floor without a paint layer covering for them.
- **The occupancy metric penalises Hebrew structurally.** Of the nine rows under the floor in
  RFC-20's calibration sweep, six are Hebrew: the same sentence, the same template, two languages,
  and Hebrew scores lower because it sets denser and covers less frame for the same words.

So the floor punishes good simplicity AND the language an entire phase was built for.

## 2.3 The sentence that governs the rewrite

From RFC-20 §11, and it is the design constraint rather than a remark:

> *The reference plates are not low-occupancy because they are empty — they are low-occupancy
> because they are confident. The bounded object must therefore be built as a COMPOSITION; if it is
> built as a way to pass a number, it will be the plate again.*

## 2.4 Why a lower number cannot fix this, in the repo's own measurements

The obvious move is to lower `OCCUPIED_SHARE_FLOOR`. It does not work, and two tables in the repo
say why.

`OCCUPIED_SHARE_FLOOR`'s own comment, from real renders on the material ground:

    POPULATED   type only, 3-line headline + 4-line body    occ 0.1083  flat 0.9237
    NEGLECTED   the owner's grey screen, one short headline  occ 0.0106  flat 0.9917

Occupancy separates those two by 10x, so a floor in the gap looks available. But the plate this
ruling is actually about — one enormous confident line on bare ground — sits at the NEGLECTED end
of that axis, beside the grey screen, **because both are one short line**. And `boringSlideMetrics`,
measured off the real 2026-09-08 Karos Labs renders, reads `occ 0.18` — HIGHER than the populated
type-only plate it is supposed to lose to.

The difference between a confident one-liner and a neglected one is not how much was said. It is
**type scale, marking and material**, and no threshold on an area metric can see it. The owner is
right that the instrument is the bug.

## 2.5 CANDIDATE 3, WRITTEN AND FALSIFIED — `contentOccupiedShare / occupiedShare`

RFC-17 §3.4 records two candidates already dead: `imageryOrDeviceShare / contentOccupiedShare`
scored the owner's decorated grey screen BETTER than both good reference plates, and a content-span
ratio read 1.00 on every real reference plate. Its standing rule: *"Until a third survives its
controls, no threshold in this file moves."*

A third was written. The reasoning was sound on its face: `occupiedShare` marks a cell when any 4
of its 64 samples carry ink, while `contentOccupiedShare` marks it only when the cell's mean has
left the ground. A thin stroke at body size touches many cells and fills none; a display stroke
fills what it touches. So the ratio should read type scale — and, as a bonus, a decorative ground
would push it DOWN, which is the property that killed candidate 1.

**It is falsified by a control already in this repo, and decisively.** `boringSlideMetrics` — the
owner's own grey screen, measured off real renders — sets `contentOccupiedShare === occupiedShare
=== 0.18`, and its fixture comment says exactly why: *"it carried no ground treatment at all, so
every mark on it was content."* **Candidate 3 scores 1.00 on the defect plate.** A ratio that gives
the thing the floor exists to catch a perfect score cannot be the bar a good plate must clear.

The error is worth naming because it is repeatable: the ratio measures DECORATION versus CONTENT,
not stroke weight. At a 4px cell grid the coverage test is not sensitive enough to separate a body
stroke from a display stroke, and on an undecorated plate the two masks coincide by construction.
The code was written, reverted before it shipped, and is recorded here rather than in a branch.

## 2.6 CANDIDATES 4 AND 5, AND THE INSTRUMENT THAT WILL DECIDE THEM

Both have a physical claim behind them rather than an analogy:

- **Candidate 4 — `inkShare / occupiedShare`.** How much real ink sits inside the cells a plate
  touched. Fat display strokes fill them; body-size strokes graze them. Unlike candidate 3 this
  reads the ink mask rather than a second occupancy mask, so an undecorated plate cannot force it
  to 1. On `boringSlideMetrics` it reads 0.045/0.18 = **0.25**.
- **Candidate 5 — `edgeDensity`.** Perimeter per unit ink, which falls as a glyph grows. Already
  measured on every slide, already carrying a floor (`EDGE_DENSITY_FLOOR` 0.06) for an unrelated
  reason. On `boringSlideMetrics` it reads **0.22**.

**The instrument is the gate-zero sweep**, and it did not need to be built — it renders 100+
populated plates across eight archetypes, three copy lengths, **three type scales** and two scripts
on real Chromium, plus its neglected controls. It simply was not printing the columns. It now
prints `ink`, `text`, `edge`, `iod` and content centroid per row, a POPULATED-versus-NEGLECTED
spread for each candidate, and a **scale ladder**: the same copy at fontScale s, m and l.

That ladder is the decisive test and it costs nothing extra. A real type-scale proxy must order
s → m → l monotonically on identical copy. A candidate that does not is measuring something else,
and it is better to learn that from a table than from a shipped threshold.

## 2.7 What still has no control, and must be built before the threshold moves

The repo has a measured NEGLECTED plate and measured POPULATED plates. **It has no measured
GOOD-SIMPLICITY plate** — the reference slides were read as images in an earlier session and never
stored, and `interest-floor-calibration.test.ts`'s own §11.6 records the grey-screen control as
UNPAID after RFC-20 cut `headline-focus.html`'s statement archetypes out of scope.

So the remaining work, in order:

1. Read the sweep's candidate table off CI and pick whichever separator orders the scale ladder.
2. Restore the grey-screen control and add its CONFIDENT counterpart — the same copy at display
   scale — so the pair differs in exactly one variable.
3. Only then move a threshold, and quote the band it came from in the constant's doc comment.

## 2.8 Direction, once the number exists

Measure the ELEMENTS that make the reference plates work — marked per-word emphasis, a real
material ground, a composition that moves between slides, a structural reason for the slide count —
rather than dry occupancy. Do not hand-tune a threshold to make one plate pass: that is how the
instrument got overfitted the first time.

**One boundary decided in advance.** When the waiver lands it applies to clauses C, D and clause
G's content limb — the emptiness clauses. It must NOT reach clause A (nothing painted), A2 (the
stylesheet did not arrive), B (clipped), F (a wall of text) or G's `noType` limb, which are
integrity rather than composition. Clause E (a cover carries something other than type) is an open
question: `@karoslabs`'s text-only `playbook` plate would fail it, but a display-size glyph may
register as `graphicShare` and clear it on its own. That is a measurement, not an argument, and it
belongs in the same sweep.

---

# Part 3 — Ruling 3, hybrid archetypes

**Status: designed here, NOT implemented, and deliberately not started as a slice.** §3.5 states why
shipping half of it would make the product worse than shipping none of it.

## 3.1 The client's own feed already is the answer

`@karoslabs` runs NAMED EDITORIAL SERIES, and the series is the archetype:

`The breakdown: X` · `Head to head: X and Y` · `The come-up, no N: X` ·
`Marketing, by the numbers: X` · `The playbook, no N` · `The campaign files, no N`

Each series carries its own layout family over ONE shared brand system (a "Karos Labs" header
lockup, a small-caps series tag top-right, a serif headline, an orange highlight on the word
carrying the surprise, a source credit in small type):

| Series | Layout family |
|---|---|
| come-up (Michael Jordan, Beyoncé) | full-bleed photograph, dark, headline low |
| breakdown (Liquid Death) | product on white, dark type |
| campaign files (ALS ice bucket) | photograph, dark |
| playbook ("Four laws that replaced marketing folklore") | TEXT ONLY on white, numbered list |
| by the numbers ("5 to 9% more revenue, for one more star") | big numeral on dark |

**Five layout families, one brand.** Variety comes from the series; finish comes from the shared
system. This is exactly the shape Ruling 3 describes — not a model authoring HTML, but composition
from validated blocks where **the STORY picks the series**.

## 3.2 What this is not

Replacing "eight identical templates" with "one identical reference look" would be the SAME defect
the owner originally complained about, wearing a new costume. It has already happened once on this
project: Phase 2's first pass gave six of eight slides the same diagonal hairline field and traded
"mostly grey" for "mostly striped". Every design change is checked for whether it collapses variety
across RUNS and across CLIENTS, not just within one carousel.

Take the reference's craft. Never its specific look.

## 3.3 WHERE THE SHIPPED CODE ACTUALLY STANDS — and it is further from the ruling than it looks

The audit finding was "eight fixed archetypes, identical for every client". That is the half
everyone remembers. Reading the tree, the OTHER half is the one the ruling is really about:

- **A run can already author raw HTML and CSS.** `instagram-copy@18` §20 gives the writer a
  `customArchetype` object with `bodyHtml`, `css`, `slots` and `fields`, bounded to two per
  carousel. The owner's ruling says the opposite in as many words: *at run time the model does NOT
  author HTML/CSS from scratch.*
- **And it ships to the client on the run that invents it.** `custom-archetype-checks.ts` is
  explicit that it "deliberately does NOT judge the design" — it checks markup safety and that
  every `{{slot}}` has a value. Quality is left to the interest floor, on the pixels, at run time.
  `custom-archetype-memory.ts` then promotes a design into the client's pool after two clean human
  ships. So the pool grows through a human gate, but the FIRST render of a model-authored layout
  goes straight to production. The ruling says a new archetype *is saved as a CANDIDATE for CI
  calibration and never goes straight to production.*
- **`seriesBadge` exists and is inert.** It is a per-client brand token frozen at setup
  (`template-studio.ts` seeds it as `"playbook"` / `"מדריך"`) and rendered as a label. Nothing
  chooses it per run and nothing reads it to pick a layout. The hook the owner's own feed uses is
  in the tree as a string.

So ruling 3 does two things at once: it **narrows** what a run may author, and it **widens** what a
run may compose. Those are not the same change and they do not have the same risk.

## 3.4 THE DESIGN

**A SERIES REGISTRY, per client.** A series binds three things that today live nowhere:

| Part | What it is | Where it comes from today |
|---|---|---|
| trigger | the kind of story this series is for — a teardown, a head-to-head, an origin, a statistic, a rule-set, a campaign post-mortem | nothing; the writer picks layouts slide by slide |
| layout family | an ordered skeleton of archetypes plus a ground treatment and a type register | `skeleton-memory.ts` records skeletons but only to REFUSE a repeat |
| brand system | the header lockup, the series tag, the serif headline, the accent mark, the source credit | already shared and already correct — this part does not change |

**The story picks the series; the series picks the composition.** That is the whole mechanism, and
it is what `@karoslabs`'s own feed does. It replaces "the writer chooses six layouts" with a choice
the writer is actually qualified to make — *what kind of story is this* — and derives the rest.

**Composition from validated blocks, not authored markup.** A series composes from a bounded
vocabulary whose members have each passed validation: the eight bundled archetypes, the client's
Template Studio rows, the ground materials, the mark kinds and the device fragments. A run assembles
them; it does not write CSS. This is the ruling's "slot-based / component assembly", and its
practical test is that a run can produce a PLATE the repo has never rendered without producing a
FILE the repo has never validated.

**The candidate path.** When a run proposes something genuinely outside the vocabulary, it is
stored as a candidate against that client and the slide renders through the validated archetype its
content fits — which is the degrade path `custom-archetype-checks.ts` already has. The candidate
enters the calibration sweep, and it joins the pool only when it clears its role's floor with the
same margin every bundled archetype must clear. `AUTO_PROMOTE_QUALITY_SCORE` and the two-clean-ships
rule stay as they are for the human route; this adds the CI route the ruling asks for.

## 3.5 WHY THIS IS NOT SHIPPED AS A SLICE, AND THAT IS THE POINT

The tempting first commit is the small one: stop `customArchetype` rendering to a client on the run
that invents it, store it as a candidate, done. It is contained, it is the ruling's own sentence,
and it would take an afternoon.

**It would also make the output more repetitive, which is the defect this entire line of work
exists to fix.** Removing the only path by which a run can produce an unseen layout, BEFORE the
composition vocabulary that replaces it exists, leaves every client on eight archetypes again. The
owner's original complaint — *"בנוסף בגלל שזה חזרתי זה נראה AI"* — would get measurably truer while
the commit message claimed to be implementing his ruling.

The same trap is on this project's record twice already: Phase 2's first pass replaced "eight
identical templates" with six of eight slides carrying the same diagonal hairline field, trading
"mostly grey" for "mostly striped"; and RFC-21 §3.2 records the same risk for the reference look.
A narrowing and its replacement have to land together.

So Part 3 is a phase, with its own RFC and its own PR, and its acceptance condition is stated in
advance: **a run can produce a plate the repo has never rendered, without producing a file the repo
has never validated, and variety across runs and across clients is measured rather than assumed.**
