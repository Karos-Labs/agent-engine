import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { SourceFitSchema, type SourceFit } from "../workflow/types.js";

/**
 * Should we be clipping THIS recording, for THIS client? (RFC-25 phase 3.)
 *
 * ## The gap it fills
 *
 * Open discovery searches all of YouTube, and all of YouTube contains clip
 * farms, re-uploads, conference B-roll and a competitor's own show. Nothing
 * else in the pipeline is positioned to notice: the moment picker reads a
 * transcript and answers "which forty seconds", the visual QA watches a
 * finished render and judges the treatment, and neither is ever asked whether
 * the run should have been in this recording at all.
 *
 * ## Why it runs on METADATA, before the transcript
 *
 * Transcribing a two-hour podcast is the most expensive step in the run. A
 * check placed after it can tell a reviewer the source was wrong, but only
 * once the run has already paid to find out. Title, channel and the run's
 * topic are enough to catch the failures this exists for — a clip farm names
 * itself, a competitor's show names itself — and catching them here costs a
 * cent instead of a transcription.
 *
 * What it therefore CANNOT judge is the moment: whether the interesting part
 * is in this episode at all. That is the moment picker's job and then the
 * watchability floor's, and the prompt says so rather than inviting a guess.
 *
 * ## It marks; it never blocks
 *
 * The standing rule (RFC-19, generalised to this family 2026-09-18). A low
 * score is a `ContentRepair` and a gate-payload field. The human at
 * `11-clip-review` is the one who can tell "a competitor, do not touch" from
 * "a competitor, and that is exactly why the take lands" — and that judgment
 * has never been code's to make.
 *
 * Gemini Flash, pinned: it reads a title, a channel name and two short
 * documents, which is the cheapest real judgment in the run.
 */
export class TikTokSourceFitAgent extends BaseAgent<SourceFit> {
  protected readonly config: AgentStepConfig<SourceFit> = {
    id: "tiktok-source-fit",
    description:
      "Judge whether this recording is worth clipping for this client: is it the kind of show whose words serve them, is it a real conversation rather than a clip farm or a re-upload, and is it on the run's subject. Score 0-10, say why in one line, and name any concern a person should act on. Judge the RECORDING, never the moment inside it.",
    allowedTools: [],
    outputSchema: SourceFitSchema,
    modelPolicy: resolveModelPolicy("tiktok-source-fit", { policy: "pinned", model: "gemini-3.8-flash", vendor: "gemini" }),
    skillRef: "tiktok-source-fit@1",
  };
}
