# How an agent is built here

**Status:** the standard · owner Shlomi · changes when a decision in `05 Decisions log` changes
**Applies to:** every agent under `agents/` that drafts something a client reads
**Rests on:** D04 (one eleven-step flow), D11 (the goal line), D29/D41 (craft rules are the
instructions), C7 (`docs/contracts/C7-run-context.md`), C5 (deliverable kinds)

This file exists because the same agent has now been built three different ways in this
repo, and the fourth time cost more than the first three. Read it before you create an agent
or change how one thinks. It is not a style guide for TypeScript — it is what makes a run
legible to the rest of the platform.

An agent that does not follow this is not "a different approach". It is an agent whose runs
the learning loop cannot see, whose output the portal cannot label, and whose behaviour
nobody can explain to a client. There is no second architecture.

---

## 0. The one-paragraph version

An agent is a workflow that reads **files in its own workspace**, drafts something, and
writes **files back to its own workspace**. It never reads a database. Everything it knows
about the client arrives as a projected file and is optional; everything it learns leaves as
one normalised record. Between those two ends it must do six things in a fixed order, and
those six things are the same on every platform.

---

## 1. The spine

Six obligations, in this order. The step ids are conventions, not suggestions — the report
builder, the demo runner and the acceptance tests all key on them.

| # | Obligation | Step id | Helper |
|---|---|---|---|
| 1 | Read the learning context | `01b-read-learning-context` | `readLearningContext` |
| 2 | Decide the funnel stage | *(no step — pure)* | `stageForRun` |
| 3 | Refuse a never-topic, skip a repeat | *(inside topic selection)* | `touchesNeverTopic`, `subjectWindowConflict` |
| 4 | Have a strategy map, or build one | `01c-build-strategy-map` | `ensureStrategyMap`, `pickStrategyRow` |
| 5 | Draft with craft, feedback and preferences as **input** | *(the draft agent step)* | `craftRulesForPrompt`, `feedbackForPrompt`, `preferencesForDrafting`, `platformStateForDrafting`, `strategyRowForDrafting` |
| 6 | Emit the goal line and write the run state | `<NN>-write-run-state` | `resolveGoalLine`, `goalLineBullets`, `writeRunState` |

All of it lives in `packages/workflow/src/primitives/learning-context.ts` and
`strategy-map.ts`. Do not reimplement any of it inside an agent. If a platform needs
something the primitive does not do, widen the primitive.

### 1.1 Read the learning context — first, once, outside every loop

```ts
const learning = await readLearningContext(wf, tools, ctx, "<platform>", "01b-read-learning-context");
```

Immediately after the client context loads, and **before** any revision or attempt scope.
Agents that wrap their drafting half in `rev(id)` / `-attempt-N` (instagram, tiktok) must put
this above that boundary, or the read re-runs on every revision and the readiness line
becomes a lie.

`<platform>` is the engine's platform key — `x`, `linkedin`, `reddit`, `instagram`,
`tiktok` — and it is the *platform*, not the product. Three TikTok agents share the key
`tiktok`, because the client has one TikTok account and one subject history on it.

### 1.2 Decide the stage

```ts
const stage = stageForRun(runDirection.slotStage, learning.subjectWindow);
```

A calendar run is told its stage by the portal's sequencing. A manual run derives one from
what the account has recently published, against the D32 default mix of 3 attention ·
2 expertise · 1 decide per six posts. Never hard-code a stage, and never let an agent choose
one by rotating a counter.

### 1.3 The two refusals

These are not filters to apply if convenient. They are the client's own words:

- `touchesNeverTopic(topic, learning.preferences)` — a client said never. An explicitly
  requested topic that touches one **HOLDS the run** with a reason naming the rule; it does
  not silently draft something else. A catalogue-sourced candidate is skipped.
- `subjectWindowConflict(topic, learning.subjectWindow)` — this account already said this,
  inside the anti-repeat window. Skip and pick again.

Where they attach differs by platform, and that is the one structural freedom: x and
linkedin have a single `07-select-candidate`; reddit filters inside `05-discover-threads`;
an agent whose topic selection is a ranking pipeline attaches them to the ranker and to the
final pick. What is not free is *whether* they attach.

### 1.4 The strategy map

