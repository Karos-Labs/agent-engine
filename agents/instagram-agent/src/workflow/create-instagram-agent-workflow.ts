import fs from "node:fs/promises";
import path from "node:path";
import { readForbiddenTopics } from "@agent-engine/core";
import type { AgentContext, AgentTool, AgentToolRegistry, GateResponse, ModelRouter, PromptStore, TemplateFeedback } from "@agent-engine/core";
import { type WorkflowContext, type RevisionNote, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure, runAutoSetup, runReviewCycle, runTopicGuardrail, readRunDirection, revisionDirective, runDirectionField, buildClientVoiceContext } from "@agent-engine/workflow";
import type { RenderCarouselInput, RenderCarouselResult } from "@agent-engine/tool-karos-publish";
import { InstagramCopyAgent } from "../agent/instagram-copy-agent.js";
import { InstagramImageVettingAgent } from "../agent/instagram-image-vetting-agent.js";
import { InstagramResearchAgent } from "../agent/instagram-research-agent.js";
import { InstagramVisualQaAgent } from "../agent/instagram-visual-qa-agent.js";
import { materializeTemplates, reviewTemplate, templateFileName, type TemplateStore } from "@agent-engine/tool-karos-templates";
import { ARCHETYPE_TEMPLATE_FILES, assembleSlidesData, checkSlidesData, resolveLayout } from "./slides-data.js";
import { checkCraftHygiene } from "./craft-hygiene.js";
import {
  BrandTokensSchema,
  type BrandTokens,
  ResearchOutputSchema,
  StyleConfigSchema,
  type ImageCandidate,
  type ImageSelection,
  type InstagramAgentWorkflowResult,
  type InstagramCopyOutput,
  type InstagramFrozenConfig,
  type InstagramRunClaim,
  type InstagramSlideLayout,
  type InstagramTopicClaim,
  type ResearchOutput,
} from "./types.js";

/**
 * The self-check retry cap (RFC-03 §3 step 07): "capped at two returns to
 * step 05" means the very first attempt plus at most two revisions — three
 * total tries at steps 05-07 before the post is `WorkflowHeld`. P0
 * parity-audit Fixes 2 and 3 extend what this SAME budget covers — a step
 * 07b craft-hygiene failure or a step 08b visual-QA failure both `continue`
 * this same loop exactly like a step 07 self-check failure, rather than
 * getting their own separate retry mechanism.
 */
const MAX_SELF_CHECK_ATTEMPTS = 3;

/**
 * Revision rounds a reviewer may request before the run holds instead.
 *
 * Two, plus the original draft, so a person gets a real back-and-forth
 * without the loop becoming unbounded. It has to be bounded: every round
 * re-runs the paid drafting steps (copy, vetting, generation, render), and a
 * reviewer who keeps clicking "revise" would otherwise keep spending with
 * nothing in the system noticing.
 */
const MAX_REVISION_ROUNDS = 2;

/**
 * Writes one review decision to durable client memory, and routes any
 * per-slide template notes to the template registry.
 *
 * Two destinations because they are two different lessons. The reviewer's
 * words about the POST go to `memory.appendFeedback`, which the next run reads
 * back as standing guidance. Their words about a TEMPLATE go to the registry,
 * where they move that template's `qualityScore` and therefore which layout
 * later runs across every client actually get.
 *
 * Idempotent by construction: `feedbackId` is `${runId}-r${revision}`, so a
 * replayed run appends one row rather than one per replay.
 *
 * Failures are swallowed and logged, deliberately and narrowly: losing a note
 * is bad, but failing an already-APPROVED run because a memory write timed out
 * would throw away a finished carousel the client is waiting for. The gate
 * record itself still holds the decision verbatim, so nothing is
 * unrecoverable.
 */
async function persistReviewFeedback(
  wf: WorkflowContext,
  tools: AgentToolRegistry,
  ctx: AgentContext,
  input: {
    revision: number;
    response: GateResponse;
    templateFeedback: readonly TemplateFeedback[];
    templateStore?: TemplateStore | undefined;
  },
): Promise<void> {
  const note = input.response.feedback ?? input.response.reason;
  const append = tools["memory.appendFeedback"];
  if (note !== undefined && append !== undefined) {
    try {
      await wf.step.code(`09a-record-feedback-r${input.revision}`, async () =>
        append.execute(
          {
            feedbackId: `${wf.runId}-r${input.revision}`,
            productId: wf.productId,
            decision: input.response.decision,
            actor: input.response.actor,
            note,
            revision: input.revision,
            runId: wf.runId,
          },
          { ctx },
        ),
      );
    } catch (error) {
      console.error(`persistReviewFeedback: could not record review feedback for run ${wf.runId}`, error);
    }
  }

  if (input.templateFeedback.length === 0 || input.templateStore === undefined) return;
  for (const entry of input.templateFeedback) {
    try {
      await wf.step.code(`09a-template-feedback-r${input.revision}-s${entry.slide}`, async () => {
        await reviewTemplate({
          store: input.templateStore!,
          templateId: entry.templateId,
          actor: input.response.actor,
          verdict: entry.verdict,
          note: entry.note,
          now: Date.now(),
        });
        return { templateId: entry.templateId, verdict: entry.verdict, promoted: entry.promote };
      });
    } catch (error) {
      console.error(`persistReviewFeedback: could not record template feedback for "${entry.templateId}"`, error);
    }
  }
}

/**
 * P0 parity-audit Fix 1: carousel-agent-v2 SKILL.md step 01's "absent or
 * empty, the default applies: the highest-evidence unused row across the
 * lanes that are furthest behind cadence" describes a real multi-lane
 * cadence-selection algorithm this Phase-1 build does not implement (it
 * would need per-lane cadence/schedule tracking that doesn't exist anywhere
 * in this repo yet). Rather than silently skip lane-scoped floor protection
 * whenever a client hasn't set an explicit `requestedLane` — which would
 * quietly defeat the whole point of Fix 1 — every run that doesn't specify a
 * lane falls back to this one named lane, so the floor guard in
 * `topics.reserve` is ALWAYS exercised, never silently bypassed. This is a
 * documented Phase-1 stand-in for the real "furthest behind cadence"
 * selection, not a claim that every client's topics naturally belong to one
 * lane called "general."
 */
export const DEFAULT_CAROUSEL_LANE = "general";

