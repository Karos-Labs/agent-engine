import { logWarning } from "@agent-engine/telemetry";
import type { AgentToolOutcome, ToolUnitUsage } from "../agent/tool.js";
import type { AgentStepTelemetry, TokenUsage } from "../types/agent-step.js";

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  /** Defaults to `inputPer1M * CACHE_READ_DISCOUNT` when absent. */
  cachedInputPer1M?: number;
  /** Defaults to `inputPer1M * CACHE_WRITE_PREMIUM` when absent. */
  cacheWritePer1M?: number;
}

/**
 * Anthropic prompt-cache reads run at roughly a 90% discount off the base
 * input price (RFC-01 §5.4) — applied to `AgentStepTelemetry.inputTokens.cached`
 * for every model, since providers behind the `portable`/`commodity` tiers
 * that support prompt caching follow the same order-of-magnitude discount.
 */
export const CACHE_READ_DISCOUNT = 0.1;

/**
 * Cache WRITES cost 25% MORE than base input, not less (SCRUM-361b).
 *
 * Source: docs.anthropic.com/en/docs/build-with-claude/prompt-caching — 5-minute
 * cache writes are 1.25x base input, 1-hour writes are 2x, cache reads 0.1x.
 * This codebase writes 5-minute entries (`cache_control: { type: "ephemeral" }`
 * in `messages-api-adapter.ts`), so 1.25 is the applicable multiplier. IF THAT
 * EVER CHANGES TO THE 1-HOUR TTL, THIS CONSTANT MUST CHANGE WITH IT — the two
 * are set in different files and nothing couples them.
 *
 * Before this existed, `cache_creation_input_tokens` was folded into `uncached`
 * and billed at 1x. The interesting part is not the 25%: it is that THE ERROR
 * ERASED ITS OWN EVIDENCE. Firestore stored `costUsd` and no token counts;
 * BigQuery merged cached and uncached into a single column; and the adapter
 * merged writes into uncached before either of them saw it. Three collapses
 * stacked, so the error could not be sized from our own telemetry at all — only
 * bounded from above. That is why the fix RECORDS the split rather than merely
 * applying it.
 */
export const CACHE_WRITE_PREMIUM = 1.25;

/**
 * USD per 1M tokens, cross-referenced against
 * `karosCMO/src/lib/models/usage-log.ts`'s `MODEL_PRICING` so a step's cost
 * here matches what the same call would cost through the portal's own
 * ledger. Update alongside that table when vendor pricing changes.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-8": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-opus-4-7": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-haiku-4-5-20251001": { inputPer1M: 0.8, outputPer1M: 4.0 },
  // Undated base ids: the fallback target of `pricingForModel`, and the
  // spelling Agent Platform uses verbatim for the 4.6-and-later generation
  // (where a dateless id is itself a pinned snapshot, not a moving pointer).
  "claude-haiku-4-5": { inputPer1M: 0.8, outputPer1M: 4.0 },
  "claude-3-5-sonnet-20241022": { inputPer1M: 3.0, outputPer1M: 15.0 },
  // v2 refresh (Oct 2024) — same published pricing as the original 3.5 Sonnet
  // above, but a distinct model id, so `pricingForModel`'s undated-fallback
  // (which only strips a trailing date) would never reach the row above.
  "claude-3-5-sonnet-v2-20241022": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-3-5-haiku-20241022": { inputPer1M: 0.8, outputPer1M: 4.0 },
  "claude-3-opus-20240229": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-3-haiku-20240307": { inputPer1M: 0.25, outputPer1M: 1.25 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "gemini-2.5-flash": { inputPer1M: 0.3, outputPer1M: 2.5 },
  "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10.0 },
  // Model Garden Model-as-a-Service (`vendor: "model-garden"`) partner
  // models, confirmed against cloud.google.com/vertex-ai/generative-ai/pricing
  // (checked 2026-08-20). Keyed by the exact model id string a step's
  // `modelPolicy.model` would pass through — verify it against that pricing
  // page (ids/names shift) before wiring a new Model Garden model into any
  // agent, and add its row here in the same change: an unrecognized id
  // silently falls back to `DEFAULT_MODEL_PRICING` (Sonnet's $3/$15), which
  // is a materially wrong number for most Model Garden partner models rather
  // than an obviously-broken one — worth catching in review, not billing.
  "llama-3.3-70b-instruct-maas": { inputPer1M: 0.72, outputPer1M: 0.72 },
  "mistral-small-2503": { inputPer1M: 0.1, outputPer1M: 0.3 },
  "mistral-medium-3": { inputPer1M: 0.4, outputPer1M: 2.0 },
  // Llama 3.1 405B and Mistral Large were NOT listed on Google's pricing page
  // as of the date above (delisted, renamed, or priced only on request) —
  // deliberately omitted rather than guessed. Confirm current pricing before
  // adding either.
};

export const DEFAULT_MODEL_PRICING: ModelPricing = { inputPer1M: 3.0, outputPer1M: 15.0 };

/**
 * Resolves the pricing row for a model id, tolerating the two spellings the
 * same model has on the two routes to it.
 *
 * Google Cloud's Agent Platform (formerly Vertex AI) dates a pinned snapshot
 * with `@` where the Claude API uses `-` (`claude-haiku-4-5@20251001` vs
 * `claude-haiku-4-5-20251001`), and returns its own spelling in
 * `response.model`. `AgentPlatformAdapter` already normalizes that before it
 * reaches telemetry (see `router/adapters/agent-platform-model-ids.ts`), so
 * this is the second line of defence, not the first — but a pricing miss
 * falls back to `DEFAULT_MODEL_PRICING` *silently*, which would bill Opus
 * work at Sonnet's $3/$15 in every per-step cost report (RFC-01 §11). A
 * plausible-looking wrong number is the worst failure mode available here, so
 * the lookup absorbs both spellings and, failing that, falls back to the
 * undated base id (`claude-haiku-4-5-20251001` -> `claude-haiku-4-5`) before
 * giving up.
 */
