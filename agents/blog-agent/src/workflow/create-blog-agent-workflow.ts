import { readForbiddenTopics } from "@agent-engine/core";
import type { AgentContext, AgentToolRegistry, GateResponse, ModelRouter, PromptStore } from "@agent-engine/core";
import { type WorkflowContext, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure, runTopicGuardrail, extractResearchCandidate, type ResearchPullResult, readRunDirection, runDirectionField, type RevisionNote, MAX_REVISION_ROUNDS, persistReviewFeedbackToMemory, readPastFeedback, revisionDirective, runReviewCycle, buildClientVoiceContext, readOutputHistoryForDedup, dedupeDirective, checkOutputDedupe, dedupeRetryDirective, readClientIntelContext, toAgentContext, runGate, finalizeDeliverable, recordOutputExcerpt} from "@agent-engine/workflow";
import { BlogDraftAgent } from "../agent/blog-draft-agent.js";
import { renderPreview, BLOG_MIN_WORD_COUNT, BLOG_MAX_WORD_COUNT, type RenderPreviewResult } from "../tools/render-preview.js";
import { buildBlogJsonLd, type BlogJsonLd } from "../tools/json-ld.js";
import type {
  BlogAgentWorkflowResult,
  BlogCandidateSummary,
  BlogClientContext,
  BlogIntakeConfig,
  BlogSelectedCandidate,
  BlogTopicReservation,
} from "./types.js";

