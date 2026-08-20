import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { ResearchOutputSchema, type ResearchOutput } from "../workflow/types.js";

/**
 * RFC-03 §3 step 04: "research the subject with verbatim raw payload
 * capture." The verbatim-capture half of that requirement is already
 * satisfied by `research.pull` itself (it persists the raw payload to the
 * workspace store before this agent ever runs, `packages/tools/karos-research/
 * src/pull.ts`) — this agent's own job is the *judgment* half: read that raw
 * payload and extract the facts worth carrying into slide copy, each traced
 * to a source and a date (RFC-03 §1: "every fact that will reach a slide
 * needs a source + date — no drafting step may search afterward").
 *
 * `allowedTools: []` — same reasoning as `IntelReportDraftAgent`
 * (`agents/intel-report-agent/src/agent/intel-report-draft-agent.ts`):
 * everything this step needs (the topic, the already-fetched raw payload)
 * is hand-assembled into its input by the workflow ahead of time, so this
 * agent's single turn goes straight to a `final` output rather than running
 * its own tool-calling loop. This also keeps step 04 bounded and cheap
 * context-wise — the "context bloat" legacy defect (RFC-03 §1) this whole
 * migration exists to avoid — since the agent only ever sees one already-
 * fetched payload, never a growing pile of prior runs' raw research.
 */
export class InstagramResearchAgent extends BaseAgent<ResearchOutput> {
  protected readonly config: AgentStepConfig<ResearchOutput> = {
    id: "instagram-research",
    description: "Extract sourced, dated facts worth carrying into carousel slide copy from one already-fetched raw research payload.",
    allowedTools: [],
    outputSchema: ResearchOutputSchema,
    // Pinned — same rationale as every other agent in this repo (RFC-02 §5):
    // even an extraction-flavored step never silently falls back to a
    // different model mid-run.
    modelPolicy: resolveModelPolicy("instagram-research", { policy: "pinned", model: "claude-sonnet-4-6" }),
    skillRef: "instagram-research@1",
  };
}
