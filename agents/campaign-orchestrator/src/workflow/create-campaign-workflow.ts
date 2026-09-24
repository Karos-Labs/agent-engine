import { readForbiddenTopics, type AgentContext, type AgentToolRegistry, type ModelRouter, type PromptStore } from "@agent-engine/core";
import { readRunDirection, runDirectionField, runTopicGuardrail, type WorkflowContext, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure, toAgentContext } from "@agent-engine/workflow";
import { createXAgentWorkflow } from "@agent-engine/agent-x";
import { createLinkedInAgentWorkflow } from "@agent-engine/agent-linkedin";
import { createRedditAgentWorkflow } from "@agent-engine/agent-reddit";
import { createBlogAgentWorkflow } from "@agent-engine/agent-blog";
import { createNewsletterAgentWorkflow } from "@agent-engine/agent-newsletter";
import { CampaignStrategyAgent, type CampaignChannel, type CampaignChannelSlot, type CampaignPlanOutput } from "../agent/campaign-strategy-agent.js";
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
   * per-channel `13-batch-review`/`15-batch-review` gate mid-fan-out would
   * mean five separate approvals instead of one, which is exactly what the
   * campaign gate exists to replace.
   *
   * SCRUM-302/AU18: this was flagged as a real scrutiny gap — the five
   * per-channel gates were the only surface that ever saw the drafted copy,
   * and skipping all five left `13-campaign-review` reviewing
   * `{campaignName, theme, channelResults}` with no actual post text in it.
   * The chosen fix (below `runChannelSlot` and in `CampaignChannelResult`)
   * keeps `autoApprove: true` — dropping it instead would mean the fan-out's
   * `AwaitingGateSignal`s pause the run five times over (once per channel
   * that reaches its own gate; `runFanout` treats a gate as a run-level
   * signal, not a per-slot outcome, and a single `13-campaign-review`
   * decision has no mechanism to resolve five separately-recorded per-channel
   * gates in one call) — and instead folds each channel's own gate-would-show
   * text (`preview`) into the campaign gate's payload, so the one human
   * checkpoint actually reviews what the five bypassed gates would have.
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


/** Dispatches to the right channel's own, already-proven `createXAgentWorkflow()`-style factory — every channel's own 17-step workflow runs unmodified (with its own per-channel gate auto-approved), just inside this slot. */
type ChannelSlotOutput = { status: "completed"; deliverableId: string; preview: string } | { status: "held"; reason: string };

/**
 * One channel's whole workflow, run in-process inside a fan-out slot.
 *
 * A channel's `WorkflowHeld` is caught HERE and returned as that slot's
 * outcome. `wf.fanout` treats `WorkflowHeld` as a run-level signal and
 * re-throws it (packages/workflow `fanout.ts`, `RUN_LEVEL_SIGNALS`), so until
 * 2026-09-07 one channel's numbers-gate hold held the entire campaign, with the
 * other four channels' finished deliverables never reaching the reviewer,
 * while a channel's `WorkflowToolingFailure` was tolerated as a `failed` slot.
 * A content hold is the least severe of the two, and now the least
 * consequential: the reviewer at 13-campaign-review sees the held channel's
 * reason beside the ones that shipped.
 */
async function runChannelSlot(channel: CampaignChannel, channelOptions: ChannelRuntimeOptions, wf: WorkflowContext): Promise<ChannelSlotOutput> {
  try {
    const result = await runChannelWorkflow(channel, channelOptions, wf);
    return { status: "completed", ...result };
  } catch (err) {
    if (err instanceof WorkflowHeld) return { status: "held", reason: err.message };
    throw err;
  }
}

