import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext, AgentToolRegistry, GateResponse, GateVerdict, ModelRouter, PromptStore } from "@agent-engine/core";
import { WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure, type WorkflowContext, runTopicGuardrail, readRunDirection, runDirectionField, readContextDoc, enforceContextDocPolicy, toAgentContext, finalizeDeliverable } from "@agent-engine/workflow";
import { BrandProfileSchema, type BrandProfile, type TranscriptWord, type VideoTranscript } from "@agent-engine/tool-karos-video";
import { BrandedShortsGraphicsAgent } from "../agent/branded-shorts-graphics-agent.js";
import { BrandedShortsHighlightsAgent } from "../agent/branded-shorts-highlights-agent.js";
import { deriveCutSegments, totalRetainedDuration } from "./cut-planner.js";
import { assembleJob, resolveRunPaths, type RunPaths } from "./job-builder.js";
import {
  AssetLibraryIndexSchema,
  BrandedShortsClientConfigSchema,
  BrandedShortsIntakeSchema,
  validateGraphicsPlan,
  type AssetLibraryStill,
  type BrandedShortsIntake,
  type BrandedShortsWorkflowResult,
  type CutawayPlan,
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


/** Unwraps a gate tool's outcome into its `GateVerdict` — a broken gate call is a tooling failure, never a content verdict (RFC-01 §5.6/§6). */
async function runGateTool(tools: AgentToolRegistry, toolName: string, args: unknown, ctx: AgentContext): Promise<GateVerdict> {
  const tool = tools[toolName];
  if (!tool) {
    throw new WorkflowToolingFailure(`no tool registered as "${toolName}"`);
  }
  const outcome = await tool.execute(args, { ctx });
  if (outcome.status !== "success") {
    // `reason` carries the actual diagnosis — the Python traceback tail, the
    // missing engine script, the ffprobe stderr. AU8 moved these from a
    // `verdict` field inside a success payload to a real `tooling_error`
    // outcome, so this is now the path a broken gate takes; dropping `reason`
    // here would trade the old wrong-status bug for a no-detail one.
    throw new WorkflowToolingFailure(`"${toolName}" call failed: ${outcome.status}: ${outcome.reason}`);
  }
  return outcome.result as GateVerdict;
}

interface GeneratePlatesParams {
  plan: GraphicsPlanOutput;
  workDir: string;
  runId: string;
  palette: string[];
  accent: string;
  styleNotes: string;
}

/**
 * Cutaway plates through karos-media's `image.generate` (SKILL.md step 5b:
 * "Generate the PLATE with AI in the client's palette environment"). One
 * billed call per plate, briefed by the agent's own `prompt` (written against
 * docs/CUTAWAY-IMAGE-PROMPTS.md) and art-directed by the locked style. Returns
 * cutaway index → absolute PNG path; `image.generate` names each file
 * `n<need>-gen<attempt>`, which is how a candidate is tied back to its
 * cutaway. A plate the model would not produce holds the run with the model's
 * reason — a missing visual is never quietly replaced.
 */
async function generatePlates(tools: AgentToolRegistry, ctx: AgentContext, params: GeneratePlatesParams): Promise<Record<number, string>> {
  const plates = params.plan.cutaways.map((c, i) => ({ c, i })).filter((p): p is { c: CutawayPlan; i: number } => p.c.kind === "plate");
  if (plates.length === 0) return {};
  const generate = tools["image.generate"];
  if (!generate) {
    throw new WorkflowToolingFailure("the plan carries plate cutaways but image.generate is not registered — validateGraphicsPlan should have refused this plan");
  }
  const outcome = await generate.execute(
    {
      repoRoot: params.workDir,
      runId: params.runId,
      needs: plates.map(({ c, i }) => ({ n: i + 1, prompt: c.prompt ?? c.phrase })),
      aspectRatio: "9:16",
      art: {
        aesthetic: "cinematic editorial photography: one clear subject, premium, believable, no text or lettering of any kind",
        palette: params.palette,
        accentColor: params.accent,
        ...(params.styleNotes.length > 0 ? { notes: params.styleNotes } : {}),
      },
    },
    { ctx },
  );
  if (outcome.status !== "success") {
    throw new WorkflowToolingFailure(`image.generate failed for the cutaway plates: ${outcome.status}: ${(outcome as { reason?: string }).reason ?? ""}`);
  }
  const result = outcome.result as { candidates: Array<{ path: string }>; unmet: Array<{ n: number; reason: string }> };
  if (result.unmet.length > 0) {
    throw new WorkflowHeld(
      `cutaway plate generation could not produce ${result.unmet.map((u) => `cutaway[${u.n - 1}] (${u.reason})`).join("; ")} — a missing visual is never substituted (THE RELEVANCE LAW)`,
    );
  }
  const plateFiles: Record<number, string> = {};
  for (const candidate of result.candidates) {
    const m = /^n(\d+)-gen\d+\./.exec(path.posix.basename(candidate.path));
    if (!m) continue;
    const index = Number(m[1]) - 1;
    if (plateFiles[index] === undefined) plateFiles[index] = path.resolve(params.workDir, candidate.path);
  }
  const missing = plates.filter(({ i }) => plateFiles[i] === undefined);
  if (missing.length > 0) {
    throw new WorkflowToolingFailure(`image.generate returned no file for cutaway(s) ${missing.map(({ i }) => i).join(", ")} although none was reported unmet`);
  }
  return plateFiles;
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

    // The run-scoped instruction someone typed in the portal, resolved once.
    //
    // It reaches the two editorial steps — which moments to highlight, and what
    // the graphics say. It does NOT reach the cut planner: those bounds come
    // from the transcript deterministically, which is what makes a cut
    // reviewable, and `mediaAssets` is unread here because this agent takes its
    // footage from the per-upload `brandedShortsIntake`, not from a run
    // attachment.
    const runDirection = readRunDirection(wf.input);

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
      if ((!config.brandedShortsProfilePath && !config.brandedShortsAssetBundle) || !config.brandedShortsGraphicsLanguage) {
        throw new WorkflowBlockedIntake(
          "client has a locked style but no brandedShortsProfilePath (or brandedShortsAssetBundle) / brandedShortsGraphicsLanguage on file yet",
        );
      }
      if (!config.brandedShortsApprovedArchetypes || config.brandedShortsApprovedArchetypes.length === 0) {
        // P0#1 audit fix: without this, nothing constrains the graphics agent to a closed
        // vocabulary at all, so its absence blocks the run exactly like a missing brand profile.
        throw new WorkflowBlockedIntake("client has a locked style but no brandedShortsApprovedArchetypes on file yet (their make_motion_repertoire.py repertoire, structured)");
      }

      const workDir = config.brandedShortsWorkDir ?? path.join(os.tmpdir(), "branded-shorts", wf.runId);
      // The locked style's own words become the plate generator's art
      // direction (CUTAWAY-IMAGE-PROMPTS production rule 5: "the client's
      // locked style governs palette, ground and light language in every
      // prompt") — read here, where the style is already in hand.
      const locked = beliefs["brandedShortsLockedStyle"] as Record<string, unknown>;
      const lockedStyleNotes = ["description", "paletteUsage", "graphicsDirection"]
        .map((k) => locked[k])
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .join(" ");
      return {
        profilePath: config.brandedShortsProfilePath,
        assetBundle: config.brandedShortsAssetBundle,
        lockedStyleNotes,
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

    // ── 01b: materialise the inputs — real files for a Python engine ──
    //
    // Every `video.*` tool hands the engine paths (RFC-06 §3/§4: "adapter,
    // never infra"), and on a Cloud Run instance nothing is on local disk when
    // a run starts: the client's upload is an object in the media bucket, and
    // their brand assets (profile, fonts, marks, the optional stills library)
    // live outside the image because they are per client. This turns a gs://
    // video and the client's asset bundle into local paths; a laptop or a
    // test that already has local paths passes straight through.
    const inputs = await wf.step.code("01b-materialize-inputs", async () => {
      const fallbackProfile = brandResolve.profilePath;
      const tool = tools["video.materializeInputs"];
      if (!tool) {
        if (!fallbackProfile) throw new WorkflowToolingFailure("brandedShortsAssetBundle is set but no video.materializeInputs tool is registered to unpack it");
        return { videoPath: intake.videoPath, profilePath: fallbackProfile };
      }
      const outcome = await tool.execute(
        { workDir: brandResolve.paths.workDir, videoPath: intake.videoPath, ...(brandResolve.assetBundle ? { assetBundle: brandResolve.assetBundle } : {}) },
        { ctx },
      );
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`video.materializeInputs failed: ${outcome.status}: ${(outcome as { reason?: string }).reason ?? ""}`);
      }
      const result = outcome.result as { videoPath: string; profilePath?: string };
      const profilePath = result.profilePath ?? fallbackProfile;
      if (!profilePath) throw new WorkflowToolingFailure("no brand profile for this run: the asset bundle holds none and brandedShortsProfilePath is unset");
      return { videoPath: result.videoPath, profilePath };
    });

    // ── 01c: assets check — SCRUM-295 (AU10). `brand_assets_check.py`
    // physically opens every font/image the brand profile references, which
    // is the check `os.path.exists()` cannot do (the karoslabs 0-byte
    // `Spectral-SemiBold.ttf` incident — RFC-06 §4). `video.assetsCheck`
    // shipped with the rest of `karos-video` (RFC-06 §6) but, before this
    // ticket, had no call site anywhere in the codebase: a corrupt or
    // missing asset would not surface until `video.render` failed deep into
    // the pipeline, or — worse — rendered a broken video that passed every
    // downstream gate. Runs on every call, not only a client's first: assets
    // can be replaced between runs, which is exactly why the tool's own doc
    // comment calls for re-checking "before any run for a client whose
    // assets may have moved." Sits right after materialisation — the profile
    // it opens may have just been unpacked — and still before any transcribe
    // or render cycle is spent on assets already known to be broken.
    await wf.step.code("01c-assets-check", async () => {
      const verdict = await runGateTool(tools, "video.assetsCheck", { profilePath: inputs.profilePath }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`video.assetsCheck: ${verdict.reason}`);
      if (verdict.verdict === "content_fail") throw new WorkflowHeld(`client brand assets failed video.assetsCheck: ${verdict.reason}`);
      return verdict;
    });

    // ── 02: load the client's real brand-profile.json off disk ──
    const profile: BrandProfile = await wf.step.code("02-load-brand-profile", async () => {
      const readOutcome = await tools["video.readJsonFile"]!.execute({ path: inputs.profilePath }, { ctx });
      if (readOutcome.status !== "success") {
        throw new WorkflowToolingFailure(`video.readJsonFile(brand-profile.json) failed: ${readOutcome.status}`);
      }
      const parsed = BrandProfileSchema.safeParse((readOutcome.result as { data: unknown }).data);
      if (!parsed.success) {
        throw new WorkflowToolingFailure(`"${inputs.profilePath}" is not a valid brand profile: ${parsed.error.message}`);
      }
      return parsed.data;
    });

    // ── 02a: the client's asset library — real stills for burst cutaways ──
    //
    // PLAYBOOK §4d: a burst is 3-6 REAL photos (logos, people, products) from
    // the client's own cleared library, never generated. The library is
    // `library/index.json` beside the brand profile, each entry a file plus
    // the subjects it shows; the graphics agent picks stills by subject and
    // `validateGraphicsPlan` refuses any it did not list. No library means no
    // bursts for this client — stated to the agent, never padded with stock.
    const library: AssetLibraryStill[] = await wf.step.code("02a-load-asset-library", async () => {
      const indexPath = path.join(path.dirname(inputs.profilePath), "library", "index.json");
      const outcome = await tools["video.readJsonFile"]!.execute({ path: indexPath }, { ctx });
      if (outcome.status !== "success") return [];
      const parsed = AssetLibraryIndexSchema.safeParse((outcome.result as { data: unknown }).data);
      if (!parsed.success) throw new WorkflowToolingFailure(`"${indexPath}" is not a valid asset library index: ${parsed.error.message}`);
      return parsed.data.stills;
    });

    // ── 02b: the client's projected branding-guidelines context doc (C1/SCRUM-209, T-A9) ──
    //
    // branded-shorts-agent is one of two agents SCRUM-241 calls "the agents
    // that read nothing" — before this step, nothing here ever called
    // `client.getContextDoc`, or `client.getBrand` either: this workflow's
    // only brand input is the video-specific `brand-profile.json`
    // (colors/fonts for the render engine itself, read at step 02 above),
    // never the karos-client BrandKit's richer, portal-authored context.
    // `branding-guidelines` (not `brand-voice`) is the deliberate choice,
    // same reasoning as instagram-agent's own 02e: this agent's one bounded
    // judgment call that touches VISUAL design is the graphics/cutaway plan
    // at step 08a, and branding-guidelines is a client's stated visual-
    // identity rules (logo/lockup, imagery, palette usage) rather than
    // tone-of-voice, which this pipeline has no prose-drafting step to apply
    // to anyway (the highlights step at 06 selects moments from the client's
    // OWN spoken words, it doesn't write new copy).
    //
    // Best-effort and non-blocking: a client with no projected
    // branding-guidelines doc yet plans graphics exactly as this workflow
    // did before this step existed.
    const brandingGuidelines = await readContextDoc(wf, tools, ctx, "branding-guidelines", "02b-load-branding-guidelines");

    // ── 02c: SCRUM-242 (T-A10) — stop failing open. branded-shorts-agent's row in
    // the one shared policy table (CONTEXT_DOC_POLICY) is DEGRADED, not BLOCK,
    // same reasoning as instagram-agent's own 02f: channel copy a human reviews
    // before it ships. The marker is threaded into the deliverable AND the
    // workflow's own return value below, not left to sit only in this step's
    // checkpoint — see those sites' own comments.
    const contextGrounding = await wf.step.code("02c-enforce-context-doc-policy", () =>
      enforceContextDocPolicy({ agentId: "branded-shorts-agent", docs: { "branding-guidelines": brandingGuidelines } }),
    );

    // ── 03: transcribe (ElevenLabs Scribe) ──
    const transcript: VideoTranscript = await wf.step.code("03-transcribe", async () => {
      const outcome = await tools["video.transcribe"]!.execute({ videoPath: inputs.videoPath }, { ctx });
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
    const highlightsResult = await wf.step.agent("06-highlights", highlightsAgent, { ...runDirectionField(runDirection), words: kept, corrections: intake.names, takeaway: intake.takeaway });
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

    // Every job this run writes shares these; the plan (and, at the end, the
    // generated plate files) is what varies between them.
    const libraryRoot = path.dirname(inputs.profilePath);
    const jobBase = {
      paths: brandResolve.paths,
      sourceVideoPath: inputs.videoPath,
      grade: colorGrade.grade,
      segments: cutPlan.segments,
      contentCuts: cutPlan.contentCuts,
      highlightStarts,
      libraryRoot,
      ...(intake.endcardOverride !== undefined ? { endcardOverride: intake.endcardOverride } : {}),
    };
    const writeJob = async (job: unknown): Promise<void> => {
      const writeOutcome = await tools["video.writeJsonFile"]!.execute({ path: brandResolve.paths.jobPath, data: job }, { ctx });
      if (writeOutcome.status !== "success") {
        throw new WorkflowToolingFailure(`video.writeJsonFile(job.json) failed: ${writeOutcome.status}`);
      }
    };

    // ── 07b: base render — the graded, concatenated footage timeline, ONCE ──
    //
    // `graphic_qa.py` judges every overlay's visibility over the frame it will
    // really sit on. That frame has to come from base.mp4 (footage only), not
    // from a finished composite that already carries the overlay being judged
    // — which is what this workflow used to hand it. The cut and grade are
    // fixed before any plan exists, so base renders once, outside the plan
    // loop; each attempt then costs overlay frames + gates, and the full
    // composite is paid for exactly once, after a plan has passed.
    const base = await wf.step.code("07b-render-base", async () => {
      await writeJob(assembleJob({ ...jobBase, plan: { overlays: [], cutaways: [] } }));
      const outcome = await tools["video.render"]!.execute({ profilePath: inputs.profilePath, jobPath: brandResolve.paths.jobPath, stage: "base" }, { ctx });
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`video.render (base) failed: ${outcome.status}: ${(outcome as { reason?: string }).reason ?? ""}`);
      }
      return outcome.result as { outputPath: string };
    });

    // ── 08: graphics & cutaways — the second bounded judgment island, looped against its own gates ──
    // PLAYBOOK §4d point 2: "COUNT ASSUMES A 30s+ RUNTIME" — the real rule is about actual
    // retained runtime, never the requested length category or the agent's own proposed count
    // (P1#5 audit fix: either proxy can mask genuine over/undercounting in either direction).
    const allowCutawayCount = totalRetainedDuration(cutPlan.segments) < CUTAWAY_COUNT_RUNTIME_FLOOR_S;
    // A plate is a billed generation through karos-media's `image.generate`;
    // on a deployment without it the agent is told so and plans none.
    const plateGenerationAvailable = tools["image.generate"] !== undefined;
    const graphicsAgent = new BrandedShortsGraphicsAgent({ router: options.router, tools, promptStore: options.promptStore });
    let priorFailureReason: string | undefined;
    let build: { outputPath: string; durationSeconds: number | null; plan: GraphicsPlanOutput; warnings: string[] } | undefined;
    let graphicsAttemptsUsed = 0;

    for (let attempt = 1; attempt <= MAX_GRAPHICS_ATTEMPTS; attempt++) {
      graphicsAttemptsUsed = attempt;
      const planResult = await wf.step.agent(`08a-plan-graphics-attempt-${attempt}`, graphicsAgent, {
        ...runDirectionField(runDirection),
        words: kept,
        graphicsLanguage: brandResolve.graphicsLanguage,
        archetypes: brandResolve.approvedArchetypes,
        // The client's real stills, by file and subject — the only material a
        // burst may be built from (PLAYBOOK §4d). Empty means "no bursts".
        assetLibrary: library.map((s) => ({ file: s.file, subjects: s.subjects })),
        plateGenerationAvailable,
        takeaway: intake.takeaway,
        targetLength: intake.targetLength,
        // The client's projected branding-guidelines context doc (T-A9),
        // best-effort. See 02b's own comment.
        ...(brandingGuidelines !== undefined ? { brandingGuidelines } : {}),
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
      // violation back into the same retry loop every other gate failure already uses. The
      // same pass now covers bursts (stills must come from the library) and plates (only on a
      // deployment that can generate one).
      const planViolations = await wf.step.code(`08a2-validate-archetypes-attempt-${attempt}`, () =>
        validateGraphicsPlan(plan, { approvedArchetypes: brandResolve.approvedArchetypes, libraryFiles: library.map((s) => s.file), plateGenerationAvailable }),
      );
      if (planViolations.length > 0) {
        priorFailureReason = planViolations.join("; ");
        if (attempt === MAX_GRAPHICS_ATTEMPTS) {
          throw new WorkflowHeld(`graphics plan still using unapproved archetypes after ${MAX_GRAPHICS_ATTEMPTS} attempts: ${priorFailureReason}`);
        }
        continue;
      }

      // Render the overlay frames, then gate them over the REAL footage (base.mp4)
      // and gate the cutaway schedule — nothing here composites, so a failing
      // plan costs frames and two gate runs, never a full encode.
      const attemptOutput = await wf.step.code(`08b-render-and-gate-attempt-${attempt}`, async () => {
        await writeJob(assembleJob({ ...jobBase, plan }));

        const overlaysVerdict = await runGateTool(tools, "video.renderOverlays", { profilePath: inputs.profilePath, jobPath: brandResolve.paths.jobPath }, ctx);
        if (overlaysVerdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`video.renderOverlays: ${overlaysVerdict.reason}`);
        if (overlaysVerdict.verdict === "content_fail") {
          // Nothing to gate: an overlay with no frames would only fail the
          // graphics gate with a less specific reason than this one.
          return { plan, failures: [`renderOverlays: ${overlaysVerdict.reason}`] };
        }

        const graphicsVerdict = await runGateTool(
          tools,
          "video.graphicsGate",
          { profilePath: inputs.profilePath, videoPath: base.outputPath, jobPath: brandResolve.paths.jobPath },
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
        return { plan, failures };
      });

      if (attemptOutput.failures.length > 0) {
        priorFailureReason = attemptOutput.failures.join("; ");
        if (attempt === MAX_GRAPHICS_ATTEMPTS) {
          throw new WorkflowHeld(`graphics/cutaway plan still failing its gates after ${MAX_GRAPHICS_ATTEMPTS} attempts: ${priorFailureReason}`);
        }
        continue;
      }

      // ── 08c: the plan passed — generate its plates, then the one full composite ──
      // Plates are generated only now, after the gates: each is a billed call,
      // and a plan that was going to fail its schedule should not have bought
      // images first. A plate the generator cannot produce holds the run with
      // the model's own reason; nothing is substituted.
      build = await wf.step.code(`08c-plates-and-render-attempt-${attempt}`, async () => {
        const plateFiles = await generatePlates(tools, ctx, {
          plan,
          workDir: brandResolve.paths.workDir,
          runId: wf.runId,
          palette: [profile.color.background, profile.color.foreground, profile.color.accent],
          accent: profile.color.accent,
          styleNotes: brandResolve.lockedStyleNotes,
        });
        await writeJob(assembleJob({ ...jobBase, plan, plateFiles }));
        const renderOutcome = await tools["video.render"]!.execute({ profilePath: inputs.profilePath, jobPath: brandResolve.paths.jobPath }, { ctx });
        if (renderOutcome.status !== "success") {
          throw new WorkflowToolingFailure(`video.render failed: ${renderOutcome.status}: ${(renderOutcome as { reason?: string }).reason ?? ""}`);
        }
        const rendered = renderOutcome.result as { outputPath: string; durationSeconds: number | null; warnings: string[] };
        return { outputPath: rendered.outputPath, durationSeconds: rendered.durationSeconds, plan, warnings: rendered.warnings };
      });
      break;
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
      const verdict = await runGateTool(
        tools,
        "video.selfEvalGate",
        { videoPath: build!.outputPath, renderWarnings: build!.warnings, profilePath: inputs.profilePath, jobPath: brandResolve.paths.jobPath },
        ctx,
      );
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
    const deliverableId = await finalizeDeliverable(wf, tools, ctx, {
      persistDeliverableStepId: "11-persist-deliverable",
      persistManifestStepId: "12-persist-manifest",
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
        // SCRUM-242 (T-A10): the DEGRADED marker, on the actual persisted
        // deliverable a reviewer looks at — see 02c's own comment.
        ...(contextGrounding.decision === "degraded" ? { contextGrounding: contextGrounding.marker } : {}),
      },
      snapshot: (deliverableId) => ({
        outputPath: build!.outputPath,
        durationSeconds: build!.durationSeconds,
        deliverableId,
        ...(contextGrounding.decision === "degraded" ? { contextGrounding: contextGrounding.marker } : {}),
      }),
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
      // SCRUM-242 (T-A10): same DEGRADED marker, on the workflow's own typed
      // return value — see 02c's own comment.
      ...(contextGrounding.decision === "degraded" ? { contextGrounding: contextGrounding.marker } : {}),
    };
  };
}

/** Re-exported for tests that need to point at the same run-paths convention the workflow uses. */
export type { RunPaths };
