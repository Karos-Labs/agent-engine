import type { ImageSearchProvider } from "./providers.js";
import { createApifyProvider, APIFY_PRESETS, type ApifyPresetName } from "./providers/apify.js";
import { createDdgImagesProvider } from "./providers/ddg-images.js";
import { createGooglePlacesProvider } from "./providers/google-places.js";
import { createOpenverseProvider } from "./providers/openverse.js";
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
 * `named_venue` keeps legacy's ordering, because there verification beats
 * licence: a correctly-identified venue photo needing credit is more useful
 * than a beautifully-licensed photo of the wrong place. The UGC sources at
 * the top of that chain are `unknown`-confidence on purpose and step 06 will
 * refuse most of them — see the note in `providers/apify.ts`.
 */
export const ROUTE_CHAINS: Record<MediaRoute, readonly string[]> = {
  named_venue: [
    "apify_google_maps",
    "apify_instagram_location",
    "google_places",
    "ddg_images",
    "openverse",
    "wikimedia",
  ],
  mood: ["unsplash", "openverse", "wikimedia", "apify_pinterest", "ddg_images"],
  default: ["unsplash", "openverse", "wikimedia", "ddg_images"],
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

  const placesKey = env.GOOGLE_PLACES_KEY?.trim();
  if (placesKey) {
    registry.set("google_places", createGooglePlacesProvider({ apiKey: placesKey, ...shared }));
  }

  const apifyToken = env.APIFY_TOKEN?.trim();
  if (apifyToken) {
    for (const preset of Object.keys(APIFY_PRESETS) as ApifyPresetName[]) {
      registry.set(
        preset,
        createApifyProvider({
          token: apifyToken,
          preset,
          // Per-preset actor override, e.g. APIFY_ACTOR_APIFY_GOOGLE_MAPS.
          ...(env[`APIFY_ACTOR_${preset.toUpperCase()}`]?.trim()
            ? { actor: env[`APIFY_ACTOR_${preset.toUpperCase()}`]!.trim() }
            : {}),
          ...shared,
        }),
      );
    }
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

export function createImageSource(registry: Map<string, ImageSearchProvider>): ImageSource {
  return {
    chainFor(route: MediaRoute): ImageSearchProvider[] {
      const chain = ROUTE_CHAINS[route] ?? ROUTE_CHAINS.default;
      const ordered = chain.map((name) => registry.get(name)).filter((p): p is ImageSearchProvider => p !== undefined);
      // A provider registered but absent from this route's chain is still a
      // better answer than nothing — a caller-supplied custom provider, for
      // instance, appears in no built-in chain. Append the remainder so an
      // explicit registration is never silently unreachable.
      for (const provider of registry.values()) {
        if (!ordered.includes(provider)) ordered.push(provider);
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
