import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSrt } from "@agent-engine/tool-karos-video";
import { downloadBrandLogo } from "@agent-engine/tool-karos-media";
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
import { WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure, runTopicGuardrail, readOutputHistoryForDedup, dedupeDirective, readClientIntelContext, type WorkflowContext, toAgentContext } from "@agent-engine/workflow";
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
  /**
   * Bounds root for ingesting an attached source video.
   *
   * Optional, unlike instagram's: a run that supplies `sourcePath` needs
   * nothing from here, and that is how every dispatch worked before the portal
   * grew an upload surface. Without it an ATTACHED video is refused with a
   * reason, never read from an unbounded location.
   */
  repoRoot?: string;
  /** Injectable for tests; the brand-logo download uses it. */
  fetchImpl?: typeof fetch;
}

/** The brand furniture the framed clip carries — every field beyond the two grounds optional, skipped when absent. */
interface VideoBrand {
  ground: string;
  fg: string;
  accent?: string;
  handle?: string;
  seriesHeader?: string;
  logoUrl?: string;
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
/**
 * Downloads an attached source video and returns an absolute path to it.
 *
 * Absolute, not repo-relative: the video tools resolve a path against the
 * process cwd, which is the server's, not the agent workspace's. Every other
 * consumer of `media.ingestAssets` renders inside the repo and wants the
 * relative form, so the join happens here rather than in the tool.
 *
 * A failure here is `WorkflowBlockedIntake`, not a tooling error: the run was
 * given footage it cannot read, which is a fact about the input.
 */
async function ingestSourceVideo(
  attached: { uri: string; label?: string | undefined },
  options: CreateTikTokAgentWorkflowOptions,
  tools: AgentToolRegistry,
  runId: string,
  ctx: AgentContext,
): Promise<string> {
  const ingest = tools["media.ingestAssets"];
  if (options.repoRoot === undefined || ingest === undefined) {
    throw new WorkflowBlockedIntake(
      "this run attached a source video, but this deployment cannot ingest one " +
        `(${options.repoRoot === undefined ? "no repoRoot configured" : "media.ingestAssets is not registered"}) — ` +
        "dispatch with a sourcePath the video tools can read instead",
    );
  }

  const outcome = await ingest.execute(
    {
      repoRoot: options.repoRoot,
      runId,
      kind: "video",
      assets: [{ uri: attached.uri, ...(attached.label ? { label: attached.label } : {}), slot: 1 }],
    },
    { ctx },
  );
  if (outcome.status !== "success") {
    throw new WorkflowBlockedIntake(
      `the attached source video could not be ingested (${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""})`,
    );
  }
  const first = (outcome.result as { candidates: Array<{ path: string }> }).candidates[0];
  if (first === undefined) {
    throw new WorkflowBlockedIntake("the attached source video could not be ingested — no file was written");
  }
  return path.resolve(options.repoRoot, first.path);
}

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

    // ── 00b: seed the commentary-clip lane from the client's own guest
    // watchlist, before this run's own reservation ever touches it ──
    //
    // Nothing in this repo ever wrote a `commentary-clip` row: `topics.topUp`
    // has exactly one caller before this one — `topics.reserve`'s own
    // proactive top-up (see reserve.ts's doc comment), which passes an empty
    // array. So this lane sat at zero rows forever and every reservation
    // below breached `LANE_FLOOR`, holding every real run regardless of
    // `sourcePool`/`guestWatchlist`. instagram-agent closed the equivalent
    // gap for its own lane with research-derived seeding (`00-auto-setup`);
    // this agent has no research query to build (a clip's "topic" is a
    // person to look out for in an already-attached recording, not a subject
    // to research), but it does not need one — `guestWatchlist` is, per this
    // agent's own config contract, "the highest-yield discovery signal", a
    // real name the client themselves gave us. Seeding the catalog from it is
    // exactly as honest as instagram seeding from real research titles, and
    // just as clearly not fabricated invention.
    //
    // Never fails the run, exactly like `runAutoSetup`: no watchlist, or a
    // `topics.topUp` tool this deployment never registered, degrades to a
    // note, and step 01 still tries its own reservation (holding honestly, as
    // it always has, if the lane is still empty after this).
    //
    // Unlike instagram's research-derived seeding, this costs no external
    // call and needs no "is this lane already healthy" gate before trying:
    // `guestWatchlist` is config already loaded above, and `topics.topUp` is
    // idempotent per normalized topic (`top-up.ts`), so calling it every run
    // is a no-op write once every name is already in the catalog. A
    // whole-catalog size check would also be the wrong signal here regardless
    // — `topics.topUp`'s `catalogSize` counts rows across every lane a client
    // has (see `top-up.ts`), and this client's catalog is keyed only by
    // `clientSlug`, not by product, so a client who also runs another channel
    // agent under the same slug would look "healthy" by that count while this
    // lane is still at zero.
    await wf.step.code("00b-seed-catalog", async () => {
      const topUp = tools["topics.topUp"];
      if (topUp === undefined) {
        return { seeded: 0, notes: ["topics.topUp is not registered; nothing to seed the commentary-clip lane with"] };
      }
      if (config.guestWatchlist.length === 0) {
        return { seeded: 0, notes: ["client's guestWatchlist is empty; nothing real to seed the commentary-clip lane with"] };
      }

      const seeded = await topUp.execute({ topics: config.guestWatchlist, lane: CLIP_LANE }, { ctx });
      if (seeded.status !== "success") {
        return { seeded: 0, notes: [`seeding the commentary-clip lane failed: ${seeded.status}`] };
      }
      const { added, catalogSize } = seeded.result as { added: number; catalogSize: number };
      return { seeded: added, notes: [`${added} new name(s) from the client's guestWatchlist landed in the ${CLIP_LANE} lane (catalog now ${catalogSize} row(s) across all lanes)`] };
    });

