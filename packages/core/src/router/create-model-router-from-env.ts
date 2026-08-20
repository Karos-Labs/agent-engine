import Anthropic from "@anthropic-ai/sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { GoogleGenAI } from "@google/genai";
import { GoogleAuth } from "google-auth-library";
import OpenAI from "openai";
import { AgentPlatformAdapter } from "./adapters/agent-platform-adapter.js";
import { regionEnvVarNamesFor } from "./adapters/agent-platform-model-ids.js";
import { AnthropicAdapter } from "./adapters/anthropic-adapter.js";
import { GeminiAdapter } from "./adapters/gemini-adapter.js";
import { OpenAICompatibleAdapter } from "./adapters/openai-compatible-adapter.js";
import type { MessagesApiClient, ModelAdapter } from "./adapters/types.js";
import { createVertexModelGardenFetch, vertexModelGardenBaseUrl } from "./adapters/vertex-model-garden-client.js";
import { DefaultModelRouter, type ModelRouter, type ModelRouterAdapters } from "./model-router.js";

export interface CreateModelRouterFromEnvOptions {
  /** Defaults to `process.env`. Override for tests or a non-Node runtime. */
  env?: Record<string, string | undefined>;
}

/**
 * Which network path Claude calls take — Google Cloud's Agent Platform
 * (formerly Vertex AI) or the direct Anthropic API. This is a transport
 * choice *within* the `anthropic` vendor (RFC-01 §5.4: "Vertex is not a
 * fourth tier — it's a second route to the same pinned models"); it has
 * nothing to do with `ModelPolicy.vendor`, which picks the vendor itself.
 * Naming keeps the pre-existing `MODEL_PROVIDER` env var, since it already
 * shipped, but the type/function names below say "route" to keep this
 * concept visibly distinct from vendor selection.
 */
export type ClaudeRoute = "agent-platform" | "anthropic";

/** Agent Platform's best-availability endpoint for Claude and Gemini alike; overridden per model where the global endpoint doesn't serve one. */
const DEFAULT_AGENT_PLATFORM_REGION = "global";
/** Most Model Garden Model-as-a-Service partner models are far more region-restricted than Claude/Gemini's own global endpoints — see `vertex-model-garden-client.ts`. */
const DEFAULT_MODEL_GARDEN_REGION = "us-central1";

