import type { AgentContext, GateVerdict } from "@agent-engine/core";
import { createKarosGatesTools } from "@agent-engine/tool-karos-gates";
import { normalizeScriptDashes, repairScriptStructure, salesPitchIssues, scriptVoiceIssues, shotVarietyIssues } from "../../src/workflow/create-tiktok-agent-workflow.js";
import type { ShortScript } from "../../src/workflow/types.js";
import type { TikTokDeterministicAssertionResult, TikTokGoldenRun } from "./types.js";

const EVAL_CTX: AgentContext = {
  runId: "eval-run",
  clientSlug: "eval",
  productId: "tiktok-agent",
  runKind: "manager",
  metadata: {},
};

/** The prompt's length band for an original short. */
export const SHORT_MIN_SECONDS = 20;
export const SHORT_MAX_SECONDS = 40;

const gates = createKarosGatesTools();

/** Everything a viewer hears or reads on screen, plus the caption and the internal `about`. */
function everyWord(script: ShortScript): string {
  return [script.hook, ...script.beats.flatMap((b) => [b.narration, b.onScreenText]), script.caption, script.about].join("\n");
}

/** What is said or shown IN the clip: the words a figure has to be sourced for. The caption carries the client's URL by convention and is judged separately. */
function spokenAndShown(script: ShortScript): string {
  return [script.hook, ...script.beats.flatMap((b) => [b.narration, b.onScreenText])].join("\n");
}

/**
 * Every deterministic rule the pipeline enforces on a script, run against an
 * endorsed one. `pass` everywhere is the contract: a rule change that would
 * send this script back to the writer shows up here, named.
 */
export async function runTikTokDeterministicAssertions(goldenRun: TikTokGoldenRun): Promise<TikTokDeterministicAssertionResult[]> {
  const script = goldenRun.endorsedOutput;
  const results: TikTokDeterministicAssertionResult[] = [];
  const record = (check: string, issues: readonly string[]): void => {
    results.push({ goldenRunId: goldenRun.id, check, verdict: issues.length === 0 ? "pass" : "content_fail", ...(issues.length > 0 ? { reason: issues.join("; ") } : {}) });
  };

  // ── The pipeline's own lints, the same functions the workflow calls ──
  record("script.structure", repairScriptStructure(script).issues);
  record("script.voice", scriptVoiceIssues(script));
  record("script.shots", shotVarietyIssues(script));
  const direction = typeof goldenRun.input["runDirection"] === "string" ? (goldenRun.input["runDirection"] as string) : undefined;
  record("script.pitch", salesPitchIssues(script, direction));

  // A dash or an exclamation mark anywhere the viewer hears or reads it: the
  // normaliser would rewrite the dashes, so an endorsed script must not need it.
  const dashIssues: string[] = [];
  if (JSON.stringify(normalizeScriptDashes(script)) !== JSON.stringify(script)) dashIssues.push("a dash the normaliser would have to rewrite");
  if (/!/.test(spokenAndShown(script))) dashIssues.push("an exclamation mark in the spoken or on-screen words");
  record("script.dashes", dashIssues);

  const seconds = script.beats.reduce((sum, b) => sum + b.seconds, 0);
  record("script.duration", seconds >= SHORT_MIN_SECONDS && seconds <= SHORT_MAX_SECONDS ? [] : [`${seconds}s of beats, outside ${SHORT_MIN_SECONDS}–${SHORT_MAX_SECONDS}s`]);

  // ── The shared gates, on the same words the workflow hands them ──
  const gateChecks: Array<{ check: string; gate: string; args: unknown }> = [
    { check: "gate.noPlaceholder", gate: "gate.noPlaceholder", args: { text: everyWord(script) } },
    { check: "gate.brandCompliance", gate: "gate.brandCompliance", args: { text: everyWord(script), ...goldenRun.gateArgs.brandCompliance } },
    { check: "gate.leakCheck", gate: "gate.leakCheck", args: { text: everyWord(script) } },
    { check: "gate.numbersSourced", gate: "gate.numbersSourced", args: { text: spokenAndShown(script), ...goldenRun.gateArgs.numbersSourced } },
  ];
  for (const { check, gate, args } of gateChecks) {
    const tool = gates[gate];
    if (!tool) {
      results.push({ goldenRunId: goldenRun.id, check, verdict: "tooling_error", reason: `no such gate: "${gate}"` });
      continue;
    }
    const outcome = await tool.execute(args, { ctx: EVAL_CTX });
    if (outcome.status !== "success") {
      results.push({ goldenRunId: goldenRun.id, check, verdict: "tooling_error", reason: outcome.reason });
      continue;
    }
    const verdict = outcome.result as GateVerdict;
    results.push({ goldenRunId: goldenRun.id, check, verdict: verdict.verdict, ...(verdict.verdict !== "pass" ? { reason: verdict.reason } : {}) });
  }

  return results;
}
