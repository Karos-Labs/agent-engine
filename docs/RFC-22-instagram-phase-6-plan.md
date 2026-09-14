# RFC-22 — Instagram Phase 6: the calibrated judge, the golden set, and a gate worth having

**Status:** PLAN ONLY. Nothing here is built. Written 2026-09-14 at the end of the session that
shipped RFC-21, so the next session starts from a costed plan rather than from a roadmap line.

---

## 0. FIRST, A NAMING COLLISION THAT WILL COST SOMEBODY AN HOUR

**`RFC-19` is titled "no run dies of a quality verdict (Phase 6)". That is NOT this phase.** RFC-19
shipped in PR #113 and is done. The roadmap's phase list and the RFC numbering drifted apart, and the
owner's "Phase 6" is the LAST item on the roadmap:

> calibrated visual QA judge, live golden set, real performance insights, useful human gate.

That is what this document plans. Read RFC-19 as background, never as this phase's spec.

---

## 1. IS IT UNBLOCKED? YES, AND THE ARGUMENT CHANGED

The standing reason Phase 6 was last (`instagram-roadmap-order`):

> Phase 6 calibrates a visual judge and builds a golden set AGAINST the interest floor. The floor is
> currently disarmed by our own decorations. Calibrating a judge against a broken instrument means
> doing it twice.

Three things happened since, and together they clear it:

