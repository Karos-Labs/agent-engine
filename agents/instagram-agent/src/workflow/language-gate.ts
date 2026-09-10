import {
  DynamicAgent,
  buildOutputSchema,
  type AgentDefinitionField,
  type AgentToolRegistry,
  type ModelRouter,
  type PromptStore,
} from "@agent-engine/core";
import type { WorkflowContext } from "@agent-engine/workflow";
import type { InstagramCopyOutput, SlidesDataSelfCheck } from "./types.js";

/**
 * SCRUM-310 (AU32): the language-compliance gate, in two stages, both run
 * inside step 07's existing self-check retry loop and both BEFORE step 08's
 * render.
 *
 * ## The gap this closes
 *
 * `instagram-image-vet@2` and `instagram-visual-qa@1` are the only quality
 * judges this workflow had before render, and neither of them reads the copy
 * as LANGUAGE: the first judges candidate photographs, the second judges a
 * rendered attempt's structured slide data against `check: "render"` layout
 * rules. Nothing anywhere asked whether the words that are about to be baked
 * into a 1080x1440 PNG are fluent, grammatical text in the language this
 * client publishes in. That is exactly how the geektime carousel (prep job
 * hcf9ymPGJC7mDS5pcEQ4) shipped in fluent English for a Hebrew-only outlet
 * and passed every check that existed.
 *
 * SCRUM-309 (AU31) gave the drafting prompt a structured language
 * REQUIREMENT (`client.getBrand`'s `language`, threaded through
 * `buildClientVoiceContext`). This is the other half: a requirement nothing
 * verifies is a request. Text baked into an image is also the one output a
 * human reviewer at gate 09a cannot fix in place — they can edit a caption,
 * they cannot re-typeset a PNG — so the check has to run before the render,
 * not after it.
 *
 * ## Why two stages and not one
 *
 * Stage 1 (`checkExpectedScript`) is pure code and costs nothing: is this
 * text in the expected writing system AT ALL? It catches the whole-post
 * failure mode that actually happened — an entirely English carousel for a
 * Hebrew client — with no model call, no latency and no way to be talked out
 * of its answer. Running it first also means the common catastrophic case
 * never pays for stage 2.
 *
 * Stage 2 (`runLanguageFluency`) is the judgment stage 1 cannot make:
 * Hebrew characters in Hebrew-shaped nonsense are still Hebrew characters. A
 * model transliterating, emitting machine-translated word salad, writing
 * grammatically broken Hebrew, or — the commonest of the four, and the only
 * one that also survives a proofreader — writing GRAMMATICAL Hebrew that is
 * an English draft rendered clause by clause, all score 100% on the script
 * check. Only a reader of the language can call that, so stage 2 is one cheap `commodity`-tier
 * model call, built the same way `runTopicGuardrail`
 * (`packages/workflow/src/primitives/topic-guardrail.ts`) builds its
 * verifier: a `DynamicAgent` with no tools, `maxSteps: 1`, a flat output
 * schema, and an inline system prompt.
 *
 * ## When it runs at all
 *
 * Whenever step 02d resolved a target language for the client. Since the
 * 2026-09 Instagram upgrade (brief item B) that resolution is no longer
 * `client.getBrand().language` alone: `resolveTargetLanguage`
 * (`./target-language.ts`) also reads the profile, the voice rules and the
 * brand-voice document, because the audit found the gate had run in NONE of
 * ten sampled prep runs — geektime's Hebrew lives in its profile prose, and
 * karoslabs has no `brand.language` at all. The only client for whom both
 * stages are skipped is one with no evidence of any non-English language
 * anywhere (`status: "english-default"`), and that skip still costs no model
 * call and adds no step to the trace, like `runTopicGuardrail` with an
 * empty forbidden-topics list.
 *
 * ## Failure handling
 *
 * Stage 2 FAILS CLOSED. This used to follow `runTopicGuardrail`'s "a
 * verifier that could not do its job never blocks good output", and that is
 * the wrong posture for this gate specifically: the guardrail protects
 * against a rare, explicit forbidden-topics list, whereas this gate is the
 * ONLY reader of the language for a client whose entire output is in it.
 * Letting an outage wave through unverified Hebrew is exactly the geektime
 * failure with a better excuse. So an incomplete stage-2 execution still
 * returns `status: "error"` (same shape as before — the checkpointed step
 * records that the check did not run), but the caller now treats anything
 * other than `"fluent"` as a failed attempt: `RETURN: 05`, with a reason
 * that names the outage rather than a copy problem, so an operator reading
 * the eventual hold does not chase a redraft.
 *
 * The cost of that posture is a Sonnet redraft (~$0.12) per transient judge
 * failure, which is why `runLanguageFluency` retries the judge ONCE, inside
 * the same 07f invocation, before reporting `error`. A single 429 or a
 * one-off malformed reply therefore costs one Haiku call, not a redraft; a
 * real outage costs the attempt budget and holds with the outage named.
 *
 * The remedy for a real `not_fluent` verdict is unchanged: the guardrail is
 * terminal and throws, whereas this gate sits inside the step-07 retry
 * loop, where the established remedy for "the copy is wrong" is
 * `RETURN: 05` — redraft. The language requirement is already in the
 * drafting prompt, and the model is being told it did not follow it. Only
 * exhausting the retry budget holds the run, via the loop's existing
 * `WorkflowHeld`.
 */

