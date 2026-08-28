import type { ModelVendor } from "../types/model-policy.js";

/**
 * The typed model-capability catalog (AU33 / SCRUM-311).
 *
 * The switching machinery — `MODEL_STEP_<ID>_VENDOR`/`_MODEL` env overrides
 * (`resolveModelPolicy`) and Studio's per-run `stageModels`
 * (`applyStageModelOverride`) — was already solid. What it sat on top of was
 * a decision-free floor: any string reaching `applyStageModelOverride`
 * became the model for that step, whether or not it named a model that
 * exists, and whether or not it belonged to the vendor the step was already
 * wired to talk to. A Studio typo (`"claude-sonnet-4-fake"`) or a
 * well-formed id from the wrong vendor (`"gemini-2.5-pro"` swapped in for a
 * step still pointed at the Anthropic adapter) both went through silently —
 * the run would fail at the provider, or worse, `DefaultModelRouter` would
 * send an id from one vendor's namespace to another vendor's adapter, since
 * adapter selection is driven by `ModelPolicy.vendor` alone
 * (`model-router.ts`'s `adapterForVendor`), never by the model id itself.
 *
 * This module is the decision layer `applyStageModelOverride` was missing:
 * a catalog of every model id this engine is prepared to route to, what it
 * can do, and — critically for the vendor check — which vendor actually
 * serves it. Per Tomer's decision record (SCRUM-333 comment, 2026-08-28,
 * ruling 15): **this catalog is the SOLE authority for model identity**
 * inside agent-engine. Shlomi's middleware catalog (SCRUM-222 / S12) is
 * downstream of this one for identity purposes — it owns aliasing and
 * pricing on the portal side, not "does this model exist".
 *
 * ## Adding a row
 *
 * Keyed by the canonical Claude-API-shaped id this codebase already speaks
 * everywhere else (`router/adapters/agent-platform-model-ids.ts`'s design
 * rule): the same spelling `MODEL_PRICING`, `router/aliases.ts`, and every
 * agent's compiled `modelPolicy.model` use. An Agent-Platform-dated id
 * (`claude-haiku-4-5@20251001`) or a Model-Garden id carrying its publisher
 * prefix (`meta/llama-3.3-70b-instruct-maas`) both resolve against the same
 * row via `lookupModelCapabilities`'s normalization, mirroring
 * `telemetry/pricing.ts`'s `lookupModelPricing` — two independent tables
 * that both key on "the model id a call site actually holds" would drift
 * apart otherwise.
 *
 * `contextWindowTokens`, `modality`, and `regions` are drawn from each
 * vendor's published model documentation. `languageStrength`, `rtlSupport`,
 * `costTier`, and `structuredOutputReliability` are engineering judgment
 * calls, not measured benchmarks — AU33's own §4b follow-up work (the
 * per-step recommender and the golden-run measurement loop, SCRUM-312/313)
 * is what turns these into data-backed numbers. Until then, treat a row as
 * a documented starting point, not a verified claim, and update it when a
 * real per-language run says otherwise.
 */

/** What a model can take/produce beyond plain text. */
export type ModelModality = "text" | "image" | "audio" | "video";

/** Coarse relative spend, for routing decisions that don't need the exact `MODEL_PRICING` row. */
export type ModelCostTier = "budget" | "standard" | "premium";

/**
 * How reliably a model returns the exact shape `ModelRouter.complete`'s
 * `schema` asks for.
 *
 * - `native`      — a first-class structured-output / tool-use mechanism;
 *                    schema violations are rare enough to treat as a bug.
 * - `high`        — good tool-use support, occasional retry needed.
 * - `best-effort` — schema compliance is prompted for, not enforced by the
 *                    provider; expect a materially higher retry/failure rate.
 */
export type StructuredOutputReliability = "native" | "high" | "best-effort";

/** Overall strength across languages generally — not RTL-specific, see `rtlSupport`. */
export type LanguageStrength = "basic" | "strong" | "multilingual-strong";

/** Right-to-left script (Hebrew, Arabic) quality — the dimension AU33's geektime incident found entirely missing. */
export type RtlSupport = "none" | "basic" | "strong";

export interface ModelCapabilities {
  /** Which vendor actually serves this id — checked by `assertModelCatalogued` against a policy's resolved vendor. */
  readonly vendor: ModelVendor;
  readonly languageStrength: LanguageStrength;
  readonly rtlSupport: RtlSupport;
  readonly modality: readonly ModelModality[];
  readonly contextWindowTokens: number;
  readonly costTier: ModelCostTier;
  readonly structuredOutputReliability: StructuredOutputReliability;
  /**
   * Availability regions for the Agent-Platform/Vertex route. `["global"]`
   * means the `global` endpoint serves it and no `VERTEX_REGION_*` pin
   * (`agent-platform-model-ids.ts`'s `regionEnvVarNamesFor`) is required.
   * That existing per-model region-pin mechanism is unaffected by this
   * catalog — this field documents what's known to work, it doesn't
   * replace the env-var pin.
   */
  readonly regions: readonly string[];
}

