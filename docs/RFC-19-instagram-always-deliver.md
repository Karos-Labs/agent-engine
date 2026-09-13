# RFC-19 — Instagram agent: no run dies of a quality verdict (Phase 6)

Status: specified. Follows RFC-13 (Phase 0/1, #84, #94), RFC-14 (Phase 2/3, #107, #108), RFC-15/RFC-16
(Phase 4, #109, #110), RFC-17 (design system, #112) and RFC-18 (Phase 5, value and the whole post). It
closes the deferral RFC-18 §9 wrote down and declined to fix.

Driven by the owner's requirement, translated from Hebrew:

> **"I want to make sure there are no runs that will fail. If the score is not good then it should repeat
> steps or do something else, but THE CLIENT CANNOT RECEIVE A FAILED RUN unless it is a real fault."**

This is the standing budget amendment — *estimate, adapt, past target drop optional work, past the hard max
finish on the cheapest complete path and **deliver*** — generalised from money to **quality**. The rule for
dollars is already built and proved (RFC-18 §7.3, `run-budget.ts:1508-1573`). Phase 6 gives a refusing
**gate** the same guarantee that a refusing **budget** already has.

---

# Part 1 — Brief

Worktree `C:\Users\1\Documents\KarosLabs\agent-engine-igdeliver`, branch `feat/instagram-always-deliver`,
cut from `origin/main` at `f1c7afa`. Never touch `C:\Users\1\Documents\KarosLabs\agent-engine` or any other
`agent-engine-*` worktree. Files are CRLF; use Edit/Write, Python writes need `newline=""`.

**Phase 6 changes no pixels.** `publish.renderCarousel` stays at `1.3.1`. No prompt text changes, so
`scripts/prompt-registry.ts` is untouched and the five-step prompt checklist does not apply. No tool's
behaviour changes, so no `TOOL_VERSION` moves. No gate's bar moves.

## The carve-out, stated once and narrowly

A run may legitimately stop when:

1. **There is nobody to write for** — no client config, no subject from any of three independent sources.
2. **A human reviewer rejected the batch** — the gate doing its job.
3. **A genuine tooling or infrastructure failure where no output exists at all.**

A run may **not** stop because:

- a judge scored below a bar;
- a self-check never passed;
- a floor refused every attempt;
- a schema came back malformed from a model.

Those are **quality events**. The run must still hand the client something, marked degraded, with the reason
recorded.

## Binding constraints (these override anything below that conflicts)

- **There is $0.0017 of budget headroom.** `run-budget.test.ts:597` pins the cold Hebrew plan at
  **$0.9983** against `TARGET_RUN_SPEND_USD = 1.0`, and that test's own comment calls it *"the tightest
  number in the file"*. `copyAttempt` is $0.181. **A change that adds $0.0018 to the plan costs a drafting
  attempt** — rung 4 (`run-budget.ts:1562`) fires and `maxSelfCheckAttempts` goes 3 → 2. Cutting an attempt
  to pay for a retry is self-defeating, so **RFC-19 adds no priced step anywhere.** §7 proves it.
- **`estimateRunCost` is not touched.** Not one key, not one number, not one rung order.
- **No bar moves.** `MIN_RELEVANCE_SCORE`, `relevanceFloor`, `MIN_BRAND_FIT`, `VALUE_MAX_RETURNS`,
  `MAX_REVISION_ROUNDS`, the interest floor, `checkExpectedScript`'s share, `checkPaletteWithinKit`'s kit,
  `DEFAULT_RENDER_RULES`. Every gate refuses exactly the drafts it refuses today. **What changes is what
  happens after the refusal.**
- **A degraded delivery must be honest.** The client-visible status says degraded, the reason names the gate
  and the score, and the deliverable records which checks did not pass. Silently shipping a bad post as
  `completed` with nothing attached is **worse** than holding. The owner asked for a deliverable **plus the
  truth**.

---

# Part 2 — Design

## 1. The one sentence this phase turns on

Every quality-driven refusal in this agent happens **inside an attempt the run has already paid for**, and
today the run throws that attempt away.

**The fix is never to buy another attempt. It is to stop discarding the one in hand.** On the final attempt a
gate that refuses records a typed finding and the run *walks forward*; the loop exits the way a clean attempt
exits; the post ships `completed` with a `selfCheck` degrade marker carrying every check that did not pass.
Zero new model calls.

`isFinalAttempt` already exists — computed **once** at `create-instagram-agent-workflow.ts:5588` (**WF:5588**
from here on), with a doc comment that describes this exact defect in its own words:

> *"**The single most important fact in this loop.** The loop's exit at `!finalOutcomeOk` throws
> `WorkflowHeld`, so EVERY `continue` on the last attempt is a hold, and a judgment gate that returns work on
> the final attempt is a hold generator wearing a gate's clothes."*

Phase 4 wrote that guard into four language branches. Phase 5 hoisted the variable and wrote it into three
more. **Phase 6 finishes the sentence**: nine more call sites read the local that is already there.

## 2. Two corrections to the record, before anything else

**(a) The file has 14 textual occurrences of `WorkflowHeld` and exactly FIVE throws.** `WF:1246`, `:3286`,
`:3611`, `:3753`, `:8536`. The other nine are doc comments — and *three of them assert the opposite
invariant*: `WF:4771` (*"`WorkflowHeld` is never thrown on any value path"*), `WF:7158`, `WF:7382` (*"NO
`WorkflowHeld` ON ANY LANGUAGE PATH"*). **`WF:7382`'s invariant is false as written today**, because `07e`
and `07e2` — the deterministic pre-checks in front of the gate it was written about — still `continue` into
`WF:8536`. §4 item 4 makes it true.

**(b) There are two different `degraded`s and this design must not conflate them.** The *engine's* `degraded`
(`workflow-engine.ts:294-302`) means an uncaught throw, and it hard-codes `output: null`
(`workflow-engine.ts:126-127`). **"Deliver the best attempt you already paid for, marked degraded" therefore
cannot be expressed by throwing.** It can only be expressed by *returning* through `09b`, the way
`WF:9995-10019` already does for `budget`, `visualInterest`, `language` and `contextGrounding`. Every path in
this RFC returns. The agent's run status stays **`completed`** — the shape `zero-held-guarantee.test.ts:519`
already asserts.

## 3. Three mechanisms, and that is all

### Mechanism A — FALL THROUGH, DON'T FALL OVER *(primary; covers 9 of the 12 feeders)*

Every quality gate inside the attempt loop adopts the shape Phase 4 and Phase 5 already built (`WF:7268`,
`WF:7431`, `WF:7456`, `WF:8237`):

```ts
if (!isFinalAttempt) { returnToCopyWith(<reason>); continue; }
recordSelfCheckFinding({ gate, step, kind, detail, slide?, score?, remedy });
// no continue — the attempt walks on to the next step
```

Nothing is invented. Nine call sites adopt an existing local and an existing pattern. Because a fall-through
reaches the bottom of the loop body, `finalOutcomeOk = true` and `break` happen through the **existing**
assignment block at `WF:8520-8532`. **No new terminus is introduced.**

`returnToCopyWith` (`WF:5570`) is used on every non-final return, never a bare `continue` — otherwise the
finding never reaches `selfCheckSteer` and the redraft is blind. Two sites are bare `continue`s today
(`WF:8355` palette, `WF:8509` QA-unjudged) and both are fixed; see §4 items 8 and 10.

### Mechanism B — THE SALVAGE REGISTER *(backstop; covers the 2 feeders where the final attempt has no artifact of its own)*

A run-scoped register recording the deepest artifact set any attempt reached:

```ts
type Salvage = {
  attempt: number;
  depth: 1 | 2 | 3 | 4;        // 1 copy · 2 +selections · 3 +slidesData · 4 +rendered
  copy: InstagramCopyOutput;
  selections?: ImageSelection[];
  slidesData?: RenderCarouselInput;
  rendered?: RenderCarouselResult;
  findings: SelfCheckFinding[];
};
let salvage: Salvage | undefined;   // replaced only on STRICTLY GREATER depth; ties → the later attempt
```

Read **only** when the final attempt cannot produce a draft of its own — `05` returned
`tooling_error`/`content_fail`, or `06`'s vetting did. The salvaged attempt is re-assembled and, if it never
rendered, re-rendered under two new checkpointed **code** steps, `rev("07s-salvage-slides-data")` and
`rev("08s-salvage-render")`. Both are **$0**: `assembleSlidesData` is pure, and `interest-relayout.ts:5-60`
states and prices the other half — *"a Chromium render is $0, a Sonnet redraft is $0.126."*

This is what gives *"the best attempt you already paid for"* a **definition** (greatest depth, then latest)
rather than a vibe.

### Mechanism C — A GATE THAT COULD NOT RUN HAS NO OPINION

This posture is already written, at `WF:6966-6977`: *"A gate that could not RUN is not a verdict on the
draft, and this one is free."* `07e2` got it right and nowhere else did. A **registered** tool returning a
non-success outcome, or a `tooling_error` verdict, is not a verdict on the draft — on **every** attempt, not
only the final one.

Distinct from an **unregistered** tool, which is a deploy defect with nothing to measure with and stays a
`WorkflowToolingFailure` (`craft-hygiene.ts:313`, `slides-data.ts:1679`, `run-gate.ts:21`). That distinction
is the whole of §6 item 8.

### Mechanism 0 — one free repair, and only one

`repairSourceRefs`: for each slide whose `sourceRef` matches no research claim verbatim, normalise both sides
(NFC, trim, collapse inner whitespace, strip wrapping quotes and one trailing `.`/`,`) and, **only on a
unique normalised match**, snap `sourceRef` to the claim verbatim. Then re-run the real `checkSlidesData`; the
patch is kept only if the gate now passes, and **discarded whole** otherwise — `applyNativeCorrections`'
`patchRefused` shape (`WF:7478-7511`) and `interest-relayout`'s rollback (`WF:8191-8209`).

Never a fuzzy match, never a nearest match: a fabricated citation is worse than the refusal. This repair
cannot invent a citation, only match one that already exists modulo whitespace.

**Every other proposed repair is rejected**, and the rejections are decisions, not oversights — see §9.

## 4. Exit-by-exit: every exit classified `quality-driven`

Ordered as the loop executes. **"Records"** always means one `SelfCheckFinding` row (§5), carried to the `09a`
gate payload, the persisted deliverable, one ledger warn, and the typed workflow return.

| # | Exit | Trigger | Disposition |
|---|---|---|---|
| 1 | **`WF:8536`** self-check exhaustion | any `continue` on the last attempt | **Terminus split.** With Mechanism A, `finalOutcomeOk` is true on the final attempt in every case except "no draft exists at all". Becomes `if (!finalCopy) throw new WorkflowHeld("no drafting attempt produced copy that cleared its own schema (${maxAttempts} attempt(s)) and no earlier attempt could be salvaged — there is no draft to deliver. Last: ${lastCopyFailure}")`. **The generic string `"step 07's self-check never passed after N attempt(s)"` is deleted outright** — it is the wording that let nine unrelated causes hide behind one sentence. |
| 2 | **`WF:6774`** `07` `checkSlidesData` | count, selection mismatch, mis-cited `sourceRef`, banned word/char, `never_say`, missing `required_framing` | `SlidesDataSelfCheck` gains `kind: "count" \| "pairing" \| "source-ref" \| "banned-term" \| "compliance" \| "compliance-unverified"` (§6, P2). **Every attempt:** `source-ref` → Mechanism 0 repair first. **Final attempt:** `pairing` → **deterministically repaired**, synthesizing `{ n, imagePath: null }` for each slide with no selection and dropping extras — the identical operation `07a` already performs at `WF:6915`, `remedy: "repaired"`. `count`, `source-ref`, `banned-term` → recorded, ship. `compliance`/`compliance-unverified` → §5.5. |
| 3 | **`WF:6782`** `07b` craft hygiene | em dash, `!`, ALL-CAPS, Title Case, Hebrew banned phrase | Mechanism C fixes `craft-hygiene.ts:322`/`:327` on every attempt. **Final attempt:** record `{ gate: "craft", detail: <the lint sentence verbatim> }`, ship. Title Case and em dashes are style — exactly the class the owner names. |
| 4 | **`WF:6923`** `07e` script check | expected-script coverage under the floor | **Final attempt:** record `{ gate: "script", kind: "wrong-script", detail: <measured coverage> }`, set `languageDegraded`, ship — **and skip `07g`, `07j` and `07f`**. Three paid opinions about text in the wrong language are three opinions nobody can act on, and skipping them **saves $0.023** (§7.4). Makes `WF:7382`'s invariant true as written. |
| 5 | **`WF:6980`** `07e2` conventions | curly quote, nikud, foreign digits, Latin month, bidi control, forbidden transliteration | **Final attempt:** record `{ gate: "conventions" }` with the verdict's own reason, ship. The irony this fixes: this gate already has the right instinct for *outages* (`WF:6966`) and not for its own *verdicts*. |
| 6 | **`WF:7102`** `07g` relevance `off-brief` | Flash judge below `relevanceGateFloor` | Gains the `isFinalAttempt` guard it is the **only** paid judge to lack. **Final attempt:** `finalRelevance = { score, reason, note }` **carrying the sub-floor score**, plus `{ gate: "relevance", score: { value, floor } }`. `DraftResult.relevance` already routes to both surfaces via `groundingFor` (`WF:8850-8864`) — today it can only ever carry a *passing* score, so the marker must say *"scored 2/5 against a floor of 3"*. |
| 7 | **`WF:7814`** `07h` default render rules | a house layout rule failed | **Final attempt: every remaining failure is waived into `residueRules`** using the mechanism the step already implements at `WF:7800-7811` — it is how the cover waiver works, and it means the visual-QA judge still sees them at `WF:8447`. `remedy: "waived"`. Zero new concepts. |
| 8 | **`WF:8355`** `08a2` palette gate | a hex outside the frozen kit | Two changes. **(a)** On non-final attempts the bare `continue` becomes `returnToCopyWith` naming the offending hex — today the next draft is never told, so it is a byte-identical prompt producing a byte-identical palette three times: the *guard that cannot pass* shape, and a recorded $0.30 hold on prep run `pubsub-21634455753345065` (`slides-data.ts:1904`, `brand-render-tokens.ts:645`). **(b)** Final attempt: record `{ gate: "palette", detail: <hex and kit> }`, ship. Brand furniture must never hold a run (`brand-render-tokens.ts:569`). |
| 9 | **`WF:8514`** `08b` visual QA `pass: false` | the judge refused the render | **Final attempt:** `finalRendered = renderedAttempt` (the PNGs are one assignment away), `finalOutcomeOk = true`, and every failing `qa.findings` row becomes a finding with its `ruleId`, `slide` and `note`. Removes the absurd asymmetry where crossing the **hard max makes a run safer** than staying under it — `WF:8454`'s cheapest-path branch already delivers. |
| 10 | **`WF:8509`** `08b` QA status ≠ `completed` | `content_fail` / `budget_exceeded` | Non-final: `returnToCopyWith` + `continue`. **Final:** `{ gate: "visual-qa", kind: "unjudged" }`. A judge that could not produce a valid verdict formed **no opinion**, which is strictly *less* reason to bin the post than one that said "fail". |
| 11 | **`WF:8506`** `08b` `tooling_error` | registered judge, non-success | **Deleted as a throw.** Merges into the branch one line below it, which already treats the schema-invalid form of the same event as a quality event. |
| 12 | **`WF:5741`** `05` copy status ≠ `completed` | `content_fail` / `budget_exceeded` | Non-final: `continue`. **Final: Mechanism B** — ship the salvaged earlier attempt with `{ gate: "draft", kind: "final-attempt-malformed" }` and a reason naming *which attempt actually shipped*. Only when no attempt ever produced copy does terminus #1 fire. |
| 13 | **`WF:5739`** `05` `tooling_error` | second malformed turn (`base-agent.ts:159`, `maxMalformedTurns: 1`) | **Deleted as a throw**, merged into #12's branch. Today two dropped `type` discriminators kill a run with two paid-for attempts unspent — the `opus-drops-type-discriminator` family, and `structured-output.ts:79-83`'s truncation exemption reaches it on attempt 1. |
| 14 | **`WF:6138`** `06` vetting status ≠ `completed` | vetting judge malformed with a healthy pool | Empty vetted set → `07a` downgrades the unfillable slides to typographic archetypes and ships. $0, no hold, **no degrade marker on any attempt**: an empty vetted set is a picture problem, and `zero-held-guarantee.test.ts` already guarantees a picture problem never costs the post. Closes that file's one gap — it proves a *dead* media tier ships, not a *malformed vetting judge*. |
| 15 | **`WF:6135`** `06` vetting `tooling_error` | registered judge, non-success | **Deleted as a throw**, merged into #14. |
| 16 | **`WF:3611`** `03g` topic brand-fit floor | `topic-selection.ts:540` branch 5 | `resolveTopicClaim` gains **branch 6**: whenever the seed is non-empty — which on this path it always is, `WF:3279` produced it — return `{ topic: seed.topic, source: "research", weighting: { rule: "no scouted story cleared brand fit ${MIN_BRAND_FIT} and no fetched headline was usable — the client's declared industry leads", belowFloor: { considered, bestFit, floor: MIN_BRAND_FIT } } }`. The `{ hold }` member becomes unreachable and is **deleted from the return type**; `WF:3611`'s throw goes with it. Costs literally nothing — no attempt has been paid for yet. `MIN_BRAND_FIT` does not move. |
| 17 | **`WF:3753`** `04b` research extraction `content_fail` | the extractor's output did not parse | **No re-ask.** The merged `04a` documents are still in hand at `WF:3746`. Build `ResearchOutput.facts` deterministically, one card per fetched document: `claim` = the document's title verbatim, `quote` = the first ≤240 chars of description/content, `source` = the URL's host, `date` = `publishedAt ?? runDate`, `url`, `kind: "event"`, `primary: false`. **$0.** Mark `research: { status: "headline-fallback", reason }`. `zero-held-guarantee.test.ts:49-50`'s reasoning (*"shipping unsourced copy is worse than shipping nothing"*) **survives intact**: these cards are sourced. If no document has a non-empty title, this **holds** — §6 item 6. |
| 18 | **`WF:1246`** target language unresolved | Cyrillic/Arabic/Han prose, no `brand.language` | `WorkflowHeld` → **`WorkflowBlockedIntake`**. One word. Not a quality change at all: it is a config gap identical to its five siblings at `:913`/`:1012`/`:1021`/`:1027`/`:1032`, and `zero-held-guarantee.test.ts:379` already asserts that class is `blocked_intake` — *"a real blockage somebody must act on"*. The run still stops; it stops honestly. |

### The bookkeeping cluster — a ledger write must never cost an approved post

| Site | Today | Becomes |
|---|---|---|
| `WF:3803` `ledger.listUsedImages` non-success | `WorkflowToolingFailure` | **Warn**, treat as "no used images known", proceed. A dedupe-bookkeeping **read** may not end a run. |
| `WF:9682` `ledger.recordUsedImages` | `WorkflowToolingFailure` **after a human approved the post** | **Warn.** The `recordOutputExcerpt` call eight lines below already swallows, for the stated reason. |
| `WF:9958` `topics.commit` | `WorkflowToolingFailure` **after `writeDeliverable` returned** | **Warn.** `WF:9557-9562` is the precedent verbatim: *"losing a promotion costs the pool one design, failing an approved post over it would cost the post."* |
| `research-lanes.ts:320` no lanes, no subject, no brief | `WorkflowToolingFailure` | **`WorkflowBlockedIntake`.** Semantically it is the owner's own carve-out ("nobody to write for") filed as a malfunction. |

## 5. The degraded contract

### 5.1 The marker

Computed **once**, beside `interestDegradedMarker` (`WF:9406`) and `languageDegradedMarker` (`WF:9423`), for
the reason those are: the gate payload, the deliverable, the ledger row and the typed return must carry the
**same sentence**.

```ts
export type SelfCheckFinding = {
  gate: "draft" | "slides" | "craft" | "script" | "conventions" | "relevance"
      | "render-rules" | "palette" | "visual-qa" | "subject" | "research";
  step: string;                             // the checkpointed step id, e.g. "07b-craft-hygiene-attempt-3"
  kind: string;                             // machine-readable sub-reason, e.g. "source-ref"
  detail: string;                           // the gate's OWN sentence, verbatim — never re-worded
  slide?: number;
  score?: { value: number; floor: number }; // scored gates only; NEVER faked
  remedy?: "repaired" | "waived" | "discarded" | "none";
  remedyNote?: string;                      // why a discarded repair was discarded
  severity?: "blocking";                    // regulated compliance only (§5.5)
};

selfCheck?: {
  status: "degraded";
  reason: string;
  attempt: number;        // which attempt actually shipped
  attemptsSpent: number;
  checks: SelfCheckFinding[];
};
```

`score` is **absent, not zero**, when a gate is not scored — the rule `relevance` and `value.axes` already
follow: a reviewer has to be able to tell *judged and found wanting* from *never judged*.

`selfCheck` is **absent, never empty**, on a clean run. That asymmetry is a **test assertion**, not a
convention (§8.2) — a marker attached unconditionally is the "silently shipping a bad post" failure in
reverse: shouting `degraded` at every clean post until nobody reads it.

### 5.2 The reason string

Built by one named function `selfCheckDegradedReason(checks, { attempt, attemptsSpent, pastHardMax })` in a
new `self-check-degrade.ts`, so it cannot drift between the four routes — the `interestDegradedReason`
precedent (`interest-floor.ts:1586`).

> `delivered degraded: 2 self-checks did not pass on the final attempt (3 of 3) — relevance scored 2/5
> against a floor of 3 (07g-relevance-attempt-3); visual QA failed default:two-elements-per-slide on slide 4
> (08b-visual-qa-attempt-3). A human should read this post before it publishes.`

It names **the gate and the score, in the gate's own words**, and ends with the same "a person should look at
this" clause Phase 4 uses. A salvaged run says so: *"attempt 3's draft was malformed, so attempt 2's rendered
carousel shipped."*

### 5.3 Where it goes — four destinations, one sentence

| Destination | Path | Pattern it copies |
|---|---|---|
| **`09a` gate payload** (what the reviewer sees) | `selfCheck`, top level, beside `visualInterest` | `WF:9036` |
| **Persisted deliverable** (what the client retrieves) | `deliverable.selfCheck`, inside the `09b` payload | `WF:9645` |
| **Ledger** | one warn, idempotent key `${runId}__self-check-degraded-r${revision}` | `WF:8221` / `WF:7328` |
| **Typed workflow return** | `output.selfCheck` | `WF:10014`; type at `types.ts:1075` beside `visualInterest` |

Top level, mirroring `visualInterest`, rather than riding `groundingFor` — it is a **run-level degrade
marker**, not a verdict about grounding. (Note for the record: the `existing-adaptive-shapes` audit's claim
that `language` and `value` never reach the deliverable is **wrong**; they ride `groundingFor(review.output)`
at `WF:8850-8864` and land at `deliverable.grounding.*`. The invariant is stated at `WF:8858`.)

### 5.4 What each party sees

- **Engine run status: `completed`.** Never `held`, never engine-`degraded` — see §2(b).
- **Client** (`GET /runs/:id/deliverables/instagram-carousel`): a 200 with the full carousel plus
  `deliverable.selfCheck`. **Today every one of these runs is a 404.**

  **ONE class is excluded, and the exclusion is stated here rather than discovered later: the `severity:
  "blocking"` regulated-compliance run of §5.5.** `ledger.writeDeliverable` lives in `09b-deliver-and-log`,
  which is DOWNSTREAM of the `09a` gate, and `step-gate.ts` auto-resolves a timed-out gate only for
  `onTimeout: "auto_approve"` — every other value falls through to `throw new AwaitingGateSignal(gateId)`.
  So §5.5's `{ duration: "24h", onTimeout: "hold" }` means a regulated run with a blocking finding parks
  `awaiting_gate` and writes no deliverable until a human acts on it, and the client's GET is a 404 for as
  long as that takes. The reviewer half of §5.5 is fully delivered — they get the rendered carousel and the
  finding at `09a`, which is the change that matters and is what §5.5 argued for. The client half is not, and
  the two fixes available are both out of scope for Phase 6: switching to `auto_approve` is the safeguard
  §5.5 exists to refuse, and hoisting the deliverable write above `09a` is a restructure of a payload built
  entirely out of `review.output`. **Post-merge follow-up**, tracked in §11: write an un-published, degraded
  deliverable before `09a` for a blocking finding, and let the gate decide publication only.
- **Reviewer** (portal, `09a`): the rendered PNGs plus exactly which checks refused, in the gate's own words,
  with the step id that produced each. They can `reject` — and *that* rejection is still a hold, because it
  is the gate doing its job.
- **Nobody sees `completed` on a bad post without the truth attached.**

### 5.5 Regulated compliance — the gate keeps refusing, and the run still delivers

**This is where the two designs disagreed and it is decided here.** One proposed keeping a `never_say`
refusal as a **new, narrower hold**; this RFC does not, and the deciding argument is the one that proposal
itself supplied: `09a`'s timeout is `{ duration: "1h", onTimeout: "auto_approve" }` (`WF:9161`), so for a
regulated client **delivery would be indistinguishable from publication**.

That is an argument about **publishing**, not about **delivering** — and it has a fix that concedes nothing:

1. The attempt **falls through and delivers** like every other. The reviewer receives the rendered carousel.
2. The finding rides the **top** of `selfCheck.checks` with `severity: "blocking"`, naming the phrase.
3. **`09a` is reconfigured for this run only:** `{ duration: "24h", onTimeout: "hold" }`. Nothing regulated
   can auto-approve into publication while nobody is looking.
4. If it times out at 24h, that hold reads *"a regulated-compliance finding went unreviewed for 24h"* — the
   gate doing its job, with a human given a whole day **and a rendered post to look at**. It is a
   categorically different hold from today's, where nobody ever sees anything.

**Adding a hold to satisfy an owner requirement whose whole content is "stop holding" is the wrong shape.**
The bar is untouched; the refusal still refuses; what changed is what happens after it.

`compliance.regulated` + a `gate.brandCompliance` **outage** is the one place Mechanism C does not apply:
that returns `kind: "compliance-unverified"`, takes the same path as above, and the finding says the gate
could not run.

## 6. The exits I am KEEPING, and why each is a real fault

1. **`review-cycle.ts:158` — a human rejected the batch.** The owner's carve-out, first item. Also
   `packages/workflow`, not ours. `zero-held-guarantee.test.ts:313-361` asserts it and that assertion stays
   untouched.
2. **`review-cycle.ts:162`** — structurally unreachable and correctly labelled. A test for it cannot be
   written without breaking `GateResponseSchema` first.
3. **`review-cycle.ts:149` — the revision ceiling.** The weakest candidate on the list and deliberately out
   of scope: a human is present and informed either way, after three rendered drafts; and the file is shared
   by x/linkedin/blog/newsletter/reddit. Reported in §10, argued, not changed.
4. **`WF:3286` — no subject from any of three sources.** The owner's carve-out, second item, pinned by
   `zero-held-guarantee.test.ts:46-48`. Three independent sources came up empty; fabricating one is what the
   surrounding 70-line comment exists to refuse. **Note it is NOT the same hold as `WF:3611`** — there the
   client *has* a declared industry and a brand-fit floor refused it, which is a quality event (§4 item 16).
5. **The narrowed `WF:8536` — no attempt produced schema-valid copy and no salvage exists.** The carve-out's
   *"no output exists at all"*. It must not hide behind the old generic wording.
6. **Research found no readable source.** `04b`'s fallback (§4 item 17) holds only when `04a` produced no
   document with a non-empty title, with the reason `"research found no readable source"`.
   `research-lanes.ts:370` (every deep-research query failed) stays a `WorkflowToolingFailure`: a genuine
   outage.
7. **`WF:9572` PNG count ≠ slide count and `WF:9671` `writeDeliverable` failure.** The renderer's own
   contract, and the write of the artifact itself. **If the deliverable cannot be written the client
   genuinely has nothing, and claiming one would be the dishonest half of this work.**
8. **Unregistered tools:** `craft-hygiene.ts:313`, `slides-data.ts:1679`, `run-gate.ts:21`. A deploy defect,
   nothing to measure with. Distinct from a *registered* tool that failed, which Mechanism C handles.
9. **`WF:7941`** (last rung of the render ladder) and **`WF:8180`** (render-integrity twice — a font that
   will not load). Genuine renderer breaks at the end of an existing ladder.
10. **`WF:4346`** brand dir escaped repoRoot; **`queue-consumer.ts:71-76`** invalid job payload.
11. **`agent-exhaustion.ts:94`** — not imported by this agent. Recorded so nobody "fixes" a hold that cannot
    fire here. Fixing a dead guard is how dead guards get written.
12. **Every gate's bar.** Not one floor, threshold, rubric or banned list moves.

**Reclassified, not kept:** `WF:1246` → `WorkflowBlockedIntake`; `research-lanes.ts:320` →
`WorkflowBlockedIntake`. Both stop the run; both stop it honestly, as a missing input rather than a
malfunction.

## 7. Cost

### 7.1 The claim

**Added planned cost: $0.000000.** `STEP_COST_ESTIMATES_USD` gains no key and changes no number.
`rawEstimate` (`run-budget.ts:1086-1201`) gains no term in `fixed`, `perAttempt`, `rescue` or `images`.
`revisionEstimateUsd` (`:775`) is unchanged. `estimateRunCost` returns a bit-identical value for every shape,
`chooseRunBudget`'s four rungs fire in exactly the same order on exactly the same inputs, and **rung 4 — the
attempt rung — cannot be moved by this work.**

It rests on one fact about the existing estimator, and this is the whole argument:

> **`rawEstimate`'s `perAttempt` prices EVERY attempt as a FULL attempt**, and `attempts =
> plan.maxSelfCheckAttempts × perAttempt`.

An attempt that `continue`s at `07` today spends **less** than it was booked for. **A `continue` is a refund
against the plan, not a saving the plan expected.** A final attempt that falls through spends **at most what
the plan already reserved for it**. The delta against the plan is **zero by construction, not by
measurement**.

### 7.2 The two per-attempt numbers, which are different functions and both correct

| | `rawEstimate.perAttempt` (`:1163`) — chooses the plan | `revisionEstimateUsd.perAttempt` (`:775`) — informs the pre-revision check |
|---|---|---|
| `copyAttempt` (`:421`) | 0.1810 | via `DRAFT_ATTEMPT_ESTIMATE_USD` |
| `vetCall` (`:489`) | 0.0065 | via `DRAFT_ATTEMPT_ESTIMATE_USD` |
| `visualQa` (`:588`) | 0.0041 | via `DRAFT_ATTEMPT_ESTIMATE_USD` |
| `DRAFT_ATTEMPT_ESTIMATE_USD` (`:721`) | — | 0.1916 |
| `relevance` (`:493`) | 0.0020 | 0.0020 |
| `valueJudge` (`:527`) | 0.0030 | 0.0030 |
| language (Hebrew) | `copyLanguageBrief` 0.009 + **1×** `nativeJudge` 0.018 = 0.0270 | 0.009 + **2×** 0.018 = 0.0450 |
| `05c` 4 photo slides × 6 candidates × `visionInspectPerImage` 0.001 | 0.0240 | — |
| `08a4` min(8,12) × 0.001 | 0.0080 | — |
| **total** | **$0.2556** | **$0.2416** |

One round vs two is deliberate and documented at `run-budget.ts:1173-1189`; the image lines are absent from
`revisionEstimateUsd` by design. **Neither number moves.**

### 7.3 The plan does not move

| Line | Before | After | Δ |
|---|---|---|---|
| `rawEstimate.perAttempt` (cold Hebrew) | 0.2556 | 0.2556 | **0** |
| `3 × perAttempt` | 0.7668 | 0.7668 | **0** |
| `fixed`, `rescue`, `images` | unchanged | unchanged | **0** |
| **cold Hebrew `estimatedUsd`** (pinned, `run-budget.test.ts:597`) | **0.9983** | **0.9983** | **0** |
| `maxSelfCheckAttempts` | 3 | 3 | **0** |

`0.9983 ≤ 1.00` holds with the same arithmetic it held with yesterday. The **$0.0017** of headroom is
untouched. §8.4's guard test pins it.

Salvage re-assembly is pure code; the salvage render is Chromium at **$0**; the headline fact cards are
string slicing; `repairSourceRefs` is NFC normalisation. `gate.lintPost`, `gate.nativeLanguage`,
`gate.brandCompliance` and `publish.renderCarousel` carry **no `STEP_COST_ESTIMATES_USD` key and no model
call** — the same reason `07i`/`07i2`/`07e2` contribute nothing to `rawEstimate` *"BY CONSTRUCTION"*.

### 7.4 Live spend — the honest part

A fall-through spends more live dollars than **a hold** does, because a hold abandons the attempt early. It
spends nothing more than **the plan**. Worst case is the earliest feeder, `07`, which today `continue`s
before relevance, value, language and QA:

| Line skipped by today's `continue` at `07` | Reserved by the plan | Spent by the fall-through |
|---|---|---|
| `07g` relevance | 0.0020 | 0.0020 |
| `07j` value judge | 0.0030 | 0.0030 |
| `07f` native judge | 0.0180 | 0.0180 |
| `08b` visual QA | 0.0041 | 0.0041 |
| **total** | **0.0271** | **0.0271** |

Maximum live delta on the most expensive final attempt of a Hebrew run: **+$0.0271 against a hold, and
$0.0000 against the plan.**

**And it cannot push a run into a new failure mode**, because those four lines are *exactly* the ones the live
meter already turns off under pressure: value judge skipped at `WF:7163`, visual QA skipped at `WF:8454`,
native judge degraded at `WF:7392` — all on `posture === "cheapest-path"`. A fall-through past the hard max
routes through branches that already exist and already deliver. `canAfford` returning `{ok: false}` is
*"never a reason to hold (owner's rule)"* (`run-budget.ts:880`) and this RFC adds no new reader of it.

**One path is cheaper than today:** §4 item 4's script degrade skips `07g` + `07j` + `07f` = **−$0.0230**.

| Scenario | Plan | Live worst case | Outcome |
|---|---|---|---|
| cold Hebrew, clean | 0.9983 | ~0.95 | `completed` |
| cold Hebrew, `07` refuses ×3 | 0.9983 | ~0.62 | `completed` + `selfCheck` |
| cold Hebrew, every gate refuses ×3 | 0.9983 | ≤1.00 | `completed` + `selfCheck` |
| past the hard max | — | >1.50 | `completed` + `budget` + `selfCheck`, cheapest path |
| **today, rows 2–3** | 0.9983 | ~0.54–0.95 | **`held`, money spent, nothing delivered** |

The change makes the expensive outcome **cheaper per delivered post**, because the current one delivers zero
posts for the same money.

### 7.5 The two things I priced and then refused

1. **One re-ask of `04b`'s extraction schema** costs `STEP_COST_ESTIMATES_USD.extraction = 0.0135`, charged
   to the **fixed** leg. `0.9983 + 0.0135 = $1.0118 > $1.00` → the `fits()` loop runs, rungs 1–3 are already
   spent on a cold Hebrew plan, and **rung 4 fires: three attempts become two.** That is the forbidden
   outcome, exactly as the brief warns. Hence §4 item 17 is a deterministic fallback, not a retry.
2. **A palette auto-snap remedy + re-render.** $0 in dollars, but it **changes pixels**, needs the
   interest-relayout rollback machinery, and any pixel claim it makes cannot be verified in this worktree
   (Chromium self-skips here; CI is the gate). Record-and-ship already satisfies the requirement. Named so it
   is a decision, not an oversight.

### 7.6 The two non-dollar costs I am adding, named

1. **One extra free gate call per `repairSourceRefs`** — `checkSlidesData` re-run on the patched copy.
   Milliseconds, no model call, no billing tool.
2. **One Chromium render** on the salvage path, bounded to once per run, only when the salvaged attempt never
   rendered. $0, ~2-4s.

If either turns out to bill, **the design is wrong and must be re-priced before merge.**

## 8. How this is proved

### 8.1 The new file: `__tests__/zero-held-quality.test.ts`

Sibling to `zero-held-guarantee.test.ts`. **That file's nine cases stay exactly as they are** — it pins the
deliberate holds and it is the boundary this work must not cross. Only its header comment is rewritten (§8.6).

Fixture shape is `zero-held-guarantee.test.ts:492-503`: three attempts' worth of turns queued, one packager
turn *after* the loop, unused turns never pulled.

**Per-feeder table test**, one case per row of §4. Six assertions each:

```ts
expect(result.status).toBe("completed");                                              // 1. delivered
expect((await env.store.listJson("acme", ["ledger","deliverables",runId,"_"])).length).toBe(1);  // 2. a row exists
const check = record.deliverable.selfCheck.checks.find(c => c.gate === <gate>);
expect(check).toBeDefined();                                                          // 3. the right gate is named
expect(check.detail).toMatch(<the gate's own sentence>);                              // 4. in the gate's own words
expect(result.output.selfCheck.reason).toBe(record.deliverable.selfCheck.reason);      // 5. ONE sentence
expect(warns.some(e => String(e.id).includes("self-check-degraded"))).toBe(true);      // 6. ledger warn
```

### 8.2 The two assertions that make the rest worth anything

**Assertion 7 — the premise.** Every case additionally reads the checkpointed step output and asserts the
gate **actually refused**:

```ts
const step = await durableStore.read(runId, "07b-craft-hygiene-attempt-3");
expect(step.output.ok).toBe(false);
```

Without it a case passes when the gate silently stopped running — precisely how this codebase has produced
guards that cannot fail (six recorded instances). **The fall-through must be *after* a refusal, not *instead
of* one.**

**Assertion 8 — the negative, in the same `it`.** Re-run the identical fixture with the gate's trigger
removed and assert `record.deliverable.selfCheck === undefined`.

**Assertion 9 — the turn count.** `expect(router.complete).toHaveBeenCalledTimes(N)` with `N` **computed,
not observed**. This is the real enforcement of "zero added model cost": a new model call exhausts the queued
turns and the case fails loudly.

### 8.3 The source guard: `__tests__/held-sites.test.ts`

Reads `create-instagram-agent-workflow.ts` and asserts **exactly three** `throw new WorkflowHeld(`
occurrences (`WF:3286`, the narrowed `:8536`, and the `04b` no-readable-source hold), each pinned by a
substring of its message. A new hold fails CI with a message telling the author to argue it against RFC-19.
**CRLF: the regex needs `\r?\n`** (memory: `python-text-writes-flip-to-crlf`, `agent-engine-worktree-and-crlf`).

### 8.4 The cost rung guard

`per-revision-estimate.test.ts` and `run-budget.test.ts` gain assertions that fail on any added cost:

- `chooseRunBudget` on the cold Hebrew shape returns `plan.maxSelfCheckAttempts === 3`, and `adaptations`
  does **not** contain `"one return to step 05 instead of two"`.
- `estimateRunCost(DEFAULT_RUN_BUDGET_PLAN, coldHebrewShape).rawUsd` equals a pinned literal.

The `language-compliance-gate.test.ts` incident recorded at `run-budget.ts:1526-1555` — where an honest
$0.0045 re-price fired the attempt rung and two tests named *"NEVER holds"* started producing held runs — is
exactly what this catches.

### 8.5 Break-the-code protocol, run before trusting any of it

| Mutation | Must fail |
|---|---|
| delete one `if (!isFinalAttempt)` guard | that gate's degrade case (proves the guard is load-bearing) |
| set the `selfCheck` marker unconditionally | every assertion 8 |
| make `checkSlidesData` return `ok: true` for `kind: "compliance"` | the regulated case |
| return `salvage` at depth 0 | the "no attempt produced a draft" case |
| drop `detail` from a finding | assertion 4, in every case |
| make `repairSourceRefs` match on prefix instead of exact-normalised | the fabricated-citation case |
| add one key to `rawEstimate.perAttempt` | §8.4's pinned literal |

### 8.6 Existing tests that flip, named now

Line numbers below are the **assertion** lines, read in this worktree at `f1c7afa`.

| File:line | Today | Becomes |
|---|---|---|
| `self-check-retry.test.ts:123` | `held`, `/self-check never passed after 3 attempt/`, `router.complete` ×9 | `completed` + `selfCheck`. **The turn count is what will bite** — delivering pulls the relevance, value, language, QA and packager turns this fixture never queued. Enumerate `N`, do not observe it. |
| `craft-hygiene.test.ts:265` | `held` | `completed` + `checks[gate="craft"]` |
| `craft-hygiene.test.ts:301` | `held` | `completed` + `checks[gate="craft"]` |
| `grounding-gate.test.ts:222` | `held` naming relevance | `completed`, `checks[gate="relevance"].score === { value: <n>, floor: 3 }` |
| `language-compliance-gate.test.ts:392` | `held` | `completed`, `language.status === "degraded"`, **and `07g`/`07j`/`07f` not called** (§7.4's saving, asserted) |
| `language-compliance-gate.test.ts:772` | `held` | `completed`; the ZERO-relevance/ZERO-judge ordering assertion preserved for attempts 1–2 |
| `language-compliance-gate.test.ts:937` | `held` | **`blocked_intake`** (§4 item 18) |
| `visual-qa-retry.test.ts:114` | `held` | `completed`, `checks[gate="visual-qa"]` with the `ruleId` |
| `trend-scout-always.test.ts:226` | `held` | `completed` via branch 6 (this fixture declares an industry), `weighting.rule` matching `/no scouted story cleared brand fit/`. **The `router.complete` `not.toHaveBeenCalled()` assertion is the thing that flips.** |
| `brand-compliance-gate.test.ts:229` | `held` | `completed` + `checks[0].severity === "blocking"` **and** the `09a` gate record shows `onTimeout: "hold"`, `duration: "24h"` |
| `zero-held-guarantee.test.ts:38-56` header | *"…or the copy/compliance self-checks never passing inside the retry budget"* | Rewritten; its enumeration of deliberate holds must match `held-sites.test.ts`. **The nine cases themselves do not change.** |
| `zero-held-guarantee.test.ts:338`/`:379`, `revision-loop.test.ts:229`, `workflow-e2e.test.ts:534`, `topic-floor-breach.test.ts:38`/`:217` | `held` / `blocked_intake` | **unchanged** — the kept boundary |

### 8.7 Render tests

**Nothing in this RFC changes what renders** — only what happens to an attempt after it renders. Chromium-gated
tests **self-skip in this worktree**; **PASSED and SKIPPED are reported separately and CI is the gate for any
pixel claim.** No Chromium install will be attempted — it has failed four times on this machine and is a
known property of it.

## 9. What I deliberately did NOT do

Five deterministic "repairs" were designed and are **rejected**, with the reason on each:

| Rejected | Why |
|---|---|
| `repairCraft` — lowercase Title Case, strip `!`, de-emphasise ALL-CAPS | It edits the model's prose for meaning-adjacent reasons on a protected-term heuristic. `interest-relayout.ts:46-54`'s rule is that a remedy *"moves, promotes or re-frames something that already exists; it never invents copy"* — rewriting a headline's capitalisation to beat a gate is the closest thing on the list to weakening the gate by the back door. Record-and-ship is honest; a silent rewrite is not. |
| `repairNativeConventions` — strip nikud, swap quote glyphs, normalise digits | Same objection, lower risk. Deferred rather than refused: it is a clean follow-up **once** there is prep evidence of how often `07e2` actually refuses on those four findings alone. |
| `snapPaletteToKit` + re-render | §7.5 item 2 — it changes pixels and cannot be verified here. |
| A re-ask at `04b` | §7.5 item 1 — it fires the attempt rung. |
| A sixth parallel degrade-marker family | Five typed steers already exist for good reasons (`WF:5555-5569`), and `WF:5523-5535` **deliberately declines** to mirror `valueDegraded` because nothing read it and it would be one more way for two copies of the same fact to disagree. **`selfCheck` is the only new marker family.** |

Also unchanged: **no `packages/workflow` change** (`review-cycle.ts`, `workflow-engine.ts`, `run-gate.ts`,
`agent-exhaustion.ts`, `signals.ts`); **no `apps/agent-server` change**, including the tempting one —
`run-job.ts:156-163` is **not** given an `"instagram-agent"` entry, because `:153` documents that a run
tripping `maxTotalCostUsd` ends **`failed`**, which would manufacture the only genuine `failed` path this
agent has and contradict the standing budget amendment; **the human gate is untouched** except for §5.5's
per-run regulated override; **no retry is added anywhere**; **no attempt is cut to pay for anything**.

## 10. NEEDED FROM other packages / repos

These are reported, not touched.

1. **`apps/agent-server/src/routes/runs.ts:387-396`** — add `reason` and `failureReason` to the `/status`
   response. Both are persisted (`adapters/types.ts:76-79`) and neither is reachable over HTTP. **Without
   it, "the client cannot receive a failed run" is false as a statement about what the client can *see*,
   independently of anything in this RFC.**
2. **`apps/agent-server/src/routes/maintenance.ts:70`** — the sweep reads only `awaiting_gate`.
   `RESUMABLE_FROM_STATUSES` (`workflow-engine.ts:32`) includes `degraded`, and `step-code.ts:109-130` writes
   `status: "failed"` on a thrown body so a resume genuinely re-runs the failing step. **The recovery
   machinery exists, works, and nothing invokes it.** A `degraded` sweep is a separate, cheap win.
3. **`packages/workflow/src/primitives/topic-guardrail.ts:150`** — `GuardrailViolationError` is a plain
   `Error`, so it lands in the catch-all at `workflow-engine.ts:294` → `degraded` + `output: null`. Its own
   doc at `:47-50` claims it *"fails the run"*, which is **false about the mechanism**. The *intent* is
   legitimate; the classification is wrong. It should be `WorkflowContentFailure`.
4. **`packages/workflow/src/primitives/review-cycle.ts:149`** — the revision ceiling. Argued in §6 item 3;
   **recommendation is to leave it in this phase.**
5. **`Karos-Labs/karos-portal`** — render `deliverable.selfCheck`. It is shaped `{ status, reason, … }`
   identically to the `visualInterest` marker the portal already reads, so the minimum change is one field
   name in the existing degraded-badge path; the richer version lists `checks[]` with `gate`, `detail`,
   `slide`, `score`.

## 11. Risks named rather than hidden

1. **Auto-approve.** `09a` auto-approves after an hour, and per the prep environment the sweep is **not wired
   there at all**. A degraded post can therefore reach `completed` with nobody having read `selfCheck`. This
   design makes that *more* consequential because it creates degraded posts that did not previously exist.
   §5.5 handles the regulated case; the general case is a **policy decision for the owner** — a longer
   timeout, or a notification when `selfCheck.status === "degraded"` — and not a silent change here.
2. **The headline fact-card fallback ships thinner posts.** A carousel sourced from headlines rather than
   extracted stats will often fail the value gate's `newFact` axis — which now degrades rather than holds.
   Intentional, and the deliverable says so twice. **If `research.status === "headline-fallback"` becomes
   common, the extractor is the thing to fix, not the fallback.**
3. **`classifySlideCheckRefusal` must be structural, not a regex on prose.** P2 returns a discriminated
   `kind` from `checkSlidesData` for exactly this reason: a wording change must break a test, never silently
   reclassify a **compliance** refusal as mechanical.
4. **Turn counts in the flipping fixtures.** Every one of §8.6's rows pulls turns the fixture never queued.
   Enumerating `N` rather than observing it is what stops this becoming a test that passes by being told the
   answer.

---

# Part 3 — Work packages

Four packages, running in parallel in one worktree. **File ownership is enforced by the author.** Exactly one
package owns any file; no path appears twice. A package needing a change in another package's file reports
`NEEDED FROM <file>: <exact change>` and does not edit it. **Anchored `Edit` calls only, never a whole-file
write** — a *"file has been modified since read"* refusal is the tool saving you. No shared file is ever
restored in place from a backup.

The workflow file is 10,065 lines and every package wants it, so **P1 owns it outright** and makes every edit
inside it, including the ones P2 and P3 depend on. P2/P3/P4 are genuinely parallel because they own different
modules; they land stacked on P1.

## P1 — The fall-through spine and the degraded contract

**Owns**
- `agents/instagram-agent/src/workflow/create-instagram-agent-workflow.ts`
- `agents/instagram-agent/src/workflow/self-check-degrade.ts` *(new)*
- `agents/instagram-agent/src/workflow/types.ts`
- `agents/instagram-agent/__tests__/zero-held-quality.test.ts` *(new)*
- `agents/instagram-agent/__tests__/held-sites.test.ts` *(new)*
- `agents/instagram-agent/__tests__/self-check-retry.test.ts`

**Builds** Mechanisms A, B and the marker. §4 items 1, 3–15 and the bookkeeping cluster; §5 in full,
including the `09a` regulated override. Every `WorkflowHeld`/`WorkflowToolingFailure` edit in the workflow
file lives here, including the ones P2 and P3 supply the inputs for (items 2, 16, 17, 18).

**Reverting fails** `zero-held-quality.test.ts` (every case) and `held-sites.test.ts`
("exactly three `throw new WorkflowHeld` sites").

## P2 — The gates speak in kinds, and a gate that could not run has no opinion

**Owns**
- `agents/instagram-agent/src/workflow/slides-data.ts`
- `agents/instagram-agent/src/workflow/craft-hygiene.ts`
- `agents/instagram-agent/__tests__/slides-data.test.ts`
- `agents/instagram-agent/__tests__/craft-hygiene.test.ts`
- `agents/instagram-agent/__tests__/brand-compliance-gate.test.ts`

**Builds** the discriminated `SlidesDataSelfCheck` refusal (`kind: "count" | "pairing" | "source-ref" |
"banned-term" | "compliance" | "compliance-unverified"`), Mechanism C at `craft-hygiene.ts:322`/`:327` and at
`slides-data.ts:1684` (`runBrandCompliance`), and Mechanism 0's `repairSourceRefs` re-run against the **real**
`checkSlidesData` — never a stub; a bare `vi.mock` here would make the branch untestable.

**NEEDED FROM** `create-instagram-agent-workflow.ts` (P1): `WF:6774` reads `attemptChecked.kind` and routes
`compliance`/`compliance-unverified` to §5.5.

**Reverting fails** `craft-hygiene.test.ts` ("a `gate.lintPost` outage forms no opinion") and
`slides-data.test.ts` ("a `never_say` refusal is `kind: 'compliance'`, a mis-cited `sourceRef` is not").

## P3 — Nothing dies before the first draft is paid for

**Owns**
- `agents/instagram-agent/src/workflow/topic-selection.ts`
- `agents/instagram-agent/src/workflow/research-lanes.ts`
- `agents/instagram-agent/src/workflow/research-fallback.ts` *(new — the headline fact cards)*
- `agents/instagram-agent/__tests__/topic-selection.test.ts`
- `agents/instagram-agent/__tests__/trend-scout-always.test.ts`
- `agents/instagram-agent/__tests__/research-lanes.test.ts`
- `agents/instagram-agent/__tests__/topic-floor-breach.test.ts`
- `agents/instagram-agent/__tests__/fact-cards.test.ts`

**Builds** §4 item 16 (branch 6, and the `{ hold }` member deleted from `resolveTopicClaim`'s return type),
§4 item 17 (`headlineFactCards`, and the narrow no-readable-source hold), and `research-lanes.ts:320` →
`WorkflowBlockedIntake`.

**NEEDED FROM** `create-instagram-agent-workflow.ts` (P1): delete the `WF:3611` throw; call
`headlineFactCards` at `WF:3753` instead of throwing; `WF:1246` → `WorkflowBlockedIntake`.

**Reverting fails** `trend-scout-always.test.ts` ("an industry seed leads when nothing clears
`MIN_BRAND_FIT`") and `fact-cards.test.ts` ("a malformed extraction ships headline cards, and holds only when
no document has a title").

## P4 — The suite tells the new truth, and the rung guard holds the line

**Owns**
- `agents/instagram-agent/__tests__/grounding-gate.test.ts`
- `agents/instagram-agent/__tests__/language-compliance-gate.test.ts`
- `agents/instagram-agent/__tests__/visual-qa-retry.test.ts`
- `agents/instagram-agent/__tests__/zero-held-guarantee.test.ts`
- `agents/instagram-agent/__tests__/revision-loop.test.ts`
- `agents/instagram-agent/__tests__/workflow-e2e.test.ts`
- `agents/instagram-agent/__tests__/blocked-intake.test.ts`
- `agents/instagram-agent/__tests__/per-revision-estimate.test.ts`
- `agents/instagram-agent/__tests__/run-budget.test.ts`

**Builds** §8.6's flips (excluding the four files P1/P2 own), §8.4's rung guard, and the
`zero-held-guarantee.test.ts` header rewrite. **Its nine cases and `revision-loop`/`workflow-e2e`'s hold
assertions do not change** — that they keep passing is the proof the boundary is real.

**Reverting fails** `run-budget.test.ts` ("the cold Hebrew plan still keeps three attempts and `rawUsd` is
unchanged") and `language-compliance-gate.test.ts` ("a wrong-script draft delivers and pays no judge").

## Sequencing

| Tier | Packages | Why |
|---|---|---|
| 1 | **P1** | One local (`isFinalAttempt`) and one existing pattern; covers nine of twelve feeders. Everything else stacks on it. |
| 2 | **P2**, **P3** | Independent of each other and of P1's internals — they own different modules and only need P1's call sites to exist. |
| 3 | **P4** | Reads the finished behaviour. Landing it earlier would mean writing assertions against code that is still moving. |
