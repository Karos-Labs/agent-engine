/**
 * Phase 0 cost controls — the owner's per-run budget (target $1.00, hard max
 * $1.50) as an ADAPTIVE plan, never a hold.
 *
 * The owner's rule (2026-09-09 amendment, binding): estimate before the run;
 * if the estimate would exceed the target, do NOT fail — adapt the plan to
 * fit, run, and deliver. If the estimate was low and the run still overran,
 * do NOT fail or throw the result away — finish on the cheapest path that
 * still yields a complete deliverable, deliver, and learn so the next run
 * stays under. A limit never breaks a run and never counts as a defect.
 *
 * Three pieces, all pure (no I/O, no clock of their own, no checkpoint):
 *
 *   1. The PLAN (`planRunBudget`) — estimated from the per-step cost table
 *      below × what the plan allows (attempts, generated images, evidence
 *      pulls, optional re-vets) × a per-client calibration learned from past
 *      runs (`RunBudgetHistory`: EWMA of actual/estimate). Over the target,
 *      the levers are pulled IN ORDER until it fits: cap generated images
 *      (tier-0/stock first, then text-only), evidence pulls down to the one
 *      most-cacheable query, self-check returns 2 -> 1, optional re-vets
 *      off. Every adaptation is a run note the reviewer sees.
 *   2. The METER (`RunSpendMeter`) — `max(measured, estimate)` per step
 *      (a Gemini-on-Vertex step may report $0; spec §0), consulted at every
 *      OPTIONAL spend point. Over the target: stop optional work (no more
 *      generated images, no rescue re-vets). Over the hard max: cheapest
 *      path — text-only downgrade for gaps, skip vision inspection and the
 *      optional visual-QA model call — and deliver. The mandatory gates
 *      (self-check, craft hygiene, language, relevance) are never skipped.
 *   3. The LEARNING (`recordRunInHistory`) — per client, per run: estimate,
 *      actual, breakdown, adaptations, whether the target/max was crossed.
 *      The next run's plan starts tighter after an overrun and relaxes again
 *      after two runs under target.
 *
 * Pricing: Sonnet 4.6 $3/$15, Gemini 2.5 Flash $0.30/$2.50, Haiku 4.5 $1/$5
 * per 1M tokens; `gemini-2.5-flash-image` $0.039/image; ScrappyCoco
 * $0.007/execution (`scrappycoco.ts` header).
 */

/** Generated images per RUN (all attempts, all revisions) at the widest plan — `remainingGenerationBudget` is the budget left for the next `generate` tier call. */
export const GENERATED_IMAGES_PER_RUN_CAP = 8;

/**
 * Candidates the harvester returns per photo slide — `media.findImages`'s
 * `maxPerNeed`, which the workflow now passes EXPLICITLY at `05b` from this
 * constant.
 *
 * One owned number because two consumers must agree on it: `05b` asks for
 * this many candidates per slide, and `05c` pays a vision inspection for
 * every candidate in the pool it produced. The estimator used to price 05c at
 * one image per photo slide while the tool's own schema default handed it six
 * — a 6x under-count of the second-largest per-attempt cost, which made the
 * pre-run estimate report a run as fitting the $1.00 target when it billed
 * over it, and so skipped the adaptation the estimate exists to trigger.
 * Change it here and both the plan and the run change together.
 */
export const CANDIDATES_PER_PHOTO_SLIDE = 6;

/** The owner's target per Instagram run: the number the pre-run plan is fitted to. */
export const TARGET_RUN_SPEND_USD = 1.0;

/** The owner's hard max per Instagram run: crossing it switches the live meter to the cheapest complete path. Never a hold. */
export const MAX_RUN_SPEND_USD = 1.5;

/**
 * Per-unit estimates the meter falls back to when a step reports no cost (or
 * under-reports), and the pre-run estimator multiplies by the plan. Keys name
 * the unit: `copyAttempt` is one Sonnet copy draft with the @12 input size;
 * `generatedImage` and `scraperExecution` are billed per unit, not per step;
 * `angle` and `brief` are Phase 1's Sonnet steps, listed now so PR-B adds
 * wiring only, never a constant.
 */
