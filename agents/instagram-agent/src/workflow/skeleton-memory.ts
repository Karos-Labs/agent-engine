import { templateBasename } from "./visual-qa-pre-checks.js";

/**
 * RFC-13 Phase 2, item P — STRUCTURAL MEMORY ACROSS RUNS.
 *
 * The owner's second complaint, verbatim: *"בנוסף בגלל שזה חזרתי זה נראה AI"* —
 * "and because it is repetitive it looks like AI". Item L measures whether one
 * slide is empty; this module measures whether this WEEK'S POST is last week's
 * post with different words. Nothing inside a single carousel can see that, so
 * the fact has to be recorded when a post ships and read back when the next
 * one is planned.
 *
 * ## Where the record lives, and why not the decision summary
 *
 * The client's beliefs document, under `SKELETON_BELIEF_KEY`, written by the
 * `memory.updateBeliefs({ diff })` `09b-deliver-and-log` already makes for
 * `RUN_BUDGET_BELIEF_KEY`. `updateBeliefs` merges a diff, so sibling keys
 * never fight, which is exactly why this is a NEW key rather than a widening
 * of an existing one.
 *
 * `topicDecisionSummary` is deliberately NOT touched. It already carries an
 * `archetypes:` segment, but it is a DE-DUPLICATED SET rendered into prose,
 * and two live parsers read that prose back (`parseContentModeFromSummary`,
 * `angleFromDecisionSummary`). Reformatting it into an ordered list to carry
 * this data would put both of them at risk in order to store an array of
 * strings that has a better home. The ordered signature goes to beliefs
 * (machine-read) and to one `ledger.appendEvent` info row (operator-visible
 * in the run trace) instead.
 *
 * ## The import boundary
 *
 * This module imports `templateBasename` and nothing else. In particular it
 * does NOT import `interest-floor.ts`: a run with the interest floor degraded
 * (or one whose measurement returned `{ ok: false }`) must still record and
 * enforce its skeleton, so the two policies are deliberately independent.
 * `SkeletonRole` below is the same string union as the floor's `SlideRole`
 * and is assignable to and from it.
 */

/** The beliefs key the shipped-skeleton history lives under. Sibling of `RUN_BUDGET_BELIEF_KEY` in the same document. */
export const SKELETON_BELIEF_KEY = "instagramSkeletons";

/**
 * How many past skeletons are kept.
 *
 * Ten, matching `run-budget.ts`'s own `HISTORY_RUNS_KEPT`: a weekly cadence
 * makes that a quarter of posts, which is long enough to see a rut and short
 * enough that a deliberate format change is not fought forever by a record
 * from last spring.
 */
export const SKELETON_HISTORY_LIMIT = 10;

/**
 * How many are shown to the writer as an avoid-list.
 *
 * Five, because the prompt has to be able to say "do not reproduce any of
 * these" and mean it. A ten-entry avoid-list over an eight-archetype menu
 * with six-to-eight positions starts to forbid more than it permits, and a
 * writer told that everything is forbidden picks arbitrarily.
 */
export const SKELETON_AVOID_WINDOW = 5;

/**
 * The soft floor on `skeletonDistance` against the immediately previous post.
 *
 * Reads as "at least two of six positions must differ". See
 * `skeletonDistance` for the arithmetic that makes 0.34 mean exactly that:
 * at six slides one differing position reports 0.17 and two reports 0.34,
 * so `distance < MIN_SKELETON_DISTANCE` fails one change and admits two.
 * Two is the smallest change a reader scrolling a grid could actually
 * notice; one swapped interior slide is not a different post.
 */
export const MIN_SKELETON_DISTANCE = 0.34;

/**
 * A slide's job in the sequence.
 *
 * Structurally identical to `interest-floor.ts`'s `SlideRole` (item L) and
 * declared separately on purpose — see this module's header. Assignment
 * works in both directions, so the integrator can pass the floor's roles
 * straight in.
 */
export type SkeletonRole = "cover" | "interior" | "closer";

/**
 * The eight routable archetype ids, as the signature spells them.
 *
 * Held here as a literal rather than imported from `slides-data.ts` because
 * the signature is a HISTORICAL record: a token written last month must keep
 * meaning the same thing after the layout enum grows again, and an archetype
 * that is later renamed must not silently re-bucket old entries. An unknown
 * basename is treated as the client's own base slide (see
 * `archetypeTokenFor`), which is the honest answer rather than a guess.
 */
