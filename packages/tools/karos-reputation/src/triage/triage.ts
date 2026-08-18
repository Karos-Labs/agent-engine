import { parseTs } from "./timestamps.js";
import { keywordHits } from "./keywords.js";
import { pyRound } from "./round.js";
import { crisisCutoff, detectBursts, detectRatingDip, triggerSignature } from "./bursts.js";
import { proposedAction } from "./proposed-action.js";
import { compareReviewIds } from "./sort.js";
import type { CrisisTrigger, Review, TriageConfig, TriagePayload, TriageResult, TriageResultRow } from "./types.js";

/**
 * Python's `str(float)` renders a whole-valued float with a trailing `.0`
 * (`str(0.0) == "0.0"`), while a JS template literal collapses `0.0` to the
 * integer string `"0"`. `triage.py`'s `"recency_decay:%s" % mult` embeds
 * exactly Python's float formatting into the signal string, so this must be
 * replicated or a signal like `"recency_decay:0.0"` silently becomes
 * `"recency_decay:0"` and diverges from the golden fixtures.
 */
function formatPyFloat(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

/** `recency_multiplier` (triage.py): full value at/under `full`, zero at/over `zero`, linear between. */
function recencyMultiplier(ageDays: number, decayCfg: { full_value_within_days: number; zero_value_after_days: number }): number {
  const full = decayCfg.full_value_within_days;
  const zero = decayCfg.zero_value_after_days;
  if (ageDays <= full) return 1.0;
  if (ageDays >= zero) return 0.0;
  return pyRound((zero - ageDays) / (zero - full), 4);
}

/**
 * `triage` (triage.py) — the deterministic routing engine. RFC-08's
 * invariant: the model extracts, arithmetic routes. This function never
 * calls a model and never touches the network; every signal it reads either
 * comes off the record's own fields or off the pre-computed, cached
 * `annotations` block.
 *
 * Ordering rule (RFC-08 task spec, `references/scoring.md` §3): burst
 * membership is computed across the WHOLE review envelope before any
 * individual review is scored — scoring one at a time cannot see a burst,
 * and a burst discovered halfway through the batch would score its first
 * members differently from its last.
 */
export function triage(payload: TriagePayload, cfg: TriageConfig): TriageResult {
  const now = parseTs(payload.now);
  const reviews = payload.reviews;
  const responded = new Set(payload.already_responded_ids);
  const seen = new Set(payload.seen_review_ids);
  const alerted = new Set(payload.alerted_crisis_signatures);
  const platformOf = new Map(reviews.map((r) => [r.review_id, r.platform]));
  const burstMembers = detectBursts(reviews, cfg, now);

  const valCfg = cfg.value_signals;
  const urgCfg = cfg.urgency_signals;
  const routesCfg = cfg.routes;
  const results: TriageResultRow[] = [];
  const summary = { respond: 0, flag: 0, no_action: 0, unavailable: 0 };
  const keywordFlagged: Array<{ review_id: string; keywords: string[] }> = [];

  // Code-point order, matching `sorted(reviews, key=...)` in triage.py — NOT
  // `localeCompare` (see `sort.ts` for why the two genuinely disagree).
  const sortedReviews = [...reviews].sort((a, b) => compareReviewIds(a.review_id, b.review_id));

  for (const review of sortedReviews) {
    const rid = review.review_id;

    if (review.capture_tier === "UNAVAILABLE") {
      summary.unavailable += 1;
      results.push({
        review_id: rid,
        route: "NO_ACTION",
        value_score: 0,
        urgency_score: 0,
        draft_attached: false,
        signals: ["capture_unavailable"],
        crisis_hit: false,
        reason: "capture leg unavailable this run; tombstone only",
      });
      continue;
    }

    const ann = review.annotations;
    const text = review.text ?? "";
    const signals: string[] = [];

    const hits = keywordHits(text, cfg.crisis_keywords);
    let urgency = 0;
    if (review.rating === 1) {
      urgency += urgCfg.rating_1;
      signals.push("rating_1");
    } else if (review.rating === 2) {
      urgency += urgCfg.rating_2;
      signals.push("rating_2");
    }
    if (hits.length > 0) {
      urgency += urgCfg.crisis_keyword;
      signals.push(`crisis_keywords:${hits.join(",")}`);
      // Urgency always scores; only cutoff-recent reviews can fire the crisis
      // TRIGGER (an old legal-threat review flags for a human, it is not a current crisis).
      if (parseTs(review.created_at) >= crisisCutoff(cfg, now)) {
        keywordFlagged.push({ review_id: rid, keywords: hits });
      }
    }
    if (review.author_badge) {
      urgency += urgCfg.influence_badge;
      signals.push("influence_badge");
    }
    if (burstMembers.has(rid)) {
      urgency += urgCfg.burst_context;
      signals.push("burst_context");
    }

    let value = 0;
    if (text.includes("?")) {
      value += valCfg.has_question;
      signals.push("has_question");
    }
    const annotationKeys = ["factual_error", "fixable_complaint", "service_recovery_opportunity", "detailed_positive"] as const;
    for (const key of annotationKeys) {
      if (ann?.[key]) {
        value += valCfg[key];
        signals.push(key);
      }
    }
    const vis = valCfg.platform_visibility;
    value += vis[review.platform] ?? vis.default;
    const ageDays = (now.getTime() - parseTs(review.created_at).getTime()) / 86_400_000;
    const mult = recencyMultiplier(ageDays, cfg.recency_decay);
    if (mult < 1.0) {
      signals.push(`recency_decay:${formatPyFloat(mult)}`);
    }
    value = pyRound(value * mult);

    const respondBlocked = responded.has(rid) || review.owner_response != null;
    if (respondBlocked) {
      signals.push("already_responded");
    }

    let route: TriageResultRow["route"];
    let draftAttached: boolean;
    let reason: string;
    let action: ReturnType<typeof proposedAction> | undefined;

    if (urgency >= routesCfg.flag_threshold) {
      route = "FLAG";
      summary.flag += 1;
      draftAttached = !respondBlocked && value >= routesCfg.respond_threshold;
      reason = `urgency ${urgency} >= ${routesCfg.flag_threshold}`;
      action = proposedAction(signals, respondBlocked, cfg);
    } else if (!respondBlocked && value >= routesCfg.respond_threshold) {
      route = "RESPOND";
      summary.respond += 1;
      draftAttached = true;
      reason = `value ${value} >= ${routesCfg.respond_threshold}`;
      action = undefined; // the proposal for a RESPOND is the attached draft itself
    } else {
      route = "NO_ACTION";
      summary.no_action += 1;
      draftAttached = false;
      reason = respondBlocked ? "already responded" : `below thresholds (value ${value}, urgency ${urgency})`;
      action = undefined;
    }

    const row: TriageResultRow = {
      review_id: rid,
      route,
      value_score: value,
      urgency_score: urgency,
      draft_attached: draftAttached,
      signals,
      crisis_hit: hits.length > 0,
      reason,
    };
    if (action !== undefined) {
      row.proposed_action = action;
    }
    results.push(row);
  }

  const triggers: CrisisTrigger[] = [];
  const dips = detectRatingDip(reviews, payload.baseline_rating_avg, cfg, now);
  for (const dip of dips) {
    const sig = triggerSignature("rating_dip", [dip.platform], dip.review_ids);
    triggers.push({
      type: "rating_dip",
      platform: dip.platform,
      baseline_rating_avg: dip.baseline_rating_avg,
      window_rating_avg: dip.window_rating_avg,
      window_review_count: dip.window_review_count,
      review_ids: dip.review_ids,
      signature: sig,
      suppressed: alerted.has(sig),
    });
  }

  // A burst is detected over the full input (a burst straddling two pulses
  // still completes) but fires only on new evidence: at least one member this
  // pulse has not seen before.
  if (burstMembers.size > 0 && [...burstMembers].some((rid) => !seen.has(rid))) {
    const ids = [...burstMembers].sort();
    const sig = triggerSignature(
      "negative_burst",
      ids.map((rid) => platformOf.get(rid)!),
      ids,
    );
    triggers.push({ type: "negative_burst", review_ids: ids, signature: sig, suppressed: alerted.has(sig) });
  }

  // Keyword triggers are per-review facts: only reviews new this pulse can
  // fire (a re-ingested review still scores urgency, but cannot re-alert).
  const newKeywordFlagged = keywordFlagged.filter((k) => !seen.has(k.review_id));
  if (cfg.crisis.keyword_instant && newKeywordFlagged.length > 0) {
    const ids = newKeywordFlagged.map((k) => k.review_id);
    const sig = triggerSignature(
      "crisis_keywords",
      ids.map((rid) => platformOf.get(rid)!),
      ids,
    );
    triggers.push({ type: "crisis_keywords", reviews: newKeywordFlagged, signature: sig, suppressed: alerted.has(sig) });
  }

  return {
    triage_config_version: cfg.triage_config_version,
    now: payload.now,
    results,
    crisis: {
      fired: triggers.some((t) => !t.suppressed),
      triggers,
    },
    summary,
  };
}