export const STEP_COST_ESTIMATES_USD = {
  /** Sonnet, ~19.5k in / 3.5k out, one draft of copy. */
  copyAttempt: 0.12,
  /** Flash image vet, ~6k in / 1.5k out — the 06 call or one rescue-tier re-vet. */
  vetCall: 0.006,
  /** Flash vision inspection, per image (05c candidate batches, 08a4 rendered slides). */
  visionInspectPerImage: 0.001,
  /** Flash relevance judge (07g), ~4k in / 0.3k out. */
  relevance: 0.002,
  /** Haiku fluency judge (07f), ~4k in / 0.3k out, non-English targets only. */
  fluency: 0.0055,
  /** Flash visual QA (08b), ~5k in / 1k out. */
  visualQa: 0.004,
  /** Flash trend scout (03c), ~12k in / 2k out. */
  scout: 0.009,
  /** Flash research extraction (04b), ~5k in / 1.5k out. */
  extraction: 0.005,
  /** `gemini-2.5-flash-image`, per generated picture. */
  generatedImage: 0.039,
  /** ScrappyCoco, per `web.search_web` execution (`scrappycoco.ts` header). Cached pulls cost nothing and must not be added. */
  scraperExecution: 0.007,
  /** Phase 1 — Sonnet angle proposal (04i), ~8k in / 0.8k out, once per revision. */
  angle: 0.036,
  /** Phase 1 — Sonnet client brief (00b2), ~25k in / 2.5k out, at most once per 30 days. */
  brief: 0.113,
} as const;

export type StepCostKey = keyof typeof STEP_COST_ESTIMATES_USD;

/**
 * What one more drafting attempt is expected to cost before it is started:
 * the copy draft, its image vet and its visual QA — the three paid steps
 * every attempt pays regardless of language or image tier. Reported on the
 * gate payload so a reviewer knows roughly what a `revise` costs.
 */
export const DRAFT_ATTEMPT_ESTIMATE_USD = STEP_COST_ESTIMATES_USD.copyAttempt + STEP_COST_ESTIMATES_USD.vetCall + STEP_COST_ESTIMATES_USD.visualQa;

/** One recorded line of spend — what it was for, what counted, and why that figure won. */
export interface SpendLine {
  label: string;
  /** The amount that counts toward the total: `max(measuredUsd ?? 0, estimateUsd)`. */
  usd: number;
  /** The vendor-reported figure when one was usable; absent when the step reported nothing, zero or a non-finite value. */
  measuredUsd?: number;
  estimateUsd: number;
  /** Which of the two the line counted at. */
  basis: "measured" | "estimate";
}

/** Sums of dollar amounts are rounded to micro-dollars so a gate payload never shows `0.30000000000000004` and a threshold comparison never turns on a float artefact. */
export function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * How the live meter wants the rest of the run spent.
 *
 * - `normal`: under the target — the plan runs as adapted.
 * - `essential-only`: the target is crossed — no more generated images, no
 *   rescue re-vets; every mandatory gate still runs.
 * - `cheapest-path`: the hard max is crossed — additionally no vision
 *   inspection and no optional visual-QA model call; gaps go text-only. The
 *   run still delivers a complete carousel, marked `degraded` with the reason.
 */
export type SpendPosture = "normal" | "essential-only" | "cheapest-path";

/**
 * The running spend for one run. Plain object, recreated on every workflow
 * invocation (a resume re-adds the lines from checkpointed step outputs);
 * never serialised as a checkpoint of its own.
 */
export class RunSpendMeter {
  private readonly entries: SpendLine[] = [];

  /**
   * Records `max(measuredUsd ?? 0, estimateUsd)` under `label`.
   *
   * A measured value that is `undefined`, `0`, negative or non-finite is
   * treated as "the vendor told us nothing" and the estimate counts — a $0
   * reading from a step that certainly ran a model is exactly the case the
   * `max` exists for. A negative estimate is clamped to zero rather than
   * thrown on: the meter must never be the thing that fails a run.
   */
  add(label: string, measuredUsd: number | undefined, estimateUsd: number): void {
    const estimate = Number.isFinite(estimateUsd) && estimateUsd > 0 ? estimateUsd : 0;
    const measured = typeof measuredUsd === "number" && Number.isFinite(measuredUsd) && measuredUsd > 0 ? measuredUsd : undefined;
    const usd = Math.max(measured ?? 0, estimate);
    this.entries.push({
      label,
      usd,
      ...(measured !== undefined ? { measuredUsd: measured } : {}),
      estimateUsd: estimate,
      basis: measured !== undefined && measured >= estimate ? "measured" : "estimate",
    });
  }

