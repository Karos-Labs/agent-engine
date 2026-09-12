import { z } from "zod";
import { similarity } from "@agent-engine/core";
import type { ContentMode } from "@agent-engine/workflow";
import type { ClientBrief } from "@agent-engine/tools";

/**
 * Instagram Phase 1, item K — the ANGLE step: the editorial judgment that
 * turns a subject into a post worth reading, and the ledger codec that stops
 * the same judgment repeating next week.
 *
 * ## What was wrong
 *
 * Until this step the writer received a topic and a pile of fact cards and
 * was left to find the point itself, on every attempt, with no memory of what
 * the account had already argued. The 2026-09-08 prep audit's five auto runs
 * read as five summaries of the same news: correct, sourced, and saying
 * nothing a reader would remember. Nothing in the pipeline ever asked "what
 * is the ONE sentence this post exists to leave behind, and has this account
 * already said it?"
 *
 * ## The shape
 *
 * One Sonnet call per REVISION (never per attempt — `04i-propose-angles`
 * sits at the top of `draftOnce`, outside the attempt loop) proposes exactly
 * three angles, one per id:
 *
 * - `wrong-assumption` — something the niche believes that the facts do not
 *   support.
 * - `surprising-number` — a figure that reframes the subject, resting on a
 *   `kind: "stat"` fact card.
 * - `what-it-means` — the consequence for this client's ICP specifically.
 *
 * The PICK is deterministic (`selectAngle`, pure, `04j-select-angle`): a
 * model that scores its own proposals grades its own homework, and the two
 * things that actually decide an angle here — how much of the client's brief
 * it touches, and how far it is from what this account already published —
 * are measurable. `briefFit` is still asked of the model (it read the facts
 * and the brief together) but it is only half of `fit`, and it cannot rescue
 * an angle that repeats last week's line.
 *
 * ## Failure posture
 *
 * Fails OPEN, like the relevance judge and unlike the fluency gate: an angle
 * agent that does not complete, or three proposals that all rest on cards
 * this run never fetched, mean the copy step drafts exactly as it did before
 * this step existed. An angle is an improvement to a post, not a
 * precondition for one, and the owner's rule is that a deliverable always
 * reaches the client.
 *
 * ## Cost
 *
 * Sonnet, ~8k in / 0.8k out ≈ $0.036, at most once per revision (three per
 * run at the ceiling: $0.108). Justified in
 * `agent/instagram-angle-agent.ts`, which is the file that pins the tier.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The proposal schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three angle kinds, in the order the prompt lists them. A closed set on
 * purpose: an open `id` would let the model propose three variants of the
 * same move (three "surprising numbers" over the same card), which is what
 * "propose three angles" produced in the legacy skill.
 */
export const ANGLE_IDS = ["wrong-assumption", "surprising-number", "what-it-means"] as const;

export const AngleIdSchema = z.enum(ANGLE_IDS);
export type AngleId = z.infer<typeof AngleIdSchema>;

export const AngleSchema = z.object({
  id: AngleIdSchema,
  /** The angle as an editor would name it in a stand-up. */
  title: z.string().min(1).max(160),
  /** The ONE sentence the reader should remember, written in the run's target language (it may be quoted near-verbatim on the cover or the closer). */
  rememberLine: z.string().min(1).max(160),
  /** The fact-card `claim`s this angle rests on, verbatim — checked against the run's cards by `selectAngle`. */
  restsOn: z.array(z.string().min(1)).min(1).max(4),
  /** Why THIS client is the account that gets to say it. */
  whyThisClient: z.string().min(1).max(300),
  /** The model's own read of brief fit, 1-5. Re-scored deterministically below; it is half of `fit`, never the whole of it. */
  briefFit: z.number().int().min(1).max(5),
});
export type Angle = z.infer<typeof AngleSchema>;