const KNOWN_ARCHETYPE_TOKENS: ReadonlySet<string> = new Set([
  "cover",
  "closer",
  "stat_callout",
  "quote_card",
  "comparison_card",
  "list_takeaway",
  "headline_focus",
  "photo",
  "text_only",
]);

/** One shipped post's structure, as the next run reads it. */
export interface SkeletonEntry {
  runId: string;
  /** ISO timestamp of delivery. */
  at: string;
  /** `"cover:cover>interior:stat_callout+bars>interior:photo>closer:closer"` — see `skeletonSignature`. */
  signature: string;
  /**
   * The archetype tokens, ORDERED, WITH DUPLICATES KEPT.
   *
   * The contrast with `topicDecisionSummary`'s de-duplicated set is the whole
   * point: `photo, photo, photo, closer` and `photo, closer` collapse to the
   * same set and are completely different posts.
   */
  archetypes: string[];
  /** The device kind on each slide, `""` where a slide carried none. Same length as `archetypes`. */
  deviceKinds: string[];
  roles: SkeletonRole[];
  /**
   * Item L's `occupiedShare` per slide, rounded to two decimals.
   *
   * The pixel half of "the same skeleton": two carousels can share an
   * archetype sequence and still read differently if one of them actually
   * fills its plates. Empty when the run had no measurement (a
   * `{ ok: false }` measure, or the floor disabled) — never faked.
   */
  occupancy: number[];
  /** Whether the reviewer edited any copy before approving. Recorded, not enforced: an edited post is still a shipped post. */
  edited: boolean;
}

export interface SkeletonHistory {
  version: 1;
  /** Oldest first, matching `RunBudgetHistory.runs`. */
  entries: SkeletonEntry[];
}

export const EMPTY_SKELETON_HISTORY: Readonly<SkeletonHistory> = { version: 1, entries: [] };

/** The minimum a caller has to know about a rendered slide to sign it. */
export interface SkeletonSlideInput {
  n: number;
  /**
   * The rendered slide's template — a path, a filename or a bare basename.
   * `-inv` and the extension are stripped by `templateBasename`, so
   * IGSTYLE-10's ground/fg inversion never reads as a different design.
   */
  template: string;
  /**
   * Whether this slide actually rendered a hero image.
   *
   * Load-bearing: `photo` and `text_only` both resolve to the client's own
   * `slideTemplate`, so the filename alone cannot tell a photograph from a
   * quiet typographic slide — and those are the two most common slides in
   * the deck. Absent is read as "no image".
   */
  hasImage?: boolean | undefined;
}

/**
 * Slide 1 is the cover, the last slide is the closer, everything between is
 * interior.
 *
 * The role rule in ONE place, so `07k`, `08a1`'s floor and `09b`'s record
 * cannot drift apart. A one-slide post (the `single` format) is a cover: it
 * is the grid thumbnail, and nothing follows it to close.
 */
export function rolesForSlideCount(count: number): SkeletonRole[] {
  if (count <= 0) return [];
  if (count === 1) return ["cover"];
  return Array.from({ length: count }, (_, i) => (i === 0 ? "cover" : i === count - 1 ? "closer" : "interior"));
}

/**
 * The archetype token for one rendered slide.
 *
 * `templateBasename` first (so `stat-callout-inv.html` and `stat-callout.html`
 * are one design), then hyphens to underscores so the token reads as the
 * archetype id the copy prompt and the layout enum both use. A basename that
 * is not a known archetype is the client's own base template, which renders
 * `photo` or `text_only` depending on whether an image landed — except for a
 * `custom_*` design, which keeps its own id because item O's auto-promotion
 * depends on being able to tell two custom designs apart.
 */
export function archetypeTokenFor(template: string, hasImage?: boolean | undefined): string {
  const token = templateBasename(template).replace(/-/gu, "_");
  if (token.startsWith("custom_")) return token;
  if (KNOWN_ARCHETYPE_TOKENS.has(token)) return token;
  return hasImage === true ? "photo" : "text_only";
}

/**
 * `"cover:cover>interior:stat_callout+bars>interior:photo>closer:closer"`.
 *
 * `role:archetype`, plus `+deviceKind` when the slide carried a device.
 * Including the device is what makes item P's own escape hatch real: a client
 * running a genuinely fixed weekly lane keeps its roles and archetypes and
 * still clears the distance floor by moving its devices, which is a real
 * change to what the reader sees, not a token trick.
 *
 * `roles` and `devices` are indexed positionally against `slides`; a short
 * array is read as "no role stated" / "no device", never as an error, because
 * a signature is written on the delivery path and must not be able to throw
 * there.
 */
