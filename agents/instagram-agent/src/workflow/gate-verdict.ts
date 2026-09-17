import type { ImageryShortfall } from "./imagery-floor.js";
import { formatUsd, roundUsd, type SpendLine } from "./run-budget.js";
import type { ImageSelection, VisualQaFinding } from "./types.js";

/**
 * Phase 5.5 (spec §6 G1) — THE ONE SCREEN A REVIEWER READS.
 *
 * ## The charge
 *
 * On 2026-09-16 the human gate approved every one of the three prep runs. One
 * of them shipped a cover device reading `2 / B B`; one shipped with no
 * hashtags and no alt text at all; one shipped its FIRST draft twice because
 * the redraft died at the output ceiling, re-judged the same words, failed the
 * same gate with the same sentence, and was marked `degraded`. None of that was
 * hidden: every fact was somewhere in the `09a` payload. The payload carries
 * forty blocks and no summary, so a reviewer approving eight posts a day read
 * the pixels, saw a competent carousel, and clicked approve.
 *
 * **Nothing in this module is new information.** There is not one field here
 * that the run did not already compute. It is the existing facts RANKED — the
 * eight that decide whether a post should ship — put first in the payload, with
 * one line above them, because a block that is fortieth is a block nobody reads.
 *
 * ## Why a line and not only a block
 *
 * `summary` is built from the same eight sections and is the thing the review
 * surface can show in a list. Every one of the three runs reads badly in it:
 *
 * - karoslabs: `attempt 2 of 3 shipped (1 draft failed) · 0 pictures of 3 wanted ·
 *   3 slides degraded · $1.39 billed / $1.00 target (over the $1.60 max)`
 * - deel: `attempt 1 of 3 shipped (2 drafts failed, no redraft landed) ·
 *   packaging FAILED (no hashtags) · $0.42 billed / $1.00 target`
 * - geektime: `visual QA FAILED 3 rules · $1.60 billed / $1.00 target (over the $1.60 max)`
 *
 * That is the point, and it is the whole design test: a run the owner would not
 * have published must not read as a clean line.
 *
 * ## Pure, and deliberately so
 *
 * `buildGateVerdict` takes ALREADY-COMPUTED inputs and returns a value. It
 * reads no store, calls no model and knows nothing about the workflow's
 * variables, which is what lets the three 2026-09-16 runs be replayed against
 * it as fixtures in `gate-verdict.test.ts` — the only honest way to check that
 * a summary would have caught a day that already happened. It also makes the
 * workflow edit one call and one payload key.
 *
 * ## Cost
 *
 * $0. Every number here was already paid for.
 */

// ─────────────────────────────────────────────────────────────────────────
// Vocabulary
// ─────────────────────────────────────────────────────────────────────────

/**
 * How a model step failed, in the ENGINE'S OWN WORDS.
 *
 * `AgentExecutionStatusSchema` (`packages/core/src/types/agent-step.ts:170`)
 * already names these three, and the spec's `output_invalid` is a fourth name
 * for what the engine calls `content_fail`. A gate payload that invents a
 * vocabulary for a status the run already recorded is a payload a reader has to
 * translate back before they can grep the trace for it.
 */
export const GATE_STEP_FAILURE_STATUSES = ["tooling_error", "budget_exceeded", "content_fail"] as const;
export type GateStepFailureStatus = (typeof GATE_STEP_FAILURE_STATUSES)[number];

/** One model step that did not complete, and what it burned doing it. */
export interface GateStepFailure {
  step: string;
  status: GateStepFailureStatus;
  /** The engine's own error text, trimmed to one readable line. */
  why: string;
  /**
   * What the failed call actually cost.
   *
   * THE MISSING FACT of 2026-09-16: seventeen truncated calls across six runs
   * recorded `$0`, so five of six copy attempts died for free as far as
   * anything in the system could tell — on runs whose budget ladder was cutting
   * the pictures out of the post to stay under a target it could not see. W1-A
   * fixed the booking; this is where the number arrives in front of a human.
   */
  usdBurned: number;
}

