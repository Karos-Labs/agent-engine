import { z } from "zod";
import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";

const ScoreSchema = z.number().int().min(1).max(5);

/**
 * The editor's verdict on a finished draft. `revise` sends the draft back
 * with `notes` injected into the redraft; `approve` lets it through to the
 * human review gate. Scores are recorded either way so the trace shows how
 * close a draft was, and so a run that ships on its final round carries the
 * editor's reservations to the reviewer instead of losing them.
 */
export const NewsletterEditorVerdictSchema = z.object({
  verdict: z.enum(["approve", "revise"]),
  scores: z.object({
    /** Does every sentence carry something the reader did not know: a name, a figure, a mechanism, a consequence? 5 = no filler at all. */
    specificity: ScoreSchema,
    /** Does it sound like this client's team, in this client's language and register, with a point of view? 5 = unmistakably theirs. */
    voice: ScoreSchema,
    /** Does the shape serve a scanning reader: a developed lead, short linked briefs, one action, one CTA, headings that stand alone? 5 = nothing to move. */
    structure: ScoreSchema,
    /** Would a subscriber believe a person wrote this? 5 = no generated-prose tells at all, varied rhythm, an actual opinion. */
    humanity: ScoreSchema,
  }),
  /** Concrete, actionable notes for the redraft. Each quotes the offending text and says what to do instead. Required on `revise`; welcome on `approve` as polish the human reviewer may apply. */
  notes: z.array(z.string().min(1)),
  /** The one line that best shows what the edition should sound like throughout, quoted. Optional. */
  strongestLine: z.string().optional(),
});
export type NewsletterEditorVerdict = z.infer<typeof NewsletterEditorVerdictSchema>;

/**
 * The editor: a second, independent model pass that reads the finished
 * draft the way a subscriber would and either approves it or sends it back
 * with notes. The deterministic checks (`gate.lintPost`,
 * `newsletter.editorialLint`, the numbers gate) have already run; this is
 * the judgment none of them can make: is it specific, is it in the client's
 * voice, does it read as a person.
 *
 * Why a separate agent rather than more self-critique on the draft step:
 * `selfCritique` is the same model re-reading its own output against one
 * mechanical gate, and it approves its own tells. A fresh context with a
 * different brief (judge, do not write) catches what the author cannot see,
 * which is the same reason a publication has editors. Bounded by the
 * workflow to `MAX_EDITORIAL_ROUNDS`; on the last round a `revise` verdict
 * ships flagged to the human reviewer with the notes attached, never held,
 * because taste is not entitled to block a person's decision.
 */
export class NewsletterEditorAgent extends BaseAgent<NewsletterEditorVerdict> {
  protected readonly config: AgentStepConfig<NewsletterEditorVerdict> = {
    id: "newsletter-editor",
    description:
      "Read the finished edition against the plan, the client's voice and the craft guide as a demanding editor. Approve it, or send it back with concrete notes that quote the offending lines.",
    allowedTools: [],
    outputSchema: NewsletterEditorVerdictSchema,
    maxTokens: 4_000,
    modelPolicy: resolveModelPolicy("newsletter-editor", { policy: "pinned", model: "claude-opus-4-8" }),
    skillRef: "newsletter-editor@1",
  };
}
