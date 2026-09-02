/**
 * IGSTYLE-4 — durable style memory: distillation.
 *
 * Turns a client's own feedback history into a `DistilledStyle` — evidence
 * about taste, never a pin (§2.6 of the style-loop spec, which governs
 * IGSTYLE-4/5/7/10). This file owns the VOTING; `memory.appendFeedback`'s
 * `StylePreferenceSchema` (`@agent-engine/tool-karos-memory`) owns the
 * STORAGE, and `persistReviewFeedbackToMemory` below (`review-cycle.ts`)
 * is what writes a row this function can later read back and vote over.
 *
 * Neither this package nor this file imports that tool's types, or an
 * agent's own `StyleIntent`/`StyleDirectiveResult`
 * (`agents/instagram-agent/src/workflow/style-directive.ts`) — `StyleIntent`/
 * `StylePreferenceLike`/`FeedbackEntryLike` below are defined locally,
 * structurally compatible by construction, because this package sits BELOW
 * every tool and every agent in the dependency graph (RFC-01 §4: Layer 1
 * owns no tools and makes no content judgments) and cannot import either's
 * types without inverting that graph. `readPastFeedback` just below in this
 * same file already establishes the pattern: it duck-types
 * `memory.readFeedback`'s result rather than importing `FeedbackEntry`.
 *
 * ## The preference model this implements (§2.6)
 *
 * Tier 2 of that model ("this run's directive; the learned prior — followed
 * unless there's a reason") splits in two: within the run that gave it,
 * binding (IGSTYLE-3's job); in LATER runs, a decaying, weighted vote — this
 * file. An agent that pins the first colour anyone ever asked for and
 * reproduces it forever is the failure mode on the opposite side of the
 * original bug, and is just as real.
 */

export interface StyleIntent {
  role: "ground" | "fg" | "accent";
  direction: "darker" | "lighter" | "more-contrast" | "hue";
  hue?: string;
}

/**
 * Structurally identical to `@agent-engine/tool-karos-memory`'s
 * `StylePreference` (itself a durable, `refusals`-free copy of the agent's
 * own `StyleDirectiveResult`) — see this file's header comment for why it's
 * a local shape rather than an import.
 */
export interface StylePreferenceLike {
  overrides: Readonly<Record<string, string>>;
  source: "structured" | "parsed" | "model";
  intents?: readonly StyleIntent[];
  /**
   * Free-text notes from the resolution that produced `overrides` — the ONLY
   * signal this module has for rule 9's kit-legality check, since this
   * function is never handed a live brand kit (see `distillStylePreferences`'s
   * own doc comment on why). `resolveNamedColor`
   * (`agents/instagram-agent/src/workflow/style-directive.ts`) already writes
   * the exact convention this reads: `"<word>: no kit colour matched, used
   * <hex> (not a brand colour)"` whenever a hue resolved outside the kit's
   * ring. Silence (no matching line) reads as "was kit-legal" — the
   * resolution step already refused anything that wasn't.
   */
  applied?: readonly string[];
}

/** The slice of a `memory.readFeedback` row this module actually needs. */
export interface FeedbackEntryLike {
  decision: "approve" | "revise" | "reject";
  productId: string;
  /** Same epoch-ms clock `memory.appendFeedback` stamps rows with (`Date.now()` at write time). */
  at: number;
  style?: StylePreferenceLike;
}

export interface DistilledStyle {
  /** The prior — a strong default, never a pin. Only roles that cleared the evidence threshold AND the kit-legality check appear here. */
  overrides: Record<string, string>;
  /** Per-role confidence in `[0,1]` — `winningWeight / totalWeightForRole`. IGSTYLE-7 spends this to decide how much variation headroom a role has. */
  strength: Record<string, number>;
  /** Winning per-role intents — populated independently of `overrides` (rule 10: an intent survives even when its hex loses). */
  intents: StyleIntent[];
  /** Human-readable trace of every promotion, rejection, and near-miss, newest-role-first in iteration order. Never empty when any row carried style data; always empty for `[]`/style-free input. */
  evidence: string[];
}

// ─────────────────────────────────────────────────────────────────────────
// IGSTYLE-7, §2.6 — "preference as prior, not pin": spending the variation
// budget on a LOW-CONFIDENCE learned role, seeded (never random) so the same
// run always resolves the same way twice and a different run may depart
// differently.
// ─────────────────────────────────────────────────────────────────────────

