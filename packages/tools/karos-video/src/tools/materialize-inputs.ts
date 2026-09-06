import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { AgentToolOutcome } from "@agent-engine/core";
import { defineTool, notAvailable, success, toolingError } from "@agent-engine/tool-common";
import { resolveEngineScript, resolveRuntime, type KarosVideoToolOptions } from "../config.js";

const TOOL_VERSION = "1.0.0";
const UNPACK_SCRIPT = "unpack_bundle.py";
const GS_URI = /^gs:\/\/([^/]+)\/(.+)$/;
const BUNDLE_EXT = /\.(zip|tar|tar\.gz|tgz)$/i;

/** The subset of `GcsArtifactStoreLike` this tool needs — `download` plus the bucket it is bound to, so a `gs://` naming another bucket is refused rather than mis-read. */
export interface MaterializeObjectReader {
  readonly bucketName?: string;
  download(objectPath: string): Promise<Buffer>;
}

export const MaterializeInputsInputSchema = z.object({
  workDir: z.string().min(1).describe("The run's local work directory; every materialised file lands under it."),
  videoPath: z
    .string()
    .min(1)
    .describe("The intake's source video: a local path (returned unchanged) or a gs:// URI in the media bucket (downloaded to <workDir>/source/)."),
  assetBundle: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The client's branded-shorts asset bundle — a .zip/.tar/.tar.gz holding brand-profile.json plus every font/mark/library file it references by relative path. Local path or gs:// URI; unpacked to <workDir>/brand/. Absent means the profile is already on local disk.",
    ),
});
export type MaterializeInputsInput = z.infer<typeof MaterializeInputsInputSchema>;

export interface MaterializeInputsResult {
  /** A real local path `ffmpeg` can open. */
  videoPath: string;
  /** `<workDir>/brand/brand-profile.json` when a bundle was unpacked; absent otherwise. */
  profilePath?: string;
  /** The unpacked bundle root, when there was one. */
  brandDir?: string;
  /** What was actually fetched, for the run report. */
  fetched: string[];
}

export interface CreateMaterializeInputsOptions extends KarosVideoToolOptions {
  /** Reads `gs://` objects. Absent, any gs:// input reports `not_available` — never a silent local-path guess. */
  objectReader?: MaterializeObjectReader | undefined;
}

/**
 * `video.materializeInputs` (RFC-06 §3/§4's "adapter, never infra", applied to
 * the inputs): every other `video.*` tool hands the Python engine REAL FILES —
 * ffmpeg/PIL never read from the abstract WorkspaceStore or from GCS. On a
 * Cloud Run instance nothing is on local disk when a run starts: the client's
 * upload is an object in the media bucket, and their brand assets (profile,
 * fonts, marks, the optional `library/` of real stills) live outside the image
 * because they are per client and the image is per deploy. This is the one
 * step that turns those into paths.
 *
 * Local paths pass through untouched, so every environment that already had
 * the files on disk (tests, a laptop) behaves exactly as before this tool
 * existed. The bundle is unpacked by `engine/unpack_bundle.py` (stdlib
 * zipfile/tarfile, zip-slip refused) rather than a Node archive dependency —
 * Python is already a hard requirement of this engine.
 */
export function createMaterializeInputs(options: CreateMaterializeInputsOptions = {}) {
  const runtime = resolveRuntime(options);
  const reader = options.objectReader;

  type Fetched = { localPath: string } | { error: AgentToolOutcome<MaterializeInputsResult> };

  async function fetchToLocal(uri: string, destDir: string, what: string): Promise<Fetched> {
    const m = GS_URI.exec(uri);
    if (!m) return { localPath: uri };
    const [, bucket, key] = m;
    if (!reader) {
      return {
        error: notAvailable<MaterializeInputsResult>(`video.materializeInputs: ${what} is a gs:// object but this deployment has no media store (GCS_MEDIA_BUCKET) to read it with`),
      };
    }
    if (reader.bucketName !== undefined && reader.bucketName !== bucket) {
      return { error: toolingError<MaterializeInputsResult>(`video.materializeInputs: ${what} names bucket "${bucket}" but the media store is bound to "${reader.bucketName}"`) };
    }
    await fs.mkdir(destDir, { recursive: true });
    const localPath = path.join(destDir, path.posix.basename(key!));
    try {
      const bytes = await reader.download(key!);
      await fs.writeFile(localPath, bytes);
    } catch (err) {
      return { error: toolingError<MaterializeInputsResult>(`video.materializeInputs: failed to download ${uri} — ${err instanceof Error ? err.message : String(err)}`) };
    }
    return { localPath };
  }

  return defineTool<MaterializeInputsInput, MaterializeInputsResult>({
    name: "video.materializeInputs",
    description:
      "Turns a run's inputs into real local files the Python engine can open: downloads a gs:// source video into the work directory and unpacks the client's brand asset bundle (profile + fonts + marks + library) beside it. Local paths pass through unchanged, so nothing changes for a deployment that already has the files on disk.",
    version: TOOL_VERSION,
    inputSchema: MaterializeInputsInputSchema,
    async execute({ workDir, videoPath, assetBundle }) {
      const fetched: string[] = [];

      const video = await fetchToLocal(videoPath, path.join(workDir, "source"), "videoPath");
      if ("error" in video) return video.error;
      if (video.localPath !== videoPath) fetched.push(videoPath);

      if (assetBundle === undefined) {
        return success<MaterializeInputsResult>({ videoPath: video.localPath, fetched });
      }
      if (!BUNDLE_EXT.test(assetBundle)) {
        return toolingError(`video.materializeInputs: assetBundle "${assetBundle}" is not a .zip/.tar/.tar.gz/.tgz archive`);
      }
      const bundle = await fetchToLocal(assetBundle, path.join(workDir, "bundle"), "assetBundle");
      if ("error" in bundle) return bundle.error;
      if (bundle.localPath !== assetBundle) fetched.push(assetBundle);

      const script = resolveEngineScript(runtime, UNPACK_SCRIPT);
      if (!script.ok) return toolingError(script.reason);
      const brandDir = path.join(workDir, "brand");
      const result = await runtime.runner(runtime.pythonBin, [script.path, "--archive", bundle.localPath, "--dest", brandDir]);
      if (result.exitCode !== 0) {
        const tail = (result.stderr || result.stdout || "").trim().slice(-2000);
        return toolingError(`${UNPACK_SCRIPT} exited ${result.exitCode}${tail ? `: ${tail}` : ""}`);
      }
      const profilePath = path.join(brandDir, "brand-profile.json");
      const hasProfile = await fs
        .access(profilePath)
        .then(() => true)
        .catch(() => false);
      if (!hasProfile) {
        return toolingError(`video.materializeInputs: the asset bundle unpacked but holds no brand-profile.json at its root (${brandDir})`);
      }
      return success<MaterializeInputsResult>({ videoPath: video.localPath, profilePath, brandDir, fetched });
    },
  });
}
