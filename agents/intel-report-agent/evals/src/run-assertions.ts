import type { AgentContext, GateVerdict } from "@agent-engine/core";
import { createKarosGatesTools } from "@agent-engine/tool-karos-gates";
import { computeOverallScore } from "@agent-engine/tool-karos-intel";
import type { IntelReportDeterministicAssertionResult, IntelReportGoldenRun } from "./types.js";

const EVAL_CTX: AgentContext = {
  runId: "eval-run",
  clientSlug: "eval",
  productId: "intel-report-agent",
  runKind: "manager",
  metadata: {},
};

const gates = createKarosGatesTools();

function concatenateAnalysisProse(endorsedOutput: IntelReportGoldenRun["endorsedOutput"]): string {
  return [
    endorsedOutput.contentAnalysis,
    endorsedOutput.conversionAnalysis,
    endorsedOutput.seoAnalysis,
    endorsedOutput.geoAnalysis,
    endorsedOutput.positioningAnalysis,
    endorsedOutput.brandAnalysis,
    endorsedOutput.growthAnalysis,
  ].join("\n\n");
}

/**
 * Deterministic assertions for the Intel Report agent (RFC-01 §12 bullet
 * 2): `gate.numbersSourced` against the endorsed report's analysis prose,
 * plus a check that `computeOverallScore` reproduces the golden run's own
 * pinned `expectedOverallScore`/`expectedOverallGrade` exactly — the same
 * deterministic arithmetic `intel.writeReport` runs in production. Fast,
 * free, zero model cost.
 */
export async function runIntelReportDeterministicAssertions(goldenRun: IntelReportGoldenRun): Promise<IntelReportDeterministicAssertionResult[]> {
  const results: IntelReportDeterministicAssertionResult[] = [];

  const text = concatenateAnalysisProse(goldenRun.endorsedOutput);
  const numbersSourcedTool = gates["gate.numbersSourced"];
  if (!numbersSourcedTool) {
    results.push({ goldenRunId: goldenRun.id, check: "gate.numbersSourced", verdict: "tooling_error", reason: "no such gate: gate.numbersSourced" });
  } else {
    const outcome = await numbersSourcedTool.execute({ text, sources: goldenRun.sources }, { ctx: EVAL_CTX });
    if (outcome.status !== "success") {
      results.push({ goldenRunId: goldenRun.id, check: "gate.numbersSourced", verdict: "tooling_error", reason: outcome.reason });
    } else {
      const verdict = outcome.result as GateVerdict;
      results.push({
        goldenRunId: goldenRun.id,
        check: "gate.numbersSourced",
        verdict: verdict.verdict,
        ...(verdict.verdict !== "pass" ? { reason: verdict.reason } : {}),
      });
    }
  }

  try {
    const { overallScore, overallGrade } = computeOverallScore(goldenRun.endorsedOutput.dimensionScores);
    if (overallScore === goldenRun.expectedOverallScore && overallGrade === goldenRun.expectedOverallGrade) {
      results.push({ goldenRunId: goldenRun.id, check: "computeOverallScore", verdict: "pass" });
    } else {
      results.push({
        goldenRunId: goldenRun.id,
        check: "computeOverallScore",
        verdict: "content_fail",
        reason: `expected score ${goldenRun.expectedOverallScore}/${goldenRun.expectedOverallGrade}, computed ${overallScore}/${overallGrade}`,
      });
    }
  } catch (err) {
    results.push({ goldenRunId: goldenRun.id, check: "computeOverallScore", verdict: "tooling_error", reason: err instanceof Error ? err.message : String(err) });
  }

  return results;
}
