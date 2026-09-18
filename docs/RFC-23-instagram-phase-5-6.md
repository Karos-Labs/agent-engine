# RFC-23 — Instagram Phase 5.6: the agent against the owner's own specification

**Status:** SHIPPED IN PART, in PR #143. This document records what was built, what was decided
against and why, and exactly what is left — because the plan it was built from lived in a session
scratchpad and that is not a place a plan survives.

Written after the work rather than before it, which is the honest order for this one: several of the
decisions below were made by evidence found during the build and would have been written down wrong
beforehand. Where a plan item changed, both the plan and the reason are stated.

---

## 0. WHAT THIS PHASE WAS

The owner supplied a written Instagram specification (`04 Instagram best practices`) and asked what
still had to change after Phase 5.5. Phase 5.6 is that answer: every item in the specification the
agent did not already satisfy, minus the ones Phase 6 owns.

The binding rulings in force, unchanged: [[quality-before-cost-2026-09-16]] — spend what the post
needs and report the figure; [[budgets-adapt-never-hold]] — a budget never fails a run; and
[[agents-always-deliver]] — never end a run with no deliverable.

---

## 1. SHIPPED

### Images — the owner's actual complaint

Nothing in the pipeline had ever looked at an image's pixels. A candidate's size was whatever a
provider's URL happened to serve, judged by a model reading a description, which cannot count.

- **A8.** `readImageSize` in `tool-common` reads the container's own header (PNG, JPEG, WebP, GIF,
  AVIF; no dependency added). The floor moved **inside `downloadHit`**, so all four source tiers get
  it and none can forget it. Under 1080px on the short side is refused with its real size in the
  reason, and nothing is written to disk. Client-supplied media is MEASURED rather than refused —
  their own photograph is not a search result to reject — but unreadable bytes are refused under
  either policy, because `measure` softens "is this big enough", not "is this an image".
- **A refusal carries a reason at all.** Every failure in that function used to return a bare
  `undefined`, so a 404, an HTML error page served as `image/jpeg` and a 400px thumbnail were one
  message: *"failed to download"*. That is the answer to "why are there no images", and it was being
  discarded on the line that knew it.
- **D2.** `IMAGE_MODEL_LADDER`: a model that says `NOT_FOUND` is struck off and the next is tried; a
  403 or a 429 demotes nothing, because neither says the model is absent; the last rung is never
  struck. Cost units are booked per model that actually served.
- **A11.** Generated frames carry provenance: model, brief hash, and whether the frame is the
  photorealistic kind Meta's rule is about — defaulting to yes, because declaring an illustration
  costs nothing and not declaring a photograph is a breach.

### Craft

| Item | What changed |
|---|---|
| A4 | Hashtags never in a comment. The `firstComment` branch is gone and a test keeps the union member dead. |
| A7 | Alt text 125 → 100. |
| A10 | The hook is ≤100 characters, counted in code points, and may not OPEN on an emoji, an `@` or a `#`. Inside the line all three are ordinary Instagram writing — this is not X's rule with a different number. |
| B1 | Slide 2 is a second cover (prompt), because the platform re-serves a carousel there for a reader who did not swipe. |
| B2 | `hookPattern`, four shapes, optional on the wire and asked for by the prompt. |
| B3 | Four asks, and the condition on the strongest: comment-for-asset is available only when the run actually has an asset to name. |
| B4 | Caption register: one idea a line, ≤30 words a line, ≤2 emoji, and a caption that is ONLY a bullet list is refused. Arrow bullets among prose are allowed, because the owner's reference accounts use them. |
| B5 | Six more tells in the shared bank. |
| B8 | Topic phrase in the first line and slide 1 — **reported, not refused**. See §2. |
| C5 | A competitor's name in a client's own post is refused, whole-word across scripts. |
| E2 | `minGapHours: 24` stated on the timing note. The portal owns the calendar and enforces ninety minutes; the engine can only say what this platform's floor is. |

`instagram-copy@23` carries all of it.

### Strategy

- **C2.** `post-performance.ts` is every consumer of Phase 6's data, built and tested before the data
  exists: the three-arm vocabulary, the typed store, `argmax(sends/reach + saves/reach)` with a 20%
  bandit and a 90-day half-life, the topic constraint that overrides the measurement, and the
  rotation fallback that runs today and says so in its own `source` field. Read at `02k`, written at
  `09b` on a post that actually shipped.
- **C3.** Each client runs three to five series, not everyone's six. `BUNDLED_SERIES`' own comment
  said the six were chosen so that "any client can carry" them, and that is the mechanism behind the
  owner's verdict on two finished posts: *you can see the same AI made both.*
- **C4.** The industry table, as a closed set of named segments. `regulated` is first, so a
  medical-records SaaS reads as regulated rather than as SaaS; a misreading has to run in that
  direction, because a regulated client posted as a SaaS is a compliance problem and a SaaS posted as
  regulated is a dull week.

---

## 2. DECIDED AGAINST, WITH THE EVIDENCE

### B8 is a note, not a refusal

Three versions, two falsified by this repo's own fixtures:

1. **A majority of the topic's significant words.** Falsified by "cutting onboarding time" against
   the cover "We cut onboarding from 14 days to 3" — one word in three, refused, and any reader can
   see the slide is about exactly that. The misses are "cutting" versus "cut" and a unit word a good
   headline replaces with a number. Both are what correct editing DOES.
2. **The most distinctive word, taken as the longest.** Falsified by `goodTrendScoutOutput()`'s topic
   "automated weekly reporting is replacing the Monday status meeting", whose longest word is
   "automated" — absent from a perfectly good cover. Length is not subjecthood.
3. **Any significant word**, kept, and demoted to a `notes[]` entry.

