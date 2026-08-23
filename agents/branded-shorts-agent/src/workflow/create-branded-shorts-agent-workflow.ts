import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext, AgentToolRegistry, GateResponse, GateVerdict, ModelRouter, PromptStore } from "@agent-engine/core";
import { WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure, type WorkflowContext, runTopicGuardrail } from "@agent-engine/workflow";
import { BrandProfileSchema, type BrandProfile, type TranscriptWord, type VideoTranscript } from "@agent-engine/tool-karos-video";
import { BrandedShortsGraphicsAgent } from "../agent/branded-shorts-graphics-agent.js";
import { BrandedShortsHighlightsAgent } from "../agent/branded-shorts-highlights-agent.js";
import { deriveCutSegments, totalRetainedDuration } from "./cut-planner.js";
import { assembleJob, resolveRunPaths, type RunPaths } from "./job-builder.js";
import {
  BrandedShortsClientConfigSchema,
  BrandedShortsIntakeSchema,
  validateGraphicsPlanArchetypes,
  type BrandedShortsIntake,
  type BrandedShortsWorkflowResult,
  type GraphicsPlanOutput,
} from "./types.js";

/** PLAYBOOK §4d point 2: "COUNT ASSUMES A 30s+ RUNTIME." */
const CUTAWAY_COUNT_RUNTIME_FLOOR_S = 30;

/** PLAYBOOK §4c/§4d: "FAIL -> auto-remedy -> re-gate," bounded so a stuck plan resolves to `held`, never loops forever. */
const MAX_GRAPHICS_ATTEMPTS = 2;

