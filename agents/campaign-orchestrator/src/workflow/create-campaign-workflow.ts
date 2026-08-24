import type { AgentContext, AgentToolRegistry, ModelRouter, PromptStore } from "@agent-engine/core";
import { readRunDirection, runDirectionField, type WorkflowContext, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure } from "@agent-engine/workflow";
import { createXAgentWorkflow } from "@agent-engine/agent-x";
import { createLinkedInAgentWorkflow } from "@agent-engine/agent-linkedin";
import { createRedditAgentWorkflow } from "@agent-engine/agent-reddit";
import { createBlogAgentWorkflow } from "@agent-engine/agent-blog";
import { createNewsletterAgentWorkflow } from "@agent-engine/agent-newsletter";
import { CampaignStrategyAgent, type CampaignChannel } from "../agent/campaign-strategy-agent.js";
import type {
  CampaignAgentWorkflowResult,
  CampaignChannelResult,
  CampaignClientContext,
  CampaignIntakeConfig,
  CampaignStrategicSummary,
  CampaignTopicPool,
} from "./types.js";

/** What every channel's own workflow factory needs — structurally identical across all five packages. */
export interface ChannelRuntimeOptions {
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Always `true` here (never surfaced as an orchestrator-level option): the
   * campaign's own `13-campaign-review` gate is the single human checkpoint
   * for the whole bundle (RFC-02 §4) — a channel pausing at its own
   * per-channel `13-batch-review` gate mid-fan-out would mean five separate
   * approvals instead of one, which is exactly what the campaign gate exists
   * to replace.
   */
  autoApprove: true;
}

