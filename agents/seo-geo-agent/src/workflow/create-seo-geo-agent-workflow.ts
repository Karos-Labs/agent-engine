import type { AgentContext, AgentToolRegistry, GateResponse, GateVerdict, ModelRouter, PromptStore } from "@agent-engine/core";
import { readRunDirection, runDirectionField, type SlotOutcome, type WorkflowContext, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure } from "@agent-engine/workflow";
import {
  GEO_READINESS_BUCKETS,
  GEO_SCORE_MODEL,
  REPRODUCIBILITY,
  SEO_BUCKETS,
  SEO_GEO_VISIBILITY_ENGINES,
  type FiredRecommendation,
  type SeoGeoCaptureCell,
  type SeoGeoCaptureTier,
  type SeoGeoVisibilityEngine,
} from "@agent-engine/tool-karos-seo-geo";
import type { SeoGeoScoreResult } from "@agent-engine/tool-karos-seo-geo";
import type { SeoGeoRecommendResult } from "@agent-engine/tool-karos-seo-geo";
import type { Competitor } from "@agent-engine/tools";
import { SeoGeoFixDraftAgent } from "../agent/seo-geo-fix-draft-agent.js";
import { SeoGeoNarrativeAgent } from "../agent/seo-geo-narrative-agent.js";
import { buildConnectorOverlay } from "./connector-overlay.js";
import { buildUnavailableMeasurements } from "./measurements.js";
import { deriveDefaultPromptSet, sha256Hex } from "./prompt-set.js";
import type {
  SeoGeoAgentWorkflowResult,
  SeoGeoClientContext,
  SeoGeoCrawlAspectResult,
  SeoGeoFixDraft,
  SeoGeoFrozenSet,
  SeoGeoIntakeConfig,
  SeoGeoPromptSetDraft,
  SeoGeoReport,
  SeoGeoScoringResult,
  SeoGeoTechnicalPhaseResult,
  SeoGeoVisibilityCapture,
} from "./types.js";

export interface CreateSeoGeoAgentWorkflowOptions {
  /** The base Layer 3 registry (karos-client/research/gates/ledger/memory/seo-geo — `createAllKarosTools()` already includes all of these). */
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips the step 03 (`prompt_set_review`) and step 12 (`fix_generation_review`)
   * human gates and records synthetic `actor: "system"` approvals instead —
   * off by default, so a real run genuinely pauses at `awaiting_gate` at both
   * points until a human reviews it (RFC-01 §8.3, RFC-04 §2's Phase 1 and
   * Phase 7 gates). Intended for tests/demos/evals that need a synchronous
   * happy path, never for production wiring — same opt-out pattern as
   * `linkedin-agent`'s `autoApprove`.
   */
  autoApprove?: boolean;
}

/** The 4 parallel technical-SEO sub-checks RFC-04 §2 Phase 2 describes (`process/phase-1-technical-seo.md`'s technical infra / on-page / performance-CWV / keyword+content-gaps sub-agents). Modeled as a `wf.fanout` over `research.pull` calls, not 4 separate bounded `BaseAgent`s: the source skill's sub-agents do real judgment over real crawl data, but this repo's crawler is a Phase-1 stand-in with nothing for a model to judge yet (see `measurements.ts`'s header comment) — fanning out proves the wiring end-to-end without a bounded agent fabricating "CONFIRMED/LIKELY/HYPOTHESIS" findings against no real evidence. */
const TECHNICAL_SEO_ASPECTS = ["technical-infra", "on-page", "performance-cwv", "keyword-content-gaps"] as const;

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

/** Unwraps a gate tool's outcome into its `GateVerdict`, treating a broken gate call as a tooling failure — never a content verdict (RFC-01 §5.6/§6). Copied verbatim from `linkedin-agent`'s `create-linkedin-agent-workflow.ts`. */
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

/** Filters a `wf.fanout` result down to the completed slots' outputs — failed slots (RFC-01 §5.5 isolation) are simply excluded, never crash the run. */
function completedOutputs<T>(slots: readonly SlotOutcome<T>[]): T[] {
  return slots.filter((s): s is Extract<SlotOutcome<T>, { status: "completed" }> => s.status === "completed").map((s) => s.output);
}