export const AngleProposalSchema = z.object({
  angles: z.array(AngleSchema).length(3),
  /** Anything the proposer could not fit into an angle (a card it distrusts, a gap in the brief). Read by a human, never by a step. */
  notes: z.string().optional(),
});
export type AngleProposal = z.infer<typeof AngleProposalSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Inputs to the deterministic pick
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One fact card as the scorer reads it. Structural rather than
 * `ResearchFact`: `kind` arrives with item J's `ResearchFactSchema` bump and
 * this module must score correctly both before and after it lands (and for a
 * card a human wrote by hand).
 */
export interface AngleFactCard {
  claim: string;
  kind?: string | undefined;
}

/** An angle this account already published, as `angleFromDecisionSummary` reads it back out of the decision log. */
export interface PastAngle {
  id: AngleId;
  rememberLine: string;
}

export interface SelectAngleOptions {
  /** The Client Brief's three scoring surfaces. A `Pick` so a test can score against six fields instead of a whole brief. */
  brief: Pick<ClientBrief, "coreTerms" | "offers" | "icp">;
  /**
   * The cards the PROPOSER was shown — the set `restsOn` must name.
   *
   * The workflow passes the one ordered prompt view (`factCardsForPrompt`'s
   * 14 cards, primary first) that both `04i` and the copy step read, not the
   * full deduped set: an angle resting on a card that reached neither prompt
   * is one the writer cannot cite, and prompt @13 asks it to carry those
   * cards' claim, source, date and URL verbatim.
   */
  facts: readonly AngleFactCard[];
  /** What this account already argued (newest first); both the novelty measure and the tie-break read it. */
  pastAngles: readonly PastAngle[];
  /** Recent post excerpts across channels (the last five is what the caller passes) — novelty is measured against these too. */
  recentExcerpts: readonly string[];
  /** This run's content mode, from `03d-select-content-mode`. */
  mode: ContentMode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A fact card counts as a "stat" when it says so, or (before item J's `kind`
 * field exists, and for any hand-written card without one) when its claim
 * actually carries a figure. The rule a `surprising-number` angle has to
 * clear is "there is a number to be surprised by", and that is a property of
 * the claim, not of which schema version wrote it. A four-digit year alone is
 * not a statistic, so it is excluded exactly as `LEADS_WITH_FIGURE` excludes
 * it in `visual-qa-pre-checks.ts`.
 */
const CLAIM_CARRIES_FIGURE = /(?<!\d)(?!\d{4}(?!\d))(?:[$€£₪]\s?)?\d[\d.,]*\s?(?:%|[kKmM]\b|million|billion|percent|אחוז|אלף|מיליון|מיליארד)?/u;

export function factCardKind(fact: AngleFactCard): string {
  const declared = typeof fact.kind === "string" ? fact.kind.trim().toLowerCase() : "";
  if (declared.length > 0) return declared;
  return CLAIM_CARRIES_FIGURE.test(fact.claim) ? "stat" : "unspecified";
}

/** Collapse whitespace; the one normalisation every comparison and every recorded string here goes through. */
function collapse(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Case- and whitespace-insensitive card matching.
 *
 * `restsOn` is specified as verbatim claims, and the prompt asks for verbatim
 * claims, but dropping an otherwise strong angle because the model
 * capitalised a sentence costs the run its editorial judgment for nothing.
 * The place where "verbatim" is load-bearing is `sourceRef` on a SLIDE, which
 * `checkSlidesData` still enforces byte-for-byte against the same cards.
 */
export function cardKey(claim: string): string {
  return collapse(claim).toLowerCase();
}

/** Letter/digit tokens, lowercased. Unicode-aware: Hebrew is a first-class target language and `\w` would drop it entirely. */
function tokens(text: string): string[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => m[0]!.toLowerCase());
}

/**
 * The brief's terms an angle can "hit", each as its own token list (a
 * multi-word term counts only when every one of its tokens is present).
 *
 * `coreTerms` and offer names are curated, so they enter as-is. ICP words
 * come out of prose, so only tokens of five letters or more enter and only
 * the first `MAX_ICP_TERMS` of them: there is deliberately NO stopword list
 * here, because the one that exists lives in `client-brief.ts` and a second
 * copy of it in a second module is a list that silently drifts. The 5-letter
 * floor plus `min(hits, MAX_HITS)` keeps generic prose from carrying `fit` on
 * its own.
 */
const MAX_ICP_TERMS = 12;
const MIN_ICP_WORD_LETTERS = 5;
/** Hitting four brief terms in two sentences is a fully on-brief angle; beyond that it reads as keyword stuffing, so the scale stops. */
export const MAX_HITS = 4;

function briefTerms(brief: SelectAngleOptions["brief"]): string[][] {
  const terms: string[][] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const list = tokens(raw);
    if (list.length === 0) return;
    const key = list.join(" ");
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(list);
  };
  for (const term of brief.coreTerms) push(term);
  for (const offer of brief.offers) push(offer.name);
  const icpProse = [brief.icp.summary, ...brief.icp.roles, ...brief.icp.pains].join(" ");
  let icpTerms = 0;
  for (const word of tokens(icpProse)) {
    if (icpTerms >= MAX_ICP_TERMS) break;
    if (word.length < MIN_ICP_WORD_LETTERS) continue;
    const before = seen.size;
    push(word);
    if (seen.size > before) icpTerms += 1;
  }
  return terms;
}