The first cut was also wired as a PACKAGE-step refusal, where no retry could have satisfied it: the
packager writes alt text and cannot rewrite a caption the copy step finalised. It would have burned
three attempts and shipped degraded over a keyword.

The general rule, which this workflow already states about a closing call to action: **code can prove
a thing is present and generally cannot prove it is absent.** A competitor NAME is the opposite case
and is rightly a refusal — a company name either appears or it does not.

`hookPattern`'s absence is a note for the reason `payloadKind`'s is, written down in `types.ts`:
requiring the declaration of a live draft without refusing the fixtures that predate it is not
something the gate can tell apart.

### C3 does not author new series

A series is not a name. It is a `middle` of validated archetypes whose ordering has been calibrated
against the interest floor, and `EditorialSeriesId` is a closed union every consumer is keyed on. A
model inventing one at setup would be inventing a layout sequence nothing has rendered — the thing
the owner's own ruling forbids ("dynamic composition from validated building blocks"). A per-client
SUBSET delivers the property that was actually asked for.

### C1 is half-built, and the absent half is absent rather than faked

Nothing in a run decides a funnel stage. `PostPerformanceRecord.funnelStage` is therefore **omitted
on every record**, deliberately: writing `"expertise"` on every row would give Phase 6 a column that
looks like data, is a constant, and makes every cut by funnel stage return the same answer.

### `selectArm` is not wired into today's format decision

With an empty store it produces the rotation answer the workflow already produces by another route,
and a selector that decides nothing is the furniture this phase exists to remove. Phase 6 fills the
store and calls it.

### D1 is an owner decision, not a code change

`resolveModelPolicy` already reads `MODEL_STEP_<STEP>_MODEL`, so
`MODEL_STEP_INSTAGRAM_COPY_MODEL=claude-opus-5` re-points the copy step per environment. **Verified
by probe, not assumed:** the env var re-points the compiled `modelPolicy`, and
`applyClientLanguagePolicy` does NOT then divert a Hebrew run to opus-4-8 — no Anthropic row at or
below the `standard` cost cap meets the multilingual requirement, so it logs a warning and keeps the
step's own model. English and Hebrew both get opus-5.

Changing the DEFAULT is a different matter: it contradicts `no-premium-models.test.ts` (RFC-15 §8,
the owner's 2026-09-12 rule) and needs a `MODEL_CAPABILITIES` row. Cost: **+$0.24 per attempt**
($0.40 on Sonnet against $0.64 on Opus, at ~47k in / ~16.3k out).

Note it currently works by FALLBACK: `claude-opus-5` has no `MODEL_CAPABILITIES` row, so nothing
confirms it is multilingual-strong. Adding one would make the Hebrew path a decision instead.

---

## 3. WHAT IS LEFT

### Blocked on PR #136 (the eight-plate design system)

A1 (canvas 4:5 **and re-calibrating every interest-floor threshold**, which were all measured on a
1440-tall frame), A2 (feed-UI safe zones), A3 (contrast measured on pixels, as a gate), A5 (logo on
one slide), A6 (two font families), A9 (the font floor asserted after `--ts` scaling), A12 (slide
count by post type), B6 (slide counter), B7 (text never over a face).

Every one edits the eight templates or `interest-floor.ts`. Two sessions editing those at once is the
collision that cost Phase 5.5's second wave three partial work packages.

### Unblocked and not done

- **C6** — the topic-approval gate, as a switch (autopilot or pick), defaulting to autopilot on a
  calendar-driven run. Left because it adds a gate to the run's flow and a large number of
  integration tests assert the gate id and count; it is a change to make with the suite in front of
  you, not at the end of a session.
- **E3** — reshare to Stories, 9:16 from the cover.
- **E4** — the 4:5 → 9:16 re-render for TikTok.
- **C1's other half** — deciding a funnel stage at all, which means a field on the topic claim and a
  prompt that argues for one.
- The rest of C4's table — tone, proof rules, and each segment's hard constraints as gates. The
  `regulated` half of that already exists, driven by client config.

### Owner actions

1. **The Instagram Graph API application.** `@agent-engine/tool-karos-meta` landed in PR #134 and
   already returns `saved`, `shares`, `reach`, `views`, `profile_visits` and `follows`. It is waiting
   on a token, and App Review is the multi-week part.
2. **D1**, per §2.
3. Re-run `agent-middleware/scripts/generate_engine_stages.py --check` after these merge, and re-seed
   the Studio stages.

---

## 4. THREE GUARDS THAT CAUGHT REAL BUGS

Worth recording, because each was invisible to a local run:

- **`check-model-pricing`** failed the moment the ladder named an `imagen-*` id. `pricingForUnit`
  THROWS on an unpriced unit, so a run that fell through to Imagen would have died at the cost step
  with the money already spent. Both rates were then read off Google's page: Imagen 4 and Imagen 3
  are **$0.04** an image — Imagen 3 is widely remembered as $0.03 and is not.
- **The tool-version push gate** caught a version carried unchanged through a merge conflict while
  the constant under it changed value.
- **`cost-accuracy-golden`** read source TEXT for a literal units array, so a computed per-model
  units argument failed a guard whose stated subject it satisfies. Widening the pattern was not
  available — a metered tool's RESULT argument carries a `model` field of its own, so any regex loose
  enough to accept a computed second argument also matches the first and the guard stops being able
  to fail. It counts commas at depth one now, and carries its own premise test.

---

## 5. THE BAR THIS PHASE DOES NOT CLEAR BY ITSELF

[[instagram-definition-of-done]] is three prep posts the owner would publish, not a green CI. Nothing
here has been run in prep. The items most likely to change what a post LOOKS like are the nine blocked
on #136, and the one most likely to change what it CONTAINS is `instagram-copy@23`, which has never
been given to a live model.