export interface CreateInstagramAgentWorkflowOptions {
  /** The base Layer 3 registry (client/research/topics/gates/ledger/publish) — see `packages/tools/src/index.ts`'s `createAllKarosTools()`. */
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips step 09's human `batch_review` gate and records a synthetic
   * `actor: "system"` approval instead — off by default, matching
   * `linkedin-agent`'s exact same opt-out pattern (RFC-01 §8.3). Intended
   * for tests/demos/evals that need a synchronous happy path, never for
   * production wiring.
   */
  autoApprove?: boolean;
  /**
   * The real filesystem directory every `templateDir`/`outDir`/image path in
   * this run's `slides-data.json` is resolved and bounds-checked against
   * (`publish.renderCarousel`'s own `repoRoot` input — RFC-03 §1 required-
   * reading item 2's `assertInside` guard). Required: there is no safe
   * default for "where do this deployment's templates/images actually live
   * on disk."
   */
  repoRoot: string;
  /**
   * A fixed candidate pool for step 06 to vet against.
   *
   * Optional, and normally omitted: step 05b now calls `media.findImages` to
   * source candidates from each slide's own `visualNeed`. Supplying a pool
   * here overrides that entirely, which is what tests and evals want (a fixed
   * pool is the only way to make step 06 deterministic) and what a caller
   * with curated client-owned assets wants.
   *
   * Defaults to empty, which no longer means "every run holds": empty is the
   * signal to go and search.
   */
  imageCandidatePool?: ImageCandidate[];
  /**
   * The slide-template registry (`@agent-engine/tool-karos-templates`).
   *
   * Omit and the run reads archetype templates straight off disk from the
   * client's own `templateDir`, exactly as it did before the registry
   * existed. Supply one and step 04c MATERIALIZES the registry's winning
   * template per archetype into this run's own directory and renders from
   * there (Approach (a)) — which is what lets a template live in Firestore,
   * and what the promotion path writes into.
   *
   * Optional rather than required on purpose: the registry must never be
   * able to take slide rendering down, and a caller that has not wired one
   * should get the previous behaviour rather than a broken run.
   */
  templateStore?: TemplateStore | undefined;
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

/**
 * `createInstagramAgentWorkflow()` (RFC-03): the 9-step run protocol,
 * steps 01-09, native to `agent-engine` from day one (RFC-03 §1 — no legacy
 * execution path exists to preserve compatibility with). Every legacy v1->v2
 * defect fix (RFC-03 §2) is structural here, not a comment:
 *
 * 1. **Context bloat** — every `BaseAgent` step (`allowedTools: []`) only
 *    ever sees the one already-assembled input the workflow hands it for
 *    that run; nothing here reads a growing ledger/master-file in full.
 * 2. **A rogue rendering path** — step 08 calls the one shared, already-
 *    tested `publish.renderCarousel` tool; this package writes no rendering
 *    code of its own, and never touches an absolute path (`assembleSlidesData`
 *    only ever produces repo-relative paths, which `assertInside` inside the
 *    tool itself refuses to relax).
 * 3. **The ledger illusion** — `topics.reserve` (step 03) is the only claim
 *    made before any paid work runs, and it is the only thing step 09
 *    re-confirms (`topics.commit`) before logging; no second, shadow dedup
 *    mechanism exists anywhere in this workflow.
 *
 * P0 parity-audit fixes layered on top of the above (see each fix's own doc
 * comment at its call site below for the full rationale):
 *
 * - **Fix 1** — step 03 passes the run's actual lane to `topics.reserve`,
 *   restoring the lane/floor-of-5 dedup model instead of a single
 *   undifferentiated catalog.
 * - **Fix 2** — steps 05-08 now share ONE retry loop that also covers a new
 *   step 08b post-render visual QA, not just step 07's self-check.
 * - **Fix 3** — step 07b is a new, unconditional mechanical craft-hygiene
 *   gate (em dash/exclamation/sentence-case), plus cross-post image-reuse
 *   prevention wired into step 06 and step 09b.
 * - **Fix 4** — step 06's image selections now carry a real rights/licence/
 *   watermark verdict, and a failing one is never shipped.
 *
 * ## The zero-held guarantee (2026-08)
 *
 * A carousel never fails to ship BECAUSE OF A PICTURE. Every tier can be down
 * at once (every stock/CC provider, the social scrape, the generative rescue)
 * and the run still delivers, degrading the affected slides to typographic
 * archetypes. Four mechanisms carry it:
 *
 * 1. An empty candidate pool skips the vetting model call and falls straight
 *    to the rescue tiers, rather than holding on a verdict about nothing.
 * 2. A sourcing `tooling_error` (a provider outage) is RECORDED, not thrown.
 *    It used to fail the whole run, so one library returning 503 discarded
 *    copy that was already written.
 * 3. Step 06f re-verifies every selected image is still on disk, so a media
 *    cache lost to an instance recycle degrades the slide instead of failing
 *    the render.
 * 4. A render `content_fail` strips every image and re-renders once, fully
 *    typographic, before reporting anything.
 *
 * Four holds remain, and none is a picture problem: no subject available at
 * all, research producing no schema-valid facts, the copy/compliance
 * self-checks never passing inside the retry budget, and a human rejecting
 * the batch review. Each is asserted in `__tests__/zero-held-guarantee.test.ts`
 * so the boundary is pinned rather than assumed.
 */
export function createInstagramAgentWorkflow(options: CreateInstagramAgentWorkflowOptions) {
  const tools = options.tools;
  const imageCandidatePool = options.imageCandidatePool ?? [];

  return async function instagramAgentWorkflow(wf: WorkflowContext): Promise<InstagramAgentWorkflowResult> {
    const ctx = toAgentContext(wf);

    // The run-scoped instruction and any media the person attached. Read once:
    // the direction steers copy, and the attachments become Tier 0 below.
    const runDirection = readRunDirection(wf.input);

    // ── 00-auto-setup: onboard this client inline, rather than requiring
    // somebody to have dispatched a separate setup agent first ──
    //
    // Step 03 below survives an unseeded catalog by falling back, which fixed
    // the outage where "every run died at step 03" — but a client whose catalog
    // is never seeded then runs in fallback FOREVER, and so runs forever
    // without the dedup lock the catalog exists to provide. This seeds it from
    // the titles of documents `research.pull` actually retrieved, so step 03
    // can reserve properly from the next run onward.
    //
    // Genuinely first, and it reads its own `client.getConfig`/`getProfile`
    // rather than borrowing step 01's `runClaim`. That costs one extra store
    // read and buys a step whose name does not lie: a step called `00-` that
    // executed third would misdescribe every run record it appears in.
    //
    // Never fails the run. Every problem (no scraper, an outage, no usable
    // titles, no declared industry) degrades to a recorded note, and step 03's
    // fallback carries the run exactly as it did before this step existed.
    // Not bound to a local: nothing downstream branches on the outcome (step
    // 03 re-reads the catalog either way), and `wf.step.code` already persists
    // the returned notes into the run record, which is where someone
    // debugging "why is this client still in fallback" will look.
    await wf.step.code("00-auto-setup", async () => {
      const [configOutcome, profileOutcome] = await Promise.all([
        tools["client.getConfig"]!.execute({}, { ctx }),
        tools["client.getProfile"]!.execute({}, { ctx }),
      ]);

      // Seeded topics must land in the lane step 03 will reserve from, or the
      // reserve breaches on a lane mismatch and the seeding was wasted.
      const runConfig = configOutcome.status === "success" ? (configOutcome.result as Record<string, unknown>) : {};
      const lane = typeof runConfig["requestedLane"] === "string" ? (runConfig["requestedLane"] as string) : DEFAULT_CAROUSEL_LANE;

      // Gated on a declared industry, and that gate is load-bearing rather
      // than defensive. Seeding needs a query; without an industry the only
      // available query is generic, and generic research would seed topics
      // with no relationship to this client. Step 03 would then reserve one
      // and draft from it in good faith, so an off-brand catalog is worse than
      // an empty one. A client with no profile is left to hold, honestly.
      const industry = industryForSetup(profileOutcome);
      if (industry === undefined) {
        return {
          ran: false,
          catalogSizeBefore: 0,
          catalogSizeAfter: 0,
          topicsAdded: 0,
          notes: ["client has no declared industry, so there is no honest query to seed topics from"],
        };
      }

      return runAutoSetup({
        tools,
        ctx,
        lane,
        researchJob: "instagram-topic-seed",
        researchQuery: `${industry} content topics and trends`,
      });
    });

    // ── 01: open the run / claim the post number ──
    const runClaim = await wf.step.code("01-open-run", async (): Promise<InstagramRunClaim> => {
      const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
      const runConfig = configOutcome.status === "success" ? (configOutcome.result as Record<string, unknown>) : {};
      const requestedLane = typeof runConfig["requestedLane"] === "string" ? (runConfig["requestedLane"] as string) : undefined;
      const requestedSubject = typeof runConfig["requestedSubject"] === "string" ? (runConfig["requestedSubject"] as string) : undefined;
      const requestedPostNumber = typeof runConfig["postNumber"] === "number" ? (runConfig["postNumber"] as number) : undefined;
      // `wf.runId` is already a caller-supplied, globally-unique idempotency
      // key (RFC-01 §9.1 rule 2), so it doubles as `postId` directly — a
      // dedicated sequential-counter tool (RFC-03 §3's suggested
      // `carousel.claimRunNumber`) is real shared infrastructure this
      // package's brief explicitly does not include building; `postNumber`
      // below is therefore best-effort/cosmetic (client-suppliable), never
      // load-bearing for any later step's correctness.
      return {
        postId: wf.runId,
        postNumber: requestedPostNumber ?? 1,
        ...(requestedLane !== undefined ? { requestedLane } : {}),
        ...(requestedSubject !== undefined ? { requestedSubject } : {}),
      };
    });

    // ── 02: freeze the small files — style config + brand tokens, parse-check-or-HALT ──
    const frozen = await wf.step.code("02-freeze-style-config", async (): Promise<InstagramFrozenConfig> => {
      const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
      if (configOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client config has not been set up for this client yet — cannot freeze a style config or brand tokens");
      }
      const config = configOutcome.result as Record<string, unknown>;

      const styleConfigParse = StyleConfigSchema.safeParse(config["instagramStyleConfig"]);
      if (!styleConfigParse.success) {
        // Never guess defaults silently (RFC-03 §1 required-reading item 1's
        // "parse-check-or-HALT" rule) — a bad/missing style config blocks
        // intake outright.
        throw new WorkflowBlockedIntake(
          `client's instagramStyleConfig failed to parse/validate — refusing to guess defaults: ${styleConfigParse.error.message}`,
        );
      }
      const brandTokensParse = BrandTokensSchema.safeParse(config["instagramBrandTokens"]);
      if (!brandTokensParse.success) {
        throw new WorkflowBlockedIntake(
          `client's instagramBrandTokens failed to parse/validate — refusing to guess defaults: ${brandTokensParse.error.message}`,
        );
      }
      if (styleConfigParse.data.canvas.scale !== 2) {
        throw new WorkflowBlockedIntake(
          `client's frozen canvas.scale must be exactly 2, got ${styleConfigParse.data.canvas.scale} — publish.renderCarousel's QA PNG floor depends on it`,
        );
      }

      return {
        forbiddenTopics: readForbiddenTopics(configOutcome.result),
        styleConfig: styleConfigParse.data,
        brandTokens: brandTokensParse.data,
      };
    });

    // ── 02b: the client's own voice/profile context — best-effort, never blocking ──
    //
    // Everything else this workflow reads (`instagramStyleConfig`,
    // `instagramBrandTokens`) is colors, canvas and compliance words. None of
    // it carries what a client's brand voice actually SAYS — including, for a
    // client like Geektime (Israel's largest HEBREW-language tech site), the
    // language the post has to be written in. That sentence lives in
    // `client.getProfile`'s `description` and `client.getVoiceRules`'s
    // `guidelines`, neither of which this workflow ever called before, so a
    // carousel drafted in fluent English for a Hebrew-only outlet passed every
    // check that existed and shipped anyway (prep job hcf9ymPGJC7mDS5pcEQ4).
    //
    // Best-effort and non-blocking on purpose: a client with no profile/voice
    // rules set up yet should still get a carousel, in English, same as
    // before this step existed — this step only ever ADDS context, it never
    // gates on finding any.
    const clientVoiceContext = await wf.step.code("02b-load-client-voice-context", async () => {
      const profileOutcome = await tools["client.getProfile"]?.execute({}, { ctx });
      const voiceOutcome = await tools["client.getVoiceRules"]?.execute({}, { ctx });
      return buildClientVoiceContext(
        profileOutcome?.status === "success" ? (profileOutcome.result as Record<string, unknown>) : undefined,
        voiceOutcome?.status === "success" ? (voiceOutcome.result as Record<string, unknown>) : undefined,
      );
    });

    // Render-type rules from the frozen config (Fix 2) — evaluated post-render
    // by step 08b, never by step 07's checkSlidesData (which only ever
    // evaluates `check: "copy"` rules).
    const renderRules = frozen.styleConfig.rules.filter((r) => r.check === "render");

    // ── 03: claim the subject — the catalog first, then the same fallbacks every other channel already has ──
    const topicClaim = await wf.step.code("03-claim-topic", async (): Promise<InstagramTopicClaim> => {
      const reservationKey = `${wf.runId}__topic`;
      const lane = runClaim.requestedLane ?? DEFAULT_CAROUSEL_LANE;

      /*
       * A SUBJECT SOMEONE TYPED FOR THIS RUN OUTRANKS THE CATALOG.
       *
       * This is the one thing that goes above the reservation, and a live prep
       * run is what showed why it has to. The direction reached the copy step
       * (`runDirectionField` at step 05) but not this one, so the catalog picked
       * the subject, step 04 researched THAT subject, and the writer was handed
       * a direction it could not honour alongside facts about something else.
       * It wrote about the facts, correctly, and the person got a carousel on a
       * topic they had not asked for — with no error anywhere.
       *
       * The rule below is the same one blog-agent and x-agent already apply, and
       * the reasoning the surrounding comment gives for keeping the RESERVATION
       * first does not reach it. That reasoning is about `requestedSubject`, a
       * STANDING config field: making it outrank the catalog would silently drop
       * the dedup lock on every run of every client who ever set it. A typed
       * direction is per-run and per-person — it cannot silently affect a run
       * nobody typed at.
       *
       * Dedup honesty is preserved exactly as the fallback path preserves it: no
       * `reservationKey`, so step 09 skips `topics.commit` and the catalog is
       * never told it issued a topic it did not.
       */
      if (runDirection.topicOverride) {
        return { topic: runDirection.topicOverride, source: "requested" };
      }

      const outcome = await tools["topics.reserve"]!.execute({ reservationKey, count: 1, excludeTopics: [], lane }, { ctx });
      if (outcome.status === "success") {
        const result = outcome.result as { reservationKey: string; topics: string[] };
        return { reservationKey: result.reservationKey, topic: result.topics[0]!, source: "reserved" };
      }
      if (outcome.status !== "content_fail") {
        throw new WorkflowToolingFailure(`topics.reserve failed: ${outcome.status}`);
      }

      /*
       * A FLOOR BREACH IS NO LONGER THE END OF THE RUN.
       *
       * The old code threw `WorkflowHeld` here, and its reasoning was sound in
       * isolation: the catalog is "the only dedup gate" (RFC-03 §2.3), so
       * proceeding without a claim means proceeding without the dedup lock, and
       * inventing a topic in a deterministic code step would be fabrication.
       * What that reasoning missed is that THIS AGENT WAS THE ONLY ONE THAT DID
       * IT. Every other caller of `topics.reserve` in this repo — x-agent,
       * linkedin-agent, blog-agent, newsletter-agent, reddit-agent,
       * campaign-orchestrator — treats a `content_fail` as "the catalog can't
       * help this run" and falls through to a research-derived candidate
       * (x-agent's step 06/07 is the closest analogue and the model followed
       * here). And it is also the only caller that passes `lane`, so it is the
       * only one whose reserve can breach on a lane mismatch rather than on an
       * empty catalog.
       *
       * The consequence in production was total, not marginal: nothing in this
       * repo ever seeds a topics catalog with real rows (`topics.topUp` is
       * called by exactly one caller — `topics.reserve`'s own proactive top-up,
       * with an empty array, a documented no-op), so a client whose catalog was
       * never seeded out of band could not run this agent AT ALL. Every run
       * died at step 03. That is not a guardrail declining a post; that is an
       * agent that cannot start.
       *
       * The dedup honesty is preserved rather than dropped: a fallback claim
       * carries no `reservationKey`, `source` records where the subject really
       * came from, and step 09's `topics.commit` is skipped for it — so the
       * catalog is never told a topic was consumed that it never issued. What a
       * fallback run gives up is dedup PROTECTION, which is the correct trade
       * against not running: a possibly-repeated post is reviewable by the human
       * gate at step 09; a run that never happened is not.
       *
       * WHY THE RESERVATION IS STILL TRIED FIRST, unlike x-agent (whose
       * explicit `requestedTopic` outranks a reserved one): the happy path must
       * not change. A client with a healthy catalog keeps getting a real dedup
       * lock on every run, exactly as before — `requestedSubject` only decides
       * things when the catalog could not. Making it outrank the catalog would
       * silently drop the dedup lock for every run of every client who has ever
       * set that field, which is a different change with different consequences.
       */

      // 1. What the client actually asked for. Read into `InstagramRunClaim` at
      //    step 01 since that step was written and, until now, never once read —
      //    a client could set `requestedSubject` and have it silently ignored.
      if (runClaim.requestedSubject) {
        return { topic: runClaim.requestedSubject, source: "requested" };
      }

      // 2. A research-derived subject, built the same way x-agent's step 04/05
      //    builds its own fallback candidate: from the client's own declared
      //    industry, labelled for what it is. Phase 1's `research.pull` has no
      //    real search backend (see karos-research/src/pull.ts), so the honest
      //    candidate is the QUERY, never a fabricated finding — the research
      //    agent at step 04b still does the real sourcing work on top of it.
      const profileOutcome = await tools["client.getProfile"]!.execute({}, { ctx });
      const industry =
        profileOutcome.status === "success" && typeof (profileOutcome.result as Record<string, unknown>)["industry"] === "string"
          ? ((profileOutcome.result as Record<string, unknown>)["industry"] as string)
          : undefined;
      if (industry) {
        return { topic: `${industry} trends this week`, source: "research" };
      }

      // 3. Genuinely nothing to post about: no catalog row, no requested
      //    subject, and no declared industry to derive one from. NOW a hold is
      //    the honest answer, and its message says which three things were
      //    missing rather than blaming the catalog alone.
      throw new WorkflowHeld(
        `no subject available for this run — the topics catalog could not serve lane "${lane}" (${outcome.reason}), ` +
          `no requestedSubject was set, and the client profile declares no industry to derive one from`,
      );
    });

    // ── 04: research the subject — verbatim raw payload capture, then judgment ──
    const researchPull = await wf.step.code("04a-research-pull", async () => {
      const outcome = await tools["research.pull"]!.execute(
        { job: "instagram-carousel-research", query: topicClaim.topic, window: "24h" },
        { ctx },
      );
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`research.pull failed: ${outcome.status}`);
      }
      return outcome.result as { runId: string; query: string; result: unknown };
    });

