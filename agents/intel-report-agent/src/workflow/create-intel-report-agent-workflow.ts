import type { AgentContext, AgentToolRegistry, GateResponse, GateVerdict, ModelRouter, PromptStore } from "@agent-engine/core";
import { type WorkflowContext, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure } from "@agent-engine/workflow";
import type { ClientBrand, ClientProfile, Competitor } from "@agent-engine/tools";
import type { IntelReportOutput } from "@agent-engine/tool-karos-intel";
import { IntelReportDraftAgent } from "../agent/intel-report-draft-agent.js";
import type { IntelReportAgentWorkflowResult, IntelReportClientContext, IntelReportResearch } from "./types.js";

export interface CreateIntelReportAgentWorkflowOptions {
  /** The base Layer 3 registry (karos-client/research/intel/gates/ledger) — this workflow adds nothing of its own on top. */
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips the human `batch_review` gate and records a synthetic
   * `actor: "system"` approval instead — off by default, so a real run
   * genuinely pauses at `awaiting_gate` until a human reviews it (RFC-01
   * §8.3), exactly like every other agent in this repo. Intended for
   * tests/demos/evals that need a synchronous happy path, never for
   * production wiring.
   */
  autoApprove?: boolean;
}

function toAgentContext(wf: WorkflowContext): AgentContext {
  return {
    runId: wf.runId,
    clientSlug: wf.clientSlug,
    productId: wf.productId,
    runKind: wf.runKind,
    ...(wf.slotId !== undefined ? { slotId: wf.slotId } : {}),
    metadata: {},
  };
}

/** Unwraps a gate tool's outcome into its `GateVerdict`, treating a broken gate call as a tooling failure — never a content verdict (RFC-01 §5.6/§6). Copied verbatim from the LinkedIn agent's workflow. */
async function runGate(
  tools: AgentToolRegistry,
  gateName: string,
  args: unknown,
  ctx: AgentContext,
): Promise<GateVerdict> {
  const tool = tools[gateName];
  if (!tool) {
    throw new WorkflowToolingFailure(`no gate registered as "${gateName}"`);
  }
  const outcome = await tool.execute(args, { ctx });
  if (outcome.status !== "success") {
    throw new WorkflowToolingFailure(`gate "${gateName}" call failed: ${outcome.status}`);
  }
  return outcome.result as GateVerdict;
}

/**
 * The 7 analysis prose fields `IntelReportOutput` carries — concatenated
 * (step 03) into the single `text` blob `gate.numbersSourced` checks every
 * numeric claim in the whole report against, in one call, rather than 7
 * separate gate calls per section.
 */
function concatenateAnalysisProse(report: IntelReportOutput): string {
  return [
    report.contentAnalysis,
    report.conversionAnalysis,
    report.seoAnalysis,
    report.geoAnalysis,
    report.positioningAnalysis,
    report.brandAnalysis,
    report.growthAnalysis,
  ].join("\n\n");
}

/**
 * `createIntelReportAgentWorkflow()` (RFC-05 §3): the one workflow used both
 * for a client's first-ever Intel Report and every later recurring "weekly
 * radar" refresh — cadence/scheduling is out of scope here, this is just
 * "run the pipeline end to end" either way.
 *
 * Deliberately, completely independent of the SEO/GEO workflow (RFC-05 §2's
 * resolved decision): this file never imports `@agent-engine/agent-seo-geo`
 * or `@agent-engine/tool-karos-seo-geo`, and never calls a `seoGeo.*` tool.
 * The legacy pipeline's hidden "regenerating the Intel Report silently
 * re-runs SEO/GEO too" coupling does not exist here in any form — an
 * onboarding orchestrator that wants both baselines can invoke this
 * workflow and the SEO/GEO workflow as two separate, explicit steps, but
 * that composition lives outside this package entirely.
 */
