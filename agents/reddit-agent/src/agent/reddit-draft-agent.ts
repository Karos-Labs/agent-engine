import { z } from "zod";
import { BaseAgent, type AgentStepConfig } from "@agent-engine/core";

/**
 * A single Reddit post (RFC-02 §5). `title` is the feed-level hook (the
 * clickable headline); `hook` is the opening line of `body` that keeps a
 * reader going once they've clicked in — distinct roles, same pairing
 * LinkedIn's `headline`/`hook` split uses. `text` is the fully composed post
 * exactly as it will be published (`title` + `body`) — the single field
 * every gate and the render check actually operate on, same role `text`
 * plays on the X and LinkedIn agents' output. `flair` defaults to empty:
 * most subreddits don't require one, and guessing at a flair that doesn't
 * exist is worse than leaving it blank (RFC-02 §5, reddit-craft@1 §9).
 */
export const RedditPostOutputSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  targetSubreddit: z.string().min(1),
  flair: z.string().default(""),
  hook: z.string().min(1),
  text: z.string().min(1),
});
export type RedditPostOutput = z.infer<typeof RedditPostOutputSchema>;

/**
 * The RFC-02 §5 migration: drafts exactly one Reddit post per run (RFC-01
 * §16.2's "one post, one run" ruling, the same recipe used for the X and
 * LinkedIn pilots). `skillRef` resolves the full craft policy (community
 * authenticity, non-promotional framing, hook construction, karma/vote
 * constraints) dynamically through `runtime.promptStore` (RFC-01 §16.1) —
 * nothing here is a hardcoded prompt literal. `allowedTools` covers the
 * mechanical render check and the three content gates; `gate.lintPost` also
 * runs as this agent's own self-critique, bounded to one revision.
 * `gateArgs: {platform: "reddit"}` pins that check to Reddit's real
 * 40,000-character selftext limit explicitly — the draft object handed to
 * self-critique is the model's raw turn output, before `outputSchema`
 * defaults ever apply, so leaving `platform` for the model to supply would
 * risk falling back to `gate.lintPost`'s generic 5,000-character limit.
 */
export class RedditDraftAgent extends BaseAgent<RedditPostOutput> {
  protected readonly config: AgentStepConfig<RedditPostOutput> = {
    id: "reddit-draft",
    description: "Draft a single Reddit post for the selected candidate topic, angle, and target subreddit.",
    allowedTools: ["render.preview", "gate.lintPost", "gate.numbersSourced", "gate.brandCompliance"],
    outputSchema: RedditPostOutputSchema,
    // Pinned — RFC-02 §5: claude-sonnet-4-6 today, claude-sonnet-5 is an
    // equally acceptable pin once available; never a fallback for a pinned step.
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    skillRef: "reddit-craft@1",
    selfCritique: { gateTool: "gate.lintPost", maxRevisions: 1, gateArgs: { platform: "reddit" } },
  };
}
