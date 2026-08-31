import { requirementForContentLanguage, type ContentLanguageRequirement } from "./client-model-policy.js";
import { MODEL_CAPABILITIES, type ModelCapabilities, type ModelCostTier } from "./model-capabilities.js";
import type { ModelVendor } from "../types/model-policy.js";

/**
 * Per-step model recommender (AU35 / SCRUM-313).
 *
 * ## What this is, and — as important — what it is not
 *
 * Given a step's task type, the client's content language, and a budget
 * tier, this ranks AU33's catalogued models (`model-capabilities.ts`) with a
 * reason per entry. It is built entirely on top of two already-landed
 * pieces: AU33's capability catalog (what a model can do) and AU34's
 * content-language requirement logic (`requirementForContentLanguage`,
 * reused verbatim rather than re-derived, so a client whose language demands
 * `multilingual-strong` + RTL here is judged by exactly the same rule that
 * already re-points their live copy steps).
 *
 * **This is a ranked opinion, not an earned recommendation — on purpose,
 * and the ticket's own words.** AU33's catalog values
 * (`languageStrength`, `rtlSupport`, `structuredOutputReliability`, ...) are
 * declared engineering judgment, not measured benchmarks (see that module's
 * header). AU25 (SCRUM-308)'s measurement loop is what will eventually turn
 * these into scored, per-language, per-task-type numbers from a real
 * corpus — but its rungs have not produced one yet as of this ticket. So
 * every recommendation this module returns today carries `basis:
 * "heuristic"`. The `"measured"` branch of that field exists so that once
 * AU25's corpus is real, a caller can start returning it — from a *different*
 * code path than this one, not by this module quietly relabeling the same
 * heuristic score. Nothing in this file ever emits `"measured"`; do not
 * "upgrade" that without an actual scored corpus behind it.
 *
 * ## Scope
 *
 * A pure, synchronous function over static inputs (the catalog is a
 * module-level constant; task type, language, and budget tier are plain
 * values) — no I/O, no client record lookup, no network. Callers that need
 * the CLIENT's language read it themselves however they already do
 * (`loadClientContentLanguage`) and pass the string in.
 *
 * This module deliberately does not decide *which vendor* a step is wired
 * to — unlike `applyClientLanguagePolicy`, which never moves a step's
 * vendor because the router's adapter selection is vendor-locked
 * (`model-router.ts`'s `adapterForVendor`). A *recommendation* is a
 * suggestion a human (or whatever surface renders this) can act on by also
 * changing the step's vendor/env pair — it ranks across the whole catalog by
 * default. Pass `vendor` to narrow the ranking to models a step could adopt
 * without a vendor change, for a caller that wants exactly that.
 */

/**
 * The four task-type shapes this ticket names, chosen to match the same
 * client-facing/internal split `ModelPolicy.contentLanguageSensitive`'s own
 * doc already draws ("text the client publishes in their own language, as
 * opposed to research notes, extraction, tagging, or an internal verdict"):
 * `copy` and `narrative` are client-facing, `extraction` and `qa` are not.
 * No fifth value is invented — a caller with a step that is none of these
 * has no business calling this function for it yet.
 */
export type RecommenderTaskType = "copy" | "extraction" | "qa" | "narrative";

/**
 * Reuses AU33's `ModelCostTier` verbatim rather than inventing a parallel
 * "budget tier" enum — the two questions ("how expensive is this model" and
 * "how much is this client/step willing to spend") are the same three-value
 * scale, and giving them different types would just be an extra mapping step
 * between them that could disagree with itself.
 */
export type RecommenderBudgetTier = ModelCostTier;

export interface RecommendModelsInput {
  readonly taskType: RecommenderTaskType;
  /**
   * The client's stated content language, AU31's free-text field verbatim
   * (`"Hebrew"`, `"he"`, `"he-IL"`, `"עברית"`, `""`/absent meaning
   * unstated). Judged with the exact same `requirementForContentLanguage`
   * AU34 already uses, so this recommender and the live per-client routing
   * can never quietly disagree about what a language demands.
   */
  readonly language?: string;
  readonly budgetTier: RecommenderBudgetTier;
  /**
   * Narrows the ranking to one vendor's models — the shape a caller wants
   * when recommending a replacement for a step that cannot change vendor
   * without an env-var deployment change (see module docs). Omitted ranks
   * across the whole catalog.
   */
  readonly vendor?: ModelVendor;
}

