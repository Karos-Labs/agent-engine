import { readForbiddenTopics } from "@agent-engine/core";
import type { AgentContext, AgentToolRegistry, GateResponse, ModelRouter, PromptStore } from "@agent-engine/core";
import { type WorkflowContext, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure, runTopicGuardrail, extractResearchCandidate, type ResearchPullResult, readRunDirection, runDirectionField, type RevisionNote, MAX_REVISION_ROUNDS, persistReviewFeedbackToMemory, readPastFeedback, revisionDirective, runReviewCycle, buildClientVoiceContext, readOutputHistoryForDedup, dedupeDirective, readClientIntelContext, toAgentContext, runGate, finalizeDeliverable, recordOutputExcerpt} from "@agent-engine/workflow";
import { NewsletterDraftAgent, type NewsletterPostOutput } from "../agent/newsletter-draft-agent.js";
import { renderPreview, type RenderPreviewResult } from "../tools/render-preview.js";
import type {
  NewsletterAgentWorkflowResult,
  NewsletterCandidateSummary,
  NewsletterClientContext,
  NewsletterIntakeConfig,
  NewsletterSelectedCandidates,
  NewsletterTopicReservation,
} from "./types.js";

export interface CreateNewsletterAgentWorkflowOptions {
  /** The base Layer 3 registry (karos-client/research/topics/gates/ledger/memory) — `render.preview` is merged in internally. */
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips step 13's human `batch_review` gate and records a synthetic
   * `actor: "system"` approval instead — off by default, so a real run
   * genuinely pauses at `awaiting_gate` until a human reviews it (RFC-01
   * §8.3). Intended for tests/demos/evals that need a synchronous happy
   * path, never for production wiring.
   */
  autoApprove?: boolean;
}

/**
 * Force-injects the client's compliance footer onto a draft's `text` — the
 * migration-audit fix for the Newsletter agent's missing structural
 * compliance surface. Mirrors the legacy `compliance-gate.mjs`'s "never let
 * the model author the footer" rule: `footerDisclaimer`, `companyAddress`,
 * and `unsubscribeUrl` are read from the client's own `brand` config only —
 * never from whatever the model itself may have put in those (optional,
 * model-writable-by-schema) fields — and always overwrite them.
 *
 * Runs AFTER `gate.brandCompliance`'s hype/forbidden-terms scan (step 10),
 * not before it — a Phase-2.5 fix. The scan used to run on the
 * already-composed text, which meant a client's own legitimately-configured
 * disclaimer (e.g. "we do not offer guaranteed returns") could contain a
 * banned hype phrase's substring and trip the gate on its own required legal
 * language. The hype bank is a check on what the MODEL wrote, not on what
 * the platform deterministically appends afterward, so it only ever sees the
 * author-generated body/sections. `gate.numbersSourced` and
 * `render.preview`'s body-length check still run on the composed (footer
 * included) text at steps 11/13, and step 12 structurally verifies the
 * footer actually landed, so nothing about the final persisted deliverable
 * is left unchecked.
 */
function composeCompliantDraft(draft: NewsletterPostOutput, brand: Record<string, unknown>): NewsletterPostOutput {
  const footerDisclaimer = brand["requiredDisclaimer"] as string | undefined;
  const companyAddress = brand["companyAddress"] as string | undefined;
  const unsubscribeUrl = brand["unsubscribeUrl"] as string | undefined;

  const footerLines: string[] = [];
  if (footerDisclaimer) footerLines.push(footerDisclaimer);
  if (companyAddress) footerLines.push(companyAddress);
  if (unsubscribeUrl) footerLines.push(`Unsubscribe: ${unsubscribeUrl}`);

  if (footerLines.length === 0) {
    // Nothing configured for this client — leave the draft exactly as authored.
    return draft;
  }

  return {
    ...draft,
    ...(footerDisclaimer !== undefined ? { footerDisclaimer } : {}),
    ...(companyAddress !== undefined ? { companyAddress } : {}),
    ...(unsubscribeUrl !== undefined ? { unsubscribeUrl } : {}),
    text: `${draft.text}\n\n${footerLines.join("\n")}`,
  };
}


