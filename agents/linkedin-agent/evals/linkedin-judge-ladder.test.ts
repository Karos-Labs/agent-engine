import { describe, expect, it } from "vitest";
import type { CompletionResult } from "@agent-engine/core";
import {
  EVAL_OPERATION,
  InMemoryAgentRunsBiTable,
  parseEvalDetail,
  type JudgeScores,
  type JudgeVerdict,
} from "@agent-engine/evals";
import { insertRowFields } from "../../../scripts/check-bq-insert-schema.js";
import { fakeRouterSequence } from "../__tests__/test-helpers.js";
import { LINKEDIN_GOLDEN_RUNS, linkedInGoldenRunsFor } from "./src/golden-runs.js";
import { runLinkedInJudgeLadder, runLinkedInJudgeLadderSuite } from "./src/run-judge-ladder.js";

/**
 * SCRUM-308 (AU25) acceptance: at least one LLM-judge-graded golden run PER
 * SUPPORTED LANGUAGE, persisted to `bi_telemetry.agent_runs_bi`, with a query
 * proving the row is readable back out.
 *
 * Everything expensive is stubbed the way this repo already stubs it, because
 * CI has neither a live model nor a BigQuery credential:
 *
 *   - the judge model, through `fakeRouterSequence` — the LinkedIn agent's own
 *     `__tests__/test-helpers.ts` helper, the same one its workflow tests use;
 *   - `agent_runs_bi`, through `InMemoryAgentRunsBiTable` constructed from
 *     `insertRowFields()`, which parses the engine's real insert literal out of
 *     `packages/telemetry/src/span-helpers.ts`. The fake rejects any row that
 *     is not shaped exactly like the one production writes, so "the row was
 *     persisted" is a claim about the real schema and not about the fake's
 *     tolerance.
 */

const SUITE_RUN_ID = "linkedin-eval-suite-2026-08-30";
const STARTED_AT = "2026-08-30T09:00:00.000Z";

/** One judge turn. Returns the verdict directly: `runRubricJudge` calls `router.complete` itself, so there is no ReAct envelope to unwrap. */
function judgeTurn(scores: JudgeScores, rationale = "Scored against the rubric anchors."): () => CompletionResult<unknown> {
  const verdict: JudgeVerdict = { scores, rationale, flags: [] };
  return () => ({
    output: verdict,
    modelUsed: "claude-opus-4-8",
    inputTokens: { cached: 0, uncached: 1_400 },
    outputTokens: 210,
  });
}

const STRONG: JudgeScores = { languageFidelity: 5, brandVoiceFidelity: 4, hookStrength: 4, platformConvention: 5 };

function table() {
  return new InMemoryAgentRunsBiTable(insertRowFields());
}

describe("LinkedIn golden runs cover both supported languages", () => {
  it("has exactly one endorsed run per language, English and Hebrew", () => {
    expect(linkedInGoldenRunsFor("en")).toHaveLength(1);
    expect(linkedInGoldenRunsFor("he")).toHaveLength(1);
    expect(LINKEDIN_GOLDEN_RUNS).toHaveLength(2);
  });

  it("the Hebrew fixture is actually in Hebrew — a fixture nobody checked is how AU32 happened", () => {
    const hebrew = linkedInGoldenRunsFor("he")[0]!;
    expect(/\p{Script=Hebrew}/u.test(hebrew.endorsedOutput.text)).toBe(true);
    expect(/\p{Script=Hebrew}/u.test(hebrew.endorsedOutput.headline)).toBe(true);
  });
});

