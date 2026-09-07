import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { CommentarySchema, type Commentary } from "../workflow/types.js";

/**
 * COMPOSE's commentary layer (subskill-spec §2 step 4): the client's own take
 * on the moment.
 *
 * This is what separates the product from a repost. The clip is someone else's
 * words; the caption is the client's — context, counterpoint, why it matters,
 * in their voice, crediting whose words those were. The legacy product treats
 * a missing source credit in the caption as a failure even when the on-clip
 * attribution block is present, and the compliance step downstream enforces
 * that rather than trusting this one.
 *
 * It may read the client's own voice and brand documents, and nothing else.
 * The narrower list is the point: a commentary writer that can reach research
 * tools starts sourcing claims of its own, and this step is not entitled to
 * introduce a fact the episode did not contain.
 */
export class TikTokCommentaryAgent extends BaseAgent<Commentary> {
  protected readonly config: AgentStepConfig<Commentary> = {
    id: "tiktok-commentary",
    description:
      "Write the client's own take on this clipped moment: the caption (context, counterpoint, why it matters), a plain 1-3 sentence description for the client, and the source credit naming the speaker, episode and show. Use the client's voice rules. Add no claim the clip itself does not support.",
    allowedTools: ["client.getVoiceRules", "client.getBrand", "client.getStrategy"],
    outputSchema: CommentarySchema,
    // Client-facing copy in the client's language: a Hebrew-language brand
    // kit re-points this at the same vendor's strongest multilingual/RTL
    // model (AU34), the way every other drafting step in the fleet is.
    modelPolicy: resolveModelPolicy("tiktok-commentary", { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: true }),
    // Pinned to "3": v3 adds `sourceContext` — the real title/channel/URL of
    // harvested or attached footage — so the source credit names what the
    // footage actually is instead of a plausible-sounding episode. v2 added
    // the client-knowledge-and-recent-posts section. v1/v2 stay frozen.
    // Pinned to "4" (2026-09-07): v4 names the mechanical tells the lint gate
    // rejects (dashes, exclamation marks, the cliche bank) and drops every em
    // dash from its own text, for the same reason tiktok-script@2 did. v3
    // stays frozen.
    skillRef: "tiktok-commentary@4",
    // The lint 07-compliance runs on the caption and about, run first on the
    // model's own output so a tell is a revision here, not a held run there.
    selfCritique: {
      gateTool: "gate.lintPost",
      maxRevisions: 2,
      gateArgs: { platform: "generic" },
      gateInput: (draft) => ({
        text: [draft.caption, draft.about].filter((p): p is string => typeof p === "string" && p.trim().length > 0).join("\n\n"),
      }),
    },
  };
}
