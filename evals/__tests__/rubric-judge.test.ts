import { describe, expect, it } from "vitest";
import { buildJudgePrompt, JUDGE_SYSTEM_PROMPT } from "../src/judge/rubric.js";
import { runRubricJudge } from "../src/judge/run-rubric-judge.js";
import { DEFAULT_JUDGE_POLICY, DEFAULT_JUDGE_THRESHOLDS, RUBRIC_DIMENSIONS, type JudgeCase } from "../src/judge/types.js";
import { fakeJudgeRouter, flatScores, judgeTurn } from "./judge-test-helpers.js";

const HEBREW_CASE: JudgeCase = {
  caseId: "linkedin-post-hybrid-anchor-days-he:he",
  agentId: "linkedin-agent",
  clientId: "geektime-like",
  language: "he",
  platform: "linkedin",
  output: "בדקנו את נתוני הנוכחות אצל הלקוחות ההיברידיים שלנו ברבעון האחרון.",
  brandRules: { tone: "ענייני, בלי ז'רגון", forbiddenTerms: ["מובטח"] },
};

const ENGLISH_CASE: JudgeCase = { ...HEBREW_CASE, caseId: "en", language: "en", clientId: "acme", output: "We looked at attendance data." };

describe("buildJudgePrompt", () => {
  it("states the language requirement first and unconditionally", () => {
    const prompt = buildJudgePrompt(HEBREW_CASE);
    expect(prompt.startsWith("LANGUAGE REQUIREMENT")).toBe(true);
    expect(prompt).toContain("Hebrew (עברית)");
    expect(prompt).toContain("right-to-left");
  });

  it("names every rubric dimension with all five anchors, so the scale is not left to the model", () => {
    const prompt = buildJudgePrompt(ENGLISH_CASE);
    for (const dimension of RUBRIC_DIMENSIONS) {
      expect(prompt, `${dimension} missing from the prompt`).toContain(`${dimension} (`);
    }
    // 4 dimensions x 5 anchors.
    expect((prompt.match(/^ {2}[1-5] = /gm) ?? []).length).toBe(20);
  });

  it("carries the client's own voice rules and the platform", () => {
    const prompt = buildJudgePrompt(HEBREW_CASE);
    expect(prompt).toContain("PLATFORM: linkedin");
    expect(prompt).toContain("ענייני, בלי ז'רגון");
    expect(prompt).toContain("forbidden terms: מובטח");
  });

  it("includes a reference only when one is supplied", () => {
    expect(buildJudgePrompt(ENGLISH_CASE)).not.toContain("HUMAN-ENDORSED REFERENCE");
    expect(buildJudgePrompt({ ...ENGLISH_CASE, reference: "the endorsed post" })).toContain("HUMAN-ENDORSED REFERENCE");
  });
});

