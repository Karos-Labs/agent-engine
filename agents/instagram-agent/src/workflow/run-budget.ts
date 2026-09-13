/**
 * Phase 0 cost controls — the owner's per-run budget (target $1.00, hard max
 * $1.50) as an ADAPTIVE plan, never a hold.
 *
 * The owner's rule (2026-09-09 amendment, binding): estimate before the run;
 * if the estimate would exceed the target, do NOT fail — adapt the plan to
 * fit, run, and deliver. If the estimate was low and the run still overran,
 * do NOT fail or throw the result away — finish on the cheapest path that
 * still yields a complete deliverable, deliver, and learn so the next run
 * stays under. A limit never breaks a run and never counts as a defect.
 *
 * Three pieces, all pure (no I/O, no clock of their own, no checkpoint):
 *
 *   1. The PLAN (`planRunBudget`) — estimated from the per-step cost table
 *      below × what the plan allows (attempts, generated images, evidence
 *      pulls, optional re-vets) × a per-client calibration learned from past
 *      runs (`RunBudgetHistory`: EWMA of actual/estimate). Over the target,
 *      the levers are pulled IN ORDER until it fits: cap generated images
 *      (tier-0/stock first, then text-only), evidence pulls down to the one
 *      most-cacheable query, optional re-vets off, self-check returns
 *      2 -> 1. Every adaptation is a run note the reviewer sees.
 *
 *      The last two rungs were SWAPPED in Phase 5 (RFC-18 §7.3): optional
 *      work is given up before a drafting attempt is, because an attempt is
 *      what every quality gate in this workflow returns into and a rescue
 *      re-vet is optional by its own name. See `planRunBudget`.
 *   2. The METER (`RunSpendMeter`) — `max(measured, estimate)` per step
 *      (a Gemini-on-Vertex step may report $0; spec §0), consulted at every
 *      OPTIONAL spend point. Over the target: stop optional work (no more
 *      generated images, no rescue re-vets). Over the hard max: cheapest
 *      path — text-only downgrade for gaps, skip vision inspection and the
 *      optional visual-QA model call — and deliver. The mandatory gates
 *      (self-check, craft hygiene, language, relevance) are never skipped.
 *   3. The LEARNING (`recordRunInHistory`) — per client, per run: estimate,
 *      actual, breakdown, adaptations, whether the target/max was crossed.
 *      The next run's plan starts tighter after an overrun and relaxes again
 *      after two runs under target.
 *
 * Pricing: Sonnet 4.6 $3/$15, Gemini 2.5 Flash $0.30/$2.50, Haiku 4.5 $1/$5
 * per 1M tokens; `gemini-2.5-flash-image` $0.039/image; ScrappyCoco
 * $0.007/execution (`scrappycoco.ts` header).
 */

/** Generated images per RUN (all attempts, all revisions) at the widest plan — `remainingGenerationBudget` is the budget left for the next `generate` tier call. */
export const GENERATED_IMAGES_PER_RUN_CAP = 8;

/**
 * Candidates the harvester returns per photo slide — `media.findImages`'s
 * `maxPerNeed`, which the workflow now passes EXPLICITLY at `05b` from this
 * constant.
 *
 * One owned number because two consumers must agree on it: `05b` asks for
 * this many candidates per slide, and `05c` pays a vision inspection for
 * every candidate in the pool it produced. The estimator used to price 05c at
 * one image per photo slide while the tool's own schema default handed it six
 * — a 6x under-count of the second-largest per-attempt cost, which made the
 * pre-run estimate report a run as fitting the $1.00 target when it billed
 * over it, and so skipped the adaptation the estimate exists to trigger.
 * Change it here and both the plan and the run change together.
 */
export const CANDIDATES_PER_PHOTO_SLIDE = 6;

/** The owner's target per Instagram run: the number the pre-run plan is fitted to. */
export const TARGET_RUN_SPEND_USD = 1.0;

/** The owner's hard max per Instagram run: crossing it switches the live meter to the cheapest complete path. Never a hold. */
export const MAX_RUN_SPEND_USD = 1.5;

/**
 * Per-unit estimates the meter falls back to when a step reports no cost (or
 * under-reports), and the pre-run estimator multiplies by the plan. Keys name
 * the unit: `copyAttempt` is one Sonnet copy draft at the `instagram-copy@15`
 * input size; `generatedImage` and `scraperExecution` are billed per unit,
 * not per step; `angle` and `brief` are Phase 1's Sonnet steps, priced into
 * `rawEstimate` through `RunShape.angleRounds` and `RunShape.briefRefresh`.
 *
 * **These numbers must track the prompts.** A price left at the previous
 * prompt's size is the same defect `CANDIDATES_PER_PHOTO_SLIDE` documents
 * below: an estimate that flatters itself pulls no lever, so the plan the
 * planner chooses is not the plan the run can afford. Every prompt bump that
 * changes a step's input size re-prices its key here in the same commit.
 */
