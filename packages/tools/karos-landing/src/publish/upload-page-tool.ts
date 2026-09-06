import { z } from "zod";
import { defineTool, success, toolingError, type GcsArtifactStoreLike } from "@agent-engine/tool-common";

const TOOL_VERSION = "2.0.0";

export const UploadPageInputSchema = z.object({
  clientSlug: z.string().min(1).describe("Which client the page belongs to (the artifact path segment)."),
  runId: z.string().min(1).describe("This run's id; files land under landing/<clientSlug>/<runId>/."),
  html: z.string().min(1).describe("The assembled index.html."),
  blueprintJson: z.string().min(1).describe("The PageBlueprint as JSON, kept next to the page so a reviewer or a later revision can read exactly what produced it."),
  partsJson: z.string().min(1).describe("The PageParts as JSON, same reason."),
});
export type UploadPageInput = z.infer<typeof UploadPageInputSchema>;

export interface UploadPageResult {
  /** `gs://<bucket>/landing/<clientSlug>/<runId>/` */
  gcsPrefix: string;
  fileCount: number;
  /** A 7-day signed URL for `index.html`, when the runtime could sign one. */
  indexSignedUrl?: string;
  indexGcsUri: string;
}

/**
 * `landing.uploadPage`: the durable copy of a build in the artifacts bucket,
 * next to the run's screenshots (`landing.renderPage` and `landing.captureSite`
 * already write under the same `landing/<slug>/<runId>/` prefix). Hosting is
 * where the page is SERVED from; this is where it is KEPT: the ledger's
 * deliverable pointer, the source a revision run can diff against, and the
 * fallback the portal can link when Hosting is not configured on a
 * deployment.
 */
export function createUploadPage(artifactStore: GcsArtifactStoreLike) {
  return defineTool<UploadPageInput, UploadPageResult>({
    name: "landing.uploadPage",
    description: "Archives the assembled index.html plus its blueprint and parts JSON to the artifacts bucket under landing/<clientSlug>/<runId>/, returning the prefix and a signed URL for the page.",
    version: TOOL_VERSION,
    inputSchema: UploadPageInputSchema,
    async execute({ clientSlug, runId, html, blueprintJson, partsJson }) {
      const prefix = `landing/${clientSlug}/${runId}/`;
      try {
        const index = await artifactStore.upload(`${prefix}index.html`, Buffer.from(html, "utf8"), { contentType: "text/html; charset=utf-8" });
        await artifactStore.upload(`${prefix}blueprint.json`, Buffer.from(blueprintJson, "utf8"), { contentType: "application/json" });
        await artifactStore.upload(`${prefix}parts.json`, Buffer.from(partsJson, "utf8"), { contentType: "application/json" });
        return success<UploadPageResult>({
          gcsPrefix: `gs://${artifactStore.bucketName}/${prefix}`,
          fileCount: 3,
          ...(index.signedUrl ? { indexSignedUrl: index.signedUrl } : {}),
          indexGcsUri: index.gcsUri,
        });
      } catch (err) {
        return toolingError(`landing.uploadPage failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}
