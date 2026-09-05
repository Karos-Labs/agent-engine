import { z } from "zod";
import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";

/**
 * The auto-derived Reddit charter: which communities this client can
 * genuinely help in, what to look for there, and what it must never engage on.
 *
 * Produced ONLY when a client has no Reddit configuration at all — no
 * `targetSubreddits` in client config, no charter on file, no setup form on
 * the run. Before this existed that state was a permanent `blocked_intake`:
 * prep job 5A6bc8VUgRKcCg0Vh7xz (Karos Labs, 2026-09-05) failed with "client
 * has not configured any target subreddits yet" although the client had a
 * profile, a brand kit with voice guidelines and six synced knowledge
 * documents — everything needed to decide where it belongs on Reddit, and
 * nothing that would.
 *
 * The output is recorded as the charter (`strategy/reddit-agent/config`) with
 * `autoDerived: true`, so a person can still replace it with a real setup form
 * later — `runRedditChannelSetup` lets a form overwrite an auto-derived
 * charter, and only an auto-derived one.
 */
export const RedditChannelPlanOutputSchema = z.object({
  targetSubreddits: z
    .array(
      z.object({
        /** Bare community name, e.g. "marketing". */
        name: z.string().min(1),
        /** One sentence: what this client can credibly add there. */
        why: z.string().min(1),
      }),
    )
    .min(3)
    .max(8),
  /** Words and phrases threads worth replying to would contain. Used to rank live threads. */
  searchKeywords: z.array(z.string().min(1)).min(4).max(20),
  /** Subjects to stay out of even when a thread invites it. */
  offLimitsTopics: z.array(z.string().min(1)).default([]),
  /** How replies from this client should sound in a community that did not ask for them. */
  voiceNotes: z.string().min(1),
  /** The one-line disclosure to use when the client's own product or company comes up. */
  disclosureLine: z.string().min(1),
});
export type RedditChannelPlanOutput = z.infer<typeof RedditChannelPlanOutputSchema>;

export class RedditChannelPlannerAgent extends BaseAgent<RedditChannelPlanOutput> {
  protected readonly config: AgentStepConfig<RedditChannelPlanOutput> = {
    id: "reddit-channel-plan",
    description:
      "Derive a Reddit charter for a client that has none: the communities it can genuinely help in, the keywords that mark a thread worth replying to, the subjects it must stay out of, and how it should sound.",
    allowedTools: [],
    outputSchema: RedditChannelPlanOutputSchema,
    modelPolicy: resolveModelPolicy("reddit-channel-plan", { policy: "pinned", model: "claude-sonnet-4-6" }),
    skillRef: "reddit-channel-plan@1",
  };
}
