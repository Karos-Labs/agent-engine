import { readForbiddenTopics } from "@agent-engine/core";
import type { AgentContext, AgentToolRegistry, ModelRouter, PromptStore } from "@agent-engine/core";
import type { CaptureFetch } from "@agent-engine/tool-common";
import { createScraperProvider, type ScraperProvider } from "@agent-engine/tool-karos-scraper";
import {
  runRedditChannelSetup,
  recordRedditAutoCharter,
  pruneAutoDerivedSubreddits,
  type RedditChannelSetupOutcome,
} from "@agent-engine/agent-setup";
import {
  type WorkflowContext,
  WorkflowBlockedIntake,
  WorkflowHeld,
  WorkflowToolingFailure,
  runTopicGuardrail,
  researchDigestForDrafting,
  researchSourceTexts,
  type ResearchPullResult,
  readRunDirection,
  runDirectionField,
  type RevisionNote,
  MAX_REVISION_ROUNDS,
  persistReviewFeedbackToMemory,
  readPastFeedback,
  revisionDirective,
  runReviewCycle,
  buildClientVoiceContext,
  readOutputHistoryForDedup,
  dedupeDirective,
  checkOutputDedupe,
  dedupeRetryDirective,
  readClientIntelContext,
  toAgentContext,
  runGate,
  finalizeDeliverable,
  recordOutputExcerpt,
} from "@agent-engine/workflow";
import { RedditDraftAgent } from "../agent/reddit-draft-agent.js";
import { RedditChannelPlannerAgent } from "../agent/reddit-channel-planner-agent.js";
import { RedditThreadScoutAgent, type RedditThreadScoutOutput } from "../agent/reddit-thread-scout-agent.js";
import { renderPreview, type RenderPreviewResult } from "../tools/render-preview.js";
import {
  bareSubreddit,
  createRedditThreadTools,
  parseRedditThreadUrl,
  type DiscoverThreadsResult,
  type FetchThreadResult,
  type RedditThreadCandidate,
} from "../tools/reddit-threads.js";
import { renderRedditDraftsEnvelope } from "./render-drafts-envelope.js";
import type {
  RedditAgentWorkflowResult,
  RedditAutoSetupOutcome,
  RedditCharter,
  RedditClientContext,
  RedditDiscovery,
  RedditIntakeConfig,
  RedditSelectedThread,
  RedditThreadContext,
} from "./types.js";

export interface CreateRedditAgentWorkflowOptions {
  /** The base Layer 3 registry (karos-client/research/topics/gates/ledger/memory) — `render.preview` and the `reddit.*` tools are merged in internally. */
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips the human `batch_review` gate and records a synthetic
   * `actor: "system"` approval instead — off by default, so a real run
   * genuinely pauses at `awaiting_gate` until a human reviews it (RFC-01
   * §8.3). Intended for tests/demos/evals that need a synchronous happy
   * path, never for production wiring.
   */
  autoApprove?: boolean;
  /**
   * The fetch used to read Reddit's public feeds. Injectable so tests serve
   * canned feeds; a deployment leaves it undefined and gets the global fetch.
   */
  redditFetch?: CaptureFetch;
  /**
   * The paid fallback for thread discovery/reading when Reddit's own feed
   * refuses. `undefined` derives one from the environment (`SCRAPPYCOCO_API_KEY`,
   * the same way `research.pull` does); `null` forces feed-only.
   */
  scraper?: ScraperProvider | null;
  /** Pause between two subreddit feed reads. Tests set 0. */
  redditPauseMs?: number;
}

/**
 * How many drafting passes the verified de-duplication check may cost —
 * initial draft plus two redraft steers, the same budget instagram-agent's
 * `MAX_SELF_CHECK_ATTEMPTS` gives its own 07d dedupe check. On the last
 * attempt a `similar` draft ships FLAGGED (the verdict stays checkpointed for
 * the trace and the reviewer), never held: `evaluateDedupe`'s own policy is
 * that de-duplication flags and steers, it does not hold a run.
 */
const MAX_DEDUPE_ATTEMPTS = 3;

/** Threads older than this are not worth replying to: nobody is reading them any more. */
const THREAD_MAX_AGE_DAYS = 7;
/** How many ranked candidates the scout sees. */
const SCOUT_CANDIDATE_LIMIT = 30;
/** Existing replies read from the chosen thread. */
const THREAD_COMMENT_LIMIT = 12;

/** Brand-kit fields that are visual identity, not voice — noise for a planner that decides where a client belongs. */
const BRAND_VISUAL_KEYS = new Set(["colors", "dominantColors", "fonts", "logoUrl", "accent", "logo", "palette"]);

function normalizeThreadUrl(url: string): string {
  const parsed = parseRedditThreadUrl(url);
  return parsed ? `https://www.reddit.com/r/${parsed.subreddit}/comments/${parsed.threadId}/` : url.trim();
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const t = (v ?? "").trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()) : [];
}

