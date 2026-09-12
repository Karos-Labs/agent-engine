# RFC-18 — Instagram agent: value, voice, and the post as a whole product (Phase 5)

Status: specified. Follows RFC-13 (Phase 0/1, merged as #84 and #94), RFC-14 (Phase 2/3, #107 and #108) and
RFC-15/RFC-16 (Phase 4, #109 and #110). Driven by the owner's original plan, translated from Hebrew:

> **"Voice, value, and the post as a whole product."**

Phase 0 answered *"is this relevant to what the client actually does?"*. Phase 5 answers the other half of the
2026-09-08 audit's central charge — ***"will anyone save this?"*** — and ships the parts of a post that a
carousel of eight PNGs and a caption has never had: hashtags, alt text, a sourced first comment, a timing
constraint.

---

# Part 1 — Brief

Worktree `C:\Users\1\Documents\KarosLabs\agent-engine-igvalue`, branch `feat/instagram-phase5-value`, cut from
`origin/main` at `4364b1a`. Never touch `C:\Users\1\Documents\KarosLabs\agent-engine` or any other
`agent-engine-*` worktree. Files are CRLF; use Edit/Write, Python writes need `newline=""`.

A separate workflow owns the TEMPLATE system this cycle. `agents/instagram-agent/assets/templates/`,
`interest-floor.ts` and `slide-devices.ts` are untouched by every package in this RFC. **Phase 5 changes no
pixels.** `publish.renderCarousel` stays at `1.3.1` with no bump.

## The owner's plan, verbatim (translated)

1. **The writing prompt is rewritten around value**: a cover headline with tension or a number; one claim per
   slide with a "so what"; a clear brand position; variation in sentence rhythm; and a ban on reproducing the
   source's prose. The writer moves to a stronger model and gets a limited search tool for verification.
2. **A value gate**: a judge with a rubric — is there a fact a reader in this niche did not know, is there a
   position, is there an action? A score below the bar returns the draft **with an explanation**. *"This is the
   gate that is missing today between 'correct' and 'good'."*
3. **The whole post**: a structured caption (hook, body, CTA), 3-5 niche hashtags derived from the brief, alt
   text for every slide, a first comment carrying sources, and a suggested publishing time. **Today there are
   no hashtags at all.**
4. **Formats**: single image with a deep caption already exists; add a Reels cover + a short script derived
   from the carousel, and a Stories teaser.

## Binding owner decisions (these override the plan where they conflict)

- **Run cost: target $1.00, hard max $1.50. NO OPUS IN A RUN.** §7 reconciles the plan's "move the writer to a
  stronger model" against this line, explicitly and with arithmetic. Every new model step justifies its cost
  in a comment beside it.
- **BUDGETS ADAPT, NEVER HOLD.** Estimate before the first paid call; adapt to fit; past target drop optional
  work; past the hard max finish on the cheapest complete path and **DELIVER**. Status `completed`, at worst
  `degraded` with a named reason. Never `held`/`failed` for budget. This reaches the value gate's retry loop:
  bounded rounds, then ship the best version degraded with a reason. Phase 4 reconciled the identical tension
  the identical way (RFC-15's termination table); §5.7 is consistent with it row for row.
- **Harvesting and verification search is ScrappyCoco only** (`packages/tools/karos-scraper`). No Apify, no new
  vendor. §4.2 spends exactly one scraper execution per run and no new tool.
- **Engine-native**: agents via `wf.step.agent`, typed zod tools under `packages/tools/*`, deterministic
  orchestration in `wf.step.code`.
- **Hebrew is first-class.** Every prose field added here passes Phase 4's machinery (§6), the hashtag
  question is decided deliberately rather than inherited (§6.3), and **Phase 4's bidi isolation is not
  touched** — §6.5 explains why extending it to the new fields would have been a defect, not a courtesy.

## The ground-truth discipline, stated once and repeated in the prompt

The owner supplied reference accounts. **Their EXECUTION transfers; their SUBJECT MATTER never does.** Those
accounts post about AI and marketing. A client that does neither must never inherit those topics — that is the
original audit failure repeating itself with better sourcing.

`briefForPrompt` already omits `sources`, `referenceAccounts` and `ownAssets` (`client-brief.ts:1066-1069`,
"those steer the scout and research, not the writer"). **Phase 5 does not change that line.** The craft is
encoded as rules in prompt §§24-27, its worked examples are written against neutral trades chosen so no client
can inherit a topic from them, and the sentence above is written into the prompt itself so a future editor
cannot drop it silently. The one line the owner named as craft — *"AI does not have a look. You do."* — is
studied in §24.2 as a **shape** (short, declarative, with a turn in it) and is never quoted as a line to
imitate.

---

# Part 2 — Design

## 1. The one sentence this phase turns on

A *"will anyone save this?"* judge is a taste judgment, and a taste judgment from a commodity model is a gate
that cannot fail. Flash will award 4/5 to competent generic copy — which is exactly the copy this gate exists
to refuse, and `relevance-gate.ts:50-54` already records that tendency in writing.

**The move that fixes it: the judge never renders taste. It is asked to FIND EVIDENCE against a stated test,
and an axis with no findable evidence is not a pass.**

Extraction is what Flash is good at. Every `pass` must carry a verbatim span from the draft; the span is
re-checked **in code** against the draft text, and a span that does not occur downgrades the axis. Every
non-pass must carry a fix naming what to write instead; a non-pass with no fix reverts to `pass` — Phase 4's
rule, `language-gate.ts:723-736`, which exists because *"a judge that flags an axis and proposes nothing has
produced a hold generator"*. The bar is computed in the repository, never read from the model's own opinion of
itself (`decideNative`, `language-gate.ts:696-706`: *"a rule stated to a model is a request"*).

Everything mechanical is refused for **$0 before the judge is ever paid**. The judge adjudicates only what a
regex cannot decide.

## 2. Execution order and the new step ids

Ordering doctrine is the workflow's own (`create-instagram-agent-workflow.ts:6478-6490`): *cheapest rejection
first, every free rejection before any paid one.* New rows in **bold**.

| # | id (`rev()`-wrapped; `07*` also `-attempt-N`) | kind | cost |
|---|---|---|---|
| 1 | `05-write-copy-attempt-N` | agent | $0.166 |
| 2 | `04o-apply-concept-attempt-N` | code | $0 |
| 3 | `05b…06f` image sourcing / vetting | code+agent | images |
| 4 | `07a-downgrade-unfillable-slides-attempt-N` | code | $0 |
| 5 | `07-self-check-attempt-N` | code | $0 |
| 6 | `07b-craft-hygiene-attempt-N` | code | $0 |
| 7 | **`07i-value-signals-attempt-N`** | code | **$0** |
| 8 | **`07i2-numbers-in-facts-attempt-N`** (`gate.numbersSourced`) | code | **$0** |
| 9 | `07e-language-script-attempt-N` | code | $0 |
| 10 | `07e2-native-conventions-attempt-N` | code | $0 |
| 11 | **`07i1-verify-lead-claim-attempt-N`** (ScrappyCoco) | code | **$0.007, once per run** |
| 12 | `07g-relevance-attempt-N` | agent | $0.002 |
| 13 | **`07j-value-judge-attempt-N`** | agent | **$0.003** |
| 14 | `07f-language-fluency-attempt-N` (+`-retry`, `-round-2`) | agent | $0.014 × rounds |
| 15 | `07d`, `07c`, `07h`, `07k`, `08*` | code/render | as today |
| — | *the attempt loop breaks* | | |
| 16 | **`08c-package-post`** (+ `-retry`) | agent | **$0.003, once per revision** |
| 17 | **`08c1-package-checks`** | code | **$0** |
| 18 | **`08c2-package-native-round`** (non-English only) | agent | **$0.009** |
| 19 | **`08c3-timing-note`** | code | **$0** |
| 20 | `09a-batch-review`, `09b-deliver-and-log` | gate/code | — |

**Why `07j` sits exactly there**, in four reasons grounded in the code:

1. **After both free gate families.** Most of what a value refusal would have cost is refused for nothing.
2. **After `07g-relevance`.** A post that is not this client's business is dead anyway, and relevance is
   cheaper.
3. **Before `07f`.** Load-bearing: the native editor's corrections are **anchored spans** into
   `headline`/`body`/`caption` (`native-corrections.ts:119-198`), so a value-driven rewrite after `07f`
   invalidates every applied correction and every span round 2 rests on. **Language is the last word on the
   sentences.**
4. **Before `07c-emit-slides-data`**, the assembly checkpoint everything downstream reads.

`07i1` runs after `07e2` so a wrong-script draft never pays for a page fetch. The `08c*` family runs **after
the loop breaks** — alt text for a slide a redraft is about to throw away is money burned, and none of those
fields is an input to any gate inside the loop.

**New step ids for the PR body** — `agent-middleware/scripts/generate_engine_stages.py --check` runs AFTER
merge, not here: `07i-value-signals`, `07i1-verify-lead-claim`, `07i2-numbers-in-facts`, `07j-value-judge`,
`08c-package-post`, `08c-package-post-retry`, `08c1-package-checks`, `08c2-package-native-round`,
`08c3-timing-note`.

## 3. The rewritten copy prompt: `instagram-copy@17`

`skillRef: "instagram-copy@17"` (`instagram-copy-agent.ts:211`). `prompts/instagram-copy/17.md` plus a
byte-identical `latest.md`. Registry `scripts/prompt-registry.ts:167-175` gains `"17"` and
`latestVersion: "17"`. `requires: { languageDirective: true }` is **unchanged** — the marker is the literal
`clientVoiceContext` and §1/§15 still carry it. @16 is 46,587 bytes; @17 lands at ≈ 52,600.

> **The prompt file itself must contain no em dash, no en dash and no double hyphen** (`latest.md:88-95`). The
> prompt bans those characters in the copy it asks for, and v1/v2 broke this and a prep run failed craft
> hygiene on exactly that character twice in three attempts.

### 3.1 Section by section

| § | change |
|---|---|
| §2 caption | Rewritten from "one paragraph" into **three jobs in one continuous string**: a **hook** (first line, ≤ 12 words, carrying the post's position — it is what shows above the "more" fold), a **body** (2-4 short paragraphs paying off the cover's tension and adding the one thing the slides could not fit), and a **CTA as the final paragraph**. Still **one `caption` string** — see §3.3. The existing hashtag ban stays *as a caption rule*; hashtags are a typed field now (§6.3). |
| §3 slide count | Becomes downstream of the payload declaration: the number of slides is whatever the declared structure needs, not a configured constant. |
| §5 headline and body | Replaced; see §3.2. |
| §10 universal craft | `"No hashtag spam"` at `:327` reworded so it is a caption rule, not a contradiction of §28. |
| §12 format | Gains `payloadKind`. |
| §13 attachedMedia | The repeated caption hashtag ban at `:375` kept, scoped. |
| §16 selfCheckSteer | Gains `valueSteer` beside `selfCheckSteer` and `nativeSteer`, with @16's existing posture: a value fix is **a rewrite instruction, not a span**. Plus one new sentence: *"Text quoted under KEEP AS WRITTEN has already been accepted. Reproduce it unchanged."* |
| **§24 new** | Value: the payload and the named specific. |
| **§25 new** | Take a position. |
| **§26 new** | Rhythm. |
| **§27 new** | The source's prose is not yours. |
| §17 angle, §22 scene brief, §23 native | Untouched. |

### 3.2 "One claim per slide with a so-what" — as an instruction and as a check

> **§5.** A slide carries ONE claim. The headline states it. The body does two things and stops: it gives the
> one detail that makes the claim checkable (a figure with its unit and its year, a name, a price, a version),
> and it says what follows for the reader — what they should now do, stop doing, or expect. A body that only
> restates the headline in longer words has no second half. A body that carries two claims is two slides, or it
> is one slide and one of the claims was not worth making.
>
> Write the second half as a consequence for the person reading, not as a summary. "Which means you are paying
> twice for the same coverage" is a so-what. "This is an important consideration for businesses" is the absence
> of one.

Checked by the judge's `payload` axis, which must quote the slide whose body best shows the claim plus its
consequence.

**Deliberately NOT a new `soWhat` field per slide.** It would be ~250 output tokens on *every attempt*, would
have to be added to `languageGateFields`, `archetypeTextSlots`, `resolveField` and the render field map, and if
it is not rendered it is the one text in the post nobody reads. The so-what lives in the body, where a reader
sees it, and the judge checks it there.

### 3.3 No structured caption object, and why

The plan says "a structured caption (hook, body, CTA)". It is delivered as **structure in the prose, not as a
schema**, and that is a deliberate decline of the field-shaped reading.

`interest-relayout.ts`'s `move-sentence-to-caption` remedy (`:686`) appends a moved sentence to
`copy.caption`, and that file is adjacent to the live interest-floor work this cycle. A `captionParts` object
would either force a **NEEDED FROM** on a file Phase 5 must not touch, or require a reconciliation step that
repairs one rendering of the same text against another for $0.17 of nothing. It also costs: the caption is read
by the relevance judge (`relevance-gate.ts:143`), craft hygiene (`craft-hygiene.ts:258`) and
`languageGateFields`'s `push("caption", …)`, and splitting it risks taking the post's main prose *out* of
gates that read it today.

The three jobs are enforced where they are observable: the judge's `position` axis must quote the hook's
assertion, and its `action` axis must quote the CTA. A structure a gate can see is worth more than a structure
a schema can see.

### 3.4 A taken position

> **§25.** The cover asserts something a competent person in this field could argue with, and the caption's
> hook repeats the assertion in different words. Three shapes that work:
> - the correction: "X is not the reason Y happens. Z is."
> - the refusal: "Stop paying for X. Do Y instead."
> - the ranking with a loser: "Of the four ways to do X, one is worse than doing nothing."
>
> A line that would be true for every business in this industry is not a position, it is a category
> description, and it is the clearest single tell that a machine wrote the post. If the client's compliance
> rules forbid a claim, take the position about the DECISION rather than about the outcome: "most teams choose
> X before they have measured Y" asserts something and promises nothing.

§25 also carries, verbatim from `lint-post.ts:86-105`, the list of CTA wordings **`gate.lintPost` already bans
and will fail the draft on**: `comment below`, `agree?`, `thoughts?`, `let me know your thoughts`,
`unpopular opinion:`, `hot take:`, `drop a 🔥`, `check out our`. The craft point is stated outright: those are
the *lazy* wordings. **No carve-out is made in the bank and `lint-post.ts` is not touched** — see §9.

### 3.5 Rhythm

> **§26.** Vary the length of consecutive sentences on purpose. At least one headline of six words or fewer.
> At least one body that turns on a contrast ("not this. that."). Do not begin three slides with the same word,
> and do not give three consecutive slides the same grammatical shape — two imperatives in a row, two questions
> in a row, two "X is Y" definitions in a row, is the cadence that makes eight slides read as one paragraph cut
> into eight. Read the slides in order; if they sound like a list of settings, they are.

The free floor enforces the two mechanical halves. **The judge is not asked about rhythm at all**, because
rhythm has no reader-value consequence a fix can name. Rhythm is a craft rule, not a gate axis. Stated here so
nobody later adds a fifth axis for it.

### 3.6 The ban on reproducing the source's prose, reconciled with §4

§4 (`latest.md:69-77`) requires `sourceRef` to carry a fact card's `claim` **verbatim, character for
character**. That is not a contradiction to resolve by softening §4; they are two different fields.

> **§27.** `sourceRef` is a citation. It quotes the card exactly and nobody reads it. `headline`, `body`,
> `caption` and the alt text are yours. They may not contain eight consecutive words taken from any fact card's
> `claim` or `quote`. Say what the card says in the words this account uses, or the post is a press release
> with a filter on it. The one exception is a slide whose layout is `quote_card`, where the quotation IS the
> slide and the speaker is named on it.

The ban is on the **prose**, never on the **figure**: §7's existing rule at `:230` ("do not paraphrase a
statistic so a slide can be a `stat_callout`") stays in force.

### 3.7 The one schema change to the copy output

```ts
// InstagramCopyOutputSchema (types.ts:609-626) gains, additively:
payloadKind: z.enum([
  "glossary", "ranking", "comparison", "checklist", "timeline", "myth-vs-fact", "walkthrough", "single-claim",
]).default("single-claim"),
```

Eight output tokens, and a `.default()` so no existing fixture or in-flight checkpoint breaks. It buys three
things: the carousel gets a **structural reason for its slide count** instead of "N slides because N was
configured"; the free floor can check the count against the kind; and it is the first editorial input that has
ever existed anywhere near the format decision.

**`04h-select-format` is not moved.** Moving it after the angle is editorially right and shifts positional
router turns for a gain `payloadKind` already delivers inside the copy step. The broken `auto` rotation it sits
on is reported in §11, not fixed.

## 4. The free half — everything a machine can decide, refused for $0

### 4.1 `07i-value-signals` — new local module `value-signals.ts`

Returns the house `SlidesDataSelfCheck` shape `{ ok: true } | { ok: false; reason }` (`types.ts:863`).

**Deliberately a local module, not a `gate.valueFloor` tool in `karos-gates`.** `craft-hygiene.ts` is the
precedent: local logic calling a shared gate when it needs one. Registering a new tool would mean a
shared-package edit and a `TOOL_VERSION` story during a parallel-package cycle, plus a `KNOWN_GATES` entry that
`check-prompts.ts` cross-checks against `createKarosGatesTools()` — for a checker with exactly one caller that
reads instagram-specific types (`FactCardForPrompt`, `ClientBrief`). Nothing is gained. **No `TOOL_VERSION` is
bumped anywhere in this PR.**

Each check refuses for $0:

1. **`sourceProse`** — no run of **≥ 8 whitespace tokens** shared between any `headline`/`body`/`caption` and
   any fact card's `claim` or `quote`. Excluded: `sourceRef`, `stat.figure`, and a `quote_card`'s pull-quote,
   which is *supposed* to be verbatim and is labelled as a quotation to the reader.
   **The threshold for RTL scripts is 6 tokens, not 8**, because Hebrew fuses articles, conjunctions and
   prepositions into clitics, so six Hebrew words carry roughly the information of eight English ones. An
   8-gram rule in Hebrew is a rule that never fires.
2. **`namedSpecifics`** — at least `ceil(slides / 3)` slides carry a named specific: a numeral with a unit,
   currency, percent or year; a `brief.coreTerms` term; a `brief.offers` name; or a capitalised multiword run
   (Latin scripts only — Hebrew has no case, hence the coreTerms/numeral path). Unicode-aware throughout.
3. **`coverTension`** — the cover headline contains a numeral, a named specific, **or** a contrast marker from
   a small per-language list (`instead of`, `stop`, `not … but`; Hebrew `במקום`, `לא … אלא`, `תפסיקו`). This
   catches the hedged cover, the single most common AI tell, at $0.
4. **`payloadShape`** — `payloadKind` consistent with the structure: `ranking` needs ≥ 5 content slides and
   ≥ 3 ordered/`list_takeaway` slides; `comparison` needs at least one `comparison_card`; `glossary` and
   `checklist` need ≥ 4 content slides; `single-claim` only on `format: "single"`.
5. **`rhythm`** — the two mechanical halves of §26: no three slides opening with the same word, no three
   consecutive slides of the same opener class.

### 4.2 `07i2-numbers-in-facts` — a free gate instagram has never called

`gate.numbersSourced` exists, is unchanged, and **no `TOOL_VERSION` bump**. Called with `text` = the caption
plus every slide's headline, body and `stat`, and `sources` = every fact card's `claim` and `quote`.

Today, unsourced numerals invented *inside* `body` are unchecked: `07-self-check`'s `sourceRef` tracing only
proves that a slide cites a card, never that the numbers in its prose came from one. Feed it **content, never
URLs** — that is the 2026-09-05 class of defect this repo already has a memory entry for. Its normaliser
already folds magnitudes, ISO currency codes, `×`, ranges and negatives, and ASCII digits are what a Hebrew
post uses anyway (`gate.nativeLanguage` flags foreign digits), so it works unmodified in both languages.

### 4.3 `07i1-verify-lead-claim` — the verification the plan asked for, done honestly

The plan says the writer "gets a limited search tool for verification". **It does not get one**, and the
reasoning is already on the record in this repo: `instagram-copy-agent.ts:29` is `allowedTools: []`
deliberately, and `tiktok-script-agent.ts:55-61` **measured** what tools cost a drafting agent — three extra
turns, $0.12 to $0.17, 70 to 115 seconds per script. At a $1.00 target that is the entire value gate plus the
entire whole-post artifact, spent on a model deciding its own queries. It also makes the draft non-deterministic
across a resume.

What the plan actually wants is for a checkable claim to be checked. The budget-honest form is deterministic:

- `07i1` takes **one** claim — the fact card the cover rests on (`angle.restsOn[0]`, or the card cited by
  slide 1's `sourceRef`) — and only when that card carries a `url`.
- It calls the already-wired `research.fetchPages` (ScrappyCoco-backed, store-cached by normalised URL) with
  that one URL. **No Apify, no new vendor, no new tool, no schema change.**
- It asks one question in code: does the card's `claim` — or its salient number plus its salient noun,
  whitespace-normalised — still occur in the page's extracted text?

| verdict | consequence |
|---|---|
| `confirmed` | recorded as `value.leadClaim`; nothing else happens |
| `not-found-on-page` | the judge's `newFact` axis is **capped at `weak`** for this attempt and the steer carries a named fix: *"the figure your cover leads on could not be found on its own source page; lead on a different card or state the number the way the source states it."* |
| `unreachable` | advisory only, recorded, never a refusal — a paywall is not the writer's fault |
| `no-url` | skipped |

This closes a real failure mode nothing in the workflow can see today: `07-self-check` proves the writer quoted
the card, and **nothing has ever proved the card**.

Cost: **one ScrappyCoco execution, $0.007, once per run** — the store's cache key makes a repeat of the same
URL on attempt 2 free. Skipped when `plan.optionalRevets === false` or the meter posture is `cheapest-path`; it
is rescue-shaped work and is levered as such (§7.3).

## 5. THE VALUE GATE

### 5.1 What it is

New module `agents/instagram-agent/src/workflow/value-gate.ts`, modelled on `relevance-gate.ts` rather than on
the native editor:

- a `DynamicAgent` with a **flat** `buildOutputSchema` contract (`AgentDefinitionFieldSchema` is
  `"string" | "number" | "boolean" | "string[]"` and has no `object[]`);
- `allowedTools: []` — a judge that can call tools is a judge that can be steered;
- `maxSteps: 1`;
- **an inline system prompt, not a prompt-store file.** Same reason `relevance-gate.ts:43-45` states: *a check
  whose wording lived in the same editable store as the drafting prompts could be edited to agree with them.*
  It also means **no second prompt-registry entry and no second prompt bump** for the judge;
- class id `instagram-value-judge`, which is what Studio keys its stage model on;
- `VALUE_RUBRIC_VERSION = "1"`, stamped on every verdict so telemetry can tell rubric eras apart
  (`NATIVE_EDITOR_RUBRIC_VERSION` precedent, `language-gate.ts:621`).

### 5.2 THE RUBRIC IN FULL

`buildValueSystemPrompt()`, verbatim:

> You are a practitioner in this client's field, scrolling. You are handed the account owner's Client Brief,
> the fact cards this post was built from, and one finished Instagram post: its caption and every slide's
> headline and body.
>
> You are NOT scoring how good it is. You are answering four yes-or-no questions, and for each one you must
> either QUOTE the words in the post that make the answer yes, or say what to write instead. A question you
> cannot quote an answer for is not a yes.
>
> **1. newFact — is there something here a practitioner in this field did not already know?**
> A yes needs a named, checkable specific: a figure with its unit and its period, a named product, company,
> standard, law, price or version, a dated event. A category noun is not a specific ("productivity tools",
> "modern platforms", "the industry"). A fact that any practitioner already knows is not a yes even if it is
> true and well sourced.
> Quote the specific. If there is none, name the fact card that carries one and say which slide should carry
> it.
>
> **2. position — does this post take a side someone could argue with?**
> A yes needs a sentence, on the cover or in the caption's first line, that a competent person in this field
> could disagree with. "X is not the reason Y happens" is a position. "X is an important consideration" is not.
> A statement that is true of every business in this industry is not a position, it is a description.
> Quote the sentence. If there is none, write the position this post's own evidence would support, in one
> sentence.
>
> **3. payload — is there something here a reader would keep?**
> A yes needs two things. First, a structure a reader could come back to: a glossary, a ranking, a comparison,
> a checklist, a walkthrough, a myth corrected, a teardown. Second, slides that each carry ONE claim and say
> what follows from it for the reader. A carousel of six true statements with no consequence attached is not a
> payload.
> Quote the one slide whose body best shows the claim plus its consequence. If no slide does, name the slide
> that comes closest and write its missing consequence.
>
> **4. action — is there a specific thing the reader can do next?**
> A yes needs an action the reader can take with what they already have, named precisely enough to start today,
> and worded so it asks for something specific rather than hoping for engagement. "Comment below" and
> "thoughts?" are not actions. "Check which of the three your current contract uses, and reply with the number
> if you want the comparison sheet" is.
> Quote the action. If there is none, write one this post has earned.
>
> Answer each question with exactly one of: pass, weak, fail.
> - pass: you quoted it and the quote satisfies the test.
> - weak: something is there but it does not meet the test as written.
> - fail: nothing in the post answers the question.
>
> Every quote must be copied from the post EXACTLY, character for character. Do not tidy it, do not translate
> it, do not shorten it. A quote that is not in the post is treated as no quote at all.
> Every weak and every fail must carry a fix: which axis, which target (`cover`, `caption`, or `slide:N`), and
> one imperative sentence naming what to write instead. A weak or a fail with no fix is discarded and the axis
> is treated as a pass, so do not raise a problem you cannot say the remedy for.
> Judge only these four questions. Not grammar, not fluency, not whether the post is on-brief, not whether the
> facts are true, not whether you like it. Those have their own checks and their own remedies.
> The post may be written in Hebrew, Arabic or another language. Judge it in the language it is written, and
> quote in that language.
>
> Finally, write `keepLine`: one sentence naming what a reader would save this post for. If you cannot write
> that sentence honestly, say so in it.

**Four axes, not six.** A sixth "does it use its own words" axis and a separate "so what" axis were both
considered and rejected: the first is the free 8-gram check (§4.1 #1) and the second is the `payload` axis's
second half. Paying a model for what a regex already decided is the one thing this budget cannot afford.

### 5.3 The output contract

Twelve flat fields, `RELEVANCE_OUTPUT_FIELDS` style:

| field | type | note |
|---|---|---|
| `newFact`, `position`, `payload`, `action` | string × 4 | `"pass" \| "weak" \| "fail"`; anything else is an **error** verdict, never clamped (`relevance-gate.ts:265-271`) |
| `newFactQuote`, `positionQuote`, `payloadQuote`, `actionQuote` | string × 4, optional | required when that axis is `pass` |
| `fixAxes`, `fixTargets`, `fixInstructions` | `string[]` × 3 | index-aligned; `fixInstructions[i]` ≤ 240 chars |
| `keepLine` | string | ≤ 160 |

Three parallel arrays rather than an `object[]` because the flat DSL has no `object[]`. **Misalignment is not
trusted**: an index whose `fixAxes[i]` is not one of the four names, or names an axis that came back `pass`, or
whose `fixTargets[i]` does not match `^(cover|caption|slide:[1-8])$`, is **discarded** — and a discarded fix
leaves its axis with no fix, which §5.4 rule 2 then acts on.

### 5.4 `normaliseValueVerdict(raw, draftText)` — pure, in code, tested

1. **Span rule.** For each `pass` axis, the quote must occur in the draft after normalising whitespace. A quote
   that does not occur downgrades the axis `pass -> weak`. **Not to `fail`**: one paraphrased quote is a model
   tidying whitespace; two are a judge inventing, and two weaks already refuse (§5.5).
2. **Fix rule** (Phase 4's, `language-gate.ts:723-736`). A `weak` or `fail` axis with no surviving fix is **set
   back to `pass`**, and the bar is recomputed. "Report without proposing" is structurally unrepresentable.
3. **Relaxation rule.** `newFact` is demoted to advisory — recorded, excluded from the decision — when
   `isThinlyGrounded(brief)` is true (`client-brief.ts:371`) **or** the run's deduped fact cards contain fewer
   than two cards carrying a number or a proper noun. Recorded on the verdict, on the gate payload and as a
   ledger warn, exactly like `relevanceThinGroundingEvent` (`relevance-gate.ts:306`). Without this, a client
   whose research returned four definitions fails an axis no redraft can answer, three times, and Phase 5 has
   reinvented the unwinnable floor Phase 0 already had to correct.
4. **The `07i1` cap.** A `not-found-on-page` lead claim caps `newFact` at `weak` for this attempt.

**The draft text the span rule tests against is the model's own bytes.** Phase 4's isolates never enter it
(§6.5), so no stripping step is needed and none is written — an exact substring test is the whole rule.

### 5.5 THE BAR

```ts
export const VALUE_AXES = ["newFact", "position", "payload", "action"] as const;
export const VALUE_WEAK_FAIL_COUNT = 2;   // two weaks refuse; one does not

export function decideValue(axes: ValueAxes, advisory: readonly ValueAxis[] = []): boolean {
  const scored = VALUE_AXES.filter((a) => !advisory.includes(a)).map((a) => axes[a]);
  if (scored.includes("fail")) return false;                                  // (1) any fail refuses alone
  if (axes.newFact === "weak" && axes.position === "weak") return false;      // (2) the audit's charge
  return scored.filter((v) => v === "weak").length < VALUE_WEAK_FAIL_COUNT;   // (3) two weaks refuse
}
```

**Clause (2) is the audit's charge in one line.** A post that is accurate, on-brief, fluent, tells the reader
nothing they did not know and takes no position is precisely the post every existing gate passes. It is worth a
clause of its own because it is the exact shape this phase was commissioned to refuse, and without it that
shape scores two weaks in a world where the threshold might one day be relaxed to three.

**A real threshold with a real other side**, three clauses, each tested on both sides: one weak passes, two do
not; one `fail` is enough alone; `newFact:weak + position:weak` refuses where `payload:weak + action:weak`
would too but for a different reason a different test pins. Flip `VALUE_WEAK_FAIL_COUNT` to 3 and the two-weak
case goes green. Delete clause (2) and the weak/weak case goes green. That is how those tests are known to be
able to fail.

There is deliberately **no `keepable: boolean` field in the output contract at all.** The bar is computed here,
never requested.

### 5.6 Worked examples

Client: a servicer of commercial kitchen equipment for independent restaurants — a neutral trade chosen on
purpose, per the ground-truth discipline. Target language English. `payloadKind: "comparison"`, 6 slides.

**A PASS.**
- cover: *"Your walk-in is not dying of old age. It is dying of a dirty condenser coil."*
- slide 3 body: *"A coil cleaned quarterly draws about 12 percent less power than one cleaned once a year. On a
  2 HP compressor that is roughly 40 dollars a month you are paying to keep dust warm."*
- caption CTA: *"Open the panel, take a photo of your coil, and reply with it. I will tell you whether it needs
  a clean this month or in six."*

All four axes `pass`, all four spans occur in the draft, zero weaks → keepable.
`keepLine`: *"A restaurant owner would keep this to decide whether the quarterly service contract is worth its
price."*

Note what the CTA does **not** say. `gate.lintPost`'s bank contains "comment below", "thoughts?", "agree?".
This design does not carve a hole in that bank. The bank bans the *lazy* forms of an ask; the `action` axis
demands the *engineered* form; **they agree.** The owner's comment-gated reference post (180 comments against
368 likes) worked because it named a keyword and what the reader got, and that wording passes the bank
untouched.

**A REFUSAL** — a draft that passes every gate that exists today: grounded, on-brief, fluent, correctly
sourced, clean typography.

- cover: *"Preventive maintenance matters more than ever for modern kitchens."*
- slide 2 body: *"Regular servicing can help reduce unexpected downtime and extend equipment lifespan."*
- caption CTA: *"Let us know your thoughts."*

```json
{ "newFact": "fail", "position": "fail", "payload": "weak", "action": "fail",
  "fixAxes":        ["newFact",  "position", "payload",  "action"],
  "fixTargets":     ["slide:3",  "cover",    "slide:2",  "caption"],
  "fixInstructions": [
    "Fact card 4 carries the 12 percent figure for quarterly coil cleaning; put that number and its period on slide 3 and drop the general claim.",
    "Assert the cause: name the single failure this client sees most often and say plainly that age is not it.",
    "Slide 2 states a benefit with no consequence; say what the downtime costs on a Friday service, in money or in covers.",
    "Ask for one thing the reader can do in a minute and say what they get back for doing it."
  ],
  "keepLine": "Nothing here is wrong, and nothing here is worth saving: every sentence would be true for any maintenance company in any trade.",
  "rubricVersion": "1" }
```

Three fails → below bar. **This is exactly the post the audit charged nothing was catching: correct, grounded,
fluent, and worthless.** It is now a refusal with four named remedies.

**What goes back** — `valueSteerFor(verdict)`, a **fifth typed steer** `valueSteer` with a one-attempt
lifetime, kept apart from `selfCheckSteer` / `relevanceSteer` / `dedupeRetrySteer` / `nativeSteer`
(`create-instagram-agent-workflow.ts:5229-5243`) so none can overwrite another:

```
The value check returned this draft. Fix these four things and change nothing else.
1. [newFact] slide 3: Fact card 4 carries the 12 percent figure for quarterly coil cleaning; put that
   number and its period on slide 3 and drop the general claim.
2. [position] cover: Assert the cause: name the single failure this client sees most often and say
   plainly that age is not it.
3. [payload] slide 2: Slide 2 states a benefit with no consequence; say what the downtime costs on a
   Friday service, in money or in covers.
4. [action] caption: Ask for one thing the reader can do in a minute and say what they get back for it.
KEEP AS WRITTEN: nothing yet passed.
```

The **`KEEP AS WRITTEN:` line is built in code from the passing axes' VERIFIED quotes, never from the model.**
On a partial refusal it reads e.g. `KEEP AS WRITTEN: "Your walk-in is not dying of old age..." (the position)
and "Open the panel, take a photo..." (the action).` That line is the anti-thrash mechanism: without it, the
classic redraft regression is fixing one axis by destroying another, and after three rounds the post is worse
than attempt 1.

### 5.7 Rounds, stop conditions, and termination by delivery

The value gate adds **no inner rounds of its own.** It rides the existing attempt loop
(`maxAttempts = min(MAX_SELF_CHECK_ATTEMPTS = 3, budgetPlan.maxSelfCheckAttempts)`), which is exactly why §7.3's
lever swap is a precondition and not an optimisation: a plan that buys 2 attempts buys the value gate exactly
one chance to send work back.

Three bounds:

1. **`VALUE_MAX_RETURNS = 2`.** At most two of the run's attempts may be caused by a value refusal, even if a
   future plan allows more attempts.
2. **The no-improvement stop.** `axesImproved(prev, next)` is true only when at least one axis moved up
   (`fail → weak → pass`) and none moved down. If attempt N+1 is not an improvement on attempt N, the loop
   stops returning for value and ships attempt N+1 as `below-bar`, with the reason naming the stall. This saves
   a whole ~$0.26 attempt on the runs where the writer has nothing more to give.
3. **The final attempt never returns.** This is the single most important implementation rule in the PR, and it
   is not politeness: `create-instagram-agent-workflow.ts:7766-7770` throws `WorkflowHeld` when the loop exits
   without `finalOutcomeOk`. **Every `continue` on the last attempt is a hold.** So `07i`, `07i2` and `07j` each
   carry an explicit guard:

```ts
const isFinalAttempt = attempt >= maxAttempts;
if (!signals.ok) {
  if (!isFinalAttempt) { returnToCopyWith(signals.reason); continue; }
  valueVerdict = { status: "below-bar", stage: "signals", reason: signals.reason, ... };
  // fall through: the draft ships, marked, with a reason a human can read
}
```

**Termination table. `value.status` is always one of these; there is no `held` and no `failed`, by design.**

| # | Condition | Step | Outcome | `value.status` | Ledger |
|---|---|---|---|---|---|
| 1 | free floor refuses, attempt remains | `07i`/`07i2` | return to 05 with the reason, **$0** | (in flight) | none |
| 2 | free floor refuses, **final attempt** | `07i`/`07i2` | **SHIP**, marked with the named span/slide | `below-bar` (stage `signals`) | warn |
| 3 | judge did not complete, or returned an axis outside `{pass,weak,fail}` | `07j` | **SHIP** unjudged, no redraft burned — **fails OPEN**, like relevance | `unjudged` | warn |
| 4 | below bar, attempt remains, returns remaining | `07j` | `valueSteer` + return to 05 | (in flight) | none |
| 5 | below bar, no axis improved on the previous attempt | `07j` | **SHIP** marked; the next attempt is not bought | `below-bar` (`no-improvement`) | warn |
| 6 | below bar, **final attempt** | `07j` | **SHIP** marked; axes + fixes on the `09a` payload so the reviewer sees exactly why | `below-bar` | warn |
| 7 | `meter.posture === "cheapest-path"` | `07j` | judge skipped, **SHIP** | `unjudged` (budget) | warn |
| 8 | pass, `newFact` relaxed for thin grounding | `07j` | **SHIP** | `keepable` + `note` | warn |
| 9 | pass | `07j` | **SHIP** | `keepable` | none |

**`WorkflowHeld` is never thrown on any value path**, stated in the module header the way `:6663-6666` states it
for language.

**The judge fails OPEN, unlike language's fail-closed.** Deliberate, and it is the relevance judge's posture
(`relevance-gate.ts:71-79`) for the same reason: the subject of this verdict is *visible to the human reviewer
at `09a`*. A Hebrew fluency failure is invisible to a reviewer who does not read Hebrew — that is why `07f`
fails closed. "This post is boring" is not invisible to anybody.

Degrade markers are attempt-scoped and reset per attempt, exactly as `languageDegraded` and `interestDegraded`
are, so an attempt that was fixed never ships reported as degraded. Exactly one ledger warn per degraded
delivery, keyed `${wf.runId}__value-${status}-r${revision}`, so a resume writes one row.

### 5.8 What reaches the reviewer

`DraftResult.value`, mirroring `DraftResult.language` (`:4603-4612`), routed to both the `09a` gate payload and
the `09b` deliverable through the one shared `groundingFor(draft)` (`:7830-7863`):

```ts
value?: {
  status: "keepable" | "below-bar" | "unjudged";
  axes: { newFact: string; position: string; payload: string; action: string };
  advisoryAxes?: string[];           // relaxed for thin grounding
  returns: 0 | 1 | 2;
  keepLine?: string;
  fixes?: Array<{ axis: string; target: string; instruction: string }>;   // present when below-bar
  leadClaim?: "confirmed" | "not-found-on-page" | "unreachable" | "no-url";
  rubricVersion: string;
  reason?: string;
};
```

`RunBudgetRunRecord` gains an optional `value?: { status, axes, returns }` beside the existing `language?`
(`run-budget.ts:827-831`), so a later run can read whether the bet paid. That is the gap RFC-15 §9.4 called out
about its own phase, closed here for this one.

### 5.9 Proving the bar is reachable — required before merge

A rubric nobody has calibrated is a coin flip with a schema. **Pre-merge calibration, recorded in the PR body
verbatim:**

Run `07j`'s judge offline against the last six shipped prep deliverables (three Hebrew, three English, pulled
from the ledger) plus the two posts the 2026-09-08 audit criticised. Eight judge calls at $0.003 = **$0.024
total.**

Acceptance, stated in advance so the result cannot be rationalised afterwards:

- the two audited posts must come back **below bar** — if they pass, the rubric does not implement the charge;
- at least two of the six shipped posts must come back **keepable** — if none do, the bar is unwinnable and the
  phase ships a permanent degrade;
- **if all eight pass, the bar is decoration and the PR does not merge.**

## 6. The whole post

### 6.1 One step, once per revision

**`08c-package-post`** — an agent step, **revision-scoped** (`rev(...)`, not attempt-scoped), placed after the
drafting loop breaks and before `09a-batch-review`. `InstagramPostPackagerAgent extends BaseAgent<PostPackage>`
— a `BaseAgent`, not a `DynamicAgent`, because alt text is per-slide and `object[]` is not expressible in the
flat DSL (`instagram-native-editor-agent.ts:11-22`). Prompt `instagram-post-package@1`, a new registry entry.
`allowedTools: []`, `maxSteps: 1`, **pinned `gemini-2.5-flash`**.

```ts
export const PostPackageSchema = z.object({
  hashtags: z.array(z.string().min(2).max(40)).min(3).max(5),    // BARE — no leading "#"
  altText: z.array(z.object({ n: z.number().int().min(1).max(8), alt: z.string().min(1).max(125) })).min(1).max(8),
  firstCommentText: z.string().min(1).max(600),                  // prose only — the model never writes a URL
});
```

Inputs: the **approved, language-corrected** copy, `briefForPrompt(brief)`, the register card (for
`hashtagsPerPost`), `languageBrief.terms`, `factCardsForPrompt(...)`, and the shipped slides'
`sourceRef → fact card` mapping.

**Fail-open, whole.** Every field is additive; a packager that does not complete leaves `post: undefined`,
writes one ledger warn, notes it on the gate payload, and the carousel ships exactly as it does today. **There
is no state in which the whole post costs us the post.**

**Why the packager and not the writer.** Authoring these fields at `05` would cost roughly +520 output tokens
on *every attempt* — ~$0.008 × 3 = $0.023 a run, most of it spent on drafts that get thrown away. One Flash
call after the loop costs $0.003, once. That is 8× cheaper and it is also more correct: alt text for a slide a
redraft is about to replace is money burned.

### 6.2 The caption stays where it is

Authored at `05`, one string, restructured by prompt §2 into hook / body / CTA. Not moved into the packager:
it is the prose the angle's `rememberLine` lands in, it is read by the relevance judge, craft hygiene and the
native editor, and `interest-relayout.ts` appends to it. Moving it would take the post's main prose *out* of
every gate that currently reads it.

### 6.3 Hashtags, and the Hebrew decision made deliberately

Stored **bare, with no `#`** — the portal prepends its own (`asset-card.tsx:635`,
`copy-caption-button.tsx:24`). LinkedIn's own fixture at `materialize.test.ts:278` stores tags *with* the hash
and therefore double-hashes them in the UI today. **Do not copy that.**

**Derivation, not invention**: drawn from `brief.coreTerms` (1-20, already "lowercase, no hashtags"),
`brief.icp.industries` and `brief.offers`. At least one must be a `coreTerm` — enforced by `08c1`, not
requested. **Never derived from the reference accounts' subject matter**; that is the original audit failure
with a `#` in front of it.

The empirical basis already exists in the repo and is not a guess. `language-register.ts:128` measures
`hashtagsPerPost` **from the client's own recent posts**, counted at `:614` with
`/(?:^|\s)#[\p{L}\p{N}_]+/gu` — a Unicode-property regex that already matches Hebrew tags — and renders it into
the register card at `:869` as `"no hashtags"` or `"N hashtags a post"`.

Five decisions:

1. **Hashtags are always authored, 3 to 5.** The prompt's escape hatch at `latest.md:53` ("unless the client's
   own style config asks") points at a field that **does not exist anywhere in `karos-client`**, so it has
   never once fired. It is deleted rather than kept as decoration.
2. **The measured count decides PLACEMENT, not existence.** `hashtagsPerPost === 0` → `hashtagPlacement:
   "firstComment"`; `>= 1` → `"caption"`. Deterministic, in `08c1`. A client whose own feed never uses hashtags
   does not suddenly acquire a tag block under their caption, and the data still exists for the portal's chip
   row and its Copy button. **That is the honest use of the measurement: it tells you what this client actually
   does.**
3. **Tags are written in the target language and script by default.** Hebrew hashtags work on Instagram, and an
   Israeli account tagging in English reads as a foreign account. A Hebrew audience does not search in English,
   and a tag nobody searches is decoration.
4. **A Latin-script tag is allowed only** when the term is on `languageBrief.terms.allowedLatinTerms` — the
   same per-client list that already governs which English words stay English in prose — or is on
   `brief.coreTerms`, or is a product/company proper noun with no Hebrew form. **Maximum 2 of 5.** This reuses
   an artifact that already exists per client instead of inventing a global policy. No transliterating a Latin
   brand into Hebrew letters, and no translating a Hebrew term into English "for reach".
5. **Grammar**: `/^[\p{L}\p{N}_]{2,40}$/u` — no `#`, no spaces, no punctuation, **no nikud** (a nikud'd tag is
   a different string from the one anyone searches, and `gate.nativeLanguage` already treats nikud as a finding
   in prose), no duplicates after case folding, **no tag mixing scripts within itself**. A multiword Hebrew
   concept is concatenated, which is what the platform's tag grammar forces and what Israeli accounts do.

**Hashtags are not sent to the native judge.** Phase 4's correction contract is span-based (`span` 1-240, an
exact substring, `language-gate.ts:645-663`), and a one-word tag has no span to anchor a correction into; a
judge asked about tags would produce findings `normaliseNativeEditorVerdict` and the patcher would then discard
anyway. The script and composition rules above are deterministic and free, which is the correct instrument.

### 6.4 Alt text, first comment, timing

**Alt text** — one entry per slide, ≤ 125 characters, in the target language. It **describes the slide** —
what the picture shows and what the plate says — it is not a transcript; the caption carries the content, and
the field is read aloud. Authored rather than derived, because the deterministic alternative leaks English:
`visualNeed.scene` is an English stock-photo query and is excluded from every language gate for exactly that
reason. It must not open with "Image of" / "A picture of" / "תמונה של", must not be string-equal to the
headline, and must carry no URL and no `#`.

**First comment** —

```ts
firstComment: { text: string; sources: Array<{ label: string; url: string }> }
```

**`text` is written by the model. `sources` is built by CODE**, from the fact cards the shipped slides'
`sourceRef`s trace to — a mapping `checkSlidesData` already computes — deduped by URL, capped at 4,
`label = "<source>, <date>"`. **An invented URL is therefore structurally unrepresentable, not merely
forbidden** — the same move Phase 4 made when it put `sourceRef`, `stat.figure` and every `source` out of reach
of the correction schema. `fact-cards.ts:241` already ranks cards by whether they carry a URL, and
`dedupeFactCards`'s output is in scope at `09b` (`:7877`), where today the deliverable persists **only counts**
(`evidenceNotesForGate`, `:7872-7878`) and throws the URLs away. The first comment is where a carousel's
sourcing finally becomes visible to a reader.

**Suggested publishing time: deliberately NOT authored as a timestamp.** The portal already computes one and
computes it better — `PLATFORM_SCHEDULES.instagram` (two weekday windows, 11:00 and 14:00),
`recommendPublishTimeWithDensity` respecting `MAX_PER_DAY = 1` and a 90-minute gap against the client's
*booked* assets, already applied to every agent-engine asset at `materialize.ts:993`. The engine cannot see
that calendar. An engine-authored timestamp would be a worse number competing with a better one.

What the engine alone knows is **perishability**. `08c3-timing-note`, `wf.step.code`, **$0, no model**:

```ts
timing: { basis: "event-dated" | "evergreen"; staleAfter?: string; reason: string }
```

A post resting on a fact card dated within 7 days gets `{ basis: "event-dated", staleAfter: date + 72h,
reason: "rests on <source>, <date>; the hook goes stale after that" }`; otherwise `{ basis: "evergreen",
reason: "no dated claim — no timing constraint" }`. The portal keeps owning the slot; this tells it the one
thing it could not compute. **This is a partial decline of plan item 3, listed as such in §9.**

### 6.5 Where the whole post is checked — and the bidi decision

**`08c1-package-checks`** (code, **free**): the hashtag grammar and script rules of §6.3; the alt-text rules of
§6.4; `gate.nativeLanguage` over every package prose field (per-field script coverage, transliterations, nikud,
foreign digits, curly quotes, bidi control characters — all of which apply to a Hebrew alt text exactly as they
apply to a headline); and `gate.lintPost` over `firstCommentText` and the alt texts **as `parts`**. All free,
all `content_fail` → **one** re-ask of the packager under `08c-package-post-retry` — a **distinct id**, because
`step.agent` replays a checkpointed `content_fail` and a re-call under the same id returns the first failure
without touching the model (`language-gate.ts:565-572`) — then ship whatever survives with the failing field
dropped.

**`08c2-package-native-round`** (agent, **non-English clients only, one round, $0.009**): reuses
`runNativeEditor` / `InstagramNativeEditorAgent` unchanged and **without the few-shot exemplars** — they are the
post's *voice*, and alt text and a sources line are utility prose — then applies its corrections through
`applyNativeCorrections`. This honours the owner's binding rule that every prose field added here passes Phase
4's native judge, at **two thirds of a full judge round**. There is no round 2 and no redraft: corrections apply
or are dropped by the patcher's four existing refusal rules, and the package ships.

This widens **one shared vocabulary**, in this package's own files:

- `language-gate.ts:647` target regex `^(caption|slide:[1-8])$` → `^(caption|comment|alt:[1-8]|slide:[1-8])$`,
  and the field enum gains `"comment" | "alt"`.
- `native-corrections.ts`'s `resolveField` gains two branches, and — **the guard that matters** — **rejects a
  `comment`/`alt` target on a carousel round and a `caption`/`headline`/`slide` target on a package round**, in
  the same idiom as the existing "a caption correction named the field X" rejections. One vocabulary, two
  contexts, neither able to reach into the other.
- The patcher's four refusal rules apply unchanged. Rule 3 (a replacement that breaks the field's schema cap is
  dropped) now guards alt text's 125-char cap, and rule 4's structural guarantee is preserved with
  `firstComment.sources[].url` **added to the unreachable set**. A language correction may never change a URL.

`NATIVE_EDITOR_RUBRIC_VERSION` `"1"` → **`"2"`**: the axes are unchanged but the correction target vocabulary
is, and telemetry that cannot tell those eras apart will mis-attribute a correction-rate change to the model.

**THE BIDI DECISION: none of the new fields is bidi-isolated, and that is not an oversight.**
`isolateForeignRuns`'s own caller contract (`bidi-isolate.ts:113-123`) says it verbatim: *"this is applied to
RENDERED SLIDE TEXT ONLY, at composition time, and never to anything a gate reads or anything that is published
as text (the caption, `sourceRef`, `checkCraftHygiene`'s input, the dedupe corpus, the language judge's
fields)."* Hashtags, alt text and the first comment are **all published as text**. Adding FSI/PDI to a hashtag
would change the string the platform indexes, and adding it to alt text would put invisible control characters
into a screen reader's input. **Phase 4's isolation is not extended and not weakened; its scope is exactly
correct as written, and Phase 5 respects it.**

### 6.6 Where it is stored

`ledger.writeDeliverable`'s `deliverable` is `z.unknown()` (`write-deliverable.ts:12`) — no tool version bump,
no schema in the way. `09b` gains, beside `caption` and `slides`:

```ts
post: {
  hashtags: string[]; hashtagPlacement: "caption" | "firstComment";
  altText: Array<{ n: number; alt: string }>;
  firstComment: { text: string; sources: Array<{ label: string; url: string }> };
  timing: { basis: "event-dated" | "evergreen"; staleAfter?: string; reason: string };
  language?: <the package's native verdict>;
  status: "complete" | "partial" | "absent";
}
```

and the same object rides the `09a-batch-review` payload, so the reviewer approves **the post**, not the
pixels.

## 7. Cost — the arithmetic, and the one lever change that is a precondition

Rates (`packages/core/src/telemetry/pricing.ts:49,65,66`): `sonnet-4-6` $3 / $15 per 1M; `gemini-2.5-flash`
$0.30 / $2.50; `gemini-2.5-pro` $1.25 / $10.

### 7.1 New and re-priced `STEP_COST_ESTIMATES_USD` keys

| key | model | arithmetic | value |
|---|---|---|---|
| `copyAttempt` **re-priced** | sonnet-4-6 | **input** +6,000 chars ≈ +1,500 tok @ $3/1M = **+$0.0045**; **output** `payloadKind` ≈ +10 tok @ $15/1M = **+$0.00015**. Total +$0.0047. Input and output stated separately, per the house rule the @13→@14 note exists to enforce. | **0.161 → 0.166** |
| `valueJudge` **new** | gemini-2.5-flash | in: rubric 1,700 + brief 600 + post 1,700 + fact-card digest 800 + scaffolding 300 = 5,100 × $0.30/1M = $0.00153; out: 4 axes + 4 quotes + 3 arrays + keepLine ≈ 500 × $2.50/1M = $0.00125 | **0.003** |
| `postPackage` **new** | gemini-2.5-flash | in: slides 1,700 + caption 300 + brief 600 + register 450 + fact cards 800 + terms 200 + instructions 1,250 = 5,300 × $0.30/1M = $0.00159; out: hashtags 40 + alt 8×45 + comment 120 + scaffolding 40 = 560 × $2.50/1M = $0.0014 | **0.003** |
| `packageNativeJudge` **new** | gemini-2.5-pro | in: rubric 1,500 + register 450 + package 600 + scaffolding 150 (**no few-shot**) = 2,700 × $1.25/1M = $0.00338; out: 6 corrections × 70 + verdict 90 = 510 × $10/1M = $0.0051 | **0.009** |
| `scraperExecution` reused | — | `07i1`, one execution **per run**, priced through a new `RunShape.claimVerifications = 1` | 0.007 |

`rawEstimate`'s `perAttempt` gains `c.valueJudge`; `fixed` gains `c.postPackage`,
`shape.targetLanguage ? c.packageNativeJudge : 0`, and `plan.optionalRevets ? c.scraperExecution : 0`;
`revisionEstimateUsd`'s `perAttempt` gains `c.valueJudge` too.

### 7.2 Per-run delta, 3 attempts, 1 revision

| line | × | English | Hebrew |
|---|---|---|---|
| `copyAttempt` +$0.005 | 3 | +$0.015 | +$0.015 |
| `valueJudge` $0.003 | 3 | +$0.009 | +$0.009 |
| `postPackage` $0.003 | 1 | +$0.003 | +$0.003 |
| `packageNativeJudge` $0.009 | 1 | — | +$0.009 |
| lead-claim verification $0.007 | 1 (per run) | +$0.007 | +$0.007 |
| `07i`, `07i2`, `08c1`, `08c3` | — | $0 | $0 |
| **planner total** | | **+$0.034** | **+$0.043** |

### 7.3 The lever swap — a precondition, not an optimisation

The ladder today (`planRunBudget`, `run-budget.ts:1007-1035`) is: **1.** cap generated images `[4, 2, 0]`;
**2.** trend evidence reduced to the one cached query; **3.** `maxSelfCheckAttempts` 3 → 2; **4.** optional
re-vets off.

`run-budget.ts:182-215` already records the consequence in writing, measured:

> *"A cold HEBREW run sits $0.0002 under target at ladder rung 4 ($0.9998). Adding $0.0045 takes it to $1.0043
> and fires rung 5, the ATTEMPT lever, dropping `maxSelfCheckAttempts` 3 → 2. `language-compliance-gate.test.ts`
> then produces runs with `status: "held"` … including the two cases named 'NEVER holds'. A budget-caused hold
> is forbidden outright by the owner's 2026-09-09 amendment."*

(That comment counts each image step as its own rung; the code has four `if` blocks. The lever it names as
"rung 5" is the `maxSelfCheckAttempts` block, step 3 in the code.)

Phase 5 adds $0.043 to that shape. Under today's ladder the attempt lever fires and **every Hebrew client loses
a drafting attempt — the very attempt the value gate needs in order to be able to send work back.** Phase 5
would ship a gate that, on its most important client segment, can refuse once and never see a second draft.

**Change: swap the last two rungs.** New order:

```
1. generated images 4 → 2 → 0
2. trend evidence reduced to the one cached industry query
3. optional rescue re-vets skipped          <- was 4
4. one return to step 05 instead of two     <- was 3, now last
```

The justification is the owner's own ordering principle applied consistently: **drop optional work before
dropping the thing that makes the post good.** A rescue re-vet is *optional work by its own name*; a drafting
attempt is *the mechanism every quality gate in this workflow returns into*. Cutting attempts to pay for the
value gate would disable the value gate's own retry loop in order to afford the value gate.

It is also worth vastly more money. On a 4-photo shape the rescue line is
`3 × (2 × $0.007 + 2 × $0.006) = $0.078`, and `07i1`'s verification is tied to the same `plan.optionalRevets`
flag so rung 3 switches off **both** rescue paths together: **$0.078 + $0.007 = $0.085 of headroom** before the
attempt lever is ever reached, against the $0.0002 the attempt lever was previously being fired to recover.

**Not changed:** the attempt lever still exists, still floors at 2, and the existing `WorkflowHeld` for genuine
mechanical exhaustion (`07`'s slide check, craft hygiene) stays. What Phase 5 guarantees is narrower and exact:
**no judgment gate — value, relevance, language, numbers — can produce a hold, and no budget lever can create
one by starving the loop.**

### 7.4 Against $1.00 and $1.50

| shape | today | + Phase 5, old ladder | + Phase 5, new ladder | attempts |
|---|---|---|---|---|
| warm English (images 0) | $0.9518 | $0.9858 | **$0.9858** | **3** (rung 3 never fires) |
| cold Hebrew | **$0.9998** | $1.0428 → **attempt lever → held** | $1.0428 − $0.085 = **$0.9578** | **3** |
| typical actual (1 attempt, Hebrew, warm) | ~$0.48 | — | **~$0.52** | — |

**Against the hard max $1.50.** The planned worst case is $0.9858. The meter crosses $1.50 only at a
calibration ratio above ~1.5; at that point `posture === "cheapest-path"` and: the free checks always run; the
value judge is skipped (`status: "unjudged"`, row 7); the lead-claim verification is off; the packager runs and
the native round does not, shipping `post.language = "unverified"`. **Every path delivers. No path in this
phase produces a hold or a failure for money.**

## 8. THE NO-OPUS RECONCILIATION, STATED EXPLICITLY

The plan says the writer "moves to a stronger model" and "gets a limited search tool for verification". The
owner's amendment, set after the plan was written, says **NO OPUS IN A RUN**. Both halves of the plan's
sentence are declined, and here is the whole argument:

**The writer stays on `claude-sonnet-4-6`** — the repo's existing Sonnet-tier copy model, which is already the
strongest model available inside this budget. Opus on the copy step alone is ≈ $0.24 per attempt; across three
attempts that is $0.72 against a $1.00 target, before the post has an image. Across the five
`contentLanguageSensitive` steps it is a ≈ $2.9 run against a $1.50 hard max. Opus is out by owner decision and
would be out on arithmetic anyway.

**The judges go on the commodity tier.** The value judge is `gemini-2.5-flash` at $0.003. Gemini 2.5 Pro would
cost $0.014 an attempt — $0.042 across a three-attempt run — and would buy *taste*. **The evidence-span design
(§1, §5.4) removes the need for taste**: every axis asks the judge to find and quote a span that satisfies a
written test, and code re-checks the span. If rubric-v1 telemetry shows Flash passing drafts the reviewer then
rejects, the escape is one line in `resolveModelPolicy` plus a re-price, and `VALUE_RUBRIC_VERSION` tells us
which era the data came from.

**`contentLanguageSensitive` is deliberately absent on the value judge**, mirroring `instagram-relevance-judge`
(`relevance-gate.ts:244`): `applyClientLanguagePolicy` would otherwise silently re-point it to a
multilingual-strong row and add ~$0.011 to every Hebrew attempt. The judge is never asked to detect a Hebrew
*nuance* — nativeness is `07f`'s job, and its system prompt says so.

**The money goes into the prompt, the rubric and a $0.007 deterministic verification instead.** That is the
reconciliation in one line: *better writing and real verification, bought with prompt and rubric quality rather
than with a bigger model.* Total Phase 5 spend is $0.034-$0.043 a run — about **4 %** of the target — against
the ≈ **72 %** an Opus writer would have cost.

## 9. What Phase 5 deliberately did NOT build

| Not built | Reason |
|---|---|
| **Reels script, Reels cover, Stories teaser (plan item 4)** | Out of this PR, on four grounds in descending order of how much they settle it. **(1)** A Stories teaser needs a 1080×1920 frame; `CanvasSchema` accepts one but every template hard-codes `width:1080px; height:1440px` (`assets/templates/default/cover.html:143`) and `scale` is pinned to 2 with a hard check — and `assets/templates/` is **owned by another worktree right now**. This is not a preference. **(2)** A Reels *video* needs `04h`+`04p`+`05`+`08`+`09`+`10b`+`10d` rebuilt — ~600 lines inlined in tiktok's 2,819-line workflow closure, none of it extracted — and **there is no cross-agent invocation primitive in the repo** (`wiring/workflows.ts:152-183` is a flat `switch (productId)`; one run is one product). Tiktok's own whole-run ceiling is $2.00 against Instagram's $1.50 for a run that has already paid for research, images, render, interest floor, native judge and visual QA. **(3)** The one cheap path ships a defect: a `video.textPlate` cover inherits none of Phase 2/3's template studio, archetypes, interest floor or art direction, and a Reels cover uglier than the carousel's own cover is a defect under the owner's "boring templates are a defect" rule. **(4)** This PR already shifts positional turn fixtures twice and re-prices a shape with $0.0002 of headroom. **Phase 6 shape, named now**: a new `InstagramReelsScriptAgent` **in this package** (not tiktok's — a new input field there means `tiktok-script@10` in another package's prompt directory, a cross-package ownership violation plus a full bump checklist), reusing tiktok's exported `ShortScriptSchema` / `ScriptBeatSchema`, one pinned Sonnet turn, `allowedTools: []`, fed the **value-gate-approved** carousel, ≈ $0.03. The 6-8 slides → 3-5 beats mapping is a selection and a register change, not a transform: a deterministic mapper produces exactly the "LinkedIn post read aloud" tiktok's v9 prompt was rewritten to stop. |
| **A search tool on the writer** | Measured at three extra turns, $0.12-$0.17 and 70-115 s per draft (`tiktok-script-agent.ts:55-61`), and it makes a draft non-deterministic across a resume. Replaced by `07i2` (free) and `07i1` (one deterministic $0.007 re-fetch). §4.2, §4.3. |
| **A `captionParts` schema object** | Would force a **NEEDED FROM** on `interest-relayout.ts`, which is adjacent to the live interest-floor work. The caption's three jobs are enforced by the judge's `position` and `action` axes instead. §3.3. |
| **A `soWhat` field per slide** | Output tokens on every attempt for text that would never render, plus four enumerations to extend. The so-what lives in the body and the judge checks it there. §3.2. |
| **A `gate.valueFloor` tool in `karos-gates`** | One caller, instagram-specific types, a shared-package edit, a `TOOL_VERSION` story during a parallel cycle, and a `KNOWN_GATES`/`createKarosGatesTools()` pair that CI cross-checks. Local module instead, `craft-hygiene.ts` precedent. **No `TOOL_VERSION` is bumped anywhere in this PR.** §4.1. |
| **A carve-out in `lint-post`'s banned-phrase bank** | The bank bans the lazy CTA; the `action` axis demands the engineered one. They agree. No behaviour change, no version bump, no blast radius across the six other agents that depend on it. §3.4, §5.6. |
| **An authored publishing timestamp** | The portal's recommendation is calendar-density-aware and the engine cannot see the calendar. Replaced by a free perishability constraint the portal cannot compute. §6.4. **A partial decline of plan item 3.** |
| **Extending bidi isolation to the new fields** | It would corrupt the string the platform indexes for a hashtag and put control characters into a screen reader's input. `isolateForeignRuns`'s own caller contract already scopes it correctly. §6.5. |
| **A second value round or a value patcher** | A value fix is a rewrite, and a rewrite is what an attempt *is*. Copying Phase 4's patch/re-check machinery would double the mechanism for no additional remedy. |
| **Best-of-N draft selection** | Each attempt re-sources its own images; restoring an earlier attempt's copy would orphan its image selections. `KEEP AS WRITTEN` is the anti-regression mechanism instead, and `value.axes` per attempt is recorded so the next phase can measure whether returns actually improve drafts. |
| **Moving `04h-select-format`** | Editorially right — format should follow the payload — but it shifts positional router turns for a gain `payloadKind` already delivers inside the copy step. §3.7. |
| **A hashtag field in client config** | The escape hatch at `latest.md:53` points at a field that does not exist in `karos-client`, and Phase 5 did not create it. `coreTerms` plus the register card's **measured** `hashtagsPerPost` is better per-client evidence than a config field nobody will fill. §6.3. |
| **Changing `07`/`07b` exhaustion behaviour** | Those free gates still `continue` on the final attempt and therefore still reach `WorkflowHeld` at `:7766`. Pre-existing, out of scope, and named here so it is not mistaken for something Phase 5 introduced. |

## 10. Tests — and the break-the-guard proof for each

Every guard below is written by breaking the code first and watching the test refuse. **Chromium-gated render
tests self-skip in this worktree; PASSED and SKIPPED are reported separately in the PR body**, and nothing in
this phase touches pixels, so a skipped render suite proves nothing either way.

| Guard | The proof it can fail |
|---|---|
| `decideValue` clause (3) | One weak passes, two weaks refuse. Flip `VALUE_WEAK_FAIL_COUNT` to 3 and the two-weak case goes green. |
| `decideValue` clause (1) | A single `fail` with three passes refuses. Delete the clause and it goes green. |
| `decideValue` clause (2) | `newFact:weak + position:weak` refuses where `payload:weak + action:weak` would also refuse but under clause (3); with `VALUE_WEAK_FAIL_COUNT` temporarily 3, only the newFact/position case still refuses. Delete clause (2) and it goes green. |
| Span rule | A verdict whose `positionQuote` is a paraphrase downgrades that axis to `weak`. Delete the substring check and a fabricated quote passes. |
| Fix rule | A verdict with `position: "fail"` and no surviving fix normalises to `pass`. Remove the rule and a fix-less refusal returns a steer with nothing in it. |
| Fix misalignment | A `fixAxes[i]` naming a `pass` axis, and a `fixTargets[i]` of `"slide:9"`, are each discarded. Remove the validation and a garbage fix reaches the steer. |
| **Final attempt never holds** | `maxAttempts = 1` plus a below-bar verdict asserts `status: "completed"` and `value.status === "below-bar"`. Remove the `isFinalAttempt` guard and the workflow throws `WorkflowHeld`. |
| No-improvement stop | Attempt 1 `fail/fail/weak/fail`, attempt 2 identical → exactly two copy turns consumed, not three. Make `axesImproved` return true unconditionally and a third turn is demanded. |
| Judge fails open | A `07j` that does not complete ships with `value.status === "unjudged"`, one ledger warn, and **no redraft burned**. |
| 8-gram source prose | A body copying a card's claim verbatim refuses; changing one interior word passes; a 20-token run inside a labelled `quote_card` passes; `sourceRef` is never inspected. A Hebrew case at **6** tokens asserted separately. |
| Thin-grounding relaxation | A brief with `isThinlyGrounded` and a `fail` on `newFact` alone still passes, with `advisoryAxes: ["newFact"]` and a ledger warn. Remove the relaxation and the thin client fails every attempt. |
| Lead-claim cap | `not-found-on-page` caps a judged `newFact: "pass"` at `weak`. Remove the cap and the unverified figure ships as a pass. |
| Hashtag rules | Each of these fails on its own: a leading `#`; a space; nikud; a duplicate after case folding; three Latin tags out of five for a Hebrew target; a tag mixing scripts within itself; zero `coreTerms` overlap. |
| **First-comment URLs** | The built `sources` are asserted a subset of this run's fact-card URLs, and **the test fails if the builder ever reads the model's output**: a fixture whose packager emits an invented URL must produce a package with that URL nowhere in it. |
| Package language re-entry | A correction targeting `comment` is **rejected on a carousel round**; a correction targeting `caption` is **rejected on a package round**; an alt replacement exceeding 125 chars is dropped. |
| Packager fails open | A packager that does not complete ships `post.status === "absent"`, a completed run, an unchanged carousel and one ledger warn. |
| Budget | `planRunBudget` on the documented cold-Hebrew shape after the Phase-5 re-price returns `maxSelfCheckAttempts === 3` and lists `"optional rescue re-vets skipped"` in `adaptations`. **Revert the rung swap and it goes red at 2.** |

## 11. Found, not fixed — for the PR body

- **The `auto` format rotation is broken at steady state.** `ownShippedCount` comes from
  `ledger.listOutputExcerpts`, whose store is capped at `OUTPUT_HISTORY_LIMIT = 25` with `.slice(-25)`
  (`output-history.ts:16,103`). Once a client's Instagram ledger fills, the count is pinned at 25,
  `25 % 3 === 1`, and `auto` returns `"carousel"` **forever** — and the same counter drives the content-mode
  rotation at `:3410`, so that is pinned too. Outside Phase 5's charge, larger than it looks, and a real defect.
- **`vetCall` is still ~$0.0005 under-priced** relative to its current prompt size, by its own comment's
  admission. §7.3's headroom is what finally makes an honest re-price safe, now that it no longer fires the
  attempt lever. Recommended for the same PR.
- **The attempt lever could produce a held run at all** — the `vetCall` comment's own deeper finding. §7.3
  removes the reachable case; whether attempt exhaustion should *ever* hold is left for the owner.

## 12. Cross-file obligations

**NEEDED FROM `C:\Users\1\Documents\KarosLabs\karosCMO\src\lib\agent-engine\materialize.ts`** (different repo,
a portal PR, not this worktree):

- `InstagramCarouselDeliverable` (`:383-389`) gains `post?: { hashtags, hashtagPlacement, altText, firstComment,
  timing }`.
- `materializeInstagramCarousel`'s `meta` (`:441-449`) emits **`hashtags` bare at the TOP LEVEL of `meta`** —
  `asset-card.tsx:251` and `copy-caption-button.tsx:19-24` read `meta.hashtags` directly and it **may not
  travel inside a nested blob** (the comment at `materialize.ts:293-294` says exactly this for LinkedIn) —
  plus `meta.slides[].alt`, `meta.firstComment` and `meta.timingNote`.
- `meta.slides[].alt` replaces the joined-render-field fallback at `asset-card.tsx:149`'s `alt` attribute, and
  the `alt=""` at `asset-detail-modal.tsx:429`.
- **Do not copy LinkedIn's fixture at `materialize.test.ts:278`**, which stores tags with the `#` and
  double-hashes them in the UI.
- `hashtagPlacement` is advisory until the Copy button reads it (`copy-caption-button.tsx:19-24` appends tags
  to the caption unconditionally today).

Without this, the engine authors hashtags and alt text and the portal still shows none.

**The five-step prompt bump** (`docs/RFC-15-instagram-native-language.md:375-386`), all in one commit, for each
of the two prompts: (1) the versioned file; (2) `latest.md` byte-identical; (3) the `skillRef` in the agent
class; (4) the H1 version line fixed **and** an inline version-ledger paragraph stating **input and output
deltas separately**; (5) `scripts/prompt-registry.ts` `versions` + `latestVersion`; (6)
`STEP_COST_ESTIMATES_USD` re-priced in the same commit. Neither prompt names a `gate.*`, so **`KNOWN_GATES` is
untouched**.

**Turn fixtures.** `TURN_ORDER` becomes `… relevance, valueJudge, nativeEditor, qa, postPackager,
packageNative`. `valueJudge` sits between `relevance` and `nativeEditor` to match execution order; the packager
pair sits **after `qa`**, because `08c*` runs after the attempt loop breaks. `packageNative` is its own key
rather than riding `nativeEditor`'s variadic slot precisely because it is consumed at a different position.

Because the workflow consumes a value turn and a packager turn on **every** run, `standardTurns` emits a
`DEFAULT_VALUE_TURN` (four passes with quotes drawn from the queued copy fixture) and a
`DEFAULT_PACKAGE_TURN` when those keys are absent — otherwise all ~30 files that queue turns positionally
desynchronise by two. Each default is a named exported constant with a comment saying what it means ("absent
means the value judge passed"), and any test that cares passes the key explicitly. `packageNative` stays
optional, exactly as `nativeEditor` is, since it runs on non-English targets only.
