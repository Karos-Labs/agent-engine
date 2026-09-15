# RFC-21 — The owner's three rulings, 2026-09-14

**Status:** Part 1 implemented. **Part 3 implemented** (the series layer). Part 2 has candidates 3, 4
and 5 all falsified as thresholds, the owner's colour correction answered with a four-palette
measurement (§2.6.3), and the one-line control built (§2.7 step 2b) — which changed the question: on
OUR templates a confident one-liner is a HIGH-occupancy plate that already passes.
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

**Status: candidates 3 and 4 FALSIFIED. Candidate 5 — `edgeDensity` — is CONFIRMED as a type-scale
proxy on every template with no averaging (§2.6.2), and FALSIFIED as a standalone threshold by the
same table.** The form it has to take is a conjunction with `textShare`, and the row that sets its
number does not exist yet (§2.7 step 2b). No threshold in `interest-floor.ts` has moved.

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

## 2.6.1 THE MEASUREMENT — CI 34831400323, n=114 populated, n=6 neglected

```
                        POPULATED (n=114)                      NEGLECTED (n=6)
cocc/occ  (cand. 3)     [0.5267 .. 0.9925] median 0.8657       [0.0000 .. 1.0000] median 1.0000
ink/occ   (cand. 4)     [0.6341 .. 0.9600] median 0.8154       [0.4139 .. 0.9251] median 0.6714
edgeDensity (cand. 5)   [0.0277 .. 0.2188] median 0.1002       [0.2365 .. 1.0000] median 0.5009
textShare               [0.0837 .. 0.3592] median 0.1963       [0.0006 .. 0.0191] median 0.0031
content centroid y      [0.1817 .. 0.6483] median 0.4749       [0.0847 .. 0.5597] median 0.3618

scale ladder, same copy at fontScale s / m / l:
  cocc/occ    0.8653  0.8731  0.8936     monotonic UP
  ink/occ     0.8084  0.8072  0.8275     NOT monotonic — it dips at m
  edge        0.0988  0.0921  0.0860     monotonic DOWN
```

**Candidate 3 is dead twice over.** §2.5 killed it on `boringSlideMetrics`; CI reproduces it
independently — `cocc/occ` reads **1.0000 on four of the six neglected controls**, and its neglected
range spans the populated range entirely. An undecorated plate forces the ratio to 1 whatever is on
it, which is the structural error, now measured rather than argued.

**Candidate 4 is dead.** Its bands overlap across 0.634–0.925, and its scale ladder is not
monotonic: 0.8084 → 0.8072 → 0.8275 dips at `m`. Whatever `ink/occ` tracks, it is not type scale.

**Candidate 5 survives both tests, and it is the only one that does.**

1. **The bands do not overlap.** Populated tops out at **0.2188**; the lowest neglected control
   (`closer` with every slot empty) sits at **0.2365**. A real gap, in the right direction: high
   perimeter-per-ink means thin strokes and nothing substantial on the plate.
2. **The scale ladder is monotonic and in the predicted direction** — 0.0988 → 0.0921 → 0.0860 as
   the same copy grows from `s` to `l`. That is the physical claim confirmed: a glyph's perimeter
   grows linearly with size while its area grows quadratically, so the ratio falls as type grows.

It is also already measured on every slide and already carries `EDGE_DENSITY_FLOOR` (0.06) as a
warning for the OPPOSITE failure, a solid wash with no edges. Candidate 5 is the ceiling at the
other end of the same instrument.

**Two honest limits on this result, stated because they decide what happens next.** The gap is
**0.0177, about 8%, on n=6** — real but thin, and thin gaps on six controls are how an overfitted
constant gets set. And the scale ladder moves only 13% across the whole `s`→`l` range, so the
gradient is genuine but shallow within the type sizes we actually ship; the reference plates set
type far larger than our `l`.

## 2.6.2 THE CONTROL PAIR — CI 34833492341, and it FALSIFIES THE THRESHOLD WHILE CONFIRMING THE PROXY

The pair renders one short statement through `cover`, `headline-focus` and `closer` at three type
scales, one variable apart:

```
scale  template          role       occ      flat     LER      ink      text     EDGE     iod      verdict
s      cover             cover      0.2655   0.6765   0.1541   0.2066   0.1623   0.1051   0.1032   pass
m      cover             cover      0.2751   0.6680   0.1427   0.2153   0.1645   0.1027   0.1106   pass
l      cover             cover      0.2919   0.6561   0.1505   0.2274   0.1699   0.0992   0.1220   pass
s      headline-focus    interior   0.4974   0.7809   0.0871   0.2038   0.4727   0.3122   0.0247   pass
m      headline-focus    interior   0.4949   0.7768   0.0912   0.2078   0.4645   0.3018   0.0303   pass
l      headline-focus    interior   0.4918   0.7714   0.0935   0.2133   0.4519   0.2886   0.0399   pass
s      closer            closer     0.5941   0.5077   0.0341   0.4875   0.3631   0.0627   0.2310   pass
m      closer            closer     0.6091   0.4905   0.0257   0.5045   0.3572   0.0612   0.2519   pass
l      closer            closer     0.6076   0.4888   0.0163   0.5063   0.2706   0.0588   0.3370   pass
```

**THE PROXY IS CONFIRMED.** `edgeDensity` falls monotonically with type scale on **every template**,
with no averaging to hide behind: cover 0.1051 → 0.0992, headline-focus 0.3122 → 0.2886, closer
0.0627 → 0.0588. More ink is painted at `l` in every case, so the scales really did differ. The
geometric claim holds.

**AND THE THRESHOLD IS FALSIFIED, by the same table.** `headline-focus` reads **0.2886–0.3122 at
every scale — ABOVE the 0.2365 floor of the neglected band** — while passing every clause. §2.6.1's
clean separation was an artefact of scope: `headline-focus` is in the sweep's `OUT_OF_SCOPE` set, so
its rows were never in the POPULATED band that made the gap look clean.

The reason is not subtle once measured. `edgeDensity` is perimeter per unit ink, i.e. **stroke
fineness**, and *two completely different plates have fine strokes*: an empty one, and a
text-dense one. `headline-focus` carries `textShare` 0.45–0.47. **A ceiling on `edgeDensity` alone
would refuse the densest real plates and the emptiest ones with the same number.**

**So candidate 5 is a proxy, not a gate, and the correct form is a CONJUNCTION** — the same shape
clause D already uses. `textShare` separates the two populations cleanly and in the other direction:
populated [0.0837 .. 0.3592] against neglected [0.0006 .. 0.0191], a 4.4x gap, with
`headline-focus` at 0.45 far above both. So:

> Among plates that carry LITTLE (low `textShare`, low occupancy), `edgeDensity` separates the
> confident from the neglected: display type paints few, fat strokes and scores low; a small
> headline parked on flat ground paints many fine ones and scores high. A text-dense plate is
> excluded by its own `textShare` and never reaches the question.

That is the rule to build, and every number above supports it. What it still needs is the row that
sets its number: a plate with ONE line at display scale and nothing else — which none of the three
archetypes here renders, because all of them carry a body.

**This is what the control pair was for.** It cost one CI run and it caught a threshold that the
aggregate table would have justified and that would have refused our own densest archetypes in
production.

## 2.7 What still has no control, and must be built before the threshold moves

The six NEGLECTED controls in §2.6.1 are **empty-slot renders** — every copy slot blank. They prove
candidate 5 separates *populated* from *completely empty*, which is the easier half of the question.
The hard half is the owner's grey screen: a plate with a real headline, set small, parked low, on
flat ground. **The repo has no measured row for it**, and none for its counterpart either — the
reference slides were read as images in an earlier session and never stored, and
`interest-floor-calibration.test.ts`'s own §11.6 records the grey-screen control as UNPAID after
RFC-20 cut `headline-focus.html`'s statement archetypes out of scope.

So the remaining work, in order:

1. ~~Read the sweep's candidate table and pick the separator that orders the scale ladder.~~
   **DONE — candidate 5, `edgeDensity`.** §2.6.1.
2. ~~Build the pair that differs in exactly one variable.~~ **DONE — §2.6.2.** It confirmed the
   proxy and falsified the single-metric threshold in the same table.
2b. ~~Build the ONE-LINE plate.~~ **DONE — §2.6.3.** `headline-focus.html` with one line and an empty
   body, at display and body scale, across four palettes.