```ts
const strategy = await ensureStrategyMap(wf, deps, ctx, {
  platform: "<platform>", learning, stepId: "01c-build-strategy-map",
  input: { today, clientProfile, accountCharter?, clientIntelContext?, forbiddenTopics },
});
const strategyRow = pickStrategyRow(strategy.map, stage, learning.subjectWindow);
```

Two guards are already inside `ensureStrategyMap` and must not be bypassed: it builds
nothing when the loop is not live for the client (`readiness.present.length === 0`), and
nothing when there is no profile or charter to build from. A cold client therefore spends no
model call on a plan nobody will collect.

An agent may legitimately have no map — reddit does not, because a reply's subject is the
thread's, not ours. That is a decision to write down in the agent's own header comment, not
an omission.

### 1.5 Drafting

The craft rules, the recent feedback, the derived preferences and the platform state go into
the **drafting prompt's input**, not into a lint that grades the draft afterwards. This is
D41, and it is the difference between an agent that writes well and one that writes badly
and then gets marked. The pre-delivery checklist stays — as the last gate, never as the
method.

Three layers arrive already merged by the projector, with precedence resolved (L3 over L2
over L1, **L1 hard rules always win**). The run does not re-resolve them. It reports the ids
it applied, in `rulesApplied`, because a rule nobody can measure is a rule nobody can retire.

### 1.6 The goal line and the record

```ts
const goalLine = resolveGoalLine(draft, { stage, audience?, whyNow: <how this topic was chosen> });
```

Resolved **once**, and used for both surfaces, so the card and the record can never disagree
about why a post exists. The model's own `goal` / `audience` / `whyNow` win when it stated
them; the fallback covers a silent model, so D11 holds either way.

Then, at the commit step:

```ts
await writeRunState(wf, tools, ctx, "<NN>-write-run-state", record);
```

`record` is `RunStateRecord` — C7 §3.1. Fill every field the platform has an honest answer
for and omit the rest; do not invent a `strategyRowId` to avoid a null.

---

## 2. The goal line has two surfaces

D11 says every output states its point. The record is what the middleware collects; it is
not what a client reads. Both must carry it, and there are only three shapes:

| Shape | Who | How |
|---|---|---|
| Meta bullets in markdown | x, linkedin | `goalLineBullets(goalLine)` into the drafts markdown, where the portal's `- **Label:** value` parsers already read it |
| A named slot in a JSON envelope | reddit (`whyThread`) | the portal already renders the slot; the funnel words stay on the record |
| A `goalLine` field on the deliverable | instagram, the three TikTok agents | the deliverable is a rendered asset, not markdown — the field is structured and the portal renders it |

Pick by what the client actually receives. An agent whose deliverable is a PNG or an mp4 has
no markdown to hang a bullet on, and stuffing the goal line into the caption is wrong: the
caption is what the client pastes into Instagram, and our internal reasoning has no business
travelling there.

**The why-now bullet carries no URL**, ever. `classifyXMetaBullet` weighs a bullet's URL
against a reply phrase, so a why-now that reads "replying to <status url>" gets taken as the
draft's reply target and points the hand-off link at the wrong post. `goalLineBullets`
strips URLs for you; do not route around it.

**No internal meta reaches the client's card.** Account-manager fields, revision counts,
reviewer notes (`formattingNotes` was the last offender) belong on the gate payload and the
run report. Client copy never mentions review or approval.

---

## 3. Degradation is the contract, not a nicety

> A run on a tree where only some of the writers exist behaves exactly as it does today.

Every projected file is optional. Missing → not present. Present but malformed → not
present, logged once with the path. `writeRunState` never throws: a failed write is recorded
on the step and the deliverable still stands.

This is what let the portal, the middleware and the engine land in the same week without a
merge fight, and it is what lets you wire a new agent to the loop before anyone has
projected a single file for it. Preserve it. A `throw` on a missing learning file is a
regression, not a validation improvement.

---

## 4. Adding a new agent

A product id is not one line. In order:

1. **Workspace** — `agents/<name>-agent/` with `package.json`, `tsconfig.json`,
   `tsconfig.test.json`, `vitest.config.ts`, `src/{agent,workflow}/`, `prompts/`,
   `__tests__/`.
2. **Register the product** — `apps/agent-server/src/wiring/workflows.ts`: the product list
   **and** the `buildWorkflowForProduct` switch.