1. **RFC-20 removed the disarming decoration** from the archetypes that carried it, and recorded the
   nine rows where it did not (the gate-zero sweep's baseline ratchet). The instrument is no longer
   passing a decorated grey screen.
2. **RFC-21 §2.6.3 established which metrics are trustworthy across brands.** `occupiedShare`,
   `inkShare`, `textShare` and `edgeDensity` are palette-invariant to 3-4 decimals;
   `contentOccupiedShare` (42% swing) and `flatBackgroundShare` (~11%) are not. **Calibrate on an
   invariant share.** A judge calibrated against a palette-dependent one would be calibrated for one
   client's brand colours.
3. **RFC-21 §2.7 closed the deliberate-emptiness worry for our own renders.** A confident one-liner on
   our templates measures `occupiedShare` 0.5094 — our templates scale display type to fill the frame,
   so the reference accounts' low-occupancy shape is one we do not produce. The floor is not refusing
   good plates we actually make.

**So calibrate now.** What is still open (§6) is bounded and none of it is a reason to wait.

---

## 2. WHAT THE JUDGE IS TODAY, BEFORE CHANGING IT

`08b-visual-qa-attempt-N`, prompt `instagram-visual-qa@4`, one Flash call.

**It does not see pixels.** It is given the rendered attempt's structured `fields`/`images`, the
frozen config's `check: "render"` rules plus four standing elevated criteria, `brandAssetContext` /
`brandPalette`, and — when the run had a vision backend — `renderedInspections`, which is what a
vision model reported about the actual PNGs. Since v4 it also receives `interest` (the floor's
per-slide measurement) and `previousSkeleton` / `thisSkeleton`.

**So it is a reasoner over other instruments' output, not an eye.** That is the single most important
fact for calibrating it: its errors are inherited from what it is shown at least as often as they are
its own. A calibration that cannot separate "the judge was wrong" from "the judge was told wrong" will
produce a prompt rewrite that fixes nothing.

---

## 3. THE WORK, IN THE ORDER IT SHOULD BE DONE

### 3.1 DAY ONE, BEFORE ANY CODE: start the Instagram Graph API access

`instagram-roadmap-order` records this as deliberately deferred with real lead time — a business
account, permissions, and app review. **It is the only item with a multi-week external dependency, and
it is worth nothing until it lands.** Start the application on the first day of the phase and build
everything else while it is pending.

What it buys: saves, reach and shares per post — the only signal in this whole system that is not our
own opinion of our own work. Everything else in Phase 6 measures whether we agree with ourselves.

**Owner action, not an agent action.** Expect to wait.

### 3.2 THE GOLDEN SET — and it is a LABELLED set, not a collection

A golden set is only worth the labels on it. The judge already produces verdicts; storing more of them
proves nothing.

- **Source.** Real prep renders across the eight archetypes, both scripts, all three type scales, and —
  new since RFC-21 — **at least three brand palettes**, including one near the 4.5:1 contrast floor. A
  set drawn from one brand calibrates a judge for one brand.
- **Size.** Start at 60-80 posts. Enough that a 10-point agreement difference is not noise; small
  enough that the owner will actually label it.
- **The label is the owner's.** `instagram-roadmap-order` already records that he is the gate for
  Hebrew quality — *show him the register card and rubric text, do not self-certify it* — and
  `instagram-quality-reference-accounts` records that the bar is his. The same applies here: the agent
  does not get to grade its own homework. Two labels per post is enough: **would you post this** and,
  when no, **which of the judge's axes should have caught it**.
- **Store it where a run can read it.** A fixture directory of PNGs plus a JSON label file, in the
  repo, so the calibration is a test rather than a notebook.

### 3.3 CALIBRATE, AND MEASURE THE RIGHT THING

The metric that matters is **not** the judge's accuracy. It is:

> On the posts the interest floor PASSES, how often does the judge agree with the owner?

The floor already catches what a deterministic metric can catch. A judge that agrees with the floor is
free to delete — its entire value is the set where it disagrees and is right.

Report four numbers, and the second is the one to optimise:

| | |
|---|---|
| agreement with the owner on floor-passed posts | the headline |
| **posts the owner rejected that the floor passed and the judge caught** | **the judge's whole reason to exist** |
| posts the judge rejected that the owner would have posted | the cost, and it is real: a false refusal buys a redraft |
| verdicts the judge could not settle | the honest abstention rate; a judge that never abstains is guessing |

**Separate the judge's errors from its inputs' errors.** For every disagreement, record whether
`renderedInspections` was present and whether the floor's numbers were in the judge's input. RFC-21's
method applies: a candidate explanation is not accepted until a control rules out the alternative.

### 3.4 THE HUMAN GATE — and this is the item with the clearest live defect

The gate is not useful today, and there is a recorded incident: the TikTok audit of 2026-09-09 found
**two gate-timeout approvals at QA 3/10**. Posts nobody looked at shipped because the gate timed out
and auto-approved.

Two causes, both known:

1. **Everything is `1h` / `auto_approve`.** A gate that approves on timeout is a delay, not a gate.
2. **The timeout sweep does not run in prep.** `gate-auto-approve-needs-scheduler-sweep` records that
   `POST /api/v1/maintenance/sweep-gate-timeouts` must be called by Cloud Scheduler per environment,
   and **the Cloud Scheduler API is not enabled in `karoscmo-prep` — the owner has to enable it.**

What "useful" should mean, and it is cheap: the gate shows the reviewer **the judge's verdict, the
floor's numbers and the specific slide each one names**, and the timeout policy differs by verdict — a
post the judge passed may auto-approve; a post it flagged waits for a person. That is a policy change
plus a payload change, not a new system.

### 3.5 PERFORMANCE INSIGHTS, ONCE §3.1 LANDS

Join saves/reach/shares to the skeleton, the series (`seriesId`, new in RFC-21 Part 3), the archetype
sequence and the floor's per-slide numbers, all of which are already recorded per shipped post in the
client's beliefs document.

**The first question to ask of that join, and it is the owner's original complaint in measurable
form:** do posts whose format repeats a recent one perform worse? RFC-21's rotation assumes they do.
It is the first assumption in this system that real data can settle, and it should be the first thing
checked rather than the last.

---

## 4. WHAT PHASE 6 MUST NOT DO

- **Do not move an interest-floor threshold to make the judge agree with it.** RFC-17 §3.4's rule
  still binds and RFC-21 spent a whole session demonstrating why: five candidate separators died
  against controls.
- **Do not calibrate on `contentOccupiedShare` or `flatBackgroundShare`** (RFC-21 §2.6.3).
- **Do not let a quality verdict kill a run.** RFC-19 is shipped and this phase must not walk it back.
- **Do not fit to the reference accounts.** `instagram-three-locked-rules`: the GT is a bar, not a
  template.
- **Do not cut work to hit $1.00.** The owner's budget ruling (RFC-21 Part 1) is that the target
  adapts optional work only. Estimate, adapt, deliver, record the overrun.

---

## 5. COST

The judge is one Flash call and already priced (`STEP_COST_ESTIMATES_USD.visualQa`). If Phase 6 keeps
it at one call, the per-run cost of the whole phase is **$0.00** — everything else is calibration work
that happens in CI and at review time, not on the run.

If a second judging pass is proposed, price it against the current cold plan first: cold English is
$0.9243 and cold Hebrew $1.0173 against a $1.00 target, so a new per-attempt call costs three times
its own price. The ceiling that binds is $1.60, and both shapes have room — but the rule is to re-price
`copyAttempt`-style keys in the same commit as the change, which `run-budget.ts` states about itself.

---

## 6. THE DEBTS PHASE 6 INHERITS, EACH WITH A DISPOSITION

| Debt | Where | Disposition |
|---|---|---|
| **The CANDIDATE path is not built.** `customArchetype` still renders model-authored markup to the client on the run that invents it. | RFC-21 §3.6 | **Build it in Phase 6 or just before.** The blocker is gone: the composition vocabulary now exists, so narrowing no longer costs variety. This is the last unimplemented half of the owner's ruling 3. |
| **Nine baseline rows** in the gate-zero sweep, all `occupiedShare` misses on small-type panel archetypes, six of nine Hebrew. | RFC-20 §11.10 | Check whether the rebuild retires the metric before building a composition for them. Recorded as a DEBT, not a pass. |
| **The material ground ships behind a flag**, because 7 of 8 templates could not clear the floor without a paint layer. | RFC-20 §11.3 | Leave. It is a template-composition job (RFC-20 §11.4), not a judge job. |
| **The statement archetype was cut** from `headline-focus.html`. | RFC-20 §11.3 | Only needed if someone wants to close the deliberate-emptiness question empirically (RFC-21 §2.7 step 2c). Not a Phase 6 blocker. |
| **`contentOccupiedShare` is palette-dependent** and clause G reads it. | RFC-21 §2.6.3 | The margin absorbs it today and a test pins where it stops. Do not calibrate on it. |

---

## 7. THE ONE-PARAGRAPH VERSION

Start the Instagram Graph API application on day one because it is the only thing with weeks of lead
time. While it is pending, build a **labelled** golden set of 60-80 real prep renders spanning
archetypes, both scripts, three type scales and **at least three brand palettes**, labelled by the
owner and stored in the repo as a test fixture. Calibrate the visual judge against it and report one
number above all others: **how many posts the owner rejected that the floor passed and the judge
caught** — because that set is the judge's entire reason to exist. Separately and cheaply, fix the
human gate so a flagged post waits for a person instead of auto-approving on timeout, which needs the
owner to enable the Cloud Scheduler API in `karoscmo-prep`. When insights land, join them to the
series and skeleton already recorded per post and check the assumption RFC-21 shipped on: that a
repeated format performs worse.
