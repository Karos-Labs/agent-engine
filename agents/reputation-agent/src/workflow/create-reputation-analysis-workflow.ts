import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { type WorkflowContext, WorkflowBlockedIntake, WorkflowToolingFailure, toAgentContext } from "@agent-engine/workflow";
import type { CaptureLegOutcome } from "@agent-engine/tool-karos-reputation";
import { parseReputationClientConfig } from "./intake.js";
import type { ReputationAnalysisWorkflowResult } from "./types.js";

/**
 * `createReputationAnalysisWorkflow()` — the "Slow Analysis Brain" scaffold
 * (RFC-08 §4, `docs/ANALYSIS-LAYERS.md`): a SEPARATE, slower-cadence pipeline
 * (client stand-up + quarterly thereafter) from the pulse runner's
 * every-3-to-7-days cadence, per RFC-08 §4's explicit "model this as a
 * second, separate `agent-engine` workflow... rather than one workflow with
 * two speeds folded together" recommendation (the same split pattern as
 * RFC-05 §2's onboarding-vs-recurring guidance).
 *
 * ============================================================================
 * BUILD STATUS (RFC-08 §4/§8, restated here so nobody mistakes this scaffold
 * for a finished pipeline): only Layer 0 (capture) does real work — it reuses
 * the already-fixture-verified `reputation.capture` tool exactly like the
 * pulse runner's own step 03. Layers 1-2 are `code`-tier in the source
 * product (`analysis.py`, deterministic, fixture-locked, its own self-test)
 * but that arithmetic has NOT been ported here — porting it byte-identically
 * is out of scope for a scaffold and was not requested with the fidelity bar
 * that `reputation.triage` itself was held to. Layers 3-5 are model-judgment
 * layers (Haiku tags/extracts, Opus synthesizes) that per RFC-08 §4/§8 "have
 * never run against real client data" — no pilot client has cleared the
 * product's own fit gate yet (RFC-08 §6), so writing real prompts/judgment
 * logic for them now would be tuning against nothing. Every phase below
 * beyond Layer 0 is a structural placeholder only: a real `wf.step.code`
 * call that runs, checkpoints, and returns an honestly-labeled
 * "not_yet_ported"/"not_yet_implemented" marker rather than fabricated
 * output.
 * ============================================================================
 *
 * Layer 4's competitor benchmark is the one phase with a REAL cross-workflow
 * dependency already wired as a structural placeholder: it is scaffolded to
 * READ i1 Intel Report's `competitor-tracking.json` output (RFC-08 §3 /
 * `REPUTATION-PLAYBOOK.md` §5b: "one owner per data source" — reputation
 * never re-collects competitor data itself), never to re-derive it. No Intel
 * Report `agent-engine` package exists yet in this repo to import from, so
 * this reads through the generic `ledger`/workspace-store surface by
 * deliverable kind rather than a typed cross-package import — the same
 * documented "explicit read-dependency between two workflows, not an
 * inlined call" shape RFC-08 §3 asks for, cited as the working example for
 * RFC-05's Intel Report/SEO-GEO boundary.
 */
export interface CreateReputationAnalysisWorkflowOptions {
  tools: AgentToolRegistry;
}


