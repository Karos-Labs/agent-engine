import {
  GUARDRAIL_OUTPUT_FIELDS,
  GUARDRAIL_STEP_ID,
  GuardrailViolationError,
  DynamicAgent,
  buildGuardrailInput,
  buildGuardrailSystemPrompt,
  buildOutputSchema,
  readForbiddenTopics,
  toVerdict,
  type AgentContext,
  type AgentToolRegistry,
  type GateVerdict,
  type GuardrailOutput,
  type ModelRouter,
  type PromptStore,
  readRichRunInput,
  firstAsset,
} from "@agent-engine/core";
import { WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure, type WorkflowContext } from "@agent-engine/workflow";
import { TikTokCommentaryAgent } from "../agent/tiktok-commentary-agent.js";
import { TikTokMomentAgent } from "../agent/tiktok-moment-agent.js";
import { boundsFromTranscript, sentenceBoundedWords, type TranscriptWordLike } from "./clip-bounds.js";
import {
  CLIP_DURATION_MAX_SECONDS,
  CLIP_DURATION_MIN_SECONDS,
  CLIP_LANE,
  MomentSelectionSchema,
  TikTokClipConfigSchema,
  type Commentary,
  type MomentSelection,
  type TikTokAgentWorkflowResult,
  type TikTokClipConfig,
  type TikTokIntake,
} from "./types.js";

