import { describe, expect, it } from "vitest";
import {
  movementDirective,
  movementSources,
  readPreviousRun,
  scoreMovement,
  type SeoGeoCurrentRun,
  type SeoGeoPreviousRun,
} from "../src/workflow/previous-run.js";

/**
 * The defect this exists for, measured in prep.
 *
 * karoslabs ran the SEO & GEO audit four times — 15, 17 and 18 September and
 * again on the 20th. Every report opened on the same sentence and ran to the
 * same length, because the narrative agent's input carried this run's numbers
 * and nothing else: identical inputs, identical prose. Meanwhile the prompt's
 * closing line promised the client that "the next run will compare against
 * this one", and step 20 had been writing exactly the snapshot needed to do it
 * since the agent shipped. Nothing read it back.
 */

const PREVIOUS: SeoGeoPreviousRun = {
  runId: "pubsub-21855989607447461",
  recordedAt: "2026-09-15T12:08:11.004Z",
  seoScore: 30,
  seoDataCoveragePct: 62,
  geoReadinessScore: 19,
  geoDataCoveragePct: 48,
  visibilityIndex: 7,
};

const CURRENT: SeoGeoCurrentRun = {
  seoScore: 34,
  seoDataCoveragePct: 62,
  geoReadinessScore: 19,
  geoDataCoveragePct: 48,
  visibilityIndex: 7,
};

const beliefsWith = (snapshot: unknown): Record<string, unknown> => ({
  seoGeoFrozenPromptSet: { prompts: [] },
  seoGeoLatestSnapshot: snapshot,
});

describe("readPreviousRun", () => {
  it("reads the snapshot step 20 has been writing all along", () => {
    const previous = readPreviousRun(beliefsWith({ ...PREVIOUS }), "pubsub-new");
    expect(previous).toEqual(PREVIOUS);
  });

  it("refuses a snapshot this very run wrote", () => {
    // A resumed run replays its steps. Without this, a resume after step 20
    // compares the run against itself and reports that nothing moved — true,
    // and the most misleading possible answer.
    expect(readPreviousRun(beliefsWith({ ...PREVIOUS }), PREVIOUS.runId)).toBeUndefined();
  });

  it("returns nothing for a first run, and for a record written before these fields existed", () => {
    expect(readPreviousRun({}, "r1")).toBeUndefined();
    expect(readPreviousRun(beliefsWith(null), "r1")).toBeUndefined();
    expect(readPreviousRun(beliefsWith({ runId: "old", recordedAt: "2026-01-01T00:00:00Z" }), "r1")).toBeUndefined();
  });

  it("treats a missing visibility index as absent, not as zero", () => {
    // An unmeasured AI visibility is not a visibility of 0, and the difference
    // is the whole reason the report nulls the index rather than printing it.
    const previous = readPreviousRun(beliefsWith({ ...PREVIOUS, visibilityIndex: null }), "r1");
    expect(previous?.visibilityIndex).toBeNull();
  });
});

describe("scoreMovement", () => {
  it("computes the deltas the summary is forbidden to compute itself", () => {
    const movement = scoreMovement(PREVIOUS, CURRENT);
    expect(movement.seoDelta).toBe(4);
    expect(movement.geoDelta).toBe(0);
    expect(movement.visibilityDelta).toBe(0);
    expect(movement.unchanged).toBe(false);
  });

  it("calls a month flat only when every score held", () => {
    const flat = scoreMovement(PREVIOUS, { ...CURRENT, seoScore: PREVIOUS.seoScore });
    expect(flat.unchanged).toBe(true);
  });

  it("does not call a run unchanged on the strength of an unmeasured index", () => {
    const movement = scoreMovement({ ...PREVIOUS, visibilityIndex: null }, { ...CURRENT, seoScore: 30, visibilityIndex: null });
    expect(movement.visibilityDelta).toBeNull();
    expect(movement.unchanged).toBe(true);
  });

  it("notices when the two runs measured different amounts", () => {
    const movement = scoreMovement(PREVIOUS, { ...CURRENT, seoDataCoveragePct: 88 });
    expect(movement.coverageChanged).toBe(true);
  });
});

describe("movementDirective", () => {
  it("names the movement and the date it is measured from", () => {
    const directive = movementDirective(scoreMovement(PREVIOUS, CURRENT))!;
    expect(directive).toContain("SEO up 4");
    expect(directive).toContain("GEO Readiness unchanged");
    expect(directive).toContain("15 September 2026");
    expect(directive).toContain("like-for-like");
  });

  it("says a flat month is flat, and forbids dressing it up", () => {
    const directive = movementDirective(scoreMovement(PREVIOUS, { ...CURRENT, seoScore: PREVIOUS.seoScore }))!;
    expect(directive).toMatch(/identical to the previous run/i);
    expect(directive).toMatch(/do not manufacture/i);
  });

  it("warns that a coverage change is not the site improving", () => {
    // The trap this closes: the score counts an unmeasured check as zero, so
    // connecting Search Console raises it while nothing about the site moved.
    // A summary reporting that as progress is a false claim to the client.
    const directive = movementDirective(scoreMovement(PREVIOUS, { ...CURRENT, seoDataCoveragePct: 88 }))!;
    expect(directive).toMatch(/not a like-for-like/i);
    expect(directive).toMatch(/never present it as the site having improved/i);
  });

  it("tells a first run to set a baseline and imply no trend", () => {
    const directive = movementDirective(undefined)!;
    expect(directive).toMatch(/FIRST measured run/);
    expect(directive).toMatch(/do not imply any trend/i);
  });
});

describe("movementSources", () => {
  it("lets the numbers gate accept the sentence this feature exists to produce", () => {
    // `gate.numbersSourced` rejects any figure it cannot trace to the inputs.
    // The delta is a figure the summary was HANDED, but it appears in no other
    // source list — without this the gate refuses the opening sentence.
    const sources = movementSources(scoreMovement(PREVIOUS, CURRENT));
    expect(sources).toContain("4"); // the SEO movement
    expect(sources).toContain("30"); // the previous score it moved from
    expect(sources).toContain("62%"); // the coverage that previous score carried
  });

  it("adds nothing on a first run", () => {
    expect(movementSources(undefined)).toEqual([]);
  });
});
