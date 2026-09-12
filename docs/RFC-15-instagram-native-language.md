# RFC-15 — Instagram agent: native language (Phase 4)

Status: implementing (PR-E). Follows RFC-13 (Phase 0/1, merged as #84 and #94) and RFC-14 (Phase 2/3,
merged as #107 and #108). Driven by the owner's original plan, translated from Hebrew:

> **"Hebrew, and any non-English language, as a native language."**

Phases 0–3 answered *"is this Hebrew?"*. Phase 4 answers *"did a Hebrew speaker write this?"* — a different
question with a different failure surface, and the one the 2026-09-08 audit actually opened.

---

# Part 1 — Brief

Worktree: `C:\Users\1\Documents\KarosLabs\agent-engine-instagram`, branch
`feat/instagram-phase4-native-language`, cut from `origin/main` at `d880358`. Never touch
`C:\Users\1\Documents\KarosLabs\agent-engine` or any other `agent-engine-*` worktree. Files are CRLF; use
Edit/Write, Python writes need `newline=""`.

Read `docs/RFC-13-instagram-grounding-and-topics.md` and `docs/RFC-14-instagram-visual-layer.md` on main for
what Phases 0–3 built and the conventions in force.

## The owner's plan, verbatim (translated)

1. **A writer in the target language** with the persona of a niche editor ("an editor at Geektime"), register
   guidance for the language (register level, which transliterations are allowed, when a term stays in English,
   quotation marks, numerals), and **few-shot from the client's REAL posts** in that language.
2. **A native judge on a strong model**: flags sentences that sound translated, grammar errors, and terms
   nobody actually says, and returns them to the writer **with proposed corrections**. Two rounds.
3. **Script typography**: fonts (Phase 0 built these), size scale, line-height, alignment, and bidi for Latin
   terms embedded in Hebrew, plus a pixel render check that text is not clipped.
4. **Target language resolved from the profile**, not only from `brand.language` (which was null for
   karoslabs).

The plan also names a tool: `gate.nativeLanguage` — a judge with a rubric and examples that **returns to
writing** rather than only reporting.

## Binding owner decisions (these override the plan where they conflict)

- **Run cost: target $1.00, hard max $1.50. NO OPUS IN A RUN.** The plan says the native judge runs on "a
  strong model"; within this budget that means the catalog's one non-premium `multilingual-strong` row, not
  Opus. **Every new model step justifies its cost in a comment next to it.**
- **BUDGETS ADAPT, NEVER HOLD.** Estimate before the first paid call; adapt the plan to fit; past target stop
  optional work; past the hard max finish on the cheapest complete path and **DELIVER**. Status `completed`,
  at worst `degraded` with a reason. **Never `held`/`failed` for budget.** This reaches the judge loop: the
  plan's "two rounds before hold" is reconciled as **two rounds then deliver the best version, degraded with a
  reason, never a hold.**
- **Harvesting is ScrappyCoco only** (`packages/tools/karos-scraper`). No Apify, no new vendor.
  `research.socialHistory` works and returns real posts.
- **Engine-native**: agents via `wf.step.agent` (`BaseAgent`), typed zod tools under `packages/tools/*`,
  deterministic orchestration in `wf.step.code`.
- **Hebrew is a first-class target language** (client `geektime`). Anything visual must hold in RTL and in the
  script fonts Phase 0 added (`src/workflow/script-fonts.ts`).

## Standing engine conventions that bite

- A prompt bump is a **five-step checklist** and `scripts/prompt-registry.ts` must be updated in the same
  commit, or CI fails. `run-budget.ts` re-pricing is a sixth step the file's own header mandates.
- New workflow step ids mean `agent-middleware/scripts/generate_engine_stages.py --check` must be re-run
  **after merge** — note it in the PR body, do not run it here.
- Chromium-gated render tests **self-skip on this machine**. A green local run can mean "skipped", not
  "passed" — always report **passed vs skipped separately**. CI has real Chromium and is the authoritative
  gate. When a synthetic image is needed, use the shared `__tests__/synthetic-photograph.ts` **at the design
  canvas size 1080×1440**; a private copy at 270×360 upscaled 8× is what produced the last false CI failure.
- **Never relax a threshold to make something green.** A template that fails a floor is a bug in the template.
- **Do not write a test that cannot fail.** Break the code and watch the guard refuse before trusting it.

---

# Part 2 — Technical spec

Lead architect's adjudication of two independent Phase 4 designs (`design-p4-A.md`, minimal-seam;
`design-p4-B.md`, native-first), verified against the worktree at `d880358`.

**Spine: design B.** Its thesis — that nativeness has six *named* failure modes, of which four are
mechanically decidable and free, and only two need a paid judge — is what makes the budget work. Design A's
discipline is grafted on wherever it removes a seam B added without earning it.

## 0. What I verified, and where each design was wrong

| # | Claim under test | Verdict | Evidence |
|---|---|---|---|
| 1 | The Opus trap is live | **TRUE — both right.** `applyClientLanguagePolicy` re-points any `contentLanguageSensitive` step to the cheapest same-vendor `multilingual-strong` row. In the Anthropic catalog those are **only** `claude-opus-4-8` and `claude-opus-4-7`, both `costTier: "premium"`. Five Instagram steps opt in on a pinned Sonnet. It has not fired only because `loadClientContentLanguage` reads `client/brand.json`'s `language` and nothing else — null for exactly the clients this phase targets. | `client-model-policy.ts:223-244`, `:91-106`; `model-capabilities.ts:105-126` |
| 2 | **A's `corrections` output field** — `{ name: "corrections", type: "object[]" }` on `LANGUAGE_FLUENCY_OUTPUT_FIELDS` | **FALSE — A's judge cannot compile.** `AgentDefinitionFieldSchema.type` is `z.enum(["string","number","boolean","string[]"])`. There is no `object[]`, and `buildOutputSchema` has no branch for one. The field DSL is documented as deliberately small. **A correction with an anchor, a replacement, an axis and a severity is not expressible in it.** This single fact decides the judge's shape: it must be a real `BaseAgent` subclass with a zod `outputSchema`, which is B's design. | `packages/core/src/agent-definitions/types.ts:16-47` |
| 3 | `gemini-2.5-pro` is the only non-premium `multilingual-strong` row | **TRUE — B right.** `languageStrength: "multilingual-strong"`, `rtlSupport: "strong"`, `costTier: "standard"`, priced $1.25/$10. `claude-sonnet-4-6` is rated **`strong`**, not multilingual-strong — by the engine's own authority Sonnet does not meet the plan's requirement. A's Sonnet judge is a compromise the catalog does not endorse; B's Gemini judge is the catalog's own answer. | `model-capabilities.ts:129`, `:205-214`; `pricing.ts:47-66` |
| 4 | Tool-registry count after `gate.nativeLanguage` | **BOTH WRONG.** A said nothing; B said "64 after PR-D, read it first". The snapshot asserts **62**. Phase 4 adds one tool → **63**. B's instinct ("read the snapshot before asserting the number") was right and its number was not. | `packages/tools/__tests__/cross-cutting.test.ts:124` |
| 5 | Letter-spacing is wrong for Hebrew on every bundled template | **TRUE — B right, A missed it entirely.** `-0.02em`/`-0.04em`/`-0.018em`/`-0.012em`/`-0.008em` on display roles; `+0.22em`/`+0.24em`/`+0.16em`/`+0.14em` on eyebrows and kickers. Negative tracking collides Hebrew's final letters (ך ן ף ץ) with the next word; positive tracking shreds a Hebrew word — Hebrew does not track. Verified across all eight templates. | `cover.html:508,525`; `headline-focus.html:407,478,498`; `closer.html:237,333,410`; `quote-card.html:236`; `list-takeaway.html:220`; `comparison-card.html:120` |
| 6 | `lang="en"` hardcoded on all eight templates | **TRUE — both right.** `<html lang="en" dir="{{dir}}">`. A Hebrew document declaring `lang="en"` gets Latin font fallback for an unmapped glyph. | `assets/templates/default/*.html:2` |
| 7 | Alignment needs no new control | **TRUE — both right.** `textAlign` defaults to `"start"`, templates declare only `ta-center`/`ta-end`, and `start` under `dir="rtl"` is already the right edge. Phase 4 **pins** it rather than changing it. | `slides-data.ts:942-946`; `slide.html:74-75` |
| 8 | Per-field script coverage is missing | **TRUE — A right, and it is a live defect.** `checkExpectedScript` measures one concatenated blob against `MIN_EXPECTED_SCRIPT_RATIO = 0.3`. A carousel with two of eight slides in English and six in Hebrew measures ~0.75 aggregate and **passes**. | `language-gate.ts:228`, `:284-291` |
| 9 | Device labels are rendered but never judged | **TRUE — both right.** `languageGateText` covers caption/headline/body/kicker/custom fields. `slide.device` labels are in `collectSlideText` for direction detection and in no gate. | `language-gate.ts:284-291`; `slides-data.ts:451-452` |
| 10 | A `ClientBriefSchema` bump is safe if every field is optional (B) | **TRUE but unjustified — A right on the merits.** `client.getBrief` returns `not_available` for a brief that fails to parse, so optional-and-defaulted is genuinely safe. But the register content B wants the brief agent to produce is **the same for every Hebrew client**: it belongs in a static pack keyed by script, not in a per-client model-written field. **No `instagram-brief` bump.** Saves $0.005/run and an entire prompt-bump checklist. | `brief.ts:138-141`, `:207-215` |
| 11 | `04e` passes no `window`, so it defaults to `6h` while every other caller passes `24h` | **TRUE — B right.** Same cache key, different freshness bar: a 7-hour-old entry is a miss for `04e` and a hit for `00b1`/`03e`/`00c2`. And `04e` bills ScrappyCoco with no `spend(...)` line anywhere. | `cross-channel-history.ts:141`; `social-history.ts:32` |
| 12 | `04l` supersedes a `buildClientVoiceContext` patch (A) | **TRUE — A right.** `buildClientVoiceContext` emits its `LANGUAGE REQUIREMENT` line only from `brand.language`. `04l` emits it from the **resolved** language, which is a strict superset, for exactly the null-`brand.language` clients a patch would have helped. Patching a shared primitive to change every agent's prompt block, to solve an Instagram problem `04l` already solves, is blast radius for nothing. | `client-voice-context.ts:40-45` |

