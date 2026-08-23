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
    modelPolicy: resolveModelPolicy("tiktok-commentary", { policy: "pinned", model: "claude-sonnet-4-6" }),
    skillRef: "tiktok-commentary@1",
  };
}