// ─────────────────────────────────────────────────────────────────────────
// Stage 1 — the deterministic script/charset check. No model call.
// ─────────────────────────────────────────────────────────────────────────

/** One writing system, as a single-code-point test plus a name for the failure message. */
export interface ExpectedScript {
  /** Canonical display name, e.g. `"Hebrew"`. */
  readonly name: string;
  /** Matches exactly one character belonging to this script. */
  readonly test: RegExp;
}

/** One row of `SCRIPT_TABLE`: a writing system plus every language name and BCP-47 primary subtag this gate knows to be written in it. */
export interface ScriptTableEntry {
  readonly script: ExpectedScript;
  /** Lower-cased language names, as a portal user would type them ("hebrew", "ivrit", "עברית"). */
  readonly names: readonly string[];
  /** Lower-cased BCP-47 primary subtags ("he", "iw"). */
  readonly tags: readonly string[];
}

/**
 * Language name / BCP-47 primary subtag -> writing system.
 *
 * `client.getBrand().language` is free text on purpose (see that field's own
 * doc comment) — "Hebrew", "he", "he-IL" are all shapes the portal can
 * legitimately produce — so this maps both spellings for every entry it
 * knows.
 *
 * The table is a KNOWN-LANGUAGES table, never a complete one, and the
 * unknown case is handled by skipping stage 1 entirely (see
 * `resolveExpectedScript`). That asymmetry is deliberate: a missing entry
 * must degrade to "this gate has no opinion", never to "fail every draft for
 * this client", because a failure here costs a redraft attempt and, at the
 * retry cap, the whole run.
 *
 * Private on purpose; `scriptTableEntries()` is the read-only view other
 * modules get. `target-language.ts` infers a client's language from prose
 * using exactly these names and script tests, and it must not carry a second
 * copy of them — two tables drift, and a language the inference knows but
 * the gate does not (or vice versa) is a client whose gate silently never
 * runs.
 */
