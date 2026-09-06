import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { ShortScriptSchema, type ShortScript } from "../workflow/types.js";

/**
 * The script of an ORIGINAL short (step 03 on the generated path): what is
 * said, what is shown, and what the footage under it looks like, beat by beat.
 *
 * This is the creative center of the format the legacy product never had. A
 * commentary clip borrows its footage and its words and adds a take; an
 * original short has to earn attention with nothing but the client's own
 * message, so the writing here is what decides whether the result reads as a
 * person with a point of view or as a template. The prompt is built around
 * that — a spoken-language hook, one idea per beat, concrete scenes rather
 * than stock-footage abstractions, and an explicit ban on the tells that make
 * generated video look generated.
 *
 * It also makes the voiceover call. The client's config can force it either
 * way; on `auto`, the model decides per piece and has to say why, so a human
 * reviewing the run can see the reasoning rather than a coin flip.
 *
 * Tools: the client's own voice, brand and strategy documents, nothing else.
 * The topic brief it is handed already carries the research evidence the
 * scout grounded the topic in; a script step that could reach research tools
 * would start sourcing claims of its own, and this step is not entitled to
 * put a fact in the client's mouth the brief did not contain.
 *
 * Claude Sonnet, pinned: this is client-facing copy in the client's own
 * language (`contentLanguageSensitive`), where voice matters most.
 */
export class TikTokScriptAgent extends BaseAgent<ShortScript> {
  protected readonly config: AgentStepConfig<ShortScript> = {
    id: "tiktok-script",
    description:
      "Write a 3-5 beat script for an original vertical short on the given topic: a cold-open hook, per-beat narration (≤30 words), on-screen text (≤8 words), a concrete visual brief for generated b-roll (a scene — no text, no logos), and the post caption. Use the client's voice rules. Decide whether this piece wants a voiceover and say why. Add no claim the brief does not support.",
    allowedTools: ["client.getVoiceRules", "client.getBrand", "client.getStrategy"],
    outputSchema: ShortScriptSchema,
    modelPolicy: resolveModelPolicy("tiktok-script", { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: true }),
    skillRef: "tiktok-script@1",
  };
}
