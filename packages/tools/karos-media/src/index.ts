import type { AgentToolRegistry } from "@agent-engine/core";
import { defineTool, notAvailable } from "@agent-engine/tool-common";
import { z } from "zod";
import { createFindImages, FindImagesInputSchema } from "./find-images.js";
import type { ImageSearchProvider } from "./providers.js";
import { buildProviderRegistry, createImageSource, singleProviderSource, type ImageSource } from "./routing.js";

export * from "./providers.js";
export * from "./providers/index.js";
export * from "./find-images.js";
export * from "./routing.js";
export * from "./quality.js";

export interface KarosMediaToolsOptions {
  env?: Record<string, string | undefined>;
  /** Overrides the whole env-derived chain with one provider. Tests pass a fake. */
  provider?: ImageSearchProvider;
  /** Overrides the env-derived chain with a full routed source. */
  source?: ImageSource;
  fetchImpl?: typeof fetch;
}

/**
 * `media.*` — image sourcing for agents that need real pictures.
 *
 * Follows the same rule as `video.*`/`landing.*` (see
 * `apps/agent-server/src/wiring/tools.ts`): an unconfigured deployment gets a
 * tool that reports per call, never a construction-time throw.
 *
 * ## `not_available` is now nearly unreachable, on purpose
 *
 * This used to return a `not_available` stub whenever `UNSPLASH_ACCESS_KEY`
 * was absent, which meant an unprovisioned deployment had no image sourcing
 * at all — and that is precisely what held every Instagram run on prep while
 * the key sat pending approval. Openverse, Wikimedia and DuckDuckGo need no
 * credential, so a chain always exists and the tool always works; keys only
 * ever *add* sources.
 *
 * The stub survives for one real case: a caller that explicitly supplies an
 * empty source. Nothing in this repo does, but the branch is honest about it
 * rather than pretending a chain exists.
 */
export function createKarosMediaTools(options: KarosMediaToolsOptions = {}): AgentToolRegistry {
  const source: ImageSource =
    options.source ??
    (options.provider
      ? singleProviderSource(options.provider)
      : createImageSource(
          buildProviderRegistry({
            ...(options.env ? { env: options.env } : {}),
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          }),
        ));

  if (source.available.length === 0) {
    return {
      "media.findImages": defineTool<z.input<typeof FindImagesInputSchema>, never>({
        name: "media.findImages",
        version: "1.0.0",
        inputSchema: FindImagesInputSchema,
        async execute() {
          return notAvailable(
            "media.findImages: no image-search provider is available — this deployment supplied an empty provider source " +
              "(see packages/tools/karos-media/README.md)",
          );
        },
      }),
    };
  }

  return {
    "media.findImages": createFindImages(source, options.fetchImpl ?? fetch),
  };
}