/** What the run spent, against what it was allowed, and what that cost the post. */
export interface GateSpendVerdict {
  /** `meter.totalUsd` — `max(measured, estimate)` per line, exactly as today. */
  meteredUsd: number;
  /** Every step's real reported cost, truncations included — the vendor figure where there is one, the per-unit price where there is not. */
  billedUsd: number;
  /**
   * How much of `billedUsd` is a per-unit estimate rather than a vendor figure
   * (scraper executions, generated images) — so "billed" is not read as "every
   * dollar here came back from an invoice".
   */
  estimatedShareUsd: number;
  targetUsd: number;
  maxUsd: number;
  /** Every lever the budget plan pulled, in `summarizeRunBudget`'s own words. */
  adaptations: string[];
  /** Floors a lever reached and could not cross, e.g. "generated images held at the floor of 2". */
  floorsHeld: string[];
  /** Work the plan did not buy, with the reason the step recorded when it declined. */
  skipped: Array<{ step: string; reason: string }>;
}

/** One drafting attempt, as the attempt loop left it. */
export interface GateDraftAttempt {
  attempt: number;
  status: GateStepFailureStatus;
  reason: string;
  usdBurned: number;
}

/**
 * WHICH DRAFT THE READER IS LOOKING AT.
 *
 * `shippedAttempt` alone is not enough: on 2026-09-16 karoslabs shipped attempt
 * 2 of 3 and deel shipped attempt 1 of 3, and both were reported identically as
 * "3 attempts". `redraftsThatActuallyHappened` is the number that would have
 * made the day obvious — karoslabs 1, deel 0, geektime 0. A run that judged a
 * draft, refused it, and then re-judged THE SAME WORDS has bought nothing with
 * its second and third attempts, and the reviewer is the only one who can act
 * on that.
 */
export interface GateDraftProvenance {
  shippedAttempt: number;
  attemptsSpent: number;
  attemptsThatFailed: GateDraftAttempt[];
  redraftsThatActuallyHappened: number;
}

/**
 * The visual judge's answer. Absent fields mean NOT JUDGED, never "fine":
 * `08b` fails open, and a reviewer has to be able to tell an outage from a pass
 * (the rule `grounding.relevance` and `value.axes` already follow).
 */
export interface GateVisualQa {
  pass?: boolean;
  /** §4.8's post-level question: would you publish this for a paying client? Absent until that judge is armed. */
  publishable?: boolean;
  findings: VisualQaFinding[];
}

/**
 * Did the post arrive whole? `08c`'s result, in three words a reviewer can act
 * on.
 *
 * A packager that never came back at all (thepitchbydeel, 2026-09-16:
 * `08c-package-post` resolved `budget_exceeded` and returned nothing) is
 * `failed`, not a fourth state of its own: the consequence a reviewer acts on
 * is identical — no hashtags, no alt text, no first comment — and `reason` is
 * where the difference belongs.
 */
export interface GatePackaging {
  status: "ok" | "retried" | "failed";
  hashtags: number;
  altTexts: number;
  firstComment: boolean;
  reason?: string;
}

/** What the post asked for in pictures and what it got. */
export interface GateImagery {
  /** Slides whose scene brief asked for a photograph. */
  wanted: number;
  /** Slides that shipped one. */
  shipped: number;
  /** Of those, how many were generated rather than retrieved. */
  generated: number;
  shortfall: ImageryShortfall[];
  /** One row per shipped picture: which slide, which file, under which licence line. */
  provenance: Array<{ slide: number; url: string; licence: string }>;
}

/** One slide that could not render the archetype it was written for. */
export interface GateDegradeMarker {
  slide: number;
  from: string;
  to: string;
  reason: string;
}

/** The brand mark the owner asked for on every client's slides, and why it is not there when it is not. */
export interface GateBrandAsset {
  present: boolean;
  corner?: string;
  reason?: string;
  remedy?: string;
}

/**
 * The block, in reading order. Field order is not cosmetic: `summary` is first
 * because it is the thing a reviewer reads, and a JSON viewer renders the keys
 * in the order they were written.
 */