    const researchAgent = new InstagramResearchAgent({ router: options.router, tools, promptStore: options.promptStore });
    const researchExec = await wf.step.agent("04b-research-extract-facts", researchAgent, {
      topic: topicClaim.topic,
      rawPayload: researchPull.result,
      rawPayloadRef: researchPull.runId,
    });
    if (researchExec.status === "content_fail") {
      throw new WorkflowHeld("research extraction did not produce output that cleared its own schema — nothing honestly cleared this run's research step");
    }
    if (researchExec.status !== "completed") {
      throw new WorkflowToolingFailure(`research extraction step resolved to "${researchExec.status}"`);
    }
    // Re-validate defensively — `finalOutput` is already schema-checked inside
    // BaseAgent, but this keeps step 07's self-check callers honestly typed
    // without a non-null assertion on a value this workflow never produced itself.
    const research: ResearchOutput = ResearchOutputSchema.parse(researchExec.finalOutput);

    // Cross-post image-reuse prevention (Fix 3): fetched once, before any
    // vetting attempt — every prior post's shipped images for this client,
    // so step 06 can refuse to reselect one regardless of what the model does.
    const usedImagesOutcome = await wf.step.code("05a-list-used-images", async () => tools["ledger.listUsedImages"]!.execute({}, { ctx }));
    if (usedImagesOutcome.status !== "success") {
      throw new WorkflowToolingFailure(`ledger.listUsedImages failed: ${usedImagesOutcome.status}`);
    }
    const usedImages = (usedImagesOutcome.result as { imagePaths: string[] }).imagePaths;
    const usedImagesSet = new Set(usedImages);