async function runChannelWorkflow(
  channel: CampaignChannel,
  channelOptions: ChannelRuntimeOptions,
  wf: WorkflowContext,
): Promise<{ deliverableId: string; preview: string }> {
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
 * THE ASSIGNMENT ONE CHANNEL RECEIVES, as the `wf.input` its own workflow reads.
 *
 * Pure, and exported, so the thing this orchestrator exists to do can be
 * asserted directly rather than inferred from a five-channel fan-out.
 *
 * ## Why it is shaped like a portal instruction
 *
 * Every channel agent already calls `readRunDirection(wf.input)` and already
 * lets a typed instruction outrank its own topic catalog. That seam is built,
 * tested on all five channels, and is exactly the relationship an orchestrator
 * wants: "someone with more information about this run than the catalog has
 * told you what to write." So the plan speaks through it, rather than through
 * five new per-channel parameters that would each need their own wiring and
 * their own tests.
 *
 * ## What each field becomes, and why
 *
 * `keyMessage` becomes `requestedTopic`, which `readRunDirection` treats as a
 * subject "full stop — no length or style heuristic applies to it". That is
 * the point: the plan decided this channel's subject, and a heuristic second-
 * guessing it would put the catalog back in charge.
 *
 * `targetAudience`, `angle` and the campaign's own name and theme become the
 * free-text direction, because they steer HOW the channel writes rather than
 * WHAT about — which is the same division the portal's own brief already uses.
 *
 * ## What it does not do
 *
 * It does not touch media, the brief, or anything else the parent input
 * carried; those ride along untouched. And it does not disable a channel's own
 * research or gates — the channel still verifies its own numbers, still runs
 * its own compliance checks, and still fails its own way. The plan chooses the
 * subject; the channel is still responsible for the post.
 */
export function campaignSlotInput(
  parentInput: Readonly<Record<string, unknown>>,
  plan: Pick<CampaignPlanOutput, "campaignName" | "theme">,
  slot: CampaignChannelSlot,
): Readonly<Record<string, unknown>> {
  const assignment = [
    `This is one channel of the campaign "${plan.campaignName}". The campaign's theme is: ${plan.theme}.`,
    `Your angle for this channel: ${slot.angle}`,
    `Write it for: ${slot.targetAudience}`,
    "Stay on the campaign's key message above. Do not pick a different subject — the other channels are covering the same campaign from their own angles, and this one is yours.",
  ].join("\n");

  // The parent's own instruction is KEPT and the assignment appended, not
  // replaced: if a person typed something when they launched the campaign, it
  // outranks a plan the model wrote, and dropping it here would silently
  // discard the one input with a human behind it.
  const parentPrompt = typeof parentInput["customPrompt"] === "string" ? parentInput["customPrompt"] : "";

  return {
    ...parentInput,
    requestedTopic: slot.keyMessage,
    customPrompt: parentPrompt ? `${parentPrompt}\n\n${assignment}` : assignment,
  };
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
 * persisted as the campaign's documented strategy intent (RFC-02 §4) AND are
 * now what each channel actually writes to: `campaignSlotInput` turns the slot
 * into the same `wf.input` shape a typed portal instruction uses, so the
 * channel honours it through `readRunDirection` — the seam it already had.
 *
 * Until that landed, those three fields were read at exactly one place in this
 * file (building the guardrail text) and every child inherited the parent's
 * input verbatim, so each channel re-ran its own topic selection and wrote what
 * it would have written standalone. The campaign was a plan document plus five
 * unrelated posts that shared a client.
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
        // Carried from the same config read every channel's own intake already
        // makes, so the campaign-level guardrail below (SCRUM-302/AU18) does
        // not have to read `client.getConfig` a second time.
        forbiddenTopics: readForbiddenTopics(config),
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

    // ── 08b: campaign-level topic guardrail (SCRUM-302/AU18) ──
    //
    // Every channel's own workflow already runs `runTopicGuardrail` over ITS
    // OWN drafted text, unconditionally — `autoApprove` only skips that
    // channel's human gate, never its guardrail. What had no guardrail at all
    // was the campaign PLAN itself: `campaignName`/`theme`/`targetPillars`
    // and each slot's `targetAudience`/`angle`/`keyMessage` are generated
    // once, up front, by `CampaignStrategyAgent`, and nothing downstream ever
    // checked that content against this client's forbidden topics before
    // fanning five channels out to draft against it.
    //
    // Run before the fan-out, deliberately: a plan that already engages a
    // forbidden subject should never spend five channels' worth of drafting
    // (and five more guardrail calls) on it.
    const planGuardrailText = [
      plan.campaignName,
      plan.theme,
      ...plan.targetPillars,
      ...plan.channelSlots.flatMap((slot) => [slot.targetAudience, slot.angle, slot.keyMessage]),
    ].join("\n");
    await runTopicGuardrail(wf, { tools: options.tools, promptStore: options.promptStore, router: options.router }, planGuardrailText, intake.forbiddenTopics);

    // ── 09-12: multi-channel fan-out (RFC-01 §5.5) ──
    const fanoutItems = await wf.step.code("09-prepare-channel-fanout-items", () => plan.channelSlots);

    const slotOutcomes = await wf.fanout(
      "channel-fanout",
      fanoutItems,
      async (slot, slotCtx) => {
        const channelOptions: ChannelRuntimeOptions = {
          tools: options.tools,
          promptStore: options.channelPromptStores[slot.channel],
          router: options.channelRouters[slot.channel],
          autoApprove: true,
        };
        return runChannelSlot(slot.channel, channelOptions, slotCtx);
      },
      {
        // THE PLAN NOW REACHES THE CHANNELS. Before this, `slot.targetAudience`,
        // `slot.angle` and `slot.keyMessage` were read at exactly ONE place in
        // this workflow — building the guardrail text above — and every child
        // inherited the parent's input verbatim. So each channel re-ran its own
        // topic selection and wrote what it would have written standalone: a
        // campaign was a plan document plus five unrelated posts that happened
        // to share a client, and everything `campaign-craft` teaches about
        // narrative alignment and per-channel angles was decorative.
        //
        // It arrives through the SEAM THAT ALREADY EXISTS rather than a new
        // per-channel parameter: `readRunDirection` is how every channel agent
        // already honours a typed instruction from the portal, it is already
        // tested on all five, and it already outranks the topic catalog. The
        // orchestrator is simply another author of that instruction.
        inputFor: (item) => campaignSlotInput(wf.input, plan, item as CampaignChannelSlot),
      },
    );

    const channelResults = await wf.step.code("11-aggregate-channel-outcomes", (): CampaignChannelResult[] => {
      return plan.channelSlots.map((slot, index) => {
        const outcome = slotOutcomes[index]!;
        if (outcome.status === "completed") {
          const output = outcome.output;
          if (output.status === "held") {
            return { slotId: slot.slotId, channel: slot.channel, status: "held", reason: output.reason };
          }
          // `preview` is the SCRUM-302/AU18 fix: the exact text that channel's
          // own (auto-approved, never-shown) gate would have carried, folded
          // in here so `13-campaign-review` is a real review of what five
          // gates would have shown, not five bare deliverable ids.
          return {
            slotId: slot.slotId,
            channel: slot.channel,
            status: "completed",
            deliverableId: output.deliverableId,
            preview: output.preview,
          };
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
      timeout: { duration: "1h", onTimeout: "auto_approve" },
    });
    /**
     * A REJECTION REFUSES THE CAMPAIGN, NOT EVERY CHANNEL'S WORK.
     *
     * Each slot has already run a whole channel workflow by now and written
     * its own deliverable; this gate is the one human checkpoint over the
     * BUNDLE. `WorkflowHeld` here left the reviewer with an error string and
     * a set of orphan per-channel deliverables nothing tied together — the
     * campaign they had opinions about existed nowhere afterwards.
     *
     * The bundle is written either way, marked `rejected` and carrying their
     * reason. What the rejection costs is step 15: the topic reservation is
     * NOT committed (those topics stay available for the next campaign), and
     * client memory records the refusal rather than "ran campaign X".
     */
    const rejected = decision.decision !== "approve";
    const rejection = rejected
      ? {
          decision: decision.decision,
          by: decision.actor,
          at: decision.at,
          reason: decision.reason ?? "no reason given",
        }
      : undefined;

    // ── 14: persist unified campaign bundle and deliverables ──
    const deliverableId = await wf.step.code("14-persist-campaign-bundle", async (): Promise<string> => {
      const outcome = await options.tools["ledger.writeDeliverable"]!.execute(
        {
          runId: wf.runId,
          kind: "campaign-bundle",
          deliverable: {
            campaignName: plan.campaignName,
            theme: plan.theme,
            targetPillars: plan.targetPillars,
            channelResults,
            // No caller may mistake a refused bundle for an approved one.
            status: rejected ? "rejected" : "ok",
            ...(rejection ? { rejection } : {}),
          },
        },
        { ctx },
      );
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`ledger.writeDeliverable failed: ${outcome.status}`);
      return (outcome.result as { id: string }).id;
    });

    // ── 15: commit updates (topics.commit, memory.appendDecision) ──
    await wf.step.code("15-commit-and-record", async () => {
      // The refused half. A committed reservation means "these topics are
      // spent", which a rejected campaign has no right to claim.
      if (topicPool.reservationKey && !rejected) {
        await options.tools["topics.commit"]!.execute({ reservationKey: topicPool.reservationKey }, { ctx });
      }
      await options.tools["memory.appendDecision"]!.execute(
        {
          decisionId: `${wf.runId}__decision`,
          summary: rejected
            ? `Campaign "${plan.campaignName}" (theme: ${plan.theme}) was REJECTED at review by ${decision.actor}: ${rejection!.reason}`
            : `Ran campaign "${plan.campaignName}" (theme: ${plan.theme}) across ${channelResults.length} channels`,
        },
        { ctx },
      );
    });

    return {
      campaignName: plan.campaignName,
      theme: plan.theme,
      channelResults,
      deliverableId,
      status: rejected ? ("rejected" as const) : ("ok" as const),
      ...(rejection ? { rejection } : {}),
    };
  };
}