### Where they disagreed, and the decision

| # | Disagreement | Decision | Why, in one line |
|---|---|---|---|
| 1 | Opus trap: delete the five `contentLanguageSensitive` flags (A) vs cap the re-point's cost tier in core (B) | **B, and keep the flags** | The owner's no-Opus rule is global, so deleting one agent's flags fixes one agent and leaves the trap armed everywhere else, while one capping constant fixes it repo-wide with a single named blast radius. |
| 2 | Judge model: `claude-sonnet-4-6` (A) vs `gemini-2.5-pro` (B) | **B** | The engine's own catalog rates Sonnet `strong`, not `multilingual-strong`; Gemini 2.5 Pro is the only non-premium row that meets the plan's "strong model", and it is cheaper per input token than Sonnet. |
| 3 | Judge shape: `DynamicAgent` + field DSL (A) vs a real `BaseAgent` class + zod (B) | **B** | The field DSL has no `object[]`; A's correction contract does not compile (finding 2). |
| 4 | Judge prompt: inline (A) vs `PromptStore` (B) | **B, with A's anti-drift guard** | A six-axis rubric with worked examples must be reviewable and versioned; the "editable to agree with the writer" risk is answered by a test that pins the axes and the verdict rule, not by hiding the file. |
| 5 | `instagram-brief@2` + schema fields (B) vs a static pack (A) | **A** | The register is the same for every Hebrew client, so a per-client model-written field buys nothing a table already holds (finding 10). |
| 6 | Correction timing: patch-then-rejudge (A) vs return-to-writer twice then patch (B) | **A's inner loop inside B's outer loop** | A sentence defect costs $0.014 to fix in place and $0.24 to redraft, and the writer still sees the steer through the attempt loop that already exists. |
| 7 | Remembered language ranks below the prose sniff (A) vs above it (B) | **B's rank, A's filter** | A measurement of what the client actually published outranks an inference from a self-description blurb, but only a decisive source may be remembered, so a guess never calcifies. |
| 8 | Step count: 2 new ids (A) vs 4 (B) | **3** | `04e2` folds into `04l` (both are free code over `crossChannel.entries`) and `07f2` folds into `07f`'s own block as a pure function of two checkpointed values. |
| 9 | Retire the `instagram-language-fluency` class id (B) | **B** | The step moves vendor `anthropic` → `gemini`, and a stale Studio `stageModels` override under the old id holding a Claude model would make `assertModelCatalogued` throw on vendor mismatch. |
| 10 | Letter-spacing (B only) | **B** | Verified on all eight templates (finding 5); A missed a real Hebrew rendering defect. |
| 11 | `04e` window + metering (B only) | **B** | One line, a saving rather than a cost, and the survey named it (finding 11). |

## 1. The six things a native reader clocks

Every mechanism below exists to kill one of them. **Four of the six are mechanically decidable and free.**
That is the budget trick: everything a machine can decide is decided in code, so the one paid judge spends its
tokens only on the two things it cannot — idiom and register.

| # | What a native reader clocks | Killed by | Cost |
|---|---|---|---|
| 1 | **Calque / English clause order** — `בסוף היום`, `בואו נצלול`, dummy-subject `זה חשוב ש…`, nominalised passive `נעשה שימוש ב` | writer persona + register card (§3), judge axes A and F (§6) | paid |
| 2 | **Wrong register** — hypercorrect literary Hebrew (`הינו`, `אשר`, `על מנת`) in a publication that writes mid-informal journalism | register card measured from the client's **own posts** (§3.2), judge axis C, deterministic hard-fail on `הינו` (§5) | mostly free |
| 3 | **Terms nobody says** — Academy purism (`יישומון`, `מרשתת`, `עסק זינוק`), or a term that should have stayed Latin and didn't | term policy from corpus + denylist (§5), judge axis D | mostly free |
| 4 | **Latin terms breaking bidi** — `"…השיק את Gemini 3."` puts the full stop on the wrong side; `(GPT-4)` mirrors its brackets; `2020-2024` reverses | Unicode isolates at render (§7.3) — **mechanical, never judged** | **free** |
| 5 | **Wrong conventions** — curly `“ ”` in Hebrew body copy, Latin month names, `MM/DD`, nikud, Eastern-Arabic digits | `gate.nativeLanguage`, deterministic (§5); judge axis E confirms and supplies the corrected string | **free** |
| 6 | **Latin typography on Hebrew** — `letter-spacing: -0.02em` collides final letters, `+0.22em` shreds a word, `lang="en"` picks the wrong fallback face | `SCRIPT_TYPOGRAPHY.letterSpacing` + the `{{lang}}` slot (§7.1–7.2), proved on real pixels by the existing interest-floor harness (§7.4) | **free** |

## 2. Target language resolution, in precedence order

`resolveTargetLanguage` (`src/workflow/target-language.ts:381-491`) keeps its shape. Phase 4 inserts **one** new
source and persists the answer for the first time.

| # | Source | Read from | Status label | New? |
|---|---|---|---|---|
| 1 | `brand.language`, verbatim (`he-IL` stays `he-IL`) | `client.getBrand()` → `clients/<slug>/client/brand.json` | `brand-language` | existing (`:387-394`) |
| 2 | Explicit output-language statement in prose | `profile.description`, `voiceRules.guidelines`, `voiceRules.doList`, brand-voice context doc | `explicit-mention` | existing (`:405-421`) |
| **3** | **Persisted belief `instagramLanguage`** — a previous run's *decisive* resolution for this client | `memory.read({ scope: "beliefs" })`, added to 02d's reads | `remembered` | **NEW** |
| 4 | Script sniff of that same prose (≥24 letters, ≥50% one script) | same four fields | `sniff` | existing (`:286-334`) |
| 5 | `english-default` | — | `english-default` | existing (`:490`) |

**Why source 3 sits above the sniff and below the two explicit statements.** It is a record of a previous run
**measuring what this client actually published**, which outranks an inference from a self-description blurb.
It sits below both explicit statements so a human who later sets `brand.language` always wins and the belief
can never become unfixable.

