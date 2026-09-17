import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { InstagramCopyDraftSchema, type InstagramCopyDraft } from "../workflow/types.js";

/**
 * The output ceiling for `05-write-copy-attempt-N`, and the number
 * `__tests__/copy-schema-length.test.ts` holds the schema against.
 *
 * ## What actually happened, measured from the six prep runs of 2026-09-16
 *
 * This step declared no `maxTokens` and therefore inherited
 * `DEFAULT_MAX_TOKENS = 16384` — a default chosen for "the longest output
 * schema in this system" by a comment written before this schema existed. Five
 * of six later attempts across three runs died on it, each for a reported $0
 * (`messages-api-adapter.ts` threw before resolving usage; fixed in the same
 * phase). The run then re-judged an EARLIER draft, failed the same gates with
 * the same words, and shipped `degraded`. Every "findings return to the draft"
 * mechanism in this workflow was inert in production.
 *
 * ## Where the 16,384 tokens actually went, which is NOT where the brief assumed
 *
 * Reading the archived turns of the eight attempts that did complete:
 *
 * | run / attempt | output tokens | `thought` chars | `finalOutput` chars |
 * |---|---|---|---|
 * | karoslabs 21868183257380937 a1 | 16,305 | 50,520 | 8,109 |
 * | karoslabs 21868183257380937 a2 | 16,120 | 52,159 | 7,721 |
 * | geektime 21868533047825082 a3 | 16,323 | 37,814 | 5,256 |
 * | karoslabs 21850131523417857 a1 | 13,869 | 41,697 | 8,803 |
 *
 * **The copy is 1,500 to 2,400 tokens. The model's own planning prose is
 * 10,000 to 14,300.** Between 84% and 88% of the budget is `thought`, and the
 * three attempts that got closest to the wall are the three that planned
 * longest. Bounding the schema (item B3, and it is right to do) buys back at
 * most a tenth of the ceiling; **raising the ceiling is the fix, and the schema
 * bound is the guard that keeps it a fix.**
 *
 * ## Why 32,000 and not 20,000 or 64,000
 *
 * The worst observed demand is 16,323 tokens in a turn that was still cut off,
 * so the true demand is unknown and above it. 32,000 is 2.0x the largest turn
 * ever completed here and ~2.2x the largest `thought` plus the largest
 * `finalOutput` ever seen together (14,300 + 2,400). It costs $0 until it is
 * used — an output ceiling is a limit, not a purchase — and the pathological
 * case of a model that fills it is $0.48 of output against the $0.24 the
 * measured attempts booked, which under the 2026-09-16 cost ruling (quality
 * first, budgets adapt and never hold) is the right side to be wrong on.
 * `run-budget.ts`'s `copyAttempt` key is re-priced for the SCHEMA and PROMPT
 * deltas, not for this: a ceiling nobody reaches bills nothing.
 *
 * Going further, to 64,000, would be fitting the ceiling to the schema's
 * theoretical maximum rather than to measured demand, and would make the guard
 * test's 60% assertion vacuous.
 */
export const COPY_MAX_TOKENS = 32_000;

/**
 * RFC-03 §3 step 05: "write the copy — six to eight slides, one idea each"
 * (enforced directly by `InstagramCopyOutputSchema`'s `.min(6).max(8)`, so
 * an out-of-range draft is a schema-validation `content_fail` at the agent
 * level, not something a later step has to notice). Pinned tier — RFC-03 §1
 * required-reading item 5 calls this "the creative judgment call," matching
 * `LinkedInDraftAgent`'s own pinned pattern exactly.
 *
 * Every claim traces to a step-04 source: `sourceRef` on each slide names a
 * `facts[].claim` from `InstagramResearchAgent`'s output verbatim, which is
 * what step 07's self-check verifies before the post ever reaches the
 * renderer.
 *
 * `allowedTools: []` — everything this step needs (topic, facts, the frozen
 * style config's copy-relevant fields, brand tokens) is hand-assembled by
 * the workflow ahead of time, same reasoning as `InstagramResearchAgent`.
 * On a step-07 self-check failure the workflow re-invokes this same agent
 * with a fresh step id (`WF-05-write-copy-attempt-N`) rather than looping
 * inside the agent itself — RFC-03 §3 step 07's "RETURN: 05" is a Layer 1
 * concern (which checkpointed step to re-run), not a Layer 2 one.
 */
