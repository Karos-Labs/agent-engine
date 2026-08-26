import type { ImageSearchProvider } from "./providers.js";
import { createDdgImagesProvider } from "./providers/ddg-images.js";
import { createGooglePlacesProvider } from "./providers/google-places.js";
import { createOpenverseProvider } from "./providers/openverse.js";
import { createPexelsProvider } from "./providers/pexels.js";
import { createPixabayProvider } from "./providers/pixabay.js";
import { createUnsplashProvider } from "./providers/unsplash.js";
import { createWikimediaProvider } from "./providers/wikimedia.js";

/**
 * What a slide actually needs a picture *of* — the legacy engine's
 * `sourcing.route_for` concept.
 *
 * This exists because the right source depends on the subject, not on which
 * key happens to be plugged in. A named venue wants geo-verified
 * photography of that exact place; a mood slide wants the cleanest licence
 * available and does not care which building it is.
 */
export type MediaRoute = "named_venue" | "mood" | "default";

export const MEDIA_ROUTES: readonly MediaRoute[] = ["named_venue", "mood", "default"];

/**
 * Ordered provider preference per route. Names not present in the built
 * registry (their key is missing, or their actor is unavailable) are skipped,
 * which is what makes a chain degrade instead of break.
 *
 * ## Why these orders differ from the legacy config
 *
 * Legacy put `openverse` ahead of `unsplash_api` on the mood route, because
 * in that deployment Unsplash was an unplugged optional extra and Openverse
 * was the working default. The ordering encoded which keys existed, not which
 * source was better.
 *
 * Here the ranking is by licence defensibility, because that is what step 06
 * actually gates on: `blanket` (no attribution needed) before `attributable`
 * (real licence, credit required) before `unknown` (provenance unestablished).
 * Unsplash therefore leads the mood chain when configured, and Openverse
 * leads it when not — the same practical outcome as legacy, for a reason that
 * survives a key being added or removed.
 *
 * `named_venue` still puts verification before licence: a correctly-identified
 * venue photo needing credit is more useful than a beautifully-licensed photo
 * of the wrong place. `google_places` therefore leads it.
 *
 * The UGC sources that used to lead this chain (Google Maps venue photos and
 * Instagram-by-place) came from a third-party scraping vendor and were removed
 * with it (AU51): scraping is a swappable capability behind `ScraperProvider`,
 * and nothing above that seam names a vendor. The seam does not model place-tagged retrieval today,
 * so venue photography now depends on `google_places` — and falls through to
 * generic image search when its key is absent.
 */
export const ROUTE_CHAINS: Record<MediaRoute, readonly string[]> = {
  named_venue: [
    "google_places",
    "ddg_images",
    "openverse",
    "wikimedia",
  ],
  // `pexels`/`pixabay` sit beside `unsplash`: same `blanket` licence tier
  // (free commercial use, no attribution), distinct catalogues, so a need
  // that comes up short on one routinely hits on another before the pool
  // ever falls through to the attribution-bearing CC sources.
  //
  // `ddg_images` is now LAST on every route rather than absent from these two.
  //
  // It was excluded on measured evidence: its hits are
  // `licenseConfidence: "unknown"` by construction, the rights gate refuses
  // unknown provenance, and prep run pubsub-21535110633863323 produced 11 DDG
  // candidates, selected 0, and spent ~27s and ~$0.04 proving it. That
  // evidence still stands and is why it sits last, after every source whose
  // licence the gate can actually clear.
  //
  // Two things changed to make including it worth the cost anyway. Providers
  // are now queried CONCURRENTLY, so a slow last-place source adds no serial
  // latency to the pool. And `ddg_images` now walks the broadening ladder like
  // everything else, where before it sent the raw twenty-word `visualNeed` —
  // which is a large part of why its hit quality measured so badly. Its
  // candidates still lose to any `blanket`/`attributable` source in the
  // interleave, so it only ever contributes where better sources came up
  // short, which is exactly the case it exists for.
  mood: ["unsplash", "pexels", "pixabay", "openverse", "wikimedia", "ddg_images"],
  default: ["unsplash", "pexels", "pixabay", "openverse", "wikimedia", "ddg_images"],
};

