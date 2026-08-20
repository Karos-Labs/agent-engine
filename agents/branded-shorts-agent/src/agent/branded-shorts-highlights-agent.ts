import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { HighlightsOutputSchema, type HighlightsOutput } from "../workflow/types.js";

/**
 * Step 3 (RFC-06 §2 / SKILL.md step 3 / PLAYBOOK §2): the emphasis-word
 * rhythm — "roughly one decisive word every chunk or two." Small,
 * schema-out, and reads client-specific corrections dicts, but still a real
 * bounded judgment call (which word in a stretch is the decisive one), not a
 * mechanical rule — worth a genuine `BaseAgent` step rather than code.
 */
export class BrandedShortsHighlightsAgent extends BaseAgent<HighlightsOutput> {
  protected readonly config: AgentStepConfig<HighlightsOutput> = {
    id: "branded-shorts-highlights",
    description:
      "Choose which transcript words get the emphasis-font treatment: roughly one decisive word every chunk or two, never a filler, never inventing a timestamp outside the given transcript.",
    allowedTools: [],
    outputSchema: HighlightsOutputSchema,
    modelPolicy: resolveModelPolicy("branded-shorts-highlights", { policy: "pinned", model: "claude-sonnet-4-6" }),
    skillRef: "branded-shorts-highlights@1",
  };
}