export const STEP_COST_ESTIMATES_USD = {
  /**
   * Sonnet, ~26.34k in / ~6.31k out, one draft of copy: $0.0790 in + $0.0947
   * out at $3/$15 per 1M = $0.1737, entered as **0.174**.
   *
   * ## Phase 5 (`instagram-copy@16` → `@17`), BOTH SIDES, STATED SEPARATELY
   *
   * The house rule this file keeps re-learning is that a prompt bump is priced
   * on the input half AND the output half, each named on its own line. The
   * @13 → @14 note below records what happens otherwise: that bump was priced
   * on input alone and under-counted the real growth by roughly nine tenths,
   * because on Sonnet an output token costs 5x an input one. So:
   *
   * **Input** (≈+4,075 tokens, **+$0.0122**): the prompt goes 45,757 →
   * 62,057 characters, **+16,300** (measured 2026-09-13 on the shipped files
   * with line endings normalised; `instagram-copy-agent.ts`'s own note counts
   * the same two files as 46,539 → 63,056 under a different convention, and
   * the two agree on the delta to within 300 characters and on this key to the
   * third decimal) — §24 (value: the payload and the named specific, carrying
   * `gate.lintPost`'s banned-CTA bank verbatim), §25 (take a position), §26
   * (rhythm), §27 (the source's prose is not yours), §16's `valueSteer`
   * paragraph, §2's rewrite of the caption into hook / body / CTA, §3's
   * payload-driven slide count and §5's one-claim-plus-consequence rewrite.
   * 16,300 chars / 4 ≈ 4,075 tokens x $3/1M = $0.012225.
   *
   * **Output** (≈+10 tokens, **+$0.00015**): exactly one new field,
   * `payloadKind`, an enum of eight short literals, optional and with NO
   * code-side default. §§24-27 change how the draft READS and what its
   * slide count is FOR; they do not ask for another per-slide object. §3.2 of
   * RFC-18 declines a per-slide `soWhat` field for precisely this reason — it
   * would have been ≈+250 output tokens on every attempt, ≈+$0.0038, i.e. 25x
   * the whole output delta priced here — and puts the so-what in the body where
   * a reader sees it and the value judge checks it.
   *
   * **Total +$0.0124 an attempt**, +$0.0371 over a three-attempt run. Entered
   * as 0.174 against an exact $0.17366, so the three-decimal table OVER-counts
   * by $0.00035 an attempt. That direction is the safe one and is stated
   * rather than waved at: this file's header says an estimate that flatters
   * itself pulls no lever.
   *
   * @17 was measured three times while this was written and moved twice, by
   * tens of characters, because the prompt is under active editing. The test
   * therefore asserts a BAND (16,150-16,700 characters) rather than one count:
   * everywhere in it, 0.174 is both the correct rounding and at-or-above the
   * real call. ±300 characters is editorial noise and cannot move a
   * three-decimal key; 5,000 is a section, and the test refuses that.
   *
   * ## WHY THIS IS 0.174 AND NOT RFC-18 §7.1's 0.166
   *
   * RFC-18 §7.1 priced this bump at **0.166**, from an estimate of "+6,000
   * characters" made while the RFC was being written and before @17 existed.
   * The file that shipped is **+16,300**, nearly three times the estimate,
   * because §§24-27 landed as full worked sections and §16's steer, §2's
   * caption rewrite, §3's slide-count rule and §5's rewrite all grew with them.
   * Priced at the RFC's figure this key would under-count by **$0.0078 an
   * attempt, $0.023 a run** — forty times the $0.0002 of headroom whose loss
   * Phase 4 considered serious enough to defer `vetCall`'s re-price over an
   * entire phase, and larger than Phase 5's whole English planner delta.
   *
   * So the key is priced against the FILE, not against the RFC's forecast of
   * the file. That IS the house rule, stated one paragraph up and re-learned at
   * @14 and again at @15: a bump is priced on what the call bills. Pricing a
   * bump against the estimate rather than against the shipped prompt is the
   * @14→@15 error wearing different clothes, and it is the error this comment
   * block exists to stop. `instagram-copy-agent.ts`'s @17 note reaches the same
   * figure independently from its own measurement of the same two files.
   *
   * This is a re-price, not a scope change: the plan still fits (`__tests__/run-budget.test.ts`
   * pins the cold English and cold Hebrew landings), the rung swap below still
   * absorbs it, and the cold Hebrew shape still keeps all three attempts.
   *
   * If @17 is edited again, RE-MEASURE. The characters are the price.
   *
   * **No Opus.** This key stays a `claude-sonnet-4-6` price. The owner's plan
   * asked for the writer to "move to a stronger model"; the owner's later
   * amendment forbids Opus in a run, and the arithmetic agrees: the identical
   * call on `claude-opus-4-8` ($5/$25 per 1M) is $0.2765 an attempt, $0.83
   * across three — 83% of the $1.00 target before the post has an image.
   * Phase 5 buys better writing with PROMPT and RUBRIC quality inside this
   * key, not with a bigger model.
   *
   * ## Phase 4 (`instagram-copy@15` → `@16`), input-only and paid on EVERY run
   *
   * **Input** (≈+760 tokens, ≈+$0.0023): the prompt went 43,519 → 46,539
   * characters — §23 "Writing in the target language as a native" (≈2,200),
   * §16's `nativeSteer` paragraph (≈480) and §1's demotion header (≈340).
   *
   * **Output: unchanged.** §23 changes how the copy READS, not how much of it
   * there is: no new output field, no new per-slide object, no new per-slide
   * anything. This is the first re-price in this file's history where the
   * input half is the whole delta, and it is stated that way on purpose,
   * because the @14→@15 note below records the same mistake being made in the
   * opposite direction — an output-heavy bump priced on input alone.
   *
   * At @16 the table's three decimals entered $0.1613 as $0.161, so the key
   * UNDER-counted by $0.0003 an attempt. Phase 5's re-price above ends that:
   * $0.17366 rounds up to 0.174 and the rounding error changes sign.
   *
   * The +$0.0023 is paid on English runs too: the prompt file is one file and
   * every draft carries all of it. What English runs do NOT pay is
   * `copyLanguageBrief` — the `languageBrief` FIELD is conditional on a
   * resolved `targetLanguage`, the prompt section is not.
   *
   * ## Phase 3 (`instagram-copy@14` → `@15`), and why the output moved again
   *
   * **Input** (≈+455 tokens, ≈+$0.0014): the prompt went 41,727 → 43,549
   * characters — §22 (the scene brief and the source choice) and §6's
   * rewrite around it.
   *
   * **Output** (≈+800 tokens, ≈+$0.012), which is again the larger half.
   * §22 replaces a ~12-word `visualNeed` STRING with an object carrying four
   * keys on EVERY slide: `scene` (≤240 chars), `why` (≤200 chars), `source`,
   * and two to four `searchTerms`. That is ≈115-130 output tokens a slide
   * against ≈18 before, so ≈+100-115 per slide and ≈+800 across an
   * eight-slide draft.
   *
   * The agent-side note on `instagram-copy-agent.ts` counted only the input
   * half at first, which is the same mistake @13 → @14 made: on Sonnet an
   * output token costs 5x an input one, so an input-only re-price
   * under-counts a prompt that asks for MORE STRUCTURE by roughly nine
   * tenths of the real growth. Over three attempts the difference between
   * $0.1455 and $0.159 is $0.0405 — most of an image-cap step.
   *
   * ## Phase 2 (`@13` → `@14`), kept because the arithmetic composes
   *
   * Phase 2 grew this call on BOTH sides, and the output side is the larger
   * of the two — which is the half an input-only re-price missed, because on
   * Sonnet an output token costs 5x an input one.
   *
   * **Input** (≈+1.55k, ≈+$0.005): the prompt went from 33.9k to 40.0k
   * characters (`instagram-copy@14` — the eight archetypes, §19 devices, §20
   * the custom-archetype licence, §21 the skeleton avoid-list), ≈+1.4k
   * tokens, and every attempt now also carries `recentSkeletons` +
   * `skeletonRule` (item P, ≈+150).
   *
   * **Output** (≈+2.0k, ≈+$0.030), which is where the money is:
   *
   * * §20 turned `customArchetype` from "a rare tool" (@13) into "author the
   *   layout yourself … **At most two per carousel**" (@14). Each authored
   *   layout is a `bodyHtml` fragment PLUS a `css` block for the fixed
   *   1080x1440 canvas, with the token block, logical properties and slot
   *   list @14 spells out — ≈900-1800 output tokens each, so up to ≈3.6k for
   *   the two the prompt permits.
   * * §19 ("the post's key figure MUST get a device") adds a `device` object
   *   on top, ≈100-200 tokens per device.
   *
   * ~5.5k out is one authored layout plus devices as the expected draft,
   * rather than the ~7k worst case: the estimator's job is to arm the right
   * lever before the money is spent, and pricing every attempt at two
   * authored layouts would pull an image lever on the majority of runs that
   * author none. The live meter's posture and `ewmaRatio` close the rest.
   *
   * **These numbers must describe the call `instagram-copy@15` actually
   * makes.** At 3 attempts the difference between 0.126 and 0.15 is $0.072 —
   * more than the whole first image lever — and an estimate that flatters
   * itself pulls no lever, so the plan the planner chooses is not the plan
   * the run can afford (`__tests__/run-budget.test.ts` pins the arithmetic).
   */
  copyAttempt: 0.174,
  /**
   * Phase 4 — the `languageBrief` input FIELD on `05-write-copy-attempt-N`,
   * added per attempt on non-English runs only (the same conditional shape
   * `fluency` has at :234 and :532, and now `nativeJudge` has).
   *
   * ~3,000 in-tokens x $3/1M = **$0.0090**: persona 60 + register card 450 +
   * term policy 180 + convention pack 200 + six few-shot posts at up to 400
   * chars ≈ 2,000 + `gate.nativeLanguage`'s soft tells 110.
   *
   * Input only, and no output delta: the brief tells the writer HOW to
   * sound, not to write more. Separate from `copyAttempt` rather than folded
   * into it because an English run must not be charged for a field its
   * payload does not carry — folding it in would flatter the English plan by
   * nothing and over-state it by $0.027 over three attempts, which is enough
   * to pull an image lever that did not need pulling.
   */
  copyLanguageBrief: 0.009,
  /**
   * Flash image vet — the 06 call or one rescue-tier re-vet.
   *
   * ## Phase 5: the deferred re-price, 0.006 → 0.0065, landing WITH the rung swap
   *
   * `instagram-image-vet@4 → @5` grew the prompt 13,705 → 18,802 chars. §1c is
   * plain markdown in a STATIC system prompt, and its own first line — "read
   * this section only when `conceptual` is present" — is an instruction to the
   * MODEL, not a conditional include, so EVERY vet call pays its ≈ +1,275 input
   * tokens: ordinary runs included, not just the minority the concept mode
   * fires on. At $0.30/1M input (`pricing.ts:65`) that is ≈ +$0.00038 a call.
   * The vet is metered at up to nine calls a run (one per attempt plus two
   * rescue re-vets per attempt), so the honest key is **0.0065** and Phase 4's
   * 0.006 really did under-count the run by ≈ $0.0045.
   *
   * Phase 4 measured the re-price and DECLINED it, for a reason that was
   * correct at the time and is recorded here because the fix is what removed
   * it: a cold HEBREW run sat $0.0002 under target at the bottom of the ladder
   * ($0.9998), adding $0.0045 took it to $1.0043, and the next rung down was
   * the ATTEMPT lever — `maxSelfCheckAttempts` 3 → 2. `language-compliance-gate.test.ts`
   * then produced runs with `status: "held"` and the reason "the run budget
   * plan allowed one return instead of two", INCLUDING the two cases named
   * "NEVER holds". A budget-caused hold is forbidden outright by the owner's
   * 2026-09-09 amendment, so an under-estimate was the cheaper defect and the
   * re-price was deferred to "a follow-up that lands WITH the rung-order
   * change".
   *
   * **This is that commit.** RFC-18 §7.3 swaps the last two rungs: optional
   * rescue re-vets now go off BEFORE a drafting attempt is given up. On the
   * cold default shape (six photo slides, three attempts) that rung is worth
   * `3 × (3 × $0.007 + 2 × $0.0065)` = $0.102 of rescue plus `07i1`'s $0.007
   * verification = **$0.109 of headroom**, where the attempt lever used to be
   * fired to recover $0.0002. The reachable held case is therefore REMOVED,
   * not merely avoided: the cold Hebrew plan carries Phase 5's whole +$0.043
   * AND @17's measured +$0.0124 an attempt AND this re-price AND the
   * `nativeJudge` re-price below ($0.014 -> $0.018, the first time that prompt
   * was measured against the file rather than forecast), and still lands at
   * **$0.9773** with all three attempts intact — **$0.0227 under the $1.00
   * target**. `__tests__/run-budget.test.ts:468` pins that figure, and
   * `:470-485` is where the headroom is read honestly rather than celebrated.
   * (These two numbers were $0.9623 and $0.038 before `nativeJudge` moved; the
   * test and RFC-18 §§7.1/7.4 were corrected and this comment was not, which is
   * a file carrying a number its own test contradicts.)
   *
   * The deeper finding the Phase 4 note named — "the real finding underneath
   * is that the attempt lever can produce a held run at all" — is what §7.3
   * acts on. The lever still exists and still floors at 2; what changed is
   * that every cheaper thing is now spent first, so no judgment gate in this
   * workflow can be starved into a hold by a budget decision.
   */
  vetCall: 0.0065,
  /** Flash vision inspection, per image (05c candidate batches, 08a4 rendered slides). */
  visionInspectPerImage: 0.001,
  /** Flash relevance judge (07g), ~4k in / 0.3k out. */
  relevance: 0.002,
  /**
   * Phase 5 (RFC-18 §5) — the VALUE judge (`07j-value-judge-attempt-N`),
   * `gemini-2.5-flash`, once per attempt in every language.
   *
   * In: rubric 1,700 + `briefForPrompt` 600 + the post (caption + 8 headlines
   * and bodies) 1,700 + fact-card digest 800 + scaffolding 300 = **5,100**
   * x $0.30/1M = $0.00153. Out: 4 axis verdicts + 4 verbatim quotes + the
   * three index-aligned fix arrays + `keepLine` ≈ **500** x $2.50/1M =
   * $0.00125. **= $0.00278, entered as 0.003.**
   *
   * ## Why this is the cheapest tier and not a better model
   *
   * NO OPUS, per the owner's rule, and not Gemini 2.5 Pro either. Pro would be
   * $0.014 an attempt — $0.042 across a three-attempt run, fourteen times this
   * — and what it would buy is TASTE. The rubric is built so taste is not
   * needed: every axis asks the judge to FIND AND QUOTE a span that satisfies
   * a written test, `normaliseValueVerdict` re-checks the span against the
   * draft IN CODE, and `decideValue` computes the bar in the repository. That
   * is extraction, which is what Flash is good at, rather than judgment, which
   * is what it is bad at (`relevance-gate.ts:50-54` already records Flash's
   * tendency to award a competent 4/5 to generic copy — the exact copy this
   * gate exists to refuse).
   *
   * `contentLanguageSensitive` is deliberately NOT set on this judge, the same
   * way it is not set on `instagram-relevance-judge`: otherwise
   * `applyClientLanguagePolicy` would silently re-point it at a
   * multilingual-strong row and add ~$0.011 to every Hebrew attempt for a
   * nuance this judge is explicitly told not to rule on.
   *
   * If rubric-v1 telemetry shows Flash passing drafts the reviewer then
   * rejects, the escape is one line in `resolveModelPolicy` plus a re-price
   * here, and `VALUE_RUBRIC_VERSION` says which era the data came from.
   */
  valueJudge: 0.003,
  /**
   * Phase 4 — the native editor (07f), `gemini-2.5-pro`, non-English targets
   * only, once per attempt and again for round 2 when round 1 proposed
   * corrections.
   *
   * ## Phase 5 re-price, 0.014 -> 0.018, and a standing error corrected with it
   *
   * The old line read "rubric 1,500". **`instagram-native-editor@1` is 13,109
   * characters — 3,277 tokens.** The rubric line has under-counted by 1,777
   * tokens ($0.0022 a call) since Phase 4 shipped it; it was never measured
   * against the file. That is the same error `copyAttempt` records at @14->@15
   * and again at @17: a prompt priced from a forecast rather than from disk.
   * Corrected here rather than carried, because this file's own header says an
   * estimate that flatters itself pulls no lever.
   *
   * On top of it, `@2` (RFC-18 §6.5) adds the post-package round's target
   * vocabulary: **16,573 chars = 4,143 tokens**, +866 over @1. Output is
   * unchanged — no new schema field, same 12-correction cap.
   *
   * In: rubric **4,143** (measured, LF-normalised) + register card 450 + 4
   * few-shot posts 2,000 + the draft 1,700 + `gate.nativeLanguage`'s findings
   * 200 + scaffolding 150 = **8,643** x $1.25/1M = $0.01080. Out: up to 8
   * corrections at ~70 tokens each + the verdict 90 ≈ **650** x $10/1M =
   * $0.0065. **= $0.01730, entered as 0.018** — rounded UP, the only direction
   * this table may round.
   *
   * It replaces a $0.0055 Haiku call — +$0.0085 an attempt — and the trade is
   * against $0.2401, the cost of the redraft a wrong verdict causes. Gemini
   * 2.5 Pro is the CHEAPEST non-premium row in `model-capabilities.ts` rated
   * `multilingual-strong` + `rtlSupport: "strong"` (`gemini-3.1-pro-preview`
   * also qualifies, at $2/$12); Haiku 4.5, which has been
   * judging Hebrew nativeness since Phase 0, is rated `basic` on both.
   */
  nativeJudge: 0.018,
  /**
   * Haiku fluency judge, ~4k in / 0.3k out, non-English targets only.
   *
   * Phase 4 keeps this key at its Phase 0 price as the `cheapest-path`
   * DEGRADED TIER of `nativeJudge` (RFC-15 §6.5): past the hard max, 07f is
   * meant to run the rubric on Haiku with no few-shot, round 1 only. **The
   * judge is never skipped** — budget degrades the TIER, it does not remove a
   * mandatory gate for a non-English client.
   *
   * NOT YET REACHABLE, and the key is kept rather than deleted for that
   * reason. `runNativeEditor` builds `InstagramNativeEditorAgent` with its own
   * pinned policy and takes no tier argument, so what the workflow can
   * currently degrade on the cheapest path is the PAYLOAD (no register card,
   * no few-shot) and the round count, not the model. 07f therefore meters at
   * `nativeJudge` on both paths — see the note at its call site. When
   * `runNativeEditor` accepts a tier, this is the number that becomes true.
   */
  fluency: 0.0055,
  /**
   * Flash visual QA (08b), ~5.5k in / 1k out.
   *
   * `instagram-visual-qa` went 3 → 4 in this phase (6,655 → 8,686
   * characters: the interest-floor residue and the cross-post rhythm
   * question), and the step's input gained `previousSkeleton`/`thisSkeleton`.
   * Small in absolute terms, re-priced for the same reason `copyAttempt` is.
   */
  visualQa: 0.0041,
  /**
   * Phase 5 (RFC-18 §6.1) — the WHOLE-POST packager (`08c-package-post`),
   * `gemini-2.5-flash`, **once per revision**, after the drafting loop breaks:
   * 3-5 bare hashtags, one alt text per slide, and the first comment's prose.
   *
   * In: shipped slides 1,700 + caption 300 + `briefForPrompt` 600 + register
   * card 450 + fact cards 800 + `languageBrief.terms` 200 + instructions 1,250
   * = **5,300** x $0.30/1M = $0.00159. Out: hashtags 40 + alt text 8 x 45 +
   * first comment 120 + scaffolding 40 = **560** x $2.50/1M = $0.0014.
   * **= $0.00299, entered as 0.003.**
   *
   * ## Why once per revision, and why not on the writer
   *
   * Authoring these fields at `05` instead would be ≈ +520 output tokens on
   * EVERY attempt — ≈ $0.008 x 3 = $0.023 a run at Sonnet's $15/1M, most of it
   * spent on drafts a redraft throws away. One Flash call after the loop is
   * $0.003 once: **8x cheaper**, and more correct — alt text for a slide
   * attempt 2 is about to replace is money burned.
   *
   * Priced in `fixed`, not in `perAttempt`, for exactly that reason. No Opus:
   * this step writes short, highly constrained strings against deterministic
   * checks (`08c1` re-checks the hashtag grammar, the coreTerm requirement,
   * the alt-text length and the URL bans in code), which is the cheapest tier's
   * best case, not its worst.
   *
   * Fail-open and free to lose: a packager that does not complete leaves
   * `post: undefined`, writes one ledger warn and the carousel ships exactly as
   * it does today. There is no state in which $0.003 costs us the post.
   */
  postPackage: 0.003,
  /**
   * Phase 5 (RFC-18 §6.1) — the native round over the PACKAGE
   * (`08c2-package-native-round`), `gemini-2.5-pro`, non-English targets only,
   * once per revision.
   *
   * In: rubric **4,143** + register card 450 + the package's prose 600 +
   * scaffolding 150 = **5,343** x $1.25/1M = $0.00668. Out: up to 6
   * corrections x 70 + the verdict 90 = **510** x $10/1M = $0.0051.
   * **= $0.01178, entered as 0.012** — rounded UP rather than to nearest,
   * which is the only direction a three-decimal table may round in a file
   * whose header says an estimate that flatters itself pulls no lever.
   *
   * Re-priced from 0.009 in the same commit as `nativeJudge` and for the same
   * two reasons: the shared "rubric 1,500" line was never measured against the
   * file (@1 is 3,277 tokens), and `@2` adds 866 more. This key carries the
   * FULL prompt exactly as `nativeJudge` does — the rubric is not the part that
   * differs between the two rounds.
   *
   * ## Why it is cheaper than `nativeJudge` ($0.018) on the same model
   *
   * **No few-shot, and a much shorter draft.** `nativeJudge` carries four of
   * the client's own recent posts (≈2,000 tokens) because it is judging
   * whether a whole draft SOUNDS like this account. This round judges an alt
   * text and a first comment — short, functional prose whose register was
   * already settled on the copy the package was derived from. The gap is
   * 3,300 tokens: few-shot 2,000, plus the carousel draft 1,700 against the
   * package's 600, plus 200 of soft tells this round is not given. That is
   * where the $0.006 goes.
   *
   * Note what is NOT in the gap: the rubric. Both rounds are the same agent on
   * the same prompt file, so @2's 4,143 tokens are paid twice over on a Hebrew
   * run and the two keys move together whenever it is bumped. Before this
   * commit both derivations said "rubric 1,500" and both were wrong by the
   * same 1,777 tokens — one mis-measurement, two under-counts.
   *
   * Same model as `nativeJudge` rather than a cheaper one: Hebrew is
   * first-class here, and `gemini-2.5-pro` is the CHEAPEST row in
   * `model-capabilities.ts` rated `multilingual-strong` + `rtlSupport:
   * "strong"`. Haiku 4.5 is rated `basic` on both and is what this repo used to
   * judge Hebrew with. No Opus: `claude-opus-4-8` ($5/$25) on the identical
   * call is $0.0263, three times this, for a six-correction pass over two
   * paragraphs.
   *
   * Booked in `fixed` and only when `shape.targetLanguage` — an English run's
   * package is never sent to it, and pricing it unconditionally would
   * over-state every English plan by $0.009 and pull an image lever that did
   * not need pulling.
   */
  packageNativeJudge: 0.012,
  /**
   * Flash trend scout (03c), ~18k in / 2.5k out.
   *
   * Phase 1 (item I) widened this call's input: the four other topic engines'
   * signals and the Client Brief now travel with the news digest, so the
   * Phase 0 figure ($0.009 at 12k/2k) prices a call this workflow no longer
   * makes.
   */
  scout: 0.012,
  /**
   * Flash research extraction (04b), ~20k in / 3k out.
   *
   * Phase 1 (item J) feeds it the merged multi-lane pull (up to 16 documents
   * at up to 6000 chars each) and asks for 12-24 fact cards, against Phase
   * 0's ~5k in / 1.5k out.
   */
  extraction: 0.0135,
  /** `gemini-2.5-flash-image`, per generated picture. */
  generatedImage: 0.039,
  /** ScrappyCoco, per `web.search_web` execution (`scrappycoco.ts` header). Cached pulls cost nothing and must not be added. */
  scraperExecution: 0.007,
  /** Phase 1 — Sonnet angle proposal (04i), ~8k in / 0.8k out, once per revision. */
  angle: 0.036,
  /** Phase 1 — Sonnet client brief (00b2), ~25k in / 2.5k out, at most once per 30 days. */
  brief: 0.113,
  /**
   * Phase 4 — Sonnet concept design (`04n-design-concept`), ~6.2k in / ~0.65k
   * out, at most once per revision and only on a run the selector found
   * eligible: 6,200 × $3/1M + 650 × $15/1M = $0.0186 + $0.00975 = $0.0284,
   * priced 0.029.
   *
   * **Why Sonnet and not Flash ($0.0033).** The same reason the art director
   * is Sonnet: this is the one call in the run that is pure judgment, it fires
   * on at most a quarter of runs, and a flat concept is worse than no concept
   * — it spends a $0.039 image on a picture nobody decodes. No Opus, per the
   * owner's rule.
   *
   * The concept's IMAGE is not priced here: it is already inside
   * `plan.generatedImagesCap * c.generatedImage` in `rawEstimate`, and adding
   * it again would be the mirror of the flattering estimate this table warns
   * about — an over-count pulls a lever the run did not need.
   */
  concept: 0.029,
} as const;