  /** Total recorded so far, rounded to micro-dollars. What the gate payload shows as `spendUsd`. */
  get totalUsd(): number {
    return roundUsd(this.entries.reduce((sum, line) => sum + line.usd, 0));
  }

  /** Every recorded line, in the order it was added — for the ledger and for a reviewer asking where the money went. */
  get lines(): ReadonlyArray<SpendLine> {
    return this.entries;
  }

  /**
   * Whether spending `nextEstimateUsd` more would stay AT OR UNDER
   * `MAX_RUN_SPEND_USD`. A pure question, for the gate payload and for the
   * optional-work decisions below — never a reason to hold (owner's rule).
   * Landing exactly on the ceiling is allowed — the owner's number is a
   * maximum, not a strict bound — so a run at $1.38 may take a $0.12 step
   * and a run at $1.39 may not.
   */
  canAfford(nextEstimateUsd: number): { ok: true } | { ok: false; reason: string } {
    const projected = roundUsd(this.totalUsd + Math.max(0, nextEstimateUsd));
    if (projected <= MAX_RUN_SPEND_USD) return { ok: true };
    return {
      ok: false,
      reason: `${formatUsd(this.totalUsd)} spent so far; the next step is estimated at ${formatUsd(nextEstimateUsd)}, which would take this run to ${formatUsd(projected)} — over the ${formatUsd(MAX_RUN_SPEND_USD)} per-run ceiling`,
    };
  }

  /** `true` once the running total exceeds the owner's target — optional work stops. */
  get crossedTarget(): boolean {
    return this.totalUsd > TARGET_RUN_SPEND_USD;
  }

  /** `true` once the running total exceeds the hard max — the rest of the run takes the cheapest complete path. */
  get crossedMax(): boolean {
    return this.totalUsd > MAX_RUN_SPEND_USD;
  }

  /** The posture the rest of the run should take, read live at every optional spend point. */
  get posture(): SpendPosture {
    if (this.crossedMax) return "cheapest-path";
    if (this.crossedTarget) return "essential-only";
    return "normal";
  }
}

/**
 * How many more images the `generate` rescue tier may request this run under
 * the widest plan. The workflow takes `min(this, plan.generatedImagesCap −
 * generatedSoFar)` and routes the rest to the text-only downgrade with the
 * reason "generation budget for this run spent". Never negative: a caller
 * that somehow over-counted must read "nothing left", not a request for −2.
 */
export function remainingGenerationBudget(generatedSoFar: number, cap: number = GENERATED_IMAGES_PER_RUN_CAP): number {
  const used = Number.isFinite(generatedSoFar) ? Math.max(0, Math.floor(generatedSoFar)) : 0;
  const ceiling = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 0;
  return Math.max(0, ceiling - used);
}

// ─────────────────────────────────────────────────────────────────────────────
// The plan
// ─────────────────────────────────────────────────────────────────────────────

/** What a run is allowed to spend on, decided BEFORE the attempt loop and never tightened into a hold mid-way. */
export interface RunBudgetPlan {
  /** Self-check attempts in total (the initial draft plus returns to step 05): 3 by default, 2 when adapted. */
  maxSelfCheckAttempts: number;
  /** Generated images allowed this run, all attempts and revisions together (≤ `GENERATED_IMAGES_PER_RUN_CAP`). */
  generatedImagesCap: number;
  /** `full` = every trend-evidence query; `reduced` = only the first, most-cacheable one (the industry query repeats run to run, so it is usually warm). */
  evidencePulls: "full" | "reduced";
  /** Whether the optional rescue tiers (scrape/generate + their re-vets) may run at all. */
  optionalRevets: boolean;
}

export const DEFAULT_RUN_BUDGET_PLAN: Readonly<RunBudgetPlan> = {
  maxSelfCheckAttempts: 3,
  generatedImagesCap: GENERATED_IMAGES_PER_RUN_CAP,
  evidencePulls: "full",
  optionalRevets: true,
};

