import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool, success, toolingError, type GcsArtifactStoreLike } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";

export const UploadDeliverableInputSchema = z.object({
  localPath: z
    .string()
    .min(1)
    .describe(
      "A real local path to an already-rendered, already-gated file (e.g. RenderResult.outputPath) — every ffprobe/ffmpeg-subprocess-bound gate in this package needs the MP4 on disk, so this tool only ever runs after all of them have already passed.",
    ),
  objectPath: z.string().min(1).describe("GCS object key to upload under, e.g. branded-shorts/<clientSlug>/<runId>/final.mp4."),
  // No existing TSDoc on this field to transcribe (SCRUM-293 flag) — synthesized from execute()'s usage.
  contentType: z.string().min(1).optional().describe("Optional MIME type to set on the uploaded object, e.g. video/mp4."),
});
export type UploadDeliverableInput = z.infer<typeof UploadDeliverableInputSchema>;

export interface UploadDeliverableResult {
  gcsUri: string;
  signedUrl?: string;
}

/**
 * `video.uploadDeliverable` (Task 1, RFC-01's GCS media store): uploads a
 * file that has already finished local rendering and every local-file-bound
 * gate to GCS, now that nothing downstream still needs it as a real path on
 * disk. Only constructed (see `../index.ts`'s `createKarosVideoTools`) when
 * a `mediaStore` was actually supplied — omitted from the registry entirely
 * otherwise, so a caller can presence-check `tools["video.uploadDeliverable"]`
 * to learn whether GCS is configured, exactly the way `create-branded-shorts-
 * agent-workflow.ts`'s own optional upload step does.
 */
export function createUploadDeliverable(mediaStore: GcsArtifactStoreLike) {
  return defineTool<UploadDeliverableInput, UploadDeliverableResult>({
    name: "video.uploadDeliverable",
    description:
      "Uploads a file that has already finished local rendering and every local-file-bound gate to GCS, now that nothing downstream still needs it as a real path on disk. Only constructed when a mediaStore was actually supplied.",
    version: TOOL_VERSION,
    inputSchema: UploadDeliverableInputSchema,
    async execute({ localPath, objectPath, contentType }) {
      let buffer: Buffer;
      try {
        buffer = await fs.readFile(localPath);
      } catch (err) {
        return toolingError(`video.uploadDeliverable: failed to read "${localPath}" — ${err instanceof Error ? err.message : String(err)}`);
      }
      const { gcsUri, signedUrl } = await mediaStore.upload(objectPath, buffer, contentType !== undefined ? { contentType } : undefined);
      return success<UploadDeliverableResult>({ gcsUri, ...(signedUrl ? { signedUrl } : {}) });
    },
  });
}
