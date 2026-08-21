import type { AgentContext, AgentToolRegistry, GateResponse, GateVerdict, ModelRouter, PromptStore } from "@agent-engine/core";
import { type WorkflowContext, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure } from "@agent-engine/workflow";
import { XDraftAgent, type Lane } from "../agent/x-draft-agent.js";
import { renderPreview, type RenderPreviewResult } from "../tools/render-preview.js";
import { renderXDraftsMarkdown } from "./render-drafts-markdown.js";
import { countRecentEngagementPosts, ENGAGEMENT_DAILY_CAP, selectLane } from "./lane.js";
import type {
  XAgentWorkflowResult,
  XCandidateSummary,
  XClientContext,
  XIntakeConfig,
  XRecentDecision,
  XSelectedCandidate,
  XTopicReservation,
} from "./types.js";

export interface CreateXAgentWorkflowOptions {
  /** The base Layer 3 registry (karos-client/research/topics/gates/ledger/memory) — `render.preview` is merged in internally. */
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips step 15's human `batch_review` gate and records a synthetic
   * `actor: "system"` approval instead — off by default, so a real run
   * genuinely pauses at `awaiting_gate` until a human reviews it (RFC-01
   * §8.3), matching every migrated channel's own legacy "never auto-publish"
   * guardrail. Intended for tests/demos/evals that need a synchronous
   * happy path, never for production wiring (`apps/agent-server` leaves this
   * unset).
   */
  autoApprove?: boolean;
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

/** A bare `http(s)://` link — the mechanical half of "post clean, link in first reply" (x-craft.md §5). */
const BARE_URL_PATTERN = /https?:\/\//i;

/**
 * `createXAgentWorkflow()` (RFC-02 §3): the 21-step recurring/on-demand run
 * protocol, steps `00`–`20`. One post, one run (RFC-01 §16.2's ruling) — no
 * fan-out here, unlike the LinkedIn pilot; every X run produces at most one
 * deliverable. Step 15 is a mandatory human `batch_review` gate (RFC-01
 * §8.3) — nothing persists until a real human approves, unless
 * `options.autoApprove` explicitly opts out (tests/demos only).
 *
 * Phase 2.5 batch 2.3 restored two previously-missing pieces of domain logic
 * versus the legacy predecessors (`x-agent-v2` primary, `x-agent` v1
 * secondary):
 *
 * 1. **The lane system** (steps 08-09): `references/lanes.md`'s six content
 *    lanes, a "never the same lane twice in a row" rotation, and an
 *    engagement-lane daily cap check.
 * 2. **"Post clean, link in first reply"** (step 13): a mechanical check
 *    that a link never lands in the post body itself when `firstReplyUrl`
 *    is set (x-craft.md §5).
 *
 * It also wires `gate.noPlaceholder` and `gate.leakCheck` (steps 16-17) —
 * both existed in `packages/tools/karos-gates` but were previously dead code
 * outside `evals/src/run-assertions.ts`, never actually called at runtime.
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

    // Full decision rows (not just summaries) — the lane rotation and the
    // engagement daily cap both need `at` timestamps, not just insertion order.
    const recentDecisions = await wf.step.code("03-load-recent-decisions", async (): Promise<XRecentDecision[]> => {
      const outcome = await tools["memory.read"]!.execute({ scope: "decisions" }, { ctx });
      if (outcome.status !== "success") return [];
      const result = outcome.result as { scope: string; items: XRecentDecision[] };
      return result.items;
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

    // ── 06-09: candidate selection, lane selection and the engagement cap ──
    const reservation = await wf.step.code("06-reserve-topic", async (): Promise<XTopicReservation> => {
      const excludeTopics = recentDecisions.map((d) => d.summary);
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

    // Restored lane system (lanes.md): an explicit request wins, otherwise a
    // deterministic "never twice in a row, least-recently-used, weight as
    // tiebreak" rotation — see lane.ts for exactly what's simplified versus
    // lanes.md's real per-identity weighted batch mix. `angle` stays the
    // pre-existing (simplified) two-value derivation; lanes.md's own angle
    // step ("the specific take, distinct from every prior angle") is a
    // judgment call this pilot leaves to the drafting model via the prompt,
    // same as before.
    const laneSelection = await wf.step.code("08-select-lane", (): { lane: Lane; angle: string } => {
      const lane = selectLane(intake.requestedLane, recentDecisions);
      const angle = candidateSummary.hasNumericInsight ? "data-point" : "trend-observation";
      return { lane, angle };
    });

    // Engagement-lane daily cap (x-craft.md §4: "defaults... 5 actions/day").
    // A no-op for every other lane. Runs before drafting so an over-cap run
    // holds without spending a model call. Per-account/per-roster caps are
    // NOT checked here — there is no roster/account model in this agent yet
    // (a real, honest gap versus legacy's "Roster membership is a compliance
    // gate, not a preference").
    await wf.step.code("09-check-engagement-cap", () => {
      if (laneSelection.lane !== "engagement") {
        return { lane: laneSelection.lane, held: false, engagementCountInWindow: 0 };
      }
      const now = Date.now();
      const countInWindow = countRecentEngagementPosts(recentDecisions, now);
      if (countInWindow >= ENGAGEMENT_DAILY_CAP) {
        throw new WorkflowHeld(
          `engagement lane daily cap reached: ${countInWindow} engagement-lane post(s) already recorded in the last 24h (cap: ${ENGAGEMENT_DAILY_CAP})`,
        );
      }
      return { lane: laneSelection.lane, held: false, engagementCountInWindow: countInWindow };
    });

    // ── 10-14: draft execution via XDraftAgent, with machine/claim/compliance/link gates ──
    const draftAgent = new XDraftAgent({ router: options.router, tools, promptStore: options.promptStore });
    const draftResult = await wf.step.agent("10-draft-post", draftAgent, {
      topic: selected.topic,
      source: selected.source,
      lane: laneSelection.lane,
      angle: laneSelection.angle,
      targetHandle: intake.xHandle,
      voiceRules: clientContext.voiceRules,
    });

    if (draftResult.status === "content_fail") {
      throw new WorkflowHeld(`draft did not clear its own self-critique gate: ${draftResult.status}`);
    }
    if (draftResult.status !== "completed") {
      throw new WorkflowToolingFailure(`draft step resolved to "${draftResult.status}"`);
    }
    // Phase 2.5 fix-batch: `mainPostText` is schema-required to carry the same
    // content as `text` (see XPostOutputSchema's own doc comment), but that
    // was only ever "enforced by prompt instruction" — every content gate
    // below (`gate.numbersSourced`, `gate.brandCompliance`, `render.preview`,
    // and the agent's own self-critique `gate.lintPost` call) checks `text`
    // only, so a banned phrase, unsourced number, or over-limit string could
    // hide in a diverging `mainPostText` while `text` passed every check.
    // Structurally deriving `mainPostText` from the model's own gated `text`
    // here — rather than trusting the model to keep the two fields in sync,
    // or re-running every gate a second time against a second field — closes
    // that gap by construction: whatever content actually cleared every gate
    // is exactly what step 13's link-placement check (and everything
    // downstream) now sees.
    const draft = { ...draftResult.finalOutput!, mainPostText: draftResult.finalOutput!.text };

    await wf.step.code("11-verify-numbers-sourced", async () => {
      const sources = candidateSummary.hasNumericInsight ? [candidateSummary.sourceLabel] : [];
      const verdict = await runGate(tools, "gate.numbersSourced", { text: draft.text, sources }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.numbersSourced: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`numbers not sourced: ${verdict.reason}`);
      return verdict;
    });

    await wf.step.code("12-verify-brand-compliance", async () => {
      const forbiddenTerms = clientContext.brand["forbiddenTerms"] as string[] | undefined;
      const verdict = await runGate(tools, "gate.brandCompliance", { text: draft.text, forbiddenTerms: forbiddenTerms ?? [] }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.brandCompliance: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`brand compliance failed: ${verdict.reason}`);
      return verdict;
    });

    // "Post clean, link in first reply" (x-craft.md §5): when the draft set a
    // `firstReplyUrl`, the main post body must not ALSO carry a bare link —
    // that means the model put the link in the wrong place. No check runs
    // when `firstReplyUrl` is unset (x-craft.md's own launch-post exception,
    // "the link IS the news", is a judgment call left to the drafting model).
    await wf.step.code("13-verify-link-placement", () => {
      if (draft.firstReplyUrl && BARE_URL_PATTERN.test(draft.mainPostText)) {
        throw new WorkflowHeld(
          "mainPostText contains a bare link even though firstReplyUrl is set — links must go in the first reply, never the main post body (x-craft.md §5)",
        );
      }
      return { checked: true };
    });

    await wf.step.code("14-render-preview-check", async () => {
      const outcome = await tools["render.preview"]!.execute({ text: draft.text }, { ctx });
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`render.preview failed: ${outcome.status}`);
      const preview = outcome.result as RenderPreviewResult;
      if (!preview.withinLimit) {
        throw new WorkflowHeld(`post exceeds the X character limit (${preview.characterCount} chars)`);
      }
      return preview;
    });

    // ── 15: human batch-review gate — nothing ships without a real approval ──
    const reviewDecision: GateResponse = options.autoApprove
      ? await wf.step.code("15-batch-review", () => ({
          decision: "approve" as const,
          actor: "system",
          at: new Date().toISOString(),
        }))
      : await wf.step.gate("15-batch-review", {
          kind: "batch_review",
          payload: { runId: wf.runId, topic: selected.topic, lane: laneSelection.lane, angle: laneSelection.angle, preview: draft.text },
          requiredRole: "account_manager",
          timeout: { duration: "24h", onTimeout: "hold" },
        });
    if (reviewDecision.decision !== "approve") {
      throw new WorkflowHeld(`batch rejected: ${reviewDecision.reason ?? "no reason given"}`);
    }

    // ── 16-17: previously-dead gates, wired in right before persistence ──
    await wf.step.code("16-verify-no-placeholder", async () => {
      const verdict = await runGate(tools, "gate.noPlaceholder", { text: draft.text }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.noPlaceholder: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`unresolved placeholder: ${verdict.reason}`);
      return verdict;
    });

    await wf.step.code("17-verify-no-leak", async () => {
      const verdict = await runGate(tools, "gate.leakCheck", { text: draft.text }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.leakCheck: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`leak check failed: ${verdict.reason}`);
      return verdict;
    });

    // ── 18-19: deliverable & manifest persistence ──
    const deliverableId = await wf.step.code("18-persist-deliverable", async (): Promise<string> => {
      // Additive: `draftsMarkdown` is the DRAFTS.md-shaped string karosCMO's
      // `x-drafts.ts` parser needs on `asset.content` — the rest of `draft`
      // stays untouched for any consumer that wants the raw structured fields.
      const draftsMarkdown = renderXDraftsMarkdown({
        targetHandle: intake.xHandle,
        lane: laneSelection.lane,
        angle: laneSelection.angle,
        draft,
      });
      const outcome = await tools["ledger.writeDeliverable"]!.execute(
        { runId: wf.runId, kind: "x-post", deliverable: { ...draft, draftsMarkdown } },
        { ctx },
      );
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`ledger.writeDeliverable failed: ${outcome.status}`);
      return (outcome.result as { id: string }).id;
    });

    await wf.step.code("19-persist-manifest", async () => {
      await tools["ledger.dashboardSnapshot"]!.execute(
        { runId: wf.runId, snapshot: { topic: selected.topic, source: selected.source, lane: laneSelection.lane, angle: laneSelection.angle, deliverableId } },
        { ctx },
      );
    });

    // ── 20: commit updates (topics.commit, memory.appendDecision, ledger.feedbackAppend) ──
    await wf.step.code("20-commit-and-record", async () => {
      if (selected.source === "reserved" && reservation.reservationKey) {
        await tools["topics.commit"]!.execute({ reservationKey: reservation.reservationKey }, { ctx });
      }
      await tools["memory.appendDecision"]!.execute(
        {
          decisionId: `${wf.runId}__decision`,
          summary: `Posted about "${selected.topic}" (lane: ${laneSelection.lane}, angle: ${laneSelection.angle})`,
        },
        { ctx },
      );
      await tools["ledger.feedbackAppend"]!.execute(
        { runId: wf.runId, feedbackId: `${wf.runId}__review`, decision: reviewDecision.decision, actor: reviewDecision.actor },
        { ctx },
      );
    });

    return { topic: selected.topic, angle: laneSelection.angle, lane: laneSelection.lane, targetHandle: intake.xHandle, deliverableId };
  };
}