/**
 * `createRedditAgentWorkflow()` — the reply-only Reddit product, end to end.
 *
 * Legacy's non-negotiable rule is "comments only, never original posts"
 * (`reddit-agent-v2/SKILL.md` line 9; `references/reddit-craft.md` §1: "We
 * do not start threads"). Every run drafts ONE reply to ONE existing thread,
 * and a human posts it from their own account.
 *
 * ## What changed in this version, and why
 *
 * Two things made the previous version unable to deliver for a client that
 * had not been set up by hand, and thin even when it had:
 *
 * 1. **Setup was a precondition, not a step.** A client with no
 *    `targetSubreddits` and no charter was `blocked_intake` forever (prep job
 *    5A6bc8VUgRKcCg0Vh7xz, Karos Labs, 2026-09-05 — a client with a profile,
 *    a brand kit and six knowledge documents, none of which the run looked
 *    at before giving up). Setup is now a step: when nothing is on file, a
 *    planner derives a charter from what the client IS, records it as
 *    auto-derived (a real form replaces it later), and the run continues.
 * 2. **There was no thread discovery.** Step 08 held every run that did not
 *    arrive with a hand-typed `requestedThreadUrl` — which, for a scheduled
 *    weekly pulse, is every run. `reddit.discoverThreads` now scans the
 *    target communities' live feeds; a scout picks the one thread where the
 *    client has real standing, or declines with a reason; and
 *    `reddit.fetchThread` reads the poster's full text and the existing
 *    replies so the draft answers the actual question instead of the title.
 *    Research then runs FOR that thread (the question is the query), and
 *    `gate.numbersSourced` is handed the thread's text and the research
 *    documents' text — not a URL — so a figure quoted from a real source
 *    verifies.
 *
 * The run still pauses at a mandatory human `batch_review` gate (RFC-01
 * §8.3) unless `options.autoApprove` opts out.
 */
