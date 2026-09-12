import type { CompletionResult } from "@agent-engine/core";
import { finalTurn, goodCopyOutput, goodImageVettingOutput, goodRelevanceVerdict, goodResearchOutput, goodTrendScoutOutput, goodVisualQaOutput } from "./test-helpers.js";
import { goodAngleProposal } from "./angle-fixtures.js";

/**
 * The fake router's turn list, in the order the workflow consumes model
 * calls (RFC-13, Phase 0 + Phase 1, 2026-09).
 *
 * Every workflow-level test used to queue its turns positionally — research,
 * copy, vet, visual QA — and every unconditional new model step (the trend
 * scout at `03c`, the relevance judge at `07g`, the angle proposal at `04i`)
 * shifts that order for thirty files at once. Naming the turns here means a
 * fixture says WHICH call it is answering, and a new step is one key added in
 * one place.
 *
 * Execution order (omitted keys are skipped — a test that stops before a step,
 * or a run whose pool is empty and so skips `06`, simply leaves the key out):
 *
 *   brief          00b2-write-client-brief    (Phase 1; only when the client has no fresh brief — `setupTestEnvironment` seeds one, so most fixtures omit it)
 *   designBrief    00c3-write-design-brief    (Phase 2 item N, SETUP budget; only when `00c` resolved `generate`)
 *   templateDesign 00c4-design-template-<id>  (Phase 2 item N; ONE PER TEMPLATE, so this key takes an ARRAY)
 *   setReview      00c6-review-template-set   (Phase 2 item N; skipped when the setup budget turned the set review off)
 *   templateRepair 00c7-repair-template-<id>  (Phase 2 item N; at most two per setup, so this key takes an ARRAY too)
 *   artDirection   00d2-derive-visual-direction (Phase 3 item Q, SETUP budget; only when `00d` resolved `derive` — `setupTestEnvironment` seeds a fresh direction, so most fixtures omit it)
 *   scout          03c-trend-scout            (every run; skipped by the workflow only when 03b fetched no documents)
 *   research   04b-research-extract-facts
 *   angle      04i-propose-angles         (Phase 1; once per REVISION, not per attempt)
 *   copy       05-write-copy-attempt-N
 *   vet        06-vet-images-attempt-N    (skipped by the workflow when the candidate pool is empty)
 *   relevance  07g-relevance-attempt-N
 *   nativeEditor 07f-language-fluency-attempt-N (+ `-round-2`) (non-English targets only; ARRAY — one entry per judge round)
 *   qa         08b-visual-qa-attempt-N
 *
 * Phase 4 (RFC-15 §6.5) RENAMED `fluency` to `nativeEditor` IN PLACE and made
 * it variadic. The position in `TURN_ORDER` is unchanged and no key was
 * inserted, which is the whole point: the ~30 files this module's warning is
 * about queue their turns through `standardTurns`, and a reorder or an
 * insertion shifts every one of them by a turn. A rename is a compile error in
 * the files that used the old key and a no-op everywhere else.
 *
 * It is an ARRAY because `07f` now runs up to twice inside one attempt: round
 * 1 judges the draft, and when it proposes corrections they are applied in
 * place and round 2 judges the patched copy under
 * `07f-language-fluency-attempt-N-round-2`. `[verdict]` is a one-round
 * fixture; `[round1, round2]` is a two-round one.
 *
 * A test that needs a SECOND attempt appends another `standardTurns({ copy, vet, … })`
 * without `scout`/`research`/`angle` — those run once per run (or, for the
 * angle, once per revision), not once per attempt. A test that needs a second
 * REVISION round appends `standardTurns({ angle, copy, vet, … })`.
 */
export interface StandardTurnFixtures {
  brief?: unknown;
  /** RFC-14 item N, `00c3`. */
  designBrief?: unknown;
  /** RFC-14 item N, `00c4` — one turn PER TEMPLATE (4-6 of them), so the fixture is an array and `standardTurns` emits one turn per entry. */
  templateDesign?: readonly unknown[];
  /** RFC-14 item N, `00c6`. */
  setReview?: unknown;
  /** RFC-14 item N, `00c7` — at most two repairs per setup, one turn each. */
  templateRepair?: readonly unknown[];
  /** RFC-14 item Q, `00d2` — one turn per client per 90 days, on the SETUP budget. */
  artDirection?: unknown;
  scout?: unknown;
  research?: unknown;
  angle?: unknown;
  copy?: unknown;
  vet?: unknown;
  relevance?: unknown;
  /** RFC-15 §6.5, `07f` — ONE ENTRY PER JUDGE ROUND (round 1, optionally round 2 on the corrected copy). */
  nativeEditor?: readonly unknown[];
  qa?: unknown;
}