**The decisiveness filter (design A's contribution, and the thing that stops a guess calcifying).** Only a
belief whose recorded `source` is `own-posts`, `brand-language`, `explicit-mention` or `brief` is readable as
source 3. A `sniff`-sourced entry **is persisted for observability and is never re-used** — a once-guessed
answer must not become permanent truth.

### Late adoption, after 02i

`adoptBriefTargetLanguage` is generalised to `adoptLateTargetLanguage(resolved, { ownPostsLanguage, briefLanguage })`.
02d's answer still wins; otherwise, in order:

1. **`ownPostsLanguage`** — `sniffDominantScript` (already exported, pure, free) over the `ownPosts` captions
   `00b1-gather-brief-sources` already fetched. This closes the survey's Q1-3: the client's own posts were
   fetched and never used as a language source.
2. `brief.language.target` (existing behaviour). A brief declaring English resolves to `undefined`.

Any late adoption that **changes** the answer writes the `instagramLanguage` belief at `09b`, beside the
existing `instagramRunBudget` write, through `memory.updateBeliefs` — free-form, shallow-merged, **no schema,
no migration, no `ClientBriefSchema` bump.**

```ts
interface InstagramLanguageBelief {
  language: string;                 // the run's adopted targetLanguage, verbatim
  script: string;                   // "Hebrew" — from resolveExpectedScript, never a second table
  source: "own-posts" | "brand-language" | "explicit-mention" | "brief" | "sniff";
  evidence: string;                 // the sentence or the corpus count that decided it
  corpusPosts: number;              // how many in-script own posts were measured
  registerKey: string;              // which LANGUAGE_REGISTER_PACKS row was applied
  resolvedAt: string;               // ISO
}
```

### The null-`brand.language` case, named

- **karoslabs.** `brand.language` unset → evidence `"brand.language unset"` pushed; no language statement in
  prose; prose is English; own posts are English → `english-default`. `targetLanguage` is `undefined`;
  `04l`, `07e`, `07e2`, `07f`, the script font sheet, the letter-spacing rule and the isolates are all
  **skipped, by design, at zero cost**. This is **a decision with recorded evidence, not a silent skip**, and
  Phase 4 does not change it.
- **geektime.** `brand.language` unset; Hebrew resolves at source 2 or 4 from `profile.description`, and after
  the first brief-refresh run at source 3 from the measured corpus with `source: "own-posts"`.

`unresolved-non-english` (Cyrillic/Arabic/Devanagari/Han with no decisive statement) keeps its `WorkflowHeld`.
**That is an intake hold at zero model spend, not a budget or quality hold**, and the never-hold rule does not
reach it. The new belief is what makes it stop recurring once a run has resolved it.

## 3. The register card, the persona, and the few-shot — `04l-language-register`

New step id `04l-language-register`, placed between `04j-select-angle` and the attempt loop, revision-scoped
via `rev()` like `04g` and `04i`. Everything it reads is already in scope and already checkpointed:
`targetLanguage`, `brief`, `clientVoiceContext`, `crossChannel.entries`, `profile`.

**`wf.step.code`. No model call. No tool call. No network. $0.00.**

It emits one `LanguageBrief`:

```ts
export interface LanguageBrief {
  target: string;                   // "Hebrew" / "he-IL", as resolved
  script: string;                   // from resolveExpectedScript — never a second table
  direction: "rtl" | "ltr";
  bcp47: string;                    // "he" — for the {{lang}} slot
  persona: string;                  // "You are a staff editor at Geektime …"
  register: RegisterCard;
  terms: TermPolicy;
  conventions: ConventionPack;      // the same object gate.nativeLanguage checks against
  fewShot: readonly FewShotPost[];  // the client's real posts, in the target language
  corpusNote?: string;              // why fewShot is short or empty
}
```

### Why a new step id rather than folding into `04g`

`04g-style-directive` is the right scope (revision, code, free) and the closest call. Rejected because `04g`
means "how this carousel should look", and folding "how this client's language sounds" into it makes one step
id mean two things — the exact trace ambiguity that started this audit. **Which three of the client's posts
were shown as register exemplars, and which register row was applied, are the two facts that will be argued
about when a Hebrew post reads wrong**, and a fact computed inline is a fact nobody debugging can find.

### 3.1 Persona — derived in code, never invented

> `You are ${role} at ${publication}. You write for ${icp}. Everything you write is read by people who read
> ${publication} every week and would put down a post that sounds translated.`

- `publication` ← `profile.companyName ?? profile.name`, falling back to the brief's positioning subject.
- `role` ← a fixed per-mode string (`"a staff editor"` for news mode, `"the editor who writes the explainers"`
  for evergreen) — **not** model-authored.
- `icp` ← `brief.icp`, already rendered by `briefForPrompt`.

For geektime this renders literally the plan's own example, *"an editor at Geektime"*, without anything in the
code knowing the word "Geektime". Then `brief.language.register` — the existing free-text tone phrase — is
appended verbatim, which is all that field was ever good for.

### 3.2 Register card — three layers, most specific first

1. **Measured (strongest).** Computed in code over the client's real in-script posts: mean sentence length,
   share of sentences opening with a verb, question-mark density, emoji density, first/second-person density,
   hashtag habit, mean caption length. Rendered as one short block — *"their posts average 18 words a sentence,
   open with a verb 4 times in 10, use no emoji, ask the reader a question once per post."*
2. **Pack (per language).** `LANGUAGE_REGISTER_PACKS`, keyed through `resolveExpectedScript` so the table can
   never drift from `SCRIPT_TABLE` — the same discipline `script-fonts.ts:122-128` already follows. Hebrew is
   populated first-class; every other non-Latin language gets the **universal** rows only (quotes, numerals,
   dates) and **says nothing where we do not know**. An English fallback beats a guessed translation.
3. **`brief.language.register`**, rendered last as the client's stated tone.

**The Hebrew pack, concretely:**

```
registerLevel:      journalistic mid-register; not literary, not slang. Headlines carry no final period.
hypercorrections:   הינו → הוא/היא · אשר → ש־ · על מנת → כדי · יתרה מזאת → ויותר מזה
                    נעשה שימוש ב → השתמשו ב · בטרם → לפני
calques (soft):     בסוף היום · בואו נצלול · בואו נפרק את זה · אנחנו נרגשים ל
                    לקחת את זה לשלב הבא · משנה את כללי המשחק · זה מה שהופך את
purisms (hard):     יישומון → אפליקציה · מרשתת → אינטרנט · עסק זינוק → סטארט-אפ
                    אינטליגנציה מלאכותית → בינה מלאכותית · קלאוד → ענן · מחשב לוח → טאבלט
transliteration OK: loanwords already standard in the trade press —
                    סטארטאפ, אפליקציה, קוד, סרבר, באג, דיפלוי
transliteration NO: any word with a live Hebrew equivalent in daily use —
                    תוכנה not סופטוור, חומרה not הארדוור
stays in Latin:     AI, LLM, GPT, API, SaaS, B2B, iOS, Android, product and company names, model names,
                    protocol/format tokens, file extensions — in Latin letters, never transliterated into
                    Hebrew letters. Plus every Latin token that appears in this client's own posts.
quotation marks:    " " (straight). NEVER “ ” ‘ ’ „ — curly English quotes in Hebrew body copy are an
                    import tell.
abbreviation:       gershayim ״ (U+05F4) before the last letter (ארה״ב, צה״ל);
                    geresh ׳ (U+05F3) for a single-letter abbreviation (ד״ר, ג׳).
numerals:           Western digits, left-to-right inside the Hebrew line. Decimal "." thousands ",".
                    Percent AFTER the figure (47%). ₪ before the figure, or "ש״ח" after.
                    Dates DD.MM.YYYY; NEVER a Latin month name inside Hebrew copy.
                    A numeric range is written with עד, never with a dash — gate.lintPost bans en/em
                    dashes and the double hyphen outright, in every language.
agreement:          gender and number agreement on every adjective and verb; construct state (סמיכות)
                    where a chain of של would be clumsy; masculine plural for a mixed audience unless
                    the brief says otherwise.
hyphen:             maqaf ־ and ASCII - are both acceptable; MIXING them in one post is the tell.
nikud:              none in body copy.
```

The `numerals` row names `gate.lintPost` on purpose: an en-dash range is the single most likely way a
**correct** Hebrew draft fails an existing gate for a reason that has nothing to do with Hebrew.

Each row is tagged `hardFail` or `softTell`. **Only the mechanically certain rows are `hardFail`** (`הינו`,
purisms, curly quotes, Eastern-Arabic digits, nikud, Latin month names). Calques, hyphen mixing and register
density are `softTell`: measured, handed to the judge as candidate evidence, and **never on their own a gate
failure**. Under the never-relax-a-threshold rule, the answer to an uncertain signal is not a loose threshold —
it is no threshold and a judge.

### 3.3 Few-shot from the client's real posts — **IN, at $0.00**

**Why in.** The register card can *describe* the voice; only a real post *is* it. Every other lever in this
phase is a description of Hebrew; the few-shot is the only evidence of *this client's* Hebrew.

**Why it is free.** The posts are already fetched. `readCrossChannelHistory` already calls
`research.socialHistory` on the client's own accounts at `04e`, stores the **full 600-char excerpt** on each
entry, tags it `origin: "social"`, `channel: "instagram"`, and labels it *"Instagram (the client's own
account)"*. `04l` reads `crossChannel.entries` and spends **nothing**. No new fetch, no new vendor, no new
window, no `POSTS_PER_ACCOUNT` change, no second `research.socialHistory` call. **The change is framing, not
fetching.**

Selection, in code:

1. Take `crossChannel.entries` where `origin === "social"`.
2. **Filter by script, per post**, with `sniffDominantScript`. A bilingual account otherwise yields a mixed
   exemplar set — the plan's failure mode dressed as its fix.
3. Drop excerpts under 120 characters — a three-word caption teaches no register.
4. Rank: posts carrying `engagement` first (by score), then by prose length, then recency. Take **6** for the
   writer and **4** for the judge, at up to 400 characters each.
5. Compute the measured register statistics of §3.2.1 over the **whole** filtered set, not just the six.

Rendered under: *"Six things this client actually published, in their own Hebrew. This is how they SOUND —
register, sentence length, which terms they leave in English, how they punctuate. Write in this voice. It is
not a topic list."*

**Empty corpus.** `research.socialHistory` drops a textless post silently and **caches the empty result**. So
`posts.length === 0` is recorded as `corpusNote: "no <language> posts were readable for this client's own
accounts (n accounts, m posts returned, k in-script)"`, the few-shot block is **omitted entirely**, the
register falls back to pack + brief, and **the run continues**. It is never read as "this client has no
Hebrew" and never writes the `instagramLanguage` belief. Nothing holds, nothing warns loudly, nothing trusts
`posts.length > 0`.

**The avoid-list reconciliation.** `recentPosts` stays *"do not repeat it here"*; `languageBrief.fewShot` is a
**separate field with the opposite instruction**. Prompt §23 states the tension in one sentence the writer
cannot misread: *"The exemplars in `languageBrief` are how this client SOUNDS. `recentPosts` in §11 is what
they have already SAID. Borrow the first, never the second — a post that reuses an exemplar's topic, hook or
angle fails 07d."*

### 3.4 `04e`, corrected in passing

`04e-read-cross-channel-history` passes `window: "24h"` (was the schema default `"6h"`), so it shares the cache
key **and the freshness bar** with `00b1`/`03e`/`00c2` — a saving of up to $0.042 on a brief-refresh run. And
it is **metered**: `spend("04e-read-cross-channel-history", undefined, accounts.length * scraperExecution)`,
only on runs where `00b1` did not already pull the same account set. This step has billed ScrappyCoco with no
`spend(...)` line since it was written; recording it is a metering correction, not new money.

## 4. The writer — `instagram-copy@15 → @16`

**New input field**, spread beside `clientVoiceContext` at `create-instagram-agent-workflow.ts:~4737`:

```ts
...(languageBrief !== undefined ? { languageBrief } : {}),
```

Absent on English runs, so an English run's prompt payload is unchanged. This also closes survey gap §5-7: the
writer finally receives the resolved language **as a field**, not only as a clause inside `briefForPrompt`.

**New steer**, a fourth typed steer beside `dedupeRetrySteer` and `relevanceSteer`:

```ts
/** Phase 4 — the native editor's corrections, quoted span by quoted span, for exactly the next attempt. */
let nativeSteer: string | undefined;
```

Kept separate from `selfCheckSteer` for the reason the existing comment already gives: a language correction
and a failed render rule are different remedies and must not overwrite each other. Rendered one line per
correction: `slide 3 · body · "בסוף היום" → "בסופו של דבר" (calque of "at the end of the day")`.

**Prompt `prompts/instagram-copy/16.md`**, ~2,600 characters added:

- **New §23 "Writing in the target language as a native"**, placed after §22. Reads `languageBrief`: the
  persona is who you are; the register card is how this publication sounds; the term policy says which words
  stay in English and which never appear; the convention block is **not style, it is spelling**; the few-shot
  is voice, never subject. When `languageBrief` is present it is **binding and outranks every stylistic
  instinct in §1–§14**. Names `gate.nativeLanguage` as the deterministic half it will be run through, and
  states that a `nativeSteer` correction is **applied, not argued with** — the same posture §16 already takes
  for a fluency finding. Carries the exemplars-vs-`recentPosts` sentence from §3.3 verbatim.
