import { logWarning } from "@agent-engine/telemetry";
import type { ModelPolicy } from "../types/model-policy.js";
import { resolveModelVendor } from "../types/model-policy.js";
import { lookupModelPricing } from "../telemetry/pricing.js";
import { MODEL_CAPABILITIES, lookupModelCapabilities, type ModelCapabilities, type ModelCostTier } from "./model-capabilities.js";

/**
 * Per-client model policy (AU34 / SCRUM-312).
 *
 * ## What was wrong
 *
 * Twenty-six of this system's twenty-seven `BaseAgent` steps are pinned to
 * `claude-sonnet-4-6` in their compiled `AgentStepConfig`, regardless of what
 * language the client they are drafting for actually publishes in. The one
 * escape hatch was `resolveModelPolicy`'s `MODEL_STEP_<ID>_VENDOR` /
 * `MODEL_STEP_<ID>_MODEL` pair (AU32 / SCRUM-310) — read from
 * `process.env` once, at module-evaluation time, before any run exists and
 * therefore before any *client* exists. That is a global-per-deployment
 * statement: setting `MODEL_STEP_INSTAGRAM_COPY_MODEL=claude-opus-4-8` to
 * serve one Hebrew-language outlet re-points that step for every other tenant
 * in the same process, and becomes actively wrong the moment a second client
 * with a different content language is onboarded. It also cannot be changed
 * without a deployment.
 *
 * This module is the per-client answer to the same question, resolved at RUN
 * time from the tenant's own stored configuration rather than from the
 * environment. Nothing here needs a deploy: onboard a Hebrew client, set the
 * `language` field AU31 (SCRUM-309) added to their brand kit, and their copy
 * steps route to a model that can actually write Hebrew.
 *
 * ## Where the two inputs come from
 *
 * - **"what language does this client publish in"** — AU31's BrandKit
 *   `language` field, the single language field in this system. Read through
 *   the workspace store's `readJson(clientSlug, segments)` access path, the
 *   same one `client.getBrand` / `client.getConfig` use
 *   (`packages/tools/karos-client/src/get-brand.ts`); see
 *   `loadClientContentLanguage` below.
 * - **"which models can write it"** — AU33's model-capability catalog
 *   (`model-capabilities.ts`), which per SCRUM-333 decision 15 (2026-08-28)
 *   is the SOLE authority on model identity inside agent-engine. The
 *   middleware catalog (S12 / SCRUM-222) is not consulted, deferred to, or
 *   synced with, here or anywhere else in this file.
 *
 * ## Precedence
 *
 * `applyClientLanguagePolicy` runs in `BaseAgent.effectivePolicy` between the
 * two overrides that already existed, so the full order is:
 *
 *   compiled default  <  MODEL_STEP_* env pair  <  client content language  <  Studio stageModels
 *
 * The env pair is deliberately left in place and deliberately *superseded*
 * rather than deleted: it is still the only way to move a step to a different
 * VENDOR, and a deployment that is using it today keeps working. It simply
 * stops being the last word for a language-sensitive step belonging to a
 * client who has stated their language — which is the entire point of this
 * ticket, since a per-deployment statement cannot be right for two clients at
 * once. Studio's per-run `stageModels` stays the most specific: a human
 * picking a model for this one run outranks a standing per-client rule.
 */

/** The tenant-scoped read this module needs — structurally satisfied by `WorkspaceStoreLike` (`@agent-engine/tools`), without Layer 2 taking a dependency on Layer 3. */
export interface ClientRecordReader {
  readJson<T>(clientSlug: string, segments: readonly string[]): Promise<T | undefined>;
}

/** AU31's BrandKit record — `["client", "brand"]`, exactly as `client.getBrand` addresses it. */
const CLIENT_BRAND_SEGMENTS: readonly string[] = ["client", "brand"];
/** The tenant's free-form standing config — `["client", "config"]`, exactly as `client.getConfig` addresses it. */
const CLIENT_CONFIG_SEGMENTS: readonly string[] = ["client", "config"];