export function pricingForModel(modelName: string): ModelPricing {
  return lookupModelPricing(modelName) ?? unpricedFallback(modelName);
}

/** The lookup itself, absent the fallback — so `assertModelPriced` can ask without triggering one. */
function lookupModelPricing(modelName: string): ModelPricing | undefined {
  const direct = MODEL_PRICING[modelName];
  if (direct) return direct;

  const canonical = modelName.replace(/@(\d{8})$/, "-$1");
  const canonicalMatch = MODEL_PRICING[canonical];
  if (canonicalMatch) return canonicalMatch;

  const undated = canonical.replace(/-\d{8}$/, "");
  const undatedMatch = MODEL_PRICING[undated];
  if (undatedMatch) return undatedMatch;

  // Model Garden ids carry a publisher prefix in some call paths and not
  // others (`meta/llama-3.3-70b-instruct-maas` vs `llama-3.3-70b-instruct-maas`),
  // and this table is keyed without it. Found by SCRUM-361's selection-time
  // guard, which refused an existing test's `meta/llama-...` override: every
  // Model Garden row in this table was unreachable from a prefixed id, so a
  // model we had deliberately priced would still have billed at Sonnet's rate.
  const unprefixed = undated.includes("/") ? undated.slice(undated.indexOf("/") + 1) : undefined;
  return unprefixed ? MODEL_PRICING[unprefixed] : undefined;
}

/**
 * The default, made audible (SCRUM-361).
 *
 * This deliberately does NOT throw, and the reason is the one thing about this
 * function worth knowing. `pricingForModel` runs AFTER the model call, from
 * `computeStepCostUsd`. Throwing here would destroy a completed step's output
 * while the money stayed spent — the worst of both. It would also fire on ids
 * that never passed through selection at all: `modelUsed` comes from the
 * PROVIDER's response, so a failover hop reports whatever the provider called
 * itself.
 *
 * So the refusal lives at model SELECTION (`assertModelPriced`, before any
 * spend) and in CI (`scripts/check-model-pricing.ts`, before any deploy). This
 * is the third line, and its job is to be LOUD rather than fatal — the AU55
 * rule applied to a number instead of a capability. A silent default is what
 * makes an unpriced model produce a plausible figure: `DEFAULT_MODEL_PRICING`
 * is Sonnet's own rate, so an Opus step understates 5x and a small Gemini
 * model overstates ~40x, and neither looks wrong in a report.
 */
function unpricedFallback(modelName: string): ModelPricing {
  logWarning(
    `no pricing row for model "${modelName}" — billing it at DEFAULT_MODEL_PRICING ` +
      `($${DEFAULT_MODEL_PRICING.inputPer1M}/$${DEFAULT_MODEL_PRICING.outputPer1M} per 1M), which is Sonnet's rate and is almost certainly wrong. ` +
      "Every cost figure involving this step is unreliable until MODEL_PRICING gains a row for it.",
    { event: "pricing.unpriced_model", model: modelName },
  );
  return DEFAULT_MODEL_PRICING;
}