export function createReputationAnalysisWorkflow(options: CreateReputationAnalysisWorkflowOptions) {
  const tools = options.tools;

  return async function reputationAnalysisWorkflow(wf: WorkflowContext): Promise<ReputationAnalysisWorkflowResult> {
    const ctx = toAgentContext(wf);

    // ── Layer 0: capture — the one real phase, reusing the same tool the pulse runner uses ──
    const layer0Capture = await wf.step.code("layer0-capture", async () => {
      const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
      const rawConfig = configOutcome.status === "success" ? (configOutcome.result as Record<string, unknown>) : {};
      const parsed = parseReputationClientConfig(rawConfig);
      if (parsed.captureLegs.length === 0) {
        throw new WorkflowBlockedIntake(
          `no reputation capture legs are configured for this client's roster${parsed.rosterConfigError ? ` (${parsed.rosterConfigError})` : ""} — nothing for the analysis brain to capture`,
        );
      }
      const outcome = await tools["reputation.capture"]!.execute({ legs: parsed.captureLegs }, { ctx });
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`reputation.capture failed: ${outcome.status}`);
      }
      const legs = (outcome.result as { legs: CaptureLegOutcome[] }).legs;
      // A dead leg now contributes an UNAVAILABLE tombstone row (ADAPTERS.md
      // rule 1). It is a run-record fact, not a review — counting it here would
      // report a broken integration as captured coverage.
      const reviewCount = legs.reduce((sum, l) => sum + l.reviews.filter((r) => r.capture_tier !== "UNAVAILABLE").length, 0);
      return { legCount: legs.length, reviewCount };
    });

    // ── Layer 1: response-behavior mining — STUB ONLY (RFC-08 §4: code-tier in the source product, not ported) ──
    const layer1ResponseBehavior = await wf.step.code("layer1-response-behavior-mining", () => ({
      status: "not_yet_ported" as const,
      note:
        "analysis.py's response-behavior arithmetic (response-rate/latency mining over the response ledger) is deterministic and fixture-locked in the source product, but porting it byte-identical is out of scope for this scaffold — see this file's header comment. Structural placeholder only.",
    }));

    // ── Layer 2: reputation state — STUB ONLY (same reasoning as Layer 1) ──
    const layer2ReputationState = await wf.step.code("layer2-reputation-state", () => ({
      status: "not_yet_ported" as const,
      note:
        "analysis.py's reputation-state rollup (rating trend, platform mix) is deterministic and fixture-locked in the source product, but porting it byte-identical is out of scope for this scaffold — see this file's header comment. Structural placeholder only.",
    }));

    // ── Layer 3: theme mining — STUB ONLY (model-judgment layer, never run against real client data yet) ──
    const layer3ThemeMining = await wf.step.code("layer3-theme-mining", () => ({
      status: "not_yet_implemented" as const,
      note:
        "Haiku-tier per-item theme tagging over the captured review corpus is real judgment work this repo has never run against live client data (RFC-08 §6/§8: no pilot client has cleared the fit gate). Writing real prompts/logic now would be tuning against nothing — structural placeholder only, deliberately not a fabricated theme list.",
    }));

    // ── Layer 4: competitor benchmark — STUB, but with a real read-dependency shape on i1 Intel Report ──
    const layer4Benchmark = await wf.step.code("layer4-competitor-benchmark", () => {
      // RFC-08 §3: "reads i1 Competitive Intelligence's `competitor-tracking.json`
      // and run outputs, and never re-collects competitor reputation data
      // itself" — the same explicit-read-dependency shape RFC-08 §3 cites as
      // the working example for RFC-05's Intel Report/SEO-GEO boundary. This
      // phase is deliberately scaffolded as a READ, not a re-collection —
      // `competitorTrackingRead: false` below states plainly that no read has
      // actually happened yet, rather than silently defaulting to a fabricated
      // "true." There is no `intel-report-agent` `agent-engine` package built
      // in this repo yet (RFC-08's own source material list never names one as
      // already migrated), so there is nothing real to read through
      // `ledger.writeDeliverable`'s shared deliverable surface today — wiring
      // an actual cross-workflow read call against a deliverable kind that
      // does not exist anywhere would be indistinguishable from a fabricated
      // integration. This stays an honest placeholder until Intel Report is
      // itself migrated onto `agent-engine`.
      return {
        status: "not_yet_implemented" as const,
        note:
          "Layer 4's benchmark synthesis (Opus-tier judgment over Layer 3's themes plus a competitor read) is real judgment work this repo has never run against live client data — structural placeholder only.",
        competitorTrackingRead: false,
      };
    });

    // ── Layer 5: synthesis — STUB ONLY (Opus-tier judgment, never run against real client data yet) ──
    const layer5Synthesis = await wf.step.code("layer5-synthesis", () => ({
      status: "not_yet_implemented" as const,
      note:
        "The final cross-layer narrative synthesis is real judgment work this repo has never run against live client data — structural placeholder only, deliberately not a fabricated report.",
    }));

    return {
      layer0Capture,
      layer1ResponseBehavior,
      layer2ReputationState,
      layer3ThemeMining,
      layer4Benchmark,
      layer5Synthesis,
    };
  };
}