export interface CreateBlogAgentWorkflowOptions {
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

/**
 * Builds `https://{client-domain}/blog/{slug}` from the client's own
 * configured `website` field (RFC-02 §5's canonical-URL remediation) — the
 * only source of truth for the domain half, never fabricated. Returns
 * `undefined` (leaving `canonicalUrl` unset) when the client has no
 * `website` configured, or when the configured value isn't parseable as a
 * host at all; a bare hostname like `"acme.com"` and a full URL like
 * `"https://www.acme.com/"` both resolve to the same canonical URL.
 */
function deriveCanonicalUrl(website: unknown, slug: string): string | undefined {
  if (typeof website !== "string" || website.trim().length === 0) return undefined;
  const trimmed = website.trim();
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let host: string;
  try {
    host = new URL(withProtocol).host;
  } catch {
    return undefined;
  }
  if (!host) return undefined;
  return `https://${host}/blog/${slug}`;
}


/**
 * `createBlogAgentWorkflow()` (RFC-02 §5 — "same recipe" as the X,
 * LinkedIn, and Reddit pilots): the 19-step recurring/on-demand run
 * protocol, steps `00`–`18`. One article, one run (RFC-01 §16.2's ruling) —
 * no fan-out here; every blog run produces at most one deliverable. Step 15
 * is a mandatory human `batch_review` gate (RFC-01 §8.3) unless
 * `options.autoApprove` opts out. Steps 13-14 (`gate.noPlaceholder`,
 * `gate.leakCheck`) were added in the Phase 2.5 domain-logic remediation —
 * both gates existed in `packages/tools/karos-gates` since the original
 * migration but were never wired into any workflow's actual step sequence
 * (only ever exercised by `evals/src/run-assertions.ts`), so a real run
 * could ship a draft with an unresolved template placeholder or a leaked
 * credential/path with nothing ever catching it.
 */
export function createBlogAgentWorkflow(options: CreateBlogAgentWorkflowOptions) {
  const tools: AgentToolRegistry = { ...options.tools, "render.preview": renderPreview };

  return async function blogAgentWorkflow(wf: WorkflowContext): Promise<BlogAgentWorkflowResult> {
    const ctx = toAgentContext(wf);

    // The run-scoped instruction someone typed in the portal, resolved once.
    // A typed sentence outranks the topic catalog for the same reason an
    // explicit requestedTopic does: a person who wrote it has more
    // information about this run than a catalog row does. Style-only notes
    // are deliberately NOT promoted to topics -- see readRunDirection.
    const runDirection = readRunDirection(wf.input);

    // ── 00: intake check — blocked_intake if voice rules, target keywords, or content pillars are missing ──
    const intake = await wf.step.code("00-intake-check", async (): Promise<BlogIntakeConfig> => {
      const voiceRulesOutcome = await tools["client.getVoiceRules"]!.execute({}, { ctx });
      if (voiceRulesOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client has not configured voice rules yet");
      }
      const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
      if (configOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client config is not available yet — cannot determine target keywords or content pillars");
      }
      const config = configOutcome.result as {
        targetKeywords?: string[];
        contentPillars?: string[];
        requestedTopic?: string;
        requestedKeyword?: string;
      };
      if (!config.targetKeywords || config.targetKeywords.length === 0) {
        throw new WorkflowBlockedIntake("client has not configured any target keywords yet");
      }
      if (!config.contentPillars || config.contentPillars.length === 0) {
        throw new WorkflowBlockedIntake("client has not configured any content pillars yet");
      }
      return {
        // Same read that produced the rest of this object, so the terminal
        // guardrail below costs no extra step.
        forbiddenTopics: readForbiddenTopics(configOutcome.result),
        targetKeywords: config.targetKeywords,
        contentPillars: config.contentPillars,
        ...(config.requestedTopic !== undefined ? { requestedTopic: config.requestedTopic } : {}),
        ...(config.requestedKeyword !== undefined ? { requestedKeyword: config.requestedKeyword } : {}),
      };
    });

    // ── 01-03: context, audience persona, and past blog history retrieval (client.*, memory.read) ──
    const clientContext = await wf.step.code("01-load-client-context", async (): Promise<BlogClientContext> => {
      const profile = await tools["client.getProfile"]!.execute({}, { ctx });
      const brand = await tools["client.getBrand"]!.execute({}, { ctx });
      const voiceRules = await tools["client.getVoiceRules"]!.execute({}, { ctx });
      const profileResult = profile.status === "success" ? (profile.result as Record<string, unknown>) : {};
      return {
        profile: profileResult,
        brand: brand.status === "success" ? (brand.result as Record<string, unknown>) : {},
        voiceRules: voiceRules.status === "success" ? (voiceRules.result as BlogClientContext["voiceRules"]) : {},
        audiencePersona: (profileResult["audiencePersona"] as string | undefined) ?? "a technical/B2B reader familiar with the industry",
      };
    });

    const beliefs = await wf.step.code("02-load-memory-shelf", async () => {
      const outcome = await tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
      return outcome.status === "success" ? outcome.result : { scope: "beliefs", beliefs: {} };
    });

    const pastBlogHistory = await wf.step.code("03-load-recent-decisions", async (): Promise<string[]> => {
      const outcome = await tools["memory.read"]!.execute({ scope: "decisions" }, { ctx });
      if (outcome.status !== "success") return [];
      const result = outcome.result as { scope: string; items: Array<{ summary: string }> };
      return result.items.map((item) => item.summary);
    });

    // ── 04-05: deep topic & competitive research (persisting verbatim raw payloads inside research.pull itself) ──
    const research = await wf.step.code("04-research-pull", async () => {
      const industry = (clientContext.profile["industry"] as string | undefined) ?? "this industry";
      const query = `${industry} deep-dive and competitive landscape research`;
      // Blog/SEO content is evergreen — a 30-day window vs. LinkedIn's 7 days or X's 24h.
      const outcome = await tools["research.pull"]!.execute(
        {
          job: "blog-deep-research",
          query,
          window: "30d",
          // Anti-repetition context: this agent's own prior deliverables, so
          // the extraction below can steer off a subject already covered.
          historyAgentId: "blog-agent",
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

    const candidateSummary = await wf.step.code("05-extract-candidate-summary", (): BlogCandidateSummary =>
      // Shared with every other publishing agent (`extractResearchCandidate`).
      // This step used to return the QUERY as the topic, on the grounds that
      // research.pull was a stand-in with nothing to extract -- accurate when
      // written, false since the scraper landed, and the same stale comment
      // was sitting in five agents at once. One implementation now.
      extractResearchCandidate(research, { avoidTopics: pastBlogHistory }),
    );

    // ── 06-08: content pillar, target keyword, and article outline selection ──
    const reservation = await wf.step.code("06-reserve-topic", async (): Promise<BlogTopicReservation> => {
      const excludeTopics = pastBlogHistory;
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

    const selected = await wf.step.code("07-select-candidate", (): BlogSelectedCandidate => {
      // Single article selection precedence (RFC-02 §5, "same recipe" as X §3): an
      // explicit client request wins, then a reserved catalog topic, then the
      // research-derived fallback.
      let topic: string;
      let source: BlogSelectedCandidate["source"];
      // Highest precedence: a typed instruction is this run's most specific
      // statement of intent. Assigned rather than returned early, because this
      // step still has to resolve targetKeyword and contentPillar below —
      // returning here would drop both.
      if (runDirection.topicOverride) {
        topic = runDirection.topicOverride;
        source = "requested";
      } else if (intake.requestedTopic) {
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

      // Target keyword: an explicit client request wins (if it's actually one of the
      // client's configured keywords), otherwise the first configured keyword.
      const targetKeyword =
        intake.requestedKeyword && intake.targetKeywords.includes(intake.requestedKeyword)
          ? intake.requestedKeyword
          : intake.targetKeywords[0]!;
      // Content pillar: the first configured pillar (Phase 1 has no pillar-matching
      // logic yet — a future pass could score pillars against the candidate topic).
      const contentPillar = intake.contentPillars[0]!;

      return { topic, source, targetKeyword, contentPillar };
    });

    const angle = await wf.step.code("08-determine-angle", (): string => {
      return candidateSummary.hasNumericInsight ? "data-driven" : "conceptual-guide";
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
    const outputHistory = await readOutputHistoryForDedup(wf, tools, ctx, "blog-agent", "read-output-history");
    const recentPostsDirective = dedupeDirective(outputHistory);
    // The client intel report, distilled to what steers copy (voice rows,
    // positioning, whitespace opportunities) — intel.getReport has been in
    // every agent registry since the intel agent shipped, with zero
    // channel-agent callers until now.
    const clientIntelContext = await readClientIntelContext(wf, tools, ctx, "read-intel-context");


    // ── 09-12: draft execution via BlogDraftAgent, with machine/claim/compliance gates ──
    const draftAgent = new BlogDraftAgent({ router: options.router, tools, promptStore: options.promptStore });
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

    // ── 09/09a: draft, then VERIFY it is not a repeat, before anything else ──
    //
    // `recentPosts` in the drafting input below is ADVISORY: it asks the model
    // not to repeat itself and nothing ever checked whether it listened, so a
    // lightly-reworded reissue of last month's article passed every gate. 09a
    // is the verification half — the same `checkOutputDedupe` primitive,
    // scoring the same excerpt window the read above pulled, with
    // `evaluateDedupe`'s calibrated trigram-Jaccard threshold, in the same
    // place instagram-agent puts its own 07d check: inside the drafting pass,
    // so a `similar` verdict COSTS the draft (it is redrafted with the
    // offending article quoted into the prompt) and the human at step 15 can
    // never be shown a draft that has not been scored.
    //
    // On the final attempt the draft ships FLAGGED rather than held — two
    // pieces a fortnight apart about the same launch may be exactly right, and
    // a fixed threshold is not entitled to overrule the person reviewing at
    // 15. The verdict is checkpointed either way.
    //
    // The scored text is exactly what step 18 records back into the window
    // (`${title}\n${text}`), so every future run compares like with like.
    const draftWithVerifiedDedupe = async () => {
      /** Set by a failed 09a check, so the NEXT attempt's prompt names exactly which published article to move away from. */
      let dedupeRetrySteer: string | undefined;
      for (let attempt = 1; attempt <= MAX_DEDUPE_ATTEMPTS; attempt++) {
        /** Attempt 1 keeps the ORIGINAL step ids, so a run that never repeats itself has a byte-identical trace to what it had before this check existed. */
        const att = (id: string) => (attempt === 1 ? id : `${id}-attempt-${attempt}`);
        const draftResult = await wf.step.agent(rev(att("09-draft-post")), draftAgent, {
          ...runDirectionField(runDirection),
          topic: selected.topic,
          source: selected.source,
          angle,
          targetKeyword: selected.targetKeyword,
          contentPillar: selected.contentPillar,
          audiencePersona: clientContext.audiencePersona,
          voiceRules: clientContext.voiceRules,
          // The client's own profile description + voice-rules guidelines,
          // verbatim — this is where a language requirement like Geektime's
          // "Hebrew-language technology site" actually lives.
          ...(clientVoiceContext !== undefined ? { clientVoiceContext } : {}),
          ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
          ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
          ...(dedupeRetrySteer !== undefined ? { dedupeAvoid: dedupeRetrySteer } : {}),
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
        const candidate = draftResult.finalOutput!;

        const dedupeVerdict = await checkOutputDedupe(
          wf,
          rev(att("09a-verify-not-duplicate")),
          `${candidate.title}\n${candidate.text}`,
          outputHistory,
        );
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
    const draft = await draftWithVerifiedDedupe();

    await wf.step.code(rev("10-verify-numbers-sourced"), async () => {
      const sources = candidateSummary.hasNumericInsight ? [candidateSummary.sourceLabel] : [];
      const verdict = await runGate(tools, "gate.numbersSourced", { text: draft.text, sources }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.numbersSourced: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`numbers not sourced: ${verdict.reason}`);
      return verdict;
    });

    // KNOWN GAP (deliberately out of scope for this batch): this gate's substring
    // matching has no negation awareness, so a legitimate negated mention of a
    // banned term — e.g. "this is not a guaranteed strategy" — is wrongly refused
    // exactly like a genuine violation would be. Legacy specifically built a
    // `{phrase, unless: [...]}` shape to avoid this (`karos-agents/products/
    // building/blog-agent-v2/setup/SKILL.md` step 03, `run.mjs`'s "defect 7").
    // `gate.brandCompliance` (`packages/tools/karos-gates/src/brand-compliance.ts`)
    // is a SHARED gate used by every channel, not just blog — a real fix means
    // either extending its matching logic there (cross-cutting, another engineer's
    // scope this batch) or building a blog-local negation pre-filter here. A
    // pre-filter was deliberately not added: reimplementing "is this term actually
    // negated" locally, on top of a shared gate whose own banned-term bank
    // (`DEFAULT_BANNED_PROMISE_PHRASES` plus this client's `forbiddenTerms`) can
    // change independently of this file, risks silently drifting out of sync with
    // what the shared gate actually checks — worse than the false-positive it
    // would fix. Tracked here as a known miss versus legacy, not a silent one.
    await wf.step.code(rev("11-verify-brand-compliance"), async () => {
      const forbiddenTerms = clientContext.brand["forbiddenTerms"] as string[] | undefined;
      const verdict = await runGate(tools, "gate.brandCompliance", { text: draft.text, forbiddenTerms: forbiddenTerms ?? [] }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.brandCompliance: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`brand compliance failed: ${verdict.reason}`);
      return verdict;
    });

    await wf.step.code(rev("12-render-preview-check"), async () => {
      const outcome = await tools["render.preview"]!.execute(
        { title: draft.title, metaDescription: draft.metaDescription, text: draft.text },
        { ctx },
      );
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`render.preview failed: ${outcome.status}`);
      const preview = outcome.result as RenderPreviewResult;
      if (!preview.withinLimit) {
        const reason = !preview.titleWithinLimit
          ? `title exceeds the 120-character limit (${preview.titleCharacterCount} chars)`
          : !preview.metaDescriptionWithinLimit
            ? `metaDescription exceeds the 160-character SEO limit (${preview.metaDescriptionCharacterCount} chars)`
            : !preview.bodyWithinLimit
              ? `article exceeds the 20000-character long-form limit (${preview.bodyCharacterCount} chars)`
              : preview.wordCountAboveCeiling
                ? `article is ${preview.wordCount} words, over the ${BLOG_MAX_WORD_COUNT}-word target ceiling for a long-form piece`
                : `article is only ${preview.wordCount} words, below the ${BLOG_MIN_WORD_COUNT}-word minimum for a real long-form piece`;
        throw new WorkflowHeld(reason);
      }
      return preview;
    });

    // ── 13-14: gate.noPlaceholder / gate.leakCheck — restored dead gates (Phase 2.5
    // remediation): both existed in packages/tools/karos-gates since the original
    // migration, but were never called by any workflow's real step sequence, only
    // ever exercised in evals/src/run-assertions.ts. Grouped with the other content
    // gates (10-12), all of which run before the human review gate below. ──
    await wf.step.code(rev("13-verify-no-placeholder"), async () => {
      const verdict = await runGate(tools, "gate.noPlaceholder", { text: draft.text }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.noPlaceholder: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`unresolved placeholder found: ${verdict.reason}`);
      return verdict;
    });

    await wf.step.code(rev("14-verify-no-leak"), async () => {
      const verdict = await runGate(tools, "gate.leakCheck", { text: draft.text }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.leakCheck: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`leak check failed: ${verdict.reason}`);
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
        payload: { runId: wf.runId, topic: selected.topic, angle, preview: draft.text, revision },
        requiredRole: "account_manager",
        timeout: { duration: "24h", onTimeout: "hold" },
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
    const draft = review.output;

    // ── 16-17: deliverable & manifest persistence ──
    const deliverableId = await finalizeDeliverable(wf, tools, ctx, {
      persistDeliverableStepId: "16-persist-deliverable",
      persistManifestStepId: "17-persist-manifest",
      kind: "blog-post",
      buildDeliverable: () => {
        // canonicalUrl is derived deterministically from the client's own configured
        // domain, never taken from the model's draft — a draft-supplied value (should
        // one ever appear) is discarded here rather than trusted.
        const { canonicalUrl: _modelSuppliedCanonicalUrl, ...draftWithoutCanonicalUrl } = draft;
        const canonicalUrl = deriveCanonicalUrl(clientContext.profile["website"], draft.slug);
        // JSON-LD structured data (SEO/GEO remediation): a `BlogPosting` object always,
        // a `FAQPage` object too when the draft's own `faqItems` is non-empty — built
        // from the draft's own fields plus this same deterministic canonicalUrl, never
        // the model's own guess. `authorName` falls back to the tenant slug (never a
        // placeholder string) when the client has no display name configured.
        // Persisted as a structured object (`jsonLd`), not a pre-serialized string —
        // see json-ld.ts's own module comment for why.
        const authorName = (clientContext.profile["name"] as string | undefined) ?? wf.clientSlug;
        const jsonLd: BlogJsonLd = buildBlogJsonLd({
          title: draft.title,
          metaDescription: draft.metaDescription,
          ...(canonicalUrl ? { canonicalUrl } : {}),
          authorName,
          datePublished: new Date().toISOString(),
          faqItems: draft.faqItems,
        });
        return { ...draftWithoutCanonicalUrl, ...(canonicalUrl ? { canonicalUrl } : {}), jsonLd };
      },
      snapshot: (deliverableId) => ({ topic: selected.topic, source: selected.source, angle, targetKeyword: selected.targetKeyword, deliverableId }),
    });

    // ── 18: commit updates (topics.commit, memory.appendDecision) — the review
    // decision itself is already durable: `onDecision` above called
    // `persistReviewFeedbackToMemory` for every round, which is the one real
    // feedback pipeline (AU22: this step used to also call the now-retired
    // `ledger.feedbackAppend`, a write-only log nothing ever read). ──
    await wf.step.code("18-commit-and-record", async () => {
      if (selected.source === "reserved" && reservation.reservationKey) {
        await tools["topics.commit"]!.execute({ reservationKey: reservation.reservationKey }, { ctx });
      }
      // The write half of the anti-repetition loop: the shipped post joins
      // this agent's rolling excerpt window, read back by research.pull's
      // history feed and the drafting directive on every future run.
      // Best-effort: losing an excerpt costs future dedup signal, never the
      // delivered post.
      await recordOutputExcerpt(tools, ctx, wf.runId, "blog-agent", `${draft.title}\n${draft.text}`);
      await tools["memory.appendDecision"]!.execute(
        { decisionId: `${wf.runId}__decision`, summary: `Published about "${selected.topic}" (keyword: ${selected.targetKeyword}, angle: ${angle})` },
        { ctx },
      );
    });

    return { topic: selected.topic, angle, targetKeyword: selected.targetKeyword, deliverableId, preview: draft.text };
  };
}
