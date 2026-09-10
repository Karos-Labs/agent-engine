import type { CompletionResult } from "@agent-engine/core";
import { finalTurn, goodCopyOutput, goodImageVettingOutput, goodRelevanceVerdict, goodResearchOutput, goodTrendScoutOutput, goodVisualQaOutput } from "./test-helpers.js";

/**
 * The fake router's turn list, in the order the Phase 0 workflow consumes
 * model calls (RFC-13, 2026-09).
 *
 * Every workflow-level test used to queue its turns positionally — research,
 * copy, vet, visual QA — and every unconditional new model step (the trend
 * scout at `03c`, the relevance judge at `07g`) shifts that order for thirty
 * files at once. Naming the turns here means a fixture says WHICH call it is
 * answering, and a new step is one key added in one place.
 *
 * Execution order (omitted keys are skipped — a test that stops before a step,
 * or a run whose pool is empty and so skips `06`, simply leaves the key out):
 *
 *   scout      03c-trend-scout            (every run; skipped by the workflow only when 03b fetched no documents)
 *   research   04b-research-extract-facts
 *   copy       05-write-copy-attempt-N
 *   vet        06-vet-images-attempt-N    (skipped by the workflow when the candidate pool is empty)
 *   relevance  07g-relevance-attempt-N
 *   fluency    07f-language-fluency-attempt-N (non-English targets only)
 *   qa         08b-visual-qa-attempt-N
 *
 * A test that needs a SECOND attempt appends another `standardTurns({ copy, vet, … })`
 * without `scout`/`research` — those run once per run, not once per attempt.
 */
export interface StandardTurnFixtures {
  scout?: unknown;
  research?: unknown;
  copy?: unknown;
  vet?: unknown;
  relevance?: unknown;
  fluency?: unknown;
  qa?: unknown;
}

export const PHASE0_TURN_ORDER = ["scout", "research", "copy", "vet", "relevance", "fluency", "qa"] as const satisfies ReadonlyArray<keyof StandardTurnFixtures>;

/** `finalTurn(...)` entries for the supplied fixtures, in execution order. */
export function standardTurns(fixtures: StandardTurnFixtures): Array<() => CompletionResult<unknown>> {
  const turns: Array<() => CompletionResult<unknown>> = [];
  for (const key of PHASE0_TURN_ORDER) {
    if (key in fixtures && fixtures[key] !== undefined) turns.push(finalTurn(fixtures[key]));
  }
  return turns;
}

/**
 * The canonical happy path for an English-language client with a candidate
 * pool: scout, research, copy, vet, relevance, QA. `overrides` replaces a
 * fixture by key (`{ vet: myVetting }`); set a key to `undefined` to drop it.
 */
export function happyTurns(overrides: StandardTurnFixtures = {}): Array<() => CompletionResult<unknown>> {
  return standardTurns({
    scout: goodTrendScoutOutput(),
    research: goodResearchOutput(),
    copy: goodCopyOutput(),
    vet: goodImageVettingOutput(),
    relevance: goodRelevanceVerdict(),
    qa: goodVisualQaOutput(),
    ...overrides,
  });
}
