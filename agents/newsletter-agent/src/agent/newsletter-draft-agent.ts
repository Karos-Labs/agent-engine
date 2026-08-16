import { z } from "zod";
import { BaseAgent, type AgentStepConfig } from "@agent-engine/core";

/** One scannable story within a newsletter edition — a heading, short body, and an optional link to the full story. */
export const NewsletterSectionSchema = z.object({
  heading: z.string().min(1),
  body: z.string().min(1),
  linkUrl: z.string().optional(),
});
export type NewsletterSection = z.infer<typeof NewsletterSectionSchema>;

/** A single, specific invitation — never more than one per edition (newsletter-craft@1 §7). */
export const NewsletterCallToActionSchema = z.object({
  text: z.string().min(1),
  url: z.string().min(1),
});
export type NewsletterCallToAction = z.infer<typeof NewsletterCallToActionSchema>;

/**
 * A single newsletter edition (RFC-02 §5). `subjectLine` and `previewText`
 * are inbox metadata — they never appear inside the sent body itself, so
 * they're deliberately excluded from `text`. `text` is the fully composed
 * edition body exactly as it will be sent (`intro` + each section's
 * `heading`/`body` + `callToAction.text` + `signoff`) — the single field
 * every gate and the render check's body limit actually operate on, same
 * role `text` plays on the X, LinkedIn, Reddit, and Blog agents' output.
 */
export const NewsletterPostOutputSchema = z.object({
  subjectLine: z.string().min(1),
  previewText: z.string().min(1),
  intro: z.string().min(1),
  sections: z.array(NewsletterSectionSchema).min(1),
  callToAction: NewsletterCallToActionSchema,
  signoff: z.string().min(1),
  text: z.string().min(1),
});
export type NewsletterPostOutput = z.infer<typeof NewsletterPostOutputSchema>;

/**
 * The RFC-02 §5 migration: drafts exactly one newsletter edition per run
 * (RFC-01 §16.2's "one post, one run" ruling, the same recipe used for the
 * X, LinkedIn, Reddit, and Blog pilots). `skillRef` resolves the full craft
 * policy (subject line construction, preheader synergy, scannable section
 * structure, editorial curation, spam-trigger hygiene) dynamically through
 * `runtime.promptStore` (RFC-01 §16.1) — nothing here is a hardcoded prompt
 * literal. `allowedTools` covers the mechanical render check and the three
 * content gates; `gate.lintPost` also runs as this agent's own
 * self-critique, bounded to one revision. `gateArgs: {platform:
 * "newsletter"}` pins that check to the edition body's real
 * 10,000-character ceiling explicitly — the draft object handed to
 * self-critique is the model's raw turn output, before `outputSchema`
 * defaults ever apply, so leaving `platform` for the model to supply would
 * risk falling back to `gate.lintPost`'s generic 5,000-character limit.
 */
export class NewsletterDraftAgent extends BaseAgent<NewsletterPostOutput> {
  protected readonly config: AgentStepConfig<NewsletterPostOutput> = {
    id: "newsletter-draft",
    description: "Draft a single newsletter edition for the selected main story and secondary sections.",
    allowedTools: ["render.preview", "gate.lintPost", "gate.numbersSourced", "gate.brandCompliance"],
    outputSchema: NewsletterPostOutputSchema,
    // Pinned — RFC-02 §5: claude-sonnet-4-6 today, claude-sonnet-5 is an
    // equally acceptable pin once available; never a fallback for a pinned step.
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    skillRef: "newsletter-craft@1",
    selfCritique: { gateTool: "gate.lintPost", maxRevisions: 1, gateArgs: { platform: "newsletter" } },
  };
}
