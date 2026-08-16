import type { AgentContext, AgentToolRegistry, GateVerdict, ModelRouter, PromptStore } from "@agent-engine/core";
import { type WorkflowContext, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure } from "@agent-engine/workflow";
import { NewsletterDraftAgent } from "../agent/newsletter-draft-agent.js";
import { renderPreview, type RenderPreviewResult } from "../tools/render-preview.js";
import type {
  NewsletterAgentWorkflowResult,
  NewsletterCandidateSummary,
  NewsletterClientContext,
  NewsletterIntakeConfig,
  NewsletterSelectedCandidates,
  NewsletterTopicReservation,
} from "./types.js";

export interface CreateNewsletterAgentWorkflowOptions {
  /** The base Layer 3 registry (karos-client/research/topics/gates/ledger/memory) — `render.preview` is merged in internally. */
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
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

/** Unwraps a gate tool's outcome into its `GateVerdict`, treating a broken gate call as a tooling failure — never a content verdict (RFC-01 §5.6/§6). */
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
 * `createNewsletterAgentWorkflow()` (RFC-02 §5 — "same recipe" as the X,
 * LinkedIn, Reddit, and Blog pilots): the 16-step recurring/on-demand run
 * protocol, steps `00`–`15`. One edition, one run (RFC-01 §16.2's ruling) —
 * no fan-out here; every newsletter run produces at most one deliverable.
 */
export function createNewsletterAgentWorkflow(options: CreateNewsletterAgentWorkflowOptions) {
  const tools: AgentToolRegistry = { ...options.tools, "render.preview": renderPreview };

  return async function newsletterAgentWorkflow(wf: WorkflowContext): Promise<NewsletterAgentWorkflowResult> {
    const ctx = toAgentContext(wf);

    // ── 00: intake check — blocked_intake if target audience, frequency, or brand guidelines are missing ──
    const intake = await wf.step.code("00-intake-check", async (): Promise<NewsletterIntakeConfig> => {
      const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
      if (configOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client config is not available yet — cannot determine target audience or frequency");
      }
      const config = configOutcome.result as { targetAudience?: string; frequency?: string; requestedTopic?: string };
      if (!config.targetAudience || config.targetAudience.length === 0) {
        throw new WorkflowBlockedIntake("client has not configured a target audience yet");
      }
      if (!config.frequency || config.frequency.length === 0) {
        throw new WorkflowBlockedIntake("client has not configured a newsletter frequency yet");
      }
      const brandOutcome = await tools["client.getBrand"]!.execute({}, { ctx });
      if (brandOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client brand guidelines have not been set up yet");
      }
      return {
        targetAudience: config.targetAudience,
        frequency: config.frequency,
        ...(config.requestedTopic !== undefined ? { requestedTopic: config.requestedTopic } : {}),
      };
    });

    // ── 01-03: context, audience persona, and past edition history retrieval (client.*, memory.read) ──
    const clientContext = await wf.step.code("01-load-client-context", async (): Promise<NewsletterClientContext> => {
      const profile = await tools["client.getProfile"]!.execute({}, { ctx });
      const brand = await tools["client.getBrand"]!.execute({}, { ctx });
      const voiceRules = await tools["client.getVoiceRules"]!.execute({}, { ctx });
      return {
        profile: profile.status === "success" ? (profile.result as Record<string, unknown>) : {},
        brand: brand.status === "success" ? (brand.result as Record<string, unknown>) : {},
        voiceRules: voiceRules.status === "success" ? (voiceRules.result as NewsletterClientContext["voiceRules"]) : {},
      };
    });

    const beliefs = await wf.step.code("02-load-memory-shelf", async () => {
      const outcome = await tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
      return outcome.status === "success" ? outcome.result : { scope: "beliefs", beliefs: {} };
    });

    const pastEditionHistory = await wf.step.code("03-load-recent-decisions", async (): Promise<string[]> => {
      const outcome = await tools["memory.read"]!.execute({ scope: "decisions" }, { ctx });
      if (outcome.status !== "success") return [];
      const result = outcome.result as { scope: string; items: Array<{ summary: string }> };
      return result.items.map((item) => item.summary);
    });

    // ── 04-05: curated industry & company update research (persisting verbatim raw payloads inside research.pull itself) ──
    const research = await wf.step.code("04-research-pull", async () => {
      const industry = (clientContext.profile["industry"] as string | undefined) ?? "this industry";
      const query = `${industry} industry and company update digest`;
      // Newsletter editions curate a window of updates — 14 days covers a
      // typical weekly-or-slower cadence without missing recent items.
      const outcome = await tools["research.pull"]!.execute({ job: "newsletter-digest-research", query, window: "14d" }, { ctx });
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`research.pull failed: ${outcome.status}`);
      }
      return outcome.result as { runId: string; query: string; fromCache: boolean };
    });

    const candidateSummary = await wf.step.code("05-extract-candidate-summary", (): NewsletterCandidateSummary => {
      // Phase 1's research.pull is a stand-in with no real external search backend yet
      // (see packages/tools/karos-research/src/pull.ts) — so there is no real numeric
      // insight to extract. This derives a low-confidence, clearly-labeled fallback
      // candidate from the query itself, never a fabricated statistic.
      return {
        candidateTopic: research.query,
        hasNumericInsight: false,
        sourceLabel: `research run ${research.runId}`,
      };
    });

    // ── 06-08: edition theme, main story, and secondary section curation ──
    const reservation = await wf.step.code("06-reserve-topics", async (): Promise<NewsletterTopicReservation> => {
      const excludeTopics = pastEditionHistory;
      // Up to 3 topics: one main story plus up to two secondary sections.
      const outcome = await tools["topics.reserve"]!.execute(
        { reservationKey: `${wf.runId}__topic`, count: 3, excludeTopics },
        { ctx },
      );
      if (outcome.status === "success") {
        const result = outcome.result as { reservationKey: string; topics: string[] };
        return { reservationKey: result.reservationKey, topics: result.topics };
      }
      // content_fail here just means the catalog floor doesn't have 3 available — not
      // fatal, step 07's precedence falls through to the research-derived candidate
      // instead, with no secondary sections this run.
      return { topics: [] };
    });

    const selected = await wf.step.code("07-select-candidates", (): NewsletterSelectedCandidates => {
      // Single edition selection precedence (RFC-02 §5, "same recipe" as X §3): an
      // explicit client request wins, then a reserved catalog topic, then the
      // research-derived fallback. Any reserved topics beyond the main story become
      // secondary sections (editorial curation, newsletter-craft@1 §6) — never
      // padded out if the catalog floor came up short.
      let mainStory: string;
      let source: NewsletterSelectedCandidates["source"];
      let secondaryTopics: string[];
      if (intake.requestedTopic) {
        mainStory = intake.requestedTopic;
        source = "requested";
        secondaryTopics = reservation.topics.slice(0, 2);
      } else if (reservation.topics.length > 0) {
        mainStory = reservation.topics[0]!;
        source = "reserved";
        secondaryTopics = reservation.topics.slice(1, 3);
      } else if (candidateSummary.candidateTopic) {
        mainStory = candidateSummary.candidateTopic;
        source = "research";
        secondaryTopics = [];
      } else {
        throw new WorkflowHeld("no candidate main story available for this run — nothing honestly cleared selection");
      }

      return { mainStory, source, secondaryTopics };
    });

    const theme = await wf.step.code("08-determine-edition-theme", (): string => {
      return candidateSummary.hasNumericInsight ? "data-point" : "curated-digest";
    });

    // ── 09-12: draft execution via NewsletterDraftAgent, with machine/claim/compliance gates ──
    const draftAgent = new NewsletterDraftAgent({ router: options.router, tools, promptStore: options.promptStore });
    const draftResult = await wf.step.agent("09-draft-post", draftAgent, {
      mainStory: selected.mainStory,
      secondaryTopics: selected.secondaryTopics,
      source: selected.source,
      theme,
      targetAudience: intake.targetAudience,
      frequency: intake.frequency,
      voiceRules: clientContext.voiceRules,
    });

    if (draftResult.status === "content_fail") {
      throw new WorkflowHeld(`draft did not clear its own self-critique gate: ${draftResult.status}`);
    }
    if (draftResult.status !== "completed") {
      throw new WorkflowToolingFailure(`draft step resolved to "${draftResult.status}"`);
    }
    const draft = draftResult.finalOutput!;

    await wf.step.code("10-verify-numbers-sourced", async () => {
      const sources = candidateSummary.hasNumericInsight ? [candidateSummary.sourceLabel] : [];
      const verdict = await runGate(tools, "gate.numbersSourced", { text: draft.text, sources }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.numbersSourced: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`numbers not sourced: ${verdict.reason}`);
      return verdict;
    });

    await wf.step.code("11-verify-brand-compliance", async () => {
      const forbiddenTerms = clientContext.brand["forbiddenTerms"] as string[] | undefined;
      const verdict = await runGate(tools, "gate.brandCompliance", { text: draft.text, forbiddenTerms: forbiddenTerms ?? [] }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.brandCompliance: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`brand compliance failed: ${verdict.reason}`);
      return verdict;
    });

    await wf.step.code("12-render-preview-check", async () => {
      const outcome = await tools["render.preview"]!.execute(
        { subjectLine: draft.subjectLine, previewText: draft.previewText, text: draft.text },
        { ctx },
      );
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`render.preview failed: ${outcome.status}`);
      const preview = outcome.result as RenderPreviewResult;
      if (!preview.withinLimit) {
        const reason = !preview.subjectLineWithinLimit
          ? `subject line exceeds the 70-character limit (${preview.subjectLineCharacterCount} chars)`
          : !preview.previewTextWithinLimit
            ? `preview text exceeds the 140-character limit (${preview.previewTextCharacterCount} chars)`
            : `edition exceeds the 10000-character body limit (${preview.bodyCharacterCount} chars)`;
        throw new WorkflowHeld(reason);
      }
      return preview;
    });

