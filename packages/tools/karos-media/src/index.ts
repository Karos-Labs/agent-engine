import { GoogleGenAI } from "@google/genai";
import type { AgentToolRegistry } from "@agent-engine/core";
import { defineTool, notAvailable } from "@agent-engine/tool-common";
import { z } from "zod";
import { createFindImages, FindImagesInputSchema } from "./find-images.js";
import { createGenerateImage, type ImageGenerationClient } from "./generate-image.js";
import { createScrapeImages } from "./scrape-images.js";
import { createIngestAssets, type ObjectReader } from "./ingest-assets.js";
import { createScraperProvider, type ScraperProvider } from "@agent-engine/tool-karos-scraper";
import type { ImageSearchProvider } from "./providers.js";
import { buildProviderRegistry, createImageSource, singleProviderSource, type ImageSource } from "./routing.js";

export * from "./providers.js";
export * from "./providers/index.js";
export * from "./find-images.js";
export * from "./generate-image.js";
export * from "./scrape-images.js";
export * from "./ingest-assets.js";
export * from "./routing.js";
export * from "./quality.js";
export * from "./brand-logo.js";

export interface KarosMediaToolsOptions {
  env?: Record<string, string | undefined>;
  /** Overrides the whole env-derived chain with one provider. Tests pass a fake. */
  provider?: ImageSearchProvider;
  /** Overrides the env-derived chain with a full routed source. */
  source?: ImageSource;
  fetchImpl?: typeof fetch;
  /** Overrides the env-derived generation client. Tests pass a fake; `null` disables generation explicitly. */
  generationClient?: ImageGenerationClient | null;
  /** Overrides the env-derived scraper backing the scrape tier. `null` disables it explicitly. */
  scraper?: ScraperProvider | null;
  /** Reads `gs://` attachments for Tier 0. Without it a gs:// upload is reported unmet rather than skipped. */
  objectReader?: ObjectReader | undefined;
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

  const scraper = createScraperProvider({
    ...(options.env ? { env: options.env } : {}),
    ...(options.scraper !== undefined ? { provider: options.scraper } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  return {
    // ── Tier 0: media the client attached to this run ──
    "media.ingestAssets": createIngestAssets({
      ...(options.objectReader ? { reader: options.objectReader } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    }),
    // ── Tier 1: stock and CC harvesters ──
    "media.findImages": createFindImages(source, options.fetchImpl ?? fetch),
    // ── Tier 2: the open social web, for a photo of the actual subject ──
    "media.scrapeImages": createScrapeImages({
      ...(scraper ? { scraper } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    }),
    // Registered whether or not a backend exists — an unconfigured deployment
    // gets a tool that reports `not_available` per call, never a missing key
    // in the registry. The workflow checks for the tool, not for the config.
    // ── Tier 3: generation. The only tier that can answer any brief, and
    // therefore the only one that can actually guarantee a filled slide.
    "image.generate": createGenerateImage({
      client:
        options.generationClient === null
          ? undefined
          : (options.generationClient ?? createImageGenerationClientFromEnv(options.env ?? process.env)),
      ...(readImageModel(options.env ?? process.env) ? { model: readImageModel(options.env ?? process.env)! } : {}),
    }),
  };
}

function readImageModel(env: Record<string, string | undefined>): string | undefined {
  const value = env["IMAGE_GEN_MODEL"]?.trim();
  return value && value.length > 0 ? value : undefined;
}

/**
 * Builds a Vertex-backed generation client from the same project/location vars
 * the Gemini adapter reads, so enabling generation costs no new credential —
 * a deployment that can already reach Gemini on Vertex can generate images.
 *
 * Returns undefined when no project is configured, which makes
 * `image.generate` report `not_available` rather than throw.
 *
 * `@google/genai` is imported statically. A `require()` here would be
 * tempting, to keep the SDK off the module-load path for deployments that
 * never generate — but this package is ESM, so `require` is not defined at
 * runtime and the whole capability would have failed silently inside a
 * try/catch. `packages/core` already imports the same SDK, so a static import
 * costs nothing.
 */
function createImageGenerationClientFromEnv(env: Record<string, string | undefined>): ImageGenerationClient | undefined {
  const project = env["GEMINI_VERTEX_PROJECT_ID"]?.trim() || env["GOOGLE_CLOUD_PROJECT"]?.trim();
  if (!project) return undefined;
  // Deliberately NOT `CLOUD_ML_REGION`, which is "global" here: an image model
  // needs a concrete region. `us-central1` and `global` were both verified to
  // serve `gemini-2.5-flash-image` for this project; the explicit region is the
  // safer default of the two.
  const location = env["IMAGE_GEN_LOCATION"]?.trim() || env["VERTEX_AI_LOCATION"]?.trim() || "us-central1";
  return new GoogleGenAI({ vertexai: true, project, location }) as unknown as ImageGenerationClient;
}
