import {
  DynamicAgent,
  buildOutputSchema,
  resolveModelPolicy,
  type AgentDefinitionField,
  type AgentToolRegistry,
  type ModelRouter,
  type PromptStore,
} from "@agent-engine/core";
import type { WorkflowContext } from "@agent-engine/workflow";
import type { FactCardForPrompt } from "./fact-cards.js";
import type { InstagramCopyOutput } from "./types.js";
import { cardCarriesSpecific } from "./value-signals.js";

/**
 * Instagram Phase 5 (RFC-18 §5) — THE VALUE GATE: `07j-value-judge`.
 *
 * ## The charge this answers
 *
 * The 2026-09-08 audit said the mechanism works (38-64 steps, gates, an image
 * veto, QA, a visual review) but that *"no step asks: is this relevant to what
 * the client actually does, and will anyone save this?"*. Phase 0's grounding
 * gate answered the first half. This is the second: the gate that is missing
 * between *correct* and *good*.
 *
 * ## Why this judge can refuse, when a taste judge could not
 *
 * A "will anyone save this?" judge is a taste judgment, and a taste judgment
 * from a commodity model is a gate that cannot fail — Flash awards 4/5 to
 * competent generic copy, which is exactly the copy this gate exists to
 * refuse, and `relevance-gate.ts:50-54` already records that tendency in
 * writing.
 *
 * **So the judge never renders taste. It is asked to FIND EVIDENCE against a
 * stated test, and an axis with no findable evidence is not a pass.**
 * Extraction is what Flash is good at:
 *
 * - every `pass` must carry a verbatim span from the draft, and the span is
 *   re-checked IN CODE against the draft text (`normaliseValueVerdict` rule 1);
 * - every non-pass must carry a fix naming what to write instead, and a
 *   non-pass with no fix reverts to `pass` (rule 2) — Phase 4's rule, from
 *   `language-gate.ts:723-736`, which exists because a judge that flags an
 *   axis and proposes nothing has produced a hold generator;
 * - the bar is computed here (`decideValue`), never read from the model's own
 *   opinion of itself. There is deliberately no `keepable` field in the output
 *   contract at all. `decideNative` says why: *a rule stated to a model is a
 *   request*.
 *
 * Everything mechanical is refused for $0 before this judge is ever paid —
 * `value-signals.ts` at `07i`, `gate.numbersSourced` at `07i2`. The judge
 * adjudicates only what a regex cannot decide.
 *
 * ## COST, and the no-Opus arithmetic (RFC-18 §7.1, §8)
 *
 * **$0.003 per attempt**, pinned `gemini-2.5-flash` at $0.30/$2.50 per 1M:
 * in 5,100 tok (rubric 1,700 + brief 600 + post 1,700 + fact-card digest 800 +
 * scaffolding 300) = $0.00153; out ~500 tok (4 axes + 4 quotes + 3 arrays +
 * `keepLine`) = $0.00125. Across a 3-attempt run that is **$0.009, under 1% of
 * the $1.00 target**.
 *
 * The owner's plan said to move the WRITER to a stronger model and give it a
 * search tool. Both are declined, on the owner's own later amendment (**no
 * Opus in a run**) and on arithmetic that agrees with it: Opus on the copy
 * step alone is ~$0.24 an attempt, $0.72 across three against a $1.00 target
 * before the post has an image, and ~$2.90 across the five
 * `contentLanguageSensitive` steps against a $1.50 hard max. Gemini 2.5 Pro
 * here would be $0.014 an attempt ($0.042 a run) and would buy *taste* — which
 * the evidence-span design above removes the need for. The money goes into the
 * PROMPT and the RUBRIC and a $0.007 deterministic verification instead.
 *
 * `contentLanguageSensitive` is deliberately ABSENT on this judge, mirroring
 * `instagram-relevance-judge` (`relevance-gate.ts:244`): `applyClientLanguagePolicy`
 * would otherwise silently re-point it to a multilingual-strong row and add
 * ~$0.011 to every Hebrew attempt. This judge is never asked to detect a
 * Hebrew *nuance* — nativeness is `07f`'s job, and the rubric says so.
 *
 * ## Failure posture: fails OPEN, and NEVER holds
 *
 * A judge that did not complete, or that answered with an axis outside
 * `{pass, weak, fail}`, returns `status: "error"`; the caller records a ledger
 * warn and the draft SHIPS unjudged, with no redraft burned. That is the
 * relevance judge's posture and it is right for the same reason: the subject
 * of this verdict is visible to the human reviewer at `09a`. A Hebrew fluency
 * failure is invisible to a reviewer who does not read Hebrew, which is why
 * `07f` fails closed; "this post is boring" is not invisible to anybody.
 *
 * **`WorkflowHeld` is never thrown on any value path.** Budgets adapt, never
 * hold: bounded returns (`VALUE_MAX_RETURNS`), a no-improvement stop
 * (`axesImproved`), and on the final attempt the draft ships marked
 * `below-bar` with the axes and the fixes on the `09a` payload so the reviewer
 * sees exactly why. Nothing in this module throws.
 */