const GLOBAL: readonly string[] = ["global"];

/**
 * The catalog. Every model id any shipped agent's compiled `modelPolicy`,
 * `router/aliases.ts`'s `MODEL_ALIASES`, or a step-level `fallbackModel`
 * currently names has a row — that set is exactly what a stage override
 * must be able to keep matching, so it can never fall short of what's
 * already running in production.
 */
export const MODEL_CAPABILITIES: Readonly<Record<string, ModelCapabilities>> = {
  // ── Anthropic ─────────────────────────────────────────────────────────
  "claude-opus-4-8": {
    vendor: "anthropic",
    languageStrength: "multilingual-strong",
    rtlSupport: "strong",
    modality: ["text", "image"],
    contextWindowTokens: 200_000,
    costTier: "premium",
    structuredOutputReliability: "native",
    regions: GLOBAL,
  },
  "claude-opus-4-7": {
    vendor: "anthropic",
    languageStrength: "multilingual-strong",
    rtlSupport: "strong",
    modality: ["text", "image"],
    contextWindowTokens: 200_000,
    costTier: "premium",
    structuredOutputReliability: "native",
    regions: GLOBAL,
  },
  "claude-sonnet-4-6": {
    vendor: "anthropic",
    languageStrength: "strong",
    rtlSupport: "strong",
    modality: ["text", "image"],
    contextWindowTokens: 200_000,
    costTier: "standard",
    structuredOutputReliability: "native",
    regions: GLOBAL,
  },
  // Dated and undated spellings of the same 4.5 Haiku snapshot both get a
  // row — see the module docs on why this table can't just normalize the
  // date away and stop at one entry (an env/Studio override may hold either
  // spelling verbatim).
  "claude-haiku-4-5-20251001": {
    vendor: "anthropic",
    languageStrength: "basic",
    rtlSupport: "basic",
    modality: ["text", "image"],
    contextWindowTokens: 200_000,
    costTier: "budget",
    structuredOutputReliability: "high",
    regions: GLOBAL,
  },
  "claude-haiku-4-5": {
    vendor: "anthropic",
    languageStrength: "basic",
    rtlSupport: "basic",
    modality: ["text", "image"],
    contextWindowTokens: 200_000,
    costTier: "budget",
    structuredOutputReliability: "high",
    regions: GLOBAL,
  },
  "claude-3-5-sonnet-20241022": {
    vendor: "anthropic",
    languageStrength: "strong",
    rtlSupport: "basic",
    modality: ["text", "image"],
    contextWindowTokens: 200_000,
    costTier: "standard",
    structuredOutputReliability: "high",
    regions: GLOBAL,
  },
  "claude-3-5-sonnet-v2-20241022": {
    vendor: "anthropic",
    languageStrength: "strong",
    rtlSupport: "basic",
    modality: ["text", "image"],
    contextWindowTokens: 200_000,
    costTier: "standard",
    structuredOutputReliability: "high",
    regions: GLOBAL,
  },
  "claude-3-5-haiku-20241022": {
    vendor: "anthropic",
    languageStrength: "basic",
    rtlSupport: "basic",
    modality: ["text"],
    contextWindowTokens: 200_000,
    costTier: "budget",
    structuredOutputReliability: "high",
    regions: GLOBAL,
  },
  "claude-3-opus-20240229": {
    vendor: "anthropic",
    languageStrength: "strong",
    rtlSupport: "basic",
    modality: ["text", "image"],
    contextWindowTokens: 200_000,
    costTier: "premium",
    structuredOutputReliability: "high",
    regions: GLOBAL,
  },
  "claude-3-haiku-20240307": {
    vendor: "anthropic",
    languageStrength: "basic",
    rtlSupport: "none",
    modality: ["text", "image"],
    contextWindowTokens: 200_000,
    costTier: "budget",
    structuredOutputReliability: "best-effort",
    regions: GLOBAL,
  },

  // ── Gemini ────────────────────────────────────────────────────────────
  "gemini-2.5-pro": {
    vendor: "gemini",
    languageStrength: "multilingual-strong",
    rtlSupport: "strong",
    modality: ["text", "image", "audio", "video"],
    contextWindowTokens: 1_000_000,
    costTier: "standard",
    structuredOutputReliability: "high",
    regions: GLOBAL,
  },
  "gemini-2.5-flash": {
    vendor: "gemini",
    languageStrength: "strong",
    rtlSupport: "strong",
    modality: ["text", "image", "audio", "video"],
    contextWindowTokens: 1_000_000,
    costTier: "budget",
    structuredOutputReliability: "high",
    regions: GLOBAL,
  },

  // ── OpenAI-compatible ─────────────────────────────────────────────────
  "gpt-4o": {
    vendor: "openai-compatible",
    languageStrength: "strong",
    rtlSupport: "basic",
    modality: ["text", "image"],
    contextWindowTokens: 128_000,
    costTier: "standard",
    structuredOutputReliability: "high",
    regions: GLOBAL,
  },
  "gpt-4o-mini": {
    vendor: "openai-compatible",
    languageStrength: "strong",
    rtlSupport: "basic",
    modality: ["text", "image"],
    contextWindowTokens: 128_000,
    costTier: "budget",
    structuredOutputReliability: "high",
    regions: GLOBAL,
  },

  // ── Model Garden (MaaS) ───────────────────────────────────────────────
  "llama-3.3-70b-instruct-maas": {
    vendor: "model-garden",
    languageStrength: "basic",
    rtlSupport: "none",
    modality: ["text"],
    contextWindowTokens: 128_000,
    costTier: "budget",
    structuredOutputReliability: "best-effort",
    regions: GLOBAL,
  },
  "mistral-small-2503": {
    vendor: "model-garden",
    languageStrength: "basic",
    rtlSupport: "none",
    modality: ["text"],
    contextWindowTokens: 32_000,
    costTier: "budget",
    structuredOutputReliability: "best-effort",
    regions: GLOBAL,
  },
  "mistral-medium-3": {
    vendor: "model-garden",
    languageStrength: "strong",
    rtlSupport: "basic",
    modality: ["text"],
    contextWindowTokens: 128_000,
    costTier: "standard",
    structuredOutputReliability: "best-effort",
    regions: GLOBAL,
  },
};