export interface CreateBrandedShortsAgentWorkflowOptions {
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips the `branded_shorts_delivery_review` human gate and records a
   * synthetic `actor: "system"` approval instead — off by default (SKILL.md
   * `requires_approval: true` / PORTAL-ONEPAGER.md "you approve it or tell
   * us what to change"). Same opt-out convention as every other migrated
   * agent's `autoApprove`; tests only.
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

/** Unwraps a gate tool's outcome into its `GateVerdict` — a broken gate call is a tooling failure, never a content verdict (RFC-01 §5.6/§6). */
async function runGateTool(tools: AgentToolRegistry, toolName: string, args: unknown, ctx: AgentContext): Promise<GateVerdict> {
  const tool = tools[toolName];
  if (!tool) {
    throw new WorkflowToolingFailure(`no tool registered as "${toolName}"`);
  }
  const outcome = await tool.execute(args, { ctx });
  if (outcome.status !== "success") {
    throw new WorkflowToolingFailure(`"${toolName}" call failed: ${outcome.status}`);
  }
  return outcome.result as GateVerdict;
}

function keptWords(words: readonly TranscriptWord[], segments: readonly [number, number][]): TranscriptWord[] {
  return words.filter((w) => w.type === "word" && segments.some(([s, e]) => w.start >= s - 0.02 && w.end <= e + 0.02));
}

/**
 * `createBrandedShortsAgentWorkflow()` (RFC-06 §2's 8-stage pipeline). Every
 * stage but two is deterministic code; the two bounded judgment islands
 * (RFC-06 §1) are `BrandedShortsHighlightsAgent` (step 06) and
 * `BrandedShortsGraphicsAgent` (step 08, looped against its own gates —
 * PLAYBOOK's "FAIL -> auto-remedy -> re-gate").
 *
 * Refuses to run for a client with no locked style on file (step 00) — run
 * `createBrandedShortsStyleExplorationWorkflow` once per client first.
 */
export function createBrandedShortsAgentWorkflow(options: CreateBrandedShortsAgentWorkflowOptions) {
  const tools = options.tools;

  return async function brandedShortsAgentWorkflow(wf: WorkflowContext): Promise<BrandedShortsWorkflowResult> {
    const ctx = toAgentContext(wf);

    // ── 00: brand resolve — refuse to run without a locked style + brand profile on file ──
    const brandResolve = await wf.step.code("00-brand-resolve", async () => {
      const beliefsOutcome = await tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
      const beliefs = beliefsOutcome.status === "success" ? (beliefsOutcome.result as { beliefs: Record<string, unknown> }).beliefs : {};
      if (!beliefs["brandedShortsLockedStyle"]) {
        throw new WorkflowBlockedIntake("no locked brand style for this client — run the Style Exploration onboarding workflow first (SKILL.md step 0)");
      }

      const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
      const rawConfig = configOutcome.status === "success" ? (configOutcome.result as Record<string, unknown>) : {};
      const config = BrandedShortsClientConfigSchema.safeParse(rawConfig).success
        ? BrandedShortsClientConfigSchema.parse(rawConfig)
        : BrandedShortsClientConfigSchema.parse({});
      if (!config.brandedShortsProfilePath || !config.brandedShortsGraphicsLanguage) {
        throw new WorkflowBlockedIntake("client has a locked style but no brandedShortsProfilePath/brandedShortsGraphicsLanguage on file yet");
      }
      if (!config.brandedShortsApprovedArchetypes || config.brandedShortsApprovedArchetypes.length === 0) {
        // P0#1 audit fix: without this, nothing constrains the graphics agent to a closed
        // vocabulary at all, so its absence blocks the run exactly like a missing brand profile.
        throw new WorkflowBlockedIntake("client has a locked style but no brandedShortsApprovedArchetypes on file yet (their make_motion_repertoire.py repertoire, structured)");
      }

      const workDir = config.brandedShortsWorkDir ?? path.join(os.tmpdir(), "branded-shorts", wf.runId);
      return {
        profilePath: config.brandedShortsProfilePath,
        graphicsLanguage: config.brandedShortsGraphicsLanguage,
        approvedArchetypes: config.brandedShortsApprovedArchetypes,
        intakeRaw: config.brandedShortsIntake,
        paths: resolveRunPaths(workDir),
      };
    });

    // ── 01: per-upload intake (RFC-06 §7 / assets/INTAKE-REQUEST.md) ──
    const intake: BrandedShortsIntake = await wf.step.code("01-load-intake", () => {
      const parsed = BrandedShortsIntakeSchema.safeParse(brandResolve.intakeRaw);
      if (!parsed.success) {
        throw new WorkflowBlockedIntake(`no valid per-upload intake for this run (brandedShortsIntake): ${parsed.error.message}`);
      }
      return parsed.data;
    });

    // ── 02: load the client's real brand-profile.json off disk ──
    const profile: BrandProfile = await wf.step.code("02-load-brand-profile", async () => {
      const readOutcome = await tools["video.readJsonFile"]!.execute({ path: brandResolve.profilePath }, { ctx });
      if (readOutcome.status !== "success") {
        throw new WorkflowToolingFailure(`video.readJsonFile(brand-profile.json) failed: ${readOutcome.status}`);
      }
      const parsed = BrandProfileSchema.safeParse((readOutcome.result as { data: unknown }).data);
      if (!parsed.success) {
        throw new WorkflowToolingFailure(`"${brandResolve.profilePath}" is not a valid brand profile: ${parsed.error.message}`);
      }
      return parsed.data;
    });

    // ── 03: transcribe (ElevenLabs Scribe) ──
    const transcript: VideoTranscript = await wf.step.code("03-transcribe", async () => {
      const outcome = await tools["video.transcribe"]!.execute({ videoPath: intake.videoPath }, { ctx });
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`video.transcribe failed: ${outcome.status}`);
      }
      const result = outcome.result as VideoTranscript;
      const writeOutcome = await tools["video.writeJsonFile"]!.execute({ path: brandResolve.paths.transcriptPath, data: result }, { ctx });
      if (writeOutcome.status !== "success") {
        throw new WorkflowToolingFailure(`video.writeJsonFile(transcript.json) failed: ${writeOutcome.status}`);
      }
      return result;
    });

    // ── 04: plan the cut — deterministic, "crop the ends, then only filler" (PLAYBOOK §3) ──
    const cutPlan = await wf.step.code("04-plan-cut", () => {
      const declaredContentCuts = intake.exclusions.filter((e) => e.span !== undefined).map((e) => ({ span: e.span!, reason: e.description }));
      const plan = deriveCutSegments(transcript.words, { declaredContentCuts });
      if (plan.segments.length === 0) {
        throw new WorkflowHeld("the transcript contains no usable spoken words after cropping — nothing to cut");
      }
      return plan;
    });

    // ── 05: cut gate — nothing borderline builds (SKILL.md step 2) ──
    await wf.step.code("05-cut-gate", async () => {
      const writeOutcome = await tools["video.writeJsonFile"]!.execute(
        { path: brandResolve.paths.jobPath, data: { segments: cutPlan.segments, content_cuts: cutPlan.contentCuts } },
        { ctx },
      );
      if (writeOutcome.status !== "success") {
        throw new WorkflowToolingFailure(`video.writeJsonFile(job.json) failed: ${writeOutcome.status}`);
      }
      const verdict = await runGateTool(tools, "video.cutGate", { jobPath: brandResolve.paths.jobPath, transcriptPath: brandResolve.paths.transcriptPath }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`video.cutGate: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`cut list failed video.cutGate: ${verdict.reason}`);
      return verdict;
    });

    // ── 06: highlights — the first bounded judgment island ──
    const kept = keptWords(transcript.words, cutPlan.segments);
    const highlightsAgent = new BrandedShortsHighlightsAgent({ router: options.router, tools, promptStore: options.promptStore });
    const highlightsResult = await wf.step.agent("06-highlights", highlightsAgent, { words: kept, corrections: intake.names, takeaway: intake.takeaway });
    if (highlightsResult.status === "content_fail") {
      throw new WorkflowHeld(`highlights did not clear its own output validation: ${highlightsResult.status}`);
    }
    if (highlightsResult.status !== "completed") {
      throw new WorkflowToolingFailure(`highlights step resolved to "${highlightsResult.status}"`);
    }
    const highlightStarts = highlightsResult.finalOutput!.highlightStarts;

    // ── 07: color grade — zero judgment, "auto" or a locked profile override (PLAYBOOK §4b) ──
    const colorGrade = await wf.step.code("07-color-grade", async () => {
      const outcome = await tools["video.colorGrade"]!.execute({ profile }, { ctx });
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`video.colorGrade failed: ${outcome.status}`);
      }
      return outcome.result as { grade: string; source: "auto" | "profile_locked" };
    });

    // ── 08: graphics & cutaways — the second bounded judgment island, looped against its own gates ──
    // PLAYBOOK §4d point 2: "COUNT ASSUMES A 30s+ RUNTIME" — the real rule is about actual
    // retained runtime, never the requested length category or the agent's own proposed count
    // (P1#5 audit fix: either proxy can mask genuine over/undercounting in either direction).
    const allowCutawayCount = totalRetainedDuration(cutPlan.segments) < CUTAWAY_COUNT_RUNTIME_FLOOR_S;
    const graphicsAgent = new BrandedShortsGraphicsAgent({ router: options.router, tools, promptStore: options.promptStore });
    let priorFailureReason: string | undefined;
    let build: { outputPath: string; durationSeconds: number | null; plan: GraphicsPlanOutput; warnings: string[] } | undefined;
    let graphicsAttemptsUsed = 0;

    for (let attempt = 1; attempt <= MAX_GRAPHICS_ATTEMPTS; attempt++) {
      graphicsAttemptsUsed = attempt;
      const planResult = await wf.step.agent(`08a-plan-graphics-attempt-${attempt}`, graphicsAgent, {
        words: kept,
        graphicsLanguage: brandResolve.graphicsLanguage,
        archetypes: brandResolve.approvedArchetypes,
        takeaway: intake.takeaway,
        targetLength: intake.targetLength,
        ...(priorFailureReason !== undefined ? { priorFailureReason } : {}),
      });
      if (planResult.status === "content_fail") {
        throw new WorkflowHeld(`graphics plan did not clear its own output validation: ${planResult.status}`);
      }
      if (planResult.status !== "completed") {
        throw new WorkflowToolingFailure(`graphics plan step resolved to "${planResult.status}"`);
      }
      const plan = planResult.finalOutput!;

      // P0#1 audit fix: reject an unapproved archetype BEFORE spending a render+gate cycle on
      // a plan already known to violate the closed-vocabulary invariant, and feed the exact
      // violation back into the same retry loop every other gate failure already uses.
      const archetypeViolations = await wf.step.code(`08a2-validate-archetypes-attempt-${attempt}`, () =>
        validateGraphicsPlanArchetypes(plan, brandResolve.approvedArchetypes),
      );
      if (archetypeViolations.length > 0) {
        priorFailureReason = archetypeViolations.join("; ");
        if (attempt === MAX_GRAPHICS_ATTEMPTS) {
          throw new WorkflowHeld(`graphics plan still using unapproved archetypes after ${MAX_GRAPHICS_ATTEMPTS} attempts: ${priorFailureReason}`);
        }
        continue;
      }

      const attemptOutput = await wf.step.code(`08b-render-and-gate-attempt-${attempt}`, async () => {
        const job = assembleJob({
          paths: brandResolve.paths,
          sourceVideoPath: intake.videoPath,
          grade: colorGrade.grade,
          segments: cutPlan.segments,
          contentCuts: cutPlan.contentCuts,
          highlightStarts,
          plan,
        });
        const writeOutcome = await tools["video.writeJsonFile"]!.execute({ path: brandResolve.paths.jobPath, data: job }, { ctx });
        if (writeOutcome.status !== "success") {
          throw new WorkflowToolingFailure(`video.writeJsonFile(job.json) failed: ${writeOutcome.status}`);
        }

        const renderOutcome = await tools["video.render"]!.execute({ profilePath: brandResolve.profilePath, jobPath: brandResolve.paths.jobPath }, { ctx });
        if (renderOutcome.status !== "success") {
          throw new WorkflowToolingFailure(`video.render failed: ${renderOutcome.status}`);
        }
        const rendered = renderOutcome.result as { outputPath: string; durationSeconds: number | null; warnings: string[] };

        const graphicsVerdict = await runGateTool(
          tools,
          "video.graphicsGate",
          { profilePath: brandResolve.profilePath, videoPath: rendered.outputPath, jobPath: brandResolve.paths.jobPath },
          ctx,
        );
        if (graphicsVerdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`video.graphicsGate: ${graphicsVerdict.reason}`);

        const cutawayVerdict = await runGateTool(
          tools,
          "video.cutawayGate",
          { jobPath: brandResolve.paths.jobPath, transcriptPath: brandResolve.paths.transcriptPath, allowCount: allowCutawayCount },
          ctx,
        );
        if (cutawayVerdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`video.cutawayGate: ${cutawayVerdict.reason}`);

        const failures = [
          ...(graphicsVerdict.verdict === "content_fail" ? [`graphicsGate: ${graphicsVerdict.reason}`] : []),
          ...(cutawayVerdict.verdict === "content_fail" ? [`cutawayGate: ${cutawayVerdict.reason}`] : []),
        ];
        return { rendered, plan, failures };
      });

      if (attemptOutput.failures.length === 0) {
        build = {
          outputPath: attemptOutput.rendered.outputPath,
          durationSeconds: attemptOutput.rendered.durationSeconds,
          plan: attemptOutput.plan,
          warnings: attemptOutput.rendered.warnings,
        };
        break;
      }
      priorFailureReason = attemptOutput.failures.join("; ");
      if (attempt === MAX_GRAPHICS_ATTEMPTS) {
        throw new WorkflowHeld(`graphics/cutaway plan still failing its gates after ${MAX_GRAPHICS_ATTEMPTS} attempts: ${priorFailureReason}`);
      }
    }
    if (!build) {
      // Unreachable: the loop above either sets `build` or throws WorkflowHeld on its last attempt.
      throw new WorkflowToolingFailure("graphics/cutaway loop exited without a build result");
    }

    // ── 09: self-eval gate — PLAYBOOK §6, before anyone sees the output ──
    // Carries `build.warnings` (e.g. build_short.py's caption-density check) forward into this
    // gate's own evidence (P0#3 audit fix) rather than letting them vanish once video.render's
    // result is otherwise consumed — advisory, never turned into a content_fail on their own.
    await wf.step.code("09-self-eval-gate", async () => {
      const verdict = await runGateTool(tools, "video.selfEvalGate", { videoPath: build!.outputPath, renderWarnings: build!.warnings }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`video.selfEvalGate: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`finished video failed video.selfEvalGate: ${verdict.reason}`);
      return verdict;
    });

    // ── 10: human delivery gate — SKILL.md requires_approval: true ──
    // -- terminal topic guardrail --
    //
    // The words that survive into the cut, plus the takeaway the client asked
    // for. These are the client's OWN words from their own footage, which is
    // exactly why the check is worth running: a subject they told us not to
    // publish can still be something they said on camera.
    await runTopicGuardrail(
      wf,
      { tools, promptStore: options.promptStore, router: options.router },
      [kept.map((w) => w.text).join(" "), intake.takeaway].filter(Boolean).join("\n\n"),
    );

    const deliveryDecision: GateResponse = options.autoApprove
      ? await wf.step.code("10-delivery-review", () => ({ decision: "approve" as const, actor: "system", at: new Date().toISOString() }))
      : await wf.step.gate("10-delivery-review", {
          kind: "branded_shorts_delivery_review",
          payload: {
            runId: wf.runId,
            outputPath: build.outputPath,
            durationSeconds: build.durationSeconds,
            overlayCount: build.plan.overlays.length,
            cutawayCount: build.plan.cutaways.length,
            renderWarnings: build.warnings,
          },
          requiredRole: "account_manager",
          timeout: { duration: "24h", onTimeout: "hold" },
        });
    if (deliveryDecision.decision !== "approve") {
      throw new WorkflowHeld(`delivery rejected: ${deliveryDecision.reason ?? "no reason given"}`);
    }

    // ── 10a: upload the finished, already-gated MP4 to GCS — only when a media store is
    // actually configured ("video.uploadDeliverable" registered means GCS_MEDIA_BUCKET is set;
    // see createKarosVideoTools). A no-op otherwise, so every deployment/test that hasn't
    // configured GCS keeps behaving exactly as it did before Task 1's GCS media store.
    const uploaded = await wf.step.code("10a-upload-to-gcs", async () => {
      const uploadTool = tools["video.uploadDeliverable"];
      if (!uploadTool) return null;
      const objectPath = `branded-shorts/${wf.clientSlug}/${wf.runId}/final.mp4`;
      const outcome = await uploadTool.execute({ localPath: build!.outputPath, objectPath, contentType: "video/mp4" }, { ctx });
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`video.uploadDeliverable failed: ${outcome.status}`);
      return outcome.result as { gcsUri: string; signedUrl?: string };
    });

