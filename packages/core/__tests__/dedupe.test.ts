import { describe, expect, it } from "vitest";
import { DEDUPE_SIMILARITY_THRESHOLD } from "../src/agent-definitions/similarity.js";
import { evaluateDedupe } from "../src/agent-definitions/dedupe.js";

/**
 * The verdict layer over the trigram measure. `similarity.test.ts` pins the
 * score itself; what is worth pinning here is everything the verdict says
 * ABOUT that score — because those are the parts a human reads when deciding
 * whether a flagged draft is actually a repeat.
 */

const PARAGRAPH =
  "The team shipped the new billing dashboard this week, cutting invoice reconciliation from three days to under an hour for finance.";

describe("evaluateDedupe", () => {
  it("reports no_history for an agent's first run rather than a pass", () => {
    // "Nothing to compare against" and "compared and found nothing similar"
    // are different facts. Collapsing them would let a first run read as
    // having cleared a check it never ran.
    const verdict = evaluateDedupe(PARAGRAPH, []);

    expect(verdict.status).toBe("no_history");
    expect(verdict.comparedCount).toBe(0);
    expect(verdict.maxSimilarity).toBe(0);
  });

  it("flags a near-identical deliverable and names the run it matched", () => {
    const verdict = evaluateDedupe(PARAGRAPH, [
      { runId: "run-old", excerpt: PARAGRAPH },
      { runId: "run-unrelated", excerpt: "Hiring two backend engineers in Tel Aviv this quarter." },
    ]);

    expect(verdict.status).toBe("similar");
    expect(verdict.mostSimilarRunId).toBe("run-old");
    expect(verdict.comparedCount).toBe(2);
    expect(verdict.maxSimilarity).toBeGreaterThanOrEqual(DEDUPE_SIMILARITY_THRESHOLD);
  });

  it("passes a genuinely different deliverable and names nothing", () => {
    const verdict = evaluateDedupe(PARAGRAPH, [
      { runId: "run-old", excerpt: "Our office is closed on Monday for the public holiday." },
    ]);

    expect(verdict.status).toBe("ok");
    // No `mostSimilarRunId` on a pass: pointing at a run that was NOT a match
    // is how a reader concludes there was one.
    expect(verdict.mostSimilarRunId).toBeUndefined();
    expect(verdict.comparedCount).toBe(1);
  });

  it("reports zero compared for an empty deliverable even when history exists", () => {
    // comparedCount states what was actually compared, so it can never
    // contradict the status printed beside it.
    const verdict = evaluateDedupe("   \n  ", [{ runId: "run-old", excerpt: PARAGRAPH }]);

    expect(verdict.status).toBe("no_history");
    expect(verdict.comparedCount).toBe(0);
  });

  it("always reports the threshold it judged against", () => {
    // The score alone is unreadable without it, and the constant may be
    // retuned — a verdict recorded on a run has to stay interpretable later.
    for (const history of [[], [{ runId: "r", excerpt: PARAGRAPH }]]) {
      expect(evaluateDedupe(PARAGRAPH, history).threshold).toBe(DEDUPE_SIMILARITY_THRESHOLD);
    }
  });

  it("takes the closest match, not the first, when several are close", () => {
    const verdict = evaluateDedupe(PARAGRAPH, [
      { runId: "run-partial", excerpt: `${PARAGRAPH.slice(0, 60)} and then something else entirely happened.` },
      { runId: "run-exact", excerpt: PARAGRAPH },
    ]);

    expect(verdict.mostSimilarRunId).toBe("run-exact");
  });

  it("never throws — a repeated theme is a flag, not a failure", () => {
    // The whole contract: unlike the topic guardrail, this module has no path
    // that stops a run. If that ever changes it should break here first.
    expect(() => evaluateDedupe(PARAGRAPH, [{ runId: "x", excerpt: PARAGRAPH }])).not.toThrow();
    expect(evaluateDedupe(PARAGRAPH, [{ runId: "x", excerpt: PARAGRAPH }]).status).toBe("similar");
  });
});