    // ── Tier 0: media the client attached to this run ──
    //
    // Above every sourcing tier, and the reasoning is not subtle: a client who
    // uploaded a photograph has told us exactly what they want on the slide.
    // No harvester, scrape or generation outranks that, and asking a vetting
    // model to "choose" between a client's own asset and a stock photo would
    // be inviting it to overrule them.
    //
    // The attachment is INGESTED, not passed through. `assertInside` in
    // karos-publish refuses URL-shaped strings outright, so a `gs://` path in
    // the candidate pool would clear the rights gate, reach step 08 and die
    // there — after the run had already paid for copy, vetting and every other
    // tier. `media.ingestAssets` downloads it into the same
    // `.media-cache/<runId>/` every other tier writes to, through the same
    // downloader, so one set of content-type and size guarantees covers all of
    // them.
    //
    // Slides are assigned by upload order: the first attachment to slide 1, the
    // second to slide 2. A rule someone can predict from the order they
    // uploaded in, rather than a model deciding which of their photos "fits".
    const tier0Pool = await wf.step.code("05z-attach-user-media", async () => {
      const usable = runDirection.mediaAssets.filter((a) => a.role === "source" || a.role === "reference");
      const ingest = tools["media.ingestAssets"];
      if (usable.length === 0 || ingest === undefined) {
        return { candidates: [] as ImageCandidate[], slots: [] as number[], attached: usable.length, note: usable.length === 0 ? "no attachments on this run" : "media.ingestAssets is not registered" };
      }

      const outcome = await ingest.execute(
        {
          repoRoot: options.repoRoot,
          runId: wf.runId,
          assets: usable.map((asset, index) => ({
            uri: asset.uri,
            ...(asset.label ? { label: asset.label } : {}),
            slot: index + 1,
          })),
        },
        { ctx },
      );

      if (outcome.status !== "success") {
        // A failed ingest must not fail the run: the tiers below can still
        // fill every slide, and a client whose upload could not be read is
        // better served by a complete post plus a recorded reason than by no
        // post at all.
        return {
          candidates: [] as ImageCandidate[],
          slots: [] as number[],
          attached: usable.length,
          note: `attachments could not be ingested (${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""})`,
        };
      }

      const result = outcome.result as { candidates: ImageCandidate[]; unmet: Array<{ slot: number; reason: string }> };
      return {
        candidates: result.candidates,
        // Only the slides an asset actually landed on. An attachment that
        // failed to ingest must not reserve a slide the harvesters would then
        // skip, which would leave it empty for the rest of the run.
        slots: result.candidates.map((_, index) => index + 1),
        attached: usable.length,
        ...(result.unmet.length > 0 ? { note: result.unmet.map((u) => `slide ${u.slot}: ${u.reason}`).join("; ") } : {}),
      };
    });

    /** Slides already carrying a client upload, so no tier below wastes a call on them. */
    const tier0Slots = new Set(tier0Pool.slots);

    // ── 04c: resolve which archetype templates this run can actually render ──
    //
    // Two paths, one output. With a registry configured, its winning template
    // per archetype is MATERIALIZED into this run's own directory and the
    // renderer points there (Approach (a)); without one, the client's own
    // `templateDir` is probed for the bundled archetype files. Either way the
    // result is a `templateDir` plus the set of filenames present in it, and
    // everything downstream reads only those two facts.
    //
    // Why materialize rather than let the renderer take template bodies:
    // `publish.renderCarousel` resolves `templateDir` through `assertInside`,
    // which refuses absolute paths, URL-shaped strings, and anything escaping
    // the repo root. That guard is why a bad path there is a tooling failure
    // rather than a silent render of the wrong thing, and it works precisely
    // because the renderer only ever deals in repo-relative files. Writing
    // files keeps one code path with one set of guarantees.
    //
    // Failure yields an EMPTY set rather than a throw, on either path: the
    // conservative reading is "assume no archetype template is available",
    // which costs layout variety and nothing else, because every archetype
    // degrades to the client's own base template.
    const templateResolution = await wf.step.code("04c-resolve-templates", async () => {
      if (options.templateStore !== undefined) {
        try {
          const materialized = await materializeTemplates({
            store: options.templateStore,
            repoRoot: options.repoRoot,
            runId: wf.runId,
            clientSlug: wf.clientSlug,
            clientTemplateDir: frozen.brandTokens.templateDir,
            clientTemplateFile: frozen.brandTokens.slideTemplate,
          });
          return {
            templateDir: materialized.templateDir,
            files: Object.values(materialized.files),
            chosen: materialized.chosen,
          };
        } catch (error) {
          // A registry outage falls back to the on-disk path below rather
          // than failing the run — the whole point of the bundled floor.
          console.error("04c-resolve-templates: registry materialization failed, falling back to the client's templateDir", error);
        }
      }
      const dir = path.resolve(options.repoRoot, frozen.brandTokens.templateDir);
      try {
        const present = (await fs.readdir(dir)).filter((f) => ARCHETYPE_TEMPLATE_FILES.includes(f));
        return { templateDir: frozen.brandTokens.templateDir, files: present, chosen: [] };
      } catch {
        return { templateDir: frozen.brandTokens.templateDir, files: [], chosen: [] };
      }
    });
    const availableTemplates = new Set(templateResolution.files);
    /** Where the renderer reads templates from: the materialized run dir, or the client's own. */
    const effectiveTemplateDir = templateResolution.templateDir;

    /**
     * Rewrites the materialized template files if they're not actually on
     * THIS instance's disk — deliberately NOT a `wf.step.code`, so it runs
     * fresh every single render attempt rather than once per run.
     *
     * `04c-resolve-templates` above IS checkpointed, and that is exactly the
     * bug this closes: Approach (a) materializes template rows into
     * `.template-cache/<runId>/`, a directory on local, per-instance disk —
     * but a run that pauses at the human review gate and comes back as a
     * `revise` can resume on a DIFFERENT Cloud Run instance, one whose disk
     * never had that directory written to it at all. The checkpointed step
     * still returns the same `templateDir`/`files` (that part is genuinely
     * safe to cache — it's a deterministic registry read), so nothing
     * notices anything is wrong until the renderer looks for a real file
     * that was never actually written HERE and reports it as a tooling
     * failure (prep job 9qkTWlg7e9ZLiVIZUok4, on exactly this path, on a
     * `-r1` revision attempt after round 0's own render had already
     * succeeded). Re-materializing is a few KB of writes plus one registry
     * read — cheap next to a failed run — and a no-op when the files are
     * already there, which is the common case on an instance that never
     * recycled.
     */
    const ensureTemplatesOnDisk = async (): Promise<void> => {
      if (options.templateStore === undefined || templateResolution.files.length === 0) return;
      const absDir = path.resolve(options.repoRoot, effectiveTemplateDir);
      const allPresent = await Promise.all(
        templateResolution.files.map((file) =>
          fs
            .access(path.join(absDir, file))
            .then(() => true)
            .catch(() => false),
        ),
      );
      if (allPresent.every(Boolean)) return;
      try {
        await materializeTemplates({
          store: options.templateStore,
          repoRoot: options.repoRoot,
          runId: wf.runId,
          clientSlug: wf.clientSlug,
          clientTemplateDir: frozen.brandTokens.templateDir,
          clientTemplateFile: frozen.brandTokens.slideTemplate,
        });
      } catch (error) {
        // Same fallback rule as 04c-resolve-templates itself: a registry
        // outage here degrades layout variety, it does not fail the run.
        console.error("ensureTemplatesOnDisk: re-materialization failed, render will fall back to the client's own template", error);
      }
    };

    // ── 05-08b: write copy -> vet images -> emit + self-check + craft-hygiene
    //           -> render -> post-render visual QA, all sharing ONE retry
    //           budget capped at two returns to step 05 (RFC-03 §3 step 07,
    //           extended by Fixes 2/3 to cover the two new checks) ──
    const copyAgent = new InstagramCopyAgent({ router: options.router, tools, promptStore: options.promptStore });
    const imageAgent = new InstagramImageVettingAgent({ router: options.router, tools, promptStore: options.promptStore });
    const qaAgent = new InstagramVisualQaAgent({ router: options.router, tools, promptStore: options.promptStore });

    // ── 04d: what this client has asked for on PREVIOUS runs ──
    //
    // The read side of the feedback flywheel. Without it every run starts from
    // zero and the same correction gets made every week — a reviewer who said
    // "stop opening with a statistic" three runs ago has to say it again.
    //
    // Bounded to ten entries and best-effort: this lands in a drafting prompt,
    // so an unbounded history would push the actual brief out of the context
    // window, and a memory read failing must not stop a run that can draft
    // perfectly well without it.
    const pastFeedback = await wf.step.code("04d-read-past-feedback", async () => {
      const read = tools["memory.readFeedback"];
      if (!read) return [] as string[];
      try {
        const outcome = await read.execute({ productId: wf.productId, limit: 10 }, { ctx });
        if (outcome.status !== "success") return [] as string[];
        const entries = (outcome.result as { entries: Array<{ decision: string; note: string; at: number }> }).entries;
        return entries.map((e) => `(${e.decision}) ${e.note}`);
      } catch (error) {
        console.error("04d-read-past-feedback: could not read client feedback history, drafting without it", error);
        return [] as string[];
      }
    });

    /** What one drafting pass produces, once its own self-checks have passed. */
    interface DraftResult {
      copy: InstagramCopyOutput;
      selections: ImageSelection[];
      slidesData: RenderCarouselInput;
      rendered: RenderCarouselResult;
    }

    /** Never prose — excluded from anything a human or the topic guardrail reads as text. */
    const NON_PROSE_FIELD_KEYS = new Set(["accentColor", "dir"]);

    /**
     * Every slide's prose field values, joined — everything ON the carousel
     * images, for the topic guardrail's coverage (it must see the whole post,
     * not only the caption below). `accentColor` is a hex string, never prose;
     * excluding it is what stopped it leaking into a reviewer's "preview" back
     * when this was the only text a reviewer saw at all.
     */
    const slidesTextFor = (draft: DraftResult): string =>
      draft.slidesData.slides
        .map((slide) =>
          Object.entries(slide.fields ?? {})
            .filter(([key]) => !NON_PROSE_FIELD_KEYS.has(key))
            .map(([, value]) => value)
            .join(" "),
        )
        .join("\n\n");