function readEnv(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/**
 * A value that isn't shaped like a GCP region/location name is treated as
 * unset rather than sent to the API, matching Claude Code's own handling of
 * these variables — a stray path, URL, or quoted comment in a `--set-env-vars`
 * string otherwise produces a base URL that 404s with nothing pointing at the
 * cause.
 */
function isRegionLike(value: string): boolean {
  return /^[a-z0-9-]+$/.test(value);
}

function readRegion(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  const value = readEnv(env, ...names);
  return value !== undefined && isRegionLike(value) ? value : undefined;
}

export function resolveClaudeRoute(env: Record<string, string | undefined>): ClaudeRoute {
  const raw = readEnv(env, "MODEL_PROVIDER")?.toLowerCase();
  if (raw === undefined) return "agent-platform";
  if (raw === "anthropic") return "anthropic";
  if (raw === "agent-platform" || raw === "vertex") return "agent-platform";
  throw new Error(
    `createModelRouterFromEnv: MODEL_PROVIDER="${raw}" is not a known route — use "agent-platform" (default, Google Cloud's Agent Platform) or "anthropic" (direct)`,
  );
}

/** @deprecated kept as an alias of {@link resolveClaudeRoute} — the old name predates `ModelPolicy.vendor` and reads as if it resolved vendor selection generally. It never did; it only ever picked Claude's own transport. */
export const resolvePinnedRouteProvider = resolveClaudeRoute;

/**
 * Builds the Agent Platform (formerly Vertex AI) adapter for Claude calls.
 * Authentication is Application Default Credentials only — the attached
 * service account on Cloud Run, `gcloud auth application-default login`
 * locally — so no model credential is ever passed to a container as an
 * environment variable value (RFC-01 §16.3's rule). `AnthropicVertex`
 * resolves ADC itself through `google-auth-library`; there is deliberately
 * no key-file or access-token branch here. (Nor could there usefully be an
 * access-token one: the SDK's `accessToken` constructor option is stored and
 * then never read as of `@anthropic-ai/vertex-sdk@0.19.5` — every request
 * resolves an `AuthClient` regardless. See
 * `__tests__/agent-platform-wire.test.ts`, which injects a stub `authClient`
 * for exactly this reason.)
 *
 * Clients are memoized per region because region lives in the client's base
 * URL, not in the request — see `AgentPlatformAdapter.clientForRegion`.
 */
function createClaudeAgentPlatformAdapter(env: Record<string, string | undefined>): ModelAdapter {
  const projectId = readEnv(env, "ANTHROPIC_VERTEX_PROJECT_ID", "GOOGLE_CLOUD_PROJECT");
  if (!projectId) {
    throw new Error(
      "createModelRouterFromEnv: ANTHROPIC_VERTEX_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) is required when MODEL_PROVIDER=agent-platform — " +
        'set it to the GCP project whose Model Garden has Claude enabled, or set MODEL_PROVIDER=anthropic to route directly with an API key instead',
    );
  }

  const defaultRegion = readRegion(env, "CLOUD_ML_REGION", "VERTEX_AI_LOCATION") ?? DEFAULT_AGENT_PLATFORM_REGION;
  const baseURL = readEnv(env, "ANTHROPIC_VERTEX_BASE_URL");
  const promptCaching = readEnv(env, "DISABLE_PROMPT_CACHING") === undefined;

  const clients = new Map<string, MessagesApiClient>();
  const clientForRegion = (region: string): MessagesApiClient => {
    const cached = clients.get(region);
    if (cached) return cached;
    const client = new AnthropicVertex({
      projectId,
      region,
      ...(baseURL !== undefined ? { baseURL } : {}),
    });
    clients.set(region, client);
    return client;
  };

  const regionForModel = (canonicalModelId: string): string | undefined =>
    readRegion(env, ...regionEnvVarNamesFor(canonicalModelId));

  return new AgentPlatformAdapter({ clientForRegion, defaultRegion, regionForModel, promptCaching });
}

function createClaudeDirectAdapter(env: Record<string, string | undefined>): ModelAdapter {
  const apiKey = readEnv(env, "ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error(
      "createModelRouterFromEnv: ANTHROPIC_API_KEY is required when MODEL_PROVIDER=anthropic — " +
        "unset MODEL_PROVIDER to use the default Agent Platform route (Application Default Credentials, no key)",
    );
  }
  const promptCaching = readEnv(env, "DISABLE_PROMPT_CACHING") === undefined;
  return new AnthropicAdapter(new Anthropic({ apiKey }), {}, promptCaching);
}

/** The `anthropic` vendor adapter — always built, per {@link resolveClaudeRoute}. This is the router's one required vendor. */
function createAnthropicVendorAdapter(env: Record<string, string | undefined>): ModelAdapter {
  return resolveClaudeRoute(env) === "agent-platform" ? createClaudeAgentPlatformAdapter(env) : createClaudeDirectAdapter(env);
}

/**
 * Which network path Gemini calls take — Agent Platform (Vertex AI backend,
 * ADC) or the direct Gemini Developer API (`GEMINI_API_KEY`). The same
 * route/vendor distinction `ClaudeRoute` draws for Claude, scoped to Gemini:
 * a deployment can run Claude on Agent Platform and Gemini direct (or vice
 * versa) without either choice affecting the other.
 */
export type GeminiRoute = "agent-platform" | "direct";