/** Best-effort domain for `seoGeo.score`'s `visibility.clientDomains` (`min(1)`). No canonical "website" field is guaranteed by `client.getProfile`'s loose shape (RFC-01 §9's onboarding-profile note) — falling back to an obviously-synthetic, never-resolvable placeholder is honest (citation/domain matching against it will simply never hit) rather than guessing a real-looking domain that might not belong to this client. */
function deriveClientDomain(profile: Record<string, unknown>, clientSlug: string): string {
  const website = typeof profile["website"] === "string" ? (profile["website"] as string) : undefined;
  if (website) {
    return website.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  }
  return `${clientSlug}.unknown-domain.invalid`;
}

/** Maps `research.captureVisibility`'s `CaptureCell` (from `@agent-engine/tool-karos-research`, re-exported via `@agent-engine/tools`) onto `karos-seo-geo`'s structurally-identical `SeoGeoCaptureCell` — the two are deliberately duplicated, not cross-imported (RFC-01 §4's tool-package independence, per `capture-visibility.ts`'s own comment), so the workflow layer is where they're explicitly reconciled. `exactOptionalPropertyTypes` means each optional field needs a conditional spread rather than a direct assignment of a possibly-`undefined` value. */
function toSeoGeoCell(cell: {
  promptId: string;
  engine: string;
  captureTier: string;
  brandMentioned: boolean;
  brandFirstMentionCharOffset?: number;
  brandCited: boolean;
  brandFirstCitationOrdinal?: number;
  competitorsNamed: Array<{ brandId: string; charOffset: number }>;
  citations: Array<{ domain: string; ordinal: number }>;
  mentionCounts: Record<string, number>;
  sentimentPerMention: Array<{ mentionIndex: number; label: "pos" | "neg" | "neutral" }>;
}): SeoGeoCaptureCell {
  return {
    promptId: cell.promptId,
    engine: cell.engine as SeoGeoVisibilityEngine,
    captureTier: cell.captureTier as SeoGeoCaptureTier,
    brandMentioned: cell.brandMentioned,
    ...(cell.brandFirstMentionCharOffset !== undefined ? { brandFirstMentionCharOffset: cell.brandFirstMentionCharOffset } : {}),
    brandCited: cell.brandCited,
    ...(cell.brandFirstCitationOrdinal !== undefined ? { brandFirstCitationOrdinal: cell.brandFirstCitationOrdinal } : {}),
    competitorsNamed: cell.competitorsNamed,
    citations: cell.citations,
    mentionCounts: cell.mentionCounts,
    sentimentPerMention: cell.sentimentPerMention,
  };
}

/** Numeric strings the Phase 8 narrative's `gate.numbersSourced` check will accept — every one is a value the workflow itself already computed, never something the narrative agent could have invented. */
function buildNarrativeSources(scoring: SeoGeoScoringResult, firedCount: number): string[] {
  const sources: string[] = [
    `${scoring.seoScore.score}`,
    `${scoring.seoScore.score}%`,
    `${scoring.geoReadiness.score}`,
    `${scoring.geoReadiness.score}%`,
    `${Math.round(scoring.seoScore.dataCoveragePct)}%`,
    `${Math.round(scoring.geoReadiness.dataCoveragePct)}%`,
    `${firedCount}`,
  ];
  if (scoring.visibilityByN) {
    sources.push(`${scoring.visibilityByN.index}`, `${scoring.visibilityByN.index}%`);
  }
  if (scoring.visibilityByNe) {
    sources.push(`${scoring.visibilityByNe.index}`, `${scoring.visibilityByNe.index}%`);
  }
  return sources;
}

