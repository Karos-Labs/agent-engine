import { readForbiddenTopics } from "@agent-engine/core";
import type { AgentContext, AgentTool, AgentToolRegistry, GateResponse, ModelRouter, PromptStore } from "@agent-engine/core";
import { type WorkflowContext, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure, runAutoSetup, runTopicGuardrail, readRunDirection, runDirectionField } from "@agent-engine/workflow";
import type { RenderCarouselInput, RenderCarouselResult } from "@agent-engine/tool-karos-publish";
import { InstagramCopyAgent } from "../agent/instagram-copy-agent.js";
import { InstagramImageVettingAgent } from "../agent/instagram-image-vetting-agent.js";
import { InstagramResearchAgent } from "../agent/instagram-research-agent.js";
import { InstagramVisualQaAgent } from "../agent/instagram-visual-qa-agent.js";
import { assembleSlidesData, checkSlidesData } from "./slides-data.js";
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
 *   watermark verdict, and a failing one holds the whole post exactly like
 *   "no viable image."
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

    // Render-type rules from the frozen config (Fix 2) — evaluated post-render
    // by step 08b, never by step 07's checkSlidesData (which only ever
    // evaluates `check: "copy"` rules).
    const renderRules = frozen.styleConfig.rules.filter((r) => r.check === "render");

    // ── 03: claim the subject — the catalog first, then the same fallbacks every other channel already has ──
    const topicClaim = await wf.step.code("03-claim-topic", async (): Promise<InstagramTopicClaim> => {
      const reservationKey = `${wf.runId}__topic`;
      const lane = runClaim.requestedLane ?? DEFAULT_CAROUSEL_LANE;
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

    // ── 05-08b: write copy -> vet images -> emit + self-check + craft-hygiene
    //           -> render -> post-render visual QA, all sharing ONE retry
    //           budget capped at two returns to step 05 (RFC-03 §3 step 07,
    //           extended by Fixes 2/3 to cover the two new checks) ──
    const copyAgent = new InstagramCopyAgent({ router: options.router, tools, promptStore: options.promptStore });
    const imageAgent = new InstagramImageVettingAgent({ router: options.router, tools, promptStore: options.promptStore });
    const qaAgent = new InstagramVisualQaAgent({ router: options.router, tools, promptStore: options.promptStore });

    let finalCopy: InstagramCopyOutput | undefined;
    let finalSelections: ImageSelection[] | undefined;
    let finalSlidesData: RenderCarouselInput | undefined;
    let finalRendered: RenderCarouselResult | undefined;
    let finalOutcomeOk = false;
    let lastSelfCheckReason = "no attempt completed";

    for (let attempt = 1; attempt <= MAX_SELF_CHECK_ATTEMPTS; attempt++) {
      const copyExec = await wf.step.agent(`05-write-copy-attempt-${attempt}`, copyAgent, {
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
      const copy = copyExec.finalOutput!;

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
      const slidesNeedingSource = copy.slides.filter((s) => !tier0Slots.has(s.n));
      if (imageCandidatePool.length === 0 && slidesNeedingSource.length > 0 && findImages !== undefined) {
        const sourced = await wf.step.code(`05b-source-images-attempt-${attempt}`, async () =>
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

        // A provider outage is not an editorial outcome. Failing loudly here
        // keeps it out of the "no viable image" hold below, which a human
        // reads as "the topic had no good picture" and would act on wrongly.
        if (sourced.status === "tooling_error") {
          throw new WorkflowToolingFailure(`media.findImages failed: tooling_error — ${sourced.reason}`);
        }
        if (sourced.status === "success") {
          // Appended, not assigned: replacing the pool here would silently
          // discard the client's own uploads the moment a harvester returned
          // anything, which is the one outcome Tier 0 exists to prevent.
          attemptPool = [...attemptPool, ...(sourced.result as { candidates: ImageCandidate[] }).candidates];
        } else {
          sourcingReason = sourced.reason;
        }
        // `content_fail` (nothing sourced) and `not_available` (no backend
        // configured) both leave the pool empty and fall through to step 06,
        // which holds the post — but now carrying `sourcingReason` so the hold
        // names the actual cause instead of only its own verdict.
      }

      // An empty pool has exactly one possible verdict, so asking a model for
      // it buys nothing. The run that prompted this spent $0.02 and 16s having
      // Sonnet write six paragraphs each concluding "the candidate pool is
      // entirely empty" — real money, on every Instagram run, for an answer
      // that is a property of the input. Holding straight from here also keeps
      // the sourcing reason intact rather than laundering it through a model's
      // restatement of it.
      if (attemptPool.length === 0) {
        const slideNumbers = copy.slides.map((s) => s.n);
        throw new WorkflowHeld(
          `no viable image found for slide(s) ${slideNumbers.join(", ")} — no candidate images were sourced at all, ` +
            `so nothing could be vetted (${sourcingReason ?? "no image-sourcing tool is registered for this run"})`,
        );
      }

      const imageExec = await wf.step.agent(`06-vet-images-attempt-${attempt}`, imageAgent, {
        slides: copy.slides.map((s) => ({ n: s.n, visualNeed: s.visualNeed })),
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

      // The preserved legacy-defect fix (RFC-03 §1/§3 step 06): ANY
      // unfillable slide holds the WHOLE post immediately — never a
      // placeholder, never a silently-dropped slide — and this is NOT
      // subject to the self-check retry budget above: retrying won't change
      // what's in a fixed candidate pool, so looping here would only waste
      // model calls before reaching the same honest outcome. Fix 4 extends
      // "unfillable" to a selection that fails rights/watermark, and Fix 3
      // extends it to a selection that (despite the prompt's instruction)
      // duplicates a prior post's already-used image — both are
      // deterministically re-checked here, never trusted from the model alone.
      /** One slide still missing a picture, with the brief the next tier should answer. */
      type ImageGap = { n: number; prompt: string };

      const isUnfillable = (s: ImageSelection): boolean => {
        if (s.imagePath === null) return true;
        if (!s.rightsUsable || !s.watermarkFree) return true;
        if (usedImagesSet.has(s.imagePath)) return true;
        return false;
      };
      let selections = vetting.selections;
      let unfillable = selections.filter(isUnfillable);

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

        const sourced = await wf.step.code(`06${"bd"[tierIndex - 1]}-${tier.id}-images-attempt-${attempt}`, async () =>
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

        const revet = await wf.step.agent(`06${"ce"[tierIndex - 1]}-vet-${tier.id}-attempt-${attempt}`, imageAgent, {
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

      if (unfillable.length > 0) {
        const detail = unfillable.map((s) => {
          if (s.imagePath === null) return `${s.n}: no candidate qualified`;
          if (!s.rightsUsable) return `${s.n}: not rights-usable`;
          if (!s.watermarkFree) return `${s.n}: not watermark-free`;
          return `${s.n}: already used in a prior post`;
        });
        throw new WorkflowHeld(
          `no viable image found for slide(s) ${unfillable.map((s) => s.n).join(", ")} — holding the whole post rather than shipping a placeholder, a rights-encumbered/watermarked image, or a reused picture, and neither the social-scrape tier nor generation could fill the gap (${detail.join("; ")})`,
        );
      }

      const selfCheck = checkSlidesData(copy, selections, research, frozen.styleConfig);
      const attemptChecked = await wf.step.code(`07-self-check-attempt-${attempt}`, () => selfCheck);

      if (!attemptChecked.ok) {
        lastSelfCheckReason = attemptChecked.reason;
        continue;
      }

      // Fix 3: the unconditional, mechanical craft-hygiene gate (em dash/
      // exclamation/sentence-case) — never client-config-driven, runs on
      // every attempt regardless of what the client's own style rules say.
      const craftHygiene = await wf.step.code(`07b-craft-hygiene-attempt-${attempt}`, () => checkCraftHygiene(tools, ctx, copy));
      if (!craftHygiene.ok) {
        lastSelfCheckReason = craftHygiene.reason;
        continue;
      }

      const slidesDataAttempt = await wf.step.code(`07c-emit-slides-data-attempt-${attempt}`, () =>
        assembleSlidesData({
          clientSlug: wf.clientSlug,
          postId: runClaim.postId,
          repoRoot: options.repoRoot,
          brandTokens: frozen.brandTokens,
          copy,
          selections,
          canvas: frozen.styleConfig.canvas,
        }),
      );

      // ── 08: render via the shared, already-tested publish.renderCarousel tool ──
      const renderOutcome = await wf.step.code(`08-render-carousel-attempt-${attempt}`, async () => tools["publish.renderCarousel"]!.execute(slidesDataAttempt, { ctx }));

      if (renderOutcome.status === "content_fail") {
        // A real content problem (e.g. an image file that went missing between
        // step 06 and step 08) — never confused with a tooling break (RFC-03
        // §1 required-reading item 2's exact three-way distinction). This is
        // NOT retried by this loop (matching carousel-agent-v2 SKILL.md step
        // 08's own "exit code 1 -> RETURN: 07", a different remedy than the
        // visual-QA "exit code ok but pixels are bad -> RETURN: 05" case
        // below) — a missing file on disk won't fix itself by rewriting copy.
        throw new WorkflowHeld(`render step reported a content failure: ${renderOutcome.reason}`);
      }
      if (renderOutcome.status !== "success") {
        throw new WorkflowToolingFailure(
          `render step reported a tooling failure: ${renderOutcome.status === "tooling_error" ? renderOutcome.reason : renderOutcome.status}`,
        );
      }
      const renderedAttempt = renderOutcome.result as RenderCarouselResult;

      // ── 08b: post-render visual QA (Fix 2) — a text-proxy stand-in for real
      //         pixel inspection (see InstagramVisualQaAgent's own doc
      //         comment). A failure here `continue`s the SAME retry loop as
      //         step 07/07b above, matching carousel-agent-v2 SKILL.md step
      //         08's "a fail here is RETURN: 05, because it is the copy or
      //         the layout, not the code." ──
      const qaExec = await wf.step.agent(`08b-visual-qa-attempt-${attempt}`, qaAgent, {
        slides: slidesDataAttempt.slides.map((s) => ({ n: s.n, fields: s.fields, images: s.images })),
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
      finalSlidesData = slidesDataAttempt;
      finalRendered = renderedAttempt;
      finalOutcomeOk = true;
      break;
    }

    if (!finalOutcomeOk || !finalCopy || !finalSelections || !finalSlidesData || !finalRendered) {
      throw new WorkflowHeld(
        `step 07's self-check never passed after ${MAX_SELF_CHECK_ATTEMPTS} attempt(s) (initial + ${MAX_SELF_CHECK_ATTEMPTS - 1} return(s) to step 05) — last reason: ${lastSelfCheckReason}`,
      );
    }
    const slidesData = finalSlidesData;
    const rendered = finalRendered;

    // ── 09a: human batch-review gate before the final delivery — nothing ships without a real approval ──
    // -- terminal topic guardrail --
    //
    // The slide copy, judged before a human is asked to approve the carousel.
    // Images are not checked here: this reads text, and what a picture is "of"
    // is a different question with a different answer.
    await runTopicGuardrail(
      wf,
      { tools, promptStore: options.promptStore, router: options.router },
      slidesData.slides.map((slide) => Object.values(slide.fields ?? {}).join(" ")).join("\n\n"),
      frozen.forbiddenTopics,
    );

    const reviewDecision: GateResponse = options.autoApprove
      ? await wf.step.code("09a-batch-review", () => ({ decision: "approve" as const, actor: "system", at: new Date().toISOString() }))
      : await wf.step.gate("09a-batch-review", {
          kind: "batch_review",
          payload: {
            runId: wf.runId,
            postId: runClaim.postId,
            topic: topicClaim.topic,
            slideCount: slidesData.slides.length,
            renderedCount: rendered.rendered.length,
          },
          requiredRole: "account_manager",
          timeout: { duration: "24h", onTimeout: "hold" },
        });
    if (reviewDecision.decision !== "approve") {
      throw new WorkflowHeld(`batch rejected: ${reviewDecision.reason ?? "no reason given"}`);
    }

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
      const shippedImagePaths = finalSelections!.map((s) => s.imagePath).filter((p): p is string => p !== null);
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
