import { readForbiddenTopics } from "@agent-engine/core";
import type { AgentContext, AgentToolRegistry, GateResponse, ModelRouter, PromptStore } from "@agent-engine/core";
import { runLinkedInChannelSetup, type ChannelSetupOutcome } from "@agent-engine/agent-setup";
import {
  type WorkflowContext,
  WorkflowBlockedIntake,
  WorkflowHeld,
  WorkflowToolingFailure,
  runTopicGuardrail,
  extractResearchCandidate,
  researchDigestForDrafting,
  researchSourceTexts,
  readRunDirection,
  runDirectionField,
  type RevisionNote,
  MAX_REVISION_ROUNDS,
  persistReviewFeedbackToMemory,
  readPastFeedback,
  revisionDirective,
  runReviewCycle,
  buildClientVoiceContext,
  readCrossChannelHistory,
  crossChannelDirective,
  crossChannelAvoidTopics,
  socialAccountsFromClient,
  checkOutputDedupe,
  dedupeRetryDirective,
  readClientIntelContext,
  readLearningContext,
  ensureStrategyMap,
  subjectWindowConflict,
  touchesNeverTopic,
  stageForRun,
  pickStrategyRow,
  craftRulesForPrompt,
  feedbackForPrompt,
  writeRunState,
  resolveGoalLine,
  platformStateForDrafting,
  preferencesForDrafting,
  strategyRowForDrafting,
  toAgentContext,
  runGate,
  finalizeDeliverable,
  recordOutputExcerpt,
  buildTrendQueries,
  pullTrendResearch,
  runTrendScout,
  researchDigestForScout,
  selectContentMode,
  selectTrendCandidate,
  trendCandidateForDrafting,
  parseContentModeFromSummary,
  analyzeAttachedMedia,
  attachedMediaForDrafting,
  resolveSocialMedia,
  mediaForDeliverable,
  type ContentMode,
  type SocialMediaPlan,
  type TrendResearch,
  type TrendScoutOutput,
  runCheckWithRepair,
  relativeDayProblems,
  stripRelativeDays,
  redactSentencesCarrying,
  localContentFail,
  localPass,
  spansFromEvidence,
  type ContentRepair,
} from "@agent-engine/workflow";
import type { GateVerdict } from "@agent-engine/core";
import { LinkedInDraftAgent, type LinkedInPostOutput } from "../agent/linkedin-draft-agent.js";
import { renderPreview, LINKEDIN_CHARACTER_LIMIT, type RenderPreviewResult } from "../tools/render-preview.js";
import { renderLinkedInDraftsMarkdown } from "./render-drafts-markdown.js";
import { whyNowFor } from "./learning.js";
import { checkLinkedInFormatting, reflowLinkedInText, type LinkedInFormattingReport } from "./linkedin-format.js";
import {
  ARCHETYPES_FOR_MODE,
  LINKEDIN_ARCHETYPES,
  type LinkedInAgentWorkflowResult,
  type LinkedInArchetype,
  type LinkedInArchetypeSelection,
  type LinkedInCandidateSummary,
  type LinkedInClientContext,
  type LinkedInContentModeSelection,
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
  /**
   * Bounds root for the media cache (2026-09). Every sourced or attached image
   * lands under `<repoRoot>/.media-cache/<runId>/`. Optional: without it the
   * post ships as text and the media step records why.
   */
  repoRoot?: string | undefined;
}

/**
 * How many drafting passes the verified de-duplication check may cost —
 * initial draft plus two redraft steers, the same budget instagram-agent's
 * `MAX_SELF_CHECK_ATTEMPTS` gives its own 07d dedupe check. On the last
 * attempt a `similar` draft ships FLAGGED (the verdict stays checkpointed for
 * the trace and the reviewer), never held: `evaluateDedupe`'s own policy is
 * that de-duplication flags and steers, it does not hold a run.
 */
/**
 * A bare link anywhere in the body. Deliberately the same shape x-agent uses
 * — a scheme is what makes a URL a URL, and anything cleverer starts matching
 * "example.com" inside a sentence, which is prose, not a link.
 */
const BARE_URL_PATTERN = /https?:\/\//i;

const MAX_DEDUPE_ATTEMPTS = 3;

/**
 * What a prose field says when every one of its sentences carried a span a
 * content gate rejected.
 *
 * Reachable only on a post short enough that one sentence was the whole field.
 * It exists because the alternative at that point is falling back to the
 * unredacted text — which republishes the very span the gate refused — and
 * because every one of these fields is `min(1)` in the schema.
 */
const POST_WITHHELD = "(withheld: this line rested on content that failed verification)";

/** The draft plus the media and formatting report the run produced for it — what the review gate shows and the deliverable persists. */
type LinkedInDraftWithMedia = LinkedInPostOutput & { mediaPlan: SocialMediaPlan; formatting: LinkedInFormattingReport };

/** A valid archetype name, or `undefined` if the string isn't one of `LINKEDIN_ARCHETYPES`. */
function parseArchetype(value: unknown): LinkedInArchetype | undefined {
  return typeof value === "string" && (LINKEDIN_ARCHETYPES as readonly string[]).includes(value) ? (value as LinkedInArchetype) : undefined;
}

/** Pulls a decision summary's recorded archetype back out (written as `(archetype: <name>)` by step 18) — the mechanism the "never the same lane as last post" rule (`lanes.md` §2) actually checks against. */
function extractArchetypeFromSummary(summary: string): LinkedInArchetype | undefined {
  const match = /archetype:\s*([a-z-]+)/i.exec(summary);
  return match ? parseArchetype(match[1]!.toLowerCase()) : undefined;
}

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
const RUN_SCOPED_KEYS = ["requestedTopic", "requestedArchetype", "requestedIdentityScope", "requestedExecutiveName", "requestedMode"] as const;

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
  requestedMode?: string;
} {
  const record = config as {
    requestedIdentityScope?: LinkedInIdentityScope;
    requestedExecutiveName?: string;
    requestedArchetype?: string;
    requestedMode?: string;
  };
  const requestedArchetype = parseArchetype(record.requestedArchetype);
  return {
    ...(record.requestedIdentityScope !== undefined ? { requestedIdentityScope: record.requestedIdentityScope } : {}),
    ...(record.requestedExecutiveName !== undefined ? { requestedExecutiveName: record.requestedExecutiveName } : {}),
    ...(requestedArchetype !== undefined ? { requestedArchetype } : {}),
    ...(typeof record.requestedMode === "string" ? { requestedMode: record.requestedMode } : {}),
  };
}

function readStringList(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
  return items.length > 0 ? items : undefined;
}

/** The art direction the generative fallback receives, from the client's brand record. Nothing is invented: absent fields stay absent. */
function artDirectionFromBrand(brand: Record<string, unknown>): { aesthetic?: string; lighting?: string; palette?: string[]; accentColor?: string; mood?: string } | undefined {
  const pick = (key: string) => (typeof brand[key] === "string" && (brand[key] as string).trim().length > 0 ? (brand[key] as string).trim() : undefined);
  const palette = readStringList(brand, "palette");
  const art = {
    ...(pick("aesthetic") ? { aesthetic: pick("aesthetic")! } : {}),
    ...(pick("lighting") ? { lighting: pick("lighting")! } : {}),
    ...(palette ? { palette: palette.slice(0, 6) } : {}),
    ...(pick("accent") ? { accentColor: pick("accent")! } : {}),
    ...(pick("visualMood") ? { mood: pick("visualMood")! } : {}),
  };
  return Object.keys(art).length > 0 ? art : undefined;
}

