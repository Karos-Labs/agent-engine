import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { InstagramCopyOutputSchema, type InstagramCopyOutput } from "../workflow/types.js";

/**
 * RFC-03 §3 step 05: "write the copy — six to eight slides, one idea each"
 * (enforced directly by `InstagramCopyOutputSchema`'s `.min(6).max(8)`, so
 * an out-of-range draft is a schema-validation `content_fail` at the agent
 * level, not something a later step has to notice). Pinned tier — RFC-03 §1
 * required-reading item 5 calls this "the creative judgment call," matching
 * `LinkedInDraftAgent`'s own pinned pattern exactly.
 *
 * Every claim traces to a step-04 source: `sourceRef` on each slide names a
 * `facts[].claim` from `InstagramResearchAgent`'s output verbatim, which is
 * what step 07's self-check verifies before the post ever reaches the
 * renderer.
 *
 * `allowedTools: []` — everything this step needs (topic, facts, the frozen
 * style config's copy-relevant fields, brand tokens) is hand-assembled by
 * the workflow ahead of time, same reasoning as `InstagramResearchAgent`.
 * On a step-07 self-check failure the workflow re-invokes this same agent
 * with a fresh step id (`WF-05-write-copy-attempt-N`) rather than looping
 * inside the agent itself — RFC-03 §3 step 07's "RETURN: 05" is a Layer 1
 * concern (which checkpointed step to re-run), not a Layer 2 one.
 */
export class InstagramCopyAgent extends BaseAgent<InstagramCopyOutput> {
  protected readonly config: AgentStepConfig<InstagramCopyOutput> = {
    id: "instagram-copy",
    description: "Write 6-8 Instagram carousel slides, one idea each, every claim traced to a sourced research fact.",
    allowedTools: [],
    outputSchema: InstagramCopyOutputSchema,
    // Pinned — RFC-02 §5's rationale applies identically here: drafting/
    // brand-voice judgment is never a fallback-eligible step.
    modelPolicy: resolveModelPolicy("instagram-copy", { policy: "pinned", model: "claude-sonnet-4-6" }),
    // Pinned to "2": v1 stays frozen as the pre-photographability baseline,
    // the same convention every other agent here follows. v2 adds the
    // single-photographable-scene rules to §4 — prep run
    // pubsub-21535110633863323 held on a slide needing "a timeline or roadmap
    // with a clearly labeled 'research' first phase, shot from above", which
    // v1 actively encouraged by asking for precision with no sense of what
    // can be pictured.
    // Pinned to "3": v3 is v2 with every em dash removed. v1 and v2 both
    // banned em dashes in the copy while using nine and eleven of them
    // respectively, and the model imitates the register of its instructions:
    // prep run pubsub-21066191524607951 failed the mechanical craft-hygiene
    // gate on two of three attempts on exactly that character. v1 and v2 stay
    // frozen.
    skillRef: "instagram-copy@3",
  };
}