/** How many distinct brief terms appear in the angle's own words, capped at `MAX_HITS`. */
export function briefTermHits(angle: Pick<Angle, "title" | "rememberLine">, brief: SelectAngleOptions["brief"]): number {
  const present = new Set(tokens(`${angle.title} ${angle.rememberLine}`));
  let hits = 0;
  for (const term of briefTerms(brief)) {
    if (term.every((token) => present.has(token))) hits += 1;
    if (hits >= MAX_HITS) return MAX_HITS;
  }
  return hits;
}

/**
 * `0.5 · briefFit/5 + 0.5 · min(hits, 4)/4` — the model's judgment and the
 * measurable overlap, weighted equally so neither can carry an angle alone.
 *
 * Hebrew morphology (prefixed articles, inflected plurals, no casing) means
 * `hits` under-counts systematically for a Hebrew angle: "לשיווק" does not
 * token-match the core term "שיווק". That is deliberate rather than patched
 * with a stemmer, because the consequence is benign and the alternative is
 * not: a Hebrew run's `fit` compresses toward `briefFit/2` for every
 * candidate, so `novelty` (which is script-independent, being trigram
 * overlap of the angle against this account's own past lines) is what
 * separates them. Novelty dominating in Hebrew is the correct behaviour for
 * an account that publishes weekly in one language.
 */
export function angleFit(angle: Pick<Angle, "title" | "rememberLine" | "briefFit">, brief: SelectAngleOptions["brief"]): { fit: number; hits: number } {
  const hits = briefTermHits(angle, brief);
  return { fit: 0.5 * (angle.briefFit / 5) + 0.5 * (Math.min(hits, MAX_HITS) / MAX_HITS), hits };
}

/** `1 −` the closest trigram-Jaccard match between this angle's remember line and anything the account already said. 1 with no history: a first post cannot be a repeat. */
export function angleNovelty(rememberLine: string, against: readonly string[]): number {
  let closest = 0;
  for (const text of against) {
    const score = similarity(rememberLine, text);
    if (score > closest) closest = score;
  }
  return Math.min(1, Math.max(0, 1 - closest));
}

/**
 * Which angle kind this run's content mode wants. Not a wall (0.85 for the
 * others, not 0): the rotation is a steer, and a mode-mismatched angle that
 * is far more on-brief and far more novel should still win.
 */
const MODE_PREFERENCE: Record<ContentMode, readonly AngleId[]> = {
  "hot-news": ["surprising-number", "what-it-means"],
  "deep-value": ["wrong-assumption"],
  "open-discussion": ["what-it-means"],
};

