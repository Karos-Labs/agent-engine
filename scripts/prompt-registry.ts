/**
 * SCRUM-325 (AU44) — the TYPED PROMPT REGISTRY.
 *
 * Before this file, every script that needed to know "what prompts exist"
 * walked `agents/<agent>/prompts/<promptId>/` and believed whatever it found.
 * `setup-local.ts` walked it, `publish-prompts.ts` walked it, and because a
 * walk cannot disagree with the disk it is reading, neither could ever notice
 * that something on disk was wrong. That is what let `blog-craft` and
 * `newsletter-craft` carry a `latest.md` that matched none of their numbered
 * versions for three commits: the walk simply reported what was there, and
 * `publish-prompts.ts` then SYNTHESIZED a phantom `v4` out of the drifted
 * `latest.md` and repointed `latestVersion` at it.
 *
 * A registry fixes that by being a SECOND, independent statement of the same
 * fact. `PROMPT_REGISTRY` below is hand-maintained and code-reviewed; the
 * disk is discovered separately; `diffRegistryAgainstDisk()` compares them.
 * A prompt added, removed, renumbered, re-owned or re-pointed without the
 * registry entry changing is a CI failure, and vice versa. Neither side is
 * trusted over the other — they are required to agree.
 *
 * Per-prompt hygiene lives here too (`requires`), for the same reason: a
 * guardrail sentence that a prompt is SUPPOSED to carry is only enforceable
 * if something outside the prompt says it is supposed to carry it. See
 * `HYGIENE_MARKERS` for what each flag actually looks for.
 *
 * Consumed by `scripts/check-prompts.ts` (CI) and `scripts/publish-prompts.ts`
 * (which now enumerates from here instead of from a walk).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

// scripts/*.ts compiles as CommonJS under the root tsconfig — see setup-local.ts's own note.
export const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * Per-prompt hygiene requirements, asserted against the prompt's own text.
 *
 * Every flag defaults to FALSE. A prompt only has to carry a guardrail when
 * this registry says it does — an unconditional "every prompt must say X"
 * rule would be satisfied by all 28 prompts today and could therefore never
 * fail, which is the exact shape of defect this repo keeps finding.
 */
export interface PromptHygiene {
  /**
   * AU31's language directive: the prompt must tell the model to read
   * `clientVoiceContext` for a stated-or-implied language and draft the whole
   * deliverable in it. Required of every client-facing DRAFTING prompt.
   * `blog-craft`/`newsletter-craft`'s drifted `latest.md` had silently lost
   * exactly this sentence — a run resolving "latest" drafted in English for a
   * Hebrew-language outlet, with nothing to catch it.
   */
  readonly languageDirective?: boolean;
  /**
   * Anti-hallucination: the prompt must contain an explicit "do not invent"
   * instruction AND name `gate.numbersSourced`, the deterministic validator
   * that actually rejects an unsourced number. Prose without the gate name is
   * an unenforced request; the gate without prose makes the model guess and
   * then fail. Required of every prompt whose output carries statistics.
   */
  readonly numbersSourced?: boolean;
  /**
   * Structured output: the prompt must name the output fields the agent's zod
   * schema actually requires (see `structuredOutputFields` below) — a prompt
   * that never mentions a required field produces a schema violation at run
   * time, not a graceful degradation.
   */
  readonly structuredOutput?: boolean;
}

export interface PromptRegistryEntry {
  /** `promptId` — the directory name, and the left half of every `skillRef`. */
  readonly promptId: string;
  /** The agent package under `agents/` that owns and ships this prompt. */
  readonly agent: string;
  /** Every numbered `N.md` that must exist on disk, ascending. Published versions are immutable; a change means a NEW number. */
  readonly versions: readonly string[];
  /** The version `latest.md` must be byte-identical to, and what `prompts/{promptId}.latestVersion` is published as. */
  readonly latestVersion: string;
  /** Guardrails this prompt is required to carry. */
  readonly requires?: PromptHygiene;
  /** Output-schema field names the prompt text must mention. Only read when `requires.structuredOutput` is set. */
  readonly structuredOutputFields?: readonly string[];
}

/**
 * What each `PromptHygiene` flag looks for in the prompt text. Case-insensitive
 * substring alternatives — a marker is satisfied when ANY alternative appears.
 *
 * Deliberately NOT regex-clever: the point is to detect a guardrail that was
 * dropped wholesale (which is what actually happened), not to grade phrasing.
 */
