import { z } from "zod";
import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";

/** One story the plan commits to, traced to the research document it came from. */
export const NewsletterPlannedStorySchema = z.object({
  /** The research document's own title (or the catalog topic), so a reader of the trace can find it. */
  title: z.string().min(1),
  /** The research document's URL, verbatim. Omitted when the story came from a topic with no source. */
  url: z.string().optional(),
  /** Why this story and why now, for this audience. One or two sentences. */
  whyItMatters: z.string().min(1),
});
export type NewsletterPlannedStory = z.infer<typeof NewsletterPlannedStorySchema>;

/**
 * The edition plan: the editorial decisions made BEFORE any prose is written,
 * separate from the writing so that selection, angle and point of view are
 * chosen on the merits of the research rather than improvised mid-sentence.
 * Checkpointed as its own step, so the run's trace shows what was considered
 * and what was passed on, not only what shipped.
 */
export const NewsletterEditionPlanSchema = z.object({
  /** One sentence: what this edition is about and why a subscriber should care this week. */
  thesis: z.string().min(1),
  lead: NewsletterPlannedStorySchema.extend({
    /** The specific angle the lead takes: the mechanism, consequence or tension the edition explains, not a restatement of the headline. */
    angle: z.string().min(1),
    /** Concrete details lifted from the source that the draft must use: names, dates, figures (verbatim), quotes. At least one. */
    specifics: z.array(z.string().min(1)).min(1),
    /** What the client's team actually thinks this means. A stance, in one or two sentences. */
    ourTake: z.string().min(1),
  }),
  /** Two to five shorter items from the research worth a paragraph each. Empty only when the research genuinely supports nothing else. */
  quickHits: z.array(NewsletterPlannedStorySchema).max(5),
  /** The single concrete action a reader can take this week because of this edition. */
  oneThingToDo: z.string().min(1),
  /** Direction for the subject line: the tension or specific to lead with, in a phrase. Not the line itself. */
  subjectLineDirection: z.string().min(1),
  /** Research stories deliberately left out, each with the reason, so the trace shows curation happened. */
  passedOn: z.array(z.object({ title: z.string().min(1), reason: z.string().min(1) })).default([]),
});
export type NewsletterEditionPlan = z.infer<typeof NewsletterEditionPlanSchema>;

/**
 * Plans one edition from the run's research before a word is drafted.
 *
 * Why a separate step: the single-agent recipe asked one model call to read
 * every source, pick the lead, decide the angle, curate the briefs, and write
 * finished prose at once. What came out (prep job sp8ICAFLjKkYWb2DAh8R) was
 * a competent restatement of one headline, because selection had never
 * really happened: the draft used the first story it was pointed at and
 * generalised the rest. Editors plan an issue and then write it. Splitting
 * the two gives the plan its own checkpoint (the reviewer can see what was
 * considered and rejected), lets the draft be judged against a stated
 * intent, and keeps a revision from silently re-deciding the edition.
 *
 * No tools: this is reading and deciding. `skillRef` resolves the planning
 * policy through `runtime.promptStore` (RFC-01 §16.1).
 */
export class NewsletterPlanAgent extends BaseAgent<NewsletterEditionPlan> {
  protected readonly config: AgentStepConfig<NewsletterEditionPlan> = {
    id: "newsletter-plan",
    description: "Read every research source and the client's context, then decide the edition: the lead and its angle, the quick hits, the one thing to do, and what to leave out.",
    allowedTools: [],
    outputSchema: NewsletterEditionPlanSchema,
    // The plan is small (a few hundred tokens of decisions), but it reads a
    // full research digest; 8_000 is generous headroom for `passedOn` on a
    // wide pull, well under any model's ceiling.
    maxTokens: 8_000,
    // Opus, same as the draft: selection is where taste matters most, and a
    // cheaper planner hands a stronger writer a weaker edition.
    modelPolicy: resolveModelPolicy("newsletter-plan", { policy: "pinned", model: "claude-opus-4-8" }),
    skillRef: "newsletter-plan@1",
  };
}