- **§1 demoted**, not deleted: "when `languageBrief` is absent, do this". English runs read identically to
  @15, and the `requires.languageDirective` marker (the literal `clientVoiceContext`) stays satisfied.
- **§16 extended** to name `nativeSteer` alongside `selfCheckSteer`, and to state that a correction arrives as
  **anchored quote → proposed replacement**: apply the proposal or write something equally native, never argue
  with it, **never change a number, a date, a name or a claim while doing so**.

**The prompt-bump checklist, all in one commit** (five steps plus the mandated re-price):

1. `prompts/instagram-copy/16.md` written.
2. `prompts/instagram-copy/latest.md` made **byte-identical** to it.
3. `skillRef: "instagram-copy@16"` in `instagram-copy-agent.ts`.
4. The H1 version line inside the prompt fixed, and the inline version-ledger paragraph added to the agent
   class stating the input **and output** deltas separately (@14→@15's own note records that an input-only
   re-price under-counts by ~9/10).
5. `scripts/prompt-registry.ts`: `versions: ["1",…,"15","16"]`, `latestVersion: "16"`, `requires` unchanged.
6. `STEP_COST_ESTIMATES_USD.copyAttempt` re-priced in the same commit (§9).

Plus **`KNOWN_GATES` gains `"gate.nativeLanguage"`** — required the instant §23 names it, cross-checked at run
time by `check-prompts.ts` against `createKarosGatesTools()`. Adding the name without the tool, or the tool
without the name, is a CI failure either way.

**No other prompt is bumped.** `instagram-brief` stays at @1 (finding 10).

## 5. `gate.nativeLanguage` — the deterministic half

### The plan reconciliation

The plan names `gate.nativeLanguage` as *"a judge with a rubric and examples that returns to writing"*. The
`karos-gates` registry's own contract is *"deterministic validators, **no model calls**"* — a stated invariant
five other tools rest on. **So the plan's single named component is built as two, keeping both contracts:**

- **`gate.nativeLanguage`** — a typed zod tool, deterministic, free, checking everything about nativeness that
  is mechanically decidable. This is the name the prompt may state, the name `KNOWN_GATES` carries, and the
  thing that can never be argued with.
- **`instagram-native-editor`** (§6) — the model judge with the rubric, the examples and the corrections,
  which is the half that returns to writing.

The judge **reads the gate's findings** and must confirm or reject each one with the corrected string, so the
two are one instrument with a cheap half and an expensive half, not two opinions.

### The tool

New file `packages/tools/karos-gates/src/native-language.ts`, `TOOL_VERSION = "1.0.0"`, registered in
`index.ts` and re-exported. Returns the repo's `GateVerdict` (`pass | content_fail`), the same shape
`gate.lintPost` returns. **No model call. $0.00.**

The tool owns **no script table.** It takes the expected script from the caller, so `SCRIPT_TABLE` stays the
single source of truth and RFC-13's "the language gate is agent-local" layering decision stands.

```ts
export const NativeLanguageInputSchema = z.object({
  language: z.string().min(1),
  scriptName: z.string().min(1),                                // "Hebrew"
  scriptPattern: z.string().regex(/^\\p\{Script=[A-Za-z]+\}$/), // allowlisted literal form only
  fields: z.array(z.object({
    id: z.string(),   // "caption" | "slide-3.headline" | "slide-3.fields.leftLabel" | "slide-3.device.label"
    text: z.string(),
  })).min(1),
  allowedLatinTerms: z.array(z.string()).default([]),           // terms this client's own posts leave in Latin
  forbiddenTransliterations: z.array(z.string()).default([]),   // the pack's hardFail rows
});
```

`scriptPattern` is constrained to the literal `\p{Script=X}` shape **and re-validated inside the tool before
construction** — a caller cannot weaken the gate by passing `.`. That constraint is itself pinned by a test
that feeds it `"."` and asserts the tool refuses.

### Hard fails — each one individually breakable in a test

| # | Rule | Why it matters |
|---|---|---|
| 1 | **Per-field script coverage** — every field with ≥12 letters must be ≥0.6 expected script | **The defect that exists today** (finding 8). A carousel with two English slides out of eight measures ~0.75 aggregate and passes; per-field, those two fail. |
| 2 | **Aggregate coverage ≥0.3** | Kept verbatim as the catastrophic floor, so nothing Phase 0 caught stops being caught. |
| 3 | **Long unexplained Latin run** — >24 chars in an in-script field, not on `allowedLatinTerms` | An English sentence smuggled into a Hebrew slide. |
| 4 | **Forbidden transliteration / purism** — a pack `hardFail` term, not in `allowedLatinTerms` and not in the client's own corpus | סופטוור / יישומון / מרשתת: the register's own list, checked mechanically instead of hoped for. |
| 5 | **Curly quotation marks** — `“ ” ‘ ’ „` in in-script text | A model asked "did you use the right quotes" is guessing; a regex is not. |
| 6 | **Hypercorrection** — `הינו` as a copula | Mechanically certain, and the single loudest literary-register tell. |
| 7 | **Nikud** — `\p{Mn}` share of in-script letters > 2% | Never used in body copy. |
| 8 | **Foreign digits** — any `[\u0660-\u0669\u06F0-\u06F9]` | Register says Western digits. |
| 9 | **Latin month name** inside in-script text | `/\b(january|…|december)\b/i` — a date that was never localised. |
| 10 | **Impossible date order** — `\b(1[3-9]\|2\d\|3[01])[./](1[3-9]\|2\d\|3[01])[./]` | An unambiguously wrong month/day order; the ambiguous cases are deliberately not flagged. |
| 11 | **Bidi control characters** — U+202A–U+202E in model-authored text | Embeddings and overrides in copy the model wrote are a leak or an attempted layout hack. The only legal isolates are the U+2068/U+2069 that `isolateForeignRuns` inserts **after** this gate runs, which is why the gate runs on raw copy at 07e2 and never on the composed fields. |

### Soft tells — returned as `evidence[]` on a **pass**, never as a failure

Calque phrases; `אשר` density > 1.5 per 100 words; `על מנת` present; mixed maqaf/ASCII hyphen; mean sentence
length more than 1.6× the client's own measured mean. These travel into the judge's input as **candidate**
findings.

**The unknown-language rule, inherited from `SCRIPT_TABLE`'s own doctrine:** a language with no pack yields
`pass` with `evidence: ["no convention pack for <language>"]`. A missing entry degrades to *"this gate has no
opinion"*, **never** to *"fail every draft for this client"*.

### Where it runs — `07e2-native-conventions-attempt-N`

Immediately after `07e`, before `07g`, called exactly the way `checkCraftHygiene` calls `gate.lintPost` (the
tool registry with `{ ctx }`). A `content_fail` calls `returnToCopyWith(...)` and `continue`s, **free**, before
the $0.002 relevance judge and the $0.014 native editor. The paid ordering contract is preserved and extended:

> `07e` (free) → `07e2` (free) → `07g` relevance (Flash, $0.002) → `07f` native editor (Gemini Pro, $0.014) —
> cheapest rejection first, free rejections before any of them.

**Fallback:** when the registry has no `gate.nativeLanguage` (partial registries in ~30 existing test files),
`07e2` is skipped and `07e`'s `checkExpectedScript` stands alone. No fixture rewrite.

**Registry count: 6 → 7 gates, and the engine tool-registry snapshot moves 62 → 63** (finding 4). Read the
snapshot; do not trust a remembered number.

## 6. The native judge — `instagram-native-editor`

### 6.1 Shape

A real agent class `InstagramNativeEditorAgent extends BaseAgent` with a zod `outputSchema`, **not** a
`DynamicAgent`: the field DSL is flat primitives and `string[]` only and cannot express a correction
(finding 2). Corrections are the whole point of this phase.

**Step id `07f-language-fluency-attempt-N` is unchanged** — tests pin it and it still names what the step is.
Round 2 checkpoints under `07f-language-fluency-attempt-N-round-2`, mirroring the existing `-retry` suffix
pattern. **The agent class id changes** `instagram-language-fluency` → `instagram-native-editor`
(decision 9): the step moves vendor `anthropic` → `gemini`, and a stale Studio `stageModels` override under
the old id holding a Claude model would make `assertModelCatalogued` throw on vendor mismatch. A new class id
inherits no override. `contentLanguageSensitive` is **false** — the step is already pinned to the model the
requirement would select, so letting the policy move it could only move it somewhere worse.

### 6.2 The rubric, in full

Six axes, each returning `ok | minor | major`. **The judge may only return anything other than `ok` with a
quoted span and a proposed replacement** — an axis flagged without a correction is discarded by the parser,
which makes "report without correcting" structurally unrepresentable. That is the plan's "returns to writing",
enforced by the schema rather than requested by the prose.

| Axis | The question | A `major`, with its worked example |
|---|---|---|
| **A. Translationese** | Is this English rendered clause by clause? Calqued idiom, English clause order that is grammatical but unnatural, dummy-subject constructions, nominalised passive where a native would use an active verb. | `בסוף היום, זה מה שהופך את המוצר לחזק` → `בסופו של דבר, זה מה שמחזיק את המוצר` |
| **B. Grammar** | Gender and number agreement, verb binyan, construct state (סמיכות) versus a chain of `של`, the definite article on the wrong member of a סמיכות. | `המנהל של הפרויקט של החברה` → `מנהל הפרויקט בחברה`; `שלושה חברות הודיעו` → `שלוש חברות הודיעו` |
| **C. Register** | Against **this client's own posts** and the measured register card. **Both directions fail**: literary hypercorrection and unearned slang. | `הינו הכלי המשמעותי ביותר` → `הוא הכלי הכי משמעותי` |
| **D. Terminology** | Does this niche actually say this word? Academy purism, a wrong transliteration, an English term that should have stayed English, an English term that should not have. | `יישומון` → `אפליקציה`; `בינה מלאכותית יוצרת` → `AI גנרטיבי` for a dev-facing outlet |
| **E. Convention** | Quotes, gershayim/geresh, numerals, dates, percent/currency, hyphen consistency, nikud. **The judge is handed `gate.nativeLanguage`'s soft tells and must confirm or reject each, with the corrected string.** | `“המודל החדש”` → `"המודל החדש"`; a dash range → `עד` |
| **F. Idiom and rhythm** | Would an editor at this publication have written this sentence, or only understood it? | a headline that parses but that nobody would say aloud |