/**
 * Refuses a model that has no price, at SELECTION time (SCRUM-361).
 *
 * This is the backstop, not the mechanism. `scripts/check-model-pricing.ts` is
 * the mechanism: 27 declarations, all static string literals, all checkable
 * before a deploy. What CI cannot see is an id that arrives at run time —
 * `MODEL_STEP_<ID>_MODEL` from the environment, or a per-run `stageModels`
 * override chosen by an admin in the Studio. Those are exactly the two paths
 * this guards, and it guards them BEFORE the call, so a mispriced run does not
 * happen rather than being detected once it has.
 */
export function assertModelPriced(modelName: string, context: string): void {
  if (lookupModelPricing(modelName) || UNIT_PRICING[modelName]) return;
  throw new Error(
    `${context}: model "${modelName}" has no pricing row, so every run using it would report a cost that is wrong and looks right. ` +
      "Add it to MODEL_PRICING in packages/core/src/telemetry/pricing.ts with a checkable source, then retry. " +
      "Refused here rather than at cost-computation time, which is after the money is spent.",
  );
}

/** 6-decimal rounding, matching `karosCMO`'s own `computeCostUsd`. */
function roundCostUsd(raw: number): number {
  return Math.round(raw * 1_000_000) / 1_000_000;
}

/**
 * Computes one step's cost from its three-way input split and output tokens.
 *
 * `cacheWrite` is optional on the way in so a record persisted before
 * SCRUM-361b — which has no such field — still costs correctly rather than
 * throwing. It just costs the way it always did.
 */
export function computeStepCostUsd(
  modelName: string,
  inputTokens: TokenUsage | { cached: number; uncached: number; cacheWrite?: number },
  outputTokens: number,
): number {
  const pricing = pricingForModel(modelName);
  const cachedRate = pricing.cachedInputPer1M ?? pricing.inputPer1M * CACHE_READ_DISCOUNT;
  const writeRate = pricing.cacheWritePer1M ?? pricing.inputPer1M * CACHE_WRITE_PREMIUM;
  const raw =
    (inputTokens.uncached * pricing.inputPer1M +
      inputTokens.cached * cachedRate +
      (inputTokens.cacheWrite ?? 0) * writeRate +
      outputTokens * pricing.outputPer1M) /
    1_000_000;
  return roundCostUsd(raw);
}


// ── The per-unit dimension ────────────────────────────────────────────────
//
// Everything above prices TOKENS. Generative media is not billed in tokens, it
// is billed per image and per second, and until SCRUM-361 this file had no way
// to express that — which is half of why a measured Instagram run understated
// itself by ~14%. The other half was that tools had no way to report units at
// all (`AgentToolOutcome.usage`, added in the same change).
//
// This sits ALONGSIDE `MODEL_PRICING`, deliberately, rather than being folded
// into it. They are keyed the same way (a model/SKU id) and consulted the same
// way, but they answer different questions, and a row that carried both would
// invite the reader to assume a model has exactly one of them. Some have both:
// gemini-2.5-flash-image is billed per image AND charges for the text prompt.

/** What one unit of a non-token SKU costs. */
export interface UnitPricing {
  /** What is being counted. Checked against the reported `unit`, so a seconds count can never be billed at an image rate. */
  readonly unit: string;
  readonly usdPerUnit: number;
  /** Where the number came from. Required — an unsourced rate is a guess with a decimal point. */
  readonly source: string;
}

/**
 * USD per non-token unit, by model/SKU id.
 *
 * ## Adding a row
 *
 * `source` is mandatory and must name something checkable. The failure mode
 * this table is built against is a plausible number nobody can retrace: the
 * token table's own `DEFAULT_MODEL_PRICING` is Sonnet's rate, which is exactly
 * why an unpriced Opus call understates by 5x while every figure still LOOKS
 * right.
 *
 * There is deliberately NO default here. An unpriced unit throws
 * (`pricingForUnit`), and `scripts/check-model-pricing.ts` fails the build
 * before that can happen at run time — declining at wiring time rather than
 * call time, the same principle AU59 applied to the OpenAI-compatible adapter.
 */
export const UNIT_PRICING: Record<string, UnitPricing> = {
  // Verified two ways for the run measured in SCRUM-361: Vertex's own
  // publisher metric reported 2 `gemini-2.5-flash-image` invocations in that
  // run's window (both response_code=200), and Google's published rate is
  // 1290 output tokens per image at $30/1M.
  "gemini-2.5-flash-image": { unit: "image", usdPerUnit: 0.039, source: "ai.google.dev/gemini-api/docs/pricing — 1290 output tokens/image at $30/1M (checked 2026-08-27)" },
};