export function skeletonSignature(
  slides: readonly SkeletonSlideInput[],
  roles: readonly SkeletonRole[] = rolesForSlideCount(slides.length),
  devices: readonly (string | undefined)[] = [],
): string {
  return slides
    .map((slide, i) => {
      const role = roles[i] ?? "interior";
      const device = devices[i];
      const suffix = device !== undefined && device !== "" ? `+${device}` : "";
      return `${role}:${archetypeTokenFor(slide.template, slide.hasImage)}${suffix}`;
    })
    .join(">");
}

/** The signature's tokens, for a caller comparing two skeletons position by position. */
export function skeletonTokens(signature: string): string[] {
  return signature === "" ? [] : signature.split(">");
}

/**
 * How different two skeletons are, 0 (identical) to 1 (nothing in common).
 *
 * Positional agreement over `role:archetype[+device]` tokens, with a position
 * present in only one of the two counting as a mismatch:
 *
 *     distance = ceil2(mismatchedPositions / max(lengthA, lengthB))
 *
 * ## Why the result is rounded UP to two decimals
 *
 * So that the threshold constant reads as the number of positions it means.
 * At six slides `1/6 = 0.1666…` and `2/6 = 0.3333…`; comparing a repeating
 * decimal against a hand-written 0.34 is how a rule that was supposed to mean
 * "two of six" silently starts meaning "three of six". Rounding up reports
 * 0.17 and 0.34 exactly, so `MIN_SKELETON_DISTANCE = 0.34` admits two
 * differing positions and refuses one. Up rather than down is also the safe
 * direction for a variety rule: the error can only ever let a post through,
 * never send a good one back.
 *
 * Measured, not asserted — the numbers this produces for six-slide posts:
 * identical 0, one swap 0.17, two swaps 0.34, three 0.5; six slides against
 * seven with two swaps 0.43.
 *
 * ## Why occupancy is not part of the distance
 *
 * `SkeletonEntry.occupancy` is recorded and it IS read back — onto the gate
 * and the deliverable as `previousOccupancy` (`skeletonGateFacts`), which is
 * how a reviewer sees whether the shapes as well as the sequence repeat. It
 * is deliberately kept out of this function: a measured share moves by a
 * percent or two between two renders of the same design, so mixing it into
 * the gating distance would make the refusal depend on pixel noise, and a
 * client running a genuinely stable weekly format would be sent back to the
 * writer for a difference no reader could see. Sequence gates; pixels report.
 */
export function skeletonDistance(a: Pick<SkeletonEntry, "signature">, b: Pick<SkeletonEntry, "signature">): number {
  const left = skeletonTokens(a.signature);
  const right = skeletonTokens(b.signature);
  const span = Math.max(left.length, right.length);
  if (span === 0) return 0;
  let mismatches = 0;
  for (let i = 0; i < span; i += 1) {
    if (left[i] !== right[i]) mismatches += 1;
  }
  return Math.ceil((mismatches / span) * 100) / 100;
}

/** Reads the history back out of a beliefs document, tolerating anything a past version or a hand edit left there — same contract as `readBudgetHistory`. */
export function readSkeletonHistory(beliefs: unknown): SkeletonHistory {
  const raw = beliefs !== null && typeof beliefs === "object" ? (beliefs as Record<string, unknown>)[SKELETON_BELIEF_KEY] : undefined;
  if (raw === null || typeof raw !== "object") return { version: 1, entries: [] };
  const rows = (raw as Record<string, unknown>)["entries"];
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
  const entries = Array.isArray(rows)
    ? rows.flatMap((row): SkeletonEntry[] => {
        if (row === null || typeof row !== "object") return [];
        const e = row as Record<string, unknown>;
        if (typeof e["runId"] !== "string" || typeof e["signature"] !== "string") return [];
        return [
          {
            runId: e["runId"],
            at: typeof e["at"] === "string" ? e["at"] : "",
            signature: e["signature"],
            archetypes: strings(e["archetypes"]),
            deviceKinds: strings(e["deviceKinds"]),
            roles: strings(e["roles"]).filter((r): r is SkeletonRole => r === "cover" || r === "interior" || r === "closer"),
            occupancy: Array.isArray(e["occupancy"])
              ? (e["occupancy"] as unknown[]).filter((n): n is number => typeof n === "number" && Number.isFinite(n))
              : [],
            edited: e["edited"] === true,
          },
        ];
      })
    : [];
  return { version: 1, entries: entries.slice(-SKELETON_HISTORY_LIMIT) };
}

