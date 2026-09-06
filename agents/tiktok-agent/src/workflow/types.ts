import { z } from "zod";

/**
 * The clip lane this product owns, and the only one it will ever reserve from.
 *
 * Named explicitly rather than left to the caller because the legacy product's
 * first rule is that it does ONE thing: short vertical video. Carousels and
 * every static format belong to instagram-agent. A lane parameter here would be
 * an invitation to run something else through a pipeline whose QA gates assume
 * a 9:16 clip.
 */
export const CLIP_LANE = "commentary-clip";

/** Clip length bounds (SKILL.md: 20s-2min, most land 25-60s). */
export const CLIP_DURATION_MIN_SECONDS = 20;
export const CLIP_DURATION_MAX_SECONDS = 120;

/**
 * How many topic candidates the discovery step asks for. Not arbitrary:
 * `topics.reserve` refuses a reservation that would leave the lane under
 * `LANE_FLOOR` (5) unused rows, so a lane seeded from empty needs at least 6
 * rows for ONE reservation to clear. Eight leaves room for the dedupe filter
 * to drop a couple before seeding.
 */
export const DISCOVERY_CANDIDATE_MIN = 6;
export const DISCOVERY_CANDIDATE_MAX = 10;

/**
 * The two things this agent can make.
 *
 * - `commentary-clip` — a moment cut out of real long-form footage (the
 *   client's own, an attached upload, or a rights-cleared show from their
 *   `sourcePool`), captioned word-for-word, framed in the brand, with the
 *   client's own take as the caption. The legacy product.
 * - `original-short` — nothing to clip from: a scripted 3-5 beat short over
 *   generated b-roll, optionally voiced, with the client's message carried by
 *   the captions/voiceover rather than by someone else's words.
 */
export const ClipFormatSchema = z.enum(["commentary-clip", "original-short"]);
export type ClipFormat = z.infer<typeof ClipFormatSchema>;

/**
 * The per-client settings. Every field is optional now — a client with no
 * `tiktokClips` block at all can still run in `original` mode, because an
 * original short needs no rights decision about anyone else's footage. What
 * stays a deliberate human decision is `sourcePool`: the agent will never clip
 * a show nobody said the client may draw on.
 */
export const TikTokClipConfigSchema = z.object({
  /**
   * Which formats this client wants. `auto` (default) clips real footage when
   * any tier can supply it and falls back to an original short; `commentary`
   * never generates footage and holds honestly when there is none to clip;
   * `original` never touches anyone else's footage.
   */
  mode: z.enum(["auto", "commentary", "original"]).default("auto"),
  /**
   * The verified inventory the client may draw on. Entries that are
   * `gs://`/`https://` URIs are OWNED FOOTAGE the sourcing cascade's Tier 2a
   * can ingest directly (a podcast episode, a keynote recording); plain-name
   * entries are shows/channels the web-harvest tier is allowed to search —
   * and the ONLY ones it will search.
   */
  sourcePool: z.array(z.string().min(1)).default([]),
  /** Where the client's own long-form media lives, when they have footage of their own. */
  ownedFootageRoot: z.string().min(1).optional(),
  /** Names worth clipping wherever they appear — the highest-yield discovery signal in the legacy product. */
  guestWatchlist: z.array(z.string().min(1)).default([]),
  /** Subjects this client will not clip, on top of the global topic guardrail. */
  narrowing: z.array(z.string().min(1)).default([]),
  /** A standing series header ("PITCH SCHOOL | LESSON 15" style) rendered in the branded frame's top bar. */
  seriesHeader: z.string().min(1).max(60).optional(),
  /**
   * Voiceover on an original short. `auto` (default) lets the script step
   * decide per piece — a punchy text-led hook often reads better silent, a
   * narrative beat wants a voice; `always`/`never` override that judgment.
   */
  voiceover: z.enum(["auto", "always", "never"]).default("auto"),
  /** BCP-47 language for the voiceover and captions of an original short. Defaults to the brand kit's content language, then en-US. */
  voiceLanguage: z.string().min(2).optional(),
  /** Provider voice id/name for the voiceover. Provider default when absent. */
  voiceName: z.string().min(1).optional(),
  /** Whether generated b-roll may contain people. Off by default: faces are where generated footage most often looks generated. */
  allowPeopleInGeneratedFootage: z.boolean().default(false),
});
export type TikTokClipConfig = z.infer<typeof TikTokClipConfigSchema>;

