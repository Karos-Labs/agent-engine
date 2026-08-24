/**
 * The image-search backend seam.
 *
 * `media.findImages` knows nothing about any particular provider — it takes a
 * chain of these, asks each for hits until one answers, and downloads the
 * result. Adding a source is a new implementation of this interface, not a
 * change to the tool.
 *
 * ## Why a chain, and not Unsplash alone
 *
 * This package originally shipped one provider (Unsplash) on the argument
 * that step 06 of `instagram-agent` records a real `license` /
 * `rightsUsable` / `watermarkFree` verdict per image and holds the whole post
 * when it cannot — so a general web search, returning images of unknown
 * provenance, would just move the hold later. That argument is sound, and it
 * is why `ddg_images` sits last in every chain and reports its provenance
 * honestly as unknown.
 *
 * But it was over-applied. It was used to justify a *single* provider, when
 * two of the sources it excluded — Openverse (CC-licensed Flickr/museum
 * photography) and Wikimedia Commons — carry real, per-asset licence metadata
 * and need no API key at all. The legacy engine ran ten connectors behind a
 * router with four of them keyless, and documented that the keyless ones
 * "are the working default today". Porting only Unsplash turned an optional
 * "premium stock mood" source into a single point of failure: prep held every
 * Instagram run because `UNSPLASH_ACCESS_KEY` was never provisioned, while
 * the legacy pipeline had been resolving the same slides keylessly.
 *
 * So: licence rigour is kept, and enforced per hit rather than per library.
 * `licenseConfidence` is what lets the chain rank a blanket-clean source
 * above an attributable one above an unknown one, instead of collapsing the
 * distinction into "Unsplash or nothing".
 */

/** How well a hit's licence can actually be justified to the rights gate. */
export type LicenseConfidence =
  /**
   * The client uploaded it themselves for this run. The strongest basis there
   * is — they own it, and they chose it — so it ranks above `generated`.
   * Without a distinct value an upload would arrive at the rights gate with no
   * provenance line and be refused as unknown provenance, which is exactly
   * backwards for the one asset the client actually owns.
   */
  | "client-supplied"
  /**
   * Created for this post, so there is no third-party rights question at all:
   * nobody else owns it, nobody needs crediting, nothing is watermarked.
   * Ranks above `blanket` — `image.generate` only.
   */
  | "generated"
  /** A blanket library licence covering commercial use — Unsplash, Google Places. */
  | "blanket"
  /** A real per-asset licence, usually CC, usually needing attribution — Openverse, Wikimedia. */
  | "attributable"
  /** User-generated or web-sourced. Provenance is not established; the gate should be sceptical. */
  | "unknown";

/** One provider result, before anything has been downloaded. */
export interface ImageSearchHit {
  /** Direct URL to the image bytes. */
  readonly url: string;
  /** What the picture shows, for the vetting agent to judge against a slide's `visualNeed`. */
  readonly description: string;
  /** Human-readable licence basis, recorded verbatim on the selection. */
  readonly license: string;
  /** Who made it — carried into the description so attribution is possible even when not required. */
  readonly credit: string;
  /** Provider's own id, used to build a stable filename. */
  readonly id: string;
  /**
   * How defensible the licence is. Optional so a hand-written provider (and
   * every existing test fake) stays valid; absent is read as `"unknown"`,
   * which is the conservative default.
   */
  readonly licenseConfidence?: LicenseConfidence;
  /** Landing page for the asset, when the provider exposes one. Attribution and audit. */
  readonly pageUrl?: string;
}

export interface ImageSearchProvider {
  readonly name: string;
  /** Returns at most `limit` hits. An empty array is a valid answer, not an error. */
  search(query: string, limit: number): Promise<ImageSearchHit[]>;
}

/** Thrown for a provider-side failure the tool should surface as `tooling_error`. */
export class ImageProviderError extends Error {}

/** Narrows to a non-empty trimmed string, or undefined. Shared by every provider's response mapping. */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Fetches JSON with a timeout, raising `ImageProviderError` on any transport,
 * status, or parse failure.
 *
 * Every provider funnels through this so a chain sees one error type and can
 * make one decision (demote to the next source) rather than pattern-matching
 * each library's own failure shape.
 */
export async function fetchJson(
  fetchImpl: typeof fetch,
  url: URL | string,
  options: { provider: string; query: string; headers?: Record<string, string>; timeoutMs?: number; init?: RequestInit } = {
    provider: "provider",
    query: "",
  },
): Promise<unknown> {
  const { provider, query, headers, timeoutMs = 15_000, init } = options;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ImageProviderError(`${provider} search failed for "${query}": ${(error as Error).message}`);
  }

  if (!response.ok) {
    throw new ImageProviderError(`${provider} search for "${query}" returned ${response.status}`);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new ImageProviderError(`${provider} returned a non-JSON body for "${query}": ${(error as Error).message}`);
  }
}
