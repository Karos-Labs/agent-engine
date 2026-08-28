import { readForbiddenTopics } from "@agent-engine/core";
import type { AgentContext, AgentToolRegistry, GateResponse, ModelRouter, PromptStore } from "@agent-engine/core";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import type { Annotations, CaptureLegOutcome, DoctrineGateResult, Review, TriageResult } from "@agent-engine/tool-karos-reputation";
import { readRunDirection, runDirectionField, type SlotOutcome, type WorkflowContext, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure, runTopicGuardrail } from "@agent-engine/workflow";
import { ReputationDoctrineGateAgent } from "../agent/reputation-doctrine-gate-agent.js";
import { ReputationDraftAgent } from "../agent/reputation-draft-agent.js";
import { REPUTATION_CLASSIFIER_MODEL_ID, ReputationExtractionAgent } from "../agent/reputation-extraction-agent.js";
import { ReputationTagAgent } from "../agent/reputation-tag-agent.js";
import { ReputationVoiceAgent } from "../agent/reputation-voice-agent.js";
import { claimPulseNumber, claimReview, releaseReviewClaim } from "./claims.js";
import { type DraftCycleItem, type DraftFailureKind, applyClientLock, resolveCycleOutcome } from "./draft-cycle.js";
import { evidencedBoolean } from "./evidence.js";
import { parseReputationClientConfig } from "./intake.js";
import { buildTriagePayload } from "./triage-envelope.js";
import {
  appendLearningLog,
  readAnnotationsCache,
  readCrisisLedger,
  readResponseLedger,
  readSeenReviewLedger,
  recordCrisisSignature,
  recordResponded,
  recordSeen,
  writeAnnotationToCache,
} from "./ledgers.js";
import {
  DEPARTMENT_TAGS,
  type DepartmentTag,
  type ReputationCaptureLegStatus,
  type ReputationCompletionManifestRow,
  type ReputationFrozenInputs,
  type ReputationPulseWorkflowResult,
  type ReputationRunClaim,
} from "./types.js";

/**
 * run-protocol.md §4: "Two is the cap; the next failure sends that single
 * draft to the FLAG lane with the reason, and the rest of the batch
 * continues." The source text names this cap specifically for the doctrine
 * gate's own returns; this port applies the SAME 2-retry budget across the
 * whole 06 (draft) -> 07 (client lock) -> 08 (voice/anti-slop) -> 09
 * (doctrine) loop for one item, not just 09's own failures. This is a
 * deliberate, documented broadening, not an oversight: run-protocol.md's own
 * `-attempt-N` file convention already treats one draft's whole redo (not
 * just its doctrine re-check) as "one attempt," and a draft that fails the
 * cheaper mechanical/voice checks is exactly as much "the same draft trying
 * again" as one that fails doctrine — giving it a SEPARATE, uncapped retry
 * budget would let a single stubborn item loop indefinitely against the
 * voice/anti-slop gate while never touching its doctrine budget, which is
 * not what "two is the cap" is protecting against. Step 07's client-lock hard
 * stop is the one exception that never consumes or is bound by this budget —
 * it never loops at all (see `applyClientLock`).
 */
const MAX_DRAFT_GATE_RETRIES = 2;

/**
 * The SEPARATE budget for execution/tooling faults on a single item
 * (run-protocol.md §4: "a crash cannot consume a gate attempt"). Two design
 * choices are worth stating outright, because the obvious alternative was
 * considered and rejected on concrete evidence:
 *
 * 1. **A tooling fault never spends a doctrine-gate attempt.** Two transient
 *    router failures used to burn the whole 2-retry budget before the model
 *    ever got a real chance, and the third — genuine — content failure then
 *    dropped a perfectly draftable review to FLAG. That is precisely the
 *    "silently eat one of three chances and move on" the source text forbids.
 *
 * 2. **A tooling fault retries the item rather than halting the run
 *    immediately — but halts loudly once this budget is spent.** Halting on
 *    the FIRST tooling fault (the more literal reading of "a crash means the
 *    whole step redoes") is not implementable as resumable work here:
 *    `step.agent` checkpoints its `AgentExecutionResult` as a COMPLETED step
 *    even when that result's own status is `tooling_error`
 *    (`packages/workflow/src/primitives/step-agent.ts`), so a resumed run
 *    replays the checkpoint, sees the same `tooling_error`, and halts again —
 *    forever. The retry loop, by contrast, DOES get a real second call,
 *    because each cycle uses a fresh cycle-numbered step id. So: retry within
 *    the run (free), and if the fault persists past this budget it is not
 *    transient — raise `WorkflowToolingFailure`, halt the run `degraded`, and
 *    let a human fix the infrastructure. The item is never quietly degraded
 *    to FLAG on infrastructure grounds either way.
 */
const MAX_DRAFT_TOOLING_RETRIES = 2;

/** Maps an `AgentExecutionResult.status` that isn't `completed` onto which retry budget it spends (RFC-01 §6's content-vs-tooling split). */
function agentFailureKind(status: string): DraftFailureKind {
  return status === "content_fail" ? "content" : "tooling";
}

