import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildKaraokeCaptionsAss, buildSrt } from "@agent-engine/tool-karos-video";
import { downloadBrandLogo, planBrandLogoPlacement, readBrandLogoInk } from "@agent-engine/tool-karos-media";
import {
  UNIT_PRICING,
  evaluateDedupe,
  readForbiddenTopics,
  shingles,
  type AgentContext,
  type AgentToolRegistry,
  type DedupeVerdict,
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
  // C7, the learning loop (SCRUM-459/460/464/466). The six obligations in
  // `docs/AGENT-ARCHITECTURE.md` §1, in that order — the order is the
  // standard, not this agent's preference.
  readLearningContext,
  stageForRun,
  touchesNeverTopic,
  subjectWindowConflict,
  ensureStrategyMap,
  pickStrategyRow,
  strategyRowForDrafting,
  craftRulesForPrompt,
  feedbackForPrompt,
  preferencesForDrafting,
  platformStateForDrafting,
  resolveGoalLine,
  writeRunState,
  type LearningContextLike,
  type ResolvedGoalLine,
  readOutputHistoryForDedup,
  readPastFeedback,
  readRunDirection,
  revisionDirective,
  runAgentStepWithCommitSteer,
  runDirectionField,
  runReviewCycle,
  runTopicGuardrail,
  toAgentContext,
  // The owner's always-deliver rule (2026-09-17), as the fleet's shared
  // primitives rather than a local re-invention: six agents already repair
  // where they used to hold, and this family was the last that did not.
  runCheckWithRepair,
  redactSentencesCarrying,
  stripSpansFrom,
  spansFromEvidence,
  localContentFail,
  localPass,
  type ContentRepair,
  type RevisionNote,
  type WorkflowContext,
} from "@agent-engine/workflow";
import { normalizeBannedDashes } from "@agent-engine/tool-common";
import { TikTokCommentaryAgent } from "../agent/tiktok-commentary-agent.js";
import { TikTokMomentAgent } from "../agent/tiktok-moment-agent.js";
import { TikTokScriptAgent } from "../agent/tiktok-script-agent.js";
import { TikTokSourceFitAgent } from "../agent/tiktok-source-fit-agent.js";
import { TikTokTopicScoutAgent } from "../agent/tiktok-topic-scout-agent.js";
import { bestLegalWindow, boundsFromTranscript, sentenceBoundedWords, type TranscriptWordLike } from "./clip-bounds.js";
import { checkDraftLanguage, isJudgeableLanguage, languageRedraftDirective, resolveTargetLanguage, type ResolvedTargetLanguage } from "./target-language.js";
import {
  clipWindowEntry,
  clippedWindowDirective,
  parseShapeMemory,
  shapeRepeatDirective,
  skeletonEntry,
  skeletonOf,
  stockClipEntry,
  windowsOverlap,
} from "./shape-memory.js";
import { scoreMoment } from "./moment-floor.js";
import { buildHarvestQuery } from "./harvest-query.js";
import { alignScriptToTimings, beatHoldsFromTimings, buildPhraseCues, buildPhraseGroups, cuesToSrt, scriptWords } from "./captions.js";
import {
  CLIP_DURATION_MAX_SECONDS,
  CLIP_DURATION_MIN_SECONDS,
  CLIP_LANE,
  clipLicenseConfidence,
  DEFAULT_CLIP_CONFIG,
  formatForVariant,
  modeForVariant,
  type TikTokVariant,
  MAX_RUN_COST_USD,
  MIN_SOURCE_FIT,
  SourceFitSchema,
  TARGET_RUN_SPEND_USD,
  VOICE_AND_QA_RESERVE_USD,
  type BudgetRung,
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
  /**
   * Whether the YouTube harvest is tried BEFORE the podcast feed.
   *
   * Set from `YT_DLP_COOKIES_FILE` at wiring time (owner ruling, 2026-09-21:
   * "RSS by default, YouTube when there are cookies"). Both tiers answer the
   * same question — find an episode about this topic — and they differ in what
   * comes back: YouTube yields the speakers on camera, a feed yields their
   * audio over sourced footage. The first is a better clip when it works, and
   * on a worker with no cookies it does not work, so trying it first there
   * costs sixteen refused yt-dlp invocations to learn what the deployment
   * already knows.
   *
   * Decided at wiring rather than read here because the workflow has no
   * business reading `process.env`, and because a test must be able to drive
   * both orders.
   */
  youtubeHarvestPreferred?: boolean;
  /**
   * Which of D08's three TikTok agents this is (SCRUM-455). Defaults to
   * `auto`, the pre-split behaviour, so every existing caller and every
   * in-flight run keeps working unchanged. `buildWorkflowForProduct` passes
   * the real one.
   */
  variant?: TikTokVariant;
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
export type PlateSource = "stock" | "still" | "text" | "client";

/** A silent source shorter than this cannot carry a 20-40 s short without frozen frames; the plates come from the library instead. */
export const MIN_CLIENT_FOOTAGE_SECONDS = 12;

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

/**
 * How fast a synthesized narrator speaks, in words a second, for predicting
 * a beat's hold before the voice exists (2026-09-15). 2.6 is the measured
 * pace of the prep runs' Chirp 3 voice at the configured 1.0-1.1 rate; it is
 * only ever used to decide how many SHOTS a beat gets, never to time
 * anything, so being a tenth out costs nothing.
 */
const NARRATION_WORDS_PER_SECOND = 2.6;

/**
 * How long this beat will really be on screen.
 *
 * `seconds` is what the writer asked for; on a VOICED short the render gives
 * each beat the time its line actually takes to say (see
 * `beatHoldsFromTimings`), which for a long line is several seconds more.
 * The two-shot rule was reading `seconds`, so a beat the writer marked 4 and
 * the voice held for 7 stayed on ONE clip for seven seconds: the longest
 * hold in the short, on the beat with the most to say. Predicting the hold
 * from the line's own length puts the second shot where the picture would
 * otherwise hang. Exported for the test.
 */
export function expectedHoldSeconds(beat: { narration: string; seconds: number }, voiceover: boolean): number {
  if (!voiceover) return beat.seconds;
  const words = beat.narration.trim().split(/\s+/).filter((w) => w.length > 0).length;
  return Math.max(beat.seconds, words / NARRATION_WORDS_PER_SECOND);
}

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
  const stillsWorstCaseUsd = input.stillsAllowed ? input.beats * unitPriceUsd("gemini-3.1-flash-image") : 0;
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

/** Enough of the hook's own words back in the closing line, and the short has gone in a circle. Both bars must be cleared, so a shared subject noun is not a finding. */
const CIRCULAR_SHARED_WORDS = 3;
const CIRCULAR_CONTAINMENT = 0.6;

/**
 * Whether the short ends where it started (2026-09-15).
 *
 * The prompt has asked since v6 for a last beat that "changes how the viewer
 * sees what came before; it does not recap it", and nothing checked. A short
 * whose closing line is the hook in other words has spent its last four
 * seconds telling a viewer something they were told at second one, which is
 * where they leave — and on a loop-to-start platform it is the one beat that
 * decides whether the second watch happens.
 *
 * Measured on content words rather than on the sentence: a closing line that
 * reuses the subject ("hire", "budget") is doing its job, one that reuses
 * most of the hook is restating it. Both bars have to be cleared, and the
 * three endorsed golden runs clear them comfortably (their closers share one
 * or two words with their hooks). Beat 1 is exempt by construction: it IS
 * the hook, which `repairScriptStructure` guarantees.
 */
export function circularEndingIssues(script: ShortScript): string[] {
  const last = script.beats[script.beats.length - 1];
  if (last === undefined || script.beats.length < 2) return [];
  const hook = topicTokens(script.hook);
  const closing = topicTokens(last.narration);
  if (hook.size === 0 || closing.size === 0) return [];
  let shared = 0;
  for (const word of closing) if (hook.has(word)) shared++;
  const containment = shared / Math.min(hook.size, closing.size);
  if (shared < CIRCULAR_SHARED_WORDS || containment < CIRCULAR_CONTAINMENT) return [];
  return [
    `the last beat says the hook again ("${last.narration.slice(0, 60)}…" against "${script.hook.slice(0, 60)}…"); ` +
      "the closing line has to leave the viewer somewhere the hook did not: the consequence, the thing to do differently, the turn",
  ];
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

/**
 * The colour the word being said lights up in when the brand kit names no
 * accent (2026-09-15). A warm yellow: the convention of the format, legible
 * on any footage, and clearly not the white the rest of the phrase is set
 * in. A brand WITH an accent uses its own.
 */
export const DEFAULT_CAPTION_HIGHLIGHT = "#FFD54F";

/** The brand furniture the framed clip carries — every field beyond the two grounds optional, skipped when absent. */
interface VideoBrand {
  ground: string;
  fg: string;
  accent?: string;
  handle?: string;
  seriesHeader?: string;
  logoUrl?: string;
  /**
   * Why a configured `logoUrl` was NOT taken, when one was configured and
   * rejected. Set only for `gs://`, and never read by any render — see the
   * derivation in `07b-load-video-brand` for what this field is for and why
   * it is a recorded reason rather than a thrown error.
   */
  rejectedLogoUrlReason?: string;
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
 * The extensions `media.ingestAssets` can actually fetch.
 *
 * It does a plain HTTP GET and writes the bytes, so an `https://` asset has to
 * BE the media. A YouTube watch page fetched that way writes an HTML document
 * with an `.mp4` name, and the failure surfaces three steps later inside
 * `video.transcribe` as an unreadable file.
 */
const DIRECT_MEDIA_EXTENSION = /\.(mp4|webm|mov|m4v|mkv)(\?|#|$)/i;

/**
 * Whether this URI is something to fetch, or a PAGE to resolve first.
 *
 * `gs://` is always ours and always a file. An `https://` URI is a file only
 * when it says so: anything else is a page a person pasted, and it goes to
 * yt-dlp instead (RFC-25 phase 4).
 */
export function isDirectMediaUri(uri: string): boolean {
  if (/^gs:\/\//i.test(uri)) return true;
  return DIRECT_MEDIA_EXTENSION.test(uri);
}

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
    const variant: TikTokVariant = options.variant ?? "auto";
    /**
     * The client's `mode` is a preference about what they are comfortable
     * with; the variant is which product they pressed, and the product wins.
     * A card that says "clipping" may not answer with a generated short
     * because the client's block happens to say `original` — the two are
     * answers to different questions, and only one of them is on the card.
     */
    const config: TikTokClipConfig = { ...intakeConfig.config, mode: modeForVariant(variant, intakeConfig.config.mode) };
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
    /**
     * What this account has already MADE — the library clips its shorts have
     * used and the skeletons they were built on.
     *
     * The other half of anti-repetition, beside `outputHistory`'s "what has it
     * already said". Read here with the rest, best-effort: a deployment with no
     * ledger tool gets a run with no structural memory, never a failed one.
     */
    const shapeMemory = await wf.step.code("01e-read-shape-memory", async () => {
      const list = tools["ledger.listUsedImages"];
      const nothing = { usedStockIds: [] as number[], skeletons: [] as string[], clippedWindows: [] as Array<{ source: string; startSeconds: number; endSeconds: number }> };
      if (list === undefined) return nothing;
      try {
        const outcome = await list.execute({}, { ctx });
        if (outcome.status !== "success") return nothing;
        return parseShapeMemory((outcome.result as { imagePaths?: string[] }).imagePaths ?? []);
      } catch (error) {
        console.error("01e-read-shape-memory: could not read what this account has already made", error);
        return nothing;
      }
    });
    const shapeDirective = shapeRepeatDirective(shapeMemory.skeletons);
    const recentPostsDirective = dedupeDirective(outputHistory);
    const clientIntelContext = await readClientIntelContext(wf, tools, ctx, "read-intel-context");
    const pastFeedback = await readPastFeedback(wf, tools, ctx, "read-past-feedback");

    // ── 01b: the learning context (C7 §2) ──
    //
    // Above both produce-closures and their `rev()` scopes, so a revision
    // drafts against the same context the first attempt saw. All three TikTok
    // products share the platform key `tiktok`, because the client has ONE
    // TikTok account and one subject history on it — not one per product we
    // happen to sell.
    const learning: LearningContextLike = await readLearningContext(wf, tools, ctx, "tiktok", "01b-read-learning-context");
    const stage = stageForRun(runDirection.slotStage, learning.subjectWindow);
    /** What this account has already said inside the window, plus what the client ruled out. */
    const learningAvoid = [
      ...(learning.subjectWindow?.rows ?? []).map((r) => r.subject).filter((v): v is string => typeof v === "string" && v.trim().length > 0),
      ...(learning.preferences?.neverTopics ?? []),
    ];

    // ── 01c: the strategy map — the topic pool with a stage on every row ──
    //
    // Built here because it needs the profile and the intel report together,
    // and both are in hand by now. `ensureStrategyMap` holds its own two
    // guards: nothing for a client with nothing projected (C7 §4.1), nothing
    // when there is no material to plan from. That matters more here than
    // anywhere else — this agent runs under a hard $2 ceiling
    // (`MAX_RUN_COST_USD`), and an unbudgeted model call on a cold client is
    // what `tiktok-short-two-dollar-cap` exists to police.
    const strategy = await ensureStrategyMap(
      wf,
      { tools, promptStore: options.promptStore, router: options.router },
      ctx,
      {
        platform: "tiktok",
        learning,
        stepId: "01c-build-strategy-map",
        input: {
          today: new Date().toISOString().slice(0, 10),
          clientProfile: profile,
          ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
          forbiddenTopics: [...forbiddenTopics, ...(learning.preferences?.neverTopics ?? [])],
        },
      },
    );
    const strategyRow = pickStrategyRow(strategy.map, stage, learning.subjectWindow);

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
      /** Set with `topicSource: "widened"`: why this run is on a subject nobody reserved. */
      topicNote?: string;
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
    const discoverTopics = async (): Promise<{
      candidates: TopicCandidate[];
      seeded: number;
      notes: string[];
      /** Proposed, then dropped only for being too close to something already said. The widen's second rung takes from here. */
      repeats: TopicCandidate[];
      /** The lane's row count, which is what the research lens and the content pillar both rotate on. */
      rotation: number;
    }> => {
      return wf.step.code("01c-discover-topics", async () => {
        const notes: string[] = [];
        const topUp = tools["topics.topUp"];
        if (topUp === undefined) {
          return { candidates: [], seeded: 0, notes: ["topics.topUp is not registered; discovered topics would have nowhere to land"], repeats: [], rotation: 0 };
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
          return { candidates: [], seeded: 0, notes, repeats: [], rotation };
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
        if (exec.status !== "completed") {
          // A scout that failed its own schema and a scout that was DOWN now
          // land in the same place: "discovery proposed nothing". The second
          // used to throw `WorkflowToolingFailure`, which killed a run that
          // could still have fallen to the client's own content pillar — the
          // always-deliver rule's tooling carve-out is for when nothing can
          // be produced, and here something can. The reason rides in the
          // notes and reaches the reviewer through the `topic-source` repair.
          notes.push(
            exec.status === "content_fail"
              ? "the topic scout did not clear its own output validation"
              : `the topic scout resolved to "${exec.status}", so nothing was discovered this run`,
          );
          return { candidates: [], seeded: 0, notes, repeats: [], rotation };
        }
        const proposed = TopicScoutOutputSchema.parse(exec.finalOutput);

        // The evidence rule, enforced in code: a URL the research did not
        // return is not evidence, whatever the model says it is.
        const knownUrls = new Set(researchDocuments.map((d) => d.url));
        const excluded = new Set(config.narrowing.map(normalizeTopic));
        const candidates: TopicCandidate[] = [];
        /** Proposed, and dropped only for being too close to something already said — in the scout's own order. */
        const repeats: TopicCandidate[] = [];
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
            repeats.push(candidate);
            continue;
          }
          // Two reads of "is this a repeat": the fleet's calibrated Jaccard
          // verdict, and a containment check sized for a short candidate
          // against a long caption (see `repeatsPublished`). Either drops it.
          const candidateText = `${candidate.topic}\n${candidate.angle}\n${candidate.hook}`;
          const verdict = evaluateDedupe(candidateText, outputHistory);
          if (verdict.status === "similar" || repeatsPublished(candidateText, outputHistory)) {
            droppedAsRepeats += 1;
            repeats.push(candidate);
            continue;
          }
          candidates.push(candidate);
        }
        if (droppedAsRepeats > 0) notes.push(`${droppedAsRepeats} candidate(s) dropped as too close to what the client recently published`);
        if (droppedAsCatalogRepeats > 0) notes.push(`${droppedAsCatalogRepeats} candidate(s) dropped as the same idea as a topic already in the lane`);
        notes.push(`research lens: ${researchLens}`);
        if (candidates.length === 0) {
          notes.push("every proposed candidate was excluded or a repeat");
          // The repeats are kept rather than discarded. They are a poor
          // answer — repetition across runs is the tell this dedupe exists to
          // remove — but "the freshest thing we could find, and here is what
          // it repeats" is a better answer than no deliverable, and the human
          // gate is where it gets refused. See `01-claim-topic`'s widen.
          return { candidates: [], seeded: 0, notes, repeats, rotation };
        }

        const seeded = await topUp.execute({ topics: candidates.map((c) => c.topic), lane: CLIP_LANE }, { ctx });
        if (seeded.status !== "success") {
          notes.push(`seeding the lane with discovered topics failed: ${seeded.status}`);
          return { candidates, seeded: 0, notes, repeats, rotation };
        }
        const { added } = seeded.result as { added: number; catalogSize: number };
        notes.push(`${added} discovered topic(s) landed in the ${CLIP_LANE} lane (${proposed.rationale})`);
        return { candidates, seeded: added, notes, repeats, rotation };
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
      if (runDirection.topicOverride) {
        // C7: a client's never-topic outranks a person's typed request, and it
        // HOLDS. Someone asked for this subject by name; clipping a different
        // one would read as having honoured the request. Before the scout,
        // before transcription and before any drafting model, so the refusal
        // costs nothing.
        const refused = touchesNeverTopic(runDirection.topicOverride, learning.preferences);
        if (refused !== undefined) {
          throw new WorkflowHeld(
            `"${runDirection.topicOverride}" touches a never-topic the client set ("${refused}") — nothing was drafted in its place`,
          );
        }
        return { topic: runDirection.topicOverride, topicSource: "requested" };
      }

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

      /**
       * ── NOTHING WAS RESERVED. Widen, rather than end with no deliverable ──
       *
       * This threw `WorkflowHeld`, quoting the legacy loop: *"a run with no
       * candidate logs that fact and exits cleanly. It never lowers the bar
       * to ship something."* That rule was superseded on 2026-09-17, and the
       * owner's ruling names THIS case in as many words — "no candidate topic
       * → widen and deliver annotated". The prose outlived the rule that made
       * it true, which is the third time in this file in two days.
       *
       * Three rungs, weakest excuse first. Every one of them is announced as
       * a `topic-source` repair, because a widened subject that arrives
       * looking like a chosen one is worse than the hold was.
       */

      // Rung 1 — discovery produced clean candidates and only the CATALOG
      // failed. The subject is exactly as good as the one that would have
      // been reserved; what is missing is bookkeeping, and bookkeeping is not
      // worth a client's run.
      const unreserved = discovery.candidates[0];
      if (unreserved !== undefined) {
        return {
          topic: unreserved.topic,
          topicSource: "widened",
          discovered: unreserved,
          topicNote: `the ${CLIP_LANE} lane could not reserve a topic, so this run went ahead on a freshly discovered subject without a catalog reservation — ${discovery.notes.join("; ")}`,
        };
      }

      // Rung 2 — everything discovery proposed was dropped for being too
      // close to something the client already said. A poor answer: repetition
      // across runs is the tell the dedupe exists to remove. Still a better
      // one than nothing, and the repeat is named so the reviewer can refuse
      // it at the gate on the facts rather than on a hunch.
      const freshest = discovery.repeats[0];
      if (freshest !== undefined) {
        return {
          topic: freshest.topic,
          topicSource: "widened",
          discovered: freshest,
          topicNote:
            `every subject discovery proposed was too close to something this client recently published; this run went ahead on the freshest of them anyway ` +
            `rather than returning nothing — check it against the recent posts before approving (${discovery.notes.join("; ")})`,
        };
      }

      /**
       * Rung 3 — discovery proposed nothing at all, so the subject has to
       * come from what we already KNOW about this client.
       *
       * Two sources, in order, and neither is a field anybody has to fill in
       * for this to work (owner, 2026-09-21: "there are all the documents on
       * a client, that is where you should be finding things that help you").
       * A `contentPillars` entry is the client's own declared answer to "what
       * should we be talking about" and is used when it exists; a profile has
       * an industry and a description on every client the portal onboards,
       * and a subject drawn from those is the client's own positioning rather
       * than something this run made up.
       *
       * The rotation is the one discovery already computed (the lane's row
       * count), so two runs in a row falling to this rung do not both land on
       * the same pillar, and it costs no second catalog read.
       */
      const pillars = intakeConfig.contentPillars;
      const pillar = pillars.length > 0 ? pillars[discovery.rotation % pillars.length] : undefined;
      if (pillar !== undefined) {
        return {
          topic: pillar,
          topicSource: "widened",
          topicNote:
            `the catalog lane is empty and discovery could not propose anything, so this run fell back to one of the client's own content pillars ` +
            `("${pillar}") rather than returning nothing — ${discovery.notes.join("; ")}`,
        };
      }
      // The profile, which every onboarded client has. `description` first —
      // it is the sentence the client wrote about themselves — and the
      // industry behind it, which is thin but is still about them.
      const fromProfile = (profile.description ?? "").trim() || (profile.industry ?? "").trim();
      if (fromProfile.length > 0) {
        // Trimmed to a catalog row's length. A whole paragraph is not a
        // subject, and the drafting steps read this as one.
        const subject = fromProfile.length <= 110 ? fromProfile : `${fromProfile.slice(0, 107).replace(/\s+\S*$/, "")}…`;
        return {
          topic: subject,
          topicSource: "widened",
          topicNote:
            `the catalog lane is empty, discovery could not propose anything and this client declares no content pillars, so the subject was taken from their own ` +
            `profile rather than returning nothing — a broad starting point, not a researched angle (${discovery.notes.join("; ")})`,
        };
      }

      // Nothing left. Not a domain dead end but an empty client: no catalog,
      // no footage, no research, no intel and no content pillars means this
      // run knows nothing about them to be about. That is the always-deliver
      // rule's "nobody to write for" carve-out, and the hold says what to add.
      throw new WorkflowHeld(
        `no ${CLIP_LANE} candidate to make and nothing to widen to: the catalog lane is empty, no footage was attached, discovery could not propose a subject, ` +
          `and this client has no content pillars, no profile description and no industry — there is nothing on record about them to be about. ` +
          `(${discovery.notes.join("; ")})`,
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
        // A PAGE rather than a file (RFC-25 phase 4). `media.ingestAssets`
        // does a plain GET, so a watch URL used to be written to disk as an
        // HTML document with an `.mp4` name and failed three steps later
        // inside `video.transcribe`. yt-dlp resolves it instead.
        if (!isDirectMediaUri(attached.uri)) {
          const harvest = tools["media.harvestVideo"];
          if (harvest === undefined || options.repoRoot === undefined) {
            tierOutcomes.push(`user-asset: "${attached.uri}" is a page rather than a media file, and this deployment cannot resolve one`);
          } else {
            const outcome = await harvest.execute({ repoRoot: options.repoRoot, runId: wf.runId, query: claim.topic, sourceUrl: attached.uri }, { ctx });
            if (outcome.status === "success") {
              const result = outcome.result as { path: string; sourceUrl: string; title?: string; channel?: string };
              return {
                ...base,
                sourcePath: path.resolve(options.repoRoot, result.path),
                sourceTier: "user-asset",
                sourceContext: {
                  url: result.sourceUrl,
                  ...(result.title ? { title: result.title } : {}),
                  ...(result.channel ? { channel: result.channel } : {}),
                  ...(attached.label ? { label: attached.label } : {}),
                  discovery: "pasted",
                },
              };
            }
            // The link did not resolve. With `mediaSource: "client"` that is
            // the end of it — 01a already refused anything else, and finding
            // a DIFFERENT video for someone who said "only my media" would be
            // answering a request with something else. Otherwise the cascade
            // carries on below and the reviewer is told what happened to the
            // link, which is a worse answer than they asked for and a better
            // one than nothing.
            const why = `${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`;
            if (runDirection.mediaSource === "client") {
              throw new WorkflowBlockedIntake(
                `the link attached to this run could not be resolved into a video (${why}), and this run is set to client-provided media only — ` +
                  "paste a different link, upload the file itself, or let the agent find footage",
              );
            }
            tierOutcomes.push(`user-asset: the link attached to this run ("${attached.uri}") could not be resolved into a video: ${why}`);
          }
        } else {
          const sourcePath = await ingestSourceVideo(attached, options, tools, wf.runId, ctx);
          return { ...base, sourcePath, sourceTier: "user-asset", sourceContext: { ...(attached.label ? { label: attached.label } : {}), url: attached.uri } };
        }
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

        /**
         * ── Tier 2c: the SHOW'S OWN FEED (2026-09-21) ──
         *
         * A podcast is published to be fetched, so this path has no bot
         * check, no login and no key. It is also a better question: the
         * YouTube harvest asks "is there a video of somebody saying this" and
         * takes whatever the index ranks, where this asks "is there a PODCAST
         * about this" and every answer is one by construction.
         *
         * The trade is the picture. An enclosure is audio, so the clip
         * carries the speakers' real words over sourced footage rather than
         * over the speakers themselves — a normal short-form format, and a
         * strictly better answer than the generated original short the
         * cascade falls to when no footage can be had at all.
         */
        const harvestPodcastTier = async (): Promise<TikTokIntake | undefined> => {
          const podcast = tools["media.harvestPodcast"];
          if (podcast === undefined || options.repoRoot === undefined) {
            tierOutcomes.push("podcast-feed: not wired in this deployment");
            return undefined;
          }
          const allowedShows = plainSourceNames(config);
          // Same ladder as the video harvest: the client's own shows first,
          // the open directory when that comes back empty. A pool that
          // answers ends the tier on one search.
          const postures: Array<"allowlist" | "open"> = allowedShows.length > 0 ? ["allowlist", "open"] : ["open"];
          for (const posture of postures) {
            const query = await wf.step.code(`01h-build-podcast-query-${posture}`, () =>
              posture === "open"
                ? buildHarvestQuery({
                    topic: claim.topic,
                    ...(profile.industry !== undefined ? { industry: profile.industry } : {}),
                    ...(claim.discovered !== undefined ? { discovered: claim.discovered } : {}),
                  })
                : claim.topic,
            );
            const outcome = await podcast.execute(
              {
                repoRoot: options.repoRoot,
                runId: wf.runId,
                query,
                allowedShows: posture === "allowlist" ? allowedShows : [],
                discovery: posture,
                // ON CAMERA ONLY, for now. A video episode is cut and framed
                // by the machinery this pipeline already has, and it is the
                // thing actually worth shipping: a clip of a podcast where
                // you can see the podcast. An AUDIO episode needs a
                // composition — the real audio under sourced plates — that is
                // not wired yet, and downloading one the run cannot use is
                // bandwidth spent to learn nothing. The tool reads the feed's
                // declared enclosure type, so this costs no download at all.
                requireVideo: true,
              },
              { ctx },
            );
            if (outcome.status === "success") {
              const result = outcome.result as { path: string; sourceUrl: string; title: string; showTitle: string; media: "video" | "audio" };
              return {
                ...base,
                ...(tierOutcomes.length > 0 ? { sourceNotes: [...tierOutcomes] } : {}),
                sourcePath: path.resolve(options.repoRoot, result.path),
                sourceTier: "podcast-feed",
                sourceContext: {
                  url: result.sourceUrl,
                  title: result.title,
                  channel: result.showTitle,
                  discovery: posture,
                  harvestQuery: query,
                },
              };
            }
            tierOutcomes.push(`podcast-feed (${posture}, "${query}"): ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
          }
          return undefined;
        };

        // Tier 2b — a web harvest by topic.
        //
        // TWO POSTURES since RFC-25 (owner ruling, 2026-09-20). A client with
        // a `sourcePool` gets the original, stronger one: the search is
        // confined to shows they hold clipping rights to. A client with an
        // EMPTY pool used to get a refusal here, and now gets an open search
        // of the whole provider instead — the owner weighed the exposure and
        // chose reach, and `docs/RFC-25-tiktok-clipping-sources.md` records
        // what was chosen over what.
        //
        // The posture is decided by the client's own data rather than by a run
        // input, deliberately: a client who has told us which shows they may
        // clip has made a statement about rights, and an open search would
        // quietly widen it. Setting a `sourcePool` is therefore how a client
        // opts back OUT, with no code change.
        const harvestVideoTier = async (): Promise<TikTokIntake | undefined> => {
        const harvest = tools["media.harvestVideo"];
        const allowedSources = plainSourceNames(config);
        /**
         * TWO ATTEMPTS, not one posture.
         *
         * RFC-25 §1 said this in so many words — *"`karoslabs`' own
         * `sourcePool` names 'The Karos Labs Podcast', which has no YouTube
         * channel, so the harvest tier has correctly refused every run since
         * 2026-09-11 and looked broken while doing it. With open discovery
         * that client gets a real search instead of a refusal."* — and the
         * code did not do it. `discovery` was chosen ONCE from whether the
         * pool was empty, so a client WITH a pool never reached the open
         * branch at all, and the one case the RFC named as fixed was the one
         * case still broken. Confirmed by prep run pubsub-21912059758236775
         * (2026-09-20), which held with "The Karos Labs Podcast: 0 result(s)".
         *
         * A pool is a statement about rights, so it still goes FIRST and an
         * answer from it ends the tier. What a pool is not is a statement
         * that the client would rather have nothing than an open search —
         * that reading turns a configuration convenience into a veto nobody
         * cast. A client who does want the narrow posture enforced says so
         * with `mediaSource: "client"`, which 01a already refuses outright.
         */
        const postures: Array<"allowlist" | "open"> = allowedSources.length > 0 ? ["allowlist", "open"] : ["open"];
        if (harvest === undefined || options.repoRoot === undefined) {
          tierOutcomes.push("web-harvest: not wired in this deployment");
        } else {
          for (const discovery of postures) {
            // The catalog row is a good SUBJECT for a short and a poor QUERY
            // for a video search — see `buildHarvestQuery`. Its own step, so a
            // prep run that comes back with a bad clip shows the query that
            // found it in the trace rather than leaving it to be
            // reconstructed. The id carries the posture because both legs can
            // run in one cascade and a shared id would overwrite the first.
            const harvestQuery = await wf.step.code(`01f-build-harvest-query-${discovery}`, () =>
              discovery === "open"
                ? buildHarvestQuery({
                    topic: claim.topic,
                    ...(profile.industry !== undefined ? { industry: profile.industry } : {}),
                    ...(claim.discovered !== undefined ? { discovered: claim.discovered } : {}),
                  })
                : // Inside an allowlist search the show name does the narrowing,
                  // so the topic only has to pick an episode out of one feed and
                  // the raw row is the better query.
                  claim.topic,
            );
            const outcome = await harvest.execute(
              {
                repoRoot: options.repoRoot,
                runId: wf.runId,
                query: harvestQuery,
                // Empty on the open leg. The tool documents `allowedSources`
                // as ignored under `discovery: "open"` and the provider returns
                // before reading it, but sending a rights list into a search
                // that does not honour it is a line that will eventually be
                // read as one that does.
                allowedSources: discovery === "allowlist" ? allowedSources : [],
                discovery,
              },
              { ctx },
            );
            if (outcome.status === "success") {
              const result = outcome.result as { path: string; sourceUrl: string; title?: string; channel?: string };
              return {
                ...base,
                // Every tier that already failed, carried forward by the tier
                // that served. Until now only the stock tier passed these on, so
                // a pasted link that did not resolve vanished the moment the
                // harvest answered — and the reviewer saw a clean clip with no
                // sign that they had asked for a different video. A failed
                // allowlist leg lands here too, which is how a reviewer learns
                // the client's own source list came up empty.
                ...(tierOutcomes.length > 0 ? { sourceNotes: [...tierOutcomes] } : {}),
                sourcePath: path.resolve(options.repoRoot, result.path),
                sourceTier: "web-harvest",
                sourceContext: {
                  url: result.sourceUrl,
                  ...(result.title ? { title: result.title } : {}),
                  ...(result.channel ? { channel: result.channel } : {}),
                  // How this footage was found, carried to the reviewer. "We
                  // searched the open web for this" is a fact about the clip,
                  // not an implementation detail, and it is the one thing a
                  // person approving it most needs to know.
                  discovery,
                  harvestQuery,
                },
              };
            }
            tierOutcomes.push(`web-harvest (${discovery}, "${harvestQuery}"): ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
          }
        }
        return undefined;
        };

        // The order the owner ruled: the feed by default, YouTube first only
        // where a cookies file makes it likely to answer at all.
        for (const tier of options.youtubeHarvestPreferred === true ? [harvestVideoTier, harvestPodcastTier] : [harvestPodcastTier, harvestVideoTier]) {
          const served = await tier();
          if (served !== undefined) return served;
        }
      }

      // Tier 3 — an original short over stock footage (a generated still for
      // a beat no library has). The only tier that can answer any topic on
      // demand, and the one `mode: "commentary"` forbids. Nothing is fetched
      // HERE: the plates are found per beat once the script exists, because a
      // plate is a scene from a script, not a picture of a topic.
      if (tools["video.findStockClip"] === undefined || options.repoRoot === undefined) {
        tierOutcomes.push(`stock: not wired in this deployment (${options.repoRoot === undefined ? "no repoRoot configured" : "video.findStockClip is not registered — set PEXELS_API_KEY"})`);
      } else if (config.mode !== "commentary") {
        // The notes travel with the intake: the reviewer sees why this is
        // stock and not the client's own footage, beside the play button.
        return { ...base, sourceTier: "stock", sourceNotes: tierOutcomes };
      } else {
        /**
         * COMMENTARY MODE WITH NOTHING TO COMMENT ON.
         *
         * `mode: "commentary"` forbidding stock is a real product rule: a
         * commentary clip is a clip of somebody's words, and an original
         * short over stock footage is a different thing. It used to end the
         * run here, and the comment beneath called the hold "honest".
         *
         * It was honest and it was still wrong. The owner's standing ruling
         * (2026-09-17) is that an agent never ends a run with no deliverable
         * — "fall back, redact, warn, or annotate on the output, but always
         * deliver a result" — and names this exact shape: no candidate topic
         * → widen and deliver annotated. A held clipping run bills a client
         * an error message in place of the work, and "we could not find a
         * podcast about your topic" is a domain-level problem, not one of the
         * three carve-outs (nobody to write for, a human rejected it, a
         * genuine tooling failure).
         *
         * So the mode yields to the rule, LOUDLY. This is a substitution the
         * reviewer is told about in `contentRepairs` and at the gate, not a
         * quiet re-interpretation of what they asked for: a worse answer than
         * they wanted, and a better one than nothing. The honest refusal is
         * still available to anyone who wants it — `mediaSource: "client"`
         * with no attachment is `blocked_intake` at 01a, which is somebody
         * actually saying "only my footage, or don't bother".
         */
        return {
          ...base,
          sourceTier: "stock",
          sourceNotes: tierOutcomes,
          modeSubstitution:
            "this client's clipping agent is set to \"commentary\" — a clip of somebody else's words — and no tier could find a recording to clip, " +
            "so the run made an original short over stock footage instead of returning nothing",
        };
      }

      // Every tier dry AND no stock tier to fall back on: the deployment is
      // missing `video.findStockClip` or a repoRoot, which is a tooling
      // failure rather than a fact about this client's topic. The one
      // remaining hold, and it names what each tier said.
      if (claim.reservationKey) {
        await tools["topics.release"]?.execute({ reservationKey: claim.reservationKey }, { ctx }).catch(() => undefined);
      }
      throw new WorkflowHeld(`no source footage from any tier — ${tierOutcomes.join("; ")}`);
    });

    /**
     * ── 01g: is this recording worth clipping, for THIS client? (RFC-25 §3) ──
     *
     * Before `02-transcribe`, deliberately. Transcribing a two-hour podcast is
     * the most expensive step in the run, and a check placed after it can only
     * tell a reviewer the source was wrong once the run has already paid to
     * find out. Title and channel are enough for the failures this exists for
     * — a clip farm names itself, a competitor's show names itself.
     *
     * Only for HARVESTED footage. An attached upload and a pasted link are the
     * client's own choice, and second-guessing a decision somebody already
     * made is not what this is for.
     *
     * It MARKS and never blocks: a `content_fail` or an outage leaves the run
     * exactly as it was, and a low score reaches the human at 11-clip-review
     * with the model's own sentence beside it.
     */
    const sourceFit = await wf.step.code("01g-source-fit", async (): Promise<{ skipped: true; note: string } | { skipped: false; score: number; reason: string; concerns: string[] }> => {
      if (intake.sourceTier !== "web-harvest") return { skipped: true, note: `not a harvested source (${intake.sourceTier})` };
      const agent = new TikTokSourceFitAgent({ router: options.router, tools, promptStore: options.promptStore });
      const exec = await wf.step.agent("01g-source-fit-judge", agent, {
        sourceTitle: intake.sourceContext?.title ?? "(the search returned no title)",
        sourceChannel: intake.sourceContext?.channel ?? "(the search returned no channel)",
        ...(intake.sourceContext?.url !== undefined ? { sourceUrl: intake.sourceContext.url } : {}),
        discovery: intake.sourceContext?.discovery ?? "allowlist",
        ...(intake.sourceContext?.harvestQuery !== undefined ? { harvestQuery: intake.sourceContext.harvestQuery } : {}),
        topic: intake.topic,
        clientProfile: profile,
        ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
      });
      if (exec.status === "content_fail") return { skipped: true, note: "the source-fit judge returned nothing schema-valid; the reviewer judges the source unaided" };
      if (exec.status !== "completed") return { skipped: true, note: `the source-fit judge resolved to "${exec.status}"; the reviewer judges the source unaided` };
      const verdict = SourceFitSchema.parse(exec.finalOutput);
      if (verdict.score < MIN_SOURCE_FIT || verdict.concerns.length > 0) {
        console.warn(`01g-source-fit: scored ${verdict.score}/10 — ${verdict.reason}${verdict.concerns.length > 0 ? ` (${verdict.concerns.join("; ")})` : ""}`);
      }
      return { skipped: false, score: verdict.score, reason: verdict.reason, concerns: verdict.concerns };
    });

    // `let`: on `auto`, a client's footage with no speech in it turns a
    // commentary clip into an original short over that footage (see
    // 02-transcribe). On the two named variants the format is the product, so
    // it is decided here and never moves — which is the whole point of the
    // split: before it, what a run produced fell out of whichever sourcing
    // tier happened to answer, and nobody pressing a button could predict it.
    /**
     * THE SOURCE OUTRANKS THE BUTTON, and only here.
     *
     * The variant pin is right about everything else: what a run produces
     * should not fall out of whichever sourcing tier happened to answer, and
     * somebody pressing "clipping" should get a clip. But a `stock` intake has
     * no source video AT ALL — its plates are found per beat once a script
     * exists — so `commentary-clip` over one does not mean "a worse clip", it
     * means calling `video.cutClip` and `video.brandFrame` with an undefined
     * path. That is a physical fact about the intake, not a preference.
     *
     * It could not happen before 2026-09-20: `mode: "commentary"` forbade the
     * stock tier and a dry cascade held, so a clipping run could never reach
     * here with `sourceTier: "stock"`. PR #170 made the cascade deliver an
     * original short rather than hold, and this line kept pinning the format
     * to the button — prep run pubsub-21908845348121079 got all the way to
     * `08-render` before failing with `videoPath: undefined`. Widening what a
     * producer can be handed means re-reading everything downstream that
     * assumed the old narrower set.
     */
    let format: ClipFormat = intake.sourceTier === "stock" ? "original-short" : (formatForVariant(variant) ?? "commentary-clip");
    /**
     * Set when this run is delivering a different KIND of short than the
     * client's mode or the pressed product asks for — carried to the reviewer
     * as a `clip-mode` repair. Seeded from the intake (a dry cascade) and also
     * set below (footage with no speech in it).
     */
    let modeSubstitution: string | undefined = intake.modeSubstitution;
    /** The client's own silent footage, when it is what the plates are cut from. */
    let clientFootage: { path: string; durationSeconds: number } | undefined;

    /**
     * The run's cost ceiling: the product rule, lowered (never raised) by the
     * client's own `maxRunCostUsd`, and by a dispatcher budget tighter than both.
     */
    const costCapUsd = Math.min(MAX_RUN_COST_USD, config.maxRunCostUsd ?? MAX_RUN_COST_USD, wf.budget?.maxTotalCostUsd ?? MAX_RUN_COST_USD);
    /**
     * What the run PLANS against, as opposed to what it may never exceed.
     *
     * Clamped to the ceiling so a client whose own `maxRunCostUsd` is below the
     * fleet target still plans against their number: a target above the wall
     * would have the ladder decide nothing until the wall stopped it, which is
     * the pre-2026-09-18 behaviour under a new name.
     */
    const targetSpendUsd = Math.min(TARGET_RUN_SPEND_USD, costCapUsd);


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
    /**
     * Set when the cut was chosen by code rather than by the picker - a picker
     * that returned nothing schema-valid, or a window that would not snap into
     * a legal clip. Carried to the reviewer and onto the deliverable, because a
     * clip nobody CHOSE is exactly the thing a person at the gate should know
     * they are watching.
     */
    let momentFallback: string | undefined;
    /**
     * What names this run's source recording in the cross-run ledger.
     *
     * The harvested URL, the attached asset's URI, or a dispatched path —
     * whichever this run actually read. `undefined` for a stock-footage
     * original short, which is assembled rather than cut, so there is no
     * recording to have used part of.
     */
    const clipSourceKey: string | undefined = intake.sourceContext?.url ?? (intake.sourceTier === "stock" ? undefined : intake.sourcePath);
    /** Set when the cut is under the watchability floor and nothing in the transcript scored better. */
    let momentFloorNote: string | undefined;
    /** Observations the floor made that never decided anything — carried to the reviewer, never acted on. */
    const momentFloorNotes: string[] = [];

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
      const transcript = await wf.step.code("02-transcribe", async (): Promise<{ words: TranscriptWordLike[]; durationSeconds: number | null }> => {
        const result = (await callTool(tools, "video.transcribe", { videoPath: intake.sourcePath }, ctx)) as {
          words?: TranscriptWordLike[];
          durationSeconds?: number;
        };
        const spoken = (result.words ?? []).filter((w) => typeof w.text === "string" && w.text.trim().length > 0);
        return { words: spoken, durationSeconds: typeof result.durationSeconds === "number" ? result.durationSeconds : null };
      });
      const words = transcript.words;

      if (words.length === 0) {
        // ── A SILENT source (2026-09-10): a screen demo, a b-roll reel, a
        //    music-only edit. Until now this held ("no spoken words to clip"):
        //    two of the audit's eleven runs died here. There is no moment to
        //    pick, but there is footage the client chose to send, and the
        //    original-short lane knows how to write a message over footage.
        //    So: the run becomes an original short on the run's topic, and
        //    its plates are cut from the client's own file, evenly across it,
        //    instead of found in a library. A file too short to cover a short
        //    without frozen frames falls back to library plates. ──
        if (intake.topicSource === "footage") {
          await releaseReservation();
          throw new WorkflowHeld("the attached footage has no spoken words and the run named no topic to write over it: add a requestedTopic or a customPrompt, or attach footage with speech");
        }
        if (intake.sourcePath !== undefined && transcript.durationSeconds !== null && transcript.durationSeconds >= MIN_CLIENT_FOOTAGE_SECONDS) {
          clientFootage = { path: intake.sourcePath, durationSeconds: transcript.durationSeconds };
        } else {
          console.warn(`02-transcribe: the silent source is ${transcript.durationSeconds ?? "of unknown length"} s, under ${MIN_CLIENT_FOOTAGE_SECONDS}; the short's plates come from the library instead`);
        }
        if (variant === "clipping") {
          // REVERSED 2026-09-20. This threw `WorkflowHeld`, reasoning that the
          // clipping agent does not write scripts and that handing back a
          // scripted short would be answering a request with something else.
          //
          // That is the same argument the dry cascade used, and the owner's
          // standing ruling (2026-09-17) settled it the other way: a
          // domain-level dead end is fall-back-and-annotate, not one of the
          // three carve-outs. Leaving this hold in place would also make the
          // agent answer two identical situations differently — footage with
          // no speech held, a cascade with no footage delivered — which is
          // worse than either answer on its own.
          //
          // The client's own file is right here and the lines below already
          // know how to write over it. So it ships, and says so.
          modeSubstitution =
            "this run was dispatched as a clipping run — a cut from somebody's spoken words — and the footage it was given has no speech in it, " +
            (clientFootage !== undefined
              ? "so the run wrote an original short over the client's own footage instead of returning nothing"
              : "and is too short to cut plates from, so the run wrote an original short over library footage instead of returning nothing");
        }
        format = "original-short";
        moment = await wf.step.code("03-select-moment", () => ({
          startSeconds: 0,
          endSeconds: CLIP_DURATION_MIN_SECONDS,
          hookLine: intake.topic,
          hookType: "sharp-one-liner" as const,
          rationale: clientFootage !== undefined ? "silent source — the script carries the message over the client's own footage, cut evenly across it" : "silent source too short to cut from — the script carries the message over library footage",
        }));
        bounds = { startSeconds: 0, endSeconds: 0, words: [], text: "", needsCut: false };
      } else {
      // ── 03: PICK-moment (judgment) ──
      moment = await wf.step.code("03-select-moment", async () => {
        const agent = new TikTokMomentAgent({ router: options.router, tools, promptStore: options.promptStore });
        const alreadyClipped = clipSourceKey !== undefined ? clippedWindowDirective(clipSourceKey, shapeMemory.clippedWindows) : undefined;
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
          // What this client has already published OUT OF THIS RECORDING
          // (2026-09-19). The topic catalog stops the same subject being made
          // twice; nothing stopped the same forty seconds of the same episode
          // being cut twice, and a client with one long podcast and a broad
          // topic could meet overlapping clips weeks apart. A steer, not an
          // exclusion - see `clippedWindowDirective`.
          ...(alreadyClipped !== undefined ? { alreadyClipped } : {}),
        });
        if (exec.status === "content_fail") {
          // The picker produced nothing schema-valid. The transcript is still
          // in hand and demonstrably contains speech, so the densest legal run
          // of whole sentences in it is the clip: a worse moment than a model
          // would have chosen, and a clip rather than a dead run. The reviewer
          // is told which it is, at the gate, beside the play button.
          const fallback = bestLegalWindow(words, { minSeconds: CLIP_DURATION_MIN_SECONDS, maxSeconds: CLIP_DURATION_MAX_SECONDS });
          if (fallback === undefined || !fallback.ok) {
            // No run of whole sentences fits between the floor and the
            // ceiling. There is genuinely nothing clippable in this recording,
            // which is the carve-out's "no material", not a quality event.
            await releaseReservation();
            throw new WorkflowHeld(
              "moment selection did not clear its own output validation, and no run of whole sentences in the transcript is a legal clip " +
                `(${CLIP_DURATION_MIN_SECONDS}-${CLIP_DURATION_MAX_SECONDS}s) to fall back to`,
            );
          }
          momentFallback = "the moment picker returned nothing usable; the densest legal run of whole sentences in the transcript was cut instead";
          return {
            startSeconds: fallback.startSeconds,
            endSeconds: fallback.endSeconds,
            hookLine: fallback.text.split(/(?<=[.!?])\s+/)[0]?.slice(0, 200) ?? intake.topic,
            hookType: "sharp-one-liner" as const,
            rationale: "chosen in code: the moment picker produced nothing schema-valid, so the densest run of complete sentences was taken",
          };
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
          // The model's window does not snap into a legal clip - it collapsed,
          // ran past the ceiling, or fell under the floor. That is a bad
          // proposal, not an unusable recording: the same transcript almost
          // always holds a legal run of whole sentences, and taking it is
          // strictly better than ending a run that has already paid for the
          // transcription. `boundsFromTranscript` still refuses to CLAMP the
          // model's window - shipping the first 120s of a 200s answer would
          // drop the payoff the moment was picked for - so the fallback picks
          // a whole window of its own rather than truncating this one.
          const widened = bestLegalWindow(words, { minSeconds: CLIP_DURATION_MIN_SECONDS, maxSeconds: CLIP_DURATION_MAX_SECONDS });
          if (widened === undefined || !widened.ok) {
            await releaseReservation();
            throw new WorkflowHeld(`selected moment is not clippable (${result.reason}) and no run of whole sentences in the transcript is a legal clip either`);
          }
          momentFallback = `the picked moment was not clippable (${result.reason}); the densest legal run of whole sentences was cut instead`;
          return widened;
        }
        return result;
      });
      // ── 04b: the moment FLOOR (2026-09-18) ──
      //
      // `04-cut-bounds` proves the window is LEGAL. Nothing until now asked
      // whether it was worth watching, and the 2026-09-08 audit's clips
      // included forty seconds of someone clearing their throat.
      //
      // Blocking measures only — density and a filler opening, both counted
      // rather than judged. A refused window is RE-PICKED, never held: the
      // deterministic picker already sorts by density, so it is the natural
      // second opinion, and it is taken only when it genuinely scores better.
      // A model that chose a sparse window for a reason code cannot see keeps
      // its choice when nothing better exists.
      const floor = await wf.step.code("04b-moment-floor", async () => {
        const first = scoreMoment(words, cut.startSeconds, cut.endSeconds);
        if (first.ok) return { ...first, replaced: null as null | { startSeconds: number; endSeconds: number; text: string; words: TranscriptWordLike[] } };
        const alternative = bestLegalWindow(words, { minSeconds: CLIP_DURATION_MIN_SECONDS, maxSeconds: CLIP_DURATION_MAX_SECONDS });
        if (alternative === undefined || !alternative.ok) return { ...first, replaced: null };
        const second = scoreMoment(words, alternative.startSeconds, alternative.endSeconds);
        if (!second.ok || second.wordsPerSecond <= first.wordsPerSecond) return { ...first, replaced: null };
        return {
          ...second,
          replaced: { startSeconds: alternative.startSeconds, endSeconds: alternative.endSeconds, text: alternative.text, words: alternative.words },
        };
      });
      if (floor.replaced !== null) {
        momentFallback =
          `the picked moment was under the watchability floor (${floor.failures.join("; ")}); ` +
          `the densest legal run of whole sentences was cut instead (${floor.wordsPerSecond.toFixed(2)} words a second)`;
        bounds = { startSeconds: floor.replaced.startSeconds, endSeconds: floor.replaced.endSeconds, words: floor.replaced.words, text: floor.replaced.text, needsCut: true };
      } else {
        if (!floor.ok) {
          // Nothing better existed. The clip ships and the reviewer is told
          // exactly what is wrong with it, which is more than they had before.
          momentFloorNote = floor.failures.join("; ");
          console.warn(`04b-moment-floor: ${momentFloorNote}; nothing in this transcript scores better, shipping flagged`);
        }
        bounds = { startSeconds: cut.startSeconds, endSeconds: cut.endSeconds, words: cut.words, text: cut.text, needsCut: true };
      }
      if (floor.notes.length > 0) momentFloorNotes.push(...floor.notes);
      }
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
      // A `gs://` logoUrl is a real BrandKit misconfiguration, and dropping
      // it to `undefined` here made it indistinguishable from a client who
      // configured no logo at all: no logo on the cover, no error, no held
      // run, nothing in the trace. instagram-agent fixed exactly this in
      // SCRUM-383 (`brand-render-tokens.ts`) and its comment cites THIS
      // derivation as the precedent it was matching — true of the accept
      // rule and not of the diagnostic, so the two agents have been half
      // agreeing ever since. This is the other half.
      //
      // The reason is recorded, not thrown, and nothing downstream reads it:
      // brand furniture must never be able to hold a run (the same invariant
      // `prepareLogo` below follows, where every download failure is silently
      // no logo). `07b-load-video-brand` is a `wf.step.code`, so its return
      // value is in the run trace — which is where the fact "this client's
      // logo was rejected, and here is the URL that was rejected" now lives.
      //
      // Scoped to `gs://` only, deliberately and for the same reason
      // SCRUM-383 gave: a `javascript:`/`file://` value is not a real-world
      // BrandKit misconfiguration, and keeps failing the way it always has.
      let logoUrl: string | undefined;
      let rejectedLogoUrlReason: string | undefined;
      {
        const raw = brand["logoUrl"];
        if (typeof raw === "string") {
          if (/^https:\/\//i.test(raw)) {
            logoUrl = raw;
          } else if (/^gs:\/\//i.test(raw)) {
            rejectedLogoUrlReason =
              `brand logoUrl "${raw}" is a gs:// URL, not https:// — downloadBrandLogo (@agent-engine/tool-karos-media) ` +
              "fetches only https:// URLs, so the cover renders with no logo. Recorded here rather than dropped " +
              "silently (SCRUM-383's fix, applied to tiktok-agent).";
          }
        }
      }
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
        ...(rejectedLogoUrlReason !== undefined ? { rejectedLogoUrlReason } : {}),
        ...(language !== undefined ? { language } : {}),
      };
    });

    /**
     * The run's language, decided ONCE by code (2026-09-18).
     *
     * Everything downstream reads `targetLanguage.tag` and nothing reads a
     * `??` chain any more. The old chain ended in the model's own
     * `script.language`, which is the writer telling us what it chose to
     * write — the very thing the check below exists to verify — so a draft in
     * the wrong language used to mark its own homework, and the caption font,
     * the voice and the QA model's expectations were each resolved separately
     * from it.
     */
    const targetLanguage: ResolvedTargetLanguage = await wf.step.code("02d-resolve-target-language", () =>
      resolveTargetLanguage({
        ...(config.voiceLanguage !== undefined ? { configuredLanguage: config.voiceLanguage } : {}),
        ...(videoBrand.language !== undefined ? { brandLanguage: videoBrand.language } : {}),
        // The client's own words about themselves. A Hebrew client whose
        // config nobody filled in still gets a Hebrew short out of this.
        clientProse: [profile.description, profile.name, clientIntelContext].filter((v) => typeof v === "string" && v.length > 0).join("\n"),
      }),
    );

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
      fit: "contain" | "cover" | "blur-fill" = "contain",
      captionFontName?: string,
      captionsAssPath?: string,
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
          ...(captionsAssPath !== undefined ? { captionsAssPath } : {}),
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
      visualQa?: {
        passed: boolean;
        reason?: string;
        evidence: string[];
        weakBeats?: Array<{ index: number; relevance: number; note: string }>;
        /** The model's read on where the CUT falls. Commentary clips only — an original short is assembled, not cut. */
        moment?: { opensOnCompleteThought: boolean; closesAfterPayoff: boolean; note: string };
      };
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
      /**
       * What this round had to repair on its way to a clip, in the order it
       * did — a redacted sentence, an appended source credit, a beat whose
       * footage nothing could serve, a check nothing could satisfy.
       *
       * The owner's always-deliver rule (2026-09-17) is only honest with this
       * attached: a run that repairs silently is worse than one that holds,
       * because the client cannot tell the difference between a clean clip and
       * a salvaged one. Empty on the normal path and omitted from the
       * deliverable entirely, so a clean run produces the bytes it always did.
       */
      repairs?: ContentRepair[];
    }

    /**
     * The ledger line for a draft that was still too close to a published post
     * after its last redraft, or nothing when it came back clean.
     *
     * `unresolved`, not `redacted`: nothing was fixed. The words went out as
     * written, and the only honest thing left is to put the number in front of
     * the person deciding whether to publish them.
     */
    const dedupeRepair = (verdict: DedupeVerdict): ContentRepair[] =>
      verdict.status !== "similar"
        ? []
        : [
            {
              check: "output-dedupe",
              action: "unresolved" as const,
              detail:
                `this draft is ${Math.round(verdict.maxSimilarity * 100)}% similar to a post this client already published` +
                `${verdict.mostSimilarRunId !== undefined ? ` (run ${verdict.mostSimilarRunId})` : ""}, over the ${Math.round(verdict.threshold * 100)}% threshold, ` +
                `and the writer was already asked once to move away from it`,
            },
          ];

    /**
     * A drafting step's result: the draft itself, and what producing it had to
     * adapt around.
     *
     * The repairs travel INSIDE the step's return value rather than in an
     * array the closure pushes to, and that is the whole point of the type. A
     * `wf.step.code` result is checkpointed; a side effect on a captured array
     * is not. On a replay - which every run that waits at a human gate performs
     * - the step short-circuits on its checkpoint, the push never happens, and
     * a deliverable that WAS assembled by the deterministic fallback would come
     * back claiming a writer wrote it.
     */
    interface Drafted<T> {
      value: T;
      repairs: ContentRepair[];
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
    ): Promise<{ draft: T; verdict: DedupeVerdict }> => {
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
        // The VERDICT comes back with the draft (2026-09-19). This loop's own
        // doc comment has always claimed that on the final attempt a `similar`
        // draft "ships FLAGGED rather than held" — and it did not: the verdict
        // was written to a step checkpoint and dropped on the floor, so a
        // caption 70% identical to one this client published last week reached
        // the reviewer looking exactly like a clean one. The checkpoint is an
        // audit trail, not a channel to a human.
        return { draft: drafted, verdict };
      }
      // Unreachable: the loop's last attempt always returns, because the
      // `continue` above is guarded on `attempt < MAX_DEDUPE_ATTEMPTS`.
      throw new WorkflowToolingFailure("the de-duplication redraft loop ended without a draft");
    };

    /**
     * One field the compliance pass may rewrite.
     *
     * `shape` decides which floor applies, and getting it wrong is how a
     * repair quietly destroys a field: `prose` (a caption, an `about`, a
     * beat's narration) loses the whole SENTENCE carrying a flagged span,
     * which is right for a paragraph and catastrophic for a three-word title
     * card. `line` (`onScreenText`, a hook) loses the SPAN and keeps the line.
     */
    interface GatedField {
      key: string;
      text: string;
      shape: "prose" | "line";
    }

    /**
     * The deterministic text gates every caption clears before anything is
     * rendered — and, since the owner's rule of 2026-09-17, the place they
     * REPAIR rather than hold.
     *
     * Until now each of these four threw `WorkflowHeld`, so one forbidden
     * superlative in one sentence of an `about` cost the client the entire
     * clip: the transcript, the moment, the cut, every plate and the render
     * that had already been paid for. None of those four is a fault — they
     * are quality events, and RFC-19's carve-out is explicit that a quality
     * event must still hand the client something, marked.
     *
     * All four are span-flagging gates that report the offending literal as
     * it appears in the draft, which is exactly the shape
     * `redactSentencesCarrying` / `stripSpansFrom` are the deterministic floor
     * for. The four run as ONE verdict rather than four sequential holds,
     * because `runCheckWithRepair` keeps a repair only when strictly fewer
     * pieces of evidence remain — scored gate by gate, fixing the lint problem
     * while a brand-compliance problem stood would look like no progress and
     * be discarded.
     *
     * A field that would be emptied entirely keeps its original text and the
     * failure is recorded `unresolved`. A caption is a required field: a clip
     * that ships with a flagged sentence AND the flag beside it is honest,
     * where a clip with no caption is broken.
     *
     * `tooling_error` still throws. A gate that could not RUN has made no
     * judgment, and treating that as a pass would ship precisely what the gate
     * exists to catch.
     */
    const runTextGates = async (fields: readonly GatedField[]): Promise<{ text: Record<string, string>; repairs: ContentRepair[] }> => {
      const RULE = "tiktok-text-gates";
      const asRecord = (list: readonly GatedField[]): Record<string, string> => Object.fromEntries(list.map((f) => [f.key, f.text]));

      const verify = async (value: readonly GatedField[]) => {
        const text = value
          .map((f) => f.text)
          .filter((t) => t.trim().length > 0)
          .join("\n\n");
        const evidence: string[] = [];
        const reasons: string[] = [];
        for (const gate of ["gate.lintPost", "gate.brandCompliance", "gate.noPlaceholder", "gate.leakCheck"] as const) {
          const verdict = await runGate(tools, gate, { text }, ctx);
          if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`${gate}: ${verdict.reason}`);
          if (verdict.verdict === "content_fail") {
            evidence.push(...verdict.evidence);
            reasons.push(`${gate}: ${verdict.reason}`);
          }
        }
        return reasons.length === 0 ? localPass(RULE) : localContentFail(RULE, reasons.join("; "), evidence);
      };

      const outcome = await runCheckWithRepair<readonly GatedField[]>({
        check: RULE,
        value: fields,
        verify,
        attempts: [
          {
            action: "redacted",
            // Mechanical and monotone: each pass removes at least one flagged
            // span or reports that it located none, so three passes clear a
            // draft carrying three unrelated problems without spinning.
            maxPasses: 3,
            run: (value, verdict) => {
              const spans = spansFromEvidence(verdict.evidence);
              if (spans.length === 0) return undefined;
              let changed = false;
              const next = value.map((field) => {
                if (field.text.trim().length === 0) return field;
                let repairedText: string;
                let removed: number;
                if (field.shape === "prose") {
                  const redacted = redactSentencesCarrying(field.text, spans);
                  repairedText = redacted.text;
                  removed = redacted.droppedSentences;
                } else {
                  const stripped = stripSpansFrom(field.text, spans);
                  // `emptied` means the line WAS the flagged span; the
                  // original is returned unchanged in that case, so treating
                  // it as no progress is both true and what keeps the field.
                  repairedText = stripped.text;
                  removed = stripped.emptied ? 0 : stripped.strippedSpans.length;
                }
                // Emptied is not repaired. The original stands and the gate's
                // objection rides to the reviewer instead.
                if (removed === 0 || repairedText.trim().length === 0) return field;
                changed = true;
                return { ...field, text: repairedText };
              });
              return changed ? next : undefined;
            },
          },
        ],
        describeUnresolved: (verdict) => `${verdict.reason} — the clip ships with this noted rather than withheld`,
      });

      return { text: asRecord(outcome.value), repairs: outcome.repairs };
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
      const commentaryDraft = await draftWithVerifiedDedupe<Drafted<Commentary>>(
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
              // ── C7: the same instructions the script writer gets (D41) ──
              slotStage: stage,
              ...(craftRulesForPrompt(learning.craft) !== undefined ? { craftRules: craftRulesForPrompt(learning.craft) } : {}),
              ...(feedbackForPrompt(learning.feedback).length > 0 ? { clientFeedback: feedbackForPrompt(learning.feedback) } : {}),
              ...(preferencesForDrafting(learning.preferences) !== undefined ? { clientPreferences: preferencesForDrafting(learning.preferences) } : {}),
              ...(learning.platformState !== undefined ? { platformState: platformStateForDrafting(learning.platformState) } : {}),
              hookLine: moment.hookLine,
              hookType: moment.hookType,
              clipText: bounds.text,
              // The caption is the one thing the client pastes into TikTok, so
              // it is written in THEIR language, not the language of whoever
              // was speaking in the footage. A Hebrew client clipping an
              // English podcast writes a Hebrew take on it.
              contentLanguage: targetLanguage.tag,
              // What the footage ACTUALLY is, so the credit names it rather
              // than a plausible episode.
              ...(intake.sourceContext ? { sourceContext: intake.sourceContext } : {}),
              // What the fit judge made of the recording (RFC-25 phase 5). Its
              // `reason` often names the connection between this clip and the
              // client's business faster than the transcript does, which is
              // the one thing v6 requires the caption to carry. Never quoted
              // and never shown to a viewer.
              ...(sourceFit.skipped ? {} : { sourceFit: { score: sourceFit.score, reason: sourceFit.reason, ...(sourceFit.concerns.length > 0 ? { concerns: sourceFit.concerns } : {}) } }),
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
              // The writer produced nothing schema-valid. Everything the
              // caption needs already exists in this run and none of it is
              // invented: the line the moment was picked for, what the footage
              // actually is, and how long the cut runs. Assembling those is a
              // plainer caption than a writer would have produced and a real
              // deliverable a reviewer can edit, which is the trade the
              // always-deliver rule asks for. Recorded `unresolved`, so nobody
              // mistakes it for the writer's work.
              const credit = intake.sourceContext?.title ?? intake.sourceContext?.channel ?? intake.sourceContext?.label ?? "the source recording";
              const assembled = normalizeCommentaryDashes({
                caption: `${moment.hookLine.trim()}

${credit}`,
                about: `A ${Math.round(bounds.endSeconds - bounds.startSeconds)}s clip from ${credit}. The commentary writer returned nothing usable on this run, so this caption is the clip's own opening line plus the credit - rewrite it before publishing.`,
                sourceCredit: credit,
              });
              return {
                value: assembled,
                repairs: [
                  {
                    check: "commentary-draft",
                    action: "unresolved" as const,
                    detail: "the commentary writer returned nothing schema-valid; the caption was assembled from the clip's own hook line and source credit, and wants an edit before it goes out",
                  },
                ],
              };
            }
            if (exec.status !== "completed") {
              throw new WorkflowToolingFailure(`commentary step resolved to "${exec.status}"`);
            }
            // The one mechanical tell repaired in code before anything scores
            // or gates the text (see `normalizeBannedDashes`): the agent has
            // already self-critiqued against the lint gate, this is the
            // backstop that makes a stray dash a comma instead of a held run.
            return { value: normalizeCommentaryDashes(exec.finalOutput as Commentary), repairs: [] };
          }),
        (c) => `${c.value.caption}\n\n${c.value.about}`,
      );
      const commentary = commentaryDraft.draft.value;

      // ── 07: compliance pass — repairs, never holds ──
      const compliance = await wf.step.code(
        rev("07-compliance"),
        async (): Promise<{ caption: string; about: string; repairs: ContentRepair[] }> => {
          const repairs: ContentRepair[] = [...commentaryDraft.draft.repairs, ...dedupeRepair(commentaryDraft.verdict)];
          // Source credit first, and checked in code rather than asked of the
          // model that wrote it. The legacy rule is explicit that the on-clip
          // attribution block is not enough — the caption has to name it — and
          // a clip that ships uncredited is the one failure here with a party
          // outside this system.
          //
          // Which is exactly why it is APPENDED rather than held on. The rule
          // protects the person whose footage this is, and a held run protects
          // them no better than a credited caption does while costing the
          // client the clip. Appending is a string concatenation; the model
          // already produced the credit, it simply did not put it in the
          // caption. Recorded, so a reviewer sees the caption was completed.
          let caption = commentary.caption;
          if (!caption.includes(commentary.sourceCredit)) {
            caption = `${caption.trimEnd()}\n\n${commentary.sourceCredit}`;
            repairs.push({
              check: "source-credit",
              action: "rewritten",
              detail: `the caption did not name the source, so "${commentary.sourceCredit}" was appended to it — an on-clip attribution block alone is not enough`,
            });
          }
          const gated = await runTextGates([
            { key: "caption", text: caption, shape: "prose" },
            { key: "about", text: commentary.about, shape: "prose" },
          ]);
          repairs.push(...gated.repairs);
          // The caption only: `about` is written for the client's own team and
          // the clip transcript is in whatever language the speaker used, so
          // neither is evidence about the language the client publishes in.
          // No redraft here, unlike the script - a commentary draft costs a
          // dedupe-verified attempt, and the reviewer edits the caption in
          // place. The failure is named instead.
          const captionLanguage = checkDraftLanguage(gated.text["caption"] ?? caption, targetLanguage);
          if (!captionLanguage.ok) {
            repairs.push({
              check: "target-language",
              action: "unresolved",
              detail: `${captionLanguage.reason}; expected ${targetLanguage.tag} (${targetLanguage.reason})`,
            });
          }
          return { caption: gated.text["caption"] ?? caption, about: gated.text["about"] ?? commentary.about, repairs };
        },
      );

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

        // A client's 16:9 frame on a 9:16 short (2026-09-10): the whole picture
        // kept, the letterbox filled with a blurred copy of it rather than flat
        // ground, the way every podcast clip on the platform is cut. A crop
        // would take the faces; flat bars read as a screen recording.
        return brandFrame(clipPath, workDir, srtPath, [], "blur-fill", captionFontFor(targetLanguage.tag));
      });

      // The REPAIRED copy from here on, never the model's original: it is what
      // the render burned nothing of, what the guardrail must judge, what the
      // reviewer reads and what step 13 writes into the dedupe window. Scoring
      // the pre-repair text would compare future runs against words that never
      // shipped.
      return finishDraft(rev, revision, {
        commentary: { caption: compliance.caption, about: compliance.about, sourceCredit: commentary.sourceCredit },
        voiceover: false,
        renderedPath: rendered.outputPath,
        // The framed file's probed length is the truth; the transcript-derived
        // window is the fallback.
        durationSeconds: rendered.durationSeconds ?? bounds.endSeconds - bounds.startSeconds,
        hookLine: moment.hookLine,
        guardrailText: `${compliance.caption}\n\n${compliance.about}\n\n${bounds.text}`,
        captionsExpected: bounds.words.length > 0,
        repairs: compliance.repairs,
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
      const drafted = await (async (): Promise<{ script: ShortScript; voiceover: boolean; stillsAllowed: boolean; estimate: CostEstimate; replans: number; budgetPlan: BudgetPlan; repairs: ContentRepair[] }> => {
        const replanTargetUsd = Math.round(costCapUsd * REPLAN_TARGET_SHARE * 100) / 100;
        const visualQaRegistered = tools["video.visualQaGate"] !== undefined;
        let budgetFeedback: string | undefined;
        for (let attempt = 0; ; attempt++) {
          const planRev = (id: string) => rev(attempt === 0 ? id : `${id}-replan-${attempt}`);
          const feedback = budgetFeedback;
          // A footage-only revision keeps the approved words: no writer, no
          // dedupe (the same words were already verified), one cheap step.
          const scriptDraft: { draft: Drafted<ShortScript>; verdict: DedupeVerdict } =
            footageRevision !== undefined
              ? // A footage-only revision keeps words a reviewer already
                // accepted, so there is nothing new to score against history.
                {
                  draft: await wf.step.code(planRev("03s-script"), async (): Promise<Drafted<ShortScript>> => ({ value: footageRevision.script, repairs: [] })),
                  verdict: { status: "ok", comparedCount: 0, maxSimilarity: 0, threshold: 1 },
                }
              : await draftWithVerifiedDedupe<Drafted<ShortScript>>(
            planRev,
            "03s-script",
            "03t-verify-not-duplicate",
            (stepId, dedupeAvoid) =>
              wf.step.code(stepId, async () => {
                const agent = new TikTokScriptAgent({ router: options.router, tools, promptStore: options.promptStore });
                /** One drafting call; `structureFix` is the note a redraft gets about what the last draft got structurally wrong. */
                // `assembledInCode` is how the deterministic fallback below
                // tells `assembled()` what it produced. It rides on the script
                // rather than on a captured array because this whole closure is
                // one checkpointed step: on a replay the step short-circuits
                // and any side effect on a captured array never happens, so a
                // short the fallback assembled would come back through the
                // checkpoint claiming a writer wrote it.
                const draftOnce = async (agentStepId: string, structureFix: string | undefined): Promise<ShortScript & { assembledInCode?: boolean }> => {
                  const exec = await runAgentStepWithCommitSteer(wf, agentStepId, agent, {
                    ...runDirectionField(runDirection),
                    topic,
                    // ── C7: what the platform has learned, as INSTRUCTIONS (D41) ──
                    //
                    // Not a lint on the finished draft. Every field is absent
                    // for a client nobody has projected anything for, and the
                    // prompt then reads exactly as it did before the loop.
                    slotStage: stage,
                    ...(craftRulesForPrompt(learning.craft) !== undefined ? { craftRules: craftRulesForPrompt(learning.craft) } : {}),
                    ...(feedbackForPrompt(learning.feedback).length > 0 ? { clientFeedback: feedbackForPrompt(learning.feedback) } : {}),
                    ...(preferencesForDrafting(learning.preferences) !== undefined ? { clientPreferences: preferencesForDrafting(learning.preferences) } : {}),
                    ...(learning.platformState !== undefined ? { platformState: platformStateForDrafting(learning.platformState) } : {}),
                    ...(strategyRow !== undefined ? { strategyRow: strategyRowForDrafting(strategyRow) } : {}),

                    ...(intake.discovered ? { topicBrief: intake.discovered } : {}),
                    clientProfile: profile,
                    ...clientVoice,
                    // The writer should know the pictures are the client's own file, not a library it can steer.
                    ...(clientFootage !== undefined
                      ? { footageNote: `The plates are cut from the client's own attached footage (${Math.round(clientFootage.durationSeconds)} s, no speech in it), spread evenly across it. Write beats that read over generic shots of that footage; stockQuery and visualBrief are not used for this short.` }
                      : {}),
                    ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
                    ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
                    ...(dedupeAvoid !== undefined ? { dedupeAvoid } : {}),
                    // What this account keeps BUILDING, as opposed to what it
                    // keeps saying. Absent until there is a real pattern.
                    ...(shapeDirective !== undefined ? { structuralMemory: shapeDirective } : {}),
                    ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
                    ...(directive !== undefined || structureFix !== undefined
                      ? { revisionRequest: [directive, structureFix].filter((s): s is string => s !== undefined).join("\n\n") }
                      : {}),
                    ...(feedback !== undefined ? { budgetFeedback: feedback } : {}),
                    voiceoverPolicy: config.voiceover,
                    allowPeople: config.allowPeopleInGeneratedFootage,
                    contentLanguage: targetLanguage.tag,
                  }, "the script");
                  if (exec.status === "content_fail") {
                    // The writer produced nothing schema-valid. A script made
                    // up in code from a bare topic string would be filler, and
                    // filler is worse than a held run - but when the run has a
                    // grounded brief, its OWN sentences are real material the
                    // scout already wrote and research already backed. A
                    // text-led short built from them says something true, costs
                    // nothing more, and reaches a person who can rewrite it.
                    const brief = intake.discovered;
                    const lines = [brief?.hook, brief?.angle, brief?.whyNow ?? runDirection.direction]
                      .map((line) => line?.trim())
                      .filter((line): line is string => line !== undefined && line.length > 0);
                    if (lines.length < 3) {
                      // No grounded brief and no typed direction: there is
                      // nothing to say that we did not invent. The carve-out's
                      // "nobody to write for", reached honestly.
                      throw new WorkflowHeld(
                        "the script writer returned nothing schema-valid, and this run carries no grounded topic brief or typed direction to build a short out of instead",
                      );
                    }
                    const cap = (line: string, n: number) => (line.length > n ? `${line.slice(0, n - 1).trimEnd()}…` : line);
                    return {
                      hook: cap(lines[0]!, 200),
                      // `seconds` is a 4 | 6 | 8 union and the beats are read
                      // aloud by nobody, so they get the short hold: a text
                      // plate a viewer has already finished reading is dead air.
                      beats: lines.slice(0, 3).map((line) => ({
                        narration: cap(line, 260),
                        onScreenText: cap(line, 80),
                        visualBrief: "a plain brand plate; this short is text-led and needs no footage",
                        seconds: 4 as const,
                      })),
                      caption: cap(lines.join(" "), 600),
                      about: "The script writer returned nothing usable on this run, so this short was assembled from the topic brief the scout produced. Rewrite it before publishing.",
                      format: "text-led" as const,
                      voiceover: false,
                      voiceoverRationale: "assembled in code from the topic brief; a synthesized read of unwritten lines would only make it sound worse",
                      language: targetLanguage.tag,
                      // Read by `assembled` below, and by nothing else: it is
                      // how a fallback script tells the step that produced it
                      // what it is, without a captured array a replay skips.
                      assembledInCode: true,
                    };
                  }
                  if (exec.status !== "completed") {
                    throw new WorkflowToolingFailure(`script step resolved to "${exec.status}"`);
                  }
                  return normalizeScriptDashes(ShortScriptSchema.parse(exec.finalOutput));
                };
                /** The ledger line a script the fallback assembled carries out of this step; empty for one a writer wrote. */
                const assembled = (script: ShortScript & { assembledInCode?: boolean }): ContentRepair[] =>
                  script.assembledInCode === true
                    ? [
                        {
                          check: "script-draft",
                          action: "unresolved" as const,
                          detail:
                            "the script writer returned nothing schema-valid; a text-led short was assembled from the run's own grounded topic brief and wants a rewrite before it goes out",
                        },
                      ]
                    : [];
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
                const firstCircular = circularEndingIssues(first.repaired);
                // The words a VIEWER meets, and only those. `visualBrief` and
                // `stockQuery` are excluded deliberately: they are a stock
                // library's search terms, that library indexes in English, and
                // gating on them would fail every correct Hebrew draft.
                const spokenAndSeen = (sc: ShortScript) =>
                  [sc.hook, sc.caption, ...sc.beats.flatMap((b) => [b.narration, b.onScreenText])].join("\n");
                const firstLanguage = checkDraftLanguage(spokenAndSeen(first.repaired), targetLanguage);
                if (
                  first.issues.length === 0 &&
                  firstVoice.length === 0 &&
                  firstShots.length === 0 &&
                  firstPitch.length === 0 &&
                  firstCircular.length === 0 &&
                  firstLanguage.ok
                ) {
                  return { value: first.repaired, repairs: assembled(first.repaired) };
                }
                const note = [
                  first.issues.length > 0 ? `Structure problem in your last draft: ${first.issues.join("; ")}. Rewrite so every beat carries its own line.` : undefined,
                  firstVoice.length > 0 ? `Voice problem in your last draft: ${firstVoice.join("; ")}. Keep the message; rewrite the lines as speech.` : undefined,
                  firstShots.length > 0 ? `Shot problem in your last draft: ${firstShots.join("; ")}. Keep the words; change only the stockQuery and visualBrief of the beats that share the place.` : undefined,
                  firstPitch.length > 0 ? `Pitch problem in your last draft: ${firstPitch.join("; ")}. Rewrite that beat so it ends on the idea, in the client's voice, with no offer and no address.` : undefined,
                  firstCircular.length > 0 ? `Ending problem in your last draft: ${firstCircular.join("; ")}. Keep the hook; rewrite only the last beat so it lands somewhere new.` : undefined,
                  // Last in the note and first in importance: a short in the
                  // wrong language is not a draft with a problem, it is a
                  // deliverable nobody can post.
                  !firstLanguage.ok ? languageRedraftDirective(targetLanguage, firstLanguage.reason) : undefined,
                ]
                  .filter((s): s is string => s !== undefined)
                  .join("\n");
                const second = repairScriptStructure(await draftOnce(`${agentStepId}-fix`, note));
                const settled = second.issues.length === 0 ? second.repaired : dropRepeatedBeats(second.repaired);
                // All FOUR craft checks re-run on the redraft (2026-09-19),
                // not just the voice. Only `scriptVoiceIssues` was re-checked
                // before, and only as a `console.warn` nobody reads — so a
                // redraft that fixed the sentence lengths and introduced a
                // sales pitch, a one-room shot list or a circular ending
                // shipped with all three unmentioned. The first draft's
                // problems were named to the writer; the second draft's were
                // named to nobody.
                //
                // Not a hold and not a third attempt: the writer has had its
                // one steer, and what it still gets wrong is a taste call the
                // person at the gate is there to make. It just has to REACH
                // them, which is the only thing that changed.
                const stillWrong = [
                  ...scriptVoiceIssues(settled),
                  ...shotVarietyIssues(settled),
                  ...salesPitchIssues(settled, runDirection.direction),
                  ...circularEndingIssues(settled),
                ];
                if (stillWrong.length > 0) console.warn(`${agentStepId}-fix: the redraft still reads off: ${stillWrong.join("; ")}; shipping to the reviewer flagged`);
                const craftRepairs: ContentRepair[] = stillWrong.map((issue) => ({
                  check: "script-craft",
                  action: "unresolved" as const,
                  detail: `${issue} — the writer was asked once and did not fix it, so the short ships with it named`,
                }));
                // One redraft, then deliver. A second wrong-language draft is
                // a model that cannot write this language today, and a third
                // attempt buys another one at the same odds - so the short
                // ships with the failure named, which is the whole shape of
                // the always-deliver rule. The reviewer is the one who can
                // tell "wrong language" from "loanword-heavy and correct".
                const secondLanguage = checkDraftLanguage(spokenAndSeen(settled), targetLanguage);
                const languageRepairs: ContentRepair[] = secondLanguage.ok
                  ? []
                  : [
                      {
                        check: "target-language",
                        action: "unresolved" as const,
                        detail: `${secondLanguage.reason}; the writer was asked once to write it again in ${targetLanguage.tag} (${targetLanguage.reason}) and did not, so the short is delivered for a person to judge`,
                      },
                    ];
                if (!secondLanguage.ok) console.warn(`${agentStepId}-fix: ${secondLanguage.reason}; delivering flagged`);
                return { value: settled, repairs: [...assembled(settled), ...craftRepairs, ...languageRepairs] };
              }),
            (s) => `${s.value.caption}\n\n${s.value.about}`,
          );
          const draftedScript = scriptDraft.draft.value;
          // The client's config outranks the model's per-piece call; on `auto`
          // the model decided and said why.
          const voiceover = config.voiceover === "always" ? true : config.voiceover === "never" ? false : draftedScript.voiceover;

          // ── 07: compliance pass — the caption and about, plus every line the
          //        viewer will hear or read, because on-screen words are
          //        published words too ──
          //
          // Repairs rather than holds (2026-09-18). A beat's `narration` is
          // prose and loses the sentence carrying a flagged span; its
          // `onScreenText` is a title card of four or five words, so it loses
          // the SPAN and keeps the card — redacting a card's only sentence
          // would leave a beat with a blank plate. The repaired script is what
          // is priced, voiced, captioned and rendered: everything downstream
          // reads `script`, and nothing downstream should ever see the words
          // the gates objected to.
          const complied = await wf.step.code(planRev("07-compliance"), async (): Promise<{ script: ShortScript; repairs: ContentRepair[] }> => {
            const gated = await runTextGates([
              { key: "caption", text: draftedScript.caption, shape: "prose" },
              { key: "about", text: draftedScript.about, shape: "prose" },
              { key: "hook", text: draftedScript.hook, shape: "line" },
              ...draftedScript.beats.flatMap((b, i) => [
                { key: `beat${i + 1}.narration`, text: b.narration, shape: "prose" as const },
                { key: `beat${i + 1}.onScreenText`, text: b.onScreenText, shape: "line" as const },
              ]),
            ]);
            const repaired: ShortScript = {
              ...draftedScript,
              caption: gated.text["caption"] ?? draftedScript.caption,
              about: gated.text["about"] ?? draftedScript.about,
              hook: gated.text["hook"] ?? draftedScript.hook,
              beats: draftedScript.beats.map((b, i) => ({
                ...b,
                narration: gated.text[`beat${i + 1}.narration`] ?? b.narration,
                onScreenText: gated.text[`beat${i + 1}.onScreenText`] ?? b.onScreenText,
              })),
            };
            // A repaired hook has to reach beat 1 too, or the cold open says
            // one thing and the voice says another — `repairScriptStructure`'s
            // own invariant, re-established after the redaction.
            return { script: repairScriptStructure(repaired).repaired, repairs: [...scriptDraft.draft.repairs, ...dedupeRepair(scriptDraft.verdict), ...gated.repairs] };
          });
          const script = complied.script;

          const narrationChars = script.beats.reduce((n, b) => n + b.narration.trim().length, 0);
          const narrationWords = script.beats.reduce((n, b) => n + b.narration.trim().split(/\s+/).length, 0);
          const paidBeats = script.beats.filter((b) => b.stat === undefined).length;
          const canBuyStills = script.format !== "text-led" && clientFootage === undefined;

          // ── 03v: price the whole plan, then climb `BUDGET_RUNG_ORDER` ──
          //
          // The plan is priced against the SOFT TARGET, not the hard ceiling
          // (2026-09-18, the owner's *quality before cost* ruling). Under the
          // target the short is built as written and gives up nothing — which
          // is the normal path and the point of the change: a short that wants
          // a voice and a photograph on two beats is now planned, not trimmed.
          //
          // Over the target, the rungs come off in `BUDGET_RUNG_ORDER`, which
          // is the part that actually changed. The old ladder dropped the
          // still, then the voice, then the QA watch — the three things that
          // decide whether a stranger finishes the short — because it was
          // written to stop Veo, which has not been a tier since 2026-09-09.
          // Now the photographs go first, the writer is asked next, and the
          // voice and the QA watch are the last things any run gives up.
          const planned = await wf.step.code(planRev("03v-estimate-cost"), async () => {
            const spentSoFarUsd = await wf.costSoFarUsd();
            const price = (opts: { voiceover: boolean; stillsAllowed: boolean }) =>
              estimateOriginalShortCost({ spentSoFarUsd, narrationChars, beats: paidBeats, voiceover: opts.voiceover, stillsAllowed: opts.stillsAllowed, visualQaRegistered, costCapUsd });

            const rungs: BudgetRung[] = [];
            let stillsAllowed = canBuyStills;
            let plannedVoice = voiceover;
            let estimate = price({ voiceover: plannedVoice, stillsAllowed });
            if (estimate.estimatedTotalUsd <= targetSpendUsd) {
              return { estimate, stillsAllowed, voiceover: plannedVoice, rungs, askWriter: false };
            }

            // Rung 1 — ask the writer. First because it is the only rung the
            // viewer does not pay for: a shorter short keeps its pictures and
            // its voice, where every rung below costs one of them.
            if (attempt < MAX_BUDGET_REPLANS) {
              return { estimate, stillsAllowed, voiceover: plannedVoice, rungs, askWriter: true };
            }

            // Rung 2 — the bought photographs. The largest line in any plan,
            // and the only one with a free tier directly underneath it: the
            // beat still gets a picture, just its own line rather than a
            // photograph. Against the HARD ceiling from here down — the gap
            // between the target and the wall exists precisely so an ambitious
            // short can spend it rather than be trimmed into an ordinary one.
            if (stillsAllowed && estimate.estimatedTotalUsd > costCapUsd) {
              stillsAllowed = false;
              rungs.push("stills");
              estimate = price({ voiceover: plannedVoice, stillsAllowed });
            }

            // Rung 3 — the voice. A silent short is a materially worse short,
            // so it goes after every photograph in the piece.
            if (plannedVoice && estimate.estimatedTotalUsd > costCapUsd) {
              plannedVoice = false;
              rungs.push("voice");
              estimate = price({ voiceover: false, stillsAllowed });
            }
            // Rung 4 — the QA watch is the last thing cut, and the guard that
            // does it lives at `10b-visual-qa` against real spend rather than
            // against an estimate. Nothing is dropped here.
            return { estimate, stillsAllowed, voiceover: plannedVoice, rungs, askWriter: false };
          });

          if (planned.askWriter) {
            budgetFeedback = budgetFeedbackFor(planned.estimate, replanTargetUsd, script.beats.length, narrationWords);
            continue;
          }

          const budgetPlan: BudgetPlan = planned.rungs.includes("voice")
            ? "stock-only-silent"
            : planned.rungs.includes("stills")
              ? "stock-only"
              : attempt === 0
                ? "original"
                : "replan";
          if (planned.rungs.length > 0) {
            console.warn(
              `${planRev("03v-estimate-cost")}: the plan priced over $${targetSpendUsd.toFixed(2)}; gave up ${planned.rungs.join(", ")} and continues at an estimated $${planned.estimate.estimatedTotalUsd.toFixed(2)}`,
            );
          }
          return {
            script,
            voiceover: planned.voiceover,
            stillsAllowed: planned.stillsAllowed,
            estimate: planned.estimate,
            replans: attempt,
            budgetPlan,
            repairs: [
              ...complied.repairs,
              // A rung is an adaptation the client's short actually wears, so
              // it belongs in the same ledger as a redacted sentence — not in a
              // separate budget report nobody opens.
              ...(planned.rungs.length > 0
                ? [
                    {
                      check: "run-budget",
                      action: "trimmed" as const,
                      detail: `the plan priced over the $${targetSpendUsd.toFixed(2)} target, so this short gave up ${planned.rungs.join(", then ")} (estimated $${planned.estimate.estimatedTotalUsd.toFixed(2)} against a $${costCapUsd.toFixed(2)} ceiling)`,
                    },
                  ]
                : []),
            ],
          };
        }
      })();
      const { script, voiceover, stillsAllowed, estimate, replans, budgetPlan } = drafted;
      /** Everything this round had to repair, from the compliance pass onward; the plate loop and the render append to it. */
      const roundRepairs: ContentRepair[] = [...drafted.repairs];

      /**
       * A line set large on the brand ground (`video.textPlate`), in the
       * language's own face. `undefined` when the deployment has no such tool;
       * a render failure is a tooling failure like any other plate's.
       */
      const renderTextPlate = async (text: string, outputName: string, seconds: number, about: string, stat?: { value: string; label: string }): Promise<string | undefined> => {
        const render = tools["video.textPlate"];
        if (render === undefined) return undefined;
        const font = captionFontFor(targetLanguage.tag);
        // `workDir`, not `baseWorkDir` (2026-09-19). Every plate step id is
        // revision-scoped and every plate FILE name was not, so round 1 wrote
        // `plate-2-text.mp4` straight over round 0's copy. The finished
        // composite for round 0 already existed by then, so nothing shipped
        // wrong — but the r0 gate record links a reviewer to a work directory
        // whose intermediates had been overwritten by a later round, and a
        // replay that re-renders from those files would build round 1's
        // pictures under round 0's checkpoint. The `r{n}` directory exists for
        // exactly this and the plates were the one thing still outside it.
        await fs.mkdir(workDir, { recursive: true });
        const outcome = await render.execute(
          {
            text: text.length > 160 ? `${text.slice(0, 157).trimEnd()}…` : text,
            ...(stat !== undefined ? { stat } : {}),
            outputPath: path.join(workDir, `${outputName}.mp4`),
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

      // ── 04p: FIND the plates, one per beat. Revision-scoped since
      //         2026-09-10: a revised script gets plates for ITS words, and a
      //         footage-only revision exists to fetch new ones. ──
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
        /**
         * Why this beat has no shots, when it has none.
         *
         * An EMPTY `shots` is not an error any more (2026-09-18): it is a beat
         * the whole ladder - the client's own footage, the library, a bought
         * still, the free text plate - could not picture, in practice because
         * a deployment has no `video.textPlate` at all. It used to hold the
         * run and throw away every other beat that HAD worked. The resolution
         * pass below stands a neighbouring shot in its place and records it.
         */
        miss?: string;
      }
      const beatPlates: BeatPlates[] = [];
      const plateSources: PlateSource[] = [];
      // Seeded with the clips a footage-only revision is replacing, so the
      // library cannot hand the same one back for the beat a reviewer named —
      // AND, since 2026-09-18, with every clip this client's previous shorts
      // already used. That list was run-scoped, so the exclusion reset every
      // run; Pexels' results for a query like "office desk" are stable, so two
      // shorts a week apart on adjacent topics opened on the same footage and
      // both passed every gate because neither knew about the other.
      const usedStockIds: number[] = [...shapeMemory.usedStockIds, ...(footageRevision?.excludeStockIds ?? [])];
      for (let i = 0; i < script.beats.length; i++) {
        const beat = script.beats[i]!;
        // Revision-scoped (2026-09-10): a revised script needs its own plates,
        // and a footage revision exists to fetch new ones. Unscoped, round 1
        // replayed round 0's checkpointed plates under different words.
        const plate = await wf.step.code(rev(`04p-plate-${i + 1}`), async (): Promise<BeatPlates> => {
          // A text-led short never searches: the beat's line IS the picture.
          if (script.format === "text-led") {
            const rendered = await renderTextPlate(beat.onScreenText, `plate-${i + 1}-text`, beat.seconds, `beat ${i + 1}`);
            if (rendered === undefined) {
              return { shots: [], miss: "this short is text-led and video.textPlate is not registered in this deployment" };
            }
            return { shots: [{ path: rendered, source: "text" }] };
          }
          // A STAT beat (2026-09-10): one number from the brief is its own
          // picture. Footage under "47%" is wallpaper; the figure, large, on
          // the brand ground with its label, is what the viewer should read.
          // Free, no library, no model. Without the tool the beat falls
          // through to footage like any other.
          if (beat.stat !== undefined) {
            const rendered = await renderTextPlate(beat.stat.label, `plate-${i + 1}-stat`, beat.seconds, `beat ${i + 1} (stat card)`, beat.stat);
            if (rendered !== undefined) return { shots: [{ path: rendered, source: "text" }] };
          }
          // The client's own silent footage (2026-09-10): each beat is a cut
          // of it, the cuts spread evenly across the file so the short walks
          // through what the client sent rather than looping its first
          // seconds. Free, no library, no model; a failed cut falls through
          // to the library like any other miss.
          if (clientFootage !== undefined) {
            const cutTool = tools["video.cutClip"];
            if (cutTool !== undefined) {
              const span = Math.max(0, clientFootage.durationSeconds - beat.seconds);
              const start = Number((script.beats.length === 1 ? 0 : (span * i) / (script.beats.length - 1)).toFixed(2));
              const end = Number(Math.min(start + beat.seconds, clientFootage.durationSeconds).toFixed(2));
              const outcome = await cutTool.execute({ sourcePath: clientFootage.path, startSeconds: start, endSeconds: end, outputPath: path.join(workDir, `plate-${i + 1}-client.mp4`) }, { ctx });
              if (outcome.status === "success") return { shots: [{ path: (outcome.result as { outputPath: string }).outputPath, source: "client" }] };
              console.warn(`04p-plate-${i + 1}: cutting the client's footage at ${start}s failed (${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""}); the library serves this beat`);
            }
          }
          const query = beat.stockQuery ?? stockQueryFromBrief(beat.visualBrief);
          const misses: string[] = [];
          // What the library is asked to judge each candidate against: the
          // scene the script wanted and the words the viewer will hear over it.
          const relevance = { brief: beat.visualBrief, narration: beat.narration };
          const taken: number[] = [...usedStockIds];
          /** A stock search for this beat, with the run's used ids excluded. */
          const searchStock = async (attemptQuery: string, minDurationSeconds: number, outputName: string, avoidTitleLike?: string) => {
            const stock = tools["video.findStockClip"]!;
            const found = await stock.execute(
              { repoRoot, runId: wf.runId, query: attemptQuery, minDurationSeconds, excludeIds: [...taken], outputName, relevance, ...(avoidTitleLike !== undefined ? { avoidTitleLike } : {}) },
              { ctx },
            );
            if (found.status !== "success") return { ok: false as const, note: `stock "${attemptQuery}": ${found.status}${"reason" in found ? ` (${found.reason})` : ""}` };
            const result = found.result as { path: string; pexelsId: number; sourceUrl: string };
            taken.push(result.pexelsId);
            return { ok: true as const, plate: { path: path.resolve(repoRoot, result.path), source: "stock" as const, stockId: result.pexelsId, sourceUrl: result.sourceUrl } };
          };
          /** The second shot of a long beat: same query, the first clip excluded AND nothing titled like it (two clocks are one clock twice), half the length. Optional: a miss leaves one shot. */
          const withSecondShot = async (first: PlateResult): Promise<BeatPlates> => {
            // Against the hold the beat will really get, not the seconds the
            // writer asked for — see `expectedHoldSeconds`.
            if (expectedHoldSeconds(beat, voiceover) < TWO_SHOT_BEAT_SECONDS || tools["video.findStockClip"] === undefined) return { shots: [first] };
            const second = await searchStock(query, SECOND_SHOT_MIN_SECONDS, `plate-${i + 1}-b`, first.sourceUrl);
            return { shots: second.ok ? [first, second.plate] : [first] };
          };
          // A still is a purchase. It is off the table when the plan said
          // stock only, when the client said stock only, or when the run has
          // already reached its ceiling: in every one of those cases the beat
          // walks the free ladder below instead.
          //
          // And — 2026-09-18, the quality-first correction — it is off the
          // table when buying it would leave nothing for the VOICE and the QA
          // WATCH. Those three guards all used to fire at the same number, so
          // the one that won was simply the one execution reached first, and
          // execution reaches the plates before either of the others. A short
          // could spend its last cents on a $0.067 photograph for beat 5 and
          // then run silent and unwatched: the most money for the least
          // return. `BUDGET_RUNG_ORDER` says the voice and the QA come off the
          // ladder LAST, and a reservation is the only way to make that true
          // mid-run rather than only in the plan.
          const spentBeforePlate = await wf.costSoFarUsd();
          const stillsHere =
            stillsAllowed && config.footageSource !== "stock" && spentBeforePlate + unitPriceUsd("gemini-3.1-flash-image") + VOICE_AND_QA_RESERVE_USD <= costCapUsd;

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
              return { shots: [], miss: `no footage for beat ${i + 1} ("${query}"): ${misses.join("; ")}; ${because}; and video.textPlate is not registered` };
            }
            return { shots: [{ path: rendered, source: "text" }] };
          };

          if (!stillsHere) {
            const why =
              config.footageSource === "stock"
                ? 'this client\'s footageSource is "stock"'
                : !stillsAllowed
                  ? `the plan is ${budgetPlan}`
                  : `buying one would leave under $${VOICE_AND_QA_RESERVE_USD.toFixed(2)} for the voice and the QA watch`;
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
              outputPath: path.join(workDir, `plate-${i + 1}-still.mp4`),
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
        // `usedStockIds` is an INPUT to the next beat's search (it is what
        // `excludeIds` is built from), so it has to be current before the loop
        // comes round again - it cannot wait for the resolution pass below the
        // way `plateSources` can. Moving this out is how two beats end up on
        // the same library clip.
        for (const shot of plate.shots) {
          if (shot.stockId !== undefined) usedStockIds.push(shot.stockId);
        }
      }

      // -- 04q: a beat nothing could picture --
      //
      // Every tier missed and there was no text plate under them. That used to
      // end the run, discarding the script, the other beats' footage and the
      // voice that was about to be bought for it. A neighbouring shot stands in
      // instead: the narration still plays, the viewer sees the previous
      // picture held a little longer, and the substitution rides on the
      // deliverable. A repeated shot is a worse short; no short is no
      // deliverable, and the owner's rule settles which of those we ship.
      //
      // The nearest EARLIER plated beat, so the stand-in is a picture the
      // viewer has already been led to rather than one from later in the piece.
      // With nothing plated at all there is no picture anywhere in the short
      // and nothing to stand in for anything: that is the carve-out's genuine
      // tooling failure, and it names which tool is missing.
      const plated = (p: BeatPlates): boolean => p.shots.length > 0;
      const firstPlatedIndex = beatPlates.findIndex(plated);
      if (firstPlatedIndex === -1) {
        throw new WorkflowToolingFailure(
          `no plate could be made for any of the ${beatPlates.length} beats - ${beatPlates.map((p, i) => `beat ${i + 1}: ${p.miss ?? "no shots"}`).join("; ")}`,
        );
      }
      for (const [i, plate] of beatPlates.entries()) {
        if (plated(plate)) continue;
        let donor = firstPlatedIndex;
        for (let j = i - 1; j >= 0; j--) {
          if (plated(beatPlates[j]!)) {
            donor = j;
            break;
          }
        }
        beatPlates[i] = { shots: [beatPlates[donor]!.shots[0]!], ...(plate.miss !== undefined ? { miss: plate.miss } : {}) };
        roundRepairs.push({
          check: "beat-footage",
          action: "substituted",
          detail: `beat ${i + 1} has no picture of its own (${plate.miss ?? "every tier missed"}); beat ${donor + 1}'s shot is held over it instead`,
        });
      }

      // `plateSources`, by contrast, IS built after the resolution pass and
      // never inside the loop: a stand-in shot has to appear at ITS beat's
      // position, because that list is how a reviewer knows which plates in
      // the clip they are watching are real footage. Nothing reads it before
      // the render, so there is no ordering cost to waiting.
      for (const plate of beatPlates) {
        for (const shot of plate.shots) plateSources.push(shot.source);
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
      const language = targetLanguage.tag;
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

        // How long each beat holds. With a voice, the picture changes where
        // the VOICE changes beat (2026-09-15): the script's words are aligned
        // to the transcript once, and each cut lands in the breath between
        // one beat's last word and the next beat's first. The word-count
        // proportion that used to place the cuts stays as the fallback for a
        // voice with no word timings. Without a voice, the script's own
        // seconds stand.
        const scripted = script.beats.map((b) => b.seconds);
        const narrationWords = script.beats.map((b) => scriptWords([b.narration]));
        const timed =
          voice && voice.words.length > 0
            ? alignScriptToTimings(
                scriptWords(script.beats.map((b) => b.narration)),
                voice.words.map((w) => ({ text: w.text, start: w.start, end: w.end })),
                voice.durationSeconds ?? undefined,
              )
            : [];
        let holds: number[] = scripted;
        if (voice?.durationSeconds) {
          const wordCounts = narrationWords.map((ws) => Math.max(1, ws.length));
          const totalWords = wordCounts.reduce((a, b) => a + b, 0);
          const total = voice.durationSeconds + 0.4;
          const proportional = wordCounts.map((n) => Math.max(MIN_PLATE_HOLD_SECONDS, (n / totalWords) * total));
          holds = beatHoldsFromTimings(timed, narrationWords.map((ws) => ws.length), total, proportional, MIN_PLATE_HOLD_SECONDS);
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
          timed.length > 0
            ? cuesToSrt(
                buildPhraseCues(timed)
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

        // The captions a viewer actually sees (2026-09-15): the same phrases,
        // as a libass script in which the word being said lights up in the
        // brand accent and steps forward. `video.brandFrame` burns it instead
        // of the SRT when it exists; the SRT is still written beside it, so a
        // reviewer reading the work directory (or a deployment whose
        // brandFrame predates 1.4.0) has the plain captions. No model, no
        // cost: the timings were already there for the SRT.
        let captionsAssPath: string | undefined;
        if (timed.length > 0) {
          const groups = buildPhraseGroups(timed)
            .filter((g) => g.end > leadSeconds + 0.05)
            .map((g) => ({ end: g.end, words: g.words.map((w) => ({ text: w.text, start: Math.max(w.start, leadSeconds), end: Math.max(w.end, leadSeconds + 0.05) })) }));
          const font = captionFontFor(language);
          const ass = buildKaraokeCaptionsAss(groups, { accent: videoBrand.accent ?? DEFAULT_CAPTION_HIGHLIGHT, ...(font !== undefined ? { fontName: font } : {}) });
          if (ass !== undefined) {
            captionsAssPath = path.join(workDir, "captions.ass");
            await fs.writeFile(captionsAssPath, ass, "utf8");
          }
        }

        const compose = tools["video.composeSequence"];
        if (compose === undefined) throw new WorkflowToolingFailure("video.composeSequence is not registered — an original short cannot be assembled");
        let stockShotsPlaced = 0;
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
                // Library footage gets a slow move, alternating push-in and
                // pull-back shot by shot across the short (2026-09-10): the
                // 2026-09-08/10 renders played every plate dead still. A
                // still already moves (`video.stillToClip`), a text plate
                // has its bar, so both stay as they are.
                ...shots.map((shot) => ({
                  path: shot.path,
                  holdSeconds: Number((hold / shots.length).toFixed(2)),
                  ...(shot.source === "stock" || shot.source === "client" ? { move: stockShotsPlaced++ % 2 === 0 ? ("push-in" as const) : ("pull-back" as const) } : {}),
                })),
              ];
            }),
            outputPath: path.join(workDir, "sequence.mp4"),
            ...(voice ? { voiceoverPath: voice.path } : {}),
            // The voice arrives at whatever level the vendor chose; the
            // short leaves at -16 LUFS so a feed does not turn it down or
            // up against the clip before it, and the music bed laid on
            // afterwards sits under a known level (2026-09-15).
            ...(voice ? { normalizeLoudness: true } : {}),
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
        const framed = await brandFrame(bedded.path, workDir, srtPath, titleCards, "cover", captionFontFor(language), captionsAssPath);
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
          // Everything this round adapted around on its way here: a redacted
          // sentence, a beat whose picture is a neighbour's, a check nothing
          // could satisfy. `finishDraft` appends the advisory gate verdicts.
          repairs: roundRepairs,
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
      /**
       * THE RE-PICK IS AN IMPROVEMENT PASS OVER A FINISHED CLIP.
       *
       * By the time it runs, `first` has been rendered, passed the bitstream
       * gate, been watched by the visual QA and UPLOADED to the bucket a
       * reviewer plays it from. Letting the re-render's failure end the run
       * throws all of that away to avoid shipping a clip whose beat 2 footage
       * is merely mediocre.
       *
       * prep run `pubsub-21922188223732599` did exactly that. The worker was
       * recycled between `10b-visual-qa` and `10d` (a 423-second gap in the
       * step timings), so the plates from the first render — written to the
       * container's own `/tmp` — were on a machine that no longer existed:
       *
       *     video.composeSequence: clips[0] ".../plate-hook.mp4" could not be
       *     probed: ffprobe exited 1: No such file or directory
       *
       * The run failed with a complete, uploaded, QA'd clip already sitting
       * in GCS. `AwaitingGateSignal` is re-thrown because it is control flow
       * (the engine's "pause here" contract), not a failure; everything else
       * falls back to the cut that already exists.
       */
      let second: ClipDraft;
      try {
        second = await finishPass(passRev, path.join(workDir, "repick"), { beats: swappedBeats, note: because });
      } catch (error) {
        if (error instanceof AwaitingGateSignal) throw error;
        const why = error instanceof Error ? error.message : String(error);
        console.warn(`${passRev("08-render")}: the re-render failed (${why}); the first cut ships`);
        return {
          ...first,
          repick: { beats: swappedBeats, note: `${because}; the re-render could not be made (${why}), so the first cut ships unchanged` },
        };
      }

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

      // ── 09: the bitstream QA — the one deterministic check the file itself
      //         can answer (duration, streams, silence, black frames). ──
      //
      // The legacy rule here was "any failure aborts THIS candidate (never
      // ship degraded)", written when there was no way to tell a reviewer
      // anything. There is now: the clip is uploaded below and a person meets
      // it at 11-clip-review with a play button. A file this gate dislikes and
      // a person can watch is strictly more useful than no file and a sentence
      // — and the gate has no authority a human watching the same clip lacks.
      //
      // So it is advisory, exactly as the visual QA became on 2026-09-07, and
      // for the same reason. A `tooling_error` still throws: a check that could
      // not run has made no judgment.
      const selfEval = await wf.step.code(rev("09-qa-gate"), async (): Promise<{ passed: boolean; reason?: string }> => {
        const verdict = await runGate(tools, "video.selfEvalGate", { videoPath: renderedPath }, ctx);
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`video.selfEvalGate: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") {
          console.warn(`${rev("09-qa-gate")}: video.selfEvalGate flagged the file, shipping to review flagged rather than held: ${verdict.reason}`);
          return { passed: false, reason: verdict.reason };
        }
        return { passed: true };
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
      type MomentFit = { opensOnCompleteThought: boolean; closesAfterPayoff: boolean; note: string };
      const visualQa = await wf.step.code(
        rev("10b-visual-qa"),
        async (): Promise<
          { skipped: true; note: string } | { skipped: false; passed: boolean; reason?: string; evidence: string[]; weakBeats: WeakBeat[]; moment?: MomentFit }
        > => {
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
              language: targetLanguage.tag,
              format,
              // The beats and their windows, so the model says WHICH shot is
              // wallpaper under its line, not only that one is.
              ...(draft.beatWindows !== undefined && draft.beatWindows.length > 0 ? { beats: draft.beatWindows.slice(0, 6) } : {}),
              // A commentary clip's own words, so the model can judge the CUT
              // (2026-09-19). Every other expectation on this call is about
              // the TREATMENT - captions, frame, artefacts, per-beat footage -
              // and a clipping run's entire product is the choice of moment.
              // A clip could score 9 here with perfect captions and an intact
              // frame while opening halfway through a sentence.
              //
              // Only for a commentary clip: an original short is ASSEMBLED
              // from beats rather than cut out of a recording, so "does it
              // open on a complete thought" is a question about writing that
              // `scriptVoiceIssues` already answers, not about an edit.
              ...(format === "commentary-clip" && bounds.text.trim().length > 0 ? { clipText: bounds.text } : {}),
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
        const verdict = outcome.result as GateVerdict & { beats?: WeakBeat[]; moment?: MomentFit };
        if (verdict.verdict === "tooling_error") return { skipped: true, note: `video.visualQaGate could not review the clip (${verdict.reason}); the reviewer judges it unaided` };
        // A beat scored under 5 is footage that does not fit its line: named
        // to the reviewer beside the play button, never a hold on its own.
        const weakBeats = (verdict.beats ?? []).filter((b) => b.relevance < 5);
        // The read on the CUT, carried whether it passed or not: "the cut is
        // in the right place" is worth as much to a reviewer as the objection.
        const moment = verdict.moment !== undefined ? { moment: verdict.moment } : {};
        if (verdict.verdict === "content_fail") {
          console.warn(`${rev("10b-visual-qa")}: visual QA flagged the clip, shipping to review flagged rather than held: ${verdict.reason}`);
          return { skipped: false, passed: false, reason: verdict.reason, evidence: verdict.evidence, weakBeats, ...moment };
        }
        return { skipped: false, passed: true, evidence: verdict.evidence, weakBeats, ...moment };
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

      // Everything the production pass had to repair, plus the two advisory
      // verdicts that used to be holds — one ledger, in the order the run met
      // them, so a reviewer reads the whole story of this clip in one place.
      const repairs: ContentRepair[] = [...(draft.repairs ?? [])];
      if (visualQa.skipped === false && visualQa.moment !== undefined && (!visualQa.moment.opensOnCompleteThought || !visualQa.moment.closesAfterPayoff)) {
        // The cut is in the wrong place, which for a clipping run is a verdict
        // on the product itself rather than on its treatment. Not a hold and
        // not a re-cut: re-cutting would need a second moment pick, a second
        // transcription window and a second render, and the person at the gate
        // can see the timeline and decide in seconds what that would cost
        // dollars to guess at. What they could not do before is KNOW.
        const wrong = [
          !visualQa.moment.opensOnCompleteThought ? "it opens part-way through a thought" : undefined,
          !visualQa.moment.closesAfterPayoff ? "it ends before the point lands" : undefined,
        ].filter((v): v is string => v !== undefined);
        repairs.push({
          check: "moment-fit",
          action: "unresolved",
          detail: `the reviewer model says the cut is in the wrong place: ${wrong.join(" and ")}${visualQa.moment.note.length > 0 ? ` — ${visualQa.moment.note}` : ""}`,
        });
      }
      if (!selfEval.passed) {
        repairs.push({
          check: "video.selfEvalGate",
          action: "unresolved",
          detail: `${selfEval.reason ?? "the finished file failed its bitstream check"} — delivered flagged for a person to watch rather than withheld`,
        });
      }

      return {
        commentary: draft.commentary,
        ...(draft.script ? { script: draft.script } : {}),
        voiceover: draft.voiceover,
        renderedPath,
        durationSeconds: draft.durationSeconds,
        uploaded,
        hookLine: draft.hookLine,
        ...(repairs.length > 0 ? { repairs } : {}),
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
                ...(visualQa.moment !== undefined ? { moment: visualQa.moment } : {}),
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
          // WHOSE RECORDING THIS IS, at the gate that decides whether to
          // publish forty seconds of it. RFC-25 §1 rests its whole case on
          // this gate being "the real protection" for a clip of somebody
          // else's podcast, and until now the gate carried the source TIER
          // and nothing else — `web-harvest` read identically whether the
          // show was one the client clears every week or one a search turned
          // up ninety seconds earlier. A reviewer cannot weigh a risk whose
          // subject is not on the screen.
          ...(intake.sourceContext?.url !== undefined ? { sourceUrl: intake.sourceContext.url } : {}),
          ...(intake.sourceContext?.channel !== undefined ? { sourceChannel: intake.sourceContext.channel } : {}),
          ...(intake.sourceContext?.title !== undefined ? { sourceTitle: intake.sourceContext.title } : {}),
          licenseConfidence: clipLicenseConfidence(intake.sourceTier, intake.sourceContext?.discovery),
          // What the judge made of the recording itself, whatever it scored.
          // "We looked at this show and it is the right kind of show" is worth
          // as much to a reviewer as the objection would be.
          ...(sourceFit.skipped ? {} : { sourceFit: { score: sourceFit.score, reason: sourceFit.reason, ...(sourceFit.concerns.length > 0 ? { concerns: sourceFit.concerns } : {}) } }),
          // How the footage was found. An `open` discovery means nobody had
          // cleared this show before the search: the clip is still
          // `licenseConfidence: unknown` and this gate is where that is
          // decided (RFC-25). Shown always, not only when it is `open`, so
          // "this came from a show the client holds rights to" is equally
          // visible.
          ...(intake.sourceContext?.discovery !== undefined
            ? { discovery: intake.sourceContext.discovery, ...(intake.sourceContext.harvestQuery !== undefined ? { harvestQuery: intake.sourceContext.harvestQuery } : {}) }
            : {}),
          // Why the footage is stock and not the client's own: what each
          // higher tier said. Absent when a higher tier served.
          ...(intake.sourceNotes !== undefined && intake.sourceNotes.length > 0 ? { sourceNotes: intake.sourceNotes } : {}),
          // The client asked for a commentary clip and is being shown an
          // original short. Nothing else on this payload says so — `format`
          // reads `original-short` as if that were the plan.
          ...(modeSubstitution !== undefined ? { modeSubstitution } : {}),
          voiceover: draft.voiceover,
          ...(draft.script ? { script: draft.script } : {}),
          revision,
          // The reviewer's actual preview — a signed URL they can watch.
          ...(draft.uploaded?.signedUrl !== undefined ? { videoUrl: draft.uploaded.signedUrl } : {}),
          ...(draft.uploaded !== null ? { gcsUri: draft.uploaded.gcsUri } : {}),
          // The visual QA model's read, so a flagged clip arrives with the
          // reason beside the play button instead of as a held run.
          ...(draft.visualQa !== undefined ? { visualQa: draft.visualQa } : {}),
          // Everything this round had to adapt around on its way to a clip: a
          // redacted sentence, an appended source credit, a beat wearing a
          // neighbour's picture, a writer that returned nothing. The reviewer
          // needs this beside the play button more than anywhere else - it is
          // the difference between a clip that came out clean and one that was
          // salvaged, and nothing else on the payload says which they are
          // watching.
          ...(draft.repairs !== undefined && draft.repairs.length > 0 ? { contentRepairs: draft.repairs } : {}),
          // The one field the portal reads to decide whether to shout.
          ...(draft.visualQa?.passed === false || (draft.repairs?.length ?? 0) > 0 ? { flagged: true } : {}),
          // Set when the cut was chosen by code rather than by the picker.
          ...(momentFallback !== undefined ? { momentFallback } : {}),
          // What the moment floor OBSERVED but did not act on — a window with
          // no figure and no contrast connective may still be the best thirty
          // seconds in the episode, and that call is the reviewer's.
          ...(momentFloorNotes.length > 0 ? { momentNotes: momentFloorNotes } : {}),
          // Which language this short is in and where that came from. Shown
          // always, not only on a failure: "we assumed English because nobody
          // configured anything" is exactly the thing a reviewer of a Hebrew
          // client's short needs to see before they approve it.
          targetLanguage: { tag: targetLanguage.tag, source: targetLanguage.source, reason: targetLanguage.reason, assumed: targetLanguage.assumed },
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
        // An unanswered gate approves itself after an hour ONLY for a clip the
        // visual QA watched and passed AND that this run did not have to
        // repair. A repaired clip is precisely the one a person has to see:
        // the always-deliver rule buys the client a deliverable, not a silent
        // publish of work the run itself knows is degraded.
        timeout: {
          duration: "1h",
          onTimeout: draft.visualQa?.passed === true && (draft.repairs?.length ?? 0) === 0 ? "auto_approve" : "hold",
        },
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
    /**
     * A reviewer who ran the cycle out of rounds, or who rejected outright,
     * recorded ON the deliverable rather than ending the run.
     *
     * This agent shares `runReviewCycle` with the rest, so it inherits the
     * same behaviour. Nothing here publishes anything — the clip still waits
     * on a human — so what changes is that the reviewer keeps the work and the
     * reason attached to it, instead of a rendered clip existing nowhere.
     */
    const reviewOutcome =
      review.outcome !== undefined && review.outcome !== "approved"
        ? { outcome: review.outcome, detail: review.outcomeDetail ?? review.outcome }
        : null;
    const { commentary: copy, script, voiceover, renderedPath, durationSeconds, uploaded } = review.output;
    /**
     * Everything the APPROVED round had to repair, plus the reviewer's own
     * verdict when it was not an approval and the cut's provenance when code
     * picked it.
     *
     * The honest half of the owner's always-deliver rule (2026-09-17). Taken
     * from `review.output`, which is the round a human actually saw — not the
     * last round attempted — so the ledger describes the clip that shipped.
     */
    const contentRepairs: ContentRepair[] = [...(review.output.repairs ?? [])];
    if (!sourceFit.skipped && (sourceFit.score < MIN_SOURCE_FIT || sourceFit.concerns.length > 0)) {
      // A poor source is not a repair in the sense of something fixed — the
      // clip is what it is. It is `unresolved` because the run noticed a
      // problem it could not do anything about, which is exactly the class of
      // thing the ledger exists to carry to a person.
      contentRepairs.push({
        check: "source-fit",
        action: "unresolved",
        detail:
          `the source-fit judge scored this recording ${sourceFit.score}/10 for this client: ${sourceFit.reason}` +
          (sourceFit.concerns.length > 0 ? ` — concerns: ${sourceFit.concerns.join("; ")}` : ""),
      });
    }

    if (claim.topicNote !== undefined) {
      // `unresolved`, like the other two: nothing was repaired, the run
      // settled for something. Which rung it settled on is in the detail.
      contentRepairs.push({ check: "topic-source", action: "unresolved", detail: claim.topicNote });
    }
    if (modeSubstitution !== undefined) {
      // The biggest substitution this pipeline can make: the client asked for
      // a commentary clip and is holding an original short. It is `unresolved`
      // rather than `substituted` on purpose — the run did not fix anything,
      // it delivered a different product, and the reviewer is the one who
      // decides whether that was the right call for this topic.
      contentRepairs.push({ check: "clip-mode", action: "unresolved", detail: modeSubstitution });
    }

    // A person pasted a link, it did not resolve, and the run found footage
    // another way rather than stopping. They asked for a specific video and
    // got a different one, which is the single most important thing on this
    // deliverable — read off `sourceNotes` rather than a captured variable,
    // because the tier step is checkpointed and a replay never re-runs it.
    const pastedLinkFailure = intake.sourceNotes?.find((note) => note.includes("could not be resolved into a video"));
    if (pastedLinkFailure !== undefined) {
      contentRepairs.push({
        check: "pasted-link",
        action: "substituted",
        detail: `${pastedLinkFailure.replace(/^user-asset: /, "")} — the clip you are looking at came from somewhere else`,
      });
    }
    if (intake.sourceContext?.discovery === "open") {
      // Not a repair — nothing was adapted around and nothing degraded. But
      // this run clipped a show nobody had cleared, on the owner's standing
      // ruling, and the deliverable is what outlives the gate: six months
      // from now "where did this footage come from" has to be answerable
      // from the record rather than from a step checkpoint.
      contentRepairs.push({
        check: "source-discovery",
        action: "substituted",
        detail:
          `this client's sourcePool names no shows, so the footage was found by an open search for "${intake.sourceContext.harvestQuery ?? topic}" ` +
          `(${intake.sourceContext.channel ?? "channel unknown"}${intake.sourceContext.url !== undefined ? `, ${intake.sourceContext.url}` : ""}) — ` +
          "RFC-25; the clip is licenseConfidence: unknown and was approved by a person before anything shipped",
      });
    }
    if (momentFallback !== undefined) {
      contentRepairs.push({ check: "moment-selection", action: "substituted", detail: momentFallback });
    }
    if (
      clipSourceKey !== undefined &&
      bounds.needsCut &&
      shapeMemory.clippedWindows.some((w) => windowsOverlap(w, { source: clipSourceKey, startSeconds: bounds.startSeconds, endSeconds: bounds.endSeconds }))
    ) {
      // The picker was shown the windows this recording has already given up
      // and chose an overlapping one anyway. That is allowed — a long episode
      // can hold one genuinely best moment, and refusing it in code would veto
      // the strongest clip because a worse neighbour went out first. What it
      // may not be is SILENT: the reviewer is the one who knows whether this
      // account's audience saw the earlier clip.
      contentRepairs.push({
        check: "clip-window-reuse",
        action: "unresolved",
        detail:
          `this cut (${Math.round(bounds.startSeconds)}s-${Math.round(bounds.endSeconds)}s) overlaps a window this client has already published from the same recording — ` +
          `the picker was shown the earlier windows and chose this one anyway`,
      });
    }
    if (momentFloorNote !== undefined) {
      contentRepairs.push({
        check: "moment-floor",
        action: "unresolved",
        detail: `${momentFloorNote} — and no other run of whole sentences in this recording scores better, so the clip ships for a person to judge`,
      });
    }
    // An ASSUMED language is deliberately NOT a repair.
    //
    // It is visible either way - `targetLanguage.assumed` rides on the gate
    // payload and the deliverable, which is where a reviewer reads it. But the
    // repair ledger means "this run had to adapt around something", and most
    // clients have no `voiceLanguage` and no brand language and publish in
    // English perfectly happily. Pushing a repair here would attach a degrade
    // marker to the majority of clean runs, which is the "shouting `degraded`
    // at every clean post until nobody reads it" failure in reverse - the same
    // asymmetry `contentRepairs` is documented to protect.
    if (reviewOutcome !== null) {
      contentRepairs.push({ check: "human-review", action: "unresolved", detail: reviewOutcome.detail });
    }

    /**
     * D11's goal line — what this clip is for, who for, and why now.
     *
     * Resolved ONCE and used for both the client's card and the state record
     * (C7 §3.2). Like instagram, this agent takes the structured-field shape:
     * the client receives an mp4 and a caption, there is no drafts markdown to
     * hang a meta bullet on, and the caption is what they paste into TikTok —
     * our reasoning about funnel stages does not belong in it.
     *
     * Neither drafting model states a goal today, so every value comes from
     * the fallback, which is `resolveGoalLine`'s designed path: D11 holds for
     * a silent model.
     */
    const goalLine: ResolvedGoalLine = resolveGoalLine(
      {},
      {
        stage,
        whyNow:
          intake.topicSource === "requested"
            ? "asked for by name on this run"
            : intake.topicSource === "footage"
              ? "the client handed over this recording"
              : intake.topicSource === "reserved"
                ? `a planned row at the ${stage} stage`
                : "what this client's audience is asking about now",
      },
    );

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
            // D11 / C3: the point of the post, on the thing the client opens.
            goalLine,
            // Which of D08's three agents made this. `format` says what it is;
            // this says which card was pressed, and on `auto` the two can
            // still disagree — which is why the legacy id is deprecated.
            variant,
            clipPath: renderedPath,
            caption: copy.caption,
            about: copy.about,
            ...(copy.sourceCredit !== undefined ? { sourceCredit: copy.sourceCredit } : {}),
            ...(intake.sourceContext ? { sourceContext: intake.sourceContext } : {}),
            // Persisted with what shipped, not only shown at the gate: the
            // question "whose footage is this clip of" is asked again every
            // time somebody reopens the deliverable, and a tier name does not
            // answer it.
            licenseConfidence: clipLicenseConfidence(intake.sourceTier, intake.sourceContext?.discovery),
            hookLine: review.output.hookLine,
            // The visual QA model's read, persisted with what shipped so the
            // portal can show a flagged clip as flagged after the fact.
            ...(review.output.visualQa !== undefined ? { visualQa: review.output.visualQa } : {}),
            // What the APPROVED round had to adapt around, plus the reviewer's
            // own verdict when it was not an approval. Absent, never empty, on
            // a clean run: a marker attached unconditionally is the "silently
            // shipping a degraded clip" failure in reverse - shouting at every
            // clean clip until nobody reads it.
            ...(contentRepairs.length > 0 ? { contentRepairs } : {}),
            ...(momentFallback !== undefined ? { momentFallback } : {}),
            targetLanguage: { tag: targetLanguage.tag, source: targetLanguage.source, assumed: targetLanguage.assumed },
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
      // A topic is only CONSUMED by a post a reviewer approved. Before this PR
      // a reject threw before ever reaching here; now it returns, so the guard
      // has to be explicit or a rejected post would burn the topic it was
      // built from and no future run could use it.
      if (intake.reservationKey) {
        if (reviewOutcome !== null) {
          await releaseReservation();
        } else {
          await callTool(tools, "topics.commit", { reservationKey: intake.reservationKey }, ctx);
        }
      }
      // The write half of the anti-repetition loop — best-effort, on delivery only.
      try {
        await tools["ledger.recordOutputExcerpt"]?.execute({ agentId: "tiktok-agent", runId: wf.runId, excerpt: `${copy.caption}\n\n${copy.about}` }, { ctx });
      } catch (error) {
        console.error("13-commit-and-record: could not record the output excerpt for future dedup", error);
      }
      // What this account has now MADE. The used-media ledger states the rule
      // for itself — "an image that never shipped was never used" — and it
      // applies to both halves of this: a short a reviewer turned down never
      // reached a feed, so it cannot have made the account look repetitive,
      // and the library clips it fetched are still free for the next run to
      // use. `reviewOutcome` is non-null for a reject and for a cycle that ran
      // out of rounds, and neither of those shipped anything.
      try {
        const record = reviewOutcome === null ? tools["ledger.recordUsedImages"] : undefined;
        if (record !== undefined) {
          const entries = [
            ...(review.output.plateStockIds ?? []).flatMap((p) => p.ids.map(stockClipEntry)),
            ...(script !== undefined ? [skeletonEntry(skeletonOf(script))] : []),
            // The window of the recording this clip came out of. Until now a
            // clipping run recorded NOTHING across runs — `skeletonOf` only
            // fires for an original short and a commentary clip buys no
            // library footage — so the same forty seconds of the same episode
            // could ship twice weeks apart, each time passing every check.
            ...(clipSourceKey !== undefined && bounds.needsCut ? [clipWindowEntry(clipSourceKey, bounds.startSeconds, bounds.endSeconds)] : []),
          ];
          if (entries.length > 0) await record.execute({ imagePaths: entries }, { ctx });
        }
      } catch (error) {
        console.error("13-commit-and-record: could not record this short's shape for future runs", error);
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

    // ── 14: what this run learned, handed back (C7 §3) ──
    //
    // Never throws: a failed write is recorded on the step and the clip still
    // stands. A video the client can post is worth more than a row in a table,
    // and the row can be rebuilt from the deliverable.
    await writeRunState(wf, tools, ctx, "14-write-run-state", {
      platform: "tiktok",
      deliverable: {
        kind: "tiktok-clip",
        ...(reviewOutcome ? { reviewOutcome } : {}),
        goal: goalLine.goal,
        ...(goalLine.audience !== undefined ? { audience: goalLine.audience } : {}),
        whyNow: goalLine.whyNow,
        // TikTok's own type vocabulary is the format, which after the split is
        // also the product: `commentary-clip` is clipping, `original-short` is
        // content design.
        type: format,
      },
      subjectRow: {
        subject: topic,
        type: format,
        stage,
        goal: goalLine.goalText,
        // A draft the reviewer rejected outright was not used, which is what
        // \`skipped\` means in the subject table. Written as \`drafted\` it sat
        // there forever looking like work still in review.
        status: review.outcome === "rejected" ? "skipped" : "drafted",
        assetKind: "tiktok-clip",
        // Honest null rather than an invented id: a made-up row would make the
        // map look spent. Only a topic that actually came off the map carries
        // one, and on this agent the catalog is still the usual source.
        strategyRowId: strategyRow !== undefined && intake.topicSource === "reserved" && strategyRow.idea === topic ? strategyRow.id : null,
      },
      platformStateDelta: { postsByUs: 1, topics: [topic] },
      // Every revision note a reviewer sent on this run, as the voice lessons
      // the middleware carries into \`client_preferences\` (Craft 11 §3: a
      // reviewer's note is the signal voice is learned from). X, LinkedIn and
      // Reddit have recorded these since C7; this agent recorded none, so a
      // note typed at the gate steered one redraft and was then forgotten.
      voiceNotes: review.notes.map((n) => ({ lesson: n.feedback, fromRevision: n.revision })),
      readiness: learning.readiness,
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