    // ── 13-14: deliverable & manifest persistence ──
    const deliverableId = await wf.step.code("13-persist-deliverable", async (): Promise<string> => {
      const outcome = await tools["ledger.writeDeliverable"]!.execute({ runId: wf.runId, kind: "newsletter-edition", deliverable: draft }, { ctx });
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`ledger.writeDeliverable failed: ${outcome.status}`);
      return (outcome.result as { id: string }).id;
    });

    await wf.step.code("14-persist-manifest", async () => {
      await tools["ledger.dashboardSnapshot"]!.execute(
        {
          runId: wf.runId,
          snapshot: {
            mainStory: selected.mainStory,
            source: selected.source,
            theme,
            secondaryTopics: selected.secondaryTopics,
            deliverableId,
          },
        },
        { ctx },
      );
    });

    // ── 15: commit updates (topics.commit, memory.appendDecision, ledger.feedbackAppend) ──
    await wf.step.code("15-commit-and-record", async () => {
      if (selected.source === "reserved" && reservation.reservationKey) {
        await tools["topics.commit"]!.execute({ reservationKey: reservation.reservationKey }, { ctx });
      }
      await tools["memory.appendDecision"]!.execute(
        {
          decisionId: `${wf.runId}__decision`,
          summary: `Sent edition about "${selected.mainStory}" (theme: ${theme}, secondary: ${selected.secondaryTopics.join(", ") || "none"})`,
        },
        { ctx },
      );
      await tools["ledger.feedbackAppend"]!.execute(
        { runId: wf.runId, feedbackId: `${wf.runId}__auto`, decision: "approve", actor: "system" },
        { ctx },
      );
    });

    return { mainStory: selected.mainStory, theme, targetAudience: intake.targetAudience, deliverableId };
  };
}
