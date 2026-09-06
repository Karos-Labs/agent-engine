import { readForbiddenTopics } from "@agent-engine/core";
import type { AgentContext, AgentToolRegistry, GateResponse, ModelRouter, PromptStore } from "@agent-engine/core";
import {
  type WorkflowContext,
  WorkflowBlockedIntake,
  WorkflowHeld,
  WorkflowToolingFailure,
  runTopicGuardrail,
  extractResearchCandidate,
  mergeResearchPulls,
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
import { NewsletterDraftAgent, type NewsletterPostOutput } from "../agent/newsletter-draft-agent.js";
import { NewsletterPlanAgent, type NewsletterEditionPlan } from "../agent/newsletter-plan-agent.js";
import { NewsletterEditorAgent, type NewsletterEditorVerdict } from "../agent/newsletter-editor-agent.js";
import { renderPreview, type RenderPreviewResult } from "../tools/render-preview.js";
import { editorialLint, type EditorialLintResult } from "../tools/editorial-lint.js";
import type {
  NewsletterAgentWorkflowResult,
  NewsletterCandidateSummary,
  NewsletterClientContext,
  NewsletterEditorialOutcome,
  NewsletterIntakeConfig,
  NewsletterSelectedCandidates,
  NewsletterTopicReservation,
} from "./types.js";

export interface CreateNewsletterAgentWorkflowOptions {
  /** The base Layer 3 registry (karos-client/research/topics/gates/ledger/memory) — `render.preview` and `newsletter.editorialLint` are merged in internally. */
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips step 16's human `batch_review` gate and records a synthetic
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
 * How many times one revision round may draft before the run gives up on
 * fixing the edition itself: the first draft plus two redrafts. A round ends
 * in a redraft when a deterministic gate fails (a number the sources do not
 * carry, a banned phrase, an invented link) or when the editor sends the
 * draft back. On the last round a deterministic failure HOLDS the run (an
 * invented URL or an unsourced figure must never reach a subscriber) while
 * an editor `revise` ships FLAGGED to the human reviewer with the notes
 * attached (taste is not entitled to block a person's decision).
 *
 * Before 2026-09-05 every one of those gates held the run on its first
 * failure, so the model never got to read the reason. The prep run that
 * started this (sp8ICAFLjKkYWb2DAh8R) was held on a figure it had quoted
 * correctly; even once the gate was fixed, a genuinely unsourced figure would
 * still have cost a human a re-run instead of costing the model a redraft.
 */
const MAX_EDITORIAL_ROUNDS = 3;

/** How many distinct research questions one edition asks. Each is a billed scrape, so this is a cost ceiling as much as a breadth setting. */
const MAX_RESEARCH_QUERIES = 4;
/** Sources the digest query keeps; the base "industry update" question deserves the widest net. */
const PRIMARY_QUERY_MAX_RESULTS = 6;
const SECONDARY_QUERY_MAX_RESULTS = 4;
/** What the plan and draft steps read: enough sources to curate from, capped so the prompt stays a prompt. */
const RESEARCH_DIGEST_OPTIONS = { maxDocuments: 12, maxExcerptChars: 2_500 } as const;

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/g;

function uniqueNonEmpty(values: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const t = (v ?? "").trim();
    if (t.length === 0) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Every URL that appears anywhere in a value, for the editorial lint's link allowlist. */
function urlsIn(value: unknown): string[] {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Array.from(text.matchAll(URL_PATTERN), (m) => m[0]);
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
 * included) text at steps 11/15, and step 12 structurally verifies the
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

/** The accumulated reasons a round was sent back, as one directive the redraft prompt carries. */
function editorialNotesDirective(notes: readonly string[]): string | undefined {
  if (notes.length === 0) return undefined;
  return [
    "Your previous draft of THIS edition was sent back. Every item below is a specific problem in that draft; fix each one in the redraft, keep everything that was not mentioned, and do not introduce new numbers, links or claims to fix a note.",
    ...notes.map((n, i) => `${i + 1}. ${n}`),
  ].join("\n");
}

/**
 * `createNewsletterAgentWorkflow()` (RFC-02 §5, rebuilt 2026-09-05): the
 * recurring/on-demand edition protocol. One edition, one run (RFC-01 §16.2's
 * ruling) — no fan-out here; every newsletter run produces at most one
 * deliverable.
 *
 * What changed in the rebuild, and why each piece is a step rather than a
 * sentence in the prompt:
 *
 * - **Research asks several questions** (`04-plan-research`,
 *   `04-research-pull`): the industry digest, the audience's own question,
 *   and the topics the client's catalog reserved for this edition. One
 *   generic query produced one story and a draft that generalised the rest.
 * - **An edition plan precedes the draft** (`08b-plan-edition`): which
 *   story leads, from what angle, what the team thinks, which quick hits
 *   earn a paragraph, what the reader should do, and what was passed on.
 *   Checkpointed, so the trace shows curation happened.
 * - **Gates redraft instead of holding** (the round loop inside
 *   `draftOnce`): a failed deterministic gate is a note to the next draft,
 *   up to `MAX_EDITORIAL_ROUNDS`; only the last round holds.
 * - **`newsletter.editorialLint`** (`15b`): the deterministic half of the
 *   editorial pass — every link must be a URL the run was given, no verdict
 *   phrases, no generic headings, no exclamation marks in the inbox fields.
 * - **An editor judges the draft** (`15c-editor-verdict`): a second model
 *   pass with a different brief, whose `revise` sends the draft back with
 *   quoted notes and whose final-round reservations ride along to the human
 *   reviewer instead of being lost.
 *
 * Step 16 is a mandatory human `batch_review` gate (RFC-01 §8.3) unless
 * `options.autoApprove` opts out.
 */
export function createNewsletterAgentWorkflow(options: CreateNewsletterAgentWorkflowOptions) {
  const tools: AgentToolRegistry = { ...options.tools, "render.preview": renderPreview, "newsletter.editorialLint": editorialLint };

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

    // Read for the trace (and any future belief-aware step); nothing below
    // consumes it yet, same as every sibling channel agent.
    await wf.step.code("02-load-memory-shelf", async () => {
      const outcome = await tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
      return outcome.status === "success" ? outcome.result : { scope: "beliefs", beliefs: {} };
    });

    const pastEditionHistory = await wf.step.code("03-load-recent-decisions", async (): Promise<string[]> => {
      const outcome = await tools["memory.read"]!.execute({ scope: "decisions" }, { ctx });
      if (outcome.status !== "success") return [];
      const result = outcome.result as { scope: string; items: Array<{ summary: string }> };
      return result.items.map((item) => item.summary);
    });

    // ── 06: topic reservation — runs BEFORE research (2026-09-05) so the reserved
    //    topics can be research questions rather than bare headings the draft
    //    has to write about from nothing. Keeps its id: nothing about the
    //    reservation itself changed, only when it happens. ──
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

    // ── 04: research — several questions, one merged payload ──
    const researchQueries = await wf.step.code("04-plan-research", (): string[] => {
      const industry = (clientContext.profile["industry"] as string | undefined) ?? "this industry";
      // The topics this edition is actually about, most specific first: a typed
      // instruction, then the standing request, then what the catalog reserved.
      const topics = uniqueNonEmpty([runDirection.topicOverride, intake.requestedTopic, ...reservation.topics]).slice(0, 2);
      return uniqueNonEmpty([
        // The original digest query, kept first and verbatim so a run inside the
        // freshness window still hits the same cache entry it always did.
        `${industry} industry and company update digest`,
        // The audience's own question, not the industry's.
        `${industry} news this week for ${intake.targetAudience}`,
        ...topics,
      ]).slice(0, MAX_RESEARCH_QUERIES);
    });

    const research = await wf.step.code("04-research-pull", async (): Promise<ResearchPullResult> => {
      // Newsletter editions curate a window of updates — 14 days covers a
      // typical weekly-or-slower cadence without missing recent items. Every
      // pull persists its raw payload inside research.pull itself.
      const outcomes = await Promise.all(
        researchQueries.map((query, i) =>
          tools["research.pull"]!.execute(
            {
              job: "newsletter-digest-research",
              query,
              window: "14d",
              maxResults: i === 0 ? PRIMARY_QUERY_MAX_RESULTS : SECONDARY_QUERY_MAX_RESULTS,
              // Anti-repetition context: this agent's own prior deliverables,
              // read once — every pull for this client reads the same ledger.
              ...(i === 0 ? { historyAgentId: "newsletter-agent" } : {}),
            },
            { ctx },
          ),
        ),
      );
      const succeeded = outcomes.flatMap((o) => (o.status === "success" ? [o.result as ResearchPullResult] : []));
      if (succeeded.length === 0) {
        throw new WorkflowToolingFailure(`research.pull failed for every query: ${outcomes.map((o) => o.status).join(", ")}`);
      }
      // One question failing out of several is a thinner edition, not a
      // stopped run; the merged payload says how many questions it answers.
      return mergeResearchPulls(succeeded);
    });

    const candidateSummary = await wf.step.code("05-extract-candidate-summary", (): NewsletterCandidateSummary =>
      // Shared with every other publishing agent (`extractResearchCandidate`).
      extractResearchCandidate(research, { avoidTopics: pastEditionHistory }),
    );

    // ── 07-08: edition main story and theme ──
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
    // positioning, whitespace opportunities).
    const clientIntelContext = await readClientIntelContext(wf, tools, ctx, "read-intel-context");
    // The research itself, shaped for the plan and drafting prompts: every
    // fetched source's title, url, date and excerpt. A pure function of step
    // 04's checkpointed output, so no step boundary of its own.
    const researchDigest = researchDigestForDrafting(research, RESEARCH_DIGEST_OPTIONS);
    const clientVoiceContext = buildClientVoiceContext(clientContext.profile, clientContext.voiceRules, clientContext.brand);

    // Everything an edition may link to: the research documents, and any URL
    // the client's own context carries (their site, their product pages).
    const allowedUrls = uniqueNonEmpty([
      ...(research.result?.documents ?? []).map((d) => d.url),
      ...urlsIn(clientContext.profile),
      ...urlsIn(clientContext.brand),
      ...urlsIn(clientContext.voiceRules),
      ...urlsIn(clientIntelContext),
    ]);

    /** Shared by the plan, draft and editor prompts, so all three reason from the same client picture. */
    const clientPicture = {
      targetAudience: intake.targetAudience,
      frequency: intake.frequency,
      voiceRules: clientContext.voiceRules,
      ...(clientVoiceContext !== undefined ? { clientVoiceContext } : {}),
      ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
    };

    // ── 08b: the edition plan — decided once, before any prose ──
    const planAgent = new NewsletterPlanAgent({ router: options.router, tools, promptStore: options.promptStore });
    const planResult = await wf.step.agent("08b-plan-edition", planAgent, {
      ...runDirectionField(runDirection),
      mainStory: selected.mainStory,
      secondaryTopics: selected.secondaryTopics,
      source: selected.source,
      theme,
      ...clientPicture,
      ...(researchDigest !== undefined ? { research: researchDigest } : {}),
      ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
      ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
    });
    if (planResult.status !== "completed") {
      throw new WorkflowToolingFailure(`edition plan step resolved to "${planResult.status}"`);
    }
    const plan: NewsletterEditionPlan = planResult.finalOutput!;

    // ── 09-15c: draft execution, with machine/claim/compliance gates, the editorial lint and the editor ──
    const draftAgent = new NewsletterDraftAgent({ router: options.router, tools, promptStore: options.promptStore });
    const editorAgent = new NewsletterEditorAgent({ router: options.router, tools, promptStore: options.promptStore });
    /** The editor's last word on each revision's shipped draft, for the review gate and the result. */
    const editorialByRevision = new Map<number, NewsletterEditorialOutcome>();

    /**
     * One full drafting pass: up to `MAX_EDITORIAL_ROUNDS` of draft, every
     * deterministic content gate, the editorial lint and the editor, then
     * the terminal topic guardrail.
     *
     * Called once per REVISION round by `runReviewCycle`. `revision` is
     * folded into every checkpointed step id inside it (via `rev`), so a
     * second round genuinely re-drafts instead of short-circuiting on the
     * first round's checkpoints — while everything OUTSIDE it (intake,
     * research, the topic reservation, the plan) keeps its id and is reused.
     * That reuse is why the revision is in-run rather than a fresh run.
     */
    const draftOnce = async (revision: number, notes: readonly RevisionNote[]) => {
      /** Revision 0 keeps the ORIGINAL ids, so a first-pass trace is unchanged. */
      const rev = (id: string) => (revision === 0 ? id : `${id}-r${revision}`);
      const directive = revisionDirective(notes);

      /** What earlier rounds of THIS revision found wrong, carried into the next draft. */
      const roundNotes: string[] = [];
      let lastEditor: NewsletterEditorVerdict | undefined;
      let lastEditorNotes: readonly string[] = [];

      for (let round = 1; round <= MAX_EDITORIAL_ROUNDS; round++) {
        /** Round 1 keeps the ORIGINAL ids, so a run that clears every gate first time has a byte-identical trace to what it had before rounds existed. */
        const rnd = (id: string) => (round === 1 ? id : `${id}-round-${round}`);
        const id = (base: string) => rev(rnd(base));
        const editorialNotes = editorialNotesDirective(roundNotes);

        // ── 09/09a: draft, then VERIFY it is not a repeat, before anything else ──
        //
        // `recentPosts` in the drafting input below is ADVISORY: it asks the model
        // not to repeat itself and nothing ever checked whether it listened, so a
        // lightly-reworded reissue of last week's edition passed every gate. 09a
        // is the verification half — the same `checkOutputDedupe` primitive,
        // scoring the same excerpt window the read above pulled, with
        // `evaluateDedupe`'s calibrated trigram-Jaccard threshold, inside the
        // drafting pass, so a `similar` verdict COSTS the draft (it is redrafted
        // with the offending edition quoted into the prompt) and the human at
        // step 16 can never be shown a draft that has not been scored.
        //
        // On the final attempt the draft ships FLAGGED rather than held — two
        // editions a fortnight apart about the same launch may be exactly right,
        // and a fixed threshold is not entitled to overrule the person reviewing
        // at 16. The verdict is checkpointed either way.
        //
        // Scored on the COMPOSED draft (`composeCompliantDraft` applied here as
        // well as below), because that — `${subjectLine}\n${text}`, footer and all
        // — is exactly what step 19 records back into the window.
        const draftWithVerifiedDedupe = async (): Promise<NewsletterPostOutput> => {
          /** Set by a failed 09a check, so the NEXT attempt's prompt names exactly which published edition to move away from. */
          let dedupeRetrySteer: string | undefined;
          for (let attempt = 1; attempt <= MAX_DEDUPE_ATTEMPTS; attempt++) {
            /** Attempt 1 keeps the ORIGINAL step ids. */
            const att = (base: string) => (attempt === 1 ? base : `${base}-attempt-${attempt}`);
            const draftResult = await wf.step.agent(id(att("09-draft-post")), draftAgent, {
              ...runDirectionField(runDirection),
              mainStory: selected.mainStory,
              secondaryTopics: selected.secondaryTopics,
              source: selected.source,
              theme,
              ...clientPicture,
              // The edition plan: what leads, from what angle, what the team
              // thinks, which quick hits, what to do. The draft writes the plan.
              plan,
              ...(researchDigest !== undefined ? { research: researchDigest } : {}),
              ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
              ...(dedupeRetrySteer !== undefined ? { dedupeAvoid: dedupeRetrySteer } : {}),
              // Three distinct steers, kept apart on purpose: `pastFeedback` is
              // what this client has said across previous RUNS, `revisionRequest`
              // is what a human reviewer asked about THIS edition minutes ago, and
              // `editorialNotes` is what this run's own gates and editor found
              // wrong with the previous round's draft.
              ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
              ...(directive !== undefined ? { revisionRequest: directive } : {}),
              ...(editorialNotes !== undefined ? { editorialNotes } : {}),
            });

            if (draftResult.status === "content_fail") {
              throw new WorkflowHeld(`draft did not clear its own self-critique gate: ${draftResult.status}`);
            }
            if (draftResult.status !== "completed") {
              throw new WorkflowToolingFailure(`draft step resolved to "${draftResult.status}"`);
            }
            const candidate = draftResult.finalOutput!;
            const asShipped = composeCompliantDraft(candidate, clientContext.brand);

            const dedupeVerdict = await checkOutputDedupe(
              wf,
              id(att("09a-verify-not-duplicate")),
              `${asShipped.subjectLine}\n${asShipped.text}`,
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
        const authoredDraft = await draftWithVerifiedDedupe();

        /**
         * Everything wrong with this round's draft, collected across every
         * gate rather than stopping at the first, so one redraft fixes all of
         * it. A gate's own wording leads each entry, so a held run's reason
         * still reads exactly as it did when the gates held on first failure.
         */
        const problems: string[] = [];
        const problem = (message: string) => {
          problems.push(message);
        };

        // Hype/forbidden-terms scan runs on the MODEL's own authored text, before the
        // platform's compliance footer is anywhere near it (Phase-2.5 fix — see
        // composeCompliantDraft's doc comment for why this ordering matters).
        // requiredDisclaimer is deliberately omitted here: the footer that satisfies
        // it hasn't been injected yet, and its presence is verified structurally at
        // step 12 instead, not by re-running this hype-scanning gate against it.
        await wf.step.code(id("10-verify-brand-compliance"), async () => {
          const forbiddenTerms = clientContext.brand["forbiddenTerms"] as string[] | undefined;
          const verdict = await runGate(tools, "gate.brandCompliance", { text: authoredDraft.text, forbiddenTerms: forbiddenTerms ?? [] }, ctx);
          if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.brandCompliance: ${verdict.reason}`);
          if (verdict.verdict === "content_fail") problem(`brand compliance failed: ${verdict.reason}`);
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

        await wf.step.code(id("11-verify-numbers-sourced"), async () => {
          // What a figure in the edition may be traced to: the full text of every
          // research document (the gate verifies against CONTENT, and a URL alone
          // verifies nothing), the client's own intel report, and the topics the
          // run was given (a catalog topic or a typed request is the client's own
          // statement).
          const sources = [
            ...researchSourceTexts(research),
            ...(clientIntelContext !== undefined ? [clientIntelContext] : []),
            selected.mainStory,
            ...selected.secondaryTopics,
            ...(candidateSummary.hasNumericInsight ? [candidateSummary.sourceLabel] : []),
          ];
          const verdict = await runGate(tools, "gate.numbersSourced", { text: draft.text, sources }, ctx);
          if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.numbersSourced: ${verdict.reason}`);
          if (verdict.verdict === "content_fail") {
            problem(
              `numbers not sourced: ${verdict.reason}. Each of these figures must be quoted exactly as a research source or the client's own material writes it, or replaced with a qualitative description.`,
            );
          }
          return verdict;
        });

        // Structural backstop, not a re-run of the hype-scanning gate: confirms the
        // footer this workflow itself just composed actually landed in the final
        // text. A failure here means composeCompliantDraft was bypassed or broken —
        // an internal bug, never a content problem — so it's a tooling failure, not
        // a held run, and never a redraft.
        await wf.step.code(id("12-verify-compliance-footer"), (): void => {
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

        // The shipped artifact's placeholder/leak pair — an unresolved placeholder
        // or a leaked credential/internal term is a redraft note like any other
        // content problem, and a hold on the last round.
        await wf.step.code(id("13-verify-no-placeholder"), async () => {
          const verdict = await runGate(tools, "gate.noPlaceholder", { text: draft.text }, ctx);
          if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.noPlaceholder: ${verdict.reason}`);
          if (verdict.verdict === "content_fail") problem(`unresolved placeholder: ${verdict.reason}`);
          return verdict;
        });

        await wf.step.code(id("14-verify-no-leak"), async () => {
          const verdict = await runGate(tools, "gate.leakCheck", { text: draft.text }, ctx);
          if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`gate.leakCheck: ${verdict.reason}`);
          if (verdict.verdict === "content_fail") problem(`leak check failed: ${verdict.reason}`);
          return verdict;
        });

        await wf.step.code(id("15-render-preview-check"), async () => {
          const outcome = await tools["render.preview"]!.execute(
            { subjectLine: draft.subjectLine, previewText: draft.previewText, text: draft.text },
            { ctx },
          );
          if (outcome.status !== "success") throw new WorkflowToolingFailure(`render.preview failed: ${outcome.status}`);
          const preview = outcome.result as RenderPreviewResult;
          if (!preview.subjectLineWithinLimit) problem(`subject line exceeds the 70-character limit (${preview.subjectLineCharacterCount} chars)`);
          if (!preview.previewTextWithinLimit) problem(`preview text exceeds the 140-character limit (${preview.previewTextCharacterCount} chars)`);
          if (!preview.bodyWithinLimit) problem(`edition exceeds the 10000-character body limit (${preview.bodyCharacterCount} chars)`);
          return preview;
        });

        // ── 15b: the deterministic half of the editorial pass ──
        const lint = await wf.step.code(id("15b-editorial-lint"), async (): Promise<EditorialLintResult> => {
          const outcome = await tools["newsletter.editorialLint"]!.execute(
            {
              subjectLine: authoredDraft.subjectLine,
              previewText: authoredDraft.previewText,
              intro: authoredDraft.intro,
              sections: authoredDraft.sections,
              callToAction: authoredDraft.callToAction,
              signoff: authoredDraft.signoff,
              allowedUrls: [...allowedUrls, ...(authoredDraft.callToAction.url ? [authoredDraft.callToAction.url] : [])],
            },
            { ctx },
          );
          if (outcome.status !== "success") throw new WorkflowToolingFailure(`newsletter.editorialLint failed: ${outcome.status}`);
          const result = outcome.result as EditorialLintResult;
          for (const item of result.evidence) problem(`editorial lint: ${item}`);
          return result;
        });

        if (problems.length > 0) {
          if (round < MAX_EDITORIAL_ROUNDS) {
            roundNotes.push(...problems);
            continue;
          }
          throw new WorkflowHeld(problems.join("; "));
        }

        // ── 15c: the editor — the judgment none of the gates can make ──
        const editorResult = await wf.step.agent(id("15c-editor-verdict"), editorAgent, {
          draft: {
            subjectLine: authoredDraft.subjectLine,
            previewText: authoredDraft.previewText,
            intro: authoredDraft.intro,
            sections: authoredDraft.sections,
            callToAction: authoredDraft.callToAction,
            signoff: authoredDraft.signoff,
          },
          plan,
          ...clientPicture,
          researchTitles: (research.result?.documents ?? []).map((d) => ({ title: d.title, ...(d.url !== undefined ? { url: d.url } : {}) })),
          lintWarnings: lint.warnings,
          lintStats: lint.stats,
          round,
          ...(lastEditorNotes.length > 0 ? { previousNotes: lastEditorNotes } : {}),
          ...(directive !== undefined ? { revisionRequest: directive } : {}),
        });
        if (editorResult.status !== "completed") {
          throw new WorkflowToolingFailure(`editor verdict step resolved to "${editorResult.status}"`);
        }
        lastEditor = editorResult.finalOutput!;
        lastEditorNotes = lastEditor.notes;

        if (lastEditor.verdict === "revise" && round < MAX_EDITORIAL_ROUNDS) {
          roundNotes.push(...lastEditor.notes.map((n) => `Editor: ${n}`));
          continue;
        }

        // ── terminal topic guardrail ──
        //
        // Before the human gate: a reviewer should never be shown a draft that
        // engages a subject this client said it does not touch. Not a repeat of
        // gate.brandCompliance -- that matches forbiddenTerms as substrings and
        // catches the word, while this judges the subject. Free for a client who
        // forbids nothing: no list, no step, no model call.
        await runTopicGuardrail(
          wf,
          { tools, promptStore: options.promptStore, router: options.router },
          draft.text,
          intake.forbiddenTopics,
          revision === 0 ? undefined : `-r${revision}`,
        );

        editorialByRevision.set(revision, {
          verdict: lastEditor.verdict,
          scores: lastEditor.scores,
          notes: lastEditor.notes,
          rounds: round,
          // Shipped on the last round with the editor still asking for changes:
          // the reviewer sees the reservations instead of the run losing them.
          flagged: lastEditor.verdict === "revise",
        });
        return draft;
      }
      // Unreachable: every branch of the last round either returns or throws.
      throw new WorkflowToolingFailure("the editorial round loop ended without a draft");
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
        payload: {
          runId: wf.runId,
          mainStory: selected.mainStory,
          theme,
          preview: draft.text,
          revision,
          subjectLine: draft.subjectLine,
          previewText: draft.previewText,
          planThesis: plan.thesis,
          ...(editorialByRevision.has(revision) ? { editorial: editorialByRevision.get(revision) } : {}),
        },
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
    const editorial = editorialByRevision.get(review.revision);

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
        planThesis: plan.thesis,
        researchQueries,
        ...(editorial !== undefined ? { editorial } : {}),
        deliverableId,
      }),
    });

    // ── 19: commit updates (topics.commit, memory.appendDecision) — the review
    // decision itself is already durable: `onDecision` above called
    // `persistReviewFeedbackToMemory` for every round, which is the one real
    // feedback pipeline (AU22). ──
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
    });

    return {
      mainStory: selected.mainStory,
      theme,
      targetAudience: intake.targetAudience,
      deliverableId,
      preview: draft.text,
      ...(editorial !== undefined ? { editorial } : {}),
    };
  };
}