/**
 * `createSeoGeoAgentWorkflow()` (RFC-04's migration of the legacy `a3` /
 * `karos-seo-geo` product): the 9-phase (0-8) audit pipeline, steps
 * `00`-`19`, shared across both run modes (`wf.runKind === "setup"` for
 * baseline onboarding capture, `"recurring"` for the monthly re-run) per
 * RFC-04 §3 — the only mode-specific behavior is step 02's prompt-set reuse.
 * Step 03 and step 12 are mandatory human gates (RFC-01 §8.3) unless
 * `options.autoApprove` opts out.
 *
 * Every deliberately-unresolved decision named in RFC-04 §4 is carried
 * forward as a typed, visible field on the final report rather than silently
 * picked: the N vs N_e visibility denominator (`report.visibility.*` — both
 * computed, never just one), `geo_score_model`'s PROPOSED weights
 * (`report.geoScoreModel`), the GSC-credential-gated connectors
 * (`report.connectorOverlay`), and `seo-geo-connectors-config-edits.txt`'s
 * gated, NOT-applied config edit (`report.connectorOverlay.pendingConfigEdit`).
 */
export function createSeoGeoAgentWorkflow(options: CreateSeoGeoAgentWorkflowOptions) {
  const tools = options.tools;

  return async function seoGeoAgentWorkflow(wf: WorkflowContext): Promise<SeoGeoAgentWorkflowResult> {
    const ctx = toAgentContext(wf);

    // The run-scoped instruction someone typed in the portal, resolved once.
    //
    // Only the two prose steps read it, and `topicOverride` is deliberately
    // unused here: this agent's subject is the client's own site, measured by
    // which recommendations actually fired, and letting a sentence redirect
    // that would produce an audit of something nobody measured.
    const runDirection = readRunDirection(wf.input);

    // ── 00: intake check — blocked_intake if foundation data is missing ──
    const intake = await wf.step.code("00-intake-check", async (): Promise<SeoGeoIntakeConfig> => {
      const profileOutcome = await tools["client.getProfile"]!.execute({}, { ctx });
      if (profileOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client profile has not been set up yet");
      }
      const brandOutcome = await tools["client.getBrand"]!.execute({}, { ctx });
      if (brandOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client has not configured a brand kit yet");
      }
      return {
        profile: profileOutcome.result as Record<string, unknown>,
        brand: brandOutcome.result as Record<string, unknown>,
      };
    });

    // ── 01: context & roster assembly (client.listCompetitors/getConfig are optional intake) ──
    const clientContext = await wf.step.code("01-load-client-context", async (): Promise<SeoGeoClientContext> => {
      const competitorsOutcome = await tools["client.listCompetitors"]!.execute({}, { ctx });
      const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
      const competitors = competitorsOutcome.status === "success" ? (competitorsOutcome.result as Competitor[]) : [];
      const config = configOutcome.status === "success" ? (configOutcome.result as Record<string, unknown>) : {};
      return {
        profile: intake.profile,
        brand: intake.brand,
        config,
        competitors: competitors.map((c) => ({ name: c.name, ...(c.website !== undefined ? { website: c.website as string } : {}) })),
        clientDomains: [deriveClientDomain(intake.profile, wf.clientSlug)],
      };
    });

    // ── 02: draft (or reuse) the prompt set — RFC-04 §3's only mode-specific step ──
    const promptSetDraft = await wf.step.code("02-draft-prompt-set", async (): Promise<SeoGeoPromptSetDraft> => {
      const beliefsOutcome = await tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
      const beliefs = beliefsOutcome.status === "success" ? (beliefsOutcome.result as { beliefs: Record<string, unknown> }).beliefs : {};
      const priorFrozen = beliefs["seoGeoFrozenPromptSet"] as
        | { prompts: SeoGeoPromptSetDraft["prompts"]; competitorRoster: string[]; promptSetHash: string }
        | undefined;

      // RFC-04 §3: recurring runs reuse the prior frozen prompt set "for trend
      // comparability"; only a baseline run drafts fresh. Changing the set on a
      // recurring run is a logged drift event, never silent — handled in step 04
      // once the human gate (step 03) has actually approved whatever this step proposes.
      if (wf.runKind === "recurring" && priorFrozen) {
        return { prompts: priorFrozen.prompts, competitorRoster: priorFrozen.competitorRoster, source: "reused" };
      }

      // No real prompt-authoring UI/judgment source exists in this repo yet
      // (RFC-04 §2 Phase 1 calls for genuine bounded-agent drafting) — see
      // `prompt-set.ts`'s header comment for why this is a deterministic
      // template stand-in instead.
      const industry = (clientContext.profile["industry"] as string | undefined) ?? "this industry";
      const prompts = deriveDefaultPromptSet(industry);
      const competitorRoster = clientContext.competitors.map((c) => c.name);
      return { prompts, competitorRoster, source: "drafted" };
    });

    // ── 03: human gate — nothing spends AI-visibility capture budget without sign-off ──
    const promptSetDecision: GateResponse = options.autoApprove
      ? await wf.step.code("03-prompt-set-review", () => ({ decision: "approve" as const, actor: "system", at: new Date().toISOString() }))
      : await wf.step.gate("03-prompt-set-review", {
          kind: "prompt_set_review",
          payload: {
            runId: wf.runId,
            prompts: promptSetDraft.prompts,
            competitorRoster: promptSetDraft.competitorRoster,
            source: promptSetDraft.source,
          },
          requiredRole: "account_manager",
          timeout: { duration: "24h", onTimeout: "hold" },
        });
    if (promptSetDecision.decision !== "approve") {
      throw new WorkflowHeld(`prompt set rejected: ${promptSetDecision.reason ?? "no reason given"}`);
    }

    // ── 04: freeze + hash the approved prompt set/roster — the reproducibility spine ──
    const frozen = await wf.step.code("04-freeze-prompt-set", async (): Promise<SeoGeoFrozenSet> => {
      const promptSetHash = sha256Hex(promptSetDraft.prompts);
      const competitorSetHash = sha256Hex([...promptSetDraft.competitorRoster].sort());
      const engineListHash = sha256Hex(SEO_GEO_VISIBILITY_ENGINES);
      // Phase 0's "category vocabulary" (RFC-04 §2) — the only gazetteer content
      // this environment can honestly derive yet, from the client's own industry.
      const gazetteerHash = sha256Hex({ industry: clientContext.profile["industry"] ?? null });

      const beliefsOutcome = await tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
      const beliefs = beliefsOutcome.status === "success" ? (beliefsOutcome.result as { beliefs: Record<string, unknown> }).beliefs : {};
      const priorFrozen = beliefs["seoGeoFrozenPromptSet"] as { promptSetHash?: string } | undefined;
      const driftLogged = wf.runKind === "recurring" && priorFrozen?.promptSetHash !== undefined && priorFrozen.promptSetHash !== promptSetHash;

      if (driftLogged) {
        await tools["memory.appendDecision"]!.execute(
          {
            decisionId: `${wf.runId}__prompt_set_drift`,
            summary: `SEO & GEO prompt set changed on a recurring run (prior hash ${priorFrozen!.promptSetHash}, new hash ${promptSetHash}) — logged per RFC-04 §3/§4, never silent.`,
          },
          { ctx },
        );
      }

      await tools["memory.updateBeliefs"]!.execute(
        {
          diff: {
            seoGeoFrozenPromptSet: {
              prompts: promptSetDraft.prompts,
              competitorRoster: promptSetDraft.competitorRoster,
              promptSetHash,
              frozenAt: new Date().toISOString(),
            },
          },
        },
        { ctx },
      );

      return {
        prompts: promptSetDraft.prompts,
        competitorRoster: promptSetDraft.competitorRoster,
        promptSetHash,
        competitorSetHash,
        engineListHash,
        gazetteerHash,
        driftLogged,
      };
    });

    // ── 05: crawl + technical SEO — 4 parallel sub-checks (RFC-04 §2 Phase 2), fanned out ──
    const crawlSlots = await wf.fanout(
      "05-crawl-technical-seo",
      TECHNICAL_SEO_ASPECTS,
      async (aspect, slotCtx): Promise<SeoGeoCrawlAspectResult> => {
        const slotAgentCtx = toAgentContext(slotCtx);
        // Hyphenated, not colon-separated: `research.pull`'s `job` string is used
        // directly as a `WorkspaceStore` path segment (see
        // `karos-research/src/runs.ts`'s `runSegments`), and `:` is an invalid
        // Windows path character outside a drive letter — this bit a first
        // draft of this step with an `ENOENT` on `mkdir`.
        const outcome = await tools["research.pull"]!.execute(
          { job: `seo-crawl-${aspect}`, query: clientContext.clientDomains[0] ?? wf.clientSlug, window: "30d" },
          { ctx: slotAgentCtx },
        );
        if (outcome.status !== "success") {
          throw new WorkflowToolingFailure(`research.pull (${aspect}) failed: ${outcome.status}`);
        }
        const result = outcome.result as { runId: string; fromCache: boolean };
        return { aspect, runId: result.runId, fromCache: result.fromCache };
      },
    );

    // ── 06: derive SEO/GEO-Readiness measurements from the crawl phase ──
    const technicalPhase = await wf.step.code("06-derive-technical-measurements", (): SeoGeoTechnicalPhaseResult => {
      const completedAspects = completedOutputs(crawlSlots);
      const crawlSnapshotHash = sha256Hex(
        [...completedAspects].sort((a, b) => a.aspect.localeCompare(b.aspect)).map((a) => ({ aspect: a.aspect, runId: a.runId })),
      );
      return {
        seoMeasurements: buildUnavailableMeasurements(SEO_BUCKETS),
        geoReadinessMeasurements: buildUnavailableMeasurements(GEO_READINESS_BUCKETS),
        crawlSnapshotHash,
        aspectsAttempted: crawlSlots.length,
        aspectsCompleted: completedAspects.length,
      };
    });

    // ── 07: AI-visibility capture — every (promptId, engine) pair, fanned out (RFC-04 §2 Phase 3) ──
    interface CaptureJob {
      promptId: string;
      promptText: string;
      engine: SeoGeoVisibilityEngine;
    }
    const captureJobs: CaptureJob[] = frozen.prompts.flatMap((p) => SEO_GEO_VISIBILITY_ENGINES.map((engine) => ({ ...p, engine })));

    const captureSlots = await wf.fanout("07-capture-ai-visibility", captureJobs, async (job, slotCtx) => {
      const slotAgentCtx = toAgentContext(slotCtx);
      const outcome = await tools["research.captureVisibility"]!.execute(
        {
          promptId: job.promptId,
          promptText: job.promptText,
          engine: job.engine,
          clientDomains: clientContext.clientDomains,
          competitorRoster: frozen.competitorRoster,
          window: "30d",
        },
        { ctx: slotAgentCtx },
      );
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`research.captureVisibility (${job.engine}/${job.promptId}) failed: ${outcome.status}`);
      }
      return (outcome.result as { cell: Parameters<typeof toSeoGeoCell>[0] }).cell;
    });

    // ── 08: assemble the frozen capture-cell blob (the "response set") ──
    const visibilityCapture = await wf.step.code("08-assemble-visibility-cells", (): SeoGeoVisibilityCapture => {
      const cells = completedOutputs(captureSlots).map(toSeoGeoCell);
      const sorted = [...cells].sort((a, b) => `${a.promptId}::${a.engine}`.localeCompare(`${b.promptId}::${b.engine}`));
      return {
        cells,
        responseSetHash: sha256Hex(sorted),
        attemptedCount: captureSlots.length,
        capturedCount: cells.length,
      };
    });

    // ── 09: deterministic scoring (RFC-04 §2 Phase 4) — the N vs N_e dual-freeze (§4) ──
    const scoring = await wf.step.code("09-compute-scores", async (): Promise<SeoGeoScoringResult> => {
      const hashInputs: Record<string, string> = {
        prompt_set_hash: frozen.promptSetHash,
        competitor_set_hash: frozen.competitorSetHash,
        engine_list_hash: frozen.engineListHash,
        response_set_hash: visibilityCapture.responseSetHash,
        gazetteer_hash: frozen.gazetteerHash,
        // Verbatim from `karos-seo-geo/src/config/scoring-config.data.ts`'s
        // `version` field ("a3-scoring-v2") — that field isn't itself
        // re-exported by the package (only its parsed bucket/reproducibility
        // sub-objects are), and that file is a "DO NOT hand-edit" verbatim
        // port, so hardcoding its known, stable version string here is safer
        // than adding a new export to a shared package for this alone.
        scoring_weights_version: "a3-scoring-v2",
        crawl_snapshot_hash: technicalPhase.crawlSnapshotHash,
        // backlink_export_date, ner_model_id, classifier_model_id,
        // reviews_snapshot_hash, entity_snapshot_hash: no Ahrefs/SERP export,
        // NER/sentiment classifier, review feed, or Wikipedia/Wikidata reader
        // is wired up in this environment (RFC-04 §5's connector-credential
        // list). Left empty rather than fabricated — `hashInputsIncomplete`
        // below honestly reports this run's reproducibility snapshot as
        // incomplete.
      };

      const visibilityBase = {
        cells: visibilityCapture.cells,
        promptCount: frozen.prompts.length,
        clientDomains: clientContext.clientDomains,
        competitorRoster: frozen.competitorRoster,
      };

      const nOutcome = await tools["seoGeo.score"]!.execute(
        {
          seoMeasurements: technicalPhase.seoMeasurements,
          geoReadinessMeasurements: technicalPhase.geoReadinessMeasurements,
          visibility: { ...visibilityBase, denominator: "N" as const },
          hashInputs,
        },
        { ctx },
      );
      if (nOutcome.status !== "success") {
        throw new WorkflowToolingFailure(`seoGeo.score (denominator N) failed: ${nOutcome.status}`);
      }

      // RFC-04 §4: N vs N_e is a "BLOCKING scoring-model decision for Daniel" —
      // both are computed from the exact same frozen capture-cell blob (never
      // recaptured) so either definition reproduces once the decision lands,
      // per the source skill's own dual-freeze requirement. Only the visibility
      // metrics differ between the two calls; seoScore/geoReadiness never depend
      // on the denominator choice.
      const neOutcome = await tools["seoGeo.score"]!.execute(
        {
          seoMeasurements: technicalPhase.seoMeasurements,
          geoReadinessMeasurements: technicalPhase.geoReadinessMeasurements,
          visibility: { ...visibilityBase, denominator: "N_e" as const },
          hashInputs,
        },
        { ctx },
      );
      if (neOutcome.status !== "success") {
        throw new WorkflowToolingFailure(`seoGeo.score (denominator N_e) failed: ${neOutcome.status}`);
      }

      const nResult = nOutcome.result as SeoGeoScoreResult;
      const neResult = neOutcome.result as SeoGeoScoreResult;
      const missingHashInputs = REPRODUCIBILITY.hash_inputs.filter((field) => !hashInputs[field]);

      return {
        seoScore: nResult.seoScore,
        geoReadiness: nResult.geoReadiness,
        visibilityByN: nResult.visibility,
        visibilityByNe: neResult.visibility,
        inputsDigest: nResult.inputsDigest,
        hashInputsIncomplete: nResult.hashInputsIncomplete,
        missingHashInputs,
      };
    });

    // ── 10: connector overlay (RFC-04 §2 Phase 5 / §4) — honest "not connected", gated edit referenced only ──
    const connectorOverlay = await wf.step.code("10-connector-overlay", () => buildConnectorOverlay());

    // ── 11: recommendations firing (RFC-04 §2 Phase 6) — a deterministic rule, zero judgment ──
    const recommendations = await wf.step.code("11-fire-recommendations", async (): Promise<FiredRecommendation[]> => {
      // `normalization` must travel with each instance — trigger.fires_when's boolean/multi_bool
      // override (norm==1 pass else fail, no "approaching" tier) depends on knowing which
      // primitive scored the worst instance, not just its norm.
      const seoInputs = scoring.seoScore.inputs.map((i) => ({ recId: i.recId, norm: i.norm, weight: i.weight, normalization: i.normalization }));
      const geoReadinessInputs = scoring.geoReadiness.inputs.map((i) => ({
        recId: i.recId,
        norm: i.norm,
        weight: i.weight,
        normalization: i.normalization,
      }));
      const outcome = await tools["seoGeo.recommend"]!.execute({ seoInputs, geoReadinessInputs }, { ctx });
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`seoGeo.recommend failed: ${outcome.status}`);
      }
      return (outcome.result as SeoGeoRecommendResult).fired;
    });

    // ── 12: human gate — "nothing is generated or shipped past this point without sign-off" (RFC-04 §2 Phase 7) ──
    const topAgentDirect = recommendations.filter((r) => r.delivery === "agent-direct").slice(0, 5);
    const fixGenerationDecision: GateResponse = options.autoApprove
      ? await wf.step.code("12-fix-generation-review", () => ({ decision: "approve" as const, actor: "system", at: new Date().toISOString() }))
      : await wf.step.gate("12-fix-generation-review", {
          kind: "fix_generation_review",
          payload: {
            runId: wf.runId,
            firedCount: recommendations.length,
            topAgentDirect: topAgentDirect.map((r) => ({ recId: r.recId, recommendation: r.recommendation, priorityScore: r.priorityScore })),
          },
          requiredRole: "account_manager",
          timeout: { duration: "24h", onTimeout: "hold" },
        });
    if (fixGenerationDecision.decision !== "approve") {
      throw new WorkflowHeld(`fix generation rejected: ${fixGenerationDecision.reason ?? "no reason given"}`);
    }

    // ── 13: fix drafting — one bounded agent, only when there's something agent-direct to draft ──
    let fixDrafts: SeoGeoFixDraft[] = [];
    if (topAgentDirect.length > 0) {
      const fixAgent = new SeoGeoFixDraftAgent({ router: options.router, tools, promptStore: options.promptStore });
      const fixResult = await wf.step.agent("13-draft-fixes", fixAgent, {
        ...runDirectionField(runDirection),
        firedRecommendations: topAgentDirect.map((r) => ({
          recId: r.recId,
          recommendation: r.recommendation,
          fireState: r.fireState,
          worstNorm: r.worstNorm,
          impact: r.impact,
          effort: r.effort,
        })),
      });
      if (fixResult.status === "content_fail") {
        throw new WorkflowHeld(`fix drafting did not clear its own output validation: ${fixResult.status}`);
      }
      if (fixResult.status !== "completed") {
        throw new WorkflowToolingFailure(`fix draft step resolved to "${fixResult.status}"`);
      }
      fixDrafts = fixResult.finalOutput!.fixes;
    }

    // ── 14: narrative drafting — the report's one prose step (RFC-04 §2 Phase 8) ──
    const narrativeAgent = new SeoGeoNarrativeAgent({ router: options.router, tools, promptStore: options.promptStore });
    const narrativeResult = await wf.step.agent("14-draft-narrative", narrativeAgent, {
      ...runDirectionField(runDirection),
      seoScore: scoring.seoScore.score,
      seoDataCoveragePct: Math.round(scoring.seoScore.dataCoveragePct),
      geoReadinessScore: scoring.geoReadiness.score,
      geoDataCoveragePct: Math.round(scoring.geoReadiness.dataCoveragePct),
      visibilityIndex: scoring.visibilityByN?.index ?? null,
      firedRecommendationCount: recommendations.length,
      topFiredRecommendations: recommendations.slice(0, 3).map((r) => ({ recId: r.recId, recommendation: r.recommendation, fireState: r.fireState })),
    });
    if (narrativeResult.status === "content_fail") {
      throw new WorkflowHeld(`narrative did not clear its own output validation: ${narrativeResult.status}`);
    }
    if (narrativeResult.status !== "completed") {
      throw new WorkflowToolingFailure(`narrative step resolved to "${narrativeResult.status}"`);
    }
    const narrative = narrativeResult.finalOutput!;

    // ── 15: gate the narrative against fabricated numbers (RFC-04 §2 Phase 8's own recommendation) ──
    await wf.step.code("15-verify-narrative-numbers", async () => {
      const sources = buildNarrativeSources(scoring, recommendations.length);
      const verdict = await runGate(tools, "gate.numbersSourced", { text: narrative.summary, sources }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.numbersSourced: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`narrative numbers not sourced: ${verdict.reason}`);
      return verdict;
    });

    // ── 16: assemble the one merged report object ──
    const report = await wf.step.code("16-assemble-report", (): SeoGeoReport => ({
      seoScore: scoring.seoScore,
      geoReadiness: scoring.geoReadiness,
      visibility: {
        byN: scoring.visibilityByN,
        byNe: scoring.visibilityByNe,
        denominatorDecision: {
          status: "pending",
          blockingOn: "Daniel — N vs N_e visibility denominator choice (RFC-04 §4)",
          defaultUsedForCanonicalScore: "N",
        },
      },
      geoScoreModel: {
        weightsStatus: GEO_SCORE_MODEL.weights_status,
        computed: false,
        note:
          "geo-score-v3 is a PROPOSED diagnostic pending Ines's sign-off (RFC-04 §4) — never the canonical GEO number. Not computed against this run's variable-length prompt set: the model's own formula (karos-seo-geo/src/geo-score-model.ts) assumes a fixed 10-prompt capture set, and forcing this run's N-prompt data through a /10 divisor would silently misrepresent the diagnostic's own stated formula.",
      },
      connectorOverlay,
      firedRecommendations: recommendations,
      fixDrafts,
      narrative: narrative.summary,
      reproducibility: {
        inputsDigest: scoring.inputsDigest,
        hashInputsIncomplete: scoring.hashInputsIncomplete,
        missingHashInputs: scoring.missingHashInputs,
      },
      promptSet: {
        prompts: frozen.prompts,
        source: promptSetDraft.source,
        promptSetHash: frozen.promptSetHash,
        competitorSetHash: frozen.competitorSetHash,
      },
      runKind: wf.runKind,
    }));

    // ── 17-18: deliverable & manifest persistence (reusing the ledger tools, same as linkedin-agent's steps 16-17) ──
    const deliverableId = await wf.step.code("17-persist-deliverable", async (): Promise<string> => {
      const outcome = await tools["ledger.writeDeliverable"]!.execute({ runId: wf.runId, kind: "seo-geo-report", deliverable: report }, { ctx });
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`ledger.writeDeliverable failed: ${outcome.status}`);
      return (outcome.result as { id: string }).id;
    });

    await wf.step.code("18-persist-manifest", async () => {
      await tools["ledger.dashboardSnapshot"]!.execute(
        {
          runId: wf.runId,
          snapshot: {
            seoScore: scoring.seoScore.score,
            geoReadinessScore: scoring.geoReadiness.score,
            visibilityIndexN: scoring.visibilityByN?.index ?? null,
            firedRecommendationCount: recommendations.length,
            deliverableId,
          },
        },
        { ctx },
      );
    });

    // ── 19: commit + record (memory.appendDecision), same convention as linkedin-agent's step 18 ──
    await wf.step.code("19-commit-and-record", async () => {
      await tools["memory.appendDecision"]!.execute(
        {
          decisionId: `${wf.runId}__decision`,
          summary: `SEO & GEO run scored SEO=${scoring.seoScore.score} GEO-Readiness=${scoring.geoReadiness.score} (partial=${scoring.seoScore.partial || scoring.geoReadiness.partial}); ${recommendations.length} recommendation(s) fired.`,
        },
        { ctx },
      );
    });

    return {
      seoScore: scoring.seoScore.score,
      geoReadinessScore: scoring.geoReadiness.score,
      visibilityIndexN: scoring.visibilityByN?.index ?? null,
      visibilityIndexNe: scoring.visibilityByNe?.index ?? null,
      firedRecommendationCount: recommendations.length,
      fixDraftCount: fixDrafts.length,
      deliverableId,
      inputsDigest: scoring.inputsDigest,
      hashInputsIncomplete: scoring.hashInputsIncomplete,
    };
  };
}