export type StepCostKey = keyof typeof STEP_COST_ESTIMATES_USD;

/**
 * What one more drafting attempt is expected to cost before it is started:
 * the copy draft, its image vet and its visual QA — the three paid steps
 * every attempt pays regardless of language or image tier. Reported on the
 * gate payload so a reviewer knows roughly what a `revise` costs.
 */
export const DRAFT_ATTEMPT_ESTIMATE_USD = STEP_COST_ESTIMATES_USD.copyAttempt + STEP_COST_ESTIMATES_USD.vetCall + STEP_COST_ESTIMATES_USD.visualQa;

/** One recorded line of spend — what it was for, what counted, and why that figure won. */
export interface SpendLine {
  label: string;
  /** The amount that counts toward the total: `max(measuredUsd ?? 0, estimateUsd)`. */
  usd: number;
  /** The vendor-reported figure when one was usable; absent when the step reported nothing, zero or a non-finite value. */
  measuredUsd?: number;
  estimateUsd: number;
  /** Which of the two the line counted at. */
  basis: "measured" | "estimate";
}

/** Sums of dollar amounts are rounded to micro-dollars so a gate payload never shows `0.30000000000000004` and a threshold comparison never turns on a float artefact. */
export function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * What one REVISION ROUND is expected to cost before it starts (Phase 1,
 * item K): the angle proposal plus the attempts it drafts under.
 *
 * A revision is not "one more attempt": a reviewer's `revise` re-enters
 * `draftOnce`, which proposes a fresh angle at `04i` (once per revision,
 * outside the attempt loop — `instagram-angle-agent.ts`) and then drafts up
 * to `plan.maxSelfCheckAttempts` times. Pricing a revision as one attempt
 * under-counts it by the whole Sonnet angle call, which is the single
 * largest per-revision line after the copy draft itself, and an estimate
 * that flatters itself pulls no lever.
 *
 * Read by the pre-revision check the way `DRAFT_ATTEMPT_ESTIMATE_USD` is
 * read before an attempt. Note what the meter does with it: crossing a
 * threshold degrades OPTIONAL work and never refuses the round (owner's
 * amendment, 2026-09-09) — a reviewer who asks for a change gets it, on the
 * cheapest complete path if the money has run out.
 */
export function revisionEstimateUsd(input: { attempts?: number; targetLanguage?: boolean; angle?: boolean } = {}): number {
  const attempts = Number.isFinite(input.attempts) ? Math.max(1, Math.floor(input.attempts!)) : 1;
  // Phase 4 — a non-English attempt now carries three language lines, not one: the `languageBrief` field on
  // the draft, and the native editor TWICE. The second judge round is priced on every non-English attempt
  // rather than on the fraction that actually redrafts, because this figure is read BEFORE the round starts
  // and must be the number the round could cost, not the number it usually does. `fluency` is no longer in
  // this sum — it is the `cheapest-path` tier the live meter substitutes, and a pre-spend estimate that
  // assumed the degraded tier would be the estimate flattering itself that this file's header warns about.
  const language = input.targetLanguage === true ? STEP_COST_ESTIMATES_USD.copyLanguageBrief + 2 * STEP_COST_ESTIMATES_USD.nativeJudge : 0;
  // Phase 5 — the value judge is paid on every attempt of a revision round too: a reviewer's `revise`
  // re-enters `draftOnce`, and `07j` sits inside the attempt loop it re-enters. $0.003 x 3 attempts is
  // $0.009, which is under the rounding of this quote — and it is added anyway, because the rule this file
  // keeps is that a quote read immediately before the spend may never be the cheap version of the truth.
  const perAttempt = DRAFT_ATTEMPT_ESTIMATE_USD + STEP_COST_ESTIMATES_USD.relevance + STEP_COST_ESTIMATES_USD.valueJudge + language;
  return roundUsd((input.angle === false ? 0 : STEP_COST_ESTIMATES_USD.angle) + attempts * perAttempt);
}

/** The floor of a revision round: one angle proposal and one drafting attempt on an English-language client. */
export const PER_REVISION_ESTIMATE_USD = revisionEstimateUsd();

/**
 * How the live meter wants the rest of the run spent.
 *
 * - `normal`: under the target — the plan runs as adapted.
 * - `essential-only`: the target is crossed — no more generated images, no
 *   rescue re-vets; every mandatory gate still runs.
 * - `cheapest-path`: the hard max is crossed — additionally no vision
 *   inspection and no optional visual-QA model call; gaps go text-only. The
 *   run still delivers a complete carousel, marked `degraded` with the reason.
 */
export type SpendPosture = "normal" | "essential-only" | "cheapest-path";

/**
 * The running spend for one run. Plain object, recreated on every workflow
 * invocation (a resume re-adds the lines from checkpointed step outputs);
 * never serialised as a checkpoint of its own.
 */
/**
 * The two numbers a meter postures against, plus what to call itself.
 *
 * Exists because Phase 2 added a SECOND budget with the same machinery and
 * different numbers: the per-client setup spend (item N — target $2.00, hard
 * max $3.00), which must never be mixed into the per-run meter that `02j`
 * reads. One optional constructor argument was the whole change: `canAfford`,
 * `crossedTarget`, `crossedMax` and the two notes used to read the module
 * constants directly, so a setup meter would have reported a $2.40 setup as
 * "over the hard max" of a run it has nothing to do with.
 */
export interface SpendMeterLimits {
  /** Defaults to `TARGET_RUN_SPEND_USD`. */
  targetUsd?: number;
  /** Defaults to `MAX_RUN_SPEND_USD`. */
  maxUsd?: number;
  /** What the notes call this budget ("run", "setup"). Reads as "per-run ceiling" / "per-setup ceiling". */
  scope?: string;
}

export class RunSpendMeter {
  private readonly entries: SpendLine[] = [];

  /** The target this meter postures against — the run's by default, the setup's when one was passed. */
  readonly targetUsd: number;
  /** The hard max this meter postures against. */
  readonly maxUsd: number;
  /** Names the budget in every note this meter's numbers appear in. */
  readonly scope: string;

  /**
   * Zero arguments is the per-run meter, byte-identically to before: every
   * existing call site keeps the owner's $1.00/$1.50.
   *
   * A non-finite or non-positive limit falls back to the run constant rather
   * than throwing. The meter must never be the thing that fails a run, and
   * that includes a caller that computed a limit badly.
   */
  constructor(limits: SpendMeterLimits = {}) {
    const positive = (value: number | undefined, fallback: number): number =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
    this.targetUsd = positive(limits.targetUsd, TARGET_RUN_SPEND_USD);
    this.maxUsd = positive(limits.maxUsd, MAX_RUN_SPEND_USD);
    this.scope = typeof limits.scope === "string" && limits.scope.trim().length > 0 ? limits.scope.trim() : "run";
  }

