import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { PagePartsSchema, type PageParts } from "@agent-engine/tool-karos-landing";

/**
 * The one targeted fix pass (ENGINE-SPEC §8: "on fail -> one targeted fix
 * -> re-check. Still failing -> flag for human. No tournament."). Receives
 * the built parts plus the exact violations from the deterministic check,
 * the render report and the craft verdict, and returns revised parts. Same
 * model as the build so the page stays one hand's work.
 */
export class LandingFixAgent extends BaseAgent<PageParts> {
  protected readonly config: AgentStepConfig<PageParts> = {
    id: "landing-fix",
    description:
      "Revise the built page parts to clear the listed violations (structure, token drift, unsourced numbers, contrast, overflow, craft verdict reasons) while changing nothing else. Return the complete revised parts.",
    allowedTools: [],
    outputSchema: PagePartsSchema,
    maxTokens: 60_000,
    modelPolicy: resolveModelPolicy("landing-fix", { policy: "pinned", model: "gemini-3.1-pro-preview", vendor: "gemini" }),
    skillRef: "landing-fix@1",
  };
}
