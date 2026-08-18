import { checkSlidesData } from "../../src/workflow/slides-data.js";
import type { InstagramDeterministicAssertionResult, InstagramGoldenRun } from "./types.js";

/**
 * Deterministic assertions for the Instagram agent (RFC-01 §12 bullet 2):
 * the exact step-07 self-check (`checkSlidesData`) plus a couple of
 * mechanical invariants (canvas scale, no unfillable slide) run against a
 * golden run's endorsed research/copy/image-selection triple. Fast, free,
 * zero model cost — and exactly the same function the real workflow's step
 * 07 runs on every attempt, so a regression here is a regression there too.
 */
export function runInstagramDeterministicAssertions(goldenRun: InstagramGoldenRun): InstagramDeterministicAssertionResult[] {
  const results: InstagramDeterministicAssertionResult[] = [];
  const { id, styleConfig, research, endorsedCopy, endorsedSelections } = goldenRun;

  const selfCheck = checkSlidesData(endorsedCopy, endorsedSelections.selections, research, styleConfig);
  results.push(
    selfCheck.ok
      ? { goldenRunId: id, check: "step07.checkSlidesData", verdict: "pass" }
      : { goldenRunId: id, check: "step07.checkSlidesData", verdict: "content_fail", reason: selfCheck.reason },
  );

  results.push(
    styleConfig.canvas.scale === 2
      ? { goldenRunId: id, check: "canvas.scale", verdict: "pass" }
      : { goldenRunId: id, check: "canvas.scale", verdict: "content_fail", reason: `scale is ${styleConfig.canvas.scale}, not 2` },
  );

  const unfillable = endorsedSelections.selections.filter((s) => s.imagePath === null);
  results.push(
    unfillable.length === 0
      ? { goldenRunId: id, check: "no-unfillable-slide", verdict: "pass" }
      : { goldenRunId: id, check: "no-unfillable-slide", verdict: "content_fail", reason: `slide(s) ${unfillable.map((s) => s.n).join(", ")} are unfillable` },
  );

  return results;
}
