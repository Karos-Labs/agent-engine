import type { AgentContext, AgentToolRegistry, GateResponse, GateVerdict, ModelRouter, PromptStore } from "@agent-engine/core";
import { type WorkflowContext, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure } from "@agent-engine/workflow";
import { LinkedInDraftAgent } from "../agent/linkedin-draft-agent.js";
import { renderPreview, type RenderPreviewResult } from "../tools/render-preview.js";
import {
  LINKEDIN_ARCHETYPES,
  type LinkedInAgentWorkflowResult,
  type LinkedInArchetype,
  type LinkedInArchetypeSelection,
  type LinkedInCandidateSummary,
  type LinkedInClientContext,
  type LinkedInDecisionsShelf,
  type LinkedInIdentity,
  type LinkedInIdentityScope,
  type LinkedInIntakeConfig,
  type LinkedInSelectedCandidate,
  type LinkedInTopicReservation,
} from "./types.js";
import type { Executive } from "@agent-engine/tools";

export interface CreateLinkedInAgentWorkflowOptions {
  /** The base Layer 3 registry (karos-client/research/topics/gates/ledger/memory) — `render.preview` is merged in internally. */
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips step 15's human `batch_review` gate and records a synthetic
   * `actor: "system"` approval instead — off by default, so a real run
   * genuinely pauses at `awaiting_gate` until a human reviews it (RFC-01
   * §8.3). Intended for tests/demos/evals that need a synchronous happy
   * path, never for production wiring.
   */
  autoApprove?: boolean;
  /**
   * Which posting identity this workflow drafts as when a given run's
   * `client.getConfig` doesn't request one itself (legacy "two-paths"
   * design — company/brand voice vs. a named executive's own voice).
   * Defaults to `"company"`, matching every pre-existing caller's behavior
   * exactly. A per-run `requestedIdentityScope` in client config always
   * takes precedence over this workflow-level default.
   */
  identityScope?: LinkedInIdentityScope;
}

/** A valid archetype name, or `undefined` if the string isn't one of `LINKEDIN_ARCHETYPES`. */
function parseArchetype(value: unknown): LinkedInArchetype | undefined {
  return typeof value === "string" && (LINKEDIN_ARCHETYPES as readonly string[]).includes(value) ? (value as LinkedInArchetype) : undefined;
}

/** Pulls a decision summary's recorded archetype back out (written as `(archetype: <name>)` by step 18) — the mechanism the "never the same lane as last post" rule (`lanes.md` §2) actually checks against. */
function extractArchetypeFromSummary(summary: string): LinkedInArchetype | undefined {
  const match = /archetype:\s*([a-z-]+)/i.exec(summary);
  return match ? parseArchetype(match[1]!.toLowerCase()) : undefined;
}

/** Reads the per-run identity/archetype overrides (if any) out of `client.getConfig`'s free-form result. */
function readRunConfig(config: unknown): {
  requestedIdentityScope?: LinkedInIdentityScope;
  requestedExecutiveName?: string;
  requestedArchetype?: LinkedInArchetype;
} {
  const record = config as {
    requestedIdentityScope?: LinkedInIdentityScope;
    requestedExecutiveName?: string;
    requestedArchetype?: string;
  };
  const requestedArchetype = parseArchetype(record.requestedArchetype);
  return {
    ...(record.requestedIdentityScope !== undefined ? { requestedIdentityScope: record.requestedIdentityScope } : {}),
    ...(record.requestedExecutiveName !== undefined ? { requestedExecutiveName: record.requestedExecutiveName } : {}),
    ...(requestedArchetype !== undefined ? { requestedArchetype } : {}),
  };
}

