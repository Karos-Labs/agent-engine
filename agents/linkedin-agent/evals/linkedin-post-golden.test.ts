import { describe, expect, it } from "vitest";
import { LINKEDIN_GOLDEN_RUNS } from "./src/golden-runs.js";
import { runLinkedInDeterministicAssertions } from "./src/run-assertions.js";

describe("LinkedIn agent golden runs — deterministic assertions (RFC-01 §12)", () => {
  it("has at least one golden run defined", () => {
    expect(LINKEDIN_GOLDEN_RUNS.length).toBeGreaterThan(0);
  });

  for (const goldenRun of LINKEDIN_GOLDEN_RUNS) {
    it(`${goldenRun.id}: endorsed post passes every check (gates + render.preview)`, async () => {
      const results = await runLinkedInDeterministicAssertions(goldenRun);

      expect(results).toHaveLength(6);
      for (const result of results) {
        expect(result.verdict, `${result.check} failed: ${result.reason ?? "(no reason)"}`).toBe("pass");
      }
    });

    it(`${goldenRun.id}: is deterministic — running it twice gives identical verdicts`, async () => {
      const first = await runLinkedInDeterministicAssertions(goldenRun);
      const second = await runLinkedInDeterministicAssertions(goldenRun);
      expect(first).toEqual(second);
    });
  }

  it("catches a regression: a post over the LinkedIn character limit fails render.preview", async () => {
    const goldenRun = LINKEDIN_GOLDEN_RUNS[0]!;
    const regressed = { ...goldenRun, endorsedOutput: { ...goldenRun.endorsedOutput, text: goldenRun.endorsedOutput.text.repeat(10) } };

    const results = await runLinkedInDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "render.preview")!;
    expect(check.verdict).toBe("content_fail");
  });

  it("catches a regression: reintroducing a forbidden pattern fails brandCompliance", async () => {
    const goldenRun = LINKEDIN_GOLDEN_RUNS[0]!;
    const regressed = { ...goldenRun, endorsedOutput: { ...goldenRun.endorsedOutput, text: `${goldenRun.endorsedOutput.text} We're #1.` } };

    const results = await runLinkedInDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "gate.brandCompliance")!;
    expect(check.verdict).toBe("content_fail");
  });

  it("catches a regression: an unsourced numeric claim fails numbersSourced", async () => {
    const goldenRun = LINKEDIN_GOLDEN_RUNS[0]!;
    const regressed = {
      ...goldenRun,
      endorsedOutput: { ...goldenRun.endorsedOutput, text: "Teams with anchor days saw scheduling conflicts fall 43% this quarter." },
    };

    const results = await runLinkedInDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "gate.numbersSourced")!;
    expect(check.verdict).toBe("content_fail");
  });
});
