import type { AgentContext, AgentToolRegistry, GateVerdict, ModelRouter, PromptStore } from "@agent-engine/core";
import { type WorkflowContext, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure } from "@agent-engine/workflow";
import { XDraftAgent } from "../agent/x-draft-agent.js";
import { renderPreview, type RenderPreviewResult } from "../tools/render-preview.js";
import type {
  XAgentWorkflowResult,
  XCandidateSummary,
  XClientContext,
  XIntakeConfig,
  XSelectedCandidate,
  XTopicReservation,
} from "./types.js";

export interface CreateXAgentWorkflowOptions {
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
 * `createXAgentWorkflow()` (RFC-02 §3): the 16-step recurring/on-demand run
 * protocol, steps `00`–`15`. One post, one run (RFC-01 §16.2's ruling) — no
 * fan-out here, unlike the LinkedIn pilot; every X run produces at most one
 * deliverable.
 */
export function createXAgentWorkflow(options: CreateXAgentWorkflowOptions) {
  const tools: AgentToolRegistry = { ...options.tools, "render.preview": renderPreview };

  return async function xAgentWorkflow(wf: WorkflowContext): Promise<XAgentWorkflowResult> {
    const ctx = toAgentContext(wf);

    // ── 00: intake check — blocked_intake if foundation data is missing ──
    const intake = await wf.step.code("00-intake-check", async (): Promise<XIntakeConfig> => {
      const outcome = await tools["client.getConfig"]!.execute({}, { ctx });
      if (outcome.status !== "success") {
        throw new WorkflowBlockedIntake("client config is not available yet — cannot determine an X handle");
      }
      const config = outcome.result as Record<string, unknown>;
      if (typeof config["xHandle"] !== "string" || config["xHandle"].length === 0) {
        throw new WorkflowBlockedIntake("client has not configured an X handle yet");
      }
      return config as XIntakeConfig;
    });

    // ── 01-03: context & shelf assembly (client.*, memory.read) ──
    const clientContext = await wf.step.code("01-load-client-context", async (): Promise<XClientContext> => {
      const profile = await tools["client.getProfile"]!.execute({}, { ctx });
      const brand = await tools["client.getBrand"]!.execute({}, { ctx });
      const voiceRules = await tools["client.getVoiceRules"]!.execute({}, { ctx });
      return {
        profile: profile.status === "success" ? (profile.result as Record<string, unknown>) : {},
        brand: brand.status === "success" ? (brand.result as Record<string, unknown>) : {},
        voiceRules: voiceRules.status === "success" ? (voiceRules.result as XClientContext["voiceRules"]) : {},
      };
    });

    const beliefs = await wf.step.code("02-load-memory-shelf", async () => {
      const outcome = await tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
      return outcome.status === "success" ? outcome.result : { scope: "beliefs", beliefs: {} };
    });

    const recentDecisions = await wf.step.code("03-load-recent-decisions", async (): Promise<string[]> => {
      const outcome = await tools["memory.read"]!.execute({ scope: "decisions" }, { ctx });
      if (outcome.status !== "success") return [];
      const result = outcome.result as { scope: string; items: Array<{ summary: string }> };
      return result.items.map((item) => item.summary);
    });

    // ── 04-05: research pull (persisting verbatim raw payloads inside research.pull itself) ──
    const research = await wf.step.code("04-research-pull", async () => {
      const industry = (clientContext.profile["industry"] as string | undefined) ?? "this industry";
      const query = `${industry} trends this week`;
      const outcome = await tools["research.pull"]!.execute({ job: "x-news-scan", query, window: "24h" }, { ctx });
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`research.pull failed: ${outcome.status}`);
      }
      return outcome.result as { runId: string; query: string; fromCache: boolean };
    });

    const candidateSummary = await wf.step.code("05-extract-candidate-summary", (): XCandidateSummary => {
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

    // ── 06-08: candidate selection and angle determination ──
    const reservation = await wf.step.code("06-reserve-topic", async (): Promise<XTopicReservation> => {
      const excludeTopics = recentDecisions;
      const outcome = await tools["topics.reserve"]!.execute(
        { reservationKey: `${wf.runId}__topic`, count: 1, excludeTopics },
        { ctx },
      );
      if (outcome.status === "success") {
        const result = outcome.result as { reservationKey: string; topics: string[] };
        return { reservationKey: result.reservationKey, topics: result.topics };
      }
      // content_fail here just means the catalog floor is currently empty — not fatal,
      // step 07's precedence falls through to the research-derived candidate instead.
      return { topics: [] };
    });

    const selected = await wf.step.code("07-select-candidate", (): XSelectedCandidate => {
      // Single post selection precedence (RFC-02 §3): an explicit client request wins,
      // then a reserved catalog topic, then the research-derived fallback.
      if (intake.requestedTopic) {
        return { topic: intake.requestedTopic, source: "requested" };
      }
      if (reservation.topics.length > 0) {
        return { topic: reservation.topics[0]!, source: "reserved" };
      }
      if (candidateSummary.candidateTopic) {
        return { topic: candidateSummary.candidateTopic, source: "research" };
      }
      throw new WorkflowHeld("no candidate topic available for this run — nothing honestly cleared selection");
    });

    const angle = await wf.step.code("08-determine-angle", (): string => {
      return candidateSummary.hasNumericInsight ? "data-point" : "trend-observation";
    });

    // ── 09-12: draft execution via XDraftAgent, with machine/claim/compliance gates ──
    const draftAgent = new XDraftAgent({ router: options.router, tools, promptStore: options.promptStore });
    const draftResult = await wf.step.agent("09-draft-post", draftAgent, {
      topic: selected.topic,
      source: selected.source,
      angle,
      targetHandle: intake.xHandle,
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
      const outcome = await tools["render.preview"]!.execute({ text: draft.text }, { ctx });
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`render.preview failed: ${outcome.status}`);
      const preview = outcome.result as RenderPreviewResult;
      if (!preview.withinLimit) {
        throw new WorkflowHeld(`post exceeds the X character limit (${preview.characterCount} chars)`);
      }
      return preview;
    });

    // ── 13-14: deliverable & manifest persistence ──
    const deliverableId = await wf.step.code("13-persist-deliverable", async (): Promise<string> => {
      const outcome = await tools["ledger.writeDeliverable"]!.execute({ runId: wf.runId, kind: "x-post", deliverable: draft }, { ctx });
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`ledger.writeDeliverable failed: ${outcome.status}`);
      return (outcome.result as { id: string }).id;
    });

    await wf.step.code("14-persist-manifest", async () => {
      await tools["ledger.dashboardSnapshot"]!.execute(
        { runId: wf.runId, snapshot: { topic: selected.topic, source: selected.source, angle, deliverableId } },
        { ctx },
      );
    });

    // ── 15: commit updates (topics.commit, memory.appendDecision, ledger.feedbackAppend) ──
    await wf.step.code("15-commit-and-record", async () => {
      if (selected.source === "reserved" && reservation.reservationKey) {
        await tools["topics.commit"]!.execute({ reservationKey: reservation.reservationKey }, { ctx });
      }
      await tools["memory.appendDecision"]!.execute(
        { decisionId: `${wf.runId}__decision`, summary: `Posted about "${selected.topic}" (angle: ${angle})` },
        { ctx },
      );
      await tools["ledger.feedbackAppend"]!.execute(
        { runId: wf.runId, feedbackId: `${wf.runId}__auto`, decision: "approve", actor: "system" },
        { ctx },
      );
    });

    return { topic: selected.topic, angle, targetHandle: intake.xHandle, deliverableId };
  };
}
