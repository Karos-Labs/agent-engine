import { describe, expect, it } from "vitest";
import { NEWSLETTER_GOLDEN_RUNS } from "./src/golden-runs.js";
import { runNewsletterDeterministicAssertions } from "./src/run-assertions.js";

describe("Newsletter agent golden runs — deterministic assertions (RFC-01 §12)", () => {
  it("has at least one golden run defined", () => {
    expect(NEWSLETTER_GOLDEN_RUNS.length).toBeGreaterThan(0);
  });

  for (const goldenRun of NEWSLETTER_GOLDEN_RUNS) {
    it(`${goldenRun.id}: endorsed edition passes every check (gates + render.preview)`, async () => {
      const results = await runNewsletterDeterministicAssertions(goldenRun);

      expect(results).toHaveLength(6);
      for (const result of results) {
        expect(result.verdict, `${result.check} failed: ${result.reason ?? "(no reason)"}`).toBe("pass");
      }
    });

    it(`${goldenRun.id}: is deterministic — running it twice gives identical verdicts`, async () => {
      const first = await runNewsletterDeterministicAssertions(goldenRun);
      const second = await runNewsletterDeterministicAssertions(goldenRun);
      expect(first).toEqual(second);
    });
  }

  it("catches a regression: a subject line over the 70-char limit fails render.preview", async () => {
    const goldenRun = NEWSLETTER_GOLDEN_RUNS[0]!;
    const regressed = { ...goldenRun, endorsedOutput: { ...goldenRun.endorsedOutput, subjectLine: goldenRun.endorsedOutput.subjectLine.repeat(3) } };

    const results = await runNewsletterDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "render.preview")!;
    expect(check.verdict).toBe("content_fail");
  });

  it("catches a regression: reintroducing a forbidden pattern fails brandCompliance", async () => {
    const goldenRun = NEWSLETTER_GOLDEN_RUNS[0]!;
    const regressed = { ...goldenRun, endorsedOutput: { ...goldenRun.endorsedOutput, text: `${goldenRun.endorsedOutput.text} We're #1.` } };

    const results = await runNewsletterDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "gate.brandCompliance")!;
    expect(check.verdict).toBe("content_fail");
  });

  it("catches a regression: an unsourced numeric claim fails numbersSourced", async () => {
    const goldenRun = NEWSLETTER_GOLDEN_RUNS[0]!;
    const regressed = {
      ...goldenRun,
      endorsedOutput: { ...goldenRun.endorsedOutput, text: "Teams that adopted structured onboarding saw ramp time fall 43% this quarter." },
    };

    const results = await runNewsletterDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "gate.numbersSourced")!;
    expect(check.verdict).toBe("content_fail");
  });
});
