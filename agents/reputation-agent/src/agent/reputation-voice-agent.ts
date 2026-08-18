import { BaseAgent, type AgentStepConfig } from "@agent-engine/core";
import { ReputationVoiceOutputSchema, type ReputationVoiceOutput } from "../workflow/types.js";

/**
 * Step 08a (RFC-08 §5): "Voice + anti-slop, read as a batch." Unlike
 * `ReputationDraftAgent`, this agent is deliberately given the WHOLE surviving
 * batch of drafts in one call — cross-item patterns like response-craft.md's
 * "same opener twice in one month on the same listing" anti-pattern are
 * invisible to a per-item check by construction; only a batch pass can see
 * them. The mechanical half of step 08 (`gate.lintPost`'s em-dash/
 * exclamation/banned-phrase scan) runs separately, per draft, as a `code`
 * step — this agent's own job is the judgment half: does each reply actually
 * sound like this client's voice, and does the batch as a whole avoid
 * reading like a template with the nouns swapped.
 */
export class ReputationVoiceAgent extends BaseAgent<ReputationVoiceOutput> {
  protected readonly config: AgentStepConfig<ReputationVoiceOutput> = {
    id: "reputation-voice",
    description: "Batch voice-consistency pass over every surviving drafted reply: does each sound like this client, and does the batch avoid repeating a template shape across items.",
    allowedTools: [],
    outputSchema: ReputationVoiceOutputSchema,
    modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
    skillRef: "reputation-voice@1",
  };
}
