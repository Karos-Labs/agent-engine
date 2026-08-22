import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, toolingError } from "@agent-engine/tool-common";
import { ImageProviderError, type ImageSearchProvider } from "./providers.js";

const TOOL_VERSION = "1.0.0";

/**
 * Every downloaded file lands under this repo-relative prefix. Kept in one
 * place because two separate things depend on it: the caller bounds-checks
 * against it, and a deployment that mounts scratch space needs to know which
 * directory actually grows.
 */
export const MEDIA_CACHE_PREFIX = ".media-cache";

export const FindImagesInputSchema = z.object({
  /** Bounds root. Every returned path is relative to this and provably inside it. */
  repoRoot: z.string().min(1),
  /**
   * One entry per slide that needs a picture. `n` is echoed back on each
   * candidate's description so the vetting agent can tell which need a
   * candidate was found for, without the tool deciding the match itself —
   * that judgement is step 06's job and stays there.
   */
  needs: z
    .array(
      z.object({
        n: z.number().int().positive(),
        query: z.string().min(1),
      }),
    )
    .min(1),
  /** Candidates to fetch per need. More gives the vetting agent room to reject. */
  perNeed: z.number().int().min(1).max(10).default(3),
  /** Namespaces the cache directory so two runs never collide on a filename. */
  runId: z.string().min(1),
});
export type FindImagesInput = z.input<typeof FindImagesInputSchema>;

export interface FindImagesCandidate {
  /** Repo-relative, forward-slashed — the shape `assertInside` and `slides-data.json` expect. */
  path: string;
  description: string;
}

export interface FindImagesResult {
  provider: string;
  candidates: FindImagesCandidate[];
  /** Needs that produced nothing, with the reason. Never silently dropped. */
  unmet: { n: number; query: string; reason: string }[];
}

/** Byte ceiling per image. A carousel slide never needs more, and this bounds a hostile or misconfigured URL. */
const MAX_BYTES = 12 * 1024 * 1024;

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

/**
 * `media.findImages` — the real image-search backend for `instagram-agent`
 * step 06.
 *
 * Before this, `imageCandidatePool` was a workflow *option* that
 * `apps/agent-server` never passed, so it defaulted to `[]`. An empty pool
 * cannot satisfy any slide's visual need, so step 06 held every production
 * Instagram run. The comment on the option said as much ("Phase 1 has no real
 * internet image-search tool yet"); this is that tool.
 *
 * It searches, downloads, and hands back repo-relative paths. It deliberately
 * does NOT decide which image fits which slide, nor whether one is usable —
 * `InstagramImageVettingAgent` does that, and folding the judgement in here
 * would move a gate that is supposed to be a model's explicit, recorded
 * verdict into an opaque ranking.
 */
export function createFindImages(provider: ImageSearchProvider, fetchImpl: typeof fetch = fetch) {
  return defineTool<FindImagesInput, FindImagesResult>({
    name: "media.findImages",
    version: TOOL_VERSION,
    inputSchema: FindImagesInputSchema,
    async execute(rawInput) {
      const input = FindImagesInputSchema.parse(rawInput);
      const relDir = `${MEDIA_CACHE_PREFIX}/${input.runId}`;
      const absDir = path.resolve(input.repoRoot, relDir);

      // Mirrors `assertInside` from karos-publish rather than importing it:
      // this package has no reason to depend on the publish package, and the
      // check is three lines. A runId containing "../" is the case that
      // matters, and it is caught here rather than after a write.
      const rootResolved = path.resolve(input.repoRoot);
      if (absDir !== rootResolved && !absDir.startsWith(rootResolved + path.sep)) {
        return toolingError(`media.findImages: resolved cache dir escaped repoRoot (runId="${input.runId}")`);
      }

      try {
        await fs.mkdir(absDir, { recursive: true });
      } catch (error) {
        return toolingError(`media.findImages: could not create ${relDir}: ${(error as Error).message}`);
      }

      const candidates: FindImagesCandidate[] = [];
      const unmet: FindImagesResult["unmet"] = [];

      for (const need of input.needs) {
        let hits;
        try {
          hits = await provider.search(need.query, input.perNeed);
        } catch (error) {
          if (error instanceof ImageProviderError) {
            // One provider failure is fatal for the whole call: partial pools
            // silently bias which slides can be filled, and step 06 holding
            // for "no candidate" would misreport an outage as an editorial
            // outcome.
            return toolingError(error.message);
          }
          throw error;
        }

        if (hits.length === 0) {
          unmet.push({ n: need.n, query: need.query, reason: `${provider.name} returned no results` });
          continue;
        }

        let savedForNeed = 0;
        for (const hit of hits) {
          const saved = await downloadHit(fetchImpl, hit, absDir, relDir, need.n);
          if (saved === undefined) continue;
          candidates.push({
            path: saved,
            // The licence rides on the description because that is the only
            // field that reaches the vetting agent, and it has to record a
            // real `license` string per selection.
            description: `slide ${need.n} candidate — ${hit.description} [licence: ${hit.license}]`,
          });
          savedForNeed += 1;
        }

        if (savedForNeed === 0) {
          unmet.push({ n: need.n, query: need.query, reason: `all ${hits.length} result(s) failed to download` });
        }
      }

      if (candidates.length === 0) {
        // Content, not tooling: the provider answered, nothing usable came
        // back. Step 06 will hold the post, which is the correct outcome —
        // but the caller gets a real reason instead of an empty pool.
        return contentFail(
          `media.findImages: no candidate images could be sourced for ${input.needs.length} need(s) via ${provider.name}`,
        );
      }

      return success<FindImagesResult>({ provider: provider.name, candidates, unmet });
    },
  });
}

/** Returns the repo-relative path written, or undefined when this hit could not be saved. */
async function downloadHit(
  fetchImpl: typeof fetch,
  hit: { id: string; url: string },
  absDir: string,
  relDir: string,
  n: number,
): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(hit.url, { signal: AbortSignal.timeout(20_000) });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;

  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const extension = EXTENSION_BY_TYPE[contentType];
  // An unrecognised content-type is refused rather than guessed: the renderer
  // feeds these straight to a browser, and a saved HTML error page named .jpg
  // fails much later and much less clearly.
  if (extension === undefined) return undefined;

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BYTES) return undefined;

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    return undefined;
  }
  // Re-checked after the fact: content-length is a claim, not a guarantee.
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return undefined;

  // Hashing the provider id keeps the filename stable for a given hit while
  // staying filesystem-safe whatever the provider's id format is.
  const stem = `n${n}-${createHash("sha256").update(hit.id).digest("hex").slice(0, 12)}`;
  const relative = `${relDir}/${stem}${extension}`;

  try {
    await fs.writeFile(path.join(absDir, `${stem}${extension}`), bytes);
  } catch {
    return undefined;
  }
  return relative;
}
