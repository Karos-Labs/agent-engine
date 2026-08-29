import { readForbiddenTopics } from "@agent-engine/core";
import type { AgentContext, AgentToolRegistry, GateResponse, ModelRouter, PromptStore } from "@agent-engine/core";
import { runRedditChannelSetup, type RedditChannelSetupOutcome } from "@agent-engine/agent-setup";
import { type WorkflowContext, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure, runTopicGuardrail, extractResearchCandidate, type ResearchPullResult, readRunDirection, runDirectionField, type RevisionNote, MAX_REVISION_ROUNDS, persistReviewFeedbackToMemory, readPastFeedback, revisionDirective, runReviewCycle, buildClientVoiceContext, readOutputHistoryForDedup, dedupeDirective, readClientIntelContext, toAgentContext, runGate, finalizeDeliverable, recordOutputExcerpt} from "@agent-engine/workflow";
import { RedditDraftAgent } from "../agent/reddit-draft-agent.js";
import { renderPreview, type RenderPreviewResult } from "../tools/render-preview.js";
import { renderRedditDraftsEnvelope } from "./render-drafts-envelope.js";
import type {
  RedditAgentWorkflowResult,
  RedditCandidateSummary,
  RedditClientContext,
  RedditIntakeConfig,
  RedditSelectedCandidate,
  RedditSelectedThread,
  RedditTopicReservation,
} from "./types.js";

export interface CreateRedditAgentWorkflowOptions {
  /** The base Layer 3 registry (karos-client/research/topics/gates/ledger/memory) — `render.preview` is merged in internally. */
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips step 18's human `batch_review` gate and records a synthetic
   * `actor: "system"` approval instead — off by default, so a real run
   * genuinely pauses at `awaiting_gate` until a human reviews it (RFC-01
   * §8.3). Intended for tests/demos/evals that need a synchronous happy
   * path, never for production wiring.
   */
  autoApprove?: boolean;
}

/**
 * Matches a real Reddit thread URL and captures its subreddit — deliberately
 * requires the `/comments/` segment (not just any reddit.com path) so this
 * never mistakes a profile, a subreddit-front-page, or a search-results URL
 * for an actual thread. A mechanical string parse, never a guess: nothing
 * here fabricates a subreddit name that isn't literally in the URL.
 */
const REDDIT_THREAD_URL_PATTERN = /^https?:\/\/(?:www\.|old\.|new\.|m\.)?reddit\.com\/r\/([A-Za-z0-9_]+)\/comments\/\S+/i;

function parseSubredditFromThreadUrl(url: string): string | undefined {
  return REDDIT_THREAD_URL_PATTERN.exec(url.trim())?.[1];
}


/**
 * `createRedditAgentWorkflow()` — Phase 2.5 Batch 2.1's domain-logic
 * restoration: the reply-only run protocol, steps `00`-`21`. Legacy's
 * non-negotiable rule is "comments only, never original posts"
 * (`reddit-agent-v2/SKILL.md` line 9; `references/reddit-craft.md` §1: "We
 * do not start threads") — the pre-restoration workflow drafted an original
 * submission (title/body/targetSubreddit/flair) into a target subreddit it
 * picked itself, the exact opposite of the legacy model. This version:
 *
 * - Selects an existing thread to reply to (step 08) rather than picking a
 *   subreddit to post into — and, since Phase 1 has no live thread-discovery
 *   backend (see step 08's own comment), that selection can only come from
 *   an explicit client-supplied candidate. A run with no such candidate is
 *   honestly `held`, exactly like a run with no candidate topic was already
 *   `held` before this batch.
 * - Deduplicates on the target thread's URL (step 09), a real, working
 *   check against this client's own decision history — legacy's
 *   `answered_thread_urls` (`run-protocol.md` §11), simplified to the tools
 *   this codebase already wires into every agent (`memory.read`/
 *   `memory.appendDecision`) instead of a bespoke ledger file.
 * - Extends the pre-draft subreddit eligibility gate (step 10) and the
 *   post-draft recheck (step 14) with the account warming/mention-cooldown
 *   checks `gate.subredditRules` now supports.
 * - Runs `gate.noPlaceholder` and `gate.leakCheck` as real workflow steps
 *   (15, 16) for the first time — both gates existed in `karos-gates`
 *   already but, before this batch, were only ever exercised by `evals/`,
 *   never called at runtime.
 *
 * Step 18 is a mandatory human `batch_review` gate (RFC-01 §8.3) unless
 * `options.autoApprove` opts out.
 */