/** What is known about the run before the first paid call — the estimator's inputs. */
export interface RunShape {
  /** A resolved non-English target language means the fluency judge runs on every attempt. */
  targetLanguage: boolean;
  /** Trend-evidence queries 03b would issue under a `full` plan (cold-cache worst case). */
  trendQueries: number;
  /**
   * Photo slides the copy is expected to produce — drives the harvest, the
   * `05c` candidate inspection (`CANDIDATES_PER_PHOTO_SLIDE` images EACH) and
   * the rescue tier. A carousel's floor is 6.
   */
  photoSlides: number;
  /**
   * Slides the carousel is expected to render, photo or typographic — what
   * `08a4` inspects, since the vision pass looks at every rendered slide and
   * not only the ones carrying a photograph. Priced at the carousel's
   * ceiling (8), because an estimate that flatters itself pulls no lever.
   */
  slideCount: number;
}

export const DEFAULT_RUN_SHAPE: Readonly<RunShape> = { targetLanguage: false, trendQueries: 4, photoSlides: 6, slideCount: 8 };

/** The estimate, itemised so the gate summary and the ledger can show where the money is expected to go. */
export interface RunCostEstimate {
  estimatedUsd: number;
  /** Raw (uncalibrated) figure the calibration ratio was applied to. */
  rawUsd: number;
  calibrationRatio: number;
  breakdown: { fixed: number; attempts: number; rescue: number; images: number };
}

/** Cold-cache, worst-case-under-the-plan cost of a run, before calibration. */
function rawEstimate(plan: RunBudgetPlan, shape: RunShape): RunCostEstimate["breakdown"] {
  const c = STEP_COST_ESTIMATES_USD;
  const queries = plan.evidencePulls === "full" ? Math.max(0, shape.trendQueries) : Math.min(1, Math.max(0, shape.trendQueries));
  const fixed = c.scout + queries * c.scraperExecution + c.scraperExecution + c.extraction;
  const photos = Math.max(0, shape.photoSlides);
  // A carousel cannot have more photo slides than slides; a shape that says
  // so is priced at the larger of the two rather than under-counting 08a4.
  const slides = Math.max(0, shape.slideCount, photos);
  const perAttempt =
    c.copyAttempt +
    c.vetCall +
    c.relevance +
    (shape.targetLanguage ? c.fluency : 0) +
    c.visualQa +
    // 05c inspects the POOL, and the pool is `CANDIDATES_PER_PHOTO_SLIDE`
    // candidates for every slide that needs a picture (plus any tier-0
    // uploads, which cost nothing to harvest and are not modelled) — not one
    // image per slide.
    photos * CANDIDATES_PER_PHOTO_SLIDE * c.visionInspectPerImage +
    // 08a4 inspects every rendered slide (capped at 12 by the step itself),
    // photo or typographic.
    Math.min(slides, 12) * c.visionInspectPerImage;
  const attempts = plan.maxSelfCheckAttempts * perAttempt;
  // Optional rescue per attempt: one scrape execution per gap (worst case half the photo slides) + two re-vets.
  const rescue = plan.optionalRevets ? plan.maxSelfCheckAttempts * (Math.ceil(photos / 2) * c.scraperExecution + 2 * c.vetCall) : 0;
  const images = plan.generatedImagesCap * c.generatedImage;
  return { fixed: roundUsd(fixed), attempts: roundUsd(attempts), rescue: roundUsd(rescue), images: roundUsd(images) };
}

/** The calibration ratio is bounded: a single wild run must not make the estimator refuse every plan, nor trust a $0 vendor reading. */
const MIN_CALIBRATION_RATIO = 0.5;
const MAX_CALIBRATION_RATIO = 3;

export function estimateRunCost(plan: RunBudgetPlan, shape: RunShape, calibrationRatio = 1): RunCostEstimate {
  const ratio = Number.isFinite(calibrationRatio) ? Math.min(MAX_CALIBRATION_RATIO, Math.max(MIN_CALIBRATION_RATIO, calibrationRatio)) : 1;
  const breakdown = rawEstimate(plan, shape);
  const rawUsd = roundUsd(breakdown.fixed + breakdown.attempts + breakdown.rescue + breakdown.images);
  return { estimatedUsd: roundUsd(rawUsd * ratio), rawUsd, calibrationRatio: ratio, breakdown };
}