export interface CreateTikTokAgentWorkflowOptions {
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips the human approval gate and records a synthetic system approval —
   * off by default, matching every other migrated channel. The legacy product
   * is `requires_approval: true` and a draft-status generator "always blocks
   * here for the operator", so a real run genuinely parks at `awaiting_gate`.
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

async function callTool(tools: AgentToolRegistry, name: string, args: unknown, ctx: AgentContext): Promise<unknown> {
  const tool = tools[name];
  if (!tool) throw new WorkflowToolingFailure(`no tool registered as "${name}"`);
  const outcome = await tool.execute(args, { ctx });
  if (outcome.status !== "success") throw new WorkflowToolingFailure(`"${name}" call failed: ${outcome.status}`);
  return outcome.result;
}

/** A gate's verdict. A broken gate is a tooling failure, never a content verdict. */
async function runGate(tools: AgentToolRegistry, name: string, args: unknown, ctx: AgentContext): Promise<GateVerdict> {
  return (await callTool(tools, name, args, ctx)) as GateVerdict;
}

/**
 * `tiktok-agent` — the podcast/commentary clip system, migrated from
 * `karos-tiktok-agent` in the lab repo.
 *
 * ## What was ported, and what deliberately was not
 *
 * The lab skill is a MASTER: run once per client, it stands up an engine
 * clone and emits per-client generator sub-skills that then run on their own
 * cadence. That shape does not survive the move, and should not: this engine
 * has no code-generation step and no scheduler, and a workflow whose output is
 * another workflow is not something the run ledger, the gates or the credit
 * system can reason about. What runs per-client-per-cadence in the lab is the
 * GENERATOR, and the generator's run loop (subskill-spec §2) is exactly one
 * clip:
 *
 *     FIND-source -> PICK-moment -> CUT -> COMPOSE -> QA -> [approve] -> QUEUE -> LOG
 *
 * That loop is this workflow, one run per clip, which is the same unit every
 * other migrated channel agent uses. The per-client settings the master used
 * to bake into a generated skill are read from the client's config instead
 * (`TikTokClipConfigSchema`), so the same code serves every client and the
 * thing that varies is data — the governing principle the lab product states
 * for its own layout.
 *
 * ## Where the judgment is
 *
 * Two model steps, both bounded and schema-out: which moment to clip, and what
 * the client's take on it is. Everything else — the reservation, the cut
 * bounds, the render, every gate — is deterministic, and the model's timestamps
 * are validated against the transcript rather than trusted.
 *
 * ## Dedup
 *
 * `topics.reserve`/`commit`/`release` IS the legacy catalog: the forward
 * pipeline of candidate moments and the hard dedup gate in one. A run that
 * fails releases its reservation, so a moment is never burned by a run that
 * shipped nothing.
 */
export function createTikTokAgentWorkflow(options: CreateTikTokAgentWorkflowOptions) {
  const tools = options.tools;

  return async function tiktokAgentWorkflow(wf: WorkflowContext): Promise<TikTokAgentWorkflowResult> {
    const ctx = toAgentContext(wf);
    const runInput = (wf.input ?? {}) as Record<string, unknown>;

    // ── 00: INTAKE — the client's clip settings, or nothing ──
    const config: TikTokClipConfig = await wf.step.code("00-intake", async () => {
      const raw = await callTool(tools, "client.getConfig", {}, ctx);
      const parsed = TikTokClipConfigSchema.safeParse((raw as { tiktokClips?: unknown }).tiktokClips);
      if (!parsed.success) {
        // Not a tooling error: nobody has told us which shows this client may
        // clip, and that is a decision a person makes, not a default.
        throw new WorkflowBlockedIntake(
          `client has no usable tiktokClips config (needs at least a sourcePool): ${parsed.error.message}`,
        );
      }
      return parsed.data;
    });

    // ── 01: FIND-source — reserve one moment from the catalog ──
    const intake: TikTokIntake = await wf.step.code("01-reserve-source", async (): Promise<TikTokIntake> => {
      const rich = readRichRunInput(runInput);
      // The typed direction wins over the catalog for the same reason an
      // explicit requestedTopic does: a person who wrote a sentence about what
      // they want has more information than the catalog row does.
      const requestedTopic =
        rich.customPrompt ?? (typeof runInput.requestedTopic === "string" ? runInput.requestedTopic.trim() : "");

      // `mediaAssets` is the portal's shape; `sourcePath` is what the video
      // tools have always taken and what a hand-rolled dispatch still sends.
      // Both are accepted, attachment first, so adding the upload surface did
      // not invalidate any existing caller.
      const attached = firstAsset(rich.mediaAssets, "source");
      const sourcePath = attached?.uri ?? (typeof runInput.sourcePath === "string" ? runInput.sourcePath.trim() : "");
      if (!sourcePath) {
        throw new WorkflowBlockedIntake(
          "this run attached no source media — the clip pipeline needs the episode it is cutting from, as a mediaAssets entry with role \"source\" or a sourcePath",
        );
      }

      // An explicit request wins, exactly as it does for every other channel:
      // someone asking for a specific moment has more information than the
      // catalog does.
      if (requestedTopic) {
        return { config, topic: requestedTopic, sourcePath };
      }

      const tool = tools["topics.reserve"];
      if (!tool) throw new WorkflowToolingFailure(`no tool registered as "topics.reserve"`);
      const outcome = await tool.execute(
        { reservationKey: `${wf.runId}__clip`, count: 1, excludeTopics: config.narrowing, lane: CLIP_LANE },
        { ctx },
      );
      if (outcome.status !== "success") {
        // The catalog is empty for this lane. The legacy loop's rule is that a
        // run with no candidate "logs that fact and exits cleanly. It never
        // lowers the bar to ship something."
        throw new WorkflowHeld(`no unused ${CLIP_LANE} candidate to clip (topics.reserve: ${outcome.status})`);
      }
      const result = outcome.result as { reservationKey: string; topics: string[] };
      const topic = result.topics[0];
      if (!topic) throw new WorkflowHeld(`topics.reserve returned no ${CLIP_LANE} candidate`);
      return { config, topic, reservationKey: result.reservationKey, sourcePath };
    });

    /** Hands a reservation back so a failed run does not burn the moment. */
    const releaseReservation = async (): Promise<void> => {
      if (!intake.reservationKey) return;
      const tool = tools["topics.release"];
      if (!tool) return;
      await tool.execute({ reservationKey: intake.reservationKey }, { ctx }).catch(() => undefined);
    };

    // ── 02: transcript ──
    const words: TranscriptWordLike[] = await wf.step.code("02-transcribe", async () => {
      const result = (await callTool(tools, "video.transcribe", { videoPath: intake.sourcePath }, ctx)) as {
        words?: TranscriptWordLike[];
      };
      const spoken = (result.words ?? []).filter((w) => typeof w.text === "string" && w.text.trim().length > 0);
      if (spoken.length === 0) {
        await releaseReservation();
        // Non-verbal source. The legacy loop falls back to a retention heatmap
        // here; this engine has no heatmap tool, so the honest outcome is to
        // stop rather than to guess a moment out of a silent timeline.
        throw new WorkflowHeld("the source has no spoken words to clip, and this deployment has no retention-heatmap fallback");
      }
      return spoken;
    });

    // ── 03: PICK-moment (judgment) ──
    const moment: MomentSelection = await wf.step.code("03-select-moment", async () => {
      const agent = new TikTokMomentAgent({ router: options.router, tools, promptStore: options.promptStore });
      const exec = await wf.step.agent("03a-moment", agent, {
        topic: intake.topic,
        transcript: sentenceBoundedWords(words),
        durationMin: CLIP_DURATION_MIN_SECONDS,
        durationMax: CLIP_DURATION_MAX_SECONDS,
      });
      if (exec.status === "content_fail") {
        await releaseReservation();
        throw new WorkflowHeld("moment selection did not clear its own output validation");
      }
      if (exec.status !== "completed") {
        await releaseReservation();
        throw new WorkflowToolingFailure(`moment selection resolved to "${exec.status}"`);
      }
      return MomentSelectionSchema.parse(exec.finalOutput);
    });

    // ── 04: CUT — snap to real transcript boundaries and validate ──
    const bounds = await wf.step.code("04-cut-bounds", async () => {
      // The model's timestamps are a proposal. This is where they become real:
      // snapped to actual word boundaries in the transcript, then checked
      // against the length rule. A model asked for a timestamp will return one
      // whether or not the transcript supports it.
      const result = boundsFromTranscript(words, moment.startSeconds, moment.endSeconds, {
        minSeconds: CLIP_DURATION_MIN_SECONDS,
        maxSeconds: CLIP_DURATION_MAX_SECONDS,
      });
      if (!result.ok) {
        await releaseReservation();
        throw new WorkflowHeld(`selected moment is not clippable: ${result.reason}`);
      }
      return result;
    });

    await wf.step.code("05-cut-gate", async () => {
      const verdict = await runGate(
        tools,
        "video.cutGate",
        { cuts: [{ start: bounds.startSeconds, end: bounds.endSeconds }], sourcePath: intake.sourcePath },
        ctx,
      );
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`video.cutGate: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") {
        await releaseReservation();
        throw new WorkflowHeld(`cut rejected by video.cutGate: ${verdict.reason}`);
      }
      return verdict;
    });

    // ── 06: COMPOSE — the commentary layer (judgment) ──
    const commentary: Commentary = await wf.step.code("06-commentary", async () => {
      const agent = new TikTokCommentaryAgent({ router: options.router, tools, promptStore: options.promptStore });
      const exec = await wf.step.agent("06a-commentary", agent, {
        topic: intake.topic,
        hookLine: moment.hookLine,
        hookType: moment.hookType,
        clipText: bounds.text,
      });
      if (exec.status === "content_fail") {
        await releaseReservation();
        throw new WorkflowHeld("commentary did not clear its own output validation");
      }
      if (exec.status !== "completed") {
        await releaseReservation();
        throw new WorkflowToolingFailure(`commentary step resolved to "${exec.status}"`);
      }
      return exec.finalOutput as Commentary;
    });

    // ── 07: compliance pass ──
    await wf.step.code("07-compliance", async () => {
      const text = `${commentary.caption}\n\n${commentary.about}`;

      // Source credit first, and checked in code rather than asked of the
      // model that wrote it. The legacy rule is explicit that the on-clip
      // attribution block is not enough — the caption has to name it — and a
      // clip that ships uncredited is the one failure here with a party
      // outside this system.
      if (!commentary.caption.includes(commentary.sourceCredit)) {
        await releaseReservation();
        throw new WorkflowHeld("the caption does not carry the source credit, and an on-clip attribution block alone is not enough");
      }

      for (const [gate, args] of [
        ["gate.lintPost", { text }],
        ["gate.brandCompliance", { text }],
        ["gate.noPlaceholder", { text }],
        ["gate.leakCheck", { text }],
      ] as const) {
        const verdict = await runGate(tools, gate, args, ctx);
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`${gate}: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") {
          await releaseReservation();
          throw new WorkflowHeld(`${gate} failed: ${verdict.reason}`);
        }
      }
    });

