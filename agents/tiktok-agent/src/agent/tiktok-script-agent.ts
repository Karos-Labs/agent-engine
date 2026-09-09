import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { ShortScriptSchema, type ShortScript } from "../workflow/types.js";

/**
 * Every word of a script a viewer hears or reads, joined for the lint gate:
 * the caption and about, the hook, and each beat's narration and on-screen
 * text. The same text 07-compliance checks after this step, so the model
 * hears about a tell while it can still fix it. Read defensively: this is the
 * raw turn output, before the schema validates it.
 */
export function scriptLintText(draft: Partial<ShortScript> | null | undefined): string {
  if (!draft || typeof draft !== "object") return "";
  const parts: unknown[] = [draft.caption, draft.about, draft.hook];
  if (Array.isArray(draft.beats)) {
    for (const beat of draft.beats) {
      if (beat && typeof beat === "object") {
        parts.push((beat as { narration?: unknown }).narration, (beat as { onScreenText?: unknown }).onScreenText);
      }
    }
  }
  return parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0).join("\n\n");
}

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
      "Write a 3-5 beat script for an original vertical short on the given topic: a cold-open hook, per-beat narration (≤30 words), on-screen text (≤8 words), a stock-footage search query and a concrete visual brief per beat (a scene — no text, no logos), and the post caption. Use the client's voice rules. Decide whether this piece wants a voiceover and say why. Add no claim the brief does not support.",
    allowedTools: ["client.getVoiceRules", "client.getBrand", "client.getStrategy"],
    outputSchema: ShortScriptSchema,
    modelPolicy: resolveModelPolicy("tiktok-script", { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: true }),
    // Pinned to "2" (2026-09-07): v2 states the mechanical tells the lint gate
    // rejects (dashes, exclamation marks, the cliche bank) and is itself
    // written without a single em dash, because a model imitates the register
    // of its instructions and v1 used dozens while banning none. Prep run
    // pubsub-21711047251391287 held at 07-compliance on one em dash in a
    // beat's narration that nothing had ever asked this step to avoid. v1
    // stays frozen.
    // Pinned to "5" (2026-09-09): generated video is gone from the pipeline.
    // v5 makes `stockQuery` the primary visual instruction and reframes
    // `visualBrief` as the brief for a PHOTOGRAPH (the still-with-push-in
    // fallback), names beat 1's on-screen text as the one title card, and
    // bans the sales CTA beat the 2026-09-08 scripts kept appending. v4 stays
    // frozen.
    skillRef: "tiktok-script@5",
    // The same lint 07-compliance runs afterwards, run FIRST on the model's
    // own output so a tell comes back as feedback it can act on rather than
    // as a held run. Two revisions: the first fix is usually enough, the
    // second is cheap insurance against fixing one dash and writing another.
    selfCritique: {
      gateTool: "gate.lintPost",
      maxRevisions: 2,
      gateArgs: { platform: "generic" },
      gateInput: (draft) => ({ text: scriptLintText(draft) }),
    },
  };
}