/**
 * The history after one more shipped post — what `09b` writes back.
 *
 * Pure and IDEMPOTENT ON `runId`: `09b` is a checkpointed step whose belief
 * write is best-effort, so a resumed delivery replays it, and a second entry
 * for the same run would make the next run compare itself against itself.
 */
export function recordSkeleton(history: SkeletonHistory, entry: SkeletonEntry): SkeletonHistory {
  if (history.entries.some((e) => e.runId === entry.runId)) return history;
  return { version: 1, entries: [...history.entries, entry].slice(-SKELETON_HISTORY_LIMIT) };
}

/** The last `SKELETON_AVOID_WINDOW` signatures, NEWEST FIRST — the order the copy prompt's §21 avoid-list is read in. */
export function skeletonAvoidList(history: SkeletonHistory): string[] {
  return [...history.entries].reverse().slice(0, SKELETON_AVOID_WINDOW).map((e) => e.signature);
}

/** The immediately previous shipped post, or `undefined` on a client's first run. */
export function previousSkeleton(history: SkeletonHistory): SkeletonEntry | undefined {
  return history.entries[history.entries.length - 1];
}

/**
 * The `skeletonRule` sentence handed to `05-write-copy-attempt-N` alongside
 * `recentSkeletons`.
 *
 * Kept here rather than inlined at the call site so that the rule the writer
 * is told and the rule `checkSkeletonVariety` enforces are one string. A
 * prompt asking for something the code does not check (or checking something
 * the prompt never asked for) is the defect this whole phase keeps finding.
 * Mirrors `instagram-copy@14` §21 verbatim.
 */
export const SKELETON_RULE_SENTENCE =
  "These are the last five posts' slide skeletons. Do not reproduce any of them. At least two positions must differ from the most recent, and the cover's archetype must differ from last week's. Repetition is the single clearest tell that a feed is machine-made.";

/** What `07k-skeleton-variety-attempt-N` decided. */
export interface SkeletonVarietyVerdict {
  /** `false` only when the attempt must return to `05`. Never a hold: see `action`. */
  ok: boolean;
  /**
   * `pass` — nothing to say. `return` — `returnToCopyWith(reason)` then
   * `continue`. `warn` — ship it, but say so on the gate and in the ledger.
   * There is no `hold`: repetition is a design defect, not a compliance one,
   * and the run always delivers.
   */
  action: "pass" | "return" | "warn";
  kind?: "repeat" | "near-repeat";
  signature: string;
  previous?: string | undefined;
  /** Exact match with the immediately previous post — the brief's mandated refusal. */
  repeatedPrevious: boolean;
  distance?: number | undefined;
  /** The sentence that goes to `returnToCopyWith`, the ledger row and the gate. Carries BOTH sequences. */
  reason?: string | undefined;
  /** Never-failing observations: adjacent slides that repeat inside this carousel. Joined to `08b`'s input. */
  warnings: string[];
  /** The avoid-list, newest first, for the gate payload and the next redraft's input. */
  recent: string[];
  /**
   * The previous post's measured per-slide `occupiedShare`, when it recorded
   * any — the read side of `SkeletonEntry.occupancy`.
   *
   * Reported on the gate and the deliverable next to `previous`, so "are we
   * shipping the same shapes every week" is answerable from the portal rather
   * than only from a beliefs dump. Deliberately NOT folded into
   * `skeletonDistance`: see its doc comment.
   */
  previousOccupancy?: number[] | undefined;
}

/**
 * Two ADJACENT slides sharing an archetype token and landing in the same
 * occupancy bucket.
 *
 * A warning, never a failure. Several photo slides in a row are the normal
 * rhythm of a carousel (§7 says so explicitly); several photo slides in a row
 * that are all filled to the same degree is the "N variations of one slide"
 * the visual-QA judge is asked about. Buckets are tenths, because
 * `occupiedShare` is a measured share and a 1% difference is not a difference
 * a reader sees.
 *
 * `occupancy` is POSITIONAL and may carry holes: a slide whose PNG the
 * measurement could not read has no share, and a hole means "these two
 * cannot be compared", not "these two match". The caller therefore passes one
 * entry per slide in carousel order — `undefined` where the slide is in
 * `notMeasured` — rather than a compacted list, which would silently pair
 * slide 3 with slide 5. Called ONLY with measured shares, i.e. after the
 * render (`08a1e`): the pre-render `07k` has no pixels yet, which is why
 * every clause of this function is skipped when it is handed nothing.
 */
