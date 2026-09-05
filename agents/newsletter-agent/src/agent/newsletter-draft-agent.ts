import { z } from "zod";
import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";

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
 * edition body as the model authors it (`intro` + each section's
 * `heading`/`body` + `callToAction.text` + `signoff`) — the single field
 * every gate and the render check's body limit actually operate on, same
 * role `text` plays on the X, LinkedIn, Reddit, and Blog agents' output. The
 * workflow (`create-newsletter-agent-workflow.ts`, right after this step)
 * force-appends the client's compliance footer — `footerDisclaimer`,
 * `companyAddress`, `unsubscribeUrl` — onto `text` before any gate runs, so
 * the version every gate and the persisted deliverable actually see is the
 * true sent body, footer included.
 */
export const NewsletterPostOutputSchema = z.object({
  subjectLine: z.string().min(1),
  previewText: z.string().min(1),
  intro: z.string().min(1),
  sections: z.array(NewsletterSectionSchema).min(1),
  callToAction: NewsletterCallToActionSchema,
  signoff: z.string().min(1),
  text: z.string().min(1),
  /**
   * The client's locked compliance footer (e.g. "Acme Corp does not provide
   * financial advice; results may vary.") — never authored by the model.
   * Optional because not every client needs full compliance footer
   * treatment, but structurally present so the workflow has a real field to
   * force-inject the client's `requiredDisclaimer` into (RFC-02 §5's
   * migration-audit fix: the legacy `compliance-gate.mjs` force-injected
   * this at render time and never let the model write it itself).
   */
  footerDisclaimer: z.string().optional(),
  /**
   * The client's unsubscribe link — never authored by the model. The
   * workflow populates this from the client's brand config, the same
   * "platform supplies it, the model never touches it" rule as
   * `footerDisclaimer`.
   */
  unsubscribeUrl: z.string().optional(),
  /** The client's CAN-SPAM-required physical mailing address — never authored by the model, populated by the workflow the same way. */
  companyAddress: z.string().optional(),
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
    // SCRUM-291 (AU14) — the third of this ticket's three named agents
    // (AUDIT-2026-08-25 §3.2 ranks it below intel-report and blog, not risk-free).
    // Sized from `NewsletterPostOutputSchema` and the channel's own enforced
    // ceiling:
    //   - `gate.lintPost`'s "newsletter" platform cap (karos-gates/src/lint-post.ts,
    //     PLATFORM_MAX_LENGTH.newsletter) is 10,000 chars on `text`.
    //   - `text` is the composed `intro` + each section's `heading`/`body` +
    //     `callToAction.text` + `signoff` (this file's doc comment above), so
    //     those constituent fields are counted a second time inside `text`: up to
    //     ~10,000 chars twice is ~18,500 content chars from `text` plus a
    //     multi-section `sections` array, before subjectLine/previewText add a
    //     few hundred more.
    //   ~19,000 content chars at ~3.5 chars/token (JSON-escaped prose,
    //   conservative) is ~5.4k tokens of floor content — comfortably under the
    //   16,384 default today, which is why this is the fleet's lowest-risk named
    //   agent of the three, but "comfortably under an implicit default" is
    //   exactly the number-picked-by-feel this ticket replaces: 20000 is an
    //   explicit ceiling with margin for a model that runs long and for the
    //   schema growing, set above (not below) today's default so this can never
    //   regress an edition that was truncating for another reason.
    maxTokens: 20_000,
    // Pinned — RFC-02 §5 pinned claude-sonnet-4-6. Moved to claude-opus-4-8
    // (2026-09-05) with newsletter-craft@5: the edition is the one deliverable
    // a subscriber reads end to end, and the sonnet drafts read as generated
    // (verdict sentences, "not X. It is Y." reframes, symmetrical sections)
    // even with the tells listed in the prompt. Opus 4.8 is the strongest
    // model the router's MODEL_CAPABILITIES catalog carries today; a stronger
    // pin is welcome once it has a catalog row. Never a fallback for a pinned
    // step. A client's MODEL_STEP_NEWSLETTER_DRAFT_MODEL override still wins.
    modelPolicy: resolveModelPolicy("newsletter-draft", { policy: "pinned", model: "claude-opus-4-8" }),
    // Pinned to "2": v2 adds a language check to §2 (Voice) against
    // `clientVoiceContext` (the client's own profile description +
    // voice-rules guidelines) — nothing before it ever forwarded `profile`
    // to this prompt at all, so an outlet that states its own language in
    // plain prose (Geektime: "Israel's largest Hebrew-language technology...
    // site") got a fluent English edition regardless of channel (prep job
    // hcf9ymPGJC7mDS5pcEQ4, traced on instagram-agent but structural across
    // every channel). Cut from 1.md, not from latest.md — latest.md carries
    // a separate, still-uncommitted signoff/compliance-footer change this
    // change does not touch and must not overwrite. v1 stays frozen.
    // Pinned to "3": v3 adds the client-knowledge-and-recent-posts section
    // — clientIntelContext (the client's own intel report, distilled) is read
    // as authoritative before external facts, and recentPosts (the shipped-
    // output dedup window this agent now writes back into on delivery) is a
    // hard do-not-repeat constraint. v2 stays frozen.
    // Pinned to "5" (2026-09-05): v5 is a rewrite of the craft policy around
    // reading as a person rather than a summary bot — a named list of the
    // machine-writing tells the sonnet drafts kept producing, the shape of a
    // modern edition (a developed lead, three to five quick hits with real
    // links, one thing to do), markdown in `text` (the portal renders it), and
    // the new `research` input (every fetched source's title/url/excerpt, which
    // the draft never received before — prep job sp8ICAFLjKkYWb2DAh8R drafted
    // from one headline and linked every section to a homepage). v4 was never
    // pinned by any agent (it was latest.md's uncommitted signoff/footer
    // change, snapshotted); v3 stays frozen.
    skillRef: "newsletter-craft@5",
    selfCritique: { gateTool: "gate.lintPost", maxRevisions: 1, gateArgs: { platform: "newsletter" } },
  };
}
