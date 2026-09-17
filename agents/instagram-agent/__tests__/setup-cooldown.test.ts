import { describe, expect, it } from "vitest";
import {
  SETUP_FAILURE_BACKOFF_RUNS,
  STUDIO_EMPTY_SETUP_COOLDOWN_DAYS,
  checkTemplateStudio,
  classifySetupAttempt,
  type StudioSetupAttempt,
} from "../src/workflow/template-studio.js";
import {
  VISUAL_DIRECTION_ATTEMPT_BELIEF_KEY,
  VISUAL_DIRECTION_RETRY_DAYS,
  checkVisualDirection,
  type VisualDirectionAttempt,
} from "../src/workflow/visual-direction.js";

/**
 * Phase 5.5, item D1 — **a technical failure is not a judgement, and must not
 * buy a lockout.**
 *
 * The evidence these cases are built from, in full, because the numbers are
 * what make them falsifiable rather than tasteful. On 2026-09-16 three prep
 * clients (karoslabs, thepitchbydeel, geektime) ran the per-client setup.
 * `00b2-write-client-brief` (ceiling 8,000), `00c3-write-design-brief`
 * (4,000) and `00d2-derive-visual-direction` (3,000) all returned
 * `tooling_error` — every one of them out of output tokens against its own
 * schema, which `setup-ceilings.test.ts` now measures. Each run then wrote
 * the two markers this file is about:
 *
 * - a setup record with `templatesStored: 0`, which `checkTemplateStudio`
 *   read as "a setup ran and produced nothing" and answered with a 30-day
 *   cooldown;
 * - a visual-direction attempt marker, whose mere PRESENCE suppressed the
 *   re-derivation for 7 days.
 *
 * So the fix for the ceilings — a one-line change per agent — could not have
 * taken effect for a month. All three posts shipped on bundled archetypes and
 * the brand-kit fallback direction, which is most of why the owner could see
 * that one machine had written all three.
 *
 * Every case below therefore fixes the OTHER inputs and varies only the
 * outcome: same timestamp, same `templatesStored: 0`, same marker age. If the
 * discrimination stopped working, the "failed" cases would go green by
 * accident — which is what the premise assertions guard against.
 */