// ─────────────────────────────────────────────────────────────────────────────
// Learning — per-client history persisted in the memory beliefs document
// ─────────────────────────────────────────────────────────────────────────────

/** The key under which `memory.updateBeliefs` / `memory.read({scope:"beliefs"})` carry this history. */
export const RUN_BUDGET_BELIEF_KEY = "instagramRunBudget";

/** One past run's money, as the next run's estimator reads it. */
export interface RunBudgetRunRecord {
  runId: string;
  at: string;
  estimatedUsd: number;
  actualUsd: number;
  crossedTarget: boolean;
  crossedMax: boolean;
  adaptations: number;
}

export interface RunBudgetHistory {
  version: 1;
  /** Exponentially weighted mean of actual/estimate across past runs (alpha 0.5); 1 when nothing is known. */
  ewmaRatio: number;
  /** Consecutive runs whose actual spend crossed the target, most recent last. Reset by a run under target. */
  overrunStreak: number;
  /** Consecutive runs under target. Two of them relax a tightened default plan again. */
  underTargetStreak: number;
  /** The last few runs, oldest first. */
  runs: RunBudgetRunRecord[];
}

export const EMPTY_RUN_BUDGET_HISTORY: Readonly<RunBudgetHistory> = { version: 1, ewmaRatio: 1, overrunStreak: 0, underTargetStreak: 0, runs: [] };

const HISTORY_RUNS_KEPT = 10;
const EWMA_ALPHA = 0.5;
/** Under-target runs needed before a tightened default relaxes again (owner: "relax again after two runs under target"). */
export const RELAX_AFTER_UNDER_TARGET_RUNS = 2;

/** Reads the history back out of a beliefs document, tolerating anything a past version or a hand edit left there. */
export function readBudgetHistory(beliefs: unknown): RunBudgetHistory {
  const raw = beliefs !== null && typeof beliefs === "object" ? (beliefs as Record<string, unknown>)[RUN_BUDGET_BELIEF_KEY] : undefined;
  if (raw === null || typeof raw !== "object") return { ...EMPTY_RUN_BUDGET_HISTORY, runs: [] };
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const runs = Array.isArray(r["runs"])
    ? (r["runs"] as unknown[]).flatMap((entry): RunBudgetRunRecord[] => {
        if (entry === null || typeof entry !== "object") return [];
        const e = entry as Record<string, unknown>;
        if (typeof e["runId"] !== "string") return [];
        return [
          {
            runId: e["runId"],
            at: typeof e["at"] === "string" ? e["at"] : "",
            estimatedUsd: num(e["estimatedUsd"], 0),
            actualUsd: num(e["actualUsd"], 0),
            crossedTarget: e["crossedTarget"] === true,
            crossedMax: e["crossedMax"] === true,
            adaptations: Math.max(0, Math.floor(num(e["adaptations"], 0))),
          },
        ];
      })
    : [];
  return {
    version: 1,
    ewmaRatio: Math.min(MAX_CALIBRATION_RATIO, Math.max(MIN_CALIBRATION_RATIO, num(r["ewmaRatio"], 1))),
    overrunStreak: Math.max(0, Math.floor(num(r["overrunStreak"], 0))),
    underTargetStreak: Math.max(0, Math.floor(num(r["underTargetStreak"], 0))),
    runs: runs.slice(-HISTORY_RUNS_KEPT),
  };
}

