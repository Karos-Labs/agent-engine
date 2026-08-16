import { describe, expect, it } from "vitest";
import { BLOG_GOLDEN_RUNS } from "./src/golden-runs.js";
import { runBlogDeterministicAssertions } from "./src/run-assertions.js";

describe("Blog agent golden runs — deterministic assertions (RFC-01 §12)", () => {
  it("has at least one golden run defined", () => {
    expect(BLOG_GOLDEN_RUNS.length).toBeGreaterThan(0);
  });

  for (const goldenRun of BLOG_GOLDEN_RUNS) {
    it(`${goldenRun.id}: endorsed article passes every check (gates + render.preview)`, async () => {
      const results = await runBlogDeterministicAssertions(goldenRun);

      expect(results).toHaveLength(6);
      for (const result of results) {
        expect(result.verdict, `${result.check} failed: ${result.reason ?? "(no reason)"}`).toBe("pass");
      }
    });

    it(`${goldenRun.id}: is deterministic — running it twice gives identical verdicts`, async () => {
      const first = await runBlogDeterministicAssertions(goldenRun);
      const second = await runBlogDeterministicAssertions(goldenRun);
      expect(first).toEqual(second);
    });
  }

  it("catches a regression: a title over the 120-char limit fails render.preview", async () => {
    const goldenRun = BLOG_GOLDEN_RUNS[0]!;
    const regressed = { ...goldenRun, endorsedOutput: { ...goldenRun.endorsedOutput, title: goldenRun.endorsedOutput.title.repeat(3) } };

    const results = await runBlogDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "render.preview")!;
    expect(check.verdict).toBe("content_fail");
  });

  it("catches a regression: reintroducing a forbidden pattern fails brandCompliance", async () => {
    const goldenRun = BLOG_GOLDEN_RUNS[0]!;
    const regressed = { ...goldenRun, endorsedOutput: { ...goldenRun.endorsedOutput, text: `${goldenRun.endorsedOutput.text} We're #1.` } };

    const results = await runBlogDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "gate.brandCompliance")!;
    expect(check.verdict).toBe("content_fail");
  });

  it("catches a regression: an unsourced numeric claim fails numbersSourced", async () => {
    const goldenRun = BLOG_GOLDEN_RUNS[0]!;
    const regressed = {
      ...goldenRun,
      endorsedOutput: { ...goldenRun.endorsedOutput, text: "Teams that adopted structured onboarding saw ramp time fall 43% this quarter." },
    };

    const results = await runBlogDeterministicAssertions(regressed);
    const check = results.find((r) => r.check === "gate.numbersSourced")!;
    expect(check.verdict).toBe("content_fail");
  });
});