    /**
     * One full drafting pass: copy, images, self-checks, render, visual QA.
     *
     * Called once per REVISION round by `runReviewCycle`. `revision` is folded
     * into every checkpointed step id inside it (via `rev` below) so a second
     * round genuinely re-executes rather than short-circuiting on the first
     * round's checkpoints — while everything OUTSIDE this function (auto-setup,
     * the topic claim, research, the template resolution) keeps its id and is
     * therefore reused for free. That reuse is the whole reason the revision is
     * in-run rather than a fresh run.
     */
    const draftOnce = async (revision: number, notes: readonly RevisionNote[]): Promise<DraftResult> => {
      /**
       * Revision-scoped step id. Revision 0 keeps the ORIGINAL ids verbatim, so
       * a first-time run's trace is byte-identical to what it was before
       * revisions existed and every existing step-id assertion still holds.
       */
      const rev = (id: string) => (revision === 0 ? id : `${id}-r${revision}`);
      /** The reviewer's accumulated change requests, as a directive for the copy agent. */
      const directive = revisionDirective(notes);

      let finalCopy: InstagramCopyOutput | undefined;
      let finalSelections: ImageSelection[] | undefined;
      let finalSlidesData: RenderCarouselInput | undefined;
      let finalRendered: RenderCarouselResult | undefined;
      let finalOutcomeOk = false;
      let lastSelfCheckReason = "no attempt completed";

    for (let attempt = 1; attempt <= MAX_SELF_CHECK_ATTEMPTS; attempt++) {
      const copyExec = await wf.step.agent(rev(`05-write-copy-attempt-${attempt}`), copyAgent, {
        ...runDirectionField(runDirection),
        topic: topicClaim.topic,
        facts: research.facts,
        styleConfig: {
          rules: frozen.styleConfig.rules,
          banned_words: frozen.styleConfig.banned_words,
          banned_chars: frozen.styleConfig.banned_chars,
          compliance: frozen.styleConfig.compliance,
        },
        brandTokens: frozen.brandTokens,
        // The client's own profile description + voice-rules guidelines,
        // verbatim — this is where a language requirement like Geektime's
        // "Hebrew-language technology site" actually lives. See step 02b.
        ...(clientVoiceContext !== undefined ? { clientVoiceContext } : {}),
        // Two distinct kinds of steer, kept apart on purpose: `pastFeedback` is
        // what this client has said across previous RUNS (durable memory), and
        // `revisionRequest` is what a reviewer asked for about THIS run's draft
        // minutes ago. Collapsing them would let a months-old preference argue
        // with an instruction someone just gave.
        ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
        ...(directive !== undefined ? { revisionRequest: directive } : {}),
      });
      if (copyExec.status === "tooling_error" || copyExec.status === "budget_exceeded") {
        throw new WorkflowToolingFailure(`copy step resolved to "${copyExec.status}" on attempt ${attempt}/${MAX_SELF_CHECK_ATTEMPTS}`);
      }
      if (copyExec.status !== "completed") {
        // A malformed draft (failed its own output schema) gets the same
        // "return to 05" remedy as a step-07 self-check failure below.
        lastSelfCheckReason = `copy draft failed its own output validation on attempt ${attempt}`;
        continue;
      }
      // `let`, not `const`: reassigned once below if a slide survives every
      // image-sourcing tier with nothing usable, to record its downgrade to
      // the "text_only" archetype (never mutated for any other reason).
      let copy = copyExec.finalOutput!;

      // ── 05b: source real candidate images for THIS attempt's copy ──
      //
      // The pool used to be a static workflow option that
      // `apps/agent-server` never supplied, so it was always `[]` and step 06
      // held every production run. `media.findImages` searches on each
      // slide's own `visualNeed`, which is why it belongs inside the retry
      // loop rather than before it: a second attempt rewrites the copy, so
      // the needs — and therefore the right candidates — change with it.
      //
      // An explicitly-supplied `options.imageCandidatePool` still wins. Tests
      // and evals depend on a fixed pool for determinism, and a caller that
      // has curated client-owned assets should not have them ignored in
      // favour of stock.
      //
      // The tool being absent entirely is a supported state, not a bug:
      // `createAllKarosTools()` deliberately excludes `media.*` (it is an
      // egress capability on a credential), so a caller assembling its own
      // registry legitimately has no such tool. That case leaves the pool
      // empty and reaches step 06's hold — exactly the behaviour before this
      // step existed. Asserting the tool here would instead crash those
      // callers.
      const findImages = tools["media.findImages"];
      // Tier 0 first: an explicitly-supplied `imageCandidatePool` still wins
      // (evals depend on a fixed pool), then the client's own uploads, then
      // whatever the harvesters find.
      let attemptPool =
        imageCandidatePool.length > 0
          ? imageCandidatePool
          : tier0Pool.candidates;
      // Why the pool is empty, in the sourcing layer's own words. Without it
      // the hold below could only say "no candidate qualified", which reads as
      // an editorial verdict on the topic and sent whoever debugged prep run
      // pubsub-21528976110173438 looking for a licensing problem when the real
      // cause was an unset UNSPLASH_ACCESS_KEY.
      let sourcingReason: string | undefined;
      // Gated on there being SLIDES LEFT TO FILL, not on the pool being empty.
      // The pool-empty form predated Tier 0 and broke the moment it landed: two
      // client uploads on an eight-slide carousel made the pool non-empty, which
      // skipped Tier 1 entirely and left the other six slides with no
      // harvester candidates at all. Tier 0 partially filling a carousel must
      // narrow the harvesters' work, never cancel it.
      //
      // An explicitly-supplied `imageCandidatePool` still suppresses sourcing,
      // which is what evals depend on.
      // ── Only PHOTO slides want a picture ──
      //
      // The archetype set (`InstagramSlideLayoutSchema`) means a slide can be
      // deliberately typographic: a `stat_callout` sets one number large, a
      // `quote_card` sets a pull-quote. Those render no image at all
      // (`assembleSlidesData` attaches `images.hero` only for `photo`), so
      // sourcing and vetting one for them is paid work whose output is
      // discarded — a real cost, since Tier 1 downloads bytes per candidate
      // and the vetting agent reads every candidate's description in one
      // prompt.
      //
      // `resolveLayout` rather than `s.layout`, because a slide whose chosen
      // archetype is missing its content block degrades to `text_only`, which
      // also needs no photo. Asking the resolved layout keeps this decision
      // consistent with what `assembleSlidesData` will actually render.
      const photoSlideNs = new Set(copy.slides.filter((s) => resolveLayout(s, availableTemplates).layout === "photo").map((s) => s.n));
      const slidesNeedingSource = copy.slides.filter((s) => photoSlideNs.has(s.n) && !tier0Slots.has(s.n));
      if (imageCandidatePool.length === 0 && slidesNeedingSource.length > 0 && findImages !== undefined) {
        const sourced = await wf.step.code(rev(`05b-source-images-attempt-${attempt}`), async () =>
          findImages.execute(
            {
              repoRoot: options.repoRoot,
              runId: wf.runId,
              // Only the slides Tier 0 did not already fill. Searching for a
            // slide that already has the client's own photo on it would be
            // paying a harvester to produce a candidate that must lose.
            needs: slidesNeedingSource.map((s) => ({ n: s.n, query: s.visualNeed })),
            },
            { ctx },
          ),
        );

        if (sourced.status === "success") {
          // Appended, not assigned: replacing the pool here would silently
          // discard the client's own uploads the moment a harvester returned
          // anything, which is the one outcome Tier 0 exists to prevent.
          attemptPool = [...attemptPool, ...(sourced.result as { candidates: ImageCandidate[] }).candidates];
        } else {
          // EVERY non-success is recorded and survived, including
          // `tooling_error`.
          //
          // A provider outage used to throw `WorkflowToolingFailure` here, on
          // the reasoning that an outage is an operator problem and must not
          // be misreported as "the topic had no good picture". That reasoning
          // is still right, and it is still honoured — the outage's own words
          // ride along in `sourcingReason` into the downgrade record, so
          // whoever reads the trace sees a 503 and not an editorial verdict.
          //
          // What was wrong was the CONSEQUENCE: throwing meant one stock
          // library returning 503 failed the entire run, discarding copy that
          // was already written and slides that could have shipped as type.
          // Reporting the cause and shipping is strictly better than
          // reporting the cause and shipping nothing.
          sourcingReason = `${sourced.status}: ${sourced.reason}`;
        }
        // Every outcome now leaves the pool as-is and falls through. An empty
        // pool means the slides degrade to typographic layouts and the post
        // still ships, carrying `sourcingReason` so the reason names the real
        // cause rather than only the gate's own verdict.
      }

      /** One slide still missing a picture, with the brief the next tier should answer. */
      type ImageGap = { n: number; prompt: string };

      /**
       * A selection for a slide that never wanted a photograph.
       *
       * `checkSlidesData` requires exactly one selection per slide, and the
       * rescue/downgrade logic below reads `rightsUsable`/`watermarkFree` —
       * so a typographic archetype needs a real entry rather than a gap.
       * `rightsUsable: true` is correct and not a fudge: there is no
       * third-party image here to have rights over.
       */
      const typographicSelection = (s: { n: number; layout: InstagramSlideLayout }): ImageSelection => ({
        n: s.n,
        imagePath: null,
        reason: `layout "${s.layout}" is typographic and renders no photograph, so no image was sourced or vetted for it`,
        license: "n/a — typographic layout, no image used",
        rightsUsable: true,
        watermarkFree: true,
      });

      /**
       * Whether a slide that WANTED a photo did not honestly get a usable one.
       *
       * Scoped to photo slides by the callers below: a `null` `imagePath` on a
       * `quote_card` is the correct, intended state, and treating it as
       * unfillable would downgrade every typographic archetype straight back
       * to `text_only` — silently undoing the whole archetype set.
       */
      const isUnfillable = (s: ImageSelection): boolean => {
        if (!photoSlideNs.has(s.n)) return false;
        if (s.imagePath === null) return true;
        if (!s.rightsUsable || !s.watermarkFree) return true;
        if (usedImagesSet.has(s.imagePath)) return true;
        return false;
      };

      let selections: ImageSelection[];
      let unfillable: ImageSelection[];

      if (attemptPool.length === 0) {
        // An empty pool has exactly one possible vetting verdict, so asking a
        // model for it buys nothing — the run that prompted this comment
        // spent $0.02 and 16s having Sonnet write six paragraphs each
        // concluding "the candidate pool is entirely empty". Skipping step
        // 06 entirely (rather than holding straight from here, the original
        // fix) still gives the rescue tiers below their real chance: `image.
        // generate` answers a slide's `visualNeed` directly and never
        // consulted this pool anyway, so a dead retrieval tier must not cost
        // it its turn.
        selections = copy.slides.map((s) =>
          photoSlideNs.has(s.n)
            ? {
                n: s.n,
                imagePath: null,
                reason: sourcingReason ?? "no candidate images were sourced at all, so nothing could be vetted",
                license: "n/a — no candidate qualified",
                rightsUsable: false,
                watermarkFree: false,
              }
            : typographicSelection({ n: s.n, layout: resolveLayout(s, availableTemplates).layout }),
        );
        unfillable = selections.filter(isUnfillable);
      } else {
        const imageExec = await wf.step.agent(rev(`06-vet-images-attempt-${attempt}`), imageAgent, {
          // Only the photo slides are put in front of the gate. A typographic
          // archetype has nothing for it to judge, and including it would ask
          // the model to match a picture to a slide that renders none.
          slides: copy.slides.filter((s) => photoSlideNs.has(s.n)).map((s) => ({ n: s.n, visualNeed: s.visualNeed })),
          candidatePool: attemptPool,
          usedImages,
        });
        if (imageExec.status === "tooling_error" || imageExec.status === "budget_exceeded") {
          throw new WorkflowToolingFailure(`image vetting step resolved to "${imageExec.status}" on attempt ${attempt}/${MAX_SELF_CHECK_ATTEMPTS}`);
        }
        if (imageExec.status !== "completed") {
          lastSelfCheckReason = `image vetting failed its own output validation on attempt ${attempt}`;
          continue;
        }
        const vetting = imageExec.finalOutput!;

        // Fix 4 extends "unfillable" to a selection that fails
        // rights/watermark, and Fix 3 extends it to a selection that
        // (despite the prompt's instruction) duplicates a prior post's
        // already-used image — both are deterministically re-checked here,
        // never trusted from the model alone.
        // The gate only saw the photo slides, so its selections cover only
        // those. Every typographic slide gets its own entry appended, in the
        // copy's slide order, so `checkSlidesData`'s one-selection-per-slide
        // requirement still holds.
        const vetted = new Map(vetting.selections.map((sel) => [sel.n, sel]));
        selections = copy.slides.map(
          (s) => vetted.get(s.n) ?? typographicSelection({ n: s.n, layout: resolveLayout(s, availableTemplates).layout }),
        );
        unfillable = selections.filter(isUnfillable);
      }

      // ── 06b/06c: generative rescue for the gaps retrieval could not fill ──
      //
      // Retrieval has a ceiling that more search backends cannot raise. prep
      // run pubsub-21535110633863323 hit it exactly: four providers, 36
      // candidates, and slide 5 still failed because it needed "a timeline or
      // roadmap with a clearly labeled 'research' first phase, shot from
      // above" — a picture no stock or CC library holds. Generation is the
      // only source that answers a specific brief on demand, so the gaps get
      // one bounded attempt at it before the post is held.
      //
      // Deliberately narrow: only the unfilled slides are generated (each
      // image is billed), only the unfilled slides are re-vetted, and only
      // once per copy attempt. The never-a-placeholder rule is untouched — a
      // generated image still has to clear the same gate as a stock photo,
      // and a run whose gaps survive generation still holds.
      // ── The tiered rescue: scrape, then generate ──
      //
      // Tier 1 (05b, `media.findImages`) has already merged every stock and CC
      // harvester. What is left unfilled is a need those libraries do not hold,
      // and the two remaining tiers answer different halves of that:
      //
      //   Tier 2 `media.scrapeImages` — a photograph of the ACTUAL subject,
      //     which exists on the open social web and nowhere else. Every
      //     candidate is `licenseConfidence: "unknown"` (UGC copyright stays
      //     with the poster), so the rights gate will refuse most of them. This
      //     tier widens the choice; it does not guarantee an outcome.
      //   Tier 3 `image.generate` — Vertex draws the brief. Owned outright,
      //     nothing to credit, nothing watermarked, so it is the ONLY tier that
      //     can actually finish a slide unattended.
      //
      // Ordered scrape-then-generate on purpose: a real photograph beats a
      // synthesised one when the gate will accept it, and generation costs a
      // billed call per image, so it runs on what survives tier 2.
      //
      // Each tier re-vets only the slides still missing, against only its own
      // new candidates. Re-judging settled slides would pay for verdicts that
      // are not going to change.
      const rescueTiers: Array<{ id: string; tool: AgentTool | undefined; buildArgs: (gaps: ImageGap[]) => unknown }> = [
        {
          id: "scrape",
          tool: tools["media.scrapeImages"],
          buildArgs: (gaps) => ({
            repoRoot: options.repoRoot,
            runId: wf.runId,
            needs: gaps.map((g) => ({ n: g.n, query: g.prompt })),
          }),
        },
        {
          id: "generate",
          tool: tools["image.generate"],
          buildArgs: (gaps) => ({
            repoRoot: options.repoRoot,
            runId: wf.runId,
            needs: gaps,
            // The real canvas, not a hardcoded default: a generated slide that
            // renders at a different ratio to the template gets cropped, and a
            // crop is exactly how a carefully-composed frame loses its subject.
            aspectRatio: aspectRatioForCanvas(frozen.styleConfig.canvas),
            art: artDirectionFor(frozen.brandTokens),
          }),
        },
      ];

      let tierIndex = 0;
      for (const tier of rescueTiers) {
        tierIndex += 1;
        if (unfillable.length === 0 || tier.tool === undefined) continue;

        const gaps: ImageGap[] = unfillable
          .map((u) => ({ n: u.n, prompt: copy.slides.find((sl) => sl.n === u.n)?.visualNeed }))
          .filter((g): g is ImageGap => g.prompt !== undefined);
        if (gaps.length === 0) continue;

        const sourced = await wf.step.code(rev(`06${"bd"[tierIndex - 1]}-${tier.id}-images-attempt-${attempt}`), async () =>
          tier.tool!.execute(tier.buildArgs(gaps), { ctx }),
        );

        if (sourced.status !== "success") {
          // `not_available` on an unconfigured deployment, `content_fail` when
          // the tier honestly found nothing, `tooling_error` on an outage: all
          // three leave `unfillable` as it was and let the next tier try. Only
          // an exhausted cascade holds the post.
          continue;
        }

        const tierPool = (sourced.result as { candidates: ImageCandidate[] }).candidates;
        if (tierPool.length === 0) continue;

        const revet = await wf.step.agent(rev(`06${"ce"[tierIndex - 1]}-vet-${tier.id}-attempt-${attempt}`), imageAgent, {
          slides: gaps.map((g) => ({ n: g.n, visualNeed: g.prompt })),
          candidatePool: tierPool,
          usedImages,
        });
        if (revet.status !== "completed") continue;

        const rescued = new Map(revet.finalOutput!.selections.map((sel) => [sel.n, sel]));
        selections = selections.map((sel) => {
          const replacement = rescued.get(sel.n);
          // Only an actually-fillable replacement wins. A rescue that failed
          // its own gate must not overwrite the original verdict with a
          // second, equally unusable one.
          return replacement && !isUnfillable(replacement) ? replacement : sel;
        });
        unfillable = selections.filter(isUnfillable);
      }

      // ── Pre-flight: does every selected image still EXIST on disk? ──
      //
      // `publish.renderCarousel` reports a missing image file as
      // `content_fail`, which used to hold the whole post at step 08 — after
      // copy, vetting, every rescue tier and the self-checks had all been
      // paid for. That is the one image-caused hold that survived the
      // guaranteed-delivery work, and it is reachable for real: the media
      // cache lives on an in-memory volume (see karos-media's README), so a
      // Cloud Run instance recycling between vetting and render genuinely
      // loses the bytes.
      //
      // Checked here instead, where a missing file is just another reason the
      // slide has no usable picture, so it flows into the SAME downgrade path
      // as every other sourcing failure rather than needing its own outcome.
      const missingOnDisk = await wf.step.code(rev(`06f-verify-images-on-disk-attempt-${attempt}`), async () => {
        const gone: number[] = [];
        for (const sel of selections) {
          if (sel.imagePath === null) continue;
          try {
            await fs.access(path.resolve(options.repoRoot, sel.imagePath));
          } catch {
            gone.push(sel.n);
          }
        }
        return gone;
      });
      if (missingOnDisk.length > 0) {
        const goneSet = new Set(missingOnDisk);
        selections = selections.map((sel) =>
          goneSet.has(sel.n)
            ? { ...sel, imagePath: null, reason: `${sel.reason} (the file was no longer on disk at render time)` }
            : sel,
        );
        unfillable = selections.filter(isUnfillable);
      }

      // Guaranteed delivery (2026-08): a slide that survives every tier —
      // retrieval, social scrape, generation — with nothing usable no longer
      // holds the whole post. The never-a-placeholder guarantee is
      // unchanged: nothing rights-encumbered, watermarked, or reused ever
      // ships. What changes is the alternative to holding — the slide ships
      // on the "text_only" archetype (`InstagramSlideLayoutSchema`) instead,
      // which `assembleSlidesData`/the render template already support
      // (headline/body/accent-band on the template's own dark background,
      // no photo). A run only holds now for a genuine copy/rights/compliance
      // self-check failure (below), never solely because a picture could not
      // be found — see prep runs pubsub-21533408759483219 and
      // pubsub-21543794087429035, both of which held on exactly this with a
      // real Vertex quota blip as the actual cause, not an editorial "no
      // picture exists" verdict.
      if (unfillable.length > 0) {
        // `s.reason` carries the real diagnostic (an unset key, a provider's
        // own "no results" chain, the vetting model's own explanation) —
        // the category label alone ("no candidate qualified") is exactly
        // the generic-editorial-verdict framing prep run
        // pubsub-21528976110173438 got burned by, with the actual cause
        // (an unset UNSPLASH_ACCESS_KEY) sitting one step upstream of it.
        const detail = unfillable.map((s) => {
          if (s.imagePath === null) return `${s.n}: ${s.reason}`;
          if (!s.rightsUsable) return `${s.n}: not rights-usable (${s.reason})`;
          if (!s.watermarkFree) return `${s.n}: not watermark-free (${s.reason})`;
          return `${s.n}: already used in a prior post`;
        });
        const downgradedNs = new Set(unfillable.map((s) => s.n));
        await wf.step.code(rev(`07a-downgrade-unfillable-slides-attempt-${attempt}`), () => ({
          downgraded: [...downgradedNs],
          reason: `slide(s) ${[...downgradedNs].join(", ")} shipping text-only — no viable image survived retrieval, social-scrape, and generation (${detail.join("; ")})`,
        }));
        // Never a rights-encumbered/watermarked/reused image, regardless of
        // which of those disqualified the candidate — the slide gets NO
        // photo, not a demoted one.
        selections = selections.map((sel) => (downgradedNs.has(sel.n) ? { ...sel, imagePath: null } : sel));
        copy = { ...copy, slides: copy.slides.map((s) => (downgradedNs.has(s.n) ? { ...s, layout: "text_only" } : s)) };
      }

      const selfCheck = checkSlidesData(copy, selections, research, frozen.styleConfig);
      const attemptChecked = await wf.step.code(rev(`07-self-check-attempt-${attempt}`), () => selfCheck);

      if (!attemptChecked.ok) {
        lastSelfCheckReason = attemptChecked.reason;
        continue;
      }

      // Fix 3: the unconditional, mechanical craft-hygiene gate (em dash/
      // exclamation/sentence-case) — never client-config-driven, runs on
      // every attempt regardless of what the client's own style rules say.
      const craftHygiene = await wf.step.code(rev(`07b-craft-hygiene-attempt-${attempt}`), () => checkCraftHygiene(tools, ctx, copy));
      if (!craftHygiene.ok) {
        lastSelfCheckReason = craftHygiene.reason;
        continue;
      }

      const slidesDataAttempt = await wf.step.code(rev(`07c-emit-slides-data-attempt-${attempt}`), () =>
        assembleSlidesData({
          clientSlug: wf.clientSlug,
          postId: runClaim.postId,
          repoRoot: options.repoRoot,
          brandTokens: frozen.brandTokens,
          copy,
          selections,
          canvas: frozen.styleConfig.canvas,
          availableTemplates,
          templateDirOverride: effectiveTemplateDir,
        }),
      );

      // ── 08: render via the shared, already-tested publish.renderCarousel tool ──
      await ensureTemplatesOnDisk();
      const renderOutcome = await wf.step.code(rev(`08-render-carousel-attempt-${attempt}`), async () => tools["publish.renderCarousel"]!.execute(slidesDataAttempt, { ctx }));

      // ── The last image-caused hold, now a degrade ──
      //
      // `content_fail` from the renderer means an image path did not resolve.
      // The pre-flight check above should have caught every case of that, so
      // reaching here means something raced it (the volume recycled between
      // the check and the screenshot). Holding was the old answer; the
      // guarantee now is that a picture problem never costs the post, so this
      // strips EVERY image and renders the carousel fully typographic instead.
      //
      // Bounded to one extra attempt on purpose: with no images left there is
      // no image left to fail on, so a second `content_fail` is not a picture
      // problem at all and is reported as the tooling break it actually is.
      let renderResolved = renderOutcome;
      let slidesDataResolved = slidesDataAttempt;
      if (renderResolved.status === "content_fail") {
        const strippedCopy: InstagramCopyOutput = {
          ...copy,
          slides: copy.slides.map((s) => (s.layout === "photo" ? { ...s, layout: "text_only" as const } : s)),
        };
        const strippedSelections = selections.map((sel) => ({ ...sel, imagePath: null }));
        slidesDataResolved = await wf.step.code(rev(`08a-render-fallback-typographic-attempt-${attempt}`), () =>
          assembleSlidesData({
            clientSlug: wf.clientSlug,
            postId: runClaim.postId,
            repoRoot: options.repoRoot,
            brandTokens: frozen.brandTokens,
            copy: strippedCopy,
            selections: strippedSelections,
            canvas: frozen.styleConfig.canvas,
            availableTemplates,
            templateDirOverride: effectiveTemplateDir,
          }),
        );
        copy = strippedCopy;
        selections = strippedSelections;
        await ensureTemplatesOnDisk();
        renderResolved = await wf.step.code(rev(`08-render-carousel-typographic-attempt-${attempt}`), async () =>
          tools["publish.renderCarousel"]!.execute(slidesDataResolved, { ctx }),
        );
      }

      if (renderResolved.status !== "success") {
        // Either a genuine tooling break, or a `content_fail` that survived
        // having every image removed — which is no longer a picture problem.
        // Both are `degraded`, never `held`: nothing here is an editorial
        // verdict a human should act on.
        // `status` is read before the `in` check below narrows the union, which
        // would otherwise leave the else branch typed `never`.
        const status: string = renderResolved.status;
        const detail = "reason" in renderResolved ? renderResolved.reason : status;
        throw new WorkflowToolingFailure(
          status === "content_fail"
            ? // Every image was already stripped before this second attempt, so
              // a surviving content failure is not a picture problem.
              `render step still reported a content failure after every image was removed, so it is not an image problem: ${detail}`
            : `render step reported a tooling failure: ${detail}`,
        );
      }
      const renderedAttempt = renderResolved.result as RenderCarouselResult;
      const slidesDataForQa = slidesDataResolved;

      // ── 08b: post-render visual QA (Fix 2) — a text-proxy stand-in for real
      //         pixel inspection (see InstagramVisualQaAgent's own doc
      //         comment). A failure here `continue`s the SAME retry loop as
      //         step 07/07b above, matching carousel-agent-v2 SKILL.md step
      //         08's "a fail here is RETURN: 05, because it is the copy or
      //         the layout, not the code." ──
      const qaExec = await wf.step.agent(rev(`08b-visual-qa-attempt-${attempt}`), qaAgent, {
        slides: slidesDataForQa.slides.map((s) => ({ n: s.n, fields: s.fields, images: s.images })),
        renderRules: renderRules.map((r) => ({ id: r.id, description: r.description })),
      });
      if (qaExec.status === "tooling_error" || qaExec.status === "budget_exceeded") {
        throw new WorkflowToolingFailure(`visual QA step resolved to "${qaExec.status}" on attempt ${attempt}/${MAX_SELF_CHECK_ATTEMPTS}`);
      }
      if (qaExec.status !== "completed") {
        lastSelfCheckReason = `visual QA output failed its own output validation on attempt ${attempt}`;
        continue;
      }
      const qa = qaExec.finalOutput!;
      if (!qa.pass) {
        const failing = qa.findings.filter((f) => !f.passed);
        lastSelfCheckReason = `visual QA failed on attempt ${attempt}: ${failing.length > 0 ? failing.map((f) => `${f.ruleId}${f.slide !== undefined ? ` (slide ${f.slide})` : ""}: ${f.note}`).join("; ") : "no specific findings given"}`;
        continue;
      }

      finalCopy = copy;
      finalSelections = selections;
      finalSlidesData = slidesDataForQa;
      finalRendered = renderedAttempt;
      finalOutcomeOk = true;
      break;
    }

      if (!finalOutcomeOk || !finalCopy || !finalSelections || !finalSlidesData || !finalRendered) {
        throw new WorkflowHeld(
          `step 07's self-check never passed after ${MAX_SELF_CHECK_ATTEMPTS} attempt(s) (initial + ${MAX_SELF_CHECK_ATTEMPTS - 1} return(s) to step 05) — last reason: ${lastSelfCheckReason}`,
        );
      }
      return { copy: finalCopy, selections: finalSelections, slidesData: finalSlidesData, rendered: finalRendered };
    };