**Verdict rule:** not native when **any axis is `major`**, or when **three or more axes are `minor`**. Two
minors pass. That is a real threshold with a real other side, and its test breaks the code (2 minors → pass,
3 → fail) rather than asserting a constant.

**The judge's few-shot** is the same corpus the writer received, capped at 4, labelled *"this client's real
published voice"*. This is load-bearing fairness: a judge holding the writer to a register the writer was
never shown generates redrafts that cannot converge — exactly the "hold generator, not a corrector" defect
Phase 0's own comment records.

**The judge judges only the language.** The framing at `language-gate.ts:386-389` is kept verbatim: not the
topic, not the tone, not the marketing quality. Proper nouns, brand names, product names and technical terms
in their original language are **normal**; so are informal register, fragments and headline style. `07g`
already owns relevance, and a fluency judge volunteering opinions on subject matter fails drafts for reasons a
redraft cannot address.

### 6.3 Model tier, and the cost justification

**`gemini-2.5-pro`**, pinned, vendor `gemini`.

| | `languageStrength` | `rtlSupport` | `costTier` | $/1M in | $/1M out |
|---|---|---|---|---|---|
| `claude-opus-4-8` | multilingual-strong | strong | **premium** | 5.00 | 25.00 |
| **`gemini-2.5-pro`** | **multilingual-strong** | **strong** | **standard** | **1.25** | **10.00** |
| `claude-sonnet-4-6` | strong | strong | standard | 3.00 | 15.00 |
| `claude-haiku-4-5` | basic | basic | budget | 1.00 | 5.00 |

The plan says "a strong model". The engine's catalog has exactly **three** `multilingual-strong` rows: two
Opus (premium, banned) and `gemini-2.5-pro` (standard). Gemini 2.5 Pro is therefore *the* model that satisfies
the plan inside the owner's constraint — not a compromise, the only non-premium row the catalog rates capable
of this job. It is 2.5× cheaper per output token than Opus and cheaper per input token than Sonnet, and it is
already priced, catalogued and reachable on the `global` endpoint.

Haiku 4.5 is rated `languageStrength: "basic"`, `rtlSupport: "basic"`. **It is the model that has been judging
Hebrew nativeness since Phase 0**, and asking a `basic` model to rule on idiom is the quiet hole in the
current gate.

**Inline comment required next to the step** (owner's rule — every new model step justifies its cost where it
is written):

```ts
// ~$0.014/attempt on non-English runs only: gemini-2.5-pro at $1.25/$10 per 1M,
// ~6.0k in (rubric 1.5k + register card 0.45k + 4 few-shot posts 2.0k + the draft 1.7k
// + gate.nativeLanguage's soft tells 0.2k + scaffolding 0.15k) and ~0.65k out (up to 8
// corrections at ~70 tokens each plus the verdict). It is the ONLY non-premium row in
// the catalog rated multilingual-strong + rtlSupport strong (model-capabilities.ts:205);
// the two Opus rows are the alternative and are banned. It replaces a $0.0055 Haiku call
// rated `basic` on both dimensions — +$0.0085/attempt to stop asking a basic model about
// idiom, against $0.240 for the redraft a wrong verdict costs.
//
// NOT Opus, at any tier. `claude-opus-4-8` on this call is $0.046, and on the five steps
// that carry `contentLanguageSensitive` it is a ~$2.9 run against a $1.50 hard max.
// See §8.
```

### 6.4 The output contract

```ts
export const NativeCorrectionSchema = z.object({
  target: z.string().regex(/^(caption|slide:[1-8])$/),
  field:  z.enum(["headline", "body", "kicker", "caption", "device", "custom", "archetype"]),
  customKey: z.string().max(64).optional(),
  span: z.string().min(1).max(240),          // EXACT substring of that field
  replacement: z.string().min(1).max(240),   // what a native writer would write
  axis: z.enum(["translationese", "grammar", "register", "terminology", "convention", "idiom"]),
  severity: z.enum(["minor", "major"]),
  why: z.string().max(160),
});
export const NativeEditorVerdictSchema = z.object({
  native: z.boolean(),
  axes: z.object({ translationese, grammar, register, terminology, convention, idiom }), // each ok|minor|major
  corrections: z.array(NativeCorrectionSchema).max(12),
  rubricVersion: z.string(),                 // stamped so telemetry can tell eras apart
});
```

The judge's input gains the same field ids, built by a new `languageGateFields(copy)` beside the existing
`languageGateText(copy)`, covering **caption, headline, body, kicker, the ARCHETYPE COPY BLOCKS,
custom-archetype field values, and device labels**. Device labels are added here (finding 9): they are
rendered copy, they are already in `collectSlideText`, and they have never been judged.

**The archetype copy blocks are the other half of that, and they are not optional.** `contentFor`
(`slides-data.ts`) is the authority on what a template actually paints, and four of the eight archetypes do
not paint `headline`/`body` at all: `quote_card` renders `quote.text` + `quote.attribution`, `stat_callout`
renders `stat.subLabel`, `comparison_card` renders the four `comparison.*` strings, `list_takeaway` renders
`items[].title`/`note`. Judging headline and body on a quote slide judges two strings the reader never sees
and reads none of the prose the reader does — a Hebrew carousel whose pull-quote was written in English would
pass `07e`'s script check, `gate.nativeLanguage` rule 1 and the native editor. Both `languageGateFields` and
`languageGateText` enumerate them through one shared `archetypeTextSlots(slide)`, and `resolveField` in
`native-corrections.ts` resolves them under `field: "archetype"` in the same commit — widening the judge
alone would produce corrections that are always dropped.

`sourceRef`, `visualNeed`, `stat.figure` and every `source` (a device's and a stat's alike) stay excluded, for
the unchanged reason — a verbatim source claim, a stock-photo query and a numeral — and gating on them fails
every correct Hebrew draft whose sources are English.

**Prompt `prompts/instagram-native-editor/1.md`** holds the rubric, the worked examples and the output
contract; `skillRef: "instagram-native-editor@1"`; registry entry with **no `requires` flags** — the judge
receives `languageBrief`, never `clientVoiceContext`, so the `languageDirective` marker (which looks for that
literal) would be unsatisfiable, the same reasoning `instagram-angle` already records.

**The versioning tradeoff, stated.** `language-gate.ts:376-390` argues for an inline prompt because *"a check
whose wording lives in the same editable store as the drafting prompts is one that can be edited to agree with
them."* Phase 4 overrides that: a rubric with six named axes and worked examples is exactly the artefact that
must be versioned and reviewable, and `instagram-image-vet`/`instagram-visual-qa` are both judges with
versioned prompts already. **The risk is answered by a guard rather than by hiding the file**:
`__tests__/native-editor-rubric.test.ts` asserts all six axis names, the `major`/3×`minor` verdict rule and the
no-finding-without-a-correction rule are present in `latest.md`, so an edit that softens the check into
agreement with the writer fails CI.

### 6.5 Two rounds, then DELIVER — never a hold

The plan's "two rounds" is **two judge rounds inside one attempt**, at sentence granularity — not two paid
redrafts. A translationese finding costs $0.014 to fix and $0.240 to redraft, and the judge has already
written the better sentence.

```
07f round 1 ── native ─────────────────────────────────────────────► pass, ship
            │
            └─ not native, corrections.length > 0
                   │
                   ├─ applyNativeCorrections(copy, corrections)   [pure, free, no step id]
                   │     • span must resolve to an existing slide/field and occur EXACTLY ONCE
                   │       (zero or two occurrences → that correction is dropped and counted;
                   │        an ambiguous patch is worse than none)
                   │     • replacement must not push the field past its own schema cap
                   │       (kicker 48, stat.figure 12, customArchetype.fields 2000)
                   │     • never touches sourceRef, visualNeed, stat.figure or any LAYOUT_FIELD_KEY
                   │
                   ├─ re-run the FREE checks the corrected text must still pass:
                   │     checkCraftHygiene  — banned words, em dashes
                   │     checkExpectedScript + gate.nativeLanguage's hard fails
                   │     → either fails ⇒ DISCARD THE WHOLE PATCH, keep the raw draft,
                   │       fall through with the reason named
                   │
                   └─ 07f round 2 (`…-round-2`), judging the CORRECTED copy
                          ├─ native ─────► ship the corrected copy, language.status = "corrected"
                          └─ not native ─► see the termination table
```

Re-running craft hygiene and the script gate on corrected text is **not optional**: `07b` and `07e2` ran
*before* the corrections existed, and copy that ships must have passed every free check **in the state it
ships in**. A judge whose proposal smuggles an em dash past `gate.lintPost` would otherwise ship it.

`applyNativeCorrections` is a pure function of two checkpointed values (the `05` output and the round-1
verdict), so it is deterministic across a resume and needs no step id of its own; the corrected copy is itself
checkpointed one step later at `07c-emit-slides-data-attempt-N`. Every correction — applied or dropped, with
the reason — is recorded on the round-2 step's checkpoint and summarised in any degrade reason.

### Termination — always by delivering

| Situation | Outcome | `DraftResult.language.status` |
|---|---|---|
| round 1 `native` | ship | `verified` |
| round 2 `native` after corrections | ship the corrected copy | `corrected` |
| round 2 not native, **attempt < maxAttempts** | set `nativeSteer` from the corrections, return to `05` | — |
| round 2 not native, **final attempt** | **ship the best version** — the corrected copy if the patch applied cleanly, else the raw draft — with the judge's reason, one ledger warn, and the flag on the gate payload and the deliverable | `degraded` |
| judge `error` (call + in-step retry), attempt remains | free gates both passed → return to `05`, reason names the outage | — |
| judge `error`, final attempt | ship, flagged unverified, ledger warn | `unverified` |
| meter posture `cheapest-path` (past $1.50) | the judge is **not skipped** — it degrades its PAYLOAD — the rubric travels, the register card and few-shot do not — round 1 only, no round 2, no language-driven redraft. **The model does not move yet** and the meter books $0.014 on both paths; see known gaps §2 | `verified` / `degraded` |

