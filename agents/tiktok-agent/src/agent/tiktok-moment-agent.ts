import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { MomentSelectionSchema, type MomentSelection } from "../workflow/types.js";

/**
 * PICK-moment (subskill-spec §2 step 2): the single most clip-worthy moment in
 * an episode.
 *
 * This is the one judgment in the pipeline that genuinely cannot be code. The
 * legacy product's hook typology — a bold contrarian claim, a surprising
 * number, an emotional story, a sharp one-liner — is a reading of what a
 * stranger will stop scrolling for, and no heuristic over a transcript
 * reproduces it. Everything downstream of it (the cut, the render, the QA) is
 * deterministic.
 *
 * `allowedTools` is empty on purpose. The transcript is handed to it in the
 * step input; a selector that could go and fetch more material is a selector
 * that can wander out of the episode it was asked about.
 *
 * The model is Gemini 2.5 Pro on Vertex, and that is a fit, not a cost cut: a
 * two-hour podcast transcript with per-sentence timestamps runs well past
 * 200k tokens, and this step has to hold the WHOLE episode in view to say
 * "this moment and not that one" — a 1M-token window is the difference
 * between choosing from the episode and choosing from its first third.
 * `pinned`, and retargetable per deployment (`MODEL_STEP_TIKTOK_MOMENT_VENDOR`
 * / `_MODEL`) without a code change, like every other model step in this repo.
 */
export class TikTokMomentAgent extends BaseAgent<MomentSelection> {
  protected readonly config: AgentStepConfig<MomentSelection> = {
    id: "tiktok-moment",
    description:
      "Pick the single most clip-worthy moment from this transcript. The first line must work cold on a stranger who has no context — never open on setup. Snap start and end to sentence boundaries, keep the clip between 20 and 120 seconds, use only timestamps that appear in the transcript you were given, and label what the moment is about in a few words.",
    allowedTools: [],
    outputSchema: MomentSelectionSchema,
    modelPolicy: resolveModelPolicy("tiktok-moment", { policy: "pinned", model: "gemini-2.5-pro", vendor: "gemini" }),
    // Pinned to "2": v2 adds `topicLabel` (the run's topic when the footage
    // arrived with none), the "the topic is a hint, the footage is the truth"
    // rule for attached recordings, and the long-episode guidance. v1 stays
    // frozen.
    skillRef: "tiktok-moment@2",
  };
}
