import { readForbiddenTopics } from "@agent-engine/core";
import type { AgentContext, AgentToolRegistry, GateResponse, GateVerdict, ModelRouter, PromptStore } from "@agent-engine/core";
import { runLinkedInChannelSetup, type ChannelSetupOutcome } from "@agent-engine/agent-setup";
import { type WorkflowContext, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure, runTopicGuardrail, extractResearchCandidate, type ResearchPullResult, readRunDirection, runDirectionField, type RevisionNote, MAX_REVISION_ROUNDS, persistReviewFeedbackToMemory, readPastFeedback, revisionDirective, runReviewCycle} from "@agent-engine/workflow";
import { LinkedInDraftAgent } from "../agent/linkedin-draft-agent.js";
import { renderPreview, type RenderPreviewResult } from "../tools/render-preview.js";
import { renderLinkedInDraftsMarkdown } from "./render-drafts-markdown.js";
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
/**
 * This run's own request layered over the client's standing configuration.
 *
 * `lanes.md`: "the customer's run request wins". Before the engine could
 * carry a per-run input, the only way to express one was to write it into
 * client config -- which every other run for that client then inherited.
 *
 * Only run-scoped keys are overlaid. Client identity (executives, handles) is
 * not a per-run choice, and letting a job payload rewrite it would be a
 * tenancy hole rather than a feature.
 */
const RUN_SCOPED_KEYS = ["requestedTopic", "requestedArchetype", "requestedIdentityScope", "requestedExecutiveName"] as const;

function withRunInput(config: unknown, input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const base = (config ?? {}) as Record<string, unknown>;
  const overlay: Record<string, unknown> = {};
  for (const key of RUN_SCOPED_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) overlay[key] = value.trim();
  }
  return { ...base, ...overlay };
}

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
/**
 * "Daniel Herbert" -> "daniel-herbert", matching the lab repo's own
 * `seat-intake/<name>.md` filenames, which is what the migrated documents are
 * keyed by. Kept beside the caller rather than in a shared util because it
 * encodes that one naming convention and nothing else depends on it.
 */