export function createIntelReportAgentWorkflow(options: CreateIntelReportAgentWorkflowOptions) {
  const tools = options.tools;

  return async function intelReportAgentWorkflow(wf: WorkflowContext): Promise<IntelReportAgentWorkflowResult> {
    const ctx = toAgentContext(wf);

    // ── 00: load client context — blocked_intake if the profile itself was never set up ──
    const clientContext = await wf.step.code("00-load-client-context", async (): Promise<IntelReportClientContext> => {
      const profileOutcome = await tools["client.getProfile"]!.execute({}, { ctx });
      if (profileOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client profile has not been set up yet");
      }
      const brandOutcome = await tools["client.getBrand"]!.execute({}, { ctx });
      const competitorsOutcome = await tools["client.listCompetitors"]!.execute({}, { ctx });
      return {
        profile: profileOutcome.result as ClientProfile,
        brand: brandOutcome.status === "success" ? (brandOutcome.result as ClientBrand) : {},
        competitors: competitorsOutcome.status === "success" ? (competitorsOutcome.result as Competitor[]) : [],
      };
    });

    // ── 01: competitive research pull — a plain research.pull call is sufficient here.
    // Phase 1's research.pull (packages/tools/karos-research/src/pull.ts) has no real
    // external search backend wired up yet; it's a cached, deterministic stand-in. This
    // step does not attempt to compensate for that with any extra logic of its own — the
    // evidence base for the report's competitor rows and numeric claims is only as rich as
    // whatever research.pull actually returns, same caveat every other agent in this repo
    // that calls research.pull already lives with (see e.g. linkedin-agent step 04-05). ──
    const research = await wf.step.code("01-research-pull", async (): Promise<IntelReportResearch> => {
      const industry = (clientContext.profile["industry"] as string | undefined) ?? "this industry";
      const competitorNames = clientContext.competitors.map((c) => c.name).join(", ");
      const query = competitorNames
        ? `${industry} competitive landscape vs. ${competitorNames}`
        : `${industry} competitive landscape`;
      const outcome = await tools["research.pull"]!.execute({ job: "intel-competitive-scan", query, window: "30d" }, { ctx });
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`research.pull failed: ${outcome.status}`);
      }
      const result = outcome.result as { runId: string; query: string; result: unknown; fromCache: boolean };
      return { runId: result.runId, query: result.query, result: result.result, fromCache: result.fromCache };
    });

    // ── 02: generate the report — one bounded BaseAgent, structured output straight in ──
    const draftAgent = new IntelReportDraftAgent({ router: options.router, tools, promptStore: options.promptStore });
    const draftResult = await wf.step.agent("02-generate-report", draftAgent, {
      profile: clientContext.profile,
      brand: clientContext.brand,
      competitors: clientContext.competitors,
      research: { query: research.query, result: research.result },
    });

    if (draftResult.status === "content_fail") {
      throw new WorkflowHeld(`report draft did not produce a valid structured output: ${draftResult.status}`);
    }
    if (draftResult.status !== "completed") {
      throw new WorkflowToolingFailure(`report generation step resolved to "${draftResult.status}"`);
    }
    const report = draftResult.finalOutput!;

    // ── 03: verify — every numeric claim across the 7 analysis sections must trace back
    // to the research pull's own content (RFC-05 §5 / §3 step 4's "reconcile the
    // score/grade discrepancy" note resolved: the model's dimension scores are real
    // judgment calls, never invented numbers to be caught here — this gate is about the
    // report's *prose* claims, e.g. "conversion rate improved 30%", not about the
    // dimension scores themselves). ──
    await wf.step.code("03-verify-numbers-sourced", async () => {
      const text = concatenateAnalysisProse(report);
      const sources = [research.query, JSON.stringify(research.result)];
      const verdict = await runGate(tools, "gate.numbersSourced", { text, sources }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.numbersSourced: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`numbers not sourced: ${verdict.reason}`);
      return verdict;
    });

    // ── 04: human batch-review gate — nothing ships without a real approval ──
    const reviewDecision: GateResponse = options.autoApprove
      ? await wf.step.code("04-batch-review", () => ({
          decision: "approve" as const,
          actor: "system",
          at: new Date().toISOString(),
        }))
      : await wf.step.gate("04-batch-review", {
          kind: "batch_review",
          payload: { runId: wf.runId, dimensionScores: report.dimensionScores, swot: report.swot },
          requiredRole: "account_manager",
          timeout: { duration: "24h", onTimeout: "hold" },
        });
    if (reviewDecision.decision !== "approve") {
      throw new WorkflowHeld(`batch rejected: ${reviewDecision.reason ?? "no reason given"}`);
    }

    // ── 05: persist — intel.writeReport computes overallScore/overallGrade deterministically ──
    const writeOutcome = await wf.step.code("05-persist-report", async () => {
      const outcome = await tools["intel.writeReport"]!.execute(report, { ctx });
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`intel.writeReport failed: ${outcome.status}`);
      return outcome.result as { overallScore: number; overallGrade: string; competitorCount: number };
    });

    // ── 06-07: deliverable & manifest persistence — normal portal visibility for this run ──
    const deliverableId = await wf.step.code("06-persist-deliverable", async (): Promise<string> => {
      const outcome = await tools["ledger.writeDeliverable"]!.execute(
        { runId: wf.runId, kind: "intel-report", deliverable: { ...report, ...writeOutcome } },
        { ctx },
      );
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`ledger.writeDeliverable failed: ${outcome.status}`);
      return (outcome.result as { id: string }).id;
    });

    await wf.step.code("07-persist-manifest", async () => {
      await tools["ledger.dashboardSnapshot"]!.execute(
        { runId: wf.runId, snapshot: { ...writeOutcome, deliverableId } },
        { ctx },
      );
    });

    // ── 08: record the review decision into the feedback log (learning loop, RFC-01 §8.2) ──
    await wf.step.code("08-record-feedback", async () => {
      await tools["ledger.feedbackAppend"]!.execute(
        { runId: wf.runId, feedbackId: `${wf.runId}__review`, decision: reviewDecision.decision, actor: reviewDecision.actor },
        { ctx },
      );
    });

    return {
      overallScore: writeOutcome.overallScore,
      overallGrade: writeOutcome.overallGrade,
      competitorCount: writeOutcome.competitorCount,
      deliverableId,
    };
  };
}