export interface CreateReputationPulseWorkflowOptions {
  /** The base Layer 3 registry — `createAllKarosTools()` already includes `karos-reputation`'s `reputation.triage`/`reputation.capture`/`reputation.doctrineGate`. */
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * The raw `WorkspaceStoreLike` this pulse's two idempotent claims
   * (run-protocol.md §5) and three live ledgers (§6) are read/written
   * against directly — these are NOT exposed as registered tools (there is
   * no generic "claim"/"ledger" tool in this codebase to reuse, per RFC-08's
   * own instruction to "build an equivalent using the WorkspaceStoreLike
   * primitives directly if nothing existing fits").
   *
   * REQUIRED (SCRUM-328 / AU45). This used to default to
   * `createWorkspaceStore()` — a local, file-backed store that, as the note
   * on `AgentRuntimeDeps.workspaceStore` already admitted, "would silently
   * reset per Cloud Run instance in production". A pulse whose claims and
   * ledgers land on instance-local disk loses them on the next request, with
   * no error anywhere. Callers pass an explicit store (in tests, one pointed
   * at a temp directory) so this and the tool registry share one workspace.
   */
  store: WorkspaceStoreLike;
  /**
   * Skips the step 10 `reputation_approve_all` human gate and records a
   * synthetic `actor: "system"` approval instead — off by default, matching
   * every other agent in this repo's exact same opt-out pattern (RFC-01
   * §8.3). Never for production wiring: RFC-08 §6/§11 item 5 is explicit
   * that every approved draft must be held for a human, unconditionally.
   */
  autoApprove?: boolean;
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

function completedOutputs<T>(slots: readonly SlotOutcome<T>[]): T[] {
  return slots.filter((s): s is Extract<SlotOutcome<T>, { status: "completed" }> => s.status === "completed").map((s) => s.output);
}

/**
 * `createReputationPulseWorkflow()` (RFC-08's migration of the legacy
 * `reputation-agent-v2` runner): the 11-step pulse (RFC-08 §5), native to
 * `agent-engine`'s Firestore-backed workflow substrate rather than
 * `run-protocol.md`'s literal numbered-file-per-step folder design — per
 * RFC-08 §1, the `WorkflowEngine`'s own durable step store already IS that
 * design's equivalent (each `wf.step.*` call's outcome is the verdict line).
 * Two ideas from `run-protocol.md` ARE ported faithfully as real logic, not
 * as literal files:
 *
 * - §5's "two claims" (the pulse number, each drafted `review_id`), each a
 *   real idempotent-keyed write via `claims.ts` — see that file's own doc
 *   comment for exactly how this replaces the legacy read-after-write race
 *   check with a single write-and-confirm.
 * - §2b's "a multi-item step writes a sibling completion file, last": the
 *   06-09 draft loop and step 11's payload both produce a real
 *   `ReputationCompletionManifestRow[]` — see the `draftManifest` field on
 *   this function's return value and the `11-assemble-and-persist` step
 *   below, which writes it as the deliverable's own last-computed field.
 *
 * The deterministic-vs-model boundary this whole product is named for
 * (`references/scoring.md` §2, RFC-08 §2): `reputation.triage` is the SOLE
 * routing authority. No agent in this file ever sees or decides a lane —
 * `ReputationExtractionAgent` only answers evidenced booleans,
 * `ReputationTagAgent` only tags reviews the engine already flagged, and
 * `ReputationDraftAgent`/`ReputationDoctrineGateAgent` only see reviews the
 * engine already routed to a lane carrying `draft_attached: true`.
 */
export function createReputationPulseWorkflow(options: CreateReputationPulseWorkflowOptions) {
  const tools = options.tools;
  const store = options.store;

  return async function reputationPulseWorkflow(wf: WorkflowContext): Promise<ReputationPulseWorkflowResult> {
    const ctx = toAgentContext(wf);

    // The run-scoped instruction someone typed in the portal, resolved once.
    //
    // Distinct from the client's standing `reputationSteer` in config, and both
    // are legitimate: the steer says what always matters to this client, the
    // direction says what matters about today's pulse.
    const runDirection = readRunDirection(wf.input);

    // ── 01: open the pulse — claim the pulse number, read the client's one-off steer ──
    const runClaim = await wf.step.code("01-open-pulse", async (): Promise<ReputationRunClaim> => {
      const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
      const rawConfig = configOutcome.status === "success" ? (configOutcome.result as Record<string, unknown>) : {};
      const parsed = parseReputationClientConfig(rawConfig);
      const pulseNumber = parsed.pulseNumber ?? 1;
      const claim = await claimPulseNumber(store, wf.clientSlug, wf.runId, pulseNumber);
      // A lost pulse-number race is cosmetic, not fatal (unlike a lost review
      // claim): the number is best-effort/informational (no sequential-counter
      // tool exists in this repo, same documented gap `instagram-agent`'s
      // `postNumber` already accepts) — the run's real identity is `wf.runId`,
      // a caller-supplied idempotency key already globally unique per RFC-01
      // §9.1 rule 2. The claim is still made for real (run-protocol.md §5's
      // discipline is worth having even where the number itself is cosmetic).
      return { pulseNumber, claimedNew: claim.won, steer: parsed.steer };
    });

    // ── 02: freeze the client-IS inputs (facts/brand/voice/locks/roster/autonomy) ──
    const frozen = await wf.step.code("02-freeze-inputs", async (): Promise<ReputationFrozenInputs> => {
      const [profileOutcome, brandOutcome, voiceOutcome, configOutcome] = await Promise.all([
        tools["client.getProfile"]!.execute({}, { ctx }),
        tools["client.getBrand"]!.execute({}, { ctx }),
        tools["client.getVoiceRules"]!.execute({}, { ctx }),
        tools["client.getConfig"]!.execute({}, { ctx }),
      ]);

      const rawConfig = configOutcome.status === "success" ? (configOutcome.result as Record<string, unknown>) : {};
      const parsed = parseReputationClientConfig(rawConfig);

      if (parsed.autonomy !== "approve-all") {
        // Fail fast, before any capture/extraction/drafting spend — RFC-08 §6:
        // no reply-publish credential exists for any autonomy level besides
        // approve-all today, so a client config claiming otherwise is a
        // config bug, never a value this run silently honors or guesses past.
        throw new WorkflowBlockedIntake(
          `client's reputationAutonomy is set to "${parsed.autonomy}", but "approve-all" is the only legal autonomy level today (RFC-08 §6) — refusing to run rather than silently picking a behavior for an unsupported value`,
        );
      }

      const profile = profileOutcome.status === "success" ? (profileOutcome.result as Record<string, unknown>) : {};
      const factsRaw = profile["facts"];
      const facts = Array.isArray(factsRaw) ? factsRaw.filter((f): f is string => typeof f === "string") : [];

      const brand = brandOutcome.status === "success" ? (brandOutcome.result as Record<string, unknown>) : {};
      const voiceRules = voiceOutcome.status === "success" ? (voiceOutcome.result as Record<string, unknown>) : {};

      return {
        forbiddenTopics: readForbiddenTopics(rawConfig),
        facts,
        brand,
        voiceRules,
        locks: parsed.locks,
        autonomy: parsed.autonomy,
        captureLegs: parsed.captureLegs,
        ...(parsed.rosterConfigError !== undefined ? { rosterConfigError: parsed.rosterConfigError } : {}),
        baselineRatingAvg: parsed.baselineRatingAvg,
        ...(parsed.triageConfigOverride !== undefined ? { triageConfigOverride: parsed.triageConfigOverride } : {}),
      };
    });

    // ── 03: capture — reputation.capture across the client's configured roster legs ──
    const captureLegs = await wf.step.code("03-capture", async (): Promise<CaptureLegOutcome[]> => {
      if (frozen.captureLegs.length === 0) {
        throw new WorkflowBlockedIntake(
          `no reputation capture legs are configured for this client's roster${frozen.rosterConfigError ? ` (${frozen.rosterConfigError})` : ""} — nothing to capture this pulse`,
        );
      }
      const outcome = await tools["reputation.capture"]!.execute({ legs: frozen.captureLegs }, { ctx });
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`reputation.capture failed: ${outcome.status}`);
      }
      return (outcome.result as { legs: CaptureLegOutcome[] }).legs;
    });
    // `reviews` now carries an UNAVAILABLE-tier tombstone row for every dead
    // leg (ADAPTERS.md rule 1 / run-protocol.md §7: "never a silent zero"), so
    // it reaches `reputation.triage`'s own tombstone branch and lands in
    // `summary.unavailable` instead of vanishing.
    const capturedReviews: Review[] = captureLegs.flatMap((l) => l.reviews);
    const reviewsById = new Map(capturedReviews.map((r) => [r.review_id, r]));

    // A tombstone row buried among the reviews is the ENGINE's signal; a human
    // reading the pulse needs the leg-level fact as a first-class line
    // ("Google: capture failed, reason X"), which is what this carries into
    // the step-11 payload and the workflow result.
    const captureLegStatuses: ReputationCaptureLegStatus[] = captureLegs.map((l) => ({
      leg: l.leg,
      status: l.status,
      reviewCount: l.reviews.filter((r) => r.capture_tier !== "UNAVAILABLE").length,
      ...(l.reason !== undefined ? { reason: l.reason } : {}),
    }));
    const unavailableLegs = captureLegStatuses.filter((l) => l.status === "UNAVAILABLE");

    // ── 04a: extraction — one commodity-tier model pass per NEW review only ──
    // (scoring.md §2: "one pass per review, cached, never re-classified.")
    // The cache read determines the fanout's item list below, so it is
    // checkpointed (frozen for this run) rather than re-read live — see
    // `ledgers.ts`'s `readAnnotationsCache` doc comment for why.
    const cachedAnnotationsEntries = await wf.step.code("04a-read-annotations-cache", async () => {
      const reviewIds = capturedReviews.filter((r) => r.capture_tier !== "UNAVAILABLE" && r.annotations === undefined).map((r) => r.review_id);
      // Keyed `(review_id, classifier_model_id)` per review-schema.md — see
      // `readAnnotationsCache`. Swapping the pinned classifier is a logged
      // config change that must re-classify, not silently reuse stale labels.
      const cache = await readAnnotationsCache(store, wf.clientSlug, reviewIds, REPUTATION_CLASSIFIER_MODEL_ID);
      return Array.from(cache.entries());
    });
    const cachedAnnotations = new Map<string, Annotations>(cachedAnnotationsEntries);

    const needsExtraction = capturedReviews.filter(
      (r) => r.capture_tier !== "UNAVAILABLE" && r.annotations === undefined && !cachedAnnotations.has(r.review_id),
    );

    const extractionSlots = await wf.fanout("04b-extract-new-reviews", needsExtraction, async (review, slotCtx) => {
      const agent = new ReputationExtractionAgent({ router: options.router, tools, promptStore: options.promptStore });
      const exec = await slotCtx.step.agent("extract", agent, {
        reviewId: review.review_id,
        platform: review.platform,
        rating: review.rating ?? null,
        text: review.text ?? "",
      });
      if (exec.status !== "completed" || !exec.finalOutput) {
        // A broken extraction pass for ONE review must never fabricate a
        // positive value signal (scoring.md §2's anti-vibe invariant) —
        // defaulting every boolean to false is the conservative direction:
        // it can only under-count value (never mis-route to RESPOND), and
        // urgency (the FLAG-triggering signal set) never depends on
        // annotations at all, so a review that genuinely needs flagging
        // still flags. The batch continues rather than the whole pulse
        // aborting over one review's extraction hiccup.
        const fallback: Annotations = {
          classifier_model_id: `extraction-failed:${exec.status}`,
          sentiment: "neutral",
          factual_error: false,
          fixable_complaint: false,
          detailed_positive: false,
          service_recovery_opportunity: false,
        };
        return { reviewId: review.review_id, annotations: fallback };
      }
      const out = exec.finalOutput;
      const modelUsed = exec.steps[exec.steps.length - 1]?.modelUsed ?? "unknown";
      const text = review.text ?? "";
      const annotations: Annotations = {
        classifier_model_id: modelUsed,
        sentiment: out.sentiment,
        factual_error: evidencedBoolean(out.factualError, text),
        fixable_complaint: evidencedBoolean(out.fixableComplaint, text),
        detailed_positive: evidencedBoolean(out.detailedPositive, text),
        service_recovery_opportunity: evidencedBoolean(out.serviceRecoveryOpportunity, text),
      };
      return { reviewId: review.review_id, annotations };
    });
    const newlyExtracted = completedOutputs(extractionSlots);

    // Cache every newly-extracted annotation for future pulses (checkpointed
    // — see `readAnnotationsCache`'s doc comment on why this is a plain,
    // idempotent overwrite rather than a live/`appendIfAbsent` ledger).
    await wf.step.code("04c-cache-new-annotations", async () => {
      for (const { reviewId, annotations } of newlyExtracted) {
        await writeAnnotationToCache(store, wf.clientSlug, reviewId, annotations);
      }
      return { cached: newlyExtracted.length };
    });

    const newlyExtractedById = new Map(newlyExtracted.map((e) => [e.reviewId, e.annotations]));
    const annotatedReviews: Review[] = capturedReviews.map((r) => {
      if (r.capture_tier === "UNAVAILABLE" || r.annotations !== undefined) return r;
      const annotations = cachedAnnotations.get(r.review_id) ?? newlyExtractedById.get(r.review_id);
      return annotations ? { ...r, annotations } : r;
    });

    // ── 04d: assemble the TriagePayload envelope and call reputation.triage ──
    // The three live ledgers are deliberately read here as plain `await`
    // calls, NOT wrapped in `wf.step.code` — run-protocol.md §6: "the
    // response ledger is re-read on every resume... a pulse resumed two days
    // later must see what a sibling pulse answered in between." Safe to
    // leave uncheckpointed because these feed plain array arguments into one
    // `wf.step.code` call below, never a fanout's item list (unlike the
    // annotations cache above).
    const alreadyRespondedIds = await readResponseLedger(store, wf.clientSlug);
    const seenReviewIds = await readSeenReviewLedger(store, wf.clientSlug);
    const alertedCrisisSignatures = await readCrisisLedger(store, wf.clientSlug);

    const triageResult = await wf.step.code("04d-triage", async (): Promise<TriageResult> => {
      const payload = buildTriagePayload({
        now: new Date().toISOString(),
        reviews: annotatedReviews,
        alreadyRespondedIds,
        seenReviewIds,
        alertedCrisisSignatures,
        baselineRatingAvg: frozen.baselineRatingAvg,
      });
      const outcome = await tools["reputation.triage"]!.execute(
        { payload, ...(frozen.triageConfigOverride !== undefined ? { config: frozen.triageConfigOverride } : {}) },
        { ctx },
      );
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`reputation.triage failed: ${outcome.status}`);
      }
      return outcome.result as TriageResult;
    });

    // ── 04e: department tagging — FLAG-lane rows only, one pinned batch call ──
    const flagRows = triageResult.results.filter((r) => r.route === "FLAG");
    const departmentTags = await wf.step.code("04e-tag-flagged-reviews", async (): Promise<Array<{ reviewId: string; tag: DepartmentTag }>> => {
      if (flagRows.length === 0) return [];
      const tagAgent = new ReputationTagAgent({ router: options.router, tools, promptStore: options.promptStore });
      const exec = await wf.step.agent("tag", tagAgent, {
        reviews: flagRows.map((r) => {
          const review = reviewsById.get(r.review_id);
          return { reviewId: r.review_id, platform: review?.platform ?? "unknown", rating: review?.rating ?? null, text: review?.text ?? "" };
        }),
      });
      if (exec.status !== "completed" || !exec.finalOutput) {
        throw new WorkflowToolingFailure(`department tagging step resolved to "${exec.status}"`);
      }
      const flagIds = new Set(flagRows.map((r) => r.review_id));
      const tags = exec.finalOutput.tags.filter((t) => flagIds.has(t.reviewId) && (DEPARTMENT_TAGS as readonly string[]).includes(t.tag));
      const coveredIds = new Set(tags.map((t) => t.reviewId));
      const missing = flagRows.filter((r) => !coveredIds.has(r.review_id));
      if (missing.length > 0) {
        throw new WorkflowToolingFailure(
          `department tagging did not cover every flagged review — missing a tag for: ${missing.map((r) => r.review_id).join(", ")}`,
        );
      }
      return tags;
    });
    const departmentTagById = new Map(departmentTags.map((t) => [t.reviewId, t.tag]));

    // ── 05: the NO-ACTION log — every NO_ACTION row recorded as a decision, not silence ──
    await wf.step.code("05-no-action-log", async () => {
      const noActionRows = triageResult.results.filter((r) => r.route === "NO_ACTION");
      for (const row of noActionRows) {
        await tools["memory.appendDecision"]!.execute(
          {
            decisionId: `${wf.runId}__no_action__${row.review_id.replace(/[:/\\]/g, "__")}`,
            summary: `NO_ACTION for ${row.review_id}: ${row.reason} (value=${row.value_score}, urgency=${row.urgency_score})`,
          },
          { ctx },
        );
      }
      return { count: noActionRows.length };
    });

    // ── 04f: claim every draft-lane review before drafting (run-protocol.md §5 claim #2) ──
    const draftLaneRows = triageResult.results.filter((r) => r.draft_attached);
    const claimResult = await wf.step.code("04f-claim-draftable-reviews", async () => {
      const claimed: string[] = [];
      const lost: Array<{ reviewId: string; claimedBy: string }> = [];
      for (const row of draftLaneRows) {
        const outcome = await claimReview(store, wf.clientSlug, wf.runId, row.review_id);
        if (outcome.won) claimed.push(row.review_id);
        else lost.push({ reviewId: row.review_id, claimedBy: outcome.claimedBy });
      }
      return { claimed, lost };
    });
    const claimedIds = new Set(claimResult.claimed);
    const claimedDraftRows = draftLaneRows.filter((r) => claimedIds.has(r.review_id));
    const manifestFromClaim: ReputationCompletionManifestRow[] = claimResult.lost.map((l) => ({
      reviewId: l.reviewId,
      outcome: "dropped",
      reason: `lost the review claim race to run "${l.claimedBy}" — deferred to a future pulse, never double-replied (run-protocol.md §5)`,
    }));

    // ── 06-09: draft -> client lock -> voice/anti-slop -> doctrine gate, looped per item ──
    let pending: DraftCycleItem[] = claimedDraftRows.map((row) => ({ row, attempts: 0, toolingRetries: 0 }));
    const approvedDrafts = new Map<string, string>();
    const manifestFromLoop: ReputationCompletionManifestRow[] = [];

    // The cycle ceiling has to cover BOTH budgets: a tooling fault buys another
    // cycle without spending a content attempt, so an item that hits the
    // maximum of each still gets all of its content attempts.
    const maxCycles = MAX_DRAFT_GATE_RETRIES + MAX_DRAFT_TOOLING_RETRIES + 1;

    for (let cycle = 1; cycle <= maxCycles && pending.length > 0; cycle++) {
      const currentPending = pending;

      // 06: draft, one bounded agent call per item, fanned out.
      const draftSlots = await wf.fanout(`06-draft-cycle-${cycle}`, currentPending, async (item, slotCtx) => {
        const review = reviewsById.get(item.row.review_id);
        const agent = new ReputationDraftAgent({ router: options.router, tools, promptStore: options.promptStore });
        const exec = await slotCtx.step.agent("draft", agent, {
          reviewId: item.row.review_id,
          platform: review?.platform ?? "unknown",
          rating: review?.rating ?? null,
          text: review?.text ?? "",
          route: item.row.route,
          factsBase: frozen.facts,
          brandVoice: frozen.voiceRules,
          priorFailureReason: item.lastFailureReason ?? null,
        });
        if (exec.status !== "completed" || !exec.finalOutput) {
          // `content_fail` is a verdict about the draft and spends an attempt;
          // `tooling_error`/`budget_exceeded` is the run breaking and does not.
          return {
            reviewId: item.row.review_id,
            ok: false as const,
            reason: `draft step resolved to "${exec.status}"`,
            failureKind: agentFailureKind(exec.status),
          };
        }
        return { reviewId: item.row.review_id, ok: true as const, draftText: exec.finalOutput.draftText };
      });

      // 07: the client-lock hard stop — deterministic, never retried.
      const lockResult = await wf.step.code(`07-client-lock-cycle-${cycle}`, () => applyClientLock(currentPending, draftSlots, frozen.locks));

      // 08a: voice consistency, read as a batch (a bounded agent call over every step-07 survivor together).
      let voiceVerdicts: Array<{ reviewId: string; pass: boolean; reason: string }> = [];
      if (lockResult.survivors.length > 0) {
        const voiceAgent = new ReputationVoiceAgent({ router: options.router, tools, promptStore: options.promptStore });
        const voiceExec = await wf.step.agent(`08a-voice-batch-cycle-${cycle}`, voiceAgent, {
          ...runDirectionField(runDirection),
          brandVoice: frozen.voiceRules,
          drafts: lockResult.survivors.map((s) => ({ reviewId: s.reviewId, draftText: s.draftText })),
        });
        if (voiceExec.status !== "completed" || !voiceExec.finalOutput) {
          throw new WorkflowToolingFailure(`voice batch step resolved to "${voiceExec.status}" on cycle ${cycle}`);
        }
        voiceVerdicts = voiceExec.finalOutput.verdicts;
      }

      // 08b: the mechanical anti-slop gate (gate.lintPost), per survivor, one pass over the batch.
      const mechanicalResult = await wf.step.code(`08b-mechanical-antislop-cycle-${cycle}`, async () => {
        const passed: Array<{ reviewId: string; draftText: string }> = [];
        const failed: Array<{ reviewId: string; reason: string }> = [];
        for (const s of lockResult.survivors) {
          const voiceVerdict = voiceVerdicts.find((v) => v.reviewId === s.reviewId);
          if (voiceVerdict && !voiceVerdict.pass) {
            failed.push({ reviewId: s.reviewId, reason: `voice batch check failed: ${voiceVerdict.reason}` });
            continue;
          }
          const lintOutcome = await tools["gate.lintPost"]!.execute({ text: s.draftText, platform: "generic" }, { ctx });
          if (lintOutcome.status !== "success") {
            throw new WorkflowToolingFailure(`gate.lintPost failed: ${lintOutcome.status}`);
          }
          const verdict = lintOutcome.result as { verdict: "pass" | "content_fail" | "tooling_error"; reason?: string };
          if (verdict.verdict === "tooling_error") {
            throw new WorkflowToolingFailure(`gate.lintPost reported tooling_error: ${verdict.reason ?? "no reason given"}`);
          }
          if (verdict.verdict === "content_fail") {
            failed.push({ reviewId: s.reviewId, reason: `mechanical anti-slop check failed: ${verdict.reason ?? "no reason given"}` });
            continue;
          }
          passed.push(s);
        }
        return { passed, failed };
      });

      // 09: the doctrine gate — a SEPARATE bounded agent (never the same
      // instance, never fed step 06's own reasoning) produces 4 quoted
      // verdicts; `reputation.doctrineGate` computes the mechanical decision.
      const doctrineSlots = await wf.fanout(`09-doctrine-gate-cycle-${cycle}`, mechanicalResult.passed, async (item, slotCtx) => {
        const review = reviewsById.get(item.reviewId);
        const doctrineAgent = new ReputationDoctrineGateAgent({ router: options.router, tools, promptStore: options.promptStore });
        const verdictExec = await slotCtx.step.agent("doctrine-verdicts", doctrineAgent, {
          reviewId: item.reviewId,
          draftText: item.draftText,
          factsBase: frozen.facts,
          reviewText: review?.text ?? "",
        });
        if (verdictExec.status !== "completed" || !verdictExec.finalOutput) {
          return {
            reviewId: item.reviewId,
            ok: false as const,
            reason: `doctrine verdict step resolved to "${verdictExec.status}"`,
            failureKind: agentFailureKind(verdictExec.status),
          };
        }
        const gateOutcome = await tools["reputation.doctrineGate"]!.execute(
          { draftText: item.draftText, factsBase: frozen.facts, modelVerdicts: verdictExec.finalOutput.verdicts },
          { ctx: toAgentContext(slotCtx) },
        );
        if (gateOutcome.status !== "success") {
          // Includes a malformed verdict set (not 4 distinct constraints):
          // `DoctrineGateInputSchema` rejects it, so the gate never ran at all.
          // That is a validation/tooling fault to surface, never a quiet
          // `overallPass: false` and never a strike against the draft.
          const detail = "reason" in gateOutcome && typeof gateOutcome.reason === "string" ? `: ${gateOutcome.reason}` : "";
          return {
            reviewId: item.reviewId,
            ok: false as const,
            reason: `reputation.doctrineGate tool call failed (${gateOutcome.status})${detail}`,
            failureKind: "tooling" as const,
          };
        }
        const result = gateOutcome.result as DoctrineGateResult;
        if (!result.overallPass) {
          const failing = result.verdicts.filter((v) => v.verdict === "fail").map((v) => `${v.constraint}: ${v.rationale}`);
          const overrideNote =
            result.mechanicalOverrides.length > 0
              ? `; mechanical override(s): ${result.mechanicalOverrides.map((o) => `${o.constraint}: ${o.reason}`).join("; ")}`
              : "";
          // An observed doctrine verdict — the one thing run-protocol.md §4's
          // "two is the cap" actually counts.
          return {
            reviewId: item.reviewId,
            ok: false as const,
            reason: `doctrine gate failed: ${failing.join("; ")}${overrideNote}`,
            failureKind: "content" as const,
          };
        }
        return { reviewId: item.reviewId, ok: true as const };
      });

      const laterFailures = new Map<string, { reason: string; kind: DraftFailureKind }>();
      // A voice/anti-slop rejection is an observed verdict about the draft's
      // content — it spends an attempt, exactly like a doctrine `fail`.
      for (const f of mechanicalResult.failed) laterFailures.set(f.reviewId, { reason: f.reason, kind: "content" });
      const approvedThisCycleIds = new Set<string>();
      mechanicalResult.passed.forEach((item, i) => {
        const slot = doctrineSlots[i];
        if (!slot) return;
        // AU68 (SCRUM-366): `!== "completed"` rather than `=== "failed"` — a
        // slot outcome is no longer binary, and a non-completed slot carries no
        // verdict about the draft either way.
        if (slot.status !== "completed") {
          // The slot did not produce a verdict: nothing was learned about the draft.
          laterFailures.set(item.reviewId, { reason: `doctrine gate step failed: ${slot.reason}`, kind: "tooling" });
          return;
        }
        if (slot.output.ok) {
          approvedThisCycleIds.add(item.reviewId);
        } else {
          laterFailures.set(item.reviewId, {
            reason: slot.output.reason ?? "doctrine gate did not pass for an unspecified reason",
            kind: slot.output.failureKind ?? "content",
          });
        }
      });

      const cycleResolution = resolveCycleOutcome(
        currentPending,
        lockResult,
        laterFailures,
        approvedThisCycleIds,
        MAX_DRAFT_GATE_RETRIES,
        MAX_DRAFT_TOOLING_RETRIES,
      );
      if (cycleResolution.toolingFailures.length > 0) {
        // Not a content verdict and not a silent degrade to FLAG: the run
        // halts `degraded` with the real cause, for a human to fix and resume
        // (run-protocol.md §9's HALT — "fix the precondition and resume that
        // same step"). Claims are deliberately NOT released here: the run is
        // not closed, and §11 keeps a resumed run's claims.
        throw new WorkflowToolingFailure(
          `steps 06-09 could not complete for ${cycleResolution.toolingFailures.length} item(s) after exhausting the per-item tooling-retry budget — ${cycleResolution.toolingFailures
            .map((f) => `${f.reviewId} (${f.reason})`)
            .join("; ")}`,
        );
      }
      for (const a of cycleResolution.approved) approvedDrafts.set(a.reviewId, a.draftText);
      manifestFromLoop.push(...cycleResolution.droppedThisCycle);
      pending = cycleResolution.nextPending;
    }

    // Safety net: by construction `pending` is empty once the loop above
    // exits (every item either lands in `approvedDrafts` or gets dropped
    // within the cycle its own attempt count exceeds the cap) — but a
    // completion manifest must account for every item regardless, so a
    // leftover here (which would indicate a logic bug, not a normal outcome)
    // is still recorded rather than silently vanishing.
    for (const leftover of pending) {
      manifestFromLoop.push({
        reviewId: leftover.row.review_id,
        outcome: "dropped",
        reason: `left pending after the retry loop exhausted its cycles: ${leftover.lastFailureReason ?? "unspecified"}`,
      });
    }

    // ── 10: apply the frozen autonomy record, then the mandatory human gate ──
    // Defense in depth: re-assert the same "approve-all is the only legal
    // value" check from step 02's freeze, even though a client config can no
    // longer change it mid-run (frozen values don't mutate) — this is the
    // "real, if trivial, autonomy-level check" RFC-08's task spec asks for
    // at this specific step, kept honest rather than turned into a comment.
    if (frozen.autonomy !== "approve-all") {
      throw new WorkflowBlockedIntake(`frozen autonomy value "${frozen.autonomy}" is not "approve-all" — this should be unreachable past step 02`);
    }
    const approvedList = Array.from(approvedDrafts.entries()).map(([reviewId, draftText]) => ({ reviewId, draftText }));
    // ── terminal topic guardrail ──
    //
    // Every approved reply, judged as one body of text before a human is asked
    // to release them. These are public replies on the client's own listings,
    // which is exactly the voice forbiddenTopics is about. Not a repeat of the
    // brand gate: that matches terms, this judges subjects.
    await runTopicGuardrail(
      wf,
      { tools, promptStore: options.promptStore, router: options.router },
      approvedList.map((d) => d.draftText).join("\n\n"),
      frozen.forbiddenTopics,
    );

    const approveAllDecision: GateResponse = options.autoApprove
      ? await wf.step.code("10-reputation-approve-all", () => ({ decision: "approve" as const, actor: "system", at: new Date().toISOString() }))
      : await wf.step.gate("10-reputation-approve-all", {
          kind: "reputation_approve_all",
          payload: {
            runId: wf.runId,
            pulseNumber: runClaim.pulseNumber,
            approvedDraftCount: approvedList.length,
            flaggedCount: flagRows.length,
            crisisFired: triageResult.crisis.fired,
          },
          requiredRole: "account_manager",
          timeout: { duration: "24h", onTimeout: "hold" },
        });
    if (approveAllDecision.decision !== "approve") {
      // A rejection here means a human looked at the batch and said no —
      // this is `WorkflowHeld`, not a crash: nothing was published either
      // way (this workflow never calls a publish path at all), so a
      // rejection just means the drafts stay unapproved for this pulse.
      //
      // This IS a closing point (run-protocol.md §9: "`HELD` jumps straight to
      // the closing step" and "closing... releases every claim"), so every
      // claim this run took comes back — the approved lane included. Without
      // this, one human "no" would strand a whole pulse's worth of perfectly
      // draftable reviews behind claims held by a run that will never reopen.
      await wf.step.code("10b-release-claims-on-hold", async () => {
        const released: string[] = [];
        for (const reviewId of claimResult.claimed) {
          if (await releaseReviewClaim(store, wf.clientSlug, wf.runId, reviewId)) released.push(reviewId);
        }
        return { released };
      });
      throw new WorkflowHeld(`reputation_approve_all gate rejected: ${approveAllDecision.reason ?? "no reason given"}`);
    }

    // ── 11: payload, ledger appends (idempotent, keyed per run-protocol.md §12), learning log ──
    const draftManifest: ReputationCompletionManifestRow[] = [
      ...manifestFromClaim,
      ...manifestFromLoop,
      ...approvedList.map((a): ReputationCompletionManifestRow => ({ reviewId: a.reviewId, outcome: "written" })),
    ];

    const deliverableId = await wf.step.code("11-assemble-and-persist", async () => {
      for (const { reviewId } of approvedList) {
        await recordResponded(store, wf.clientSlug, wf.runId, "11", reviewId);
      }

      // run-protocol.md §9: the closing step "releases every claim". A claim
      // only ever existed to stop two pulses drafting the same review at once
      // — it is NOT the record that a review was answered (that is the
      // response ledger, written just above). So every review this run claimed
      // but did not persist a reply for (dropped by the client lock, dropped
      // after the retry cap, left over) hands its claim back here; otherwise
      // it is claimed forever by a closed run and can never be drafted again.
      for (const reviewId of claimResult.claimed) {
        if (!approvedDrafts.has(reviewId)) {
          await releaseReviewClaim(store, wf.clientSlug, wf.runId, reviewId);
        }
      }

      for (const review of capturedReviews) {
        if (review.capture_tier !== "UNAVAILABLE") {
          await recordSeen(store, wf.clientSlug, wf.runId, "11", review.review_id);
        }
      }
      for (const trigger of triageResult.crisis.triggers) {
        if (!trigger.suppressed) {
          await recordCrisisSignature(store, wf.clientSlug, wf.runId, "11", trigger.signature);
        }
      }

      const flaggedWithTags = flagRows.map((r): ReputationFlagRowPayload => {
        const departmentTag = departmentTagById.get(r.review_id);
        return {
          reviewId: r.review_id,
          valueScore: r.value_score,
          urgencyScore: r.urgency_score,
          reason: r.reason,
          ...(departmentTag !== undefined ? { departmentTag } : {}),
        };
      });

      const payload = {
        pulseNumber: runClaim.pulseNumber,
        generatedAt: new Date().toISOString(),
        summary: triageResult.summary,
        crisis: triageResult.crisis,
        // First-class, human-readable coverage: which legs ran, which are
        // down and why. `summary.unavailable` counts the tombstone ROWS; this
        // names the integrations (ADAPTERS.md rule 1 / run-protocol.md §7).
        captureLegs: captureLegStatuses,
        unavailableLegs,
        flagged: flaggedWithTags,
        approvedDrafts: approvedList,
        draftManifest,
      };

      const writeOutcome = await tools["ledger.writeDeliverable"]!.execute({ runId: wf.runId, kind: "reputation-pulse", deliverable: payload }, { ctx });
      if (writeOutcome.status !== "success") {
        throw new WorkflowToolingFailure(`ledger.writeDeliverable failed: ${writeOutcome.status}`);
      }
      const id = (writeOutcome.result as { id: string }).id;

      await appendLearningLog(store, wf.clientSlug, wf.runId, {
        pulseNumber: runClaim.pulseNumber,
        counts: triageResult.summary as unknown as Record<string, number>,
        crisisFired: triageResult.crisis.fired,
        droppedToFlagCount: draftManifest.filter((m) => m.outcome === "dropped").length,
      });

      return id;
    });

    return {
      pulseNumber: runClaim.pulseNumber,
      counts: {
        respond: triageResult.summary.respond,
        flag: triageResult.summary.flag,
        noAction: triageResult.summary.no_action,
        unavailable: triageResult.summary.unavailable,
      },
      crisisFired: triageResult.crisis.fired,
      crisisTriggerCount: triageResult.crisis.triggers.length,
      deliverableId,
      draftManifest,
      approvedDraftCount: approvedList.length,
      flaggedCount: flagRows.length,
      captureLegs: captureLegStatuses,
      unavailableLegs,
    };
  };
}

interface ReputationFlagRowPayload {
  reviewId: string;
  valueScore: number;
  urgencyScore: number;
  reason: string;
  departmentTag?: DepartmentTag;
}