function slugifySeat(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function createLinkedInAgentWorkflow(options: CreateLinkedInAgentWorkflowOptions) {
  const tools: AgentToolRegistry = { ...options.tools, "render.preview": renderPreview };

  return async function linkedInAgentWorkflow(wf: WorkflowContext): Promise<LinkedInAgentWorkflowResult> {
    const ctx = toAgentContext(wf);

    // The run-scoped instruction someone typed in the portal, resolved once.
    // A typed sentence outranks the topic catalog for the same reason an
    // explicit requestedTopic does: a person who wrote it has more
    // information about this run than a catalog row does. Style-only notes
    // are deliberately NOT promoted to topics -- see readRunDirection.
    const runDirection = readRunDirection(wf.input);

    /*
     * ── 00-channel-setup: a pre-flight this agent runs for itself ──
     *
     * `linkedin-setup-agent` used to be a separate product in the catalog, and
     * the sequencing was left to whoever ran it: notice this client has no
     * charter, find the setup card, run it, come back. Nothing enforced that
     * order and nothing announced it, so a run against an unconfigured client
     * simply drafted with `strategy: null` — a post in nobody's voice, with no
     * "never post about X" list, and no error anywhere.
     *
     * Now the run checks first. A client with a charter pays one read and
     * nothing else; a run carrying a filled form records it here and drafts
     * against it immediately.
     *
     * NOT blocking when neither exists. This agent has always been able to
     * draft without a charter — `01-load-client-context` treats a missing one
     * as `strategy: null` — and turning that into a refusal would take away a
     * capability while claiming to add one. The step records which of the three
     * paths it took, so "drafted without a charter" is visible in the trace
     * rather than inferred from its absence.
     */
    const channelSetup: ChannelSetupOutcome = await wf.step.code("00-channel-setup", () =>
      runLinkedInChannelSetup({ tools, ctx, runId: wf.runId, clientSlug: wf.clientSlug, input: wf.input ?? {} }),
    );

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
      const { requestedIdentityScope } =
        configOutcome.status === "success"
          ? readRunConfig(withRunInput(configOutcome.result, wf.input))
          : readRunConfig(withRunInput({}, wf.input));
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
        // Same read that produced identityScope, so the terminal guardrail
        // below costs no extra step.
        forbiddenTopics: configOutcome.status === "success" ? readForbiddenTopics(configOutcome.result) : [],
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
      const merged = withRunInput(config.status === "success" ? config.result : {}, wf.input);
      const requestedTopic = (merged as { requestedTopic?: string }).requestedTopic;
      const { requestedIdentityScope, requestedExecutiveName, requestedArchetype } = readRunConfig(merged);
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

      // The setup document for the identity this run posts as: the seat's own
      // intake for an executive, the company page's standing direction
      // otherwise. Keyed by identity rather than by client so a seat never
      // inherits the company's charter — see LinkedInClientContext.strategy.
      //
      // The tool may be absent from a caller's registry entirely (it is new);
      // that is the same as having no document, not a crash.
      const getStrategy = tools["client.getStrategy"];
      let strategy: string | null = null;
      if (getStrategy) {
        const key = identity.scope === "executive" ? slugifySeat(identity.executiveName) : undefined;
        const outcome = await getStrategy.execute(
          { agent: "linkedin-agent", ...(key ? { key } : {}) },
          { ctx },
        );
        if (outcome.status === "success") {
          strategy = (outcome.result as { markdown: string }).markdown;
        }
      }

      return {
        profile: profile.status === "success" ? (profile.result as Record<string, unknown>) : {},
        brand: brand.status === "success" ? (brand.result as Record<string, unknown>) : {},
        voiceRules: voiceRules.status === "success" ? (voiceRules.result as LinkedInClientContext["voiceRules"]) : {},
        ...(requestedTopic !== undefined ? { requestedTopic } : {}),
        ...(requestedArchetype !== undefined ? { requestedArchetype } : {}),
        identity,
        strategy,
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
      const outcome = await tools["research.pull"]!.execute(
        {
          job: "linkedin-trend-scan",
          query,
          window: "7d",
          // Anti-repetition context: this agent's own prior deliverables, so
          // the extraction below can steer off a subject already covered.
          historyAgentId: "linkedin-agent",
        },
        { ctx },
      );
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`research.pull failed: ${outcome.status}`);
      }
      // The payload is kept, not discarded. Step 05 reads the real documents
      // out of it; before this it saw only `runId`/`query` and had nothing to
      // extract from even once the search became real.
      return outcome.result as ResearchPullResult;
    });

    const candidateSummary = await wf.step.code("05-extract-candidate-summary", (): LinkedInCandidateSummary =>
      // Shared with every other publishing agent (`extractResearchCandidate`).
      // This step used to return the QUERY as the topic, on the grounds that
      // research.pull was a stand-in with nothing to extract -- accurate when
      // written, false since the scraper landed, and the same stale comment
      // was sitting in five agents at once. One implementation now.
      extractResearchCandidate(research, { avoidTopics: recentDecisions.summaries }),
    );

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
      // Highest precedence, above an explicit requestedTopic's own branch
      // below only when that is absent: a typed instruction is this run's
      // most specific statement of intent.
      if (runDirection.topicOverride) {
        return { topic: runDirection.topicOverride, source: "requested" };
      }
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
    // ── The read side of the feedback flywheel: what this client asked
    //    for on previous runs, injected into the drafting prompt. Bounded
    //    and best-effort — a memory read failing must not stop a run that
    //    can draft perfectly well without it.
    const pastFeedback = await readPastFeedback(wf, tools, ctx, "04e-read-past-feedback");


    // ── 09-14: draft execution via LinkedInDraftAgent, with machine/claim/compliance/hygiene gates ──
    const draftAgent = new LinkedInDraftAgent({ router: options.router, tools, promptStore: options.promptStore });
    /**
     * One full drafting pass: draft, every deterministic content gate, then
     * the terminal topic guardrail.
     *
     * Called once per REVISION round by `runReviewCycle`. `revision` is
     * folded into every checkpointed step id inside it (via `rev`), so a
     * second round genuinely re-drafts instead of short-circuiting on the
     * first round's checkpoints — while everything OUTSIDE it (intake,
     * research, the topic reservation) keeps its id and is reused. That
     * reuse is why the revision is in-run rather than a fresh run.
     */
    const draftOnce = async (revision: number, notes: readonly RevisionNote[]) => {
      /** Revision 0 keeps the ORIGINAL ids, so a first-pass trace is unchanged. */
      const rev = (id: string) => (revision === 0 ? id : `${id}-r${revision}`);
      const directive = revisionDirective(notes);

    const draftResult = await wf.step.agent(rev("09-draft-post"), draftAgent, {
      ...runDirectionField(runDirection),
      topic: selected.topic,
      source: selected.source,
      archetype: archetypeSelection.archetype,
      voiceRules: clientContext.voiceRules,
      identity: clientContext.identity,
      // Two distinct steers, kept apart on purpose: `pastFeedback` is what
      // this client has said across previous RUNS, `revisionRequest` is what
      // a reviewer asked about THIS draft minutes ago.
      ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
      ...(directive !== undefined ? { revisionRequest: directive } : {}),
    });

    if (draftResult.status === "content_fail") {
      throw new WorkflowHeld(`draft did not clear its own self-critique gate: ${draftResult.status}`);
    }
    if (draftResult.status !== "completed") {
      throw new WorkflowToolingFailure(`draft step resolved to "${draftResult.status}"`);
    }
    const draft = draftResult.finalOutput!;

    await wf.step.code(rev("10-verify-numbers-sourced"), async () => {
      const sources = candidateSummary.hasNumericInsight ? [candidateSummary.sourceLabel] : [];
      const verdict = await runGate(tools, "gate.numbersSourced", { text: draft.text, sources }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.numbersSourced: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`numbers not sourced: ${verdict.reason}`);
      return verdict;
    });

    await wf.step.code(rev("11-verify-brand-compliance"), async () => {
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

    await wf.step.code(rev("12-render-preview-check"), async () => {
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
    await wf.step.code(rev("13-verify-no-placeholder"), async () => {
      const verdict = await runGate(tools, "gate.noPlaceholder", { text: draft.text }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.noPlaceholder: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`draft contains an unresolved placeholder: ${verdict.reason}`);
      return verdict;
    });

    await wf.step.code(rev("14-verify-no-leak"), async () => {
      const verdict = await runGate(tools, "gate.leakCheck", { text: draft.text }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.leakCheck: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`draft appears to leak sensitive content: ${verdict.reason}`);
      return verdict;
    });

    // ── 15: human batch-review gate — nothing ships without a real approval ──
    // ── terminal topic guardrail ──
    //
    // Before the human gate: a reviewer should never be shown a draft that
    // engages a subject this client said it does not touch. Not a repeat of
    // gate.brandCompliance -- that matches forbiddenTerms as substrings and
    // catches the word, while this judges the subject. Free for a client who
    // forbids nothing: no list, no step, no model call.
    await runTopicGuardrail(wf, { tools, promptStore: options.promptStore, router: options.router }, draft.text, intake.forbiddenTopics, revision === 0 ? undefined : `-r${revision}`);

      return draft;
    };

    // ── The universal approve / revise / reject cycle ──
    //
    // `revise` re-drafts with the reviewer's feedback injected, reusing
    // everything already checkpointed, instead of holding the run and
    // forcing somebody to dispatch a fresh one that knows nothing about the
    // feedback. Every decision, approvals included, reaches client memory.
    const review = await runReviewCycle(wf, {
      gateId: "15-batch-review",
      maxRevisions: MAX_REVISION_ROUNDS,
      ...(options.autoApprove ? { autoApprove: true } : {}),
      attempt: draftOnce,
      buildGate: (draft, revision) => ({
        kind: "batch_review",
        payload: { runId: wf.runId, topic: selected.topic, archetype: draft.archetype, preview: draft.text, revision },
        requiredRole: "account_manager",
        timeout: { duration: "24h", onTimeout: "hold" },
      }),
      onDecision: async ({ revision, response }) => {
        await persistReviewFeedbackToMemory(wf, tools, ctx, revision, response);
      },
    });
    const draft = review.output;

    // ── 16-17: deliverable & manifest persistence ──
    const deliverableId = await wf.step.code("16-persist-deliverable", async (): Promise<string> => {
      // Additive: `draftsMarkdown` is the "# LinkedIn drafts"-shaped string
      // karosCMO's `li-drafts.ts` parser needs on `asset.content` — the rest
      // of `draft` stays untouched for any consumer that wants raw fields.
      const companyName = clientContext.profile["companyName"];
      const draftsMarkdown = renderLinkedInDraftsMarkdown({
        identity: clientContext.identity,
        ...(typeof companyName === "string" ? { companyName } : {}),
        archetype: draft.archetype,
        topic: selected.topic,
        draft,
      });
      const outcome = await tools["ledger.writeDeliverable"]!.execute(
        { runId: wf.runId, kind: "linkedin-post", deliverable: { ...draft, draftsMarkdown } },
        { ctx },
      );
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
        { runId: wf.runId, feedbackId: `${wf.runId}__review`, decision: review.response.decision, actor: review.response.actor },
        { ctx },
      );
    });

    return {
      topic: selected.topic,
      archetype: draft.archetype,
      targetAudience: draft.targetAudience,
      deliverableId,
      channelSetup: channelSetup.status,
    };
  };
}
