import type {
  AgentContext,
  AgentToolRegistry,
  GateResponse,
  ModelRouter,
  PromptStore,
  GateVerdict,
} from "@agent-engine/core";
import {
  readRunDirection,
  runDirectionField,
  type WorkflowContext,
  WorkflowBlockedIntake,
  WorkflowHeld,
  WorkflowToolingFailure,
  toAgentContext,
  runGate,
  finalizeDeliverable,
  type RevisionNote,
  MAX_REVISION_ROUNDS,
  persistReviewFeedbackToMemory,
  readPastFeedback,
  revisionDirective,
  runReviewCycle,
} from "@agent-engine/workflow";
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

    // The run-scoped instruction someone typed in the portal, resolved once.
    // Same contract as every other agent: a typed sentence outranks the
    // agent's own subject selection, and style-only notes are deliberately not
    // promoted to subjects (see readRunDirection).
    const runDirection = readRunDirection(wf.input);

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

    // ── 01: competitive research pull ──
    //
    // `research.pull` is backed by a real scraper now, not the cached
    // deterministic stand-in this comment used to describe, so the evidence
    // base is as good as what the query asks for. That is why a typed direction
    // is folded into the QUERY and not only into the drafting step: someone who
    // wrote "focus on their pricing page changes" has named what to go and look
    // at, and a direction that only reached the writer would have it reason
    // about evidence nobody fetched. ──
    const research = await wf.step.code("01-research-pull", async (): Promise<IntelReportResearch> => {
      const industry = (clientContext.profile["industry"] as string | undefined) ?? "this industry";
      const competitorNames = clientContext.competitors.map((c) => c.name).join(", ");
      const base = competitorNames
        ? `${industry} competitive landscape vs. ${competitorNames}`
        : `${industry} competitive landscape`;
      // Appended, never substituted: the competitor names are what makes this a
      // competitive scan at all, and a direction that replaced them would
      // quietly turn the report into something else.
      const query = runDirection.direction ? `${base} — focus: ${runDirection.direction}` : base;
      const outcome = await tools["research.pull"]!.execute({ job: "intel-competitive-scan", query, window: "30d" }, { ctx });
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`research.pull failed: ${outcome.status}`);
      }
      const result = outcome.result as { runId: string; query: string; result: unknown; fromCache: boolean };
      return { runId: result.runId, query: result.query, result: result.result, fromCache: result.fromCache };
    });

    // The read side of the feedback flywheel: what this client asked for on
    // previous runs, injected into the drafting prompt. Bounded and
    // best-effort — a memory read failing must not stop a run that can draft
    // perfectly well without it.
    const pastFeedback = await readPastFeedback(wf, tools, ctx, "01b-read-past-feedback");

    // ── 02-03: generate the report, then verify its numeric claims — one full drafting pass ──
    const draftAgent = new IntelReportDraftAgent({ router: options.router, tools, promptStore: options.promptStore });
    /**
     * One full drafting pass: generate the report, then verify its numbers
     * are sourced.
     *
     * No terminal topic guardrail here, deliberately — this report is an
     * internal deliverable read by the client's own team, never published,
     * and `guardrail-coverage.test.ts` (apps/agent-server) enforces exactly
     * that split across every agent in this repo.
     *
     * Called once per REVISION round by `runReviewCycle`. `revision` is
     * folded into every checkpointed step id inside it (via `rev`), so a
     * second round genuinely re-generates instead of short-circuiting on the
     * first round's checkpoints — while everything OUTSIDE it (client
     * context, research) keeps its id and is reused. That reuse is why the
     * revision is in-run rather than a fresh run.
     */
    const draftOnce = async (revision: number, notes: readonly RevisionNote[]): Promise<IntelReportOutput> => {
      /** Revision 0 keeps the ORIGINAL ids, so a first-pass trace is unchanged. */
      const rev = (id: string) => (revision === 0 ? id : `${id}-r${revision}`);
      const directive = revisionDirective(notes);

      const draftResult = await wf.step.agent(rev("02-generate-report"), draftAgent, {
        ...runDirectionField(runDirection),
        profile: clientContext.profile,
        brand: clientContext.brand,
        competitors: clientContext.competitors,
        research: { query: research.query, result: research.result },
        // Two distinct steers, kept apart on purpose: `pastFeedback` is what
        // this client has said across previous RUNS, `revisionRequest` is what
        // a reviewer asked about THIS report minutes ago.
        ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
        ...(directive !== undefined ? { revisionRequest: directive } : {}),
      });

      if (draftResult.status === "content_fail") {
        throw new WorkflowHeld(`report draft did not produce a valid structured output: ${draftResult.status}`);
      }
      if (draftResult.status !== "completed") {
        throw new WorkflowToolingFailure(`report generation step resolved to "${draftResult.status}"`);
      }
      const report = draftResult.finalOutput!;

      // ── verify — every numeric claim across the 7 analysis sections must trace back
      // to the research pull's own content (RFC-05 §5 / §3 step 4's "reconcile the
      // score/grade discrepancy" note resolved: the model's dimension scores are real
      // judgment calls, never invented numbers to be caught here — this gate is about the
      // report's *prose* claims, e.g. "conversion rate improved 30%", not about the
      // dimension scores themselves). ──
      await wf.step.code(rev("03-verify-numbers-sourced"), async () => {
        const text = concatenateAnalysisProse(report);
        const sources = [research.query, JSON.stringify(research.result)];
        const verdict = await runGate(tools, "gate.numbersSourced", { text, sources }, ctx);
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.numbersSourced: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") throw new WorkflowHeld(`numbers not sourced: ${verdict.reason}`);
        return verdict;
      });

      return report;
    };

    // ── The universal approve / revise / reject cycle ──
    //
    // `revise` re-generates with the reviewer's feedback injected, reusing
    // everything already checkpointed, instead of holding the run and
    // forcing somebody to dispatch a fresh one that knows nothing about the
    // feedback. Every decision, approvals included, reaches client memory.
    const review = await runReviewCycle(wf, {
      gateId: "04-batch-review",
      maxRevisions: MAX_REVISION_ROUNDS,
      ...(options.autoApprove ? { autoApprove: true } : {}),
      attempt: draftOnce,
      buildGate: (report, revision) => ({
        kind: "batch_review",
        payload: { runId: wf.runId, dimensionScores: report.dimensionScores, swot: report.swot, revision },
        requiredRole: "account_manager",
        timeout: { duration: "24h", onTimeout: "hold" },
      }),
      onDecision: async ({ revision, response }) => {
        await persistReviewFeedbackToMemory(wf, tools, ctx, revision, response);
      },
    });
    const report = review.output;

    // ── 05: persist — intel.writeReport computes overallScore/overallGrade deterministically ──
    const writeOutcome = await wf.step.code("05-persist-report", async () => {
      const outcome = await tools["intel.writeReport"]!.execute(report, { ctx });
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`intel.writeReport failed: ${outcome.status}`);
      return outcome.result as { overallScore: number; overallGrade: string; competitorCount: number };
    });

    // ── 06-07: deliverable & manifest persistence — normal portal visibility for this run ──
    const deliverableId = await finalizeDeliverable(wf, tools, ctx, {
      persistDeliverableStepId: "06-persist-deliverable",
      persistManifestStepId: "07-persist-manifest",
      kind: "intel-report",
      deliverable: { ...report, ...writeOutcome },
      snapshot: (deliverableId) => ({ ...writeOutcome, deliverableId }),
    });

    // ── 08: record the review decision into the feedback log (learning loop, RFC-01 §8.2) ──
    await wf.step.code("08-record-feedback", async () => {
      await tools["ledger.feedbackAppend"]!.execute(
        { runId: wf.runId, feedbackId: `${wf.runId}__review`, decision: review.response.decision, actor: review.response.actor },
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
