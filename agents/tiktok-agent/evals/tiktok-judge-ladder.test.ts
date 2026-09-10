import { describe, expect, it, vi } from "vitest";
import type { CompletionResult, ModelRouter } from "@agent-engine/core";
import { EVAL_OPERATION, InMemoryAgentRunsBiTable, parseEvalDetail, type JudgeScores, type JudgeVerdict } from "@agent-engine/evals";
import { insertRowFields } from "../../../scripts/check-bq-insert-schema.js";
import { TIKTOK_GOLDEN_RUNS, tikTokGoldenRunsFor } from "./src/golden-runs.js";
import { buildTikTokJudgeCase, runTikTokJudgeLadder, runTikTokJudgeLadderSuite, scriptAsTranscript } from "./src/run-judge-ladder.js";

/**
 * Rungs 3–5 for the original short: the rubric judge grades the script as a
 * viewer meets it, the score is persisted as one `agent_runs_bi` row shaped
 * exactly like production's insert, and it reads back. Everything expensive
 * is stubbed the way the LinkedIn ladder stubs it.
 */

const SUITE_RUN_ID = "tiktok-eval-suite-2026-09-10";
const STARTED_AT = "2026-09-10T16:00:00.000Z";

function fakeRouterSequence(turns: Array<() => CompletionResult<unknown>>): ModelRouter {
  const queue = [...turns];
  return {
    complete: vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error("fakeRouterSequence: exhausted configured turns");
      return next();
    }),
    completeAlias: vi.fn(async () => {
      throw new Error("fakeRouterSequence: completeAlias not used in these tests");
    }),
  } as unknown as ModelRouter;
}

function judgeTurn(scores: JudgeScores, rationale = "Scored against the rubric anchors."): () => CompletionResult<unknown> {
  const verdict: JudgeVerdict = { scores, rationale, flags: [] };
  return () => ({ output: verdict, modelUsed: "claude-opus-4-8", inputTokens: { cached: 0, uncached: 1_400 }, outputTokens: 210 });
}

