# RFC-16 — Instagram agent: CONCEPT DIRECTION for generated imagery (Phase 4)

Status: specified. Follows RFC-13 (Phase 0/1, merged as #84 and #94) and RFC-14 (Phase 2/3, merged as #107 and #108).
Driven by the owner's 2026-09-11 feedback on the reference accounts: the images have to be COOL, sometimes — and
"cool" turned out, on inspection of the actual pixels, to be a property of CONCEPT, not of style.

Worktree: `C:\Users\1\Documents\KarosLabs\agent-engine-igimage`, branch `feat/instagram-image-concept`, cut from
`origin/main` at `d880358`. Files are CRLF; use Edit/Write, Python writes need `newline=""`.

---

# Part 1 — Brief

## What Phase 3 solved, and what it did not

Before Phase 3, `packages/tools/karos-media/src/generate-image.ts` carried one hardcoded line for the whole fleet:

> `Style: realistic photography, natural lighting, clean composition.`

Phase 3 (item Q) replaced it with per-client ART DIRECTION, a STYLE LOCK, a client MEDIA LIBRARY and `art.forbid`.
That was a real improvement and it solved **style** — what the image looks like. It did not solve **concept** — what
the image IS OF. The scene brief describes a scene. Nothing in the pipeline asks *what is the visual metaphor for
this story?*, which is the thing that makes an image arresting rather than merely on-brand.

## The owner's request

Translated from Hebrew, 2026-09-11:

> "Everything still has to be driven by the branding colours and the topics relevant to the company, but the images
> just need to be COOL. What gets generated with AI should be cool — like sometimes celebrities, or companies, or
> things like that, doing something cool with AI. Just take this as ANOTHER DIRECTION for image creation, SOMETIMES."

## The recipe, observed from the reference account's real pixels

Harvested with ScrappyCoco and looked at, not inferred. Four items, and only the third is about style:

1. **A subject recognised instantly** — a known mascot, person or logo. *Recognition* is what stops the scroll, not
   beauty. This is the item both draft designs underweighted and it is the one the selector now gates on hardest.
2. **Placed in an unexpected situation that IS the story's metaphor.** Their post *"in the Apple vs Samsung foldable
   battle, Duolingo just jumped in"* rendered the Duolingo owl on the Iron Throne amid fire and embers, with the Apple
   and Samsung marks as clean white circular badges floating over the frame. The image IS the headline.
3. **Cinematic production** — fire, embers, deep blacks, rim light. The opposite of "clean product shot".
4. **Composed around the type zone** — the lower third deliberately darkened so the headline can sit on it.

## Owner decisions carried into this phase (binding)

- **Run cost: target $1.00, hard max $1.50. No Opus in a run.** Setup is a separate amortised budget: target $2.00
  per client, hard max $3.00. Every new model step justifies its cost in a comment beside it.
- **Budgets adapt, never hold.** Estimate before the first paid call; adapt to fit; past target drop optional work;
  past the hard max finish on the cheapest complete path and DELIVER. Status `completed`, at worst `degraded` with a
  reason. Never `held`/`failed` for budget. Image generation is one of the most expensive lines in a run, so the
  adaptive meter must price the concept mode *unconditionally* rather than hoping it does not fire.
- **Harvesting is ScrappyCoco only** (`packages/tools/karos-scraper`). This phase adds **no egress at all**.
- **Engine-native**: agents via `wf.step.agent` (`BaseAgent`), typed zod tools under `packages/tools/*`,
  deterministic orchestration in `wf.step.code`.
- **Hebrew is a first-class target language.** Anything visual must hold in RTL, and no selector may be built on a
  capitalisation heuristic that is silent in Hebrew.

## The three constraints that define the feature

**(a) Sometimes, not always.** This must not become the new universal look — that would recreate the repetition
defect Phase 2 exists to prevent. §1 is an explicit, inspectable, deterministic selector driven by properties of the
STORY, with its default rate stated and three independent ceilings.

**(b) Brand colours and client topics still govern, absolutely.** §3 is the chain of code checks that makes an
off-client concept unreachable rather than unlikely. The original audit failure — a real-estate carousel generated
for Karos Labs, because a step took a request verbatim as a web query with no client grounding — must be
structurally impossible here, not merely discouraged.

**(c) Third-party likeness and trademarks are a policy decision, not a default.** §5 ships the capability
**conservative and disabled for the entire fleet**, puts the permission in an inspectable consent document no agent
may write, and surfaces the decision in the PR body for the owner.

---

# Part 2 — Technical spec

## 0. Adjudication — the two designs, and where each was wrong

Two architects designed this independently: **A** (`concept-engine` — a dedicated concept step) and **B**
(`reuse-scene-brief` — the copy writer authors the metaphor). Both survey documents were re-checked against the
worktree at `d880358` wherever they disagreed or a claim smelled.

**Spine: A.** Grafts from B are itemised below. The spine decision rests on one property neither design shares:
because A leaves `slide.visualNeed` immutable, the concept slide keeps the picture retrieval already found for it,
so the concept image can be made to win **only by out-scoring that picture on the same rubric**. The mode therefore
cannot make a slide worse. B's `source: "generate"` removes the slide from `slidesNeedingSource`
(`create-instagram-agent-workflow.ts:4871`), so a concept B discards leaves the slide with nothing and it downgrades
to typographic — B's own cost table books the −$0.006 retrieval saving that proves it.

| # | They disagreed on | Decision, and why in one line |
|---|---|---|
| 1 | Who authors the metaphor | **A** — a dedicated `wf.step.agent`, because A never widens `instagram-copy@15`'s absolute *"No named real people, brands, products or logos"*, and a concept the code refuses costs one discarded object rather than a redraft of the whole carousel. |
| 2 | Does the concept slide keep its retrieved photograph | **A** — yes; that live fallback is what makes strictly-better replacement (§6.4) possible, and it is the single strongest property in either design. |
| 3 | Recognition signal | **B** — `namedEntities()` from fact-card `source` fields and registrable hostnames, because A's term set contained no recognition term at all and recognition is item 1 of the observed recipe; A's contest lexicon is kept, as a *shape* term rather than the recognition gate. |
| 4 | Style-lock composition | **B** — a *relative* production instruction ("push the locked style to its most dramatic end"), because A's plan of emitting a cinematic note and relying on the lock appearing after it asks a diffusion model to resolve two competing style statements by position, which is a hope, not a mechanism. |
| 5 | Where the consent reader lives | **B** — its own module plus its own read-only tool, because the workflow holds `templateStore` and `repoRoot` and **no `WorkspaceStore`** (verified at `create-instagram-agent-workflow.ts:477,697,725`), so A's "free store read at a code step" is not reachable; consent must arrive the way `media.getVisualPatterns` does. |
| 6 | Subject grounding | **B** — `conceptSubjectPalette(brief, permit)` filtered through `isPlaceholderBriefValue`, named verbatim by the model and re-checked in code; A grounded the *claim* (`restsOn`) but never the *subject*, and "a cool image about something the client does not do" is a subject failure. |
| 7 | Rate limiter | **B's cooldown** (no concept within `CONCEPT_COOLDOWN_POSTS = 3`), with A's window kept as a second ceiling; a cooldown states a guarantee ("never two in a row"), a bare window permits a burst of two and then silence. |
| 8 | Vet rubric for a declared metaphor | **A** — a *stricter* floor on a concept slide (a picture that could illustrate any story is a 2), not B's artificial ceiling of 4; the ceiling protects nothing, since the floor is 3, and costs a rubric clause. |
| 9 | `fallbackVisualDirection`'s missing forbid entry | **B's catch, adopted.** `visual-direction.ts:842-845` populates `forbid` **solely** from `brief.forbidden.topics`, so the art-director prompt's standing *"logos and brand marks, recognisable real people"* policy is present only when the *agent* wrote the direction. A client on the brand-kit fallback path has no such entry at all. Fixed in code, with a test. A missed this. |
| 10 | Vision-inspecting the concept frame | **Both, and both are right.** On the generate tier the vet compares the brief against itself (`generate-image.ts:366` feeds `describeGenerated(prompt)` back as the candidate description), so without pixels both "is this the wrong metaphor?" and "did it draw a celebrity?" are unanswerable. §6.3. |

**Repo facts re-verified for this spec** (every one spot-checked, not taken from the surveys):
`image.generate` `TOOL_VERSION = "1.1.0"` (`generate-image.ts:17`); the standing constraint line at `:472-476` bans
logos unconditionally and fleet-wide; `CLIENT_CONSENT_SEGMENTS = ["client","consent"]` with the "open-ended so other
consented capabilities can add their own block later" doc comment (`visual-patterns.ts:61,106-110`); the tool
registry count test `expect(names.length).toBe(62)` (`packages/tools/__tests__/cross-cutting.test.ts:124`); the
rescue re-vet builds slides as `{ n, headline, body, scene: g.prompt, isClientPhotoSlot }` with **no `why`**
(`create-instagram-agent-workflow.ts:5235-5238`); the vet's anti-Maccabi belt and the `MIN_CLAIM_MATCH` floor
(`prompts/instagram-image-vet/4.md:110-125`, `types.ts:706`); `instagram-image-vet` is pinned at `@4` in exactly one
place (`instagram-image-vetting-agent.ts:83`) and asserted by `semantic-image-vetting.test.ts:78`; budget constants
`TARGET_RUN_SPEND_USD = 1.0`, `MAX_RUN_SPEND_USD = 1.5`, `generatedImage: 0.039`, `visionInspectPerImage: 0.001`,
`vetCall: 0.006`, `copyAttempt: 0.159`, `angle: 0.036`, `IMAGE_CAP_STEPS = [4,2,0]` (`run-budget.ts`); the
anti-metaphor fallback line at `visual-direction.ts:825`; prompt-registry rows at `scripts/prompt-registry.ts:153,171`.

---

## 1. THE SELECTOR

### 1.1 Where it runs

Three free code steps and one model step. Nothing here is on the setup meter.

| id | kind | position | cost |
|---|---|---|---|
| `00e-check-likeness-consent` | `wf.step.code` | after `00d-check-visual-direction` (`workflow:2483`), outside the attempt loop, frozen into the run | $0.000 |
| `04m-concept-eligibility` | `wf.step.code` | immediately after `04j-select-angle` (`workflow:4608`), above the attempt loop at `:4678` | $0.000 |
| `04n-design-concept` | `wf.step.agent` | only when `04l` returned `eligible` | $0.029 |
| `04o-apply-concept` | `wf.step.code` | inside the attempt loop, after copy is accepted (`workflow:~4779`) and before `photoSlideNs` (`:4863`) | $0.000 |

**Why after `04j` and not frozen at `04k`.** The surveys named the ordering conflict correctly:
`04k-freeze-generation-style` runs once per RUN (`workflow:3858`), while `04i`/`04j` run once per REVISION
(`:4592`, `:4608`). These are two different kinds of decision and must not be frozen together. **Style is a property
of the client** and stays frozen at `04k` for the whole run. **Concept is a property of the argument**, and a
reviewer's `revise` legitimately changes the argument — so the concept verdict is revision-scoped, keyed through the
existing `rev()` helper exactly as `04i`/`04j` are. `04k` is not moved, not re-run and not touched.

### 1.2 What it reads — all of it already typed, checkpointed and in scope

No new field on `TrendCandidate`, no re-priced scout, no model call to classify the story.

```ts
// agents/instagram-agent/src/workflow/concept-direction.ts
export interface ConceptSignals {
  angleId?: AngleId;                 // angleDecision.chosen.id            (angle-selection.ts:67)
  briefFit?: number;                 // angleDecision.chosen.briefFit      (:83)
  angleFit?: number;                 // angleFit(...)                      (:247-250)
  trend?: Pick<TrendCandidate, "mode"|"interest"|"brandFit"|"hasNumbers"|"headline"|"whyNow"|"angle">;
  distance?: number;                 // RankComponents.distance            (topic-selection.ts:95-103)
  facts: readonly AngleFactCard[];   // promptFacts — the SAME list 04i and 05 read
  entities: readonly string[];       // namedEntities(...), §1.3
}
```

### 1.3 Recognition — `namedEntities()`, and why it is not a proper-noun regex

`HEADING_HAS_PROPER_NOUN` (`topic-engines.ts:370`) is capitalisation-based and its own comment at `:380-382` admits
it is silent in Hebrew. A selector keyed on it would fire for English clients and **never** for `geektime`, which is
a defect, not a policy.

`namedEntities(trend, angle, facts, brief)` builds a lexicon and intersects it with the story's own artefacts, in
this precedence:

1. organisation names in fact-card `source` fields (`ResearchFactSchema.source`, `types.ts:351-359`);
2. registrable host labels from `trend.evidenceRefs` and fact-card `url`s (`apple.com` → `apple`);
3. `brief.coreTerms`, `brief.offers[].name` and the client's own brand name;
4. a Latin proper-noun regex as an **additive bonus only** — it may add an entity, never withhold one.

Sources 1 and 2 are language-independent, which is why a Hebrew story about Apple and Samsung still recognises Apple
and Samsung. Pinned by a test whose only Latin text is in the fact-card sources.

### 1.4 The score

```
score(story) =
    2 · [angleId === "wrong-assumption"]                        // a reversal: the story IS a turn
  + 2 · [angleId === "surprising-number" && hasFigureCard]       // scale: claimFigures() non-empty on a stat card
  + 2 · [contestMarker(headline ⧺ whyNow ⧺ trend.angle)]         // a named contest
  + 1 · [trend.mode === "hot-news"]                              // there is a moment
  + 1 · [trend.interest >= 4]                                    // the measured scroll-stop proxy
  + 1 · [trend.hasNumbers]
  + 1 · [distance >= 0.6]                                        // novel against what we just posted
```

`hasFigureCard` reuses `claimFigures(normalizeClaim(c.claim))` from `fact-cards.ts:148-158` — the repo's existing
figure extractor, not a second regex. `contestMarker` is a small Hebrew-aware lexicon over normalised text
(`" vs "`, `" versus "`, `"outpaces"`, `"overtakes"`, `"battle"`, `"לעומת"`, `"מול"`, `"נגד"`, `"עוקף"`) — a contrast
token works in both scripts where a capitalisation heuristic does not.

```ts
export const CONCEPT_MIN_SCORE = 5;          // of a SHIPPED ceiling of 7 — see the note below the brake table
export const CONCEPT_MIN_BRAND_FIT = 4;      // mirrors TREND_JACK_MIN_BRAND_FIT (topic-selection.ts:78)
export const CONCEPT_MIN_ANGLE_FIT = 0.6;
export const CONCEPT_COOLDOWN_POSTS = 3;     // no concept within 3 shipped posts → arithmetic max 25%
export const CONCEPT_WINDOW = 8;
export const CONCEPT_MAX_IN_WINDOW = 2;      // a second ceiling: 2 in 8
```

### 1.5 The verdict

`eligible` requires the score **and** every one of nine hard preconditions. Any single failure returns
`eligible: false` with its own sentence, and the run proceeds on exactly today's path.

| # | precondition | source |
|---|---|---|
| 1 | `score >= CONCEPT_MIN_SCORE` — and note a story with none of the three 2-point shape terms maxes at 4 and **cannot** qualify | §1.4 |
| 2 | **recognition**: `entities.length > 0` | §1.3 |
| 3 | **grounding floor**: `trend.brandFit >= 4` when a trend took the slot, else `chosen.briefFit >= 4 && angleFit >= 0.6`. When `angleDecision.status !== "selected"` (the documented fail-open path, `angle-selection.ts:329`) → **not eligible**: the concept mode fails OFF, always | `topic-selection.ts:78`, `angle-selection.ts:83,247` |
| 4 | **cooldown**: no concept marker in the last `CONCEPT_COOLDOWN_POSTS` decision rows, and fewer than `CONCEPT_MAX_IN_WINDOW` in the last `CONCEPT_WINDOW` | ledger codec, §1.7 |
| 5 | **subject palette non-empty** after `isPlaceholderBriefValue` filtering | §3.1 |
| 6 | **a brand colour exists**: `buildArtDirection(...)` returns an `accentColor` or a non-empty `palette` | §3.2 |
| 7 | **budget**: `budgetPlan.generatedImagesCap > 0` **and** `meter.posture === "normal"` | `run-budget.ts:393`, `workflow:5193` |
| 8 | **not a client-media run**: `runDirection.mediaSource !== "client"` | `workflow:3463` |
| 9 | **at least one pattern's precondition holds** (§2.1) | §2.1 |

### 1.6 Default rate, and why this cannot become the universal look

**Design-intent selection rate: ~1 post in 6 (≈17%). Hard arithmetic ceiling: 1 post in 4 (25%).**

The triggering story properties, stated plainly: *a recognisable named entity is in the story's own sources* AND
*the story has a shape a metaphor can carry* — a reversal (`wrong-assumption`), a figure that reframes
(`surprising-number` over a stat card with a real number), or a named contest (a contrast marker in the headline,
`whyNow` or the client's angle) — AND *the story is strongly on-brand* (`brandFit >= 4`, the trend-jack band).

Five independent brakes:

| brake | effect |
|---|---|
| score ≥ 5 needs one of the three 2-point shape terms | the 1-point terms sum to 3 as shipped; a story with no reversal, no figure and no contest **cannot** reach the threshold |
| recognition gate | a story whose own sources name no organisation never qualifies, whatever its shape |
| `brandFit >= 4` / `briefFit >= 4` | the trend-jack band, already the minority of scouted stories |
| **cooldown of 3** | an absolute arithmetic ceiling of **25% of posts**, whatever the stories look like, plus 2-in-8 |
| **one slide per carousel** | at most 1 of 6-8 images — ≤14% of shipped frames even on a firing run, ~2-3% of all shipped slides |

**The shipped ceiling is 7, not 10, and the measured rate must be read against it.** `scoreConcept` defines four
1-point terms, but `distance` is never supplied: `04l` deliberately omits it rather than approximate the scout's
per-candidate novelty onto the claim, so three 1-point terms are reachable and they sum to 3. `reversal` and `scale`
are both keyed on `signals.angleId`, so they are mutually exclusive and the 2-point half caps at 4. The consequence
worth stating: `hot-news`, `interest>=4` and `numbers` all read `signals.trend`, so a story with no trend attached
maxes out at 2 and can never clear the threshold on the `auto` path — which also puts the `basis: "angle"` grounding
floors out of reach except under `conceptMode: "on"`. The selector is therefore **tighter** than the ~17% design
intent below. That is the safe direction for constraint (a), and the first prep sweep should compare its measured
rate against 7.
| meter/plan gates | a run past target never buys one |

Compare the Phase 2 repetition defect: *one* look on *every* slide of *every* run. A ceiling of 25% of posts × 14%
of slides is structurally a different thing.

There is a sixth brake worth naming: because a concept must **beat** the slide's existing selection on the same
rubric (§6.4), a run can fire the selector, pay the Sonnet call, generate the image and still ship the ordinary
photograph. **The selection rate is the ceiling on the shipping rate, not equal to it.**

I am not going to pretend the score distribution is known in advance. `09b-deliver-and-log` writes
`conceptFired: boolean` and `conceptShipped: boolean` into the beliefs document `RUN_BUDGET_BELIEF_KEY` history
already uses, and **the first prep sweep of ten runs reports the measured rate as a PR follow-up.** If selection
comes in over 25%, the lever is `CONCEPT_MIN_SCORE = 6` — one constant, no code change.

### 1.7 Inspection and override

**Inspect.** `04l`'s checkpointed return is the full audit trail, itemised in the house style of `RankComponents`
and `AngleScore.rule`:

```jsonc
{ "eligible": true, "score": 6, "threshold": 5,
  "terms": [ {"term":"reversal","points":2,"why":"angle \"wrong-assumption\""},
             {"term":"contest","points":2,"why":"contrast marker \"לעומת\" in whyNow"},
             {"term":"hot-news","points":1}, {"term":"interest>=4","points":1,"why":"interest 4"} ],
  "recognition": {"entities":["apple","samsung"],"basis":"fact-card sources + evidence hostnames"},
  "grounding": {"brandFit":4,"floor":4,"basis":"trend"},
  "cooldown": {"postsSinceLastConcept":5,"required":3,"usedInWindow":1,"window":8,"ceiling":2},
  "patterns": ["rivalry","the-race"],
  "rule": "score 6 ≥ 5, entities(apple, samsung), brandFit 4 ≥ 4, 5 posts since the last concept ≥ 3 → eligible" }
```

Surfaced as `conceptReport` in the gate payload beside `visualDirectionReport` (`workflow:6614`) and in the
deliverable (`:7202`), **on every run including the ones where it declined**, so a reviewer sees the decision and
its arithmetic before approving.

The cooldown reads back from the decision ledger using the existing codec pattern —
`conceptDecisionSummary` / `pastConceptsFromDecisions`, modelled line-for-line on `angleDecisionSummary` /
`pastAnglesFromDecisions` (`angle-selection.ts:467-518`), marker `; concept: <n> | <pattern> | <anchor>`. The codec
doubles as the audit trail.

**Override.** Three levels, most specific first, all deterministic, each recording itself in `rule`:

1. **Client config `instagramConceptMode`**, read at `02-freeze-style-config` beside `readForbiddenTopics`
   (`workflow:938`). `"off"` is a standing client-level opt-out and beats any per-run request.
2. **Run input `conceptMode?: "auto" | "on" | "off"`** (default `"auto"`), alongside the existing `mediaSource`
   field on the run dialog. `"on"` bypasses the score, the recognition gate and the cooldown — **but not the
   grounding floor (§1.5.3), not the palette or colour gates (5, 6), not the budget gates (7) and not the safety
   policy (§5).** Those are not preferences.
3. `"auto"` → §1.5.

---

## 2. THE CONCEPT ITSELF

### 2.1 A closed pattern vocabulary, with code-computed preconditions

Closed for the same reason `ANGLE_IDS` is closed (`angle-selection.ts:61-67`): an open field lets a model propose
three flavours of the same move.

```ts
export const CONCEPT_PATTERNS = [
  "rivalry",       // two forces, one prize
  "reversal",      // the thing everyone believed, upended
  "scale",         // one number made physical
  "before-after",  // one frame holding both states
  "the-outsider",  // the one who does not belong, and does
  "the-crown",     // who holds the position, and how precariously
  "the-race",      // the moment before, or the moment of passing
] as const;
```

**The model does not get all seven.** `04l` computes the eligible subset deterministically and hands only that to
`04m` — the same discipline as `selectAngle` checking `restsOn` against the cards that actually exist.

| pattern | precondition, computed in code |
|---|---|
| `rivalry` | `contestMarker(...)` true **and** `entities.length >= 2` |
| `reversal` | `angleId === "wrong-assumption"` |
| `scale` | a `kind: "stat"` fact card with `claimFigures(...).length > 0` |
| `before-after` | a `kind: "event"` card, or `trend.whyNow` non-empty |
| `the-outsider` | `brief.positioning.differentiators` non-empty and not placeholder |
| `the-crown` | a `stat` card whose claim carries a rank or superlative (`#1`, `largest`, `first`, `הגדול`, `הראשון`) |
| `the-race` | `trend.mode === "hot-news"` |

An empty eligible set returns `eligible: false` — a concept with no pattern the story supports is the "cool image
about nothing the client does" failure in embryo.

### 2.2 `04n-design-concept` — the model step, and what it costs

Agent `InstagramConceptAgent`, `agents/instagram-agent/src/agent/instagram-concept-agent.ts`:

```ts
id: "instagram-concept",
allowedTools: [],                // everything it reads is hand-assembled, like the art director
maxSteps: 1,
maxTokens: 1_200,
modelPolicy: resolveModelPolicy("instagram-concept",
  { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: false }),
skillRef: "instagram-concept@1",
```

**Cost justification, as it will read in the comment beside the step.** ~6.2k in / ~0.65k out on Sonnet 4.6 =
6,200 × $3/1M + 650 × $15/1M = $0.0186 + $0.00975 = **$0.0284**, priced `concept: 0.029`. Sonnet rather than Flash
($0.0033) for the same reason the art director is Sonnet (`instagram-art-director-agent.ts:41-51`): this is the one
call in the run that is pure judgment, it fires on at most a quarter of runs, and a flat concept is worse than no
concept — it spends a $0.039 image on a picture nobody decodes. **No Opus, per the owner's rule.**
`contentLanguageSensitive: false`: the output is an English brief addressed to a diffusion model, never
client-facing copy — Hebrew clients get Hebrew *slides*, which is `target-language.ts`'s job.

**Input** (hand-assembled, ~6.2k tokens): `briefForPrompt(brief)` positioning / ICP / coreTerms / forbidden; the
chosen angle; the 6 highest-ranked `promptFacts` with `kind`; `trendCandidateForDrafting(trend)`; the recognised
`entities`; the **eligible pattern subset** with their preconditions; the **subject palette** (§3.1);
`visualDirection.lines` + `forbid` + `frozenStyle.line`; `art.accentColor` and `art.palette`; the likeness permit
(§5).

**Output** — `ConceptSchema`:

```ts
export const ConceptSchema = z.object({
  pattern: z.enum(CONCEPT_PATTERNS),
  /** The ONE concrete, photographable, instantly-recognised thing in frame. Must name a subject-palette token. */
  anchor: z.string().min(1).max(80),
  /** The unexpected situation the anchor is in — exactly one metaphorical move. */
  situation: z.string().min(1).max(120),
  /** The full generation brief. Replaces `scene` on the GENERATION path only. ≤240 so it round-trips SlideVisualNeedSchema. */
  scene: z.string().min(1).max(240),
  /** What a reader who has NOT read the headline would say this picture is of. */
  readsAs: z.string().min(1).max(160),
  /** The sentence the picture and the headline assert together. The legibility contract. Must name an entity. */
  decodesTo: z.string().min(1).max(200),
  /** The fact-card claim this dramatises, VERBATIM. Checked by code against promptFacts. */
  restsOn: z.string().min(1),
  /** How the brand accent appears AS AN OBJECT OR SURFACE inside the metaphor. Required. */
  paletteRole: z.string().min(1).max(120),
  /** A RELATIVE production note — how far toward the dramatic end of the LOCKED style to push. Never a style. */
  productionNote: z.string().max(100).optional(),
  /** Third-party marks the concept uses. Empty unless the permit names them. */
  usesPermittedMarks: z.array(z.string().min(1)).max(3).default([]),
  /** The lower third the headline sits on — how it is darkened or cleared. Required. */
  typeZone: z.string().min(1).max(120),
});
```

`typeZone` is in the schema because it is item 4 of the observed recipe and because the pipeline already measures
it: `08a4-inspect-rendered`'s brief asks whether "the photo (if any) is not fighting the text" (`workflow:6322`),
and a concept image is the most likely image in the fleet to fight it. `productionNote` is **relative** by schema
comment and by prompt: *"push the locked style to its most dramatic end — the deepest shadows, the strongest key
light and the most atmosphere it allows."* A client whose style lock is "flat, bright, minimal product photography"
gets a flat, bright, minimal metaphor, which is the correct outcome and the opposite of a house style leaking in.

### 2.3 The legibility guard — `checkConceptLegibility`, deterministic, free, in `04n`

A concept failing **any** clause is **discarded silently**; the slide keeps the writer's original scene brief and
the run proceeds on exactly today's path. No retry, no hold, no second model call. The fallback is the current
working behaviour, which is precisely why discarding is cheap enough to do freely.

| # | clause | implementation |
|---|---|---|
| **L1** | `restsOn` names a real card | `cardKey(concept.restsOn)` must match a card in `promptFacts`, using `angle-selection.ts:171`'s exact matcher |
| **L2** | the anchor is drawn from the client's own world | `anchor` (normalised) must contain a `conceptSubjectPalette(brief, permit)` token verbatim — the `restsOn` discipline of `angle-selection.ts:379-388` applied to the SUBJECT — **and `scene` must contain that same token**. `scene` is the only field the diffusion model is handed (`conceptPrompt = concept.scene`), so grounding `anchor` alone would check a string that is then thrown away |
| **L3** | the anchor is photographable | `anchor` must not match `ABSTRACT_ANCHOR` (trust, momentum, growth, alignment, synergy, innovation, transformation, disruption; Hebrew: אמון, צמיחה, תנופה, חדשנות). `instagram-copy@15` §6 asks for this in prose; here it is enforced in code |
| **L4** | the decode is about this slide, and names a recognised entity | `decodesTo`, normalised, must share a content token with `entities` **and** with one of: the angle's `rememberLine`, a `brief.coreTerms` entry, or a figure from `claimFigures(restsOn)` |
| **L5** | exactly one move | `situation` carries at most one clause (no `" and "` / `" while "` / `" as "` joining two unexpected states); `scene` carries no simile marker (`like a`, `as if`, `כמו`) — a simile inside the scene is a second metaphor stacked on the first |
| **L6** | `readsAs` ≠ `decodesTo` | if the two are the same sentence the model wrote a literal image and labelled it a concept. Not an error — it is **demoted to a normal scene brief**, a correct outcome that is simply not a concept |
| **L7** | forbid is enforced, not advisory | `anchor`, `situation`, `scene` and `paletteRole` are matched against `art.forbid` and `brief.forbidden.topics` with the normalised matcher `TREATMENT_VETO_CUES` already uses (`style-lock.ts:200-214`). A hit discards |
| **L8** | a brand colour to obey | `paletteRole` non-empty and an `accentColor` or non-empty `palette` exists. The owner's "brand colours govern absolutely" has to mean something when there are none |
| **L9** | safety, on both the declared and the undeclared path | (a) `anchor`, `situation`, `scene` and `paletteRole` are matched, **per token**, against every recognised `entities` name the permit does not allow and the client's own subject palette does not contain, plus the mark nouns (`logo`, `wordmark`, `crest`, `emblem`, `insignia`, `mascot`, `לוגו`, `סמל`) when the permit grants nothing. A hit discards. (b) every entry of `usesPermittedMarks` is in the permit's allowlist (§5). (a) exists because only `scene` reaches the generator, L7's matcher compares whole forbid entries as substrings (so the standing `"logos and brand marks"` fires only on a scene quoting the policy verbatim), and the entity names are in the model's own input — L4 *requires* it to name one in `decodesTo`. Without (a), a concept that wrote the mark into `scene` and left `usesPermittedMarks` empty was enforced against nothing |
| **L10** | length | `scene.length <= 240`, so the rewritten need still parses `SlideVisualNeedSchema` |

**What this prevents, and what it does not.** L3 keeps the anchor a real object; L5 keeps the inference to one step;
L2 and L4 keep that step pointed at the client's world and this slide's claim; L6 catches the null case. The
remaining failure — anchor fine, situation fine, but the *drawn* result unreadable — is not a text problem and is
caught by measurement on pixels in §6.3.

### 2.4 `04o-apply-concept` — what actually changes

**Chosen slide:** the cover, when `resolveLayout` puts it in `HERO_IMAGE_LAYOUTS` and it is not covered by a client
upload (`tier0Slots`); otherwise the lowest-numbered slide that is. If neither exists the concept is discarded with
that reason — it does not invent a slide. The cover is the scroll-stop and that is the entire point of the mode.

Then, and only then:

```ts
conceptSlideN = n;
conceptPrompt = concept.scene;     // consumed by the GENERATE tier only
// slide.visualNeed is NOT mutated: retrievalQueryFor() still reads the writer's searchTerms,
// vetSubjectFor() still returns the writer's scene+why for the tier-1 vet at 06.
```

Four consequences, all deliberate:

- **The copy prompt is not bumped.** `instagram-copy@15` stays at 15. §6's *"No named real people, brands, products
  or logos"* stays true **of the writer**, because the writer never authors a concept. No carve-out, no widening, no
  five-step checklist on the largest prompt in the agent.
- **`scene-brief.ts` is not touched.** No new schema field, no fixture churn across ~30 tests, no resumed-run
  re-parse risk.
- **The retrieval query is not poisoned** — `visualNeed` stays immutable, so `retrievalQueryFor` at `:4893` still
  asks a keyword index for the literal subject.
- **The slide keeps its retrieved picture as a live fallback**, which is what makes §6.4 possible.

---

## 3. GROUNDING — the code path that makes an off-client concept IMPOSSIBLE

Not "unlikely". Each link is a deterministic code check; any one of them discards.

```
buildGroundedQuery (client-brief.ts:1177) — the research query names the business and the ICP
   └─> 04b-research-extract-facts ──> 04b2-dedupe-fact-cards ──> promptFacts
          └─> [L1] cardKey(concept.restsOn) ∈ promptFacts               ← THE CLAIM WIRE
                 └─> [L2] anchor names a conceptSubjectPalette token    ← THE SUBJECT WIRE
                        └─> [1.5.3] brandFit ≥ 4 / briefFit ≥ 4 && angleFit ≥ 0.6
                               └─> [L4] decodesTo names a recognised entity AND a slide term
                                      └─> [L7] ∉ art.forbid ∪ brief.forbidden.topics
                                             └─> [L8] a brand accent or palette exists
                                                    └─> runTopicGuardrail sees decodesTo (§3.3)
```

**L1 and L2 are the load-bearing pair.** A concept is by construction a dramatisation of a fact card that came out
of a query `buildGroundedQuery` rewrote to name the client's business, staged with a subject drawn from the client's
own brief. There is no path by which a concept can be *about* something the client's brief-grounded research did not
produce. The original audit failure — a real-estate carousel for an AI marketing agency, because a step took a
request verbatim as a web query with no client grounding — is structurally unreachable: the concept step is handed
no request, no query and no web access (`allowedTools: []`). It is handed six cards and a palette, asked to
dramatise one card with one palette subject, and the pair it names is checked in code.

### 3.1 The subject palette

`conceptSubjectPalette(brief, permit)` returns tokens drawn **only** from `ClientBrief`: `offers[].name`,
`icp.roles` rendered as generic archetypes ("a courier", "a founder"), `coreTerms`, `ownAssets[].title`, the
client's own brand marks, plus anything the permit explicitly adds (§5). Every token passes
`isPlaceholderBriefValue` (`client-brief.ts:264-295`) first — the exact rule that file records after
`fallbackVisualDirection` once piped *"an unnamed business: no profile description, tagline, name or industry on
file"* into a diffusion model **and** into the run-wide style lock.

**An empty palette turns the selector off** (precondition 5). A client with a placeholder brief can never get a
concept image. That is the MassHousing failure closed at its own root, on the subject side.

### 3.2 Colour

`art.palette` / `art.accentColor` continue to reach the generator by the one existing wire
(`buildArtDirection` → `workflow:5159` → `generate-image.ts:436-437`). Unchanged: `accentColor` remains
un-overridable because it is a brand FACT (`visual-direction.ts:918-921`).

The concept adds **obligation, not a new wire**: `paletteRole` is required by the schema, checked by L8, and
appended into `art.notes` by `buildConceptArtDirection` so it lands in the verbatim block. The generic path says
"carry the accent somewhere, as an object rather than an overlay"; the concept path says *which* object — and the
concept prompt carries one binding sentence: **"the light, fire or atmosphere in this frame takes its colour from
the palette above, not from a generic warm orange."** That sentence is the whole answer to "the branding colours
still drive it": the cinematic production is rendered *in the client's palette*, or it is not rendered.

### 3.3 The terminal belt

`runTopicGuardrail` (`workflow:6557`) currently runs over the caption and slide text only and never sees imagery.
On a concept run its text surface gains one entry: `concept.decodesTo`. A concept that drifts to a forbidden subject
then throws `GuardrailViolationError` exactly as off-topic copy does. Two lines, and it closes the only gap where a
concept could carry a subject the copy does not.

---

## 4. COMPOSITION WITH PHASE 3

### 4.1 The style lock — untouched, and it still wins

`04k-freeze-generation-style` is not moved, not re-run and not re-resolved. `frozenStyle.line` still overrides at
`workflow:5159`, still emitted with its *"identical for every image in this set, do not vary it"* wording
(`generate-image.ts:464-466`). The concept prompt carries the rule in one sentence: **"You choose what is in the
frame. You do not choose how it is shot — the run's style lock does."**

The observed recipe wants cinematic production and a style lock may say "soft north light". Resolved by making the
production note **relative rather than absolute** (§2.2): it has no style content of its own to compete with, so
there is nothing for the model to resolve. The style lock's job — a set of rescue images reading as one set — is
preserved, because the concept image is one frame in that set and inherits the same locked sentence.

The render-side half is also untouched: `pickImageTreatment` still picks one treatment per client from
`IMAGE_TREATMENTS`, and `imageTreatmentCssBlock` still paints the concept image exactly as it paints any other hero.

### 4.2 `art.forbid` — strictly stronger on this path

`forbid` is additive and cannot be shortened by a concept. It is also **promoted from advisory to enforced** here:
`generate-image.ts:83-88` is honest that a negative list is advisory to a diffusion model, but L7 checks the concept
*text* against it before a cent is spent. A concept naming something on the client's forbid list never reaches the
generator at all.

### 4.3 The one Phase 3 line that must be dropped on this path

`visual-direction.ts:825` ships, for every client on the deterministic fallback direction, the line:

> `Show what is actually sold as a real object, screen or workplace rather than an abstract metaphor: <whatWeSell>`

It goes into `art.notes` verbatim for every generated image, and it is the exact instruction a concept must not
receive. Dropped by identity, never by a regex over prose:

```ts
// visual-direction.ts — exported so the drop is by identity, and a change to the
// sentence cannot silently stop dropping it. Pinned in concept-budget-and-art.test.ts.
export const ANTI_METAPHOR_LINE_PREFIX =
  "Show what is actually sold as a real object, screen or workplace rather than an abstract metaphor:";
```

`buildConceptArtDirection(tokens, direction, concept)` = `buildArtDirection(...)` with (a) notes filtered of any
line starting with that prefix, (b) `paletteRole` and `productionNote` appended, (c) everything else — palette,
accentColor, forbid, styleLock — identical.

**Honest limit, stated here and in the PR body:** the art-director *agent* can write its own literalism line
("photograph the product, never a symbol") that no constant can match. The concept prompt is therefore also told, in
one sentence, that direction lines describing *subject-matter policy* are superseded for this one image while lines
describing *look* are not. That is a prompt instruction, not an enforcement, and this RFC does not claim otherwise.

### 4.4 A pre-existing safety hole, fixed while we are here

`fallbackVisualDirection` populates `forbid` **solely** from `brief.forbidden.topics`
(`visual-direction.ts:842-845`). The art-director prompt's standing product policy — *"legible text or signage in
frame, logos and brand marks, recognisable real people"* (`instagram-art-director/1.md` §4) — is therefore only ever
present when the **agent** wrote the direction. Every client on the brand-kit fallback path has had **no**
real-people or brand-mark entry at all since Phase 3 shipped.

The standing entry moves into the deterministic fallback so it is present on both paths. No prompt bump; a code
change with a test. This is independent of the concept mode and would be worth shipping on its own.

---

## 5. SAFETY — likeness and third-party marks

### 5.1 The default, for every client with no record: conservative

Unchanged from today's enforced behaviour, and it ships that way for the whole fleet.
`generate-image.ts:472-476`'s constraint line stays **byte-identical** when no permit names anything:
`no logos, no watermarks`. `describeGenerated`'s `no identifiable real person` assertion stays byte-identical. The
concept prompt's §Safety reads:

> Represent a rival, a competitor or a public figure by **role, position and object** — never by mark, face or
> likeness. Two identical chairs at the head of one table, not two logos. A crown with no house on it. The one
> throne and the two hands reaching for it.

The safe default palette, stated positively so the model has somewhere to go: generic archetypes from `icp.roles`
("a founder at 2am", "a courier"), the client's own products, marks and workplaces, and public-domain or allusive
visual language — a throne, a crown, a scale, a tug-of-war rope, a starting block, a relay baton, a chess board, a
ladder, a door, a lifeboat.

### 5.2 The permission — `generatedLikeness` in the existing consent document

Home: `clients/<slug>/client/consent.json`, i.e. `CLIENT_CONSENT_SEGMENTS` (`visual-patterns.ts:61`). That file's
own doc comment (`:106-110`) says it is *"open-ended so other consented capabilities can add their own block
later"* — this is that block. Its three stated reasons for being a document rather than a config key (`:50-59`) are
exactly the reasons here: an absent file is an unambiguous no; a permission carries provenance; revoking must not
mean editing runtime settings.

```ts
// packages/tools/karos-media/src/likeness-consent.ts — new, pure, fail-closed
export interface GeneratedLikenessConsent {
  readonly status: "granted" | "denied" | "revoked";   // three states, not a boolean — visual-patterns.ts:86-104
  readonly grantedAt?: string;
  readonly grantedBy?: string;
  /** What the grant covers. Absent, or every list empty and ownMarks false, grants NOTHING. */
  readonly allow?: {
    /** Named third-party marks. An allowlist, never a blanket yes. */
    readonly thirdPartyMarks?: readonly string[];
    /** Named public figures. A separate list because it is a separate body of law. */
    readonly publicFigures?: readonly string[];
    /** Whether the client's OWN marks may be drawn. False even here by default. */
    readonly ownMarks?: boolean;
  };
  /** What the owner wrote when granting. Surfaced verbatim in the gate payload. */
  readonly scopeNote?: string;
}
// ClientConsentRecord gains: readonly generatedLikeness?: GeneratedLikenessConsent;
```

`readGeneratedLikenessConsent(record, clientSlug)` is shaped line-for-line on `readVisualPatternConsent`
(`visual-patterns.ts:140-204`) and fails closed on every path that is not an explicit yes: absent record,
unreadable record, absent block, non-`granted` status, **and a `granted` status naming nothing** — the direct
analogue of `:186-195`'s accounts-less grant. "Permission to use third-party marks" that does not say which marks
cannot be checked, so it grants nothing.

**An allowlist rather than a flag, deliberately.** "Apple, Samsung, Duolingo" is a decision an owner can make and a
lawyer can review. "Third-party marks: yes" is not a decision, it is an abdication.

**How it reaches the workflow.** The workflow holds `templateStore` and `repoRoot` and **no `WorkspaceStore`**
(`create-instagram-agent-workflow.ts:477,697,725`), so the document cannot be read at a code step. It arrives
through a new read-only tool `media.getLikenessConsent` (`TOOL_VERSION = "1.0.0"`, no egress), created the way
`createGetVisualPatterns(store)` is, registered in `packages/tools/karos-media/src/index.ts`, and called at the free
step `00e-check-likeness-consent`, outside the attempt loop, checkpointed and frozen into the run. `media.*` is
legitimately absent from some registries (`workflow:4798-4804`) — **an absent tool yields no permit**, i.e. the
conservative default. Fail-closed by construction. Registry count **62 → 63**.

### 5.3 What the generation prompt does differently

**Denied / absent — every client on day one:** nothing changes. `art.permittedMarks` / `art.permittedFigures` are
absent, so `buildBrief` is byte-identical to 1.1.0.

**Granted, with names:** `image.generate` gains two optional inputs and one conditional clause.

```ts
// generate-image.ts input schema, additive
permittedMarks:   z.array(z.string().min(1)).max(6).optional(),
permittedFigures: z.array(z.string().min(1)).max(3).optional(),
```

and the standing constraint changes **only when a list is non-empty**:

```
Constraints: no text, no words, no lettering, no numbers rendered in the image,
no logos or brand marks other than: Apple, Samsung — those may appear only as clean flat
circular badges or plain wordless silhouettes, never as a photographed product,
a packaged good or a person's likeness;
no watermarks, no borders or frames, no collage or split panels.
```

The badge framing is not decoration: it is what the reference account actually does, it keeps the mark out of the
*photographic* content where a rights question is sharpest, and it renders reliably at small size.
`describeGenerated` gains the corresponding clause when `permittedFigures` is non-empty, so the vet is not told "no
identifiable real person" about an image that deliberately contains one.

**Tool version: `image.generate` 1.1.0 → 1.2.0.** MINOR, with the rationale in the header comment beside the
existing 1.0.1 / 1.1.0 entries: additive optional fields, byte-identical brief when absent, but the composed prompt
changes shape when present — the same reasoning 1.1.0 records for `forbid`/`styleLock`. The push gate exists so a
prompt change is legible in the version. `visual-patterns.ts`'s two tools are not edited, so `INGEST_TOOL_VERSION` /
`GET_TOOL_VERSION` stay at 1.0.1.

### 5.4 Code, not model judgment, is what enforces the list

L9 checks every `usesPermittedMarks` entry against the permit before `04n` accepts the concept, and the workflow
never passes a name to `art.permittedMarks` that the consent record did not list. A model that invents "Nike" does
not get Nike; it gets its concept discarded. The prompt is advisory (the tool's own schema says so at `:83-88`); the
teeth are L9 plus the vision inspection in §6.3, which compares what was actually drawn against the permit.

### 5.5 The owner's decision, surfaced in the PR body

The PR body will state, in these words: *the capability ships conservative and disabled. The permission is a
`generatedLikeness` block in `clients/<slug>/client/consent.json`; no client has one; the shipped behaviour is
therefore no third-party marks and no public figures for the entire fleet until you write a record. Here is the
shape of the record. This is a trademark, right-of-publicity and brand-safety decision and it is yours — nothing in
the agent can make it, and no agent may ever write this block.*

---

## 6. THE IMAGE VET AND METAPHOR

The sharpest risk in the design. Today a good metaphor is **mechanically rejected** and a wrong metaphor is
**mechanically accepted**, for two independent reasons. Four changes.

### 6.1 A declared metaphor, opt-in per slide — `instagram-image-vet@4 → @5`

The vet's per-slide input gains one optional field, present **only** on the one slide `04n` actually gave a concept
to:

```ts
conceptual?: { pattern: ConceptPattern; anchor: string; decodesTo: string; restsOn: string }
```

Every other slide, on every other run, reads the **byte-identical @4 rubric**, including the anti-Maccabi belt at
`4.md:110-118`. Metaphor tolerance is **declared by the pipeline** for one slide, never inferred by the vet. That is
what stops this bump from quietly loosening the literalism Phase 0 and Phase 3 bought.

New §1c, on a `conceptual` slide only, scored on the **same 1-5 `claimMatch` scale** so `MIN_CLAIM_MATCH = 3`
(`types.ts:706`) and `isUnfillable` (`workflow:4967`) are untouched:

- **5** — the declared `anchor` is what is in frame, the unexpected situation is the declared one, and a reader
  holding the headline arrives at `decodesTo` immediately.
- **4** — anchor present, situation approximately right, the decode takes a beat.
- **3** — anchor present, but the situation is generic: the picture is decorative rather than the story.
- **1-2** — the anchor is absent or different; **or** the picture decodes to something other than `decodesTo`;
  **or** it decodes to nothing.
- And the clause that stops a wrong metaphor: **"A picture that could illustrate any story is a 2 on a conceptual
  slide, even though the same picture would be a 3 on a literal one."**

A concept slide is therefore held to a **higher** floor than a literal one, not a lower one. The escape from
literalism is paid for with a stricter test of whether the metaphor actually works. **No threshold is relaxed
anywhere.**

§1c also suspends the `4.md:110-118` unnamed-subject belt **for `conceptual` slides only**, in one sentence naming
the reason: on a declared metaphor the named entity is deliberately absent from the frame, and the belt exists to
catch a candidate that is silently about a different subject — which `decodesTo`, checked against the vision note,
now tests directly.

### 6.2 The `why`-stripping bug on the generate tier — fixed

`workflow:5235-5238` builds the rescue re-vet's slides as
`{ n, headline, body, scene: g.prompt, isClientPhotoSlot }` — **no `why`**. The vet's own prompt says a slide
arriving without `why` falls back to v3 literalism (`4.md:19-20`). So the generate tier, the only tier a concept
image can arrive on, is exactly the tier where the metaphor-tolerant discriminator is stripped. Fix:

```ts
const need = normaliseVisualNeed(slide);
return { n: g.n, headline, body, ...vetSubjectFor(need), scene: g.prompt,
         isClientPhotoSlot: tier0Slots.has(g.n),
         ...(conceptForSlide(g.n) !== undefined ? { conceptual: conceptForSlide(g.n)! } : {}) };
```

Free, and a correctness fix independent of this phase.

### 6.3 The tautology — broken, on pixels, for $0.001

`describeGenerated(prompt)` (`generate-image.ts:184-186, :366`) restates the prompt into the candidate description,
and the rescue tiers are **not** vision-inspected (`05c` runs only on the tier-1 pool). On the generate tier the vet
therefore compares the brief against itself. For a normal generated image that is merely weak; for a concept image
it is fatal — the concept would score 5 against its own words every time and §6.1 would be theatre.

New step `06d1-inspect-concept-image-attempt-N`: **one** `media.inspectImages` call on **one** candidate, the
concept image only, `purpose: "candidate-vetting"`. Its output — `subjects`, `textInImage`, `hasPeople`, and the
description that names what it can actually recognise (`inspect-images.ts:133-137`) — **replaces**
`describeGenerated`'s echo in the candidate handed to the re-vet. The vet now judges what was drawn.
`looksAiGenerated: true` is expected here and is explicitly **not** a rejection reason.

The same call does the safety check, in code (`checkConceptRendered(analysis, permit, ownBrandName)`):

- **Any name the permit does not cover, in `subjects` *or* in `description`, → candidate dropped.** The test is the
  RECOGNITION itself — a name-shaped token run — not a cue word beside it. `inspect-images.ts:133` asks the model to
  "NAME what you can actually recognise … and say so plainly", so the likeliest output shape for a recognised mark
  or face is a bare name (`"Tim Cook at the head of the table"`, `"Nike sneakers"`, `"the Duolingo owl"`), and a
  first cut of this check that required one of twelve English mark nouns in the same string passed all three.
- A mark NOUN with no name attached (`"an owl mascot"`, `"a crest on the shirt"`) → candidate dropped, unless the
  note carries a permitted name. The mascot/character/cartoon entries are here because the reference recipe's own
  headline example is a mascot.
- `hasPeople` true or a person noun present, with a name the permit does not cover → dropped as a likeness rather
  than as a mark. The two differ only in the sentence the reviewer is shown.
- `textInImage` non-empty → candidate dropped (the standing no-lettering constraint, now actually verified on the
  one image most likely to violate it, since badges and throne-rooms invite signage).

Cost: `visionInspectPerImage` = **$0.001**, at most once per attempt. It is the highest-value dollar in this design
and it is the difference between a measured mode and a hopeful one.

### 6.4 The concept must WIN, not merely qualify

Three precise changes in the rescue-tier loop:

1. **The tier runs for a concept even with no gap.** `workflow:5172`'s `unfillable.length === 0` guard becomes
   `unfillable.length === 0 && conceptPending === false` for the `generate` tier only.
2. **Concept-first ordering.** `gaps` is sorted with the concept slide first, so `gaps.slice(0, budget)` at `:5207`
   keeps it when the image budget is partial.
3. **Strictly-better replacement.** At `:5246-5252`, for the concept slide only:

```ts
// A concept image REPLACES a picture the slide already had only by beating it
// on the same rubric. A slide that already has a 4 does not lose it to a 4.
replacement && !isUnfillable(replacement) &&
  (sel.imagePath === null || replacement.claimMatch > sel.claimMatch)
```

A concept that reads scores higher and ships; a concept that does not read scores lower and the photograph stays.
**The mode cannot degrade a slide.**

### 6.5 Proving the guards, in both directions

Per the standing rule — a test that cannot fail is not a test — each fixture below was written by breaking the code
first and watching the guard refuse.

| | fixture | expected | break it and watch |
|---|---|---|---|
| **a good metaphor is not rejected** | headline names two rival companies; `conceptual: {pattern:"rivalry", anchor:"two identical high-backed chairs at the head of one long table, one seat scorched", decodesTo:"…"}`; the vision note names chairs, a table and scorch marks, and **no company** | `claimMatch >= 3`, the slide keeps its image | remove the `conceptual` field → the same fixture scores **2** under `4.md:110-118` and downgrades. That is the premise assertion: without §1c the good metaphor genuinely dies |
| **a wrong metaphor is not waved through** | same slide, same `conceptual`, vision note is "a laptop on a desk, soft daylight, a person out of focus" | `claimMatch <= 2`, concept discarded, photograph retained | delete the "could illustrate any story" clause → it becomes **3** and ships |
| **a decorated assertion is not waved through** | `decodesTo` names the entity correctly but the vision note shows nothing related | `claimMatch <= 2` | remove the "an assertion in the description is not evidence; the vision note is" clause → it scores on the assertion alone |

Plus, deterministic and free: L1-L10 each get a test that passes a concept violating exactly that clause and asserts
it is discarded, and a control that passes.

---

## 7. COST

### 7.1 Per run, when the concept fires

| line | arithmetic | $ |
|---|---|---|
| `00e-check-likeness-consent` | `wf.step.code`, one store read via a tool, no egress | 0.000 |
| `04m-concept-eligibility` | `wf.step.code` | 0.000 |
| `04n-design-concept` | Sonnet 4.6: 6,200 in × $3/1M + 650 out × $15/1M = $0.0186 + $0.00975 | **0.029** |
| the concept image | 1 × `generatedImage` (`perNeed: 1`, no shortlist) | **0.039** |
| `06d1-inspect-concept-image` | 1 × `visionInspectPerImage` | **0.001** |
| re-vet prompt growth | ~200 extra tokens on an existing Flash call | 0.0001 |
| `04o-apply-concept` | `wf.step.code` | 0.000 |
| **worst case when it fires** | | **$0.069** |

The $0.039 is only genuinely additive when the concept slide had no gap of its own; when retrieval had already
failed that slide, the image would have been generated anyway and the marginal cost is **$0.030**. The table books
the worst case.

**Amortised at the design-intent ~17% selection rate: 0.17 × 0.069 = $0.012 per run.**
**At the 25% arithmetic ceiling: 0.25 × 0.069 = $0.017 per run.**

**Setup budget: +$0.00.** No setup step. The concept reads the art direction Phase 3's setup already derived; the
consent read is a free store read through a tool with no egress. Target $2.00 / hard max $3.00 unchanged,
`planSetupBudget` untouched.

### 7.2 Against $1.00 target / $1.50 hard max

A typical Instagram run today prices at roughly **$0.38–0.55** (scout 0.012 + extraction 0.0135 + angle 0.036 +
copy 0.159 × ~1.5 + `05c` ~0.030 + vets ~0.012 + relevance/fluency/visualQA ~0.010 + rendered inspect ~0.008 +
scraper). A firing run lands at **$0.45–0.62** — comfortably inside target.

The estimator at `02j-plan-run-budget` cannot know whether `04l` will fire, because it runs long before it. Per
`run-budget.ts:73-76`'s own rule — *an estimate that flatters itself pulls no lever* — it prices the worst case
**unconditionally**: `RunShape` gains `conceptPossible: boolean` (false when the client config says `off` or the run
input says `off`), and `rawEstimate.fixed` gains
`+ (shape.conceptPossible ? c.concept + c.visionInspectPerImage : 0)` = **+$0.030**. The image is already inside the
existing `plan.generatedImagesCap * c.generatedImage` term at `:545` and is **not** double-counted.

So a cold English run's estimate moves by **+$0.030**. On a run already near target this will now trip
`IMAGE_CAP_STEPS[0] = 4` where it previously fitted. **That is the adaptation working, not a regression** — and it
is exactly why concept-first ordering (§6.4.2) exists: when the cap is partial, the concept image is the one that
survives it, because it is the one image in the run whose loss cannot be recovered by retrieval.

**The hard max is unreachable by this feature.** Precondition 7 requires `meter.posture === "normal"`, evaluated
live at `04l`. Past $1.00 the meter is `essential-only` and the concept step does not run — **the $0.029 Sonnet call
can only ever be bought out of the first dollar.** The mode cannot push a run from $1.40 to $1.50.

### 7.3 The adaptive ladder — never a hold

| state | behaviour | run status |
|---|---|---|
| `posture: normal`, `generatedImagesCap > 0`, selector fires | full concept | `completed` |
| `posture: essential-only` (past target) at `04l` | no concept step; the verdict records `skipped: "past target"`; the slide takes its ordinary scene brief | `completed` |
| `posture: cheapest-path` (past hard max) | same; the rescue tiers are already off at `:5193` | `completed` |
| `generatedImagesCap === 0` (third image lever) | `04l` returns not-eligible before spending anything | `completed` |
| concept authored, generation 429s / `content_fail`s / is capped | the slide falls back to its **original, never-discarded** scene brief and its retrieved candidate | `completed` — the ordinary brief is a complete deliverable, so not even `degraded` |
| concept image generated but loses the re-vet (§6.4) | the photograph stays | `completed` |
| concept discarded by L1-L10 | the slide keeps the writer's brief | `completed` |

Never `held`, never `failed`, at no point in the ladder. Every skip is recorded in `rescueSkipped` / `conceptReport`
and surfaced in the downgrade detail at `workflow:5316` in the house style.

---

## 8. THE CHANGE SET

**New files**
- `agents/instagram-agent/src/workflow/concept-direction.ts` — the selector, signals, `namedEntities`,
  `conceptSubjectPalette`, the pattern preconditions, the ledger codec, `checkConceptLegibility`,
  `checkConceptRendered`. Pure: imports nothing from the workflow, testable without a harness.
- `agents/instagram-agent/src/agent/instagram-concept-agent.ts`
- `agents/instagram-agent/prompts/instagram-concept/1.md` (+ identical `latest.md`)
- `agents/instagram-agent/prompts/instagram-image-vet/5.md` (+ identical `latest.md`)
- `packages/tools/karos-media/src/likeness-consent.ts` — `GeneratedLikenessConsent`,
  `readGeneratedLikenessConsent`. Pure, fail-closed.
- `packages/tools/karos-media/src/get-likeness-consent.ts` — `media.getLikenessConsent`, `TOOL_VERSION = "1.0.0"`.
- Tests: `concept-direction.test.ts`, `concept-vet-metaphor.test.ts`, `concept-workflow.test.ts`,
  `concept-budget-and-art.test.ts`, `likeness-consent.test.ts`, `generate-image-concept.test.ts`.

**Changed files**
- `create-instagram-agent-workflow.ts` — four steps, the gate payload and deliverable, gaps ordering, the re-vet
  input, the replacement rule, the guardrail surface, the run-input override.
- `packages/tools/karos-media/src/generate-image.ts` — **1.1.0 → 1.2.0**.
- `packages/tools/karos-media/src/index.ts` — register the new tool.
- `packages/tools/__tests__/cross-cutting.test.ts` — registry count **62 → 63**.
- `agents/instagram-agent/src/agent/instagram-image-vetting-agent.ts` — `skillRef` `@4 → @5`.
- `agents/instagram-agent/__tests__/semantic-image-vetting.test.ts` — the `@4` pin at `:78` becomes `@5`.
- `run-budget.ts` — `concept: 0.029`, `RunShape.conceptPossible`, the fixed-estimate term.
- `visual-direction.ts` — export `ANTI_METAPHOR_LINE_PREFIX`, add `buildConceptArtDirection`, and the §4.4
  fallback-forbid fix.
- `scripts/prompt-registry.ts`, `docs/RFC-16` (this file).

**Prompt registry rows**

```ts
{ promptId: "instagram-concept",   agent: "instagram-agent", versions: ["1"], latestVersion: "1" },
{ promptId: "instagram-image-vet", agent: "instagram-agent",
  versions: ["1","2","3","4","5"], latestVersion: "5" },
```

`instagram-concept` carries no `requires` flags, for the same reason `instagram-art-director` does not
(`scripts/prompt-registry.ts:145-151`): it receives the resolved `targetLanguage`, never `clientVoiceContext`, and
its output is an English brief for an image model. Two five-step prompt-bump checklists:
`instagram-image-vet@5` (bump) and `instagram-concept@1` (new). `instagram-copy` is **not** bumped — that is a
deliberate property of the design, not an omission.

**New workflow step ids, for the PR body.** `agent-middleware/scripts/generate_engine_stages.py --check` must be
re-run **after merge**, not in the worktree:
`00e-check-likeness-consent`, `04m-concept-eligibility`, `04n-design-concept`, `04o-apply-concept`,
`06d1-inspect-concept-image-attempt-N` — the last three also appear `rev()`-keyed per revision.

**New agent class id for Studio `stageModels`:** `instagram-concept`.

**Cross-package fixture:** `packages/workflow/__tests__/context-doc-policy-fixture.test.ts` feeds instagram router
turns positionally; `04m` adds a model step, so that fixture needs one more queued turn via the named
`standardTurns()` helpers (RFC-14 §Engine conventions records this trap).

**Test posture.** Chromium-gated render tests self-skip on this machine; **passed and SKIPPED are reported
separately** and CI is the authoritative gate. Nothing in this design touches a threshold — `MIN_CLAIM_MATCH`, the
Phase 2 interest floor, `MIN_RELEVANCE_SCORE`, `ACCENT_GROUND_CONTRAST_FLOOR` and the budget ceilings are all
unchanged.

---

## 9. WHAT WAS DELIBERATELY NOT BUILT

1. **A concept on more than one slide.** One per carousel, always. Two concepts in one post is a themed carousel — a
   different product, and the fastest route to the repetition defect Phase 2 exists to measure.
2. **A copy-prompt carve-out.** `instagram-copy@15` is untouched and §6's *"no named real people, brands, products
   or logos"* stays absolutely true of the writer. Widening the largest prompt in the agent to let the *writer*
   author concepts would put the exception on every slide of every run and make it unmeasurable.
3. **Composited logo badges in the renderer.** The reference account's white circular Apple/Samsung badges are a
   *template* job, not a diffusion job: the generator cannot draw legible marks, and the standing no-lettering
   constraint predates the rights question. `art.permittedMarks` gets the capability into the generator behind
   consent; a badge slot needs an asset pipeline for third-party marks and a rights question about *stored* marks,
   and is separate, later work with its own owner decision.
4. **The news-plate type treatment.** The condensed-uppercase headline with a yellow→orange gradient on the surprise
   clause is the other half of what makes the reference slides arresting, and it is a renderer / Template Studio
   change. Mixing a type-system change into an imagery change makes neither reviewable.
5. **Wiring `effectiveKit.palette` into `image.generate`.** The derived accent ring is richer and
   contrast-validated, and it is currently un-wired — but changing which palette reaches generation would change
   *every* generated image in the fleet, a Phase 3 regression risk taken on Phase 4's ticket.
6. **A `tension` / `rivalry` / `entities` field on `TrendCandidate`.** It re-prices the scout and invalidates
   fixtures across five engines, to buy a signal `angleId` + `hasNumbers` + a contrast lexicon + fact-card sources
   already approximate. If the measured rate proves the lexicon is the weak term, that is the next lever.
7. **Vision-inspecting every generated image.** The `describeGenerated` tautology is real for all of them; it is
   broken here for the one image whose whole value is whether it reads. Fleet-wide is +$0.001 per generated image up
   to +$0.008 a run — defensible, and out of scope of a mode that fires a quarter of the time at most.
8. **A Hebrew-aware proper-noun detector.** `HEADING_HAS_PROPER_NOUN` is case-based and its own comment admits it is
   silent in Hebrew. Writing a real one is worthwhile work and it is not this work; §1.3 is built so it is not
   needed.
9. **A `gate.likeness` in `karos-gates`.** Enforcement here is a fail-closed consent read, deterministic allowlist
   checks and one vision inspection. A general-purpose likeness gate usable by the video, TikTok and Instagram
   agents is the right eventual home and should be designed against three callers, not one.
10. **Auto-derivation of the consent record.** No agent may ever write `generatedLikeness`. The reasons
    `visual-patterns.ts:50-59` gives for consent living in its own document apply doubly to a permission an agent
    could otherwise grant itself.
11. **A `perNeed: 2` shortlist for concept images.** Doubling the most expensive line in the run to audition
    metaphors is the wrong trade at a $1.00 target.