const SCRIPT_TABLE: ReadonlyArray<ScriptTableEntry> = [
  { script: { name: "Hebrew", test: /\p{Script=Hebrew}/u }, names: ["hebrew", "ivrit", "עברית"], tags: ["he", "iw"] },
  { script: { name: "Arabic", test: /\p{Script=Arabic}/u }, names: ["arabic", "farsi", "persian", "urdu"], tags: ["ar", "fa", "ur"] },
  { script: { name: "Greek", test: /\p{Script=Greek}/u }, names: ["greek"], tags: ["el"] },
  {
    script: { name: "Cyrillic", test: /\p{Script=Cyrillic}/u },
    names: ["russian", "ukrainian", "bulgarian", "serbian", "belarusian", "macedonian"],
    tags: ["ru", "uk", "bg", "sr", "be", "mk"],
  },
  { script: { name: "Devanagari", test: /\p{Script=Devanagari}/u }, names: ["hindi", "marathi", "nepali", "sanskrit"], tags: ["hi", "mr", "ne", "sa"] },
  { script: { name: "Thai", test: /\p{Script=Thai}/u }, names: ["thai"], tags: ["th"] },
  { script: { name: "Armenian", test: /\p{Script=Armenian}/u }, names: ["armenian"], tags: ["hy"] },
  { script: { name: "Georgian", test: /\p{Script=Georgian}/u }, names: ["georgian"], tags: ["ka"] },
  // Japanese is written in three scripts at once; Korean mixes Hangul with
  // Han. Treating either as a single script would fail perfectly ordinary
  // text, so each one's test is the union it actually uses.
  {
    script: { name: "Japanese", test: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u },
    names: ["japanese"],
    tags: ["ja"],
  },
  { script: { name: "Korean", test: /[\p{Script=Hangul}\p{Script=Han}]/u }, names: ["korean"], tags: ["ko"] },
  { script: { name: "Chinese", test: /\p{Script=Han}/u }, names: ["chinese", "mandarin", "cantonese"], tags: ["zh"] },
  {
    script: { name: "Latin", test: /\p{Script=Latin}/u },
    names: [
      "english", "spanish", "french", "german", "italian", "portuguese", "dutch", "danish",
      "swedish", "norwegian", "finnish", "polish", "czech", "romanian", "hungarian", "turkish",
      "indonesian", "malay", "vietnamese", "catalan", "croatian", "slovak", "slovenian", "estonian",
      "latvian", "lithuanian", "filipino", "tagalog", "swahili", "afrikaans",
    ],
    tags: [
      "en", "es", "fr", "de", "it", "pt", "nl", "da", "sv", "no", "nb", "fi", "pl", "cs", "ro",
      "hu", "tr", "id", "ms", "vi", "ca", "hr", "sk", "sl", "et", "lv", "lt", "fil", "tl", "sw", "af",
    ],
  },
];

/**
 * Read-only view over `SCRIPT_TABLE` for `target-language.ts`'s inference —
 * the one table, shared, never duplicated (see `SCRIPT_TABLE`'s doc comment
 * for why). The array and its rows are frozen at module load so a consumer
 * cannot reach in and change what the gate itself checks against.
 */
const SCRIPT_TABLE_VIEW: ReadonlyArray<ScriptTableEntry> = Object.freeze(
  SCRIPT_TABLE.map((row) => Object.freeze({ script: Object.freeze({ ...row.script }), names: Object.freeze([...row.names]), tags: Object.freeze([...row.tags]) })),
);
export function scriptTableEntries(): ReadonlyArray<ScriptTableEntry> {
  return SCRIPT_TABLE_VIEW;
}

/**
 * The writing system a declared language is written in, or `undefined` when
 * this table has never heard of it.
 *
 * `undefined` means "no opinion", and every caller treats it as a pass — see
 * `SCRIPT_TABLE`'s note on why a missing entry must not fail a run.
 */
export function resolveExpectedScript(language: string): ExpectedScript | undefined {
  const normalized = language.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  // "he-IL" / "he_IL" / "pt-BR" all decide on their primary subtag; the
  // region says nothing about the writing system.
  const primary = normalized.split(/[-_]/)[0] ?? normalized;
  for (const row of SCRIPT_TABLE) {
    if (row.names.includes(normalized) || row.tags.includes(primary)) return row.script;
  }
  return undefined;
}

/**
 * How much of the text's alphabetic content must be in the expected script.
 *
 * Not near-1.0 on purpose. Real Hebrew tech copy is full of Latin-script
 * product names, and real copy in any language carries brand names, model
 * numbers and URLs; a strict threshold would reject correct drafts, and a
 * rejection here costs a redraft attempt and eventually the run. The failure
 * this stage exists to catch is the one that actually happened — an entirely
 * English post for a Hebrew outlet, which scores 0.00 — so a floor that a
 * wholly-wrong-script draft cannot clear and a heavily-loanworded correct
 * draft comfortably clears is the right shape. Everything subtler than that
 * is stage 2's job.
 */
