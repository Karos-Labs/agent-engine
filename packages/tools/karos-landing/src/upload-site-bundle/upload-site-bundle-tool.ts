import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, toolingError, type GcsArtifactStoreLike } from "@agent-engine/tool-common";
import { siteRootForClient } from "../sandbox/site-sandbox.js";
import type { LandingEngineConfig } from "../config.js";

const TOOL_VERSION = "1.0.0";

export const UploadSiteBundleInputSchema = z.object({
  // No existing TSDoc on these fields to transcribe (SCRUM-293 flag) — synthesized from execute()'s usage and the tool's own doc comment.
  clientSlug: z.string().min(1).describe("Which client's site directory to archive."),
  runId: z.string().min(1).describe("This run's id — the uploaded objects land under landing/<clientSlug>/<runId>/site/ in GCS."),
});
export type UploadSiteBundleInput = z.infer<typeof UploadSiteBundleInputSchema>;

export interface UploadSiteBundleResult {
  /** `gs://<bucket>/landing/<clientSlug>/<runId>/site/` — the common prefix every uploaded file shares; there's no single-URL "the bundle" the way a one-file MP4/PNG has, since a site is a tree. */
  gcsPrefix: string;
  fileCount: number;
}

async function listFilesRecursive(root: string, dir: string = root): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(root, full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/**
 * `landing.uploadSiteBundle` (Task 1, RFC-01's GCS artifact store):
 * archives a client's current site directory to GCS, one object per file
 * under a shared `landing/<clientSlug>/<runId>/site/` prefix (mirroring the
 * on-disk tree rather than a single tar/zip, so this needs no new archiving
 * dependency and a caller can fetch one file without downloading the whole
 * bundle).
 *
 * Scope note, read before wiring this into a workflow: `landing.gate`'s own
 * `doBuild` flag — the only thing in this codebase that would ever run a
 * real `next build` — is hardcoded `false` in
 * `create-landing-builder-agent-workflow.ts` today, so what this tool
 * uploads is the site's current *source* tree (whatever `landing.copyTemplate`/
 * `landing.writeSiteFile` have written), not a compiled `.next/` bundle.
 * Uploading a genuinely compiled bundle needs `doBuild: true` (or an
 * explicit build step) to run first — a separate, deliberate change to that
 * workflow this tool does not make on its own.
 */
export function createUploadSiteBundle(config: LandingEngineConfig, artifactStore: GcsArtifactStoreLike) {
  return defineTool<UploadSiteBundleInput, UploadSiteBundleResult>({
    name: "landing.uploadSiteBundle",
    description:
      "Archives a client's current site directory to GCS, one object per file under a shared landing/<clientSlug>/<runId>/site/ prefix, mirroring the on-disk tree rather than a single tar/zip.",
    version: TOOL_VERSION,
    inputSchema: UploadSiteBundleInputSchema,
    async execute({ clientSlug, runId }) {
      const siteRoot = siteRootForClient(config, clientSlug);
      let files: string[];
      try {
        files = await listFilesRecursive(siteRoot);
      } catch (err) {
        return toolingError(`landing.uploadSiteBundle: failed to list "${siteRoot}" — ${err instanceof Error ? err.message : String(err)}`);
      }

      const prefix = `landing/${clientSlug}/${runId}/site/`;
      for (const filePath of files) {
        const relPath = path.relative(siteRoot, filePath).split(path.sep).join("/");
        const buffer = await fs.readFile(filePath);
        await artifactStore.upload(`${prefix}${relPath}`, buffer);
      }

      return success<UploadSiteBundleResult>({ gcsPrefix: `gs://${artifactStore.bucketName}/${prefix}`, fileCount: files.length });
    },
  });
}
