import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool, success, contentFail, toolingError } from "@agent-engine/tool-common";
import { ImageProviderError, type ImageSearchHit, type ImageSearchProvider } from "./providers.js";
import { MEDIA_ROUTES, singleProviderSource, type ImageSource, type MediaRoute } from "./routing.js";

// 1.0.1 (SCRUM-296/AU11): removed the redundant re-parse of already-validated input.
const TOOL_VERSION = "1.0.1";

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
  /**
   * Candidates to request from EACH provider in the need's chain.
   *
   * Was "per need" when only one provider was ever consulted. Every provider
   * is now asked, so this is the per-source width and `maxPerNeed` is the
   * total ceiling.
   */
  perNeed: z.number().int().min(1).max(10).default(3),
  /**
   * Ceiling on the merged pool for one need, after every provider answered.
   *
   * The pool is not free: step 06 reads every candidate's description in one
   * prompt, so its cost and latency scale with this number (18 candidates
   * already cost ~63s and $0.02 on prep run pubsub-20632239329452475).
   * Diversity, not volume, is what the gate was missing — so the cap stays
   * low and `interleaveByProvider` spends it across sources rather than on
   * one source's deep tail.
   */
  maxPerNeed: z.number().int().min(1).max(30).default(6),
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
      // `defineTool` already ran `FindImagesInputSchema.safeParse` before calling this —
      // `rawInput` is genuinely the post-default OUTPUT shape at runtime; `FindImagesInput`
      // (this function's declared parameter type) is `z.input<...>`, the pre-default shape,
      // because that is the type a caller assembling arguments should see. Re-parsing here
      // to get the properly-typed value was actual removed work (SCRUM-296/AU11) — the two
      // shapes already coincide at runtime, so this cast documents that instead of a second
      // `.parse()` call redoing validation `defineTool` already did.
      const input = rawInput as z.output<typeof FindImagesInputSchema>;
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

        // Ask EVERY provider, instead of stopping at the first that returns
        // bytes.
        //
        // Stopping early looked like it respected the chain's licence
        // ranking. What it actually did, on prep run
        // pubsub-20632239329452475: Unsplash answers any generic query, so it
        // filled all 18 slots and openverse/wikimedia were never consulted.
        // The gate then rejected 5 of 6 slides for subject mismatch — it did
        // not want a cleaner licence, it wanted a picture of the right thing,
        // and the sources that might have held one were never asked.
        //
        // Merging cannot "dilute" the pool, which was the original argument
        // for stopping: every candidate is vetted individually against its
        // own recorded licence, so a low-confidence hit sitting beside a
        // high-confidence one costs the gate nothing and can only widen the
        // choice.
        const perProviderHits: Array<{ provider: string; hits: ImageSearchHit[] }> = [];
        const seenUrls = new Set<string>();

        // ── Every provider in the chain, CONCURRENTLY ──
        //
        // All of them are asked for every need — the chain is a ranking
        // order, never a stop condition (see the note above). What changed
        // (2026-08) is that they are now asked at the same time instead of
        // one after another.
        //
        // The saving is real and it compounds: six providers at roughly one
        // to three seconds each, per need, on a six-to-eight slide carousel,
        // is a minute or more of pure serial waiting per attempt — and the
        // drafting loop can run three attempts. Nothing about the merged pool
        // changes, because the fan-in below still walks `chain` IN ORDER.
        //
        // `allSettled`, not `all`: one provider rejecting must not discard
        // every healthy result alongside it, which is the same demote-don't-
        // abort rule the sequential version had.
        const settled = await Promise.allSettled(chain.map((provider) => provider.search(need.query, input.perNeed)));

        // Fan-in IN CHAIN ORDER, which is what keeps this identical to the
        // sequential behaviour rather than merely similar: dedup precedence
        // ("the earlier, higher-confidence provider keeps a shared URL") and
        // the interleave's within-round ordering both depend on it, and
        // `Promise.allSettled` preserves input order regardless of which
        // request actually finished first.
        for (const [index, provider] of chain.entries()) {
          const result = settled[index]!;

          if (result.status === "rejected") {
            const error = result.reason;
            if (error instanceof ImageProviderError) {
              // Demote, do not abort. One provider's outage must not discard
              // every healthy source alongside it. Still reported — just not
              // fatal while an alternative remains.
              attempts.push(`${provider.name}: ${error.message}`);
              sawProviderError = true;
              continue;
            }
            // A non-provider error is a real bug, not a source being down, so
            // it still propagates exactly as it did when awaited inline.
            throw error;
          }

          const hits = result.value;
          // The same photo can surface from two providers — Openverse
          // aggregates Wikimedia among others. Deduping on the byte URL keeps
          // the interleave honest; otherwise one image quietly consumes two
          // slots of a deliberately small budget.
          const fresh = hits.filter((h) => !seenUrls.has(h.url));
          for (const h of fresh) seenUrls.add(h.url);

          if (fresh.length === 0) {
            attempts.push(
              `${provider.name}: ${hits.length === 0 ? "no results" : "only duplicates of earlier providers"}`,
            );
            continue;
          }
          perProviderHits.push({ provider: provider.name, hits: fresh });
        }

        // Round-robin, so a `maxPerNeed` budget buys one pick from each source
        // before any source's second. Chain order still decides who goes first
        // within a round, so the highest-confidence provider keeps its
        // precedence without taking everything.
        for (const { provider, hit } of interleaveByProvider(perProviderHits)) {
          if (savedForNeed >= input.maxPerNeed) break;
          const saved = await downloadHit(fetchImpl, hit, absDir, relDir, need.n);
          if (saved === undefined) continue;
          candidates.push({
            path: saved,
            // The licence rides on the description because that is the only
            // field that reaches the vetting agent, and it has to record a
            // real `license` string per selection.
            description: `slide ${need.n} candidate — ${hit.description} [licence: ${hit.license}]`,
            provider,
            licenseConfidence: hit.licenseConfidence ?? "unknown",
          });
          savedForNeed += 1;
          if (!providersUsed.includes(provider)) providersUsed.push(provider);
        }

        if (savedForNeed === 0) {
          const offered = perProviderHits.reduce((n, p) => n + p.hits.length, 0);
          if (offered > 0) {
            attempts.push(
              `all ${offered} result(s) across ${perProviderHits.length} provider(s) failed to download`,
            );
          }
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

/**
 * Flattens per-provider hit lists into one round-robin sequence: every
 * provider's first hit in chain order, then every provider's second, and so
 * on. A provider with a shorter list simply drops out of later rounds.
 *
 * This is what turns a small `maxPerNeed` budget into a diverse pool rather
 * than the first provider's top-N.
 */
function interleaveByProvider(
  groups: Array<{ provider: string; hits: ImageSearchHit[] }>,
): Array<{ provider: string; hit: ImageSearchHit }> {
  const out: Array<{ provider: string; hit: ImageSearchHit }> = [];
  const deepest = groups.reduce((max, g) => Math.max(max, g.hits.length), 0);
  for (let round = 0; round < deepest; round++) {
    for (const group of groups) {
      const hit = group.hits[round];
      if (hit !== undefined) out.push({ provider: group.provider, hit });
    }
  }
  return out;
}

/**
 * Returns the repo-relative path written, or undefined when this hit could not
 * be saved.
 *
 * Exported as `downloadImage` for `media.scrapeImages`, which needs the exact
 * same guarantees: content-type refused rather than guessed, size ceiling
 * enforced twice (declared and actual), filename derived from a hash so a
 * provider's id format cannot escape the directory. A second download path
 * with its own subtly different checks is precisely the kind of duplication
 * that ends with an HTML error page saved as .jpg.
 */
export { downloadHit as downloadImage };

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
