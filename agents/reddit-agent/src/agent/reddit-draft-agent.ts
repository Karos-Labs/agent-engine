import { z } from "zod";
import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";

/**
 * A single Reddit reply (Phase 2.5 Batch 2.1 domain-logic restoration).
 * Legacy's non-negotiable rule is "comments only, never original posts"
 * (`reddit-agent-v2/SKILL.md` line 9: "Comments only, never original
 * posts"; `references/reddit-craft.md` §1: "We do not start threads")  —
 * the pre-restoration schema drafted an original submission
 * (`title`/`body`/`targetSubreddit`/`flair`), the exact opposite of the
 * legacy model, and was the migration audit's single biggest Reddit finding.
 * This schema replaces it outright rather than living alongside it: nothing
 * downstream should ever again have the option of producing a submission
 * shape.
 *
 * `targetThreadUrl`/`targetThreadTitle` identify the existing thread being
 * replied to (the thread's own title is carried for context/logging only —
 * we never write it, only read it). `parentCommentId` is set only when
 * replying to a specific comment rather than the thread root (a top-level
 * comment on the submission itself is the common case and leaves this
 * unset). `replyBody` is the actual comment text. `disclosureIncluded`
 * records whether this draft's own text carries the account's disclosure
 * line — `gate.subredditRules` uses it both for the existing
 * disclosure-required check and as the least-bad Phase-1 proxy for "this
 * draft attempts a product mention" (see that gate's own doc comment) feeding
 * the warming/cooldown checks, since Phase 1 has no `account.json`-style
 * `mention_names` text scanner yet. `text` mirrors every other channel's
 * convention (X, LinkedIn): the flattened text every mechanical gate and the
 * render check actually operate on. Because a reply has no separate title,
 * `text` and `replyBody` carry identical content — the field still exists
 * so this agent's gate-calling code doesn't need a Reddit-specific
 * exception to reach into `replyBody` instead of `text`.
 *
 * `flair` is deliberately dropped, not merely renamed: flair is a
 * submission-level Reddit feature (attached to a post, shown next to its
 * title in the subreddit listing) with no comment equivalent, so a field
 * named `flair` on a reply schema would be meaningless input the model could
 * only guess at.
 */
export const RedditReplyOutputSchema = z.object({
  targetThreadUrl: z.string().min(1),
  targetThreadTitle: z.string().min(1),
  parentCommentId: z.string().min(1).optional(),
  replyBody: z.string().min(1),
  targetSubreddit: z.string().min(1),
  disclosureIncluded: z.boolean().default(false),
  text: z.string().min(1),
});
export type RedditReplyOutput = z.infer<typeof RedditReplyOutputSchema>;

/**
 * The RFC-02 §5 migration, restored to the reply-only model in Phase 2.5
 * Batch 2.1: drafts exactly one Reddit reply per run to an already-selected
 * thread (the workflow's step 08 selects the target thread; this agent never
 * chooses one). `skillRef` resolves the full craft policy dynamically
 * through `runtime.promptStore` (RFC-01 §16.1) — nothing here is a
 * hardcoded prompt literal. Pinned to `reddit-craft@2`, the reply-only craft
 * guide (`@1` is kept on disk as the frozen historical submission-era
 * version, never resolved by this agent again). `allowedTools` covers the
 * mechanical render check and the three content gates; `gate.lintPost` also
 * runs as this agent's own self-critique, bounded to one revision, with
 * `bannedPhrases` carrying the Reddit-specific pitch-tells from legacy's
 * `check-draft.mjs` (`PITCH_TELLS`/`BANNED_PHRASES`) that the shared
 * `karos-gates` bank doesn't already cover — see that gate's own bank for
 * what's already covered mechanically. `gateArgs: {platform: "reddit"}`
 * pins the length check to Reddit's real 10,000-character comment limit
 * (`gate.lintPost`'s "reddit" entry is still the 40,000-char submission
 * selftext limit today, more permissive than a comment ever needs — this
 * agent's own `render.preview` tool is what actually enforces the tighter
 * real comment limit, at workflow step 17).
 */
export class RedditDraftAgent extends BaseAgent<RedditReplyOutput> {
  protected readonly config: AgentStepConfig<RedditReplyOutput> = {
    id: "reddit-draft",
    description: "Draft a single Reddit reply to the selected target thread, in the account's own voice, comments only.",
    allowedTools: ["render.preview", "gate.lintPost", "gate.numbersSourced", "gate.brandCompliance"],
    outputSchema: RedditReplyOutputSchema,
    // Pinned — RFC-02 §5: claude-sonnet-4-6 today, claude-sonnet-5 is an
    // equally acceptable pin once available; never a fallback for a pinned step.
    modelPolicy: resolveModelPolicy("reddit-draft", { policy: "pinned", model: "claude-sonnet-4-6" }),
    // Pinned to "3": v3 adds a language check to §2 (Community authenticity)
    // against `clientVoiceContext` (the client's own profile description +
    // voice-rules guidelines), deferring to the target thread's own language
    // when that gives a stronger signal — nothing before it ever forwarded
    // `profile` to this prompt at all (prep job hcf9ymPGJC7mDS5pcEQ4, traced
    // on instagram-agent but structural across every channel). v2 stays frozen.
    // Pinned to "4": v4 adds the client-knowledge-and-recent-posts section
    // — clientIntelContext (the client's own intel report, distilled) is read
    // as authoritative before external facts, and recentPosts (the shipped-
    // output dedup window this agent now writes back into on delivery) is a
    // hard do-not-repeat constraint. v3 stays frozen.
    skillRef: "reddit-craft@4",
    selfCritique: {
      gateTool: "gate.lintPost",
      maxRevisions: 1,
      gateArgs: {
        platform: "reddit",
        bannedPhrases: [
          "lets dive in",
          "id be happy to help",
          "honoured to",
          "move the needle for you",
          "feel free to pm",
          "shoot me a dm",
          "happy to jump on a call",
          "check out my",
          "our platform helps",
        ],
      },
    },
  };
}