export function resolveGeminiRoute(env: Record<string, string | undefined>): GeminiRoute {
  const raw = readEnv(env, "GEMINI_ROUTE")?.toLowerCase();
  if (raw === undefined) return "agent-platform";
  if (raw === "direct") return "direct";
  if (raw === "agent-platform" || raw === "vertex") return "agent-platform";
  throw new Error(`createModelRouterFromEnv: GEMINI_ROUTE="${raw}" is not a known route — use "agent-platform" (default) or "direct"`);
}

/**
 * Builds the `gemini` vendor adapter, or `undefined` if nothing configures
 * it — Gemini is optional, exactly like the pre-existing
 * `OPENAI_COMPATIBLE_BASE_URL` opt-in this generalizes. A step whose
 * `modelPolicy.vendor` is `"gemini"` with no adapter wired fails loudly and
 * specifically at the point of use (`DefaultModelRouter`'s own error), not
 * here at startup — most deployments never touch Gemini, and shouldn't need
 * Gemini credentials just to boot.
 *
 * Agent Platform route: ADC only, via `@google/genai`'s own
 * `googleAuthOptions` resolution (the SDK's default when `vertexai: true`
 * and no `apiKey` is given) — no key ever passed as an env var, same rule as
 * Claude's Agent Platform route. One client per resolved region, for the
 * same reason `AgentPlatformAdapter` keys Claude's clients that way.
 */