/** §2.6 / 7b — the strength floor below which a learned role is a weak enough prior to vary rather than reproduce verbatim. At or above, the prior is used as-is (a strong default). */
export const VARIATION_THRESHOLD = 0.75;

/** One reported departure from the raw learned prior — always paired with WHY, per the ticket's own "every departure in styleVariation" acceptance line. */
export interface StyleVariationEntry {
  role: "ground" | "fg" | "accent";
  /** The learned prior's own value — `"(no hex reached the evidence threshold)"` for a 7c intent-only satisfaction, which has no losing hex to name. */
  prior: string;
  used: string;
  reason: string;
}

/** What `varyLearnedStyle` resolves a ground/fg/accent candidate against — deliberately just hexes and a ring, never a live brand kit object (see this file's own header: this package sits below every agent and cannot import one). */
export interface VariationContext {
  /** Layer 0's own resolved ground/fg — what a shaded ground/fg candidate's pair-contrast is checked against when only one half of the pair is being varied this round. */
  baselineGround?: string;
  baselineFg?: string;
  /** The kit's accent ring (`BrandRenderTokens.palette`) — accent variation only ever moves to ANOTHER ring member, never invents one (kit-boundedness is free by construction: the ring itself is already contrast-checked against the ground). */
  ring?: readonly string[];
}

