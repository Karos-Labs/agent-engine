import type { AgentContext, AgentToolRegistry, GateVerdict, ModelRouter, PromptStore } from "@agent-engine/core";
import { type WorkflowContext, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure } from "@agent-engine/workflow";
import { RedditDraftAgent } from "../agent/reddit-draft-agent.js";
import { renderPreview, type RenderPreviewResult } from "../tools/render-preview.js";
import type {
  RedditAgentWorkflowResult,
  RedditCandidateSummary,
  RedditClientContext,
  RedditIntakeConfig,
  RedditSelectedCandidate,
  RedditTopicReservation,
} from "./types.js";

export interface CreateRedditAgentWorkflowOptions {
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
 * `createRedditAgentWorkflow()` (RFC-02 §5 — "same recipe" as the X and
 * LinkedIn pilots): the 16-step recurring/on-demand run protocol, steps
 * `00`–`15`. One post, one run (RFC-01 §16.2's ruling) — no fan-out here;
 * every Reddit run produces at most one deliverable, in exactly one
 * target subreddit.
 */
export function createRedditAgentWorkflow(options: CreateRedditAgentWorkflowOptions) {
  const tools: AgentToolRegistry = { ...options.tools, "render.preview": renderPreview };

  return async function redditAgentWorkflow(wf: WorkflowContext): Promise<RedditAgentWorkflowResult> {
    const ctx = toAgentContext(wf);

    // ── 00: intake check — blocked_intake if target subreddits or brand guidelines are missing ──
    const intake = await wf.step.code("00-intake-check", async (): Promise<RedditIntakeConfig> => {
      const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
      if (configOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client config is not available yet — cannot determine target subreddits");
      }
      const config = configOutcome.result as { targetSubreddits?: string[]; requestedTopic?: string; requestedSubreddit?: string };
      if (!config.targetSubreddits || config.targetSubreddits.length === 0) {
        throw new WorkflowBlockedIntake("client has not configured any target subreddits yet");
      }
      const brandOutcome = await tools["client.getBrand"]!.execute({}, { ctx });
      if (brandOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client brand guidelines have not been set up yet");
      }
      return {
        targetSubreddits: config.targetSubreddits,
        ...(config.requestedTopic !== undefined ? { requestedTopic: config.requestedTopic } : {}),
        ...(config.requestedSubreddit !== undefined ? { requestedSubreddit: config.requestedSubreddit } : {}),
      };
    });

    // ── 01-03: context & shelf assembly (client.*, memory.read) ──
    const clientContext = await wf.step.code("01-load-client-context", async (): Promise<RedditClientContext> => {
      const profile = await tools["client.getProfile"]!.execute({}, { ctx });
      const brand = await tools["client.getBrand"]!.execute({}, { ctx });
      const voiceRules = await tools["client.getVoiceRules"]!.execute({}, { ctx });
      return {
        profile: profile.status === "success" ? (profile.result as Record<string, unknown>) : {},
        brand: brand.status === "success" ? (brand.result as Record<string, unknown>) : {},
        voiceRules: voiceRules.status === "success" ? (voiceRules.result as RedditClientContext["voiceRules"]) : {},
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
      const query = `${industry} community discussion trends`;
      // Subreddit conversations move faster than LinkedIn's week-scale thought
      // leadership but slower than X's minute-by-minute news — a 3-day window.
      const outcome = await tools["research.pull"]!.execute({ job: "reddit-community-scan", query, window: "3d" }, { ctx });
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`research.pull failed: ${outcome.status}`);
      }
      return outcome.result as { runId: string; query: string; fromCache: boolean };
    });

    const candidateSummary = await wf.step.code("05-extract-candidate-summary", (): RedditCandidateSummary => {
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

    // ── 06-08: subreddit, topic, and angle selection (authenticity/value-add focus) ──
    const reservation = await wf.step.code("06-reserve-topic", async (): Promise<RedditTopicReservation> => {
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

    const selected = await wf.step.code("07-select-candidate", (): RedditSelectedCandidate => {
      // Single post selection precedence (RFC-02 §5, "same recipe" as X §3): an
      // explicit client request wins, then a reserved catalog topic, then the
      // research-derived fallback.
      let topic: string;
      let source: RedditSelectedCandidate["source"];
      if (intake.requestedTopic) {
        topic = intake.requestedTopic;
        source = "requested";
      } else if (reservation.topics.length > 0) {
        topic = reservation.topics[0]!;
        source = "reserved";
      } else if (candidateSummary.candidateTopic) {
        topic = candidateSummary.candidateTopic;
        source = "research";
      } else {
        throw new WorkflowHeld("no candidate topic available for this run — nothing honestly cleared selection");
      }

      // Subreddit selection: an explicit client request wins (if it's actually one of
      // the client's configured subreddits), otherwise the first configured subreddit.
      const targetSubreddit =
        intake.requestedSubreddit && intake.targetSubreddits.includes(intake.requestedSubreddit)
          ? intake.requestedSubreddit
          : intake.targetSubreddits[0]!;

      return { topic, source, targetSubreddit };
    });

    const angle = await wf.step.code("08-determine-angle", (): string => {
      // Reddit's craft policy is explicitly non-promotional (reddit-craft@1 §4) —
      // the non-numeric default angle names that value-add framing directly.
      return candidateSummary.hasNumericInsight ? "data-point" : "value-add-discussion";
    });

    // ── 09-12: draft execution via RedditDraftAgent, with machine/claim/compliance gates ──
    const draftAgent = new RedditDraftAgent({ router: options.router, tools, promptStore: options.promptStore });
    const draftResult = await wf.step.agent("09-draft-post", draftAgent, {
      topic: selected.topic,
      source: selected.source,
      angle,
      targetSubreddit: selected.targetSubreddit,
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
      const outcome = await tools["render.preview"]!.execute({ title: draft.title, text: draft.text }, { ctx });
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`render.preview failed: ${outcome.status}`);
      const preview = outcome.result as RenderPreviewResult;
      if (!preview.withinLimit) {
        const reason = !preview.titleWithinLimit
          ? `title exceeds Reddit's 300-character limit (${preview.titleCharacterCount} chars)`
          : `post exceeds Reddit's 40000-character body limit (${preview.bodyCharacterCount} chars)`;
        throw new WorkflowHeld(reason);
      }
      return preview;
    });

    // ── 13-14: deliverable & manifest persistence ──
    const deliverableId = await wf.step.code("13-persist-deliverable", async (): Promise<string> => {
      const outcome = await tools["ledger.writeDeliverable"]!.execute({ runId: wf.runId, kind: "reddit-post", deliverable: draft }, { ctx });
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`ledger.writeDeliverable failed: ${outcome.status}`);
      return (outcome.result as { id: string }).id;
    });

    await wf.step.code("14-persist-manifest", async () => {
      await tools["ledger.dashboardSnapshot"]!.execute(
        { runId: wf.runId, snapshot: { topic: selected.topic, source: selected.source, angle, targetSubreddit: selected.targetSubreddit, deliverableId } },
        { ctx },
      );
    });

    // ── 15: commit updates (topics.commit, memory.appendDecision, ledger.feedbackAppend) ──
    await wf.step.code("15-commit-and-record", async () => {
      if (selected.source === "reserved" && reservation.reservationKey) {
        await tools["topics.commit"]!.execute({ reservationKey: reservation.reservationKey }, { ctx });
      }
      await tools["memory.appendDecision"]!.execute(
        { decisionId: `${wf.runId}__decision`, summary: `Posted about "${selected.topic}" in r/${selected.targetSubreddit} (angle: ${angle})` },
        { ctx },
      );
      await tools["ledger.feedbackAppend"]!.execute(
        { runId: wf.runId, feedbackId: `${wf.runId}__auto`, decision: "approve", actor: "system" },
        { ctx },
      );
    });

    return { topic: selected.topic, angle, targetSubreddit: selected.targetSubreddit, deliverableId };
  };
}
