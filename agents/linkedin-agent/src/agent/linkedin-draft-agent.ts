import { z } from "zod";
import { BaseAgent, type AgentStepConfig } from "@agent-engine/core";
import { LINKEDIN_ARCHETYPES } from "../workflow/types.js";

/**
 * A single LinkedIn post (RFC-02 §5). `headline`, `hook`, `body`,
 * `hashtags`, `callToAction`, and `targetAudience` are the structured
 * breakdown; `text` is the fully composed post exactly as it will be
 * published (`hook` + `body` + `callToAction` + hashtags) — the single
 * field every gate and the render check actually operate on, same role
 * `text` plays on the X agent's output. `headline` is never published; it's
 * an internal working title for the client's content calendar. `archetype`
 * is the restored lane/mix concept (Phase 2.5 Batch 2.2, source of truth
 * `linkedin-voice-by-industry.md`'s 11 founder archetypes) — the model
 * echoes back which archetype it actually wrote the post in (it is handed
 * a chosen archetype as input; this field is the ground truth of what
 * shipped, which is what the workflow records for the next run's
 * never-repeat-the-last-lane check).
 */
export const LinkedInPostOutputSchema = z.object({
  headline: z.string().min(1),
  hook: z.string().min(1),
  body: z.string().min(1),
  hashtags: z.array(z.string()).default([]),
  callToAction: z.string().min(1),
  targetAudience: z.string().min(1),
  text: z.string().min(1),
  archetype: z.enum(LINKEDIN_ARCHETYPES),
});
export type LinkedInPostOutput = z.infer<typeof LinkedInPostOutputSchema>;

/**
 * The RFC-02 §5 migration: drafts exactly one LinkedIn post per run (RFC-01
 * §16.2's "one post, one run" ruling, the same recipe used for the X pilot).
 * `skillRef` resolves the full craft policy (voice, hook construction,
 * thought-leadership structure, hashtag policy) dynamically through
 * `runtime.promptStore` (RFC-01 §16.1) — nothing here is a hardcoded prompt
 * literal. `allowedTools` covers the mechanical render check and the three
 * content gates; `gate.lintPost` also runs as this agent's own
 * self-critique, bounded to one revision. `gateArgs: {platform: "linkedin"}`
 * pins that check to LinkedIn's real 3000-character limit explicitly — the
 * draft object handed to self-critique is the model's raw turn output,
 * before `outputSchema` defaults ever apply, so leaving `platform` for the
 * model to supply would risk falling back to `gate.lintPost`'s generic
 * 5000-character limit.
 */
export class LinkedInDraftAgent extends BaseAgent<LinkedInPostOutput> {
  protected readonly config: AgentStepConfig<LinkedInPostOutput> = {
    id: "linkedin-draft",
    description: "Draft a single LinkedIn post for the selected candidate topic and angle.",
    allowedTools: ["render.preview", "gate.lintPost", "gate.numbersSourced", "gate.brandCompliance"],
    outputSchema: LinkedInPostOutputSchema,
    // Pinned — RFC-02 §5: claude-sonnet-4-6 today, claude-sonnet-5 is an
    // equally acceptable pin once available; never a fallback for a pinned step.
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    skillRef: "linkedin-craft@2",
    selfCritique: { gateTool: "gate.lintPost", maxRevisions: 1, gateArgs: { platform: "linkedin" } },
  };
}
