import { readRichRunInput, type MediaAsset } from "@agent-engine/core";

/**
 * The run-scoped direction a person typed, resolved once per run.
 *
 * ## Why this wrapper exists over `readRichRunInput`
 *
 * `readRichRunInput` already parses `customPrompt`/`mediaAssets` off a run's
 * input, and tiktok-agent has used it since it landed. What no agent had was a
 * shared answer to the two questions that follow: does a typed instruction
 * outrank the topic catalog, and does the drafting model get to see it?
 *
 * Answering those per agent is how five copies of the research-extraction step
 * drifted, so this answers them once. `topicOverride` decides precedence,
 * `direction` is what reaches the model, and (for a typed instruction) both
 * come from the same string so they cannot disagree.
 *
 * `direction` and `topicOverride` are not the same claim. A person who writes
 * "focus on the product launch" has named a subject; a person who writes "keep
 * it short and skip the emoji" has named a style and should not have it
 * reserved as a topic. The heuristic below decides which, and errs toward
 * treating a sentence as direction rather than as a topic. An explicit
 * `requestedTopic` field is exempt from that heuristic: it says what it is.
 */

/**
 * The structured half of a per-run brief — the portal's shared intake fields
 * (`toEngineRunInput` in karosCMO: audience, tone, cta, mustInclude[],
 * keywords[], runScope), read here once so every agent gets them the same way.
 *
 * WHY THIS EXISTS. The portal's run dialogs collect these on every engine-routed
 * agent and send them on the wire, and until 2026-09 no workflow read a single
 * one of them: a client filled in "Audience" and "Must include" and the model
 * never saw either. Every agent already spreads `runDirectionField(...)` into
 * its drafting step (pinned by apps/agent-server's run-direction coverage
 * test), so folding the brief into `direction` there is the one-place fix.
 */
export interface RunBrief {
  audience?: string;
  tone?: string;
  cta?: string;
  mustInclude: readonly string[];
  keywords: readonly string[];
  /** X's "Company page" / "One person's seat" scope selector. */
  runScope?: string;
  /**
   * The per-dialog fields below are collected by ONE product's form each, and
   * are carried here for the same reason as the shared ones: the agent that
   * owns the form is the only one that will ever receive them, and until now
   * it received them not at all. Every one of these is a question the portal
   * asks a client and then dropped on the floor — seo-geo asked for the site
   * to audit, its market and its competitors and passed none of the three.
   *
   * Rendered as labelled prose rather than acted on structurally: this makes
   * the model AWARE of the answer, which is the whole of what a free-text
   * steer can promise. An agent that should change its BEHAVIOUR on one of
   * these (auditing the typed URL rather than the configured one, honouring a
   * "revise" run mode) has to read it off `wf.input` itself and decide what it
   * means — see this module's own note in the portal's field contract.
   */
  runMode?: string;
  platform?: string;
  duration?: string;
  offer?: string;
  proof?: string;
  website?: string;
  scope?: string;
  market?: string;
  competitors?: string;
}

export interface RunDirection {
  /**
   * What the drafting model reads: the typed instruction, followed by the
   * labelled brief lines. Undefined only when the run carries neither.
   */
  direction?: string;
  /**
   * The topic this run is about, when the person said so. An explicit
   * `requestedTopic` always wins; a typed instruction is promoted only when it
   * reads like a topic line (see `looksLikeTopic`).
   */
  topicOverride?: string;
  mediaAssets: readonly MediaAsset[];
  brief: RunBrief;
}

/**
 * Words that mean the sentence is about HOW to write, not WHAT to write about.
 *
 * Kept short and boring on purpose. A longer list would start making editorial
 * judgments about phrasing, and the cost of a wrong guess is asymmetric: a
 * style note misread as a topic gets reserved in the catalog and drafted
 * against, which produces a post about the instruction itself.
 */
const STYLE_ONLY_HINTS = [
  "tone",
  "shorter",
  "longer",
  "avoid",
  "don't",
  "do not",
  "no emoji",
  "keep it",
  "make it",
  "less",
  "more casual",
  "more formal",
  "punchier",
];

/**
 * True when the instruction reads as a subject rather than a style note.
 *
 * Deliberately conservative: anything carrying a style hint is treated as
 * direction only. A run that also wants a specific subject can still say so
 * through `requestedTopic`, which outranks this either way.
 */