export interface ModelRecommendation {
  readonly modelId: string;
  readonly vendor: ModelVendor;
  /** 1-based position in the returned list — `result[0].rank === 1`. */
  readonly rank: number;
  /** Human-readable grounds for this position, most decisive first. Always at least one entry. */
  readonly reasons: readonly string[];
  /**
   * `"heuristic"` — ranked from AU33's declared capability judgments, not
   * measured performance. `"measured"` is reserved for a future caller
   * backed by AU25's scored corpus; this function never returns it (see
   * module docs).
   */
  readonly basis: "heuristic" | "measured";
}

const LANGUAGE_STRENGTH_RANK: Record<ModelCapabilities["languageStrength"], number> = {
  basic: 0,
  strong: 1,
  "multilingual-strong": 2,
};

const RTL_SUPPORT_RANK: Record<ModelCapabilities["rtlSupport"], number> = {
  none: 0,
  basic: 1,
  strong: 2,
};

const STRUCTURED_OUTPUT_RANK: Record<ModelCapabilities["structuredOutputReliability"], number> = {
  "best-effort": 0,
  high: 1,
  native: 2,
};

const COST_TIER_RANK: Record<ModelCostTier, number> = { budget: 0, standard: 1, premium: 2 };

/**
 * Per-task-type weighting. `language` and `structuredOutput` are mutually
 * exclusive by design (the client-facing/internal split from the module
 * docs) rather than a matter of degree: a client-facing step's output is
 * read by the client's audience, so language quality is what can visibly
 * embarrass it; an internal step's output is read by this system, so a
 * reliably-shaped answer is what keeps the pipeline from breaking, and its
 * language quality is moot. `costFit` and `contextWindow` apply to every
 * task type, `contextWindow` more so for the two long-form shapes.
 */
interface TaskTypeWeights {
  readonly language: number;
  readonly structuredOutput: number;
  readonly costFit: number;
  readonly contextWindow: number;
}

const TASK_TYPE_WEIGHTS: Record<RecommenderTaskType, TaskTypeWeights> = {
  copy: { language: 4, structuredOutput: 0, costFit: 2, contextWindow: 0 },
  narrative: { language: 4, structuredOutput: 0, costFit: 2, contextWindow: 1 },
  extraction: { language: 0, structuredOutput: 4, costFit: 2, contextWindow: 1 },
  qa: { language: 0, structuredOutput: 4, costFit: 2, contextWindow: 0 },
};

const CLIENT_FACING_TASK_TYPES: ReadonlySet<RecommenderTaskType> = new Set(["copy", "narrative"]);

/** >=500K tokens is "large" (Gemini's 1M-token row today), >=150K is "generous" (the 200K Claude/OpenAI rows), else "standard". */
function contextWindowScore(tokens: number): { score: number; label: string } {
  if (tokens >= 500_000) return { score: 2, label: "a very large context window" };
  if (tokens >= 150_000) return { score: 1, label: "a generous context window" };
  return { score: 0, label: "a standard context window" };
}

function languageComponent(
  taskType: RecommenderTaskType,
  requirement: ContentLanguageRequirement | undefined,
  capabilities: ModelCapabilities,
): { score: number; reasons: string[] } {
  if (!CLIENT_FACING_TASK_TYPES.has(taskType)) {
    return { score: 0, reasons: [] };
  }
  if (requirement === undefined) {
    // English, or no language stated: every catalogued model clears this bar,
    // so language only breaks ties here rather than gating anything.
    return {
      score: LANGUAGE_STRENGTH_RANK[capabilities.languageStrength],
      reasons: [`Language strength "${capabilities.languageStrength}" — no non-English content-language requirement was stated.`],
    };
  }

  const reasons: string[] = [];
  let score = 0;
  const meetsMultilingual = capabilities.languageStrength === "multilingual-strong";
  if (meetsMultilingual) {
    score += 6;
    reasons.push(`Meets the "multilingual-strong" language bar this client's content language requires.`);
  } else {
    score -= 6;
    reasons.push(
      `Language strength is only "${capabilities.languageStrength}", below the "multilingual-strong" bar this client's ` +
        "content language requires — risks fluent-sounding output in the wrong register or, per the geektime incident, in English.",
    );
  }

  if (requirement.rtlStrong) {
    if (capabilities.rtlSupport === "strong") {
      score += 3;
      reasons.push(`Right-to-left support is "strong", matching this client's RTL content language.`);
    } else {
      score -= 3;
      reasons.push(`Right-to-left support is only "${capabilities.rtlSupport}" — this client's content language is written right-to-left.`);
    }
  }

  return { score, reasons };
}

