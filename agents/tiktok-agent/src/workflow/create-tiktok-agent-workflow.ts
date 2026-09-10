import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSrt } from "@agent-engine/tool-karos-video";
import { downloadBrandLogo, planBrandLogoPlacement, readBrandLogoInk } from "@agent-engine/tool-karos-media";
import {
  UNIT_PRICING,
  evaluateDedupe,
  readForbiddenTopics,
  shingles,
  type AgentContext,
  type AgentToolRegistry,
  type GateVerdict,
  type ModelRouter,
  type PromptStore,
  firstAsset,
} from "@agent-engine/core";
import {
  AwaitingGateSignal,
  MAX_REVISION_ROUNDS,
  WorkflowBlockedIntake,
  WorkflowHeld,
  WorkflowToolingFailure,
  checkOutputDedupe,
  dedupeDirective,
  dedupeRetryDirective,
  persistReviewFeedbackToMemory,
  readClientIntelContext,
  readOutputHistoryForDedup,
  readPastFeedback,
  readRunDirection,
  revisionDirective,
  runAgentStepWithCommitSteer,
  runDirectionField,
  runReviewCycle,
  runTopicGuardrail,
  toAgentContext,
  type RevisionNote,
  type WorkflowContext,
} from "@agent-engine/workflow";
import { normalizeBannedDashes } from "@agent-engine/tool-common";
import { TikTokCommentaryAgent } from "../agent/tiktok-commentary-agent.js";
import { TikTokMomentAgent } from "../agent/tiktok-moment-agent.js";
import { TikTokScriptAgent } from "../agent/tiktok-script-agent.js";
import { TikTokTopicScoutAgent } from "../agent/tiktok-topic-scout-agent.js";
import { boundsFromTranscript, sentenceBoundedWords, type TranscriptWordLike } from "./clip-bounds.js";
import { alignScriptToTimings, buildPhraseCues, cuesToSrt, scriptWords } from "./captions.js";
import {
  CLIP_DURATION_MAX_SECONDS,
  CLIP_DURATION_MIN_SECONDS,
  CLIP_LANE,
  DEFAULT_CLIP_CONFIG,
  MAX_RUN_COST_USD,
  MomentSelectionSchema,
  ShortScriptSchema,
  TikTokClipConfigSchema,
  TopicScoutOutputSchema,
  type ClipCopy,
  type ClipFormat,
  type Commentary,
  type MomentSelection,
  type ShortScript,
  type TikTokAgentWorkflowResult,
  type TikTokClipConfig,
  type TikTokIntake,
  type TopicCandidate,
  type TopicSource,
  VISUAL_QA_ESTIMATE_USD,
} from "./types.js";

export interface CreateTikTokAgentWorkflowOptions {
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips the human approval gate and records a synthetic system approval —
   * off by default, matching every other migrated channel. The legacy product
   * is `requires_approval: true` and a draft-status generator "always blocks
   * here for the operator", so a real run genuinely parks at `awaiting_gate`.
   */
  autoApprove?: boolean;
  /**
   * Bounds root for ingesting an attached source video, harvesting footage,
   * and generating b-roll plates.
   *
   * Optional, unlike instagram's: a run that supplies `sourcePath` needs
   * nothing from here, and that is how every dispatch worked before the portal
   * grew an upload surface. Without it an ATTACHED video is refused with a
   * reason, never read from an unbounded location, and the harvest/generate
   * tiers report themselves as not wired.
   */
  repoRoot?: string;
  /** Injectable for tests; the brand-logo download uses it. */
  fetchImpl?: typeof fetch;
}

/**
 * How many commentary drafts the verified de-duplication check may cost —
 * initial draft plus ONE redraft steer. SCRUM-381 (AU20 left this agent off
 * its capability matrix by mistake — six agents were advisory, not five):
 * `recentPosts` below was already a hard-sounding do-not-repeat directive in
 * the drafting prompt, and nothing ever checked whether the model listened,
 * so a lightly-reworded reissue passed every gate. This is the verification
 * half, `checkOutputDedupe` scoring the same excerpt window against
 * `evaluateDedupe`'s calibrated threshold, in the same place the other five
 * migrated channel agents run their own check: inside the drafting pass, so a
 * `similar` verdict costs the draft rather than reaching the reviewer at
 * 11-clip-review unscored.
 *
 * Deliberately 2, not blog/reddit/x/linkedin/newsletter's 3 — this agent's
 * economics are not theirs. Every attempt here is a drafting call anchored to
 * a real, run-specific brief (a transcript excerpt, or a topic the scout
 * grounded in research), not a free choice of topic and angle the way a blog
 * or X draft is — a near-duplicate here is far more often a stylistic echo
 * than substantive repetition, and one steer quoting the offending prior post
 * is enough to break that the overwhelming majority of the time. This budget
 * only ever costs an extra text call: the expensive steps — the ffmpeg
 * composite, the QA model call, the upload — run once per REVIEW round, after
 * this loop has already settled, never once per dedupe attempt.
 */
const MAX_DEDUPE_ATTEMPTS = 2;

/**
 * Prep run pubsub-21711047251391287 went from a finished script to a held run
 * on a single em dash in one beat's narration. The script and commentary
 * steps now self-critique against `gate.lintPost`, so a dash is normally a
 * revision inside the step; these two are the deterministic backstop for the
 * one that still gets through, applied to exactly the fields 07-compliance
 * lints and 13-commit-and-record writes back into the dedupe window, so every
 * later comparison is against what actually shipped.
 */
/**
 * Where one beat's plate came from — carried to the reviewer and the
 * deliverable. `stock` is a real library clip; `still` is a generated
 * photograph held with a slow push-in; `text` is the beat's own line set
 * large on the brand ground (free, needs nothing, the tier under every
 * other tier since 2026-09-10). There is no `generated` video any more
 * (2026-09-09): the product rule is a short under two dollars, and one
 * generated clip cost more than that on its own.
 */
export type PlateSource = "stock" | "still" | "text";

interface PlateResult {
  path: string;
  source: PlateSource;
  /** The library id, so later beats in the same run never reuse the clip. */
  stockId?: number;
  sourceUrl?: string;
}

/** A `UNIT_PRICING` rate, or a tooling failure: an estimate built on a missing row would be a guess with a decimal point. */
function unitPriceUsd(sku: string): number {
  const row = UNIT_PRICING[sku];
  if (row === undefined) throw new WorkflowToolingFailure(`cannot estimate this run's cost: no UNIT_PRICING row for "${sku}"`);
  return row.usdPerUnit;
}

/** Spoken English runs ~14 characters a second at a narrator's pace; used only to size the transcription estimate. */
const NARRATION_CHARS_PER_SECOND = 14;

/**
 * A beat this long or longer is cut as TWO shots when the library can serve
 * two (2026-09-09): a six-second hold on one clip is the pace of a
 * documentary, and a vertical short changes picture every two to four
 * seconds. The second shot answers the same query with the first clip
 * excluded, so the beat stays on subject and never repeats a frame.
 */
const TWO_SHOT_BEAT_SECONDS = 6;
/** The second shot of a beat may be shorter than the beat: it only has to cover half the hold. */
const SECOND_SHOT_MIN_SECONDS = 3;

/** A music bed is a few minutes of compressed audio; anything past this is not a track. */
const MAX_MUSIC_TRACK_BYTES = 25 * 1024 * 1024;

/**
 * The cold open (2026-09-10): the hook set large on the brand ground for the
 * first two seconds, before any footage. A stranger reads the claim before
 * they hear it; every 2026-09-08 short opened on a neutral stock frame with
 * a top bar and lost the thumb. Takes its time out of beat 1's hold, so the
 * voice still starts at zero and the hook is being SAID while it is on screen.
 */
const HOOK_PLATE_SECONDS = 2;
/** Beat 1 keeps at least this much footage after the cold open, or the cold open is skipped and the title card stands in. */
const MIN_LEAD_REMAINDER_SECONDS = 1.5;
/**
 * After the visual QA names beats whose footage does not fit the line said
 * over them (relevance under 5), up to this many are re-sourced from the
 * library ONCE and the short re-rendered (2026-09-10). One round: a second
 * miss ships to the reviewer named, as before.
 */
const MAX_REPICK_BEATS = 2;

/**
 * The caption/furniture font for a language. The server image ships Noto
 * (`fonts-noto-core`), and libass falls back per glyph through fontconfig
 * anyway; naming the script's own face keeps the primary text from being
 * assembled out of fallback glyphs. Latin and everything unlisted keep the
 * frame's default.
 */
export function captionFontFor(language: string | undefined): string | undefined {
  const tag = (language ?? "").toLowerCase();
  if (tag.startsWith("he") || tag.startsWith("iw") || tag.startsWith("yi")) return "Noto Sans Hebrew";
  if (tag.startsWith("ar") || tag.startsWith("fa") || tag.startsWith("ur")) return "Noto Sans Arabic";
  if (tag.startsWith("ja")) return "Noto Sans CJK JP";
  if (tag.startsWith("ko")) return "Noto Sans CJK KR";
  if (tag.startsWith("zh")) return "Noto Sans CJK SC";
  return undefined;
}

/**
 * How many times a script that prices over the ceiling is sent back to the
 * writer with the numbers before the deterministic fallback takes over.
 * Two: the first re-plan almost always lands (fewer beats, silent), the
 * second is insurance; after that the run stops asking and simply buys
 * nothing more (stock footage only, then silent).
 */
const MAX_BUDGET_REPLANS = 2;

/** A re-plan is asked to land comfortably under the ceiling, not to graze it: three quarters of the cap. */
const REPLAN_TARGET_SHARE = 0.75;

/**
 * Where the plan's cost landed, carried to the gate payload and the
 * deliverable so a reviewer can see HOW the short was kept under the
 * ceiling, never as a failure the client meets.
 */
export type BudgetPlan = "original" | "replan" | "stock-only" | "stock-only-silent";

/**
 * Library queries any stock library answers, for the deterministic
 * fallback (`stock-only`): a beat whose own query and brief-derived query
 * both miss still gets a real, free plate rather than a still or a hold.
 * Neutral scenes with no people, rotated by beat so a short does not repeat one.
 */
const GENERIC_STOCK_QUERIES = ["city street", "office desk window", "hands typing keyboard", "clouds sky", "rain on window", "coffee cup table"] as const;

export interface CostEstimate {
  estimatedTotalUsd: number;
  costCapUsd: number;
  breakdown: { spentSoFarUsd: number; voiceUsd: number; transcribeUsd: number; stillsWorstCaseUsd: number; visualQaUsd: number; stockUsd: 0 };
}

/**
 * The whole downstream plan priced from the same `UNIT_PRICING` rows the
 * tools bill against, at the worst case (every beat a still when stills are
 * allowed, the dearer TTS vendor), on top of what the run has already spent.
 */
export function estimateOriginalShortCost(input: {
  spentSoFarUsd: number;
  narrationChars: number;
  beats: number;
  voiceover: boolean;
  stillsAllowed: boolean;
  visualQaRegistered: boolean;
  costCapUsd: number;
}): CostEstimate {
  const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
  const voiceUsd = input.voiceover ? input.narrationChars * unitPriceUsd("elevenlabs-tts-multilingual-v2") : 0;
  const transcribeUsd = input.voiceover ? (input.narrationChars / NARRATION_CHARS_PER_SECOND) * unitPriceUsd("elevenlabs-scribe") : 0;
  const stillsWorstCaseUsd = input.stillsAllowed ? input.beats * unitPriceUsd("gemini-2.5-flash-image") : 0;
  const visualQaUsd = input.visualQaRegistered ? VISUAL_QA_ESTIMATE_USD : 0;
  return {
    estimatedTotalUsd: round(input.spentSoFarUsd + voiceUsd + transcribeUsd + stillsWorstCaseUsd + visualQaUsd),
    costCapUsd: input.costCapUsd,
    breakdown: {
      spentSoFarUsd: round(input.spentSoFarUsd),
      voiceUsd: round(voiceUsd),
      transcribeUsd: round(transcribeUsd),
      stillsWorstCaseUsd: round(stillsWorstCaseUsd),
      visualQaUsd: round(visualQaUsd),
      stockUsd: 0,
    },
  };
}

/** The note the writer gets with a plan that priced over the ceiling: the numbers, the target, and the levers it actually has. */
export function budgetFeedbackFor(estimate: CostEstimate, targetUsd: number, beats: number, narrationWords: number): string {
  const b = estimate.breakdown;
  return (
    `The previous plan is priced at $${estimate.estimatedTotalUsd.toFixed(2)} against a $${estimate.costCapUsd.toFixed(2)} ceiling for this short ` +
    `(already spent on writing $${b.spentSoFarUsd.toFixed(2)}; voiceover $${b.voiceUsd.toFixed(2)}; up to $${b.stillsWorstCaseUsd.toFixed(2)} for a generated photograph on each of ${beats} beats the library cannot serve; QA $${b.visualQaUsd.toFixed(2)}). ` +
    `Re-plan so the whole short lands under $${targetUsd.toFixed(2)}: fewer beats (each beat is one library search and, at worst, one paid photograph), ` +
    `shorter narration (now ${narrationWords} words; the voice is billed per character), stock queries a library certainly holds (places, weather, ordinary objects, a texture) so no photograph is needed, ` +
    `and consider running silent with strong on-screen text. Keep the message; cut the cost.`
  );
}

/** The photograph brief the still tier sends to `image.generate`: the beat's scene, as a photograph, with the things that read as generated ruled out. */
export function stillBrief(visualBrief: string, allowPeople: boolean): string {
  return [
    visualBrief.trim().replace(/\s+/g, " "),
    "A documentary photograph, not an illustration or a render: natural light, real textures, ordinary lens, nothing glossy.",
    "No text, no signs, no logos, no screens with writing, no documents.",
    allowPeople ? "" : "No people.",
  ]
    .filter((s) => s.length > 0)
    .join(" ");
}

/**
 * A stock-library query derived from a `visualBrief`, for a script written
 * before beats carried `stockQuery` (prompt v3 and earlier): the brief's
 * first clause, minus camera and light words, first four content words.
 */
const BRIEF_FILLER = new Set([
  "a", "an", "the", "of", "on", "in", "at", "to", "from", "with", "and", "as", "by", "into", "across", "over", "through", "one", "single",
  "shot", "wide", "close", "tight", "static", "overhead", "slow", "push-in", "pull-back", "pan", "left", "right", "reveal", "drift", "handheld",
  "light", "lighting", "soft", "natural", "sidelight", "dusk", "dawn", "blue", "hour", "casting", "catching", "camera", "frame", "motion", "gently",
]);
export function stockQueryFromBrief(brief: string): string {
  const clause = brief.split(/[.,;:]/)[0] ?? brief;
  const words = clause
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !BRIEF_FILLER.has(w));
  const picked = words.slice(0, 4);
  return picked.length >= 2 ? picked.join(" ") : clause.trim().split(/\s+/).slice(0, 4).join(" ");
}

/** Lower-cased words only, for "is this the same line" comparisons between beats. */
function narrationKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .join(" ");
}

/**
 * The structural rules of a short that the schema cannot express, checked in
 * code after the model returns (2026-09-10, prep run pubsub-21157255126300088:
 * beats 1 and 2 carried the identical narration, and the hook the prompt
 * calls "beat 1" was in `hook` only, so the viewer heard the second line
 * first and then heard it again).
 *
 * `repaired` is the script with what code can fix fixed: when beat 1 does
 * not open on the hook, the hook becomes beat 1's narration (the prompt's own
 * rule, "beat 1 is the hook"; the hook is at most 200 characters so it fits
 * the narration cap). `issues` names what only a redraft can fix: two beats
 * saying the same thing.
 */
export function repairScriptStructure(script: ShortScript): { repaired: ShortScript; issues: string[] } {
  const issues: string[] = [];
  const beats = script.beats.map((b) => ({ ...b }));
  const hookKey = narrationKey(script.hook);
  if (beats[0] !== undefined && hookKey.length > 0 && !narrationKey(beats[0].narration).startsWith(hookKey.split(" ").slice(0, 6).join(" "))) {
    beats[0] = { ...beats[0], narration: script.hook };
  }
  const seen = new Map<string, number>();
  beats.forEach((beat, i) => {
    const key = narrationKey(beat.narration);
    const first = seen.get(key);
    if (first !== undefined) issues.push(`beats ${first + 1} and ${i + 1} have the same narration ("${beat.narration.slice(0, 60)}…"); each beat says one different thing`);
    else seen.set(key, i);
  });
  return { repaired: { ...script, beats }, issues };
}

/**
 * When a redraft still repeats a line, drop the later copy rather than ship
 * it twice: a three-beat floor stands (the schema's), so only a four- or
 * five-beat script can lose one. Returns the script unchanged otherwise.
 */
/** A spoken sentence longer than this is a paragraph, not a line; the prompt asks for twelve, code allows a little slack. */
export const MAX_SPOKEN_SENTENCE_WORDS = 14;
/** The hook is set large on screen for two seconds; past this it does not fit and does not land. */
export const MAX_HOOK_WORDS = 14;

/**
 * The phrases that make a short sound like a slide read aloud. The prompt
 * bans them; this is the check that makes the ban real. Matched on the
 * spoken and on-screen words only, never the caption or about.
 */