export class InstagramCopyAgent extends BaseAgent<InstagramCopyDraft> {
  protected readonly config: AgentStepConfig<InstagramCopyDraft> = {
    id: "instagram-copy",
    description: "Write an Instagram post in the requested format: 6-8 carousel slides (one idea each) or one designed slide with a deep caption, every claim traced to a sourced research fact.",
    allowedTools: [],
    // The DRAFT schema, which is `InstagramCopyOutputSchema` minus the authored
    // `customArchetype` markup — see `InstagramCopyDraftSchema`. A draft is
    // assignable to `InstagramCopyOutput`, so the workflow's own type is
    // unchanged; what changed is what the model is asked to produce.
    outputSchema: InstagramCopyDraftSchema,
    maxTokens: COPY_MAX_TOKENS,
    // Default is 1. A malformed turn on THIS step is a quality event, not a
    // tooling failure: the model answered and its answer did not clear a
    // schema, which `opus-drops-type-discriminator`-class truncation and a
    // missing `type` discriminator both look like. One more turn costs ~$0.24
    // against a whole $0.35 attempt AND against the attempt budget itself,
    // which is the scarce resource (three attempts, and a spent one is a
    // redraft the post never gets). Raised here and nowhere else, because this
    // is the only step whose retry is cheaper than its failure.
    maxMalformedTurns: 2,
    // Pinned — RFC-02 §5's rationale applies identically here: drafting/
    // brand-voice judgment is never a fallback-eligible step.
    //
    // `contentLanguageSensitive` (AU34 / SCRUM-312): this is the step that
    // writes the words the client's audience reads, so it is the step whose
    // model has to be able to write them in the client's own language. When
    // the client's brand kit states a non-English `language`
    // (AU31/SCRUM-309), `applyClientLanguagePolicy` re-points this step at a
    // catalogued model that AU33's capability table rates as capable of it —
    // per client, at run time, with no deployment change. That supersedes the
    // `MODEL_STEP_INSTAGRAM_COPY_VENDOR`/`_MODEL` env pair (AU32/SCRUM-310),
    // which still works and is still the only way to move this step to a
    // different VENDOR, but is one global setting for every tenant in the
    // process and so cannot be right for two clients publishing in two
    // languages. `pinned` is unaffected: this changes which model the step is
    // pinned TO, it does not make the step fallback-eligible.
    modelPolicy: resolveModelPolicy("instagram-copy", { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: true }),
    // Pinned to "2": v1 stays frozen as the pre-photographability baseline,
    // the same convention every other agent here follows. v2 adds the
    // single-photographable-scene rules to §4 — prep run
    // pubsub-21535110633863323 held on a slide needing "a timeline or roadmap
    // with a clearly labeled 'research' first phase, shot from above", which
    // v1 actively encouraged by asking for precision with no sense of what
    // can be pictured.
    // Pinned to "3": v3 is v2 with every em dash removed. v1 and v2 both
    // banned em dashes in the copy while using nine and eleven of them
    // respectively, and the model imitates the register of its instructions:
    // prep run pubsub-21066191524607951 failed the mechanical craft-hygiene
    // gate on two of three attempts on exactly that character. v1 and v2 stay
    // frozen.
    // Pinned to "4": v4 is v3 plus §5, the layout-archetype menu. Until it,
    // `layout` existed in the schema but nothing ever asked the model to
    // choose one, so every slide defaulted to `photo` and the five ported
    // archetypes were reachable only as a fallback — a carousel could not
    // deliberately set a number large or a quote as a quote. v4 also states
    // the two rules that keep the choice honest: fill the block you named,
    // and never invent a statistic or a quote to justify an archetype. v3
    // stays frozen as the pre-archetype baseline.
    // Pinned to "5": v5 is v4 plus the two rules that stop retrieval failing
    // for reasons the copy step controls. §4 gains a hard constraint budget
    // (one subject, one setting, at most one more constraint, ~12 words),
    // because a long scene description does not return nothing from a keyword
    // index, it returns near-arbitrary matches the gate then pays to reject.
    // §5 gains an explicit routing table: a number, a chart, a comparison or a
    // list is NOT a photo, and writing it as a photo brief is what sent prep
    // run pubsub-21545408480430711's four data slides through retrieval,
    // scrape and into generation. v4 stays frozen.
    // Pinned to "6": v6 adds a required `caption` (the post's own text below
    // the carousel, distinct from any slide's baked-in headline/body) — until
    // it, the schema had no such field at all, so a reviewer approving a post
    // saw either nothing or a raw join of every slide's field values including
    // `accentColor`'s hex code (prep run 2VFCw79Wu8xfJOKXC7zP). v6 also
    // upgrades the archetype-variety guidance from a soft "aim for a mix" to
    // an explicit one-per-carousel rule for the five structured archetypes,
    // matched by a mechanical downgrade in `resolveLayout` — the same run
    // shipped two `stat_callout`s and two `comparison_card`s in one post. v5
    // stays frozen.
    // Pinned to "7": v7 adds §1, a check for the client's own stated
    // language before anything else is written. Nothing before it ever read
    // the client's profile/voice-rules for a language requirement at all —
    // the workflow itself never even called those tools — so an outlet that
    // states its own language in plain prose (Geektime: "Israel's largest
    // Hebrew-language technology... site") got a fluent, well-sourced,
    // entirely English carousel with every other check passing (prep job
    // hcf9ymPGJC7mDS5pcEQ4). v6 stays frozen.
    // Pinned to "8": v8 adds `layout: "custom"` — the rare escape hatch to
    // author a brand-new typographic archetype (`customArchetype`'s
    // `bodyHtml`/`css`/`slots`/`fields`) when none of the six standard ones
    // fit. Machine-validated (`assertSafeMarkup` in
    // `@agent-engine/tool-karos-templates`) before it is ever rendered, and
    // only enrolled into the shared template registry on an explicit
    // reviewer approval (`promoteTemplate`) — never from this step alone.
    // v7 stays frozen.
    // Pinned to "9": v9 adds the client-knowledge-and-recent-posts section
    // — clientIntelContext (the client's own intel report, distilled) is read
    // as authoritative before external facts, and recentPosts (the shipped-
    // output dedup window this agent now writes back into on delivery) is a
    // hard do-not-repeat constraint. v8 stays frozen.
    // Pinned to "10": v10 (SCRUM-241/T-A9) documents `brandingGuidelines` —
    // the client's own projected branding-guidelines context doc (C1) — in
    // §11, and tells the model it bears on `visualNeed`/archetype choice and
    // outranks this guide's own generic instincts when the two conflict.
    // v9 stays frozen.
    // Pinned to "11" (2026-09): v11 adds the elite-tier sections. §12 the
    // post FORMAT (`format`: a 6-8 slide carousel, or a single designed slide
    // with a deep caption that carries the argument in short lines), §13
    // `attachedMedia` (the client's uploads as a vision model described them,
    // so slide N is written TO the client's picture N), and §14
    // `trendCandidate` (a scouted story with its angle, hook, why-now and
    // brand-fit bridge). v10 stays frozen.
    // Pinned to "12" (2026-09, Instagram Phase 0 grounding gate): v12 adds
    // §15, "Who this client is" — `clientBrief` (the Client Brief from
    // `client.getBrief` or the deterministic derivation in
    // `workflow/client-brief.ts`: positioning, ICP, offers, core terms,
    // forbidden claims, language) is read BEFORE the facts and every slide
    // must be legible as this business speaking to its audience; and
    // `relevanceSteer`, the relevance judge's verdict from a failed
    // attempt, which must be fixed rather than argued with. §7 gains the
    // three default render rules (cover carries a device, numbers are
    // devices, closer carries a CTA) the deterministic 07h check enforces.
    // v12 also fixes the H1, which said "v10" from v10 through v11. The
    // 2026-09-08 prep audit: an AI marketing agency shipped a real-estate
    // carousel that cleared every gate, because no prompt or check ever
    // said who the client was. v11 stays frozen.
    // Pinned to "13" (2026-09, Instagram Phase 1 item K): v13 adds §17, "The
    // angle" — `angle.chosen` (the editorial decision `04i-propose-angles`
    // proposed and `04j-select-angle` picked, deterministically) is what the
    // carousel argues, its `rememberLine` appears on the cover or the closer
    // near-verbatim in the target language, and the two `rejected` angles are
    // context only, never blended in; an input with no `angle` block writes
    // exactly as v12 did, so the fail-open path needs no second prompt. §18
    // routes item J's fact-card `kind`s: `stat` to a `stat_callout` or
    // `comparison_card` (under §7's one-per-carousel rule), `quote` to a
    // `quote_card` attributed from the card's own `source`, `event` to a
    // dated slide, `definition` to prose, plus the `~date` and
    // `primary: true` rules. The 2026-09-08 prep audit's five auto runs were
    // correct, sourced and unmemorable because nothing in the pipeline ever
    // decided what a post was FOR. v12 stays frozen as the Phase 0 baseline.
    // v13 also rewrites §14 for item I's five topic engines: `trendCandidate`
    // now carries `engine`, and only `niche-news` may be written as news —
    // an `own-assets` or `evergreen` subject has no week in it, so nothing on
    // a slide may say "this week" unless a fact card carries the date.
    // Before this, `engine` was dropped on the way to the prompt and §14 told
    // the writer the scout had "found a live story", which turned every
    // evergreen subject's `whyNow` into an invented timeliness claim no
    // downstream check could catch.
    // v15 (Phase 3, item R, 2026-09): `visualNeed` becomes a scene brief —
    // what is in frame, why the slide is weaker without it, an explicit
    // source choice (client-upload / stock / generate / none) and optional
    // `searchTerms`. §6's keyword-search prose shrank because the split made
    // it obsolete: retrieval reads `searchTerms`, generation and vetting read
    // the scene. §22 documents the new field and states the bias — photo-
    // driven is the default, `"none"` is for ideas that are not
    // photographable, and a `"none"` slide must carry a device
    // (`default:no-image-means-device`).
    //
    // Cost, BOTH halves — the input one is the smaller one. Input: +1,822
    // prompt characters ≈ +455 tokens ≈ +$0.0014 per attempt. Output: the
    // four-key `visualNeed` object replaces a ~12-word string on EVERY
    // slide, ≈115-130 tokens against ≈18, so ≈+800 output tokens per draft ≈
    // +$0.012 at $15/1M — nine tenths of the growth, and invisible to an
    // input-only count. `STEP_COST_ESTIMATES_USD.copyAttempt` is re-priced
    // 0.1455 → 0.159 in the same commit, which is the rule `run-budget.ts`
    // states about itself. A `"none"` slide still saves six vision
    // inspections ($0.006), so a carousel with two of them gives back
    // roughly what the prompt growth costs — but the estimator does not
    // bank that, because `DEFAULT_RUN_SHAPE.photoSlides` stays at 6.
    //
    // v16 (Phase 4, RFC-15 §4, 2026-09-12): §23 "Writing in the target
    // language as a native". The writer receives a new `languageBrief` field
    // — a persona derived from the client's own profile, a register card
    // MEASURED from their real posts, a term policy, a convention pack and up
    // to six of their own published posts as exemplars — and §23 makes it
    // BINDING and superior to every stylistic instinct in §1-§14 when it is
    // present. §1 is DEMOTED rather than deleted ("when `languageBrief` is
    // absent, do this"), so an English run reads identically to @15 and the
    // registry's `requires.languageDirective` marker, which looks for the
    // literal `clientVoiceContext`, stays satisfied. §16 gains `nativeSteer`
    // beside `selfCheckSteer`: a correction arrives as an anchored quote and
    // a proposed replacement, is applied rather than argued with, and never
    // moves a number, a date, a name or a claim while being applied.
    //
    // Cost, BOTH halves stated separately — and this time the OUTPUT half is
    // ZERO, which is the whole point of stating them apart. Input: +3,020
    // prompt characters (43,519 → 46,539) ≈ +760 tokens ≈ +$0.0023 per
    // attempt, paid on English runs too because the prompt file is one file.
    // Output: UNCHANGED. §23 changes how the copy reads, not how much of it
    // there is — no new output field, no new per-slide object, nothing that
    // scales with the slide count. The @14→@15 note above records the
    // opposite error (an output-heavy bump priced on input alone,
    // under-counting by nine tenths); the guard against repeating it is to
    // count both sides every time, including the times one side is zero.
    // `STEP_COST_ESTIMATES_USD.copyAttempt` is re-priced 0.159 → 0.161 in the
    // same commit, which is the rule `run-budget.ts` states about itself.
    //
    // The `languageBrief` FIELD is priced separately, as
    // `STEP_COST_ESTIMATES_USD.copyLanguageBrief` ($0.009 ≈ 3,000 in-tokens),
    // and only on runs with a resolved `targetLanguage` — the field is
    // conditional, the prompt section is not, and charging an English run for
    // a payload it does not carry would pull an image lever for nothing.
    //
    // v17 (Phase 5, RFC-18 §3, 2026-09-13): the guide is rewritten around
    // VALUE. §2 makes the caption three jobs in one string (a hook of at most
    // twelve words carrying the post's position, a body that pays off the
    // cover's tension, and the ask as the final paragraph) rather than "two to
    // four short sentences". §3 makes the slide count follow the declared
    // payload instead of a configured constant. §5 is replaced: one claim a
    // slide, and a body whose second half is a CONSEQUENCE for the reader
    // rather than a restatement. §12 gains `payloadKind`. §16 gains
    // `valueSteer`, a fifth typed steer that is a rewrite instruction rather
    // than an anchored span, plus the sentence that stops the classic
    // multi-attempt regression: text quoted under KEEP AS WRITTEN has already
    // been accepted and is reproduced unchanged. §24-§27 are new: the payload
    // and the named specific (carrying `gate.lintPost`'s banned-CTA bank
    // verbatim, as wordings that fail the draft on contact), taking a
    // position, rhythm, and the ban on reproducing a source's prose. The
    // ground-truth discipline — reference EXECUTION transfers, reference
    // SUBJECT MATTER never does — is written into BOTH §15 and §24 so an
    // editor cannot drop it from one and leave the file looking complete, and
    // every worked example is set in a neutral trade for the same reason.
    // v16 stays frozen as the Phase 4 baseline.
    //
    // v17 also removes the last em dashes and double hyphens from the
    // INHERITED sections (seventeen and nine of them, including §5's own
    // editor's note, which was an HTML comment and therefore made of them).
    // The file now contains none of the three characters anywhere, which is
    // what §5's note has asked for since v3 and what `copy-prompt-v17.test.ts`
    // asserts. A prompt that bans a character while using it teaches the model
    // to ignore the ban, and prep run pubsub-21066191524607951 failed craft
    // hygiene on exactly that character twice in three attempts.
    //
    // Cost, BOTH halves stated separately, and MEASURED rather than
    // estimated. Input: +16,301 prompt characters (45,805 → 62,106, counted
    // with line endings normalised, since a CRLF checkout would otherwise
    // inflate the figure by one byte a line and make the same file price
    // differently on two machines) ≈ +4,075 tokens ≈ +$0.0122 per attempt,
    // paid on English runs too because the prompt file is one file. The same
    // measurement is made independently in `run-budget.ts`'s `copyAttempt`
    // block, from the same two files, and the two must agree.
    // Output: `payloadKind` is one enum value, ≈ +10
    // tokens ≈ +$0.00015 — and nothing else grows, deliberately: §5's so-what
    // lives inside `body` and the caption's three jobs are structure inside
    // the one `caption` string, so neither is a per-slide field. RFC-18 §7.1
    // estimated +6,000 characters and priced `copyAttempt` at 0.166; the file
    // is larger than the estimate, so `STEP_COST_ESTIMATES_USD.copyAttempt` is
    // re-priced 0.161 → 0.174, and the prompt's own version ledger states the
    // same measured numbers. Pricing a bump against the estimate rather than
    // against the file is the @14→@15 error in the other direction.
    //
    // NOTE FOR THE INTEGRATOR, 2026-09-13: `run-budget.ts` carries this same
    // argument in full — it has a comment section headed "WHY THIS IS 0.174
    // AND NOT RFC-18 §7.1's 0.166" — but the CONSTANT it guards was still
    // `copyAttempt: 0.166` when this package was written, so the file
    // currently disagrees with its own comment. The pricing key is not this
    // package's to edit; the correction is reported as a cross-file
    // obligation rather than made here.
    //
    // RESOLVED before @17 shipped: `run-budget.ts` carries `copyAttempt: 0.174`
    // on `main` and `run-budget.test.ts` pins it. The NOTE above is kept as the
    // record of the obligation, not as a live statement of the constant.
    //
    // v18 (design system, RFC-17 §5.7, 2026-09-13): §28 "Marking", and @18 is
    // @17 PLUS THAT ONE SECTION — every v17 value rule above is inherited
    // verbatim, not re-opened. The writer names one to five spans per slide
    // whose MEANING carries it — the noun a list row defines, the clause
    // carrying the surprise, the term the reader will screenshot — as BARE
    // STRINGS copied VERBATIM out of the field it already wrote. There is no
    // field name and no index: code searches headline, body, quote, then the
    // rows in order, and a string that occurs nowhere is dropped rather than
    // resolved to the wrong words. It
    // chooses WHICH words and never the colour, the weight or how the mark is
    // drawn: code picks the kind from the slide's ground luminance and rotates
    // the ring, which is the one thing the model cannot see (RFC-17 finding 2).
    // §28 also carries the topic rule verbatim (execution transfers, subject
    // matter never does) and states its own interaction with §10:
    // `checkSentenceCase` still refuses shouting, and marking is now the
    // sanctioned way to emphasise.
    //
    // Cost, BOTH halves counted — and here BOTH are non-zero, which is why
    // neither the @14→@15 shape (output-heavy, priced on input alone) nor the
    // @15→@16 shape (input-only) is the right template for it:
    //
    //   Input:  +3,276 prompt characters ≈ 819 tokens x $3/1e6 = $0.00246.
    //           Paid on English runs too — one prompt file, no conditional
    //           include. That is the WHOLE FILE delta (67,929 - 64,653, line
    //           endings normalised), never §28 alone: §28 measures 2,836 and
    //           the same file also carries a changelog block, so a section
    //           delta under-counts. THE MODEL IS SENT EVERY BYTE OF THE FILE.
    //           That rule is what 0.179, 0.180 and 0.184 were each produced
    //           by breaking. (918 characters of the changelog were also cut
    //           here: it described the superseded OBJECT encoding and quoted
    //           three numbers that are now false. Stale documentation inside
    //           a prompt is not documentation, it is a bill.)
    //   Output: the `emphasis` array, a FLAT ARRAY OF VERBATIM STRINGS
    //           (`["Business", "Founder", "Know"]`) — ≈22 tokens a slide (3.6
    //           marks at ≈5 tokens each, the rf-05 mean span being 2.6
    //           word-tokens, plus 4 array overhead) x 8 slides = 176 tokens
    //           x $15/1e6 = $0.00264.
    //   Total:  $0.00510 an attempt, rounded UP.
    //
    // The first encoding named `field`/`itemIndex`/`text` per mark (≈17 output
    // tokens each, ≈$0.00780) and was re-encoded because it did not FIT: the
    // cold Hebrew plan has $0.00757 an attempt of headroom to the $1.00
    // target, and that output half ALONE exceeded it, firing the attempt rung
    // and reproducing a held run on two cases named "NEVER holds". The mark
    // COUNT was deliberately not cut — rf-05's near-empty closer carries four
    // marks — so the mechanism got cheaper rather than smaller. RFC-17 §6.4.
    //
    // `STEP_COST_ESTIMATES_USD.copyAttempt` is re-priced **0.174 → 0.181** in
    // the SAME commit, which is the rule `run-budget.ts` states about itself.
    // The base is @17's MEASURED 0.174, NOT RFC-18 §7.1's superseded 0.166
    // forecast: this branch was written against 0.161 and computed 0.171, and
    // both of those bases are now stale. A fourth stale number, **0.184**,
    // shipped in the Phase 5 merge and priced the OBJECT encoding; restoring
    // it would over-count by $0.0042 an attempt now that a mark is a bare
    // string. See `run-budget.ts`'s `copyAttempt` block for the full
    // arithmetic and for the measured cold-Hebrew plan at each candidate key.
    // At the 3-attempt cap the @18 delta is +$0.021 against the owner's $1.00
    // target (2.1%) and the $1.50 hard max (1.4%), and no new model step at
    // run time or at setup: the mark ring is derived in code from the kit's
    // accent ring, so per-client setup moves by exactly $0.000 (RFC-17 §6.2).
    //
    // v19 (RFC-21 Part 3, the series layer, 2026-09-14): ONE additive section,
    // §29 "Your series". When the input carries a `seriesDirective` the layout
    // of every slide is already decided and §7's layout MENU does not apply —
    // every other rule in §7, including what each archetype REQUIRES, applies
    // unchanged, and the section says so in those words because that is the
    // whole safety argument for handing a writer a skeleton.
    //
    //   Input:  +3,726 prompt characters (69,629 -> 73,355) ≈ 932 tokens x
    //           $3/1e6 = $0.00280, plus the directive itself on the input
    //           object — the premise, the register and one numbered line per
    //           slide, ≈700 characters ≈ 175 tokens = $0.00053.
    //   Output: $0.000. No new field. The writer emits the same schema; what
    //           changed is that it no longer chooses `layout`, and `layout`
    //           was already being emitted.
    //   Total:  $0.00333 an attempt, and `STEP_COST_ESTIMATES_USD.copyAttempt`
    //           is re-priced **0.181 -> 0.185** in the SAME commit, which is
    //           the rule `run-budget.ts` states about itself. Rounded up.
    //
    // It FAILS OPEN, which is why it is additive rather than a rewrite: a run
    // whose series step did not complete sends no `seriesDirective`, §29 says
    // so explicitly, and the draft reads identically to @18.
    //
    // v21 (Phase 5.5, brief items B and A3, 2026-09-16): the first bump whose
    // job is to make the OUTPUT SMALLER and the ceiling reachable. Four edits,
    // three of them subtractive:
    //
    //   1. §20 no longer asks for markup. The writer emits
    //      `customArchetypeBrief` (archetype id, name, rationale, slots) and
    //      `05f-author-custom-archetype` writes the `bodyHtml`/`css`/`fields`.
    //      That is the largest single block removed from an output schema that
    //      had no maximum, and ~800 characters given back on the input side.
    //   2. §5 states the new field bounds, so a writer knows where the schema
    //      wall is rather than discovering it as a lost draft.
    //   3. §7 gains the `unfillable` rule, which is the field half of the fix
    //      for the work-note geektime's slide 4 shipped to the reader. The
    //      instruction that produced it lives in `editorial-series.ts` and is
    //      changed there; this is where the writer is told where to put it.
    //   4. §7's cover rule is tightened to spec §4.5: a cover carries ONE
    //      subject and no furniture. The 2026-09-16 covers were a gradient, a
    //      small device and a title in the lower third, and the owner's verdict
    //      on the first slide was "יחסית ריק ומשעמם".
    //
    // Cost, BOTH halves, MEASURED off the two files (the rule this ledger has
    // followed since the @14 -> @15 error, which priced an output-heavy bump on
    // its input alone and under-counted by nine tenths):
    //
    //   Input:  +4,415 prompt characters (78,829 -> 83,244, line endings
    //           normalised, WHOLE FILE as always) = +1,104 tokens x $3/1e6 =
    //           +$0.0033 an attempt, paid on English runs too because the
    //           prompt file is one file. §20 gives back 805 characters; the
    //           field-bound table, the cover rules, the `unfillable` rule and
    //           the ledger itself spend 5,220. The prompt's own version ledger
    //           states the same four numbers and the two must agree.
    //   Output: the `customArchetype` block is GONE from this step's schema.
    //           None of the six 2026-09-16 runs emitted one, so the MEASURED
    //           saving on those runs is $0.000 and it is stated that way rather
    //           than claimed: what changes is the WORST CASE, from an uncapped
    //           record plus 8,000 characters of markup (~2,200 tokens on a
    //           single slide) to a ~60-token brief. `unfillable` is optional
    //           and was emitted zero times in 61 measured slides.
    //   Total:  +$0.0033 an attempt, and the thing the phase actually buys is
    //           the attempt that stops being lost: five of six redrafts on
    //           2026-09-16 died at the ceiling, each one a ~$0.33 draft that
    //           bought the post nothing.
    //
    // `STEP_COST_ESTIMATES_USD.copyAttempt` is NOT re-priced here, and that is
    // a reported obligation rather than an omission. `run-budget.ts` belongs to
    // W1-C in this phase and two hands on that file is the collision this
    // phase's rules exist to stop. The number it needs is `0.185 -> 0.189`
    // (+$0.0033, rounded up), and it is the SMALLER of the two corrections that
    // key is owed: the larger one is the one W1-A's cost fix exposes, since a
    // truncated attempt now books ~$0.33 where it used to book $0. Stated in
    // the package's integration notes so it cannot be lost between the two.
    //
    // `05f-author-custom-archetype` is priced separately at $0.030, at most
    // once per carousel and only when a draft asks for it. See
    // `InstagramCustomArchetypeAgent`.
    skillRef: "instagram-copy@23",
  };
}
