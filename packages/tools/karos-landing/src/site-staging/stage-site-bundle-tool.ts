import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool, success, toolingError, type GcsArtifactStoreLike } from "@agent-engine/tool-common";
import type { LandingEngineConfig } from "../config.js";
import { siteRootForClient } from "../sandbox/site-sandbox.js";
import {
  type StagingManifest,
  listFilesRecursive,
  manifestObjectPath,
  stagedObjectPath,
  toRelativeKey,
} from "./manifest.js";

const TOOL_VERSION = "1.0.0";

export const StageSiteBundleInputSchema = z.object({
  // No existing TSDoc on these fields to transcribe (SCRUM-293 flag) — synthesized from execute()'s usage and the tool's own doc comment.
  clientSlug: z.string().min(1).describe("Which client's working site tree to stage."),
  runId: z.string().min(1).describe("This run's id — the staged tree and its manifest are written under runs/<runId>/staging/ in GCS."),
});
export type StageSiteBundleInput = z.infer<typeof StageSiteBundleInputSchema>;

export interface StageSiteBundleResult {
  /** `gs://<bucket>/runs/<runId>/staging/` — where the tree and its manifest live. */
  stagingPrefix: string;
  fileCount: number;
}

/**
 * `landing.stageSiteBundle`: copy the working site tree into the run's GCS
 * staging area so it survives a gate pause that resumes on another container.
 *
 * Called immediately *before* the human-review gate. See
 * `./manifest.ts` for the full account of why local disk is not durable
 * across a pause.
 *
 * Distinct from `landing.uploadSiteBundle` on purpose, even though both copy
 * the same tree upward. Staging is internal run state under
 * `runs/<runId>/staging/`, written before review and meaningless afterwards;
 * the upload is the client-facing deliverable under
 * `landing/<clientSlug>/<runId>/site/`, written only once a human has
 * approved. Collapsing them would publish an unreviewed build to the
 * deliverable location.
 */
export function createStageSiteBundle(config: LandingEngineConfig, artifactStore: GcsArtifactStoreLike) {
  return defineTool<StageSiteBundleInput, StageSiteBundleResult>({
    name: "landing.stageSiteBundle",
    description:
      "Copies the working site tree into the run's GCS staging area so it survives a human-review gate pause that resumes on another container. Called immediately before the gate; distinct from landing.uploadSiteBundle, which publishes only after approval.",
    version: TOOL_VERSION,
    inputSchema: StageSiteBundleInputSchema,
    async execute({ clientSlug, runId }) {
      const siteRoot = siteRootForClient(config, clientSlug);

      let files: string[];
      try {
        files = await listFilesRecursive(siteRoot);
      } catch (err) {
        return toolingError(
          `landing.stageSiteBundle: failed to list "${siteRoot}" — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (files.length === 0) {
        // Staging nothing would write an empty manifest that a later restore
        // would treat as a complete bundle, turning a missing tree into a
        // silently empty deliverable.
        return toolingError(`landing.stageSiteBundle: "${siteRoot}" holds no files to stage`);
      }

      const relativePaths: string[] = [];
      for (const filePath of files) {
        const relativePath = toRelativeKey(siteRoot, filePath);
        await artifactStore.upload(stagedObjectPath(runId, relativePath), await fs.readFile(filePath));
        relativePaths.push(relativePath);
      }

      // Written last, on purpose: the manifest's presence is what marks a
      // staging area complete, so a run that dies mid-upload leaves no
      // manifest and the restore step refuses rather than restoring a
      // half-copied tree.
      const manifest: StagingManifest = {
        runId,
        clientSlug,
        files: [...relativePaths].sort(),
        stagedAt: new Date().toISOString(),
      };
      await artifactStore.upload(
        manifestObjectPath(runId),
        Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
        { contentType: "application/json" },
      );

      return success<StageSiteBundleResult>({
        stagingPrefix: `gs://${artifactStore.bucketName}/runs/${runId}/staging/`,
        fileCount: relativePaths.length,
      });
    },
  });
}