const CORPORATE_CADENCE: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bleverag(e|es|ed|ing)\b/i, label: "leverage" },
  { pattern: /\bat scale\b/i, label: "at scale" },
  { pattern: /\bhere'?s the thing\b/i, label: "here's the thing" },
  { pattern: /\bthe (real|actual) (question|problem|issue|risk|answer|story) is\b/i, label: "the real X is" },
  { pattern: /\bthe question is\b/i, label: "the question is" },
  { pattern: /\bstrateg(y|ic) (layer|oversight|imperative)\b/i, label: "strategy layer / strategic oversight" },
  { pattern: /\bunlock(s|ed|ing)?\b/i, label: "unlock" },
  { pattern: /\bgame[- ]?changer\b/i, label: "game-changer" },
  { pattern: /\bin today'?s\b/i, label: "in today's" },
  { pattern: /\becosystem\b/i, label: "ecosystem" },
  { pattern: /\bsynerg(y|ies|istic)\b/i, label: "synergy" },
  { pattern: /\bcutting[- ]edge\b/i, label: "cutting-edge" },
  { pattern: /\bseamless(ly)?\b/i, label: "seamless" },
  { pattern: /\bempower(s|ed|ing)?\b/i, label: "empower" },
  { pattern: /\bholistic\b/i, label: "holistic" },
  { pattern: /\bparadigm\b/i, label: "paradigm" },
  { pattern: /\bbest[- ]in[- ]class\b/i, label: "best-in-class" },
  { pattern: /\bthought leader(ship)?\b/i, label: "thought leadership" },
  { pattern: /\bdelve\b/i, label: "delve" },
  { pattern: /\bnavigat(e|es|ing) the\b/i, label: "navigate the …" },
  { pattern: /\bstakeholders?\b/i, label: "stakeholders" },
];

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * What only the writer can fix about how a short SOUNDS (2026-09-10): a
 * hook too long to be set large on screen, a spoken sentence that runs past
 * a breath, a phrase from the conference-slide register. The prompt states
 * every one of these rules; the 2026-09-08 scripts broke all three ("That is
 * a strategy problem. Not a software problem." after a 27-word sentence), so
 * the rules are checked here and handed back once, named, before the render.
 */
export function scriptVoiceIssues(script: ShortScript): string[] {
  const issues: string[] = [];
  if (wordCount(script.hook) > MAX_HOOK_WORDS) {
    issues.push(`the hook is ${wordCount(script.hook)} words; it is set large on screen for two seconds and must be ${MAX_HOOK_WORDS} or fewer`);
  }
  script.beats.forEach((beat, i) => {
    for (const sentence of beat.narration.split(/(?<=[.!?…])\s+/)) {
      const n = wordCount(sentence);
      if (n > MAX_SPOKEN_SENTENCE_WORDS) issues.push(`beat ${i + 1} has a ${n}-word sentence ("${sentence.trim().slice(0, 50)}…"); one breath each, ${MAX_SPOKEN_SENTENCE_WORDS} words or fewer`);
    }
  });
  const spoken = [script.hook, ...script.beats.flatMap((b) => [b.narration, b.onScreenText])].join("\n");
  const heard = CORPORATE_CADENCE.filter((c) => c.pattern.test(spoken)).map((c) => c.label);
  if (heard.length > 0) issues.push(`corporate cadence a viewer scrolls past: ${heard.join(", ")}; say it the way you would across a table`);
  return issues;
}

/** A place word this many beats share means the short is one room. Three of four (prep run pubsub-21156942503403946) is the case that prompted it. */
export const SAME_PLACE_BEATS = 3;

/** Words in a stock query that say how a place is lit or framed, not which place it is. */
const QUERY_FRAMING_WORDS = new Set([
  "empty", "close", "closeup", "up", "wide", "shot", "view", "angle", "interior", "exterior", "light", "glow", "dark", "night", "morning", "dusk", "dawn", "evening", "afternoon", "day", "sunset", "sunrise", "rain", "window", "ceiling", "wall", "floor", "receding", "overhead", "slow", "still", "detail", "texture", "background", "blind", "blinds",
  "a", "an", "and", "the", "of", "on", "in", "at", "with", "from", "by",
]);

/**
 * The beats whose stock queries put the short in one place (2026-09-10).
 * Prep run pubsub-21156942503403946 asked the library for "empty office desk
 * night monitor glow", "empty office chair desk morning window blind",
 * "analog clock wall office close" and "empty office corridor fluorescent
 * ceiling receding": four beats, one room, a viewer's thumb already moving.
 * The prompt asks for a different place per beat; this is the check that
 * makes the rule real, handed back once with the voice issues.
 */
export function shotVarietyIssues(script: ShortScript): string[] {
  if (script.format === "text-led") return [];
  const perBeat = script.beats.map((b) => new Set((b.stockQuery ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !QUERY_FRAMING_WORDS.has(w))));
  const counts = new Map<string, number>();
  for (const words of perBeat) for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  const shared = [...counts.entries()].filter(([, n]) => n >= SAME_PLACE_BEATS).sort((a, b) => b[1] - a[1]);
  if (shared.length === 0) return [];
  const [word, n] = shared[0]!;
  return [`${n} of ${script.beats.length} shots are set in the same place ("${word}"); give each beat its own place: an office, then a street, a kitchen, a workshop, a car`];
}

/** Words a reviewer uses about the PICTURE. English and Hebrew, since both are typed at the gate. */
const FOOTAGE_WORDS = /\b(footage|shot|shots|clip|clips|plate|plates|b-?roll|visual|visuals|video|image|picture|stock|scene)\b|פוטג|שוט|קליפ|תמונ|וידאו|ויזואל|סצנ/i;
/** Words a reviewer uses about the WORDS, the voice or the music: any of these and the writer has to hear the note. "line" is deliberately absent: "the clip does not fit the line" is the commonest footage note there is. */
const WORDING_WORDS = /\b(script|word|words|say|says|said|wording|phrase|sentence|hook|caption|about|narration|voice|voiceover|tone|shorter|longer|rewrite|rewritten|copy|text|title|music)\b|טקסט|מיל|משפט|סקריפט|כתובי|קול|קריינות|הוק|נוסח|מוזיק/i;

/**
 * Whether a reviewer's note is about the footage and nothing else (2026-09-10).
 * "Beat 2's clip does not fit" is; "swap the clip and shorten the hook" is
 * not, because the writer has to hear the second half.
 */
export function isFootageOnlyFeedback(feedback: string): boolean {
  return FOOTAGE_WORDS.test(feedback) && !WORDING_WORDS.test(feedback);
}

/** The beats a note points at ("beat 2", "shot 3", "ביט 2"), 1-based, in the order named, deduplicated. Empty when it names none. */
export function beatsNamedIn(feedback: string): number[] {
  const out: number[] = [];
  for (const m of feedback.matchAll(/\b(?:beat|shot)\s*#?(\d{1,2})\b|ביט\s*(\d{1,2})/gi)) {
    const n = Number(m[1] ?? m[2]);
    if (n >= 1 && n <= 8 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** The calls to action a short is not allowed to make unless the run asked for one. Spoken and on-screen words only. */
const PITCH_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(book|schedule|grab) a (call|demo|meeting|slot)\b/i, label: "book a call" },
  { pattern: /\b(dm|message|email) (us|me)\b/i, label: "DM us" },
  { pattern: /\blink in (my |our |the )?bio\b/i, label: "link in bio" },
  { pattern: /\b(sign up|get started|contact us|reach out|get in touch)\b/i, label: "sign up / contact us" },
  { pattern: /\bfollow (us|me|for more)\b/i, label: "follow us" },
  { pattern: /\b[a-z0-9-]+\.(com|io|co|ai|net|org)\b/i, label: "a website address" },
  { pattern: /\bthat'?s (what|how) we do\b/i, label: "that's what we do" },
];
/** A last beat that talks about what the client offers is a sales beat however softly it is put. */
const LAST_BEAT_WE_SELL = /\b(we|our team) (can|will|help|show|build|give|offer|do|make|take care of)\b/i;
/** A run that asked for a call to action lifts the rule. */
const CTA_REQUESTED = /call to action|\bcta\b|קריאה לפעולה/i;

/**
 * The pitch the prompt bans (2026-09-10): every 2026-09-08 script ended on
 * one, and prep run pubsub-21157235573121560's last beat was "We show you the
 * plan before anything else." A website address or a "book a call" anywhere,
 * or a last beat about what the client offers, goes back to the writer once
 * with the beat named, unless the run's own direction asked for a call to
 * action. The caption is exempt: the client's hashtag and URL convention
 * lives there by design.
 */
export function salesPitchIssues(script: ShortScript, direction: string | undefined): string[] {
  if (direction !== undefined && CTA_REQUESTED.test(direction)) return [];
  const issues: string[] = [];
  script.beats.forEach((beat, i) => {
    const spoken = `${beat.narration}\n${beat.onScreenText}`;
    const hit = PITCH_PATTERNS.find((p) => p.pattern.test(spoken));
    if (hit !== undefined) issues.push(`beat ${i + 1} pitches (${hit.label}); the short lands an idea, it does not sell`);
    else if (i === script.beats.length - 1 && LAST_BEAT_WE_SELL.test(spoken)) {
      issues.push(`the last beat sells ("${beat.narration.slice(0, 60)}…"); land what the viewer should think or do, not what the client offers`);
    }
  });
  return issues;
}

export function dropRepeatedBeats(script: ShortScript): ShortScript {
  const seen = new Set<string>();
  const kept = script.beats.filter((b) => {
    const key = narrationKey(b.narration);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return kept.length >= 3 && kept.length < script.beats.length ? { ...script, beats: kept } : script;
}

export function normalizeScriptDashes(script: ShortScript): ShortScript {
  return {
    ...script,
    hook: normalizeBannedDashes(script.hook),
    caption: normalizeBannedDashes(script.caption),
    about: normalizeBannedDashes(script.about),
    beats: script.beats.map((beat) => ({
      ...beat,
      narration: normalizeBannedDashes(beat.narration),
      onScreenText: normalizeBannedDashes(beat.onScreenText),
    })),
  };
}

/** `sourceCredit` is normalised with the caption it must appear in, so the 07-compliance containment check compares like with like. */
export function normalizeCommentaryDashes(commentary: Commentary): Commentary {
  return {
    caption: normalizeBannedDashes(commentary.caption),
    about: normalizeBannedDashes(commentary.about),
    sourceCredit: normalizeBannedDashes(commentary.sourceCredit),
  };
}

/** Every plate a generated short is built from stays on screen at least this long — under it a cut reads as a glitch. */
const MIN_PLATE_HOLD_SECONDS = 2;

/** The brand furniture the framed clip carries — every field beyond the two grounds optional, skipped when absent. */
interface VideoBrand {
  ground: string;
  fg: string;
  accent?: string;
  handle?: string;
  seriesHeader?: string;
  logoUrl?: string;
  /** The brand kit's stated content language, when it states one — the default voiceover/caption language. */
  language?: string;
}

async function callTool(tools: AgentToolRegistry, name: string, args: unknown, ctx: AgentContext): Promise<unknown> {
  const tool = tools[name];
  if (!tool) throw new WorkflowToolingFailure(`no tool registered as "${name}"`);
  const outcome = await tool.execute(args, { ctx });
  if (outcome.status !== "success") throw new WorkflowToolingFailure(`"${name}" call failed: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
  return outcome.result;
}

/** A gate's verdict. A broken gate is a tooling failure, never a content verdict. */
async function runGate(tools: AgentToolRegistry, name: string, args: unknown, ctx: AgentContext): Promise<GateVerdict> {
  return (await callTool(tools, name, args, ctx)) as GateVerdict;
}

/** Reads `key` off a loose record as a trimmed non-empty string, or nothing. */
function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Reads `key` off a loose record as an array of non-empty strings, or []. */
function readStringList(record: Record<string, unknown> | undefined, key: string): string[] {
  const value = record?.[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim()) : [];
}

/** The same trim-and-lowercase the topic catalog keys on, so "same topic" here means what it means there. */
function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Above this share of a candidate's word-trigrams already sitting inside ONE
 * published post, the candidate is a repeat. Containment rather than Jaccard
 * for this one check, on purpose: `evaluateDedupe`'s Jaccard is calibrated
 * for two DELIVERABLES of similar length, and a three-line topic candidate
 * against a full caption never clears 0.4 even when every word of it is in
 * there — the union is dominated by the caption. Asking "how much of the
 * candidate is already published" is the question actually being asked.
 */
const CANDIDATE_CONTAINMENT_THRESHOLD = 0.6;

/**
 * The angles this week's research is pulled from, one per discovery run,
 * rotating with the size of the lane (2026-09-09). Under a single fixed
 * query ("what is being debated this week") prep's scout read the same eight
 * documents on every run for two days and proposed the same seven
 * candidates. A different lens returns different documents, and a different
 * pillar each time keeps a multi-pillar client from living in one of them.
 */
export const DISCOVERY_LENSES = [
  "what is being debated this week",
  "the numbers, reports and studies published this week",
  "what buyers and practitioners are asking and complaining about right now",
  "regulation, platform and policy changes this week",
  "myths and received wisdom being challenged this week",
  "case studies and real results published this week",
] as const;

const TOPIC_STOP_WORDS = new Set([
  "the", "a", "an", "of", "for", "to", "in", "on", "and", "or", "is", "are", "was", "were", "has", "have", "been", "will", "your", "you", "their", "our", "we", "they",
  "why", "what", "how", "not", "now", "this", "that", "it", "its", "with", "as", "at", "by", "from", "be", "new", "just", "more", "most", "into", "about",
]);

/** Salient word tokens of a catalog-row-sized string, for near-duplicate detection between topics. */
function topicTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !TOPIC_STOP_WORDS.has(w)),
  );
}

/**
 * Whether two topic rows are the same idea in different words: enough
 * salient words in common that a viewer would call it the same short.
 * "The rise of Generative Engine Optimization as a new marketing discipline"
 * and "Introducing Generative Engine Optimization (GEO)" share three salient
 * words and most of the shorter one; "AI marketing budget cuts" and "AI
 * marketing ethics" share two and are different subjects. Exported for the test.
 */
export function nearDuplicateTopic(a: string, b: string): boolean {
  const ta = topicTokens(a);
  const tb = topicTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  const union = ta.size + tb.size - shared;
  const containment = shared / Math.min(ta.size, tb.size);
  return shared / union >= 0.6 || (shared >= 3 && containment >= 0.6) || (shared >= 4 && containment >= 0.5);
}

/** True when `text` is mostly already inside one of the client's published excerpts. */
function repeatsPublished(text: string, history: readonly { excerpt: string }[]): boolean {
  const own = shingles(text);
  if (own.size === 0) return false;
  for (const entry of history) {
    const published = shingles(entry.excerpt);
    let contained = 0;
    for (const shingle of own) if (published.has(shingle)) contained++;
    if (contained / own.size >= CANDIDATE_CONTAINMENT_THRESHOLD) return true;
  }
  return false;
}

/** Shows/channels the harvest tier may search — the sourcePool minus the entries that are footage URIs. */
function plainSourceNames(config: TikTokClipConfig): string[] {
  return config.sourcePool.filter((entry) => !/^(gs|https?):\/\//i.test(entry));
}

/**
 * `tiktok-agent` — the short-video system: podcast/commentary clips (the
 * product migrated from `karos-tiktok-agent` in the lab repo) and, when there
 * is nothing to clip, an original scripted short.
 *
 * ## What the run does, in order
 *
 *     INTAKE -> SEED -> CLAIM-topic -> FIND-source ->
 *       (footage)  TRANSCRIBE -> PICK-moment -> CUT -> COMPOSE-commentary -> RENDER
 *       (nothing)  SCRIPT -> ESTIMATE-cost -> FIND-plates (stock, else a still) -> VOICE -> RENDER
 *     -> QA -> [approve] -> QUEUE -> LOG
 *
 * One run, one clip — the same unit every other migrated channel agent uses.
 * The per-client settings live in the client's config (`TikTokClipConfigSchema`),
 * so the same code serves every client and the thing that varies is data.
 *
 * ## Where the topic comes from — the smart order
 *
 * 1. A topic the client typed for this run (`requestedTopic`, or a
 *    `customPrompt` that reads as a topic) wins over everything.
 * 2. The catalog lane, seeded from the client's own `guestWatchlist`. This is
 *    the dedup lock: a reserved row is committed only when a clip ships.
 * 3. FOOTAGE THE CLIENT ATTACHED. When a recording was handed to us and the
 *    catalog has nothing to say, the run does not hold — the topic is whatever
 *    the moment step finds in that footage (`topicLabel`), because a client who
 *    uploaded an episode wants a clip from it, not a lecture about their
 *    catalog. The catalog stays advisory for this case: a reserved guest name,
 *    when there is one, steers the moment picker but never forces it.
 * 4. DISCOVERY. No direction, no footage, empty lane: `research.pull` fetches
 *    what the client's field is talking about this week, the scout proposes
 *    6-10 grounded candidates, the dedupe filter drops anything close to what
 *    the client recently published, the survivors seed the lane through
 *    `topics.topUp`, and the run reserves one. From then on the lane has real
 *    rows and the dedup lock works exactly as for a hand-seeded catalog.
 * 5. Only when every one of those is dry does the run hold — naming what it
 *    tried.
 *
 * ## Where the footage comes from — the tiered cascade
 *
 * Attached upload -> the client's own footage URIs in `sourcePool` -> a web
 * harvest restricted to the shows named in `sourcePool` (never the open web)
 * -> an original short over STOCK footage, a generated still for a beat no
 * library has. Generated video is not a tier (2026-09-09): a short must cost
 * under two dollars, and one Veo plate cost more than that. `mode:
 * "commentary"` stops before the original short and holds; `mode: "original"`
 * never touches anyone else's footage.
 *
 * ## What it may cost
 *
 * `MAX_RUN_COST_USD` ($2), or the client's lower `maxRunCostUsd`. Never a
 * failure the client meets: `03v-estimate-cost` prices the whole plan before
 * the first plate is bought, a plan over the ceiling goes back to the writer
 * with the numbers (up to `MAX_BUDGET_REPLANS` times), and after that a
 * deterministic rule buys nothing more (stock only, then silent). At the
 * ceiling mid-run a still, the voice and the QA call are skipped, not bought.
 * The dispatcher's `WorkflowBudget` is the engine-level backstop under all of it.
 *
 * ## Where the judgment is
 *
 * Bounded, schema-out model steps, each with a prompt in the store: which
 * moment to clip (Gemini 2.5 Pro — the whole episode has to fit), what to
 * make when nothing was given (scout, Gemini 2.5 Pro), what to say (script /
 * commentary, Claude Sonnet — client voice), and whether the finished clip
 * looks like something a person would post (`video.visualQaGate`, Gemini 2.5
 * Flash watching the MP4). Everything else — reservation, cut bounds, timing,
 * render, the deterministic gates — is code, and a model's timestamps are
 * validated against the transcript rather than trusted.
 *
 * ## Dedup
 *
 * `topics.reserve`/`commit`/`release` IS the legacy catalog: the forward
 * pipeline of candidates and the hard dedup gate in one. A run that fails
 * releases its reservation, so a topic is never burned by a run that shipped
 * nothing. A run PAUSED at the review gate has not failed and keeps its
 * reservation — see the catch around the review cycle. The text-level half is
 * `checkOutputDedupe` against the shipped-output excerpt window.
 *
 * ## Review
 *
 * The `[approve]` step is `runReviewCycle`, the same approve / revise / reject
 * loop every other migrated agent uses. `revise` re-writes the words with the
 * reviewer's note in hand and re-renders the clip around them, in-run: the
 * transcript, the moment, the cut bounds, the generated plates and the brand
 * keep their step ids and are reused, so a revision costs a drafting call and
 * a render rather than a second run's worth of footage.
 */
/**
 * Downloads an attached source video and returns an absolute path to it.
 *
 * Absolute, not repo-relative: the video tools resolve a path against the
 * process cwd, which is the server's, not the agent workspace's. Every other
 * consumer of `media.ingestAssets` renders inside the repo and wants the
 * relative form, so the join happens here rather than in the tool.
 *
 * A failure here is `WorkflowBlockedIntake`, not a tooling error: the run was
 * given footage it cannot read, which is a fact about the input.
 */
async function ingestSourceVideo(
  attached: { uri: string; label?: string | undefined },
  options: CreateTikTokAgentWorkflowOptions,
  tools: AgentToolRegistry,
  runId: string,
  ctx: AgentContext,
): Promise<string> {
  const ingest = tools["media.ingestAssets"];
  if (options.repoRoot === undefined || ingest === undefined) {
    throw new WorkflowBlockedIntake(
      "this run attached a source video, but this deployment cannot ingest one " +
        `(${options.repoRoot === undefined ? "no repoRoot configured" : "media.ingestAssets is not registered"}) — ` +
        "dispatch with a sourcePath the video tools can read instead",
    );
  }

  const outcome = await ingest.execute(
    {
      repoRoot: options.repoRoot,
      runId,
      kind: "video",
      assets: [{ uri: attached.uri, ...(attached.label ? { label: attached.label } : {}), slot: 1 }],
    },
    { ctx },
  );
  if (outcome.status !== "success") {
    throw new WorkflowBlockedIntake(
      `the attached source video could not be ingested (${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""})`,
    );
  }
  const first = (outcome.result as { candidates: Array<{ path: string }> }).candidates[0];
  if (first === undefined) {
    throw new WorkflowBlockedIntake("the attached source video could not be ingested — no file was written");
  }
  return path.resolve(options.repoRoot, first.path);
}

export function createTikTokAgentWorkflow(options: CreateTikTokAgentWorkflowOptions) {
  const tools = options.tools;

  return async function tiktokAgentWorkflow(wf: WorkflowContext): Promise<TikTokAgentWorkflowResult> {
    const ctx = toAgentContext(wf);
    const runInput = (wf.input ?? {}) as Record<string, unknown>;

    // The run-scoped brief someone filled in on the portal — the typed
    // direction, the structured intake fields, and any attached media —
    // resolved once, the same way every other agent resolves it.
    const runDirection = readRunDirection(wf.input);

    // ── 00: INTAKE — the client's clip settings, or the defaults ──
    //
    // `forbiddenTopics` comes out of the SAME read as the clip settings, so
    // the terminal guardrail below needs no second one.
    //
    // A client with no `tiktokClips` block used to be refused at intake. That
    // rule protected one decision — which shows the client may clip — and it
    // still does: `sourcePool` defaults to empty, so a client who configured
    // nothing can never have anyone else's footage clipped on their behalf.
    // What they CAN have is an original short, which needs no rights decision
    // at all. A `tiktokClips` block that IS present but does not parse is
    // still a blocked intake: someone wrote settings and got them wrong, and
    // guessing at what they meant is not this agent's call.
    const intakeConfig = await wf.step.code(
      "00-intake",
      async (): Promise<{ config: TikTokClipConfig; forbiddenTopics: string[]; contentPillars: string[]; configured: boolean }> => {
        const outcome = await tools["client.getConfig"]?.execute({}, { ctx });
        const raw = (outcome?.status === "success" ? outcome.result : {}) as Record<string, unknown>;
        const block = raw["tiktokClips"];
        if (block === undefined || block === null) {
          return { config: DEFAULT_CLIP_CONFIG, forbiddenTopics: readForbiddenTopics(raw), contentPillars: readStringList(raw, "contentPillars"), configured: false };
        }
        const parsed = TikTokClipConfigSchema.safeParse(block);
        if (!parsed.success) {
          throw new WorkflowBlockedIntake(`client's tiktokClips config does not parse: ${parsed.error.message}`);
        }
        return { config: parsed.data, forbiddenTopics: readForbiddenTopics(raw), contentPillars: readStringList(raw, "contentPillars"), configured: true };
      },
    );
    const config: TikTokClipConfig = intakeConfig.config;
    const forbiddenTopics: readonly string[] = intakeConfig.forbiddenTopics;

    // ── 00a: who the client is — the discovery step's grounding, and the
    //        script step's sense of what world its b-roll belongs to.
    //        Best-effort: a missing profile narrows what discovery can do, it
    //        does not stop a run that has footage. ──
    const profile = await wf.step.code("00a-read-profile", async (): Promise<{ name?: string; industry?: string; description?: string }> => {
      const outcome = await tools["client.getProfile"]?.execute({}, { ctx });
      const raw = (outcome?.status === "success" ? outcome.result : {}) as Record<string, unknown>;
      const name = readString(raw, "name");
      const industry = readString(raw, "industry");
      const description = readString(raw, "description");
      return { ...(name ? { name } : {}), ...(industry ? { industry } : {}), ...(description ? { description } : {}) };
    });

    // ── 00b: seed the commentary-clip lane from the client's own guest
    // watchlist, before this run's own reservation ever touches it ──
    //
    // `guestWatchlist` is, per this agent's own config contract, "the
    // highest-yield discovery signal", a real name the client themselves gave
    // us. Seeding the catalog from it is exactly as honest as instagram
    // seeding from real research titles, and just as clearly not invention.
    // Never fails the run: no watchlist, or a `topics.topUp` this deployment
    // never registered, degrades to a note.
    //
    // Unconditional every run, with no "is the catalog already healthy" gate:
    // `topics.topUp` is idempotent per normalized topic, so re-seeding is a
    // no-op write once every name is in — and a whole-catalog size check
    // would be the wrong signal regardless, because `catalogSize` counts rows
    // across every lane a client has, keyed only by `clientSlug`, so a client
    // who also runs another channel agent would look "healthy" while THIS
    // lane sits at zero.
    await wf.step.code("00b-seed-catalog", async () => {
      const topUp = tools["topics.topUp"];
      if (topUp === undefined) {
        return { seeded: 0, notes: ["topics.topUp is not registered; nothing to seed the commentary-clip lane with"] };
      }
      if (config.guestWatchlist.length === 0) {
        return { seeded: 0, notes: ["client's guestWatchlist is empty; nothing to seed the commentary-clip lane with from config"] };
      }

      const seeded = await topUp.execute({ topics: config.guestWatchlist, lane: CLIP_LANE }, { ctx });
      if (seeded.status !== "success") {
        return { seeded: 0, notes: [`seeding the commentary-clip lane failed: ${seeded.status}`] };
      }
      const { added, catalogSize } = seeded.result as { added: number; catalogSize: number };
      return { seeded: added, notes: [`${added} new name(s) from the client's guestWatchlist landed in the ${CLIP_LANE} lane (catalog now ${catalogSize} row(s) across all lanes)`] };
    });

    // The anti-repetition read (the excerpt window step 13 writes back into),
    // the client intel report distilled, and what this client asked for on
    // PREVIOUS runs. Read ONCE, up here, because discovery needs the first two
    // as much as drafting does: a scout that cannot see what the client just
    // published proposes it again.
    const outputHistory = await readOutputHistoryForDedup(wf, tools, ctx, "tiktok-agent", "read-output-history");
    const recentPostsDirective = dedupeDirective(outputHistory);
    const clientIntelContext = await readClientIntelContext(wf, tools, ctx, "read-intel-context");
    const pastFeedback = await readPastFeedback(wf, tools, ctx, "read-past-feedback");

    // ── 03r: the client's own documents, read ONCE for the writer ──
    //
    // Until 2026-09-10 the script agent fetched these itself, three model
    // turns before the one that wrote: the dominant cost and the longest
    // wait in every prep run. Read here, best-effort each (a client with no
    // voice rules yet gets a writer who simply has none, not a held run), and
    // handed to the script step as input. Every `client.*` read is a
    // workspace read, so the whole step costs nothing.
    const clientVoice = await wf.step.code("03r-read-client-voice", async (): Promise<{ voiceRules?: unknown; brand?: unknown; strategy?: unknown }> => {
      const read = async (name: string): Promise<unknown> => {
        const tool = tools[name];
        if (tool === undefined) return undefined;
        try {
          const outcome = await tool.execute({}, { ctx });
          return outcome.status === "success" ? outcome.result : undefined;
        } catch {
          return undefined;
        }
      };
      const [voiceRules, brand, strategy] = await Promise.all([read("client.getVoiceRules"), read("client.getBrand"), read("client.getStrategy")]);
      const strategyMarkdown = strategy !== null && typeof strategy === "object" && typeof (strategy as { markdown?: unknown }).markdown === "string" ? (strategy as { markdown: string }).markdown.trim() : "";
      return {
        ...(voiceRules !== undefined ? { voiceRules } : {}),
        ...(brand !== undefined ? { brand } : {}),
        ...(strategyMarkdown.length > 0 ? { strategy: strategyMarkdown } : {}),
      };
    });

    // Footage the client handed us, in either form the portal and a hand
    // dispatch use. Decided before the topic claim because it changes what an
    // empty catalog MEANS: with footage in hand it is a missing hint, without
    // it is a missing subject.
    const attached = firstAsset(runDirection.mediaAssets, "source");
    const explicitSourcePath = typeof runInput.sourcePath === "string" && runInput.sourcePath.trim().length > 0 ? runInput.sourcePath.trim() : undefined;
    const footageProvided = attached !== undefined || explicitSourcePath !== undefined;

    // ── 01a: "Only media I upload for this job" (RunDirection.mediaSource) ──
    //
    // With footage in hand the user-asset tier below wins and nothing else is
    // touched, exactly as before. Without it there is nothing this run may
    // clip: the owned-footage, web-harvest and generated tiers are all
    // sourcing, and a video has no typographic fallback. Refused here, before
    // the topic claim spends a reservation or a model call.
    await wf.step.code("01a-check-media-source", () => {
      if (runDirection.mediaSource === "client" && !footageProvided) {
        throw new WorkflowBlockedIntake(
          "this run was set to client-provided media only, but no source video was attached — attach the episode to clip, or let the agent find or generate footage",
        );
      }
      return { mediaSource: runDirection.mediaSource, footageProvided };
    });

    interface TopicClaim {
      topic: string;
      topicSource: TopicSource;
      reservationKey?: string;
      discovered?: TopicCandidate;
    }

    /** One catalog reservation attempt. `undefined` is the honest "nothing available" — every other non-success is a tooling failure. */
    const tryReserve = async (): Promise<{ topic: string; reservationKey: string } | undefined> => {
      const tool = tools["topics.reserve"];
      if (!tool) throw new WorkflowToolingFailure(`no tool registered as "topics.reserve"`);
      const outcome = await tool.execute(
        { reservationKey: `${wf.runId}__clip`, count: 1, excludeTopics: config.narrowing, lane: CLIP_LANE },
        { ctx },
      );
      if (outcome.status === "content_fail") return undefined;
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`topics.reserve failed: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
      const result = outcome.result as { reservationKey: string; topics: string[] };
      const topic = result.topics[0];
      if (!topic) return undefined;
      return { topic, reservationKey: result.reservationKey };
    };

    /**
     * 01c/01d — DISCOVERY: what should this client make, when nobody said.
     *
     * Research first, in code, cached and freshness-enforced; then the scout,
     * which may only cite what that research returned; then a dedupe pass
     * against the shipped-output window; then the survivors seed the lane.
     * Every shortfall is a recorded note, and an empty result is an honest
     * outcome the caller turns into a hold — never a fabricated candidate.
     */
    const discoverTopics = async (): Promise<{ candidates: TopicCandidate[]; seeded: number; notes: string[] }> => {
      return wf.step.code("01c-discover-topics", async () => {
        const notes: string[] = [];
        const topUp = tools["topics.topUp"];
        if (topUp === undefined) {
          return { candidates: [], seeded: 0, notes: ["topics.topUp is not registered; discovered topics would have nowhere to land"] };
        }

        // What the lane already holds — made, waiting, or proposed before —
        // read first: it rotates the research lens and pillar, goes to the
        // scout as a hard do-not-repeat, and drops what comes back anyway.
        const alreadyInCatalog: string[] = await (async () => {
          const list = tools["topics.list"];
          if (list === undefined) return [];
          const outcome = await list.execute({ lane: CLIP_LANE }, { ctx });
          if (outcome.status !== "success") return [];
          return (outcome.result as { rows: Array<{ topic: string }> }).rows.map((r) => r.topic);
        })();
        const rotation = alreadyInCatalog.length;
        const researchLens = DISCOVERY_LENSES[rotation % DISCOVERY_LENSES.length]!;

        interface ResearchDoc {
          title: string;
          url: string;
          description?: string;
          content?: string;
        }
        let researchDocuments: ResearchDoc[] = [];
        const research = tools["research.pull"];
        if (research === undefined) {
          notes.push("research.pull is not registered, so discovery ran on the client's own documents only");
        } else if (profile.industry === undefined) {
          notes.push("client profile declares no industry, so there was no honest research query to run");
        } else {
          // One pillar per discovery, rotating, rather than all of them in one
          // query: a search engine answers "A, B, C, D this week" with the
          // same generic A-and-B page every time.
          const pillars = intakeConfig.contentPillars;
          const pillar = pillars.length > 0 ? pillars[rotation % pillars.length]! : undefined;
          const query = pillar !== undefined ? `${profile.industry}: ${pillar} — ${researchLens}` : `${profile.industry} — ${researchLens}`;
          const pulled = await research.execute(
            { job: "tiktok-topic-discovery", query, window: "24h", maxResults: 8, historyAgentId: "tiktok-agent" },
            { ctx },
          );
          if (pulled.status !== "success") {
            notes.push(`research for discovery was unusable (${pulled.status}${"reason" in pulled ? `: ${pulled.reason}` : ""})`);
          } else {
            const payload = (pulled.result as { result?: { documents?: Array<{ title?: string; url?: string; description?: string; content?: string }> } }).result;
            researchDocuments = (payload?.documents ?? [])
              .filter((d): d is { title: string; url: string; description?: string; content?: string } => typeof d.title === "string" && d.title.trim().length > 0 && typeof d.url === "string" && d.url.length > 0)
              .map((d) => ({
                title: d.title.trim(),
                url: d.url,
                ...(d.description ? { description: d.description.slice(0, 400) } : {}),
                ...(d.content ? { content: d.content.slice(0, 1200) } : {}),
              }));
            notes.push(`research returned ${researchDocuments.length} document(s) for "${query}"`);
          }
        }

        if (researchDocuments.length === 0 && clientIntelContext === undefined) {
          notes.push("no research documents and no client intel — nothing honest to discover topics from");
          return { candidates: [], seeded: 0, notes };
        }

        const scout = new TikTokTopicScoutAgent({ router: options.router, tools, promptStore: options.promptStore });
        const exec = await wf.step.agent("01d-topic-scout", scout, {
          ...runDirectionField(runDirection),
          clientProfile: profile,
          ...(intakeConfig.contentPillars.length > 0 ? { contentPillars: intakeConfig.contentPillars } : {}),
          ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
          researchDocuments,
          ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
          ...(plainSourceNames(config).length > 0 ? { sourcePool: plainSourceNames(config) } : {}),
          ...(alreadyInCatalog.length > 0 ? { alreadyInCatalog: alreadyInCatalog.slice(-40) } : {}),
          researchLens,
          mode: config.mode,
        });
        if (exec.status === "content_fail") {
          notes.push("the topic scout did not clear its own output validation");
          return { candidates: [], seeded: 0, notes };
        }
        if (exec.status !== "completed") {
          throw new WorkflowToolingFailure(`topic discovery resolved to "${exec.status}"`);
        }
        const proposed = TopicScoutOutputSchema.parse(exec.finalOutput);

        // The evidence rule, enforced in code: a URL the research did not
        // return is not evidence, whatever the model says it is.
        const knownUrls = new Set(researchDocuments.map((d) => d.url));
        const excluded = new Set(config.narrowing.map(normalizeTopic));
        const candidates: TopicCandidate[] = [];
        let droppedAsRepeats = 0;
        let droppedAsCatalogRepeats = 0;
        for (const raw of proposed.candidates) {
          const candidate: TopicCandidate = { ...raw, evidenceUrls: raw.evidenceUrls.filter((u) => knownUrls.has(u)) };
          if (excluded.has(normalizeTopic(candidate.topic))) continue;
          // The same idea in new words is the same row. `topics.topUp` only
          // knows the exact string, so this is where a re-proposed topic is
          // caught — against the lane AND against what this run already kept.
          if ([...alreadyInCatalog, ...candidates.map((c) => c.topic)].some((existing) => nearDuplicateTopic(candidate.topic, existing))) {
            droppedAsCatalogRepeats += 1;
            continue;
          }
          // Two reads of "is this a repeat": the fleet's calibrated Jaccard
          // verdict, and a containment check sized for a short candidate
          // against a long caption (see `repeatsPublished`). Either drops it.
          const candidateText = `${candidate.topic}\n${candidate.angle}\n${candidate.hook}`;
          const verdict = evaluateDedupe(candidateText, outputHistory);
          if (verdict.status === "similar" || repeatsPublished(candidateText, outputHistory)) {
            droppedAsRepeats += 1;
            continue;
          }
          candidates.push(candidate);
        }
        if (droppedAsRepeats > 0) notes.push(`${droppedAsRepeats} candidate(s) dropped as too close to what the client recently published`);
        if (droppedAsCatalogRepeats > 0) notes.push(`${droppedAsCatalogRepeats} candidate(s) dropped as the same idea as a topic already in the lane`);
        notes.push(`research lens: ${researchLens}`);
        if (candidates.length === 0) {
          notes.push("every proposed candidate was excluded or a repeat");
          return { candidates: [], seeded: 0, notes };
        }

        const seeded = await topUp.execute({ topics: candidates.map((c) => c.topic), lane: CLIP_LANE }, { ctx });
        if (seeded.status !== "success") {
          notes.push(`seeding the lane with discovered topics failed: ${seeded.status}`);
          return { candidates, seeded: 0, notes };
        }
        const { added } = seeded.result as { added: number; catalogSize: number };
        notes.push(`${added} discovered topic(s) landed in the ${CLIP_LANE} lane (${proposed.rationale})`);
        return { candidates, seeded: added, notes };
      });
    };

    // ── 01: claim the topic — the smart order described in the file header ──
    const claim = await wf.step.code("01-claim-topic", async (): Promise<TopicClaim> => {
      // The typed direction wins over the catalog for the same reason an
      // explicit requestedTopic does: a person who wrote a sentence about what
      // they want has more information than the catalog row does. THROUGH THE
      // SHARED PRIMITIVE, not a local read of `customPrompt` — the local
      // version promoted ANY typed sentence to a topic, so "keep it shorter
      // and skip the emoji" became the subject of the clip.
      if (runDirection.topicOverride) return { topic: runDirection.topicOverride, topicSource: "requested" };

      const reserved = await tryReserve();
      if (reserved !== undefined) return { ...reserved, topicSource: "reserved" };

      // The lane is empty. With footage in hand that is a missing HINT, not a
      // missing subject: the moment step names the topic from what the
      // recording actually contains (`topicLabel`).
      if (footageProvided) {
        return { topic: attached?.label ?? "the attached footage", topicSource: "footage" };
      }

      // No direction, no footage, empty lane: go and find out what this
      // client should be talking about.
      const discovery = await discoverTopics();
      if (discovery.seeded > 0 || discovery.candidates.length > 0) {
        const reservedAfterDiscovery = await tryReserve();
        if (reservedAfterDiscovery !== undefined) {
          const match = discovery.candidates.find((c) => normalizeTopic(c.topic) === normalizeTopic(reservedAfterDiscovery.topic));
          return { ...reservedAfterDiscovery, topicSource: "discovered", ...(match ? { discovered: match } : {}) };
        }
      }

      // The legacy loop's rule stands for the case nothing can fill: a run
      // with no candidate "logs that fact and exits cleanly. It never lowers
      // the bar to ship something."
      throw new WorkflowHeld(
        `no ${CLIP_LANE} candidate to make: the catalog lane is empty, no footage was attached, and discovery could not seed it — ${discovery.notes.join("; ")}`,
      );
    });

    // ── 01b: FIND-source — the tiered cascade. Zero-held BETWEEN tiers: a
    //         tier that cannot serve skips to the next with its reason kept,
    //         and only a fully dry cascade holds, naming every tier's outcome. ──
    const intake: TikTokIntake = await wf.step.code("01b-resolve-source", async (): Promise<TikTokIntake> => {
      const tierOutcomes: string[] = [];
      const base = { config, topic: claim.topic, topicSource: claim.topicSource, ...(claim.reservationKey ? { reservationKey: claim.reservationKey } : {}), ...(claim.discovered ? { discovered: claim.discovered } : {}) };

      // Tier 1 — footage attached to THIS run (or a hand-dispatched
      // sourcePath). The attachment is INGESTED rather than passed through:
      // its `uri` is a `gs://` object and `video.transcribe` does a plain
      // readFile on whatever it is handed.
      if (attached) {
        const sourcePath = await ingestSourceVideo(attached, options, tools, wf.runId, ctx);
        return { ...base, sourcePath, sourceTier: "user-asset", sourceContext: { ...(attached.label ? { label: attached.label } : {}), url: attached.uri } };
      }
      if (explicitSourcePath !== undefined) {
        return { ...base, sourcePath: explicitSourcePath, sourceTier: "user-asset" };
      }
      tierOutcomes.push("user-asset: no media attached to this run");

      if (config.mode === "original") {
        tierOutcomes.push("owned-footage, web-harvest: skipped — mode is \"original\", nobody else's footage is used");
      } else {
        // Tier 2a — the client's own footage library: sourcePool entries that
        // are URIs (a podcast episode, a keynote recording in their bucket).
        // The highest-context harvest there is — it's literally their footage.
        const ownedUris = config.sourcePool.filter((entry) => /^(gs|https):\/\//i.test(entry));
        if (ownedUris.length > 0) {
          try {
            const sourcePath = await ingestSourceVideo({ uri: ownedUris[0]!, label: "owned footage" }, options, tools, wf.runId, ctx);
            return { ...base, sourcePath, sourceTier: "owned-footage", sourceContext: { label: "owned footage", url: ownedUris[0]! } };
          } catch (error) {
            tierOutcomes.push(`owned-footage: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else {
          tierOutcomes.push("owned-footage: sourcePool holds no gs://https:// footage URIs");
        }

        // Tier 2b — a web harvest by topic, RESTRICTED to the shows the client
        // holds rights to. A pool that names no shows means this tier has
        // nothing it is allowed to search, and says so rather than searching
        // the open web.
        const harvest = tools["media.harvestVideo"];
        const allowedSources = plainSourceNames(config);
        if (harvest === undefined || options.repoRoot === undefined) {
          tierOutcomes.push("web-harvest: not wired in this deployment");
        } else if (allowedSources.length === 0) {
          tierOutcomes.push("web-harvest: sourcePool names no shows this client may clip, so there is nothing this tier is allowed to search");
        } else {
          const outcome = await harvest.execute({ repoRoot: options.repoRoot, runId: wf.runId, query: claim.topic, allowedSources }, { ctx });
          if (outcome.status === "success") {
            const result = outcome.result as { path: string; sourceUrl: string; title?: string; channel?: string };
            return {
              ...base,
              sourcePath: path.resolve(options.repoRoot, result.path),
              sourceTier: "web-harvest",
              sourceContext: { url: result.sourceUrl, ...(result.title ? { title: result.title } : {}), ...(result.channel ? { channel: result.channel } : {}) },
            };
          }
          tierOutcomes.push(`web-harvest: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
        }
      }

      // Tier 3 — an original short over stock footage (a generated still for
      // a beat no library has). The only tier that can answer any topic on
      // demand, and the one `mode: "commentary"` forbids. Nothing is fetched
      // HERE: the plates are found per beat once the script exists, because a
      // plate is a scene from a script, not a picture of a topic.
      if (config.mode === "commentary") {
        tierOutcomes.push("stock: disabled — mode is \"commentary\"");
      } else if (tools["video.findStockClip"] === undefined || options.repoRoot === undefined) {
        tierOutcomes.push(`stock: not wired in this deployment (${options.repoRoot === undefined ? "no repoRoot configured" : "video.findStockClip is not registered — set PEXELS_API_KEY"})`);
      } else {
        // The notes travel with the intake: the reviewer sees why this is
        // stock and not the client's own footage, beside the play button.
        return { ...base, sourceTier: "stock", sourceNotes: tierOutcomes };
      }

      // Every tier dry. A video post has no typographic fallback — this hold
      // is honest, and its reason names exactly what each tier said.
      if (claim.reservationKey) {
        await tools["topics.release"]?.execute({ reservationKey: claim.reservationKey }, { ctx }).catch(() => undefined);
      }
      throw new WorkflowHeld(`no source footage from any tier — ${tierOutcomes.join("; ")}`);
    });

    const format: ClipFormat = intake.sourceTier === "stock" ? "original-short" : "commentary-clip";

    /**
     * The run's cost ceiling: the product rule, lowered (never raised) by the
     * client's own `maxRunCostUsd`, and by a dispatcher budget tighter than both.
     */
    const costCapUsd = Math.min(MAX_RUN_COST_USD, config.maxRunCostUsd ?? MAX_RUN_COST_USD, wf.budget?.maxTotalCostUsd ?? MAX_RUN_COST_USD);


    /**
     * Hands a reservation back so a failed run does not burn the topic.
     *
     * Idempotent within a pass. The review cycle below gives this two callers
     * that can fire for the same failure — a drafting step that throws inside
     * `attempt`, and the catch wrapping the cycle — and `topics.release` is
     * not a no-op the second time: it puts the row back for anyone to claim
     * and records a second release against a reservation that only ever
     * existed once.
     */
    let reservationReleased = false;
    const releaseReservation = async (): Promise<void> => {
      if (!intake.reservationKey || reservationReleased) return;
      const tool = tools["topics.release"];
      if (!tool) return;
      reservationReleased = true;
      await tool.execute({ reservationKey: intake.reservationKey }, { ctx }).catch(() => undefined);
    };

    /** The cut plan every downstream step works from — real transcript-derived bounds for spoken footage, or nothing for a generated short. */
    interface ClipPlan {
      startSeconds: number;
      endSeconds: number;
      words: TranscriptWordLike[];
      text: string;
      /** Whether a cut is needed at all — a generated short is assembled, not cut. */
      needsCut: boolean;
    }

    // The run's topic. Provisional for `topicSource: "footage"` until the
    // moment step names what the recording is actually about.
    let topic = intake.topic;
    let moment: MomentSelection;
    let bounds: ClipPlan;

    if (intake.sourceTier === "stock") {
      // An original short has no speech to mine and no moment to pick. The
      // script step (inside `produceClip`, so a reviewer's note can rewrite
      // it) carries the whole message; this placeholder keeps the deliverable
      // shape every consumer already reads.
      moment = await wf.step.code("03-select-moment", () => ({
        startSeconds: 0,
        endSeconds: CLIP_DURATION_MIN_SECONDS,
        hookLine: intake.topic,
        hookType: "sharp-one-liner" as const,
        rationale: "original short — no transcript exists to pick a moment from; the script carries the message over stock footage",
      }));
      bounds = { startSeconds: 0, endSeconds: 0, words: [], text: "", needsCut: false };
    } else {
      // ── 02: transcript ──
      const words: TranscriptWordLike[] = await wf.step.code("02-transcribe", async () => {
        const result = (await callTool(tools, "video.transcribe", { videoPath: intake.sourcePath }, ctx)) as {
          words?: TranscriptWordLike[];
        };
        const spoken = (result.words ?? []).filter((w) => typeof w.text === "string" && w.text.trim().length > 0);
        if (spoken.length === 0) {
          await releaseReservation();
          // Non-verbal source. The legacy loop falls back to a retention heatmap
          // here; this engine has no heatmap tool, so the honest outcome is to
          // stop rather than to guess a moment out of a silent timeline.
          throw new WorkflowHeld("the source has no spoken words to clip, and this deployment has no retention-heatmap fallback");
        }
        return spoken;
      });

      // ── 03: PICK-moment (judgment) ──
      moment = await wf.step.code("03-select-moment", async () => {
        const agent = new TikTokMomentAgent({ router: options.router, tools, promptStore: options.promptStore });
        const exec = await wf.step.agent("03a-moment", agent, {
          // Which moment to clip is exactly the kind of thing a client's
          // direction speaks to ("the part where they talk about pricing"),
          // and the topic alone cannot carry a style note or an audience.
          ...runDirectionField(runDirection),
          topic: intake.topic,
          // Tells the picker how much weight the topic carries: a reserved
          // guest name is a steer, "the attached footage" is no steer at all.
          topicSource: intake.topicSource,
          ...(intake.sourceContext ? { sourceContext: intake.sourceContext } : {}),
          transcript: sentenceBoundedWords(words),
          durationMin: CLIP_DURATION_MIN_SECONDS,
          durationMax: CLIP_DURATION_MAX_SECONDS,
        });
        if (exec.status === "content_fail") {
          await releaseReservation();
          throw new WorkflowHeld("moment selection did not clear its own output validation");
        }
        if (exec.status !== "completed") {
          await releaseReservation();
          throw new WorkflowToolingFailure(`moment selection resolved to "${exec.status}"`);
        }
        return MomentSelectionSchema.parse(exec.finalOutput);
      });
      if (intake.topicSource === "footage" && moment.topicLabel) topic = moment.topicLabel;

      // ── 04: CUT — snap to real transcript boundaries and validate. This is
      //        the whole cut gate: the deterministic TS bounds check below is
      //        the check that actually runs and holds. ──
      const cut = await wf.step.code("04-cut-bounds", async () => {
        // The model's timestamps are a proposal. This is where they become real:
        // snapped to actual word boundaries in the transcript, then checked
        // against the length rule. A model asked for a timestamp will return one
        // whether or not the transcript supports it.
        const result = boundsFromTranscript(words, moment.startSeconds, moment.endSeconds, {
          minSeconds: CLIP_DURATION_MIN_SECONDS,
          maxSeconds: CLIP_DURATION_MAX_SECONDS,
        });
        if (!result.ok) {
          await releaseReservation();
          throw new WorkflowHeld(`selected moment is not clippable: ${result.reason}`);
        }
        return result;
      });
      bounds = { startSeconds: cut.startSeconds, endSeconds: cut.endSeconds, words: cut.words, text: cut.text, needsCut: true };
    }

    // ── 07b: the client's brand, for the framed clip. Best-effort, never
    //         blocking — brand furniture must never be able to hold a run,
    //         the same rule the slide pipeline's brand kit follows.
    //
    //         Read ONCE, above the review cycle: a reviewer's note changes the
    //         words, never the client's own colours, so every revision's
    //         render reuses this rather than re-reading it. ──
    const baseWorkDir = path.join(os.tmpdir(), "tiktok-agent", wf.runId);
    const videoBrand = await wf.step.code("07b-load-video-brand", async (): Promise<VideoBrand> => {
      const HEX6 = /^#[0-9a-fA-F]{6}$/;
      const asHex = (v: unknown): string | undefined => (typeof v === "string" && HEX6.test(v.trim()) ? v.trim() : undefined);
      const brandOutcome = await tools["client.getBrand"]?.execute({}, { ctx });
      const brand = (brandOutcome?.status === "success" ? brandOutcome.result : {}) as Record<string, unknown>;
      const colors = (brand["colors"] ?? {}) as Record<string, unknown>;
      const rawHandle = typeof brand["handle"] === "string" ? brand["handle"].trim() : "";
      const logoUrl = typeof brand["logoUrl"] === "string" && /^https:\/\//i.test(brand["logoUrl"]) ? brand["logoUrl"] : undefined;
      const language = readString(brand, "language");
      return {
        ground: asHex(colors["neutralDark"]) ?? "#17181C",
        fg: asHex(colors["neutralLight"]) ?? "#F4F2EC",
        ...(asHex(brand["accent"]) ?? asHex(colors["primaryAccent"])
          ? { accent: (asHex(brand["accent"]) ?? asHex(colors["primaryAccent"]))! }
          : {}),
        ...(rawHandle.length > 0 && /^@?[A-Za-z0-9._]{1,40}$/.test(rawHandle) ? { handle: `@${rawHandle.replace(/^@+/, "")}` } : {}),
        // The top bar names the client: a configured series header when the
        // client runs a series, else the company's own name (product rule
        // 2026-09-08). Absent both, the bar stays bare rather than inventing one.
        ...(config.seriesHeader !== undefined
          ? { seriesHeader: config.seriesHeader }
          : profile.name !== undefined && profile.name.trim().length > 0
            ? { seriesHeader: profile.name.trim().slice(0, 60) }
            : {}),
        ...(logoUrl !== undefined ? { logoUrl } : {}),
        ...(language !== undefined ? { language } : {}),
      };
    });

    /**
     * The logo, downloaded fresh for a render (any failure = no logo, never a
     * hold), with the WCAG contrast plan the compositor needs.
     *
     * AU38 (SCRUM-322): the cover's top bar is painted in `videoBrand.ground`,
     * so the mark's own decoded colors are checked against THAT token before
     * it is composited. A mark that clears WCAG 3:1 overlays bare; one that
     * does not gets the plate the plan verified it does clear; and a mark
     * whose bytes are unreadable is reported unchecked rather than credited
     * with a contrast nobody computed. No prompt is involved in any of it.
     */
    const prepareLogo = async (workDir: string): Promise<{ logoPath?: string; logoScrim?: string }> => {
      if (videoBrand.logoUrl === undefined) return {};
      const download = await downloadBrandLogo(options.fetchImpl ?? fetch, videoBrand.logoUrl);
      // SVG can't overlay in ffmpeg without a rasterizer — raster formats only here.
      if (download === undefined || download.mime === "image/svg+xml") return {};
      const ink = readBrandLogoInk(download);
      const placement = planBrandLogoPlacement({
        ground: videoBrand.ground,
        ...(ink !== undefined ? { ink } : {}),
        fg: videoBrand.fg,
        surface: "cover",
      });
      if (placement.decision === "omit") return {};
      const logoPath = path.join(workDir, download.mime === "image/png" ? "logo.png" : "logo.jpg");
      await fs.writeFile(logoPath, download.bytes);
      return { logoPath, ...(placement.scrim?.color !== undefined ? { logoScrim: placement.scrim.color } : {}) };
    };

    /** A beat's on-screen line, shown as a title card in the upper third of the picture while its narration is captioned below. */
    interface TitleCard {
      text: string;
      start: number;
      end: number;
    }

    /** The branded 9:16 frame around a finished cut or sequence — bars, header, handle, logo, captions, title cards. */
    const brandFrame = async (
      clipPath: string,
      workDir: string,
      srtPath: string | undefined,
      overlays: readonly TitleCard[] = [],
      fit: "contain" | "cover" = "contain",
      captionFontName?: string,
    ): Promise<{ outputPath: string; durationSeconds: number | null }> => {
      const { logoPath, logoScrim } = await prepareLogo(workDir);
      const frameOutcome = await tools["video.brandFrame"]?.execute(
        {
          videoPath: clipPath,
          outputPath: path.join(workDir, "clip-framed.mp4"),
          fit,
          ...(overlays.length > 0 ? { overlays } : {}),
          ...(captionFontName !== undefined ? { captionStyle: { fontName: captionFontName } } : {}),
          brand: {
            ground: videoBrand.ground,
            fg: videoBrand.fg,
            ...(videoBrand.accent !== undefined ? { accent: videoBrand.accent } : {}),
            ...(videoBrand.handle !== undefined ? { handle: videoBrand.handle } : {}),
            ...(videoBrand.seriesHeader !== undefined ? { seriesHeader: videoBrand.seriesHeader } : {}),
            ...(logoPath !== undefined ? { logoPath } : {}),
            ...(logoPath !== undefined && logoScrim !== undefined ? { logoScrim } : {}),
          },
          ...(srtPath !== undefined ? { srtPath } : {}),
        },
        { ctx },
      );
      if (frameOutcome === undefined || frameOutcome.status !== "success") {
        throw new WorkflowToolingFailure(
          `video.brandFrame failed: ${frameOutcome === undefined ? "tool not registered" : `${frameOutcome.status}${"reason" in frameOutcome ? ` (${frameOutcome.reason})` : ""}`}`,
        );
      }
      const framed = frameOutcome.result as { outputPath: string; durationSeconds: number | null };
      return { outputPath: framed.outputPath, durationSeconds: framed.durationSeconds ?? null };
    };

    /** One round's finished clip: what the gate shows a reviewer, and what step 12 persists once one approves it. */
    interface ClipDraft {
      /** Named `commentary` for both formats: it is the field the persisted review-feedback row (SCRUM-306) and the portal read. */
      commentary: ClipCopy;
      script?: ShortScript;
      voiceover: boolean;
      renderedPath: string;
      durationSeconds: number;
      uploaded: { gcsUri: string; signedUrl?: string } | null;
      /** The hook a viewer meets first — the moment's line, or the script's. */
      hookLine: string;
      /**
       * What the visual QA model said about the finished clip. A `content_fail`
       * here no longer holds the run: it ships to the human at 11-clip-review
       * FLAGGED with the model's reason, and the person decides. Absent when
       * the gate is not registered in the deployment.
       */
      visualQa?: { passed: boolean; reason?: string; evidence: string[]; weakBeats?: Array<{ index: number; relevance: number; note: string }> };
      /** The beats' time windows in the finished clip, for the visual QA's per-beat relevance read. Original shorts only. */
      beatWindows?: Array<{ index: number; start: number; end: number; narration: string }>;
      /** Per beat, where the b-roll came from — so a reviewer knows which plates are real footage. Original shorts only. */
      plateSources?: PlateSource[];
      /** What the run had spent when this draft reached the gate, so the reviewer sees the number beside the play button. */
      costSoFarUsd: number;
      /** The pre-purchase estimate for the whole run (original shorts only), so the reviewer can see how the actual compares. */
      estimatedCostUsd?: number;
      /** How the plan was kept under the ceiling (original shorts only): as written, re-planned, or by the deterministic stock-only fallback. */
      budgetPlan?: BudgetPlan;
      /** How many times the script went back to the writer over cost. */
      replans?: number;
      /** Whether a music bed was laid, and why not when it was not. Original shorts only. */
      music?: { applied: boolean; note?: string };
      /** Beats whose footage was re-sourced after the visual QA scored it under 5, and how the re-render fared (original shorts only). */
      repick?: { beats: number[]; note: string };
      /** Per beat, the library ids of its shots, so a later revision can exclude exactly the footage a reviewer turned down. Not shown to the reviewer. */
      plateStockIds?: Array<{ beat: number; ids: number[] }>;
      /** How this round was produced: the words rewritten, or only the footage re-sourced under the approved words (2026-09-10). Absent on round 0. */
      revisionKind?: "rewrite" | "footage-only";
    }

    /**
     * The text-level dedupe loop around ONE drafting call. `draft` runs the
     * model; the scored text is exactly what 07-compliance checks and
     * 13-commit-and-record writes back into the window, so every future run
     * compares like with like. On a `similar` verdict the draft is redone with
     * the offending post quoted into the prompt, bounded by
     * `MAX_DEDUPE_ATTEMPTS`; on the final attempt it ships FLAGGED rather than
     * held — the verdict stays checkpointed either way, and the human at
     * 11-clip-review is never shown words that were not scored.
     */
    const draftWithVerifiedDedupe = async <T>(
      rev: (id: string) => string,
      draftStepId: string,
      verifyStepId: string,
      draft: (attemptStepId: string, dedupeAvoid: string | undefined) => Promise<T>,
      scoredText: (draft: T) => string,
    ): Promise<T> => {
      let dedupeRetrySteer: string | undefined;
      for (let attempt = 1; attempt <= MAX_DEDUPE_ATTEMPTS; attempt++) {
        /** Attempt 1 keeps the ORIGINAL step ids, so a run that never repeats itself has a byte-identical trace to what it had before this check existed. */
        const att = (id: string) => (attempt === 1 ? id : `${id}-attempt-${attempt}`);
        const drafted = await draft(rev(att(draftStepId)), dedupeRetrySteer);
        const verdict = await checkOutputDedupe(wf, rev(att(verifyStepId)), scoredText(drafted), outputHistory);
        if (verdict.status === "similar" && attempt < MAX_DEDUPE_ATTEMPTS) {
          dedupeRetrySteer = dedupeRetryDirective(verdict, outputHistory);
          continue;
        }
        return drafted;
      }
      // Unreachable: the loop's last attempt always returns, because the
      // `continue` above is guarded on `attempt < MAX_DEDUPE_ATTEMPTS`.
      throw new WorkflowToolingFailure("the de-duplication redraft loop ended without a draft");
    };

    /** The deterministic text gates every caption clears before anything is rendered. */
    const runTextGates = async (text: string): Promise<void> => {
      for (const [gate, args] of [
        ["gate.lintPost", { text }],
        ["gate.brandCompliance", { text }],
        ["gate.noPlaceholder", { text }],
        ["gate.leakCheck", { text }],
      ] as const) {
        const verdict = await runGate(tools, gate, args, ctx);
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`${gate}: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") {
          throw new WorkflowHeld(`${gate} failed: ${verdict.reason}`);
        }
      }
    };

    // ─────────────────────────────────────────────────────────────────────
    // The COMMENTARY-CLIP production pass: someone else's moment, the
    // client's take, cut + captioned + framed.
    // ─────────────────────────────────────────────────────────────────────
    const produceCommentaryClip = async (revision: number, notes: readonly RevisionNote[]): Promise<ClipDraft> => {
      /** Revision 0 keeps the ORIGINAL ids, so a first-pass trace is unchanged. */
      const rev = (id: string) => (revision === 0 ? id : `${id}-r${revision}`);
      const directive = revisionDirective(notes);
      // A later round renders into its own directory. Sharing one would
      // overwrite `clip-framed.mp4` in place, and the r0 gate record — the
      // audit trail of what a human actually looked at — would then point at a
      // file holding the r1 clip.
      const workDir = revision === 0 ? baseWorkDir : path.join(baseWorkDir, `r${revision}`);

      // ── 06/06b: COMPOSE the commentary layer (judgment), then VERIFY it is
      //           not a repeat before anything downstream sees it ──
      const commentary = await draftWithVerifiedDedupe<Commentary>(
        rev,
        "06-commentary",
        "06b-verify-not-duplicate",
        (stepId, dedupeAvoid) =>
          wf.step.code(stepId, async () => {
            const agent = new TikTokCommentaryAgent({ router: options.router, tools, promptStore: options.promptStore });
            const exec = await runAgentStepWithCommitSteer(wf, `${stepId.replace("06-commentary", "06a-commentary")}`, agent, {
              // The step that writes the caption the client reads — the one
              // place their direction and brief matter most.
              ...runDirectionField(runDirection),
              topic,
              hookLine: moment.hookLine,
              hookType: moment.hookType,
              clipText: bounds.text,
              // What the footage ACTUALLY is, so the credit names it rather
              // than a plausible episode.
              ...(intake.sourceContext ? { sourceContext: intake.sourceContext } : {}),
              ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
              ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
              ...(dedupeAvoid !== undefined ? { dedupeAvoid } : {}),
              // Two distinct steers, kept apart: `pastFeedback` is what this client
              // has said across previous RUNS, `revisionRequest` is what a reviewer
              // asked about THIS clip minutes ago.
              ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
              ...(directive !== undefined ? { revisionRequest: directive } : {}),
            }, "the commentary");
            if (exec.status === "content_fail") {
              throw new WorkflowHeld("commentary did not clear its own output validation");
            }
            if (exec.status !== "completed") {
              throw new WorkflowToolingFailure(`commentary step resolved to "${exec.status}"`);
            }
            // The one mechanical tell repaired in code before anything scores
            // or gates the text (see `normalizeBannedDashes`): the agent has
            // already self-critiqued against the lint gate, this is the
            // backstop that makes a stray dash a comma instead of a held run.
            return normalizeCommentaryDashes(exec.finalOutput as Commentary);
          }),
        (c) => `${c.caption}\n\n${c.about}`,
      );

      // ── 07: compliance pass ──
      await wf.step.code(rev("07-compliance"), async () => {
        // Source credit first, and checked in code rather than asked of the
        // model that wrote it. The legacy rule is explicit that the on-clip
        // attribution block is not enough — the caption has to name it — and a
        // clip that ships uncredited is the one failure here with a party
        // outside this system.
        if (!commentary.caption.includes(commentary.sourceCredit)) {
          throw new WorkflowHeld("the caption does not carry the source credit, and an on-clip attribution block alone is not enough");
        }
        await runTextGates(`${commentary.caption}\n\n${commentary.about}`);
      });

      // ── 08: render — cut, caption, branded frame, all pure ffmpeg. ──
      const rendered = await wf.step.code(rev("08-render"), async (): Promise<{ outputPath: string; durationSeconds: number | null }> => {
        await fs.mkdir(workDir, { recursive: true });

        // Cut the moment out of the source.
        let clipPath = intake.sourcePath!;
        if (bounds.needsCut) {
          const cutOutcome = await tools["video.cutClip"]?.execute(
            {
              sourcePath: intake.sourcePath,
              startSeconds: bounds.startSeconds,
              endSeconds: bounds.endSeconds,
              outputPath: path.join(workDir, "clip-cut.mp4"),
            },
            { ctx },
          );
          if (cutOutcome === undefined || cutOutcome.status !== "success") {
            throw new WorkflowToolingFailure(
              `video.cutClip failed: ${cutOutcome === undefined ? "tool not registered" : `${cutOutcome.status}${"reason" in cutOutcome ? ` (${cutOutcome.reason})` : ""}`}`,
            );
          }
          clipPath = (cutOutcome.result as { outputPath: string }).outputPath;
        }

        // Burned captions, from the moment's own word timings — clip-relative.
        let srtPath: string | undefined;
        if (bounds.words.length > 0) {
          const srt = buildSrt(
            bounds.words.map((w) => ({ word: w.text, start: w.start, end: w.end })),
            bounds.startSeconds,
          );
          srtPath = path.join(workDir, "captions.srt");
          await fs.writeFile(srtPath, srt, "utf8");
        }

        return brandFrame(clipPath, workDir, srtPath, [], "contain", captionFontFor(videoBrand.language));
      });

      return finishDraft(rev, revision, {
        commentary: { caption: commentary.caption, about: commentary.about, sourceCredit: commentary.sourceCredit },
        voiceover: false,
        renderedPath: rendered.outputPath,
        // The framed file's probed length is the truth; the transcript-derived
        // window is the fallback.
        durationSeconds: rendered.durationSeconds ?? bounds.endSeconds - bounds.startSeconds,
        hookLine: moment.hookLine,
        guardrailText: `${commentary.caption}\n\n${commentary.about}\n\n${bounds.text}`,
        captionsExpected: bounds.words.length > 0,
      });
    };

    // ─────────────────────────────────────────────────────────────────────
    // The ORIGINAL-SHORT production pass: a script, generated plates per
    // beat, an optional voice, captions from real word timings, framed.
    // ─────────────────────────────────────────────────────────────────────
    /** The last draft this process produced, so a revision can keep its words and know which clips it used. Rebuilt from checkpoints on a replay, since round 0 re-runs first. */
    let lastDraft: ClipDraft | undefined;
    const produceOriginalShort = async (revision: number, notes: readonly RevisionNote[]): Promise<ClipDraft> => {
      const draft = await produceOriginalShortRound(revision, notes);
      lastDraft = draft;
      return draft;
    };
    const produceOriginalShortRound = async (revision: number, notes: readonly RevisionNote[]): Promise<ClipDraft> => {
      const rev = (id: string) => (revision === 0 ? id : `${id}-r${revision}`);
      const directive = revisionDirective(notes);
      const workDir = revision === 0 ? baseWorkDir : path.join(baseWorkDir, `r${revision}`);
      const repoRoot = options.repoRoot!;

      // ── A FOOTAGE-ONLY revision (2026-09-10) ──
      //
      // When every note the reviewer left this round is about the footage
      // ("beat 2's clip does not fit"), the words they did not complain about
      // are kept exactly, the writer is not asked again, and only the plates
      // are re-sourced, with the turned-down clips excluded so the library
      // must answer with something else. Until now every revise rewrote the
      // script: a footage note changed lines a reviewer had already accepted
      // and paid a drafting turn for the privilege. A note that mentions the
      // words, the voice or the music at all goes to the writer as before.
      const footageRevision = (() => {
        if (revision === 0 || lastDraft?.script === undefined || notes.length === 0) return undefined;
        const thisRound = notes.filter((n) => n.revision === revision - 1);
        const relevant = thisRound.length > 0 ? thisRound : notes;
        if (!relevant.every((n) => isFootageOnlyFeedback(n.feedback))) return undefined;
        const beats = [...new Set(relevant.flatMap((n) => beatsNamedIn(n.feedback)))];
        const previous = lastDraft.plateStockIds ?? [];
        const excludeStockIds = previous.filter((p) => beats.length === 0 || beats.includes(p.beat)).flatMap((p) => p.ids);
        return { script: lastDraft.script, beats, excludeStockIds };
      })();

      // ── 03s → 07 → 03v: SCRIPT, compliance, ESTIMATE — as a RE-PLAN LOOP ──
      //
      // Everything downstream of the script costs money: a voice, its
      // transcription, a still for any beat the library cannot serve, the QA
      // model watching the result. The plan is priced from the same
      // `UNIT_PRICING` rows the tools bill against, at the worst case, on
      // top of what the run has already spent, BEFORE anything is bought.
      //
      // A plan that prices over the ceiling is not a failure and not a hold
      // (2026-09-09, product rule): the client sees one continuous run that
      // ends in a finished clip. The script goes back to the writer with the
      // numbers and the levers (`budgetFeedback`), up to `MAX_BUDGET_REPLANS`
      // times. If the writer still cannot land it, a deterministic rule takes
      // over and simply buys nothing more: stock footage only (no stills),
      // and if even that does not fit, silent. Remaining cost is then the QA
      // call alone, so the ceiling is met by construction.
      //
      // Step ids carry `-replan-N` for the second and third attempts so every
      // draft, its dedupe verdict and its estimate stay in the trace.
      const drafted = await (async (): Promise<{ script: ShortScript; voiceover: boolean; stillsAllowed: boolean; estimate: CostEstimate; replans: number; budgetPlan: BudgetPlan }> => {
        const replanTargetUsd = Math.round(costCapUsd * REPLAN_TARGET_SHARE * 100) / 100;
        const visualQaRegistered = tools["video.visualQaGate"] !== undefined;
        let budgetFeedback: string | undefined;
        for (let attempt = 0; ; attempt++) {
          const planRev = (id: string) => rev(attempt === 0 ? id : `${id}-replan-${attempt}`);
          const feedback = budgetFeedback;
          // A footage-only revision keeps the approved words: no writer, no
          // dedupe (the same words were already verified), one cheap step.
          const script =
            footageRevision !== undefined
              ? await wf.step.code(planRev("03s-script"), async (): Promise<ShortScript> => footageRevision.script)
              : await draftWithVerifiedDedupe<ShortScript>(
            planRev,
            "03s-script",
            "03t-verify-not-duplicate",
            (stepId, dedupeAvoid) =>
              wf.step.code(stepId, async () => {
                const agent = new TikTokScriptAgent({ router: options.router, tools, promptStore: options.promptStore });
                /** One drafting call; `structureFix` is the note a redraft gets about what the last draft got structurally wrong. */
                const draftOnce = async (agentStepId: string, structureFix: string | undefined): Promise<ShortScript> => {
                  const exec = await runAgentStepWithCommitSteer(wf, agentStepId, agent, {
                    ...runDirectionField(runDirection),
                    topic,
                    ...(intake.discovered ? { topicBrief: intake.discovered } : {}),
                    clientProfile: profile,
                    ...clientVoice,
                    ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
                    ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
                    ...(dedupeAvoid !== undefined ? { dedupeAvoid } : {}),
                    ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
                    ...(directive !== undefined || structureFix !== undefined
                      ? { revisionRequest: [directive, structureFix].filter((s): s is string => s !== undefined).join("\n\n") }
                      : {}),
                    ...(feedback !== undefined ? { budgetFeedback: feedback } : {}),
                    voiceoverPolicy: config.voiceover,
                    allowPeople: config.allowPeopleInGeneratedFootage,
                    ...(config.voiceLanguage ?? videoBrand.language ? { contentLanguage: config.voiceLanguage ?? videoBrand.language } : {}),
                  }, "the script");
                  if (exec.status === "content_fail") {
                    throw new WorkflowHeld("the script did not clear its own output validation");
                  }
                  if (exec.status !== "completed") {
                    throw new WorkflowToolingFailure(`script step resolved to "${exec.status}"`);
                  }
                  return normalizeScriptDashes(ShortScriptSchema.parse(exec.finalOutput));
                };
                // Structure the schema cannot check: beat 1 opens on the hook
                // (repaired in code), no two beats say the same line (ONE
                // redraft with the offending beats named, then the later copy
                // is dropped rather than shipped twice).
                const agentStepId = stepId.replace("03s-script", "03u-script");
                // …and how it sounds: sentence length, hook length, the
                // conference-slide register. Same one redraft, every problem
                // named; what the redraft still gets wrong ships (the human at
                // the gate hears it), except a repeated beat, which is dropped.
                const first = repairScriptStructure(await draftOnce(agentStepId, undefined));
                const firstVoice = scriptVoiceIssues(first.repaired);
                const firstShots = shotVarietyIssues(first.repaired);
                const firstPitch = salesPitchIssues(first.repaired, runDirection.direction);
                if (first.issues.length === 0 && firstVoice.length === 0 && firstShots.length === 0 && firstPitch.length === 0) return first.repaired;
                const note = [
                  first.issues.length > 0 ? `Structure problem in your last draft: ${first.issues.join("; ")}. Rewrite so every beat carries its own line.` : undefined,
                  firstVoice.length > 0 ? `Voice problem in your last draft: ${firstVoice.join("; ")}. Keep the message; rewrite the lines as speech.` : undefined,
                  firstShots.length > 0 ? `Shot problem in your last draft: ${firstShots.join("; ")}. Keep the words; change only the stockQuery and visualBrief of the beats that share the place.` : undefined,
                  firstPitch.length > 0 ? `Pitch problem in your last draft: ${firstPitch.join("; ")}. Rewrite that beat so it ends on the idea, in the client's voice, with no offer and no address.` : undefined,
                ]
                  .filter((s): s is string => s !== undefined)
                  .join("\n");
                const second = repairScriptStructure(await draftOnce(`${agentStepId}-fix`, note));
                const secondVoice = scriptVoiceIssues(second.repaired);
                if (secondVoice.length > 0) console.warn(`${agentStepId}-fix: the redraft still reads off: ${secondVoice.join("; ")}; shipping to the reviewer as is`);
                return second.issues.length === 0 ? second.repaired : dropRepeatedBeats(second.repaired);
              }),
            (s) => `${s.caption}\n\n${s.about}`,
          );
          // The client's config outranks the model's per-piece call; on `auto`
          // the model decided and said why.
          const voiceover = config.voiceover === "always" ? true : config.voiceover === "never" ? false : script.voiceover;

          // ── 07: compliance pass — the caption and about, plus every line the
          //        viewer will hear or read, because on-screen words are
          //        published words too ──
          await wf.step.code(planRev("07-compliance"), async () => {
            await runTextGates([script.caption, script.about, ...script.beats.flatMap((b) => [b.narration, b.onScreenText])].join("\n\n"));
          });

          const narrationChars = script.beats.reduce((n, b) => n + b.narration.trim().length, 0);
          const narrationWords = script.beats.reduce((n, b) => n + b.narration.trim().split(/\s+/).length, 0);
          const estimate = await wf.step.code(planRev("03v-estimate-cost"), async () =>
            estimateOriginalShortCost({ spentSoFarUsd: await wf.costSoFarUsd(), narrationChars, beats: script.beats.length, voiceover, stillsAllowed: script.format !== "text-led", visualQaRegistered, costCapUsd }),
          );
          if (estimate.estimatedTotalUsd <= costCapUsd) {
            return { script, voiceover, stillsAllowed: script.format !== "text-led", estimate, replans: attempt, budgetPlan: attempt === 0 ? "original" : "replan" };
          }
          if (attempt < MAX_BUDGET_REPLANS) {
            budgetFeedback = budgetFeedbackFor(estimate, replanTargetUsd, script.beats.length, narrationWords);
            continue;
          }

          // ── 03w: the deterministic fallback. No more asking: stock only,
          //         and silent if stock only still does not fit. ──
          return wf.step.code(planRev("03w-budget-fallback"), async () => {
            const spentSoFarUsd = await wf.costSoFarUsd();
            let plan: BudgetPlan = "stock-only";
            let finalVoice = voiceover;
            let fallback = estimateOriginalShortCost({ spentSoFarUsd, narrationChars, beats: script.beats.length, voiceover: finalVoice, stillsAllowed: false, visualQaRegistered, costCapUsd });
            if (fallback.estimatedTotalUsd > costCapUsd && finalVoice) {
              finalVoice = false;
              plan = "stock-only-silent";
              fallback = estimateOriginalShortCost({ spentSoFarUsd, narrationChars, beats: script.beats.length, voiceover: false, stillsAllowed: false, visualQaRegistered, costCapUsd });
            }
            console.warn(`03w-budget-fallback: two re-plans still priced over $${costCapUsd.toFixed(2)}; continuing as ${plan} at an estimated $${fallback.estimatedTotalUsd.toFixed(2)}`);
            return { script, voiceover: finalVoice, stillsAllowed: false, estimate: fallback, replans: attempt, budgetPlan: plan };
          });
        }
      })();
      const { script, voiceover, stillsAllowed, estimate, replans, budgetPlan } = drafted;

      /**
       * A line set large on the brand ground (`video.textPlate`), in the
       * language's own face. `undefined` when the deployment has no such tool;
       * a render failure is a tooling failure like any other plate's.
       */
      const renderTextPlate = async (text: string, outputName: string, seconds: number, about: string): Promise<string | undefined> => {
        const render = tools["video.textPlate"];
        if (render === undefined) return undefined;
        const font = captionFontFor(config.voiceLanguage ?? videoBrand.language ?? script.language);
        const outcome = await render.execute(
          {
            text: text.length > 160 ? `${text.slice(0, 157).trimEnd()}…` : text,
            outputPath: path.join(baseWorkDir, `${outputName}.mp4`),
            durationSeconds: seconds,
            ground: videoBrand.ground,
            fg: videoBrand.fg,
            ...(videoBrand.accent !== undefined ? { accent: videoBrand.accent } : {}),
            ...(font !== undefined ? { fontName: font } : {}),
          },
          { ctx },
        );
        if (outcome.status !== "success") {
          throw new WorkflowToolingFailure(`video.textPlate failed for ${about}: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
        }
        return (outcome.result as { outputPath: string }).outputPath;
      };

      // ── 04p: FIND the plates, one per beat. Step ids carry NO revision
      //         suffix on purpose: a reviewer's note changes the words, and
      //         footage already found for beat 3 is reused for the revised
      //         beat 3 rather than fetched again. A revision with MORE beats
      //         finds only the extra ones; one with fewer uses a subset. ──
      //
      // Two tiers, in order. A real clip from the stock library first: real
      // footage is what a viewer trusts, and it costs nothing. Then a
      // generated PHOTOGRAPH ($0.04) held with a slow push-in, for the beat
      // no library has. Never generated video: the four prep runs of
      // 2026-09-07/08 each paid ~$13 for Veo plates that the visual QA
      // called "obviously AI-generated", against a product rule of two
      // dollars a short. `footageSource: "stock"` holds instead of taking
      // the still.
      /** One beat's footage: one shot, or two when the beat is long and the library had two clips for it. */
      interface BeatPlates {
        shots: PlateResult[];
      }
      const beatPlates: BeatPlates[] = [];
      const plateSources: PlateSource[] = [];
      // Seeded with the clips a footage-only revision is replacing, so the
      // library cannot hand the same one back for the beat a reviewer named.
      const usedStockIds: number[] = [...(footageRevision?.excludeStockIds ?? [])];
      for (let i = 0; i < script.beats.length; i++) {
        const beat = script.beats[i]!;
        // Revision-scoped (2026-09-10): a revised script needs its own plates,
        // and a footage revision exists to fetch new ones. Unscoped, round 1
        // replayed round 0's checkpointed plates under different words.
        const plate = await wf.step.code(rev(`04p-plate-${i + 1}`), async (): Promise<BeatPlates> => {
          // A text-led short never searches: the beat's line IS the picture.
          if (script.format === "text-led") {
            const rendered = await renderTextPlate(beat.onScreenText, `plate-${i + 1}-text`, beat.seconds, `beat ${i + 1}`);
            if (rendered === undefined) throw new WorkflowHeld("this short is text-led and video.textPlate is not registered in this deployment");
            return { shots: [{ path: rendered, source: "text" }] };
          }
          const query = beat.stockQuery ?? stockQueryFromBrief(beat.visualBrief);
          const misses: string[] = [];
          // What the library is asked to judge each candidate against: the
          // scene the script wanted and the words the viewer will hear over it.
          const relevance = { brief: beat.visualBrief, narration: beat.narration };
          const taken: number[] = [...usedStockIds];
          /** A stock search for this beat, with the run's used ids excluded. */
          const searchStock = async (attemptQuery: string, minDurationSeconds: number, outputName: string) => {
            const stock = tools["video.findStockClip"]!;
            const found = await stock.execute({ repoRoot, runId: wf.runId, query: attemptQuery, minDurationSeconds, excludeIds: [...taken], outputName, relevance }, { ctx });
            if (found.status !== "success") return { ok: false as const, note: `stock "${attemptQuery}": ${found.status}${"reason" in found ? ` (${found.reason})` : ""}` };
            const result = found.result as { path: string; pexelsId: number; sourceUrl: string };
            taken.push(result.pexelsId);
            return { ok: true as const, plate: { path: path.resolve(repoRoot, result.path), source: "stock" as const, stockId: result.pexelsId, sourceUrl: result.sourceUrl } };
          };
          /** The second shot of a long beat: same query, the first clip excluded, half the length. Optional: a miss leaves one shot. */
          const withSecondShot = async (first: PlateResult): Promise<BeatPlates> => {
            if (beat.seconds < TWO_SHOT_BEAT_SECONDS || tools["video.findStockClip"] === undefined) return { shots: [first] };
            const second = await searchStock(query, SECOND_SHOT_MIN_SECONDS, `plate-${i + 1}-b`);
            return { shots: second.ok ? [first, second.plate] : [first] };
          };
          // A still is a purchase. It is off the table when the plan said
          // stock only, when the client said stock only, or when the run has
          // already reached its ceiling: in every one of those cases the beat
          // walks the free ladder below instead, and a beat nothing free can
          // serve is the one honest hold left.
          const stillsHere = stillsAllowed && config.footageSource !== "stock" && (await wf.costSoFarUsd()) < costCapUsd;

          if (tools["video.findStockClip"] === undefined) {
            misses.push("stock: video.findStockClip is not registered");
          } else {
            // The beat's own query first; without a still to fall back on,
            // the brief-derived query and then a generic scene every library
            // holds, so "free only" still means a real plate.
            const ladder = stillsHere
              ? [query]
              : [...new Set([query, stockQueryFromBrief(beat.visualBrief), GENERIC_STOCK_QUERIES[i % GENERIC_STOCK_QUERIES.length]!, GENERIC_STOCK_QUERIES[(i + 1) % GENERIC_STOCK_QUERIES.length]!])];
            for (const attemptQuery of ladder) {
              const found = await searchStock(attemptQuery, beat.seconds, `plate-${i + 1}`);
              if (found.ok) return withSecondShot(found.plate);
              misses.push(found.note);
            }
          }
          /**
           * The free tier under every other tier (2026-09-10): the beat's own
           * line, set large on the brand ground with the accent bar drawing
           * across. Costs nothing, needs no library and no model, renders any
           * script through libass. Reached when no still may be bought, when
           * the still tier is not wired, or when the still itself fails; the
           * only hold left is a deployment without the tool.
           */
          const textPlate = async (because: string): Promise<BeatPlates> => {
            const rendered = await renderTextPlate(beat.onScreenText, `plate-${i + 1}-text`, beat.seconds, `beat ${i + 1}`);
            if (rendered === undefined) {
              throw new WorkflowHeld(`no footage for beat ${i + 1} ("${query}"): ${misses.join("; ")}; ${because}; and video.textPlate is not registered`);
            }
            return { shots: [{ path: rendered, source: "text" }] };
          };

          if (!stillsHere) {
            const why = config.footageSource === "stock" ? 'this client\'s footageSource is "stock"' : !stillsAllowed ? `the plan is ${budgetPlan}` : "the run has reached its cost ceiling";
            return textPlate(`no still may be bought (${why})`);
          }

          const generateImage = tools["image.generate"];
          const stillToClip = tools["video.stillToClip"];
          if (generateImage === undefined || stillToClip === undefined) {
            return textPlate(`the still tier is not wired (${generateImage === undefined ? "image.generate" : "video.stillToClip"} is not registered)`);
          }
          const image = await generateImage.execute(
            {
              repoRoot,
              runId: wf.runId,
              needs: [{ n: i + 1, prompt: stillBrief(beat.visualBrief, config.allowPeopleInGeneratedFootage) }],
              perNeed: 1,
              aspectRatio: "9:16",
              art: { aesthetic: "documentary photograph", lighting: "natural light", mood: "calm, observational" },
            },
            { ctx },
          );
          if (image.status !== "success") {
            // The image route down (a 403 billing hold on Vertex took it out
            // on 2026-09-10) is a route outage, not a fact about the beat.
            return textPlate(`still: ${image.status}${"reason" in image ? ` (${image.reason})` : ""}`);
          }
          const generated = image.result as { candidates: Array<{ path: string }>; unmet: Array<{ n: number; reason: string }> };
          const candidate = generated.candidates[0];
          if (candidate === undefined) {
            return textPlate(`still: ${generated.unmet[0]?.reason ?? "the image model produced nothing"}`);
          }
          const clip = await stillToClip.execute(
            {
              imagePath: path.resolve(repoRoot, candidate.path),
              outputPath: path.join(baseWorkDir, `plate-${i + 1}-still.mp4`),
              durationSeconds: beat.seconds,
              move: i % 2 === 0 ? "push-in" : "pull-back",
            },
            { ctx },
          );
          if (clip.status !== "success") {
            throw new WorkflowToolingFailure(`video.stillToClip failed for beat ${i + 1}: ${clip.status}${"reason" in clip ? ` (${clip.reason})` : ""}`);
          }
          return { shots: [{ path: (clip.result as { outputPath: string }).outputPath, source: "still" }] };
        });
        beatPlates.push(plate);
        for (const shot of plate.shots) {
          plateSources.push(shot.source);
          if (shot.stockId !== undefined) usedStockIds.push(shot.stockId);
        }
      }

      // ── 05: VOICE — the narration spoken, then TIMED by transcribing the
      //        very file that will play, so captions sit on the words a
      //        listener actually hears rather than on an estimate. ──
      // ── 04h: the cold open — the hook, large, for the first two seconds
      //         (see HOOK_PLATE_SECONDS). Footage shorts only: a text-led
      //         short already opens on its own line. Not a plate source; it
      //         is furniture the way the title card was. ──
      const hookPlate = await wf.step.code(rev("04h-hook-plate"), async (): Promise<{ path: string; seconds: number } | null> => {
        if (script.format === "text-led") return null;
        const rendered = await renderTextPlate(script.hook, "plate-hook", HOOK_PLATE_SECONDS, "the hook");
        return rendered === undefined ? null : { path: rendered, seconds: HOOK_PLATE_SECONDS };
      });

      const narration = script.beats.map((b) => b.narration.trim()).join(" … ");
      const language = config.voiceLanguage ?? videoBrand.language ?? script.language;
      const voice = await wf.step.code(rev("05-voiceover"), async (): Promise<{ path: string; durationSeconds: number | null; words: TranscriptWordLike[]; notes: string[] } | null> => {
        if (!voiceover) return null;
        if ((await wf.costSoFarUsd()) >= costCapUsd) {
          // The plan was priced to fit, so this is the belt to its braces: at
          // the ceiling the short runs silent (captions carry the words)
          // rather than buying a voice, and never fails for it.
          console.warn("05-voiceover: the run has reached its cost ceiling; running silent instead of buying a voice");
          return null;
        }
        await fs.mkdir(workDir, { recursive: true });
        const synth = tools["video.synthesizeVoice"];
        if (synth === undefined) {
          // The same rule as a voice we cannot afford: the short runs silent
          // and the captions carry the words. A deployment without a TTS
          // provider is an operator fact the reviewer should see, not a
          // failed run the client should meet.
          console.warn("05-voiceover: video.synthesizeVoice is not registered; running silent");
          return null;
        }
        const outputPath = path.join(workDir, "voiceover.mp3");
        const outcome = await synth.execute(
          { text: narration, outputPath, language, ...(config.voiceName ? { voice: config.voiceName } : {}), ...(config.voiceSpeakingRate !== undefined ? { speakingRate: config.voiceSpeakingRate } : {}) },
          { ctx },
        );
        if (outcome.status !== "success") {
          // Every TTS route down (2026-09-10: a billing hold took every Google
          // API in the project offline at once) is a route outage, not a fact
          // about the script. Silent, with the captions, beats no clip.
          console.warn(`05-voiceover: video.synthesizeVoice ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}; running silent`);
          return null;
        }
        const result = outcome.result as { outputPath: string; durationSeconds: number | null };
        const notes: string[] = [];
        let words: TranscriptWordLike[] = [];
        const timing = await tools["video.transcribe"]?.execute({ videoPath: result.outputPath }, { ctx });
        if (timing?.status === "success") {
          words = ((timing.result as { words?: TranscriptWordLike[] }).words ?? []).filter((w) => typeof w.text === "string" && w.text.trim().length > 0);
        } else {
          notes.push(`voiceover word timings unavailable (${timing?.status ?? "video.transcribe not registered"}); captions are timed per beat instead`);
        }
        return { path: result.outputPath, durationSeconds: result.durationSeconds, words, notes };
      });

      /**
       * Downloads the client's track and lays it under the sequence. Returns
       * the path to frame (the mixed file, or the original when anything
       * about the bed did not work out) and what to tell the reviewer.
       */
      const layMusicBed = async (sequencePath: string, dir: string): Promise<{ path: string; music: { applied: boolean; note?: string } }> => {
        const noBed = (note: string) => ({ path: sequencePath, music: { applied: false, note } });
        if (config.musicTrackUri === undefined) return noBed("no musicTrackUri in the client's tiktokClips config");
        const mix = tools["video.mixMusic"];
        if (mix === undefined) return noBed("video.mixMusic is not registered in this deployment");
        let bytes: Buffer;
        let extension = "mp3";
        try {
          const response = await (options.fetchImpl ?? fetch)(config.musicTrackUri, { signal: AbortSignal.timeout(30_000) });
          if (!response.ok) return noBed(`the music track could not be fetched (${response.status})`);
          const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
          if (type.length > 0 && !type.startsWith("audio/") && type !== "application/octet-stream" && type !== "video/mp4") {
            return noBed(`the music track URL returned ${type}, not audio`);
          }
          if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) extension = "m4a";
          else if (type.includes("wav")) extension = "wav";
          bytes = Buffer.from(await response.arrayBuffer());
        } catch (error) {
          return noBed(`the music track could not be fetched: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_MUSIC_TRACK_BYTES) {
          return noBed(`the music track is ${Math.round(bytes.byteLength / 1_048_576)} MB; a bed is under ${MAX_MUSIC_TRACK_BYTES / 1_048_576} MB`);
        }
        const musicPath = path.join(dir, `music.${extension}`);
        await fs.writeFile(musicPath, bytes);
        const outcome = await mix.execute(
          { videoPath: sequencePath, musicPath, outputPath: path.join(dir, "sequence-music.mp4"), ...(config.musicGainDb !== undefined ? { musicGainDb: config.musicGainDb } : {}) },
          { ctx },
        );
        if (outcome.status !== "success") {
          console.warn(`08-render: video.mixMusic ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}; shipping without a bed`);
          return noBed(`the mix failed (${outcome.status}); shipped without a bed`);
        }
        const mixed = outcome.result as { outputPath: string; ducked: boolean };
        return { path: mixed.outputPath, music: { applied: true, ...(mixed.ducked ? {} : { note: "bed laid under a silent short" }) } };
      };
      let musicOutcome: { applied: boolean; note?: string } | undefined;

      // ── 08: render — hold each plate for its beat, lay the voice under,
      //        burn the captions, frame it. ──
      /**
       * The render as one PASS. `passRev` names its checkpoints and `workDir`
       * its files, so the re-pick after the visual QA (below) renders under
       * `08-render-repick` into its own directory instead of replaying the
       * first pass's checkpoint or overwriting its clip.
       */
      const renderPass = (passRev: (id: string) => string, workDir: string) => wf.step.code(passRev("08-render"), async (): Promise<{ outputPath: string; durationSeconds: number | null; beatWindows: Array<{ index: number; start: number; end: number; narration: string }> }> => {
        await fs.mkdir(workDir, { recursive: true });

        // How long each beat holds. With a voice, the plates stretch to cover
        // it in proportion to how much each beat says; without one, the
        // script's own seconds stand.
        const scripted = script.beats.map((b) => b.seconds);
        let holds: number[] = scripted;
        if (voice?.durationSeconds) {
          const wordCounts = script.beats.map((b) => Math.max(1, b.narration.trim().split(/\s+/).length));
          const totalWords = wordCounts.reduce((a, b) => a + b, 0);
          const total = voice.durationSeconds + 0.4;
          holds = wordCounts.map((n) => Math.max(MIN_PLATE_HOLD_SECONDS, (n / totalWords) * total));
        }
        const boundaries = holds.reduce<number[]>((acc, h) => [...acc, (acc[acc.length - 1] ?? 0) + h], []);

        // Captions: the SCRIPT's words, timed by the voice's transcript
        // (see `captions.ts`: the recognizer is the clock, never the text, so
        // "karoslabs.com" is never burned as "Kairoslabs.com" and a cue ends
        // where the phrase does). Without a timed voice, the on-screen text
        // per beat, held for the beat.
        // How long the cold open holds: up to HOOK_PLATE_SECONDS out of beat
        // 1's hold, as long as beat 1 keeps enough footage after it. Zero
        // means no cold open (no tool, a text-led short, or a beat 1 too
        // short to share).
        const leadSeconds = (() => {
          if (hookPlate === null || holds[0] === undefined) return 0;
          const lead = Math.min(HOOK_PLATE_SECONDS, holds[0] / 2);
          return holds[0] - lead >= MIN_LEAD_REMAINDER_SECONDS ? Number(lead.toFixed(2)) : 0;
        })();

        // Captions: the SCRIPT's words, timed by the voice's transcript, cut
        // at phrase boundaries; none while the cold open is on screen (the
        // hook is already the picture, twice is noise). Without a timed voice,
        // the on-screen text per beat, held for the beat.
        const cues =
          voice && voice.words.length > 0
            ? cuesToSrt(
                buildPhraseCues(
                  alignScriptToTimings(
                    scriptWords(script.beats.map((b) => b.narration)),
                    voice.words.map((w) => ({ text: w.text, start: w.start, end: w.end })),
                    voice.durationSeconds ?? undefined,
                  ),
                )
                  .filter((cue) => cue.end > leadSeconds + 0.05)
                  .map((cue) => ({ ...cue, start: Math.max(cue.start, leadSeconds) })),
              )
            : buildSrt(
                script.beats.map((b, i) => ({ word: b.onScreenText, start: i === 0 ? leadSeconds : boundaries[i - 1]!, end: boundaries[i]! - 0.05 })),
                0,
                1,
              );
        const srtPath = path.join(workDir, "captions.srt");
        await fs.writeFile(srtPath, cues, "utf8");

        const compose = tools["video.composeSequence"];
        if (compose === undefined) throw new WorkflowToolingFailure("video.composeSequence is not registered — an original short cannot be assembled");
        const composed = await compose.execute(
          {
            // A long beat with two shots cuts halfway through its hold; one
            // whose hold ended up too short for two legible shots (a voice
            // that rushed the line) keeps its first shot alone.
            clips: beatPlates.slice(0, script.beats.length).flatMap((beatPlate, i) => {
              // The cold open takes its seconds out of beat 1's hold.
              const lead = i === 0 ? leadSeconds : 0;
              const hold = holds[i]! - lead;
              const shots = beatPlate.shots.length === 2 && hold >= 2 * MIN_PLATE_HOLD_SECONDS ? beatPlate.shots : beatPlate.shots.slice(0, 1);
              return [
                ...(lead > 0 && hookPlate !== null ? [{ path: hookPlate.path, holdSeconds: lead }] : []),
                ...shots.map((shot) => ({ path: shot.path, holdSeconds: Number((hold / shots.length).toFixed(2)) })),
              ];
            }),
            outputPath: path.join(workDir, "sequence.mp4"),
            ...(voice ? { voiceoverPath: voice.path } : {}),
          },
          { ctx },
        );
        if (composed.status !== "success") {
          throw new WorkflowToolingFailure(`video.composeSequence failed: ${composed.status}${"reason" in composed ? ` (${composed.reason})` : ""}`);
        }
        const sequence = composed.result as { outputPath: string; durationSeconds: number | null };

        // ── The music bed (2026-09-09). Every 2026-09-08 short played a
        //    synthetic voice over silence, the second-loudest "made by a
        //    machine" signal after the footage. The client's own track, looped
        //    or trimmed to the picture, ducked under the voice, faded out.
        //    Never a hold: no track, no tool, a bad download or a failed mix
        //    all ship the clip without a bed and say so to the reviewer. ──
        const bedded = await layMusicBed(sequence.outputPath, workDir);
        musicOutcome = bedded.music;

        // With a voice, the captions are the spoken words and ONE title card
        // sits above them: beat 1's on-screen text, for the whole first beat.
        // That card is the visual hook a stranger reads before they hear a
        // word. The 2026-09-08 renders carded every beat and the visual QA
        // read it as "multiple, conflicting captioning styles"; a viewer
        // reads one line at a time. Silent, the on-screen text IS the caption
        // (built above) and no card repeats it.
        const titleCards: TitleCard[] =
          leadSeconds === 0 && voice && voice.words.length > 0 && script.beats[0] !== undefined
            ? [{ text: script.beats[0].onScreenText, start: 0, end: Math.max(0.5, Math.min(boundaries[0]!, 4) - 0.05) }]
            : [];

        // Plates are portrait: fill the picture area edge to edge rather than
        // letterboxing a 9:16 clip inside a 9:12.7 region (the 2026-09-08
        // render had dark side bars either side of every plate).
        const framed = await brandFrame(bedded.path, workDir, srtPath, titleCards, "cover", captionFontFor(language));
        // Where each beat's footage sits in the finished clip, for the QA's
        // per-beat relevance read (the cold open is part of beat 1's window).
        const beatWindows = script.beats.map((b, i) => ({ index: i + 1, start: Number((i === 0 ? 0 : boundaries[i - 1]!).toFixed(2)), end: Number(boundaries[i]!.toFixed(2)), narration: b.narration }));
        return { ...framed, beatWindows };
      });

      /** One pass through the render and everything after it up to the human gate. */
      const finishPass = async (passRev: (id: string) => string, dir: string, repick?: ClipDraft["repick"]): Promise<ClipDraft> => {
        const rendered = await renderPass(passRev, dir);
        return finishDraft(passRev, revision, {
          commentary: { caption: script.caption, about: script.about },
          script,
          // What actually shipped: a voice skipped at the ceiling is a silent short.
          voiceover: voice !== null,
          plateSources: beatPlates.flatMap((p) => p.shots.map((s) => s.source)),
          plateStockIds: beatPlates.map((p, i) => ({ beat: i + 1, ids: p.shots.flatMap((s) => (s.stockId !== undefined ? [s.stockId] : [])) })),
          ...(revision > 0 ? { revisionKind: footageRevision !== undefined ? ("footage-only" as const) : ("rewrite" as const) } : {}),
          budgetPlan,
          replans,
          renderedPath: rendered.outputPath,
          durationSeconds: rendered.durationSeconds ?? script.beats.reduce((a, b) => a + b.seconds, 0),
          beatWindows: rendered.beatWindows,
          // What the viewer actually meets first is beat 1's narration; the
          // script's `hook` field is the same line when the model follows its
          // prompt, and when it does not, judging the render against a line
          // nobody hears (as the 2026-09-08 visual QA did) is the wrong test.
          hookLine: script.beats[0]?.narration ?? script.hook,
          guardrailText: [script.caption, script.about, ...script.beats.map((b) => b.narration)].join("\n\n"),
          captionsExpected: true,
          estimatedCostUsd: estimate.estimatedTotalUsd,
          // On a replay of a checkpointed render the helper never ran; the
          // reviewer then sees "unknown" rather than a claim nobody verified.
          music: musicOutcome ?? { applied: false, note: "render replayed from checkpoint; bed status not re-derived" },
          ...(repick !== undefined ? { repick } : {}),
        });
      };

      const first = await finishPass(rev, workDir);

      // ── 10d: RE-PICK the beats the visual QA said do not fit (2026-09-10) ──
      //
      // The QA scores every beat's footage against the line said over it and
      // names the ones under 5 (`weakBeats`). Until now that name went to the
      // reviewer and no further: the audit's 2026-09-08 clips shipped with a
      // concert under a line about hiring because nobody was there to swap
      // it. Now each named beat (the worst first, at most MAX_REPICK_BEATS)
      // is searched again with every clip this run has used excluded, so the
      // library must answer with something else; the short is re-rendered
      // and re-watched under its own step ids, and the cut the QA scored
      // better is what reaches the gate. ONE round: a beat still weak after
      // its second clip ships named, as before. Free apart from the second
      // QA call (~$0.01) and the relevance thumbnails, and skipped at the
      // ceiling like everything else that costs.
      const weak = first.visualQa?.weakBeats ?? [];
      const stockTool = tools["video.findStockClip"];
      if (weak.length === 0 || script.format === "text-led" || stockTool === undefined || (await wf.costSoFarUsd()) >= costCapUsd) return first;
      const repicked = await wf.step.code(rev("10d-repick-weak-beats"), async (): Promise<{ swapped: Array<{ index: number; plate: PlateResult }>; misses: string[] }> => {
        const swapped: Array<{ index: number; plate: PlateResult }> = [];
        const misses: string[] = [];
        const taken = [...usedStockIds];
        for (const w of [...weak].sort((a, b) => a.relevance - b.relevance).slice(0, MAX_REPICK_BEATS)) {
          const beat = script.beats[w.index - 1];
          if (beat === undefined) continue;
          const query = beat.stockQuery ?? stockQueryFromBrief(beat.visualBrief);
          const found = await stockTool.execute(
            { repoRoot, runId: wf.runId, query, minDurationSeconds: beat.seconds, excludeIds: [...taken], outputName: `plate-${w.index}-repick`, relevance: { brief: beat.visualBrief, narration: beat.narration } },
            { ctx },
          );
          if (found.status !== "success") {
            misses.push(`beat ${w.index} ("${query}"): ${found.status}${"reason" in found ? ` (${found.reason})` : ""}`);
            continue;
          }
          const result = found.result as { path: string; pexelsId: number; sourceUrl: string };
          taken.push(result.pexelsId);
          swapped.push({ index: w.index, plate: { path: path.resolve(repoRoot, result.path), source: "stock", stockId: result.pexelsId, sourceUrl: result.sourceUrl } });
        }
        return { swapped, misses };
      });
      const named = weak.map((w) => `beat ${w.index}`).join(", ");
      if (repicked.swapped.length === 0) {
        return { ...first, repick: { beats: [], note: `the visual QA scored ${named} under 5 and the library had nothing else for ${repicked.misses.join("; ")}` } };
      }
      // Applied OUTSIDE the step from its recorded result, so a replay that
      // skips the step still renders the swapped plates.
      for (const s of repicked.swapped) {
        beatPlates[s.index - 1] = { shots: [s.plate] };
        if (s.plate.stockId !== undefined) usedStockIds.push(s.plate.stockId);
      }
      const swappedBeats = repicked.swapped.map((s) => s.index);
      const because = `${swappedBeats.map((i) => `beat ${i}`).join(", ")} re-sourced after the visual QA scored the footage under 5${repicked.misses.length > 0 ? ` (nothing else for ${repicked.misses.join("; ")})` : ""}`;
      const passRev = (id: string) => rev(`${id}-repick`);
      const second = await finishPass(passRev, path.join(workDir, "repick"), { beats: swappedBeats, note: because });

      // The cut the QA scored better ships. A re-render the QA did not get to
      // watch (an outage between the two calls) ships too — its footage was
      // at least chosen against the line, where the first's was scored
      // against it and failed — and the gate then holds for a person, as
      // any unreviewed clip does.
      const weakCount = (d: ClipDraft): number => d.visualQa?.weakBeats?.length ?? 0;
      const worse = second.visualQa !== undefined && first.visualQa !== undefined && ((first.visualQa.passed && !second.visualQa.passed) || weakCount(second) > weakCount(first));
      if (worse) {
        return { ...first, repick: { beats: swappedBeats, note: `${because}; the re-render scored worse (${second.visualQa?.reason ?? `${weakCount(second)} weak beat(s)`}), so the first cut ships` } };
      }
      const stillWeak = second.visualQa?.weakBeats?.map((w) => `beat ${w.index}`) ?? [];
      const outcome = second.visualQa === undefined ? "the QA did not watch the re-render" : stillWeak.length === 0 ? "the re-render scored clean" : `the re-render still names ${stillWeak.join(", ")}`;
      return { ...second, repick: { beats: swappedBeats, note: `${because}; ${outcome}` } };
    };

    /**
     * What both production passes share once a framed file exists: the
     * blocking QA gates, the reviewer's upload, and the terminal topic
     * guardrail.
     */
    const finishDraft = async (
      rev: (id: string) => string,
      revision: number,
      draft: Omit<ClipDraft, "uploaded" | "costSoFarUsd" | "visualQa"> & { guardrailText: string; captionsExpected: boolean },
    ): Promise<ClipDraft> => {
      const { renderedPath } = draft;

      await wf.step.code(rev("09-qa-gate"), async () => {
        // Blocking. The legacy rule: "Any failure aborts THIS candidate (never
        // ship degraded)." The bitstream check is the one deterministic QA the
        // file itself can answer.
        const verdict = await runGate(tools, "video.selfEvalGate", { videoPath: renderedPath }, ctx);
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`video.selfEvalGate: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") {
          throw new WorkflowHeld(`video.selfEvalGate failed: ${verdict.reason}`);
        }
      });

      // ── 10a: upload BEFORE the human gate, so the reviewer can actually
      //         watch what they're approving (a bare container path is not a
      //         reviewable clip). Registered only when a media store is
      //         configured; absent, the gate carries the local path as before.
      //         Also before the visual QA, which can then watch the GCS object
      //         instead of pushing the whole file inline. ──
      const uploaded = await wf.step.code(rev("10a-upload-clip"), async () => {
        const uploadTool = tools["video.uploadDeliverable"];
        if (!uploadTool) return null;
        // Suffixed like the step ids (`clip.mp4`, `clip-r1.mp4`,
        // `clip-repick.mp4`) for the same reason the work directory is: a
        // revision or a re-pick must not overwrite the object the previous
        // cut's gate record links a reviewer to.
        const objectName = `${rev("clip")}.mp4`;
        const outcome = await uploadTool.execute(
          { localPath: renderedPath, objectPath: `tiktok/${wf.clientSlug}/${wf.runId}/${objectName}`, contentType: "video/mp4" },
          { ctx },
        );
        if (outcome.status !== "success") {
          console.error(`${rev("10a-upload-clip")}: upload failed (${outcome.status}) — the gate and deliverable carry the local path only`);
          return null;
        }
        return outcome.result as { gcsUri: string; signedUrl?: string };
      });

      // ── 10c: the anti-repetition window learns about this clip NOW, not
      //         only on commit (2026-09-09). Two GEO shorts were made six
      //         hours apart on 2026-09-08 because the first sat at its gate
      //         unrecorded, so the next run's scout never saw it. Idempotent
      //         on runId: 13-commit-and-record re-records the same entry with
      //         the words that actually shipped. A rejected clip's angle
      //         stays in the window too, and that is right: the next run
      //         should not re-propose the thing a person just turned down. ──
      await wf.step.code(rev("10c-record-pending-excerpt"), async () => {
        try {
          const outcome = await tools["ledger.recordOutputExcerpt"]?.execute(
            { agentId: "tiktok-agent", runId: wf.runId, excerpt: `${draft.commentary.caption}\n\n${draft.commentary.about}` },
            { ctx },
          );
          return { recorded: outcome?.status === "success" };
        } catch (error) {
          console.error(`${rev("10c-record-pending-excerpt")}: could not record the pending excerpt`, error);
          return { recorded: false };
        }
      });

      // ── 10b: the visual QA — a model WATCHES the finished clip and says
      //         whether a person would post it: captions legible and in sync,
      //         no generation artifacts, the brand frame intact, and whether
      //         it reads as generated. ADVISORY since 2026-09-07: a
      //         content_fail is carried to the reviewer as a flag with the
      //         model's reason, never a hold. Prep run pubsub-21756184831102737
      //         held a finished, in-brand original short because Gemini scored
      //         it 6/10 ("unnatural movement in plant growth animation"), a
      //         taste call on generated b-roll that the person at 11-clip-review
      //         is there to make and was never shown. A deployment without the
      //         gate records that it was skipped rather than pretending it
      //         passed. ──
      type WeakBeat = { index: number; relevance: number; note: string };
      const visualQa = await wf.step.code(rev("10b-visual-qa"), async (): Promise<{ skipped: true; note: string } | { skipped: false; passed: boolean; reason?: string; evidence: string[]; weakBeats: WeakBeat[] }> => {
        const gate = tools["video.visualQaGate"];
        if (gate === undefined) return { skipped: true, note: "video.visualQaGate is not registered in this deployment" };
        if ((await wf.costSoFarUsd()) >= costCapUsd) return { skipped: true, note: "skipped: the run has reached its cost ceiling; the reviewer judges the clip unaided" };
        const outcome = await gate.execute(
          {
            videoPath: renderedPath,
            ...(uploaded?.gcsUri ? { gcsUri: uploaded.gcsUri } : {}),
            expectations: {
              topic,
              hookLine: draft.hookLine,
              captionsExpected: draft.captionsExpected,
              voiceoverExpected: draft.voiceover,
              brandColors: [videoBrand.ground, videoBrand.fg, ...(videoBrand.accent ? [videoBrand.accent] : [])],
              ...(videoBrand.language ? { language: videoBrand.language } : {}),
              format,
              // The beats and their windows, so the model says WHICH shot is
              // wallpaper under its line, not only that one is.
              ...(draft.beatWindows !== undefined && draft.beatWindows.length > 0 ? { beats: draft.beatWindows.slice(0, 6) } : {}),
            },
          },
          { ctx },
        );
        if (outcome.status === "not_available") return { skipped: true, note: `video.visualQaGate is not available: ${outcome.reason}` };
        // The QA is advisory: a route outage on the model that would have
        // watched the clip (a 403 billing hold on Vertex, 2026-09-10) leaves
        // the human to judge it unaided, recorded as such — never a failed
        // run over a review nobody got to give.
        if (outcome.status !== "success") return { skipped: true, note: `video.visualQaGate ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}; the reviewer judges the clip unaided` };
        const verdict = outcome.result as GateVerdict & { beats?: WeakBeat[] };
        if (verdict.verdict === "tooling_error") return { skipped: true, note: `video.visualQaGate could not review the clip (${verdict.reason}); the reviewer judges it unaided` };
        // A beat scored under 5 is footage that does not fit its line: named
        // to the reviewer beside the play button, never a hold on its own.
        const weakBeats = (verdict.beats ?? []).filter((b) => b.relevance < 5);
        if (verdict.verdict === "content_fail") {
          console.warn(`${rev("10b-visual-qa")}: visual QA flagged the clip, shipping to review flagged rather than held: ${verdict.reason}`);
          return { skipped: false, passed: false, reason: verdict.reason, evidence: verdict.evidence, weakBeats };
        }
        return { skipped: false, passed: true, evidence: verdict.evidence, weakBeats };
      });

      // ── 10: terminal topic guardrail ──
      //
      // The same check the dynamic runner appends to every dynamic agent, run
      // here for the same reason: the client's own forbidden-topic list is a
      // promise about what their account will not talk about, and a clip of
      // someone ELSE saying it is still their account saying it. Runs before the
      // human gate so a reviewer is never shown something that should not exist.
      //
      // `forbiddenTopics` is what step 00 already read, so the guardrail does
      // not read the client's config a second time. The `-r{n}` suffix gives
      // each revision round its own checkpoint: without it the fixed step id
      // short-circuits on round 0's checkpoint and the REVISED words are never
      // actually verified, while the trace still reports a pass.
      await runTopicGuardrail(
        wf,
        { tools, promptStore: options.promptStore, router: options.router },
        draft.guardrailText,
        forbiddenTopics,
        revision === 0 ? undefined : `-r${revision}`,
      );

      // Read AFTER the QA model has billed itself, so the number beside the
      // play button is what this clip actually cost to bring to the reviewer.
      const costSoFarUsd = Math.round((await wf.costSoFarUsd()) * 1_000_000) / 1_000_000;

      return {
        commentary: draft.commentary,
        ...(draft.script ? { script: draft.script } : {}),
        voiceover: draft.voiceover,
        renderedPath,
        durationSeconds: draft.durationSeconds,
        uploaded,
        hookLine: draft.hookLine,
        costSoFarUsd,
        ...(draft.estimatedCostUsd !== undefined ? { estimatedCostUsd: draft.estimatedCostUsd } : {}),
        ...(draft.budgetPlan !== undefined ? { budgetPlan: draft.budgetPlan } : {}),
        ...(draft.replans !== undefined ? { replans: draft.replans } : {}),
        ...(draft.music !== undefined ? { music: draft.music } : {}),
        ...(draft.plateSources !== undefined ? { plateSources: draft.plateSources } : {}),
        ...(draft.repick !== undefined ? { repick: draft.repick } : {}),
        ...(draft.plateStockIds !== undefined ? { plateStockIds: draft.plateStockIds } : {}),
        ...(draft.revisionKind !== undefined ? { revisionKind: draft.revisionKind } : {}),
        ...(visualQa.skipped
          ? {}
          : {
              visualQa: {
                passed: visualQa.passed,
                ...(visualQa.reason !== undefined ? { reason: visualQa.reason } : {}),
                evidence: visualQa.evidence,
                ...(visualQa.weakBeats.length > 0 ? { weakBeats: visualQa.weakBeats } : {}),
              },
            }),
      };
    };

    const produceClip = format === "original-short" ? produceOriginalShort : produceCommentaryClip;

    // ── 11: the universal approve / revise / reject cycle ──
    //
    // `revise` re-writes the words with the reviewer's feedback in hand and
    // re-renders the clip around them, reusing everything already
    // checkpointed, instead of holding the run and forcing somebody to
    // dispatch a fresh one that knows nothing about why the first was turned
    // down. Every decision, approvals included, is written to client memory.
    const review = await runReviewCycle<ClipDraft>(wf, {
      gateId: "11-clip-review",
      maxRevisions: MAX_REVISION_ROUNDS,
      ...(options.autoApprove ? { autoApprove: true } : {}),
      attempt: produceClip,
      buildGate: (draft, revision) => ({
        kind: "batch_review",
        payload: {
          runId: wf.runId,
          topic,
          topicSource: intake.topicSource,
          lane: CLIP_LANE,
          format,
          preview: draft.commentary.caption,
          clipPath: draft.renderedPath,
          durationSeconds: draft.durationSeconds,
          sourceTier: intake.sourceTier,
          // Why the footage is stock and not the client's own: what each
          // higher tier said. Absent when a higher tier served.
          ...(intake.sourceNotes !== undefined && intake.sourceNotes.length > 0 ? { sourceNotes: intake.sourceNotes } : {}),
          voiceover: draft.voiceover,
          ...(draft.script ? { script: draft.script } : {}),
          revision,
          // The reviewer's actual preview — a signed URL they can watch.
          ...(draft.uploaded?.signedUrl !== undefined ? { videoUrl: draft.uploaded.signedUrl } : {}),
          ...(draft.uploaded !== null ? { gcsUri: draft.uploaded.gcsUri } : {}),
          // The visual QA model's read, so a flagged clip arrives with the
          // reason beside the play button instead of as a held run.
          ...(draft.visualQa !== undefined ? { visualQa: draft.visualQa, flagged: !draft.visualQa.passed } : {}),
          // Which plates are real footage and which are generated stills.
          ...(draft.plateSources !== undefined ? { plateSources: draft.plateSources } : {}),
          // What it cost to get here, what the plan was priced at, and the
          // ceiling — beside the play button, not in a separate report.
          costSoFarUsd: draft.costSoFarUsd,
          ...(draft.estimatedCostUsd !== undefined ? { estimatedCostUsd: draft.estimatedCostUsd } : {}),
          maxCostUsd: costCapUsd,
          ...(draft.budgetPlan !== undefined ? { budgetPlan: draft.budgetPlan } : {}),
          ...(draft.replans !== undefined ? { replans: draft.replans } : {}),
          ...(draft.music !== undefined ? { music: draft.music } : {}),
          // Which beats were re-sourced after the QA, and how the re-render fared.
          ...(draft.repick !== undefined ? { repick: draft.repick } : {}),
          // Whether this round rewrote the words or only re-sourced footage.
          ...(draft.revisionKind !== undefined ? { revisionKind: draft.revisionKind } : {}),
        },
        requiredRole: "account_manager",
        // An unanswered gate approves itself after an hour ONLY for a clip the
        // visual QA passed. Two prep clips scored 3/10 shipped on 2026-09-08
        // by `system:gate-timeout` after seven hours with nobody watching; a
        // flagged clip now waits for a person, however long that takes.
        // A clip the visual QA never got to watch (a skipped or failed gate,
        // as under the 2026-09-10 Vertex hold) waits for a person too: a clip
        // nobody reviewed is exactly what the audit found shipping.
        timeout: { duration: "1h", onTimeout: draft.visualQa !== undefined && draft.visualQa.passed ? "auto_approve" : "hold" },
      }),
      onDecision: async ({ revision, response, output }) => {
        // SCRUM-306 (AU23): a reject's drafted content previously had nowhere
        // durable to go — it lived only in this round's step checkpoints and
        // was lost the moment the run held. Attached only on reject: an
        // approval's content already has a durable copy via
        // `ledger.writeDeliverable`, and a revise round's draft is superseded
        // by the next attempt.
        await persistReviewFeedbackToMemory(
          wf,
          tools,
          ctx,
          revision,
          response,
          response.decision === "reject" ? JSON.stringify(output) : undefined,
        );
      },
    }).catch(async (error: unknown): Promise<never> => {
      // The topic goes back for anything that ends this run without a clip: a
      // rejection, the revision ceiling, a content gate that said no inside
      // the production pass, a guardrail violation.
      //
      // Every such failure releases here and ONLY here — but a gate nobody has
      // answered yet is not one of them. `step.gate` throws
      // `AwaitingGateSignal` to PAUSE the run; that is the literal "throw to
      // pause" contract `WorkflowEngine.run` catches to return
      // `awaiting_gate`, and it arrives at this catch on every single run that
      // actually waits for a human. Releasing on it would hand the topic back
      // the instant the clip reached a reviewer: the row returns to the lane
      // while the clip made from it sits awaiting approval, the next run
      // claims the same topic, and the approval that eventually lands commits
      // a reservation that no longer means anything.
      if (error instanceof AwaitingGateSignal) throw error;
      await releaseReservation();
      throw error;
    });
    const { commentary: copy, script, voiceover, renderedPath, durationSeconds, uploaded } = review.output;

    // ── 12: QUEUE ──
    const deliverableId: string = await wf.step.code("12-persist-deliverable", async () => {
      const result = (await callTool(
        tools,
        "ledger.writeDeliverable",
        {
          runId: wf.runId,
          kind: "tiktok-clip",
          deliverable: {
            topic,
            topicSource: intake.topicSource,
            lane: CLIP_LANE,
            format,
            clipPath: renderedPath,
            caption: copy.caption,
            about: copy.about,
            ...(copy.sourceCredit !== undefined ? { sourceCredit: copy.sourceCredit } : {}),
            ...(intake.sourceContext ? { sourceContext: intake.sourceContext } : {}),
            hookLine: review.output.hookLine,
            // The visual QA model's read, persisted with what shipped so the
            // portal can show a flagged clip as flagged after the fact.
            ...(review.output.visualQa !== undefined ? { visualQa: review.output.visualQa } : {}),
            ...(review.output.plateSources !== undefined ? { plateSources: review.output.plateSources } : {}),
            ...(review.output.repick !== undefined ? { repick: review.output.repick } : {}),
            ...(review.output.revisionKind !== undefined ? { revisionKind: review.output.revisionKind } : {}),
            costSoFarUsd: review.output.costSoFarUsd,
            ...(review.output.estimatedCostUsd !== undefined ? { estimatedCostUsd: review.output.estimatedCostUsd } : {}),
            maxCostUsd: costCapUsd,
            ...(review.output.budgetPlan !== undefined ? { budgetPlan: review.output.budgetPlan } : {}),
            ...(review.output.replans !== undefined ? { replans: review.output.replans } : {}),
            ...(review.output.music !== undefined ? { music: review.output.music } : {}),
            hookType: moment.hookType,
            startSeconds: bounds.startSeconds,
            endSeconds: bounds.endSeconds,
            durationSeconds,
            sourceTier: intake.sourceTier,
            ...(intake.sourceNotes !== undefined && intake.sourceNotes.length > 0 ? { sourceNotes: intake.sourceNotes } : {}),
            voiceover,
            ...(script ? { script } : {}),
            ...(uploaded?.signedUrl !== undefined ? { signedUrl: uploaded.signedUrl } : {}),
            ...(uploaded !== null ? { gcsUri: uploaded.gcsUri } : {}),
          },
        },
        ctx,
      )) as { id: string };
      return result.id;
    });

    // ── 13: LOG — burn the topic only now that a clip actually shipped ──
    await wf.step.code("13-commit-and-record", async () => {
      if (intake.reservationKey) {
        await callTool(tools, "topics.commit", { reservationKey: intake.reservationKey }, ctx);
      }
      // The write half of the anti-repetition loop — best-effort, on delivery only.
      try {
        await tools["ledger.recordOutputExcerpt"]?.execute({ agentId: "tiktok-agent", runId: wf.runId, excerpt: `${copy.caption}\n\n${copy.about}` }, { ctx });
      } catch (error) {
        console.error("13-commit-and-record: could not record the output excerpt for future dedup", error);
      }
      const memory = tools["memory.appendDecision"];
      if (memory) {
        await memory.execute(
          {
            decisionId: `${wf.runId}__decision`,
            summary: format === "original-short" ? `Made an original short on "${topic}"${voiceover ? " with voiceover" : ""}` : `Clipped "${topic}" (${moment.hookType})`,
          },
          { ctx },
        );
      }
    });

    return {
      topic,
      topicSource: intake.topicSource,
      lane: CLIP_LANE,
      format,
      moment,
      commentary: copy,
      ...(script ? { script } : {}),
      voiceover,
      deliverableId,
      durationSeconds,
    };
  };
}
