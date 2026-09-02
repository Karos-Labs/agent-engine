import type {
  AgentContext,
  AgentToolRegistry,
  GateResponse,
  ModelRouter,
  PromptStore,
  GateVerdict,
} from "@agent-engine/core";
import { routeContextDocumentModel, type ContextDocumentRoutingOptions } from "@agent-engine/core";
import {
  readLatestBrandVoice,
  readContextDoc,
  enforceContextDocPolicy,
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
import {
  IntelReportDraftAgent,
  INTEL_REPORT_DRAFT_MAX_TOKENS,
  INTEL_REPORT_DRAFT_MODEL_POLICY,
} from "../agent/intel-report-draft-agent.js";
import type { IntelReportAgentWorkflowResult, IntelReportClientContext, IntelReportResearch } from "./types.js";

export interface CreateIntelReportAgentWorkflowOptions {
  /** The base Layer 3 registry (karos-client/research/intel/gates/ledger) — this workflow adds nothing of its own on top. */
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips the human `batch_review` gate and records a synthetic
   * `actor: "system"` approval instead — off by default, so a run built
   * without it genuinely pauses at `awaiting_gate` until a human reviews it
   * (RFC-01 §8.3), exactly like every other agent in this repo.
   *
   * THIS AGENT'S PRODUCTION WIRING NOW PASSES IT, reversing what this comment
   * used to say ("never for production wiring"). Two reasons, both specific to
   * this agent: its deliverable is not published under a client's name — it IS
   * the portal's `ClientReport` — and its gate was the one gate in this repo
   * with no auto-approve at all (`24h`/`hold`), so an unattended run could
   * only ever end at the portal's own 70-minute deliverable timeout. See
   * `buildWorkflowForProduct` (`apps/agent-server/src/wiring/workflows.ts`)
   * for the decision; the flag stays off by default so every test keeps the
   * gated behaviour.
   */
  autoApprove?: boolean;
  /**
   * SCRUM-380 (D1-v2). Per-instance model routing for the context-document
   * generation step (`02-generate-report`) — see
   * `routeContextDocumentModel` (`@agent-engine/core`) for what "document
   * complexity" is measured from and why.
   *
   * Optional, and its own default is conservative: with nothing passed, a
   * hard instance still escalates within the `anthropic` vendor (which the
   * router always has), and the cross-vendor large-context escalation stays
   * off. A deployment that has Gemini wired should pass
   * `{ allowVendorEscalation: true }`.
   */
  contextDocumentRouting?: ContextDocumentRoutingOptions;
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

    // ── 01c/01d: the client's projected target-audience and market-strategy context docs (C1/SCRUM-209, T-A9) ──
    //
    // Two separate doc types, not one combined read, and each threaded into
    // the draft prompt as its own named field: `targetAudience` steers WHO
    // the report's positioning/growth analysis should be written for, and
    // `marketStrategy` steers WHAT competitive lane the client says it is
    // playing in — a report that only knew the competitor list (already read
    // at 00-load-client-context) but not the client's own stated audience or
    // strategy could rank a competitor's move as a threat or an opportunity
    // in either direction depending on who is actually meant to read this
    // report. Unlike `readLatestBrandVoice`, these ARE checkpointed
    // (`wf.step.code` inside `readContextDoc`): a target-audience/
    // market-strategy document is client-authored reference material, not
    // something a reviewer edits mid-review the way a Brand Voice tweak
    // prompts a revision — the "always latest" freshness concern that
    // function's own doc comment describes does not apply here.
    //
    // Best-effort and non-blocking, same as every other optional context
    // read in this workflow: a client with neither doc yet projected drafts
    // exactly as this workflow did before this ticket.
    const targetAudience = await readContextDoc(wf, tools, ctx, "target-audience", "01c-load-target-audience");
    const marketStrategy = await readContextDoc(wf, tools, ctx, "market-strategy", "01d-load-market-strategy");

    // ── 01e: SCRUM-242 (T-A10) — stop failing open. intel-report-agent's row in the
    // one shared policy table (CONTEXT_DOC_POLICY) is BLOCK: this is a client-facing
    // deliverable that names external parties (competitors), so drafting it with zero
    // real grounding — generic analysis that reads exactly like a grounded report —
    // is worse than not drafting it at all. `enforceContextDocPolicy` throws
    // `WorkflowBlockedIntake` itself when EVERY context doc this agent reads is
    // absent (not merely one of the two — see that function's own doc comment),
    // UNLESS this is a `runKind: "setup"` run on this row's `bootstrapExempt`
    // exemption (SCRUM-388): onboarding dispatches this exact agent to PRODUCE
    // target-audience/market-strategy, so BLOCKing a run on documents it exists
    // to create would deadlock a fresh client's very first report forever. Every
    // recurring run still BLOCKs exactly as before — only `runKind` decides that,
    // never anything specific to this call site. The outcome is captured (not
    // discarded) because a bootstrap-exempted run must surface its DEGRADED
    // marker wherever this report actually surfaces — see 06's deliverable spread
    // and this function's own return value below.
    const contextGrounding = await wf.step.code("01e-enforce-context-doc-policy", () =>
      enforceContextDocPolicy({
        agentId: "intel-report-agent",
        docs: { "target-audience": targetAudience, "market-strategy": marketStrategy },
        runKind: wf.runKind,
      }),
    );

    // ── 02-03: generate the report, then verify its numeric claims — one full drafting pass ──
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

      // ── SCRUM-380 (D1-v2), part 2: Brand Voice, always-latest ──
      //
      // Deliberately NOT wrapped in `wf.step.code`, and deliberately read
      // HERE rather than reused from `00-load-client-context`'s checkpoint.
      // A checkpoint IS a cache: a completed step is replayed verbatim on
      // every later pass without its body running again (`step-code.ts`).
      // This run pauses at a 24-hour human gate in the middle, and the whole
      // reason a reviewer clicks "revise" is often that the voice is wrong —
      // so the realistic sequence is edit-the-Brand-Voice-then-revise, and a
      // re-draft served from yesterday's checkpoint would be blind to the
      // very edit it was asked to act on. See `readLatestBrandVoice`'s own
      // doc comment. Best-effort: a failed read falls back to the brand kit
      // step 00 already loaded, so freshness can never cost a run.
      //
      // No new checkpointed step id appears anywhere as a result — which is
      // both the mechanism and the reason `workflow-e2e.test.ts`'s exact
      // `ALL_STEP_IDS` equality still holds.
      const brandVoice = await readLatestBrandVoice(tools, ctx, clientContext.brand);

      // ── SCRUM-380 (D1-v2), part 1: complexity-driven routing for THIS instance ──
      //
      // Pure and deterministic — every signal is already in hand, so this
      // adds no tool call, no probe turn, and nothing that could fail and
      // take the run with it. Re-derived per attempt because the inputs
      // genuinely change per attempt: a revision round carries the
      // reviewer's directive and a higher round number, both of which the
      // scorer counts.
      const route = routeContextDocumentModel(
        INTEL_REPORT_DRAFT_MODEL_POLICY,
        {
          competitorCount: clientContext.competitors.length,
          evidenceChars: JSON.stringify(research.result ?? null).length,
          clientContextChars: JSON.stringify({ profile: clientContext.profile, brand: brandVoice.brand }).length,
          steerCount:
            (runDirection.direction ? 1 : 0) + (directive !== undefined ? 1 : 0) + pastFeedback.length,
          revision,
        },
        { maxOutputTokens: INTEL_REPORT_DRAFT_MAX_TOKENS, ...options.contextDocumentRouting },
      );
      const draftAgent = new IntelReportDraftAgent(
        { router: options.router, tools, promptStore: options.promptStore },
        { modelPolicy: route.policy },
      );

      const draftResult = await wf.step.agent(rev("02-generate-report"), draftAgent, {
        ...runDirectionField(runDirection),
        profile: clientContext.profile,
        // The freshly-read kit, not step 00's checkpointed copy.
        brand: brandVoice.brand,
        // First-class, alongside the client context rather than buried inside
        // the brand-kit blob: the model reads a named `brandVoice` field
        // instead of having to go looking for `brand.voice`. Omitted entirely
        // when the client has no Brand Voice set, so a client without one
        // sends a byte-identical prompt to what it sent before.
        ...(brandVoice.voice !== undefined ? { brandVoice: brandVoice.voice } : {}),
        // The client's projected target-audience and market-strategy
        // context docs (T-A9), best-effort. See 01c/01d's own comment.
        ...(targetAudience !== undefined ? { targetAudience } : {}),
        ...(marketStrategy !== undefined ? { marketStrategy } : {}),
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
      onDecision: async ({ revision, response, output }) => {
        // SCRUM-306 (AU23): a reject's drafted content previously had nowhere
        // durable to go — it lived only in this round's step checkpoints and
        // was lost the moment the run held. Attached only on reject: an
        // approval's content already has a durable copy via
        // `ledger.writeDeliverable`, and a revise round's draft is superseded
        // by the next attempt.
        await persistReviewFeedbackToMemory(
          wf,
          tools,
          ctx,
          revision,
          response,
          response.decision === "reject" ? JSON.stringify(output) : undefined,
        );
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
      deliverable: {
        ...report,
        ...writeOutcome,
        // SCRUM-242/SCRUM-388 (T-A10): the DEGRADED marker, on the actual
        // persisted deliverable a reviewer looks at — see 01e's own comment.
        ...(contextGrounding.decision === "degraded" ? { contextGrounding: contextGrounding.marker } : {}),
      },
      snapshot: (deliverableId) => ({ ...writeOutcome, deliverableId }),
    });

    // ── 08: record the review decision into durable client memory (AU22 + AU19) ──
    //
    // AU22: this step used to call `ledger.feedbackAppend`, which wrote to
    // `["ledger","feedback",runId,feedbackId]` — a path nothing in this repo
    // ever read back (no `ledger.readFeedback`/`ledger.listFeedback` tool was
    // ever registered), so every review decision here was a write into the
    // void. That tool is deleted as of AU22; the one real feedback pipeline is
    // `persistReviewFeedbackToMemory` (packages/workflow/src/primitives/
    // review-cycle.ts), which writes via `memory.appendFeedback` — the store
    // `memory.readFeedback`, and so `01b-read-past-feedback` above, actually
    // reads.
    //
    // AU19 (merged first) additionally wired `runReviewCycle`'s `onDecision`
    // to persist EVERY round's response, approvals included. This final-
    // decision write therefore lands on the same `review-feedback-r${revision}`
    // step id that `onDecision` already checkpointed for the approving round,
    // making it an idempotent backstop rather than a second record. It is kept
    // (rather than dropped) so this agent still carries the same explicit
    // 08-record-feedback step as the five other agents AU22 converted.
    //
    // `review.revision` — not a hardcoded 0 — is the round that was actually
    // approved: unlike the five agents in AU22's diff, this workflow HAS a
    // revision loop, so a report approved on round 2 must be recorded against
    // round 2.
    await persistReviewFeedbackToMemory(wf, tools, ctx, review.revision, review.response);

    return {
      overallScore: writeOutcome.overallScore,
      overallGrade: writeOutcome.overallGrade,
      competitorCount: writeOutcome.competitorCount,
      deliverableId,
      // SCRUM-242/SCRUM-388 (T-A10): same DEGRADED marker, on the workflow's
      // own typed return value — see 01e's own comment.
      ...(contextGrounding.decision === "degraded" ? { contextGrounding: contextGrounding.marker } : {}),
    };
  };
}
