import { z } from "zod";

/**
 * The parts of `WorkflowContext.input` that mean the same thing to every
 * agent.
 *
 * Most of what a run carries is product-specific — a requested subreddit means
 * nothing to the landing builder. These two are not: "here is what I want this
 * run to do, in my own words" and "here is the media it should work from" are
 * questions the portal asks the same way whatever agent is being dispatched,
 * so they get one shape and one set of rules instead of each agent inventing
 * its own key.
 */

/**
 * A source asset attached to a run.
 *
 * `uri` is a `gs://` object or an https URL. Local filesystem paths are
 * accepted only because the video tools still take them, and a run dispatched
 * from the portal will never produce one — it is the seam between the portal's
 * uploads and an engine whose media tools predate them.
 */
export const MediaAssetSchema = z.object({
  uri: z.string().min(1),
  /**
   * What the agent should do with it. Left to the agent to interpret: a
   * "source" video to the clip system is the episode to cut from, and to
   * branded-shorts it is the talking head to render. Naming the ROLE rather
   * than the product keeps the portal out of the business of knowing which
   * agent wants which slot.
   */
  role: z.enum(["source", "reference", "logo", "overlay"]).default("source"),
  /** Content type when the portal knows it, so an agent can refuse a mismatch early rather than at ffmpeg. */
  contentType: z.string().min(1).optional(),
  /** Human label from the upload, carried through to the deliverable record. */
  label: z.string().min(1).optional(),
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

/**
 * Where a media agent's visuals come from, chosen per run in the portal
 * (`media_source` in the run dialog, 2026-09-06).
 *
 *   `system` — the default, and exactly the behaviour before this field
 *              existed: whatever the client attached is used first, and the
 *              agent's own pipeline (stock, screenshots, harvests, owned
 *              footage, generation) fills what they did not supply.
 *   `client` — ONLY what the client attached to this run is used. No tier that
 *              sources, scrapes, harvests or generates a visual may run. The
 *              text-first channels ship as text when nothing was attached; a
 *              carousel or video agent has nothing to make and refuses intake.
 *
 * Read off the run through `readRichRunInput` like the assets it governs, so
 * every agent gets the same two words with the same meaning.
 */
export const MEDIA_SOURCES = ["system", "client"] as const;
export const MediaSourceSchema = z.enum(MEDIA_SOURCES);
export type MediaSource = z.infer<typeof MediaSourceSchema>;
export const DEFAULT_MEDIA_SOURCE: MediaSource = "system";

/**
 * The run-scoped direction a person typed, and the media they attached.
 *
 * Both optional, and that is the contract rather than an oversight: a run with
 * neither is the normal case — a scheduled run has nobody typing at it — and
 * every agent already has a standing strategy to fall back on. An empty
 * `customPrompt` must therefore read as "use the client's strategy", never as
 * "the client has no direction", which is why it is normalized away rather
 * than passed through as an empty string an agent might dutifully honour.
 */
export const RichRunInputSchema = z.object({
  customPrompt: z.string().min(1).optional(),
  mediaAssets: z.array(MediaAssetSchema).default([]),
  mediaSource: MediaSourceSchema.default(DEFAULT_MEDIA_SOURCE),
});
export type RichRunInput = z.infer<typeof RichRunInputSchema>;

/**
 * Reads the shared fields out of a run's raw input.
 *
 * Never throws. A malformed `mediaAssets` is dropped rather than failing the
 * run, because these are additive to every agent that reads them: an agent
 * that would have run fine on its standing strategy should not start failing
 * because a caller sent a bad optional field. What it must not do is pass
 * half-valid junk through — an asset with no uri is not an asset.
 */
export function readRichRunInput(input: Readonly<Record<string, unknown>> | undefined): RichRunInput {
  const raw = input ?? {};
  const prompt = typeof raw.customPrompt === "string" ? raw.customPrompt.trim() : "";
  const assets: MediaAsset[] = [];
  if (Array.isArray(raw.mediaAssets)) {
    for (const candidate of raw.mediaAssets) {
      const parsed = MediaAssetSchema.safeParse(candidate);
      if (parsed.success) assets.push(parsed.data);
    }
  }
  // Anything but the one non-default word is the default: an unknown value
  // must never read as a third mode nobody defined, and must never fail a run.
  const mediaSource: MediaSource = raw.mediaSource === "client" ? "client" : DEFAULT_MEDIA_SOURCE;
  return { ...(prompt ? { customPrompt: prompt } : {}), mediaAssets: assets, mediaSource };
}

/** True when this run may use ONLY the media the client attached — no sourcing, harvesting or generation tier may run. */
export function clientMediaOnly(input: Pick<RichRunInput, "mediaSource">): boolean {
  return input.mediaSource === "client";
}

/** The first asset in a given role, which is what a single-source agent wants. */
export function firstAsset(assets: readonly MediaAsset[], role: MediaAsset["role"] = "source"): MediaAsset | undefined {
  return assets.find((a) => a.role === role);
}