// ─────────────────────────────────────────────────────────────────────────
// The rubric's vocabulary
// ─────────────────────────────────────────────────────────────────────────

/** Step-id stem; the workflow appends `-attempt-N` and the revision suffix. */
export const VALUE_STEP_ID = "07j-value-judge";

/** The four questions. Four, not six — see `buildValueSystemPrompt`'s note on the two axes that were rejected. */
export const VALUE_AXES = ["newFact", "position", "payload", "action"] as const;
export type ValueAxis = (typeof VALUE_AXES)[number];

export const VALUE_AXIS_VERDICTS = ["pass", "weak", "fail"] as const;
export type ValueAxisVerdict = (typeof VALUE_AXIS_VERDICTS)[number];

export type ValueAxes = Record<ValueAxis, ValueAxisVerdict>;

/**
 * Stamped on every verdict so telemetry can tell rubric eras apart — a shift
 * in the per-axis refusal mix means nothing unless you know which rubric
 * produced it. `NATIVE_EDITOR_RUBRIC_VERSION` precedent
 * (`language-gate.ts:621`). Bumped when an axis changes MEANING, not when it
 * gains an example.
 */
export const VALUE_RUBRIC_VERSION = "1";

/**
 * How many `weak` axes refuse. Two do; one does not.
 *
 * A real threshold with a real other side. One weak is a competent post with
 * one soft corner, which is a human editor's ordinary output. Two is a
 * pattern, and the pattern is the thing this phase was commissioned to catch.
 * Flip this to 3 and the two-weak test goes green, which is how that test is
 * known to be able to fail.
 */
export const VALUE_WEAK_FAIL_COUNT = 2;

/**
 * At most this many of a run's attempts may be caused by a value refusal,
 * even if a future budget plan allows more attempts.
 *
 * The value gate adds NO inner rounds of its own — it rides the existing
 * attempt loop (`maxAttempts = min(MAX_SELF_CHECK_ATTEMPTS, budgetPlan.maxSelfCheckAttempts)`).
 * This is the ceiling on how much of that loop it may spend.
 */
export const VALUE_MAX_RETURNS = 2;

/** Fewer cards than this carrying a number or a proper noun relaxes `newFact` to advisory (rule 3). */
export const VALUE_MIN_SPECIFIC_CARDS = 2;

/** How much of the post the judge reads; a carousel is far smaller, the cap guards a runaway single-format caption. */
export const VALUE_JUDGE_MAX_CHARS = 12_000;

/** A `fixInstructions[i]` longer than this is the model writing an essay instead of a remedy. */
export const VALUE_FIX_MAX_CHARS = 240;

/** How much of a passing quote the `KEEP AS WRITTEN` line reproduces before it elides. */
export const VALUE_KEEP_QUOTE_CHARS = 160;

/** `07i1-verify-lead-claim`'s four outcomes (RFC-18 §4.3). Only `not-found-on-page` changes a verdict. */
export type LeadClaimStatus = "confirmed" | "not-found-on-page" | "unreachable" | "no-url";

/** One remedy: which axis, which target, and one imperative sentence naming what to write instead. */
export interface ValueFix {
  axis: ValueAxis;
  /** `cover`, `caption`, or `slide:N`. */
  target: string;
  instruction: string;
}

// ─────────────────────────────────────────────────────────────────────────
// The output contract — twelve flat fields
// ─────────────────────────────────────────────────────────────────────────

const AXIS_FIELD_DESCRIPTION =
  "Exactly one of: pass, weak, fail. pass = you quoted words from the post that satisfy the test; weak = something is there but it does not meet the test as written; fail = nothing in the post answers the question.";

/**
 * Twelve flat fields, `RELEVANCE_OUTPUT_FIELDS` style.
 *
 * Three PARALLEL ARRAYS rather than an `object[]` because the flat DSL
 * (`AgentDefinitionFieldSchema`) is `"string" | "number" | "boolean" |
 * "string[]"` and has no `object[]`. Misalignment is not trusted: an index
 * whose axis is not one of the four, or names an axis that came back `pass`,
 * or whose target does not match `^(cover|caption|slide:[1-8])$`, is
 * DISCARDED — and a discarded fix leaves its axis with no fix, which rule 2
 * then acts on.
 *
 * There is deliberately no `keepable` field. The bar is computed in
 * `decideValue`, never requested.
 */