> ### ⚠ SUPERSEDED 2026-09-14 BY A MEASUREMENT — READ `docs/instagram-restraint-reference.md`
>
> The paragraph below concludes that our templates cannot produce the shape the ruling is about. **That
> reading was measuring the DECORATION.** Quieting the full-plate hairline from 22%/9px to 8%/14px drops
> the identical plate from `occupiedShare` 0.5094 to **0.1300**, and it then FAILS clause D on every
> palette (CI 34861097819). Roughly 38 of those 51 points were the dot field, not the type.
>
> **The case IS reproducible. It was hidden by the paint.** And the floor is what holds the paint in
> place: the same change turned `slide.html` heroless, `closer.html` in Hebrew, the marked-emphasis case
> and the whole gate-zero sweep red. The next piece of work is the floor itself.

**AND IT CHANGED THE QUESTION.** That plate measures `occupiedShare` **0.5094** and `textShare`
**0.47**. It is not sparse at all: our templates scale display type to fill the frame, so a confident
one-liner on OUR system is a HIGH-occupancy plate that clears every floor with room. It passed on all
four palettes at both scales.

So the refusal the ruling is about **is not reproducible on our own templates**, and that is the
honest finding rather than a failure to find one. The reference plates are low-occupancy because that
publisher sets small type on a large paper ground; ours does not do that, and the plate the owner
would be glad to ship already ships.

What remains, in order:

2c. **Reproduce it or close it.** Either build the plate that genuinely fails — small type,
   deliberately placed, on a quiet ground, which is `headline-focus.html`'s cut statement archetype
   (RFC-20 §11.4) — or record that our template system cannot produce the shape and close the
   deliberate-emptiness question against our own renders. **Do not ship a waiver for a case no plate
   exercises.**
2d. Calibrate on an INVARIANT share (§2.6.3). `edgeDensity` is invariant and does track type scale,
   but it is a PROXY and not a gate: it is dominated by imagery share, so a text-dense plate and an
   empty one both score high. Any rule using it is a conjunction with `textShare`.
3. Then wire it, and only into clauses C, D and clause G's content limb — never into A, A2, B, F or
   G's `noType` limb (§2.8). A waiver that admits the plate the floor was built for would be worse
   than no waiver, so the acceptance condition is written as a pair: **the confident plate is
   waived AND the grey screen is still refused**, including the grey screen with marks stuck on it
   (RFC-17 finding 5).
4. Re-sweep and quote the new band in the constant's doc comment.

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

**Status: IMPLEMENTED, with its replacement, which is what §3.5 argued for before any of it was
written.** `editorial-series.ts`, the `04i2-select-series` step and prompt @19 §29 ship together, so
the composition vocabulary exists in the same commit that starts using it. §3.6 records what shipped.

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


## 3.6 WHAT SHIPPED

`src/workflow/editorial-series.ts` holds six generic editorial formats, each binding a story-shaped
trigger to a layout family over the one shared brand system: `by_the_numbers`, `head_to_head`,
`the_breakdown`, `the_playbook`, `field_notes`, `in_their_words`. Every layout they compose from is an
archetype the repo already renders and calibrates, and never `custom` — a test reads the module's
import list off the source and fails the moment it reaches for a template directory or a CSS string.
That import boundary IS "composition from validated building blocks".

`04i2-select-series` picks one from the post's own evidence: the kinds of fact card the ANGLE rests on
(not everything research returned), and whether the angle's title sets two things against each other.
`wf.step.code`, no model call, $0.00 on `rawEstimate` by construction, identical across a resume.

Prompt **@19 §29** hands the writer the skeleton and states the one thing that must not be
misunderstood: the series constrains the SEQUENCE, §7's per-archetype requirements constrain the FIT,
and where they disagree the fit wins. `copyAttempt` is re-priced 0.181 → 0.185 in the same commit.

**Rotation is the owner's repetition complaint as a property.** A format used in the last two shipped
posts is held out, so three consecutive runs on ONE UNCHANGED STORY get three different formats and
three different opening archetypes. The test asserts both, and asserts its own premise — the same
three runs without the history come back identical — so it is measuring the rotation rather than
agreeing with it.

### Four bugs the tests found before the code shipped

1. `skeletonFor` returned a two-slide carousel on a NaN count, because `Math.max(4, NaN)` is NaN. A
   cover and a closer with no post between them, and no clause would have refused it: every plate on
   it is fine.