  /**
   * Records `max(measuredUsd ?? 0, estimateUsd)` under `label`.
   *
   * A measured value that is `undefined`, `0`, negative or non-finite is
   * treated as "the vendor told us nothing" and the estimate counts — a $0
   * reading from a step that certainly ran a model is exactly the case the
   * `max` exists for. A negative estimate is clamped to zero rather than
   * thrown on: the meter must never be the thing that fails a run.
   */
  add(label: string, measuredUsd: number | undefined, estimateUsd: number): void {
    const estimate = Number.isFinite(estimateUsd) && estimateUsd > 0 ? estimateUsd : 0;
    const measured = typeof measuredUsd === "number" && Number.isFinite(measuredUsd) && measuredUsd > 0 ? measuredUsd : undefined;
    const usd = Math.max(measured ?? 0, estimate);
    this.entries.push({
      label,
      usd,
      ...(measured !== undefined ? { measuredUsd: measured } : {}),
      estimateUsd: estimate,
      basis: measured !== undefined && measured >= estimate ? "measured" : "estimate",
    });
  }

  /** Total recorded so far, rounded to micro-dollars. What the gate payload shows as `spendUsd`. */
  get totalUsd(): number {
    return roundUsd(this.entries.reduce((sum, line) => sum + line.usd, 0));
  }

  /** Every recorded line, in the order it was added — for the ledger and for a reviewer asking where the money went. */
  get lines(): ReadonlyArray<SpendLine> {
    return this.entries;
  }

  /**
   * Whether spending `nextEstimateUsd` more would stay AT OR UNDER
   * `MAX_RUN_SPEND_USD`. A pure question, for the gate payload and for the
   * optional-work decisions below — never a reason to hold (owner's rule).
   * Landing exactly on the ceiling is allowed — the owner's number is a
   * maximum, not a strict bound — so a run at $1.38 may take a $0.12 step
   * and a run at $1.39 may not.
   */
  canAfford(nextEstimateUsd: number): { ok: true } | { ok: false; reason: string } {
    const projected = roundUsd(this.totalUsd + Math.max(0, nextEstimateUsd));
    if (projected <= this.maxUsd) return { ok: true };
    return {
      ok: false,
      reason: `${formatUsd(this.totalUsd)} spent so far; the next step is estimated at ${formatUsd(nextEstimateUsd)}, which would take this ${this.scope} to ${formatUsd(projected)} — over the ${formatUsd(this.maxUsd)} per-${this.scope} ceiling`,
    };
  }

  /** `true` once the running total exceeds the owner's target — optional work stops. */
  get crossedTarget(): boolean {
    return this.totalUsd > this.targetUsd;
  }

  /** `true` once the running total exceeds the hard max — the rest of the run takes the cheapest complete path. */
  get crossedMax(): boolean {
    return this.totalUsd > this.maxUsd;
  }

  /** The posture the rest of the run should take, read live at every optional spend point. */
  get posture(): SpendPosture {
    if (this.crossedMax) return "cheapest-path";
    if (this.crossedTarget) return "essential-only";
    return "normal";
  }
}

/**
 * How many more images the `generate` rescue tier may request this run under
 * the widest plan. The workflow takes `min(this, plan.generatedImagesCap −
 * generatedSoFar)` and routes the rest to the text-only downgrade with the
 * reason "generation budget for this run spent". Never negative: a caller
 * that somehow over-counted must read "nothing left", not a request for −2.
 */
export function remainingGenerationBudget(generatedSoFar: number, cap: number = GENERATED_IMAGES_PER_RUN_CAP): number {
  const used = Number.isFinite(generatedSoFar) ? Math.max(0, Math.floor(generatedSoFar)) : 0;
  const ceiling = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 0;
  return Math.max(0, ceiling - used);
}

// ─────────────────────────────────────────────────────────────────────────────
// The plan
// ─────────────────────────────────────────────────────────────────────────────

/** What a run is allowed to spend on, decided BEFORE the attempt loop and never tightened into a hold mid-way. */
export interface RunBudgetPlan {
  /** Self-check attempts in total (the initial draft plus returns to step 05): 3 by default, 2 when adapted. */
  maxSelfCheckAttempts: number;
  /** Generated images allowed this run, all attempts and revisions together (≤ `GENERATED_IMAGES_PER_RUN_CAP`). */
  generatedImagesCap: number;
  /** `full` = every trend-evidence query; `reduced` = only the first, most-cacheable one (the industry query repeats run to run, so it is usually warm). */
  evidencePulls: "full" | "reduced";
  /**
   * Whether the optional rescue tiers (scrape/generate + their re-vets) may
   * run at all — and, since Phase 5, whether `07i1-verify-lead-claim` spends
   * its one ScrappyCoco execution. One flag, both rescue paths: see
   * `rawEstimate` and `planRunBudget` rung 3.
   */
  optionalRevets: boolean;
}

export const DEFAULT_RUN_BUDGET_PLAN: Readonly<RunBudgetPlan> = {
  maxSelfCheckAttempts: 3,
  generatedImagesCap: GENERATED_IMAGES_PER_RUN_CAP,
  evidencePulls: "full",
  optionalRevets: true,
};

/**
 * Scraper executions one brief refresh bills at `00b1-gather-brief-sources`:
 * three page fetches of the client's own site (home, about, pricing) plus up
 * to six `research.socialHistory` accounts. The worst case, because the
 * cheaper cases are cache hits and an estimate that flatters itself pulls no
 * lever.
 */
export const BRIEF_REFRESH_SCRAPER_EXECUTIONS = 9;

/** Scraper executions `03e-topic-signals` bills cold: up to six reference accounts plus two community queries (Phase 1, item I). */
export const TOPIC_SIGNAL_EXECUTIONS = 8;

/** Lane queries `04a2-research-pull-deep` bills cold: news 3 + insight 2 + primary-domains 1 (Phase 1, item J). */
export const RESEARCH_LANE_QUERIES = 6;

/** Page fetches `04a3-fetch-primary-sources` bills cold (Phase 1, item J caps it at two). */
export const PRIMARY_SOURCE_PAGE_FETCHES = 2;

/** What is known about the run before the first paid call — the estimator's inputs. */
export interface RunShape {
  /** A resolved non-English target language means the `languageBrief` field and the native editor (both rounds) are priced into every attempt. */
  targetLanguage: boolean;
  /** Trend-evidence queries 03b would issue under a `full` plan (cold-cache worst case). */
  trendQueries: number;
  /**
   * Phase 1, item H — whether `00b` resolved `refresh`/`create`, so this run
   * pays the Sonnet brief call at `00b2` and the source scrapes at `00b1`.
   * Known before any of it is spent (`00b-check-client-brief` is a free store
   * read), which is why `02j-plan-run-budget` sits between the two.
   */
  briefRefresh: boolean;
  /** Scraper executions a refresh would bill; counted only when `briefRefresh`. Defaults to `BRIEF_REFRESH_SCRAPER_EXECUTIONS`. */
  briefScrapes: number;
  /**
   * Phase 1, item I — `03e-topic-signals` executions (reference accounts +
   * community queries), cold. NOT trimmed by the `evidencePulls` lever, which
   * only reaches 03b's trend queries (`create-instagram-agent-workflow.ts`'s
   * `queries` slice): the estimate prices what the run would actually do.
   */
  signalExecutions: number;
  /** Phase 1, item J — `04a2-research-pull-deep` lane queries, cold. Replaces Phase 0's single `04a` pull. */
  researchLaneQueries: number;
  /** Phase 1, item J — `04a3-fetch-primary-sources` page fetches, cold. */
  pageFetches: number;
  /**
   * The client's OWN social accounts, one billed `research.socialHistory`
   * execution each at `04e-read-cross-channel-history` (cold).
   *
   * Added when 04e's spend was metered for the first time: that step had been
   * scraping since it was written with no `spend(...)` line, and fixing the
   * METER without fixing the ESTIMATOR leaves the plan knowingly short by up
   * to $0.042 on a multi-account client — enough to take the shipped Hebrew
   * plan from $0.9998 to ~$1.04, i.e. over the very target it was fitted to.
   * `spentUsd` cannot cover it either: 02j runs long before 04e.
   *
   * Knowable before the first paid call: the count comes from
   * `client.getConfig` + `client.getBrand`, both free reads, which is exactly
   * what `04e0-load-social-accounts` does later with the same inputs.
   */
  socialAccounts: number;
  /**
   * Phase 1, item K — angle proposals this plan pays for: one per revision
   * ROUND, and the plan covers the initial round only (a reviewer's `revise`
   * is priced separately by `revisionEstimateUsd`). Zero for a run whose
   * angle step cannot run at all.
   */
  angleRounds: number;
  /**
   * Photo slides the copy is expected to produce — drives the harvest, the
   * `05c` candidate inspection (`CANDIDATES_PER_PHOTO_SLIDE` images EACH) and
   * the rescue tier. A carousel's floor is 6.
   */
  photoSlides: number;
  /**
   * Slides the carousel is expected to render, photo or typographic — what
   * `08a4` inspects, since the vision pass looks at every rendered slide and
   * not only the ones carrying a photograph. Priced at the carousel's
   * ceiling (8), because an estimate that flatters itself pulls no lever.
   */
  slideCount: number;
  /**
   * Phase 4 (RFC-16) — whether the CONCEPT mode could fire at all on this run.
   *
   * `false` only when something switched the mode off before the run started:
   * the client config's `instagramConceptMode: "off"`, or the run input's
   * `conceptMode: "off"`. Anything else — including `"auto"`, where the
   * selector declines on most runs — is `true`.
   *
   * It is deliberately NOT "will the selector fire". `02j-plan-run-budget`
   * runs long before `04m-concept-eligibility` and cannot know that, and this
   * module's own rule (see `STEP_COST_ESTIMATES_USD`) is that an estimate
   * which flatters itself pulls no lever. So the worst case is priced
   * UNCONDITIONALLY on every run where the mode is reachable: an estimator
   * that priced the concept only on the runs it hoped would fire would arm no
   * image lever on the runs that do, and the concept step plus its one vision
   * inspection is $0.030 — most of an image-cap step.
   */
  conceptPossible: boolean;
}

export const DEFAULT_RUN_SHAPE: Readonly<RunShape> = {
  targetLanguage: false,
  trendQueries: 4,
  photoSlides: 6,
  slideCount: 8,
  briefRefresh: false,
  briefScrapes: BRIEF_REFRESH_SCRAPER_EXECUTIONS,
  signalExecutions: TOPIC_SIGNAL_EXECUTIONS,
  researchLaneQueries: RESEARCH_LANE_QUERIES,
  pageFetches: PRIMARY_SOURCE_PAGE_FETCHES,
  // Zero, not a guess: a client with no configured social accounts pays 04e
  // nothing, and the real count is read from free config at 02j.
  socialAccounts: 0,
  angleRounds: 1,
  // The default is the worst case, like every other field here: the mode is
  // reachable unless a client config or a run input has turned it off, and the
  // planner is handed the shape it cannot yet disprove.
  conceptPossible: true,
};

/** The estimate, itemised so the gate summary and the ledger can show where the money is expected to go. */
export interface RunCostEstimate {
  estimatedUsd: number;
  /** Raw (uncalibrated) figure the calibration ratio was applied to. */
  rawUsd: number;
  calibrationRatio: number;
  breakdown: { fixed: number; attempts: number; rescue: number; images: number };
}

/** A count from a shape, floored at zero: a hand-written or replayed shape must never make the estimator subtract. */
const count = (value: number | undefined): number => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0);

