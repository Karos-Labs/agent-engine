import { logInfo, logWarning } from "@agent-engine/telemetry";
import type { ModelPolicy } from "../types/model-policy.js";
import { resolveModelVendor } from "../types/model-policy.js";
import { assertModelPriced } from "../telemetry/pricing.js";
import { assertModelCatalogued, lookupModelCapabilities } from "./model-capabilities.js";

/**
 * Complexity-aware model selection for a CONTEXT-DOCUMENT generation step
 * (SCRUM-380 / D1-v2).
 *
 * ## What this is, and what it deliberately is not
 *
 * A context document is a deliverable this engine writes once and then feeds
 * to every LATER agent as grounding — the Intel Report is the concrete one
 * (`readClientIntelContext` in `@agent-engine/workflow` distills it into the
 * drafting prompt of every channel agent). One bad context document is not
 * one bad post; it is the floor every subsequent post reasons from. That
 * asymmetry is the whole argument for spending more model on this step than
 * on the steps that consume it — and for spending it only when the instance
 * is actually hard, rather than pinning the step at a premium model forever.
 *
 * This is NOT a fallback mechanism and does not weaken RFC-01 §5.4's "a
 * pinned step never silently swaps models". Two different questions:
 *
 *   - `DefaultModelRouter`'s `fallbackModel` and `ResilientClaudeAdapter`'s
 *     hops answer "the call I just made FAILED, what now?" — after the fact,
 *     invisibly, mid-step.
 *   - This answers "how hard is the instance I am ABOUT to send?" — before
 *     the call, deterministically, from inputs already in hand, and it
 *     returns a complete `ModelPolicy` the caller can log, assert on, and
 *     attribute cost to.
 *
 * A `pinned` policy stays pinned through this: whichever model is selected,
 * that model is what runs or the step fails loudly. Selection here is the
 * same KIND of act as `resolveModelPolicy`'s `MODEL_STEP_<ID>_VENDOR/_MODEL`
 * env pair or a Studio `stageModels` pick — a decision made before the call,
 * not a substitution made during one.
 *
 * ## The transport layer is already solved, and is not re-implemented here
 *
 * "Vertex-primary with Anthropic-fallback" already exists and is already the
 * DEFAULT: `createAnthropicVendorAdapter` (`create-model-router-from-env.ts`)
 * wraps the Agent Platform / Vertex adapter in a `ResilientClaudeAdapter`
 * whose secondary hop is the direct Anthropic API and whose tertiary hop is
 * Vertex Gemini (AU61 / SCRUM-360). Nothing in this module duplicates,
 * replaces, or competes with that: it picks WHICH MODEL the step asks for;
 * that chain picks which ROUTE serves it. Both can be true at once and
 * neither knows about the other.
 */

/**
 * Everything this module measures, named. Every field is available to the
 * caller BEFORE the generation call, from values the workflow has already
 * assembled — no extra tool call, no probe turn, nothing that could itself
 * fail and take the run with it.
 *
 * This list IS the design decision. "Document complexity" is not an
 * intrinsic property of a document that has not been written yet; it can
 * only ever be a claim about the INPUTS, and the honest thing is to say
 * exactly which inputs and how they are weighted rather than to hide a
 * heuristic behind an adjective.
 */
export interface ContextDocumentComplexitySignals {
  /**
   * How many competitors the document must research, rank, and write a row
   * (plus, for deep-dives, a free-text positioning paragraph) for. The single
   * largest driver of both output length and reasoning breadth in an Intel
   * Report: the work is roughly linear in this number, and the "Wide Scan"
   * target the craft prompt sets is >= 8 rows.
   */
  readonly competitorCount: number;
  /**
   * Characters of research evidence the step must read and reconcile — the
   * serialized `research.pull` payload. Volume, not quality: a large evidence
   * base is harder to hold in one head whether or not any of it is useful.
   */
  readonly evidenceChars: number;
  /**
   * Characters of client context (profile, brand kit, knowledge base) handed
   * to the step alongside the evidence. Counted separately from evidence
   * because it is the half a client can grow without anyone re-running a
   * scan, and because a caller may legitimately have one and not the other.
   */
  readonly clientContextChars: number;
  /**
   * How many distinct steers are layered on top of the base task — a typed
   * run direction, a reviewer's revision directive, each remembered
   * past-feedback note. Each one is a constraint the model has to satisfy
   * simultaneously with everything else, and constraints compose worse than
   * they add.
   */
  readonly steerCount: number;
  /**
   * Which review round this is. Round 0 is the first draft; a round > 0
   * instance is by construction one a human has already looked at and sent
   * back, i.e. the empirically harder instance of this task, with the
   * previous draft's shortcomings to avoid on top of the original brief.
   */
  readonly revision: number;
}