export interface CreateCampaignWorkflowOptions {
  /** The base Layer 3 registry shared by every channel — each channel's own workflow factory merges in its own `render.preview` internally. */
  tools: AgentToolRegistry;
  /** Resolves `campaign-craft@1` for `CampaignStrategyAgent`. */
  promptStore: PromptStore;
  /** Drives `CampaignStrategyAgent`'s own turn. */
  router: ModelRouter;
  /** One PromptStore per channel — each pointed at that channel's own prompts directory (`x-craft@1`, `linkedin-craft@1`, ...). */
  channelPromptStores: Record<CampaignChannel, PromptStore>;
  /**
   * One ModelRouter per channel. Deliberately separate from the strategy
   * agent's own `router` and from each other: the fan-out runs all five
   * channels concurrently (RFC-01 §5.5), so a single shared FIFO-queue fake
   * router would race on call order across channels in tests. A real
   * `DefaultModelRouter` has no such ordering dependency and can be shared
   * freely; this separation only matters for scripted test routers.
   */
  channelRouters: Record<CampaignChannel, ModelRouter>;
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

/** Dispatches to the right channel's own, already-proven `createXAgentWorkflow()`-style factory — every channel's own 17-step workflow runs unmodified (with its own per-channel gate auto-approved), just inside this slot. */
async function runChannelSlot(
  channel: CampaignChannel,
  channelOptions: ChannelRuntimeOptions,
  wf: WorkflowContext,
): Promise<{ deliverableId: string }> {
  switch (channel) {
    case "x":
      return createXAgentWorkflow(channelOptions)(wf);
    case "linkedin":
      return createLinkedInAgentWorkflow(channelOptions)(wf);
    case "reddit":
      return createRedditAgentWorkflow(channelOptions)(wf);
    case "blog":
      return createBlogAgentWorkflow(channelOptions)(wf);
    case "newsletter":
      return createNewsletterAgentWorkflow(channelOptions)(wf);
  }
}

/**
 * `createCampaignWorkflow()` (RFC-02 §4): the 16-step orchestrator
 * protocol, steps `00`–`15`. Unlike every channel agent, this workflow
 * doesn't draft anything itself — `06`-`08` produce a cross-channel
 * strategy plan, `09`-`12` fan that plan out across the five channels'
 * own workflows (RFC-01 §5.5's per-slot isolation — each channel's own
 * "00-intake-check" etc. gets its own checkpoint via `${slotId}::${id}`,
 * completely unmodified from how it runs standalone), and `13` pauses for
 * one human review of the whole bundle before `14`-`15` persist and
 * commit. The plan's per-slot `targetAudience`/`angle`/`keyMessage` are
 * persisted as the campaign's documented strategy intent (RFC-02 §4); each
 * channel still autonomously selects its own actual topic from the shared
 * catalog via its own internal `topics.reserve`/`research.pull` — Phase 1
 * doesn't yet thread the plan's assignment into that selection, the same
 * kind of documented simplification as `research.pull`'s stand-in search
 * backend (`packages/tools/karos-research/src/pull.ts`).
 */
export function createCampaignWorkflow(options: CreateCampaignWorkflowOptions) {
  return async function campaignWorkflow(wf: WorkflowContext): Promise<CampaignAgentWorkflowResult> {
    const ctx = toAgentContext(wf);

    // The run-scoped instruction someone typed in the portal, resolved once.
    // Same contract as every other agent: a typed sentence outranks the
    // agent's own subject selection, and style-only notes are deliberately not
    // promoted to subjects (see readRunDirection).
    const runDirection = readRunDirection(wf.input);

    // ── 00: intake & brief check — blocked_intake if campaign goals or brand baseline are missing ──
    const intake = await wf.step.code("00-intake-check", async (): Promise<CampaignIntakeConfig> => {
      const configOutcome = await options.tools["client.getConfig"]!.execute({}, { ctx });
      if (configOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client config is not available yet — cannot determine campaign goals");
      }
      const config = configOutcome.result as { campaignGoals?: string; requestedTheme?: string };
      if (!config.campaignGoals || config.campaignGoals.length === 0) {
        throw new WorkflowBlockedIntake("client has not supplied campaign goals yet");
      }
      const brandOutcome = await options.tools["client.getBrand"]!.execute({}, { ctx });
      if (brandOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client brand baseline has not been set up yet");
      }
      return {
        goals: config.campaignGoals,
        ...(config.requestedTheme !== undefined ? { requestedTheme: config.requestedTheme } : {}),
      };
    });

    // ── 01-03: brand identity, past campaign performance, and memory assembly ──
    const clientContext = await wf.step.code("01-load-client-context", async (): Promise<CampaignClientContext> => {
      const profile = await options.tools["client.getProfile"]!.execute({}, { ctx });
      const brand = await options.tools["client.getBrand"]!.execute({}, { ctx });
      const voiceRules = await options.tools["client.getVoiceRules"]!.execute({}, { ctx });
      return {
        profile: profile.status === "success" ? (profile.result as Record<string, unknown>) : {},
        brand: brand.status === "success" ? (brand.result as Record<string, unknown>) : {},
        voiceRules: voiceRules.status === "success" ? (voiceRules.result as CampaignClientContext["voiceRules"]) : {},
      };
    });

    const beliefs = await wf.step.code("02-load-memory-shelf", async () => {
      const outcome = await options.tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
      return outcome.status === "success" ? outcome.result : { scope: "beliefs", beliefs: {} };
    });

    const pastCampaignPerformance = await wf.step.code("03-load-past-campaign-performance", async (): Promise<string[]> => {
      const outcome = await options.tools["memory.read"]!.execute({ scope: "decisions" }, { ctx });
      if (outcome.status !== "success") return [];
      const result = outcome.result as { scope: string; items: Array<{ summary: string }> };
      return result.items.map((item) => item.summary);
    });

    // ── 04-05: strategic industry/market research (persisting verbatim raw payloads inside research.pull itself) ──
    const research = await wf.step.code("04-research-pull", async () => {
      const industry = (clientContext.profile["industry"] as string | undefined) ?? "this industry";
      const query = `${industry} strategic market and competitive landscape research`;
      // Campaign strategy looks further out than any single channel's own research —
      // a 30-day window, matching Blog's evergreen-content horizon.
      const outcome = await options.tools["research.pull"]!.execute({ job: "campaign-strategic-research", query, window: "30d" }, { ctx });
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`research.pull failed: ${outcome.status}`);
      }
      return outcome.result as { runId: string; query: string; fromCache: boolean };
    });

    const strategicSummary = await wf.step.code("05-extract-strategic-summary", (): CampaignStrategicSummary => {
      // Phase 1's research.pull is a stand-in with no real external search backend yet
      // (see packages/tools/karos-research/src/pull.ts) — so there is no real numeric
      // insight to extract. This derives a low-confidence, clearly-labeled fallback
      // candidate from the query itself, never a fabricated statistic.
      return {
        candidatePillar: research.query,
        hasNumericInsight: false,
        sourceLabel: `research run ${research.runId}`,
      };
    });

    // ── 06-08: strategy plan generation via CampaignStrategyAgent ──
    const topicPool = await wf.step.code("06-reserve-topic-pool", async (): Promise<CampaignTopicPool> => {
      const outcome = await options.tools["topics.reserve"]!.execute(
        { reservationKey: `${wf.runId}__pool`, count: 5, excludeTopics: pastCampaignPerformance },
        { ctx },
      );
      if (outcome.status === "success") {
        const result = outcome.result as { reservationKey: string; topics: string[] };
        return { reservationKey: result.reservationKey, topics: result.topics };
      }
      // content_fail here just means the catalog floor doesn't have 5 available — not
      // fatal, the strategy agent still has the research-derived fallback pillar.
      return { topics: [] };
    });