/** Cold-cache, worst-case-under-the-plan cost of a run, before calibration. */
function rawEstimate(plan: RunBudgetPlan, shape: RunShape): RunCostEstimate["breakdown"] {
  const c = STEP_COST_ESTIMATES_USD;
  const queries = plan.evidencePulls === "full" ? count(shape.trendQueries) : Math.min(1, count(shape.trendQueries));
  // Every ONCE-PER-RUN line, in execution order. Phase 1 added five of them
  // (the brief and its scrapes, the topic-signal engines, the research lanes,
  // the primary-source fetches, the angle proposal) and pricing a Phase 1 run
  // with Phase 0's `fixed` under-counted a cold run by roughly $0.25 — so
  // `fits()` was true, `adaptations` was empty, and the lever the owner's
  // amendment exists to pull never fired on this phase's own spend.
  const fixed =
    // 00b1 + 00b2, only on the runs that write a brief (`00b` decided this
    // before a cent was spent, and 02j runs between the two).
    (shape.briefRefresh ? c.brief + count(shape.briefScrapes) * c.scraperExecution : 0) +
    // 03b trend evidence (the one lever `evidencePulls` reaches) + 03c scout.
    queries * c.scraperExecution +
    c.scout +
    // 03e's four other engines.
    count(shape.signalExecutions) * c.scraperExecution +
    // 04a2's lanes (Phase 0's single `04a` pull was one execution) + 04a3's page fetches.
    count(shape.researchLaneQueries) * c.scraperExecution +
    count(shape.pageFetches) * c.scraperExecution +
    // 04e's own-account history: one ScrappyCoco execution per account.
    count(shape.socialAccounts) * c.scraperExecution +
    // 04b extraction, then 04i's angle: one per revision round, and the plan
    // covers the initial round.
    c.extraction +
    count(shape.angleRounds) * c.angle +
    // Phase 4 (RFC-16): the concept step and the ONE vision inspection of the
    // frame it produces, priced on every run the mode is reachable on rather
    // than on the ~1-in-6 the selector is expected to fire on. 02j runs long
    // before 04l, so "will it fire?" is unanswerable here and the only honest
    // answer is the worst case (+$0.030) — the same rule the rest of this
    // function follows for cold caches and eight-slide carousels.
    //
    // "Unanswerable" is true of the STORY, not of the PLAN. Two of the
    // selector's preconditions are decided by the very plan being priced, and
    // on a rung that fails either of them the concept costs exactly $0:
    // `conceptEligibility` declines with "the run budget bought no generated
    // images" when `generatedImagesCap <= 0`, and the workflow declines
    // outright when `optionalRevets` is false. Booking $0.030 there charged
    // the estimate for spend the chosen plan had just made impossible, and it
    // compounds — on the saturated ladder the same line costs $0.030 x the
    // calibration ratio — which is what pushed the target headroom down. The
    // full plan, where the concept really can be bought, still carries the
    // honest worst case.
    //
    // The concept's IMAGE is NOT added here: it is one of the
    // `plan.generatedImagesCap` pictures priced in `images` below, and
    // double-counting it would pull an image lever a run does not need.
    (shape.conceptPossible && plan.generatedImagesCap > 0 && plan.optionalRevets ? c.concept + c.visionInspectPerImage : 0) +
    // Phase 5 (RFC-18 §6, §4.3) — the three once-per-run lines the whole-post
    // half adds, all of them OUTSIDE the attempt loop by design:
    //
    //  - `08c-package-post`, the Flash packager, once per revision and the
    //    plan covers the initial round (the same convention `angleRounds`
    //    follows). Authoring hashtags, alt text and the first comment at `05`
    //    instead would be ≈+$0.008 on EVERY attempt — see the key's comment.
    c.postPackage +
    //  - `08c2-package-native-round`, only when a target language resolved.
    //    An English run's package is never judged, so charging it here would
    //    over-state every English plan by $0.009.
    (shape.targetLanguage ? c.packageNativeJudge : 0) +
    //  - `07i1-verify-lead-claim`, ONE ScrappyCoco execution per run (the
    //    store's cache key makes a repeat of the same URL on attempt 2 free,
    //    which is why this is a `fixed` line and not a `perAttempt` one).
    //
    //    It is tied to `plan.optionalRevets` because it IS rescue-shaped work:
    //    a deterministic re-fetch of the one page the cover's claim rests on,
    //    valuable when there is money for it and skippable when there is not.
    //    That tie is load-bearing for RFC-18 §7.3's rung swap: the re-vet rung
    //    now switches off BOTH rescue paths together, so it buys the rescue
    //    line plus this $0.007 before the attempt lever is ever reached.
    (plan.optionalRevets ? c.scraperExecution : 0);
  const photos = Math.max(0, shape.photoSlides);
  // A carousel cannot have more photo slides than slides; a shape that says
  // so is priced at the larger of the two rather than under-counting 08a4.
  const slides = Math.max(0, shape.slideCount, photos);
  const perAttempt =
    c.copyAttempt +
    c.vetCall +
    c.relevance +
    // Phase 5 (RFC-18 §5) — the value judge, once per attempt, in every
    // language. `07i`, `07i2` and `08c1` are `wf.step.code` with no model call
    // and no tool call, so they contribute nothing here BY CONSTRUCTION, the
    // same way `04l` and `07e2` do not.
    c.valueJudge +
    // Phase 4 — the language lines, on non-English runs only: the `languageBrief` field on the draft and ONE
    // native-editor round (RFC-15 §6.5, §9.3's headline arithmetic). `04l` and `07e2` are `wf.step.code`
    // with no model call and no tool call, so they contribute nothing here BY CONSTRUCTION, not by omission.
    //
    // ## Why ONE round here and TWO in `revisionEstimateUsd`, deliberately
    //
    // Round 2 is conditional — it happens only when round 1 proposed corrections. The two functions are read
    // at different moments and a wrong number costs something different at each:
    //
    // * This function CHOOSES THE PLAN, before a cent is spent. Pricing the conditional round here was
    //   measured: it takes the cold Hebrew shape past the point where the image levers can absorb it, fires
    //   the attempt lever, and lands the plan at $0.75 with `maxSelfCheckAttempts` cut 3 -> 2. That is the
    //   lever overshooting by $0.25 and paying for it with a whole drafting attempt, on exactly the clients
    //   this phase exists to serve. Priced at one round the same shape plans three attempts at $0.9998.
    // * `revisionEstimateUsd` only INFORMS the pre-revision check, which degrades optional work and never
    //   refuses the round, so its overshoot costs nothing and its under-shoot would be the estimate
    //   flattering itself immediately before the spend. It prices both rounds.
    //
    // The live meter is what closes the gap either way: a second round that does happen is metered when it
    // happens, and `ewmaRatio` teaches the next run what this client's Hebrew actually costs.
    (shape.targetLanguage ? c.copyLanguageBrief + c.nativeJudge : 0) +
    c.visualQa +
    // 05c inspects the POOL, and the pool is `CANDIDATES_PER_PHOTO_SLIDE`
    // candidates for every slide that needs a picture (plus any tier-0
    // uploads, which cost nothing to harvest and are not modelled) — not one
    // image per slide.
    photos * CANDIDATES_PER_PHOTO_SLIDE * c.visionInspectPerImage +
    // 08a4 inspects every rendered slide (capped at 12 by the step itself),
    // photo or typographic.
    Math.min(slides, 12) * c.visionInspectPerImage;
  const attempts = plan.maxSelfCheckAttempts * perAttempt;
  // Optional rescue per attempt: one scrape execution per gap (worst case half the photo slides) + two re-vets.
  const rescue = plan.optionalRevets ? plan.maxSelfCheckAttempts * (Math.ceil(photos / 2) * c.scraperExecution + 2 * c.vetCall) : 0;
  const images = plan.generatedImagesCap * c.generatedImage;
  return { fixed: roundUsd(fixed), attempts: roundUsd(attempts), rescue: roundUsd(rescue), images: roundUsd(images) };
}

/** The calibration ratio is bounded: a single wild run must not make the estimator refuse every plan, nor trust a $0 vendor reading. */
const MIN_CALIBRATION_RATIO = 0.5;
const MAX_CALIBRATION_RATIO = 3;

export function estimateRunCost(plan: RunBudgetPlan, shape: RunShape, calibrationRatio = 1): RunCostEstimate {
  const ratio = Number.isFinite(calibrationRatio) ? Math.min(MAX_CALIBRATION_RATIO, Math.max(MIN_CALIBRATION_RATIO, calibrationRatio)) : 1;
  const breakdown = rawEstimate(plan, shape);
  const rawUsd = roundUsd(breakdown.fixed + breakdown.attempts + breakdown.rescue + breakdown.images);
  return { estimatedUsd: roundUsd(rawUsd * ratio), rawUsd, calibrationRatio: ratio, breakdown };
}

// ─────────────────────────────────────────────────────────────────────────────
// Learning — per-client history persisted in the memory beliefs document
// ─────────────────────────────────────────────────────────────────────────────

/** The key under which `memory.updateBeliefs` / `memory.read({scope:"beliefs"})` carry this history. */
export const RUN_BUDGET_BELIEF_KEY = "instagramRunBudget";

/** One past run's money, as the next run's estimator reads it. */
export interface RunBudgetRunRecord {
  runId: string;
  at: string;
  estimatedUsd: number;
  actualUsd: number;
  crossedTarget: boolean;
  crossedMax: boolean;
  adaptations: number;
  /**
   * Phase 4 (RFC-16 §1.6) — did the concept selector fire, and did a concept
   * image actually reach the shipped post?
   *
   * OPTIONAL because every run recorded before Phase 4 has neither, and an
   * absent field has to stay distinguishable from a recorded `false`: the
   * whole point of these two is to MEASURE the selection rate against the
   * RFC's design-intent ~17% and its 25% ceiling, and a missing row counted
   * as a decline would bias that measurement downwards exactly when the
   * history is thinnest. A reader must count only the runs where the field is
   * present. `readBudgetHistory` below preserves that distinction.
   *
   * Nothing in the estimator reads these — they are observation, not input.
   */
  conceptFired?: boolean;
  conceptShipped?: boolean;
  /**
   * RFC-15 §9.4's measurement hook: what the native-language loop cost this
   * run in ROUNDS, and what it actually found, per axis.
   *
   * The phase's stated bet is that round 1 usually settles it and the
   * in-place patch usually holds — i.e. that `rounds: 2` is the exception and
   * a given axis fails rarely. Nothing could check that: the per-run
   * deliverable carried the numbers and no later run ever reads a deliverable
   * back, so the next phase had no way to learn whether the bet paid. This is
   * the belief a later run CAN read, beside the estimate-vs-actual it already
   * reads.
   *
   * Absent on English runs, where the loop does not run at all — which is
   * itself the signal, not a gap.
   */
  language?: {
    rounds: 1 | 2;
    status: "verified" | "corrected" | "degraded" | "unverified";
    axes: Record<string, string>;
  };
  /**
   * Phase 5 (RFC-18 §5.8) — what the VALUE gate decided, what each axis said,
   * and how many of this run's drafting attempts a value refusal caused.
   *
   * RFC-15 §9.4 named this gap about its own phase and then had to leave it
   * open: the per-run deliverable carried the numbers and no later run ever
   * reads a deliverable back, so there was no way to learn whether the bet
   * paid. `language` above closed it for Phase 4. This closes it for Phase 5,
   * and it is the measurement the phase is actually accountable to:
   *
   *  - `status` says whether the bar was met, missed or never asked;
   *  - `axes` says WHICH of `newFact` / `position` / `payload` / `action` is
   *    the one the writer keeps failing, which is the input to the next
   *    rubric era (`VALUE_RUBRIC_VERSION`);
   *  - `returns` says what the gate COST in redrafts — 0, 1 or 2. A gate that
   *    is always 0 is decoration; a gate that is always 2 is an unwinnable
   *    floor of the kind Phase 0 already had to correct, and §5.9's
   *    pre-merge calibration is only a sample of eight.
   *
   * OPTIONAL for the same reason the two concept booleans are: a run recorded
   * before Phase 5 has none of this, and an absent record must stay
   * distinguishable from a recorded `below-bar`. A reader counts only the runs
   * where the field is present. Nothing in the estimator reads it — it is
   * observation, not input.
   */
  value?: {
    status: "keepable" | "below-bar" | "unjudged";
    axes: Record<string, string>;
    returns: number;
  };
}

export interface RunBudgetHistory {
  version: 1;
  /** Exponentially weighted mean of actual/estimate across past runs (alpha 0.5); 1 when nothing is known. */
  ewmaRatio: number;
  /** Consecutive runs whose actual spend crossed the target, most recent last. Reset by a run under target. */
  overrunStreak: number;
  /** Consecutive runs under target. Two of them relax a tightened default plan again. */
  underTargetStreak: number;
  /** The last few runs, oldest first. */
  runs: RunBudgetRunRecord[];
}

export const EMPTY_RUN_BUDGET_HISTORY: Readonly<RunBudgetHistory> = { version: 1, ewmaRatio: 1, overrunStreak: 0, underTargetStreak: 0, runs: [] };

const HISTORY_RUNS_KEPT = 10;
const EWMA_ALPHA = 0.5;
/** Under-target runs needed before a tightened default relaxes again (owner: "relax again after two runs under target"). */
export const RELAX_AFTER_UNDER_TARGET_RUNS = 2;

/**
 * One stored `language` record, or `undefined` for anything that is not one.
 *
 * Same posture as every other field in `readBudgetHistory`: a hand edit, a
 * pre-Phase-4 entry or an English run all produce `undefined` rather than a
 * zero-filled row, because "the loop did not run" and "the loop ran and found
 * nothing" are different facts and a later run reasons about both.
 */
function readLanguageRecord(raw: unknown): RunBudgetRunRecord["language"] {
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const rounds = r["rounds"] === 2 ? 2 : r["rounds"] === 1 ? 1 : undefined;
  if (rounds === undefined) return undefined;
  const status = r["status"];
  if (status !== "verified" && status !== "corrected" && status !== "degraded" && status !== "unverified") return undefined;
  const axes: Record<string, string> = {};
  if (r["axes"] !== null && typeof r["axes"] === "object") {
    for (const [axis, verdict] of Object.entries(r["axes"] as Record<string, unknown>)) {
      if (typeof verdict === "string") axes[axis] = verdict;
    }
  }
  return { rounds, status, axes };
}