/** Picks the executive to post as: an explicit per-run name match (case-insensitive) wins, else the first configured executive. */
function selectExecutive(executives: Executive[], requestedExecutiveName?: string): Executive {
  if (requestedExecutiveName) {
    const match = executives.find((e) => e.name.toLowerCase() === requestedExecutiveName.toLowerCase());
    if (match) return match;
  }
  return executives[0]!;
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

/**
 * `createLinkedInAgentWorkflow()` (RFC-02 §5 — "same recipe" as the X pilot
 * in §3): the recurring/on-demand run protocol, steps `00`–`18`. One post,
 * one run (RFC-01 §16.2's ruling) — no fan-out here; every LinkedIn run
 * produces at most one deliverable. Step 15 is a mandatory human
 * `batch_review` gate (RFC-01 §8.3) unless `options.autoApprove` opts out.
 *
 * ## The 2026-09 elite-tier upgrade, in the order a run meets it
 *
 * - **04**: research is several questions (industry news, launches/deals/
 *   reports, the client's own name, the client's configured `trendQueries`),
 *   merged and de-duplicated.
 * - **07a**: when nobody planned this run's subject, a trend SCOUT (Gemini
 *   Flash) turns the research into brand-fit-scored candidates tagged by
 *   content mode; the strongest on-brand one takes the slot.
 * - **07b**: the content-mode rotation — hot news / deep value / open
 *   discussion — never the same twice, steering which archetype family 08
 *   draws from.
 * - **08b**: media the client ATTACHED is read by a vision model BEFORE
 *   drafting, so the post is written to the picture.
 * - **09**: the draft receives the research itself, the trend candidate,
 *   the mode and the attached media — until now it received a headline.
 * - **09b**: the post is re-flowed into LinkedIn's shape (one or two
 *   sentences per line, a blank line between) without touching a word, and
 *   the takeaway's presence is checked; findings are notes for the
 *   reviewer, never a hold.
 * - **10**: the numbers gate verifies against source TEXT, not a URL.
 * - **14b**: the media resolver answers the draft's own `mediaBrief`
 *   (screenshot, article image, stock, generation last, vision-judged).
 */
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
      const config = configOutcome.status === "success" ? (configOutcome.result as Record<string, unknown>) : {};
      const { requestedIdentityScope, requestedMode } = readRunConfig(withRunInput(config, wf.input));
      const identityScope: LinkedInIdentityScope = requestedIdentityScope ?? options.identityScope ?? "company";
      if (identityScope === "executive") {
        const executivesOutcome = await tools["client.getExecutives"]!.execute({}, { ctx });
        if (executivesOutcome.status !== "success" || (executivesOutcome.result as Executive[]).length === 0) {
          throw new WorkflowBlockedIntake(
            "identityScope is \"executive\" for this run, but the client has no executives configured to post as",
          );
        }
      }
      const trendQueries = readStringList(config, "trendQueries");
      return {
        // Same read that produced identityScope, so the terminal guardrail
        // below costs no extra step.
        forbiddenTopics: configOutcome.status === "success" ? readForbiddenTopics(configOutcome.result) : [],
        profile: profileOutcome.result as Record<string, unknown>,
        voiceRules: voiceRulesOutcome.result as Record<string, unknown>,
        ...(requestedMode !== undefined ? { requestedMode } : {}),
        ...(trendQueries ? { trendQueries } : {}),
        trendJacking: config["trendJacking"] === "always" ? "always" : "fallback",
        // Kept for the cross-channel history read, which derives the client's
        // own social accounts (xHandle, socialAccounts, …) from it.
        rawConfig: config,
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

    // ── 01b: what the PLATFORM has learned about this client on LinkedIn (C7, A1) ──
    //
    // The seven optional files the middleware projects before dispatch (see
    // x-agent's step of the same name for the history). Best-effort and
    // checkpointed: a client with nothing projected drafts exactly as before.
    const learning = await readLearningContext(wf, tools, ctx, "linkedin", "01b-read-learning-context");
    // The stage this run writes for: the calendar slot's, else D32's default
    // mix walked against what the subject window already holds.
    const stage = stageForRun(runDirection.slotStage, learning.subjectWindow);

    const beliefs = await wf.step.code("02-load-memory-shelf", async () => {
      const outcome = await tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
      return outcome.status === "success" ? outcome.result : { scope: "beliefs", beliefs: {} };
    });

    const recentDecisions = await wf.step.code("03-load-recent-decisions", async (): Promise<LinkedInDecisionsShelf & { modes: ContentMode[] }> => {
      const outcome = await tools["memory.read"]!.execute({ scope: "decisions" }, { ctx });
      if (outcome.status !== "success") return { summaries: [], modes: [] };
      const result = outcome.result as { scope: string; items: Array<{ summary: string; at?: number }> };
      // `memory.read({scope:"decisions"})` is now product-scoped (AU24 / audit
      // §4.2-§4.3-3): `karos-memory` keys the decision log by `(clientSlug,
      // productId)`, so `result.items` here is already just this LinkedIn
      // product's own history — a same-client `x-agent`/`blog-agent`/etc. post
      // can no longer stand in for "the last LinkedIn post," at any timestamp.
      // The archetype-parsing below still has a real job: a decision row has
      // no first-class `archetype` field, only the free-text `summary` step 18
      // writes it into, so this still has to pull the value back out of that
      // string and filter out any row that doesn't parse one. Sorting by the
      // decision's own `at` (mirroring x-agent's lane.ts) still matters:
      // `listJson` returns entries in filename order, not chronological order.
      const dated = result.items.map((item) => ({ at: item.at ?? 0, summary: item.summary })).sort((a, b) => a.at - b.at);
      const lastArchetype = dated
        .map((item) => extractArchetypeFromSummary(item.summary))
        .filter((a): a is LinkedInArchetype => a !== undefined)
        .at(-1);
      // The content modes, oldest first — the same summary field, `(… mode: X)`.
      const modes = dated.map((item) => parseContentModeFromSummary(item.summary)).filter((m): m is ContentMode => m !== undefined);
      return {
        summaries: result.items.map((item) => item.summary),
        ...(lastArchetype !== undefined ? { lastArchetype } : {}),
        modes,
      };
    });

    // ── 04-05: research pull (persisting verbatim raw payloads inside research.pull itself) ──
    //
    // Several questions, one step (2026-09). `${industry} thought leadership
    // trends this week` alone returned the week's generic think-pieces and no
    // launch, deal or report that had actually happened.
    const industry = (clientContext.profile["industry"] as string | undefined) ?? undefined;
    const companyName = (clientContext.profile["companyName"] as string | undefined) ?? (clientContext.profile["name"] as string | undefined);
    const queries = buildTrendQueries({
      industry,
      companyName,
      configuredQueries: intake.trendQueries,
      requestedTopic: runDirection.topicOverride ?? clientContext.requestedTopic,
    });
    const research: TrendResearch = await pullTrendResearch(wf, tools, ctx, {
      stepId: "04-research-pull",
      job: "linkedin-trend-scan",
      queries: queries.length > 0 ? queries : [`${industry ?? "this industry"} thought leadership trends this week`],
      // LinkedIn content moves slower than X news — a 7-day window vs. X's 24h.
      window: "7d",
      // Anti-repetition context: this agent's own prior deliverables, so
      // the extraction below can steer off a subject already covered.
      historyAgentId: "linkedin-agent",
    });

    const candidateSummary = await wf.step.code("05-extract-candidate-summary", (): LinkedInCandidateSummary =>
      // Shared with every other publishing agent (`extractResearchCandidate`).
      // Kept as the last-resort fallback behind the scout.
      extractResearchCandidate(research.merged, { avoidTopics: recentDecisions.summaries }),
    );

    // ── 06-08: candidate selection, mode and archetype determination ──
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
      // step 07's precedence falls through to the scout, then the research-derived candidate.
      return { topics: [] };
    });

    // ── The read side of the feedback flywheel: what this client asked
    //    for on previous runs, injected into the drafting prompt. Bounded
    //    and best-effort — a memory read failing must not stop a run that
    //    can draft perfectly well without it.
    const pastFeedback = await readPastFeedback(wf, tools, ctx, "04e-read-past-feedback");
    // The anti-repetition read — CROSS-CHANNEL (2026-09): what this client
    // already published on EVERY channel we draft for and on their own
    // accounts, so a story X told yesterday is not retold here as new. Read
    // before the scout, which must not propose what the client just published.
    const crossChannel = await readCrossChannelHistory(wf, tools, ctx, {
      stepId: "read-cross-channel-history",
      socialAccounts: socialAccountsFromClient(intake.rawConfig, clientContext.brand),
    });
    const outputHistory = crossChannel.entries;
    const recentPostsDirective = crossChannelDirective(crossChannel);
    // The client intel report AND knowledge base, distilled to what steers
    // copy — the client knowledge this platform holds, read by the scout and
    // the draft alike.
    const clientIntelContext = await readClientIntelContext(wf, tools, ctx, "read-intel-context");

    // ── 01c: the strategy map — handed to the run, or built by it (C1, SCRUM-464) ──
    // See x-agent's step of the same name. LinkedIn's rows carry the archetype as `type`.
    const strategy = await ensureStrategyMap(wf, { tools, promptStore: options.promptStore, router: options.router }, ctx, {
      platform: "linkedin",
      learning,
      stepId: "01c-build-strategy-map",
      input: {
        today: new Date().toISOString().slice(0, 10),
        clientProfile: clientContext.profile,
        ...(clientContext.strategy ? { accountCharter: clientContext.strategy } : {}),
        ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
        forbiddenTopics: [...intake.forbiddenTopics, ...(learning.preferences?.neverTopics ?? [])],
      },
    });
    const strategyRow = pickStrategyRow(strategy.map, stage, learning.subjectWindow);
    const clientVoiceContext = buildClientVoiceContext(clientContext.profile, clientContext.voiceRules, clientContext.brand);

    // ── 07a: the trend scout — only when no one planned this run's subject ──
    //
    // A typed or configured topic is the client's own statement; a catalog
    // row is a planned editorial slot with a dedup lock. Both outrank a trend
    // by default (`trendJacking: "fallback"`), so the scout runs exactly where
    // the old code fell back to "first headline with a number in it".
    const wantsScout = !runDirection.topicOverride && !clientContext.requestedTopic && (reservation.topics.length === 0 || intake.trendJacking === "always");
    let scout: TrendScoutOutput | undefined;
    if (wantsScout) {
      scout = await runTrendScout(wf, { tools, promptStore: options.promptStore, router: options.router }, "07a-trend-scout", {
        research: researchDigestForScout(research.merged),
        channel: "linkedin",
        clientProfile: clientContext.profile,
        ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
        ...(clientVoiceContext !== undefined ? { clientVoiceContext } : {}),
        ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
        forbiddenTopics: intake.forbiddenTopics,
        today: new Date().toISOString().slice(0, 10),
      });
    }

    // ── 07b: the content-mode rotation — never the same twice, least-used first ──
    //
    // Precedence (SCRUM-430, mirroring tiktok's "customPrompt wins over
    // requestedTopic"): a typed run note that names a kind of post outranks the
    // dialog's "Kind of post" pick, because the person who wrote the sentence
    // said more about THIS run than the person who clicked a chip did. A note
    // that says nothing about the kind of post leaves the pick standing — the
    // note is not ignored, it just spoke to a different axis (topic, style).
    const modeSelection = await wf.step.code("07b-select-content-mode", (): LinkedInContentModeSelection => {
      const priorMode = recentDecisions.modes.at(-1);
      const directed = runDirection.modeOverride;
      const mode = selectContentMode(recentDecisions.modes, directed ?? intake.requestedMode);
      const source: LinkedInContentModeSelection["source"] =
        directed !== undefined && mode === directed
          ? "directed"
          : intake.requestedMode !== undefined && mode === intake.requestedMode
            ? "requested"
            : "rotation";
      return {
        mode,
        source,
        ...(priorMode !== undefined ? { priorMode } : {}),
      };
    });

    const selected = await wf.step.code("07-select-candidate", (): LinkedInSelectedCandidate => {
      // Single post selection precedence (RFC-02 §5, "same recipe" as X §3): an
      // explicit client request wins, then a reserved catalog topic, then the
      // scout's on-brand trend, then the research-derived fallback.
      // C7: a topic the client said never to touch is refused whoever proposed
      // it — an explicit request for one HOLDS with the reason, every other
      // source falls through — and a subject already in this platform's
      // window is not proposed again (same rules as x-agent's step 07).
      const never = (topic: string) => touchesNeverTopic(topic, learning.preferences);
      const repeated = (topic: string) => subjectWindowConflict(topic, learning.subjectWindow);
      // A topic on the client's never-list is refused whoever asked for it —
      // including a person typing it into the portal. That rule is absolute and
      // is NOT relaxed here.
      //
      // What changed is the consequence. This used to end the run, so the
      // person who asked got an error and the client got no post that day.
      // Now the request is declined, the refusal is carried out to the
      // deliverable, and selection falls through to something this account IS
      // allowed to talk about. The subject they asked for still never gets
      // written.
      let refusedRequest: string | undefined;
      const requested = runDirection.topicOverride ?? clientContext.requestedTopic;
      if (requested !== undefined) {
        const hit = never(requested);
        if (hit === undefined) return { ...(refusedRequest !== undefined ? { refusedRequest } : {}), topic: requested, source: "requested" };
        refusedRequest = `the requested topic ("${requested}") touches a never-topic the client set ("${hit}"), so this run wrote about something else instead`;
      }
      const trend =
        scout !== undefined
          ? selectTrendCandidate(scout.candidates, modeSelection.mode, { avoidTopics: [...recentDecisions.summaries, ...crossChannelAvoidTopics(crossChannel)] })
          : undefined;
      const trendOk = trend !== undefined && never(trend.topic) === undefined && repeated(trend.topic) === undefined ? trend : undefined;
      const reservedOk = reservation.topics.filter((t) => never(t) === undefined && repeated(t) === undefined);
      if (trendOk !== undefined && intake.trendJacking === "always" && trendOk.brandFit >= 4 && reservedOk.length > 0) {
        return { ...(refusedRequest !== undefined ? { refusedRequest } : {}), topic: trendOk.topic, source: "trend", trend: trendOk };
      }
      if (reservedOk.length > 0) {
        return { ...(refusedRequest !== undefined ? { refusedRequest } : {}), topic: reservedOk[0]!, source: "reserved" };
      }
      if (trendOk !== undefined) {
        return { ...(refusedRequest !== undefined ? { refusedRequest } : {}), topic: trendOk.topic, source: "trend", trend: trendOk };
      }
      // The strategy map (C1 / SCRUM-464): the client's own problem × stage
      // rows, picked for this run's stage — above the research fallback,
      // below the catalog and the scout.
      if (strategyRow !== undefined && never(strategyRow.idea) === undefined) {
        return { ...(refusedRequest !== undefined ? { refusedRequest } : {}), topic: strategyRow.idea, source: "strategy", strategyRowId: strategyRow.id };
      }
      if (candidateSummary.candidateTopic && never(candidateSummary.candidateTopic) === undefined && repeated(candidateSummary.candidateTopic) === undefined) {
        return { ...(refusedRequest !== undefined ? { refusedRequest } : {}), topic: candidateSummary.candidateTopic, source: "research" };
      }
      // ── nothing cleared selection ──
      //
      // This used to end the run. It no longer does, but the relaxation is
      // deliberately one-sided: candidates are rejected here for two very
      // different reasons, and only one of them is soft.
      //
      // `repeated` means this platform covered the subject recently. That is a
      // freshness preference, and a slightly repetitive post the client can
      // decline beats no post at all.
      //
      // `never` is a rule the client set about what they do not talk about.
      // That is not relaxed, here or anywhere below — a topic on the
      // never-list stays refused no matter how little else is available.
      const reservedRepeatOk = reservation.topics.filter((t) => never(t) === undefined);
      if (reservedRepeatOk.length > 0) {
        return { ...(refusedRequest !== undefined ? { refusedRequest } : {}), topic: reservedRepeatOk[0]!, source: "reserved" };
      }
      if (trend !== undefined && never(trend.topic) === undefined) {
        return { ...(refusedRequest !== undefined ? { refusedRequest } : {}), topic: trend.topic, source: "trend", trend };
      }
      if (strategyRow !== undefined && never(strategyRow.idea) === undefined) {
        return { ...(refusedRequest !== undefined ? { refusedRequest } : {}), topic: strategyRow.idea, source: "strategy", strategyRowId: strategyRow.id };
      }
      if (candidateSummary.candidateTopic && never(candidateSummary.candidateTopic) === undefined) {
        return { ...(refusedRequest !== undefined ? { refusedRequest } : {}), topic: candidateSummary.candidateTopic, source: "research" };
      }
      // Everything available is on the client's never-list. Refusing to write
      // is the correct answer to that, and the only remaining honest one.
      throw new WorkflowHeld(
        "every available topic is on the client's never-list — there is nothing this account is permitted to post about this run",
      );
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
     * priority order from position 0, which only ever landed on `order[0]` or
     * `order[1]` — a 2-cycle oscillation that left 9 of the 11 archetypes
     * structurally unreachable. The fix rotates the SCAN'S OWN STARTING POINT
     * by the total number of prior decisions before applying the same "skip
     * the immediate predecessor" rule.
     *
     * 2026-09: the scan prefers the archetype FAMILY of this run's content
     * mode (`ARCHETYPES_FOR_MODE`) — a hot-news week draws an
     * industry-reaction, a deep-value week a teardown or a lesson — and
     * falls back to the whole menu only when every family member is the one
     * just used. A scouted trend that carries a numeric finding uses the
     * numeric ordering like any other numeric candidate.
     */
    const archetypeSelection = await wf.step.code("08-determine-archetype", (): LinkedInArchetypeSelection => {
      const priorArchetype = recentDecisions.lastArchetype;
      const mode = modeSelection.mode;
      if (clientContext.requestedArchetype) {
        return {
          archetype: clientContext.requestedArchetype,
          source: "requested",
          mode,
          ...(priorArchetype !== undefined ? { priorArchetype } : {}),
        };
      }
      const numeric = candidateSummary.hasNumericInsight || selected.trend?.hasNumbers === true;
      const order = numeric ? NUMERIC_INSIGHT_ARCHETYPE_ORDER : DEFAULT_ARCHETYPE_ORDER;
      const rotationIndex = recentDecisions.summaries.length % order.length;
      const rotatedOrder = [...order.slice(rotationIndex), ...order.slice(0, rotationIndex)];
      const family = ARCHETYPES_FOR_MODE[mode];
      const archetype =
        rotatedOrder.find((candidate) => candidate !== priorArchetype && family.includes(candidate)) ??
        rotatedOrder.find((candidate) => candidate !== priorArchetype) ??
        rotatedOrder[0]!;
      return {
        archetype,
        source: "rotation",
        mode,
        ...(priorArchetype !== undefined ? { priorArchetype } : {}),
      };
    });

    // ── 08b: media the client attached, read by a vision model BEFORE drafting ──
    const attachedMedia = await analyzeAttachedMedia(wf, tools, ctx, {
      stepId: "08b-analyze-attached-media",
      repoRoot: options.repoRoot,
      assets: runDirection.mediaAssets,
    });
    const attachedForDrafting = attachedMediaForDrafting(attachedMedia);

    // The research itself, shaped for the drafting prompt: every fetched
    // source's title, url, date and excerpt. Until 2026-09 the draft was handed
    // a headline and nothing else. A pure function of step 04's output.
    const researchDigest = researchDigestForDrafting(research.merged);
    const researchSources = (researchDigest ?? []).filter((d) => d.url !== undefined).map((d) => ({ url: d.url!, title: d.title }));

    // ── 09-14: draft execution via LinkedInDraftAgent, with machine/claim/compliance/hygiene gates ──
    // The learning context in the shapes the drafting prompt reads
    // (linkedin-craft §0, §14). Pure functions of step 01b's output.
    const craftRules = craftRulesForPrompt(learning.craft);
    const clientFeedback = feedbackForPrompt(learning.feedback);
    const clientPreferences = preferencesForDrafting(learning.preferences);

    const draftAgent = new LinkedInDraftAgent({ router: options.router, tools, promptStore: options.promptStore });
    /**
     * One full drafting pass: draft, every deterministic content gate, the
     * media resolution, then the terminal topic guardrail.
     *
     * Called once per REVISION round by `runReviewCycle`. `revision` is
     * folded into every checkpointed step id inside it (via `rev`), so a
     * second round genuinely re-drafts instead of short-circuiting on the
     * first round's checkpoints — while everything OUTSIDE it (intake,
     * research, the topic reservation) keeps its id and is reused. That
     * reuse is why the revision is in-run rather than a fresh run.
     */
    /** What each drafting round had to repair before it could deliver. Empty on the normal path. */
    const repairsByRevision = new Map<number, ContentRepair[]>();

    const draftOnce = async (revision: number, notes: readonly RevisionNote[]): Promise<LinkedInDraftWithMedia> => {
      /** Revision 0 keeps the ORIGINAL ids, so a first-pass trace is unchanged. */
      const rev = (id: string) => (revision === 0 ? id : `${id}-r${revision}`);
      const directive = revisionDirective(notes);

      // ── 09/09a: draft, then VERIFY it is not a repeat, before anything else ──
      //
      // `recentPosts` in the drafting input below is ADVISORY: it asks the model
      // not to repeat itself and nothing ever checked whether it listened, so a
      // lightly-reworded reissue of last week's post passed every gate. 09a is
      // the verification half — the same `checkOutputDedupe` primitive, scoring
      // the same excerpt window the read above pulled, with `evaluateDedupe`'s
      // calibrated trigram-Jaccard threshold, inside the drafting pass, so a
      // `similar` verdict COSTS the draft and the human at step 15 can never be
      // shown a draft that has not been scored.
      //
      // On the final attempt the draft ships FLAGGED rather than held — two
      // posts a fortnight apart about the same launch may be exactly right, and
      // a fixed threshold is not entitled to overrule the person reviewing at
      // 15. The verdict is checkpointed either way.
      //
      // The scored text is exactly what step 18 records back into the window
      // (`draft.text`, after the formatting reflow), so every future run
      // compares like with like.
      /** The last drafting input used, so step 14r's redraft reads exactly the same brief. */
      let draftInputForRepair: Record<string, unknown> = {};
      const draftWithVerifiedDedupe = async (): Promise<LinkedInPostOutput> => {
        /** Set by a failed 09a check, so the NEXT attempt's prompt names exactly which published post to move away from. */
        let dedupeRetrySteer: string | undefined;
        for (let attempt = 1; attempt <= MAX_DEDUPE_ATTEMPTS; attempt++) {
          /** Attempt 1 keeps the ORIGINAL step ids, so a run that never repeats itself has a byte-identical trace to what it had before this check existed. */
          const att = (id: string) => (attempt === 1 ? id : `${id}-attempt-${attempt}`);
          const draftInput = {
            ...runDirectionField(runDirection),
            topic: selected.topic,
            source: selected.source,
            archetype: archetypeSelection.archetype,
            contentMode: modeSelection.mode,
            voiceRules: clientContext.voiceRules,
            identity: clientContext.identity,
            // The client's own profile description + voice-rules guidelines,
            // verbatim — this is where a language requirement like Geektime's
            // "Hebrew-language technology site" actually lives.
            ...(clientVoiceContext !== undefined ? { clientVoiceContext } : {}),
            ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
            // The research the post is written from, and the scouted story
            // when one took the slot.
            ...(researchDigest !== undefined ? { research: researchDigest } : {}),
            ...(selected.trend !== undefined ? { trendCandidate: trendCandidateForDrafting(selected.trend) } : {}),
            // What the client attached, as a vision model described it.
            ...(attachedForDrafting !== undefined ? { attachedMedia: attachedForDrafting } : {}),
            ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
            ...(dedupeRetrySteer !== undefined ? { dedupeAvoid: dedupeRetrySteer } : {}),
            // Omitted rather than passed as null when absent (see x-agent).
            ...(clientContext.strategy ? { accountCharter: clientContext.strategy } : {}),
            // ── C7 (A1): what the platform has learned, as the prompt's §0/§14 read it ──
            // Every key is omitted when the file was absent.
            slotStage: stage,
            ...(strategyRow !== undefined ? { strategyRow: strategyRowForDrafting(strategyRow) } : {}),
            ...(learning.platformState !== undefined ? { platformState: platformStateForDrafting(learning.platformState) } : {}),
            ...(learning.whatWorks !== undefined ? { whatWorks: learning.whatWorks } : {}),
            ...(craftRules !== undefined ? { craftRules } : {}),
            ...(clientFeedback.length > 0 ? { clientFeedback } : {}),
            ...(clientPreferences !== undefined ? { clientPreferences } : {}),
            // Two distinct steers, kept apart on purpose: `pastFeedback` is what
            // this client has said across previous RUNS, `revisionRequest` is what
            // a reviewer asked about THIS draft minutes ago.
            ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
            ...(directive !== undefined ? { revisionRequest: directive } : {}),
          };
          const draftResult = await wf.step.agent(rev(att("09-draft-post")), draftAgent, draftInput);
          // Kept for the repair redraft below, which must send byte-identical
          // evidence and differ only in its `revisionRequest`.
          draftInputForRepair = draftInput;

          // A draft that came back unusable gets ANOTHER draft, not a held
          // run: `content_fail` here means the turn returned no parseable
          // structured output, which is a coin flip rather than a verdict.
          const usableDraft =
            draftResult.status === "content_fail"
              ? await wf.step.agent(rev(att("09z-regenerate-post")), draftAgent, draftInput)
              : draftResult;
          if (usableDraft.status === "content_fail") {
            // Twice is no longer a coin flip. Nothing was drafted, so there
            // is nothing to repair and nothing to annotate. `degraded` rather
            // than `held`: `held` means "we looked and decided not to
            // publish", a content verdict nobody made here. Neither status is
            // auto-retried (the queue consumer acks every terminal status);
            // this is about classifying the failure honestly.
            throw new WorkflowToolingFailure("draft did not produce a parseable post on two consecutive attempts");
          }
          if (usableDraft.status !== "completed") {
            throw new WorkflowToolingFailure(`draft step resolved to "${usableDraft.status}"`);
          }
          // The formatting reflow happens HERE, before the dedupe score and
          // every gate, so everything downstream — the recorded excerpt, the
          // gates, the reviewer — sees the exact text that ships. Whitespace
          // only; not a word of the model's prose changes.
          const raw = usableDraft.finalOutput!;
          const candidate: LinkedInPostOutput = { ...raw, text: reflowLinkedInText(raw.text) };

          const dedupeVerdict = await checkOutputDedupe(wf, rev(att("09a-verify-not-duplicate")), candidate.text, outputHistory);
          if (dedupeVerdict.status === "similar" && attempt < MAX_DEDUPE_ATTEMPTS) {
            dedupeRetrySteer = dedupeRetryDirective(dedupeVerdict, outputHistory);
            continue;
          }
          return candidate;
        }
        // Unreachable: the loop's last attempt always returns, because the
        // `continue` above is guarded on `attempt < MAX_DEDUPE_ATTEMPTS`.
        throw new WorkflowToolingFailure("the de-duplication redraft loop ended without a draft");
      };
      /** `let`: the repair region below may hand back a corrected post, and everything downstream must see it. */
      let draft = await draftWithVerifiedDedupe();

      // ── 09b: the shape check — notes for the reviewer, never a hold ──
      //
      // The reflow above already put the post into LinkedIn's rhythm; this
      // records what it could not fix (a single 300-character sentence, a
      // takeaway the model stated but never wrote into the post). A finding
      // here is an editorial call for the human at 15, not a reason to spend
      // another drafting pass or hold a post whose content cleared every gate.
      const formatting = await wf.step.code(rev("09b-verify-formatting"), () => checkLinkedInFormatting(draft.text, draft.takeaway));

      // ── 10-14r: inspect, then REPAIR. This region no longer holds the run. ──
      //
      // Every check here used to `throw new WorkflowHeld(...)`, ending the run
      // and handing the client an error where a post should have been — over
      // one figure, one banned word, or a link in the wrong place. Each of
      // those is a reason to fix that one thing, not to withhold the post.
      //
      // The checks keep their full authority over what may be PUBLISHED and
      // lose the authority to end the run. `tooling_error` still throws.
      //
      // What a figure in the post may be traced to: the full text of every
      // research document (the gate verifies against CONTENT; a URL alone
      // verifies nothing), the client's own intel context, the run's topic, the
      // scouted story, and any legible text in an attached image. Until 2026-09
      // this was `[sourceLabel]`, so every number a draft quoted faithfully
      // from a real source was held anyway.
      const sources = [
        ...researchSourceTexts(research.merged),
        ...(clientIntelContext !== undefined ? [clientIntelContext] : []),
        selected.topic,
        ...(selected.trend !== undefined ? [selected.trend.headline, selected.trend.angle] : []),
        ...(attachedMedia?.analyses.flatMap((a) => a.textInImage) ?? []),
        ...(candidateSummary.hasNumericInsight ? [candidateSummary.sourceLabel] : []),
      ];
      const forbiddenTerms = (clientContext.brand["forbiddenTerms"] as string[] | undefined) ?? [];
      const requiredDisclaimer = clientContext.brand["requiredDisclaimer"] as string | undefined;

      /**
       * Applies a span redaction across EVERY prose field, not just the gated
       * `text`.
       *
       * The deliverable spreads the whole draft, so `body`, `hook`, `headline`,
       * `takeaway` and `callToAction` all reach the client. Repairing `text`
       * alone would re-check clean and ship the rest unredacted.
       *
       * Never falls back to the original on an emptied field: that would put
       * the flagged span straight back, which is the one mistake that turns
       * this whole mechanism into a no-op.
       */
      const redactAcrossDraft = (post: LinkedInPostOutput, spans: readonly string[]): LinkedInPostOutput => ({
        ...post,
        text: redactSentencesCarrying(post.text, spans, POST_WITHHELD).text,
        headline: redactSentencesCarrying(post.headline, spans, POST_WITHHELD).text,
        hook: redactSentencesCarrying(post.hook, spans, POST_WITHHELD).text,
        body: redactSentencesCarrying(post.body, spans, POST_WITHHELD).text,
        takeaway: redactSentencesCarrying(post.takeaway, spans, POST_WITHHELD).text,
        callToAction: redactSentencesCarrying(post.callToAction, spans, POST_WITHHELD).text,
      });

      /**
       * Every prose field a reader actually sees — the same six
       * `redactAcrossDraft` covers. A rule that reaches only `text` leaves the
       * offending phrase sitting in the `body` and `hook` the portal renders
       * beside it, which reads as the rule not working.
       */
      const linkedInProse = (post: LinkedInPostOutput): readonly string[] => [
        post.text,
        post.headline,
        post.hook,
        post.body,
        post.takeaway,
        post.callToAction,
      ];

      /**
       * One problem per distinct relative-day phrase across the whole draft —
       * `relativeDayProblems` dedupes by phrase, so the count is stable
       * whether a phrase appears in one field or all six. That matters:
       * `runCheckWithRepair` keeps a repair only when strictly FEWER problems
       * remain, so a count that moved with field duplication would make a real
       * fix look like no progress.
       */
      const datedProblemsIn = (post: LinkedInPostOutput): string[] =>
        relativeDayProblems(linkedInProse(post).join("\n\n"), "linkedin-craft §12a");

      /** Deletion across every field at once, or nothing — see the floor below. */
      const stripDatedAcrossDraft = (post: LinkedInPostOutput): LinkedInPostOutput | undefined => {
        const next: LinkedInPostOutput = {
          ...post,
          text: stripRelativeDays(post.text),
          headline: stripRelativeDays(post.headline),
          hook: stripRelativeDays(post.hook),
          body: stripRelativeDays(post.body),
          takeaway: stripRelativeDays(post.takeaway),
          callToAction: stripRelativeDays(post.callToAction),
        };
        if (linkedInProse(next).every((field, i) => field === linkedInProse(post)[i])) return undefined;
        // Never hand back an empty post: a field that was nothing but the
        // phrase is left as the caller wrote it rather than blanked.
        if (next.text.trim().length === 0) return undefined;
        return next;
      };

      /** The four span-flagging gates, run together — they share an evidence shape and a repair. */
      const inspectSpans = async (post: LinkedInPostOutput): Promise<GateVerdict> => {
        const verdicts = await Promise.all([
          runGate(tools, "gate.numbersSourced", { text: post.text, sources }, ctx),
          runGate(
            tools,
            "gate.brandCompliance",
            { text: post.text, forbiddenTerms, ...(requiredDisclaimer !== undefined ? { requiredDisclaimer } : {}) },
            ctx,
          ),
          runGate(tools, "gate.noPlaceholder", { text: post.text }, ctx),
          runGate(tools, "gate.leakCheck", { text: post.text }, ctx),
        ]);
        const broken = verdicts.find((v) => v.verdict === "tooling_error");
        if (broken !== undefined && broken.verdict === "tooling_error") {
          throw new WorkflowToolingFailure(`linkedin content gate: ${broken.reason}`);
        }
        const failures = verdicts.filter((v) => v.verdict === "content_fail");
        if (failures.length === 0) return localPass("linkedin-content-gates");
        return localContentFail(
          "linkedin-content-gates",
          failures.map((v) => (v.verdict === "content_fail" ? v.reason : "")).join("; "),
          failures.flatMap((v) => v.evidence),
        );
      };

      const previewOf = async (post: LinkedInPostOutput): Promise<RenderPreviewResult> => {
        const outcome = await tools["render.preview"]!.execute({ text: post.text }, { ctx });
        if (outcome.status !== "success") throw new WorkflowToolingFailure(`render.preview failed: ${outcome.status}`);
        return outcome.result as RenderPreviewResult;
      };

      // Each check keeps its own step id and records its verdict against the
      // draft AS FIRST WRITTEN, which is what a trace wants to show.
      const numbersVerdict = await wf.step.code(rev("10-verify-numbers-sourced"), () =>
        runGate(tools, "gate.numbersSourced", { text: draft.text, sources }, ctx),
      );
      const brandVerdict = await wf.step.code(rev("11-verify-brand-compliance"), () =>
        runGate(
          tools,
          "gate.brandCompliance",
          { text: draft.text, forbiddenTerms, ...(requiredDisclaimer !== undefined ? { requiredDisclaimer } : {}) },
          ctx,
        ),
      );
      const previewInspection = await wf.step.code(rev("12-render-preview-check"), async () => {
        const preview = await previewOf(draft);
        return { withinLimit: preview.withinLimit, characterCount: preview.characterCount };
      });
      // ── D22: the link goes in the first comment, and the body carries none ──
      //
      // Craft 02 §11 files this under HARD, and unlike x-agent's equivalent it
      // has NO exception: X's craft page carves out "the link IS the news",
      // LinkedIn's does not. A body link costs -18.8% median reach (vdB 2026)
      // to -26.5% average (Ordinal, 900K+ posts), and it cannot be fixed after
      // delivery — adding a link by editing the post costs a further -42% of
      // impressions (ConnectSafely), so the only place to catch it is here.
      //
      // Checked whether or not `firstCommentUrl` is set: a bare URL in the body
      // is wrong even when the model forgot to name where the link belongs.
      const linkInspection = await wf.step.code(rev("12b-verify-link-placement"), () => {
        const inBody = BARE_URL_PATTERN.exec(draft.text);
        return { bodyUrl: inBody ? inBody[0] : null, firstCommentUrl: draft.firstCommentUrl ?? null };
      });
      const placeholderVerdict = await wf.step.code(rev("13-verify-no-placeholder"), () =>
        runGate(tools, "gate.noPlaceholder", { text: draft.text }, ctx),
      );
      const leakVerdict = await wf.step.code(rev("14-verify-no-leak"), () => runGate(tools, "gate.leakCheck", { text: draft.text }, ctx));

      /** Everything the span gates objected to, unwrapped from each gate's own evidence shape. */
      const flaggedSpans = [numbersVerdict, brandVerdict, placeholderVerdict, leakVerdict].flatMap((verdict) => {
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`linkedin content gate: ${verdict.reason}`);
        // `spansFromEvidence`, not `.evidence`: gate.leakCheck reports
        // `local file path: "..."`, which the redactor cannot match as-is.
        return verdict.verdict === "content_fail" ? spansFromEvidence(verdict.evidence) : [];
      });

      /**
       * 14r — the repair step.
       *
       * Runs only when something above objected, so a clean post costs nothing
       * extra. ONE model redraft told every problem at once, kept only if
       * strictly cleaner, then deterministic floors that cannot fail to
       * converge.
       */
      const repaired = await wf.step.code(
        rev("14r-repair-post"),
        async (): Promise<{ post: LinkedInPostOutput; repairs: ContentRepair[] }> => {
          const overLimit = previewInspection.withinLimit
            ? null
            : `post exceeds the LinkedIn character limit (${previewInspection.characterCount} chars)`;
          const bodyUrl = linkInspection.bodyUrl;
          // A draft is written now and published later — a post drafted Friday
          // and approved Monday cannot say "yesterday" (linkedin-craft@8 §12a).
          const datedProblems = datedProblemsIn(draft);
          if (flaggedSpans.length === 0 && overLimit === null && bodyUrl === null && datedProblems.length === 0) {
            return { post: draft, repairs: [] };
          }

          const repairs: ContentRepair[] = [];
          let post = draft;

          // ── one model redraft, told everything that is wrong ──
          const asked = [
            ...(flaggedSpans.length > 0
              ? [
                  `These exact spans were rejected and must not appear anywhere in the post: ${flaggedSpans.join(", ")}.`,
                  "For a figure: restate it exactly as a source writes it, or make the point qualitatively with no number.",
                  "For a banned phrase or an unresolved placeholder: rewrite the sentence without it.",
                  "For anything resembling a credential, an internal path or an internal-only term: remove it.",
                ]
              : []),
            ...(overLimit !== null ? [`The post was also rejected for length: ${overLimit}. Cut it to fit without losing the point.`] : []),
            ...(bodyUrl !== null
              ? [`The body contains a link (${bodyUrl}). On LinkedIn the link goes in firstCommentUrl, never in the body — move it there and write the body without it.`]
              : []),
            ...(datedProblems.length > 0 ? [`The post was also rejected on dated language: ${datedProblems.join("; ")}.`] : []),
            "Keep everything else exactly as it is.",
          ].join(" ");

          const redraft = await draftAgent.run(ctx, { ...draftInputForRepair, revisionRequest: asked });
          if (redraft.status === "completed" && redraft.finalOutput) {
            const candidate: LinkedInPostOutput = { ...redraft.finalOutput, text: reflowLinkedInText(redraft.finalOutput.text) };
            const candidateSpans = await inspectSpans(candidate);
            const candidatePreview = await previewOf(candidate);
            const before = flaggedSpans.length + (overLimit === null ? 0 : 1) + (bodyUrl === null ? 0 : 1) + datedProblems.length;
            const after =
              (candidateSpans.verdict === "content_fail" ? spansFromEvidence(candidateSpans.evidence).length : 0) +
              (candidatePreview.withinLimit ? 0 : 1) +
              (BARE_URL_PATTERN.exec(candidate.text) ? 1 : 0) +
              datedProblemsIn(candidate).length;
            if (after < before) {
              post = candidate;
              repairs.push({
                check: "linkedin-content-gates",
                action: "rewritten",
                detail: `redrafted to clear ${before - after} of ${before} flagged problem(s)`,
              });
            }
          }

          // ── floor 1: spans ──
          const spanOutcome = await runCheckWithRepair({
            check: "linkedin-content-gates",
            value: post,
            verify: inspectSpans,
            attempts: [
              // A MISSING required disclaimer is the one brand failure fixed by
              // ADDING rather than removing — and it is fixable exactly, because
              // the client configured the sentence verbatim. Tried first:
              // appending it is a smaller, truer edit than deleting a sentence,
              // and redaction cannot reach it at all. No legal copy is invented.
              {
                action: "rewritten",
                run: (value) => {
                  if (requiredDisclaimer === undefined || value.text.includes(requiredDisclaimer)) return undefined;
                  return { ...value, text: `${value.text}\n\n${requiredDisclaimer}` };
                },
              },
              { action: "redacted", maxPasses: 3, run: (value, verdict) => redactAcrossDraft(value, spansFromEvidence(verdict.evidence)) },
            ],
            // The gate's OWN reason, not a "could not be removed" gloss: not
            // every content failure is something to delete, and the
            // delete-framing read as nonsense for a missing disclaimer on the
            // ledger a reviewer actually sees.
            describeUnresolved: (verdict) => `${verdict.reason} — delivered with this noted rather than withheld`,
          });
          post = spanOutcome.value;
          repairs.push(...spanOutcome.repairs);

          // ── floor 2: the link goes where it belongs ──
          //
          // Mechanically fixable and worth fixing rather than flagging: the URL
          // is lifted out of the body verbatim and put in `firstCommentUrl`,
          // which is exactly what the rule asks for. An existing
          // `firstCommentUrl` is not overwritten — the model already chose a
          // link for the comment, and replacing it would be a second edit
          // nobody asked for.
          const linkOutcome = await runCheckWithRepair({
            check: "linkedin-link-placement",
            value: post,
            verify: (value) => {
              const found = BARE_URL_PATTERN.exec(value.text);
              return Promise.resolve(
                found
                  ? localContentFail("linkedin-link-placement", `the post body contains a link (${found[0]})`, [found[0]])
                  : localPass("linkedin-link-placement"),
              );
            },
            attempts: [
              {
                action: "moved",
                maxPasses: 3,
                run: (value, verdict) => {
                  const url = verdict.evidence[0];
                  if (url === undefined) return undefined;
                  const text = value.text.split(url).join("").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim();
                  if (text.length === 0) return undefined;
                  return {
                    ...value,
                    text,
                    body: value.body.split(url).join("").replace(/[ \t]{2,}/g, " ").trim() || value.body,
                    firstCommentUrl: value.firstCommentUrl ?? url,
                  };
                },
              },
            ],
            describeUnresolved: (verdict) => `${verdict.reason} — delivered with this noted rather than withheld`,
          });
          post = linkOutcome.value;
          repairs.push(...linkOutcome.repairs);

          // ── floor 3: dated language ──
          //
          // Deletion, never substitution. Nothing here knows what date the
          // writer meant, and inventing one is the failure the rule exists to
          // prevent: "closed its Series D yesterday" becomes "closed its
          // Series D" — less specific, never false. Run BEFORE the length
          // floor, since it can only shorten the post.
          const datedOutcome = await runCheckWithRepair({
            check: "linkedin-dated-language",
            value: post,
            verify: (value) => {
              const problems = datedProblemsIn(value);
              return Promise.resolve(
                problems.length === 0
                  ? localPass("linkedin-dated-language")
                  : localContentFail("linkedin-dated-language", problems.join("; "), problems),
              );
            },
            attempts: [{ action: "redacted", run: (value) => stripDatedAcrossDraft(value) }],
            describeUnresolved: (verdict) => `${verdict.reason} — delivered with this noted rather than withheld`,
          });
          post = datedOutcome.value;
          repairs.push(...datedOutcome.repairs);

          // ── floor 3: the character limit ──
          //
          // A social post, unlike a long-form article, IS safely truncatable at
          // a sentence boundary: the last sentence is the one that overflows,
          // and losing it beats losing the post.
          const lengthOutcome = await runCheckWithRepair({
            check: "linkedin-length",
            value: post,
            verify: async (value) => {
              const preview = await previewOf(value);
              return preview.withinLimit
                ? localPass("linkedin-length")
                : localContentFail("linkedin-length", `post exceeds the LinkedIn character limit (${preview.characterCount} chars)`, [
                    `${preview.characterCount}`,
                  ]);
            },
            attempts: [
              {
                action: "trimmed",
                run: (value) => {
                  // Drops as many TRAILING sentences as the overrun needs, in one
                  // pass. Shedding one sentence at a time runs out of passes on a
                  // post far over the limit, and a trim that stops short delivers
                  // an unpublishable post while reporting that it trimmed it.
                  const parts = value.text.split(/(?<=[.!?])\s+/);
                  if (parts.length <= 1) return undefined;
                  let kept = parts.length;
                  while (kept > 1 && parts.slice(0, kept).join(" ").trim().length > LINKEDIN_CHARACTER_LIMIT) kept -= 1;
                  const text = parts.slice(0, kept).join(" ").trim();
                  return text.length === 0 || text.length >= value.text.length ? undefined : { ...value, text };
                },
              },
            ],
            describeUnresolved: (verdict) => `${verdict.reason} — delivered with this noted rather than withheld`,
          });
          post = lengthOutcome.value;
          repairs.push(...lengthOutcome.repairs);

          return { post, repairs };
        },
      );
      draft = repaired.post;
      // Outside the step body: a checkpointed step is replayed from its stored
      // value on resume and its body never runs again.
      repairsByRevision.set(revision, repaired.repairs);

      // ── 14b: the post's media — attached first, then the draft's own brief ──
      //
      // After every text gate, so a held draft never pays for a screenshot or
      // a generation; inside the revision loop, because a revised post may want
      // a different picture. Never holds.
      const mediaPlan = await resolveSocialMedia(wf, tools, ctx, {
        stepId: rev("14b-resolve-media"),
        repoRoot: options.repoRoot,
        platform: "linkedin",
        brief: draft.mediaBrief,
        attached: attachedMedia,
        sources: researchSources,
        postText: draft.text,
        art: artDirectionFromBrand(clientContext.brand),
        // "Only media I upload": an attached picture still wins above; with
        // none, the post ships as text and no tier is asked (2026-09-06).
        clientMediaOnly: runDirection.mediaSource === "client",
      });

      // ── terminal topic guardrail ──
      //
      // Before the human gate: a reviewer should never be shown a draft that
      // engages a subject this client said it does not touch. Not a repeat of
      // gate.brandCompliance -- that matches forbiddenTerms as substrings and
      // catches the word, while this judges the subject. Free for a client who
      // forbids nothing: no list, no step, no model call.
      await runTopicGuardrail(wf, { tools, promptStore: options.promptStore, router: options.router }, draft.text, intake.forbiddenTopics, revision === 0 ? undefined : `-r${revision}`);

      return { ...draft, mediaPlan, formatting };
    };

    // ── 15: the universal approve / revise / reject cycle ──
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
        payload: {
          runId: wf.runId,
          topic: selected.topic,
          archetype: draft.archetype,
          contentMode: modeSelection.mode,
          preview: draft.text,
          takeaway: draft.takeaway,
          ...(draft.formatting.notes.length > 0 ? { formattingNotes: draft.formatting.notes } : {}),
          ...mediaForDeliverable(draft.mediaPlan),
          ...(selected.trend !== undefined ? { trend: { whyNow: selected.trend.whyNow, brandFitReason: selected.trend.brandFitReason, sourceUrls: selected.trend.sourceUrls } } : {}),
          revision,
        },
        requiredRole: "account_manager",
        timeout: { duration: "1h", onTimeout: "auto_approve" },
      }),
      onDecision: async ({ revision, response, output }) => {
        // SCRUM-306 (AU23): a reject's drafted content previously had nowhere
        // durable to go — it lived only in this round's step checkpoints and
        // was lost the moment the run held. Attached only on reject: an
        // approval's content already has a durable copy via
        // `ledger.writeDeliverable`, and a revise round's draft is superseded
        // by the next attempt.
        await persistReviewFeedbackToMemory(
          wf,
          tools,
          ctx,
          revision,
          response,
          response.decision === "reject" ? JSON.stringify(output) : undefined,
        );
      },
    });
    const { mediaPlan, formatting, ...draft } = review.output;
    /**
     * The repairs made to the round that was APPROVED — not the last round
     * attempted, which on an approve-after-revise run is the same thing only by
     * luck. Omitted from the deliverable when empty, so a clean run produces
     * the bytes it always did.
     */
    const contentRepairs = repairsByRevision.get(review.revision) ?? [];
    // A reviewer who ran out of rounds, or who rejected outright, is recorded
    // ON the deliverable rather than ending the run: the work survives for
    // them to act on, and the marker is what makes their decision unmissable.
    // Nothing here publishes anything — every deliverable still waits on a
    // human — so this changes what a reviewer KEEPS, not what ships.
    // A topic someone asked for and did not get is something they must find
    // out about, so it rides on the deliverable like every other adaptation.
    if (selected.refusedRequest !== undefined) {
      contentRepairs.push({ check: "never-topic", action: "substituted", detail: selected.refusedRequest });
    }
    if (review.outcome !== undefined && review.outcome !== "approved") {
      contentRepairs.push({
        check: "human-review",
        action: "unresolved",
        detail: review.outcomeDetail ?? review.outcome,
      });
    }

    // ── 16-17: deliverable & manifest persistence ──
    // Additive: `draftsMarkdown` is the "# LinkedIn drafts"-shaped string
    // karosCMO's `li-drafts.ts` parser needs on `asset.content` — the rest
    // of `draft` stays untouched for any consumer that wants raw fields. The
    // media block rides beside it.
    const profileCompanyName = clientContext.profile["companyName"];
    // D11 / C3 (SCRUM-457): resolved once, used for both the client's card and
    // the state record below. `targetAudience` is the older, broader line the
    // prompt has always produced, so it stands in when the model named no
    // buyer problem of its own.
    const goalLine = resolveGoalLine(draft, { stage, audience: draft.targetAudience, whyNow: whyNowFor(selected) });
    const draftsMarkdown = renderLinkedInDraftsMarkdown({
      identity: clientContext.identity,
      ...(typeof profileCompanyName === "string" ? { companyName: profileCompanyName } : {}),
      archetype: draft.archetype,
      topic: selected.topic,
      draft,
      goalLine,
      media: mediaPlan,
    });
    const deliverableId = await finalizeDeliverable(wf, tools, ctx, {
      persistDeliverableStepId: "16-persist-deliverable",
      persistManifestStepId: "17-persist-manifest",
      kind: "linkedin-post",
      deliverable: {
        ...draft,
        ...mediaForDeliverable(mediaPlan),
        contentMode: modeSelection.mode,
        // Present only when something had to be repaired to get here, so a
        // reviewer sees what changed instead of a silently edited post.
        ...(contentRepairs.length > 0 ? { contentRepairs } : {}),
        // C3 (SCRUM-457): `formattingNotes` are the shape check's notes FOR THE
        // REVIEWER (step 09b), and karosCMO's `materialize.ts` renders every
        // name in its `metaFields` list onto the client's asset — so shipping
        // them here put "the takeaway is missing a blank line before it" on a
        // client's screen. They stay on the gate payload, where the reviewer
        // reads them, and on the run report. Client copy never mentions review.
        ...(selected.trend !== undefined ? { trend: selected.trend } : {}),
        draftsMarkdown,
      },
      snapshot: (deliverableId) => ({
        topic: selected.topic,
        source: selected.source,
        archetype: draft.archetype,
        contentMode: modeSelection.mode,
        mediaStatus: mediaPlan.status,
        deliverableId,
      }),
    });

    // ── 18: commit updates (topics.commit, memory.appendDecision) — the review
    // decision itself is already durable: `onDecision` above called
    // `persistReviewFeedbackToMemory` for every round, which is the one real
    // feedback pipeline (AU22: this step used to also call the now-retired
    // `ledger.feedbackAppend`, a write-only log nothing ever read). ──
    await wf.step.code("18-commit-and-record", async () => {
      // A topic is only CONSUMED by a post a reviewer approved. Before this PR
      // a reject threw before ever reaching here; now it returns, so the guard
      // has to be explicit or a rejected post would burn the topic it was
      // written from and no future run could use it.
      if (selected.source === "reserved" && reservation.reservationKey) {
        if (review.outcome !== undefined && review.outcome !== "approved") {
          await tools["topics.release"]?.execute({ reservationKey: reservation.reservationKey }, { ctx }).catch(() => undefined);
        } else {
          await tools["topics.commit"]!.execute({ reservationKey: reservation.reservationKey }, { ctx });
        }
      }
      // The write half of the anti-repetition loop: the shipped post joins
      // this agent's rolling excerpt window, read back by research.pull's
      // history feed and the drafting directive on every future run.
      // Best-effort: losing an excerpt costs future dedup signal, never the
      // delivered post.
      await recordOutputExcerpt(tools, ctx, wf.runId, "linkedin-agent", draft.text);
      await tools["memory.appendDecision"]!.execute(
        {
          decisionId: `${wf.runId}__decision`,
          // `(archetype: …)` feeds the never-repeat rule and `(mode: …)` the
          // content-mode rotation on every future run.
          summary: `Posted about "${selected.topic}" (archetype: ${draft.archetype}, mode: ${modeSelection.mode})`,
        },
        { ctx },
      );
    });

    // ── 19: the learning loop's write side (C7 §3, A2) ──
    //
    // One normalised record the middleware collects into the subject table
    // and the platform state, plus the D11 goal line. LinkedIn's `type` is
    // the archetype (its own post-type vocabulary); `targetAudience` is the
    // prompt's existing audience line, so the record carries one whether or
    // not the model filled the new `audience` field. Never fails the run.
    await writeRunState(wf, tools, ctx, "19-write-run-state", {
      platform: "linkedin",
      deliverable: {
        kind: "linkedin-post",
        goal: goalLine.goal,
        ...(goalLine.audience !== undefined ? { audience: goalLine.audience } : {}),
        whyNow: goalLine.whyNow,
        type: draft.archetype,
        sources: (researchDigest ?? []).map((d) => d.url).filter((u): u is string => typeof u === "string"),
      },
      subjectRow: {
        subject: selected.topic,
        angle: draft.takeaway,
        type: draft.archetype,
        stage: goalLine.goal,
        goal: goalLine.goalText,
        status: "drafted",
        assetKind: "linkedin-post",
        strategyRowId: selected.strategyRowId ?? null,
      },
      platformStateDelta: {
        postsByUs: 1,
        topics: [selected.topic],
        voiceNotes: [],
        account: clientContext.identity.scope === "executive" ? { handle: clientContext.identity.executiveName } : { handle: typeof clientContext.profile["companyName"] === "string" ? (clientContext.profile["companyName"] as string) : "company" },
      },
      voiceNotes: review.notes.map((n) => ({ lesson: n.feedback, fromRevision: n.revision })),
      rulesApplied: draft.rulesApplied,
      readiness: learning.readiness,
    });

    return {
      topic: selected.topic,
      archetype: draft.archetype,
      contentMode: modeSelection.mode,
      targetAudience: draft.targetAudience,
      takeaway: draft.takeaway,
      deliverableId,
      mediaStatus: mediaPlan.status,
      formattingNotes: formatting.notes,
      channelSetup: channelSetup.status,
      preview: draft.text,
    };
  };
}
