import type { AgentToolRegistry } from "@agent-engine/core";
import { defineTool, notAvailable } from "@agent-engine/tool-common";
import { z } from "zod";
import { createFindImages, FindImagesInputSchema } from "./find-images.js";
import { createUnsplashProvider, type ImageSearchProvider } from "./providers.js";

export * from "./providers.js";
export * from "./find-images.js";

export interface KarosMediaToolsOptions {
  env?: Record<string, string | undefined>;
  /** Overrides the env-derived provider. Tests pass a fake; a future backend swaps in here. */
  provider?: ImageSearchProvider;
  fetchImpl?: typeof fetch;
}

/**
 * `media.*` — image sourcing for agents that need real pictures.
 *
 * Follows the same rule as `video.*`/`landing.*` (see
 * `apps/agent-server/src/wiring/tools.ts`): an unconfigured deployment gets a
 * tool that reports per call, never a construction-time throw. Here the
 * report is `not_available` rather than `tooling_error`, because a missing
 * API key is a deployment that has not enabled the capability, not a
 * malfunction — and the two read very differently at 3am.
 */
export function createKarosMediaTools(options: KarosMediaToolsOptions = {}): AgentToolRegistry {
  const env = options.env ?? process.env;
  const accessKey = env.UNSPLASH_ACCESS_KEY?.trim();

  const provider =
    options.provider ??
    (accessKey ? createUnsplashProvider({ accessKey, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) }) : undefined);

  if (provider === undefined) {
    return {
      "media.findImages": defineTool<z.input<typeof FindImagesInputSchema>, never>({
        name: "media.findImages",
        version: "1.0.0",
        inputSchema: FindImagesInputSchema,
        async execute() {
          return notAvailable(
            "media.findImages: no image-search backend configured — set UNSPLASH_ACCESS_KEY (see packages/tools/karos-media/README.md)",
          );
        },
      }),
    };
  }

  return {
    "media.findImages": createFindImages(provider, options.fetchImpl ?? fetch),
  };
}