/** The config a client with no `tiktokClips` block runs under. */
export const DEFAULT_CLIP_CONFIG: TikTokClipConfig = TikTokClipConfigSchema.parse({});

/** Which sourcing tier actually produced this run's footage — recorded on the intake, the deliverable, and the hold reason when every tier came up dry. */
export type ClipSourceTier = "user-asset" | "owned-footage" | "web-harvest" | "generated";

/**
 * Where the run's topic came from. `footage` means the client handed us a
 * recording and the topic is whatever the moment step finds in it — the one
 * case where the catalog is advisory rather than authoritative.
 */
export type TopicSource = "requested" | "reserved" | "discovered" | "footage";

/** What the run resolved before any model was asked anything. */
export interface TikTokIntake {
  config: TikTokClipConfig;
  /** The subject this run is producing on. Provisional for `topicSource: "footage"` until the moment step names it. */
  topic: string;
  topicSource: TopicSource;
  /** Set when the topic came from the catalog, so the reservation can be committed or released. */
  reservationKey?: string;
  /** The media file to clip. Absent only for `sourceTier: "generated"`, whose footage is made per beat AFTER the script exists. */
  sourcePath?: string;
  /** Which tier the footage came from. A `generated` source has no transcript — the spoken-moment steps are skipped for it. */
  sourceTier: ClipSourceTier;
  /** Where harvested/attached footage came from — the honest basis for the caption's source credit. */
  sourceContext?: { title?: string; channel?: string; url?: string; label?: string };
  /** The discovery step's brief for the reserved topic, when the topic came from discovery. */
  discovered?: TopicCandidate;
}

/**
 * The moment-selection step's output.
 *
 * Timestamps are seconds into the SOURCE, and the agent is told to snap them to
 * sentence boundaries. They are validated against the transcript afterwards
 * rather than trusted: a model asked for a timestamp will produce one whether
 * or not the transcript supports it.
 */
export const MomentSelectionSchema = z.object({
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  /** The line that has to work cold on a stranger — the first thing they hear. */
  hookLine: z.string().min(1),
  /** Which hook type this is, from the legacy typology. Recorded so a human can see the reasoning, not to branch on. */
  hookType: z.enum(["contrarian-claim", "surprising-number", "emotional-story", "sharp-one-liner"]),
  /** Why this moment over the rest of the episode. */
  rationale: z.string().min(1),
  /**
   * A short label for what the chosen moment is actually about, in the
   * client's terms. This becomes the run's topic when the footage was handed
   * to us with no topic of its own (`topicSource: "footage"`).
   */
  topicLabel: z.string().min(1).max(120).optional(),
});
export type MomentSelection = z.infer<typeof MomentSelectionSchema>;

/**
 * The commentary layer: the client's own take, which is what makes the clip
 * theirs rather than a repost.
 */
export const CommentarySchema = z.object({
  /** The caption: context, counterpoint, why it matters — in client voice, crediting the source. */
  caption: z.string().min(1),
  /** 1-3 plain sentences a client can read to understand what this clip is. */
  about: z.string().min(1),
  /** Speaker + episode + show, named in the caption. The on-clip attribution block alone is not enough. */
  sourceCredit: z.string().min(1),
});
export type Commentary = z.infer<typeof CommentarySchema>;

/**
 * One discovered topic candidate — what the scout proposes and what seeds the
 * catalog. `evidenceUrls` is the anti-fabrication rule made structural: a
 * candidate with no evidence and no client-document grounding is not
 * "trending", it is invented, and the prompt says so.
 */