    // ── 09a: the universal approve / revise / reject cycle ──
    //
    // `revise` is what makes this a loop rather than a verdict: the reviewer's
    // feedback is injected into a fresh drafting pass (revision-scoped step
    // ids, everything upstream reused from its checkpoints) instead of the run
    // being held and somebody having to dispatch a new one that knows nothing
    // about what was asked for.
    //
    // Every decision, including approvals, is written to client memory by
    // `onDecision` before the cycle acts on it — an approving reviewer saying
    // "the shorter hooks are working" is teaching the system something, and a
    // store that only remembers complaints learns a distorted version of what
    // a client wants.
    const review = await runReviewCycle<DraftResult>(wf, {
      gateId: "09a-batch-review",
      maxRevisions: MAX_REVISION_ROUNDS,
      ...(options.autoApprove ? { autoApprove: true } : {}),
      attempt: async (revision, notes) => {
        const draft = await draftOnce(revision, notes);
        // The terminal topic guardrail runs on the copy that is about to be
        // shown to a human, so a revision's new copy is checked too rather
        // than only the first draft's. Checks the caption AND every slide's
        // own text, since a forbidden subject could surface in either.
        await runTopicGuardrail(
          wf,
          { tools, promptStore: options.promptStore, router: options.router },
          `${draft.copy.caption}\n\n${slidesTextFor(draft)}`,
          frozen.forbiddenTopics,
          revision === 0 ? undefined : `-r${revision}`,
        );
        return draft;
      },
      buildGate: (draft, revision) => ({
        kind: "batch_review",
        payload: {
          runId: wf.runId,
          postId: runClaim.postId,
          topic: topicClaim.topic,
          slideCount: draft.slidesData.slides.length,
          renderedCount: draft.rendered.rendered.length,
          revision,
          // The actual caption a reviewer approves alongside the images —
          // every other channel's gate payload has carried its drafted text
          // as `preview` since the review panel existed; a carousel's own
          // `preview` used to be a raw join of every slide's field values
          // (including `accentColor`'s hex code) because no real caption
          // existed yet to show instead.
          preview: draft.copy.caption,
          // The rendered PNGs, in slide order — `path` is a signed https URL
          // when the runtime could sign one (`GcsArtifactStore.upload`'s own
          // fallback rule), a bare `gs://` URI otherwise, which the review
          // panel can't load but which the payload should still carry rather
          // than silently omit.
          images: draft.rendered.rendered.map((r) => ({ n: r.n, url: r.path })),
          // Which template rendered each slide, and whether it is one a person
          // has never signed off on. This is what lets the review surface say
          // "new custom template used on slide 4" and attach design feedback to
          // the right registry row rather than to the post as a whole.
          slideTemplates: draft.slidesData.slides.map((slide) => {
            const chosen = templateResolution.chosen.find((c) => templateFileName(c.archetypeId) === slide.template);
            return {
              n: slide.n,
              template: slide.template,
              ...(chosen ? { templateId: chosen.templateId, templateSource: chosen.source } : {}),
              isExperimental: chosen?.source === "ai_generated",
            };
          }),
        },
        requiredRole: "account_manager",
        timeout: { duration: "24h", onTimeout: "hold" },
      }),
      onDecision: async ({ revision, response, templateFeedback }) => {
        await persistReviewFeedback(wf, tools, ctx, { revision, response, templateFeedback, templateStore: options.templateStore });
      },
    });