3. **Declare its capabilities** — `packages/core/src/diagnostics/capability-products.ts`:
   `requires` is what the run cannot start without; `enhances` is what makes it better.
   Getting this wrong means a run fails deep instead of being refused at the door.
4. **Name its gate** — `apps/agent-server/src/report.ts`, `GATE_STEP_IDS_BY_NEW_PRODUCT`,
   both the bare id and the `-r0` variant.
5. **The spine** — §1, all six obligations.
6. **Prompts** — a directory per prompt id, numbered versions plus `latest.md`, and an entry
   in `scripts/prompt-registry.ts`. `npm run check:prompts` enforces registry-vs-disk drift,
   the declared guardrails being present in the text, and every `skillRef: "id@n"` resolving.
7. **Tests** — at minimum `__tests__/learning-loop.test.ts`, following the shape the three
   existing ones share (§5).
8. **Docs** — the agent's engine page (N10): steps, inputs read, outputs emitted, where A1
   and A2 land.

### 4.1 Adding a platform, as opposed to an agent

If the agent posts to a platform the loop has not seen, also widen: `LearningPlatform` in
`learning-context.ts`, `LEARNING_PLATFORMS` in `packages/tools/karos-client`,
`StrategyMapPlatform`, the `ledger.writeStrategyMap` enum, and the middleware's own platform
enum and migration. Several agents may share one platform key; they must.

### 4.2 What CI will stop you on

- `npm run check:prompts` — registry drift, guardrail hygiene, pin resolution.
- `npm run check:tool-versions` — any `defineTool()` file changed without its `TOOL_VERSION`
  moving. It diffs against the **previous push**, not the base branch, so a bump in an
  earlier commit of the same branch does not satisfy a later change.
- `check:config`, `check:pricing`, `check:bq-schema` — the last one matters if you change the
  run-state record's shape.
- `pretest` rebuilds `dist/`, which is checked in.

---

## 5. What the learning-loop test must prove

Four assertions, in every agent. Copy the shape from
`agents/x-agent/__tests__/learning-loop.test.ts`; the fixtures are the same everywhere
(`envelope(kind, data)` written under `["context","learning",platform,doc]`, preferences at
the client level).

1. **Nothing projected** — the run completes exactly as before and the record's
   `readiness.absent` lists all seven files.
2. **Everything projected** — each file reaches the drafting input, in the prompt's own
   shape. Assert on the input, not on the output.
3. **The goal line reaches the client's surface** — whichever of the three shapes §2 gives
   this agent — and still does when the model says nothing about goal, audience or why-now.
4. **A never-topic HOLDS an explicit request, before any model call.** Assert the router was
   never called. A refusal that costs a model call is a refusal that arrived too late.

---

## 6. Where platforms may differ, and where they may not

| Free | Fixed |
|---|---|
| Where the two refusals attach in topic selection | That they attach |
| Whether there is a strategy map | That the decision is written down |
| Which of the three goal-line shapes | That the client's surface carries it |
| The platform's own `type` vocabulary | That `stage` / `goal` use `FUNNEL_STAGES` |
| Research, drafting and rendering — tailored per platform (D04) | The other eight steps |
| Extra steps, extra gates, extra agents in the chain | The six step ids in §1 |

The rule behind the table: **a middleware column and an engine field with the same meaning
have the same name.** Vocabulary is shared, never translated. The moment a platform
translates `stage` into its own words, every report that joins across platforms silently
stops working.

---

## 7. The craft pages are upstream of this file

Each platform has a Craft page in Drive (00 Craft layer, 01 X … 05 TikTok and Reels,
04 Instagram) with `HARD` rules separated from `HEUR` defaults and every number sourced.
Section 11 of each page is written for whoever integrates it and says, per agent, what
research must pull, what the decide step must choose, what the vet gates are, and what the
learning loop should log.

`HARD` is never client-overridable and belongs in code or in a gate — container and
safe-zone checks, audio source by account type, AI labelling, likeness guards, rights
records, platform caps. `HEUR` is a default the client layer may override, and belongs in
the prompt and in the craft store where the loop can measure it and retire it.

When a Craft page changes, the prompt version bumps. TikTok's Community Guidelines revision
of 2026-09-24 is the next scheduled one.