function looksLikeTopic(instruction: string): boolean {
  const lower = instruction.toLowerCase();
  if (STYLE_ONLY_HINTS.some((hint) => lower.includes(hint))) return false;
  // A whole paragraph is a brief, not a topic line.
  return instruction.length <= 160;
}

function readString(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = input[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringList(input: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === "string" && item.trim().length > 0 ? [item.trim()] : []));
}

/**
 * Every scalar the portal can send, paired with the label a model reads it
 * under. ONE table, walked by both the reader and the renderer, so a field
 * cannot be parsed-but-unlabelled (silently dropped from the prose) or
 * labelled-but-unparsed (a label for a value nobody read) — the two halves
 * drifting apart is how `postCount` survived as a control that did nothing.
 *
 * The order is the order a model reads them in, and it is fixed so two runs
 * with the same brief produce the same prompt.
 */
const BRIEF_SCALARS = [
  ["audience", "Audience"],
  ["tone", "Tone"],
  ["cta", "Call to action"],
  ["runMode", "Run mode"],
  ["platform", "Channel"],
  ["duration", "Target duration"],
  ["offer", "Offer"],
  ["proof", "Proof to lean on"],
  ["website", "Website"],
  ["scope", "Scope"],
  ["market", "Market"],
  ["competitors", "Competitors"],
  ["runScope", "Scope of this run"],
] as const satisfies ReadonlyArray<readonly [key: keyof RunBrief, label: string]>;

const BRIEF_LISTS = [
  ["mustInclude", "Must include", "; "],
  ["keywords", "Keywords to work in", ", "],
] as const satisfies ReadonlyArray<readonly [key: keyof RunBrief, label: string, join: string]>;

export function readRunBrief(input: Readonly<Record<string, unknown>> | undefined): RunBrief {
  const raw = input ?? {};
  const scalars: Record<string, string> = {};
  for (const [key] of BRIEF_SCALARS) {
    const value = readString(raw, key);
    if (value) scalars[key] = value;
  }
  return {
    ...scalars,
    mustInclude: readStringList(raw, "mustInclude"),
    keywords: readStringList(raw, "keywords"),
  };
}

/**
 * The brief as prose lines for a model, in a fixed order so two runs with the
 * same brief read the same. Empty when nothing was filled in.
 */
export function renderRunBrief(brief: RunBrief, requestedTopic?: string): string[] {
  const lines: string[] = [];
  if (requestedTopic) lines.push(`Requested topic: ${requestedTopic}`);
  for (const [key, label] of BRIEF_SCALARS) {
    const value = brief[key];
    if (typeof value === "string" && value.length > 0) lines.push(`${label}: ${value}`);
  }
  for (const [key, label, join] of BRIEF_LISTS) {
    const value = brief[key];
    if (Array.isArray(value) && value.length > 0) lines.push(`${label}: ${value.join(join)}`);
  }
  return lines;
}

export function readRunDirection(input: Readonly<Record<string, unknown>> | undefined): RunDirection {
  const rich = readRichRunInput(input);
  const instruction = rich.customPrompt;
  const requestedTopic = readString(input ?? {}, "requestedTopic");
  const brief = readRunBrief(input);

  // An explicit topic field is a topic, full stop — no length or style
  // heuristic applies to it. Only a free-text instruction has to look like one.
  const topicOverride = requestedTopic ?? (instruction && looksLikeTopic(instruction) ? instruction : undefined);

  // The brief rides along with the instruction rather than replacing it, and
  // the "does this look like a topic" question above was asked of the bare
  // instruction, so appending lines here can never demote a typed topic.
  const briefLines = renderRunBrief(brief, requestedTopic);
  const direction = [instruction, ...(briefLines.length > 0 ? [briefLines.join("\n")] : [])]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");

  return {
    ...(direction ? { direction } : {}),
    ...(topicOverride ? { topicOverride } : {}),
    mediaAssets: rich.mediaAssets,
    brief,
  };
}

/**
 * The `runDirection` field to spread into a drafting step's input.
 *
 * A helper rather than inline spreading because the omit-when-absent rule
 * matters and is easy to get wrong: an explicit `runDirection: undefined` in
 * the payload invites a model to remark on its absence instead of simply
 * working without one, exactly as the existing `accountCharter` handling
 * already notes.
 */
export function runDirectionField(direction: RunDirection): { runDirection?: string } {
  return direction.direction !== undefined ? { runDirection: direction.direction } : {};
}