/**
 * `createNewsletterAgentWorkflow()` (RFC-02 §5 — "same recipe" as the X,
 * LinkedIn, Reddit, and Blog pilots): the 20-step recurring/on-demand run
 * protocol, steps `00`–`19`. One edition, one run (RFC-01 §16.2's ruling) —
 * no fan-out here; every newsletter run produces at most one deliverable.
 * Grew three steps past the original 17-step recipe in Phase 2.5: the
 * hype-language scan (10) and the footer-injection structural check (12) are
 * now distinct steps rather than one combined "verify-brand-compliance" (so
 * the scan never sees text the platform itself appended), and
 * `gate.noPlaceholder`/`gate.leakCheck` (13/14) are now actually wired into
 * the run instead of existing only for offline evals. Step 16 is a mandatory
 * human `batch_review` gate (RFC-01 §8.3) unless `options.autoApprove` opts
 * out.
 */
export function createNewsletterAgentWorkflow(options: CreateNewsletterAgentWorkflowOptions) {
  const tools: AgentToolRegistry = { ...options.tools, "render.preview": renderPreview };

  return async function newsletterAgentWorkflow(wf: WorkflowContext): Promise<NewsletterAgentWorkflowResult> {
    const ctx = toAgentContext(wf);

    // The run-scoped instruction someone typed in the portal, resolved once.
    // A typed sentence outranks the topic catalog for the same reason an
    // explicit requestedTopic does: a person who wrote it has more
    // information about this run than a catalog row does. Style-only notes
    // are deliberately NOT promoted to topics -- see readRunDirection.
    const runDirection = readRunDirection(wf.input);

    // ── 00: intake check — blocked_intake if target audience, frequency, or brand guidelines are missing ──
    const intake = await wf.step.code("00-intake-check", async (): Promise<NewsletterIntakeConfig> => {
      const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
      if (configOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client config is not available yet — cannot determine target audience or frequency");
      }
      const config = configOutcome.result as { targetAudience?: string; frequency?: string; requestedTopic?: string };
      if (!config.targetAudience || config.targetAudience.length === 0) {
        throw new WorkflowBlockedIntake("client has not configured a target audience yet");
      }
      if (!config.frequency || config.frequency.length === 0) {
        throw new WorkflowBlockedIntake("client has not configured a newsletter frequency yet");
      }
      const brandOutcome = await tools["client.getBrand"]!.execute({}, { ctx });
      if (brandOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client brand guidelines have not been set up yet");
      }
      return {
        // Same read that produced the rest of this object, so the terminal
        // guardrail below costs no extra step.
        forbiddenTopics: readForbiddenTopics(configOutcome.result),
        targetAudience: config.targetAudience,
        frequency: config.frequency,
        ...(config.requestedTopic !== undefined ? { requestedTopic: config.requestedTopic } : {}),
      };
    });

    // ── 01-03: context, audience persona, and past edition history retrieval (client.*, memory.read) ──
    const clientContext = await wf.step.code("01-load-client-context", async (): Promise<NewsletterClientContext> => {
      const profile = await tools["client.getProfile"]!.execute({}, { ctx });
      const brand = await tools["client.getBrand"]!.execute({}, { ctx });
      const voiceRules = await tools["client.getVoiceRules"]!.execute({}, { ctx });
      return {
        profile: profile.status === "success" ? (profile.result as Record<string, unknown>) : {},
        brand: brand.status === "success" ? (brand.result as Record<string, unknown>) : {},
        voiceRules: voiceRules.status === "success" ? (voiceRules.result as NewsletterClientContext["voiceRules"]) : {},
      };
    });

    const beliefs = await wf.step.code("02-load-memory-shelf", async () => {
      const outcome = await tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
      return outcome.status === "success" ? outcome.result : { scope: "beliefs", beliefs: {} };
    });

    const pastEditionHistory = await wf.step.code("03-load-recent-decisions", async (): Promise<string[]> => {
      const outcome = await tools["memory.read"]!.execute({ scope: "decisions" }, { ctx });
      if (outcome.status !== "success") return [];
      const result = outcome.result as { scope: string; items: Array<{ summary: string }> };
      return result.items.map((item) => item.summary);
    });

    // ── 04-05: curated industry & company update research (persisting verbatim raw payloads inside research.pull itself) ──
    const research = await wf.step.code("04-research-pull", async () => {
      const industry = (clientContext.profile["industry"] as string | undefined) ?? "this industry";
      const query = `${industry} industry and company update digest`;
      // Newsletter editions curate a window of updates — 14 days covers a
      // typical weekly-or-slower cadence without missing recent items.
      const outcome = await tools["research.pull"]!.execute(
        {
          job: "newsletter-digest-research",
          query,
          window: "14d",
          // Anti-repetition context: this agent's own prior deliverables, so
          // the extraction below can steer off a subject already covered.
          historyAgentId: "newsletter-agent",
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

    const candidateSummary = await wf.step.code("05-extract-candidate-summary", (): NewsletterCandidateSummary =>
      // Shared with every other publishing agent (`extractResearchCandidate`).
      // This step used to return the QUERY as the topic, on the grounds that
      // research.pull was a stand-in with nothing to extract -- accurate when
      // written, false since the scraper landed, and the same stale comment
      // was sitting in five agents at once. One implementation now.
      extractResearchCandidate(research, { avoidTopics: pastEditionHistory }),
    );

    // ── 06-08: edition theme, main story, and secondary section curation ──
    const reservation = await wf.step.code("06-reserve-topics", async (): Promise<NewsletterTopicReservation> => {
      const excludeTopics = pastEditionHistory;
      // Up to 3 topics: one main story plus up to two secondary sections.
      const outcome = await tools["topics.reserve"]!.execute(
        { reservationKey: `${wf.runId}__topic`, count: 3, excludeTopics },
        { ctx },
      );
      if (outcome.status === "success") {
        const result = outcome.result as { reservationKey: string; topics: string[] };
        return { reservationKey: result.reservationKey, topics: result.topics };
      }
      // content_fail here just means the catalog floor doesn't have 3 available — not
      // fatal, step 07's precedence falls through to the research-derived candidate
      // instead, with no secondary sections this run.
      return { topics: [] };
    });

    const selected = await wf.step.code("07-select-candidates", (): NewsletterSelectedCandidates => {
      // Single edition selection precedence (RFC-02 §5, "same recipe" as X §3): an
      // explicit client request wins, then a reserved catalog topic, then the
      // research-derived fallback. Any reserved topics beyond the main story become
      // secondary sections (editorial curation, newsletter-craft@1 §6) — never
      // padded out if the catalog floor came up short.
      let mainStory: string;
      let source: NewsletterSelectedCandidates["source"];
      let secondaryTopics: string[];
      if (runDirection.topicOverride) {
        // Highest precedence: a typed instruction is this run's most specific
        // statement of intent, above the catalog and above standing config.
        mainStory = runDirection.topicOverride;
        source = "requested";
        secondaryTopics = reservation.topics.slice(0, 2);
      } else if (intake.requestedTopic) {
        mainStory = intake.requestedTopic;
        source = "requested";
        secondaryTopics = reservation.topics.slice(0, 2);
      } else if (reservation.topics.length > 0) {
        mainStory = reservation.topics[0]!;
        source = "reserved";
        secondaryTopics = reservation.topics.slice(1, 3);
      } else if (candidateSummary.candidateTopic) {
        mainStory = candidateSummary.candidateTopic;
        source = "research";
        secondaryTopics = [];
      } else {
        throw new WorkflowHeld("no candidate main story available for this run — nothing honestly cleared selection");
      }

      return { mainStory, source, secondaryTopics };
    });

    const theme = await wf.step.code("08-determine-edition-theme", (): string => {
      return candidateSummary.hasNumericInsight ? "data-point" : "curated-digest";
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
    const outputHistory = await readOutputHistoryForDedup(wf, tools, ctx, "newsletter-agent", "read-output-history");
    const recentPostsDirective = dedupeDirective(outputHistory);
    // The client intel report, distilled to what steers copy (voice rows,
    // positioning, whitespace opportunities) — intel.getReport has been in
    // every agent registry since the intel agent shipped, with zero
    // channel-agent callers until now.
    const clientIntelContext = await readClientIntelContext(wf, tools, ctx, "read-intel-context");


    // ── 09-12: draft execution via NewsletterDraftAgent, with machine/claim/compliance gates ──
    const draftAgent = new NewsletterDraftAgent({ router: options.router, tools, promptStore: options.promptStore });
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

    const clientVoiceContext = buildClientVoiceContext(clientContext.profile, clientContext.voiceRules);
    const draftResult = await wf.step.agent(rev("09-draft-post"), draftAgent, {
      ...runDirectionField(runDirection),
      mainStory: selected.mainStory,
      secondaryTopics: selected.secondaryTopics,
      source: selected.source,
      theme,
      targetAudience: intake.targetAudience,
      frequency: intake.frequency,
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
    const authoredDraft = draftResult.finalOutput!;

    // Hype/forbidden-terms scan runs on the MODEL's own authored text, before the
    // platform's compliance footer is anywhere near it (Phase-2.5 fix — see
    // composeCompliantDraft's doc comment for why this ordering matters).
    // requiredDisclaimer is deliberately omitted here: the footer that satisfies
    // it hasn't been injected yet, and its presence is verified structurally at
    // step 12 instead, not by re-running this hype-scanning gate against it.
    await wf.step.code(rev("10-verify-brand-compliance"), async () => {
      const forbiddenTerms = clientContext.brand["forbiddenTerms"] as string[] | undefined;
      const verdict = await runGate(tools, "gate.brandCompliance", { text: authoredDraft.text, forbiddenTerms: forbiddenTerms ?? [] }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.brandCompliance: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`brand compliance failed: ${verdict.reason}`);
      return verdict;
    });

    // Force-inject the client's locked compliance footer (disclaimer, company
    // address, unsubscribe link) onto the model's own draft — never the model's
    // own field, always the platform's (see composeCompliantDraft's doc comment
    // above). Plain, deterministic code (not its own step) — a pure function of
    // already-checkpointed step 09's output and step 01's client context, so
    // resuming a run recomputes the exact same value without adding a step
    // boundary.
    const draft = composeCompliantDraft(authoredDraft, clientContext.brand);

    await wf.step.code(rev("11-verify-numbers-sourced"), async () => {
      const sources = candidateSummary.hasNumericInsight ? [candidateSummary.sourceLabel] : [];
      const verdict = await runGate(tools, "gate.numbersSourced", { text: draft.text, sources }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.numbersSourced: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`numbers not sourced: ${verdict.reason}`);
      return verdict;
    });

    // Structural backstop, not a re-run of the hype-scanning gate: confirms the
    // footer this workflow itself just composed actually landed in the final
    // text. A failure here means composeCompliantDraft was bypassed or broken —
    // an internal bug, never a content problem — so it's a tooling failure, not
    // a held run.
    await wf.step.code(rev("12-verify-compliance-footer"), (): void => {
      const requiredDisclaimer = clientContext.brand["requiredDisclaimer"] as string | undefined;
      const companyAddress = clientContext.brand["companyAddress"] as string | undefined;
      const unsubscribeUrl = clientContext.brand["unsubscribeUrl"] as string | undefined;
      const lower = draft.text.toLowerCase();
      const missing = [
        requiredDisclaimer && !lower.includes(requiredDisclaimer.toLowerCase()) ? "footerDisclaimer" : undefined,
        companyAddress && !lower.includes(companyAddress.toLowerCase()) ? "companyAddress" : undefined,
        unsubscribeUrl && !lower.includes(unsubscribeUrl.toLowerCase()) ? "unsubscribeUrl" : undefined,
      ].filter((field): field is string => field !== undefined);
      if (missing.length > 0) {
        throw new WorkflowToolingFailure(`compliance footer failed to inject configured field(s): ${missing.join(", ")}`);
      }
    });

    // The shipped artifact's final gate pair — an unresolved placeholder or a
    // leaked credential/internal term must hold the run before it ever reaches
    // persistence, matching legacy's hard, unconditional delivery gates.
    await wf.step.code(rev("13-verify-no-placeholder"), async () => {
      const verdict = await runGate(tools, "gate.noPlaceholder", { text: draft.text }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.noPlaceholder: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`unresolved placeholder: ${verdict.reason}`);
      return verdict;
    });

    await wf.step.code(rev("14-verify-no-leak"), async () => {
      const verdict = await runGate(tools, "gate.leakCheck", { text: draft.text }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.leakCheck: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`leak check failed: ${verdict.reason}`);
      return verdict;
    });

    await wf.step.code(rev("15-render-preview-check"), async () => {
      const outcome = await tools["render.preview"]!.execute(
        { subjectLine: draft.subjectLine, previewText: draft.previewText, text: draft.text },
        { ctx },
      );
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`render.preview failed: ${outcome.status}`);
      const preview = outcome.result as RenderPreviewResult;
      if (!preview.withinLimit) {
        const reason = !preview.subjectLineWithinLimit
          ? `subject line exceeds the 70-character limit (${preview.subjectLineCharacterCount} chars)`
          : !preview.previewTextWithinLimit
            ? `preview text exceeds the 140-character limit (${preview.previewTextCharacterCount} chars)`
            : `edition exceeds the 10000-character body limit (${preview.bodyCharacterCount} chars)`;
        throw new WorkflowHeld(reason);
      }
      return preview;
    });

    // ── 16: human batch-review gate — nothing ships without a real approval ──
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
      gateId: "16-batch-review",
      maxRevisions: MAX_REVISION_ROUNDS,
      ...(options.autoApprove ? { autoApprove: true } : {}),
      attempt: draftOnce,
      buildGate: (draft, revision) => ({
        kind: "batch_review",
        payload: { runId: wf.runId, mainStory: selected.mainStory, theme, preview: draft.text, revision },
        requiredRole: "account_manager",
        timeout: { duration: "24h", onTimeout: "hold" },
      }),
      onDecision: async ({ revision, response }) => {
        await persistReviewFeedbackToMemory(wf, tools, ctx, revision, response);
      },
    });
    const draft = review.output;

    // ── 17-18: deliverable & manifest persistence ──
    const deliverableId = await finalizeDeliverable(wf, tools, ctx, {
      persistDeliverableStepId: "17-persist-deliverable",
      persistManifestStepId: "18-persist-manifest",
      kind: "newsletter-edition",
      deliverable: draft,
      snapshot: (deliverableId) => ({
        mainStory: selected.mainStory,
        source: selected.source,
        theme,
        secondaryTopics: selected.secondaryTopics,
        deliverableId,
      }),
    });

    // ── 19: commit updates (topics.commit, memory.appendDecision, ledger.feedbackAppend) ──
    await wf.step.code("19-commit-and-record", async () => {
      if (selected.source === "reserved" && reservation.reservationKey) {
        await tools["topics.commit"]!.execute({ reservationKey: reservation.reservationKey }, { ctx });
      }
      // The write half of the anti-repetition loop: the shipped post joins
      // this agent's rolling excerpt window, read back by research.pull's
      // history feed and the drafting directive on every future run.
      // Best-effort: losing an excerpt costs future dedup signal, never the
      // delivered post.
      await recordOutputExcerpt(tools, ctx, wf.runId, "newsletter-agent", `${draft.subjectLine}\n${draft.text}`);
      await tools["memory.appendDecision"]!.execute(
        {
          decisionId: `${wf.runId}__decision`,
          summary: `Sent edition about "${selected.mainStory}" (theme: ${theme}, secondary: ${selected.secondaryTopics.join(", ") || "none"})`,
        },
        { ctx },
      );
      await tools["ledger.feedbackAppend"]!.execute(
        { runId: wf.runId, feedbackId: `${wf.runId}__review`, decision: review.response.decision, actor: review.response.actor },
        { ctx },
      );
    });

    return { mainStory: selected.mainStory, theme, targetAudience: intake.targetAudience, deliverableId };
  };
}