export const VALUE_OUTPUT_FIELDS: readonly AgentDefinitionField[] = [
  { name: "newFact", type: "string", description: `Question 1 (something a practitioner did not already know). ${AXIS_FIELD_DESCRIPTION}`, optional: false },
  { name: "position", type: "string", description: `Question 2 (a side someone could argue with). ${AXIS_FIELD_DESCRIPTION}`, optional: false },
  { name: "payload", type: "string", description: `Question 3 (something a reader would keep). ${AXIS_FIELD_DESCRIPTION}`, optional: false },
  { name: "action", type: "string", description: `Question 4 (a specific thing the reader can do next). ${AXIS_FIELD_DESCRIPTION}`, optional: false },
  { name: "newFactQuote", type: "string", description: "Required when newFact is pass: the named, checkable specific, copied from the post character for character.", optional: true },
  { name: "positionQuote", type: "string", description: "Required when position is pass: the sentence a competent person could disagree with, copied from the post character for character.", optional: true },
  { name: "payloadQuote", type: "string", description: "Required when payload is pass: the one slide body that best shows a claim plus its consequence, copied from the post character for character.", optional: true },
  { name: "actionQuote", type: "string", description: "Required when action is pass: the action, copied from the post character for character.", optional: true },
  { name: "fixAxes", type: "string[]", description: "One entry per weak or fail axis, naming it: newFact, position, payload or action. Index-aligned with fixTargets and fixInstructions.", optional: true },
  { name: "fixTargets", type: "string[]", description: "Where each fix applies: cover, caption, or slide:N (N is the slide number). Index-aligned with fixAxes.", optional: true },
  {
    name: "fixInstructions",
    type: "string[]",
    description: `One imperative sentence per fix, naming what to write instead. At most ${VALUE_FIX_MAX_CHARS} characters each. Index-aligned with fixAxes.`,
    optional: true,
  },
  { name: "keepLine", type: "string", description: "One sentence naming what a reader would save this post for. If you cannot write that sentence honestly, say so in it. At most 160 characters.", optional: false },
];

/** The judge's answer, as the schema delivers it. Every field still `unknown` until `runValueJudge` has read it. */
export interface RawValueVerdict {
  newFact: ValueAxisVerdict;
  position: ValueAxisVerdict;
  payload: ValueAxisVerdict;
  action: ValueAxisVerdict;
  newFactQuote?: string;
  positionQuote?: string;
  payloadQuote?: string;
  actionQuote?: string;
  fixAxes?: string[];
  fixTargets?: string[];
  fixInstructions?: string[];
  keepLine?: string;
}

/** The quote field that belongs to each axis. */
const QUOTE_FIELD: Record<ValueAxis, keyof RawValueVerdict> = {
  newFact: "newFactQuote",
  position: "positionQuote",
  payload: "payloadQuote",
  action: "actionQuote",
};

/** How each axis is named to a human — in the steer, and in the `KEEP AS WRITTEN` line. */
const AXIS_LABEL: Record<ValueAxis, string> = {
  newFact: "the new fact",
  position: "the position",
  payload: "the payload",
  action: "the action",
};

/**
 * What each axis asks for, in one line.
 *
 * Used only when a refusal carries NO fix at all — which is reachable exactly
 * when code, not the model, downgraded an axis (a fabricated quote under rule
 * 1, or the lead-claim cap under rule 4). Without these the steer for that
 * case would be an empty list, which is the "hold generator" shape rule 2
 * exists to forbid, arriving by a different door.
 */
const VALUE_AXIS_ASKS: Record<ValueAxis, string> = {
  newFact: "put a named, checkable specific on a slide that has none: a figure with its unit and its period, a named product, standard, price or version.",
  position: "make the cover assert something a competent person in this field could argue with, and repeat the assertion in different words in the caption's first line.",
  payload: "give the carousel a structure a reader would come back to, and make each slide say what follows from its claim for the reader.",
  action: "end the caption with one thing the reader can do today with what they already have, and say what they get back for doing it.",
};

/** The target shapes a fix may name. Anything else is a fix that cannot be applied and is discarded. */
const FIX_TARGET = /^(cover|caption|slide:[1-8])$/;

// ─────────────────────────────────────────────────────────────────────────
// The rubric
// ─────────────────────────────────────────────────────────────────────────