/**
 * NOTE ON VIDEO. `unit: "second"` is a first-class case in this design and has
 * NO ROW YET, on purpose. The video engine is unbuilt (SCRUM-362) and no video
 * model's rate has been verified against a published page or a metered call.
 *
 * That absence is the correct state and it is not silent: wiring a video model
 * without adding its row here fails `check-model-pricing`, which is precisely
 * the outcome wanted. Guessing a per-second rate now would produce a number
 * that looks right and is not, and would remove the only signal that would
 * have caught it.
 */

/** The unit price for a SKU. Throws rather than defaulting — see `UNIT_PRICING`. */
export function pricingForUnit(model: string): UnitPricing {
  const pricing = UNIT_PRICING[model];
  if (!pricing) {
    throw new Error(
      `pricingForUnit: no per-unit price for "${model}". Add a row to UNIT_PRICING with a checkable source. ` +
        "This throws rather than defaulting because a plausible wrong cost is worse than a loud missing one — " +
        "and scripts/check-model-pricing.ts should have failed the build before this ran.",
    );
  }
  return pricing;
}

/**
 * Costs the non-token units a tool consumed.
 *
 * Rejects a unit mismatch instead of multiplying anyway. A tool reporting 30
 * `second`s against a SKU priced per `image` is a wiring bug, and billing it
 * at $0.039 x 30 would hide that bug behind a number that reconciles.
 */
export function computeToolCostUsd(usage: readonly ToolUnitUsage[]): number {
  let raw = 0;
  for (const entry of usage) {
    const pricing = UNIT_PRICING[entry.model];
    if (!pricing) {
      // Loud, not fatal — the same rule as `unpricedFallback`, for the same
      // reason: this runs AFTER the units were consumed and paid for, so
      // throwing would destroy the step's output while the money stayed spent.
      //
      // Zero rather than a guessed rate, and the units are still PERSISTED on
      // the step record, so the run stays reconcilable once a rate exists. A
      // guessed default here would be strictly worse than a visible hole:
      // `scripts/check-model-pricing.ts` is what stops this reaching
      // production, and it fails the build before a deploy.
      logWarning(
        `no per-unit price for "${entry.model}" — ${entry.quantity} ${entry.unit}(s) recorded at $0. ` +
          "This run's cost is understated by whatever they actually cost. Add a UNIT_PRICING row with a checkable source.",
        { event: "pricing.unpriced_unit", model: entry.model, unit: entry.unit, quantity: entry.quantity },
      );
      continue;
    }
    if (pricing.unit !== entry.unit) {
      throw new Error(
        `computeToolCostUsd: "${entry.model}" is priced per ${pricing.unit} but ${entry.quantity} ${entry.unit}(s) were reported. ` +
          "Refusing to bill one unit at another's rate.",
      );
    }
    raw += entry.quantity * pricing.usdPerUnit;
  }
  return roundCostUsd(raw);
}

/**
 * Pulls unit usage out of whatever a `step.code` body returned.
 *
 * Deliberately shape-driven rather than opt-in. `step.code(id, () =>
 * tool.execute(...))` is the shape every media call already has, and requiring
 * each call site to declare "and please count this one" reintroduces exactly
 * the failure being fixed: the cost is missed by DEFAULT, and only the sites
 * someone remembered are counted. A tool that starts reporting usage is billed
 * everywhere it is called, immediately, with no call-site change.
 *
 * Recognises a single outcome or an array of them (a fanned-out step). Anything
 * else yields nothing, which is correct: most `step.code` bodies are ordinary
 * computation.
 */
export function extractToolUsage(output: unknown): readonly ToolUnitUsage[] {
  if (Array.isArray(output)) return output.flatMap((item) => extractToolUsage(item));
  if (typeof output !== "object" || output === null) return [];
  const outcome = output as Partial<AgentToolOutcome<unknown>> & { usage?: unknown };
  if (outcome.status !== "success" || !Array.isArray(outcome.usage)) return [];
  return outcome.usage.filter(
    (u): u is ToolUnitUsage =>
      typeof u === "object" && u !== null && typeof (u as ToolUnitUsage).model === "string" && typeof (u as ToolUnitUsage).quantity === "number",
  );
}

export interface TelemetryTotals {
  totalCostUsd: number;
  totalTokens: { input: number; output: number };
}

/** Rolls up a completed run's per-step telemetry into `AgentExecutionResult`'s totals. */
export function summarizeStepTelemetry(steps: readonly AgentStepTelemetry[]): TelemetryTotals {
  let totalCostUsd = 0;
  let input = 0;
  let output = 0;

  for (const step of steps) {
    totalCostUsd += step.costUsd;
    input += step.inputTokens.cached + step.inputTokens.uncached;
    output += step.outputTokens;
  }

  return { totalCostUsd: roundCostUsd(totalCostUsd), totalTokens: { input, output } };
}
