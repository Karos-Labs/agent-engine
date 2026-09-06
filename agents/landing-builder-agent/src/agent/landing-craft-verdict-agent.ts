import { BaseAgent, resolveModelPolicy, GateVerdictSchema, type AgentStepConfig, type GateVerdict } from "@agent-engine/core";

/**
 * GATE layer 3 (RFC-11 §5): the one judgment pass. Reads the actual
 * assembled HTML, the blueprint it was meant to implement, the brand
 * material, and the render report (fonts loaded, contrast, overflow, the
 * page's real height at each breakpoint), then judges in strict order: the
 * client's brand, the craft floor, the not-boring bar (a real signature
 * moment, not fades), the first-pass bar (client-ready, not a skeleton).
 * Its output IS a `GateVerdict`, so the workflow's fix-once-then-hold logic
 * drives off the same contract every other gate uses.
 *
 * Opus, pinned: taste is the point of this step, and it reads a whole page.
 * Text-only by construction: the router carries no image input, so the
 * screenshots go to the human reviewer, and this step reasons from the
 * source plus the measured render facts instead.
 */
export class LandingCraftVerdictAgent extends BaseAgent<GateVerdict> {
  protected readonly config: AgentStepConfig<GateVerdict> = {
    id: "landing-craft-verdict",
    description:
      "Judge the assembled page against, in order: the client's brand and blueprint, the craft floor, the not-boring bar (one real signature moment), and the first-pass bar. Return pass or content_fail with specific, fixable reasons.",
    allowedTools: [],
    outputSchema: GateVerdictSchema,
    modelPolicy: resolveModelPolicy("landing-craft-verdict", { policy: "pinned", model: "claude-opus-4-8" }),
    skillRef: "landing-craft-verdict@2",
  };
}