export const HYGIENE_MARKERS = {
  languageDirective: ["clientvoicecontext"],
  numbersSourcedProse: ["never invent", "do not invent", "don't invent"],
  numbersSourcedGate: ["gate.numberssourced"],
} as const;

/**
 * Every `gate.*` name a prompt is allowed to name, taken from the tool
 * registry `createKarosGatesTools()` actually returns
 * (`packages/tools/karos-gates/src/index.ts`). A prompt instructing the model
 * to satisfy a gate that does not exist is an unenforced instruction dressed
 * as an enforced one.
 *
 * Kept as a literal rather than imported so this script has no compile-time
 * dependency on a workspace package's built `dist/` — `check-prompts.ts` runs
 * on a fresh checkout, before `npm run build`. `check-prompts.ts` re-derives
 * the same list FROM that source file at run time and fails if the two
 * disagree, so this copy cannot silently rot.
 */
export const KNOWN_GATES = [
  "gate.lintPost",
  "gate.noPlaceholder",
  "gate.brandCompliance",
  "gate.leakCheck",
  "gate.numbersSourced",
  "gate.subredditRules",
  // Phase 4 (RFC-15 §5). The deterministic half of the plan's `gate.nativeLanguage`: per-field script
  // coverage, forbidden transliterations, curly quotes, nikud, foreign digits, Latin month names and bidi
  // control characters — no model call. It is listed here the instant `instagram-copy@16` §23 names it,
  // because `check-prompts.ts` cross-checks this literal against `createKarosGatesTools()`'s actual returns
  // and either half alone is a CI failure.
  "gate.nativeLanguage",
] as const;

/**
 * THE REGISTRY. Ordered by promptId. Edit this deliberately when you add,
 * renumber or re-own a prompt — CI fails if it disagrees with `agents/`.
 */