/**
 * The judge's system prompt — RFC-18 §5.2, inline.
 *
 * **Inline, not a prompt-store file**, for the reason `relevance-gate.ts:43-45`
 * states: a check whose wording lived in the same editable store as the
 * drafting prompts could be edited to agree with them. It also means no second
 * prompt-registry entry and no second prompt bump for this judge.
 *
 * **Four axes, not six.** A "does it use its own words" axis and a separate
 * "so what" axis were both considered and rejected: the first is the free
 * 8-gram check in `value-signals.ts`, and the second is the `payload` axis's
 * own second half. Paying a model for what a regex already decided is the one
 * thing this budget cannot afford. Rhythm is not an axis either — it has no
 * reader-value consequence a fix can name, so it is a craft rule in the
 * writer's prompt and a free mechanical check, never a paid opinion.
 *
 * Two deliberate departures from §5.2's text, both documented rather than
 * quiet:
 *
 * 1. The four question headings are written with a colon rather than an em
 *    dash. Every word is otherwise verbatim. The reason is recorded in RFC-18
 *    §3: a prep run failed craft hygiene on that character twice in three
 *    attempts, and this judge's `fixInstructions` are fed to the writer as
 *    `valueSteer`, so a dash in here is a dash one rewrite away from the copy.
 * 2. One added line asking for plain characters, for the same reason.
 */