    const strategyAgent = new CampaignStrategyAgent({ router: options.router, tools: options.tools, promptStore: options.promptStore });
    // A typed direction that names a subject becomes this campaign's theme,
    // outranking the client's standing `requestedTheme` in config for the same
    // reason it outranks a topic catalog elsewhere: it was written for this run,
    // and the config value was written once for all of them.
    const requestedTheme = runDirection.topicOverride ?? intake.requestedTheme;

    const strategyResult = await wf.step.agent("07-generate-strategy-plan", strategyAgent, {
      ...runDirectionField(runDirection),
      goals: intake.goals,
      ...(requestedTheme !== undefined ? { requestedTheme } : {}),
      profile: clientContext.profile,
      brand: clientContext.brand,
      voiceRules: clientContext.voiceRules,
      pastCampaignPerformance,
      ...(strategicSummary.candidatePillar !== undefined ? { candidatePillar: strategicSummary.candidatePillar } : {}),
      topicPool: topicPool.topics,
    });

    if (strategyResult.status === "content_fail") {
      throw new WorkflowHeld(`strategy plan did not clear its own validation: ${strategyResult.status}`);
    }
    if (strategyResult.status !== "completed") {
      throw new WorkflowToolingFailure(`strategy step resolved to "${strategyResult.status}"`);
    }
    const plan = strategyResult.finalOutput!;

    await wf.step.code("08-validate-strategy-plan", (): void => {
      const slotIds = new Set<string>();
      for (const slot of plan.channelSlots) {
        if (slotIds.has(slot.slotId)) {
          throw new WorkflowHeld(`strategy plan reused slotId "${slot.slotId}" across channel slots — nothing honestly cleared selection`);
        }
        slotIds.add(slot.slotId);
      }
    });

    // ── 09-12: multi-channel fan-out (RFC-01 §5.5) ──
    const fanoutItems = await wf.step.code("09-prepare-channel-fanout-items", () => plan.channelSlots);

    const slotOutcomes = await wf.fanout("channel-fanout", fanoutItems, async (slot, slotCtx) => {
      const channelOptions: ChannelRuntimeOptions = {
        tools: options.tools,
        promptStore: options.channelPromptStores[slot.channel],
        router: options.channelRouters[slot.channel],
        autoApprove: true,
      };
      return runChannelSlot(slot.channel, channelOptions, slotCtx);
    });

    const channelResults = await wf.step.code("11-aggregate-channel-outcomes", (): CampaignChannelResult[] => {
      return plan.channelSlots.map((slot, index) => {
        const outcome = slotOutcomes[index]!;
        if (outcome.status === "completed") {
          return { slotId: slot.slotId, channel: slot.channel, status: "completed", deliverableId: outcome.output.deliverableId };
        }
        return { slotId: slot.slotId, channel: slot.channel, status: "failed", reason: outcome.reason };
      });
    });

    await wf.step.code("12-verify-campaign-completeness", (): void => {
      if (!channelResults.some((result) => result.status === "completed")) {
        throw new WorkflowHeld("no channel produced a deliverable for this campaign — nothing honestly cleared its own gates");
      }
    });

    // ── 13: campaign gate — human review pause ──
    const decision = await wf.step.gate("13-campaign-review", {
      kind: "campaign_review",
      payload: { campaignName: plan.campaignName, theme: plan.theme, channelResults },
      requiredRole: "account_manager",
      timeout: { duration: "48h", onTimeout: "escalate" },
    });
    if (decision.decision !== "approve") {
      throw new WorkflowHeld(`campaign rejected: ${decision.reason ?? "no reason given"}`);
    }

    // ── 14: persist unified campaign bundle and deliverables ──
    const deliverableId = await wf.step.code("14-persist-campaign-bundle", async (): Promise<string> => {
      const outcome = await options.tools["ledger.writeDeliverable"]!.execute(
        {
          runId: wf.runId,
          kind: "campaign-bundle",
          deliverable: { campaignName: plan.campaignName, theme: plan.theme, targetPillars: plan.targetPillars, channelResults },
        },
        { ctx },
      );
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`ledger.writeDeliverable failed: ${outcome.status}`);
      return (outcome.result as { id: string }).id;
    });

    // ── 15: commit updates (topics.commit, memory.appendDecision) ──
    await wf.step.code("15-commit-and-record", async () => {
      if (topicPool.reservationKey) {
        await options.tools["topics.commit"]!.execute({ reservationKey: topicPool.reservationKey }, { ctx });
      }
      await options.tools["memory.appendDecision"]!.execute(
        {
          decisionId: `${wf.runId}__decision`,
          summary: `Ran campaign "${plan.campaignName}" (theme: ${plan.theme}) across ${channelResults.length} channels`,
        },
        { ctx },
      );
    });

    return { campaignName: plan.campaignName, theme: plan.theme, channelResults, deliverableId };
  };
}