describe("the ladder: judge -> score -> persist -> read back, one row per language", () => {
  it("grades, persists and reads back one judged row for every supported language", async () => {
    const sink = table();
    const router = fakeRouterSequence([judgeTurn(STRONG), judgeTurn(STRONG)]);

    const results = await runLinkedInJudgeLadderSuite(LINKEDIN_GOLDEN_RUNS, {
      router,
      sink,
      evalSuiteRunId: SUITE_RUN_ID,
      startedAt: STARTED_AT,
    });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.score.verdict === "pass")).toBe(true);
    // Two golden runs, two judge calls — the grading is model-graded, not asserted into existence.
    expect((router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(2);

    const readBack = await sink.query({ jobId: SUITE_RUN_ID, operation: EVAL_OPERATION });
    expect(readBack).toHaveLength(2);
    expect(readBack.map((row) => row.stepId).sort()).toEqual([
      "linkedin-post-hybrid-anchor-days-he:he",
      "linkedin-post-hybrid-anchor-days:en",
    ]);
    for (const row of readBack) {
      expect(row.status).toBe("eval_pass");
      expect(row.agentId).toBe("linkedin-agent");
      expect(row.source).toBe("agent-engine");
      expect(row.model).toBe("claude-opus-4-8");
      expect(row.costUsd).toBeGreaterThan(0);
    }
  });

  it("reads the rubric scores back out of the persisted rows, per language", async () => {
    const sink = table();
    await runLinkedInJudgeLadderSuite(LINKEDIN_GOLDEN_RUNS, {
      router: fakeRouterSequence([judgeTurn(STRONG), judgeTurn(STRONG)]),
      sink,
      evalSuiteRunId: SUITE_RUN_ID,
      startedAt: STARTED_AT,
    });

    const hebrewRow = (await sink.query({ stepId: "linkedin-post-hybrid-anchor-days-he:he" }))[0]!;
    const detail = parseEvalDetail(hebrewRow);
    expect(detail.language).toBe("he");
    expect(detail.scores).toEqual(STRONG);
    expect(detail.overall).toBe(4.5);
    expect(detail.languageScriptShare).toBe(1);
    expect(detail.deterministic.map((d) => d.name)).toEqual([
      "gate.lintPost",
      "gate.noPlaceholder",
      "gate.brandCompliance",
      "gate.leakCheck",
      "gate.numbersSourced",
      "render.preview",
    ]);
    expect(detail.failureReasons).toEqual([]);
  });

  it("tells the judge, in the prompt, which language it is grading", async () => {
    const router = fakeRouterSequence([judgeTurn(STRONG)]);
    await runLinkedInJudgeLadder(linkedInGoldenRunsFor("he")[0]!, {
      router,
      sink: table(),
      evalSuiteRunId: SUITE_RUN_ID,
      startedAt: STARTED_AT,
    });

    const prompt = String((router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]);
    expect(prompt.startsWith("LANGUAGE REQUIREMENT")).toBe(true);
    expect(prompt).toContain("Hebrew (עברית)");
    expect(prompt).toContain("right-to-left");
  });
});

describe("the AU32 regression the ladder exists to make measurable", () => {
  it("fails, and persists an eval_fail row, when the Hebrew client's run produces English copy", async () => {
    const sink = table();
    const hebrewRun = linkedInGoldenRunsFor("he")[0]!;
    const englishText = linkedInGoldenRunsFor("en")[0]!.endorsedOutput.text;

    // Deliberately a GENEROUS judge: every rubric dimension scores 5, exactly
    // as a language-blind grader would. The run must still fail, on the
    // deterministic language check, because that is the whole point — the
    // English carousel passed every check that existed.
    const { score, row } = await runLinkedInJudgeLadder(
      hebrewRun,
      { router: fakeRouterSequence([judgeTurn({ languageFidelity: 5, brandVoiceFidelity: 5, hookStrength: 5, platformConvention: 5 })]), sink, evalSuiteRunId: SUITE_RUN_ID, startedAt: STARTED_AT },
      englishText,
    );

    expect(score.verdict).toBe("fail");
    expect(score.languageFidelity.verdict).toBe("content_fail");
    expect(score.failureReasons.join("\n")).toMatch(/language\.fidelity: content_fail — client language is Hebrew/);
    expect(row.status).toBe("eval_fail");

    const persisted = (await sink.query({ runId: row.runId }))[0]!;
    const detail = parseEvalDetail(persisted);
    expect(detail.verdict).toBe("fail");
    expect(detail.languageScriptShare).toBe(0);
    // The judge's own opinion is preserved verbatim next to the failure, so a
    // reader can see that the grader was happy and the check was not.
    expect(detail.scores.languageFidelity).toBe(5);
  });

  it("fails when the judge itself reports translated-sounding Hebrew, even though the script check passes", async () => {
    const sink = table();
    const hebrewRun = linkedInGoldenRunsFor("he")[0]!;

    const { score } = await runLinkedInJudgeLadder(hebrewRun, {
      router: fakeRouterSequence([judgeTurn({ languageFidelity: 3, brandVoiceFidelity: 5, hookStrength: 5, platformConvention: 5 })]),
      sink,
      evalSuiteRunId: SUITE_RUN_ID,
      startedAt: STARTED_AT,
    });

    expect(score.languageFidelity.verdict).toBe("pass");
    expect(score.judge.failedDimensions).toEqual(["languageFidelity"]);
    expect(score.verdict).toBe("fail");
    expect(score.failureReasons.join("\n")).toMatch(/judge\.rubric/);
  });
});