function readLanguageField(record: Record<string, unknown> | undefined): string | undefined {
  const value = record?.["language"];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The client's stated content language, or `undefined` if they have not stated
 * one (which must never fail a run — an unconfigured tenant keeps exactly the
 * behaviour it had before this function existed).
 *
 * Reads AU31's `language` field. The brand kit is where that field lives and
 * therefore wins; `client/config` is consulted only as a fallback location for
 * the *same* field, for a tenant whose brand kit has not been set up. No
 * second language field is introduced anywhere — that was AU31's whole point,
 * and duplicating it here would recreate the ambiguity it removed.
 *
 * Store failures are swallowed with a warning for the same reason: a model
 * ROUTING preference must not be the thing that takes a run down.
 */
export async function loadClientContentLanguage(store: ClientRecordReader, clientSlug: string): Promise<string | undefined> {
  try {
    const brand = await store.readJson<Record<string, unknown>>(clientSlug, CLIENT_BRAND_SEGMENTS);
    const fromBrand = readLanguageField(brand);
    if (fromBrand !== undefined) return fromBrand;

    const config = await store.readJson<Record<string, unknown>>(clientSlug, CLIENT_CONFIG_SEGMENTS);
    return readLanguageField(config);
  } catch (err) {
    logWarning("loadClientContentLanguage: could not read this client's stored language — falling back to the step's own model policy", {
      clientSlug,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Right-to-left primary language subtags. `iw` is Hebrew's superseded ISO
 * 639-1 code, still emitted by older locale pickers; both spellings name the
 * same language and both must route the same way.
 */
const RTL_SUBTAGS = new Set(["he", "iw", "ar", "fa", "ur", "yi", "ji", "ps", "dv", "ku", "sd", "ug"]);

/** Plain English (and endonym) names for the same, since AU31's field is free text on purpose. */
const RTL_LANGUAGE_NAMES = new Set(["hebrew", "arabic", "farsi", "persian", "urdu", "yiddish", "pashto", "dhivehi", "divehi", "kurdish", "sindhi", "uyghur"]);

const ENGLISH_SUBTAGS = new Set(["en", "eng"]);
const ENGLISH_LANGUAGE_NAMES = new Set(["english"]);

/** Hebrew and Arabic script blocks — catches a language written in its own script ("עברית", "العربية"). */
const RTL_SCRIPT = /[֐-׿؀-ۿ܀-ݏހ-޿ࢠ-ࣿ]/;

/** `"he-IL"` / `"he_IL"` / `" Hebrew "` → `"he"` / `"hebrew"`. */
function normalizeLanguage(language: string): string {
  return language.trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

/** Whether this client publishes in English — the case the whole system's compiled defaults already assume. */
export function isEnglishContentLanguage(language: string): boolean {
  const primary = normalizeLanguage(language);
  return ENGLISH_SUBTAGS.has(primary) || ENGLISH_LANGUAGE_NAMES.has(primary);
}

/** Whether this client's content language is written right-to-left — the dimension the geektime incident found missing everywhere. */
export function isRightToLeftContentLanguage(language: string): boolean {
  const primary = normalizeLanguage(language);
  return RTL_SUBTAGS.has(primary) || RTL_LANGUAGE_NAMES.has(primary) || RTL_SCRIPT.test(language);
}

/**
 * What a model has to be, in AU33 catalog terms, to be trusted with copy in
 * this client's language.
 *
 * A non-English content language needs `multilingual-strong`: `strong`
 * (`claude-sonnet-4-6`'s row) is the catalog's judgment for "good at English
 * and serviceable elsewhere", which is precisely the level that produced a
 * fluent English carousel for a Hebrew-only outlet. A right-to-left language
 * needs `rtlSupport: "strong"` on top of that — the two are independent
 * columns in the catalog for a reason, and a model can be broadly
 * multilingual while mangling RTL punctuation and bidi runs.
 */
export interface ContentLanguageRequirement {
  readonly multilingualStrong: boolean;
  readonly rtlStrong: boolean;
}

export function requirementForContentLanguage(language: string): ContentLanguageRequirement | undefined {
  if (language.trim().length === 0 || isEnglishContentLanguage(language)) return undefined;
  return { multilingualStrong: true, rtlStrong: isRightToLeftContentLanguage(language) };
}

function satisfies(capabilities: ModelCapabilities, requirement: ContentLanguageRequirement): boolean {
  if (requirement.multilingualStrong && capabilities.languageStrength !== "multilingual-strong") return false;
  if (requirement.rtlStrong && capabilities.rtlSupport !== "strong") return false;
  return true;
}

const COST_TIER_ORDER: Record<ModelCostTier, number> = { budget: 0, standard: 1, premium: 2 };

/**
 * The cheapest catalogued model that meets `requirement` AND is served by
 * `vendor`.
 *
 * Vendor deliberately does not move — the same rule `applyStageModelOverride`
 * documents at length: `model-router.ts`'s `adapterForVendor` selects the
 * adapter from `ModelPolicy.vendor` alone, never from the model id, so
 * swapping in another vendor's id here would hand it to an adapter that has
 * never heard of it. A deployment that needs a language-capable model from a
 * *different* vendor still uses the `MODEL_STEP_<ID>_VENDOR`/`_MODEL` pair,
 * which is exactly the case that pair remains the only mechanism for.
 *
 * Candidates without a `MODEL_PRICING` row are skipped rather than selected
 * and then refused: this function makes a routing *preference*, so an
 * unpriced-but-capable model is a reason to keep looking, not a reason to
 * fail a run. Ties on cost tier fall back to catalog declaration order, so
 * the choice is deterministic across processes and across runs.
 */
export function selectModelForContentLanguage(
  vendor: ModelPolicy["vendor"],
  requirement: ContentLanguageRequirement,
): string | undefined {
  const resolvedVendor = resolveModelVendor({ ...(vendor !== undefined ? { vendor } : {}) });
  let best: { modelId: string; tier: number } | undefined;
  for (const [modelId, capabilities] of Object.entries(MODEL_CAPABILITIES)) {
    if (capabilities.vendor !== resolvedVendor) continue;
    if (!satisfies(capabilities, requirement)) continue;
    if (lookupModelPricing(modelId) === undefined) continue;
    const tier = COST_TIER_ORDER[capabilities.costTier];
    if (best === undefined || tier < best.tier) best = { modelId, tier };
  }
  return best?.modelId;
}

/**
 * Applies the client's content language to one step's already-resolved policy.
 *
 * Returns `policy` completely unchanged — the identical object reference — for
 * every case that is not "this step writes client-facing copy, for a client
 * who has stated a non-English language, whose current model cannot be trusted
 * with it". That covers: a step that never opted in
 * (`ModelPolicy.contentLanguageSensitive`), a client who has stated nothing, an
 * English-language client, a step already pointed at a capable model, and a
 * vendor with no capable catalogued alternative.
 *
 * The last of those logs and continues rather than throwing. This is a routing
 * preference derived from a tenant's configuration, not a correctness guard
 * like `assertModelCatalogued`: failing a Hebrew client's run outright because
 * their step's vendor has no multilingual-strong row would be a worse outcome
 * than the English-copy bug this exists to prevent, and the warning is what
 * makes the gap visible.
 */
export function applyClientLanguagePolicy(stepId: string, policy: ModelPolicy, contentLanguage: string | undefined): ModelPolicy {
  if (policy.contentLanguageSensitive !== true) return policy;
  if (contentLanguage === undefined) return policy;

  const requirement = requirementForContentLanguage(contentLanguage);
  if (requirement === undefined) return policy;

  const current = lookupModelCapabilities(policy.model);
  if (current !== undefined && satisfies(current, requirement)) return policy;

  const selected = selectModelForContentLanguage(policy.vendor, requirement);
  if (selected === undefined) {
    logWarning(
      `applyClientLanguagePolicy("${stepId}"): no catalogued model from vendor "${resolveModelVendor(policy)}" meets this client's content-language requirement — the step keeps its own model`,
      { stepId, contentLanguage, model: policy.model, vendor: resolveModelVendor(policy) },
    );
    return policy;
  }
  if (selected === policy.model) return policy;

  return { ...policy, model: selected };
}