/** `claude-haiku-4-5@20251001` → `claude-haiku-4-5-20251001` (Agent Platform's `@`-dated spelling → canonical). */
const AGENT_PLATFORM_DATED = /^(.*)@(\d{8})$/;

/**
 * Resolves a model id to its catalog row, tolerating the same id spellings
 * `telemetry/pricing.ts`'s `lookupModelPricing` already tolerates: this
 * repo's own canonical id, Agent Platform's `@`-dated spelling, the undated
 * base id, and a Model-Garden id carrying its publisher prefix
 * (`meta/llama-3.3-70b-instruct-maas`) or not. Kept independent of that
 * function rather than sharing code with it, since a pricing miss and a
 * catalog miss are refused for different reasons and at different call
 * sites — but deliberately mirrors its normalization steps so the two
 * tables can't quietly disagree about which spellings name the same model.
 */
export function lookupModelCapabilities(modelId: string): ModelCapabilities | undefined {
  const direct = MODEL_CAPABILITIES[modelId];
  if (direct) return direct;

  const canonical = modelId.replace(AGENT_PLATFORM_DATED, "$1-$2");
  const canonicalMatch = MODEL_CAPABILITIES[canonical];
  if (canonicalMatch) return canonicalMatch;

  const undated = canonical.replace(/-\d{8}$/, "");
  const undatedMatch = MODEL_CAPABILITIES[undated];
  if (undatedMatch) return undatedMatch;

  const unprefixed = undated.includes("/") ? undated.slice(undated.indexOf("/") + 1) : undefined;
  return unprefixed ? MODEL_CAPABILITIES[unprefixed] : undefined;
}

/** Whether a model id resolves to a catalog row at all. */
export function isCataloguedModel(modelId: string): boolean {
  return lookupModelCapabilities(modelId) !== undefined;
}

/**
 * Refuses a model id that either isn't in the catalog at all, or is — but
 * under a different vendor than the caller expected. This is the guard
 * `applyStageModelOverride` was missing (AU33): a Studio pick is a model id
 * only, never a vendor (see that function's own docs on why vendor
 * deliberately doesn't move with it), so the model it names has to already
 * belong to the vendor the step is wired to, or the router would hand that
 * id to an adapter that has never heard of it
 * (`model-router.ts`'s `adapterForVendor` selects purely on
 * `ModelPolicy.vendor`, never on the model id).
 */
export function assertModelCatalogued(modelId: string, expectedVendor: ModelVendor, context: string): ModelCapabilities {
  const capabilities = lookupModelCapabilities(modelId);
  if (!capabilities) {
    throw new Error(
      `${context}: model "${modelId}" is not in the model-capability catalog ` +
        "(packages/core/src/router/model-capabilities.ts) — refusing rather than routing a step to a model id " +
        "that may not exist. Per SCRUM-311 (decision 15 on SCRUM-333), this engine's catalog is the sole authority " +
        "for model identity: add a row here — vendor, language/RTL strength, modality, context window, cost tier, " +
        "structured-output reliability, region — before this id can be selected.",
    );
  }
  if (capabilities.vendor !== expectedVendor) {
    throw new Error(
      `${context}: model "${modelId}" is catalogued under vendor "${capabilities.vendor}", but this step's model ` +
        `policy resolves to vendor "${expectedVendor}". A stage override changes which model answers the call, ` +
        "never which vendor does (the vendor's adapter is selected from ModelPolicy.vendor alone, never from the " +
        "model id) — use the MODEL_STEP_<ID>_VENDOR / MODEL_STEP_<ID>_MODEL env pair instead if this step needs to " +
        "move to a different vendor.",
    );
  }
  return capabilities;
}
