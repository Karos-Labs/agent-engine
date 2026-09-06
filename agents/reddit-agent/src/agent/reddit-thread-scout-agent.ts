import { z } from "zod";
import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";

/**
 * Picks the ONE live thread this run should reply to, or declines.
 *
 * Legacy's own summary of the product: "finding the right thread is the
 * expensive skill; writing the reply is nearly free." The workflow's step 08
 * used to hold every run without a hand-supplied thread URL because nothing
 * could find one. `reddit.discoverThreads` now returns real, fresh candidates;
 * this agent judges them — which thread asks a question the client can answer
 * with genuine standing, where a reply adds something the thread does not yet
 * have, and where turning up would not read as a pitch.
 *
 * `selected: null` is a legitimate, expected answer. A week with no thread
 * worth replying to is a week without a Reddit reply, and the run holds
 * honestly on the scout's `passReason` rather than forcing a reply into the
 * least-bad thread.
 *
 * Every `url` in the output must be one of the candidates' own URLs; the
 * workflow rejects anything else, so the model cannot invent a thread.
 */
export const RedditThreadScoutOutputSchema = z.object({
  selected: z
    .object({
      /** Exactly one of the candidate URLs, verbatim. */
      url: z.string().min(1),
      /** Why this thread, in one or two sentences a reviewer would agree with. */
      why: z.string().min(1),
      /** Which reply shape the thread calls for. */
      angle: z.enum(["thorough-value", "personal-experience", "comparison-decision-help", "correction-with-receipts"]),
      /** 2-4 concrete things the reply should say that the thread does not already have. */
      whatToAdd: z.array(z.string().min(1)).min(1).max(5),
      /** True when answering honestly requires mentioning the client's own company or product. */
      requiresDisclosure: z.boolean().default(false),
    })
    .nullable(),
  /** When `selected` is null: why nothing qualified, naming what was looked at. */
  passReason: z.string().optional(),
  /** Other candidates considered, with the reason each lost. Bounded so the trace stays readable. */
  runnersUp: z.array(z.object({ url: z.string().min(1), why: z.string().min(1) })).max(5).default([]),
});
export type RedditThreadScoutOutput = z.infer<typeof RedditThreadScoutOutputSchema>;

export class RedditThreadScoutAgent extends BaseAgent<RedditThreadScoutOutput> {
  protected readonly config: AgentStepConfig<RedditThreadScoutOutput> = {
    id: "reddit-scout",
    description:
      "Choose the single live Reddit thread this client should reply to this run — the one where it has real standing, a reply adds something missing, and showing up will not read as marketing — or decline with a reason.",
    allowedTools: [],
    outputSchema: RedditThreadScoutOutputSchema,
    modelPolicy: resolveModelPolicy("reddit-scout", { policy: "pinned", model: "claude-sonnet-4-6" }),
    skillRef: "reddit-scout@1",
  };
}