export function adjacentRepeatWarnings(signature: string, occupancy: readonly (number | undefined)[]): string[] {
  const tokens = skeletonTokens(signature);
  const warnings: string[] = [];
  for (let i = 1; i < tokens.length; i += 1) {
    if (tokens[i] !== tokens[i - 1]) continue;
    const a = occupancy[i - 1];
    const b = occupancy[i];
    if (a === undefined || b === undefined) continue;
    if (Math.round(a * 10) !== Math.round(b * 10)) continue;
    warnings.push(
      `slides ${i} and ${i + 1} are both "${tokens[i]}" and both fill about ${Math.round(a * 100)}% of the plate — adjacent slides that measure the same read as one slide shown twice`,
    );
  }
  return warnings;
}

/**
 * `07k-skeleton-variety-attempt-N`, as a pure function.
 *
 * Runs BEFORE the render, deliberately: a repeat costs no render at all, and
 * a returned attempt that has not yet spent Chromium is the cheapest possible
 * correction. It is deliberately NOT a `DEFAULT_RENDER_RULES` entry either —
 * a client with its own render rules must not lose this check, and `07h`'s
 * four-rule surface must not grow.
 *
 * * **Hard clause** — the signature is identical to the immediately previous
 *   post's. Returns to `05` naming both sequences, on any attempt but the
 *   last.
 * * **Soft clause** — `distance < MIN_SKELETON_DISTANCE`. Returns on attempt
 *   1 ONLY; from attempt 2 it degrades to a warning. Variety is enforced
 *   while it is free, never at the cost of the post.
 * * **Final attempt** — always `warn`. This must never become a fourth hold
 *   cause (`zero-held-guarantee.test.ts` names three).
 */
export function checkSkeletonVariety(
  history: SkeletonHistory,
  input: { signature: string; occupancy?: readonly (number | undefined)[] | undefined },
  opts: { attempt: number; maxAttempts: number },
): SkeletonVarietyVerdict {
  const recent = skeletonAvoidList(history);
  const warnings = adjacentRepeatWarnings(input.signature, input.occupancy ?? []);
  const previous = previousSkeleton(history);
  const base = {
    signature: input.signature,
    previous: previous?.signature,
    recent,
    warnings,
    ...(previous !== undefined && previous.occupancy.length > 0 ? { previousOccupancy: previous.occupancy } : {}),
  };

  // A client's first post has nothing to repeat. Both clauses inert, and the
  // step consumes nothing.
  if (previous === undefined) return { ...base, ok: true, action: "pass", repeatedPrevious: false };

  const distance = skeletonDistance({ signature: input.signature }, previous);
  const repeatedPrevious = distance === 0;
  const isFinalAttempt = opts.attempt >= opts.maxAttempts;

  if (repeatedPrevious) {
    const reason =
      `this carousel's layout sequence (${input.signature}) is identical to the previous post's (${previous.signature}) — ` +
      "change at least two slides' archetypes, starting with the cover";
    // On the FINAL attempt this degrades and ships (`ok: true`) — item L's
    // semantics, for the same reason: never a fourth hold cause.
    return { ...base, ok: isFinalAttempt, action: isFinalAttempt ? "warn" : "return", kind: "repeat", repeatedPrevious, distance, reason };
  }

  if (distance < MIN_SKELETON_DISTANCE) {
    const reason =
      `this carousel's layout sequence (${input.signature}) differs from the previous post's (${previous.signature}) in ` +
      `${Math.round(distance * skeletonTokens(input.signature).length)} of ${skeletonTokens(input.signature).length} positions ` +
      `(measured distance ${distance.toFixed(2)}, floor ${MIN_SKELETON_DISTANCE}) — change another slide's archetype or its device`;
    // Soft: attempt 1 pays a free redraft for it; later attempts do not.
    const returning = opts.attempt === 1 && !isFinalAttempt;
    return { ...base, ok: !returning, action: returning ? "return" : "warn", kind: "near-repeat", repeatedPrevious, distance, reason };
  }

  return { ...base, ok: true, action: warnings.length > 0 ? "warn" : "pass", repeatedPrevious, distance };
}