/** Local, minimal copy — see `style-directive.ts`'s own `relativeLuminance`/`contrastRatio` doc comment for why this package keeps its own rather than importing brand-render-tokens.ts's (or that file's) private ones: this package sits below every agent in the dependency graph. */
function relativeLuminance(hex: string): number {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  const channel = (i: number) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrastRatioLocal(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Local copy of `style-directive.ts`'s own `shade` — same reasoning as `contrastRatioLocal` above. */
function shade(hex: string, percent: number): string {
  let h = hex.slice(1);
  const hadShortAlpha = h.length === 4;
  const hadLongAlpha = h.length === 8;
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const alpha = hadShortAlpha || hadLongAlpha ? h.slice(6, 8) : "";
  const p = percent / 100;
  const adjust = (c: number): number => {
    const next = p < 0 ? c * (1 + p) : c + (255 - c) * p;
    return Math.max(0, Math.min(255, Math.round(next)));
  };
  const toHex = (c: number) => c.toString(16).padStart(2, "0");
  return `#${toHex(adjust(r))}${toHex(adjust(g))}${toHex(adjust(b))}${alpha}`;
}

/** FNV-1a 32-bit — same algorithm `brand-render-tokens.ts`'s own seeded ring walk uses, duplicated here for the same "no cross-boundary import" reason as `shade`/`contrastRatioLocal` above. Pure: no clock, no randomness. */
function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const VARIATION_SHADE_STEP_PERCENT = 12;
const TEXT_CONTRAST_FLOOR = 4.5;

/** Deterministic ±1, seeded per `(seed, role)` — which DIRECTION a weak ground/fg prior shades on this run. Different seeds may disagree; the same seed never does. */
function shadeDirection(seed: string, role: string): 1 | -1 {
  return fnv1a32(`${seed}:${role}:shade`) % 2 === 0 ? 1 : -1;
}

/**
 * §2.6 / 7b+7c — spends the variation budget on the LEARNED prior only,
 * never on this round's own active directive (the caller merges
 * `styleDirectiveResult.overrides` in AFTER this function's output, last-wins,
 * exactly as before IGSTYLE-7 — "in-run supremacy" holds structurally, not by
 * special-casing here).
 *
 * - A role at or above `VARIATION_THRESHOLD` is used as-is (rule: "strong
 *   default").
 * - A role below it MAY depart: `ground`/`fg` shade `±VARIATION_SHADE_STEP_PERCENT`
 *   in a seeded direction, kept only if the resulting pair still clears the
 *   4.5:1 floor (checked jointly — contrast is a PAIR property); `accent`
 *   moves to a DIFFERENT member of `context.ring` (seeded, never the same
 *   member twice for one seed), which is kit-bounded by construction since
 *   the ring itself is already contrast-checked against the ground
 *   (`buildAccentRing`).
 * - Nothing legal to vary to (no room in the pair, ring of length ≤ 1) is an
 *   honest no-op: the prior ships unchanged, no colour is invented, and no
 *   variation entry is reported for it (nothing departed).
 *
 * Pure and deterministic given the same `seed` — no clock, no RNG.
 */
export function varyLearnedStyle(
  learned: Readonly<Record<string, string | undefined>>,
  strength: Readonly<Record<string, number | undefined>>,
  seed: string,
  context: VariationContext = {},
): { varied: Record<string, string>; variations: StyleVariationEntry[] } {
  // Callers may hand this a `StyleOverrides`-shaped object (every field
  // individually optional, per the wire contract) rather than a plain
  // `Record<string,string>` — filter rather than widen `varied`'s own type,
  // since every consumer downstream (`effectiveBrandKit`'s `learned`
  // parameter included) expects a patch with only DEFINED keys, exactly like
  // `mergeStyleOverrides`'s own "defined keys only" contract.
  const varied: Record<string, string> = Object.fromEntries(Object.entries(learned).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const variations: StyleVariationEntry[] = [];

  const isWeak = (role: string): boolean => (strength[role] ?? 1) < VARIATION_THRESHOLD;

  // ── ground/fg: a joint pair decision, since contrast is a pair property ──
  const priorGround = learned["ground"];
  const priorFg = learned["fg"];
  const groundWeak = priorGround !== undefined && isWeak("ground");
  const fgWeak = priorFg !== undefined && isWeak("fg");
  if (groundWeak || fgWeak) {
    const candidateGround = groundWeak ? shade(priorGround!, shadeDirection(seed, "ground") * VARIATION_SHADE_STEP_PERCENT) : (priorGround ?? context.baselineGround);
    const candidateFg = fgWeak ? shade(priorFg!, shadeDirection(seed, "fg") * VARIATION_SHADE_STEP_PERCENT) : (priorFg ?? context.baselineFg);
    if (candidateGround !== undefined && candidateFg !== undefined && contrastRatioLocal(candidateGround, candidateFg) >= TEXT_CONTRAST_FLOOR) {
      if (groundWeak && candidateGround !== priorGround) {
        varied["ground"] = candidateGround;
        variations.push({
          role: "ground",
          prior: priorGround!,
          used: candidateGround,
          reason: `strength ${(strength["ground"] ?? 1).toFixed(2)} is below the ${VARIATION_THRESHOLD} variation threshold — shaded within the 4.5:1 contrast floor rather than reproducing the exact prior hex`,
        });
      }
      if (fgWeak && candidateFg !== priorFg) {
        varied["fg"] = candidateFg;
        variations.push({
          role: "fg",
          prior: priorFg!,
          used: candidateFg,
          reason: `strength ${(strength["fg"] ?? 1).toFixed(2)} is below the ${VARIATION_THRESHOLD} variation threshold — shaded within the 4.5:1 contrast floor rather than reproducing the exact prior hex`,
        });
      }
    }
    // else: the shaded pair would drop below the floor — honest no-op, both roles ship the exact prior, nothing invented.
  }

  // ── accent: move to a different, already-kit-legal ring member ──
  const priorAccent = learned["accent"];
  if (priorAccent !== undefined && isWeak("accent") && context.ring !== undefined && context.ring.length > 1) {
    const ring = context.ring;
    const priorIdx = ring.findIndex((h) => h.toLowerCase() === priorAccent.toLowerCase());
    const baseIdx = priorIdx >= 0 ? priorIdx : 0;
    const step = 1 + (fnv1a32(`${seed}:accent:step`) % (ring.length - 1)); // 1..ring.length-1 — never 0, always a genuine departure
    const candidateIdx = (baseIdx + step) % ring.length;
    const candidate = ring[candidateIdx]!;
    if (candidate.toLowerCase() !== priorAccent.toLowerCase()) {
      varied["accent"] = candidate;
      variations.push({
        role: "accent",
        prior: priorAccent,
        used: candidate,
        reason: `strength ${(strength["accent"] ?? 1).toFixed(2)} is below the ${VARIATION_THRESHOLD} variation threshold — moved to another member of the brand kit's own accent ring`,
      });
    }
  }
  // else (ring absent, length <= 1, or accent not weak): honest no-op — nothing invented, see §2.6's "never manufacture colours to fill a ring".

  return { varied, variations };
}

/** Rule 3's default half-life — a pick from ~6.5 weeks ago carries half the weight of one made today. */
export const DEFAULT_HALF_LIFE_DAYS = 45;

/** Rule 4 — the accumulated weight a (role, value) candidate needs before it is promoted at all. */
const PROMOTION_THRESHOLD = 1.0;

/**
 * Rounding tolerance for the threshold comparison — "one deliberate pick
 * suffices" (rule 4's own words) means a SINGLE fresh `structured` row
 * (weight `1.0 × recencyWeight`) promotes on its own, but
 * `recencyWeight(ageMs, halfLifeDays)` (`Math.pow(0.5, ageDays /
 * halfLifeDays)`) is strictly less than `1` for any `ageMs > 0` — a row read
 * back even a second after it was written already carries something like
 * `0.999999999...`, not exactly `1`. Comparing that raw value against `1.0`
 * with a bare `<`/`>=` would make "one deliberate pick suffices" true only
 * at literal time-zero, which is never how this actually gets called (`02h`
 * always reads AFTER a prior run wrote, with real wall-clock time between
 * the two). Rounding both sides to the same two decimal places this
 * module's own `evidence` strings already report weight at
 * (`candidate.weight.toFixed(2)`) keeps the promotion decision consistent
 * with what a person reading that evidence actually sees — an evidence line
 * that says "at 1.00" is, by construction, a promotion, never a near-miss —
 * while still discarding any candidate that is genuinely, visibly short of
 * the threshold (anything that would round down to `0.99` or below).
 */
function meetsThreshold(weight: number): boolean {
  return Math.round(weight * 100) / 100 >= PROMOTION_THRESHOLD;
}

/** Rule 6 — `ReadFeedbackInputSchema`'s own ceiling (`packages/tools/karos-memory/src/append-feedback.ts`). Mirrored here as a defensive cap, not raised, so a caller that (mistakenly) hands this function more rows than that tool would ever return still gets a bounded vote. */
const MAX_ROWS_CONSIDERED = 50;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Rule 3. */
function recencyWeight(ageMs: number, halfLifeDays: number): number {
  const ageDays = ageMs / MS_PER_DAY;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** Rule 4 — `structured` is a deliberate human pick; `parsed`/`model` are inferred from free text and count for half. */
function sourceMultiplier(source: StylePreferenceLike["source"]): number {
  return source === "structured" ? 1 : 0.5;
}

/** Rule 9 — see `StylePreferenceLike.applied`'s own doc comment for the exact convention this reads. */
function offKitNote(hex: string, applied: readonly string[]): string | undefined {
  const needle = hex.toLowerCase();
  return applied.find((line) => {
    const lower = line.toLowerCase();
    return lower.includes(needle) && lower.includes("not a brand colour");
  });
}

interface HexCandidate {
  weight: number;
  /** Most recent contributing row's timestamp — rule 7's first tiebreaker. */
  latestAt: number;
  offKitNote: string | undefined;
}

interface IntentCandidate {
  weight: number;
  latestAt: number;
  intent: StyleIntent;
}

/** Rule 7 — weight desc, then newer-first, then smaller key (hex, or intent key) lexicographically. Deterministic given the same `now`. */
function rankedEntries<T extends { weight: number; latestAt: number }>(map: ReadonlyMap<string, T>): Array<[string, T]> {
  return [...map.entries()].sort(([keyA, a], [keyB, b]) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    if (b.latestAt !== a.latestAt) return b.latestAt - a.latestAt;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
}

const ROLES: readonly ("ground" | "fg" | "accent")[] = ["ground", "fg", "accent"];

/**
 * Distills a client's own feedback history into a style prior. Pure and
 * deterministic given the same `entries`/`options.now` — no clock read
 * unless `options.now` is omitted, no I/O, no randomness (rule 7).
 *
 * Deliberately takes NO brand-kit/ring parameter: this function only ever
 * sees free-standing feedback rows, potentially written under a kit that has
 * since changed, so it cannot re-validate a hex against "the kit" at
 * distillation time even if it wanted to. Rule 9's kit-legality check
 * instead trusts the evidence the ORIGINAL resolution already recorded (see
 * `StylePreferenceLike.applied`'s doc comment) — the same posture
 * `style-directive.ts` itself takes ("REFUSE — no signal, no override"):
 * this module never launders a colour the resolution step itself flagged as
 * off-kit back in, no matter how many rows re-request it.
 */
export function distillStylePreferences(
  entries: readonly FeedbackEntryLike[],
  options: { productId?: string; now?: number; halfLifeDays?: number } = {},
): DistilledStyle {
  const now = options.now ?? Date.now();
  const halfLifeDays = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;

  // Rules 1, 5, 6, 7 — never learn from a reject; filter by productId when
  // asked; bound to the 50 most-recent qualifying rows; ties (equal `at`)
  // are resolved identically regardless of input order because every vote
  // below sorts candidates deterministically, not these rows.
  const qualifying = entries
    .filter((entry) => entry.decision !== "reject")
    .filter((entry) => options.productId === undefined || entry.productId === options.productId)
    .slice()
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ROWS_CONSIDERED);

  const overrides: Record<string, string> = {};
  const strength: Record<string, number> = {};
  const intents: StyleIntent[] = [];
  const evidence: string[] = [];

  for (const role of ROLES) {
    // ── hex voting (rule 2 — independent per role) ──
    const hexCandidates = new Map<string, HexCandidate>();
    for (const entry of qualifying) {
      const style = entry.style;
      if (style === undefined) continue;
      const hex = style.overrides[role];
      if (hex === undefined) continue;
      const weight = recencyWeight(now - entry.at, halfLifeDays) * sourceMultiplier(style.source);
      const note = offKitNote(hex, style.applied ?? []);
      const existing = hexCandidates.get(hex);
      if (existing === undefined) {
        hexCandidates.set(hex, { weight, latestAt: entry.at, offKitNote: note });
      } else {
        existing.weight += weight;
        existing.latestAt = Math.max(existing.latestAt, entry.at);
        existing.offKitNote = existing.offKitNote ?? note;
      }
    }

    const totalWeightForRole = [...hexCandidates.values()].reduce((sum, c) => sum + c.weight, 0);
    const rankedHexes = rankedEntries(hexCandidates);

    for (const [hex, candidate] of rankedHexes) {
      if (!meetsThreshold(candidate.weight)) {
        evidence.push(
          `${role}: no candidate reached the ${PROMOTION_THRESHOLD.toFixed(1)} evidence threshold (best remaining "${hex}" at ${candidate.weight.toFixed(2)})`,
        );
        break;
      }
      // Rule 9 — kit-legal only. A candidate that cleared the threshold but
      // is marked off-kit is skipped, never promoted, and never silently
      // dropped — the runner-up (if any) still gets its own shot.
      if (candidate.offKitNote !== undefined) {
        evidence.push(`${role}: "${hex}" not promoted — off-kit (${candidate.offKitNote}); weight ${candidate.weight.toFixed(2)} discarded`);
        continue;
      }
      overrides[role] = hex;
      strength[role] = clamp(candidate.weight / (totalWeightForRole || 1), 0, 1);
      evidence.push(`${role}: promoted "${hex}" (weight ${candidate.weight.toFixed(2)} of ${totalWeightForRole.toFixed(2)} total)`);
      break;
    }

    // ── intent voting (rule 10 — independent of whether the hex above won) ──
    const intentCandidates = new Map<string, IntentCandidate>();
    for (const entry of qualifying) {
      const style = entry.style;
      if (style === undefined) continue;
      for (const intent of style.intents ?? []) {
        if (intent.role !== role) continue;
        const key = `${intent.direction}:${intent.hue ?? ""}`;
        const weight = recencyWeight(now - entry.at, halfLifeDays) * sourceMultiplier(style.source);
        const existing = intentCandidates.get(key);
        if (existing === undefined) {
          intentCandidates.set(key, { weight, latestAt: entry.at, intent });
        } else {
          existing.weight += weight;
          existing.latestAt = Math.max(existing.latestAt, entry.at);
        }
      }
    }
    const rankedIntents = rankedEntries(intentCandidates);
    const winningIntent = rankedIntents[0];
    if (winningIntent !== undefined && meetsThreshold(winningIntent[1].weight)) {
      intents.push(winningIntent[1].intent);
    }
  }

  return { overrides, strength, intents, evidence };
}