/**
 * Estimated JSON-escaped English prose chars per token. Not a new number:
 * this is the same ~3.5 the `IntelReportDraftAgent` `maxTokens` sizing
 * already reasons with, kept identical on purpose so the two estimates
 * cannot drift into disagreeing about the same prompt.
 */
export const CHARS_PER_TOKEN = 3.5;

/**
 * Competitors a routine run carries before the field itself is the hard
 * part. Below this the row-production burden is not what makes an instance
 * difficult; above it, each additional competitor is another row, another
 * ranking comparison, and (for deep-dives) another positioning paragraph.
 */
const BASELINE_COMPETITORS = 3;
const COMPETITOR_WEIGHT = 1;
/**
 * One complexity point per this many estimated prompt tokens of input.
 * Calibrated so a full 200k-token Claude context window is worth 8 points on
 * its own — i.e. an instance that fills the window is unambiguously `high`
 * by evidence volume alone, without needing any other signal to agree.
 */
const EVIDENCE_TOKENS_PER_POINT = 25_000;
const EVIDENCE_WEIGHT = 1;
const STEER_WEIGHT = 0.5;
const REVISION_WEIGHT = 1;

/**
 * The one threshold. Deliberately stateable in a sentence rather than tuned
 * to a curve nobody can defend: an instance is `high` once its inputs are
 * worth about five Wide-Scan competitor rows of work. Reached by the Wide
 * Scan target alone (8 competitors -> 5.0), or by a smaller field plus a
 * large evidence base, a reviewer's revision, and stacked steers.
 */
export const HIGH_COMPLEXITY_THRESHOLD = 5;

/**
 * How much of a model's context window this is willing to plan to fill
 * before treating the instance as one that does not fit. Reserves headroom
 * for the parts of a prompt this estimate does not see — the cached system
 * block, the craft-policy skill body, the response contract, the ReAct
 * transcript on any turn after the first.
 */
const CONTEXT_SAFETY_FRACTION = 0.8;

/**
 * The premium same-vendor escalation: more reasoning for a hard instance,
 * no new wiring, no vendor change, no new failure mode. `anthropic` is the
 * router's one REQUIRED vendor (`ModelRouterAdapters`), so this branch can
 * never route a step at an adapter that was not built.
 */
const HIGH_COMPLEXITY_MODEL = "claude-opus-4-8";

/**
 * The large-context escalation, used only when the instance does not FIT.
 * Chosen from the catalog, not from taste: `gemini-2.5-pro` is the only
 * catalogued model with a 1,000,000-token window (`model-capabilities.ts`),
 * which is the single property this branch exists to buy. It is also a
 * VENDOR change, which is why it is gated — see `allowVendorEscalation`.
 */
const LARGE_CONTEXT_MODEL = "gemini-2.5-pro";

export type DocumentComplexityTier = "standard" | "high";

export interface ContextDocumentComplexity {
  readonly tier: DocumentComplexityTier;
  /** The weighted score itself, so a caller can log the number and not just the bucket. */
  readonly score: number;
  /** Estimated prompt tokens the measured input alone contributes. */
  readonly estimatedPromptTokens: number;
  /** Human-readable contributions, in the order they were added — for logs and test assertions. */
  readonly reasons: readonly string[];
}

/** Rounds to 2dp so a score is comparable and printable without float noise. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Scores one instance. Pure, total, and side-effect free: same signals in,
 * same tier out, on every replay of a resumed run. That matters more than it
 * might look — a workflow step's model choice has to be reproducible, or a
 * resumed run and its original could bill against different models with
 * nothing in the record explaining why.
 *
 * Negative or non-finite inputs are clamped rather than thrown on. This
 * function's failure mode must never be "the run dies before drafting": a
 * caller that hands it a `NaN` from a bad length calculation should get a
 * `standard` document, not a crash.
 */
export function assessContextDocumentComplexity(
  signals: ContextDocumentComplexitySignals,
): ContextDocumentComplexity {
  const clamp = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

  const competitorCount = clamp(signals.competitorCount);
  const chars = clamp(signals.evidenceChars) + clamp(signals.clientContextChars);
  const steerCount = clamp(signals.steerCount);
  const revision = clamp(signals.revision);

  const estimatedPromptTokens = Math.round(chars / CHARS_PER_TOKEN);
  const reasons: string[] = [];

  const competitorPoints = COMPETITOR_WEIGHT * Math.max(0, competitorCount - BASELINE_COMPETITORS);
  if (competitorPoints > 0) {
    reasons.push(`${competitorCount} competitors (${BASELINE_COMPETITORS} baseline) -> +${round2(competitorPoints)}`);
  }

  const evidencePoints = EVIDENCE_WEIGHT * (estimatedPromptTokens / EVIDENCE_TOKENS_PER_POINT);
  if (evidencePoints > 0) {
    reasons.push(`~${estimatedPromptTokens} estimated prompt tokens of input -> +${round2(evidencePoints)}`);
  }

  const steerPoints = STEER_WEIGHT * steerCount;
  if (steerPoints > 0) {
    reasons.push(`${steerCount} layered steers -> +${round2(steerPoints)}`);
  }

  const revisionPoints = REVISION_WEIGHT * revision;
  if (revisionPoints > 0) {
    reasons.push(`review round ${revision} -> +${round2(revisionPoints)}`);
  }

  const score = round2(competitorPoints + evidencePoints + steerPoints + revisionPoints);
  return {
    tier: score >= HIGH_COMPLEXITY_THRESHOLD ? "high" : "standard",
    score,
    estimatedPromptTokens,
    reasons,
  };
}