export function buildValueSystemPrompt(): string {
  return [
    "You are a practitioner in this client's field, scrolling. You are handed the account owner's Client Brief, the fact cards this post was built from, and one finished Instagram post: its caption and every slide's headline and body.",
    "",
    "You are NOT scoring how good it is. You are answering four yes-or-no questions, and for each one you must either QUOTE the words in the post that make the answer yes, or say what to write instead. A question you cannot quote an answer for is not a yes.",
    "",
    "1. newFact: is there something here a practitioner in this field did not already know?",
    "A yes needs a named, checkable specific: a figure with its unit and its period, a named product, company, standard, law, price or version, a dated event. A category noun is not a specific (\"productivity tools\", \"modern platforms\", \"the industry\"). A fact that any practitioner already knows is not a yes even if it is true and well sourced.",
    "Quote the specific. If there is none, name the fact card that carries one and say which slide should carry it.",
    "",
    "2. position: does this post take a side someone could argue with?",
    "A yes needs a sentence, on the cover or in the caption's first line, that a competent person in this field could disagree with. \"X is not the reason Y happens\" is a position. \"X is an important consideration\" is not. A statement that is true of every business in this industry is not a position, it is a description.",
    "Quote the sentence. If there is none, write the position this post's own evidence would support, in one sentence.",
    "",
    "3. payload: is there something here a reader would keep?",
    "A yes needs two things. First, a structure a reader could come back to: a glossary, a ranking, a comparison, a checklist, a walkthrough, a myth corrected, a teardown. Second, slides that each carry ONE claim and say what follows from it for the reader. A carousel of six true statements with no consequence attached is not a payload.",
    "Quote the one slide whose body best shows the claim plus its consequence. If no slide does, name the slide that comes closest and write its missing consequence.",
    "",
    "4. action: is there a specific thing the reader can do next?",
    "A yes needs an action the reader can take with what they already have, named precisely enough to start today, and worded so it asks for something specific rather than hoping for engagement. \"Comment below\" and \"thoughts?\" are not actions. \"Check which of the three your current contract uses, and reply with the number if you want the comparison sheet\" is.",
    "Quote the action. If there is none, write one this post has earned.",
    "",
    "Answer each question with exactly one of: pass, weak, fail.",
    "- pass: you quoted it and the quote satisfies the test.",
    "- weak: something is there but it does not meet the test as written.",
    "- fail: nothing in the post answers the question.",
    "",
    "Every quote must be copied from the post EXACTLY, character for character. Do not tidy it, do not translate it, do not shorten it. A quote that is not in the post is treated as no quote at all.",
    "Every weak and every fail must carry a fix: which axis, which target (cover, caption, or slide:N), and one imperative sentence naming what to write instead. A weak or a fail with no fix is discarded and the axis is treated as a pass, so do not raise a problem you cannot say the remedy for.",
    "Judge only these four questions. Not grammar, not fluency, not whether the post is on-brief, not whether the facts are true, not whether you like it. Those have their own checks and their own remedies.",
    "The post may be written in Hebrew, Arabic or another language. Judge it in the language it is written, and quote in that language.",
    "Write your fixes in plain characters: no em dash, no en dash, no double hyphen. The writer is held to that rule and reads your fixes verbatim.",
    "",
    "Finally, write keepLine: one sentence naming what a reader would save this post for. If you cannot write that sentence honestly, say so in it.",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// The bar
// ─────────────────────────────────────────────────────────────────────────

/**
 * The bar, in code. RFC-18 §5.5's three clauses.
 *
 * Computed in the repository and never read from the model's own opinion of
 * itself — there is no `keepable` field in the output contract for it to
 * answer with.
 *
 * **Clause (2) is the audit's charge in one line.** A post that is accurate,
 * on-brief, fluent, tells the reader nothing they did not know and takes no
 * position is precisely the post every existing gate passes. It earns a clause
 * of its own because it is the exact shape this phase was commissioned to
 * refuse, and without it that shape survives any future relaxation of
 * `VALUE_WEAK_FAIL_COUNT`.
 *
 * **One documented refinement of §5.5's snippet**: clause (2) is skipped when
 * `newFact` is advisory. §5.4's rule 3 says an advisory axis is "recorded,
 * excluded from the decision", and clause (2) is part of the decision; reading
 * `axes.newFact` there unconditionally would re-import the unwinnable axis
 * that the relaxation exists to remove, for exactly the thinly-grounded client
 * Phase 0 already had to correct the floor for once.
 */
export function decideValue(axes: ValueAxes, advisory: readonly ValueAxis[] = []): boolean {
  const scored = VALUE_AXES.filter((a) => !advisory.includes(a)).map((a) => axes[a]);
  if (scored.includes("fail")) return false;
  if (!advisory.includes("newFact") && axes.newFact === "weak" && axes.position === "weak") return false;
  return scored.filter((v) => v === "weak").length < VALUE_WEAK_FAIL_COUNT;
}

const AXIS_RANK: Record<ValueAxisVerdict, number> = { fail: 0, weak: 1, pass: 2 };

/**
 * Did the redraft actually move? True only when at least one axis moved UP
 * (`fail -> weak -> pass`) and none moved down.
 *
 * The no-improvement stop this feeds saves a whole ~$0.26 attempt on the runs
 * where the writer has nothing more to give, and it is a stop rather than a
 * hold: the draft ships marked `below-bar` with the stall named.
 */
export function axesImproved(prev: ValueAxes, next: ValueAxes): boolean {
  let up = false;
  for (const axis of VALUE_AXES) {
    const delta = AXIS_RANK[next[axis]] - AXIS_RANK[prev[axis]];
    if (delta < 0) return false;
    if (delta > 0) up = true;
  }
  return up;
}

// ─────────────────────────────────────────────────────────────────────────
// Normalising the verdict
// ─────────────────────────────────────────────────────────────────────────

/** Everything outside the judge's answer that the four rules of §5.4 need. */
export interface ValueNormaliseOptions {
  /** `isThinlyGrounded(brief)`. The caller owns the brief; this module stays a judge and not a brief reader. */
  thinlyGrounded?: boolean;
  /** The run's deduped fact cards. Fewer than `VALUE_MIN_SPECIFIC_CARDS` carrying a specific relaxes `newFact` too. */
  factCards?: readonly FactCardForPrompt[];
  /** `07i1-verify-lead-claim`'s verdict for this attempt. */
  leadClaim?: LeadClaimStatus;
}

export interface NormalisedValueVerdict {
  axes: ValueAxes;
  /** Axes recorded but excluded from the decision (today: `newFact` under thin grounding). */
  advisoryAxes: ValueAxis[];
  fixes: ValueFix[];
  /** Only quotes that were re-found in the draft. The `KEEP AS WRITTEN` line is built from these and from nothing else. */
  verifiedQuotes: Partial<Record<ValueAxis, string>>;
  keepable: boolean;
  keepLine?: string;
  /** Why an axis was relaxed or capped, in the reviewer's words. Never silent: these reach the gate payload and a ledger warn. */
  notes: string[];
}

/** Whitespace-normalised, for the span rule. Case is NOT folded: the rubric asks for a quote copied character for character. */
function normaliseSpan(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** The exact bytes the span rule tests against: the model's own output, caption and slides, in reading order. */
export function valueDraftText(caption: string, slides: ReadonlyArray<{ headline: string; body: string }>): string {
  // Phase 4's bidi isolates never enter this text (`bidi-isolate.ts:113-123`
  // applies them to RENDERED SLIDE TEXT ONLY, never to anything a gate reads),
  // so no stripping step is needed and none is written. An exact substring
  // test is the whole rule.
  return [caption, ...slides.flatMap((s) => [s.headline, s.body])].join("\n");
}

/** The slides as the judge reads them — headline and body only, never `visualNeed` or `sourceRef` (those are for other steps). */
export function valueSlidesFor(copy: InstagramCopyOutput): Array<{ n: number; headline: string; body: string }> {
  return copy.slides.map((s) => ({ n: s.n, headline: s.headline, body: s.body }));
}

function isAxisName(value: string): value is ValueAxis {
  return (VALUE_AXES as readonly string[]).includes(value);
}

/**
 * The four rules of RFC-18 §5.4, pure and in code.
 *
 * Rule order is load-bearing, and the two axis rules are DISJOINT by
 * construction:
 *
 * - **Rule 2 (the fix rule)** applies only to axes the MODEL reported as
 *   `weak`/`fail`. One with no surviving fix is set back to `pass`. "Report
 *   without proposing" is structurally unrepresentable.
 * - **Rule 1 (the span rule)** applies only to axes the MODEL reported as
 *   `pass`. A quote that does not occur in the draft downgrades the axis to
 *   `weak` — not to `fail`: one paraphrased quote is a model tidying
 *   whitespace, two are a judge inventing, and two weaks already refuse.
 *
 * If rule 2 were allowed to see a rule-1 downgrade it would revert it
 * immediately (a span-downgraded axis has no fix, because the model thought it
 * was a pass), and rule 1 would be a no-op. A code-imposed downgrade is not
 * subject to the fix rule.
 *
 * - **Rule 4 (the `07i1` cap)** then caps `newFact` at `weak` when the lead
 *   claim could not be found on its own source page.
 * - **Rule 3 (the relaxation)** demotes `newFact` to advisory when the brief
 *   is thinly grounded or the research came back without two cards carrying a
 *   specific. Without it, a client whose research returned four definitions
 *   fails an axis no redraft can answer, three times, and Phase 5 has
 *   reinvented the unwinnable floor Phase 0 already had to correct.
 */
export function normaliseValueVerdict(raw: RawValueVerdict, draftText: string, options: ValueNormaliseOptions = {}): NormalisedValueVerdict {
  const haystack = normaliseSpan(draftText);
  const claimed: ValueAxes = { newFact: raw.newFact, position: raw.position, payload: raw.payload, action: raw.action };
  const axes: ValueAxes = { ...claimed };
  const notes: string[] = [];

  // The three parallel arrays, index-aligned. Misalignment is not trusted.
  const fixAxes = raw.fixAxes ?? [];
  const fixTargets = raw.fixTargets ?? [];
  const fixInstructions = raw.fixInstructions ?? [];
  const fixes: ValueFix[] = [];
  for (let i = 0; i < fixAxes.length; i++) {
    const axis = (fixAxes[i] ?? "").trim();
    const target = (fixTargets[i] ?? "").trim();
    const instruction = (fixInstructions[i] ?? "").trim();
    if (!isAxisName(axis)) continue;
    // A fix for an axis the judge itself passed is not a remedy, it is a
    // second opinion nobody asked for, and applying it would send back a
    // draft on an axis that already met the test.
    if (claimed[axis] === "pass") continue;
    if (!FIX_TARGET.test(target)) continue;
    if (instruction.length === 0) continue;
    fixes.push({ axis, target, instruction: instruction.slice(0, VALUE_FIX_MAX_CHARS) });
  }

  // Rule 2 — a model-claimed non-pass with no surviving fix reverts to pass.
  for (const axis of VALUE_AXES) {
    if (claimed[axis] === "pass") continue;
    if (!fixes.some((f) => f.axis === axis)) axes[axis] = "pass";
  }

  // Rule 1 — a model-claimed pass must carry a quote that is really in the draft.
  const verifiedQuotes: Partial<Record<ValueAxis, string>> = {};
  for (const axis of VALUE_AXES) {
    if (claimed[axis] !== "pass") continue;
    const quote = raw[QUOTE_FIELD[axis]];
    const span = typeof quote === "string" ? normaliseSpan(quote) : "";
    if (span.length > 0 && haystack.includes(span)) {
      verifiedQuotes[axis] = span;
      continue;
    }
    axes[axis] = "weak";
    notes.push(
      span.length === 0
        ? `${AXIS_LABEL[axis]} was passed with no quote, and a question you cannot quote an answer for is not a yes`
        : `${AXIS_LABEL[axis]} was passed on a quote that does not occur in the post ("${span.slice(0, 80)}")`,
    );
  }

  // Rule 4 — the lead-claim cap.
  if (options.leadClaim === "not-found-on-page" && axes.newFact === "pass") {
    axes.newFact = "weak";
    notes.push("the figure the cover leads on could not be found on its own source page, so the new fact is capped at weak for this attempt");
  }

  // Rule 3 — the thin-grounding relaxation.
  const advisoryAxes: ValueAxis[] = [];
  const specificCards = (options.factCards ?? []).filter(cardCarriesSpecific).length;
  const thinCards = options.factCards !== undefined && specificCards < VALUE_MIN_SPECIFIC_CARDS;
  if (axes.newFact !== "pass" && (options.thinlyGrounded === true || thinCards)) {
    advisoryAxes.push("newFact");
    notes.push(
      options.thinlyGrounded === true
        ? "the new fact was recorded but not scored: this client's brief grounds the post in an industry rather than a business, so no redraft could answer that axis"
        : `the new fact was recorded but not scored: only ${specificCards} of this run's fact cards carry a figure or a named thing, so no redraft could answer that axis`,
    );
  }

  const keepLine = typeof raw.keepLine === "string" && raw.keepLine.trim().length > 0 ? raw.keepLine.trim() : undefined;
  return {
    axes,
    advisoryAxes,
    fixes,
    verifiedQuotes,
    keepable: decideValue(axes, advisoryAxes),
    ...(keepLine !== undefined ? { keepLine } : {}),
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// The verdict, and what goes back to the writer
// ─────────────────────────────────────────────────────────────────────────

/** Everything a judged verdict carries, whichever side of the bar it landed on. */
export interface JudgedValueVerdict extends NormalisedValueVerdict {
  rubricVersion: string;
}

export type ValueVerdict =
  | ({ status: "keepable" } & JudgedValueVerdict)
  | ({ status: "below-bar" } & JudgedValueVerdict)
  | { status: "error"; reason: string };

export type BelowBarVerdict = Extract<ValueVerdict, { status: "below-bar" }>;

/** The `lastSelfCheckReason` wording for a below-bar verdict — one place, so the trace and the gate payload agree. */
export function valueFailureReason(verdict: BelowBarVerdict): string {
  const named = VALUE_AXES.filter((a) => verdict.axes[a] !== "pass" && !verdict.advisoryAxes.includes(a)).map((a) => `${a}: ${verdict.axes[a]}`);
  return `post is below the value bar (${named.join(", ")})`;
}

const COUNT_WORD = ["nothing", "one", "two", "three", "four"];

/** `"a", "b" and "c"` — the joiner the `KEEP AS WRITTEN` line uses. */
function joinWithAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]!}`;
}

function elide(quote: string): string {
  return quote.length <= VALUE_KEEP_QUOTE_CHARS ? quote : `${quote.slice(0, VALUE_KEEP_QUOTE_CHARS).trimEnd()}...`;
}

/**
 * The fifth typed steer, `valueSteer` — a one-attempt lifetime, kept apart
 * from `selfCheckSteer` / `relevanceSteer` / `dedupeRetrySteer` / `nativeSteer`
 * so none can overwrite another.
 *
 * **The `KEEP AS WRITTEN:` line is built HERE, in code, from the passing axes'
 * VERIFIED quotes, and never from the model.** That line is the anti-thrash
 * mechanism: without it, the classic redraft regression is fixing one axis by
 * destroying another, and after three rounds the post is worse than attempt 1.
 * A quote that failed the span rule is not in `verifiedQuotes`, so a
 * fabricated line can never be handed back to the writer as accepted text.
 *
 * A value fix is a REWRITE INSTRUCTION, not an anchored span — the opposite of
 * Phase 4's corrections, deliberately. A rewrite is what an attempt is, which
 * is why this phase builds no patcher and no second round of its own.
 */
export function valueSteerFor(verdict: BelowBarVerdict, verifiedQuotes: Partial<Record<ValueAxis, string>> = verdict.verifiedQuotes): string {
  const lines: string[] = [];
  const items = verdict.fixes.length > 0
    ? verdict.fixes.map((f) => `[${f.axis}] ${f.target}: ${f.instruction}`)
    : VALUE_AXES.filter((a) => verdict.axes[a] !== "pass" && !verdict.advisoryAxes.includes(a)).map((a) => `[${a}] the post: ${VALUE_AXIS_ASKS[a]}`);

  const count = items.length === 1 ? "this one thing" : `these ${COUNT_WORD[items.length] ?? String(items.length)} things`;
  lines.push(`The value check returned this draft. Fix ${count} and change nothing else.`);
  items.forEach((item, i) => lines.push(`${i + 1}. ${item}`));

  const kept = VALUE_AXES.filter((a) => verdict.axes[a] === "pass" && verifiedQuotes[a] !== undefined).map((a) => `"${elide(verifiedQuotes[a]!)}" (${AXIS_LABEL[a]})`);
  lines.push(kept.length === 0 ? "KEEP AS WRITTEN: nothing yet passed." : `KEEP AS WRITTEN: ${joinWithAnd(kept)}.`);
  return lines.join("\n");
}

/**
 * The one ledger warn a degraded value delivery writes, keyed
 * `${runId}__value-${status}-r${revision}` so a resume writes one row rather
 * than a second one.
 *
 * A warn and not an info: the post ships, and the reviewer is being told that
 * the check which would normally have sent it back did not get to.
 */
export function valueDegradedEvent(
  runId: string,
  revision: number,
  status: "below-bar" | "unjudged",
  detail: string,
): { eventId: string; level: "warn"; message: string } {
  const message =
    status === "unjudged"
      ? `the value judge could not run (${detail}); the post shipped unjudged for value and no redraft was spent — the reviewer should check there is a reason to save this post`
      : `the post shipped below the value bar (${detail}) — the axes and the fixes the judge named are on this run's review payload`;
  return { eventId: `${runId}__value-${status}-r${revision}`, level: "warn", message };
}

// ─────────────────────────────────────────────────────────────────────────
// Running the judge
// ─────────────────────────────────────────────────────────────────────────

export interface ValueGateDeps {
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
}

export interface ValueJudgeInput {
  /** `briefForPrompt(brief)` — the same rendering the copy agent read. */
  brief: string;
  caption: string;
  slides: Array<{ n: number; headline: string; body: string }>;
  /** The cards this post was built from: the judge names one when `newFact` has no answer in the post. */
  factCards: readonly FactCardForPrompt[];
  /** The structure the writer declared, when it declared one. */
  payloadKind?: string;
}

function readAxis(value: unknown): ValueAxisVerdict | undefined {
  if (typeof value !== "string") return undefined;
  const folded = value.trim().toLowerCase();
  return (VALUE_AXIS_VERDICTS as readonly string[]).includes(folded) ? (folded as ValueAxisVerdict) : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * One Flash call: is there a reason to save this post?
 *
 * Never throws. A judge that did not complete, or that answered with an axis
 * outside `{pass, weak, fail}`, returns `status: "error"` and the caller fails
 * OPEN with a ledger warn — an axis outside the rubric is a judge that did not
 * follow it, and a verdict built on it would be a guess dressed as a score
 * (`relevance-gate.ts:265-271`; never clamped).
 */
export async function runValueJudge(
  wf: WorkflowContext,
  deps: ValueGateDeps,
  stepId: string,
  input: ValueJudgeInput,
  options: ValueNormaliseOptions = {},
): Promise<ValueVerdict> {
  const judge = new DynamicAgent(
    { tools: deps.tools, router: deps.router, promptStore: deps.promptStore },
    {
      id: "instagram-value-judge",
      description: "Judge whether a drafted Instagram post gives a practitioner in this client's field a reason to save it: a new fact, a position, a payload and an action, each evidenced by a verbatim quote from the post.",
      // No tools: a judge that can call tools is a judge that can be steered.
      allowedTools: [],
      outputSchema: buildOutputSchema([...VALUE_OUTPUT_FIELDS]),
      // Pinned Flash on the Gemini vendor — the commodity tier, at $0.003 an
      // attempt (see this module's header for the arithmetic and for why Pro
      // and Opus are both out). `resolveModelPolicy` keeps the per-step env
      // override path, and `contentLanguageSensitive` is deliberately absent.
      modelPolicy: resolveModelPolicy("instagram-value-judge", { policy: "pinned", model: "gemini-2.5-flash", vendor: "gemini" }),
      maxSteps: 1,
    },
    buildValueSystemPrompt(),
  );

  const post = {
    caption: input.caption.slice(0, VALUE_JUDGE_MAX_CHARS),
    slides: input.slides,
    ...(input.payloadKind !== undefined ? { declaredStructure: input.payloadKind } : {}),
  };
  const factCards = input.factCards.map((c, i) => ({ card: i + 1, claim: c.claim, source: c.source, date: c.date }));
  const exec = await wf.step.agent(stepId, judge, { clientBrief: input.brief, factCards, post });
  if (exec.status !== "completed" || !exec.finalOutput) {
    return { status: "error", reason: `value judge did not complete (${exec.status})` };
  }

  const output = exec.finalOutput as unknown as Record<string, unknown>;
  const axes: Partial<ValueAxes> = {};
  for (const axis of VALUE_AXES) {
    const read = readAxis(output[axis]);
    if (read === undefined) {
      return { status: "error", reason: `value judge returned "${String(output[axis])}" for ${axis}, which is not one of pass, weak, fail` };
    }
    axes[axis] = read;
  }

  const optional = <T,>(key: string, value: T | undefined): Record<string, T> => (value === undefined ? {} : { [key]: value });
  const raw: RawValueVerdict = {
    newFact: axes.newFact!,
    position: axes.position!,
    payload: axes.payload!,
    action: axes.action!,
    ...optional("newFactQuote", readString(output.newFactQuote)),
    ...optional("positionQuote", readString(output.positionQuote)),
    ...optional("payloadQuote", readString(output.payloadQuote)),
    ...optional("actionQuote", readString(output.actionQuote)),
    ...optional("fixAxes", readStringArray(output.fixAxes)),
    ...optional("fixTargets", readStringArray(output.fixTargets)),
    ...optional("fixInstructions", readStringArray(output.fixInstructions)),
    ...optional("keepLine", readString(output.keepLine)),
  };

  const normalised = normaliseValueVerdict(raw, valueDraftText(input.caption, input.slides), options);
  return { status: normalised.keepable ? "keepable" : "below-bar", rubricVersion: VALUE_RUBRIC_VERSION, ...normalised };
}