const STRONG: JudgeScores = { languageFidelity: 5, brandVoiceFidelity: 4, hookStrength: 4, platformConvention: 5 };
const table = () => new InMemoryAgentRunsBiTable(insertRowFields());
const calls = (router: ModelRouter) => (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls;

describe("the judge reads the script as a viewer meets it", () => {
  it("transcribes hook, beats (spoken + on screen), stat cards and caption in order, and never the stock queries", () => {
    const run = TIKTOK_GOLDEN_RUNS[1]!;
    const transcript = scriptAsTranscript(run.endorsedOutput);
    expect(transcript.startsWith(`HOOK (on screen for two seconds): ${run.endorsedOutput.hook}`)).toBe(true);
    expect(transcript).toContain(`BEAT 1 (6s) spoken: ${run.endorsedOutput.beats[0]!.narration}`);
    expect(transcript).toContain(`on screen: ${run.endorsedOutput.beats[0]!.onScreenText}`);
    expect(transcript).toContain(`CAPTION: ${run.endorsedOutput.caption}`);
    expect(transcript).not.toContain(run.endorsedOutput.beats[0]!.stockQuery!);
    const withStat = { ...run.endorsedOutput, beats: [{ ...run.endorsedOutput.beats[0]!, stat: { value: "$2", label: "a short, at most" } }, ...run.endorsedOutput.beats.slice(1)] };
    expect(scriptAsTranscript(withStat)).toContain("stat card: $2 a short, at most");
  });

  it("builds a case on the tiktok platform with the client's tone and forbidden terms, and tells the judge what the four dimensions mean for a short", () => {
    const judgeCase = buildTikTokJudgeCase(TIKTOK_GOLDEN_RUNS[0]!);
    expect(judgeCase.platform).toBe("tiktok");
    expect(judgeCase.clientId).toBe("karoslabs");
    expect(judgeCase.brandRules?.tone).toContain("clear and precise");
    expect(judgeCase.brandRules?.forbiddenTerms).toContain("game-changer");
    expect(judgeCase.notes).toContain("hookStrength");
    expect(judgeCase.reference).toBeUndefined();
    // Grading a candidate against the endorsed script carries the endorsed one as the reference.
    const candidate = { ...TIKTOK_GOLDEN_RUNS[0]!.endorsedOutput, hook: "A different hook." };
    expect(buildTikTokJudgeCase(TIKTOK_GOLDEN_RUNS[0]!, candidate).reference).toBe(scriptAsTranscript(TIKTOK_GOLDEN_RUNS[0]!.endorsedOutput));
  });
});

describe("the ladder: judge -> score -> persist -> read back, one row per golden run", () => {
  it("grades, persists and reads back one judged row for every golden run, in both languages", async () => {
    const sink = table();
    const router = fakeRouterSequence(TIKTOK_GOLDEN_RUNS.map(() => judgeTurn(STRONG)));
    const results = await runTikTokJudgeLadderSuite(TIKTOK_GOLDEN_RUNS, { router, sink, evalSuiteRunId: SUITE_RUN_ID, startedAt: STARTED_AT });

    expect(results).toHaveLength(TIKTOK_GOLDEN_RUNS.length);
    expect(results.every((r) => r.score.verdict === "pass"), results.map((r) => r.score.failureReasons.join("; ")).join("\n")).toBe(true);
    expect(calls(router)).toHaveLength(TIKTOK_GOLDEN_RUNS.length);

    const readBack = await sink.query({ jobId: SUITE_RUN_ID, operation: EVAL_OPERATION });
    expect(readBack).toHaveLength(TIKTOK_GOLDEN_RUNS.length);
    expect(readBack.map((row) => row.stepId).sort()).toEqual(TIKTOK_GOLDEN_RUNS.map((g) => `${g.id}:${g.language}`).sort());
    for (const row of readBack) {
      expect(row.status).toBe("eval_pass");
      expect(row.agentId).toBe("tiktok-agent");
      expect(row.model).toBe("claude-opus-4-8");
      expect(row.costUsd).toBeGreaterThan(0);
    }
  });

  it("reads the rubric scores and the ten deterministic checks back out of the Hebrew row", async () => {
    const sink = table();
    const hebrew = tikTokGoldenRunsFor("he")[0]!;
    await runTikTokJudgeLadder(hebrew, { router: fakeRouterSequence([judgeTurn(STRONG)]), sink, evalSuiteRunId: SUITE_RUN_ID, startedAt: STARTED_AT });
    const row = (await sink.query({ stepId: `${hebrew.id}:he` }))[0]!;
    const detail = parseEvalDetail(row);
    expect(detail.language).toBe("he");
    expect(detail.scores).toEqual(STRONG);
    expect(detail.overall).toBe(4.5);
    // The viewer's words are Hebrew through and through; the caption's URL is not counted against it.
    expect(detail.languageScriptShare).toBe(1);
    expect(detail.deterministic.map((d) => d.name)).toEqual([
      "script.structure",
      "script.voice",
      "script.shots",
      "script.pitch",
      "script.dashes",
      "script.duration",
      "gate.noPlaceholder",
      "gate.brandCompliance",
      "gate.leakCheck",
      "gate.numbersSourced",
    ]);
    expect(detail.failureReasons).toEqual([]);
  });

  it("tells the judge, in the prompt, which language it is grading", async () => {
    const router = fakeRouterSequence([judgeTurn(STRONG)]);
    await runTikTokJudgeLadder(tikTokGoldenRunsFor("he")[0]!, { router, sink: table(), evalSuiteRunId: SUITE_RUN_ID, startedAt: STARTED_AT });
    const prompt = String(calls(router)[0]![0]);
    expect(prompt.startsWith("LANGUAGE REQUIREMENT")).toBe(true);
    expect(prompt).toContain("Hebrew (עברית)");
  });
});

describe("the regressions the ladder exists to make measurable", () => {
  it("fails, and persists an eval_fail row, when the Hebrew client's short is written in English, however happy the judge is", async () => {
    const sink = table();
    const hebrew = tikTokGoldenRunsFor("he")[0]!;
    const english = tikTokGoldenRunsFor("en")[0]!.endorsedOutput;
    const { score, row } = await runTikTokJudgeLadder(
      hebrew,
      { router: fakeRouterSequence([judgeTurn({ languageFidelity: 5, brandVoiceFidelity: 5, hookStrength: 5, platformConvention: 5 })]), sink, evalSuiteRunId: SUITE_RUN_ID, startedAt: STARTED_AT },
      english,
    );
    expect(score.verdict).toBe("fail");
    expect(score.languageFidelity.verdict).toBe("content_fail");
    expect(row.status).toBe("eval_fail");
    expect(parseEvalDetail((await sink.query({ runId: row.runId }))[0]!).languageScriptShare).toBe(0);
  });

  it("fails on a deterministic check when a candidate ends on a pitch, with the check named in the failure reasons", async () => {
    const run = tikTokGoldenRunsFor("en")[0]!;
    const beats = run.endorsedOutput.beats.map((b) => ({ ...b }));
    beats[beats.length - 1]!.narration = "Book a call and we will show you the plan.";
    const { score } = await runTikTokJudgeLadder(run, { router: fakeRouterSequence([judgeTurn(STRONG)]), sink: table(), evalSuiteRunId: SUITE_RUN_ID, startedAt: STARTED_AT }, { ...run.endorsedOutput, beats });
    expect(score.verdict).toBe("fail");
    expect(score.failureReasons.join("\n")).toMatch(/script\.pitch/);
  });

  it("fails on the judge alone when the words are clean but the hook does not stop anyone", async () => {
    const run = tikTokGoldenRunsFor("en")[0]!;
    const { score } = await runTikTokJudgeLadder(run, {
      router: fakeRouterSequence([judgeTurn({ languageFidelity: 5, brandVoiceFidelity: 4, hookStrength: 2, platformConvention: 4 }, "The hook states a fact nobody would stop for.")]),
      sink: table(),
      evalSuiteRunId: SUITE_RUN_ID,
      startedAt: STARTED_AT,
    });
    expect(score.verdict).toBe("fail");
    expect(score.failureReasons.join("\n")).toMatch(/hookStrength/);
  });
});
