import { readForbiddenTopics, type AgentContext, type AgentToolRegistry, type GateResponse, type ModelRouter, type PromptStore } from "@agent-engine/core";
import { weightedLengthForX } from "@agent-engine/tool-karos-gates";
import {
  type WorkflowContext,
  type RevisionNote,
  WorkflowBlockedIntake,
  WorkflowHeld,
  WorkflowToolingFailure,
  MAX_REVISION_ROUNDS,
  persistReviewFeedbackToMemory,
  readPastFeedback,
  revisionDirective,
  runReviewCycle,
  runTopicGuardrail,
  extractResearchCandidate,
  researchDigestForDrafting,
  researchSourceTexts,
  readRunDirection,
  recordedSubject,
  runDirectionField,
  buildClientVoiceContext,
  readCrossChannelHistory,
  crossChannelDirective,
  crossChannelAvoidTopics,
  socialAccountsFromClient,
  checkOutputDedupe,
  dedupeRetryDirective,
  describeAgentExhaustion,
  commitDirectiveAfterExhaustion,
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
  redactSentencesCarrying,
  relativeDayProblems,
  stripRelativeDays,
  localContentFail,
  localPass,
  spansFromEvidence,
  type ContentRepair,
  textGateTimeout,
} from "@agent-engine/workflow";
import type { GateVerdict } from "@agent-engine/core";
import { MAX_THREAD_PARTS, XDraftAgent, type Lane, type XPostOutput } from "../agent/x-draft-agent.js";
import { renderPreview, X_CHARACTER_LIMIT, type RenderPreviewResult } from "../tools/render-preview.js";
import { renderXDraftsMarkdown } from "./render-drafts-markdown.js";
import { readEngagementTarget, UNVERIFIED_TARGET_NOTE } from "./engagement-target.js";
import { whyNowFor } from "./learning.js";
import { countRecentEngagementPosts, ENGAGEMENT_DAILY_CAP, LANES_FOR_MODE, selectLane } from "./lane.js";
import type {
  XAgentWorkflowResult,
  XCandidateSummary,
  XClientContext,
  XContentModeSelection,
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
  /**
   * Bounds root for the media cache (2026-09). Every sourced or attached image
   * lands under `<repoRoot>/.media-cache/<runId>/`, the same directory every
   * other media tool uses. Optional: without it the post ships as text and the
   * media step records why. `apps/agent-server` passes the same root it
   * passes instagram-agent.
   */
  repoRoot?: string | undefined;
}

/** A bare `http(s)://` link — the mechanical half of "post clean, link in first reply" (x-craft.md §5). */
const BARE_URL_PATTERN = /https?:\/\//i;

/**
 * How many drafting passes the verified de-duplication check may cost —
 * initial draft plus two redraft steers, the same budget instagram-agent's
 * `MAX_SELF_CHECK_ATTEMPTS` gives its own 07d dedupe check. On the last
 * attempt a `similar` draft ships FLAGGED (the verdict stays checkpointed for
 * the trace and the reviewer), never held: `evaluateDedupe`'s own policy is
 * that de-duplication flags and steers, it does not hold a run.
 */
const MAX_DEDUPE_ATTEMPTS = 3;

/**
 * What the main post says when every one of its sentences carried a span a
 * content gate rejected.
 *
 * Reachable only on a post short enough that one sentence was the whole thing.
 * It exists because the alternative at that point is falling back to the
 * unredacted text — which republishes the very span the gate refused — and
 * because `text` is `min(1)` in the schema. A thread PART in this state is
 * dropped instead, since X will not publish an empty post.
 */
const POST_WITHHELD = "(withheld: this post rested on content that failed verification)";

/**
 * Names every post in a draft that is over X's limit, as the steer for one
 * in-loop redraft, or `undefined` when the whole draft fits.
 *
 * X's OWN counting — 23 per URL, 2 per emoji — which is what `render.preview`
 * (steps 13b and 14) and `gate.lintPost` both now count, so a draft this
 * passes cannot then be held there for length. It used to be plain
 * `String.length` in all three places, which agreed with itself and disagreed
 * with X: a 275-character post carrying two links measured 275 here and 319
 * on the platform.
 */
export function describeLengthOverrun(draft: Pick<XPostOutput, "text" | "thread">): string | undefined {
  const over: string[] = [];
  const lengthOf = (text: string): number => weightedLengthForX(text);
  if (lengthOf(draft.text) > X_CHARACTER_LIMIT) over.push(`part 1 (text) is ${lengthOf(draft.text)} characters`);
  draft.thread.forEach((part, index) => {
    if (lengthOf(part) > X_CHARACTER_LIMIT) over.push(`thread part ${index + 2} is ${lengthOf(part)} characters`);
  });
  if (over.length === 0) return undefined;
  return (
    `Your previous draft was over X's ${X_CHARACTER_LIMIT}-character limit: ${over.join("; ")}. ` +
    `Every post, part 1 and each thread part, must be at most ${X_CHARACTER_LIMIT} characters; aim under 260. ` +
    "Shorten only the over-limit part(s), keep the sourced specifics and everything else as it was, and return the complete draft again."
  );
}

/** The draft plus the media the run resolved for it — what the review gate shows and the deliverable persists. */
type XDraftWithMedia = XPostOutput & { mediaPlan: SocialMediaPlan };