    const slidesData = review.output.slidesData;
    const rendered = review.output.rendered;
    const caption = review.output.copy.caption;

    // ── 09b: deliver + log — the count invariant is real and checked, not just documented ──
    const deliverableId = await wf.step.code("09b-deliver-and-log", async () => {
      if (rendered.rendered.length !== slidesData.slides.length) {
        // A genuine internal inconsistency (the renderer's own contract is to
        // render every slide or fail outright) — a tooling bug, never a
        // content verdict, so this is never recorded as if the post were
        // simply short a slide.
        throw new WorkflowToolingFailure(
          `rendered PNG count (${rendered.rendered.length}) does not match slide count (${slidesData.slides.length}) — refusing to log a deliverable that doesn't match what was actually rendered`,
        );
      }

      const writeOutcome = await tools["ledger.writeDeliverable"]!.execute(
        {
          runId: wf.runId,
          kind: "instagram-carousel",
          deliverable: {
            postId: runClaim.postId,
            topic: topicClaim.topic,
            caption,
            slides: slidesData.slides,
            rendered: rendered.rendered,
          },
        },
        { ctx },
      );
      if (writeOutcome.status !== "success") {
        throw new WorkflowToolingFailure(`ledger.writeDeliverable failed: ${writeOutcome.status}`);
      }
      const id = (writeOutcome.result as { id: string }).id;

      // Fix 3: this post's shipped images are now "used" for every future
      // run's cross-post reuse check (step 06 above) — recorded only now,
      // once delivery is otherwise real, never speculatively before that.
      const shippedImagePaths = review.output.selections.map((s) => s.imagePath).filter((p): p is string => p !== null);
      if (shippedImagePaths.length > 0) {
        const recordOutcome = await tools["ledger.recordUsedImages"]!.execute({ imagePaths: shippedImagePaths }, { ctx });
        if (recordOutcome.status !== "success") {
          throw new WorkflowToolingFailure(`ledger.recordUsedImages failed: ${recordOutcome.status}`);
        }
      }

      await tools["ledger.appendEvent"]!.execute(
        {
          runId: wf.runId,
          eventId: `${wf.runId}__delivered`,
          level: "success",
          message: `Instagram carousel delivered: ${rendered.rendered.length} slides rendered for topic "${topicClaim.topic}"`,
        },
        { ctx },
      );

      // Re-confirm the step-03 topic claim survived a concurrent run before
      // finishing (RFC-03 §3 step 09's note) — commits the sole dedup claim
      // for good, only once delivery is otherwise complete.
      //
      // CONDITIONAL, because step 03 can now reach a subject without reserving
      // one (a requested subject, or a research-derived fallback, when the
      // catalog could not serve this lane — see that step's own note). There is
      // no reservation to confirm in those cases, and calling `topics.commit`
      // with no key would either fail or, worse, claim the catalog issued
      // something it never did. Same guard x-agent's step 20 already applies to
      // its own reservation.
      if (topicClaim.source === "reserved" && topicClaim.reservationKey) {
        const commitOutcome = await tools["topics.commit"]!.execute({ reservationKey: topicClaim.reservationKey }, { ctx });
        if (commitOutcome.status !== "success") {
          throw new WorkflowToolingFailure(`topics.commit failed to confirm the step-03 topic claim: ${commitOutcome.status}`);
        }
      }

      return id;
    });

