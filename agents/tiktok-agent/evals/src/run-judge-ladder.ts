import type { ModelRouter } from "@agent-engine/core";
import {
  buildEvalScore,
  checkLanguageFidelity,
  evalScoreToAgentRunsBiRow,
  runRubricJudge,
  type AgentRunsBiRow,
  type AgentRunsBiSink,
  type EvalCheckResult,
  type EvalScore,
  type JudgeCase,
  type RubricJudgeOptions,
} from "@agent-engine/evals";
import type { ShortScript } from "../../src/workflow/types.js";
import { runTikTokDeterministicAssertions } from "./run-assertions.js";
import type { TikTokGoldenRun } from "./types.js";

export interface TikTokJudgeLadderOptions {
  router: ModelRouter;
  sink: AgentRunsBiSink;
  evalSuiteRunId: string;
  startedAt?: string;
  judge?: RubricJudgeOptions;
}

export interface TikTokLadderCaseResult {
  score: EvalScore;
  row: AgentRunsBiRow;
}

/**
 * The script as the judge reads it, in the order a viewer meets it: the hook
 * card, then each beat's spoken line with its on-screen line, then the
 * caption. Stock queries and visual briefs are not graded here: they are
 * instructions to a library, not words a viewer sees.
 */
export function scriptAsTranscript(script: ShortScript): string {
  return [
    `HOOK (on screen for two seconds): ${script.hook}`,
    ...script.beats.map((b, i) => `BEAT ${i + 1} (${b.seconds}s) spoken: ${b.narration}\n  on screen: ${b.onScreenText}${b.stat ? `\n  stat card: ${b.stat.value} ${b.stat.label}` : ""}`),
    `CAPTION: ${script.caption}`,
  ].join("\n");
}

function clientIdOf(goldenRun: TikTokGoldenRun): string {
  const slug = goldenRun.input["clientSlug"];
  return typeof slug === "string" && slug.length > 0 ? slug : "eval";
}

function brandRulesOf(goldenRun: TikTokGoldenRun): JudgeCase["brandRules"] {
  const voiceRules = goldenRun.input["voiceRules"];
  const tone = typeof voiceRules === "object" && voiceRules !== null ? (voiceRules as Record<string, unknown>)["tone"] : undefined;
  const forbiddenTerms = goldenRun.gateArgs.brandCompliance?.forbiddenTerms;
  if (typeof tone !== "string" && forbiddenTerms === undefined) return undefined;
  return {
    ...(typeof tone === "string" ? { tone } : {}),
    ...(forbiddenTerms !== undefined ? { forbiddenTerms } : {}),
  };
}

/** What the shared rubric's four dimensions mean for a 20–40 second spoken short, said to the judge once. */
const SHORT_FORM_NOTES = [
  "This is the script of an original 9:16 short (20-40 s): a hook card, then each beat spoken over library footage with a line on screen, then the post caption.",
  "hookStrength: the HOOK line is on screen for the first two seconds and beat 1 is spoken over it; judge whether a stranger scrolling would stop.",
  "platformConvention: one idea per beat, spoken sentences under a breath, no slide register, no dash, no exclamation mark, and the last beat lands an idea rather than a pitch; the caption may carry the client's URL and hashtags.",
  "brandVoiceFidelity: the client's tone applies to the spoken lines and the caption alike.",
].join(" ");

export function buildTikTokJudgeCase(goldenRun: TikTokGoldenRun, output?: ShortScript): JudgeCase {
  const brandRules = brandRulesOf(goldenRun);
  const endorsed = scriptAsTranscript(goldenRun.endorsedOutput);
  const graded = output === undefined ? endorsed : scriptAsTranscript(output);
  return {
    caseId: `${goldenRun.id}:${goldenRun.language}`,
    agentId: goldenRun.agentId,
    clientId: clientIdOf(goldenRun),
    language: goldenRun.language,
    platform: "tiktok",
    output: graded,
    ...(graded !== endorsed ? { reference: endorsed } : {}),
    ...(brandRules !== undefined ? { brandRules } : {}),
    notes: SHORT_FORM_NOTES,
  };
}

/**
 * Rungs 1–5 for one short: the deterministic checks, the language check on
 * the words a viewer hears and reads, the rubric judge, one `EvalScore`, one
 * `agent_runs_bi` row. `output` grades a candidate script against the
 * endorsed one (production sampling); absent, the endorsed script itself.
 */
export async function runTikTokJudgeLadder(goldenRun: TikTokGoldenRun, opts: TikTokJudgeLadderOptions, output?: ShortScript): Promise<TikTokLadderCaseResult> {
  const graded = output ?? goldenRun.endorsedOutput;
  const assertions = await runTikTokDeterministicAssertions(output === undefined ? goldenRun : { ...goldenRun, endorsedOutput: graded });
  const deterministic: EvalCheckResult[] = assertions.map((a) => ({
    name: a.check,
    verdict: a.verdict,
    ...(a.reason !== undefined ? { reason: a.reason } : {}),
  }));

  // The language check reads what the viewer hears and reads: the URL and
  // the brand hashtag in the caption are Latin by convention in any language,
  // so the caption is left out, as the stock queries are.
  const viewerWords = [graded.hook, ...graded.beats.flatMap((b) => [b.narration, b.onScreenText])].join("\n");
  const languageFidelity = checkLanguageFidelity(viewerWords, goldenRun.language);
  const judge = await runRubricJudge(opts.router, buildTikTokJudgeCase(goldenRun, output), opts.judge ?? {});

  const score = buildEvalScore({
    evalRunId: `${opts.evalSuiteRunId}:${goldenRun.id}:${goldenRun.language}`,
    evalSuiteRunId: opts.evalSuiteRunId,
    goldenRunId: goldenRun.id,
    agentId: goldenRun.agentId,
    clientId: clientIdOf(goldenRun),
    language: goldenRun.language,
    deterministic,
    languageFidelity,
    judge,
    startedAt: opts.startedAt ?? new Date().toISOString(),
  });

  const row = evalScoreToAgentRunsBiRow(score);
  await opts.sink.insert([row]);
  return { score, row };
}

export async function runTikTokJudgeLadderSuite(goldenRuns: readonly TikTokGoldenRun[], opts: TikTokJudgeLadderOptions): Promise<TikTokLadderCaseResult[]> {
  const results: TikTokLadderCaseResult[] = [];
  for (const goldenRun of goldenRuns) {
    results.push(await runTikTokJudgeLadder(goldenRun, opts));
  }
  return results;
}
