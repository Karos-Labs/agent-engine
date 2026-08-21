import type { RedditReplyOutput } from "../agent/reddit-draft-agent.js";

/**
 * The v2 JSON delivery envelope karosCMO's `reddit-drafts.ts` reader expects
 * for a NEW Reddit deliverable — `isRedditV2Envelope`/`parseRedditDrafts`
 * there prefer this shape over the legacy `# Reddit answer drafts` markdown,
 * which that module's own doc comment says "nothing writes... any more."
 * Duplicated here rather than imported from a shared package for the same
 * reason `karosCMO/src/lib/agent-engine/read-run.ts` duplicates agent-engine's
 * own Firestore record shapes: agent-engine is a separate deployable with its
 * own release cycle.
 */
export const REDDIT_V2_ENVELOPE_KIND = "reddit-drafts-v2";

/**
 * Renders this run's single reply into that envelope. One thread, one reply
 * per run (Phase 2.5 Batch 2.1's "comments only, never original posts, one
 * thread at a time" model), so `threads` always has exactly one entry with
 * one `approaches` element — `RedditReplyOutputSchema` never produces a
 * second approach the way the lab repo's v2 pipeline does.
 *
 * Persisted alongside the existing structured `draft` object (additive, see
 * step 19's own call site), not in place of it.
 */
export function renderRedditDraftsEnvelope(input: {
  account?: string;
  targetThreadUrl: string;
  targetThreadTitle: string;
  targetSubreddit: string;
  draft: RedditReplyOutput;
}): string {
  const { account, targetThreadUrl, targetThreadTitle, targetSubreddit, draft } = input;
  const envelope = {
    kind: REDDIT_V2_ENVELOPE_KIND,
    outcome: "delivered" as const,
    ...(account ? { account } : {}),
    threads: [
      {
        folder: "01-answer",
        threadTitle: targetThreadTitle,
        threadUrl: targetThreadUrl,
        subreddit: `r/${targetSubreddit}`,
        ...(draft.disclosureIncluded ? { disclosure: "This reply discloses the account's affiliation, per subreddit rules." } : {}),
        approaches: [{ id: "approach-1" as const, text: draft.replyBody }],
      },
    ],
  };
  return JSON.stringify(envelope);
}