**`WorkflowHeld` is never thrown for a language reason.** Language is a mandatory gate for a non-English
client; the **tier** is the optional part. The existing hold for attempt-cap exhaustion remains for everything
else, and `unresolved-non-english` at intake remains (§2).

**On the outage path**, "fails closed" is preserved in the sense that still matters: unverified Hebrew never
ships *silently*. It ships *flagged*, to a run that still has a human gate at `09a`. A hold delivers nothing
and a person cannot reject what they never received; a flagged delivery is a decision a person can make. The
original geektime failure shipped because nothing told anyone.

**Degrade marker**, mirroring `interestDegradedMarker` exactly — an attempt-scoped marker, reset per attempt
so a fixed attempt is never reported as degraded, routed into the gate payload beside `contextGrounding`,
`visualInterest` and `budget`:

```ts
`the native ${targetLanguage} editor still flagged ${n} phrase(s) after 2 rounds; ${applied} of its
corrections were applied in place and ${dropped} could not be (${axes}). A ${targetLanguage} reader
should read the slides before this publishes.`
```

**`DraftResult` gains:**

```ts
language?: {
  status: "verified" | "corrected" | "degraded" | "unverified";
  rounds: 1 | 2;
  axes: Record<NativeAxis, "ok" | "minor" | "major">;
  correctionsProposed: number;
  correctionsApplied: number;     // < proposed when a span did not match verbatim exactly once
  reason?: string;                // present on degraded / unverified
};
```

plus a `ledger.appendEvent` warn on `degraded` and `unverified`, keyed `${runId}__language-<status>-r<revision>`
so a resume writes one row. The per-axis verdicts and the round count are also written to the
`instagramRunBudget` belief, so the next phase can read whether §9.4's bet paid.

## 7. Script typography

### 7.1 Size scale and line-height — unchanged; letter-spacing — the gap

`SCRIPT_TYPOGRAPHY` already carries Hebrew at `typeScale 0.94`, `lineHeight { display: 1.12, body: 1.6 }`,
emitted onto the templates' own `body`/`body.ts-s`/`body.ts-l` selectors so a reviewer's `fontScale` composes,
with the `padding-block-end: 0.22em` descender allowance emitted alongside the leading. **All measured in real
Chromium in Phase 0. None of it changes.** Re-deriving measured work is how the 270×360-gradient fixture
happened.

**The gap is letter-spacing** (finding 5). `ScriptTypography` gains:

```ts
/** Optional, and absent means "not measured for this script — emit nothing rather than guess". */
readonly letterSpacing?: { readonly display: string; readonly body: string };
// Hebrew: { display: "normal", body: "normal" }
```

emitted by `buildScriptFontHeadHtml` onto `DISPLAY_SELECTORS` and `BODY_SELECTORS` beside the existing
line-height rules, **only when the field is present**. `.num-figure` stays excluded (digits are
script-neutral) and `.brand-handle` is in neither list, so the Latin handle keeps its `0.08em`.

### 7.2 `lang`, and alignment