export const PROMPT_REGISTRY: readonly PromptRegistryEntry[] = [
  {
    promptId: "blog-craft",
    agent: "blog-agent",
    versions: ["1", "2", "3", "4"],
    latestVersion: "4",
    requires: { languageDirective: true, numbersSourced: true, structuredOutput: true },
    structuredOutputFields: ["bodyMarkdown", "slug", "excerpt", "estimatedReadMinutes", "faqItems"],
  },
  { promptId: "branded-shorts-graphics", agent: "branded-shorts-agent", versions: ["1", "2", "3"], latestVersion: "3" },
  { promptId: "branded-shorts-highlights", agent: "branded-shorts-agent", versions: ["1"], latestVersion: "1" },
  { promptId: "branded-shorts-style-exploration", agent: "branded-shorts-agent", versions: ["1"], latestVersion: "1" },
  { promptId: "campaign-craft", agent: "campaign-orchestrator", versions: ["1"], latestVersion: "1" },
  // Phase 1, item K. No `requires.languageDirective`: that marker looks for
  // the literal `clientVoiceContext`, which the angle prompt is not given —
  // it receives the resolved `targetLanguage` instead.
  { promptId: "instagram-angle", agent: "instagram-agent", versions: ["1"], latestVersion: "1" },
  // Phase 1, item H. Same reason for no `requires` flags: the brief prompt
  // receives `targetLanguage`, not `clientVoiceContext`, and it outputs no
  // statistics for the numbers gate to source.
  { promptId: "instagram-brief", agent: "instagram-agent", versions: ["1"], latestVersion: "1" },
  // Phase 3, item Q. No `requires` flags for the same reason as
  // `instagram-brief`: the art director receives the resolved
  // `targetLanguage` and never `clientVoiceContext` (so the
  // `languageDirective` marker would be unsatisfiable — its output is an
  // English generation brief for an image model, never client-facing copy),
  // and it names no `gate.*`.
  // Phase 5.5, item D. @2 adds the six frozen per-client axes (`ClientVisualSystem`) — the
  // display register, composition grammar, ground texture and the rest — so two clients stop
  // resolving to the same visual system. Runs once per client per 90 days on the setup meter.
  { promptId: "instagram-art-director", agent: "instagram-agent", versions: ["1", "2"], latestVersion: "2" },
  // Phase 4 (RFC-16 §2.2), the concept direction. No `requires` flags for the
  // same reason `instagram-art-director` has none: it receives the resolved
  // `targetLanguage` and never `clientVoiceContext` (so the `languageDirective`
  // marker, which looks for that literal, would be unsatisfiable — its output
  // is an English generation brief for an image model, never client-facing
  // copy), it names no `gate.*`, and every figure it can touch is copied
  // verbatim out of a fact card the research already sourced.
  { promptId: "instagram-concept", agent: "instagram-agent", versions: ["1"], latestVersion: "1" },
  {
    promptId: "instagram-copy",
    agent: "instagram-agent",
    versions: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24"],
    latestVersion: "24",
    // `requires` is UNCHANGED at @16. §23 makes `languageBrief` binding when it is present, but §1 is
    // demoted rather than deleted, so the `languageDirective` marker — which looks for the literal
    // `clientVoiceContext` — is still satisfied, and an English run reads identically to @15.
    //
    // Phase 5 (RFC-18 §3), @17: the guide is rewritten around VALUE — §2's caption as three jobs in one
    // string, §5's one claim plus its consequence, §12's `payloadKind`, §16's `valueSteer`, and the four new
    // sections §24-§27. `requires` is UNCHANGED again, and for a reason worth stating rather than inferring:
    // §1 and §15 both still carry the literal `clientVoiceContext`, so the `languageDirective` marker is
    // satisfied by two independent sections. It names no NEW gate either — §23's `gate.nativeLanguage` is
    // inherited verbatim from @16 and is already on `KNOWN_GATES`, so **`KNOWN_GATES` is untouched by Phase
    // 5**. `numbersSourced` is deliberately still false: `07i2-numbers-in-facts` calls `gate.numbersSourced`
    // on the FINISHED draft, but the copy prompt does not instruct the model to satisfy that gate by name,
    // and setting the flag would demand a sentence the prompt does not carry.
    //
    // Design system (RFC-17 §5.7), @18: `requires` is UNCHANGED a third time, and that is a claim, not an
    // oversight. @18 is @17 plus ONE additive section, §28 "Marking", which names which words in copy the
    // model has ALREADY WRITTEN carry the slide. It names no `gate.*` — the mark system is enforced by
    // `resolveSlideMarks`, by the DOM clause `marks-missing` and by a dropped span, none of which is a gate
    // tool a prompt could be told to satisfy — so the `numbersSourced` flag would fail its own
    // `gate.numberssourced` marker and would be the "unenforced instruction dressed as an enforced one"
    // this registry's doc comment warns about. It touches neither §1 nor §15 nor the literal
    // `clientVoiceContext`, so `languageDirective` stays satisfied and satisfiable exactly as at @17. And
    // it adds no REQUIRED output field: `emphasis` is OPTIONAL on every slide (a slide with nothing worth
    // marking correctly carries none), so a `structuredOutput` flag would assert a field the schema does
    // not require. Claiming any new flag here would be dishonest about what §28 is.
    //
    // Phase 5.5 (spec §3 B3), @21: the custom-archetype MARKUP authoring is removed from the copy step and
    // hoisted into `05f-author-custom-archetype` (`instagram-custom-archetype@1`); the writer now emits a
    // `customArchetypeBrief` instead, at most ONE per carousel. §7 gains the `unfillable` field (spec §6 G3 —
    // an object the cards cannot fill is named there, never narrated to the reader in `headline`/`body`), and
    // §7's kicker bullet no longer advertises a kicker as the cheapest way to clear the interest floor. Every
    // string in the copy contract is now bounded, and those maxes are stated in the prompt.
    //
    // `requires` is UNCHANGED a fourth time, and for the reason @17-@20 already record: @21 edits neither §1
    // nor §15, both of which still carry the literal `clientVoiceContext`, so `languageDirective` stays
    // satisfied by two independent sections. It names no NEW `gate.*` — `gate.nativeLanguage` is still
    // inherited verbatim from @16 and is already on `KNOWN_GATES` — so **`KNOWN_GATES` is untouched**.
    //
    // Phase 5.5 (spec §2 A2/A3), @22: the scene brief gains a SUBJECT. §22 documents `visualNeed.subject`
    // (`noun`, optional `entityRef`, optional `mustShow`), §6 documents the `namedEntities` input — the
    // entities `04b3-extract-entities` found and `groundEntities` corroborated verbatim against this run's
    // own fact cards — and §16 documents `sceneSteer`, which is the one steer in this prompt that never
    // causes a redraft. It answers two measured defects: the owner's "the pictures are generic" verdict on
    // the 2026-09-16 posts, and one slide whose six candidates were all refused because its brief named a
    // mood ("signalling precision and permanence") that a road tunnel satisfied.
    //
    // `requires` is UNCHANGED a fifth time, for the reason @17-@21 already record: @22 edits neither §1 nor
    // §15, both of which still carry the literal `clientVoiceContext`, so `languageDirective` stays
    // satisfied by two independent sections. It names no NEW `gate.*`, so **`KNOWN_GATES` is untouched**.
    requires: { languageDirective: true },
  },
  // Phase 5.5 (spec §3 B3). The markup half of a custom archetype, hoisted out of the copy schema: the writer
  // chooses the design and justifies it in a `customArchetypeBrief`, and THIS prompt authors the `bodyHtml`,
  // `css` and `fields` that realise it, at most once per carousel, behind the same `assertSafeMarkup` contract
  // the copy step used to run. The split exists because the markup was ~6k of a 16,384-token ceiling that the
  // drafting loop kept hitting; see `agents/instagram-agent/__tests__/copy-schema-length.test.ts`.
  //
  // No `requires` flags, for the reason `instagram-concept` and `instagram-post-package` already record: it
  // receives the resolved `targetLanguage` and never `clientVoiceContext`, so the `languageDirective` marker —
  // which looks for that literal — would be unsatisfiable. It names no `gate.*` (what guards its output is
  // `assertSafeMarkup` plus `validateCustomArchetypeSlots`, in code), and it emits no statistic.
  { promptId: "instagram-custom-archetype", agent: "instagram-agent", versions: ["1"], latestVersion: "1" },
  // Phase 5 (RFC-18 §6.1). The post packager: hashtags, per-slide alt text and the first comment's prose,
  // written ONCE per revision after the drafting loop breaks, on a pinned `gemini-2.5-flash`.
  //
  // No `requires` flags, for the reason `instagram-native-editor` and `instagram-angle` already record: the
  // packager receives the resolved `targetLanguage`, never `clientVoiceContext`, so the `languageDirective`
  // marker — which looks for that literal — would be unsatisfiable by a prompt that is nonetheless entirely
  // correct about language (its §1 says "write all three in the post's target language"). It names no
  // `gate.*` at all: `08c1-package-checks` runs `gate.nativeLanguage` and `gate.lintPost` over what comes
  // back, in code, and the prompt quotes the banned-phrase bank as wordings rather than naming the tool.
  //
  // `structuredOutput` is not set either. The prompt names all three output fields (`hashtags`, `altText`,
  // `firstCommentText`) in its own section headings, so the flag would pass today — but it would pass
  // vacuously, since a prompt organised one section per field cannot fail a "mentions its fields" check.
  //
  // Phase 5.5 (spec §6 G2), @2: `ALT_TEXT_MAX_CHARS = 125` was enforced on the wire and stated nowhere the
  // model could read it, so two of three live runs lost their hashtags AND their alt text to one over-long
  // `alt`. @2 states that the count is CHARACTERS not words, that a Hebrew character counts the same as a
  // Latin one, carries a worked 118-character example, and states the new semantics: an over-long `alt` is
  // cut at a word boundary in code rather than refusing the whole package. Hashtags are deliberately still
  // refused rather than clamped — a truncated tag is a different tag, pointing at a different search.
  { promptId: "instagram-post-package", agent: "instagram-agent", versions: ["1", "2"], latestVersion: "2" },
  // Phase 4 (RFC-15 §6). The native judge: six axes, worked examples, and a correction contract that makes
  // "report without correcting" structurally unrepresentable. No `requires` flags, for the reason
  // `instagram-angle` already records — the judge receives `languageBrief`, never `clientVoiceContext`, so
  // the `languageDirective` marker would be unsatisfiable. It names no `gate.*` either: it READS
  // `gate.nativeLanguage`'s findings as input, it does not instruct a model to satisfy that gate.
  //
  // @2 (Phase 5, RFC-18 §6.5) teaches it the POST-PACKAGE round's vocabulary. `NativeCorrectionSchema` and
  // `resolveField` were widened for `comment`/`alt:N` and `NATIVE_EDITOR_RUBRIC_VERSION` was stamped "2",
  // but @1 was never told any of it existed — so on `08c2` the judge had only `"caption"`/`"slide:N"` to
  // write, and every correction it produced was correctly dropped as cross-context. Prompt-only: no new
  // step, no code change, no re-price beyond the file's own growth.
  { promptId: "instagram-native-editor", agent: "instagram-agent", versions: ["1", "2"], latestVersion: "2" },
  // Phase 2, item N. The Template Studio's three setup-time prompts. None of
  // them carries `requires` flags, for the same reason `instagram-brief` and
  // `instagram-angle` do not: they receive the resolved `targetLanguage`
  // rather than `clientVoiceContext` (so the `languageDirective` marker,
  // which looks for that literal, would be unsatisfiable), and while the
  // design brief is under a hard "never invent a metric" rule, what enforces
  // it is `assertNoInventedMetrics` over the evidence block, NOT
  // `gate.numbersSourced` — and the `numbersSourced` flag requires the prompt
  // to name that gate. Naming a gate that never runs on this output is
  // exactly the "unenforced instruction dressed as an enforced one" this
  // registry's own doc comment warns about.
  { promptId: "instagram-design-brief", agent: "instagram-agent", versions: ["1"], latestVersion: "1" },
  // Phase 4 (RFC-16 §6.1): @5 adds §1c, reachable only on a slide the pipeline
  // declared `conceptual`. @4 stays frozen and is what every other slide reads.
  // Phase 5.5 (item A3): @6 separates the SUBJECT from the scene and declares
  // `scene` decorative — on 2026-09-16 @5 refused five correct photographs of
  // server infrastructure for not having been shot with a long exposure, and
  // the post shipped with no pictures in it.
  { promptId: "instagram-image-vet", agent: "instagram-agent", versions: ["1", "2", "3", "4", "5", "6"], latestVersion: "6" },
  // Phase 5.5 (item A2): `04b3-extract-entities`. No `requires` flags — the
  // step writes nothing a reader sees and carries no statistics; its output is
  // re-checked against the evidence by `groundEntities` in code, which is a
  // stronger guarantee than a prompt sentence and is why none is declared.
  { promptId: "instagram-entities", agent: "instagram-agent", versions: ["1"], latestVersion: "1" },
  { promptId: "instagram-research", agent: "instagram-agent", versions: ["1", "2"], latestVersion: "2" },
  { promptId: "instagram-template-designer", agent: "instagram-agent", versions: ["1"], latestVersion: "1" },
  { promptId: "instagram-template-set-review", agent: "instagram-agent", versions: ["1"], latestVersion: "1" },
  // Phase 5.5 (@5): the rubric is re-centred on five POST-LEVEL questions, the
  // judge is fed a CONTACT SHEET of every plate at once — which is how the
  // owner judged the three posts he rejected on 2026-09-16 — and the output
  // gains `publishable`, the CMO verdict `pass` could never carry.
  { promptId: "instagram-visual-qa", agent: "instagram-agent", versions: ["1", "2", "3", "4", "5"], latestVersion: "5" },
  {
    promptId: "intel-report-grounding",
    agent: "intel-report-agent",
    versions: ["1"],
    latestVersion: "1",
    // The pre-gate correction pass names the gate it exists to satisfy, so the
    // hygiene check holds it to the same "never invent numbers" declaration the
    // drafting prompt carries.
    requires: { numbersSourced: true },
  },
  {
    promptId: "intel-report-craft",
    agent: "intel-report-agent",
    versions: ["1", "2", "3", "4", "5", "6", "7", "8"],
    latestVersion: "8",
    requires: { numbersSourced: true },
  },
  // Landing Builder v2 (RFC-11). The blueprint decides every fact on the page
  // and the build/fix steps copy it verbatim, so all three carry the
  // never-invent declaration; `landing.checkPage` is the validator that
  // actually rejects an unsourced figure (it applies gate.numbersSourced's rule
  // to the assembled HTML).
  { promptId: "landing-blueprint", agent: "landing-builder-agent", versions: ["1"], latestVersion: "1", requires: { numbersSourced: true } },
  { promptId: "landing-build", agent: "landing-builder-agent", versions: ["1"], latestVersion: "1", requires: { numbersSourced: true } },
  { promptId: "landing-fix", agent: "landing-builder-agent", versions: ["1"], latestVersion: "1", requires: { numbersSourced: true } },
  { promptId: "landing-craft-verdict", agent: "landing-builder-agent", versions: ["1", "2"], latestVersion: "2" },
  {
    promptId: "linkedin-craft",
    agent: "linkedin-agent",
    // 8: §12a — no relative day words, for the same reason as x-craft@8 and
    // from the same run: the 17.9.2026 draft opened with a Series D that
    // closed "yesterday" two days before it was written.
    // 7: the eleven rules from the 06 Agent Improve sheet (Lola, 2026-09-07)
    // as §12b, and §8's image rules — no web-page screenshots, and the four
    // gates any picture clears. Both came from reading posts this agent
    // actually shipped rather than from a style opinion.
    versions: ["1", "2", "3", "4", "5", "6", "7", "8"],
    latestVersion: "8",
    requires: { languageDirective: true, numbersSourced: true },
  },
  {
    promptId: "newsletter-craft",
    agent: "newsletter-agent",
    versions: ["1", "2", "3", "4", "5", "6"],
    latestVersion: "6",
    requires: { languageDirective: true, numbersSourced: true, structuredOutput: true },
    structuredOutputFields: ["subject", "previewText", "intro", "callToAction", "signoff", "text"],
  },
  {
    promptId: "newsletter-editor",
    agent: "newsletter-agent",
    versions: ["1"],
    latestVersion: "1",
    // A judgment step that reads a finished edition and returns a verdict with
    // notes: it writes no client-facing prose and adds no facts, so neither the
    // language directive nor the numbers pair applies. Its output fields are
    // what the workflow acts on, so those are checked.
    requires: { structuredOutput: true },
    structuredOutputFields: ["verdict", "scores", "notes"],
  },
  {
    promptId: "newsletter-plan",
    agent: "newsletter-agent",
    versions: ["1"],
    latestVersion: "1",
    // The edition plan: an internal brief for the writer, in English by
    // design (it notes the edition's language for the writer instead), and
    // it names no figures of its own (`specifics` are copied verbatim from
    // the research), so the language directive and numbers pair do not apply.
    requires: { structuredOutput: true },
    structuredOutputFields: ["thesis", "lead", "quickHits", "oneThingToDo", "subjectLineDirection", "passedOn"],
  },
  {
    promptId: "reddit-channel-plan",
    agent: "reddit-agent",
    versions: ["1"],
    latestVersion: "1",
    // A planning step, not client-facing prose: it decides communities and
    // keywords, so neither the language directive nor the numbers pair applies.
    requires: { structuredOutput: true },
    structuredOutputFields: ["targetSubreddits", "searchKeywords", "offLimitsTopics", "voiceNotes", "disclosureLine"],
  },
  {
    promptId: "reddit-craft",
    agent: "reddit-agent",
    versions: ["1", "2", "3", "4", "5", "6"],
    latestVersion: "6",
    requires: { languageDirective: true, numbersSourced: true, structuredOutput: true },
    structuredOutputFields: ["replyBody", "text", "targetThreadUrl", "targetThreadTitle", "targetSubreddit", "disclosureIncluded", "sourcesUsed"],
  },
  {
    promptId: "reddit-scout",
    agent: "reddit-agent",
    versions: ["1"],
    latestVersion: "1",
    // Chooses a thread; produces no client-facing prose and no figures.
    requires: { structuredOutput: true },
    structuredOutputFields: ["selected", "passReason", "runnersUp", "angle", "whatToAdd", "requiresDisclosure"],
  },
  { promptId: "reputation-doctrine-gate", agent: "reputation-agent", versions: ["1"], latestVersion: "1" },
  { promptId: "reputation-draft", agent: "reputation-agent", versions: ["1"], latestVersion: "1" },
  { promptId: "reputation-extraction", agent: "reputation-agent", versions: ["1"], latestVersion: "1" },
  { promptId: "reputation-tag", agent: "reputation-agent", versions: ["1"], latestVersion: "1" },
  { promptId: "reputation-voice", agent: "reputation-agent", versions: ["1"], latestVersion: "1" },
  { promptId: "seo-geo-fix-draft", agent: "seo-geo-agent", versions: ["1", "2"], latestVersion: "2" },
  // v3: the summary now states the measured-basis score and coverage side by
  // side and may quote the run's own measured facts — never a number outside them.
  { promptId: "seo-geo-narrative", agent: "seo-geo-agent", versions: ["1", "2", "3"], latestVersion: "3", requires: { numbersSourced: true } },
  // RFC-04 §2 Phase 1 as the source skill described it: a bounded drafting
  // pass writing the prompt set in the buyer's language and market, replacing
  // the industry-string templates that asked every client's buyers the same
  // English questions. Falls back to those templates on any failure.
  { promptId: "seo-geo-prompt-set", agent: "seo-geo-agent", versions: ["1"], latestVersion: "1" },
  {
    promptId: "tiktok-commentary",
    agent: "tiktok-agent",
    versions: ["1", "2", "3", "4", "5"],
    latestVersion: "5",
    requires: { languageDirective: true, structuredOutput: true },
    structuredOutputFields: ["caption", "about", "sourceCredit"],
  },
  { promptId: "tiktok-moment", agent: "tiktok-agent", versions: ["1", "2"], latestVersion: "2" },
  {
    promptId: "tiktok-script",
    agent: "tiktok-agent",
    versions: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
    latestVersion: "11",
    requires: { languageDirective: true, structuredOutput: true },
    structuredOutputFields: ["hook", "beats", "narration", "onScreenText", "visualBrief", "stockQuery", "seconds", "caption", "about", "format", "formatRationale", "voiceover", "voiceoverRationale", "language"],
  },
  {
    promptId: "tiktok-topic-scout",
    agent: "tiktok-agent",
    versions: ["1", "2"],
    latestVersion: "2",
    requires: { structuredOutput: true },
    structuredOutputFields: ["candidates", "topic", "angle", "hook", "format", "whyNow", "evidenceUrls", "voiceoverRecommended", "rationale"],
  },
  {
    promptId: "x-craft",
    agent: "x-agent",
    // 8: §12b — no relative day words. A draft is reviewed and published
    // later, so "yesterday" is wrong by the time anyone reads it, and every
    // check that existed asked whether a claim was SOURCED rather than
    // whether it still read true after a weekend in the queue.
    // 7: D24 — X is text only. §10 stopped asking the model for screenshots
    // and photographs, because the workflow stopped acting on the request;
    // and §5/§11 state the three limits the gate now actually enforces (hook
    // 70 with no @/#/link/emoji, one hashtag, two mentions) rather than
    // describing them as taste.
    versions: ["1", "2", "3", "4", "5", "6", "7", "8"],
    latestVersion: "8",
    requires: { languageDirective: true, numbersSourced: true },
  },
];

