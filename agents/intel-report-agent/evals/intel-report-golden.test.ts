import { describe, expect, it } from "vitest";
import { INTEL_REPORT_GOLDEN_RUNS } from "./src/golden-runs.js";
import { runIntelReportDeterministicAssertions } from "./src/run-assertions.js";

describe("Intel Report agent golden runs — deterministic assertions (RFC-01 §12)", () => {
  it("has at least one golden run defined", () => {
    expect(INTEL_REPORT_GOLDEN_RUNS.length).toBeGreaterThan(0);
  });

  for (const goldenRun of INTEL_REPORT_GOLDEN_RUNS) {
    it(`${goldenRun.id}: endorsed report passes gate.numbersSourced and reproduces the pinned overall score/grade`, async () => {
      const results = await runIntelReportDeterministicAssertions(goldenRun);

      expect(results).toHaveLength(2);
      for (const result of results) {
        expect(result.verdict, `${result.check} failed: ${result.reason ?? "(no reason)"}`).toBe("pass");
      }
    });

    it(`${goldenRun.id}: is deterministic — running it twice gives identical verdicts`, async () => {
      const first = await runIntelReportDeterministicAssertions(goldenRun);
      const second = await runIntelReportDeterministicAssertions(goldenRun);
      expect(first).toEqual(second);
    });
  }

  it("catches a regression: an unsourced numeric claim fails gate.numbersSourced", async () => {
    const goldenRun = INTEL_REPORT_GOLDEN_RUNS[0]!;
    const regressed = {
      ...goldenRun,
      endorsedOutput: { ...goldenRun.endorsedOutput, conversionAnalysis: "Acme's conversion rate improved 91% after the last redesign." },
    };

    const results = await runIntelReportDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "gate.numbersSourced")!;
    expect(check.verdict).toBe("content_fail");
  });

  it("catches a regression: a tampered dimension score changes the deterministic overall score/grade", async () => {
    const goldenRun = INTEL_REPORT_GOLDEN_RUNS[0]!;
    const regressed = {
      ...goldenRun,
      endorsedOutput: {
        ...goldenRun.endorsedOutput,
        dimensionScores: goldenRun.endorsedOutput.dimensionScores.map((d) => (d.dimension === "positioning" ? { ...d, score: 0 } : d)),
      },
    };

    const results = await runIntelReportDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "computeOverallScore")!;
    expect(check.verdict).toBe("content_fail");
    expect(check.reason).toMatch(/expected score 70\/B/);
  });
});
