import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { AnthropicAdapter } from "./adapters/anthropic-adapter.js";
import { OpenAICompatibleAdapter } from "./adapters/openai-compatible-adapter.js";
import type { ModelAdapter } from "./adapters/types.js";
import { DefaultModelRouter, type ModelRouter } from "./model-router.js";

export interface CreateModelRouterFromEnvOptions {
  /** Defaults to `process.env`. Override for tests or a non-Node runtime. */
  env?: Record<string, string | undefined>;
}

function readEnv(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Builds a real, working `ModelRouter` from environment configuration.
 * `ANTHROPIC_API_KEY` backs the `pinned` tier directly — every agent in this
 * system today declares `modelPolicy: {policy: "pinned", ...}` with a Claude
 * model id (RFC-01 §5.4's alias table resolves the same way, see
 * `./aliases.ts`), so a working pinned tier is the one genuinely required
 * piece for any of these agents to run for real.
 *
 * `portable`/`commodity` default to that same Anthropic adapter (no agent in
 * this system currently declares either tier), but point
 * `OPENAI_COMPATIBLE_BASE_URL` at a gateway (the real OpenAI API, or a
 * self-hosted LiteLLM instance fronting other providers) to route those two
 * tiers through `OpenAICompatibleAdapter` instead, exactly as that adapter's
 * own doc comment describes.
 */
export function createModelRouterFromEnv(options: CreateModelRouterFromEnvOptions = {}): ModelRouter {
  const env = options.env ?? process.env;

  const anthropicApiKey = readEnv(env, "ANTHROPIC_API_KEY");
  if (!anthropicApiKey) {
    throw new Error(
      "createModelRouterFromEnv: ANTHROPIC_API_KEY is required — every pinned-tier agent in this system runs on Claude",
    );
  }
  const pinnedAdapter: ModelAdapter = new AnthropicAdapter(new Anthropic({ apiKey: anthropicApiKey }));

  let portableAdapter: ModelAdapter = pinnedAdapter;
  let commodityAdapter: ModelAdapter = pinnedAdapter;

  const compatibleBaseUrl = readEnv(env, "OPENAI_COMPATIBLE_BASE_URL");
  if (compatibleBaseUrl) {
    const compatibleApiKey = readEnv(env, "OPENAI_COMPATIBLE_API_KEY", "OPENAI_API_KEY") ?? "unused";
    const compatibleAdapter: ModelAdapter = new OpenAICompatibleAdapter(
      new OpenAI({ apiKey: compatibleApiKey, baseURL: compatibleBaseUrl }),
      "openai-compatible",
    );
    portableAdapter = compatibleAdapter;
    commodityAdapter = compatibleAdapter;
  }

  return new DefaultModelRouter({ pinned: pinnedAdapter, portable: portableAdapter, commodity: commodityAdapter });
}