/** The history after one more finished run — what 09b writes back. Pure; idempotent on `runId` (a replayed 09b does not double-count). */
export function recordRunInHistory(history: RunBudgetHistory, run: RunBudgetRunRecord): RunBudgetHistory {
  if (history.runs.some((r) => r.runId === run.runId)) return history;
  const ratio = run.estimatedUsd > 0 ? run.actualUsd / run.estimatedUsd : 1;
  const bounded = Math.min(MAX_CALIBRATION_RATIO, Math.max(MIN_CALIBRATION_RATIO, ratio));
  const ewmaRatio = roundUsd(history.runs.length === 0 ? bounded : history.ewmaRatio * (1 - EWMA_ALPHA) + bounded * EWMA_ALPHA);
  // An overrun is remembered until RELAX_AFTER_UNDER_TARGET_RUNS runs have
  // landed under target (owner: "tighter default plan after an overrun; relax
  // again after two runs under target") — one good run does not erase it.
  const underTargetStreak = run.crossedTarget ? 0 : history.underTargetStreak + 1;
  const overrunStreak = run.crossedTarget ? history.overrunStreak + 1 : underTargetStreak >= RELAX_AFTER_UNDER_TARGET_RUNS ? 0 : history.overrunStreak;
  return {
    version: 1,
    ewmaRatio,
    overrunStreak,
    underTargetStreak,
    runs: [...history.runs, run].slice(-HISTORY_RUNS_KEPT),
  };
}

/** How the next run should start: `tight` after an overrun until two runs land under target, `default` otherwise. */
export function calibrationPosture(history: RunBudgetHistory): "default" | "tight" {
  return history.overrunStreak > 0 && history.underTargetStreak < RELAX_AFTER_UNDER_TARGET_RUNS ? "tight" : "default";
}

// ─────────────────────────────────────────────────────────────────────────────
// Planning — fit the plan to the target, in the owner's order, never a hold
// ─────────────────────────────────────────────────────────────────────────────

export interface RunBudgetDecision {
  plan: RunBudgetPlan;
  estimate: RunCostEstimate;
  /** The estimate BEFORE any lever was pulled — what the reviewer compares the adapted figure against. */
  initialEstimateUsd: number;
  targetUsd: number;
  maxUsd: number;
  calibration: { ratio: number; posture: "default" | "tight"; pastRuns: number };
  /** Every lever pulled, in order, in the words the reviewer reads. Empty when the full plan fits. */
  adaptations: string[];
  /** The one-line run note ("budget: estimate $1.21 > $1.00 → images capped at 4, one return to step 05 instead of two"). */
  note: string;
}

/** The image caps the first lever steps through: stock/tier-0 first, then fewer generated pictures, then none. */
const IMAGE_CAP_STEPS = [4, 2, 0] as const;

/**
 * Decide the plan for this run. Starts from the default plan (or, after an
 * overrun, a tightened one: images already capped at 4) and pulls the levers
 * in the owner's order until the calibrated estimate fits the target. A plan
 * that still does not fit after every lever is returned as-is with the note
 * saying so — the run proceeds; the live meter takes it from there.
 */