export interface ContextDocumentRoutingOptions {
  /**
   * Output ceiling this step reserves (`AgentStepConfig.maxTokens`). Counted
   * against the context window alongside the input, because a window holds
   * both: a 190k-token prompt to a 200k model does not fail until the model
   * tries to write the 32k-token report it was asked for.
   */
  readonly maxOutputTokens?: number;
  /**
   * Whether the large-context escalation may cross VENDORS (Claude ->
   * Gemini). Defaults to `false`, and that default is a deliberate
   * conservatism rather than an oversight: `ModelRouter` exposes no way to
   * ask which vendor adapters a deployment actually built
   * (`DefaultModelRouter.adapters` is private and the interface has no
   * capability query), so a routing decision made here cannot verify that
   * `gemini` is wired. Guessing wrong converts "a large report that might
   * have squeezed into Claude's window" into "a run that fails at the first
   * model call with a missing-adapter error". Deployments that have Gemini
   * configured — which is most, since `GOOGLE_CLOUD_PROJECT` alone is enough
   * (`createGeminiVendorAdapter`) — should turn this on explicitly.
   *
   * Left as a plain option rather than an env var on purpose: this repo
   * inventories its configuration (`scripts/config-inventory.ts`), and a new
   * env var is a deployment contract, not a local implementation detail.
   */
  readonly allowVendorEscalation?: boolean;
}

export interface ContextDocumentRoute {
  /** The policy to actually run this step with. Identical to `basePolicy` when nothing escalated. */
  readonly policy: ModelPolicy;
  readonly complexity: ContextDocumentComplexity;
  /** Why this policy, in one line — safe to log verbatim. */
  readonly rationale: string;
  /** True when `policy` differs from `basePolicy`. Convenience for assertions and metrics. */
  readonly escalated: boolean;
}

/**
 * Builds the escalated policy for `model`, taking the VENDOR from the
 * catalog rather than from the caller.
 *
 * That is the opposite of `applyStageModelOverride`'s rule, and the reason
 * for the difference is worth stating: a Studio pick is a bare string typed
 * by a human, so the vendor deliberately does not move with it (see that
 * function's docs). A selection made HERE names a model this module chose
 * from `MODEL_CAPABILITIES` itself, and that row records which vendor serves
 * it — so moving the vendor is reading a fact the catalog already holds, not
 * inferring one. `assertModelCatalogued` then re-checks the pair, so this
 * cannot quietly ship a model/vendor mismatch even if the constants above
 * are edited badly later.
 *
 * `fallbackModel` is dropped: it was chosen for the BASE model's vendor and
 * tier, and `ModelPolicySchema` requires a fallback to resolve against the
 * same vendor as its primary. Carrying it across an escalation would be the
 * one genuinely unsafe thing this function could do.
 */
function escalateTo(basePolicy: ModelPolicy, model: string, context: string): ModelPolicy {
  const capabilities = lookupModelCapabilities(model);
  if (!capabilities) {
    // Unreachable with the constants above (both have catalog rows, asserted
    // by this module's own tests), but this module must never hand back a
    // policy naming a model the catalog cannot vouch for.
    throw new Error(`${context}: escalation target "${model}" is not in the model-capability catalog`);
  }
  assertModelCatalogued(model, capabilities.vendor, context);
  assertModelPriced(model, context);

  const { fallbackModel: _dropped, ...rest } = basePolicy;
  return { ...rest, model, vendor: capabilities.vendor };
}

/**
 * The whole decision, in one call: score the instance, then pick a model.
 *
 * The two escalations are checked in this order on purpose, and the order is
 * the argument:
 *
 *   1. **Does it FIT?** A capability question, not a preference. If the
 *      estimated prompt plus the reserved output ceiling would not fit in
 *      the base model's context window (with `CONTEXT_SAFETY_FRACTION`
 *      headroom), no amount of reasoning quality helps — the call fails on
 *      length. Only a bigger window fixes that, and in this engine's catalog
 *      exactly one model has one.
 *   2. **Is it HARD?** A quality question. A `high`-tier instance that fits
 *      goes to the premium same-vendor model.
 *
 * A `standard` instance that fits returns `basePolicy` completely unchanged
 * — byte-identical to what the step compiled with — so a deployment that
 * never trips either branch behaves exactly as it did before this module
 * existed.
 */