export interface GateVerdict {
  /** The one line. Also carried inside the block so the deliverable and the ledger quote the same sentence. */
  summary: string;
  spend: GateSpendVerdict;
  draftProvenance: GateDraftProvenance;
  stepFailures: GateStepFailure[];
  visualQa: GateVisualQa;
  packaging: GatePackaging;
  imagery: GateImagery;
  degradeMarkers: GateDegradeMarker[];
  brandAsset: GateBrandAsset;
}

// ─────────────────────────────────────────────────────────────────────────
// The input: facts the run already has
// ─────────────────────────────────────────────────────────────────────────

/**
 * One attempt as the loop observed it. `producedDraft` is the only thing that
 * distinguishes an attempt that cost money and gave nothing back from one that
 * handed the run a draft.
 */
export interface GateAttemptRecord {
  attempt: number;
  producedDraft: boolean;
  /** Absent on a completed attempt. */
  status?: GateStepFailureStatus;
  /** The engine's error text, or the gate sentence that sent the draft back. */
  reason?: string;
  usdBurned: number;
  /**
   * A cheap fingerprint of the draft this attempt produced (any stable digest
   * of the caption plus the slides). Supplied, two consecutive attempts with
   * the SAME digest count as no redraft at all — the deel case, where attempts
   * 1 and 3 failed the identical gate on the identical words. Absent, a second
   * completed draft is counted as a redraft rather than assumed inert.
   */
  draftDigest?: string;
}

export interface GateVerdictInput {
  /** `summarizeRunBudget(budgetDecision, meter, budgetNotes)`. */
  budget: {
    actualUsd: number;
    targetUsd: number;
    maxUsd: number;
    adaptations: readonly string[];
    lines: readonly SpendLine[];
  };
  /**
   * The real bill, when the caller has a truer figure than the meter's lines.
   *
   * Omitted — the normal case — it is derived from `budget.lines` as
   * `Σ (measuredUsd ?? estimateUsd)`: the vendor's own figure for every line one
   * exists for, and the per-unit price for the lines no vendor prices back
   * (scraper executions, generated images).
   *
   * It is NOT `wf.costSoFarUsd()`, which sums the durable store's per-step
   * `costUsd` and therefore sees model steps only — every scraper execution a
   * `wf.step.code` paid for is invisible to it.
   */
  billedUsd?: number;
  floorsHeld?: readonly string[];
  skipped?: ReadonlyArray<{ step: string; reason: string }>;
  shippedAttempt: number;
  attempts: readonly GateAttemptRecord[];
  /** Failures OUTSIDE the drafting loop (research extraction, packaging, the setup agents). Draft failures are derived from `attempts`. */
  stepFailures?: readonly GateStepFailure[];
  visualQa?: { pass?: boolean; publishable?: boolean; findings?: readonly VisualQaFinding[] };
  /** `draft.post`, as `08c` left it. Absent means the packager never came back. */
  post?: {
    hashtags: readonly string[];
    altText: ReadonlyArray<{ n: number; alt: string }>;
    firstComment: { text: string };
    status: "complete" | "partial" | "absent";
    reason?: string;
  };
  /** True when `08c-package-post-retry` ran, whatever it returned. */
  packagingRetried?: boolean;
  imagery: {
    /** Slides whose scene brief asked for a picture (`SceneSource !== "none"`). */
    wanted: number;
    /** How many of the shipped pictures were generated rather than retrieved. */
    generated: number;
    shortfall?: readonly ImageryShortfall[];
    selections: ReadonlyArray<Pick<ImageSelection, "n" | "imagePath" | "license">>;
  };
  degradeMarkers?: readonly GateDegradeMarker[];
  brandAsset: GateBrandAsset;
}

// ─────────────────────────────────────────────────────────────────────────
// The builder
// ─────────────────────────────────────────────────────────────────────────

/**
 * A stable fingerprint of one draft, for `GateAttemptRecord.draftDigest`.
 *
 * Offered here rather than left to the caller so every call site computes it the
 * same way and `redraftsThatActuallyHappened` means one thing. FNV-1a over the
 * caption and every slide's headline and body: no crypto import, no I/O, and
 * collisions do not matter — the only question asked of it is "are these two
 * drafts the same words", and the cost of a collision is one redraft reported as
 * none on a gate payload that also lists the attempts.
 *
 * Whitespace is normalised, because a writer that re-emitted the identical draft
 * with a different line wrap has still said nothing new.
 */
