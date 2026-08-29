import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, success, toolingError, type GcsArtifactStoreLike } from "@agent-engine/tool-common";
import type { LandingEngineConfig } from "../config.js";
import { resolveSandboxedWritePath, siteRootForClient } from "../sandbox/site-sandbox.js";
import { type StagingManifest, directoryHasFiles, manifestObjectPath, stagedObjectPath } from "./manifest.js";

const TOOL_VERSION = "1.0.0";

export const RestoreSiteBundleInputSchema = z.object({
  // No existing TSDoc on these fields to transcribe (SCRUM-293 flag) — synthesized from execute()'s usage and the tool's own doc comment.
  clientSlug: z.string().min(1).describe("Which client's site tree to restore onto local disk."),
  runId: z.string().min(1).describe("The run whose staged bundle (uploaded by landing.stageSiteBundle before the gate) to restore from GCS."),
});
export type RestoreSiteBundleInput = z.infer<typeof RestoreSiteBundleInputSchema>;

export interface RestoreSiteBundleResult {
  /** `"local"` when the tree was already on disk, `"gcs"` when it was pulled back down. */
  source: "local" | "gcs";
  fileCount: number;
}

/**
 * `landing.restoreSiteBundle`: put the staged site tree back on local disk
 * after a gate pause, so the steps that follow can work the way they always
 * have.
 *
 * Called immediately *after* the human-review gate.
 *
 * Two properties worth stating:
 *
 * **It is a no-op when the tree is already there.** A run that never changed
 * containers — the whole-run-on-one-service case, and every existing test —
 * finds its own files and returns `source: "local"` without touching GCS.
 * Downloading unconditionally would be wasted work and would overwrite a
 * newer local state with an older staged copy.
 *
 * **It restores the tree rather than teaching one step to read GCS.** The
 * cheaper fix would be to point `landing.uploadSiteBundle` at the staging
 * prefix, but the local tree is not read by that step alone: the rebuild
 * path's feedback persistence touches the bundle, the workflow returns a
 * `sitePath` a human is told to `cd` into, and any step added after the gate
 * will reasonably assume the same working directory every pre-gate step had.
 * Making the container whole again fixes the class of problem; special-casing
 * one step fixes one instance of it.
 */
export function createRestoreSiteBundle(config: LandingEngineConfig, artifactStore: GcsArtifactStoreLike) {
  return defineTool<RestoreSiteBundleInput, RestoreSiteBundleResult>({
    name: "landing.restoreSiteBundle",
    description:
      "Puts the staged site tree back on local disk after a human-review gate, so the steps that follow can work the way they always have. A no-op (source: \"local\") when the tree is already on this container; otherwise pulls it back down from GCS (source: \"gcs\").",
    version: TOOL_VERSION,
    inputSchema: RestoreSiteBundleInputSchema,
    async execute({ clientSlug, runId }) {
      const siteRoot = siteRootForClient(config, clientSlug);

      if (await directoryHasFiles(siteRoot)) {
        const existing = await fs.readdir(siteRoot, { recursive: true, withFileTypes: true });
        return success<RestoreSiteBundleResult>({
          source: "local",
          fileCount: existing.filter((entry) => entry.isFile()).length,
        });
      }

      let manifest: StagingManifest;
      try {
        const raw = await artifactStore.download(manifestObjectPath(runId));
        manifest = JSON.parse(raw.toString("utf8")) as StagingManifest;
      } catch (err) {
        return toolingError(
          `landing.restoreSiteBundle: no usable staging manifest at ` +
            `gs://${artifactStore.bucketName}/${manifestObjectPath(runId)} — ` +
            `${err instanceof Error ? err.message : String(err)}. The site tree was not ` +
            `staged before the gate, so there is nothing to restore onto this container.`,
        );
      }

      if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
        return toolingError(`landing.restoreSiteBundle: staging manifest for run "${runId}" lists no files`);
      }

      // `resolveSandboxedWritePath` resolves the sandbox root through
      // `fs.realpath`, so the root has to exist before the first write. On a
      // fresh container it does not — that is the entire situation we are here
      // to repair.
      await fs.mkdir(siteRoot, { recursive: true });

      for (const relativePath of manifest.files) {
        // Every restored path goes back through the same sandbox guard that
        // governed writing it. The manifest is our own object, but it is still
        // input read from storage, and a `../` in it would otherwise write
        // outside the client's tree.
        const target = await resolveSandboxedWritePath(siteRoot, config.templateRoot, relativePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, await artifactStore.download(stagedObjectPath(runId, relativePath)));
      }

      return success<RestoreSiteBundleResult>({ source: "gcs", fileCount: manifest.files.length });
    },
  });
}