/**
 * One stored `value` record, or `undefined` for anything that is not one.
 *
 * Same posture as `readLanguageRecord`, and for the same reason: a pre-Phase-5
 * entry, a hand edit and a run whose judge never ran are three different facts,
 * and none of them may read as "the gate said `keepable`, 0 returns". A record
 * survives only when it carries a known status; `returns` is floored at 0 and
 * capped at `VALUE_MAX_RETURNS`'s ceiling of 2 the way every other count here
 * is bounded, so a garbage row cannot make a later reader's average absurd.
 */
function readValueRecord(raw: unknown): RunBudgetRunRecord["value"] {
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const status = r["status"];
  if (status !== "keepable" && status !== "below-bar" && status !== "unjudged") return undefined;
  const axes: Record<string, string> = {};
  if (r["axes"] !== null && typeof r["axes"] === "object") {
    for (const [axis, verdict] of Object.entries(r["axes"] as Record<string, unknown>)) {
      if (typeof verdict === "string") axes[axis] = verdict;
    }
  }
  const rawReturns = r["returns"];
  const returns = typeof rawReturns === "number" && Number.isFinite(rawReturns) ? Math.min(2, Math.max(0, Math.floor(rawReturns))) : 0;
  return { status, axes, returns };
}

/** Reads the history back out of a beliefs document, tolerating anything a past version or a hand edit left there. */
export function readBudgetHistory(beliefs: unknown): RunBudgetHistory {
  const raw = beliefs !== null && typeof beliefs === "object" ? (beliefs as Record<string, unknown>)[RUN_BUDGET_BELIEF_KEY] : undefined;
  if (raw === null || typeof raw !== "object") return { ...EMPTY_RUN_BUDGET_HISTORY, runs: [] };
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const runs = Array.isArray(r["runs"])
    ? (r["runs"] as unknown[]).flatMap((entry): RunBudgetRunRecord[] => {
        if (entry === null || typeof entry !== "object") return [];
        const e = entry as Record<string, unknown>;
        if (typeof e["runId"] !== "string") return [];
        // Phase 4: the two concept booleans round-trip ONLY when the stored
        // row actually carries a boolean. `e["conceptFired"] === true` would
        // have been shorter and wrong — it turns "this run predates Phase 4"
        // into "this run declined", which is the one distinction §1.6's
        // selection-rate measurement rests on. Absent stays absent.
        const conceptFields: { conceptFired?: boolean; conceptShipped?: boolean } = {
          ...(typeof e["conceptFired"] === "boolean" ? { conceptFired: e["conceptFired"] } : {}),
          ...(typeof e["conceptShipped"] === "boolean" ? { conceptShipped: e["conceptShipped"] } : {}),
        };
        const language = readLanguageRecord(e["language"]);
        const value = readValueRecord(e["value"]);
        return [
          {
            runId: e["runId"],
            at: typeof e["at"] === "string" ? e["at"] : "",
            estimatedUsd: num(e["estimatedUsd"], 0),
            actualUsd: num(e["actualUsd"], 0),
            crossedTarget: e["crossedTarget"] === true,
            crossedMax: e["crossedMax"] === true,
            adaptations: Math.max(0, Math.floor(num(e["adaptations"], 0))),
            ...conceptFields,
            // Tolerated the way every other field here is: an entry written
            // before this key existed simply carries no language record, which
            // reads as "English run, or an older era" and never as zero.
            ...(language !== undefined ? { language } : {}),
            // Phase 5, tolerated identically: a row written before the value
            // gate existed simply carries no value record, which reads as "an
            // older era" and never as a keepable post with zero returns.
            ...(value !== undefined ? { value } : {}),
          },
        ];
      })
    : [];
  return {
    version: 1,
    ewmaRatio: Math.min(MAX_CALIBRATION_RATIO, Math.max(MIN_CALIBRATION_RATIO, num(r["ewmaRatio"], 1))),
    overrunStreak: Math.max(0, Math.floor(num(r["overrunStreak"], 0))),
    underTargetStreak: Math.max(0, Math.floor(num(r["underTargetStreak"], 0))),
    runs: runs.slice(-HISTORY_RUNS_KEPT),
  };
}

/** The history after one more finished run — what 09b writes back. Pure; idempotent on `runId` (a replayed 09b does not double-count). */
export function recordRunInHistory(history: RunBudgetHistory, run: RunBudgetRunRecord): RunBudgetHistory {
  if (history.runs.some((r) => r.runId === run.runId)) return history;
  const ratio = run.estimatedUsd > 0 ? run.actualUsd / run.estimatedUsd : 1;
  const bounded = Math.min(MAX_CALIBRATION_RATIO, Math.max(MIN_CALIBRATION_RATIO, ratio));
  const ewmaRatio = roundUsd(history.runs.length === 0 ? bounded : history.ewmaRatio * (1 - EWMA_ALPHA) + bounded * EWMA_ALPHA);
  // An overrun is remembered until RELAX_AFTER_UNDER_TARGET_RUNS runs have
  // landed under target (owner: "tighter default plan after an overrun; relax
  // again after two runs under target") — one good run does not erase it.
  const underTargetStreak = run.crossedTarget ? 0 : history.underTargetStreak + 1;
  const overrunStreak = run.crossedTarget ? history.overrunStreak + 1 : underTargetStreak >= RELAX_AFTER_UNDER_TARGET_RUNS ? 0 : history.overrunStreak;
  return {
    version: 1,
    ewmaRatio,
    overrunStreak,
    underTargetStreak,
    runs: [...history.runs, run].slice(-HISTORY_RUNS_KEPT),
  };
}

/** How the next run should start: `tight` after an overrun until two runs land under target, `default` otherwise. */
export function calibrationPosture(history: RunBudgetHistory): "default" | "tight" {
  return history.overrunStreak > 0 && history.underTargetStreak < RELAX_AFTER_UNDER_TARGET_RUNS ? "tight" : "default";
}

// ─────────────────────────────────────────────────────────────────────────────
// Planning — fit the plan to the target, in the owner's order, never a hold
// ─────────────────────────────────────────────────────────────────────────────

export interface RunBudgetDecision {
  plan: RunBudgetPlan;
  estimate: RunCostEstimate;
  /** The estimate BEFORE any lever was pulled — what the reviewer compares the adapted figure against. */
  initialEstimateUsd: number;
  targetUsd: number;
  maxUsd: number;
  calibration: { ratio: number; posture: "default" | "tight"; pastRuns: number };
  /**
   * Money already on the meter when the plan was made — normally $0, because
   * `02j-plan-run-budget` runs before the first paid call. Non-zero only if a
   * future step is added ahead of it: the plan is then fitted to what is LEFT
   * of the target rather than to the whole of it, so the lever still fires.
   */
  spentBeforePlanUsd: number;
  /** Every lever pulled, in order, in the words the reviewer reads. Empty when the full plan fits. */
  adaptations: string[];
  /** The one-line run note ("budget: estimate $1.21 > $1.00 → images capped at 4, one return to step 05 instead of two"). */
  note: string;
}

/** The image caps the first lever steps through: stock/tier-0 first, then fewer generated pictures, then none. */
const IMAGE_CAP_STEPS = [4, 2, 0] as const;

/**
 * Decide the plan for this run. Starts from the default plan (or, after an
 * overrun, a tightened one: images already capped at 4) and pulls the levers
 * in the owner's order until the calibrated estimate fits the target. A plan
 * that still does not fit after every lever is returned as-is with the note
 * saying so — the run proceeds; the live meter takes it from there.
 */