- **`lang`.** Change `<html lang="en" dir="{{dir}}">` to `<html lang="{{lang}}" dir="{{dir}}">` on all eight
  templates, and add `lang` to `contentFor`'s `base` fields (filled from `languageBrief.bcp47 ?? "en"`), to
  `LAYOUT_FIELD_KEYS` (it is layout metadata, never prose, and must not be counted by the two-elements rule,
  the topic-guardrail corpus or the reviewer's editable-fields view), and to the Template Studio's
  code-written document shell and `STANDING_FURNITURE_SLOTS`. A client-pool template authored without the slot
  keeps its literal `lang="en"` and renders exactly as today — `fillTemplate` strips unfilled slots, so this
  degrades rather than breaking.
- **Alignment.** Already correct and already logical (finding 7). Phase 4 adds **no new control** and instead
  **pins** it: a test asserts no bundled template and no emitted script-sheet rule resolves to a physical
  `left`/`right` on a display or body selector. A physical keyword sneaking into a future template is the
  failure this guard exists to catch, and it can fail today if you add one.

### 7.3 Bidi for Latin terms embedded in Hebrew

Today the only isolation anywhere is `<bdi dir="ltr">{{brandHandle}}</bdi>` for brand furniture. A Latin
technical term in Hebrew body copy has none, so `"…השיק את Gemini 3."` puts the full stop on the wrong side,
`(GPT-4)` mirrors its brackets, and `2020-2024` reads backwards.

**Mechanism: Unicode isolates, not markup.** New pure module `src/workflow/bidi-isolate.ts`:

```ts
/** Wraps each Latin/digit run in FSI…PDI when the carousel is RTL. No-op when dir === "ltr". */
export function isolateForeignRuns(text: string, dir: "rtl" | "ltr"): string;
```

Token = `/[A-Za-z0-9](?:[A-Za-z0-9.@/&+#'’_-]*[A-Za-z0-9%])?/`; a RUN is a maximal sequence of tokens
separated by SINGLE SPACES, and only a run of two or more characters is wrapped. Greedy enough to keep
`gpt-4o`, `api.stripe.com` and `50%` intact, and space-joining is what keeps `S&P 500`, `API v2`,
`Gemini 3` and `iPhone 17 Pro Max` **one isolate each**.

One isolate per RUN, never one per token, and this is load-bearing rather than tidy: UAX#9 rule X6a makes an
FSI…PDI opaque to the isolating run sequence around it, so `⁨API⁩ ⁨v2⁩` between two Hebrew runs resolves as
three neutrals, N1 gives them the surrounding R direction, and L2 displays `v2 API`. Those phrases all render
CORRECTLY with no isolation at all, so per-token isolation would be strictly worse than doing nothing.
A lone stray Latin letter or digit standing by itself is still left alone: it does not reorder, and wrapping
every digit doubles the character count of a numeral-heavy stat for nothing.

**Why isolates and not `<bdi>`:**

- Copy fields go through the escaped `{{key}}` form — there is no raw form — and the privileged `{{html:...}}`
  slots are a closed set (`["device","recap","itemRows"]`) enforced by studio gate 3. **The markup channel is
  unavailable.** Isolate characters survive HTML escaping and need no new privileged slot.
- They reach **every** archetype at once, including device labels and model-authored `customArchetype.fields`,
  which markup wrapping would have to reach one slot at a time.
- They are `\p{Cf}` format characters, **not** `\p{L}`, so `checkExpectedScript`'s ratio and `detectDirection`
  are both untouched.

**Scope, stated precisely.** Applied inside `contentFor` to **rendered slide text only** — `headline`, `body`,
`kicker`, `quote.text`, `quote.attribution`, `stat.subLabel`, `stat.source`, `comparison.*`, list
`items[].title/note`, device labels, `customArchetype.fields` values. **Never** to `stat.figure` (a bare
numeral inside a `line-height: 0.95` lockup — a designed relationship, and the same reason `.num-figure` is
excluded from `DISPLAY_SELECTORS`), never to any `LAYOUT_FIELD_KEY`, and **never to the published caption,
`sourceRef`, `languageGateFields`, `checkCraftHygiene`'s input or `07d`'s dedupe text**. Every gate reads the
model's original copy, so no gate ever sees a control character and no invisible character reaches Instagram's
caption field. A test asserts exactly that.

**Named risk, and how it is caught.** `headline-focus.html` and `stat-callout.html` size display type from an
in-page `textContent.length` breakpoint (`> 60 → tiny`, `> 32 → small`). Two isolate characters per Latin run
move that count and can tip a slide onto a larger step that overflows. This is exactly the class of failure
`probe.overflow` exists to catch — a DOM fact, the half that catches Hebrew type running off the plate at a
size an in-page breakpoint picked for Latin glyph widths. **No new machinery:** the existing `clipped` finding
fires and the existing free re-layout at `08a1b` steps `fontScale` down one. The risk is real, it is measured
on pixels, and it already has a free remedy.

### 7.4 The pixel check that text is not clipped — the existing harness, extended

**No new render step and no new metric.** Two existing measurements already do the whole job on real rendered
PNGs:

1. **Per-run:** `08a1-interest-floor-attempt-N` → `interest-floor.ts` clause B, finding kind `"clipped"`,
   firing on `probe.overflow === true` or `metrics.clippedEdgeShare > CLIPPED_EDGE_SHARE_CEILING`, with a free
   re-layout at `08a1b`/`08a1c`/`08a1d`.
2. **Per-template, at setup:** Template Studio **gate 8** (`gate-8-rtl-and-script-fonts`) renders the **same
   document bytes** with `dir: "rtl"` and a Hebrew seed, and fails on `rtl.probe.overflow`, on
   `textShare <= 0` (tofu, or a face that never loaded) and on `probe.fontFamiliesUsed` containing none of the
   script stack.

Phase 4 gives them **the string shapes it introduces**, which they have never once measured:

- `rtlSeed`'s Hebrew strings gain a **mixed-direction** variant in each of the headline, body and device-label
  seeds: an embedded Latin product name mid-sentence ending in a full stop, a parenthesised Latin term, a
  percentage, and a `2020-2024` range — e.g. `״הדיפלוי של API v2 ירד ב-38% בין 2023-2024״`.
- The seed is passed through `isolateForeignRuns`, so gate 8 measures the bytes a real run will render.
- A template that clips it **fails gate 8 — the template is the bug, the threshold is not.**

## 8. The Opus trap — capped before anything can trip it

`applyClientLanguagePolicy` re-points any `contentLanguageSensitive` step to the cheapest catalogued
same-vendor model rated `multilingual-strong`. In the Anthropic catalog those are **only** the two Opus rows,
both premium (finding 1). Five Instagram steps opt in on a pinned Sonnet: `instagram-copy`,
`instagram-brief`, `instagram-angle`, `instagram-design-brief`, `instagram-template-designer`.

It has not fired because `loadClientContentLanguage` reads only `client/brand.json`'s `language` — null for
exactly the clients this phase targets. **Phase 4 is the phase in which somebody sets `brand.language: "Hebrew"`
for geektime in the portal.** The moment they do, with no code change and no warning:

- `copyAttempt` 0.161 → **0.60** (Opus 5/25 vs Sonnet 3/15 on ~21.5k in / 6.3k out)
- `angle` 0.036 → 0.13, `brief` 0.113 → 0.42
- a 3-attempt Hebrew run ≈ **$2.9**, roughly **2× the hard max**.

**The fix, in `packages/core/src/router/client-model-policy.ts`:**

```ts
/**
 * The most expensive tier a content-language re-point may select (owner's rule,
 * 2026-09-12: no premium-tier model in a routine content run). A vendor whose only
 * capable rows are premium keeps the step's own model and logs — the existing,
 * documented `selected === undefined` path, which was always a degradation and
 * never a failure.
 */
export const CONTENT_LANGUAGE_MAX_COST_TIER: ModelCostTier = "standard";
```

threaded into `satisfies`/`selectModelForContentLanguage` via a `maxCostTier` field on
`ContentLanguageRequirement` defaulting to that constant.

**Why cap rather than delete the flags** (decision 1). Deleting `contentLanguageSensitive` from five Instagram
agents fixes Instagram and leaves the trap armed for every other agent in the repo, and it throws away a
mechanism that would correctly select a future cheap `multilingual-strong` row. The cap is one constant, it
expresses the owner's rule where the rule belongs, and it keeps the flags meaning what they say: *this step
writes reader-facing copy.*

- **Gemini-wired steps: unaffected.** `gemini-2.5-pro` is `standard` and is still selected.
- **Anthropic-wired steps:** keep their own model and emit the existing warn. That warn is now *informative*
  rather than *silent overspend*.
- **Blast radius, named:** `agents/tiktok-agent/src/workflow/create-tiktok-agent-workflow.ts:1840` is the one
  live call site that sets `contentLanguage`. Its `contentLanguageSensitive` steps stop escalating to Opus and
  stay on Sonnet. That is a behaviour change to another agent, **in the direction of the owner's global cost
  rule**, and it must be called out in the PR body. The escape hatch is unchanged:
  `MODEL_STEP_<ID>_VENDOR` / `_MODEL`.

**Do not** wire `ctx.contentLanguage` from 02d. Native-language quality in this agent comes from the writer
directive, the register card, the few-shot and the judge — **not** from a bigger model. The switch is *capped*,
not thrown.

## 9. Cost

Rates: Sonnet 4.6 $3/$15, Gemini 2.5 Pro $1.25/$10, Gemini 2.5 Flash $0.30/$2.50, Haiku 4.5 $1/$5, per 1M
in/out.

### 9.1 Changed and new keys in `STEP_COST_ESTIMATES_USD`

| Key | Before | After | Arithmetic |
|---|---|---|---|
| `copyAttempt` | 0.159 | **0.161** | §23 adds ~2,600 chars ≈ **+700 in-tokens on every run, English too** × $3/1M = **+$0.0021** |
| `copyLanguageBrief` **(new)** | — | **0.009** | the `languageBrief` field, non-English only: persona 60 + register card 450 + terms 180 + conventions 200 + 6 few-shot posts ≈ 2,000 + gate soft tells 110 ≈ **3,000 in-tokens** × $3/1M = **$0.0090** |
| `nativeJudge` **(new)** | — | **0.014** | gemini-2.5-pro. In: rubric 1,500 + register 450 + 4 few-shot 2,000 + draft 1,700 + gate findings 200 + scaffolding 150 = **6,000** × $1.25/1M = $0.0075. Out: ≤8 corrections × ~70 + verdict 90 ≈ **650** × $10/1M = $0.0065. **= $0.0140** |
| round 2 | — | **0.014** | the same call on the patched draft; conditional |
| `fluency` | 0.0055 | **0.0055** | retained as the **`cheapest-path` degraded tier** (Haiku, rubric, no few-shot) |
| `brief` | 0.113 | **0.113** | unchanged — no `instagram-brief` bump (decision 5) |
| `scraperExecution` | 0.007 | 0.007 | unchanged rate; newly **recorded** at `04e` |

`DRAFT_ATTEMPT_ESTIMATE_USD` becomes `0.161 + 0.006 + 0.0041 = 0.1711`. `revisionEstimateUsd` swaps `fluency`
for `nativeJudge` and adds `copyLanguageBrief` plus one round-2 allowance per attempt when `targetLanguage` is
true — the same conditional shape `fluency` already has.

### 9.2 Per attempt, Hebrew

| Line | Before | After, no round 2 | After, with round 2 |
|---|---|---|---|
| `05` copy draft | 0.1590 | 0.1610 | 0.1610 |
| `languageBrief` input | — | 0.0090 | 0.0090 |
| `06` image vet | 0.0060 | 0.0060 | 0.0060 |
| `07g` relevance (Flash) | 0.0020 | 0.0020 | 0.0020 |
| `07e` + `07e2` (`gate.nativeLanguage`) | — | **0.0000** | **0.0000** |
| `07f` judge, round 1 | 0.0055 | 0.0140 | 0.0140 |
| `07f` judge, round 2 | — | — | 0.0140 |
| `08b` visual QA (Flash) | 0.0041 | 0.0041 | 0.0041 |
| `05c` vision, 6 slides × 6 | 0.0360 | 0.0360 | 0.0360 |
| `08a4` vision, 8 slides | 0.0080 | 0.0080 | 0.0080 |
| **attempt total** | **0.2206** | **0.2401** | **0.2541** |

### 9.3 Per run

Fixed block **$0.200** (scout 0.012, scrapes 0.140, extraction 0.0135, angle 0.036), brief reused, `04l` and
`07e2` free, plus **$0.007** for `04e`'s newly-recorded scraper execution.

| Scenario | Before | After | Δ | vs $1.00 target / $1.50 max |
|---|---|---|---|---|
| 1 attempt, clean | 0.421 | 0.447 | +0.027 | ✅ |
| 3 attempts, no round 2 | 0.862 | 0.927 | +0.066 | ✅ under target |
| **3 attempts, round 2 on one (expected Hebrew run)** | 0.862 | **0.941** | **+0.080** | ✅ under target |
| 3 attempts, round 2 on all three (worst case) | 0.862 | 0.969 | +0.108 | ✅ under target |
| worst case + rescue tier (+0.099) | 0.961 | 1.068 | +0.108 | ⚠️ past target → meter goes `essential-only`: no generated images, no rescue re-vets. Under max |
| worst case + brief refresh (+0.176) | 1.038 | 1.145 | +0.108 | ⚠️ past target, under max |
| **worst case + brief refresh + rescue** | 1.137 | **1.244** | +0.108 | ✅ **under the $1.50 hard max** |
| English run, 3 attempts | 0.845 | 0.851 | **+0.006** | ✅ prompt-file growth only; `04l`, `07e2`, the judge, the isolates and the script sheet all skip |

Arithmetic for the headline row: `0.200 + 0.007 + 3 × 0.2401 + 0.0140 = 0.9413`.
Worst case: `0.200 + 0.007 + 3 × 0.2541 = 0.9693`.

**Setup delta: $0.00.** No new setup-time model call. Gate 8's Hebrew seed gains a Latin term, a percent and a
range — the same render, the same one render call it already made. The two setup prompts are untouched.

**The negative line.** §8's cap takes the "somebody sets `brand.language`" run from **~$2.9 to $0.94**.
Nothing else in this phase is worth as much.

**Generated images.** The `GENERATED_IMAGES_PER_RUN_CAP × 0.039` lever is untouched and remains the first thing
the meter turns off at `essential-only`.

### 9.4 The saving the phase is betting on

A redraft attempt costs **$0.2401**. The measured register card, the few-shot, the free `gate.nativeLanguage`
and the in-place correction loop all exist to stop a redraft happening. If they remove one redraft on **one
Hebrew run in four**, that is **−$0.060 per run on average** — larger than the whole Phase 4 delta. **This is
stated as a hypothesis to be measured, not a claim**: `instagramRunBudget` already persists estimate-vs-actual
per run, and the `rounds` count and per-axis verdicts are written to it so the next phase can read whether it
happened.

## 10. What is deliberately NOT built

| Not built | Why |
|---|---|
| **Any Opus step** | Binding owner decision. And the catalog's only non-premium `multilingual-strong` row is rated identically to Opus on both language dimensions, so it is not a compromise. |
| **Waking `ctx.contentLanguage` from 02d** | It is the single switch that turns five Sonnet steps into Opus steps. The competence it would buy is bought instead by the register machinery and by pinning the judge. The switch is capped (§8), not thrown. |
| **A structured `ClientBrief.language.register` and an `instagram-brief@2`** | The register is the same for every Hebrew client; a static pack keyed by script holds it without a schema change that risks `not_available` on every stored brief (finding 10). |
| **A patch to `buildClientVoiceContext`** | `04l` emits the LANGUAGE REQUIREMENT from the **resolved** language, a strict superset of what the patch would produce, for exactly the null-`brand.language` clients it would have helped (finding 12). |
| **A model call for the register card or the persona** | Both are derivable in code from the brief, the profile and the measured corpus. A model call to describe a voice we can measure is $0.04 spent guessing at data we hold. |
| **A second scraper call, a new window, or a bigger `POSTS_PER_ACCOUNT`** | ScrappyCoco only, and the posts are already in `crossChannel.entries`. `research.socialHistory`'s hardcoded 12 / 600 chars stand — they touch every agent that reads social history. |
| **The consent-gated `VisualPatternProfile.sourcePosts` corpus** | Better-ranked text, but consent is usually absent and it is engagement-filtered to `score > 0` — a popularity filter, not a register filter. |
| **A per-string `language` or `script` field on `InstagramSlideCopySchema`** | The judge anchors by slide number + field id + exact quoted span, which needs nothing new on the wire. A new field is a new way for a draft to fail its own output schema. |
| **`<bdi>` markup or a new privileged `{{html:...}}` slot** | Isolates reach model-authored custom archetypes and device labels; markup cannot, and the privileged slot set is closed and gate-enforced. |
| **Any change to `SCRIPT_TYPOGRAPHY`'s scales, leadings or the descender allowance** | Measured in real Chromium in Phase 0. Only the missing `letterSpacing` field is added. |
| **A new render step or a new clipping metric** | `interest-floor.ts` clause B and Studio gate 8 already measure clipping on real pixels with a free re-layout remedy. Phase 4 extends their **inputs**, not their machinery. |
| **A machine-readable Hebrew grammar checker** | No such library is in this repo's dependency set, and adding one to judge idiom would be a vendor decision dressed as a lint rule. The split is: mechanical → `gate.nativeLanguage`; idiomatic → the editor. |
| **Threshold relaxation, anywhere** | `MIN_EXPECTED_SCRIPT_RATIO` 0.3 is kept as the aggregate floor and **tightened per field to 0.6**, not loosened. |
| **A hold anywhere on the language path** | Owner's rule. The one surviving hold, `unresolved-non-english`, is an intake decision at zero model spend and is *reduced* by the new belief, not extended. |

## 11. Tests

Every guard below must be shown to **refuse a broken version of the code** before it is trusted.

| File | Asserts | How it is proven able to fail |
|---|---|---|
| `packages/tools/karos-gates/__tests__/native-language.test.ts` | each of the 11 hard fails individually; soft tells never fail; unknown language → pass with no opinion; a term in `allowedLatinTerms` is not flagged; `scriptPattern: "."` is **refused** | delete one hard-fail rule and watch its case go green |
| `__tests__/target-language.test.ts` (extend) | belief source ranks below an explicit statement and above the prose sniff; a `sniff`-sourced belief is **never** re-read; own-post late adoption; null-`brand.language` → `english-default` with evidence | remove the belief branch → the precedence case fails |
| `__tests__/language-register.test.ts` (new) | per-post script filtering (a bilingual account yields only in-script exemplars); empty corpus → `corpusNote`, no belief written, run continues; the persona renders "editor at Geektime" from profile data alone; a language with no pack gets universal rows only | feed a mixed corpus with the filter disabled |
| `__tests__/native-editor-rubric.test.ts` (new) | all six axis names present in `latest.md`; verdict rule — 2 minors pass, 3 minors fail, any major fails; a finding without a correction is discarded | flip the count to 4 and watch the 3-minor case pass |
| `__tests__/native-corrections.test.ts` (new) | a span must occur exactly once; a replacement over a schema cap is dropped; a replacement in the wrong script is dropped; a patch that breaks `checkCraftHygiene` or the script gate discards **the whole patch** | pass a span occurring twice and assert the copy is unchanged |
| `__tests__/language-compliance-gate.test.ts` (extend) | **two rounds then deliver**: round 1 not native → patch → round 2; round 2 native → ships `corrected`; round 2 not native with attempts left → return to `05` with `nativeSteer`; final attempt → ships `degraded`; **no `WorkflowHeld` on any language path**; judge outage → degraded, never held; `07e` → `07e2` → `07g` → `07f` ordering | make the loop hold at exhaustion and watch the never-held assertion fire |
| `__tests__/script-fonts.test.ts` (extend) | `letterSpacing` emitted for Hebrew and **absent** for a script without the field; an English run's document stays byte-identical; no bundled template or emitted rule carries physical `left`/`right`; **Chromium-gated**: mixed Hebrew+Latin render at **1080×1440** with the shared `synthetic-photograph.ts`, `probe.overflow === false`, `metrics.textShare > 0`, `probe.fontFamiliesUsed` matching Heebo/Assistant, `documentElement.lang === "he"` | remove the letter-spacing emission; and for the clip guard, set Hebrew's `lineHeight.display` to `0.9` and confirm the Chromium case fails on `probe.overflow` — **if it still passes, the fixture is wrong** |
| `__tests__/bidi-isolation.test.ts` (new) | isolates present in the rendered document; **absent** from every published field, from `languageGateFields`, from the dedupe text, from `checkCraftHygiene`'s input and from `sourceRef`; `checkExpectedScript`'s ratio unchanged by their presence; `stat.figure` never wrapped | apply isolation to the caption and watch the published-field assertion fire |
| `__tests__/no-premium-models.test.ts` (new) | no Instagram step resolves to a `premium` model under `contentLanguage: "Hebrew"` or `"he-IL"`; **and** that with `maxCostTier: "premium"` it *does* select Opus | the second case is the anti-tautology — without it the first assertion is vacuous |
| `__tests__/run-budget.test.ts` (extend) | the re-priced keys; `revisionEstimateUsd({ targetLanguage: true })` carries `nativeJudge` + `copyLanguageBrief` + a round-2 allowance; `cheapest-path` degrades the judge to Haiku and **never skips it** | change a constant and watch the arithmetic assertion fail |
| `packages/tools/__tests__/cross-cutting.test.ts` (changed) | registry count **62 → 63** | read the snapshot; do not assert a remembered number |

**Gate to run before the PR:**

```
npm run build && npm run typecheck                      # root
npm test -w @agent-engine/agent-instagram -- --testTimeout=180000
npm test -w @agent-engine/tool-karos-gates
npm test -w @agent-engine/tools                         # registry snapshot 62 -> 63
npm test -w @agent-engine/core                          # model-policy + capability catalog
npm test -w @agent-engine/workflow                      # cross-channel-history
npx tsx scripts/check-prompts.ts                        # registry <-> disk <-> KNOWN_GATES
npm run check:tool-versions                             # gate.nativeLanguage's TOOL_VERSION
```

## 12. What the PR body must carry

- **New step ids** `04l-language-register`, `07e2-native-conventions-attempt-N`,
  `07f-language-fluency-attempt-N-round-2` → `agent-middleware/scripts/generate_engine_stages.py --check`
  must be re-run **after merge**. Do not run it in this worktree.
- **The agent class-id rename** `instagram-language-fluency` → `instagram-native-editor`, its vendor change
  `anthropic` → `gemini`, and the retired Studio `stageModels` key.
- **Prompt bump** `instagram-copy@15 → @16` and **new prompt** `instagram-native-editor@1`, with all checklist
  steps and the `run-budget.ts` re-price in the same commits.
- **The gate-registry count change** 6 → 7 gates, engine tool-registry snapshot **62 → 63**.
- **The TikTok blast radius** of `CONTENT_LANGUAGE_MAX_COST_TIER`: its `contentLanguageSensitive` steps stop
  escalating to Opus and stay on Sonnet.
- **The re-priced `STEP_COST_ESTIMATES_USD` keys** with their arithmetic (§9.1).
- **Local test results as passed N / skipped M**, with the Chromium-gated blocks listed **by name** as skipped.
  CI is the authoritative gate for them.
- **The four break-the-code checks** — the `no-premium-models` anti-tautology, the `gate.nativeLanguage`
  `scriptPattern` refusal, the clip guard at `lineHeight.display: 0.9`, and the never-held assertion — each run
  by hand and each observed to fail before the fix was restored.

---

# Part 3 — As-built notes (P5, the integration slice)

Two places where what shipped differs from Part 2, both recorded here rather than silently absorbed.

## 1. `rawEstimate` prices ONE judge round, `revisionEstimateUsd` prices TWO (§9.1)

§9.1 says `revisionEstimateUsd` "adds … one round-2 allowance per attempt". It does. The PRE-RUN PLANNER
(`estimateRunCost`/`planRunBudget`) does not, and the asymmetry is deliberate and was measured.

The two functions are read at different moments and a wrong number costs something different at each.
`rawEstimate` CHOOSES THE PLAN, before a cent is spent; pricing the conditional second round there takes the
cold Hebrew shape past the point where the image levers can absorb it, fires the attempt lever, and lands the
plan at **$0.75 with `maxSelfCheckAttempts` cut 3 → 2** — the lever overshooting by $0.25 and paying for it
with a whole drafting attempt, on exactly the clients this phase exists to serve. Priced at one round the
same shape plans three attempts at **$0.9998**. `revisionEstimateUsd` only INFORMS the pre-revision check,
which degrades optional work and never refuses the round, so its overshoot costs nothing and its undershoot
would be the estimate flattering itself immediately before the spend.

`__tests__/run-budget.test.ts` pins the asymmetry: if the two ever agree, one of them is wrong.

**The cold Hebrew plan now pulls one more lever than the English plan** — `trend evidence reduced to the one
cached industry query` — because Phase 4 costs $0.069 over three attempts against the $0.048 of headroom the
English plan had left. §9.3's "the same two image steps still absorb it" is not what happens. What does
happen is one cheaper lever firing and all three drafting attempts surviving, which is asserted by name.

## 2. The `cheapest-path` judge degrades its PAYLOAD, not yet its MODEL (§6.5)

The termination table's last row degrades 07f to the Haiku tier at $0.0055. What ships degrades the payload
(no register card, no few-shot) and the round count (round 1 only, no language-driven redraft). The model does
not move: `runNativeEditor` constructs `InstagramNativeEditorAgent` with its own pinned policy and takes no
tier argument.

So **07f meters at `nativeJudge` ($0.014) on both paths.** Booking `fluency` for a call that costs
`nativeJudge` would be the estimate flattering itself by $0.0085 on precisely the runs that have already
crossed the hard max — the one moment the meter's reading has to be right.
`STEP_COST_ESTIMATES_USD.fluency` is retained, priced and asserted, so the tier is not lost; it becomes true
the moment `runNativeEditor` accepts a tier argument.

The invariant that matters is unaffected: **the judge is never skipped.**