/**
 * `08a1e-skeleton-occupancy-attempt-N` — the PIXEL half of "the same
 * skeleton", folded back into the verdict `08b` and the gate read.
 *
 * `07k` runs before the render on purpose, so a repeated sequence costs no
 * Chromium at all. The price of that placement is that the third clause of
 * item P.2 — two ADJACENT slides sharing an archetype *and* landing in the
 * same occupancy bucket — cannot be evaluated there: the shares do not exist
 * yet. Left at that, `warnings` was structurally always empty,
 * `adjacentRepeatWarnings` was unreachable in production, and `08b` never
 * received the `skeletonWarnings` the spec required. So the clause is re-run
 * here, once, against `08a1`'s measured `occupiedShare` per slide.
 *
 * Never a failure and never a return: `ok` is untouched, a `pass` becomes a
 * `warn`, and an existing `return`/`warn` verdict keeps whatever the
 * cross-run clauses decided. Repetition inside one carousel is a note for the
 * judge and the reviewer, not a reason to spend another draft.
 */
export function withMeasuredOccupancy(
  verdict: SkeletonVarietyVerdict,
  occupancy: readonly (number | undefined)[],
): SkeletonVarietyVerdict {
  const measured = adjacentRepeatWarnings(verdict.signature, occupancy);
  const added = measured.filter((w) => !verdict.warnings.includes(w));
  if (added.length === 0) return verdict;
  return {
    ...verdict,
    warnings: [...verdict.warnings, ...added],
    action: verdict.action === "pass" ? "warn" : verdict.action,
  };
}

/**
 * The `skeleton` block on the `09a` gate payload and on the deliverable
 * (item P.3) — the first time "are we shipping the same post every week" is
 * answerable from the portal.
 */
export function skeletonGateFacts(verdict: SkeletonVarietyVerdict): {
  signature: string;
  previous?: string | undefined;
  repeatedPrevious: boolean;
  distance?: number | undefined;
  recent: string[];
  previousOccupancy?: number[] | undefined;
  /** The within-carousel adjacency notes, measured at `08a1e`. Present only when there are any. */
  warnings?: string[] | undefined;
} {
  // Absent keys, never `undefined` ones: this object crosses a JSON gate
  // payload and a persisted deliverable, and a serializer that maps
  // `undefined` to `null` would make "this client has no previous post" read
  // as a previous post whose signature was null.
  return {
    signature: verdict.signature,
    ...(verdict.previous !== undefined ? { previous: verdict.previous } : {}),
    repeatedPrevious: verdict.repeatedPrevious,
    ...(verdict.distance !== undefined ? { distance: verdict.distance } : {}),
    recent: verdict.recent,
    ...(verdict.previousOccupancy !== undefined && verdict.previousOccupancy.length > 0
      ? { previousOccupancy: verdict.previousOccupancy }
      : {}),
    ...(verdict.warnings.length > 0 ? { warnings: verdict.warnings } : {}),
  };
}

/**
 * The entry `09b` records, assembled from what is already in scope there.
 *
 * `edited` comes from `hasReviewEdits`, `occupancy` from item L's per-slide
 * metrics (omitted rather than zero-filled when the measurement did not
 * happen, so a reader of the history can tell "flat" from "unmeasured").
 */
export function buildSkeletonEntry(input: {
  runId: string;
  at: string;
  slides: readonly SkeletonSlideInput[];
  roles?: readonly SkeletonRole[] | undefined;
  devices?: readonly (string | undefined)[] | undefined;
  occupancy?: readonly number[] | undefined;
  edited: boolean;
}): SkeletonEntry {
  const roles = input.roles ?? rolesForSlideCount(input.slides.length);
  const devices = input.devices ?? [];
  return {
    runId: input.runId,
    at: input.at,
    signature: skeletonSignature(input.slides, roles, devices),
    archetypes: input.slides.map((slide) => archetypeTokenFor(slide.template, slide.hasImage)),
    deviceKinds: input.slides.map((_, i) => devices[i] ?? ""),
    roles: [...roles],
    occupancy: (input.occupancy ?? []).map((n) => Math.round(n * 100) / 100),
    edited: input.edited,
  };
}
