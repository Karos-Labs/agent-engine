import { readForbiddenTopics } from "@agent-engine/core";
import type { AgentContext, AgentToolRegistry, GateResponse, GateVerdict, ModelRouter, PromptStore } from "@agent-engine/core";
import { type WorkflowContext, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure, runTopicGuardrail, extractResearchCandidate, type ResearchPullResult } from "@agent-engine/workflow";
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
      if (intake.requestedTopic) {
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

    // ── 09-12: draft execution via BlogDraftAgent, with machine/claim/compliance gates ──
    const draftAgent = new BlogDraftAgent({ router: options.router, tools, promptStore: options.promptStore });
    const draftResult = await wf.step.agent("09-draft-post", draftAgent, {
      topic: selected.topic,
      source: selected.source,
      angle,
      targetKeyword: selected.targetKeyword,
      contentPillar: selected.contentPillar,
      audiencePersona: clientContext.audiencePersona,
      voiceRules: clientContext.voiceRules,
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
    await wf.step.code("11-verify-brand-compliance", async () => {
      const forbiddenTerms = clientContext.brand["forbiddenTerms"] as string[] | undefined;
      const verdict = await runGate(tools, "gate.brandCompliance", { text: draft.text, forbiddenTerms: forbiddenTerms ?? [] }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.brandCompliance: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`brand compliance failed: ${verdict.reason}`);
      return verdict;
    });

    await wf.step.code("12-render-preview-check", async () => {
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
    await wf.step.code("13-verify-no-placeholder", async () => {
      const verdict = await runGate(tools, "gate.noPlaceholder", { text: draft.text }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.noPlaceholder: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`unresolved placeholder found: ${verdict.reason}`);
      return verdict;
    });

    await wf.step.code("14-verify-no-leak", async () => {
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
    await runTopicGuardrail(wf, { tools, promptStore: options.promptStore, router: options.router }, draft.text, intake.forbiddenTopics);

    const reviewDecision: GateResponse = options.autoApprove
      ? await wf.step.code("15-batch-review", () => ({
          decision: "approve" as const,
          actor: "system",
          at: new Date().toISOString(),
        }))
      : await wf.step.gate("15-batch-review", {
          kind: "batch_review",
          payload: { runId: wf.runId, topic: selected.topic, angle, preview: draft.text },
          requiredRole: "account_manager",
          timeout: { duration: "24h", onTimeout: "hold" },
        });
    if (reviewDecision.decision !== "approve") {
      throw new WorkflowHeld(`batch rejected: ${reviewDecision.reason ?? "no reason given"}`);
    }

    // ── 16-17: deliverable & manifest persistence ──
    const deliverableId = await wf.step.code("16-persist-deliverable", async (): Promise<string> => {
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
      const deliverable = { ...draftWithoutCanonicalUrl, ...(canonicalUrl ? { canonicalUrl } : {}), jsonLd };
      const outcome = await tools["ledger.writeDeliverable"]!.execute({ runId: wf.runId, kind: "blog-post", deliverable }, { ctx });
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`ledger.writeDeliverable failed: ${outcome.status}`);
      return (outcome.result as { id: string }).id;
    });

    await wf.step.code("17-persist-manifest", async () => {
      await tools["ledger.dashboardSnapshot"]!.execute(
        {
          runId: wf.runId,
          snapshot: { topic: selected.topic, source: selected.source, angle, targetKeyword: selected.targetKeyword, deliverableId },
        },
        { ctx },
      );
    });

    // ── 18: commit updates (topics.commit, memory.appendDecision, ledger.feedbackAppend) ──
    await wf.step.code("18-commit-and-record", async () => {
      if (selected.source === "reserved" && reservation.reservationKey) {
        await tools["topics.commit"]!.execute({ reservationKey: reservation.reservationKey }, { ctx });
      }
      await tools["memory.appendDecision"]!.execute(
        { decisionId: `${wf.runId}__decision`, summary: `Published about "${selected.topic}" (keyword: ${selected.targetKeyword}, angle: ${angle})` },
        { ctx },
      );
      await tools["ledger.feedbackAppend"]!.execute(
        { runId: wf.runId, feedbackId: `${wf.runId}__review`, decision: reviewDecision.decision, actor: reviewDecision.actor },
        { ctx },
      );
    });

    return { topic: selected.topic, angle, targetKeyword: selected.targetKeyword, deliverableId };
  };
}
