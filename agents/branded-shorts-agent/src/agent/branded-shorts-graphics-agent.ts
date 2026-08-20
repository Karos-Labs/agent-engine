import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { GraphicsPlanOutputSchema, type GraphicsPlanOutput } from "../workflow/types.js";

/**
 * Step 5/5b (RFC-06 §1/§2 — "the one real creative step" / SKILL.md steps
 * 5-5b): plans motion-graphic overlays and cutaways from the transcript
 * against the client's `graphics-language.md` and repertoire. Creative, but
 * constrained to the client's already-approved closed vocabulary (an
 * `archetype` name, never a rendered pixel) — the actual frames are
 * generated and gated by code afterward (`video.graphicsGate`/
 * `video.cutawayGate`), never by this step's own judgment of what looks
 * good.
 *
 * The workflow's `input` to this step MUST include an `archetypes: string[]`
 * field — the client's exact approved repertoire — and the workflow
 * independently validates every returned `archetype` against that same list
 * via `validateGraphicsPlanArchetypes` (P0#1 audit fix) before spending a
 * render+gate cycle on the plan. That validation is NOT baked into this
 * agent's own `outputSchema`: see `createGraphicOverlayPlanSchema`'s doc
 * comment in `workflow/types.ts` for why a `.refine()` there would surface
 * as a `tooling_error` instead of a retryable content signal.
 *
 * The workflow re-invokes this agent (a fresh `step.agent` call, a higher
 * `maxSteps` budget is not needed here) with the prior gate's (or archetype
 * validation's) failure reason appended to its input when a plan fails —
 * PLAYBOOK §4c's "FAIL -> auto-remedy -> re-gate" loop implemented as
 * workflow code rather than `BaseAgent`'s built-in `selfCritique` (which
 * expects the gate tool to run directly on the raw draft; the real gates
 * here need a rendered video file on disk, which is real I/O the workflow's
 * job-builder step performs in between).
 */
export class BrandedShortsGraphicsAgent extends BaseAgent<GraphicsPlanOutput> {
  protected readonly config: AgentStepConfig<GraphicsPlanOutput> = {
    id: "branded-shorts-graphics",
    description:
      "Plan which transcript beats get a motion-graphic overlay and which get a full-frame cutaway (a real-photo burst or a single plate), each justified against what the speaker is actually saying at that moment. Every overlay's `archetype` MUST be copied verbatim from the `archetypes` list given in the input — never invent, rename, or approximate one, even if it seems like a natural extension of the client's style.",
    allowedTools: [],
    outputSchema: GraphicsPlanOutputSchema,
    modelPolicy: resolveModelPolicy("branded-shorts-graphics", { policy: "pinned", model: "claude-sonnet-4-6" }),
    skillRef: "branded-shorts-graphics@1",
  };
}