export function createRedditAgentWorkflow(options: CreateRedditAgentWorkflowOptions) {
  const tools: AgentToolRegistry = { ...options.tools, "render.preview": renderPreview };

  return async function redditAgentWorkflow(wf: WorkflowContext): Promise<RedditAgentWorkflowResult> {
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
     * `reddit-setup-agent` used to be a separate product, and inlining it fixed
     * a gap that was worse than the sequencing: THE DRAFTING AGENT NEVER READ
     * WHAT SETUP WROTE. Setup stored `strategy/reddit-agent/config`; the intake
     * check below has only ever read `client.getConfig`. So a client could run
     * setup, see it succeed, and still have every Reddit run block on "has not
     * configured any target subreddits yet".
     *
     * The allowlist now travels as data on the charter rather than only as
     * prose inside it, and the intake check below falls back to it. Setup is
     * still not a substitute for client config — config wins when both exist —
     * but a recorded charter is no longer a document nothing consults.
     *
     * Draft-only is unaffected. This records where a human may later post from
     * their own account; it grants no posting capability, and none exists.
     */
    const channelSetup: RedditChannelSetupOutcome = await wf.step.code("00-channel-setup", () =>
      runRedditChannelSetup({ tools, ctx, runId: wf.runId, clientSlug: wf.clientSlug, input: wf.input ?? {} }),
    );

    // ── 00: intake check — blocked_intake if target subreddits or brand guidelines are missing ──
    const intake = await wf.step.code("00-intake-check", async (): Promise<RedditIntakeConfig> => {
      const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
      if (configOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client config is not available yet — cannot determine target subreddits");
      }
      // This run's own request layered over the client's standing config --
      // "the customer's run request wins". Only run-scoped keys are overlaid:
      // targetSubreddits is client configuration, and letting a job payload
      // rewrite which subreddits an account posts into would be a tenancy hole,
      // not a feature.
      const runScoped: Record<string, unknown> = {};
      for (const key of ["requestedTopic", "requestedSubreddit", "requestedThreadUrl", "requestedThreadTitle"] as const) {
        const value = wf.input[key];
        if (typeof value === "string" && value.trim().length > 0) runScoped[key] = value.trim();
      }
      const config = { ...(configOutcome.result as Record<string, unknown>), ...runScoped } as {
        targetSubreddits?: string[];
        requestedTopic?: string;
        requestedSubreddit?: string;
        requestedThreadUrl?: string;
        requestedThreadTitle?: string;
      };
      // Client config first, the recorded charter second. Config is the
      // standing tenant configuration and outranks a form; the charter is what
      // makes an onboarded-but-not-yet-configured client able to run at all.
      const targetSubreddits =
        config.targetSubreddits && config.targetSubreddits.length > 0
          ? config.targetSubreddits
          : channelSetup.targetSubreddits;
      if (targetSubreddits.length === 0) {
        throw new WorkflowBlockedIntake(
          "client has not configured any target subreddits yet, and no Reddit charter is on file — " +
            `${channelSetup.note}`,
        );
      }
      const brandOutcome = await tools["client.getBrand"]!.execute({}, { ctx });
      if (brandOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client brand guidelines have not been set up yet");
      }
      return {
        // Same read that produced the rest of this object, so the terminal
        // guardrail below costs no extra step.
        forbiddenTopics: readForbiddenTopics(configOutcome.result),
        // The resolved list, not `config.targetSubreddits`: it may have come
        // from the charter rather than from client config, and the difference
        // stops mattering past this point.
        targetSubreddits,
        ...(config.requestedTopic !== undefined ? { requestedTopic: config.requestedTopic } : {}),
        ...(config.requestedSubreddit !== undefined ? { requestedSubreddit: config.requestedSubreddit } : {}),
        ...(config.requestedThreadUrl !== undefined ? { requestedThreadUrl: config.requestedThreadUrl } : {}),
        ...(config.requestedThreadTitle !== undefined ? { requestedThreadTitle: config.requestedThreadTitle } : {}),
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
      const outcome = await tools["research.pull"]!.execute(
        {
          job: "reddit-community-scan",
          query,
          window: "3d",
          // Anti-repetition context: this agent's own prior deliverables, so
          // the extraction below can steer off a subject already covered.
          historyAgentId: "reddit-agent",
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

    const candidateSummary = await wf.step.code("05-extract-candidate-summary", (): RedditCandidateSummary =>
      // Shared with every other publishing agent (`extractResearchCandidate`).
      // This step used to return the QUERY as the topic, on the grounds that
      // research.pull was a stand-in with nothing to extract -- accurate when
      // written, false since the scraper landed, and the same stale comment
      // was sitting in five agents at once. One implementation now.
      extractResearchCandidate(research, { avoidTopics: recentDecisions }),
    );

    // ── 06-07: recurring-question-pattern / angle-context selection ──
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
      // Recurring-question-pattern selection precedence (legacy's "recurring question
      // pool", subreddit-sourcing.md §3): an explicit client request wins, then a
      // reserved catalog pattern, then the research-derived fallback. This is context
      // for the draft's angle, not the target thread — that's step 08, entirely separate.
      // Highest precedence, above an explicit requestedTopic's own branch
      // below only when that is absent: a typed instruction is this run's
      // most specific statement of intent.
      if (runDirection.topicOverride) {
        return { topic: runDirection.topicOverride, source: "requested" };
      }
      if (intake.requestedTopic) {
        return { topic: intake.requestedTopic, source: "requested" };
      }
      if (reservation.topics.length > 0) {
        return { topic: reservation.topics[0]!, source: "reserved" };
      }
      if (candidateSummary.candidateTopic) {
        return { topic: candidateSummary.candidateTopic, source: "research" };
      }
      throw new WorkflowHeld("no candidate question-pattern available for this run — nothing honestly cleared selection");
    });

    // ── 08: select the target thread — the reply-only model's central selection step ──
    const selectedThread = await wf.step.code("08-select-target-thread", (): RedditSelectedThread => {
      // Legacy's real value is here: "finding the right thread is the expensive
      // skill; writing the reply is nearly free" (reddit-agent-v2 SKILL.md). Finding
      // one means scanning subreddit RSS feeds / the Reddit API for live threads
      // worth replying to — exactly the kind of external-service integration
      // research.pull itself stands in for above (step 04/05's comment), and
      // building it is out of scope for Phase 1. So the only honest source of a
      // target thread today is an explicit client-supplied candidate through
      // intake — never a URL synthesized from a query string. A run with no such
      // candidate is held, not forced through with a fabricated thread.
      if (!intake.requestedThreadUrl || !intake.requestedThreadTitle) {
        throw new WorkflowHeld(
          "no target thread available for this run — Phase 1 has no live thread-discovery backend (RSS/API scanning is out of scope, see step 08's own comment); supply requestedThreadUrl + requestedThreadTitle via client intake to reply to a specific thread",
        );
      }
      const targetSubreddit = parseSubredditFromThreadUrl(intake.requestedThreadUrl);
      if (!targetSubreddit) {
        throw new WorkflowHeld(
          `requestedThreadUrl "${intake.requestedThreadUrl}" doesn't look like a real reddit.com thread URL (expected .../r/<subreddit>/comments/...)`,
        );
      }
      return { targetThreadUrl: intake.requestedThreadUrl, targetThreadTitle: intake.requestedThreadTitle, targetSubreddit };
    });

    // ── 09: thread-level dedup — never two replies to one thread (reddit-craft.md §6.6) ──
    await wf.step.code("09-check-thread-not-answered", async () => {
      const outcome = await tools["memory.read"]!.execute({ scope: "decisions" }, { ctx });
      if (outcome.status !== "success") {
        return { checked: false };
      }
      const result = outcome.result as { scope: string; items: Array<{ summary: string }> };
      // Step 21 records the target thread URL verbatim inside the decision summary
      // it appends — a real, working substring check against this client's own
      // history, not a stub. Simplified from legacy's bespoke `answered_thread_urls`
      // ledger (`run-protocol.md` §11) to the memory tools this codebase already
      // wires into every agent.
      const alreadyAnswered = result.items.some((item) => item.summary.includes(selectedThread.targetThreadUrl));
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
      // at this pre-draft point — re-checked at step 14 once real text exists, where
      // mentionAttempted is derived from the draft's own disclosureIncluded flag.
      // Karma, account age, the legacy warming period, and the per-subreddit mention
      // cooldown are all Phase-1-stubbed pending real account-state storage (no live
      // karma, no live warming history, no live mention ledger) — an unset
      // threshold/value means "cannot check," not "assume it fails" (gate.subredditRules'
      // own contract). The CHECK LOGIC itself is real: a client that does configure
      // these fields on client.getSubredditRules gets them genuinely enforced, both
      // here and at step 14, exactly as the gate's own fixture-driven tests prove.
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

    // ── 11: angle — the reply-shape taxonomy (reddit-answer-formulas.md §Formula menu) ──
    const angle = await wf.step.code("11-determine-angle", (): string => {
      // A deterministic starting hint, not a hard rule — reddit-craft@2 names all
      // four shapes (thorough value, personal experience, comparison/decision-help,
      // correction-with-receipts) and the model picks whichever the thread's actual
      // angle calls for. This just seeds the more common of the two data-agnostic
      // defaults.
      return candidateSummary.hasNumericInsight ? "thorough-value" : "personal-experience";
    });
    // ── The read side of the feedback flywheel: what this client asked
    //    for on previous runs, injected into the drafting prompt. Bounded
    //    and best-effort — a memory read failing must not stop a run that
    //    can draft perfectly well without it.
    const pastFeedback = await readPastFeedback(wf, tools, ctx, "04e-read-past-feedback");
    // The anti-repetition read: what this agent already SHIPPED for this
    // client (the excerpt window the commit step below writes back into),
    // formatted as a hard do-not-repeat directive for the draft. Distinct
    // from pastFeedback (what a person SAID about past drafts) the same way
    // decisions are distinct from feedback.
    const outputHistory = await readOutputHistoryForDedup(wf, tools, ctx, "reddit-agent", "read-output-history");
    const recentPostsDirective = dedupeDirective(outputHistory);
    // The client intel report, distilled to what steers copy (voice rows,
    // positioning, whitespace opportunities) — intel.getReport has been in
    // every agent registry since the intel agent shipped, with zero
    // channel-agent callers until now.
    const clientIntelContext = await readClientIntelContext(wf, tools, ctx, "read-intel-context");


    // ── 12-17: draft execution via RedditDraftAgent, with the full gate stack ──
    const draftAgent = new RedditDraftAgent({ router: options.router, tools, promptStore: options.promptStore });
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

    const clientVoiceContext = buildClientVoiceContext(clientContext.profile, clientContext.voiceRules, clientContext.brand);
    const draftResult = await wf.step.agent(rev("12-draft-reply"), draftAgent, {
      ...runDirectionField(runDirection),
      topic: selected.topic,
      source: selected.source,
      angle,
      targetThreadUrl: selectedThread.targetThreadUrl,
      targetThreadTitle: selectedThread.targetThreadTitle,
      targetSubreddit: selectedThread.targetSubreddit,
      voiceRules: clientContext.voiceRules,
      // The client's own profile description + voice-rules guidelines,
      // verbatim — this is where a language requirement like Geektime's
      // "Hebrew-language technology site" actually lives.
      ...(clientVoiceContext !== undefined ? { clientVoiceContext } : {}),
      ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
      ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
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

    await wf.step.code(rev("13-verify-numbers-sourced"), async () => {
      const sources = candidateSummary.hasNumericInsight ? [candidateSummary.sourceLabel] : [];
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
      // mentionAttempted is derived from the draft's own disclosureIncluded flag:
      // Phase 1 has no account.json-style mention-name text scanner, and an
      // undisclosed mention is already rejected by the disclosure check below, so
      // "disclosed" and "mentioned" are the same event in practice today.
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

    // ── 15-16: gate.noPlaceholder / gate.leakCheck — wired into a real run for the first time ──
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

    // ── 18: human batch-review gate — nothing ships without a real approval ──
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
      gateId: "18-batch-review",
      maxRevisions: MAX_REVISION_ROUNDS,
      ...(options.autoApprove ? { autoApprove: true } : {}),
      attempt: draftOnce,
      buildGate: (draft, revision) => ({
        kind: "batch_review",
        payload: { runId: wf.runId, topic: selected.topic, angle, targetThreadUrl: selectedThread.targetThreadUrl, targetSubreddit: selectedThread.targetSubreddit, preview: draft.text, revision },
        requiredRole: "account_manager",
        timeout: { duration: "24h", onTimeout: "hold" },
      }),
      onDecision: async ({ revision, response }) => {
        await persistReviewFeedbackToMemory(wf, tools, ctx, revision, response);
      },
    });
    const draft = review.output;

    // ── 19-20: deliverable & manifest persistence ──
    // Additive: `draftsEnvelope` is the v2 JSON envelope karosCMO's
    // `reddit-drafts.ts` reader now expects on `asset.content` — the rest
    // of `draft` stays untouched for any consumer that wants raw fields.
    const redditUsername = clientContext.profile["redditUsername"];
    const draftsEnvelope = renderRedditDraftsEnvelope({
      ...(typeof redditUsername === "string" ? { account: redditUsername } : {}),
      targetThreadUrl: selectedThread.targetThreadUrl,
      targetThreadTitle: selectedThread.targetThreadTitle,
      targetSubreddit: selectedThread.targetSubreddit,
      draft,
    });
    const deliverableId = await finalizeDeliverable(wf, tools, ctx, {
      persistDeliverableStepId: "19-persist-deliverable",
      persistManifestStepId: "20-persist-manifest",
      kind: "reddit-reply",
      deliverable: { ...draft, draftsEnvelope },
      snapshot: (deliverableId) => ({
        topic: selected.topic,
        source: selected.source,
        angle,
        targetThreadUrl: selectedThread.targetThreadUrl,
        targetSubreddit: selectedThread.targetSubreddit,
        deliverableId,
      }),
    });

    // ── 21: commit updates (topics.commit, memory.appendDecision, ledger.feedbackAppend) ──
    await wf.step.code("21-commit-and-record", async () => {
      if (selected.source === "reserved" && reservation.reservationKey) {
        await tools["topics.commit"]!.execute({ reservationKey: reservation.reservationKey }, { ctx });
      }
      // The target thread URL is recorded verbatim in this summary — step 09's
      // dedup check on a future run reads it back with a plain substring search.
      // The write half of the anti-repetition loop: the shipped post joins
      // this agent's rolling excerpt window, read back by research.pull's
      // history feed and the drafting directive on every future run.
      // Best-effort: losing an excerpt costs future dedup signal, never the
      // delivered post.
      await recordOutputExcerpt(tools, ctx, wf.runId, "reddit-agent", draft.text);
      await tools["memory.appendDecision"]!.execute(
        {
          decisionId: `${wf.runId}__decision`,
          summary: `Replied to thread ${selectedThread.targetThreadUrl} in r/${selectedThread.targetSubreddit} (topic: "${selected.topic}", angle: ${angle})`,
        },
        { ctx },
      );
      await tools["ledger.feedbackAppend"]!.execute(
        { runId: wf.runId, feedbackId: `${wf.runId}__review`, decision: review.response.decision, actor: review.response.actor },
        { ctx },
      );
    });

    return {
      targetThreadUrl: selectedThread.targetThreadUrl,
      targetSubreddit: selectedThread.targetSubreddit,
      topic: selected.topic,
      angle,
      deliverableId,
      preview: draft.text,
    };
  };
}