export const TopicCandidateSchema = z.object({
  /** The catalog row: short, specific, ≤120 chars. */
  topic: z.string().min(3).max(120),
  /** The client's angle on it — what they would actually say. */
  angle: z.string().min(1).max(400),
  /** The opening line that has to stop a stranger's thumb. */
  hook: z.string().min(1).max(200),
  /** Which format suits it. Advisory: the sourcing cascade decides what footage exists. */
  format: ClipFormatSchema,
  /** Why this week and not any week. Must trace to `evidenceUrls` or to the client's own documents. */
  whyNow: z.string().min(1).max(400),
  /** Research documents this candidate is grounded in. Empty only when grounded in the client's own intel/profile. */
  evidenceUrls: z.array(z.string().url()).default([]),
  /** The scout's read on whether a voice carries this better than text alone. */
  voiceoverRecommended: z.boolean().default(false),
});
export type TopicCandidate = z.infer<typeof TopicCandidateSchema>;

export const TopicScoutOutputSchema = z.object({
  candidates: z.array(TopicCandidateSchema).min(DISCOVERY_CANDIDATE_MIN).max(DISCOVERY_CANDIDATE_MAX),
  /** One or two sentences on what in the research/intel drove the picks — read by a human debugging a weak week. */
  rationale: z.string().min(1),
});
export type TopicScoutOutput = z.infer<typeof TopicScoutOutputSchema>;

/** Veo's clip lengths. The pipeline picks one per beat from how long its narration runs. */
export const PLATE_SECONDS = [4, 6, 8] as const;

/**
 * One beat of an original short: what is said, what is shown on screen, and
 * what the footage under it should be. `visualBrief` is a SCENE, never a
 * message — the generator is told to render no text and no logos, because the
 * brand frame and captions composite on top.
 */
export const ScriptBeatSchema = z.object({
  /** The spoken line for this beat — or, with no voiceover, the line the captions carry. ≤ 30 words. */
  narration: z.string().min(1).max(260),
  /** The on-screen text when the short runs silent. ≤ 8 words, in the client's voice. */
  onScreenText: z.string().min(1).max(80),
  /** What the b-roll shows: a concrete scene, lighting, motion. No text, no logos, no brand names. */
  visualBrief: z.string().min(10).max(600),
  /** How long this beat holds on screen. */
  seconds: z.union([z.literal(4), z.literal(6), z.literal(8)]),
});
export type ScriptBeat = z.infer<typeof ScriptBeatSchema>;

export const ShortScriptSchema = z.object({
  /** The first thing a stranger hears or reads. Doubles as the first beat's opening. */
  hook: z.string().min(1).max(200),
  beats: z.array(ScriptBeatSchema).min(3).max(5),
  /** The post caption, in client voice. */
  caption: z.string().min(1),
  /** 1-3 plain sentences for the client's own team. */
  about: z.string().min(1),
  /** The script step's own call on whether this piece wants a voice. Overridden by the client's `voiceover` config when not `auto`. */
  voiceover: z.boolean(),
  voiceoverRationale: z.string().min(1).max(300),
  /** BCP-47 tag of the language the script is written in. */
  language: z.string().min(2).max(16),
});
export type ShortScript = z.infer<typeof ShortScriptSchema>;

/** The caption/about pair every finished clip carries, whatever its format. `sourceCredit` exists only for a clip of someone else's words. */
export interface ClipCopy {
  caption: string;
  about: string;
  sourceCredit?: string;
}

/** What the workflow returns. */
export interface TikTokAgentWorkflowResult {
  topic: string;
  topicSource: TopicSource;
  lane: typeof CLIP_LANE;
  format: ClipFormat;
  moment: MomentSelection;
  commentary: ClipCopy;
  /** Present for an original short. */
  script?: ShortScript;
  voiceover: boolean;
  deliverableId: string;
  durationSeconds: number;
}