export function createRedditAgentWorkflow(options: CreateRedditAgentWorkflowOptions) {
  const scraper = options.scraper === null ? undefined : (options.scraper ?? createScraperProvider({}));
  const redditTools = createRedditThreadTools({
    ...(options.redditFetch ? { fetchImpl: options.redditFetch } : {}),
    ...(scraper ? { scraper } : {}),
    ...(options.redditPauseMs !== undefined ? { pauseBetweenFeedsMs: options.redditPauseMs } : {}),
    // A zero pause also means "do not wait on retries": tests must not sleep.
    ...(options.redditPauseMs === 0 ? { sleep: async () => {} } : {}),
  });
  // A caller's own `reddit.*` entries win (tests inject fakes); `render.preview` is this agent's and always its own.
  const tools: AgentToolRegistry = { ...redditTools, ...options.tools, "render.preview": renderPreview };

  return async function redditAgentWorkflow(wf: WorkflowContext): Promise<RedditAgentWorkflowResult> {
    const ctx = toAgentContext(wf);
    const setupArgs = { tools, ctx, runId: wf.runId, clientSlug: wf.clientSlug, input: wf.input ?? {} };

    // The run-scoped instruction someone typed in the portal, resolved once.
    // A typed sentence outranks everything derived for the same reason an
    // explicit requestedTopic does: a person who wrote it has more
    // information about this run than any record does.
    const runDirection = readRunDirection(wf.input);

    /*
     * ── 00-channel-setup: record a filled setup form, if this run carried one ──
     *
     * Reads the charter on file and, when the run's own input is a filled
     * Reddit setup form and no (human-recorded) charter exists yet, stores it.
     * Draft-only is unaffected: this records where a human may later post
     * from their own account; it grants no posting capability, and none exists.
     */
    const channelSetup: RedditChannelSetupOutcome = await wf.step.code("00-channel-setup", () => runRedditChannelSetup(setupArgs));

    // ── 00a: the client's standing configuration, read once ──
    const clientConfig = await wf.step.code("00a-load-client-config", async (): Promise<Record<string, unknown>> => {
      const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
      if (configOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client config is not available yet — the client workspace has not been provisioned");
      }
      return configOutcome.result as Record<string, unknown>;
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

    await wf.step.code("02-load-memory-shelf", async () => {
      const outcome = await tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
      return outcome.status === "success" ? outcome.result : { scope: "beliefs", beliefs: {} };
    });

    const recentDecisions = await wf.step.code("03-load-recent-decisions", async (): Promise<string[]> => {
      const outcome = await tools["memory.read"]!.execute({ scope: "decisions" }, { ctx });
      if (outcome.status !== "success") return [];
      const result = outcome.result as { scope: string; items: Array<{ summary: string }> };
      return result.items.map((item) => item.summary);
    });

    // The client intel report + synced knowledge base, distilled. Read here,
    // ahead of setup, because deciding where a client belongs on Reddit needs
    // to know what the client actually does — and so does judging threads.
    const clientIntelContext = await readClientIntelContext(wf, tools, ctx, "04-read-intel-context");
    const clientVoiceContext = buildClientVoiceContext(clientContext.profile, clientContext.voiceRules, clientContext.brand);

    /*
     * ── 04a/04b: auto-setup, only when NOTHING is on file ──
     *
     * Client config first, the recorded charter second, and only when both
     * are empty does the engine decide for itself. The decision is a model
     * step (choosing communities is judgment); the RECORDING is code in the
     * setup package, and the stored document says it was auto-derived so a
     * person can replace it by filling in the real form.
     */
    const configSubreddits = uniqueStrings(stringList(clientConfig["targetSubreddits"]).map(bareSubreddit));
    const charterSubreddits = uniqueStrings(channelSetup.targetSubreddits.map(bareSubreddit));
    const needsAutoSetup = configSubreddits.length === 0 && charterSubreddits.length === 0;

    const autoSetup: RedditAutoSetupOutcome = needsAutoSetup
      ? await (async (): Promise<RedditAutoSetupOutcome> => {
          const planner = new RedditChannelPlannerAgent({ router: options.router, tools, promptStore: options.promptStore });
          const brandForPlanner = Object.fromEntries(Object.entries(clientContext.brand).filter(([k]) => !BRAND_VISUAL_KEYS.has(k)));
          const planResult = await wf.step.agent("04a-plan-channel", planner, {
            ...runDirectionField(runDirection),
            profile: clientContext.profile,
            brand: brandForPlanner,
            voiceRules: clientContext.voiceRules,
            ...(clientVoiceContext !== undefined ? { clientVoiceContext } : {}),
            ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
            existingHints: {
              ...(clientConfig["targetAudience"] !== undefined ? { targetAudience: clientConfig["targetAudience"] } : {}),
              ...(stringList(clientConfig["contentPillars"]).length > 0 ? { contentPillars: stringList(clientConfig["contentPillars"]) } : {}),
              ...(stringList(clientConfig["targetKeywords"]).length > 0 ? { targetKeywords: stringList(clientConfig["targetKeywords"]) } : {}),
            },
          });
          if (planResult.status !== "completed" || !planResult.finalOutput) {
            return {
              status: "planner-failed",
              note: `the channel planner resolved to "${planResult.status}" and produced no charter`,
            };
          }
          const plan = planResult.finalOutput;
          const recorded = await wf.step.code("04b-record-auto-charter", () => recordRedditAutoCharter(setupArgs, plan));
          return {
            status: recorded.status === "recorded" || recorded.status === "already-configured" ? "recorded" : "not-recorded",
            plan,
            note: recorded.note,
          };
        })()
      : { status: "not-needed", note: configSubreddits.length > 0 ? "client config names the target communities" : channelSetup.note };

    // ── 04c: intake check — blocked_intake only when there is genuinely nothing to work from ──
    const intake = await wf.step.code("04c-intake-check", async (): Promise<RedditIntakeConfig> => {
      // Run-scoped request keys layered over standing config -- "the customer's
      // run request wins". Only run-scoped keys are overlaid: targetSubreddits
      // is client configuration, and letting a job payload rewrite which
      // communities an account replies in would be a tenancy hole.
      const runScoped: Record<string, string> = {};
      const readKey = (source: Readonly<Record<string, unknown>>, key: string): string | undefined => {
        const value = source[key];
        return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
      };
      for (const key of ["requestedTopic", "requestedSubreddit"] as const) {
        const value = readKey(wf.input, key) ?? readKey(clientConfig, key);
        if (value !== undefined) runScoped[key] = value;
      }
      // URL and title travel together: a title from config must never be
      // attached to a different thread typed into the run.
      const threadSource = readKey(wf.input, "requestedThreadUrl") !== undefined ? wf.input : clientConfig;
      for (const key of ["requestedThreadUrl", "requestedThreadTitle"] as const) {
        const value = readKey(threadSource, key);
        if (value !== undefined) runScoped[key] = value;
      }

      let charter: RedditCharter;
      const stored = channelSetup.charter;
      if (configSubreddits.length > 0) {
        charter = {
          targetSubreddits: configSubreddits,
          searchKeywords: stored?.searchKeywords ?? [],
          offLimitsTopics: stored?.offLimitsTopics ?? [],
          ...(stored?.voiceNotes ? { voiceNotes: stored.voiceNotes } : {}),
          ...(stored?.disclosureLine ? { disclosureLine: stored.disclosureLine } : {}),
          source: "client-config",
          autoDerived: false,
        };
      } else if (charterSubreddits.length > 0 && stored) {
        charter = {
          targetSubreddits: charterSubreddits,
          searchKeywords: stored.searchKeywords ?? [],
          offLimitsTopics: stored.offLimitsTopics ?? [],
          ...(stored.voiceNotes ? { voiceNotes: stored.voiceNotes } : {}),
          ...(stored.disclosureLine ? { disclosureLine: stored.disclosureLine } : {}),
          source: "charter",
          autoDerived: stored.autoDerived === true,
        };
      } else if (autoSetup.plan) {
        const plan = autoSetup.plan;
        charter = {
          targetSubreddits: uniqueStrings(plan.targetSubreddits.map((c) => bareSubreddit(c.name))),
          searchKeywords: uniqueStrings(plan.searchKeywords),
          offLimitsTopics: plan.offLimitsTopics,
          voiceNotes: plan.voiceNotes,
          disclosureLine: plan.disclosureLine,
          source: "auto-derived",
          autoDerived: true,
        };
      } else {
        throw new WorkflowBlockedIntake(
          "client has not configured any target subreddits, no Reddit charter is on file, and auto-setup could not derive one — " +
            `${autoSetup.note}. Fill in the Reddit setup form (target communities) for this client, or re-run once the client's profile and knowledge base are synced.`,
        );
      }
      if (charter.targetSubreddits.length === 0) {
        throw new WorkflowBlockedIntake("the Reddit charter names no usable communities");
      }

      const brandOutcome = await tools["client.getBrand"]!.execute({}, { ctx });
      if (brandOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client brand guidelines have not been set up yet");
      }
      return {
        forbiddenTopics: uniqueStrings([...readForbiddenTopics(clientConfig), ...charter.offLimitsTopics]),
        charter,
        ...(runScoped["requestedTopic"] !== undefined ? { requestedTopic: runScoped["requestedTopic"] } : {}),
        ...(runScoped["requestedSubreddit"] !== undefined ? { requestedSubreddit: runScoped["requestedSubreddit"] } : {}),
        ...(runScoped["requestedThreadUrl"] !== undefined ? { requestedThreadUrl: runScoped["requestedThreadUrl"] } : {}),
        ...(runScoped["requestedThreadTitle"] !== undefined ? { requestedThreadTitle: runScoped["requestedThreadTitle"] } : {}),
      };
    });

    // ── The read side of the feedback flywheel and the anti-repetition window ──
    const pastFeedback = await readPastFeedback(wf, tools, ctx, "04d-read-past-feedback");
    const outputHistory = await readOutputHistoryForDedup(wf, tools, ctx, "reddit-agent", "04e-read-output-history");
    const recentPostsDirective = dedupeDirective(outputHistory);

    /*
     * ── 05: discover live threads — the step this product never had ──
     *
     * A person who named a thread has already done the finding, so a
     * `requestedThreadUrl` skips the scan entirely. Otherwise every target
     * community's newest threads are read and ranked against the keywords the
     * charter, the run brief and the client's own config supply. Threads
     * already answered for this client are dropped before ranking.
     */
    const discovery = await wf.step.code("05-discover-threads", async (): Promise<RedditDiscovery> => {
      const keywords = uniqueStrings([
        runDirection.topicOverride,
        intake.requestedTopic,
        ...runDirection.brief.keywords,
        ...intake.charter.searchKeywords,
        // Config keywords only when the charter has none of its own: the
        // portal's derived `targetKeywords` are often single common words.
        ...(intake.charter.searchKeywords.length === 0 ? stringList(clientConfig["targetKeywords"]) : []),
        ...stringList(clientConfig["contentPillars"]),
        typeof clientContext.profile["industry"] === "string" ? (clientContext.profile["industry"] as string) : undefined,
      ]).filter((k) => k.length >= 4 || /^[A-Z]{2,}$/.test(k));

      if (intake.requestedThreadUrl) {
        const parsed = parseRedditThreadUrl(intake.requestedThreadUrl);
        if (!parsed) {
          throw new WorkflowHeld(
            `requestedThreadUrl "${intake.requestedThreadUrl}" doesn't look like a real reddit.com thread URL (expected .../r/<subreddit>/comments/...)`,
          );
        }
        // Kept exactly as the caller typed it: it is their bookmark, and both
        // dedup checks compare the normalised form anyway.
        const candidate: RedditThreadCandidate = {
          url: intake.requestedThreadUrl.trim(),
          title: intake.requestedThreadTitle ?? intake.requestedThreadUrl,
          subreddit: parsed.subreddit,
          excerpt: "",
          keywordHits: [],
          looksLikeQuestion: false,
          source: "reddit-feed",
        };
        return { mode: "requested", candidates: [candidate], scanned: [], filteredOut: 0, keywords };
      }

      const subreddits = intake.requestedSubreddit ? [bareSubreddit(intake.requestedSubreddit)] : intake.charter.targetSubreddits;
      const answeredUrls = recentDecisions.flatMap((d) => d.match(/https?:\/\/\S*reddit\.com\/r\/[A-Za-z0-9_]+\/comments\/\S+/g) ?? []);
      const outcome = await tools["reddit.discoverThreads"]!.execute(
        { subreddits, keywords, excludeUrls: answeredUrls, maxAgeDays: THREAD_MAX_AGE_DAYS, maxCandidates: SCOUT_CANDIDATE_LIMIT },
        { ctx },
      );
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`reddit.discoverThreads: ${outcome.status}${"reason" in outcome ? ` — ${outcome.reason}` : ""}`);
      }
      const result = outcome.result as DiscoverThreadsResult;
      const reachable = result.scanned.filter((s) => s.source !== "failed");
      if (reachable.length === 0) {
        // Every community failed to load and none was reported missing: that
        // is an outage (Reddit, network, scraper), not an empty week.
        const allMissing = result.scanned.every((s) => s.notFound);
        if (!allMissing) {
          throw new WorkflowToolingFailure(
            `could not read any target community: ${result.scanned.map((s) => `r/${s.subreddit} (${s.error ?? "unknown"})`).join("; ")}`,
          );
        }
      }
      return { ...result, mode: "scanned", keywords };
    });

    // ── 05a: self-heal an auto-derived charter whose planner guessed a community that does not exist ──
    if (intake.charter.autoDerived && discovery.scanned.some((s) => s.notFound)) {
      await wf.step.code("05a-prune-missing-communities", () =>
        pruneAutoDerivedSubreddits(
          setupArgs,
          discovery.scanned.filter((s) => s.notFound).map((s) => s.subreddit),
        ),
      );
    }

    /*
     * ── 06: the scout — choose the one thread, or decline ──
     *
     * Model judgment, bounded by code: the chosen URL must be one of the
     * candidates verbatim, so no thread can be invented. `selected: null` is
     * an honest, expected answer and holds the run on the scout's own reason.
     */
    const selectedThread = await (async (): Promise<RedditSelectedThread> => {
      if (discovery.mode === "requested") {
        const only = discovery.candidates[0]!;
        return await wf.step.code("07-select-target-thread", () => ({
          targetThreadUrl: only.url,
          targetThreadTitle: only.title,
          targetSubreddit: only.subreddit,
          selectedBy: "requested" as const,
        }));
      }

      if (discovery.candidates.length === 0) {
        const where = discovery.scanned.map((s) => `r/${s.subreddit}`).join(", ");
        const missing = discovery.scanned.filter((s) => s.notFound).map((s) => `r/${s.subreddit}`);
        throw new WorkflowHeld(
          `no fresh threads found in ${where || "the target communities"} in the last ${THREAD_MAX_AGE_DAYS} days` +
            (discovery.filteredOut > 0 ? ` (${discovery.filteredOut} thread(s) were older than that or already answered)` : "") +
            (missing.length > 0 ? `; ${missing.join(", ")} do not exist or are not readable` : "") +
            " — nothing to reply to this run",
        );
      }

      const scout = new RedditThreadScoutAgent({ router: options.router, tools, promptStore: options.promptStore });
      const candidateUrls = new Set(discovery.candidates.map((c) => c.url));
      const recentlyAnswered = recentDecisions.slice(-15);
      let steer: string | undefined;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const stepId = attempt === 1 ? "06-scout-thread" : `06-scout-thread-attempt-${attempt}`;
        const result = await wf.step.agent(stepId, scout, {
          ...runDirectionField(runDirection),
          candidates: discovery.candidates,
          ...(clientVoiceContext !== undefined ? { clientVoiceContext } : {}),
          ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
          charter: {
            targetSubreddits: intake.charter.targetSubreddits,
            searchKeywords: intake.charter.searchKeywords,
            offLimitsTopics: intake.charter.offLimitsTopics,
            ...(intake.charter.voiceNotes ? { voiceNotes: intake.charter.voiceNotes } : {}),
          },
          recentlyAnswered,
          ...(steer !== undefined ? { correction: steer } : {}),
        });
        if (result.status !== "completed" || !result.finalOutput) {
          throw new WorkflowToolingFailure(`thread scout resolved to "${result.status}"`);
        }
        const verdict: RedditThreadScoutOutput = result.finalOutput;
        if (verdict.selected === null) {
          throw new WorkflowHeld(
            `the thread scout found nothing worth replying to this run: ${verdict.passReason ?? "no candidate passed"} ` +
              `(${discovery.candidates.length} candidate(s) across ${discovery.scanned.map((s) => `r/${s.subreddit}`).join(", ")})`,
          );
        }
        const chosenUrl = normalizeThreadUrl(verdict.selected.url);
        const match = discovery.candidates.find((c) => c.url === chosenUrl) ?? discovery.candidates.find((c) => verdict.selected!.url.includes(c.url));
        if (!match || !candidateUrls.has(match.url)) {
          steer = `Your previous answer named "${verdict.selected.url}", which is not one of the candidate URLs. Choose a candidate URL verbatim, or decline with selected: null.`;
          continue;
        }
        return await wf.step.code("07-select-target-thread", () => ({
          targetThreadUrl: match.url,
          targetThreadTitle: match.title,
          targetSubreddit: match.subreddit,
          selectedBy: "scout" as const,
          scoutBrief: { ...verdict.selected!, url: match.url },
        }));
      }
      throw new WorkflowHeld("the thread scout twice named a thread that was not among the candidates — nothing honestly cleared selection");
    })();

    // ── 08: read the thread — the poster's full text and the existing replies ──
    const thread = await wf.step.code("08-fetch-thread", async (): Promise<RedditThreadContext> => {
      const outcome = await tools["reddit.fetchThread"]!.execute({ url: selectedThread.targetThreadUrl, maxComments: THREAD_COMMENT_LIMIT }, { ctx });
      if (outcome.status === "success") {
        const fetched = outcome.result as FetchThreadResult;
        // A caller-supplied title wins over the feed's only when the caller
        // gave one; otherwise the thread's own title is the truth.
        return selectedThread.selectedBy === "requested" && intake.requestedThreadTitle ? { ...fetched, title: intake.requestedThreadTitle } : fetched;
      }
      // Best-effort: a thread that cannot be read still has a title (from the
      // feed scan or the caller). The draft is told it knows less than usual.
      return {
        url: selectedThread.targetThreadUrl,
        title: selectedThread.targetThreadTitle,
        subreddit: selectedThread.targetSubreddit,
        body: "",
        comments: [],
        source: "unavailable",
        note: `the thread could not be read (${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""}); only its title is known`,
      };
    });
    const targetThreadTitle = thread.title || selectedThread.targetThreadTitle;

    // ── 09: thread-level dedup — never two replies to one thread (reddit-craft.md §6.6) ──
    await wf.step.code("09-check-thread-not-answered", async () => {
      const outcome = await tools["memory.read"]!.execute({ scope: "decisions" }, { ctx });
      if (outcome.status !== "success") {
        return { checked: false };
      }
      const result = outcome.result as { scope: string; items: Array<{ summary: string }> };
      // Step 21 records the target thread URL verbatim inside the decision summary
      // it appends — a real, working substring check against this client's own
      // history. Both spellings are checked because older decisions recorded
      // the URL exactly as the caller typed it.
      const needle = normalizeThreadUrl(selectedThread.targetThreadUrl);
      const alreadyAnswered = result.items.some((item) => item.summary.includes(selectedThread.targetThreadUrl) || item.summary.includes(needle));
      if (alreadyAnswered) {
        throw new WorkflowHeld(
          `thread ${selectedThread.targetThreadUrl} was already answered in a prior run for this client — never two replies to one thread from any account (reddit-craft.md §6.6)`,
        );
      }
      return { checked: true, priorDecisionCount: result.items.length };
    });

    // ── 10: subreddit eligibility — never even draft for an off-limits, AI-content-banned, or below-gate subreddit ──
    const subredditRulesLookup = await wf.step.code("10-verify-subreddit-eligibility", async () => {
      const outcome = await tools["client.getSubredditRules"]!.execute({ subreddit: selectedThread.targetSubreddit }, { ctx });
      const rules =
        outcome.status === "success"
          ? (outcome.result as {
              configStatus: "configured" | "unconfigured";
              offLimits: boolean;
              aiContentBanned: boolean;
              disclosureRequired: boolean;
              requiredDisclosure?: string;
              minKarma?: number;
              minAccountAgeDays?: number;
              mentionCooldownDays?: number;
              lastMentionAt?: string;
              accountWarmingUntil?: string;
            })
          : { configStatus: "unconfigured" as const, offLimits: false, aiContentBanned: false, disclosureRequired: false };
      // Disclosure/mention depends on the draft's own text, which doesn't exist yet
      // at this pre-draft point — re-checked at step 14 once real text exists.
      const verdict = await runGate(
        tools,
        "gate.subredditRules",
        { text: "", subreddit: selectedThread.targetSubreddit, ...rules, disclosureRequired: false, mentionAttempted: false },
        ctx,
      );
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.subredditRules: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`subreddit eligibility check failed: ${verdict.reason}`);
      return rules;
    });

    /*
     * ── 11: research FOR the thread ──
     *
     * The thread's question is the query. Before this, research ran on
     * "<industry> community discussion trends" before any thread existed, and
     * its only use was to pick a "topic" the reply then had to steer toward
     * regardless of what the thread asked. Now the documents exist to
     * support the answer, and their text is what `gate.numbersSourced`
     * verifies figures against.
     *
     * Best-effort: a reply rests on the thread and the client's own knowledge
     * first. No scraper, or an outage, degrades to "no external claims" rather
     * than failing a run that can answer perfectly well from the thread.
     */
    const research = await wf.step.code("11-research-pull", async (): Promise<ResearchPullResult | null> => {
      const hits = selectedThread.scoutBrief?.whatToAdd.slice(0, 2) ?? [];
      const query = uniqueStrings([targetThreadTitle, ...hits]).join(" ").slice(0, 200);
      const outcome = await tools["research.pull"]!.execute(
        { job: "reddit-thread-research", query, window: "7d", maxResults: 5, historyAgentId: "reddit-agent" },
        { ctx },
      );
      // JSON round-trip note: `null`, never `undefined`, crosses the checkpoint.
      return outcome.status === "success" ? (outcome.result as ResearchPullResult) : null;
    });
    const researchDigest = research ? researchDigestForDrafting(research, { maxDocuments: 5, maxExcerptChars: 2_000 }) : undefined;

    const angle = await wf.step.code("11a-determine-angle", (): string => selectedThread.scoutBrief?.angle ?? "thorough-value");
    const topic = targetThreadTitle;

    // ── 12-17: draft execution via RedditDraftAgent, with the full gate stack ──
    const draftAgent = new RedditDraftAgent({ router: options.router, tools, promptStore: options.promptStore });
    /**
     * One full drafting pass: draft, every deterministic content gate, then
     * the terminal topic guardrail. Called once per REVISION round by
     * `runReviewCycle`; `revision` is folded into every checkpointed step id
     * inside it so a second round genuinely re-drafts, while everything
     * OUTSIDE it (intake, discovery, the thread read, research) keeps its id
     * and is reused.
     */
    const draftOnce = async (revision: number, notes: readonly RevisionNote[]) => {
      const rev = (id: string) => (revision === 0 ? id : `${id}-r${revision}`);
      const directive = revisionDirective(notes);

      // ── 12/12a: draft, then VERIFY it is not a repeat, before anything else ──
      const draftWithVerifiedDedupe = async () => {
        let dedupeRetrySteer: string | undefined;
        for (let attempt = 1; attempt <= MAX_DEDUPE_ATTEMPTS; attempt++) {
          const att = (id: string) => (attempt === 1 ? id : `${id}-attempt-${attempt}`);
          const draftResult = await wf.step.agent(rev(att("12-draft-reply")), draftAgent, {
            ...runDirectionField(runDirection),
            topic,
            angle,
            targetThreadUrl: selectedThread.targetThreadUrl,
            targetThreadTitle,
            targetSubreddit: selectedThread.targetSubreddit,
            // The thread itself: the poster's words and what has already been
            // said. This is the single biggest input to a reply worth posting.
            thread: {
              url: thread.url,
              title: targetThreadTitle,
              subreddit: thread.subreddit,
              ...("author" in thread && thread.author ? { author: thread.author } : {}),
              ...("postedAt" in thread && thread.postedAt ? { postedAt: thread.postedAt } : {}),
              body: thread.body,
              comments: thread.comments.map((c) => ({ ...(c.author ? { author: c.author } : {}), body: c.body })),
              // How the thread was read: `reddit-feed` (post + replies),
              // `scraper` (post only), `unavailable` (title only).
              source: thread.source,
              ...(thread.note ? { note: thread.note } : {}),
            },
            ...(selectedThread.scoutBrief ? { scoutBrief: selectedThread.scoutBrief } : {}),
            charter: {
              ...(intake.charter.voiceNotes ? { voiceNotes: intake.charter.voiceNotes } : {}),
              ...(intake.charter.disclosureLine ? { disclosureLine: intake.charter.disclosureLine } : {}),
              offLimitsTopics: intake.charter.offLimitsTopics,
            },
            ...(researchDigest !== undefined
              ? { research: researchDigest }
              : { researchNote: "no external research was available for this run: make no factual claims beyond the thread and the client's own knowledge" }),
            voiceRules: clientContext.voiceRules,
            ...(clientVoiceContext !== undefined ? { clientVoiceContext } : {}),
            ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
            ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
            ...(dedupeRetrySteer !== undefined ? { dedupeAvoid: dedupeRetrySteer } : {}),
            ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
            ...(directive !== undefined ? { revisionRequest: directive } : {}),
          });

          if (draftResult.status === "content_fail") {
            throw new WorkflowHeld(`draft did not clear its own self-critique gate: ${draftResult.status}`);
          }
          if (draftResult.status !== "completed") {
            throw new WorkflowToolingFailure(`draft step resolved to "${draftResult.status}"`);
          }
          const candidate = draftResult.finalOutput!;

          const dedupeVerdict = await checkOutputDedupe(wf, rev(att("12a-verify-not-duplicate")), candidate.text, outputHistory);
          if (dedupeVerdict.status === "similar" && attempt < MAX_DEDUPE_ATTEMPTS) {
            dedupeRetrySteer = dedupeRetryDirective(dedupeVerdict, outputHistory);
            continue;
          }
          return candidate;
        }
        throw new WorkflowToolingFailure("the de-duplication redraft loop ended without a draft");
      };
      const draft = await draftWithVerifiedDedupe();

      await wf.step.code(rev("13-verify-numbers-sourced"), async () => {
        // Source CONTENT, never URLs: the thread's own text (a figure the poster
        // stated is sourced), the client's own knowledge, and the research
        // documents' text. Handing this gate a URL verified nothing and held
        // every faithfully quoted number.
        const sources = [
          thread.body,
          ...thread.comments.map((c) => c.body),
          ...(clientIntelContext !== undefined ? [clientIntelContext] : []),
          ...(research ? researchSourceTexts(research) : []),
        ].filter((s) => s.trim().length > 0);
        const verdict = await runGate(tools, "gate.numbersSourced", { text: draft.text, sources }, ctx);
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.numbersSourced: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") throw new WorkflowHeld(`numbers not sourced: ${verdict.reason}`);
        return verdict;
      });

      await wf.step.code(rev("14-verify-brand-compliance"), async () => {
        const forbiddenTerms = clientContext.brand["forbiddenTerms"] as string[] | undefined;
        const brandVerdict = await runGate(tools, "gate.brandCompliance", { text: draft.text, forbiddenTerms: forbiddenTerms ?? [] }, ctx);
        if (brandVerdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.brandCompliance: ${brandVerdict.reason}`);
        if (brandVerdict.verdict === "content_fail") throw new WorkflowHeld(`brand compliance failed: ${brandVerdict.reason}`);

        // Disclosure/warming/cooldown are the subreddit-rules checks that need real
        // draft text — re-run now that it exists, reusing step 10's lookup.
        const disclosureVerdict = await runGate(
          tools,
          "gate.subredditRules",
          {
            text: draft.text,
            subreddit: selectedThread.targetSubreddit,
            ...subredditRulesLookup,
            mentionAttempted: draft.disclosureIncluded,
            now: new Date().toISOString(),
          },
          ctx,
        );
        if (disclosureVerdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.subredditRules: ${disclosureVerdict.reason}`);
        if (disclosureVerdict.verdict === "content_fail") throw new WorkflowHeld(`subreddit mention/disclosure check failed: ${disclosureVerdict.reason}`);

        return { brandVerdict, disclosureVerdict };
      });

      await wf.step.code(rev("15-verify-no-placeholder"), async () => {
        const verdict = await runGate(tools, "gate.noPlaceholder", { text: draft.text }, ctx);
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.noPlaceholder: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") throw new WorkflowHeld(`unresolved placeholder left in draft: ${verdict.reason}`);
        return verdict;
      });

      await wf.step.code(rev("16-verify-leak-check"), async () => {
        const verdict = await runGate(tools, "gate.leakCheck", { text: draft.text }, ctx);
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.leakCheck: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") throw new WorkflowHeld(`draft appears to leak a credential, path, or internal-only term: ${verdict.reason}`);
        return verdict;
      });

      await wf.step.code(rev("17-render-preview-check"), async () => {
        const outcome = await tools["render.preview"]!.execute({ text: draft.text }, { ctx });
        if (outcome.status !== "success") throw new WorkflowToolingFailure(`render.preview failed: ${outcome.status}`);
        const preview = outcome.result as RenderPreviewResult;
        if (!preview.withinLimit) {
          throw new WorkflowHeld(`reply exceeds Reddit's 10000-character comment limit (${preview.characterCount} chars)`);
        }
        return preview;
      });

      // ── terminal topic guardrail: a reviewer is never shown a draft on a subject this client does not touch ──
      await runTopicGuardrail(wf, { tools, promptStore: options.promptStore, router: options.router }, draft.text, intake.forbiddenTopics, revision === 0 ? undefined : `-r${revision}`);

      return draft;
    };

    // ── 18: the universal approve / revise / reject cycle ──
    const review = await runReviewCycle(wf, {
      gateId: "18-batch-review",
      maxRevisions: MAX_REVISION_ROUNDS,
      ...(options.autoApprove ? { autoApprove: true } : {}),
      attempt: draftOnce,
      buildGate: (draft, revision) => ({
        kind: "batch_review",
        payload: {
          runId: wf.runId,
          topic,
          angle,
          targetThreadUrl: selectedThread.targetThreadUrl,
          targetThreadTitle,
          targetSubreddit: selectedThread.targetSubreddit,
          ...(selectedThread.scoutBrief ? { whyThisThread: selectedThread.scoutBrief.why } : {}),
          preview: draft.text,
          revision,
        },
        requiredRole: "account_manager",
        timeout: { duration: "24h", onTimeout: "hold" },
      }),
      onDecision: async ({ revision, response, output }) => {
        await persistReviewFeedbackToMemory(wf, tools, ctx, revision, response, response.decision === "reject" ? JSON.stringify(output) : undefined);
      },
    });
    const draft = review.output;

    // ── 19-20: deliverable & manifest persistence ──
    const redditUsername = clientContext.profile["redditUsername"];
    const draftsEnvelope = renderRedditDraftsEnvelope({
      ...(typeof redditUsername === "string" ? { account: redditUsername } : {}),
      targetThreadUrl: selectedThread.targetThreadUrl,
      targetThreadTitle,
      targetSubreddit: selectedThread.targetSubreddit,
      draft,
    });
    const deliverableId = await finalizeDeliverable(wf, tools, ctx, {
      persistDeliverableStepId: "19-persist-deliverable",
      persistManifestStepId: "20-persist-manifest",
      kind: "reddit-reply",
      deliverable: {
        ...draft,
        draftsEnvelope,
        ...(selectedThread.scoutBrief ? { whyThisThread: selectedThread.scoutBrief.why, whatToAdd: selectedThread.scoutBrief.whatToAdd } : {}),
        threadSource: thread.source,
        charterSource: intake.charter.source,
      },
      snapshot: (id) => ({
        topic,
        angle,
        targetThreadUrl: selectedThread.targetThreadUrl,
        targetSubreddit: selectedThread.targetSubreddit,
        selectedBy: selectedThread.selectedBy,
        charterSource: intake.charter.source,
        deliverableId: id,
      }),
    });

    // ── 21: commit updates (memory.appendDecision + the anti-repetition window) ──
    await wf.step.code("21-commit-and-record", async () => {
      // The write half of the anti-repetition loop: the shipped reply joins this
      // agent's rolling excerpt window, read back on every future run.
      // Best-effort: losing an excerpt costs future dedup signal, never the reply.
      await recordOutputExcerpt(tools, ctx, wf.runId, "reddit-agent", draft.text);
      // The target thread URL is recorded verbatim — step 09 and step 05's
      // exclusion list read it back with a plain substring search.
      await tools["memory.appendDecision"]!.execute(
        {
          decisionId: `${wf.runId}__decision`,
          summary: `Replied to thread ${selectedThread.targetThreadUrl} in r/${selectedThread.targetSubreddit} (thread: "${targetThreadTitle}", angle: ${angle}, chosen by ${selectedThread.selectedBy})`,
        },
        { ctx },
      );
    });

    return {
      targetThreadUrl: selectedThread.targetThreadUrl,
      targetSubreddit: selectedThread.targetSubreddit,
      topic,
      angle,
      deliverableId,
      preview: draft.text,
    };
  };
}