/** The penalty an off-mode angle carries. */
export const OFF_MODE_FIT = 0.85;

export function angleModeFit(id: AngleId, mode: ContentMode): number {
  return MODE_PREFERENCE[mode].includes(id) ? 1 : OFF_MODE_FIT;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// The pick
// ─────────────────────────────────────────────────────────────────────────────

/** One angle's arithmetic, itemised — the gate payload and the ledger show it so a reviewer can see WHY this angle won. */
export interface AngleScore {
  id: AngleId;
  title: string;
  score: number;
  fit: number;
  novelty: number;
  modeFit: number;
  hits: number;
  eligible: boolean;
  /** Present only when `eligible` is false: which rule dropped it. */
  ineligibleReason?: string;
}

export interface RejectedAngle {
  angle: Angle;
  score: number;
  /** The reviewer-facing reason this one did not run: an eligibility rule, or the arithmetic against the winner. */
  why: string;
}

export type AngleSelection =
  | {
      status: "selected";
      chosen: Angle;
      rejected: RejectedAngle[];
      scores: AngleScore[];
      /** How the winner won, in the words the gate payload shows. */
      rule: string;
    }
  | {
      status: "no-eligible-angle";
      rejected: RejectedAngle[];
      scores: AngleScore[];
      reason: string;
    };

/** What the gate payload carries as `angleDecision`: the pick, the empty field, or the fail-open "the proposer could not run". */
export type AngleDecision = AngleSelection | { status: "unavailable"; reason: string };

/** The fail-open decision: the agent did not complete (`content_fail`, `budget_exceeded`), so copy drafts without an angle. Never a hold. */
export function angleUnavailable(reason: string): Extract<AngleDecision, { status: "unavailable" }> {
  return { status: "unavailable", reason };
}

/**
 * The `angle` block the copy step receives, or `undefined` when there is
 * nothing to steer with. The two rejected angles travel as context only
 * (prompt §17: "do not blend them in"), so they go without their scores —
 * the arithmetic is for the reviewer, not for the writer.
 */
export function angleForCopyInput(decision: AngleDecision): { chosen: Angle; rejected: Angle[] } | undefined {
  if (decision.status !== "selected") return undefined;
  return { chosen: decision.chosen, rejected: decision.rejected.map((r) => r.angle) };
}

interface Evaluated {
  angle: Angle;
  score: AngleScore;
  /** Input order, the final tie-break: two angles that are equal on every measure resolve the way the proposer listed them. */
  order: number;
}

/**
 * Score three proposed angles and pick one. Pure, total, never throws.
 *
 * Eligibility first (an angle that fails it scores 0 and can never be
 * chosen):
 * 1. every `restsOn` entry names a fact card this run actually fetched;
 * 2. a `surprising-number` angle rests on at least one `kind: "stat"` card.
 *
 * Then `score = fit × novelty × modeFit`, highest wins; a tie goes to the id
 * this account has used LEAST (the rotation the ledger exists for), and a
 * remaining tie to the proposer's own order.
 */
export function selectAngle(angles: readonly Angle[], options: SelectAngleOptions): AngleSelection {
  const cards = new Map<string, AngleFactCard>();
  for (const fact of options.facts) cards.set(cardKey(fact.claim), fact);
  const novelAgainst = [...options.pastAngles.map((p) => p.rememberLine), ...options.recentExcerpts];
  const usage = new Map<AngleId, number>(ANGLE_IDS.map((id) => [id, 0]));
  for (const past of options.pastAngles) usage.set(past.id, (usage.get(past.id) ?? 0) + 1);

  const evaluated: Evaluated[] = angles.map((angle, order) => {
    const { fit, hits } = angleFit(angle, options.brief);
    const novelty = angleNovelty(angle.rememberLine, novelAgainst);
    const modeFit = angleModeFit(angle.id, options.mode);
    // Against `options.facts`, which is the list the proposer was shown — so
    // "never fetched" also covers the card that exists in the run's full
    // deduped set but reached neither prompt. Either way the writer has no
    // source, date or URL for it.
    const missing = angle.restsOn.filter((claim) => !cards.has(cardKey(claim)));
    const restsOnStat = angle.restsOn.some((claim) => {
      const card = cards.get(cardKey(claim));
      return card !== undefined && factCardKind(card) === "stat";
    });
    const ineligibleReason =
      missing.length > 0
        ? `rests on ${missing.length === 1 ? "a fact card" : `${missing.length} fact cards`} this run never fetched: ${missing.map((m) => `"${collapse(m)}"`).join(", ")}`
        : angle.id === "surprising-number" && !restsOnStat
          ? 'a "surprising number" angle has to rest on a fact card of kind "stat"; none of the cards it names carries a figure'
          : undefined;
    const eligible = ineligibleReason === undefined;
    return {
      angle,
      order,
      score: {
        id: angle.id,
        title: angle.title,
        score: eligible ? round3(fit * novelty * modeFit) : 0,
        fit: round3(fit),
        novelty: round3(novelty),
        modeFit,
        hits,
        eligible,
        ...(ineligibleReason !== undefined ? { ineligibleReason } : {}),
      },
    };
  });

  const scores = evaluated.map((e) => e.score);
  const eligible = evaluated.filter((e) => e.score.eligible);
  if (eligible.length === 0) {
    return {
      status: "no-eligible-angle",
      rejected: evaluated.map((e) => ({ angle: e.angle, score: e.score.score, why: e.score.ineligibleReason ?? "not eligible" })),
      scores,
      reason:
        `none of the ${evaluated.length} proposed angles was usable: ` +
        `${evaluated.map((e) => `${e.angle.id} (${e.score.ineligibleReason ?? "not eligible"})`).join("; ")} — the copy step drafts without an angle`,
    };
  }

  const ranked = [...eligible].sort((a, b) => {
    if (b.score.score !== a.score.score) return b.score.score - a.score.score;
    const byUsage = (usage.get(a.angle.id) ?? 0) - (usage.get(b.angle.id) ?? 0);
    if (byUsage !== 0) return byUsage;
    return a.order - b.order;
  });
  const winner = ranked[0]!;
  const tied = ranked.filter((e) => e.score.score === winner.score.score).length > 1;
  const rejected: RejectedAngle[] = evaluated
    .filter((e) => e !== winner)
    .map((e) => ({
      angle: e.angle,
      score: e.score.score,
      why: e.score.eligible
        ? `scored ${e.score.score} against the chosen angle's ${winner.score.score} (brief fit ${e.score.fit}, novelty ${e.score.novelty}, mode fit ${e.score.modeFit})`
        : (e.score.ineligibleReason ?? "not eligible"),
    }));

  return {
    status: "selected",
    chosen: winner.angle,
    rejected,
    scores,
    rule:
      `${winner.angle.id} scored ${winner.score.score} = brief fit ${winner.score.fit} x novelty ${winner.score.novelty} x mode fit ${winner.score.modeFit} ` +
      `(${winner.score.hits} of the brief's terms in its own words; mode ${options.mode})` +
      (tied ? `; the tie was broken toward the angle kind this account has used least (${usage.get(winner.angle.id) ?? 0} of the last ${options.pastAngles.length})` : ""),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The ledger codec — `; angle: <id> | <rememberLine>` inside E's summary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Item E's decision summary with this run's angle appended INSIDE the
 * parenthesis:
 *
 *   instagram post: "…" (mode: deep-value; source: trend; archetypes: photo,stat-callout; angle: wrong-assumption | The hours only come back when the report writes itself.)
 *
 * Inside, and last, for two reasons. Inside, because
 * `parseContentModeFromSummary`'s `/mode: ([a-z-]+)/` reads the mode back out
 * of the same group and a summary is the only place the rotation survives
 * across runs. Last, because a `rememberLine` is a human sentence that may
 * contain semicolons, colons and parentheses, and anything after it would
 * need to be told apart from them.
 */
export function angleDecisionSummary(base: string, chosen: Angle | undefined): string {
  if (chosen === undefined) return base;
  const line = collapse(chosen.rememberLine);
  if (line.length === 0) return base;
  const fragment = `angle: ${chosen.id} | ${line}`;
  const close = base.lastIndexOf(")");
  if (close === -1) return `${base} (${fragment})`;
  return `${base.slice(0, close)}; ${fragment}${base.slice(close)}`;
}

/** `; angle: <id> | ` (or `(angle: … | ` when the base carried no parenthesis) — the marker the reader below anchors on. */
const ANGLE_MARKER = new RegExp(`[;(]\\s*angle:\\s*(${ANGLE_IDS.join("|")})\\s*\\|\\s*`, "u");

/**
 * Reads one angle back out of a decision summary, or `undefined` for a row
 * that carries none (every row written before this step existed, and every
 * run whose angle agent failed open).
 *
 * The remember line runs to the summary's own closing parenthesis, so a line
 * containing "(again)" round-trips. A key appended after the angle by some
 * later writer is cut off rather than swallowed into the line.
 */
export function angleFromDecisionSummary(summary: string): PastAngle | undefined {
  const match = ANGLE_MARKER.exec(summary);
  if (!match) return undefined;
  const rest = summary.slice(match.index + match[0].length);
  const close = rest.lastIndexOf(")");
  let body = close === -1 ? rest : rest.slice(0, close);
  const laterKey = /;\s(?:archetypes|mode|source|lane|angle|concept):\s/u.exec(body);
  if (laterKey) body = body.slice(0, laterKey.index);
  const rememberLine = collapse(body);
  if (rememberLine.length === 0) return undefined;
  return { id: match[1] as AngleId, rememberLine };
}

/**
 * The angles this account already published, newest first, out of the
 * decision log as `memory.read({ scope: "decisions", limit: 20 })` returns it
 * (NEWEST first already; sorted here so a caller that re-orders the rows
 * cannot change what "recent" means). Rows without an angle are skipped, not
 * defaulted: a run that failed open must not look like a run that chose
 * `wrong-assumption`.
 */
export function pastAnglesFromDecisions(decisions: ReadonlyArray<{ at?: unknown; summary: string }>): PastAngle[] {
  const at = (d: { at?: unknown }): number => (typeof d.at === "number" ? d.at : 0);
  return [...decisions]
    .sort((a, b) => at(b) - at(a))
    .flatMap((d) => {
      const angle = angleFromDecisionSummary(d.summary);
      return angle === undefined ? [] : [angle];
    });
}

/**
 * The compact `facts` the angle agent reads: at most `ANGLE_FACTS_IN_PROMPT`
 * cards, claim and kind only. The proposer needs to know what evidence
 * exists and which of it is a number; the source URL, the quote and the
 * primary flag are the copy step's and the self-check's business.
 *
 * Fed the SAME ordered view the copy step gets (`factCardsForPrompt`), never
 * the raw deduped set: this function keeps the first N in the order it is
 * given, so slicing the raw set here and re-ordering it there produced two
 * different 14-card windows and let an angle rest on a card the writer never
 * received. `ANGLE_FACTS_IN_PROMPT <= FACT_CARDS_FOR_PROMPT` keeps this a
 * prefix of that view (pinned in `fact-cards.test.ts`).
 */
export const ANGLE_FACTS_IN_PROMPT = 14;

export function factsForAnglePrompt(facts: readonly AngleFactCard[]): Array<{ claim: string; kind: string }> {
  return facts.slice(0, ANGLE_FACTS_IN_PROMPT).map((fact) => ({ claim: fact.claim, kind: factCardKind(fact) }));
}
