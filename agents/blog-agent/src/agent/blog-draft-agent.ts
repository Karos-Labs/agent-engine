import { z } from "zod";
import { BaseAgent, type AgentStepConfig } from "@agent-engine/core";

/**
 * A single long-form blog article (RFC-02 §5). `headersList` is the
 * article's real H2/H3 outline and must match the headers that actually
 * appear in `bodyMarkdown`. `excerpt` (index-page teaser) and
 * `metaDescription` (search-result snippet) are deliberately distinct
 * fields, not the same text reused twice. `text` is the fully composed
 * article exactly as it will be published (`title` + `bodyMarkdown`) — the
 * single field every gate and the render check actually operate on, same
 * role `text` plays on the X, LinkedIn, and Reddit agents' output.
 */
export const BlogPostOutputSchema = z.object({
  title: z.string().min(1),
  slug: z.string().min(1),
  excerpt: z.string().min(1),
  bodyMarkdown: z.string().min(1),
  headersList: z.array(z.string()).default([]),
  metaDescription: z.string().min(1),
  estimatedReadMinutes: z.number().positive(),
  text: z.string().min(1),
});
export type BlogPostOutput = z.infer<typeof BlogPostOutputSchema>;

/**
 * The RFC-02 §5 migration: drafts exactly one long-form blog article per
 * run (RFC-01 §16.2's "one post, one run" ruling, the same recipe used for
 * the X, LinkedIn, and Reddit pilots). `skillRef` resolves the full craft
 * policy (long-form structure, intro hooks, section transitions, SEO
 * practices, CTA formatting) dynamically through `runtime.promptStore`
 * (RFC-01 §16.1) — nothing here is a hardcoded prompt literal.
 * `allowedTools` covers the mechanical render check and the three content
 * gates; `gate.lintPost` also runs as this agent's own self-critique,
 * bounded to one revision. `gateArgs: {platform: "blog"}` pins that check
 * to blog's real 20,000-character long-form ceiling explicitly — the draft
 * object handed to self-critique is the model's raw turn output, before
 * `outputSchema` defaults ever apply, so leaving `platform` for the model
 * to supply would risk falling back to `gate.lintPost`'s generic
 * 5,000-character limit (far too short for a real article).
 */
export class BlogDraftAgent extends BaseAgent<BlogPostOutput> {
  protected readonly config: AgentStepConfig<BlogPostOutput> = {
    id: "blog-draft",
    description: "Draft a single long-form blog article for the selected content pillar, target keyword, and angle.",
    allowedTools: ["render.preview", "gate.lintPost", "gate.numbersSourced", "gate.brandCompliance"],
    outputSchema: BlogPostOutputSchema,
    // Pinned — RFC-02 §5: claude-sonnet-4-6 today, claude-sonnet-5 is an
    // equally acceptable pin once available; never a fallback for a pinned step.
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    skillRef: "blog-craft@1",
    selfCritique: { gateTool: "gate.lintPost", maxRevisions: 1, gateArgs: { platform: "blog" } },
  };
}