export function planRunBudget(
  shape: RunShape,
  history: RunBudgetHistory = EMPTY_RUN_BUDGET_HISTORY,
  options: { spentUsd?: number } = {},
): RunBudgetDecision {
  const posture = calibrationPosture(history);
  const ratio = history.ewmaRatio;
  const spent = roundUsd(count(options.spentUsd));
  const adaptations: string[] = [];
  let plan: RunBudgetPlan = { ...DEFAULT_RUN_BUDGET_PLAN };
  if (posture === "tight") {
    plan = { ...plan, generatedImagesCap: IMAGE_CAP_STEPS[0] };
    adaptations.push(`started tight after ${history.overrunStreak} run(s) over target: images capped at ${IMAGE_CAP_STEPS[0]}`);
  }
  const initialEstimate = estimateRunCost(plan, shape, ratio);
  let estimate = initialEstimate;
  // The rest of the run has to fit what is LEFT of the target: money already
  // billed is money the plan cannot un-spend, and fitting the plan to the
  // whole $1.00 after $0.18 of brief writing is exactly the flattery this
  // file's own comment warns about.
  const fits = () => roundUsd(estimate.estimatedUsd + spent) <= TARGET_RUN_SPEND_USD;

  // 1. Cap generated images (prefer tier-0/stock, then text-only).
  for (const cap of IMAGE_CAP_STEPS) {
    if (fits() || plan.generatedImagesCap <= cap) continue;
    plan = { ...plan, generatedImagesCap: cap };
    estimate = estimateRunCost(plan, shape, ratio);
    adaptations.push(cap === 0 ? "no generated images (stock or text-only)" : `images capped at ${cap}`);
  }
  // 2. Optional evidence pulls down to the one most-cacheable query.
  if (!fits() && plan.evidencePulls === "full") {
    plan = { ...plan, evidencePulls: "reduced" };
    estimate = estimateRunCost(plan, shape, ratio);
    adaptations.push("trend evidence reduced to the one cached industry query");
  }
  // 3. Optional re-vets off — AND, since Phase 5, `07i1`'s lead-claim
  //    verification with them: one flag, both rescue paths.
  //
  // ## RFC-18 §7.3 — this rung and the next one were SWAPPED, and it is a
  // ## precondition of the value gate, not an optimisation
  //
  // Until Phase 5 the attempt lever ran here and the re-vet lever ran last.
  // That order gave up a whole drafting attempt before it gave up work whose
  // own name is "optional", and `vetCall`'s comment above records what it
  // cost: a cold Hebrew run sat $0.0002 under target with the re-vet rung
  // still unspent, so an honest $0.0045 re-price fired the ATTEMPT lever and
  // `language-compliance-gate.test.ts` started producing `status: "held"` runs
  // in the two cases named "NEVER holds".
  //
  // The owner's own ordering principle, applied consistently: DROP OPTIONAL
  // WORK BEFORE DROPPING THE THING THAT MAKES THE POST GOOD. A rescue re-vet
  // is optional by its own name; a drafting attempt is the mechanism every
  // quality gate in this workflow returns INTO. Phase 5's value gate rides
  // that same loop (`maxAttempts = min(MAX_SELF_CHECK_ATTEMPTS, plan.maxSelfCheckAttempts)`),
  // so a plan that buys 2 attempts buys the value gate exactly one chance to
  // send work back — i.e. the old order would have paid for the value gate by
  // disabling the value gate's own retry loop.
  //
  // It is also worth vastly more money, and in the right direction. On the
  // cold default shape this rung frees $0.109 (`3 x (3 x $0.007 + 2 x
  // $0.0065)` of rescue plus `07i1`'s $0.007) while the attempt rung frees
  // $0.2906 — so the old order overshot by a quarter of the whole target to
  // recover a few cents, and did it by deleting a draft.
  //
  // Not changed: the attempt lever still exists and still floors at 2, and the
  // `WorkflowHeld` for genuine MECHANICAL exhaustion (07's slide check, craft
  // hygiene) is untouched. What is guaranteed is narrower and exact: no
  // judgment gate — value, relevance, language, numbers — can be starved into
  // a hold by a budget decision.
  if (!fits() && plan.optionalRevets) {
    plan = { ...plan, optionalRevets: false };
    estimate = estimateRunCost(plan, shape, ratio);
    adaptations.push("optional rescue re-vets skipped");
  }
  // 4. Allowed self-check returns 2 -> 1. LAST, because it is the only rung
  //    that makes the deliverable itself worse.
  if (!fits() && plan.maxSelfCheckAttempts > 2) {
    plan = { ...plan, maxSelfCheckAttempts: 2 };
    estimate = estimateRunCost(plan, shape, ratio);
    adaptations.push("one return to step 05 instead of two");
  }

  const note =
    (fits()
      ? adaptations.length === 0
        ? `budget: estimate ${formatUsd(estimate.estimatedUsd)} ≤ ${formatUsd(TARGET_RUN_SPEND_USD)} → full plan`
        : `budget: estimate ${formatUsd(initialEstimate.estimatedUsd)} > ${formatUsd(TARGET_RUN_SPEND_USD)} → ${adaptations.join(", ")} (now ${formatUsd(estimate.estimatedUsd)})`
      : `budget: estimate ${formatUsd(initialEstimate.estimatedUsd)} > ${formatUsd(TARGET_RUN_SPEND_USD)} → ${adaptations.join(", ")}; still ${formatUsd(estimate.estimatedUsd)} on the tightest plan — running anyway, the live meter finishes on the cheapest path if needed`) +
    // Silent in the normal case (nothing is billed before 02j), so the note a
    // reviewer reads on almost every run is unchanged.
    (spent > 0 ? `; ${formatUsd(spent)} was already spent before the plan, so the target left for the rest of the run is ${formatUsd(Math.max(0, roundUsd(TARGET_RUN_SPEND_USD - spent)))}` : "");

  return {
    plan,
    estimate,
    initialEstimateUsd: initialEstimate.estimatedUsd,
    targetUsd: TARGET_RUN_SPEND_USD,
    maxUsd: MAX_RUN_SPEND_USD,
    calibration: { ratio: estimate.calibrationRatio, posture, pastRuns: history.runs.length },
    spentBeforePlanUsd: spent,
    adaptations,
    note,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The live notes and the summary the reviewer / ledger see
// ─────────────────────────────────────────────────────────────────────────────

/** The note recorded the moment the meter crosses the target. Reads the METER's target, so a setup meter's note carries the setup number. */
export function targetCrossedNote(meter: RunSpendMeter, at: string): string {
  return `budget: ${formatUsd(meter.totalUsd)} spent at ${at}, over the ${formatUsd(meter.targetUsd)} target — optional work stopped (no more generated images, no rescue re-vets); every mandatory gate still runs`;
}

/** The note recorded the moment the meter crosses the hard max. */
export function maxCrossedNote(meter: RunSpendMeter, at: string): string {
  return `budget: ${formatUsd(meter.totalUsd)} spent at ${at}, over the ${formatUsd(meter.maxUsd)} hard max — finishing on the cheapest complete path (text-only for any image gap, no vision inspection, no visual-QA model call) and delivering; the deliverable is marked degraded, never held`;
}

/** Estimate vs actual, for the gate summary, the deliverable and the ledger. */
export interface RunBudgetSummary {
  estimatedUsd: number;
  actualUsd: number;
  targetUsd: number;
  maxUsd: number;
  crossedTarget: boolean;
  crossedMax: boolean;
  posture: SpendPosture;
  plan: RunBudgetPlan;
  adaptations: string[];
  notes: string[];
  lines: SpendLine[];
}

export function summarizeRunBudget(decision: RunBudgetDecision, meter: RunSpendMeter, notes: readonly string[]): RunBudgetSummary {
  return {
    estimatedUsd: decision.estimate.estimatedUsd,
    actualUsd: meter.totalUsd,
    targetUsd: decision.targetUsd,
    maxUsd: decision.maxUsd,
    crossedTarget: meter.crossedTarget,
    crossedMax: meter.crossedMax,
    posture: meter.posture,
    plan: decision.plan,
    adaptations: [...decision.adaptations],
    notes: [...notes],
    lines: [...meter.lines],
  };
}

/** The one-line "estimate vs actual" the gate summary shows. */
export function estimateVsActualLine(summary: Pick<RunBudgetSummary, "estimatedUsd" | "actualUsd" | "crossedTarget" | "crossedMax">): string {
  const verdict = summary.crossedMax ? "over the hard max" : summary.crossedTarget ? "over target" : "under target";
  return `budget: estimated ${formatUsd(summary.estimatedUsd)}, actual ${formatUsd(summary.actualUsd)} (${verdict})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2, item N — the SETUP budget: separate meter, separate target, same
// rule (it adapts, it never holds)
//
// The owner's second number (2026-09-10, binding): one-off per-client setup
// work — the Template Studio's 4-6 generated templates, and Phase 3's visual
// direction — is amortised over a quarter of runs, so it gets its own budget
// (target $2.00, hard max $3.00 per client per setup) and is reported exactly
// the way a run is. It lives in THIS file rather than a module of its own for
// one reason: the machinery is identical (a table of per-unit estimates, an
// estimator, levers pulled in a fixed order, a live meter, a per-client
// calibration in the beliefs document) and a second copy of it would drift.
//
// "A setup that would exceed the budget generates FEWER TEMPLATES rather than
// failing" is the brief's own words, and it is the entire semantics of
// `planSetupBudget`: there is no refusal branch, not even past the hard max.
// ─────────────────────────────────────────────────────────────────────────────

/** The owner's target per client per setup: the number the pre-setup plan is fitted to. */
export const TARGET_SETUP_SPEND_USD = 2.0;

/** The owner's hard max per client per setup. Crossing it means fewer templates on the cheapest complete path — never a failure, never a hold. */
export const MAX_SETUP_SPEND_USD = 3.0;

/** The key under which `memory.updateBeliefs` / `memory.read({scope:"beliefs"})` carry the setup history, beside `RUN_BUDGET_BELIEF_KEY`. */
export const SETUP_BUDGET_BELIEF_KEY = "instagramSetupBudget";

/**
 * How many templates a full setup generates, and the floors the levers stop
 * at.
 *
 * `MIN_STUDIO_TEMPLATES = 4` is a quality floor, not a budget one: the brief
 * asks for "4-6 templates per client", and a client whose pool is a cover and
 * a closer has no menu to route a carousel through — it would fall back to
 * the bundled set on most slides anyway, which is the outcome the studio
 * exists to improve on. Lever 3 therefore stops at 4 and only the
 * past-the-hard-max lever 6 goes below it, with the reason recorded.
 */
export const STUDIO_TEMPLATES_TARGET = 6;
export const MIN_STUDIO_TEMPLATES = 4;
/** The absolute floor, reached only past the hard max: a cover and a closer, the two slides every carousel has. */
export const CHEAPEST_PATH_STUDIO_TEMPLATES = 2;

/**
 * Per-unit estimates for the setup steps, the same `max(measured, estimate)`
 * contract `STEP_COST_ESTIMATES_USD` documents.
 *
 * Every figure is a token count against the published rates in this file's
 * header (Sonnet 4.6 $3/$15, Gemini 2.5 Flash $0.30/$2.50 per 1M) — no Opus
 * anywhere, per the owner's rule. The two Sonnet lines are the ones that
 * carry the money, and each is justified where it is spent: a weak format
 * thesis or a weak layout is not one bad post, it is every post until the
 * next setup.
 */
export const SETUP_STEP_COST_ESTIMATES_USD = {
  /** Sonnet, ~8k in / 1.2k out — the format thesis every designer call reads (00c3). */
  designBrief: 0.042,
  /** Sonnet, ~7k in / 2.0k out — authors one template's HTML+CSS+sample, in the client's own script (00c4). ONE CALL PER TEMPLATE, so a schema failure costs one template instead of six. */
  templateDesign: 0.051,
  /** Sonnet, ~6k in / 2.0k out — one repair carrying the failing gate's measured numbers (00c7), at most two per setup. */
  templateRepair: 0.048,
  /** Flash, ~6k in / 1k out — grades the rendered samples it can see described (00c6). Residue only; the eight gates answer the factual half. */
  setReview: 0.004,
  /** Flash vision, one look per image: a reference post at 00c2, our own rendered sample at 00c5. */
  sampleInspect: 0.001,
  /**
   * Flash, ~12k in / 1.5k out — names formats over numbers code already
   * computed.
   *
   * Priced at ZERO occurrences in the plan below, deliberately: the wired
   * `00c2` ranks formats in code (`rankReferenceFormats`), which is free and
   * deterministic. The unit stays in the table because the qualitative
   * fallback — no numeric engagement signal anywhere, so nothing to rank —
   * is one step away from wanting a cheap labelling pass, and an estimator
   * whose table cannot name a unit it might bill is how a step gets added
   * without anyone re-running the numbers.
   */
  formatMap: 0.008,
  /** Sonnet, ~8k in / 1.2k out — Phase 3 item Q's art-direction lines, once per client per 90 days. */
  artDirection: 0.042,
  /** `media.ingestVisualPatterns`: Flash + vision + <=3 scrapes, consent-gated (Phase 3 item Q). */
  visualPatterns: 0.033,
  /** ScrappyCoco, per execution — reference-account history and the client's own site pages, cache shared with `00b1`/`03e`. */
  scraperExecution: 0.007,
} as const;

export type SetupStepCostKey = keyof typeof SETUP_STEP_COST_ESTIMATES_USD;

/** What is known about a setup before the first paid call — the estimator's inputs, cold-cache worst case. */
export interface SetupShape {
  /** Templates the design brief wants to author (4-6). */
  templates: number;
  /** Repair turns allowed across the whole setup. */
  repairs: number;
  /** `research.socialHistory` reads at `00c2` — the brief's reference accounts, capped at 6 by the tool's own schema. */
  referenceAccounts: number;
  /** `research.fetchPages` reads of the client's own site at `00c2`. */
  sitePages: number;
  /** Reference-post images `media.inspectImages` looks at, at `00c2`. */
  referenceImages: number;
  /** Whether the Flash set review at `00c6` runs. */
  setReview: boolean;
  /** Whether Phase 3's visual-direction block (`00d1`/`00d2`) runs on this setup. */
  visualDirection: boolean;
}

/** The full plan: what a setup does when the money is there. Matches spec N.5's cold table ($0.552 at 5 templates / 2 repairs). */
export const DEFAULT_SETUP_SHAPE: Readonly<SetupShape> = {
  templates: STUDIO_TEMPLATES_TARGET,
  repairs: 2,
  referenceAccounts: 6,
  sitePages: 3,
  referenceImages: 12,
  setReview: true,
  visualDirection: true,
};

/** What a setup is ALLOWED to do, decided before the first paid call and never tightened into a refusal. */
export interface SetupBudgetPlan {
  templates: number;
  repairsAllowed: number;
  referenceImages: number;
  setReview: boolean;
  visualDirection: boolean;
}

export interface SetupCostEstimate {
  estimatedUsd: number;
  rawUsd: number;
  calibrationRatio: number;
  breakdown: { evidence: number; design: number; validation: number; review: number; repairs: number; direction: number };
}

/** Cold-cache, worst-case-under-the-plan cost of one setup, before calibration. */
function rawSetupEstimate(plan: SetupBudgetPlan, shape: SetupShape): SetupCostEstimate["breakdown"] {
  const c = SETUP_STEP_COST_ESTIMATES_USD;
  const templates = Math.max(0, Math.floor(count(plan.templates)));
  // 00c2: one scrape per reference account and per site page (both usually
  // warm — the 24h cache is shared with 03e/04e and 00b1), plus one Flash
  // vision look per reference image.
  const evidence = (count(shape.referenceAccounts) + count(shape.sitePages)) * c.scraperExecution + count(plan.referenceImages) * c.sampleInspect;
  // 00c3 + 00c4: the thesis once, then one Sonnet call per template. Zero
  // templates means no studio work at all this setup (see `planSetupBudget`),
  // and then the thesis every designer call reads is not written either.
  const design = templates === 0 ? 0 : c.designBrief + templates * c.templateDesign;
  // 00c5: the eight gates and their Chromium renders are FREE; only the one
  // vision look per rendered sample bills.
  const validation = templates * c.sampleInspect;
  const review = plan.setReview ? c.setReview : 0;
  const repairs = Math.max(0, Math.floor(count(plan.repairsAllowed))) * c.templateRepair;
  const direction = plan.visualDirection ? c.visualPatterns + c.artDirection : 0;
  return {
    evidence: roundUsd(evidence),
    design: roundUsd(design),
    validation: roundUsd(validation),
    review: roundUsd(review),
    repairs: roundUsd(repairs),
    direction: roundUsd(direction),
  };
}

export function estimateSetupCost(plan: SetupBudgetPlan, shape: SetupShape, calibrationRatio = 1): SetupCostEstimate {
  const ratio = Number.isFinite(calibrationRatio) ? Math.min(MAX_CALIBRATION_RATIO, Math.max(MIN_CALIBRATION_RATIO, calibrationRatio)) : 1;
  const breakdown = rawSetupEstimate(plan, shape);
  const rawUsd = roundUsd(breakdown.evidence + breakdown.design + breakdown.validation + breakdown.review + breakdown.repairs + breakdown.direction);
  return { estimatedUsd: roundUsd(rawUsd * ratio), rawUsd, calibrationRatio: ratio, breakdown };
}

/** One past setup's money, as the next setup's estimator reads it. */
export interface SetupBudgetRecord {
  runId: string;
  at: string;
  estimatedUsd: number;
  actualUsd: number;
  templatesStored: number;
  templatesDropped: number;
  crossedTarget: boolean;
  crossedMax: boolean;
  adaptations: number;
}

export interface SetupBudgetHistory {
  version: 1;
  /** Exponentially weighted mean of actual/estimate across past setups (alpha 0.5); 1 when nothing is known. */
  ewmaRatio: number;
  /** The last few setups, oldest first. A client normally has one or two ever, which is exactly why the calibration matters more per row than the run meter's. */
  setups: SetupBudgetRecord[];
}

export const EMPTY_SETUP_BUDGET_HISTORY: Readonly<SetupBudgetHistory> = { version: 1, ewmaRatio: 1, setups: [] };

const SETUP_HISTORY_KEPT = 5;

/** Reads the setup history back out of a beliefs document, tolerating anything a past version or a hand edit left there. */
export function readSetupBudgetHistory(beliefs: unknown): SetupBudgetHistory {
  const raw = beliefs !== null && typeof beliefs === "object" ? (beliefs as Record<string, unknown>)[SETUP_BUDGET_BELIEF_KEY] : undefined;
  if (raw === null || typeof raw !== "object") return { ...EMPTY_SETUP_BUDGET_HISTORY, setups: [] };
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const setups = Array.isArray(r["setups"])
    ? (r["setups"] as unknown[]).flatMap((entry): SetupBudgetRecord[] => {
        if (entry === null || typeof entry !== "object") return [];
        const e = entry as Record<string, unknown>;
        if (typeof e["runId"] !== "string") return [];
        return [
          {
            runId: e["runId"],
            at: typeof e["at"] === "string" ? e["at"] : "",
            estimatedUsd: num(e["estimatedUsd"], 0),
            actualUsd: num(e["actualUsd"], 0),
            templatesStored: Math.max(0, Math.floor(num(e["templatesStored"], 0))),
            templatesDropped: Math.max(0, Math.floor(num(e["templatesDropped"], 0))),
            crossedTarget: e["crossedTarget"] === true,
            crossedMax: e["crossedMax"] === true,
            adaptations: Math.max(0, Math.floor(num(e["adaptations"], 0))),
          },
        ];
      })
    : [];
  return {
    version: 1,
    ewmaRatio: Math.min(MAX_CALIBRATION_RATIO, Math.max(MIN_CALIBRATION_RATIO, num(r["ewmaRatio"], 1))),
    setups: setups.slice(-SETUP_HISTORY_KEPT),
  };
}

/** The setup history after one more finished setup. Pure; idempotent on `runId`, so a resumed `09b` cannot double-count. */
export function recordSetupInHistory(history: SetupBudgetHistory, setup: SetupBudgetRecord): SetupBudgetHistory {
  if (history.setups.some((s) => s.runId === setup.runId)) return history;
  const ratio = setup.estimatedUsd > 0 ? setup.actualUsd / setup.estimatedUsd : 1;
  const bounded = Math.min(MAX_CALIBRATION_RATIO, Math.max(MIN_CALIBRATION_RATIO, ratio));
  const ewmaRatio = roundUsd(history.setups.length === 0 ? bounded : history.ewmaRatio * (1 - EWMA_ALPHA) + bounded * EWMA_ALPHA);
  return { version: 1, ewmaRatio, setups: [...history.setups, setup].slice(-SETUP_HISTORY_KEPT) };
}

export interface SetupBudgetDecision {
  plan: SetupBudgetPlan;
  estimate: SetupCostEstimate;
  /** The estimate BEFORE any lever was pulled. */
  initialEstimateUsd: number;
  targetUsd: number;
  maxUsd: number;
  calibration: { ratio: number; pastSetups: number };
  /** Money already on the SETUP meter when the plan was made — normally $0, because `00c1` runs before the first paid setup call. */
  spentBeforePlanUsd: number;
  /** Every lever pulled, in order, in the words the reviewer reads. */
  adaptations: string[];
  /** True when even the tightest plan above the template floor did not fit the HARD MAX, so lever 6 went below four templates. */
  belowTemplateFloor: boolean;
  note: string;
}

/** Lever 1's steps: the reference-image vision pass, which is the only evidence line that scales with money rather than with cache state. */
const SETUP_REFERENCE_IMAGE_STEPS = [6, 0] as const;

/**
 * Decide what this client's setup is allowed to do, before the first paid
 * setup call.
 *
 * The levers, in the owner's order (spec N.5): fewer reference images, then
 * no set review, then fewer templates (down to four), then fewer repairs,
 * then no visual direction — and only PAST THE HARD MAX, fewer than four
 * templates, with the reason recorded.
 *
 * **There is no refusal.** Not over the target, not over the hard max, not
 * with a calibration ratio pinned at its ceiling. The worst outcome this
 * function can produce is a two-template plan and a note saying so; the
 * bundled eight archetypes are always underneath, so a thin setup costs
 * variety, never a delivery.
 */
export function planSetupBudget(
  shape: SetupShape,
  history: SetupBudgetHistory = EMPTY_SETUP_BUDGET_HISTORY,
  options: { spentUsd?: number } = {},
): SetupBudgetDecision {
  const ratio = history.ewmaRatio;
  const spent = roundUsd(count(options.spentUsd));
  const adaptations: string[] = [];
  // A NON-FINITE value is nonsense (a replayed or hand-written shape), not an
  // instruction: it reads as "the usual number of templates" and the floor
  // below then applies. A finite ZERO is an instruction — see the plan's own
  // comment — so the two cannot share `count()`, which maps both to 0.
  const requestedTemplates = typeof shape.templates === "number" && Number.isFinite(shape.templates) ? Math.max(0, Math.floor(shape.templates)) : STUDIO_TEMPLATES_TARGET;
  let plan: SetupBudgetPlan = {
    // Zero asked for is zero planned. The floor exists so a setup that IS
    // building a template set never builds a useless one of two — it must not
    // invent four templates for a setup that has no studio work at all, which
    // is the real case where the 90-day visual-direction TTL (item Q) expires
    // inside the 120-day studio TTL (item N): the direction re-derives alone.
    // Inventing the four would put ~$0.25 of design work into the estimate
    // that no step can spend, and the estimate-vs-actual it recorded would
    // then mis-calibrate the NEXT setup downwards.
    templates: requestedTemplates === 0 ? 0 : Math.min(STUDIO_TEMPLATES_TARGET, Math.max(MIN_STUDIO_TEMPLATES, requestedTemplates)),
    repairsAllowed: Math.max(0, Math.floor(count(shape.repairs))),
    referenceImages: Math.max(0, Math.floor(count(shape.referenceImages))),
    setReview: shape.setReview,
    visualDirection: shape.visualDirection,
  };
  const initialEstimate = estimateSetupCost(plan, shape, ratio);
  let estimate = initialEstimate;
  const reprice = () => {
    estimate = estimateSetupCost(plan, shape, ratio);
  };
  const fitsTarget = () => roundUsd(estimate.estimatedUsd + spent) <= TARGET_SETUP_SPEND_USD;
  const fitsMax = () => roundUsd(estimate.estimatedUsd + spent) <= MAX_SETUP_SPEND_USD;

  // 1. Reference images: the format map then ranks from text only, and says so.
  for (const step of SETUP_REFERENCE_IMAGE_STEPS) {
    if (fitsTarget() || plan.referenceImages <= step) continue;
    plan = { ...plan, referenceImages: step };
    reprice();
    adaptations.push(
      step === 0
        ? "no reference-post images inspected — formats ranked from post text alone, recorded as an absent signal"
        : `reference-post images inspected cut to ${step}`,
    );
  }
  // 2. The set review — the residue call, the first thing that is purely optional.
  if (!fitsTarget() && plan.setReview) {
    plan = { ...plan, setReview: false };
    reprice();
    adaptations.push("no set review — the eight validation gates still run on every template");
  }
  // 3. Templates, down to the floor of four ("two formats is not a menu").
  while (!fitsTarget() && plan.templates > MIN_STUDIO_TEMPLATES) {
    plan = { ...plan, templates: plan.templates - 1 };
    reprice();
    adaptations.push(`${plan.templates} templates instead of ${plan.templates + 1}`);
  }
  // 4. Repairs.
  while (!fitsTarget() && plan.repairsAllowed > 0) {
    plan = { ...plan, repairsAllowed: plan.repairsAllowed - 1 };
    reprice();
    adaptations.push(
      plan.repairsAllowed === 0
        ? "no repair turns — a template that fails a gate is dropped rather than repaired"
        : `${plan.repairsAllowed} repair turn instead of ${plan.repairsAllowed + 1}`,
    );
  }
  // 5. Visual direction (item Q) deferred to the next setup.
  if (!fitsTarget() && plan.visualDirection) {
    plan = { ...plan, visualDirection: false };
    reprice();
    adaptations.push("visual direction deferred to the next setup — generated images keep the brand-kit fallback direction until then");
  }
  // 6. Past the HARD MAX only: below the template floor, on the cheapest
  //    complete path. This is the branch that replaces the refusal the owner's
  //    rule forbids.
  let belowTemplateFloor = false;
  while (!fitsMax() && plan.templates > CHEAPEST_PATH_STUDIO_TEMPLATES) {
    plan = { ...plan, templates: plan.templates - 1 };
    reprice();
    belowTemplateFloor = true;
    adaptations.push(`generated ${plan.templates} templates instead of ${MIN_STUDIO_TEMPLATES} on the cheapest complete path (past the ${formatUsd(MAX_SETUP_SPEND_USD)} hard max)`);
  }

  const note =
    (fitsTarget()
      ? adaptations.length === 0
        ? `setup budget: estimate ${formatUsd(estimate.estimatedUsd)} ≤ ${formatUsd(TARGET_SETUP_SPEND_USD)} → ${plan.templates} templates, full plan`
        : `setup budget: estimate ${formatUsd(initialEstimate.estimatedUsd)} > ${formatUsd(TARGET_SETUP_SPEND_USD)} → ${adaptations.join(", ")} (now ${formatUsd(estimate.estimatedUsd)})`
      : `setup budget: estimate ${formatUsd(initialEstimate.estimatedUsd)} > ${formatUsd(TARGET_SETUP_SPEND_USD)} → ${adaptations.join(", ")}; still ${formatUsd(estimate.estimatedUsd)} on the tightest plan — generating anyway, the live meter finishes on the cheapest complete path and the bundled archetypes cover whatever is not stored`) +
    (spent > 0 ? `; ${formatUsd(spent)} was already spent on this setup, so the target left for the rest of it is ${formatUsd(Math.max(0, roundUsd(TARGET_SETUP_SPEND_USD - spent)))}` : "");

  return {
    plan,
    estimate,
    initialEstimateUsd: initialEstimate.estimatedUsd,
    targetUsd: TARGET_SETUP_SPEND_USD,
    maxUsd: MAX_SETUP_SPEND_USD,
    calibration: { ratio: estimate.calibrationRatio, pastSetups: history.setups.length },
    spentBeforePlanUsd: spent,
    adaptations,
    belowTemplateFloor,
    note,
  };
}

/** Estimate vs actual for one setup — the gate payload's `setup.budget`, the deliverable's, and the ledger row's. */
export interface SetupBudgetSummary {
  estimatedUsd: number;
  actualUsd: number;
  targetUsd: number;
  maxUsd: number;
  crossedTarget: boolean;
  crossedMax: boolean;
  posture: SpendPosture;
  plan: SetupBudgetPlan;
  adaptations: string[];
  notes: string[];
  lines: SpendLine[];
}

export function summarizeSetupBudget(decision: SetupBudgetDecision, meter: RunSpendMeter, notes: readonly string[]): SetupBudgetSummary {
  return {
    estimatedUsd: decision.estimate.estimatedUsd,
    actualUsd: meter.totalUsd,
    targetUsd: decision.targetUsd,
    maxUsd: decision.maxUsd,
    crossedTarget: meter.crossedTarget,
    crossedMax: meter.crossedMax,
    posture: meter.posture,
    plan: decision.plan,
    adaptations: [...decision.adaptations],
    notes: [...notes],
    lines: [...meter.lines],
  };
}

/** The one-line "estimate vs actual" for a setup, in the same shape a run's reads. */
export function setupEstimateVsActualLine(
  summary: Pick<SetupBudgetSummary, "estimatedUsd" | "actualUsd" | "crossedTarget" | "crossedMax" | "plan">,
): string {
  const verdict = summary.crossedMax ? "over the hard max" : summary.crossedTarget ? "over target" : "under target";
  return `setup budget: estimated ${formatUsd(summary.estimatedUsd)}, actual ${formatUsd(summary.actualUsd)} (${verdict}) for ${summary.plan.templates} planned template(s)`;
}