2. `head_to_head` could be chosen by the angle's framing alone, handing the writer a comparison
   skeleton with nothing to compare. It is now the one series whose signal is a GATE rather than a sum.
3. Two series opened on the same archetype, so a rotation between them would have produced a post that
   reads the same on the slide after the cover.
4. The `ledger.appendEvent` sat outside the checkpointed step and re-fired on resume —
   `resume-idempotency.test.ts` counted it.

### One decision worth naming

`countComparedEntities` uses a per-script list of comparison connectives rather than counting
capitalised spans. A capitalisation heuristic would have denied the format to every RTL client, which
is the same shape of defect as calibrating a colour metric on one brand's palette. A language not on
the list returns 0 and falls through to the general teardown: **wrong toward the default, never toward
a format that cannot be filled.**

### What is NOT built, and is the next slice

The CANDIDATE path. `customArchetype` still renders model-authored markup to the client on the run
that invents it. Now that the composition vocabulary exists, narrowing it no longer costs the variety
it used to — which is precisely the condition §3.5 said had to be met first.

---

# 12. CLAUSE H — THE SEMANTIC FLOOR (RFC-21 Part 2)

**This closes the question Part 11 kept re-opening, and it closes it by changing what is measured rather than
what the number is.**

## 12.1 The six failures, and the one thing they share

