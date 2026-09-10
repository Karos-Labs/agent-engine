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
 *   brief      00b2-write-client-brief    (Phase 1; only when the client has no fresh brief — `setupTestEnvironment` seeds one, so most fixtures omit it)
 *   scout      03c-trend-scout            (every run; skipped by the workflow only when 03b fetched no documents)
 *   research   04b-research-extract-facts
 *   angle      04i-propose-angles         (Phase 1; once per REVISION, not per attempt)
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
  scout?: unknown;
  research?: unknown;
  angle?: unknown;
  copy?: unknown;
  vet?: unknown;
  relevance?: unknown;
  fluency?: unknown;
  qa?: unknown;
}

/** The order `standardTurns` emits its fixtures in — the order the workflow consumes them. */
export const TURN_ORDER = ["brief", "scout", "research", "angle", "copy", "vet", "relevance", "fluency", "qa"] as const satisfies ReadonlyArray<keyof StandardTurnFixtures>;

/** `finalTurn(...)` entries for the supplied fixtures, in execution order. */
export function standardTurns(fixtures: StandardTurnFixtures): Array<() => CompletionResult<unknown>> {
  const turns: Array<() => CompletionResult<unknown>> = [];
  for (const key of TURN_ORDER) {
    if (key in fixtures && fixtures[key] !== undefined) turns.push(finalTurn(fixtures[key]));
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
