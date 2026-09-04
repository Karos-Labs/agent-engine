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
  type RunDirection,
  type SlotOutcome,
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
  revisionDirective,
  runReviewCycle,
} from "@agent-engine/workflow";
import {
  GEO_READINESS_BUCKETS,
  GEO_SCORE_MODEL,
  REPRODUCIBILITY,
  SEO_BUCKETS,
  SEO_GEO_CAPTURE_ENGINES,
  SEO_GEO_VISIBILITY_ENGINES,
  SEO_GEO_VISIBILITY_ENGINE_DECISION,
  VISIBILITY_DENOMINATOR_DECISION,
  type FiredRecommendation,
  type SeoGeoCaptureCell,
  type SeoGeoCaptureTier,
  type SeoGeoVisibilityEngine,
} from "@agent-engine/tool-karos-seo-geo";
import type { SeoGeoScoreResult } from "@agent-engine/tool-karos-seo-geo";
import type { SeoGeoRecommendResult } from "@agent-engine/tool-karos-seo-geo";
import type { Competitor, TechnicalSeoSnapshot } from "@agent-engine/tools";
import { SeoGeoFixDraftAgent } from "../agent/seo-geo-fix-draft-agent.js";
import { SeoGeoNarrativeAgent } from "../agent/seo-geo-narrative-agent.js";
import { buildConnectorOverlay } from "./connector-overlay.js";
import { buildTechnicalMeasurements } from "./measurements.js";
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
   * off by default, so a run built without it genuinely pauses at
   * `awaiting_gate` at both points until a human reviews it (RFC-01 §8.3,
   * RFC-04 §2's Phase 1 and Phase 7 gates). Same opt-out pattern as
   * `linkedin-agent`'s `autoApprove`.
   *
   * THIS AGENT'S PRODUCTION WIRING NOW PASSES IT. That is a reversal of what
   * this comment used to say ("never for production wiring"), and it is a
   * product decision rather than a convenience: this agent produces
   * intelligence the portal reads back, not content published under a
   * client's name, so there is nothing here for an account manager to
   * approve. See `buildWorkflowForProduct` (`apps/agent-server/src/wiring/
   * workflows.ts`), which is the only place that decision is made and the
   * only place it should be read from — the flag stays off by default so
   * every other consumer, and every test, keeps the gated behaviour.
   */
  autoApprove?: boolean;
}

/**
 * The 4 parallel technical-SEO sub-checks RFC-04 §2 Phase 2 describes
 * (`process/phase-1-technical-seo.md`'s technical infra / on-page /
 * performance-CWV / keyword+content-gaps sub-agents). Modeled as a
 * `wf.fanout`, not 4 separate bounded `BaseAgent`s: the source skill's
 * sub-agents do real judgment over real crawl data, and `technical-infra`
 * (T-A2/SCRUM-236) now has exactly that — `research.crawlTechnicalSeo`'s real
 * robots.txt/sitemap.xml/HTTP-status facts — but the other three still have
 * no real tool behind them (on-page content parsing, Core Web Vitals RUM,
 * keyword/content-gap NLP), so fanning out over plain `research.pull` calls
 * for those three still proves the wiring end-to-end without a bounded agent
 * fabricating "CONFIRMED/LIKELY/HYPOTHESIS" findings against no real
 * evidence (see `measurements.ts`'s header comment for exactly which inputs
 * this environment can and cannot honestly measure today).
 */
const TECHNICAL_SEO_ASPECTS = ["technical-infra", "on-page", "performance-cwv", "keyword-content-gaps"] as const;

/** Filters a `wf.fanout` result down to the completed slots' outputs — failed slots (RFC-01 §5.5 isolation) are simply excluded, never crash the run. */
function completedOutputs<T>(slots: readonly SlotOutcome<T>[]): T[] {
  return slots.filter((s): s is Extract<SlotOutcome<T>, { status: "completed" }> => s.status === "completed").map((s) => s.output);
}

/**
 * T-A13/SCRUM-269: the `"reference"`-role assets a client attached to this
 * run (`RichRunInputSchema.mediaAssets`, resolved once as `runDirection` — see
 * `readRunDirection`) — a competitor teardown, a screenshot of a desired
 * layout, a brand style sheet — described to the fix-drafting and narrative
 * steps as material to ground *tone and framing* against, never as a source
 * this agent has actually fetched: neither step has a tool that reads the
 * bytes behind `uri`, only the portal-supplied metadata, so the prompt must
 * never claim to have "reviewed" it.
 *
 * Mirrors `runDirectionField`'s omit-when-absent rule for the same reason
 * that one gives: an explicit empty array in the payload invites the model to
 * remark on having nothing attached instead of simply working without the
 * field at all.
 */