/** Picks the executive to post as: an explicit per-run name match (case-insensitive) wins, else the first configured executive. */
function selectExecutive(executives: Executive[], requestedExecutiveName?: string): Executive {
  if (requestedExecutiveName) {
    const match = executives.find((e) => e.name.toLowerCase() === requestedExecutiveName.toLowerCase());
    if (match) return match;
  }
  return executives[0]!;
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
 * The restored default archetype rotation (Phase 2.5 Batch 2.2), ordered
 * highest-priority-first per `linkedin-voice-by-industry.md`'s suggested mix
 * (framework/teardown heaviest, then lesson/industry-react, tapering to the
 * rarer milestone/contrarian/vulnerability slots) — two orderings, one
 * biased toward archetypes that read well with a genuine numeric finding in
 * hand, one for when there isn't one. Selection always walks the ordering
 * and skips whichever archetype the immediately-prior run used (`lanes.md`
 * §2's "never the same lane as this identity's last post" rule) — the one
 * rule the spec says "does most of the work."
 */
const DEFAULT_ARCHETYPE_ORDER: readonly LinkedInArchetype[] = [
  "teardown-framework",
  "lesson-learned",
  "industry-reaction",
  "build-in-public",
  "community-question",
  "contrarian-take",
  "customer-story",
  "origin-story",
  "milestone-launch",
  "hiring-culture",
  "vulnerability-admission",
];

const NUMERIC_INSIGHT_ARCHETYPE_ORDER: readonly LinkedInArchetype[] = [
  "milestone-launch",
  "teardown-framework",
  "customer-story",
  "build-in-public",
  "industry-reaction",
  "contrarian-take",
  "lesson-learned",
  "community-question",
  "origin-story",
  "hiring-culture",
  "vulnerability-admission",
];

/**
 * `createLinkedInAgentWorkflow()` (RFC-02 §5 — "same recipe" as the X pilot
 * in §3): the 19-step recurring/on-demand run protocol, steps `00`–`18`. One
 * post, one run (RFC-01 §16.2's ruling) — no fan-out here; every LinkedIn
 * run produces at most one deliverable. Step 15 is a mandatory human
 * `batch_review` gate (RFC-01 §8.3) unless `options.autoApprove` opts out.
 */
export function createLinkedInAgentWorkflow(options: CreateLinkedInAgentWorkflowOptions) {
  const tools: AgentToolRegistry = { ...options.tools, "render.preview": renderPreview };

  return async function linkedInAgentWorkflow(wf: WorkflowContext): Promise<LinkedInAgentWorkflowResult> {
    const ctx = toAgentContext(wf);

    // ── 00: intake check — blocked_intake if foundation data is missing ──
    const intake = await wf.step.code("00-intake-check", async (): Promise<LinkedInIntakeConfig> => {
      const profileOutcome = await tools["client.getProfile"]!.execute({}, { ctx });
      if (profileOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client profile has not been set up yet");
      }
      const voiceRulesOutcome = await tools["client.getVoiceRules"]!.execute({}, { ctx });
      if (voiceRulesOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client has not configured voice rules yet");
      }
      // A client's own per-run config can request the executive identity path
      // (legacy "two-paths" design) — options.identityScope is only the
      // fallback default when the client doesn't ask for one.
      const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
      const { requestedIdentityScope } = configOutcome.status === "success" ? readRunConfig(configOutcome.result) : {};
      const identityScope: LinkedInIdentityScope = requestedIdentityScope ?? options.identityScope ?? "company";
      if (identityScope === "executive") {
        const executivesOutcome = await tools["client.getExecutives"]!.execute({}, { ctx });
        if (executivesOutcome.status !== "success" || (executivesOutcome.result as Executive[]).length === 0) {
          throw new WorkflowBlockedIntake(
            "identityScope is \"executive\" for this run, but the client has no executives configured to post as",
          );
        }
      }
      return {
        profile: profileOutcome.result as Record<string, unknown>,
        voiceRules: voiceRulesOutcome.result as Record<string, unknown>,
      };
    });

    // ── 01-03: context & shelf assembly (client.*, memory.read) ──
    const clientContext = await wf.step.code("01-load-client-context", async (): Promise<LinkedInClientContext> => {
      const profile = await tools["client.getProfile"]!.execute({}, { ctx });
      const brand = await tools["client.getBrand"]!.execute({}, { ctx });
      const voiceRules = await tools["client.getVoiceRules"]!.execute({}, { ctx });
      // client.getConfig is optional here (unlike the intake check above) — a
      // client may simply not have requested a specific topic (or identity) for this run.
      const config = await tools["client.getConfig"]!.execute({}, { ctx });
      const requestedTopic = config.status === "success" ? (config.result as { requestedTopic?: string }).requestedTopic : undefined;
      const { requestedIdentityScope, requestedExecutiveName, requestedArchetype } =
        config.status === "success" ? readRunConfig(config.result) : {};
      const identityScope: LinkedInIdentityScope = requestedIdentityScope ?? options.identityScope ?? "company";

      let identity: LinkedInIdentity = { scope: "company" };
      if (identityScope === "executive") {
        const executivesOutcome = await tools["client.getExecutives"]!.execute({}, { ctx });
        if (executivesOutcome.status !== "success" || (executivesOutcome.result as Executive[]).length === 0) {
          // Step 00 already blocks this same condition — reaching here on a
          // resumed/re-run should be unreachable, but never silently fall
          // back to the company voice for an explicitly-requested executive run.
          throw new WorkflowBlockedIntake(
            "identityScope is \"executive\" for this run, but the client has no executives configured to post as",
          );
        }
        const executive = selectExecutive(executivesOutcome.result as Executive[], requestedExecutiveName);
        identity = {
          scope: "executive",
          executiveName: executive.name,
          ...(executive.title !== undefined ? { executiveTitle: executive.title as string } : {}),
          ...(executive.careerHistory !== undefined ? { careerHistory: executive.careerHistory as string } : {}),
          ...(executive.corePillars !== undefined ? { corePillars: executive.corePillars as string[] } : {}),
          ...(executive.offLimitsTopics !== undefined ? { offLimitsTopics: executive.offLimitsTopics as string[] } : {}),
          ...(executive.voiceTone !== undefined ? { voiceTone: executive.voiceTone as string } : {}),
        };
      }

      return {
        profile: profile.status === "success" ? (profile.result as Record<string, unknown>) : {},
        brand: brand.status === "success" ? (brand.result as Record<string, unknown>) : {},
        voiceRules: voiceRules.status === "success" ? (voiceRules.result as LinkedInClientContext["voiceRules"]) : {},
        ...(requestedTopic !== undefined ? { requestedTopic } : {}),
        ...(requestedArchetype !== undefined ? { requestedArchetype } : {}),
        identity,
      };
    });

    const beliefs = await wf.step.code("02-load-memory-shelf", async () => {
      const outcome = await tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
      return outcome.status === "success" ? outcome.result : { scope: "beliefs", beliefs: {} };
    });

    const recentDecisions = await wf.step.code("03-load-recent-decisions", async (): Promise<LinkedInDecisionsShelf> => {
      const outcome = await tools["memory.read"]!.execute({ scope: "decisions" }, { ctx });
      if (outcome.status !== "success") return { summaries: [] };
      const result = outcome.result as { scope: string; items: Array<{ summary: string; at?: number }> };
      // Filtered to only decisions that actually parse an archetype, then sorted
      // most-recent-first by the decision's own recorded timestamp (mirroring
      // x-agent's lane.ts) — "decisions" is a client-wide memory scope, so a client
      // running LinkedIn alongside other channels has non-LinkedIn decisions
      // interleaved here too. Taking the single most-recent decision *overall*
      // (regardless of channel) silently disabled "never repeat the last archetype"
      // (lanes.md §2 — the rule that does most of the rotation's dedup work)
      // whenever another channel's run happened to be more recent than LinkedIn's
      // own last post (a multi-channel dedup audit finding).
      const archetypeBearing = result.items
        .map((item) => ({ at: item.at ?? 0, archetype: extractArchetypeFromSummary(item.summary) }))
        .filter((item): item is { at: number; archetype: LinkedInArchetype } => item.archetype !== undefined);
      const lastArchetype = archetypeBearing.slice().sort((a, b) => b.at - a.at)[0]?.archetype;
      return {
        summaries: result.items.map((item) => item.summary),
        ...(lastArchetype !== undefined ? { lastArchetype } : {}),
      };
    });

    // ── 04-05: research pull (persisting verbatim raw payloads inside research.pull itself) ──
    const research = await wf.step.code("04-research-pull", async () => {
      const industry = (clientContext.profile["industry"] as string | undefined) ?? "this industry";
      const query = `${industry} thought leadership trends this week`;
      // LinkedIn content moves slower than X news — a 7-day window vs. X's 24h.
      const outcome = await tools["research.pull"]!.execute({ job: "linkedin-trend-scan", query, window: "7d" }, { ctx });
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`research.pull failed: ${outcome.status}`);
      }
      return outcome.result as { runId: string; query: string; fromCache: boolean };
    });

    const candidateSummary = await wf.step.code("05-extract-candidate-summary", (): LinkedInCandidateSummary => {
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

    // ── 06-08: candidate selection and archetype determination ──
    const reservation = await wf.step.code("06-reserve-topic", async (): Promise<LinkedInTopicReservation> => {
      const excludeTopics = recentDecisions.summaries;
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

    const selected = await wf.step.code("07-select-candidate", (): LinkedInSelectedCandidate => {
      // Single post selection precedence (RFC-02 §5, "same recipe" as X §3): an
      // explicit client request wins, then a reserved catalog topic, then the
      // research-derived fallback.
      if (clientContext.requestedTopic) {
        return { topic: clientContext.requestedTopic, source: "requested" };
      }
      if (reservation.topics.length > 0) {
        return { topic: reservation.topics[0]!, source: "reserved" };
      }
      if (candidateSummary.candidateTopic) {
        return { topic: candidateSummary.candidateTopic, source: "research" };
      }
      throw new WorkflowHeld("no candidate topic available for this run — nothing honestly cleared selection");
    });

    /**
     * The restored lane/mix decision tree (`lanes.md` §2's style-choice
     * rule, Phase 2.5 Batch 2.2). Precedence: (1) an explicit run
     * request/standing direction names the archetype directly and takes the
     * slot exactly as asked, even if it repeats the last post's archetype —
     * "the customer's request wins" is unconditional; (2) otherwise a real
     * round-robin rotation applies. This is the "never the same lane as this
     * identity's last post" rule — a real, checkable constraint against
     * `recentDecisions`, not just a comment.
     *
     * Phase 2.5 fix-batch: the original rotation always rescanned the fixed
     * priority order from position 0 (`order.find(c => c !== priorArchetype)
     * ?? order[0]`), which only ever lands on `order[0]` or, when that
     * matches the prior run, `order[1]` — a 2-cycle oscillation that leaves 9
     * of the 11 archetypes structurally unreachable. The fix rotates the
     * SCAN'S OWN STARTING POINT by the total number of prior decisions before
     * applying the same "skip the immediate predecessor" rule, so consecutive
     * runs advance through the whole order over time instead of converging on
     * the same two slots, while still never repeating the immediately-prior
     * archetype.
     */
    const archetypeSelection = await wf.step.code("08-determine-archetype", (): LinkedInArchetypeSelection => {
      const priorArchetype = recentDecisions.lastArchetype;
      if (clientContext.requestedArchetype) {
        return {
          archetype: clientContext.requestedArchetype,
          source: "requested",
          ...(priorArchetype !== undefined ? { priorArchetype } : {}),
        };
      }
      const order = candidateSummary.hasNumericInsight ? NUMERIC_INSIGHT_ARCHETYPE_ORDER : DEFAULT_ARCHETYPE_ORDER;
      const rotationIndex = recentDecisions.summaries.length % order.length;
      const rotatedOrder = [...order.slice(rotationIndex), ...order.slice(0, rotationIndex)];
      const archetype = rotatedOrder.find((candidate) => candidate !== priorArchetype) ?? rotatedOrder[0]!;
      return {
        archetype,
        source: "rotation",
        ...(priorArchetype !== undefined ? { priorArchetype } : {}),
      };
    });

    // ── 09-14: draft execution via LinkedInDraftAgent, with machine/claim/compliance/hygiene gates ──
    const draftAgent = new LinkedInDraftAgent({ router: options.router, tools, promptStore: options.promptStore });
    const draftResult = await wf.step.agent("09-draft-post", draftAgent, {
      topic: selected.topic,
      source: selected.source,
      archetype: archetypeSelection.archetype,
      voiceRules: clientContext.voiceRules,
      identity: clientContext.identity,
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
      const requiredDisclaimer = clientContext.brand["requiredDisclaimer"] as string | undefined;
      const verdict = await runGate(
        tools,
        "gate.brandCompliance",
        { text: draft.text, forbiddenTerms: forbiddenTerms ?? [], ...(requiredDisclaimer !== undefined ? { requiredDisclaimer } : {}) },
        ctx,
      );
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.brandCompliance: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`brand compliance failed: ${verdict.reason}`);
      return verdict;
    });

    await wf.step.code("12-render-preview-check", async () => {
      const outcome = await tools["render.preview"]!.execute({ text: draft.text }, { ctx });
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`render.preview failed: ${outcome.status}`);
      const preview = outcome.result as RenderPreviewResult;
      if (!preview.withinLimit) {
        throw new WorkflowHeld(`post exceeds the LinkedIn character limit (${preview.characterCount} chars)`);
      }
      return preview;
    });

    // gate.noPlaceholder and gate.leakCheck exist in packages/tools/karos-gates
    // but were never wired into any channel's runtime step sequence before
    // Phase 2.5 — restored here, run before the human ever sees the draft.
    await wf.step.code("13-verify-no-placeholder", async () => {
      const verdict = await runGate(tools, "gate.noPlaceholder", { text: draft.text }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.noPlaceholder: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`draft contains an unresolved placeholder: ${verdict.reason}`);
      return verdict;
    });

    await wf.step.code("14-verify-no-leak", async () => {
      const verdict = await runGate(tools, "gate.leakCheck", { text: draft.text }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.leakCheck: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`draft appears to leak sensitive content: ${verdict.reason}`);
      return verdict;
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
          payload: { runId: wf.runId, topic: selected.topic, archetype: draft.archetype, preview: draft.text },
          requiredRole: "account_manager",
          timeout: { duration: "24h", onTimeout: "hold" },
        });
    if (reviewDecision.decision !== "approve") {
      throw new WorkflowHeld(`batch rejected: ${reviewDecision.reason ?? "no reason given"}`);
    }

    // ── 16-17: deliverable & manifest persistence ──
    const deliverableId = await wf.step.code("16-persist-deliverable", async (): Promise<string> => {
      const outcome = await tools["ledger.writeDeliverable"]!.execute({ runId: wf.runId, kind: "linkedin-post", deliverable: draft }, { ctx });
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`ledger.writeDeliverable failed: ${outcome.status}`);
      return (outcome.result as { id: string }).id;
    });

    await wf.step.code("17-persist-manifest", async () => {
      await tools["ledger.dashboardSnapshot"]!.execute(
        { runId: wf.runId, snapshot: { topic: selected.topic, source: selected.source, archetype: draft.archetype, deliverableId } },
        { ctx },
      );
    });

    // ── 18: commit updates (topics.commit, memory.appendDecision, ledger.feedbackAppend) ──
    await wf.step.code("18-commit-and-record", async () => {
      if (selected.source === "reserved" && reservation.reservationKey) {
        await tools["topics.commit"]!.execute({ reservationKey: reservation.reservationKey }, { ctx });
      }
      await tools["memory.appendDecision"]!.execute(
        { decisionId: `${wf.runId}__decision`, summary: `Posted about "${selected.topic}" (archetype: ${draft.archetype})` },
        { ctx },
      );
      await tools["ledger.feedbackAppend"]!.execute(
        { runId: wf.runId, feedbackId: `${wf.runId}__review`, decision: reviewDecision.decision, actor: reviewDecision.actor },
        { ctx },
      );
    });

    return { topic: selected.topic, archetype: draft.archetype, targetAudience: draft.targetAudience, deliverableId };
  };
}
