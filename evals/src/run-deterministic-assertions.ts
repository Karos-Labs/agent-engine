import type { AgentContext, GateVerdict } from "@agent-engine/core";
import { createKarosGatesTools } from "@agent-engine/tool-karos-gates";
import type { DeterministicAssertionResult, GoldenRun } from "./types.js";

const EVAL_CTX: AgentContext = {
  runId: "eval-run",
  clientSlug: "eval",
  productId: "eval",
  runKind: "manager",
  metadata: {},
};

const gates = createKarosGatesTools();

/**
 * Deterministic assertions (RFC-01 §12 bullet 2): every `karos-gates` tool
 * runs against a golden run's endorsed output. Fast, free, zero model cost —
 * catches format violations, banned words, missing sourcing, before anything
 * more expensive runs.
 */
export async function runDeterministicAssertions(goldenRun: GoldenRun): Promise<DeterministicAssertionResult[]> {
  const { text, platform } = goldenRun.endorsedOutput;

  const checks: Array<{ gate: string; args: unknown }> = [
    { gate: "gate.lintPost", args: { text, platform } },
    { gate: "gate.noPlaceholder", args: { text } },
    { gate: "gate.brandCompliance", args: { text, ...goldenRun.gateArgs.brandCompliance } },
    { gate: "gate.leakCheck", args: { text, ...goldenRun.gateArgs.leakCheck } },
    { gate: "gate.numbersSourced", args: { text, ...goldenRun.gateArgs.numbersSourced } },
  ];

  const results: DeterministicAssertionResult[] = [];
  for (const check of checks) {
    const tool = gates[check.gate];
    if (!tool) {
      results.push({ goldenRunId: goldenRun.id, gate: check.gate, verdict: "tooling_error", reason: `no such gate: "${check.gate}"` });
      continue;
    }

    const outcome = await tool.execute(check.args, { ctx: EVAL_CTX });
    if (outcome.status !== "success") {
      results.push({ goldenRunId: goldenRun.id, gate: check.gate, verdict: "tooling_error", reason: outcome.reason });
      continue;
    }

    const verdict = outcome.result as GateVerdict;
    results.push({
      goldenRunId: goldenRun.id,
      gate: check.gate,
      verdict: verdict.verdict,
      ...(verdict.verdict !== "pass" ? { reason: verdict.reason } : {}),
    });
  }
  return results;
}