function createGeminiVendorAdapter(env: Record<string, string | undefined>): ModelAdapter | undefined {
  const route = resolveGeminiRoute(env);

  if (route === "direct") {
    const apiKey = readEnv(env, "GEMINI_API_KEY");
    if (!apiKey) return undefined;
    const client = new GoogleGenAI({ apiKey });
    return new GeminiAdapter({ client });
  }

  const projectId = readEnv(env, "GEMINI_VERTEX_PROJECT_ID", "GOOGLE_CLOUD_PROJECT");
  if (!projectId) return undefined;

  const defaultRegion = readRegion(env, "GEMINI_VERTEX_LOCATION", "CLOUD_ML_REGION", "VERTEX_AI_LOCATION") ?? DEFAULT_AGENT_PLATFORM_REGION;
  const clients = new Map<string, GoogleGenAI>();
  const clientForRegion = (region: string): GoogleGenAI => {
    const cached = clients.get(region);
    if (cached) return cached;
    const client = new GoogleGenAI({ vertexai: true, project: projectId, location: region });
    clients.set(region, client);
    return client;
  };

  const clientForModel = (canonicalModelId: string): GoogleGenAI => {
    const modelRegionVar = `GEMINI_REGION_${canonicalModelId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
    const region = readRegion(env, modelRegionVar) ?? defaultRegion;
    return clientForRegion(region);
  };

  return new GeminiAdapter({ client: clientForModel });
}

/**
 * Builds the `model-garden` vendor adapter, or `undefined` if nothing
 * configures it. This is Agent Platform's own Model-as-a-Service
 * OpenAI-compatible endpoint (`vertex-model-garden-client.ts`) — third-party
 * and open Model Garden models (Llama, Mistral, and similar), ADC-only, no
 * separate opt-in credential beyond a project id.
 *
 * Deliberately gated on its own `MODEL_GARDEN_PROJECT_ID` rather than
 * defaulting on whenever `GOOGLE_CLOUD_PROJECT` happens to be set for
 * something else (Firestore, telemetry, the Claude/Gemini routes) — a vendor
 * this consequential (it changes which company's model runs client-facing
 * work, the moment a step's `vendor` is switched to it) should need a
 * deliberate flag, not an accident of which other GCP features are already
 * configured. Set `MODEL_GARDEN_PROJECT_ID` to the same value as
 * `GOOGLE_CLOUD_PROJECT` to opt in explicitly with zero new project setup.
 */
function createModelGardenVendorAdapter(env: Record<string, string | undefined>): ModelAdapter | undefined {
  const projectId = readEnv(env, "MODEL_GARDEN_PROJECT_ID");
  if (!projectId) return undefined;

  const defaultRegion = readRegion(env, "MODEL_GARDEN_REGION") ?? DEFAULT_MODEL_GARDEN_REGION;
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const fetchWithAdcAuth = createVertexModelGardenFetch(auth);

  const clients = new Map<string, OpenAI>();
  const clientForRegion = (region: string): OpenAI => {
    const cached = clients.get(region);
    if (cached) return cached;
    // `apiKey` is a required constructor field but is never actually sent —
    // `fetchWithAdcAuth` overwrites the Authorization header on every
    // request with a live ADC bearer token (see that function's doc comment).
    const client = new OpenAI({ apiKey: "adc", baseURL: vertexModelGardenBaseUrl(projectId, region), fetch: fetchWithAdcAuth });
    clients.set(region, client);
    return client;
  };

  const resolveClient = (canonicalModelId: string): OpenAI => {
    const modelRegionVar = `MODEL_GARDEN_REGION_${canonicalModelId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
    const region = readRegion(env, modelRegionVar) ?? defaultRegion;
    return clientForRegion(region);
  };

  return new OpenAICompatibleAdapter(resolveClient, "vertex-model-garden");
}

/**
 * Builds the `openai-compatible` vendor adapter, or `undefined` if nothing
 * configures it: the real OpenAI API, or a self-hosted gateway (LiteLLM)
 * fronting whatever it fronts. Distinct from `model-garden` above even
 * though both share `OpenAICompatibleAdapter`'s wire mechanics — this one is
 * NOT Agent Platform and carries its own credential.
 */
function createOpenAICompatibleVendorAdapter(env: Record<string, string | undefined>): ModelAdapter | undefined {
  const baseURL = readEnv(env, "OPENAI_COMPATIBLE_BASE_URL");
  if (!baseURL) return undefined;
  const apiKey = readEnv(env, "OPENAI_COMPATIBLE_API_KEY", "OPENAI_API_KEY") ?? "unused";
  return new OpenAICompatibleAdapter(new OpenAI({ apiKey, baseURL }), "openai-compatible");
}

/**
 * Builds a real, working `ModelRouter` from environment configuration.
 *
 * Every `ModelPolicy` in this system resolves to a vendor (RFC-01 §5.4 +
 * `types/model-policy.ts`): `anthropic` by default (every step written
 * before vendor selection existed), or `gemini` / `model-garden` /
 * `openai-compatible` when a step's `modelPolicy.vendor` says so — set
 * directly in code, or overridden per step at the environment level via
 * `resolveModelPolicy` (`step-model-policy.ts`)'s `MODEL_STEP_<ID>_VENDOR`
 * / `MODEL_STEP_<ID>_MODEL` pair.
 *
 * `anthropic` is the only vendor this function requires configuration for —
 * it throws if it can't build one, since every existing agent depends on it
 * regardless of tier. `gemini`, `model-garden`, and `openai-compatible` are
 * each built only if their own configuration is present; a step that
 * requests an unconfigured vendor gets a specific, actionable error from
 * `DefaultModelRouter` at the point of use, not a vague failure at startup.
 */
export function createModelRouterFromEnv(options: CreateModelRouterFromEnvOptions = {}): ModelRouter {
  const env = options.env ?? process.env;

  const adapters: ModelRouterAdapters = { anthropic: createAnthropicVendorAdapter(env) };

  const gemini = createGeminiVendorAdapter(env);
  if (gemini) adapters.gemini = gemini;

  const modelGarden = createModelGardenVendorAdapter(env);
  if (modelGarden) adapters["model-garden"] = modelGarden;

  const openaiCompatible = createOpenAICompatibleVendorAdapter(env);
  if (openaiCompatible) adapters["openai-compatible"] = openaiCompatible;

  return new DefaultModelRouter(adapters);
}
