import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { PagePartsSchema, type PageParts } from "@agent-engine/tool-karos-landing";

/**
 * Phase 2 BUILD (RFC-11 §4): implement the blueprint as one self-contained
 * page: a stylesheet, one HTML fragment per blueprint section, one vanilla
 * script. No framework, no build step, no external script; the assembler
 * owns the document shell.
 *
 * Gemini 3.1 Pro on Vertex, pinned. Two reasons, both about this step
 * specifically: its 65k-token output window fits a whole front-end in one
 * turn (Claude's 32k does not, and splitting a page across turns is where
 * design coherence dies), and it is served through Vertex on the project
 * this engine already authenticates against, which is where the owner wants
 * model spend to land. `MODEL_STEP_LANDING_BUILD_MODEL`/`_VENDOR` re-point
 * it without a deploy, as for every other step.
 */
export class LandingBuildAgent extends BaseAgent<PageParts> {
  protected readonly config: AgentStepConfig<PageParts> = {
    id: "landing-build",
    description:
      "Build the page the blueprint decided: complete CSS on design tokens, one production-quality HTML fragment per blueprint section (copy verbatim from the blueprint), and the vanilla JS for reveals, the signature moment, nav and FAQ. Self-contained, responsive at 390px and 1440px, reduced-motion safe.",
    allowedTools: [],
    outputSchema: PagePartsSchema,
    maxTokens: 60_000,
    modelPolicy: resolveModelPolicy("landing-build", { policy: "pinned", model: "gemini-3.1-pro-preview", vendor: "gemini" }),
    skillRef: "landing-build@1",
  };
}