const NOW = new Date("2026-09-16T18:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

/** A tooling error, exactly as 2026-09-16 wrote it: nothing stored, and now SAYING so. */
function failedAttempt(days: number, status: "tooling_error" | "budget_exceeded" | "content_fail" = "tooling_error"): StudioSetupAttempt {
  return {
    at: daysAgo(days),
    templatesStored: 0,
    outcome: { kind: "failed", status, reason: "00c3-write-design-brief returned tooling_error (hit the 4,000-token output ceiling)" },
  };
}

/** The studio ran, authored candidates, and the eight gates dropped every one. Nothing about tomorrow changes that. */
function emptyAttempt(days: number): StudioSetupAttempt {
  return {
    at: daysAgo(days),
    templatesStored: 0,
    outcome: { kind: "empty", reason: "six candidates authored, all six failed the interest floor at their declared role" },
  };
}

/** A record written before this discrimination existed: `templatesStored` and nothing else. */
function legacyAttempt(days: number): StudioSetupAttempt {
  return { at: daysAgo(days), templatesStored: 0 };
}

describe("the Template Studio cooldown discriminates a failure from an empty answer", () => {
  it("THE PREMISE: the failed and the empty attempt are identical apart from `outcome`", () => {
    // If this ever stops holding, every case below is testing two variables at
    // once and the green is worth nothing.
    const failed = failedAttempt(1);
    const empty = emptyAttempt(1);
    expect(failed.templatesStored).toBe(empty.templatesStored);
    expect(failed.at).toBe(empty.at);
    expect(classifySetupAttempt(failed)).toBe("failed");
    expect(classifySetupAttempt(empty)).toBe("empty");
  });

  it("a `failed` setup does NOT start a cooldown: the next run tries again", () => {
    const check = checkTemplateStudio({ rows: [], now: NOW, setupHistory: [failedAttempt(1)] });
    expect(check.action).toBe("generate");
    expect(check.reason).toContain("no studio templates for this client yet");
  });

  it.each(["tooling_error", "budget_exceeded", "content_fail"] as const)("...for any failure status (%s)", (status) => {
    expect(checkTemplateStudio({ rows: [], now: NOW, setupHistory: [failedAttempt(0, status)] }).action).toBe("generate");
  });

  it("an `empty` setup DOES start one, and it holds for exactly STUDIO_EMPTY_SETUP_COOLDOWN_DAYS", () => {
    const held = checkTemplateStudio({ rows: [], now: NOW, setupHistory: [emptyAttempt(1)] });
    expect(held.action).toBe("reuse");
    expect(held.reason).toContain("ran and stored no templates");
    // The boundary, both sides of it.
    expect(checkTemplateStudio({ rows: [], now: NOW, setupHistory: [emptyAttempt(STUDIO_EMPTY_SETUP_COOLDOWN_DAYS - 1)] }).action).toBe("reuse");
    expect(checkTemplateStudio({ rows: [], now: NOW, setupHistory: [emptyAttempt(STUDIO_EMPTY_SETUP_COOLDOWN_DAYS)] }).action).toBe("generate");
  });

  it("`refreshTemplates` still overrides the cooldown immediately", () => {
    const check = checkTemplateStudio({ rows: [], now: NOW, refreshRequested: true, setupHistory: [emptyAttempt(0)] });
    expect(check.action).toBe("generate");
  });

  it("a LEGACY record (no outcome) never locks a client out — the three clients on disk today are all tooling errors", () => {
    expect(classifySetupAttempt(legacyAttempt(1))).toBe("unknown");
    expect(checkTemplateStudio({ rows: [], now: NOW, setupHistory: [legacyAttempt(1)] }).action).toBe("generate");
  });

  it("a legacy record that DID store templates still reads as `stored`, so a deletion still regenerates", () => {
    const stored: StudioSetupAttempt = { at: daysAgo(2), templatesStored: 6 };
    expect(classifySetupAttempt(stored)).toBe("stored");
    expect(checkTemplateStudio({ rows: [], now: NOW, setupHistory: [stored] }).action).toBe("generate");
  });

  it("BREAK THE CODE: restore the old rule and the same fixture is suppressed", () => {
    // The old rule, verbatim in behaviour: `templatesStored === 0` inside the
    // window means reuse, whatever happened. Re-implemented here rather than
    // described, so the case fails if the two ever converge again.
    const oldRuleSuppresses = (attempt: StudioSetupAttempt): boolean => {
      const ageDays = Math.floor((NOW.getTime() - Date.parse(attempt.at)) / DAY_MS);
      return attempt.templatesStored === 0 && ageDays >= 0 && ageDays < STUDIO_EMPTY_SETUP_COOLDOWN_DAYS;
    };
    const failed = failedAttempt(1);
    expect(oldRuleSuppresses(failed)).toBe(true);
    expect(checkTemplateStudio({ rows: [], now: NOW, setupHistory: [failed] }).action).toBe("generate");
  });
});

describe("SETUP_FAILURE_BACKOFF_RUNS bounds a permanently broken client without ever locking one out", () => {
  it("is [1, 1, 8] — two free retries, then roughly a month at a weekly cadence", () => {
    expect([...SETUP_FAILURE_BACKOFF_RUNS]).toEqual([1, 1, 8]);
  });

  it("the first and second consecutive failures suppress nothing: the very next run retries", () => {
    // `runsSinceLastAttempt: 1` IS the next run — the counter is "runs
    // completed since that attempt's own run", so the run immediately after
    // reports 1 and only a re-entry inside the same run reports 0.
    for (const history of [[failedAttempt(1)], [failedAttempt(2), failedAttempt(1)]]) {
      const check = checkTemplateStudio({ rows: [], now: NOW, setupHistory: history, runsSinceLastAttempt: 1 });
      expect(check.action, check.reason).toBe("generate");
    }
  });

  it("the THIRD consecutive failure holds the setup bill until the eighth run, then releases it", () => {
    const three = [failedAttempt(3), failedAttempt(2), failedAttempt(1)];
    const held = checkTemplateStudio({ rows: [], now: NOW, setupHistory: three, runsSinceLastAttempt: 7 });
    expect(held.action).toBe("reuse");
    expect(held.reason).toContain("3 setup(s)");
    expect(held.reason).toContain("backoff, not a cooldown");
    expect(checkTemplateStudio({ rows: [], now: NOW, setupHistory: three, runsSinceLastAttempt: 8 }).action).toBe("generate");
    // And `refreshTemplates` still overrides it.
    expect(checkTemplateStudio({ rows: [], now: NOW, setupHistory: three, refreshRequested: true, runsSinceLastAttempt: 0 }).action).toBe("generate");
  });

  it("with no run counter, the gap is read as days and a gap of 1 means no wait at all", () => {
    // The case that mattered on the day: the failures are hours old and the
    // ceilings have just been raised. A day-denominated reading of "1 run"
    // would have blocked the very re-run this change exists to allow.
    expect(checkTemplateStudio({ rows: [], now: NOW, setupHistory: [failedAttempt(0)] }).action).toBe("generate");
    const three = [failedAttempt(0), failedAttempt(0), failedAttempt(0)];
    expect(checkTemplateStudio({ rows: [], now: NOW, setupHistory: three }).action).toBe("reuse");
    expect(checkTemplateStudio({ rows: [], now: NOW, setupHistory: [failedAttempt(7), failedAttempt(7), failedAttempt(7)] }).action).toBe("generate");
  });

  it("the NEWEST attempt decides, so two old failures under a later empty answer are not 'three strikes'", () => {
    // Oldest first, as the beliefs document stores them. The newest here is
    // the empty attempt, and its cooldown has passed — so the answer is
    // `generate`, on the empty branch, and the two old failures do not add up
    // to a backoff behind it.
    const history = [failedAttempt(60), failedAttempt(50), emptyAttempt(STUDIO_EMPTY_SETUP_COOLDOWN_DAYS + 1)];
    expect(checkTemplateStudio({ rows: [], now: NOW, setupHistory: history, runsSinceLastAttempt: 0 }).action).toBe("generate");
  });
});

describe("the visual-direction retry window discriminates the same two events", () => {
  function beliefs(attempt: VisualDirectionAttempt | undefined): unknown {
    return attempt === undefined ? {} : { [VISUAL_DIRECTION_ATTEMPT_BELIEF_KEY]: attempt };
  }

  const failedMarker: VisualDirectionAttempt = {
    version: 1,
    attemptedAt: daysAgo(1),
    failedWith: "00d2-derive-visual-direction returned tooling_error",
    outcome: "failed",
    status: "tooling_error",
  };
  const emptyMarker: VisualDirectionAttempt = {
    version: 1,
    attemptedAt: daysAgo(1),
    failedWith: "the art director returned three lines, under the four-line floor",
    outcome: "empty",
  };

  it("a `failed` marker does not hold the retry — the ceiling that caused it has been raised", () => {
    const check = checkVisualDirection(beliefs(failedMarker), { now: NOW, allowDerive: true });
    expect(check.action).toBe("derive");
  });

  it("an `empty` marker holds it for VISUAL_DIRECTION_RETRY_DAYS, then releases", () => {
    expect(checkVisualDirection(beliefs(emptyMarker), { now: NOW, allowDerive: true }).action).toBe("unavailable");
    const old = { ...emptyMarker, attemptedAt: daysAgo(VISUAL_DIRECTION_RETRY_DAYS) };
    expect(checkVisualDirection(beliefs(old), { now: NOW, allowDerive: true }).action).toBe("derive");
  });

  it("a marker with NO outcome — every one on disk today — does not hold it either", () => {
    const legacy: VisualDirectionAttempt = { version: 1, attemptedAt: daysAgo(1), failedWith: "00d2 failed" };
    expect(checkVisualDirection(beliefs(legacy), { now: NOW, allowDerive: true }).action).toBe("derive");
  });

  it("BREAK THE CODE: the old rule suppressed all three markers alike", () => {
    // `attempt !== undefined && ageDays < VISUAL_DIRECTION_RETRY_DAYS` — the
    // whole of the old condition, which never looked at what happened.
    const oldRuleSuppresses = (attempt: VisualDirectionAttempt): boolean =>
      Math.floor((NOW.getTime() - Date.parse(attempt.attemptedAt)) / DAY_MS) < VISUAL_DIRECTION_RETRY_DAYS;
    for (const marker of [failedMarker, emptyMarker]) expect(oldRuleSuppresses(marker)).toBe(true);
    expect(checkVisualDirection(beliefs(failedMarker), { now: NOW, allowDerive: true }).action).toBe("derive");
    expect(checkVisualDirection(beliefs(emptyMarker), { now: NOW, allowDerive: true }).action).toBe("unavailable");
  });

  it("the budget lever is untouched: `allowDerive: false` is still `unavailable`, marker or no marker", () => {
    expect(checkVisualDirection(beliefs(undefined), { now: NOW, allowDerive: false }).action).toBe("unavailable");
    expect(checkVisualDirection(beliefs(failedMarker), { now: NOW, allowDerive: false }).action).toBe("unavailable");
  });
});
