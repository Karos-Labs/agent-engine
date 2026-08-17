import { describe, expect, it } from "vitest";
import { REDDIT_GOLDEN_RUNS } from "./src/golden-runs.js";
import { runRedditDeterministicAssertions } from "./src/run-assertions.js";

describe("Reddit agent golden runs — deterministic assertions (RFC-01 §12)", () => {
  it("has at least one golden run defined", () => {
    expect(REDDIT_GOLDEN_RUNS.length).toBeGreaterThan(0);
  });

  for (const goldenRun of REDDIT_GOLDEN_RUNS) {
    it(`${goldenRun.id}: endorsed reply passes every check (gates + render.preview)`, async () => {
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

  it("catches a regression: a reply over Reddit's 10000-character comment limit fails render.preview", async () => {
    const goldenRun = REDDIT_GOLDEN_RUNS[0]!;
    const overLimitText = goldenRun.endorsedOutput.text.repeat(20);
    const regressed = { ...goldenRun, endorsedOutput: { ...goldenRun.endorsedOutput, replyBody: overLimitText, text: overLimitText } };

    const results = await runRedditDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "render.preview")!;
    expect(check.verdict).toBe("content_fail");
  });

  it("catches a regression: reintroducing a forbidden pattern fails brandCompliance", async () => {
    const goldenRun = REDDIT_GOLDEN_RUNS[0]!;
    const regressedText = `${goldenRun.endorsedOutput.text} This is the best option, guaranteed.`;
    const regressed = { ...goldenRun, endorsedOutput: { ...goldenRun.endorsedOutput, replyBody: regressedText, text: regressedText } };

    const results = await runRedditDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "gate.brandCompliance")!;
    expect(check.verdict).toBe("content_fail");
  });

  it("catches a regression: an unsourced numeric claim fails numbersSourced", async () => {
    const goldenRun = REDDIT_GOLDEN_RUNS[0]!;
    const regressedText = "Teams running a 4-day week saw sick days drop 43% this quarter.";
    const regressed = { ...goldenRun, endorsedOutput: { ...goldenRun.endorsedOutput, replyBody: regressedText, text: regressedText } };

    const results = await runRedditDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "gate.numbersSourced")!;
    expect(check.verdict).toBe("content_fail");
  });

  it("catches a regression: a planted placeholder marker fails noPlaceholder", async () => {
    const goldenRun = REDDIT_GOLDEN_RUNS[0]!;
    const regressedText = `${goldenRun.endorsedOutput.text} TODO: insert the real number here.`;
    const regressed = { ...goldenRun, endorsedOutput: { ...goldenRun.endorsedOutput, replyBody: regressedText, text: regressedText } };

    const results = await runRedditDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "gate.noPlaceholder")!;
    expect(check.verdict).toBe("content_fail");
  });

  it("catches a regression: a leaked local file path fails leakCheck", async () => {
    const goldenRun = REDDIT_GOLDEN_RUNS[0]!;
    const regressedText = `${goldenRun.endorsedOutput.text} Config lives at C:\\Users\\jane\\acme\\config.json.`;
    const regressed = { ...goldenRun, endorsedOutput: { ...goldenRun.endorsedOutput, replyBody: regressedText, text: regressedText } };

    const results = await runRedditDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "gate.leakCheck")!;
    expect(check.verdict).toBe("content_fail");
  });
});