export function draftDigestFor(caption: string, slides: ReadonlyArray<{ headline: string; body: string }>): string {
  const text = [caption, ...slides.flatMap((s) => [s.headline, s.body])].join("\n").replace(/\s+/gu, " ").trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** One readable line out of an engine error that may carry a stack, a JSON body or a paragraph. */
function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3).trimEnd()}...`;
}

/**
 * How much of `billedUsd` never came from a vendor.
 *
 * A `SpendLine` carries `measuredUsd` only when the router reported a usable
 * figure; a scraper execution and a generated image are priced per unit and
 * booked at their estimate. Both are real money, so both belong in `billedUsd`
 * — but "billed" would be a lie if it did not also say how much of itself is
 * arithmetic.
 */
function estimatedShare(lines: readonly SpendLine[]): number {
  return roundUsd(lines.filter((l) => l.measuredUsd === undefined).reduce((sum, l) => sum + l.estimateUsd, 0));
}

/**
 * The real bill out of the meter's own lines.
 *
 * `meter.totalUsd` books `max(measured, estimate)` per line, which is the right
 * number to STEER a budget with (it never under-counts a step that has not
 * reported yet) and the wrong one to show a human as "what this cost": a step
 * that really cost $0.02 against a $0.05 estimate is booked at $0.05. This is
 * what the vendors actually reported, plus the per-unit price of the lines they
 * never priced back.
 *
 * Since W1-A it includes the truncated turns, which is the whole point: before
 * that fix, five of six copy attempts across the 2026-09-16 runs reported
 * nothing at all and neither figure could see them.
 */
function billedFromLines(lines: readonly SpendLine[]): number {
  return roundUsd(lines.reduce((sum, l) => sum + (l.measuredUsd ?? l.estimateUsd), 0));
}

/**
 * Did a later draft say anything a previous one did not?
 *
 * Counted over attempts that PRODUCED a draft, in attempt order. The first
 * produced draft is the draft, not a redraft. A later one counts only when its
 * digest differs from the previous produced draft's — or when either digest is
 * unknown, because an unknown digest is not evidence of sameness.
 */
function countRealRedrafts(attempts: readonly GateAttemptRecord[]): number {
  const produced = [...attempts].filter((a) => a.producedDraft).sort((a, b) => a.attempt - b.attempt);
  let redrafts = 0;
  for (let i = 1; i < produced.length; i++) {
    const prev = produced[i - 1]!.draftDigest;
    const next = produced[i]!.draftDigest;
    if (prev !== undefined && next !== undefined && prev === next) continue;
    redrafts++;
  }
  return redrafts;
}

/** `08c`'s four states, from the package the run actually has in hand. */
function packagingFrom(input: GateVerdictInput): GatePackaging {
  const pkg = input.post;
  if (pkg === undefined) {
    return {
      status: "failed",
      hashtags: 0,
      altTexts: 0,
      firstComment: false,
      reason: "the packager produced no post at all, so this carousel ships with no hashtags, no alt text and no first comment",
    };
  }
  const hashtags = pkg.hashtags.length;
  const altTexts = pkg.altText.length;
  const firstComment = pkg.firstComment.text.trim().length > 0;
  // `failed` is about what the READER gets, not about which step errored: a
  // package that came back `complete` with zero hashtags has failed at the only
  // thing a reviewer can check, and a `partial` one with its tags and its alt
  // text intact has not.
  const status: GatePackaging["status"] =
    hashtags === 0 || altTexts === 0 ? "failed" : input.packagingRetried === true ? "retried" : pkg.status === "complete" ? "ok" : "retried";
  const shortfalls = [hashtags === 0 ? "no hashtags" : undefined, altTexts === 0 ? "no alt text" : undefined].filter((s): s is string => s !== undefined);
  const reason = pkg.reason ?? (shortfalls.length > 0 ? `the post shipped with ${shortfalls.join(" and ")}` : undefined);
  return { status, hashtags, altTexts, firstComment, ...(reason !== undefined ? { reason } : {}) };
}

/**
 * Builds the verdict. Pure: same inputs, same block, same line.
 *
 * Every array is copied rather than aliased — this value is written onto a gate
 * payload and a persisted deliverable, and a payload that shares an array with
 * the live meter is a payload that changes after it was shown to a human.
 */
export function buildGateVerdict(input: GateVerdictInput): GateVerdict {
  const attempts = [...input.attempts].sort((a, b) => a.attempt - b.attempt);
  const attemptsThatFailed: GateDraftAttempt[] = attempts
    .filter((a) => !a.producedDraft)
    .map((a) => ({
      attempt: a.attempt,
      status: a.status ?? "tooling_error",
      reason: oneLine(a.reason ?? "the attempt produced no draft and recorded no reason"),
      usdBurned: roundUsd(a.usdBurned),
    }));

  // The drafting loop's own failures are step failures too, and listing them in
  // both places is deliberate: `draftProvenance` answers "which draft am I
  // looking at", `stepFailures` answers "what did this run pay for and not
  // get", and a reviewer scanning the second must not have to reconstruct the
  // copy step from the first.
  const draftFailures: GateStepFailure[] = attemptsThatFailed.map((a) => ({
    step: `05-write-copy-attempt-${a.attempt}`,
    status: a.status,
    why: a.reason,
    usdBurned: a.usdBurned,
  }));
  const stepFailures = [...draftFailures, ...(input.stepFailures ?? []).map((f) => ({ ...f, why: oneLine(f.why), usdBurned: roundUsd(f.usdBurned) }))];

  const shortfall = [...(input.imagery.shortfall ?? [])];
  const provenance = input.imagery.selections
    .filter((s): s is typeof s & { imagePath: string } => typeof s.imagePath === "string" && s.imagePath.length > 0)
    .map((s) => ({ slide: s.n, url: s.imagePath, licence: s.license }));

  const verdict: GateVerdict = {
    // Overwritten immediately below. Declared here so the key is FIRST in the
    // serialised object: a JSON viewer renders insertion order, and a summary
    // under eight blocks is a summary nobody reaches.
    summary: "",
    spend: {
      meteredUsd: roundUsd(input.budget.actualUsd),
      billedUsd: input.billedUsd !== undefined ? roundUsd(input.billedUsd) : billedFromLines(input.budget.lines),
      estimatedShareUsd: estimatedShare(input.budget.lines),
      targetUsd: input.budget.targetUsd,
      maxUsd: input.budget.maxUsd,
      adaptations: [...input.budget.adaptations],
      floorsHeld: [...(input.floorsHeld ?? [])],
      skipped: [...(input.skipped ?? [])],
    },
    draftProvenance: {
      shippedAttempt: input.shippedAttempt,
      attemptsSpent: attempts.length,
      attemptsThatFailed,
      redraftsThatActuallyHappened: countRealRedrafts(attempts),
    },
    stepFailures,
    visualQa: {
      ...(input.visualQa?.pass !== undefined ? { pass: input.visualQa.pass } : {}),
      ...(input.visualQa?.publishable !== undefined ? { publishable: input.visualQa.publishable } : {}),
      findings: [...(input.visualQa?.findings ?? [])],
    },
    packaging: packagingFrom(input),
    imagery: {
      wanted: input.imagery.wanted,
      shipped: provenance.length,
      generated: input.imagery.generated,
      shortfall,
      provenance,
    },
    degradeMarkers: [...(input.degradeMarkers ?? [])],
    brandAsset: { ...input.brandAsset },
  };
  verdict.summary = gateVerdictLine(verdict);
  return verdict;
}

// ─────────────────────────────────────────────────────────────────────────
// The line
// ─────────────────────────────────────────────────────────────────────────

/** The separator the spec's own example uses. */
const SEGMENT_JOIN = " · ";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The one line, built from the block and from nothing else.
 *
 * Two rules decide what is in it.
 *
 * 1. **A segment that carries no bad news is short or absent.** A reviewer
 *    scanning a list needs the exceptions to be the thing their eye lands on,
 *    so "0 slides degraded" is not printed at all and "packaging ok" is three
 *    characters of reassurance rather than a clause.
 * 2. **The bad news is in capitals.** FAILED, NOT PUBLISHABLE, NO LOGO. This is
 *    the one typographic trick in the codebase and it is here because the
 *    failure mode being fixed is a human reading past the truth, not the truth
 *    being absent.
 *
 * Exported separately so a caller can re-render the line from a persisted
 * verdict without rebuilding it.
 */
export function gateVerdictLine(verdict: GateVerdict): string {
  const segments: string[] = [];

  // 1. Which draft is this, and did any later attempt buy anything?
  const draft = verdict.draftProvenance;
  const failed = draft.attemptsThatFailed.length;
  const attemptNotes: string[] = [];
  if (failed > 0) attemptNotes.push(`${plural(failed, "draft")} failed`);
  // Only interesting once the run has spent more than one attempt: a run that
  // shipped its only draft has not failed to redraft, it simply did not need to.
  if (draft.attemptsSpent > 1 && draft.redraftsThatActuallyHappened === 0) attemptNotes.push("NO REDRAFT LANDED");
  segments.push(
    `attempt ${draft.shippedAttempt} of ${draft.attemptsSpent} shipped${attemptNotes.length > 0 ? ` (${attemptNotes.join(", ")})` : ""}`,
  );

  // 2. The owner's loudest complaint, in the second segment.
  const img = verdict.imagery;
  const generated = img.generated > 0 ? ` (${img.generated} generated)` : "";
  segments.push(
    img.shipped < img.wanted
      ? `${img.shipped} of ${plural(img.wanted, "picture")} WANTED${generated}${img.shortfall.length > 0 ? `, ${plural(img.shortfall.length, "slide")} lost one` : ""}`
      : `${plural(img.shipped, "picture")}${generated}`,
  );

  // 3. The only step that is asked whether the post is any good.
  const qa = verdict.visualQa;
  const failing = qa.findings.filter((f) => !f.passed).length;
  if (qa.pass === undefined) segments.push("visual QA NOT JUDGED");
  else if (!qa.pass) segments.push(`visual QA FAILED ${plural(failing, "rule")}`);
  else segments.push("visual QA passed");
  if (qa.publishable === false) segments.push("judged NOT PUBLISHABLE");

  // 4. Did the post arrive whole?
  const pkg = verdict.packaging;
  if (pkg.status === "failed") {
    const missing = [pkg.hashtags === 0 ? "no hashtags" : undefined, pkg.altTexts === 0 ? "no alt text" : undefined].filter((s): s is string => s !== undefined);
    segments.push(`packaging FAILED${missing.length > 0 ? ` (${missing.join(", ")})` : ""}`);
  } else if (pkg.status === "retried") segments.push("packaging retried");
  else segments.push("packaging ok");

  // 5. Slides that could not be the thing they were written to be.
  if (verdict.degradeMarkers.length > 0) segments.push(`${plural(verdict.degradeMarkers.length, "slide")} DEGRADED`);

  // 6. Money spent on steps that gave nothing back. Draft failures are already
  //    in segment 1, so this names only what is left — and it names the dollars,
  //    because $0 is what these lines used to say.
  const otherFailures = verdict.stepFailures.filter((f) => !/^05-write-copy-attempt-/u.test(f.step));
  if (otherFailures.length > 0) {
    const burned = roundUsd(otherFailures.reduce((sum, f) => sum + f.usdBurned, 0));
    segments.push(`${plural(otherFailures.length, "step")} FAILED (${formatUsd(burned)} burned)`);
  }

  // 7. The mark the owner explicitly asked to see on every client's slides.
  if (!verdict.brandAsset.present) segments.push("NO LOGO");

  // 8. The number the owner asked for, last, where a total belongs.
  const spend = verdict.spend;
  const over = spend.billedUsd > spend.maxUsd ? ` (OVER the ${formatUsd(spend.maxUsd)} max)` : "";
  segments.push(`${formatUsd(spend.billedUsd)} billed / ${formatUsd(spend.targetUsd)} target${over}`);

  return segments.join(SEGMENT_JOIN);
}