export function routeContextDocumentModel(
  basePolicy: ModelPolicy,
  signals: ContextDocumentComplexitySignals,
  options: ContextDocumentRoutingOptions = {},
): ContextDocumentRoute {
  const complexity = assessContextDocumentComplexity(signals);
  const context = `routeContextDocumentModel("${basePolicy.model}")`;

  const maxOutputTokens = Number.isFinite(options.maxOutputTokens) ? Math.max(0, options.maxOutputTokens!) : 0;
  const baseCapabilities = lookupModelCapabilities(basePolicy.model);
  const baseWindow = baseCapabilities?.contextWindowTokens;
  const needed = complexity.estimatedPromptTokens + maxOutputTokens;
  const usableWindow = baseWindow !== undefined ? Math.floor(baseWindow * CONTEXT_SAFETY_FRACTION) : undefined;
  const overflows = usableWindow !== undefined && needed > usableWindow;

  if (overflows) {
    if (options.allowVendorEscalation === true) {
      const policy = escalateTo(basePolicy, LARGE_CONTEXT_MODEL, context);
      const rationale =
        `~${needed} tokens needed (input + ${maxOutputTokens} reserved output) exceeds ${usableWindow} usable of ` +
        `"${basePolicy.model}"'s ${baseWindow}-token window — routed to "${policy.model}" ` +
        `(${lookupModelCapabilities(policy.model)!.contextWindowTokens}-token window, vendor "${resolveModelVendor(policy)}")`;
      // Same reasoning as `recordFailover`: a routing decision nobody can see
      // is a way of not finding out. `event` is stable so a log-based metric
      // can count escalations as a rate.
      logInfo(`context-document routing: ${rationale}`, {
        event: "context_document.route",
        reason: "context_window",
        from: basePolicy.model,
        to: policy.model,
        vendor: resolveModelVendor(policy),
        score: complexity.score,
        estimatedPromptTokens: complexity.estimatedPromptTokens,
      });
      return { policy, complexity, escalated: true, rationale };
    }
    // Deliberately NOT silent, and deliberately not fatal. The step still runs
    // on its base model and may well fail on length — but it then fails with
    // the provider's own error, which is the truth, rather than with a
    // missing-adapter error caused by this module routing at a vendor the
    // deployment may never have wired. The log line is the fix instruction.
    const rationale =
      `~${needed} tokens needed exceeds ${usableWindow} usable of "${basePolicy.model}"'s ${baseWindow}-token ` +
      `window, but vendor escalation is disabled — kept "${basePolicy.model}"`;
    logWarning(`${context}: ${rationale}. Pass allowVendorEscalation to route large context documents at "${LARGE_CONTEXT_MODEL}".`, {
      event: "context_document.route_declined",
      reason: "vendor_escalation_disabled",
      model: basePolicy.model,
      estimatedPromptTokens: complexity.estimatedPromptTokens,
    });
    // And it returns HERE rather than falling through to the complexity
    // branch below. An instance that just failed a FIT check does not get a
    // premium same-window model: `claude-opus-4-8` has the same 200k window
    // as the Sonnet it would replace, so that escalation could not fix the
    // problem this branch just diagnosed — it would only pay 5x for the same
    // failure. Declining to escalate at all is the coherent answer to our own
    // claim that the instance does not fit.
    return { policy: basePolicy, complexity, escalated: false, rationale };
  }

  if (complexity.tier === "high" && basePolicy.model !== HIGH_COMPLEXITY_MODEL) {
    const policy = escalateTo(basePolicy, HIGH_COMPLEXITY_MODEL, context);
    const rationale =
      `complexity ${complexity.score} >= ${HIGH_COMPLEXITY_THRESHOLD} (${complexity.reasons.join("; ")}) — ` +
      `routed from "${basePolicy.model}" to "${policy.model}"`;
    logInfo(`context-document routing: ${rationale}`, {
      event: "context_document.route",
      reason: "complexity",
      from: basePolicy.model,
      to: policy.model,
      vendor: resolveModelVendor(policy),
      score: complexity.score,
      estimatedPromptTokens: complexity.estimatedPromptTokens,
    });
    return { policy, complexity, escalated: true, rationale };
  }

  return {
    policy: basePolicy,
    complexity,
    escalated: false,
    rationale: `complexity ${complexity.score} < ${HIGH_COMPLEXITY_THRESHOLD} — kept "${basePolicy.model}"`,
  };
}