    // ── 11-13: persist deliverable, dashboard snapshot, commit + record ──
    const deliverableId = await wf.step.code("11-persist-deliverable", async () => {
      const outcome = await tools["ledger.writeDeliverable"]!.execute(
        {
          runId: wf.runId,
          kind: "branded-shorts-video",
          deliverable: {
            outputPath: build!.outputPath,
            ...(uploaded ? { gcsUri: uploaded.gcsUri, ...(uploaded.signedUrl ? { signedUrl: uploaded.signedUrl } : {}) } : {}),
            durationSeconds: build!.durationSeconds,
            overlays: build!.plan.overlays,
            cutaways: build!.plan.cutaways,
            highlightStarts,
            contentCuts: cutPlan.contentCuts,
            grade: colorGrade,
            renderWarnings: build!.warnings,
          },
        },
        { ctx },
      );
      if (outcome.status !== "success") throw new WorkflowToolingFailure(`ledger.writeDeliverable failed: ${outcome.status}`);
      return (outcome.result as { id: string }).id;
    });

    await wf.step.code("12-persist-manifest", async () => {
      await tools["ledger.dashboardSnapshot"]!.execute(
        { runId: wf.runId, snapshot: { outputPath: build!.outputPath, durationSeconds: build!.durationSeconds, deliverableId } },
        { ctx },
      );
    });

    await wf.step.code("13-commit-and-record", async () => {
      await tools["memory.appendDecision"]!.execute(
        {
          decisionId: `${wf.runId}__decision`,
          summary: `Branded short built: ${build!.plan.overlays.length} graphic(s), ${build!.plan.cutaways.length} cutaway(s), ${cutPlan.contentCuts.length} declared content cut(s).`,
        },
        { ctx },
      );
    });

    return {
      outputPath: build.outputPath,
      durationSeconds: build.durationSeconds,
      deliverableId,
      overlayCount: build.plan.overlays.length,
      cutawayCount: build.plan.cutaways.length,
      contentCutsDeclared: cutPlan.contentCuts.length,
      graphicsAttempts: graphicsAttemptsUsed,
      renderWarnings: build.warnings,
    };
  };
}

/** Re-exported for tests that need to point at the same run-paths convention the workflow uses. */
export type { RunPaths };
