import type { AgentContext, GateVerdict } from "@agent-engine/core";
import { createKarosGatesTools } from "@agent-engine/tool-karos-gates";
import { renderPreview } from "../../src/tools/render-preview.js";
import type { BlogDeterministicAssertionResult, BlogGoldenRun } from "./types.js";

const EVAL_CTX: AgentContext = {
  runId: "eval-run",
  clientSlug: "eval",
  productId: "blog-agent",
  runKind: "manager",
  metadata: {},
};

const gates = createKarosGatesTools();

/**
 * Deterministic assertions for the Blog agent (RFC-01 §12 bullet 2): every
 * `karos-gates` check plus the mechanical `render.preview` character-limit
 * check (title, meta description, and body all three), run against a
 * golden run's endorsed article. Fast, free, zero model cost.
 */
export async function runBlogDeterministicAssertions(goldenRun: BlogGoldenRun): Promise<BlogDeterministicAssertionResult[]> {
  const { title, metaDescription, text, platform } = goldenRun.endorsedOutput;
  const results: BlogDeterministicAssertionResult[] = [];

  const gateChecks: Array<{ check: string; gate: string; args: unknown }> = [
    { check: "gate.lintPost", gate: "gate.lintPost", args: { text, platform } },
    { check: "gate.noPlaceholder", gate: "gate.noPlaceholder", args: { text } },
    { check: "gate.brandCompliance", gate: "gate.brandCompliance", args: { text, ...goldenRun.gateArgs.brandCompliance } },
    { check: "gate.leakCheck", gate: "gate.leakCheck", args: { text } },
    { check: "gate.numbersSourced", gate: "gate.numbersSourced", args: { text, sources: goldenRun.gateArgs.numbersSourced?.sources ?? [] } },
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

  // The mechanical character-limit check — the real blog title/meta/body limits,
  // not gate.lintPost's single-field platform lookup.
  const previewOutcome = await renderPreview.execute({ title, metaDescription, text }, { ctx: EVAL_CTX });
  if (previewOutcome.status !== "success") {
    results.push({ goldenRunId: goldenRun.id, check: "render.preview", verdict: "tooling_error", reason: previewOutcome.reason });
  } else if (!previewOutcome.result.withinLimit) {
    const floorReason = !previewOutcome.result.wordCountWithinFloor
      ? `, ${previewOutcome.result.wordCount} words (under the minimum)`
      : previewOutcome.result.wordCountAboveCeiling
        ? `, ${previewOutcome.result.wordCount} words (over the target ceiling)`
        : "";
    results.push({
      goldenRunId: goldenRun.id,
      check: "render.preview",
      verdict: "content_fail",
      reason: `title ${previewOutcome.result.titleCharacterCount} / meta ${previewOutcome.result.metaDescriptionCharacterCount} / body ${previewOutcome.result.bodyCharacterCount} chars${floorReason} — outside a blog limit`,
    });
  } else {
    results.push({ goldenRunId: goldenRun.id, check: "render.preview", verdict: "pass" });
  }

  return results;
}
