import { z } from "zod";

/**
 * The clip lane this product owns, and the only one it will ever reserve from.
 *
 * Named explicitly rather than left to the caller because the legacy product's
 * first rule is that it does ONE thing: podcast/commentary clips. Carousels and
 * every static format belong to instagram-agent. A lane parameter here would be
 * an invitation to run something else through a pipeline whose QA gates assume
 * a talking-head cut.
 */
export const CLIP_LANE = "commentary-clip";

/** Clip length bounds (SKILL.md: 20s-2min, most land 25-60s). */
export const CLIP_DURATION_MIN_SECONDS = 20;
export const CLIP_DURATION_MAX_SECONDS = 120;

/**
 * The per-client settings this agent refuses to start without.
 *
 * `sourcePool` is the verified inventory of shows the client may draw on. It
 * is required and never defaulted: picking a source for a client is a rights
 * and relevance decision someone made deliberately, and an agent that fell
 * back to "any podcast" would be clipping strangers' content on their behalf.
 */
export const TikTokClipConfigSchema = z.object({
  /**
   * The verified inventory the client may draw on. Entries that are
   * `gs://`/`https://` URIs are OWNED FOOTAGE the sourcing cascade's Tier 2a
   * can ingest directly (a podcast episode, a keynote recording); plain-name
   * entries remain editorial identifiers of shows the client may clip.
   */
  sourcePool: z.array(z.string().min(1)).min(1),
  /** Where the client's own long-form media lives, when they have footage of their own. */
  ownedFootageRoot: z.string().min(1).optional(),
  /** Names worth clipping wherever they appear — the highest-yield discovery signal in the legacy product. */
  guestWatchlist: z.array(z.string().min(1)).default([]),
  /** Subjects this client will not clip, on top of the global topic guardrail. */
  narrowing: z.array(z.string().min(1)).default([]),
  /** A standing series header ("PITCH SCHOOL | LESSON 15" style) rendered in the branded frame's top bar. */
  seriesHeader: z.string().min(1).max(60).optional(),
});
export type TikTokClipConfig = z.infer<typeof TikTokClipConfigSchema>;

/** Which sourcing tier actually produced this run's footage — recorded on the intake, the deliverable, and the hold reason when every tier came up dry. */
export type ClipSourceTier = "user-asset" | "owned-footage" | "web-harvest" | "generated";

/** What the run resolved before any model was asked anything. */
export interface TikTokIntake {
  config: TikTokClipConfig;
  /** The source moment this run is producing from. */
  topic: string;
  /** Set when the topic came from the catalog, so the reservation can be committed or released. */
  reservationKey?: string;
  /** The media file to clip. */
  sourcePath: string;
  /** Which tier the footage came from. A `generated` source has no transcript — the spoken-moment steps are skipped for it. */
  sourceTier: ClipSourceTier;
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

/** What the workflow returns. */
export interface TikTokAgentWorkflowResult {
  topic: string;
  lane: typeof CLIP_LANE;
  moment: MomentSelection;
  commentary: Commentary;
  deliverableId: string;
  durationSeconds: number;
}