function structuredOutputComponent(capabilities: ModelCapabilities): { score: number; reason: string } {
  const rank = STRUCTURED_OUTPUT_RANK[capabilities.structuredOutputReliability];
  const reason =
    capabilities.structuredOutputReliability === "native"
      ? `Native structured-output support — the shape this task needs comes back reliably, not just prompted for.`
      : capabilities.structuredOutputReliability === "high"
        ? `High structured-output reliability, with occasional retries.`
        : `Best-effort structured-output reliability only — expect a materially higher retry/failure rate on this task's output shape.`;
  return { score: rank, reason };
}

function costFitComponent(capabilities: ModelCostTier, budgetTier: RecommenderBudgetTier): { score: number; reason: string } {
  const modelRank = COST_TIER_RANK[capabilities];
  const budgetRank = COST_TIER_RANK[budgetTier];
  if (modelRank === budgetRank) {
    return { score: 2, reason: `Cost tier "${capabilities}" matches the requested "${budgetTier}" budget tier exactly.` };
  }
  if (modelRank < budgetRank) {
    return { score: 1, reason: `Cost tier "${capabilities}" is cheaper than the requested "${budgetTier}" budget tier — comes in under budget.` };
  }
  return { score: -2, reason: `Cost tier "${capabilities}" exceeds the requested "${budgetTier}" budget tier.` };
}

/**
 * Ranks every catalogued model (optionally narrowed to one `vendor`) for one
 * step's task type, the client's content language, and a budget tier.
 *
 * Pure and synchronous: same inputs, same output, every time, in every
 * process — table-driven tests can assert on it directly with no fixture and
 * no network. Ties (equal total score) are broken by catalog declaration
 * order (`Object.entries(MODEL_CAPABILITIES)`'s iteration order, which is
 * insertion order for string keys — the same determinism
 * `selectModelForContentLanguage` already relies on), so the result is
 * stable across runs and across processes.
 */
export function recommendModelsForStep(input: RecommendModelsInput): readonly ModelRecommendation[] {
  const weights = TASK_TYPE_WEIGHTS[input.taskType];
  const requirement = requirementForContentLanguage(input.language ?? "");

  const scored: Array<{ modelId: string; capabilities: ModelCapabilities; score: number; reasons: string[] }> = [];

  for (const [modelId, capabilities] of Object.entries(MODEL_CAPABILITIES)) {
    if (input.vendor !== undefined && capabilities.vendor !== input.vendor) continue;

    const lang = languageComponent(input.taskType, requirement, capabilities);
    const structured = structuredOutputComponent(capabilities);
    const cost = costFitComponent(capabilities.costTier, input.budgetTier);
    const ctxWindow = contextWindowScore(capabilities.contextWindowTokens);

    const score =
      weights.language * lang.score +
      weights.structuredOutput * structured.score +
      weights.costFit * cost.score +
      weights.contextWindow * ctxWindow.score;

    const reasons: string[] = [...lang.reasons];
    if (weights.structuredOutput > 0) reasons.push(structured.reason);
    reasons.push(cost.reason);
    if (weights.contextWindow > 0) reasons.push(`Has ${ctxWindow.label} (${capabilities.contextWindowTokens.toLocaleString("en-US")} tokens).`);

    scored.push({ modelId, capabilities, score, reasons });
  }

  // `Array#sort` is stable per the ECMAScript spec (since ES2019) — ties keep
  // their `Object.entries` insertion order rather than an arbitrary one.
  scored.sort((a, b) => b.score - a.score);

  return scored.map((entry, index) => ({
    modelId: entry.modelId,
    vendor: entry.capabilities.vendor,
    rank: index + 1,
    reasons: entry.reasons,
    basis: "heuristic",
  }));
}
