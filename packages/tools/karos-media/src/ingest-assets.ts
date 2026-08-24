import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, toolingError } from "@agent-engine/tool-common";
import { MEDIA_CACHE_PREFIX, downloadImage, type FindImagesCandidate } from "./find-images.js";

const TOOL_VERSION = "1.0.0";

/** Reads a `gs://` object. Structurally satisfied by `GcsArtifactStoreLike`/`GcsMediaStore`. */
export interface ObjectReader {
  download(objectPath: string): Promise<Buffer>;
}

export const IngestAssetsInputSchema = z.object({
  /** Bounds root. Every returned path is relative to this and provably inside it. */
  repoRoot: z.string().min(1),
  /** Namespaces the cache directory, exactly as the other media tools do. */
  runId: z.string().min(1),
  /** The assets a person attached to this run, in upload order. */
  assets: z
    .array(
      z.object({
        uri: z.string().min(1),
        label: z.string().min(1).optional(),
        /** Slide this asset is destined for. Assigned by the caller, by upload order. */
        slot: z.number().int().positive(),
      }),
    )
    .min(1),
});
export type IngestAssetsInput = z.input<typeof IngestAssetsInputSchema>;

export interface IngestAssetsResult {
  candidates: FindImagesCandidate[];
  /** Assets that could not be ingested, with the reason. Never silently dropped. */
  unmet: { slot: number; uri: string; reason: string }[];
}

/**
 * The licence line recorded on a client's own upload.
 *
 * The strongest basis there is: they own it and they chose it. Stated
 * explicitly because the vetting agent decides `rightsUsable`/`watermarkFree`
 * from the description and cannot inspect pixels — an upload arriving with no
 * provenance line reads as unknown provenance and gets refused, which is
 * exactly backwards for the one asset the client actually owns.
 */
const CLIENT_LICENCE = "client-supplied — owned by the client, uploaded deliberately for this post";

/** `gs://bucket/object/path` → the object path the reader wants. */
function parseGsUri(uri: string): { bucket: string; objectPath: string } | undefined {
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  return match ? { bucket: match[1]!, objectPath: match[2]! } : undefined;
}

const MIME_EXTENSION: Record<string, string> = { ".jpg": ".jpg", ".jpeg": ".jpg", ".png": ".png", ".webp": ".webp" };

/**
 * `media.ingestAssets` — Tier 0's downloader.
 *
 * ## Why this exists rather than passing the URI straight through
 *
 * The obvious implementation hands the attachment's `gs://` URI to the
 * candidate pool and lets the renderer sort it out. The renderer will not:
 * `assertInside` in karos-publish refuses URL-shaped strings outright
 * ("`must be a repo-relative path`"), by design, because a bad path there is a
 * tooling failure rather than a content one. So an un-ingested Tier 0 asset
 * clears the rights gate, reaches step 08, and dies — after the run has paid
 * for copy, vetting and every other tier.
 *
 * So attachments land in the same `.media-cache/<runId>/` directory every other
 * tier writes to, through the same `downloadImage` used by the harvester and
 * scrape tiers, which is what keeps one set of guarantees rather than three:
 * content-type refused rather than guessed, size ceiling enforced, filename
 * derived so a hostile URI cannot escape the directory.
 *
 * `https://` assets are fetched. `gs://` assets need credentials, so they go
 * through the injected reader; without one they are reported as unmet rather
 * than silently skipped.
 */
export function createIngestAssets(options: { reader?: ObjectReader | undefined; fetchImpl?: typeof fetch }) {
  const fetchImpl = options.fetchImpl ?? fetch;

  return defineTool<IngestAssetsInput, IngestAssetsResult>({
    name: "media.ingestAssets",
    version: TOOL_VERSION,
    inputSchema: IngestAssetsInputSchema,
    async execute(rawInput) {
      const input = IngestAssetsInputSchema.parse(rawInput);

      const relDir = `${MEDIA_CACHE_PREFIX}/${input.runId}`;
      const absDir = path.resolve(input.repoRoot, relDir);
      const rootResolved = path.resolve(input.repoRoot);
      if (absDir !== rootResolved && !absDir.startsWith(rootResolved + path.sep)) {
        return toolingError(`media.ingestAssets: resolved cache dir escaped repoRoot (runId="${input.runId}")`);
      }
      try {
        await fs.mkdir(absDir, { recursive: true });
      } catch (error) {
        return toolingError(`media.ingestAssets: could not create ${relDir}: ${(error as Error).message}`);
      }

      const candidates: FindImagesCandidate[] = [];
      const unmet: IngestAssetsResult["unmet"] = [];

      for (const asset of input.assets) {
        const describe = (relative: string): FindImagesCandidate => ({
          path: relative,
          description:
            `slide ${asset.slot} candidate — CLIENT-SUPPLIED asset uploaded with this run` +
            `${asset.label ? ` ("${asset.label}")` : ""}. The client owns this image and attached it deliberately, so it is ` +
            `rights-cleared and unwatermarked unless the picture itself shows otherwise. ` +
            `[licence: ${CLIENT_LICENCE}]`,
          provider: "client-upload",
          licenseConfidence: "client-supplied",
        });

        const gs = parseGsUri(asset.uri);
        if (gs !== undefined) {
          if (options.reader === undefined) {
            unmet.push({
              slot: asset.slot,
              uri: asset.uri,
              reason: "this deployment has no GCS reader configured, so a gs:// attachment cannot be read",
            });
            continue;
          }
          const extension = MIME_EXTENSION[path.extname(gs.objectPath).toLowerCase()] ?? ".png";
          const stem = `n${asset.slot}-client${input.assets.indexOf(asset)}`;
          const relative = `${relDir}/${stem}${extension}`;
          try {
            const bytes = await options.reader.download(gs.objectPath);
            if (bytes.byteLength === 0) {
              unmet.push({ slot: asset.slot, uri: asset.uri, reason: "the object is empty" });
              continue;
            }
            await fs.writeFile(path.join(absDir, `${stem}${extension}`), bytes);
          } catch (error) {
            unmet.push({ slot: asset.slot, uri: asset.uri, reason: `could not read the object: ${(error as Error).message}` });
            continue;
          }
          candidates.push(describe(relative));
          continue;
        }

        if (/^https?:\/\//i.test(asset.uri)) {
          // Same downloader as every other tier, so the content-type and size
          // guarantees cannot drift between them.
          const saved = await downloadImage(fetchImpl, { id: `client-${asset.slot}-${asset.uri}`, url: asset.uri }, absDir, relDir, asset.slot);
          if (saved === undefined) {
            unmet.push({ slot: asset.slot, uri: asset.uri, reason: "the URL did not return a usable image" });
            continue;
          }
          candidates.push(describe(saved));
          continue;
        }

        // A bare filesystem path is what the video tools still accept, and a
        // portal upload will never produce one. Reported rather than guessed
        // at: resolving it here would mean reading an arbitrary local path on
        // the strength of a job payload.
        unmet.push({
          slot: asset.slot,
          uri: asset.uri,
          reason: "unsupported attachment scheme — expected gs:// or https://",
        });
      }

      if (candidates.length === 0) {
        return contentFail(
          `media.ingestAssets: none of the ${input.assets.length} attachment(s) could be ingested — ${unmet
            .map((u) => `slide ${u.slot} (${u.reason})`)
            .join("; ")}`,
        );
      }

      return success<IngestAssetsResult>({ candidates, unmet });
    },
  });
}