    // ── 08: render + blocking QA ──
    const renderedPath: string = await wf.step.code("08-render", async () => {
      const result = (await callTool(
        tools,
        "video.render",
        {
          sourcePath: intake.sourcePath,
          cuts: [{ start: bounds.startSeconds, end: bounds.endSeconds }],
          subtitles: bounds.words,
          caption: commentary.caption,
        },
        ctx,
      )) as { outputPath?: string };
      if (!result.outputPath) throw new WorkflowToolingFailure("video.render returned no outputPath");
      return result.outputPath;
    });

    await wf.step.code("09-qa-gate", async () => {
      // Blocking, all of it. The legacy rule: "Any failure aborts THIS
      // candidate (never ship degraded)."
      for (const gate of ["video.selfEvalGate", "video.brandGate"] as const) {
        const verdict = await runGate(tools, gate, { videoPath: renderedPath }, ctx);
        if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`${gate}: ${verdict.reason}`);
        if (verdict.verdict === "content_fail") {
          await releaseReservation();
          throw new WorkflowHeld(`${gate} failed: ${verdict.reason}`);
        }
      }
    });

    // ── 10: terminal topic guardrail ──
    //
    // The same check the dynamic runner appends to every dynamic agent, run
    // here for the same reason: the client's own forbidden-topic list is a
    // promise about what their account will not talk about, and a clip of
    // someone ELSE saying it is still their account saying it. Runs before the
    // human gate so a reviewer is never shown something that should not exist.
    await wf.step.code("10-topic-guardrail", async () => {
      const forbidden = readForbiddenTopics(await callTool(tools, "client.getConfig", {}, ctx));
      if (forbidden.length === 0) return { status: "skipped" as const };

      const verifier = new DynamicAgent(
        { tools, router: options.router, promptStore: options.promptStore },
        {
          id: GUARDRAIL_STEP_ID,
          description: "Check the finished clip's commentary against the topics this client does not engage with.",
          allowedTools: [],
          outputSchema: buildOutputSchema([...GUARDRAIL_OUTPUT_FIELDS]),
          modelPolicy: { policy: "commodity", model: "claude-haiku-4-5-20251001" },
          maxSteps: 1,
        },
        buildGuardrailSystemPrompt(forbidden),
      );
      const exec = await wf.step.agent(
        GUARDRAIL_STEP_ID,
        verifier,
        buildGuardrailInput(`${commentary.caption}\n\n${commentary.about}\n\n${bounds.text}`),
      );
      if (exec.status !== "completed" || !exec.finalOutput) {
        // A verifier that could not do its job must not block good output, but
        // the failure is recorded so a human can see the check did not run.
        return { status: "error" as const, error: `guardrail verification did not complete (${exec.status})` };
      }
      const verdict = toVerdict(exec.finalOutput as GuardrailOutput, forbidden);
      if (verdict.status === "violation") {
        await releaseReservation();
        throw new GuardrailViolationError(verdict);
      }
      return verdict;
    });

    // ── 11: human approval ──
    const review = options.autoApprove
      ? await wf.step.code("11-clip-review", () => ({ decision: "approve" as const, actor: "system", reason: undefined as string | undefined }))
      : await wf.step.gate("11-clip-review", {
          kind: "batch_review",
          payload: {
            runId: wf.runId,
            topic: intake.topic,
            lane: CLIP_LANE,
            preview: commentary.caption,
            clipPath: renderedPath,
            durationSeconds: bounds.endSeconds - bounds.startSeconds,
          },
          requiredRole: "account_manager",
          timeout: { duration: "24h", onTimeout: "hold" },
        });
    if (review.decision !== "approve") {
      await releaseReservation();
      throw new WorkflowHeld(`clip rejected: ${review.reason ?? "no reason given"}`);
    }

    // ── 12: QUEUE ──
    const deliverableId: string = await wf.step.code("12-persist-deliverable", async () => {
      const result = (await callTool(
        tools,
        "ledger.writeDeliverable",
        {
          runId: wf.runId,
          kind: "tiktok-clip",
          deliverable: {
            topic: intake.topic,
            lane: CLIP_LANE,
            clipPath: renderedPath,
            caption: commentary.caption,
            about: commentary.about,
            sourceCredit: commentary.sourceCredit,
            hookLine: moment.hookLine,
            hookType: moment.hookType,
            startSeconds: bounds.startSeconds,
            endSeconds: bounds.endSeconds,
          },
        },
        ctx,
      )) as { id: string };
      return result.id;
    });

    // ── 13: LOG — burn the moment only now that a clip actually shipped ──
    await wf.step.code("13-commit-and-record", async () => {
      if (intake.reservationKey) {
        await callTool(tools, "topics.commit", { reservationKey: intake.reservationKey }, ctx);
      }
      const memory = tools["memory.appendDecision"];
      if (memory) {
        await memory.execute(
          { decisionId: `${wf.runId}__decision`, summary: `Clipped "${intake.topic}" (${moment.hookType})` },
          { ctx },
        );
      }
    });

    return {
      topic: intake.topic,
      lane: CLIP_LANE,
      moment,
      commentary,
      deliverableId,
      durationSeconds: bounds.endSeconds - bounds.startSeconds,
    };
  };
}
