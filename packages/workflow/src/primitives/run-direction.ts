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
 * `direction` is what reaches the model, and both come from the same string so
 * they cannot disagree.
 */
export interface RunDirection {
  /**
   * The instruction verbatim, for the drafting step to honour as angle and
   * tone. Undefined when nobody typed anything.
   */
  direction?: string;
  /**
   * The same string, offered as a topic when the run has no explicit
   * `requestedTopic`.
   *
   * Separate from `direction` because they are not the same claim. A person who
   * writes "focus on the product launch" has named a subject; a person who
   * writes "keep it short and skip the emoji" has named a style and should not
   * have it reserved as a topic. The heuristic below decides which, and errs
   * toward treating a sentence as direction rather than as a topic.
   */
  topicOverride?: string;
  /** Assets attached to this run, in portal order. */
  mediaAssets: readonly MediaAsset[];
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

/** Resolves a run's typed direction and attachments from its raw input. */
export function readRunDirection(input: Readonly<Record<string, unknown>> | undefined): RunDirection {
  const rich = readRichRunInput(input);
  const instruction = rich.customPrompt;
  return {
    ...(instruction ? { direction: instruction } : {}),
    ...(instruction && looksLikeTopic(instruction) ? { topicOverride: instruction } : {}),
    mediaAssets: rich.mediaAssets,
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
