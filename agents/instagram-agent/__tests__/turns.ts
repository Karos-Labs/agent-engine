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
 *   concept    04m-design-concept         (Phase 4; once per REVISION, and ONLY when `04l` found the story eligible — most fixtures omit it)
 *   copy       05-write-copy-attempt-N
 *   vet        06-vet-images-attempt-N    (skipped by the workflow when the candidate pool is empty)
 *   relevance  07g-relevance-attempt-N
 *   fluency    07f-language-fluency-attempt-N (non-English targets only)
 *   qa         08b-visual-qa-attempt-N
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
  /**
   * RFC-16 Phase 4, `04m` — the concept direction, once per REVISION.
   *
   * Deliberately NOT in `happyTurns`: `04l-concept-eligibility` declines on
   * the canonical story (no rivalry, no reversal, no recognised entity), so
   * the workflow buys no turn and a queued one would desynchronise every
   * later fixture. A test that wants the concept path must both make its
   * story eligible AND pass this key.
   */
  concept?: unknown;
  copy?: unknown;
  vet?: unknown;
  relevance?: unknown;
  fluency?: unknown;
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
  // Phase 4's `04m-design-concept` sits between the angle and the copy
  // because that is where the workflow places it: `04l` scores the story off
  // the CHOSEN angle, and `04n` applies the result after copy is accepted.
  "concept",
  "copy",
  "vet",
  "relevance",
  "fluency",
  "qa",
] as const satisfies ReadonlyArray<keyof StandardTurnFixtures>;

/** Which keys carry a LIST of turns rather than one. Named explicitly rather than sniffed with `Array.isArray`, so a fixture whose model output happens to be an array is never silently spread into several turns. */
const VARIADIC_TURN_KEYS: ReadonlySet<keyof StandardTurnFixtures> = new Set(["templateDesign", "templateRepair"]);

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
