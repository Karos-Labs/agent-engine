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
 * `sourcesUsed` (v5) lists the research URLs a fact was actually drawn from,
 * so a reviewer can check a claim without re-reading the research payload.
 * Optional and defaulted: a reply that rests on the thread and the client's
 * own knowledge alone has none, which is the common case.
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
  sourcesUsed: z.array(z.string().min(1)).default([]),
});
export type RedditReplyOutput = z.infer<typeof RedditReplyOutputSchema>;

/**
 * Reddit-specific pitch-tells, on top of `gate.lintPost`'s shared bank.
 *
 * The first nine are legacy's `check-draft.mjs` (`PITCH_TELLS`/
 * `BANNED_PHRASES`). The rest were added with reddit-craft@5 from what
 * actually reads as a marketing account in a thread: advice-column openers,
 * the "hope this helps" sign-off family, and the vocabulary the craft guide's
 * §2 bans by name. Kept as an exported constant so the evals' deterministic
 * assertions run the identical list rather than a hand-copied one.
 */
export const REDDIT_BANNED_PHRASES: readonly string[] = [
  "lets dive in",
  "id be happy to help",
  "honoured to",
  "move the needle for you",
  "feel free to pm",
  "shoot me a dm",
  "happy to jump on a call",
  "check out my",
  "our platform helps",
  "great question",
  "hope this helps",
  "hope that helps",
  "happy to elaborate",
  "feel free to dm",
  "feel free to reach out",
  "game-changing",
  "game changer",
  "revolutionary",
  "seamless",
  "unlock",
  "empower",
  "as an ai",
];

/**
 * The RFC-02 §5 migration, restored to the reply-only model in Phase 2.5
 * Batch 2.1: drafts exactly one Reddit reply per run to an already-selected
 * thread (the workflow selects the target thread; this agent never chooses
 * one). `skillRef` resolves the full craft policy dynamically through
 * `runtime.promptStore` (RFC-01 §16.1) — nothing here is a hardcoded prompt
 * literal. `allowedTools` covers the mechanical render check and the three
 * content gates; `gate.lintPost` also runs as this agent's own self-critique,
 * bounded to one revision, with `bannedPhrases` carrying the Reddit-specific
 * pitch-tells above. `gateArgs: {platform: "reddit"}` pins the length check
 * to Reddit's entry (`gate.lintPost`'s "reddit" entry is still the 40,000-char
 * submission selftext limit today, more permissive than a comment ever needs
 * — this agent's own `render.preview` tool is what actually enforces the
 * tighter real comment limit, at the workflow's render step).
 *
 * Model: pinned to `claude-opus-4-8`, the same pin newsletter-agent moved its
 * draft to for craft. A Reddit reply is short, so the premium tier costs
 * cents per run, and the channel's tolerance for a wrong register is zero:
 * one reply that reads as marketing costs the account its standing in that
 * community. Sonnet stays on the two judgment steps around it (channel plan,
 * thread scout), where the output is a decision rather than prose a
 * community will read.
 */
export class RedditDraftAgent extends BaseAgent<RedditReplyOutput> {
  protected readonly config: AgentStepConfig<RedditReplyOutput> = {
    id: "reddit-draft",
    description:
      "Draft a single Reddit reply to the selected target thread, grounded in the thread's own text and existing replies, in the account's own voice, comments only.",
    allowedTools: ["render.preview", "gate.lintPost", "gate.numbersSourced", "gate.brandCompliance"],
    outputSchema: RedditReplyOutputSchema,
    modelPolicy: resolveModelPolicy("reddit-draft", { policy: "pinned", model: "claude-opus-4-8" }),
    // Pinned to "5": v5 is the thread-grounded guide — it reads `thread`
    // (the poster's full text and the existing replies, fetched live),
    // follows `scoutBrief` (why this thread, what to add), and cites
    // `research` entries by URL. Everything before v5 drafted from the thread
    // TITLE alone, which is why replies were generic. v1–v4 stay frozen on
    // disk; the registry lists them all.
    skillRef: "reddit-craft@5",
    selfCritique: {
      gateTool: "gate.lintPost",
      maxRevisions: 1,
      gateArgs: {
        platform: "reddit",
        bannedPhrases: [...REDDIT_BANNED_PHRASES],
      },
    },
  };
}
