import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, toolingError } from "@agent-engine/tool-common";
import { ImageProviderError, type ImageSearchHit, type ImageSearchProvider } from "./providers.js";
import { MEDIA_ROUTES, singleProviderSource, type ImageSource, type MediaRoute } from "./routing.js";

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
        /**
         * What this slide needs a picture *of*, which decides the provider
         * order (`ROUTE_CHAINS`). Optional and defaulted so every existing
         * caller — including `instagram-agent` step 05b, which passes only
         * `{n, query}` — keeps working unchanged on the general-purpose chain.
         */
        route: z.enum(MEDIA_ROUTES as unknown as [MediaRoute, ...MediaRoute[]]).default("default"),
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
  /** Which provider in the chain actually supplied this. Recorded for audit. */
  provider: string;
  /** How defensible this image's licence is — `unknown` means the rights gate should be sceptical. */
  licenseConfidence: string;
}

export interface FindImagesResult {
  /** Every provider that contributed at least one candidate, in first-use order. */
  provider: string;
  providersUsed: string[];
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
export function createFindImages(source: ImageSource | ImageSearchProvider, fetchImpl: typeof fetch = fetch) {
  // Accepting a bare provider keeps every existing caller and test working;
  // a single provider is just a one-link chain.
  const imageSource: ImageSource = "chainFor" in source ? source : singleProviderSource(source);

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
      const providersUsed: string[] = [];
      /**
       * Needs left unfilled where at least one provider in the chain actually
       * errored, as opposed to honestly returning nothing.
       *
       * This distinction is the whole reason the chain does not simply
       * collapse every failure into `content_fail`: `content_fail` means "no
       * image out there fits", which is a real editorial answer a human
       * should act on, while an outage means the question was never asked.
       * A chain that recovers via a fallback absorbs the error and it is
       * correctly forgotten; only an unrecovered one is reported.
       */
      const outages: string[] = [];

      for (const need of input.needs) {
        const chain = imageSource.chainFor(need.route);
        if (chain.length === 0) {
          unmet.push({ n: need.n, query: need.query, reason: "no image-search provider is configured" });
          continue;
        }

        // Why each provider in the chain declined, so a hold can name the
        // real cause. Without this the caller only learns "no candidate
        // qualified", which reads as an editorial verdict and sends whoever
        // is debugging it looking for a licensing problem instead of an
        // unset key or a dead endpoint.
        const attempts: string[] = [];
        let savedForNeed = 0;
        let sawProviderError = false;

        for (const provider of chain) {
          let hits: ImageSearchHit[];
          try {
            hits = await provider.search(need.query, input.perNeed);
          } catch (error) {
            if (error instanceof ImageProviderError) {
              // Demote, do not abort. A single provider outage used to fail
              // the whole call; with a chain that would throw away every
              // healthy source behind it. The failure is still reported —
              // it just is not fatal while an alternative remains.
              attempts.push(`${provider.name}: ${error.message}`);
              sawProviderError = true;
              continue;
            }
            throw error;
          }

          if (hits.length === 0) {
            attempts.push(`${provider.name}: no results`);
            continue;
          }

          for (const hit of hits) {
            const saved = await downloadHit(fetchImpl, hit, absDir, relDir, need.n);
            if (saved === undefined) continue;
            candidates.push({
              path: saved,
              // The licence rides on the description because that is the only
              // field that reaches the vetting agent, and it has to record a
              // real `license` string per selection.
              description: `slide ${need.n} candidate — ${hit.description} [licence: ${hit.license}]`,
              provider: provider.name,
              licenseConfidence: hit.licenseConfidence ?? "unknown",
            });
            savedForNeed += 1;
          }

          if (savedForNeed > 0) {
            if (!providersUsed.includes(provider.name)) providersUsed.push(provider.name);
            // First provider to actually deliver wins the need — the chain is
            // a preference order, not a pool to merge. Merging would let a
            // low-confidence source dilute a high-confidence one.
            break;
          }

          attempts.push(`${provider.name}: all ${hits.length} result(s) failed to download`);
        }

        if (savedForNeed === 0) {
          unmet.push({ n: need.n, query: need.query, reason: attempts.join("; ") });
          if (sawProviderError) outages.push(`slide ${need.n}: ${attempts.join("; ")}`);
        }
      }

      // An unfilled need holds the entire post downstream, so a need left
      // unfilled *because a provider broke* has to surface as tooling — even
      // when other slides were filled fine. Reporting it as content would put
      // an outage in front of a human as "the topic had no good picture",
      // which is the exact misdiagnosis this tool exists to avoid.
      if (outages.length > 0) {
        return toolingError(
          `media.findImages: provider failure left ${outages.length} of ${input.needs.length} need(s) unfilled — ${outages.join(" | ")}`,
        );
      }

      if (candidates.length === 0) {
        // Content, not tooling: every provider answered honestly and had
        // nothing. Step 06 will hold the post, which is the correct outcome —
        // and the reason carries each provider's own words, so the hold names
        // a cause instead of only "no candidate qualified".
        const detail = unmet.map((u) => `slide ${u.n} (${u.reason})`).join("; ");
        return contentFail(
          `media.findImages: no candidate images could be sourced for ${input.needs.length} need(s). ` +
            `Chain tried: ${imageSource.available.join(", ") || "none"}. ${detail}`,
        );
      }

      return success<FindImagesResult>({
        provider: providersUsed[0] ?? "none",
        providersUsed,
        candidates,
        unmet,
      });
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
