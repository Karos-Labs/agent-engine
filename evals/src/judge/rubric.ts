import { evalLanguageProfile } from "../language.js";
import { RUBRIC_DIMENSIONS, type JudgeCase, type RubricDimension } from "./types.js";

/**
 * The 1–5 anchors, one line per point, for each dimension.
 *
 * Written out rather than left to the model's own sense of "good", because
 * RFC-01 §12 bullet 3 requires the rubric to be "derived from the same rules
 * that live in the skill body" — an unanchored 1–5 scale drifts between
 * judge model versions and makes a score history uncomparable, which defeats
 * the point of persisting scores at all.
 */
export const RUBRIC_ANCHORS: Readonly<Record<RubricDimension, { title: string; anchors: Readonly<Record<1 | 2 | 3 | 4 | 5, string>> }>> = {
  languageFidelity: {
    title: "Language fidelity",
    anchors: {
      1: "Written in the wrong language entirely.",
      2: "Mostly the right language but large stretches of the wrong one, or grammatically broken throughout.",
      3: "Recognizably the right language, but reads as machine translation: calqued idioms, wrong register, English sentence shapes.",
      4: "Fluent and idiomatic, with occasional phrasing a native writer would change.",
      5: "Reads as originally written in this language by a native professional writer.",
    },
  },
  brandVoiceFidelity: {
    title: "Brand voice fidelity",
    anchors: {
      1: "Contradicts the client's stated voice rules, or uses a forbidden term.",
      2: "Generic corporate copy with no trace of this client's voice.",
      3: "Broadly consistent with the voice rules but interchangeable with any competitor's post.",
      4: "Clearly this client's voice, with a lapse or two in register.",
      5: "Indistinguishable from the client's own best published work.",
    },
  },
  hookStrength: {
    title: "Hook strength",
    anchors: {
      1: "No hook: opens with throat-clearing or a restatement of the topic.",
      2: "A hook in form only; nothing about it earns the next line.",
      3: "Competent opening that would hold a reader already interested in the topic.",
      4: "Specific and concrete enough to stop a scroll.",
      5: "A genuine reason to keep reading, delivered without engagement bait.",
    },
  },
  platformConvention: {
    title: "Platform convention adherence",
    anchors: {
      1: "Would be rejected or read as spam on this platform.",
      2: "Ignores the platform's norms for length, structure, or tagging.",
      3: "Structurally acceptable but shaped like copy written for a different channel.",
      4: "Follows the platform's conventions with minor slips.",
      5: "Uses the platform's conventions deliberately and well.",
    },
  },
};

export const JUDGE_SYSTEM_PROMPT = [
  "You are a strict editorial judge scoring one piece of client-facing marketing copy against a fixed rubric.",
  "Score each dimension on the 1-5 anchors given. Use the anchors literally: do not invent intermediate meanings, and do not award a 4 or 5 out of politeness.",
  "You are grading the copy in front of you, not the topic it is about, and not whether you personally agree with it.",
  "If a reference output is supplied it is a human-endorsed example of an acceptable answer for the same brief, not a target to match word for word.",
  "Return only the structured verdict.",
].join("\n");

function renderRubric(): string {
  return RUBRIC_DIMENSIONS.map((dimension) => {
    const { title, anchors } = RUBRIC_ANCHORS[dimension];
    const lines = ([1, 2, 3, 4, 5] as const).map((point) => `  ${point} = ${anchors[point]}`).join("\n");
    return `${dimension} (${title}):\n${lines}`;
  }).join("\n\n");
}

/**
 * Builds the judge prompt for one case.
 *
 * The language requirement is stated FIRST and unconditionally, in the same
 * shape and for the same reason as `buildClientVoiceContext`'s own
 * `LANGUAGE REQUIREMENT` block (`@agent-engine/workflow`, SCRUM-309): a
 * structured field must never be indistinguishable, on the page the model
 * reads, from a sentence someone happened to write. A judge told the client's
 * language only in passing grades fluency and forgets to check the language
 * at all — which is the same omission on the grading side that AU32 was on
 * the drafting side.
 */
export function buildJudgePrompt(judgeCase: JudgeCase): string {
  const language = evalLanguageProfile(judgeCase.language);
  const sections: string[] = [];

  sections.push(
    `LANGUAGE REQUIREMENT (structured, from this client's brand kit): this copy must be written entirely in ${language.englishName} (${language.endonym}), ` +
      `a ${language.direction === "rtl" ? "right-to-left" : "left-to-right"} language. This is a hard requirement, not a stylistic preference. ` +
      `Copy in any other language scores 1 on languageFidelity regardless of how well written it is.`,
  );

  sections.push(`PLATFORM: ${judgeCase.platform}\nAGENT: ${judgeCase.agentId}\nCLIENT: ${judgeCase.clientId}`);

  if (judgeCase.brandRules) {
    const rules: string[] = [];
    if (judgeCase.brandRules.tone) rules.push(`tone: ${judgeCase.brandRules.tone}`);
    if (judgeCase.brandRules.forbiddenTerms && judgeCase.brandRules.forbiddenTerms.length > 0) {
      rules.push(`forbidden terms: ${judgeCase.brandRules.forbiddenTerms.join(", ")}`);
    }
    if (rules.length > 0) sections.push(`CLIENT VOICE RULES:\n${rules.map((r) => `- ${r}`).join("\n")}`);
  }

  if (judgeCase.notes) sections.push(`CONTEXT:\n${judgeCase.notes}`);

  sections.push(`RUBRIC:\n${renderRubric()}`);

  if (judgeCase.reference !== undefined) {
    sections.push(`HUMAN-ENDORSED REFERENCE OUTPUT (for calibration, not for word-for-word comparison):\n${judgeCase.reference}`);
  }

  sections.push(`OUTPUT UNDER EVALUATION:\n${judgeCase.output}`);

  return sections.join("\n\n---\n\n");
}
