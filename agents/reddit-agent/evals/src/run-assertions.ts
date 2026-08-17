import type { AgentContext, GateVerdict } from "@agent-engine/core";
import { createKarosGatesTools } from "@agent-engine/tool-karos-gates";
import { renderPreview } from "../../src/tools/render-preview.js";
import type { RedditDeterministicAssertionResult, RedditGoldenRun } from "./types.js";

const EVAL_CTX: AgentContext = {
  runId: "eval-run",
  clientSlug: "eval",
  productId: "reddit-agent",
  runKind: "manager",
  metadata: {},
};

const gates = createKarosGatesTools();

/** The Reddit-specific pitch-tells from legacy's `check-draft.mjs` (`PITCH_TELLS`/`BANNED_PHRASES`) not already covered by `karos-gates`' shared bank — mirrors `RedditDraftAgent`'s own self-critique `bannedPhrases`. */
const REDDIT_EXTRA_BANNED_PHRASES = [
  "lets dive in",
  "id be happy to help",
  "honoured to",
  "move the needle for you",
  "feel free to pm",
  "shoot me a dm",
  "happy to jump on a call",
  "check out my",
  "our platform helps",
];

/**
 * Deterministic assertions for the Reddit agent (RFC-01 §12 bullet 2): every
 * `karos-gates` check plus the mechanical `render.preview` character-limit
 * check, run against a golden run's endorsed reply (`text`, the flattened
 * field every gate and the render check actually operate on — identical to
 * `replyBody` since a reply has no separate title). Fast, free, zero model
 * cost.
 */
export async function runRedditDeterministicAssertions(goldenRun: RedditGoldenRun): Promise<RedditDeterministicAssertionResult[]> {
  const { text } = goldenRun.endorsedOutput;
  const results: RedditDeterministicAssertionResult[] = [];

  const gateChecks: Array<{ check: string; gate: string; args: unknown }> = [
    { check: "gate.lintPost", gate: "gate.lintPost", args: { text, platform: "reddit", bannedPhrases: REDDIT_EXTRA_BANNED_PHRASES } },
    { check: "gate.noPlaceholder", gate: "gate.noPlaceholder", args: { text } },
    { check: "gate.brandCompliance", gate: "gate.brandCompliance", args: { text, ...goldenRun.gateArgs.brandCompliance } },
    { check: "gate.leakCheck", gate: "gate.leakCheck", args: { text } },
    { check: "gate.numbersSourced", gate: "gate.numbersSourced", args: { text } },
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

  // The mechanical character-limit check — Reddit's real 10,000-character
  // comment limit, not gate.lintPost's more permissive submission-era "reddit"
  // platform entry (still 40,000 chars, a leftover from the pre-restoration
  // submission shape).
  const previewOutcome = await renderPreview.execute({ text }, { ctx: EVAL_CTX });
  if (previewOutcome.status !== "success") {
    results.push({ goldenRunId: goldenRun.id, check: "render.preview", verdict: "tooling_error", reason: previewOutcome.reason });
  } else if (!previewOutcome.result.withinLimit) {
    results.push({
      goldenRunId: goldenRun.id,
      check: "render.preview",
      verdict: "content_fail",
      reason: `reply ${previewOutcome.result.characterCount} chars — over Reddit's comment limit`,
    });
  } else {
    results.push({ goldenRunId: goldenRun.id, check: "render.preview", verdict: "pass" });
  }

  return results;
}