/** Every part of the deliverable as one string, for the gates that judge the whole post (brand, leak, placeholder, topic). */
function fullText(draft: XPostOutput): string {
  return [draft.text, ...draft.thread].join("\n\n");
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

/**
 * `createXAgentWorkflow()` (RFC-02 §3): the recurring/on-demand run
 * protocol, steps `00`–`20`. One post, one run (RFC-01 §16.2's ruling) — no
 * fan-out here, unlike the LinkedIn pilot; every X run produces at most one
 * deliverable (a thread is one deliverable with parts). Step 15 is a
 * mandatory human `batch_review` gate (RFC-01 §8.3) — nothing persists until
 * a real human approves, unless `options.autoApprove` explicitly opts out
 * (tests/demos only).
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
 * ## The 2026-09 elite-tier upgrade, in the order a run meets it
 *
 * - **04**: research is several questions, not one — the industry's news,
 *   its launches/deals/reports, the client's own name, and the client's
 *   configured `trendQueries` — merged and de-duplicated.
 * - **07a**: when nobody requested a topic and the catalog has none, a
 *   trend SCOUT (Gemini Flash) turns the research into brand-fit-scored
 *   candidates tagged by content mode; the strongest on-brand one takes the
 *   slot. Below `MIN_BRAND_FIT` nothing is forced.
 * - **07b**: the content-mode rotation — hot news / deep value / open
 *   discussion — never the same mode twice in a row, steering the lane.
 * - **09b**: media the client ATTACHED is ingested and read by a vision
 *   model BEFORE drafting, so the post is written to the picture.
 * - **10**: the draft receives the research itself (every source's title,
 *   url, date, excerpt), the trend candidate, the mode and the attached
 *   media — until now it received a headline.
 * - **11**: the numbers gate verifies against source TEXT, the intel context
 *   and the run's topic, not a URL.
 * - **13b**: a thread (parts 2..N) is checked part by part.
 * - **14e**: the media resolver answers the draft's own `mediaBrief`:
 *   screenshot of the cited page, the article's lead image, stock, and only
 *   then generation — never by default, and every candidate vision-judged.
 */
export function createXAgentWorkflow(options: CreateXAgentWorkflowOptions) {
  const tools: AgentToolRegistry = { ...options.tools, "render.preview": renderPreview };

  return async function xAgentWorkflow(wf: WorkflowContext): Promise<XAgentWorkflowResult> {
    const ctx = toAgentContext(wf);

    // The run-scoped instruction someone typed in the portal, resolved once.
    // A typed sentence outranks the topic catalog for the same reason an
    // explicit requestedTopic does: a person who wrote it has more
    // information about this run than a catalog row does. Style-only notes
    // are deliberately NOT promoted to topics -- see readRunDirection.
    const runDirection = readRunDirection(wf.input);

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
      // This run's own request wins over the client's standing configuration.
      // `lanes.md`'s rule is "the customer's run request wins", and until the
      // engine could carry a per-run input the only way to express one was to
      // write it into client config -- which every other run for that client
      // would then pick up too.
      //
      // Only run-scoped keys are overlaid. xHandle and xStrategyKey are client
      // identity, not a per-run choice, and letting a job payload rewrite which
      // account a post is drafted for would be a tenancy hole.
      const runScoped: Record<string, unknown> = {};
      for (const key of ["requestedTopic", "requestedLane", "requestedMode"] as const) {
        const value = wf.input[key];
        if (typeof value === "string" && value.trim().length > 0) runScoped[key] = value.trim();
      }
      const trendQueries = readStringList(config, "trendQueries");
      // forbiddenTopics comes out of the SAME read, so the terminal guardrail
      // below needs no second one.
      return {
        ...config,
        ...runScoped,
        forbiddenTopics: readForbiddenTopics(config),
        ...(trendQueries ? { trendQueries } : {}),
        allowThreads: config["xAllowThreads"] !== false,
        trendJacking: config["trendJacking"] === "always" ? "always" : "fallback",
      } as XIntakeConfig;
    });

    // ── 01-03: context & shelf assembly (client.*, memory.read) ──
    const clientContext = await wf.step.code("01-load-client-context", async (): Promise<XClientContext> => {
      const profile = await tools["client.getProfile"]!.execute({}, { ctx });
      const brand = await tools["client.getBrand"]!.execute({}, { ctx });
      const voiceRules = await tools["client.getVoiceRules"]!.execute({}, { ctx });

      // The account's own setup document. A brand page and a founder's seat
      // share a voice and have opposite charters, so the intake is per account
      // and must never be blended — which is why the document is named by
      // `xStrategyKey` in the client's config rather than guessed from the
      // handle. Falls back to the account-level document.
      //
      // `client.getStrategy` may be absent from a caller's registry entirely
      // (the tool is new); that is the same as having no document, not a
      // crash.
      const getStrategy = tools["client.getStrategy"];
      let strategy: string | null = null;
      if (getStrategy) {
        const attempts = intake.xStrategyKey
          ? [{ agent: "x-agent", key: intake.xStrategyKey }, { agent: "x-agent" }]
          : [{ agent: "x-agent" }];
        for (const args of attempts) {
          const outcome = await getStrategy.execute(args, { ctx });
          if (outcome.status === "success") {
            strategy = (outcome.result as { markdown: string }).markdown;
            break;
          }
        }
      }

      return {
        profile: profile.status === "success" ? (profile.result as Record<string, unknown>) : {},
        brand: brand.status === "success" ? (brand.result as Record<string, unknown>) : {},
        voiceRules: voiceRules.status === "success" ? (voiceRules.result as XClientContext["voiceRules"]) : {},
        strategy,
      };
    });

    // ── 01b: what the PLATFORM has learned about this client on X (C7, A1) ──
    //
    // Seven optional files the middleware projects before dispatch: platform
    // state, the subject window, the client's review actions, derived
    // preferences, what works, the strategy map, the craft rules. Until
    // 2026-09-16 none of it reached a run: the portal built context files on
    // every submit and attached them to a service that had been deleted
    // (02 Learning Loop §5, step 5). Best-effort and checkpointed — a run on
    // a client with nothing projected yet drafts exactly as before, and the
    // step record says which files it found.
    const learning = await readLearningContext(wf, tools, ctx, "x", "01b-read-learning-context");
    // The stage this run writes for: the calendar slot's, else D32's default
    // mix walked against what the subject window already holds.
    const stage = stageForRun(runDirection.slotStage, learning.subjectWindow);

    const beliefs = await wf.step.code("02-load-memory-shelf", async () => {
      const outcome = await tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
      return outcome.status === "success" ? outcome.result : { scope: "beliefs", beliefs: {} };
    });

    // Full decision rows (not just summaries) — the lane rotation, the
    // engagement daily cap and the content-mode rotation all need `at`
    // timestamps, not just insertion order.
    const recentDecisions = await wf.step.code("03-load-recent-decisions", async (): Promise<XRecentDecision[]> => {
      const outcome = await tools["memory.read"]!.execute({ scope: "decisions" }, { ctx });
      if (outcome.status !== "success") return [];
      const result = outcome.result as { scope: string; items: XRecentDecision[] };
      return result.items;
    });

    // ── 04-05: research pull (persisting verbatim raw payloads inside research.pull itself) ──
    //
    // Several questions, one step. `${industry} trends this week` alone gave
    // the scout nothing to scout: it returned the week's top-ranked generic
    // pieces and no launch, deal or report that had actually happened. The
    // queries now ask what a strategist would ask, and the client can add
    // their own standing ones (`trendQueries`).
    const industry = (clientContext.profile["industry"] as string | undefined) ?? undefined;
    const companyName = (clientContext.profile["companyName"] as string | undefined) ?? (clientContext.profile["name"] as string | undefined);
    const queries = buildTrendQueries({
      industry,
      companyName,
      configuredQueries: intake.trendQueries,
      requestedTopic: runDirection.topicOverride ?? intake.requestedTopic,
    });
    const research: TrendResearch = await pullTrendResearch(wf, tools, ctx, {
      stepId: "04-research-pull",
      job: "x-news-scan",
      // A client with no industry, no name and no request still gets the one
      // query the step always ran, so the trace is never a silent no-op.
      queries: queries.length > 0 ? queries : [`${industry ?? "this industry"} trends this week`],
      window: "24h",
      // Anti-repetition context: this agent's own prior posts, so the
      // extraction below can steer off a subject already covered.
      historyAgentId: "x-agent",
    });

    const candidateSummary = await wf.step.code("05-extract-candidate-summary", (): XCandidateSummary =>
      // Shared with every other publishing agent (`extractResearchCandidate`).
      // Kept as the last-resort fallback behind the scout: a run whose scout
      // step did not complete still gets the same honest candidate it always
      // did, never a fabricated one.
      extractResearchCandidate(research.merged, { avoidTopics: recentDecisions.map((d) => d.summary) }),
    );

    // ── 06-09: candidate selection, mode, lane selection and the engagement cap ──
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
      // step 07's precedence falls through to the scout, then the research-derived candidate.
      return { topics: [] };
    });

    // ── 04e: what this client asked for on PREVIOUS runs ──
    //
    // The read side of the feedback flywheel. Without it every run starts from
    // zero and the same correction gets made every week. Bounded and
    // best-effort: it lands in a drafting prompt, and a memory read failing
    // must not stop a run that can draft perfectly well without it.
    const pastFeedback = await readPastFeedback(wf, tools, ctx, "04e-read-past-feedback");
    // The anti-repetition read — CROSS-CHANNEL (2026-09): what this client
    // already published on EVERY channel we draft for (each agent's excerpt
    // ledger) and on their own accounts (`research.socialHistory`, read from
    // the handles in their config). A launch LinkedIn covered on Tuesday is
    // covered; this run must not tell it again on X. Distinct from
    // pastFeedback (what a person SAID about past drafts) the same way
    // decisions are distinct from feedback. Read before the scout, which must
    // not propose what the client just published anywhere.
    const crossChannel = await readCrossChannelHistory(wf, tools, ctx, {
      stepId: "read-cross-channel-history",
      socialAccounts: socialAccountsFromClient(intake as Record<string, unknown>, clientContext.brand),
    });
    const outputHistory = crossChannel.entries;
    const recentPostsDirective = crossChannelDirective(crossChannel);
    // The client intel report AND knowledge base, distilled to what steers
    // copy (voice rows, positioning, whitespace, meeting notes) — the client
    // knowledge this platform holds, read by the scout and the draft alike.
    const clientIntelContext = await readClientIntelContext(wf, tools, ctx, "read-intel-context");

    // ── 01c: the strategy map — handed to the run, or built by it (C1, SCRUM-464) ──
    //
    // A client nobody has planned for reaches here with no map. This is the
    // first moment a run holds the profile, the charter and the knowledge
    // together, so it builds the map now (one model call, checkpointed),
    // writes it to `state/x/strategy-map.json` for the middleware to collect,
    // and selects from it below. The next run finds it and pays nothing.
    const strategy = await ensureStrategyMap(wf, { tools, promptStore: options.promptStore, router: options.router }, ctx, {
      platform: "x",
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
    // row is a planned editorial slot with a dedup lock. Both outrank a
    // trend by default (`trendJacking: "fallback"`), so the scout — one
    // Gemini Flash call — runs exactly where the old code fell back to
    // "first headline with a number in it": an empty catalog and no request.
    // `trendJacking: "always"` lets a fresh, high-fit story compete with the
    // catalog for clients whose whole point is being first.
    // 2026-09-24: the strategy map now leads the plan (see `07-select-candidate`),
    // so a usable map row is "someone planned this run's subject" exactly as a
    // catalog row is — and the scout, one paid model call, is skipped for it
    // unless the client opted into `trendJacking: "always"`.
    const strategyRowUsable = strategyRow !== undefined && touchesNeverTopic(strategyRow.idea, learning.preferences) === undefined;
    const wantsScout = !runDirection.topicOverride && !intake.requestedTopic && ((reservation.topics.length === 0 && !strategyRowUsable) || intake.trendJacking === "always");
    let scout: TrendScoutOutput | undefined;
    if (wantsScout) {
      scout = await runTrendScout(wf, { tools, promptStore: options.promptStore, router: options.router }, "07a-trend-scout", {
        research: researchDigestForScout(research.merged),
        channel: "x",
        clientProfile: clientContext.profile,
        ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
        ...(clientVoiceContext !== undefined ? { clientVoiceContext } : {}),
        ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
        forbiddenTopics: intake.forbiddenTopics,
        today: new Date().toISOString().slice(0, 10),
      });
    }

    // ── 07b: the content-mode rotation ──
    //
    // Hot news, deep value, open discussion: never the same twice in a row,
    // least-used first. The mode survives across runs the way the lane does —
    // inside the decision summary, `(mode: hot-news)` — and is parsed back here.
    const modeSelection = await wf.step.code("07b-select-content-mode", (): XContentModeSelection => {
      const recentModes = recentDecisions
        .map((d) => ({ at: typeof d.at === "number" ? d.at : 0, mode: parseContentModeFromSummary(d.summary) }))
        .filter((d): d is { at: number; mode: ContentMode } => d.mode !== undefined)
        .sort((a, b) => a.at - b.at)
        .map((d) => d.mode);
      const priorMode = recentModes.at(-1);
      // Same precedence as linkedin-agent's 07b (SCRUM-430): a typed note that
      // names a kind of post outranks the dialog's pick; one that does not
      // leaves the pick standing. The two products stay readable side by side.
      const directed = runDirection.modeOverride;
      const mode = selectContentMode(recentModes, directed ?? intake.requestedMode);
      const source: XContentModeSelection["source"] =
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

    const selected = await wf.step.code("07-select-candidate", (): XSelectedCandidate => {
      // Single post selection precedence (RFC-02 §3): an explicit client request wins,
      // then a reserved catalog topic, then the scout's on-brand trend, then the
      // research-derived fallback.
      // Highest precedence, above an explicit requestedTopic's own branch
      // below only when that is absent: a typed instruction is this run's
      // most specific statement of intent.
      // A topic the client said never to touch (C7 §2.4, derived from their
      // own review actions) is refused whoever proposed it. An explicit
      // request for one HOLDS with the reason — the person asked for the one
      // thing the client ruled out, and a human should see that, not a silent
      // swap; every other source simply falls through to the next.
      const never = (topic: string) => touchesNeverTopic(topic, learning.preferences);
      // A subject already in this platform's window (02 §3.2's anti-repetition
      // rule, read off the subject table rather than off this agent's memory
      // alone) is not proposed again either.
      const repeated = (topic: string) => subjectWindowConflict(topic, learning.subjectWindow);
      // A topic on the client's never-list is refused whoever asked for it —
      // including a person typing it into the portal. That rule is absolute and
      // is NOT relaxed here.
      //
      // What changed is the consequence. This used to end the run, so the
      // person who asked got an error and the account posted nothing that day.
      // Now the request is declined, the refusal travels out to the
      // deliverable, and selection falls through to something this account IS
      // allowed to talk about. The subject they asked for still never gets
      // written.
      let refusedRequest: string | undefined;
      const requested = runDirection.topicOverride ?? intake.requestedTopic;
      if (requested !== undefined) {
        const hit = never(requested);
        if (hit === undefined) return { ...(refusedRequest !== undefined ? { refusedRequest } : {}), topic: requested, source: "requested" };
        refusedRequest = `the requested topic ("${requested}") touches a never-topic the client set ("${hit}"), so this run wrote about something else instead`;
      }
      // Subjects already covered: this agent's own decisions AND what every
      // other channel (and the client's own accounts) published lately.
      const avoidTopics = [...recentDecisions.map((d) => d.summary), ...crossChannelAvoidTopics(crossChannel)];
      const trend = scout !== undefined ? selectTrendCandidate(scout.candidates, modeSelection.mode, { avoidTopics }) : undefined;
      const trendOk = trend !== undefined && never(trend.topic) === undefined && repeated(trend.topic) === undefined ? trend : undefined;
      const reservedOk = reservation.topics.filter((t) => never(t) === undefined && repeated(t) === undefined);
      // ── THE ORDER (2026-09-24, owner's ruling) ──
      //
      // The strategy map — the client's own problem × stage plan, built at
      // setup (C1 / SCRUM-464) — now LEADS: after an explicit request, and after
      // a high-fit trend for a client who opted into `trendJacking: "always"`,
      // it outranks the topic catalog and the scout. It used to sit fifth, below
      // both, so any client with a catalog topic or a live trend never drew from
      // its own map: prep's `karoslabs` read "0 of 15 used" after three drafted
      // X subjects. The map is the plan the stage rotation (`stageForRun`) and
      // the learning loop were built around, so it goes first; the catalog and
      // the scout fill in when the map is spent or refused.
      //
      // `pickStrategyRow` already skipped rows whose idea is in this platform's
      // subject window, so only the never-list is checked here.
      const strategyOk = strategyRow !== undefined && never(strategyRow.idea) === undefined ? strategyRow : undefined;
      if (trendOk !== undefined && intake.trendJacking === "always" && trendOk.brandFit >= 4) {
        return { ...(refusedRequest !== undefined ? { refusedRequest } : {}), topic: trendOk.topic, source: "trend", trend: trendOk };
      }
      if (strategyOk !== undefined) {
        return { ...(refusedRequest !== undefined ? { refusedRequest } : {}), topic: strategyOk.idea, source: "strategy", strategyRowId: strategyOk.id };
      }
      if (reservedOk.length > 0) {
        return { ...(refusedRequest !== undefined ? { refusedRequest } : {}), topic: reservedOk[0]!, source: "reserved" };
      }
      if (trendOk !== undefined) {
        return { ...(refusedRequest !== undefined ? { refusedRequest } : {}), topic: trendOk.topic, source: "trend", trend: trendOk };
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
      // (No strategy branch here: the map row is refused above only by the
      // never-list, which is not relaxed, so it could never be taken here either.)
      if (candidateSummary.candidateTopic && never(candidateSummary.candidateTopic) === undefined) {
        return { ...(refusedRequest !== undefined ? { refusedRequest } : {}), topic: candidateSummary.candidateTopic, source: "research" };
      }
      // Everything available is on the client's never-list. Refusing to write
      // is the correct answer to that, and the only remaining honest one.
      throw new WorkflowHeld(
        "every available topic is on the client's never-list — there is nothing this account is permitted to post about this run",
      );
    });

    // Restored lane system (lanes.md): an explicit request wins, otherwise a
    // deterministic "never twice in a row, least-recently-used, weight as
    // tiebreak" rotation — narrowed (2026-09) to the lanes that carry this
    // run's content mode. `angle` is the scout's when a trend took the slot,
    // else the pre-existing two-value derivation.
    const laneSelection = await wf.step.code("08-select-lane", (): { lane: Lane; angle: string } => {
      // A scouted trend or a research headline is someone else's news, and
      // build-in-public is the client's OWN ship, decision or number (x-craft
      // §2) — the lane cannot honestly carry an external topic, and the
      // prompt forbids the draft from choosing another. Prep run
      // pubsub-21699953559354996 spent all eight drafting turns on exactly
      // that contradiction ("the lane says our ship; the topic is OpenAI's").
      // Out of the ROTATION only: an explicit `requestedLane` still wins.
      const externalTopic = selected.source === "trend" || selected.source === "research";
      const lane = selectLane(intake.requestedLane, recentDecisions, LANES_FOR_MODE[modeSelection.mode], externalTopic ? ["build-in-public"] : []);
      const angle = selected.trend?.angle ?? (candidateSummary.hasNumericInsight ? "data-point" : "trend-observation");
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

    // ── 09b: media the client attached, read by a vision model BEFORE drafting ──
    //
    // The copy is written TO the picture, so the picture has to be understood
    // first. No step at all when the run carries no attachments.
    const attachedMedia = await analyzeAttachedMedia(wf, tools, ctx, {
      stepId: "09b-analyze-attached-media",
      repoRoot: options.repoRoot,
      assets: runDirection.mediaAssets,
    });
    const attachedForDrafting = attachedMediaForDrafting(attachedMedia);

    // The research itself, shaped for the drafting prompt: every fetched
    // source's title, url, date and excerpt. Until 2026-09 the draft was handed
    // a headline and nothing else, so a run with real sources drafted from one
    // title (the newsletter agent's prep job sp8ICAFLjKkYWb2DAh8R measured the
    // same defect). A pure function of step 04's checkpointed output.
    const researchDigest = researchDigestForDrafting(research.merged);
    const researchSources = (researchDigest ?? []).filter((d) => d.url !== undefined).map((d) => ({ url: d.url!, title: d.title }));

    // The learning context in the shapes the drafting prompt reads (x-craft §0,
    // §15). Pure functions of step 01b's checkpointed output.
    const craftRules = craftRulesForPrompt(learning.craft);
    const clientFeedback = feedbackForPrompt(learning.feedback);
    const clientPreferences = preferencesForDrafting(learning.preferences);

    // ── 10-14: draft execution via XDraftAgent, with machine/claim/compliance/link gates ──
    const draftAgent = new XDraftAgent({ router: options.router, tools, promptStore: options.promptStore });

    /**
     * One full drafting pass: draft, then every deterministic content gate,
     * then the media resolution, then the terminal topic guardrail.
     *
     * Called once per REVISION round by `runReviewCycle`. `revision` is folded
     * into every checkpointed step id inside it (via `rev`), so a second round
     * genuinely re-drafts instead of short-circuiting on the first round's
     * checkpoints — while everything OUTSIDE it (intake, research, the topic
     * reservation) keeps its id and is reused. That reuse is why the revision
     * is in-run rather than a fresh run.
     */
    /** What each drafting round had to repair before it could deliver. Empty on the normal path. */
    const repairsByRevision = new Map<number, ContentRepair[]>();

    const draftOnce = async (revision: number, notes: readonly RevisionNote[]): Promise<XDraftWithMedia> => {
      /** The last drafting input used, so step 14r's redraft reads exactly the same brief. */
      let draftInputForRepair: Record<string, unknown> = {};
      /** Revision 0 keeps the ORIGINAL ids, so a first-pass trace is unchanged. */
      const rev = (id: string) => (revision === 0 ? id : `${id}-r${revision}`);
      const directive = revisionDirective(notes);

      // ── 10/10a: draft, then VERIFY it is not a repeat, before anything else ──
      //
      // `recentPosts` in the drafting input below is ADVISORY: it asks the model
      // not to repeat itself and nothing ever checked whether it listened, so a
      // lightly-reworded reissue of last week's post passed every gate. 10a is
      // the verification half — the same `checkOutputDedupe` primitive, scoring
      // the same excerpt window step 04e read with `evaluateDedupe`'s calibrated
      // trigram-Jaccard threshold, in the same place instagram-agent puts its
      // own 07d check: inside the drafting pass, so a `similar` verdict COSTS
      // the draft (it is redrafted with the offending post quoted into the
      // prompt) and the human at step 15 can never be shown a draft that has
      // not been scored.
      //
      // On the final attempt the draft ships FLAGGED rather than held — two
      // posts a fortnight apart about the same launch may be exactly right, and
      // a fixed threshold is not entitled to overrule the person reviewing at
      // 15. The verdict is checkpointed either way.
      //
      // The scored text is exactly what step 20 records back into the window
      // (`draft.text`), so every future run compares like with like.
      const draftWithVerifiedDedupe = async (): Promise<XPostOutput> => {
        /** Set by a failed 10a check, so the NEXT attempt's prompt names exactly which published post to move away from. */
        let dedupeRetrySteer: string | undefined;
        /** Set once, by a draft that ran out of turns: the next attempt is told what its predecessor did instead of finishing. */
        let commitSteer: string | undefined;
        /** Set once, by a draft with a part over X's limit: the next attempt is told exactly which part and by how much. */
        let lengthSteer: string | undefined;
        for (let attempt = 1; attempt <= MAX_DEDUPE_ATTEMPTS; attempt++) {
          /** Attempt 1 keeps the ORIGINAL step ids, so a run that never repeats itself has a byte-identical trace to what it had before this check existed. */
          const att = (id: string) => (attempt === 1 ? id : `${id}-attempt-${attempt}`);
          const draftInput = {
            ...runDirectionField(runDirection),
            topic: selected.topic,
            source: selected.source,
            lane: laneSelection.lane,
            angle: laneSelection.angle,
            contentMode: modeSelection.mode,
            threadAllowed: intake.allowThreads,
            targetHandle: intake.xHandle,
            voiceRules: clientContext.voiceRules,
            // The client's own profile description + voice-rules guidelines,
            // verbatim — this is where a language requirement like Geektime's
            // "Hebrew-language technology site" actually lives.
            ...(clientVoiceContext !== undefined ? { clientVoiceContext } : {}),
            ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
            // The research the post is written from, and the scouted story
            // when one took the slot: angle, hook, why-now, brand-fit bridge.
            ...(researchDigest !== undefined ? { research: researchDigest } : {}),
            ...(selected.trend !== undefined ? { trendCandidate: trendCandidateForDrafting(selected.trend) } : {}),
            // What the client attached, as a vision model described it.
            ...(attachedForDrafting !== undefined ? { attachedMedia: attachedForDrafting } : {}),
            ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
            ...(dedupeRetrySteer !== undefined ? { dedupeAvoid: dedupeRetrySteer } : {}),
            ...(commitSteer !== undefined ? { commitDirective: commitSteer } : {}),
            ...(lengthSteer !== undefined ? { lengthDirective: lengthSteer } : {}),
            // Omitted rather than passed as null when absent: an explicit
            // "accountCharter: null" in the payload invites the model to remark on
            // its absence instead of simply working without one.
            ...(clientContext.strategy ? { accountCharter: clientContext.strategy } : {}),
            // ── C7 (A1): what the platform has learned, as the prompt's §0/§15 read it ──
            // The stage this post is for and, when the map had one, the row it
            // takes; the introduction doc's what-works and voice notes; the
            // derived rules; the client's recent review actions; the craft
            // layers as instructions with their ids, so the model can report
            // `rulesApplied`. Every key is omitted when the file was absent.
            slotStage: stage,
            ...(strategyRow !== undefined ? { strategyRow: strategyRowForDrafting(strategyRow) } : {}),
            ...(learning.platformState !== undefined ? { platformState: platformStateForDrafting(learning.platformState) } : {}),
            ...(learning.whatWorks !== undefined ? { whatWorks: learning.whatWorks } : {}),
            ...(craftRules !== undefined ? { craftRules } : {}),
            ...(clientFeedback.length > 0 ? { clientFeedback } : {}),
            ...(clientPreferences !== undefined ? { clientPreferences } : {}),
            // Two distinct steers, kept apart: `pastFeedback` is what this client
            // has said across previous RUNS, `revisionRequest` is what a reviewer
            // asked about THIS draft minutes ago.
            ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
            ...(directive !== undefined ? { revisionRequest: directive } : {}),
          };
          // Kept for the repair redraft at 14r, which must send byte-identical
          // evidence and differ only in its `revisionRequest`.
          draftInputForRepair = draftInput;
          const firstDraft = await wf.step.agent(rev(att("10-draft-post")), draftAgent, draftInput);

          // A draft that came back unusable gets ANOTHER draft, not a held run:
          // `content_fail` here means the turn returned no parseable structured
          // output, which is a coin flip rather than a verdict on the post.
          const draftResult =
            firstDraft.status === "content_fail"
              ? await wf.step.agent(rev(att("10z-regenerate-post")), draftAgent, draftInput)
              : firstDraft;

          if (draftResult.status === "content_fail") {
            // Twice is no longer a coin flip. Nothing was drafted, so there
            // is nothing to repair and nothing to annotate. `degraded` rather
            // than `held`: `held` means "we looked and decided not to
            // publish", a content verdict nobody made here. Neither status is
            // auto-retried (the queue consumer acks every terminal status);
            // this is about classifying the failure honestly.
            throw new WorkflowToolingFailure("draft did not produce a parseable post on two consecutive attempts");
          }
          // A loop that hit its turn ceiling did not malfunction (`step.agent`'s
          // own taxonomy), so it is not a `WorkflowToolingFailure` — which is
          // what prep job viPcZ66rMVWk6HmiQImc became: a `failed` run over a
          // draft that had passed lint seven times and was never returned.
          // The engine's commit turn now catches most of these inside the
          // step; when it does not, the draft is re-attempted ONCE, told what
          // the first attempt did instead of finishing, and a second
          // exhaustion holds the run with that same account as its reason.
          if (draftResult.status === "budget_exceeded") {
            const diagnosis = describeAgentExhaustion(draftResult);
            if (commitSteer === undefined && attempt < MAX_DEDUPE_ATTEMPTS) {
              commitSteer = commitDirectiveAfterExhaustion(diagnosis);
              continue;
            }
            // Nothing was drafted, so there is no content to repair. Not a
            // content verdict either — the model ran out of turns, which is a
            // malfunction (RFC-01 §6), and recording it as `held` claimed a
            // judgment nobody made. Neither status is auto-retried.
            throw new WorkflowToolingFailure(`draft ran out of turns without returning a post: ${diagnosis}`);
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
          const candidate: XPostOutput = { ...draftResult.finalOutput!, mainPostText: draftResult.finalOutput!.text };

          // The length check, INSIDE the loop, before the draft is scored or
          // gated. Steps 13b/14 below still verify with `render.preview` and
          // hold; they are the record. But a hold there used to be the first
          // time anyone told the model a part was over (prep run
          // pubsub-21720543781218757: "thread part 3 exceeds the X character
          // limit (283 chars)", a finished, sourced thread thrown away over
          // three characters). Counted the way `render.preview` counts, so the
          // steer and the backstop can never disagree. One redraft, then the
          // backstop holds as before.
          const overrun = describeLengthOverrun(candidate);
          if (overrun !== undefined && lengthSteer === undefined && attempt < MAX_DEDUPE_ATTEMPTS) {
            lengthSteer = overrun;
            continue;
          }

          const dedupeVerdict = await checkOutputDedupe(wf, rev(att("10a-verify-not-duplicate")), fullText(candidate), outputHistory);
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

      // ── 11-14r: inspect, then REPAIR. This region no longer holds the run. ──
      //
      // Every check here used to `throw new WorkflowHeld(...)`, ending the run
      // and handing the client an error where a post should have been. Each of
      // these failures is a reason to fix one thing — drop a figure, move a
      // link, trim a part, publish the main post without its thread — not a
      // reason to withhold the post.
      //
      // The checks keep their full authority over what may be PUBLISHED and
      // lose the authority to end the run. `tooling_error` still throws.
      //
      // What a figure in the post may be traced to: the full text of every
      // research document (the gate verifies against CONTENT, and a URL alone
      // — which is all `sourceLabel` is — verifies nothing), the client's own
      // intel context, the run's topic (a catalog topic or a typed request is
      // the client's own statement), and any legible text in an attached
      // image. Until 2026-09 this was `[sourceLabel]`, so every number a draft
      // quoted faithfully from a real source was held anyway.
      const sources = [
        ...researchSourceTexts(research.merged),
        ...(clientIntelContext !== undefined ? [clientIntelContext] : []),
        selected.topic,
        ...(selected.trend !== undefined ? [selected.trend.headline, selected.trend.angle] : []),
        ...(attachedMedia?.analyses.flatMap((a) => a.textInImage) ?? []),
        ...(candidateSummary.hasNumericInsight ? [candidateSummary.sourceLabel] : []),
      ];
      const forbiddenTerms = (clientContext.brand["forbiddenTerms"] as string[] | undefined) ?? [];

      /**
       * Applies a span redaction across the main post AND every thread part.
       *
       * `text` and `mainPostText` are kept in lockstep: `fullText` reads `text`,
       * the link and thread checks read `mainPostText`, and letting them drift
       * would mean one check passing on a string the client never sees.
       *
       * A thread part emptied by redaction is DROPPED from the array rather
       * than left blank — X will not publish an empty post, and a thread with a
       * hole in it reads worse than a shorter thread.
       */
      const redactAcrossDraft = (post: XPostOutput, spans: readonly string[]): XPostOutput => {
        const text = redactSentencesCarrying(post.text, spans, POST_WITHHELD).text;
        return {
          ...post,
          text,
          mainPostText: text,
          thread: post.thread.map((part) => redactSentencesCarrying(part, spans).text).filter((part) => part.trim().length > 0),
        };
      };

      /** The four span-flagging gates over the WHOLE post — main plus thread. */
      const inspectSpans = async (post: XPostOutput): Promise<GateVerdict> => {
        const whole = fullText(post);
        const verdicts = await Promise.all([
          runGate(tools, "gate.numbersSourced", { text: whole, sources }, ctx),
          runGate(tools, "gate.brandCompliance", { text: whole, forbiddenTerms }, ctx),
          runGate(tools, "gate.noPlaceholder", { text: whole }, ctx),
          runGate(tools, "gate.leakCheck", { text: whole }, ctx),
        ]);
        const broken = verdicts.find((v) => v.verdict === "tooling_error");
        if (broken !== undefined && broken.verdict === "tooling_error") {
          throw new WorkflowToolingFailure(`x content gate: ${broken.reason}`);
        }
        const failures = verdicts.filter((v) => v.verdict === "content_fail");
        if (failures.length === 0) return localPass("x-content-gates");
        return localContentFail(
          "x-content-gates",
          failures.map((v) => (v.verdict === "content_fail" ? v.reason : "")).join("; "),
          failures.flatMap((v) => v.evidence),
        );
      };

      const previewOf = async (text: string): Promise<RenderPreviewResult> => {
        const outcome = await tools["render.preview"]!.execute({ text }, { ctx });
        if (outcome.status !== "success") throw new WorkflowToolingFailure(`render.preview failed: ${outcome.status}`);
        return outcome.result as RenderPreviewResult;
      };

      /**
       * Every SHAPE rule X imposes, as one list of problems: the main post's
       * length, whether this account may thread at all, the thread ceiling, and
       * each continuation part's own length.
       *
       * One entry per violation, never a single catch-all string.
       * `runCheckWithRepair` keeps a repair only when strictly fewer items
       * remain, so a lumped verdict would make every partial fix — trimming one
       * over-long part of three — look like no fix at all and be discarded.
       */
      const shapeProblems = async (post: XPostOutput): Promise<string[]> => {
        const problems: string[] = [];
        const main = await previewOf(post.text);
        if (!main.withinLimit) problems.push(`post exceeds the X character limit (${main.characterCount} chars)`);
        if (post.thread.length > 0) {
          if (!intake.allowThreads) {
            problems.push(`the draft carries ${post.thread.length} thread part(s) but this account does not publish threads (xAllowThreads: false)`);
          }
          if (post.thread.length + 1 > MAX_THREAD_PARTS) {
            problems.push(`the thread runs to ${post.thread.length + 1} posts; the ceiling is ${MAX_THREAD_PARTS}`);
          }
          for (const [index, part] of post.thread.entries()) {
            const preview = await previewOf(part);
            if (!preview.withinLimit) problems.push(`thread part ${index + 2} exceeds the X character limit (${preview.characterCount} chars)`);
          }
        }
        // "Post clean, link in first reply" (x-craft.md §5): when the draft set
        // a `firstReplyUrl`, neither the main post nor a thread part may ALSO
        // carry a bare link — that means the model put it in the wrong place.
        // No check when `firstReplyUrl` is unset (x-craft.md's own launch-post
        // exception, "the link IS the news", is the drafting model's call).
        if (post.firstReplyUrl && [post.mainPostText, ...post.thread].some((part) => BARE_URL_PATTERN.test(part))) {
          problems.push("the post (or a thread part) contains a bare link even though firstReplyUrl is set — links go in the first reply, never the post body (x-craft.md §5)");
        }
        // A draft is written now and published later — often days later, by a
        // person working through a review queue. `fullText`, so thread part 4
        // is checked with part 1: they publish at the same second and decay
        // together (x-craft@8 §12b).
        problems.push(...relativeDayProblems(fullText(post), "x-craft §12b"));
        return problems;
      };

      /** Removes every bare URL from the main post and each thread part. */
      const stripBareLinks = (post: XPostOutput): XPostOutput => {
        const clean = (part: string) => part.replace(new RegExp(BARE_URL_PATTERN.source, "g"), "").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim();
        const text = clean(post.text);
        if (text.length === 0) return post;
        return { ...post, text, mainPostText: text, thread: post.thread.map(clean).filter((part) => part.length > 0) };
      };

      // Each check keeps its own step id and records its verdict against the
      // draft AS FIRST WRITTEN, which is what a trace wants to show.
      const numbersVerdict = await wf.step.code(rev("11-verify-numbers-sourced"), () =>
        runGate(tools, "gate.numbersSourced", { text: fullText(draft), sources }, ctx),
      );
      const brandVerdict = await wf.step.code(rev("12-verify-brand-compliance"), () =>
        runGate(tools, "gate.brandCompliance", { text: fullText(draft), forbiddenTerms }, ctx),
      );
      const linkInspection = await wf.step.code(rev("13-verify-link-placement"), () => ({
        bodyLink:
          draft.firstReplyUrl && [draft.mainPostText, ...draft.thread].some((part) => BARE_URL_PATTERN.test(part)) ? true : false,
      }));
      // No step at all for a single post, so a plain run's trace is unchanged.
      if (draft.thread.length > 0) {
        await wf.step.code(rev("13b-verify-thread"), async () => {
          const counts: number[] = [];
          for (const part of draft.thread) counts.push((await previewOf(part)).characterCount);
          return {
            parts: draft.thread.length + 1,
            allowed: intake.allowThreads,
            withinCeiling: draft.thread.length + 1 <= MAX_THREAD_PARTS,
            characterCounts: [draft.mainPostText.length, ...counts],
          };
        });
      }
      const previewInspection = await wf.step.code(rev("14-render-preview-check"), async () => {
        const preview = await previewOf(draft.text);
        return { withinLimit: preview.withinLimit, characterCount: preview.characterCount };
      });
      const placeholderVerdict = await wf.step.code(rev("14c-verify-no-placeholder"), () =>
        runGate(tools, "gate.noPlaceholder", { text: fullText(draft) }, ctx),
      );
      const leakVerdict = await wf.step.code(rev("14d-verify-no-leak"), () =>
        runGate(tools, "gate.leakCheck", { text: fullText(draft) }, ctx),
      );

      /** Everything the span gates objected to, unwrapped from each gate's own evidence shape. */
      const flaggedSpans = [numbersVerdict, brandVerdict, placeholderVerdict, leakVerdict].flatMap((verdict) => {
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`x content gate: ${verdict.reason}`);
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
        async (): Promise<{ post: XPostOutput; repairs: ContentRepair[] }> => {
          const openingShape = await shapeProblems(draft);
          if (flaggedSpans.length === 0 && openingShape.length === 0) return { post: draft, repairs: [] };

          const repairs: ContentRepair[] = [];
          let post = draft;

          // ── one model redraft, told everything that is wrong ──
          const asked = [
            ...(flaggedSpans.length > 0
              ? [
                  `These exact spans were rejected and must not appear anywhere in the post or any thread part: ${flaggedSpans.join(", ")}.`,
                  "For a figure: restate it exactly as a source writes it, or make the point qualitatively with no number.",
                  "For a banned phrase or an unresolved placeholder: rewrite without it.",
                  "For anything resembling a credential, an internal path or an internal-only term: remove it.",
                ]
              : []),
            ...(openingShape.length > 0 ? [`The post was also rejected on shape: ${openingShape.join("; ")}. Fix each of these.`] : []),
            "Keep everything else exactly as it is.",
          ].join(" ");

          const redraft = await draftAgent.run(ctx, { ...draftInputForRepair, revisionRequest: asked });
          if (redraft.status === "completed" && redraft.finalOutput) {
            const candidate: XPostOutput = { ...redraft.finalOutput, mainPostText: redraft.finalOutput.text };
            const candidateSpans = await inspectSpans(candidate);
            const candidateShape = await shapeProblems(candidate);
            const before = flaggedSpans.length + openingShape.length;
            const after = (candidateSpans.verdict === "content_fail" ? spansFromEvidence(candidateSpans.evidence).length : 0) + candidateShape.length;
            if (after < before) {
              post = candidate;
              repairs.push({
                check: "x-content-gates",
                action: "rewritten",
                detail: `redrafted to clear ${before - after} of ${before} flagged problem(s)`,
              });
            }
          }

          // ── floor 1: spans ──
          const spanOutcome = await runCheckWithRepair({
            check: "x-content-gates",
            value: post,
            verify: inspectSpans,
            attempts: [{ action: "redacted", maxPasses: 3, run: (value, verdict) => redactAcrossDraft(value, spansFromEvidence(verdict.evidence)) }],
            describeUnresolved: (verdict) => `${verdict.reason} — delivered with this noted rather than withheld`,
          });
          post = spanOutcome.value;
          repairs.push(...spanOutcome.repairs);

          // ── floor 2: shape ──
          //
          // Four mechanical repairs, each the honest answer to its own rule:
          // a link that belongs in the first reply is REMOVED from the body
          // (it is already in `firstReplyUrl`, so nothing is lost); a thread an
          // account may not publish is DROPPED, delivering the main post the
          // account CAN publish; a thread over the ceiling is cut to it; and an
          // over-long post or part loses its trailing sentence.
          const shapeOutcome = await runCheckWithRepair({
            check: "x-post-shape",
            value: post,
            verify: async (value) => {
              const problems = await shapeProblems(value);
              return problems.length === 0 ? localPass("x-post-shape") : localContentFail("x-post-shape", problems.join("; "), problems);
            },
            attempts: [
              {
                // Deletion, never substitution: nothing here knows what date
                // the writer meant, and inventing one is the failure the rule
                // exists to prevent. "closed its Series D yesterday" becomes
                // "closed its Series D" — less specific, never false.
                action: "redacted",
                run: (value) => {
                  const text = stripRelativeDays(value.text);
                  const thread = value.thread.map(stripRelativeDays).filter((part) => part.trim().length > 0);
                  if (text === value.text && thread.every((part, i) => part === value.thread[i])) return undefined;
                  if (text.trim().length === 0) return undefined;
                  return { ...value, text, mainPostText: text, thread };
                },
              },
              {
                action: "moved",
                run: (value) => (value.firstReplyUrl && [value.mainPostText, ...value.thread].some((p) => BARE_URL_PATTERN.test(p)) ? stripBareLinks(value) : undefined),
              },
              {
                action: "substituted",
                run: (value) => (value.thread.length > 0 && !intake.allowThreads ? { ...value, thread: [] } : undefined),
              },
              {
                action: "trimmed",
                run: (value) => (value.thread.length + 1 > MAX_THREAD_PARTS ? { ...value, thread: value.thread.slice(0, MAX_THREAD_PARTS - 1) } : undefined),
              },
              {
                action: "trimmed",
                maxPasses: 5,
                run: async (value) => {
                  /**
                   * Cuts a part down to the limit in ONE pass, not one sentence
                   * per pass: shedding one at a time runs out of passes on a
                   * part far over 280, and a trim that stops short delivers an
                   * unpublishable post while reporting that it trimmed it.
                   */
                  const shorten = (part: string): string | undefined => {
                    const sentences = part.split(/(?<=[.!?])\s+/);
                    if (sentences.length <= 1) return undefined;
                    let kept = sentences.length;
                    while (kept > 1 && sentences.slice(0, kept).join(" ").trim().length > X_CHARACTER_LIMIT) kept -= 1;
                    const shorter = sentences.slice(0, kept).join(" ").trim();
                    return shorter.length === 0 || shorter.length >= part.length ? undefined : shorter;
                  };
                  const mainPreview = await previewOf(value.text);
                  if (!mainPreview.withinLimit) {
                    const shorter = shorten(value.text);
                    if (shorter !== undefined) return { ...value, text: shorter, mainPostText: shorter };
                  }
                  for (const [index, part] of value.thread.entries()) {
                    const preview = await previewOf(part);
                    if (preview.withinLimit) continue;
                    const shorter = shorten(part);
                    if (shorter === undefined) continue;
                    const thread = [...value.thread];
                    thread[index] = shorter;
                    return { ...value, thread };
                  }
                  return undefined;
                },
              },
            ],
            describeUnresolved: (verdict) => `${verdict.reason} — delivered with this noted rather than withheld`,
          });
          post = shapeOutcome.value;
          repairs.push(...shapeOutcome.repairs);

          return { post, repairs };
        },
      );
      draft = repaired.post;

      // ── 14f: the post this reply is aimed at, and whether it can be shown ──
      //
      // `targetPostHandle`/`targetPostUrl` came out of the drafting model and
      // NOTHING read them. No tool in this agent fetches a post, the schema's
      // `z.string().url()` accepts `https://example.com`, and the deliverable
      // printed the result as `**In reply to:** <url>` — a citation shape over
      // a claim the run cannot stand behind. Same defect class as an unsourced
      // figure, one field over.
      //
      // This cannot establish that the post exists; that costs an API tier
      // this agent does not have. It establishes that the URL is shaped like
      // an X post at all and that the draft does not contradict itself, drops
      // what fails, and records the drop. A pure read, so it needs no step of
      // its own and no checkpoint.
      const engagementTarget = readEngagementTarget(draft);
      if (engagementTarget.kind === "unusable") {
        repaired.repairs.push({
          check: "engagement-target",
          action: "redacted",
          detail: `${engagementTarget.reason} — the post ships without naming a target rather than naming an invented one`,
        });
      }

      // Outside the step body: a checkpointed step is replayed from its stored
      // value on resume and its body never runs again.
      repairsByRevision.set(revision, repaired.repairs);

      // ── 14e: the post's media — attached first, then the draft's own brief ──
      //
      // After every text gate, so a held draft never pays for a screenshot or
      // a generation; inside the revision loop, because a revised post may want
      // a different picture. Never holds: a post with no picture ships and the
      // rationale rides into the gate payload for the reviewer.
      const mediaPlan = await resolveSocialMedia(wf, tools, ctx, {
        stepId: rev("14e-resolve-media"),
        repoRoot: options.repoRoot,
        platform: "x",
        brief: draft.mediaBrief,
        attached: attachedMedia,
        sources: researchSources,
        postText: draft.text,
        art: artDirectionFromBrand(clientContext.brand),
        // ── D24: X IS TEXT ONLY ──
        //
        // "X is text only: it does not create or source pictures; a client's
        // own picture is attached if given" (05 Decisions log, D24).
        //
        // This used to read `runDirection.mediaSource === "client"`, which made
        // the four-tier cascade — screenshot, harvest, stock, `image.generate`
        // — the DEFAULT, and text-only an opt-in the client had to remember per
        // run. That is the decision inverted. A generated illustration or a
        // scraped screenshot on an X post is exactly what marks an account as
        // automated, which is the reason the decision exists.
        //
        // Hardcoded `true` rather than left as an option: a flag someone can
        // turn off is not a product rule. The attached-media path above is
        // untouched and is the whole of the permitted half — `attached` still
        // wins, the vision read still runs, and the post is still written TO
        // the client's picture.
        //
        // The same cascade stays exactly as it was for linkedin, which has no
        // such rule.
        clientMediaOnly: true,
      });

      // ── 14b: terminal topic guardrail ──
      //
      // Before the human gate, deliberately: a reviewer should never be shown a
      // draft that engages a subject this client said it does not touch. It is
      // NOT what gate.brandCompliance already did two steps up — that matches
      // forbiddenTerms as substrings and catches the word, while this judges the
      // subject, so a post that discusses a forbidden topic fluently without
      // naming it passes the first and fails this.
      //
      // Appended by this workflow rather than read from any editable list, and
      // free for a client who forbids no topics: no list, no model call.
      await runTopicGuardrail(
        wf,
        { tools, promptStore: options.promptStore, router: options.router },
        // Re-derived from the REPAIRED draft, not the draft as first written:
        // the guardrail must judge the subject of the post that actually ships.
        fullText(draft),
        intake.forbiddenTopics,
        revision === 0 ? undefined : `-r${revision}`,
      );

      return { ...draft, mediaPlan };
    };

    // ── 15: the universal approve / revise / reject cycle ──
    //
    // `revise` re-drafts with the reviewer's feedback injected, reusing
    // everything already checkpointed, instead of holding the run and forcing
    // somebody to dispatch a fresh one that knows nothing about the feedback.
    // Every decision, approvals included, is written to client memory.
    const review = await runReviewCycle(wf, {
      gateId: "15-batch-review",
      maxRevisions: MAX_REVISION_ROUNDS,
      ...(options.autoApprove ? { autoApprove: true } : {}),
      attempt: draftOnce,
      buildGate: (draft, revision) => {
        // THE THREE TIERS, NOT A FLAT HOUR.
        //
        // This gate used to carry `{ duration: "1h", onTimeout: "auto_approve" }`
        // written out by hand, so a draft the run had already REPAIRED — an
        // unsourced figure redacted, a banned phrase redrafted, a part trimmed
        // to fit — got exactly the same hour as a clean one, and a
        // regulated-compliance finding got no special treatment at all.
        //
        // Read ONCE and used both as the policy and as the payload block, so
        // the clock a reviewer is racing and the sentence explaining it can
        // never disagree.
        const gateTimeout = textGateTimeout({ repairs: repairsByRevision.get(revision) });
        // Re-read from THIS round's draft rather than closing over the outer
        // one: `buildGate` is called per revision with the draft that round
        // produced, and a target from the previous round is the wrong post.
        const gateTarget = readEngagementTarget(draft);
        return {
        kind: "batch_review",
        payload: {
          runId: wf.runId,
          topic: selected.topic,
          lane: laneSelection.lane,
          angle: laneSelection.angle,
          contentMode: modeSelection.mode,
          preview: draft.text,
          ...(draft.thread.length > 0 ? { thread: draft.thread } : {}),
          // Truthiness, not `!== undefined`: the draft schema accepts "" as "no link" (see XPostOutputSchema).
          ...(draft.firstReplyUrl ? { firstReplyUrl: draft.firstReplyUrl } : {}),
          ...mediaForDeliverable(draft.mediaPlan),
          ...(selected.trend !== undefined ? { trend: { whyNow: selected.trend.whyNow, brandFitReason: selected.trend.brandFitReason, sourceUrls: selected.trend.sourceUrls } } : {}),
          // WHAT THIS REPLY IS AIMED AT, and who checked. Nobody did: the URL
          // is the drafting model's proposal and no tool here can fetch a post.
          // The gate is the right surface for the warning — the portal paints
          // any payload key and no parser reads it, unlike the DRAFTS.md label,
          // which karosCMO's `x-drafts.ts` matches on to decide what a client's
          // reply gets ADDRESSED at.
          ...(gateTarget.kind === "usable" ? { replyingTo: gateTarget.target.url, replyingToCheck: UNVERIFIED_TARGET_NOTE } : {}),
          revision,
          // WHY this draft waits as long as it does, in front of the person
          // whose time it is spending.
          gateTimeout,
        },
        requiredRole: "account_manager",
        timeout: { duration: gateTimeout.duration, onTimeout: gateTimeout.onTimeout },
        };
      },
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
    const { mediaPlan, ...draft } = review.output;
    // What this run WRITES DOWN as its subject — the subject table, the
    // platform state's topics and the decision memory. Equal to the selected
    // topic for every source but a typed note, which records the subject the
    // draft named (x-craft@9 §14) rather than the note as it was typed.
    const subject = recordedSubject(selected.topic, {
      fromNote: selected.source === "requested" && runDirection.topicFromNote === true && selected.topic === runDirection.topicOverride,
      stated: draft.subject,
    });
    /**
     * The repairs made to the round that was APPROVED — not the last round
     * attempted. Omitted from the deliverable when empty, so a clean run
     * produces the bytes it always did.
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

    // ── 18-19: deliverable & manifest persistence ──
    // Additive: `draftsMarkdown` is the DRAFTS.md-shaped string karosCMO's
    // `x-drafts.ts` parser needs on `asset.content` — the rest of `draft`
    // stays untouched for any consumer that wants the raw structured fields.
    // The media block (`media`, `mediaStatus`, `mediaRationale`) rides beside
    // it; `mediaRefs` carries the staged URL so the portal's existing
    // `metaFields` read picks it up unchanged.
    // D11 / C3 (SCRUM-457): what this post is for, who for, and why now —
    // resolved ONCE here and used for both the client's card and the state
    // record below, so the two can never disagree about why the post exists.
    const goalLine = resolveGoalLine(draft, { stage, whyNow: whyNowFor(selected) });
    const draftsMarkdown = renderXDraftsMarkdown({
      targetHandle: intake.xHandle,
      lane: laneSelection.lane,
      angle: laneSelection.angle,
      draft,
      goalLine,
      media: mediaPlan,
    });
    const deliverableId = await finalizeDeliverable(wf, tools, ctx, {
      persistDeliverableStepId: "18-persist-deliverable",
      persistManifestStepId: "19-persist-manifest",
      kind: "x-post",
      deliverable: {
        ...draft,
        mediaRefs: mediaPlan.asset !== undefined ? [mediaPlan.asset.url ?? mediaPlan.asset.path] : draft.mediaRefs,
        ...mediaForDeliverable(mediaPlan),
        contentMode: modeSelection.mode,
        ...(selected.trend !== undefined ? { trend: selected.trend } : {}),
        // Present only when something had to be repaired to get here, so a
        // reviewer sees what changed instead of a silently edited post.
        ...(contentRepairs.length > 0 ? { contentRepairs } : {}),
        draftsMarkdown,
      },
      snapshot: (deliverableId) => ({
        topic: selected.topic,
        source: selected.source,
        lane: laneSelection.lane,
        angle: laneSelection.angle,
        contentMode: modeSelection.mode,
        parts: draft.thread.length + 1,
        mediaStatus: mediaPlan.status,
        deliverableId,
      }),
    });

    // ── 20: commit updates (topics.commit, memory.appendDecision) — the review
    // decision itself is already durable: `onDecision` above called
    // `persistReviewFeedbackToMemory` for every round, which is the one real
    // feedback pipeline (AU22: this step used to also call the now-retired
    // `ledger.feedbackAppend`, a write-only log nothing ever read). ──
    await wf.step.code("20-commit-and-record", async () => {
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
      // A catalog topic this run reserved but did not write about goes back to
      // the floor. `06-reserve-topic` reserves before selection runs, and a
      // reservation has no expiry — so every run that took a map row (the
      // common case since the map leads) or a trend would otherwise strand
      // one catalog topic in `reserved` for good.
      else if (reservation.reservationKey && reservation.topics.length > 0) {
        await tools["topics.release"]?.execute({ reservationKey: reservation.reservationKey }, { ctx }).catch(() => undefined);
      }
      // The write half of the anti-repetition loop: the shipped post joins
      // this agent's rolling excerpt window, read back by research.pull's
      // history feed and the drafting directive on every future run.
      // Best-effort: losing an excerpt costs future dedup signal, never the
      // delivered post.
      await recordOutputExcerpt(tools, ctx, wf.runId, "x-agent", fullText(draft));
      await tools["memory.appendDecision"]!.execute(
        {
          decisionId: `${wf.runId}__decision`,
          // `(lane: …)` feeds the lane rotation and `(mode: …)` the content-mode
          // rotation on every future run — the summary is the only field that
          // survives the decision schema.
          summary: `Posted about "${subject}" (lane: ${laneSelection.lane}, angle: ${laneSelection.angle}, mode: ${modeSelection.mode})`,
        },
        { ctx },
      );
    });

    // ── 21: the learning loop's write side (C7 §3, A2) ──
    //
    // One normalised record the middleware collects into the subject table
    // and the platform state, plus the D11 goal line. The draft's own
    // `goal`/`audience`/`whyNow` win when the model stated them; the stage
    // this run was written for is the fallback, so the record always carries
    // a goal. A reviewer's revision notes are the voice lessons — an edit is
    // the one signal Craft 11 §3 admits for voice. Never fails the run: the
    // deliverable above stands whatever happens here, and the step record
    // says whether the write landed.
    await writeRunState(wf, tools, ctx, "21-write-run-state", {
      platform: "x",
      deliverable: {
        kind: "x-post",
        goal: goalLine.goal,
        ...(goalLine.audience !== undefined ? { audience: goalLine.audience } : {}),
        whyNow: goalLine.whyNow,
        type: laneSelection.lane,
        sources: researchSources.map((r) => r.url),
      },
      subjectRow: {
        subject,
        angle: draft.angle,
        type: laneSelection.lane,
        stage: goalLine.goal,
        goal: goalLine.goalText,
        // A draft the reviewer rejected outright was not used, which is what
        // \`skipped\` means in the subject table. Written as \`drafted\` it sat
        // there forever looking like work still in review.
        status: review.outcome === "rejected" ? "skipped" : "drafted",
        assetKind: "x-post",
        strategyRowId: selected.strategyRowId ?? null,
      },
      platformStateDelta: {
        postsByUs: 1,
        topics: [subject],
        voiceNotes: [],
        account: { handle: intake.xHandle },
      },
      voiceNotes: review.notes.map((n) => ({ lesson: n.feedback, fromRevision: n.revision })),
      rulesApplied: draft.rulesApplied,
      readiness: learning.readiness,
    });

    return {
      topic: selected.topic,
      angle: laneSelection.angle,
      lane: laneSelection.lane,
      contentMode: modeSelection.mode,
      targetHandle: intake.xHandle,
      deliverableId,
      parts: draft.thread.length + 1,
      mediaStatus: mediaPlan.status,
      preview: draft.text,
    };
  };
}