function referenceMaterialsField(direction: RunDirection): { clientAttachedReferences?: Array<{ uri: string; label?: string }> } {
  const refs = direction.mediaAssets
    .filter((asset) => asset.role === "reference")
    .map((asset) => ({ uri: asset.uri, ...(asset.label !== undefined ? { label: asset.label } : {}) }));
  return refs.length > 0 ? { clientAttachedReferences: refs } : {};
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
  rawSha256?: string;
  unavailableReason?: "credit_probe_402" | "no_adapter_wired";
  aioAbsent?: boolean;
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
    ...(cell.rawSha256 !== undefined ? { rawSha256: cell.rawSha256 } : {}),
    ...(cell.unavailableReason !== undefined ? { unavailableReason: cell.unavailableReason } : {}),
    ...(cell.aioAbsent !== undefined ? { aioAbsent: cell.aioAbsent } : {}),
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
        | {
            prompts: SeoGeoPromptSetDraft["prompts"];
            competitorRoster: string[];
            promptSetHash: string;
            language?: string;
            languageFallbackApplied?: boolean;
            quotaShortfalls?: string[];
          }
        | undefined;

      // RFC-04 §3: recurring runs reuse the prior frozen prompt set "for trend
      // comparability"; only a baseline run drafts fresh. Changing the set on a
      // recurring run is a logged drift event, never silent — handled in step 04
      // once the human gate (step 03) has actually approved whatever this step proposes.
      if (wf.runKind === "recurring" && priorFrozen) {
        return {
          prompts: priorFrozen.prompts,
          competitorRoster: priorFrozen.competitorRoster,
          source: "reused",
          // `?? "en"` covers only a belief record written before this field
          // existed — every record frozen by THIS version of step 04 always
          // carries `language` (SCRUM-320: the bug this port fixes was step 04
          // silently dropping it, not step 02 failing to read it).
          language: priorFrozen.language ?? "en",
          languageFallbackApplied: priorFrozen.languageFallbackApplied ?? false,
          quotaShortfalls: priorFrozen.quotaShortfalls ?? [],
        };
      }

      // No real prompt-authoring UI/judgment source exists in this repo yet
      // (RFC-04 §2 Phase 1 calls for genuine bounded-agent drafting) — see
      // `prompt-set.ts`'s header comment for why this is a deterministic
      // template stand-in instead.
      const industry = (clientContext.profile["industry"] as string | undefined) ?? "this industry";
      const requestedLanguage = clientContext.profile["language"] as string | undefined;
      const drafted = deriveDefaultPromptSet(industry, requestedLanguage);
      const competitorRoster = clientContext.competitors.map((c) => c.name);
      return {
        prompts: drafted.prompts,
        competitorRoster,
        source: "drafted",
        language: drafted.language,
        languageFallbackApplied: drafted.languageFallbackApplied,
        quotaShortfalls: drafted.quotaShortfalls,
      };
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
            language: promptSetDraft.language,
            languageFallbackApplied: promptSetDraft.languageFallbackApplied,
            quotaShortfalls: promptSetDraft.quotaShortfalls,
            // Every prompt's `desiredOutcome` is already `DESIRED_OUTCOME_NEUTRAL_PREFILL`
            // ("named_in_answer") — surfaced again here, at the top level, as the
            // rationale the reviewer sees next to each toggle
            // (`capture-config.data.ts`'s `prefill_rule`: "shown next to each
            // toggle so the client makes a real choice, not a rubber-stamp").
            // Per-prompt edits to this default are NOT wired: `GateResponse`
            // carries only approve/revise/reject + free-text feedback, no
            // structured per-prompt override — a real gap, not silently faked.
            desiredOutcomePrefillRationale:
              "Pre-fill is NEUTRAL: default desired_outcome = named_in_answer (never named_first, which makes every prompt read as failure; never not_applicable, which hides gaps).",
          },
          requiredRole: "account_manager",
          // SCRUM-273/T-A20: shrunk from a 24h hold to a 1h auto-approve —
          // the scrape -> AI-engine-query -> inference/synthesis pipeline
          // upstream of both of this agent's gates now runs fully automated
          // end to end (T-A2/T-A3/T-A7 above), so a run no longer needs to
          // sit at `awaiting_gate` indefinitely for a human who may never
          // look; `runStepGate`'s `auto_approve` handling (packages/workflow)
          // synthesizes an `approve` from `actor: "system:gate-timeout"`
          // after 1h with no human response, distinguishable in the audit
          // trail from both a genuine human approval and `autoApprove`'s
          // own `actor: "system"` test/demo opt-out.
          timeout: { duration: "1h", onTimeout: "auto_approve" },
        });
    if (promptSetDecision.decision !== "approve") {
      throw new WorkflowHeld(`prompt set rejected: ${promptSetDecision.reason ?? "no reason given"}`);
    }

    // ── 04: freeze + hash the approved prompt set/roster — the reproducibility spine ──
    const frozen = await wf.step.code("04-freeze-prompt-set", async (): Promise<SeoGeoFrozenSet> => {
      // `language` is folded into `promptSetHash`'s own input (not just carried
      // as a sibling field) so two prompt sets that ever produced byte-identical
      // text across two languages would still mint different hashes.
      const promptSetHash = sha256Hex({ prompts: promptSetDraft.prompts, language: promptSetDraft.language });
      const competitorSetHash = sha256Hex([...promptSetDraft.competitorRoster].sort());
      // SCRUM-396: hashed over the CAPTURED engines, not the accepted ones.
      // The two lists are different on purpose (see `SEO_GEO_CAPTURE_ENGINES`)
      // and only the captured list determines the response set, so widening
      // the accepted list to seven engines leaves this hash — and therefore
      // every prior run's frozen record — untouched. The drift record below is
      // what makes a real change to the captured list visible.
      const engineListHash = sha256Hex(SEO_GEO_CAPTURE_ENGINES);
      // Phase 0's "category vocabulary" (RFC-04 §2) — the only gazetteer content
      // this environment can honestly derive yet, from the client's own industry.
      const gazetteerHash = sha256Hex({ industry: clientContext.profile["industry"] ?? null });

      const beliefsOutcome = await tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
      const beliefs = beliefsOutcome.status === "success" ? (beliefsOutcome.result as { beliefs: Record<string, unknown> }).beliefs : {};
      const priorFrozen = beliefs["seoGeoFrozenPromptSet"] as { promptSetHash?: string } | undefined;
      const driftLogged = wf.runKind === "recurring" && priorFrozen?.promptSetHash !== undefined && priorFrozen.promptSetHash !== promptSetHash;
      // SCRUM-396: the prompt set has logged its drift since RFC-04 §3/§4, but
      // the engine list — the other half of the same reproducibility spine —
      // could change the captured response set silently, because nothing
      // recomputes `engineListHash` against the stored one. Checked here, beside
      // the prompt set's own check and before either is overwritten, so the two
      // halves cannot get out of step.
      const priorEngineListHash = (beliefs["seoGeoFrozenEngineList"] as { engineListHash?: string } | undefined)?.engineListHash;
      const engineListDriftLogged = wf.runKind === "recurring" && priorEngineListHash !== undefined && priorEngineListHash !== engineListHash;

      if (engineListDriftLogged) {
        // The v2 capture contract requires a source change to carry a drift
        // event; a reader must never have to infer one by diffing two runs'
        // hashes by hand.
        await tools["memory.appendDecision"]!.execute(
          {
            decisionId: `${wf.runId}__engine_list_drift`,
            summary: `SEO & GEO captured engine list changed on a recurring run (prior hash ${priorEngineListHash}, new hash ${engineListHash}; now [${SEO_GEO_CAPTURE_ENGINES.join(", ")}]) — logged per RFC-04 §3/§4 and SCRUM-396, never silent.`,
          },
          { ctx },
        );
      }

      if (driftLogged) {
        await tools["memory.appendDecision"]!.execute(
          {
            decisionId: `${wf.runId}__prompt_set_drift`,
            summary: `SEO & GEO prompt set changed on a recurring run (prior hash ${priorFrozen!.promptSetHash}, new hash ${promptSetHash}) — logged per RFC-04 §3/§4, never silent.`,
          },
          { ctx },
        );
      }

      // SCRUM-320 fix: this diff previously omitted `language` (and
      // `languageFallbackApplied`/`quotaShortfalls`) entirely. A recurring run
      // would then read `priorFrozen.language` back as `undefined` in step 02
      // above, fall back to "en", and report `promptSet.language: "en"` in
      // every subsequent run's report/gate metadata even for a client whose
      // frozen prompts are genuinely Spanish (hash-stable, since the PROMPTS
      // themselves were still reused correctly — only the reported language
      // metadata was wrong). Every field this step freezes now round-trips
      // through belief storage, not just the prompts/hash/roster.
      await tools["memory.updateBeliefs"]!.execute(
        {
          diff: {
            seoGeoFrozenPromptSet: {
              prompts: promptSetDraft.prompts,
              competitorRoster: promptSetDraft.competitorRoster,
              promptSetHash,
              language: promptSetDraft.language,
              languageFallbackApplied: promptSetDraft.languageFallbackApplied,
              quotaShortfalls: promptSetDraft.quotaShortfalls,
              frozenAt: new Date().toISOString(),
            },
            // SCRUM-396: frozen alongside the prompt set, in the SAME diff, so
            // one recurring run cannot record a new prompt set and an old
            // engine list (or vice versa) if the second write were to fail.
            seoGeoFrozenEngineList: {
              engineListHash,
              capturedEngines: [...SEO_GEO_CAPTURE_ENGINES],
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
        language: promptSetDraft.language,
        languageFallbackApplied: promptSetDraft.languageFallbackApplied,
        quotaShortfalls: promptSetDraft.quotaShortfalls,
      };
    });

    // ── 05: crawl + technical SEO — 4 parallel sub-checks (RFC-04 §2 Phase 2), fanned out ──
    //
    // Only "technical-infra" has a real tool behind it today
    // (`research.crawlTechnicalSeo`, T-A2/SCRUM-236 — wiring T-A1's crawl
    // capabilities up as a tool for the first time). The other 3
    // (`on-page`/`performance-cwv`/`keyword-content-gaps`) still call
    // `research.pull`, exactly as before this ticket: on-page content
    // parsing, Core Web Vitals RUM, and keyword/content-gap NLP have no real
    // tool in this environment yet, so there is nothing honest for those
    // three to derive beyond what `research.pull` already did. Every aspect
    // still fans out and checkpoints independently (RFC-01 §5.5 isolation) —
    // a crawl failure never blocks the other three.
    const crawlSlots = await wf.fanout(
      "05-crawl-technical-seo",
      TECHNICAL_SEO_ASPECTS,
      async (aspect, slotCtx): Promise<SeoGeoCrawlAspectResult> => {
        const slotAgentCtx = toAgentContext(slotCtx);
        const domain = clientContext.clientDomains[0] ?? wf.clientSlug;

        if (aspect === "technical-infra") {
          const outcome = await tools["research.crawlTechnicalSeo"]!.execute({ seedUrl: `https://${domain}`, limit: 10 }, { ctx: slotAgentCtx });
          if (outcome.status !== "success") {
            throw new WorkflowToolingFailure(`research.crawlTechnicalSeo (${aspect}) failed: ${outcome.status}`);
          }
          const result = outcome.result as { runId: string; snapshot: TechnicalSeoSnapshot };
          return { aspect, runId: result.runId, fromCache: false, technicalSnapshot: result.snapshot };
        }

        // Hyphenated, not colon-separated: `research.pull`'s `job` string is used
        // directly as a `WorkspaceStore` path segment (see
        // `karos-research/src/runs.ts`'s `runSegments`), and `:` is an invalid
        // Windows path character outside a drive letter — this bit a first
        // draft of this step with an `ENOENT` on `mkdir`.
        const outcome = await tools["research.pull"]!.execute({ job: `seo-crawl-${aspect}`, query: domain, window: "30d" }, { ctx: slotAgentCtx });
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
      // "technical-infra" is the only aspect carrying a real snapshot today
      // (see step 05's own comment) — `find` rather than assuming array
      // position, since a failed technical-infra slot is simply excluded by
      // `completedOutputs` (RFC-01 §5.5), leaving `technicalSnapshot`
      // `undefined` and every derived measurement honestly `unavailable`.
      const technicalSnapshot = completedAspects.find((a) => a.aspect === "technical-infra")?.technicalSnapshot;
      return {
        seoMeasurements: buildTechnicalMeasurements(SEO_BUCKETS, technicalSnapshot),
        geoReadinessMeasurements: buildTechnicalMeasurements(GEO_READINESS_BUCKETS, technicalSnapshot),
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
    // SCRUM-396: fanned out over the CAPTURED engines. `aimode`/`google_aio`
    // are accepted by the schema but have no adapter in this build, and fanning
    // out to an adapter-less engine would write a full column of honest-but-
    // empty UNAVAILABLE cells every run — measuring nothing while lowering the
    // coverage percentage the client actually feels.
    const captureJobs: CaptureJob[] = frozen.prompts.flatMap((p) => SEO_GEO_CAPTURE_ENGINES.map((engine) => ({ ...p, engine })));

    const captureSlots = await wf.fanout(
      "07-capture-ai-visibility",
      captureJobs,
      async (job, slotCtx) => {
        const slotAgentCtx = toAgentContext(slotCtx);
        const outcome = await tools["research.captureVisibility"]!.execute(
          {
            promptId: job.promptId,
            promptText: job.promptText,
            engine: job.engine,
            clientDomains: clientContext.clientDomains,
            competitorRoster: frozen.competitorRoster,
            // The brand as a person writes it. Without it, mention detection
            // falls back to a token derived from the domain — `karoslabs.com`
            // becomes `karoslabs`, which never appears in an answer that says
            // "Karos Labs", so every measured cell for every multi-word brand
            // reported `brandMentioned: false` no matter what the engine said.
            // `competitorRoster` above has always been display names; the
            // client was the only entity matched by a mangled domain.
            ...(typeof clientContext.profile["name"] === "string" && clientContext.profile["name"].trim()
              ? { clientBrandName: (clientContext.profile["name"] as string).trim() }
              : {}),
            window: "30d",
          },
          { ctx: slotAgentCtx },
        );
        if (outcome.status !== "success") {
          throw new WorkflowToolingFailure(`research.captureVisibility (${job.engine}/${job.promptId}) failed: ${outcome.status}`);
        }
        return (outcome.result as { cell: Parameters<typeof toSeoGeoCell>[0] }).cell;
      },
      // T-A3/SCRUM-237: two of the captured engines (chatgpt/copilot) route
      // through ScrappyCoco's CLI-driven browser-automation capability, which is
      // the one least able to tolerate a large concurrent burst — the source
      // ticket's own "concurrency 3" instruction. Applied to the WHOLE capture
      // fanout (every captured engine's jobs are interleaved in
      // `captureJobs`) rather than only the ScrappyCoco-routed jobs, for
      // simplicity: a lower shared ceiling costs a real run some wall-clock
      // time, never correctness, and this fanout already isolates a single
      // slot's failure from the rest (RFC-01 §5.5) regardless of ordering.
      { concurrency: 3 },
    );

    // ── 08: assemble the frozen capture-cell blob (the "response set") ──
    const visibilityCapture = await wf.step.code("08-assemble-visibility-cells", (): SeoGeoVisibilityCapture => {
      const cells = completedOutputs(captureSlots).map(toSeoGeoCell);
      const sorted = [...cells].sort((a, b) => `${a.promptId}::${a.engine}`.localeCompare(`${b.promptId}::${b.engine}`));
      return {
        cells,
        responseSetHash: sha256Hex(sorted),
        attemptedCount: captureSlots.length,
        capturedCount: cells.length,
        // Same "usable cell" test as `denominatorFor`'s N_e branch
        // (karos-seo-geo/src/visibility-metrics.ts) — one definition, so the
        // hold below and the scorer can never disagree about what counts.
        measuredCount: cells.filter((c) => c.captureTier !== "UNAVAILABLE").length,
      };
    });

    // ── 08a: refuse to score, narrate, or deliver a report built on nothing ──
    //
    // Thrown here at workflow level rather than inside step 08, matching the
    // gate-rejection holds above: `step.code` records `status: "failed"` for
    // ANY throw including this signal (packages/workflow/src/primitives/step-code.ts),
    // and step 08 did not fail — it correctly assembled an empty response set.
    //
    // The test is `measuredCount`, NOT `capturedCount`. Every capture slot
    // completes successfully today: `research.captureVisibility` has no real
    // capture adapter wired and returns a schema-valid
    // `captureTier: "UNAVAILABLE"` cell for every (prompt, engine) pair
    // (packages/tools/karos-research/src/capture-visibility.ts). So
    // `capturedCount` equals the full prompt×engine matrix on a run that
    // measured nothing whatsoever, and a `capturedCount === 0` guard would be
    // dead code that reads like a safety valve.
    //
    // Downstream is honest in isolation — `grade_data_only_rule` scores an
    // unavailable input 0 and excludes it from `dataCoveragePct`, so the
    // numbers themselves aren't fabricated — but nothing stopped the run
    // persisting and delivering a client-facing report whose every input was
    // absent. Holding is the correct terminal state: it is recoverable, it
    // spends no further model budget on fix-drafting and narrative, and it
    // surfaces the disconnected fuel line instead of formatting it.
    //
    // This is a stopgap for the missing capture layer, not a fix for it.
    if (visibilityCapture.measuredCount === 0) {
      throw new WorkflowHeld(
        `AI-visibility capture measured nothing: ${visibilityCapture.capturedCount} of ${visibilityCapture.attemptedCount} cells captured, all "UNAVAILABLE". ` +
          `Refusing to score or deliver a report with no measured data behind it.`,
      );
    }

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

      // SCRUM-390: this used to be two calls, one per denominator ("N" and
      // "N_e") — a holdover from when RFC-04 §4 still described N vs N_e as
      // a "BLOCKING scoring-model decision for Daniel". That decision is now
      // CLOSED (AU28/SCRUM-319, frozen as `VISIBILITY_DENOMINATOR_DECISION`
      // in `packages/tools/karos-seo-geo/src/visibility-metrics.ts`), and
      // `computeVisibilityMetrics` no longer varies its output by the
      // `denominator` parameter at all: per-engine rates always use `N_e`,
      // the blended Index always uses `N`, and `denominator` survives only as
      // a deprecated, purely-echoed field (`denominatorRequested`) kept so
      // old callers still compile. Confirmed by reading
      // `visibility-metrics.ts` and `visibility-index.ts` end to end, not
      // assumed: neither function's actual computation branches on it. So
      // the two calls always produced bit-identical `seoScore`, `geoReadiness`,
      // `visibility` and `visibilityMetrics` results — one call now does the
      // work of two, and the single result serves both `visibilityByN` and
      // `visibilityByNe` below (still both present so nothing downstream that
      // reads either field breaks; SCRUM-271/T-B16's portal mapper reads
      // neither).
      const scoreOutcome = await tools["seoGeo.score"]!.execute(
        {
          seoMeasurements: technicalPhase.seoMeasurements,
          geoReadinessMeasurements: technicalPhase.geoReadinessMeasurements,
          visibility: visibilityBase,
          hashInputs,
        },
        { ctx },
      );
      if (scoreOutcome.status !== "success") {
        throw new WorkflowToolingFailure(`seoGeo.score failed: ${scoreOutcome.status}`);
      }

      const scoreResult = scoreOutcome.result as SeoGeoScoreResult;
      const missingHashInputs = REPRODUCIBILITY.hash_inputs.filter((field) => !hashInputs[field]);

      return {
        seoScore: scoreResult.seoScore,
        geoReadiness: scoreResult.geoReadiness,
        visibilityByN: scoreResult.visibility,
        visibilityByNe: scoreResult.visibility,
        inputsDigest: scoreResult.inputsDigest,
        hashInputsIncomplete: scoreResult.hashInputsIncomplete,
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
          // SCRUM-273/T-A20: same 1h auto-approve as step 03 — see that
          // gate's comment.
          timeout: { duration: "1h", onTimeout: "auto_approve" },
        });
    if (fixGenerationDecision.decision !== "approve") {
      throw new WorkflowHeld(`fix generation rejected: ${fixGenerationDecision.reason ?? "no reason given"}`);
    }

    /** What one Phase 7/8 drafting pass produces, once its own gates have all passed. */
    interface DraftResult {
      fixDrafts: SeoGeoFixDraft[];
      narrative: string;
    }

    /**
     * One full Phase 7/8 drafting pass: fix drafts (when there's something
     * agent-direct to draft), the narrative, then its numbers-sourced check.
     *
     * No terminal topic guardrail here, deliberately — this report is an
     * internal deliverable read by the client's own team, never published,
     * and `guardrail-coverage.test.ts` (apps/agent-server) enforces exactly
     * that split across every agent in this repo. See that suite's own doc
     * comment.
     *
     * Called once per REVISION round by `runReviewCycle`. `revision` is
     * folded into every checkpointed step id inside it (via `rev`), so a
     * second round genuinely re-drafts instead of short-circuiting on the
     * first round's checkpoints — while everything OUTSIDE it (scoring,
     * recommendations, the connector overlay) keeps its id and is reused.
     * That reuse is why the revision is in-run rather than a fresh run.
     *
     * This is a gap the pipeline had before this change, not merely an
     * omission of style: the only human sign-off before this was step 12's
     * `fix_generation_review`, which approves generating fixes at all —
     * BEFORE the fixes or the narrative exist. Nothing downstream of that
     * ever showed a human what the report's own prose actually says before
     * shipping it.
     */
    const draftOnce = async (revision: number, notes: readonly RevisionNote[]): Promise<DraftResult> => {
      /** Revision 0 keeps the ORIGINAL ids, so a first-pass trace is unchanged. */
      const rev = (id: string) => (revision === 0 ? id : `${id}-r${revision}`);
      const directive = revisionDirective(notes);

      // ── fix drafting — one bounded agent, only when there's something agent-direct to draft ──
      let fixDrafts: SeoGeoFixDraft[] = [];
      if (topAgentDirect.length > 0) {
        const fixAgent = new SeoGeoFixDraftAgent({ router: options.router, tools, promptStore: options.promptStore });
        const fixResult = await wf.step.agent(rev("13-draft-fixes"), fixAgent, {
          ...runDirectionField(runDirection),
          ...referenceMaterialsField(runDirection),
          firedRecommendations: topAgentDirect.map((r) => ({
            recId: r.recId,
            recommendation: r.recommendation,
            fireState: r.fireState,
            worstNorm: r.worstNorm,
            impact: r.impact,
            effort: r.effort,
          })),
          ...(directive !== undefined ? { revisionRequest: directive } : {}),
        });
        if (fixResult.status === "content_fail") {
          throw new WorkflowHeld(`fix drafting did not clear its own output validation: ${fixResult.status}`);
        }
        if (fixResult.status !== "completed") {
          throw new WorkflowToolingFailure(`fix draft step resolved to "${fixResult.status}"`);
        }
        fixDrafts = fixResult.finalOutput!.fixes;
      }

      // ── narrative drafting — the report's one prose step (RFC-04 §2 Phase 8) ──
      const narrativeAgent = new SeoGeoNarrativeAgent({ router: options.router, tools, promptStore: options.promptStore });
      const narrativeResult = await wf.step.agent(rev("14-draft-narrative"), narrativeAgent, {
        ...runDirectionField(runDirection),
        ...referenceMaterialsField(runDirection),
        seoScore: scoring.seoScore.score,
        seoDataCoveragePct: Math.round(scoring.seoScore.dataCoveragePct),
        geoReadinessScore: scoring.geoReadiness.score,
        geoDataCoveragePct: Math.round(scoring.geoReadiness.dataCoveragePct),
        visibilityIndex: scoring.visibilityByN?.index ?? null,
        firedRecommendationCount: recommendations.length,
        topFiredRecommendations: recommendations.slice(0, 3).map((r) => ({ recId: r.recId, recommendation: r.recommendation, fireState: r.fireState })),
        ...(directive !== undefined ? { revisionRequest: directive } : {}),
      });
      if (narrativeResult.status === "content_fail") {
        throw new WorkflowHeld(`narrative did not clear its own output validation: ${narrativeResult.status}`);
      }
      if (narrativeResult.status !== "completed") {
        throw new WorkflowToolingFailure(`narrative step resolved to "${narrativeResult.status}"`);
      }
      const narrative = narrativeResult.finalOutput!;

      // ── gate the narrative against fabricated numbers (RFC-04 §2 Phase 8's own recommendation) ──
      await wf.step.code(rev("15-verify-narrative-numbers"), async () => {
        const sources = buildNarrativeSources(scoring, recommendations.length);
        const verdict = await runGate(tools, "gate.numbersSourced", { text: narrative.summary, sources }, ctx);
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.numbersSourced: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") throw new WorkflowHeld(`narrative numbers not sourced: ${verdict.reason}`);
        return verdict;
      });

      return { fixDrafts, narrative: narrative.summary };
    };

    // ── 16: human batch-review gate — nothing ships without a real review of what will actually ship ──
    //
    // `revise` re-drafts the fixes/narrative with the reviewer's feedback
    // injected, reusing everything already checkpointed (scoring, the fired
    // recommendations, the connector overlay), instead of holding the run and
    // forcing somebody to dispatch a fresh one that knows nothing about the
    // feedback. Every decision, approvals included, reaches client memory.
    //
    // SCRUM-389: this was the one seo-geo-agent gate T-A20/SCRUM-273 missed —
    // its ticket text and the Batch 9 dispatch brief both described the agent
    // as having two human gates, when the file (derived here, not assumed)
    // has three: 03-prompt-set-review, 12-fix-generation-review, and this one.
    // 16-batch-review sits immediately before `finalizeDeliverable`, so it is
    // the gate actually holding the client-visible seo-geo-report — the two
    // gates T-A20 already fixed are upstream of it. Brought in line with D3/
    // SCRUM-279's same 1h/auto_approve trade its siblings already made.
    //
    // Worth stating plainly, because this is the gate where the trade bites
    // hardest: after 1h with no human response, a seo-geo-report now SHIPS
    // approved rather than staying held. That is a deliberate consequence of
    // D3, not an oversight — the failure mode this trades into is "shipped
    // without review", not "stuck forever", and D3 already judged that the
    // latter (an onboarding client stuck for 24h) is worse. But unlike the
    // upstream gates, this one gates the actual deliverable a client sees, so
    // an hour of silence here now means the report goes out unreviewed.
    const review = await runReviewCycle(wf, {
      gateId: "16-batch-review",
      maxRevisions: MAX_REVISION_ROUNDS,
      ...(options.autoApprove ? { autoApprove: true } : {}),
      attempt: draftOnce,
      buildGate: (draft, revision) => ({
        kind: "batch_review",
        payload: {
          runId: wf.runId,
          seoScore: scoring.seoScore.score,
          geoReadinessScore: scoring.geoReadiness.score,
          firedRecommendationCount: recommendations.length,
          fixDraftCount: draft.fixDrafts.length,
          preview: draft.narrative,
          revision,
        },
        requiredRole: "account_manager",
        timeout: { duration: "1h", onTimeout: "auto_approve" },
      }),
      onDecision: async ({ revision, response }) => {
        await persistReviewFeedbackToMemory(wf, tools, ctx, revision, response);
      },
    });
    const { fixDrafts, narrative: narrativeSummary } = review.output;

    // ── 17: assemble the one merged report object ──
    const report = await wf.step.code("17-assemble-report", (): SeoGeoReport => ({
      seoScore: scoring.seoScore,
      geoReadiness: scoring.geoReadiness,
      visibility: {
        byN: scoring.visibilityByN,
        byNe: scoring.visibilityByNe,
        // SCRUM-390: was a hardcoded "pending, blockingOn: Daniel" literal —
        // a client-visible artefact advertising an open decision over an
        // engine that had already resolved it. Reads the frozen record now.
        denominatorDecision: VISIBILITY_DENOMINATOR_DECISION,
      },
      geoScoreModel: {
        weightsStatus: GEO_SCORE_MODEL.weights_status,
        computed: false,
        note:
          "geo-score-v3 is a PROPOSED diagnostic pending Ines's sign-off (RFC-04 §4) — never the canonical GEO number. Not computed against this run's variable-length prompt set: the model's own formula (karos-seo-geo/src/geo-score-model.ts) assumes a fixed 10-prompt capture set, and forcing this run's N-prompt data through a /10 divisor would silently misrepresent the diagnostic's own stated formula.",
      },
      // SCRUM-396: the report used to carry no engine list at all, so every
      // renderer downstream had to hardcode a count — which is how the portal
      // ended up with an "N of 5 engines" disclosure of its own. It is stated
      // here now, derived from the ratified constant, so a client-facing engine
      // count is read rather than guessed.
      engines: {
        accepted: [...SEO_GEO_VISIBILITY_ENGINES],
        captured: [...SEO_GEO_CAPTURE_ENGINES],
        decision: SEO_GEO_VISIBILITY_ENGINE_DECISION,
      },
      connectorOverlay,
      firedRecommendations: recommendations,
      fixDrafts,
      narrative: narrativeSummary,
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
        language: frozen.language,
        languageFallbackApplied: frozen.languageFallbackApplied,
        quotaShortfalls: frozen.quotaShortfalls,
      },
      runKind: wf.runKind,
    }));

    // ── 18-19: deliverable & manifest persistence (reusing the ledger tools, same as linkedin-agent's steps 16-17) ──
    const deliverableId = await finalizeDeliverable(wf, tools, ctx, {
      persistDeliverableStepId: "18-persist-deliverable",
      persistManifestStepId: "19-persist-manifest",
      kind: "seo-geo-report",
      deliverable: report,
      snapshot: (deliverableId) => ({
        seoScore: scoring.seoScore.score,
        geoReadinessScore: scoring.geoReadiness.score,
        visibilityIndexN: scoring.visibilityByN?.index ?? null,
        firedRecommendationCount: recommendations.length,
        deliverableId,
      }),
    });

    // ── 20: commit + record (memory.appendDecision) — the review decision
    // itself is already durable: `onDecision` above called
    // `persistReviewFeedbackToMemory` for every round, which is the one real
    // feedback pipeline (AU22: this step used to also call the now-retired
    // `ledger.feedbackAppend`, a write-only log nothing ever read). ──
    await wf.step.code("20-commit-and-record", async () => {
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