    return {
      postId: runClaim.postId,
      topic: topicClaim.topic,
      slideCount: slidesData.slides.length,
      renderedCount: rendered.rendered.length,
      deliverableId,
    };
  };
}

/**
 * The client's declared industry, or undefined when they have none.
 *
 * Reads the same field step 03's fallback reads. Deliberately NOT defaulted to
 * a neutral stand-in: a stand-in would let auto-setup seed the catalog from
 * generic research for a client whose profile is empty, and step 03 would then
 * reserve one of those off-brand topics and draft from it in good faith.
 * Undefined is what makes the caller skip seeding instead.
 */
function industryForSetup(outcome: { status: string; result?: unknown }): string | undefined {
  if (outcome.status !== "success") return undefined;
  const industry = (outcome.result as Record<string, unknown> | undefined)?.["industry"];
  return typeof industry === "string" && industry.trim().length > 0 ? industry.trim() : undefined;
}

/**
 * The closest aspect ratio the image model accepts to the client's actual
 * canvas.
 *
 * The generator only takes a fixed set of ratios, so this picks the nearest by
 * numeric distance rather than guessing a default. Getting it wrong is not
 * cosmetic: the template renders the image into a fixed frame, so a mismatched
 * generation is cropped, and a crop takes the subject out of a frame that was
 * composed around it.
 */
function aspectRatioForCanvas(canvas: { w: number; h: number }): "1:1" | "3:4" | "4:3" | "9:16" | "16:9" {
  const supported: Array<{ id: "1:1" | "3:4" | "4:3" | "9:16" | "16:9"; value: number }> = [
    { id: "1:1", value: 1 },
    { id: "3:4", value: 3 / 4 },
    { id: "4:3", value: 4 / 3 },
    { id: "9:16", value: 9 / 16 },
    { id: "16:9", value: 16 / 9 },
  ];
  const target = canvas.h > 0 ? canvas.w / canvas.h : 1;
  return supported.reduce((best, option) =>
    Math.abs(option.value - target) < Math.abs(best.value - target) ? option : best,
  ).id;
}

/**
 * Art direction assembled from the client's own brand tokens, or undefined
 * when they have declared none.
 *
 * Undefined rather than a set of tasteful defaults, deliberately: invented
 * direction would make every client's generated slides look like whatever this
 * function happened to prefer, which is worse than the neutral brief the
 * generator already falls back to. Only what the client actually declared.
 */
function artDirectionFor(tokens: BrandTokens): Record<string, unknown> | undefined {
  const art = {
    ...(tokens.aesthetic ? { aesthetic: tokens.aesthetic } : {}),
    ...(tokens.lighting ? { lighting: tokens.lighting } : {}),
    ...(tokens.palette && tokens.palette.length > 0 ? { palette: tokens.palette } : {}),
    ...(tokens.accentColor ? { accentColor: tokens.accentColor } : {}),
    ...(tokens.visualMood ? { mood: tokens.visualMood } : {}),
  };
  return Object.keys(art).length > 0 ? art : undefined;
}