/** One promptId as it actually exists on disk. */
export interface DiskPrompt {
  readonly promptId: string;
  readonly agent: string;
  /** version -> file content, ascending by numeric version. */
  readonly versions: ReadonlyMap<string, string>;
  /** `latest.md`'s content, or `undefined` when the file is missing entirely. */
  readonly latestContent: string | undefined;
}

/**
 * Reads `agents/<agent>/prompts/<promptId>/` from disk. Unlike the walk this
 * replaced, NOTHING downstream trusts this on its own — it exists to be
 * compared against `PROMPT_REGISTRY`.
 *
 * `root` is injectable so the checker's own tests can point it at a fixture
 * tree; production callers pass nothing and get `REPO_ROOT`.
 */
export async function discoverPromptsOnDisk(root: string = REPO_ROOT): Promise<DiskPrompt[]> {
  const agentsDir = path.join(root, "agents");
  const prompts: DiskPrompt[] = [];

  let agentEntries: import("fs").Dirent[];
  try {
    agentEntries = (await fs.readdir(agentsDir, { withFileTypes: true })).filter((e) => e.isDirectory());
  } catch {
    return prompts;
  }

  for (const agent of agentEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    const promptsDir = path.join(agentsDir, agent.name, "prompts");
    let promptIds: string[];
    try {
      promptIds = (await fs.readdir(promptsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue; // an agent folder without a prompts/ dir is fine
    }

    for (const promptId of promptIds.sort()) {
      const dir = path.join(promptsDir, promptId);
      const files = await fs.readdir(dir);
      const numbered: Array<[string, string]> = [];
      for (const file of files) {
        const m = /^(\d+)\.md$/.exec(file);
        if (m) numbered.push([m[1]!, await fs.readFile(path.join(dir, file), "utf8")]);
      }
      numbered.sort((a, b) => Number(a[0]) - Number(b[0]));
      let latestContent: string | undefined;
      try {
        latestContent = await fs.readFile(path.join(dir, "latest.md"), "utf8");
      } catch {
        latestContent = undefined;
      }
      prompts.push({ promptId, agent: agent.name, versions: new Map(numbered), latestContent });
    }
  }
  return prompts;
}

/** A single disagreement between the registry and the disk, or a violated invariant. */
export interface PromptProblem {
  readonly kind:
    | "latest-drift"
    | "latest-missing"
    | "registry-missing-prompt"
    | "registry-orphan-prompt"
    | "registry-wrong-agent"
    | "registry-version-mismatch"
    | "registry-latest-mismatch"
    | "duplicate-prompt-id"
    | "hygiene-missing-marker"
    | "unknown-gate"
    | "unresolvable-pin";
  readonly promptId: string;
  readonly detail: string;
}

/**
 * The drift check itself: registry vs disk, plus the `latest.md` invariant.
 *
 * The `latest.md` invariant is "byte-identical to the registry's declared
 * `latestVersion`", not the weaker "matches SOME numbered version". The weaker
 * form would have passed a `latest.md` frozen at `1.md` while `2.md` and
 * `3.md` shipped past it — which is a drift you very much want to hear about.
 */
export function diffRegistryAgainstDisk(registry: readonly PromptRegistryEntry[], disk: readonly DiskPrompt[]): PromptProblem[] {
  const problems: PromptProblem[] = [];

  const seenIds = new Set<string>();
  for (const entry of registry) {
    if (seenIds.has(entry.promptId)) {
      problems.push({ kind: "duplicate-prompt-id", promptId: entry.promptId, detail: `declared more than once in PROMPT_REGISTRY` });
    }
    seenIds.add(entry.promptId);
  }

  const diskById = new Map<string, DiskPrompt[]>();
  for (const d of disk) {
    const bucket = diskById.get(d.promptId);
    if (bucket) bucket.push(d);
    else diskById.set(d.promptId, [d]);
  }
  for (const [promptId, owners] of diskById) {
    if (owners.length > 1) {
      problems.push({
        kind: "duplicate-prompt-id",
        promptId,
        detail: `shipped by ${owners.map((o) => `"${o.agent}"`).join(" and ")} — one shared PromptStore can't serve both`,
      });
    }
  }

  for (const d of disk) {
    if (!seenIds.has(d.promptId)) {
      problems.push({
        kind: "registry-missing-prompt",
        promptId: d.promptId,
        detail: `exists at agents/${d.agent}/prompts/${d.promptId}/ but is not declared in PROMPT_REGISTRY`,
      });
    }
  }

  for (const entry of registry) {
    const d = diskById.get(entry.promptId)?.[0];
    if (!d) {
      problems.push({
        kind: "registry-orphan-prompt",
        promptId: entry.promptId,
        detail: `declared in PROMPT_REGISTRY (owner "${entry.agent}") but no such directory exists under agents/*/prompts/`,
      });
      continue;
    }

    if (d.agent !== entry.agent) {
      problems.push({
        kind: "registry-wrong-agent",
        promptId: entry.promptId,
        detail: `registry says owner "${entry.agent}", disk says "${d.agent}"`,
      });
    }

    const onDisk = [...d.versions.keys()];
    const declared = [...entry.versions];
    const missingOnDisk = declared.filter((v) => !d.versions.has(v));
    const undeclared = onDisk.filter((v) => !declared.includes(v));
    if (missingOnDisk.length > 0 || undeclared.length > 0) {
      problems.push({
        kind: "registry-version-mismatch",
        promptId: entry.promptId,
        detail:
          `registry declares [${declared.join(", ")}], disk has [${onDisk.join(", ")}]` +
          (missingOnDisk.length > 0 ? ` — declared but absent: ${missingOnDisk.join(", ")}` : "") +
          (undeclared.length > 0 ? ` — present but undeclared: ${undeclared.join(", ")}` : ""),
      });
    }

    if (!entry.versions.includes(entry.latestVersion)) {
      problems.push({
        kind: "registry-latest-mismatch",
        promptId: entry.promptId,
        detail: `registry latestVersion "${entry.latestVersion}" is not one of its declared versions [${declared.join(", ")}]`,
      });
      continue;
    }

    if (d.latestContent === undefined) {
      problems.push({ kind: "latest-missing", promptId: entry.promptId, detail: `agents/${d.agent}/prompts/${entry.promptId}/latest.md does not exist` });
      continue;
    }

    const declaredLatest = d.versions.get(entry.latestVersion);
    if (declaredLatest !== undefined && declaredLatest !== d.latestContent) {
      const matches = [...d.versions.entries()].filter(([, content]) => content === d.latestContent).map(([v]) => v);
      problems.push({
        kind: "latest-drift",
        promptId: entry.promptId,
        detail:
          `latest.md is not byte-identical to its declared latestVersion ${entry.latestVersion}.md — ` +
          (matches.length > 0
            ? `it matches ${matches.map((v) => `${v}.md`).join(", ")} instead. Either bump latestVersion or re-sync latest.md.`
            : `it matches NO numbered version at all. Snapshot it as a new numbered version and point latestVersion at that ` +
              `— do not leave it for the publisher to invent one.`),
      });
    }
  }

  return problems;
}

/** Absolute path to one numbered prompt file, derived from a registry entry. */
export function promptVersionPath(entry: PromptRegistryEntry, version: string, root: string = REPO_ROOT): string {
  return path.join(root, "agents", entry.agent, "prompts", entry.promptId, `${version}.md`);
}
