import { describe, expect, it } from "vitest";
import { REDDIT_GOLDEN_RUNS } from "./src/golden-runs.js";
import { runRedditDeterministicAssertions } from "./src/run-assertions.js";

describe("Reddit agent golden runs — deterministic assertions (RFC-01 §12)", () => {
  it("has at least one golden run defined", () => {
    expect(REDDIT_GOLDEN_RUNS.length).toBeGreaterThan(0);
  });

  for (const goldenRun of REDDIT_GOLDEN_RUNS) {
    it(`${goldenRun.id}: endorsed post passes every check (gates + render.preview)`, async () => {
      const results = await runRedditDeterministicAssertions(goldenRun);

      expect(results).toHaveLength(6);
      for (const result of results) {
        expect(result.verdict, `${result.check} failed: ${result.reason ?? "(no reason)"}`).toBe("pass");
      }
    });

    it(`${goldenRun.id}: is deterministic — running it twice gives identical verdicts`, async () => {
      const first = await runRedditDeterministicAssertions(goldenRun);
      const second = await runRedditDeterministicAssertions(goldenRun);
      expect(first).toEqual(second);
    });
  }

  it("catches a regression: a title over Reddit's 300-char limit fails render.preview", async () => {
    const goldenRun = REDDIT_GOLDEN_RUNS[0]!;
    const regressed = { ...goldenRun, endorsedOutput: { ...goldenRun.endorsedOutput, title: goldenRun.endorsedOutput.title.repeat(5) } };

    const results = await runRedditDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "render.preview")!;
    expect(check.verdict).toBe("content_fail");
  });

  it("catches a regression: reintroducing a forbidden pattern fails brandCompliance", async () => {
    const goldenRun = REDDIT_GOLDEN_RUNS[0]!;
    const regressed = { ...goldenRun, endorsedOutput: { ...goldenRun.endorsedOutput, text: `${goldenRun.endorsedOutput.text} We're #1.` } };

    const results = await runRedditDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "gate.brandCompliance")!;
    expect(check.verdict).toBe("content_fail");
  });

  it("catches a regression: an unsourced numeric claim fails numbersSourced", async () => {
    const goldenRun = REDDIT_GOLDEN_RUNS[0]!;
    const regressed = {
      ...goldenRun,
      endorsedOutput: { ...goldenRun.endorsedOutput, text: "Teams running a 4-day week saw sick days drop 43% this quarter." },
    };

    const results = await runRedditDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "gate.numbersSourced")!;
    expect(check.verdict).toBe("content_fail");
  });
});