export function planRunBudget(shape: RunShape, history: RunBudgetHistory = EMPTY_RUN_BUDGET_HISTORY): RunBudgetDecision {
  const posture = calibrationPosture(history);
  const ratio = history.ewmaRatio;
  const adaptations: string[] = [];
  let plan: RunBudgetPlan = { ...DEFAULT_RUN_BUDGET_PLAN };
  if (posture === "tight") {
    plan = { ...plan, generatedImagesCap: IMAGE_CAP_STEPS[0] };
    adaptations.push(`started tight after ${history.overrunStreak} run(s) over target: images capped at ${IMAGE_CAP_STEPS[0]}`);
  }
  const initialEstimate = estimateRunCost(plan, shape, ratio);
  let estimate = initialEstimate;
  const fits = () => estimate.estimatedUsd <= TARGET_RUN_SPEND_USD;

  // 1. Cap generated images (prefer tier-0/stock, then text-only).
  for (const cap of IMAGE_CAP_STEPS) {
    if (fits() || plan.generatedImagesCap <= cap) continue;
    plan = { ...plan, generatedImagesCap: cap };
    estimate = estimateRunCost(plan, shape, ratio);
    adaptations.push(cap === 0 ? "no generated images (stock or text-only)" : `images capped at ${cap}`);
  }
  // 2. Optional evidence pulls down to the one most-cacheable query.
  if (!fits() && plan.evidencePulls === "full") {
    plan = { ...plan, evidencePulls: "reduced" };
    estimate = estimateRunCost(plan, shape, ratio);
    adaptations.push("trend evidence reduced to the one cached industry query");
  }
  // 3. Allowed self-check returns 2 -> 1.
  if (!fits() && plan.maxSelfCheckAttempts > 2) {
    plan = { ...plan, maxSelfCheckAttempts: 2 };
    estimate = estimateRunCost(plan, shape, ratio);
    adaptations.push("one return to step 05 instead of two");
  }
  // 4. Optional re-vets off.
  if (!fits() && plan.optionalRevets) {
    plan = { ...plan, optionalRevets: false };
    estimate = estimateRunCost(plan, shape, ratio);
    adaptations.push("optional rescue re-vets skipped");
  }

  const note = fits()
    ? adaptations.length === 0
      ? `budget: estimate ${formatUsd(estimate.estimatedUsd)} ≤ ${formatUsd(TARGET_RUN_SPEND_USD)} → full plan`
      : `budget: estimate ${formatUsd(initialEstimate.estimatedUsd)} > ${formatUsd(TARGET_RUN_SPEND_USD)} → ${adaptations.join(", ")} (now ${formatUsd(estimate.estimatedUsd)})`
    : `budget: estimate ${formatUsd(initialEstimate.estimatedUsd)} > ${formatUsd(TARGET_RUN_SPEND_USD)} → ${adaptations.join(", ")}; still ${formatUsd(estimate.estimatedUsd)} on the tightest plan — running anyway, the live meter finishes on the cheapest path if needed`;

  return {
    plan,
    estimate,
    initialEstimateUsd: initialEstimate.estimatedUsd,
    targetUsd: TARGET_RUN_SPEND_USD,
    maxUsd: MAX_RUN_SPEND_USD,
    calibration: { ratio: estimate.calibrationRatio, posture, pastRuns: history.runs.length },
    adaptations,
    note,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The live notes and the summary the reviewer / ledger see
// ─────────────────────────────────────────────────────────────────────────────

/** The note recorded the moment the meter crosses the target. */
export function targetCrossedNote(meter: RunSpendMeter, at: string): string {
  return `budget: ${formatUsd(meter.totalUsd)} spent at ${at}, over the ${formatUsd(TARGET_RUN_SPEND_USD)} target — optional work stopped (no more generated images, no rescue re-vets); every mandatory gate still runs`;
}

/** The note recorded the moment the meter crosses the hard max. */
export function maxCrossedNote(meter: RunSpendMeter, at: string): string {
  return `budget: ${formatUsd(meter.totalUsd)} spent at ${at}, over the ${formatUsd(MAX_RUN_SPEND_USD)} hard max — finishing on the cheapest complete path (text-only for any image gap, no vision inspection, no visual-QA model call) and delivering; the deliverable is marked degraded, never held`;
}

/** Estimate vs actual, for the gate summary, the deliverable and the ledger. */
export interface RunBudgetSummary {
  estimatedUsd: number;
  actualUsd: number;
  targetUsd: number;
  maxUsd: number;
  crossedTarget: boolean;
  crossedMax: boolean;
  posture: SpendPosture;
  plan: RunBudgetPlan;
  adaptations: string[];
  notes: string[];
  lines: SpendLine[];
}

export function summarizeRunBudget(decision: RunBudgetDecision, meter: RunSpendMeter, notes: readonly string[]): RunBudgetSummary {
  return {
    estimatedUsd: decision.estimate.estimatedUsd,
    actualUsd: meter.totalUsd,
    targetUsd: decision.targetUsd,
    maxUsd: decision.maxUsd,
    crossedTarget: meter.crossedTarget,
    crossedMax: meter.crossedMax,
    posture: meter.posture,
    plan: decision.plan,
    adaptations: [...decision.adaptations],
    notes: [...notes],
    lines: [...meter.lines],
  };
}

/** The one-line "estimate vs actual" the gate summary shows. */
export function estimateVsActualLine(summary: Pick<RunBudgetSummary, "estimatedUsd" | "actualUsd" | "crossedTarget" | "crossedMax">): string {
  const verdict = summary.crossedMax ? "over the hard max" : summary.crossedTarget ? "over target" : "under target";
  return `budget: estimated ${formatUsd(summary.estimatedUsd)}, actual ${formatUsd(summary.actualUsd)} (${verdict})`;
}
