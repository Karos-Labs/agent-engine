import type { AgentContext, GateVerdict } from "@agent-engine/core";
import { createKarosGatesTools } from "@agent-engine/tool-karos-gates";
import { renderPreview } from "../../src/tools/render-preview.js";
import type { NewsletterDeterministicAssertionResult, NewsletterGoldenRun } from "./types.js";

const EVAL_CTX: AgentContext = {
  runId: "eval-run",
  clientSlug: "eval",
  productId: "newsletter-agent",
  runKind: "manager",
  metadata: {},
};

const gates = createKarosGatesTools();

/**
 * Deterministic assertions for the Newsletter agent (RFC-01 §12 bullet 2):
 * every `karos-gates` check plus the mechanical `render.preview`
 * character-limit check (subject line, preview text, and body all three),
 * run against a golden run's endorsed edition. Fast, free, zero model cost.
 */
export async function runNewsletterDeterministicAssertions(goldenRun: NewsletterGoldenRun): Promise<NewsletterDeterministicAssertionResult[]> {
  const { subjectLine, previewText, text, platform } = goldenRun.endorsedOutput;
  const results: NewsletterDeterministicAssertionResult[] = [];

  const gateChecks: Array<{ check: string; gate: string; args: unknown }> = [
    { check: "gate.lintPost", gate: "gate.lintPost", args: { text, platform } },
    { check: "gate.noPlaceholder", gate: "gate.noPlaceholder", args: { text } },
    { check: "gate.brandCompliance", gate: "gate.brandCompliance", args: { text, ...goldenRun.gateArgs.brandCompliance } },
    { check: "gate.leakCheck", gate: "gate.leakCheck", args: { text } },
    { check: "gate.numbersSourced", gate: "gate.numbersSourced", args: { text, ...goldenRun.gateArgs.numbersSourced } },
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
    results.push({
      goldenRunId: goldenRun.id,
      check,
      verdict: verdict.verdict,
      ...(verdict.verdict !== "pass" ? { reason: verdict.reason } : {}),
    });
  }

  // The mechanical character-limit check — the real subject/preview/body limits,
  // not gate.lintPost's single-field platform lookup.
  const previewOutcome = await renderPreview.execute({ subjectLine, previewText, text }, { ctx: EVAL_CTX });
  if (previewOutcome.status !== "success") {
    results.push({ goldenRunId: goldenRun.id, check: "render.preview", verdict: "tooling_error", reason: previewOutcome.reason });
  } else if (!previewOutcome.result.withinLimit) {
    results.push({
      goldenRunId: goldenRun.id,
      check: "render.preview",
      verdict: "content_fail",
      reason: `subject ${previewOutcome.result.subjectLineCharacterCount} / preview ${previewOutcome.result.previewTextCharacterCount} / body ${previewOutcome.result.bodyCharacterCount} chars, over a newsletter limit`,
    });
  } else {
    results.push({ goldenRunId: goldenRun.id, check: "render.preview", verdict: "pass" });
  }

  return results;
}
