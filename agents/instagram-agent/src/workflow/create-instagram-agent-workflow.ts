import type { AgentContext, AgentToolRegistry, GateResponse, ModelRouter, PromptStore } from "@agent-engine/core";
import { type WorkflowContext, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure } from "@agent-engine/workflow";
import type { RenderCarouselInput, RenderCarouselResult } from "@agent-engine/tool-karos-publish";
import { InstagramCopyAgent } from "../agent/instagram-copy-agent.js";
import { InstagramImageVettingAgent } from "../agent/instagram-image-vetting-agent.js";
import { InstagramResearchAgent } from "../agent/instagram-research-agent.js";
import { InstagramVisualQaAgent } from "../agent/instagram-visual-qa-agent.js";
import { assembleSlidesData, checkSlidesData } from "./slides-data.js";
import { checkCraftHygiene } from "./craft-hygiene.js";
import {
  BrandTokensSchema,
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
   * The candidate image pool step 06 vets against, per RFC-03 §1's note that
   * Phase 1 has no real internet image-search tool yet — this stands in for
   * that tool, supplied by the caller (or, in a later phase, by a real
   * `media.findImage`-style tool's own candidate list). Defaults to empty,
   * which deterministically holds every run at step 06 (an empty pool can
   * never satisfy any slide's visual need) rather than crashing.
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

      return { styleConfig: styleConfigParse.data, brandTokens: brandTokensParse.data };
    });

    // Render-type rules from the frozen config (Fix 2) — evaluated post-render
    // by step 08b, never by step 07's checkSlidesData (which only ever
    // evaluates `check: "copy"` rules).
    const renderRules = frozen.styleConfig.rules.filter((r) => r.check === "render");

    // ── 03: claim the topic — topics.reserve is the ONLY dedup gate ──
    const topicClaim = await wf.step.code("03-claim-topic", async (): Promise<InstagramTopicClaim> => {
      const reservationKey = `${wf.runId}__topic`;
      const lane = runClaim.requestedLane ?? DEFAULT_CAROUSEL_LANE;
      const outcome = await tools["topics.reserve"]!.execute({ reservationKey, count: 1, excludeTopics: [], lane }, { ctx });
      if (outcome.status === "success") {
        const result = outcome.result as { reservationKey: string; topics: string[] };
        return { reservationKey: result.reservationKey, topic: result.topics[0]! };
      }
      if (outcome.status === "content_fail") {
        // The topics catalog is "the only dedup gate" (RFC-03 §2.3) — a floor
        // breach here (fewer unused rows available than requested, OR
        // reserving would drop the lane below the floor of 5 — Fix 1) is a
        // real, expected content outcome, never a crash. Fabricating a topic
        // ourselves would require the same real "invent + append" judgment
        // `research.pull` deliberately stands in for rather than fakes
        // (`packages/tools/karos-research/src/pull.ts`) — out of scope for
        // this deterministic code step — so a genuine breach holds the whole
        // post rather than silently proceeding without ever having claimed
        // the sole dedup lock. `topics.reserve` itself already tried a
        // proactive top-up before reporting this breach (see its own doc
        // comment) — this is the honest "it still couldn't be satisfied"
        // outcome, not a step this workflow skipped.
        throw new WorkflowHeld(`topics catalog floor breached — topics.reserve could not claim a topic for this run: ${outcome.reason}`);
      }
      throw new WorkflowToolingFailure(`topics.reserve failed: ${outcome.status}`);
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

      const imageExec = await wf.step.agent(`06-vet-images-attempt-${attempt}`, imageAgent, {
        slides: copy.slides.map((s) => ({ n: s.n, visualNeed: s.visualNeed })),
        candidatePool: imageCandidatePool,
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
      const unfillable = vetting.selections.filter((s) => {
        if (s.imagePath === null) return true;
        if (!s.rightsUsable || !s.watermarkFree) return true;
        if (usedImagesSet.has(s.imagePath)) return true;
        return false;
      });
      if (unfillable.length > 0) {
        const detail = unfillable.map((s) => {
          if (s.imagePath === null) return `${s.n}: no candidate qualified`;
          if (!s.rightsUsable) return `${s.n}: not rights-usable`;
          if (!s.watermarkFree) return `${s.n}: not watermark-free`;
          return `${s.n}: already used in a prior post`;
        });
        throw new WorkflowHeld(
          `no viable image found for slide(s) ${unfillable.map((s) => s.n).join(", ")} — holding the whole post rather than shipping a placeholder, a rights-encumbered/watermarked image, or a reused picture (${detail.join("; ")})`,
        );
      }

      const selfCheck = checkSlidesData(copy, vetting.selections, research, frozen.styleConfig);
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
          selections: vetting.selections,
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
      finalSelections = vetting.selections;
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
      const commitOutcome = await tools["topics.commit"]!.execute({ reservationKey: topicClaim.reservationKey }, { ctx });
      if (commitOutcome.status !== "success") {
        throw new WorkflowToolingFailure(`topics.commit failed to confirm the step-03 topic claim: ${commitOutcome.status}`);
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