export const MIN_EXPECTED_SCRIPT_RATIO = 0.3;

/**
 * Below this many letters there is not enough signal to judge — a six-word
 * headline of proper nouns is not evidence of anything. Short text passes;
 * it is checked as part of the whole post anyway.
 */
export const MIN_LETTERS_TO_JUDGE = 24;

/**
 * Stage 1: is this text in the expected writing system at all?
 *
 * Pure, synchronous, no model call, no tools, no I/O. Counts Unicode letters
 * (`\p{L}` — never `[A-Za-z]`, which cannot see any of the scripts this is
 * for) and reports the share of them belonging to the expected script.
 *
 * Passes without an opinion when the language is unknown to
 * `SCRIPT_TABLE` or the text is too short to judge.
 */
export function checkExpectedScript(text: string, language: string): SlidesDataSelfCheck {
  const expected = resolveExpectedScript(language);
  if (!expected) return { ok: true };

  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < MIN_LETTERS_TO_JUDGE) return { ok: true };

  const inScript = letters.filter((ch) => expected.test.test(ch)).length;
  const ratio = inScript / letters.length;
  if (ratio >= MIN_EXPECTED_SCRIPT_RATIO) return { ok: true };

  return {
    ok: false,
    reason:
      `text is not written in the ${expected.name} script this client requires (language: "${language.trim()}") — ` +
      `only ${inScript}/${letters.length} letters (${(ratio * 100).toFixed(0)}%) are ${expected.name}, ` +
      `below the ${(MIN_EXPECTED_SCRIPT_RATIO * 100).toFixed(0)}% floor`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// The text both stages judge
// ─────────────────────────────────────────────────────────────────────────

/**
 * Everything a human will actually READ: the caption plus every slide's
 * on-image prose, including a custom archetype's own slot values (the same
 * "every archetype, not just the six whose text lives in headline/body"
 * reasoning `checkCraftHygiene` uses).
 *
 * `sourceRef` and `visualNeed` are deliberately excluded. Neither is ever
 * rendered or published: `sourceRef` must match a step-04 research fact's
 * claim VERBATIM (see `checkSlidesData`) and research runs in whatever
 * language the sources are in, and `visualNeed` is a stock-photo search
 * query. Gating on either would fail every correct Hebrew draft whose
 * sources happen to be English.
 */
export function languageGateText(copy: InstagramCopyOutput): string {
  const slideText = copy.slides.map((slide) =>
    [slide.headline, slide.body, slide.kicker ?? "", ...(slide.customArchetype ? Object.values(slide.customArchetype.fields) : [])]
      .filter((s) => s.length > 0)
      .join(" "),
  );
  return [copy.caption, ...slideText].join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────
// Stage 2 — the LLM fluency judge (one commodity-tier call)
// ─────────────────────────────────────────────────────────────────────────

/** Bounded so a long post cannot push the instruction out of the judge's attention — same bound and reason as `GUARDRAIL_MAX_OUTPUT_CHARS`. */
export const LANGUAGE_JUDGE_MAX_CHARS = 24_000;

/** The step id this gate's judge checkpoints under, before the `-attempt-N` suffix the retry loop adds. */
export const LANGUAGE_FLUENCY_STEP_ID = "07f-language-fluency";

/** The step id stage 1 checkpoints under, before the `-attempt-N` suffix. */
export const LANGUAGE_SCRIPT_STEP_ID = "07e-language-script";

/**
 * Appended to the caller's step id for the one in-step retry of the fluency
 * judge (`07f-language-fluency-attempt-2-retry`). Its own checkpoint rather
 * than a re-call under the same id: `step.agent` replays any checkpointed
 * status — `content_fail` and `tooling_error` included — so a second call
 * with the first call's id would return the first call's failure without
 * ever touching the model. A distinct id is also what makes the retry
 * visible in the trace and idempotent across a resume.
 */
export const LANGUAGE_FLUENCY_RETRY_SUFFIX = "-retry";

export interface LanguageGateDeps {
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
}

export interface LanguageFluencyVerdict {
  /**
   * `error` means the judge could not run, twice (the call and its one
   * in-step retry). It is not a verdict on the draft, but the caller fails
   * closed on it all the same — see the module doc comment's "Failure
   * handling": unverified copy in a language nothing else reads does not
   * ship on the strength of an outage.
   */
  status: "fluent" | "not_fluent" | "error";
  /** The judge's own findings, each a short phrase. Empty when fluent. */
  issues: string[];
  /** A short quote from the draft supporting the first issue. */
  evidence?: string;
  /** Why the check could not run, when `status` is `"error"`. */
  error?: string;
}

/**
 * The judge's output contract, in the same flat field DSL every dynamic
 * stage uses — so `BaseAgent` enforces it and an unparseable reply is a
 * `content_fail` this module reports as `error` rather than something it has
 * to hand-parse out of prose. Same mechanism as `GUARDRAIL_OUTPUT_FIELDS`.
 */
export const LANGUAGE_FLUENCY_OUTPUT_FIELDS: readonly AgentDefinitionField[] = [
  {
    name: "fluent",
    type: "boolean",
    description:
      "True when the text reads as fluent, grammatical, natural writing in the required language, written by someone who speaks it. False when it does not.",
    optional: false,
  },
  {
    name: "issues",
    type: "string[]",
    description:
      "Each concrete language problem found, one short phrase each (wrong language, broken grammar, nonsense phrasing, transliteration, translationese: a word-for-word translation of English rather than how a native writer would say it). Empty when fluent.",
    optional: false,
  },
  {
    name: "evidence",
    type: "string",
    description: "A short quote from the text supporting the first issue. Omit when there are none.",
    optional: true,
  },
];

/** What `LANGUAGE_FLUENCY_OUTPUT_FIELDS` produces once `BaseAgent` has validated it. */
interface LanguageFluencyOutput {
  fluent: boolean;
  issues: string[];
  evidence?: string;
}

/**
 * The judge's system prompt.
 *
 * Inline rather than resolved through `PromptStore`, matching
 * `buildGuardrailSystemPrompt` — and for the same reason as everything else
 * about this gate: it is a check on the drafting model's output, and a check
 * whose wording lives in the same editable store as the drafting prompts is
 * one that can be edited to agree with them.
 *
 * The "judge only the language" framing is load-bearing. This gate runs
 * alongside a banned-word gate, a craft-hygiene gate and a topic guardrail,
 * all of which have their own remedies; a fluency judge that also volunteers
 * opinions on tone or subject matter would fail drafts for reasons the
 * retry loop's redraft cannot address.
 */
export function buildLanguageFluencySystemPrompt(language: string): string {
  return [
    `You are a native ${language} speaker checking whether a piece of social-media copy is written in fluent, natural, grammatical ${language}.`,
    "",
    `Judge ONLY the language. Not the topic, not the tone, not the marketing quality, not whether you agree with it. The single question is: would a literate native ${language} speaker read this as competent ${language} writing?`,
    "",
    "Answer `fluent: false` when the text is:",
    `- not in ${language} at all, or only partly in it`,
    "- grammatically broken (wrong agreement, wrong verb forms, mangled word order)",
    "- word-salad or machine-translated nonsense, even when every individual word is a real word",
    `- transliterated into another script rather than written in ${language}'s own`,
    // Translationese is the failure mode this gate meets most often and the
    // only one every bullet above waves through: a draft written in English
    // and rendered clause by clause is grammatical, uses real words, is in
    // the right script, and reads to a native speaker as a translation. The
    // drafting prompt (@12 §16) already promises the writer this exact
    // finding as a redraft steer ("reads as word by word translation" means
    // those slides are rewritten as a native writer would say them), and
    // that steer can only ever be emitted if the judge is asked the question.
    `- a word-for-word translation of English rather than ${language} as a native writer would say it: calqued idiom, English clause order that is grammatical but not natural, marketing phrases rendered literally instead of in their ${language} equivalent`,
    "",
    `Proper nouns, brand names, product names and technical terms left in their original language are NORMAL and are NOT a failure. Neither is informal register, fragments, or headline style — social copy is written that way on purpose.`,
    "",
    `Report concrete issues only, quoting the text. Never invent a problem to seem thorough: if it reads as competent, natural ${language} writing, say so. "Competent" is the bar for grammar; "natural" is the bar for phrasing, and a draft can pass the first and fail the second.`,
  ].join("\n");
}

/**
 * Stage 2: one `commodity`-tier model call asking whether the copy is
 * fluent, grammatical text in the client's declared language.
 *
 * Deliberately shaped like `runTopicGuardrail`'s verifier: a `DynamicAgent`
 * with `allowedTools: []` (a judgment over text already in hand — a verifier
 * that can call tools is a verifier that can be steered), `maxSteps: 1`, a
 * `buildOutputSchema` output contract, and the same
 * `{ policy: "commodity", model: "claude-haiku-4-5-20251001" }` tier — this
 * codebase's own tier for classification work, which is what "is this
 * fluent Hebrew, yes or no" is, and which keeps the cost of having the gate
 * on at all close to nothing.
 *
 * Never throws. A judge call that does not complete is retried ONCE, under
 * `${stepId}${LANGUAGE_FLUENCY_RETRY_SUFFIX}`, before this returns
 * `status: "error"` — and the caller FAILS CLOSED on that error (it is a
 * failed attempt, not a pass; see the module doc comment). The retry is what
 * keeps a transient 429 or a one-off malformed reply from costing a Sonnet
 * redraft: the second Haiku call is ~$0.006, the redraft it prevents ~$0.12.
 * A judge that fails twice in a row is an outage, and an outage is exactly
 * what the caller's hold reason should name.
 */
export async function runLanguageFluency(
  wf: WorkflowContext,
  deps: LanguageGateDeps,
  text: string,
  language: string,
  stepId: string,
): Promise<LanguageFluencyVerdict> {
  const judge = new DynamicAgent(
    { tools: deps.tools, router: deps.router, promptStore: deps.promptStore },
    {
      id: "instagram-language-fluency",
      description: `Judge whether a drafted carousel's caption and on-image copy is fluent, grammatical ${language}.`,
      // No tools: this is a judgment over text already in hand, and a verifier
      // that can call tools is a verifier that can be steered.
      allowedTools: [],
      outputSchema: buildOutputSchema([...LANGUAGE_FLUENCY_OUTPUT_FIELDS]),
      modelPolicy: { policy: "commodity", model: "claude-haiku-4-5-20251001" },
      maxSteps: 1,
    },
    buildLanguageFluencySystemPrompt(language),
  );
  const input = { language, draft: text.slice(0, LANGUAGE_JUDGE_MAX_CHARS) };

  let exec = await wf.step.agent(stepId, judge, input);
  if (exec.status !== "completed" || !exec.finalOutput) {
    const firstStatus = exec.status;
    // One retry, its own checkpoint (see `LANGUAGE_FLUENCY_RETRY_SUFFIX`).
    // Any non-completed status is retried, not just `tooling_error`: with
    // `maxSteps: 1` a `content_fail` here is the model returning something
    // its own output schema rejects, which on a fresh sample is as transient
    // as a rate limit.
    exec = await wf.step.agent(`${stepId}${LANGUAGE_FLUENCY_RETRY_SUFFIX}`, judge, input);
    if (exec.status !== "completed" || !exec.finalOutput) {
      return {
        status: "error",
        issues: [],
        error: `language fluency judge did not complete (${firstStatus}), nor on its in-step retry (${exec.status})`,
      };
    }
  }

  const output = exec.finalOutput as unknown as LanguageFluencyOutput;
  if (output.fluent) return { status: "fluent", issues: [] };
  return {
    status: "not_fluent",
    issues: output.issues.filter((i) => typeof i === "string" && i.trim().length > 0),
    ...(output.evidence ? { evidence: output.evidence } : {}),
  };
}