    // ── 01: claim the topic — the source cascade below needs it (a web
    //        harvest searches by it, a generated plate is briefed by it) ──
    const claim = await wf.step.code("01-claim-topic", async (): Promise<{ topic: string; reservationKey?: string }> => {
      const rich = readRichRunInput(runInput);
      // The typed direction wins over the catalog for the same reason an
      // explicit requestedTopic does: a person who wrote a sentence about what
      // they want has more information than the catalog row does.
      const requestedTopic =
        rich.customPrompt ?? (typeof runInput.requestedTopic === "string" ? runInput.requestedTopic.trim() : "");
      if (requestedTopic) return { topic: requestedTopic };

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
      return { topic, reservationKey: result.reservationKey };
    });

    // ── 01b: FIND-source — the tiered cascade. Zero-held BETWEEN tiers: a
    //         tier that cannot serve skips to the next with its reason kept,
    //         and only a fully dry cascade holds, naming every tier's outcome. ──
    const intake: TikTokIntake = await wf.step.code("01b-resolve-source", async (): Promise<TikTokIntake> => {
      const rich = readRichRunInput(runInput);
      const tierOutcomes: string[] = [];

      // Tier 1 — footage attached to THIS run (or a hand-dispatched
      // sourcePath). The attachment is INGESTED rather than passed through:
      // its `uri` is a `gs://` object and `video.transcribe` does a plain
      // readFile on whatever it is handed.
      const attached = firstAsset(rich.mediaAssets, "source");
      if (attached) {
        const sourcePath = await ingestSourceVideo(attached, options, tools, wf.runId, ctx);
        return { config, ...claim, sourcePath, sourceTier: "user-asset" };
      }
      if (typeof runInput.sourcePath === "string" && runInput.sourcePath.trim().length > 0) {
        return { config, ...claim, sourcePath: runInput.sourcePath.trim(), sourceTier: "user-asset" };
      }
      tierOutcomes.push("user-asset: no media attached to this run");

      // Tier 2a — the client's own footage library: sourcePool entries that
      // are URIs (a podcast episode, a keynote recording in their bucket).
      // The highest-context harvest there is — it's literally their footage.
      const ownedUris = config.sourcePool.filter((entry) => /^(gs|https):\/\//i.test(entry));
      if (ownedUris.length > 0) {
        try {
          const sourcePath = await ingestSourceVideo({ uri: ownedUris[0]!, label: "owned footage" }, options, tools, wf.runId, ctx);
          return { config, ...claim, sourcePath, sourceTier: "owned-footage" };
        } catch (error) {
          tierOutcomes.push(`owned-footage: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        tierOutcomes.push("owned-footage: sourcePool holds no gs://https:// footage URIs");
      }

      // Tier 2b — contextual web harvest by topic. `not_available` until a
      // provider is wired; either way the cascade continues.
      const harvest = tools["media.harvestVideo"];
      if (harvest !== undefined && options.repoRoot !== undefined) {
        const outcome = await harvest.execute({ repoRoot: options.repoRoot, runId: wf.runId, query: claim.topic }, { ctx });
        if (outcome.status === "success") {
          const result = outcome.result as { path: string };
          return { config, ...claim, sourcePath: path.resolve(options.repoRoot, result.path), sourceTier: "web-harvest" };
        }
        tierOutcomes.push(`web-harvest: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
      } else {
        tierOutcomes.push("web-harvest: not wired in this deployment");
      }

      // Tier 3 — a generated B-roll plate. The last resort, and the only tier
      // that can answer any topic on demand. A generated source has no
      // transcript, so the spoken-moment steps are skipped downstream.
      const generate = tools["video.generateClip"];
      if (generate !== undefined && options.repoRoot !== undefined) {
        const outcome = await generate.execute({ repoRoot: options.repoRoot, runId: wf.runId, brief: claim.topic }, { ctx });
        if (outcome.status === "success") {
          const result = outcome.result as { path: string };
          return { config, ...claim, sourcePath: path.resolve(options.repoRoot, result.path), sourceTier: "generated" };
        }
        tierOutcomes.push(`generated: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
      } else {
        tierOutcomes.push("generated: not wired in this deployment");
      }

      // Every tier dry. A video post has no typographic fallback — this hold
      // is honest, and its reason names exactly what each tier said.
      if (claim.reservationKey) {
        await tools["topics.release"]?.execute({ reservationKey: claim.reservationKey }, { ctx }).catch(() => undefined);
      }
      throw new WorkflowHeld(`no source footage from any tier — ${tierOutcomes.join("; ")}`);
    });

    /** Hands a reservation back so a failed run does not burn the moment. */
    const releaseReservation = async (): Promise<void> => {
      if (!intake.reservationKey) return;
      const tool = tools["topics.release"];
      if (!tool) return;
      await tool.execute({ reservationKey: intake.reservationKey }, { ctx }).catch(() => undefined);
    };

    /** The cut plan every downstream step works from — real transcript-derived bounds for spoken footage, or the whole plate for a generated one. */
    interface ClipPlan {
      startSeconds: number;
      endSeconds: number;
      words: TranscriptWordLike[];
      text: string;
      /** Whether a cut is needed at all — a generated plate is already the clip. */
      needsCut: boolean;
    }

    let moment: MomentSelection;
    let bounds: ClipPlan;

    if (intake.sourceTier === "generated") {
      // A generated B-roll plate has no speech: there is no transcript to
      // mine, no moment to pick, no cut to make. The commentary layer carries
      // the whole message, over branded footage.
      moment = await wf.step.code("03-select-moment", () => ({
        startSeconds: 0,
        endSeconds: CLIP_DURATION_MIN_SECONDS,
        hookLine: intake.topic,
        hookType: "sharp-one-liner" as const,
        rationale: "generated B-roll plate — the commentary layer carries the message; no transcript exists to pick a moment from",
      }));
      bounds = { startSeconds: 0, endSeconds: 0, words: [], text: "", needsCut: false };
    } else {
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
      moment = await wf.step.code("03-select-moment", async () => {
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

      // ── 04: CUT — snap to real transcript boundaries and validate. This is
      //        the whole cut gate now: the old `video.cutGate` call shelled
      //        into the unvendored Python engine with the wrong argument shape
      //        and had never once succeeded in production — the deterministic
      //        TS bounds check below is the check that actually ran and held. ──
      const cut = await wf.step.code("04-cut-bounds", async () => {
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
      bounds = { startSeconds: cut.startSeconds, endSeconds: cut.endSeconds, words: cut.words, text: cut.text, needsCut: true };
    }

    // The anti-repetition read (the excerpt window step 13 writes back into)
    // and the client intel report, distilled — the same two reads every text
    // channel agent now does before drafting.
    const outputHistory = await readOutputHistoryForDedup(wf, tools, ctx, "tiktok-agent", "read-output-history");
    const recentPostsDirective = dedupeDirective(outputHistory);
    const clientIntelContext = await readClientIntelContext(wf, tools, ctx, "read-intel-context");

    // ── 06: COMPOSE — the commentary layer (judgment) ──
    const commentary: Commentary = await wf.step.code("06-commentary", async () => {
      const agent = new TikTokCommentaryAgent({ router: options.router, tools, promptStore: options.promptStore });
      const exec = await wf.step.agent("06a-commentary", agent, {
        topic: intake.topic,
        hookLine: moment.hookLine,
        hookType: moment.hookType,
        clipText: bounds.text,
        ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
        ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
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

    // ── 07b: the client's brand, for the framed clip. Best-effort, never
    //         blocking — brand furniture must never be able to hold a run,
    //         the same rule the slide pipeline's brand kit follows. ──
    const workDir = path.join(os.tmpdir(), "tiktok-agent", wf.runId);
    const videoBrand = await wf.step.code("07b-load-video-brand", async (): Promise<VideoBrand> => {
      const HEX6 = /^#[0-9a-fA-F]{6}$/;
      const asHex = (v: unknown): string | undefined => (typeof v === "string" && HEX6.test(v.trim()) ? v.trim() : undefined);
      const brandOutcome = await tools["client.getBrand"]?.execute({}, { ctx });
      const brand = (brandOutcome?.status === "success" ? brandOutcome.result : {}) as Record<string, unknown>;
      const colors = (brand["colors"] ?? {}) as Record<string, unknown>;
      const rawHandle = typeof brand["handle"] === "string" ? brand["handle"].trim() : "";
      const logoUrl = typeof brand["logoUrl"] === "string" && /^https:\/\//i.test(brand["logoUrl"]) ? brand["logoUrl"] : undefined;
      return {
        ground: asHex(colors["neutralDark"]) ?? "#17181C",
        fg: asHex(colors["neutralLight"]) ?? "#F4F2EC",
        ...(asHex(brand["accent"]) ?? asHex(colors["primaryAccent"])
          ? { accent: (asHex(brand["accent"]) ?? asHex(colors["primaryAccent"]))! }
          : {}),
        ...(rawHandle.length > 0 && /^@?[A-Za-z0-9._]{1,40}$/.test(rawHandle) ? { handle: `@${rawHandle.replace(/^@+/, "")}` } : {}),
        ...(config.seriesHeader !== undefined ? { seriesHeader: config.seriesHeader } : {}),
        ...(logoUrl !== undefined ? { logoUrl } : {}),
      };
    });

    // ── 08: render — cut, caption, branded frame, all pure ffmpeg. The old
    //        `video.render` call shelled into the unvendored Python engine
    //        with the wrong argument shape; this path depends on nothing but
    //        the ffmpeg already in the server image. ──
    const rendered = await wf.step.code("08-render", async (): Promise<{ outputPath: string; durationSeconds: number | null }> => {
      await fs.mkdir(workDir, { recursive: true });

      // Cut the moment out of the source (a generated plate is already the clip).
      let clipPath = intake.sourcePath;
      if (bounds.needsCut) {
        const cutOutcome = await tools["video.cutClip"]?.execute(
          {
            sourcePath: intake.sourcePath,
            startSeconds: bounds.startSeconds,
            endSeconds: bounds.endSeconds,
            outputPath: path.join(workDir, "clip-cut.mp4"),
          },
          { ctx },
        );
        if (cutOutcome === undefined || cutOutcome.status !== "success") {
          throw new WorkflowToolingFailure(
            `video.cutClip failed: ${cutOutcome === undefined ? "tool not registered" : `${cutOutcome.status}${"reason" in cutOutcome ? ` (${cutOutcome.reason})` : ""}`}`,
          );
        }
        clipPath = (cutOutcome.result as { outputPath: string }).outputPath;
      }

      // Burned captions, from the moment's own word timings — clip-relative.
      let srtPath: string | undefined;
      if (bounds.words.length > 0) {
        const srt = buildSrt(
          bounds.words.map((w) => ({ word: w.text, start: w.start, end: w.end })),
          bounds.startSeconds,
        );
        srtPath = path.join(workDir, "captions.srt");
        await fs.writeFile(srtPath, srt, "utf8");
      }

      // The logo, downloaded fresh for this render (any failure = no logo,
      // never a hold).
      let logoPath: string | undefined;
      if (videoBrand.logoUrl !== undefined) {
        const download = await downloadBrandLogo(options.fetchImpl ?? fetch, videoBrand.logoUrl);
        // SVG can't overlay in ffmpeg without a rasterizer — raster formats only here.
        if (download !== undefined && download.mime !== "image/svg+xml") {
          logoPath = path.join(workDir, download.mime === "image/png" ? "logo.png" : "logo.jpg");
          await fs.writeFile(logoPath, download.bytes);
        }
      }

      const frameOutcome = await tools["video.brandFrame"]?.execute(
        {
          videoPath: clipPath,
          outputPath: path.join(workDir, "clip-framed.mp4"),
          brand: {
            ground: videoBrand.ground,
            fg: videoBrand.fg,
            ...(videoBrand.accent !== undefined ? { accent: videoBrand.accent } : {}),
            ...(videoBrand.handle !== undefined ? { handle: videoBrand.handle } : {}),
            ...(videoBrand.seriesHeader !== undefined ? { seriesHeader: videoBrand.seriesHeader } : {}),
            ...(logoPath !== undefined ? { logoPath } : {}),
          },
          ...(srtPath !== undefined ? { srtPath } : {}),
        },
        { ctx },
      );
      if (frameOutcome === undefined || frameOutcome.status !== "success") {
        throw new WorkflowToolingFailure(
          `video.brandFrame failed: ${frameOutcome === undefined ? "tool not registered" : `${frameOutcome.status}${"reason" in frameOutcome ? ` (${frameOutcome.reason})` : ""}`}`,
        );
      }
      const framed = frameOutcome.result as { outputPath: string; durationSeconds: number | null };
      return { outputPath: framed.outputPath, durationSeconds: framed.durationSeconds ?? null };
    });
    const renderedPath = rendered.outputPath;
    // The framed file's probed length is the truth; the transcript-derived
    // window is the fallback (a generated plate's window is zero-width).
    const durationSeconds = rendered.durationSeconds ?? bounds.endSeconds - bounds.startSeconds;

    await wf.step.code("09-qa-gate", async () => {
      // Blocking. The legacy rule: "Any failure aborts THIS candidate (never
      // ship degraded)." `video.brandGate` was dropped from this list — its
      // real contract takes PNG stills for the Python engine, not an MP4, and
      // the branded frame is now composited deterministically upstream.
      const verdict = await runGate(tools, "video.selfEvalGate", { videoPath: renderedPath }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`video.selfEvalGate: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") {
        await releaseReservation();
        throw new WorkflowHeld(`video.selfEvalGate failed: ${verdict.reason}`);
      }
    });

    // ── 10a: upload BEFORE the human gate, so the reviewer can actually
    //         watch what they're approving (a bare container path is not a
    //         reviewable clip). Registered only when a media store is
    //         configured; absent, the gate carries the local path as before. ──
    const uploaded = await wf.step.code("10a-upload-clip", async () => {
      const uploadTool = tools["video.uploadDeliverable"];
      if (!uploadTool) return null;
      const outcome = await uploadTool.execute(
        { localPath: renderedPath, objectPath: `tiktok/${wf.clientSlug}/${wf.runId}/clip.mp4`, contentType: "video/mp4" },
        { ctx },
      );
      if (outcome.status !== "success") {
        console.error(`10a-upload-clip: upload failed (${outcome.status}) — the gate and deliverable carry the local path only`);
        return null;
      }
      return outcome.result as { gcsUri: string; signedUrl?: string };
    });

    // ── 10: terminal topic guardrail ──
    //
    // The same check the dynamic runner appends to every dynamic agent, run
    // here for the same reason: the client's own forbidden-topic list is a
    // promise about what their account will not talk about, and a clip of
    // someone ELSE saying it is still their account saying it. Runs before the
    // human gate so a reviewer is never shown something that should not exist.
    await runTopicGuardrail(
      wf,
      { tools, promptStore: options.promptStore, router: options.router },
      `${commentary.caption}

${commentary.about}

${bounds.text}`,
    ).catch(async (err) => {
      // A violation is the one thing that stops the run here, and the moment
      // goes back so a rejected clip does not burn it.
      await releaseReservation();
      throw err;
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
            durationSeconds,
            sourceTier: intake.sourceTier,
            // The reviewer's actual preview — a signed URL they can watch.
            ...(uploaded?.signedUrl !== undefined ? { videoUrl: uploaded.signedUrl } : {}),
            ...(uploaded !== null ? { gcsUri: uploaded.gcsUri } : {}),
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
            durationSeconds,
            sourceTier: intake.sourceTier,
            ...(uploaded?.signedUrl !== undefined ? { signedUrl: uploaded.signedUrl } : {}),
            ...(uploaded !== null ? { gcsUri: uploaded.gcsUri } : {}),
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
      // The write half of the anti-repetition loop — best-effort, on delivery only.
      try {
        await tools["ledger.recordOutputExcerpt"]?.execute({ agentId: "tiktok-agent", runId: wf.runId, excerpt: `${commentary.caption}

${commentary.about}` }, { ctx });
      } catch (error) {
        console.error("13-commit-and-record: could not record the output excerpt for future dedup", error);
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
      durationSeconds,
    };
  };
}