describe("runRubricJudge", () => {
  it("calls the router with the judge policy, the rubric system prompt, and the verdict schema", async () => {
    const router = fakeJudgeRouter([judgeTurn(flatScores(5))]);
    await runRubricJudge(router, ENGLISH_CASE);

    const complete = router.complete as unknown as { mock: { calls: unknown[][] } };
    expect(complete.mock.calls).toHaveLength(1);
    const [prompt, schema, policy, opts] = complete.mock.calls[0]!;
    expect(String(prompt)).toContain("OUTPUT UNDER EVALUATION");
    expect(schema).toBeDefined();
    expect(policy).toEqual(DEFAULT_JUDGE_POLICY);
    expect((opts as { system: string }).system).toBe(JUDGE_SYSTEM_PROMPT);
  });

  it("averages the dimensions and passes a strong output", async () => {
    const result = await runRubricJudge(fakeJudgeRouter([judgeTurn(flatScores(5))]), ENGLISH_CASE);
    expect(result.overall).toBe(5);
    expect(result.passed).toBe(true);
    expect(result.failedDimensions).toEqual([]);
  });

  it("fails an output whose overall clears the floor but which is under threshold on one dimension", async () => {
    // 5/5/5/2 averages 4.25, comfortably over minOverall. A judge result that
    // reported "pass" here would let a single unacceptable dimension be
    // averaged away, which is the failure mode a mean alone always has.
    const result = await runRubricJudge(
      fakeJudgeRouter([judgeTurn({ languageFidelity: 5, brandVoiceFidelity: 5, hookStrength: 5, platformConvention: 2 })]),
      ENGLISH_CASE,
    );
    expect(result.overall).toBe(4.25);
    expect(result.overall).toBeGreaterThan(DEFAULT_JUDGE_THRESHOLDS.minOverall);
    expect(result.passed).toBe(false);
    expect(result.failedDimensions).toEqual(["platformConvention"]);
  });

  it("holds languageFidelity to a higher bar than the other dimensions", async () => {
    // 3 = "recognizably the right language, but reads as machine translation".
    // That is the outcome AU32 actually shipped, so a 3 here must not pass
    // while a 3 on hookStrength does.
    const translated = await runRubricJudge(
      fakeJudgeRouter([judgeTurn({ languageFidelity: 3, brandVoiceFidelity: 5, hookStrength: 5, platformConvention: 5 })]),
      HEBREW_CASE,
    );
    expect(translated.passed).toBe(false);
    expect(translated.failedDimensions).toEqual(["languageFidelity"]);

    const weakHook = await runRubricJudge(
      fakeJudgeRouter([judgeTurn({ languageFidelity: 5, brandVoiceFidelity: 5, hookStrength: 3, platformConvention: 5 })]),
      HEBREW_CASE,
    );
    expect(weakHook.passed).toBe(true);
  });

  it("prices the judge call through the shared cost calculator", async () => {
    const result = await runRubricJudge(
      fakeJudgeRouter([judgeTurn(flatScores(4), { model: "claude-opus-4-8", inputTokensUncached: 1_000_000, outputTokens: 1_000_000 })]),
      ENGLISH_CASE,
    );
    // claude-opus-4-8: $15/1M in, $75/1M out.
    expect(result.costUsd).toBe(90);
    expect(result.modelUsed).toBe("claude-opus-4-8");
  });

  it("records a fallback hop when one served the judge, and nothing when the primary did", async () => {
    const primary = await runRubricJudge(fakeJudgeRouter([judgeTurn(flatScores(4))]), ENGLISH_CASE);
    expect(primary.servedByHop).toBeUndefined();

    const failedOver = await runRubricJudge(
      fakeJudgeRouter([
        () => ({
          ...judgeTurn(flatScores(4))(),
          provenance: { hop: "secondary" as const, servedBy: "anthropic", failedOver: [] },
        }),
      ]),
      ENGLISH_CASE,
    );
    expect(failedOver.servedByHop).toBe("secondary");
    expect(failedOver.servingAdapter).toBe("anthropic");
  });

  it("measures duration off the injected clock rather than the wall", async () => {
    let t = 1_000;
    const result = await runRubricJudge(fakeJudgeRouter([judgeTurn(flatScores(4))]), ENGLISH_CASE, {
      now: () => {
        t += 250;
        return t;
      },
    });
    expect(result.durationMs).toBe(250);
  });

  it("throws rather than inventing a neutral score when the judge returns something off-scale", async () => {
    // A "3 because the judge malfunctioned" row is indistinguishable from a
    // real mediocre score once it is in BigQuery, which is why this must not
    // be swallowed.
    const router = fakeJudgeRouter([judgeTurn(flatScores(4), { rawOutput: { scores: { languageFidelity: 9 }, rationale: "" } })]);
    await expect(runRubricJudge(router, ENGLISH_CASE)).rejects.toThrow();
  });

  it("propagates a judge call that fails outright", async () => {
    const router = fakeJudgeRouter([]);
    await expect(runRubricJudge(router, ENGLISH_CASE)).rejects.toThrow(/exhausted configured turns/);
  });
});