| candidate / clause | how it died |
|---|---|
| `occupiedShare` (clause D) | demanded decoration, and accepted it from anywhere — PR #124 |
| `contentOccupiedShare` (clause G, pixel limb) | palette spread **0.9404** on a quiet plate |
| `flatBackgroundShare` | moves with the material at `flat` 0.925 |
| `edgeDensity` | five refusals; finally, moves **both ways** across templates in one run |
| `contentOccupiedShare / occupiedShare` | reads **1.00** on the defect plate itself |
| `displayTypeScale` (`plateSubject`'s type limb) | waived the grey screen at **0.2715** against a 0.055 floor |

And then the geometry went the same way. RFC-21 §2.9 measured `largestEmptyRect` giving **four different verdicts
on four brand palettes for one plate**: `bundled dark = dead-space`, the other three `pass`.

> **Every mask in `slide-metrics.ts` is cut at an ABSOLUTE distance, so on a quiet plate nothing measured off the
> pixels is palette-invariant — not a share, and not a rectangle derived from one.**

That sentence is the whole of Part 11 and Part 12's premise. It also means a seventh pixel candidate was never
going to work, and proposing one would have been the eighth cycle of the same mistake.

## 12.2 The answer was in the ruling all along

The owner, 2026-09-14: *make sure the metrics are agnostic to colour and rest on the absence of **elements,
structure** and contrast rather than on thresholds fitted to one palette.*

**Count the elements.** `countContentElements` already existed — `visual-qa-pre-checks.ts` has read it since
Phase 2 for `default:two-elements-per-slide`, which reports to the judge. Clause H reads **the same function**,
and refuses.

It counts what the ASSEMBLED document carries: the prose fields that survived `LAYOUT_FIELD_KEYS`, the hero
image, a list's rows fragment, a device fragment, a closer's recap strip. **A brand palette cannot reach any of
them.** Re-skin the entire kit and the count is identical — the property six pixel candidates could not offer.

And it is the reference's own rule, already written down as a count: `@semrush` and `@buffer` carry **three or
four element groups**; the prep render the owner rejected carried **nine, three of which said the same sentence**.

## 12.3 The floor is 2, and deliberately not 3

```
the owner's grey screen  one headline, nothing else        1   REFUSED
a statement and a body                                     2   passes
a composed statement plate with its bounded object         3   passes
```

2 refuses exactly the plate the complaint named and nothing more. 3 would refuse every honest
headline-and-body slide whose copy carries no figure — and while §11.4 argues such a plate *should* carry an
object, **a gate is the wrong instrument for an argument about craft. A floor refuses neglect; it does not
enforce a target.** The 3–4 norm belongs in the prompt and in the judge's report.

## 12.4 What it is not

Not a replacement for clause E — a cover still has to carry a photograph or a device, and that is a question
about *which* elements. Not a replacement for clause F — a wall of text has plenty of elements. Clause H answers
one question: **is there more than one thing here.**

It **abstains** when the caller supplies no count, and the abstention is asserted, because an abstention looks
exactly like a pass from outside.

## 12.5 What it let us restore

G1, G5 and RFC-21 §2.9 were marked `it.fails` earlier in this same branch — known-red, with the measurement that
the grey screen is not separable by geometry (bundled `LER` 0.3337 over the ceiling, paper 0.2707 under, marked
0.2036 well under). **All three are back to `it`.**

G5 is the one worth reading. Its claim was always *marks cannot buy a plate a pass*, and it asserted that on the
rectangle — which was the wrong measurement, because **marks genuinely do close the hole** (§11.6 recorded 0.2278
before this branch existed). Clause H carries the claim properly: five swatches painted on one headline is still
**one element**. *Emphasis is not content.*

## 12.6 The remedy, and the one thing it may not do

`one-element` sits high in `KIND_PRIORITY` — after the render-integrity kinds, ahead of every geometric one —
because it is the only kind on that list that is a statement about content. A plate carrying one element usually
also reports a hole, and remedying the hole first would spend the attempt's free chance moving type around a
plate that has nothing on it.

Its only free remedy is a device built from a figure the slide already states. **It deliberately does not fall
through to `switch-archetype` or `font-scale`**: neither adds an element, so both would re-render identically in
the way that matters. With no figure there is no free remedy and the paid redraft is what that case is for —
**inventing the element is the `pubsub-21839432908803804` failure mode by another route.**

---

# 13. THE IMAGERY FLOOR

## 13.1 Two runs, same week, same budget

```
karoslabs       pubsub-21551118258353204   8 slides   5 with a hero image
                                                      (one AI-GENERATED, n4-gen0.png)
thepitchbydeel  pubsub-21559620763659451   8 slides   0
```

Nothing was broken in either. Images are sourced only for `HERO_IMAGE_LAYOUTS` — `photo` and `cover`, the only
two archetypes whose templates declare an `{{image:hero}}` slot. **So the number of pictures in a post was
decided entirely by the copy model's layout choices, and nothing ever enforced a floor on it.**

Meanwhile `DEFAULT_RUN_SHAPE.photoSlides` is **6**: every run plans, prices and reserves spend for six image
slides. The owner, 2026-09-15: *"it makes no sense that the budget pays for 6 and the post comes out with 0."*

**The two halves of the system had disagreed about this for the whole of the agent's life, and no gate could see
it** — every clause in `interest-floor.ts` judges a slide that has already been composed, and a carousel that
never asked for a picture is not a failing slide, it is eight passing ones.

## 13.2 Promotion, not a gate

`enforceImageryFloor` runs at **04m2**, after the copy is final and **before** 04n binds the concept or any tier
sources anything. Under the floor, it promotes `text_only` slides to `photo`, lowest slide number first.

- **$0.00 and deterministic.** It changes one enum on one slide and lets the existing ladder — client upload,
  library, stock, scrape, **generate** — do the rest. That ladder already works: the `karoslabs` run's fourth
  slide is an AI-generated image it produced unaided.
- **It only ever ADDS.** A draft that chose its own photographs is returned untouched.
- **It promotes `text_only` and nothing else.** `text_only` and `photo` resolve to the *same template*; the
  difference between them is nothing but whether an image was found, so promoting one is not a design change at
  all. Every other archetype is a designed shape whose content would have nowhere to go, and converting a
  `stat_callout` into a photograph throws away the figure that made it a stat callout.
- **A promotion is a request for a picture, never a promise of one.** If sourcing finds nothing the slide is
  reassigned back to `text_only` and ships heroless, with `downgradedForImages` waiving clause E — unchanged
  behaviour.
- **It never holds.** A carousel too dense to reach the floor reports a shortfall and continues, per
  `budgets-adapt-never-hold`.

## 13.3 The floor is 3, and it is a composition number

Not 6. `photoSlides: 6` is what the run may **spend**; enforcing it as a composition target would make three
quarters of every carousel a photograph and produce exactly the post prompt `instagram-copy` warns against —
*"one rhythm, reads as filler."* The budget over-estimating is the safe direction and the owner's own rule.

3 comes from `docs/instagram-restraint-reference.md`: `@semrush` and `@buffer` carry a real photograph or a real
diagram on roughly every third plate — never on every one, and never on none. On an 8-slide carousel that is 3.

**It is a floor, not a target.** A draft that wants five photographs keeps five. What it refuses is the shape it
was written for: a post with one picture, or none.
