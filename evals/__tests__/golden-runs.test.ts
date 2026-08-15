import { describe, expect, it } from "vitest";
import { GOLDEN_RUNS } from "../src/golden-runs.js";
import { runDeterministicAssertions } from "../src/run-deterministic-assertions.js";

describe("golden runs — deterministic gate assertions (RFC-01 §12)", () => {
  it("has at least one golden run defined", () => {
    expect(GOLDEN_RUNS.length).toBeGreaterThan(0);
  });

  for (const goldenRun of GOLDEN_RUNS) {
    it(`${goldenRun.id}: endorsed output passes every karos-gate`, async () => {
      const results = await runDeterministicAssertions(goldenRun);

      expect(results).toHaveLength(5);
      for (const result of results) {
        expect(result.verdict, `${result.gate} failed: ${result.reason ?? "(no reason)"}`).toBe("pass");
      }
    });

    it(`${goldenRun.id}: is deterministic — running it twice gives identical verdicts`, async () => {
      const first = await runDeterministicAssertions(goldenRun);
      const second = await runDeterministicAssertions(goldenRun);
      expect(first).toEqual(second);
    });
  }

  it("catches a real regression: reintroducing a forbidden term fails brandCompliance", async () => {
    const goldenRun = GOLDEN_RUNS[0]!;
    const regressed = {
      ...goldenRun,
      endorsedOutput: { ...goldenRun.endorsedOutput, text: `${goldenRun.endorsedOutput.text} Guaranteed results, every time.` },
    };

    const results = await runDeterministicAssertions(regressed);
    const brandCheck = results.find((r) => r.gate === "gate.brandCompliance")!;
    expect(brandCheck.verdict).toBe("content_fail");
  });

  it("catches a real regression: an unresolved placeholder fails noPlaceholder", async () => {
    const goldenRun = GOLDEN_RUNS[0]!;
    const regressed = {
      ...goldenRun,
      endorsedOutput: { ...goldenRun.endorsedOutput, text: "TODO: write the actual post about {{topic}}." },
    };

    const results = await runDeterministicAssertions(regressed);
    const placeholderCheck = results.find((r) => r.gate === "gate.noPlaceholder")!;
    expect(placeholderCheck.verdict).toBe("content_fail");
  });
});
