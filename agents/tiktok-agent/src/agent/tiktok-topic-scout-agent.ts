import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { TopicScoutOutputSchema, type TopicScoutOutput } from "../workflow/types.js";

/**
 * Topic discovery (step 01c): what should this client make a short about this
 * week, when nobody told us and the catalog has nothing left.
 *
 * This is the step that replaces "hold forever on an empty lane" with a
 * grounded proposal. It is handed the research documents `research.pull`
 * actually fetched, the client's own intel report and profile, and the list
 * of what they RECENTLY PUBLISHED — and it is asked for 6-10 candidates,
 * each with an angle, a hook, and the evidence it rests on. The candidates
 * seed the catalog lane through `topics.topUp`, so every one of them becomes
 * a real, reservable, dedupe-tracked row rather than a one-off guess.
 *
 * `allowedTools` is empty on purpose, the same reason the moment step's is: a
 * scout that could go and fetch more would wander off the evidence it was
 * given, and the evidence it was given is the whole point. The research call
 * happens in code, once, cached and freshness-enforced, before this agent runs.
 *
 * The model is Gemini 2.5 Pro on Vertex, not Claude: this step reads a pile
 * of web documents plus an intel report and needs breadth and a large window
 * more than it needs voice — voice is the script/commentary step's job. It is
 * `pinned` (never silently substituted) but, like every model step, can be
 * retargeted per deployment via `MODEL_STEP_TIKTOK_TOPIC_SCOUT_VENDOR/_MODEL`.
 */
export class TikTokTopicScoutAgent extends BaseAgent<TopicScoutOutput> {
  protected readonly config: AgentStepConfig<TopicScoutOutput> = {
    id: "tiktok-topic-scout",
    description:
      "Propose 6-10 short-video topics this client should make this week: each with the client's angle, a cold-open hook, the format that suits it, why now, and the research URLs it rests on. Ground every candidate in the research documents or the client's own intel — never invent a trend. Avoid anything the client recently published.",
    allowedTools: [],
    outputSchema: TopicScoutOutputSchema,
    modelPolicy: resolveModelPolicy("tiktok-topic-scout", { policy: "pinned", model: "gemini-2.5-pro", vendor: "gemini" }),
    // Pinned to "2" (2026-09-09): v2 adds `alreadyInCatalog` (the lane's
    // rows as a hard do-not-repeat, including the same idea in new words),
    // `researchLens`, and a variety rule across hook types and pillars. Prep
    // proposed the same seven GEO / AI-Max / EU-ChatGPT candidates on every
    // run for two days under v1. v1 stays frozen.
    skillRef: "tiktok-topic-scout@2",
  };
}