export interface ProviderRegistryOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/**
 * Builds every provider the environment can support, keyed by name.
 *
 * Keyless providers are always present, which is the central behaviour
 * change: there is no longer an environment in which this package has no
 * backend at all. Keyed providers join when their key appears — one variable,
 * every client, exactly as the legacy CONNECTORS.md described.
 */
export function buildProviderRegistry(options: ProviderRegistryOptions = {}): Map<string, ImageSearchProvider> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl;
  const shared = fetchImpl ? { fetchImpl } : {};
  const registry = new Map<string, ImageSearchProvider>();

  // ── Keyless: always available ──
  registry.set("openverse", createOpenverseProvider(shared));
  registry.set("wikimedia", createWikimediaProvider(shared));
  registry.set("ddg_images", createDdgImagesProvider(shared));

  // ── Keyed: opt in by setting the variable ──
  const unsplashKey = env.UNSPLASH_ACCESS_KEY?.trim();
  if (unsplashKey) {
    registry.set("unsplash", createUnsplashProvider({ accessKey: unsplashKey, ...shared }));
  }

  const pexelsKey = env.PEXELS_API_KEY?.trim();
  if (pexelsKey) {
    registry.set("pexels", createPexelsProvider({ apiKey: pexelsKey, ...shared }));
  }

  const pixabayKey = env.PIXABAY_API_KEY?.trim();
  if (pixabayKey) {
    registry.set("pixabay", createPixabayProvider({ apiKey: pixabayKey, ...shared }));
  }

  const placesKey = env.GOOGLE_PLACES_KEY?.trim();
  if (placesKey) {
    registry.set("google_places", createGooglePlacesProvider({ apiKey: placesKey, ...shared }));
  }


  return registry;
}

/**
 * The ordered providers to try for one route, plus a description of what was
 * skipped and why.
 *
 * `chainFor` never returns an empty array in a normal deployment, because the
 * keyless providers are unconditional. It can only be empty if a caller
 * supplied its own empty registry, which `createKarosMediaTools` treats as
 * the genuine `not_available` case.
 */
export interface ImageSource {
  chainFor(route: MediaRoute): ImageSearchProvider[];
  /** Provider names actually available, in registry order. For run-record reporting. */
  readonly available: string[];
}

/** Every provider named by any built-in route. A name outside this set is a caller's own registration. */
const ROUTED_PROVIDER_NAMES = new Set(Object.values(ROUTE_CHAINS).flat());

export function createImageSource(registry: Map<string, ImageSearchProvider>): ImageSource {
  return {
    chainFor(route: MediaRoute): ImageSearchProvider[] {
      const chain = ROUTE_CHAINS[route] ?? ROUTE_CHAINS.default;
      const ordered = chain.map((name) => registry.get(name)).filter((p): p is ImageSearchProvider => p !== undefined);
      // A provider the built-in routes never mention — a caller's own
      // registration — is appended so an explicit registration is never
      // silently unreachable.
      //
      // Scoped to *unrouted* names only, and that scoping is load-bearing: it
      // used to append anything missing from this route, which meant a
      // provider deliberately left off a chain got added back to the end of
      // it anyway. Dropping `ddg_images` from `mood`/`default` would have been
      // a no-op.
      for (const [name, provider] of registry) {
        if (!ROUTED_PROVIDER_NAMES.has(name) && !ordered.includes(provider)) ordered.push(provider);
      }
      return ordered;
    },
    available: [...registry.keys()],
  };
}

/** Wraps one provider as a source that ignores routing. Used by tests and by an explicit `provider` override. */
export function singleProviderSource(provider: ImageSearchProvider): ImageSource {
  return { chainFor: () => [provider], available: [provider.name] };
}
