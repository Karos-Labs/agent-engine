import { describe, expect, it } from "vitest";
import { ROUTE_CHAINS, buildProviderRegistry } from "../src/routing.js";

/**
 * AU56 (SCRUM-355): a registered provider nobody can route to is dead weight,
 * and a route entry no provider answers is a silent hole. Both happened here.
 *
 *  - `apify_instagram` was registered by the token block and named in NO route
 *    chain. It could never be selected, and nothing flagged it.
 *  - `google_places` sat in the `named_venue` chain while its key was wired in
 *    neither cloudbuild file, so the route fell through its only
 *    place-verified tier to generic image search in every environment — for as
 *    long as the route had existed.
 *
 * The second is the one that cost something, and it is why this asserts both
 * directions. A route table is a promise about what a request will get; an
 * entry with no provider behind it is a promise nothing keeps.
 */

/** Every provider that any env combination can register. */
function allRegisterableProviders(): string[] {
  const fullEnv = {
    UNSPLASH_ACCESS_KEY: "k",
    PEXELS_API_KEY: "k",
    PIXABAY_API_KEY: "k",
    GOOGLE_PLACES_KEY: "k",
  };
  return [...buildProviderRegistry({ env: fullEnv }).keys()];
}

describe("AU56: route chains and the provider registry agree", () => {
  const routed = new Set(Object.values(ROUTE_CHAINS).flat());
  const registerable = allRegisterableProviders();

  it("every registerable provider is reachable from at least one route", () => {
    const unreachable = registerable.filter((name) => !routed.has(name));
    expect(
      unreachable,
      `these providers can be registered but no route names them, so nothing can ever select them: ${unreachable.join(", ")}`,
    ).toEqual([]);
  });

  it("every route entry is backed by a provider that can actually be registered", () => {
    const orphanEntries = [...routed].filter((name) => !registerable.includes(name));
    expect(
      orphanEntries,
      `these route entries name a provider the registry cannot build, so the route silently falls through: ${orphanEntries.join(", ")}`,
    ).toEqual([]);
  });

  it("named_venue still leads with its place-verified source", () => {
    // The whole point of the route: verification before licence. If this ever
    // stops being first, a venue request is being answered by something that
    // cannot confirm the place.
    expect(ROUTE_CHAINS.named_venue[0]).toBe("google_places");
  });

  it("names what a keyless deployment actually gets on each route", () => {
    // Documents the real fallback rather than asserting an aspiration: with no
    // keys at all, every route degrades to the same three keyless sources.
    const keyless = [...buildProviderRegistry({ env: {} }).keys()];
    expect(keyless).toEqual(["openverse", "wikimedia", "ddg_images"]);

    for (const [route, chain] of Object.entries(ROUTE_CHAINS)) {
      const reachable = chain.filter((name) => keyless.includes(name));
      expect(reachable.length, `${route} must retain at least one keyless source`).toBeGreaterThan(0);
    }
  });
});