/**
 * The order `standardTurns` emits its fixtures in — the order the workflow
 * consumes them.
 *
 * The four Template Studio keys sit immediately AFTER `brief` and before
 * `scout`, because that is where they actually run: the studio steps are
 * `00c*`, which the workflow places after `00b3-persist-client-brief` (so the
 * studio reads a fresh brief and the frozen brand kit) and before
 * `03-claim-topic`. Putting them at the front would be wrong in exactly the
 * way this module exists to prevent — a fixture whose turn list is off by one
 * because a new step was assumed to run first.
 */
export const TURN_ORDER = [
  "brief",
  "designBrief",
  "templateDesign",
  "setReview",
  "templateRepair",
  // Phase 3 item Q's `00d2` runs immediately after the studio block and
  // before `03-claim-topic`, on the same setup meter — so its turn sits here,
  // after `templateRepair` and before `scout`.
  "artDirection",
  "scout",
  "research",
  "angle",
  "copy",
  "vet",
  "relevance",
  // Phase 4 renamed this slot `fluency` -> `nativeEditor` and made it variadic. It did NOT move, and nothing
  // was inserted around it: `07f` still runs where it ran, between the relevance judge and the visual QA.
  "nativeEditor",
  "qa",
] as const satisfies ReadonlyArray<keyof StandardTurnFixtures>;

/** Which keys carry a LIST of turns rather than one. Named explicitly rather than sniffed with `Array.isArray`, so a fixture whose model output happens to be an array is never silently spread into several turns. */
const VARIADIC_TURN_KEYS: ReadonlySet<keyof StandardTurnFixtures> = new Set(["templateDesign", "templateRepair", "nativeEditor"]);

/** `finalTurn(...)` entries for the supplied fixtures, in execution order. */
export function standardTurns(fixtures: StandardTurnFixtures): Array<() => CompletionResult<unknown>> {
  const turns: Array<() => CompletionResult<unknown>> = [];
  for (const key of TURN_ORDER) {
    if (!(key in fixtures)) continue;
    const value = fixtures[key];
    if (value === undefined) continue;
    if (VARIADIC_TURN_KEYS.has(key)) {
      for (const entry of value as readonly unknown[]) turns.push(finalTurn(entry));
      continue;
    }
    turns.push(finalTurn(value));
  }
  return turns;
}

/**
 * The canonical happy path for an English-language client with a candidate
 * pool: scout, research, angle, copy, vet, relevance, QA. `overrides`
 * replaces a fixture by key (`{ vet: myVetting }`); set a key to `undefined`
 * to drop it.
 *
 * No `brief` turn by default: `setupTestEnvironment` seeds a fresh persisted
 * brief, so `00b-check-client-brief` resolves to `reuse` and `00b2` never
 * runs. A fixture that wants the create path passes `seedBrief: false` there
 * AND a `brief` fixture here.
 *
 * No Template Studio turns by default either, for the same reason and the
 * same shape: `setupTestEnvironment` seeds a fresh APPROVED studio set, so
 * `00c-check-template-studio` resolves to `reuse` and `00c3`-`00c7` never
 * run. A fixture that wants the generate path passes `seedStudio: false`
 * there AND `designBrief`/`templateDesign`/`setReview` fixtures here.
 *
 * The `angle` IS in the default, because `04i-propose-angles` runs on every
 * revision of every run (once per revision, never per attempt).
 */
export function happyTurns(overrides: StandardTurnFixtures = {}): Array<() => CompletionResult<unknown>> {
  return standardTurns({
    scout: goodTrendScoutOutput(),
    research: goodResearchOutput(),
    angle: goodAngleProposal(),
    copy: goodCopyOutput(),
    vet: goodImageVettingOutput(),
    relevance: goodRelevanceVerdict(),
    qa: goodVisualQaOutput(),
    ...overrides,
  });
}
