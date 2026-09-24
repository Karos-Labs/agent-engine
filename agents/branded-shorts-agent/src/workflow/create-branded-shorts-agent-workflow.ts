import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext, AgentToolRegistry, GateResponse, GateVerdict, ModelRouter, PromptStore } from "@agent-engine/core";
import { firstAsset, UNIT_PRICING } from "@agent-engine/core";
import { WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure, type WorkflowContext, runTopicGuardrail, readRunDirection, runDirectionField, readContextDoc, enforceContextDocPolicy, toAgentContext, finalizeDeliverable, readLearningContext, stageForRun, touchesNeverTopic, craftRulesForPrompt, preferencesForDrafting, resolveGoalLine, writeRunState, type LearningContextLike, type ResolvedGoalLine,
// D08's editing agent catching up with clipping and content design
// (2026-09-18): the reviewer's revise loop it never had, and the owner's
// always-deliver rule as the fleet's own primitives rather than a local
// re-invention.
MAX_REVISION_ROUNDS, runReviewCycle, revisionDirective, persistReviewFeedbackToMemory, readPastFeedback, buildClientVoiceContext, type RevisionNote, type ContentRepair } from "@agent-engine/workflow";
import { BrandProfileSchema, type BrandProfile, type TranscriptWord, type VideoTranscript } from "@agent-engine/tool-karos-video";
import { BrandedShortsGraphicsAgent } from "../agent/branded-shorts-graphics-agent.js";
import { BrandedShortsCaptionAgent } from "../agent/branded-shorts-caption-agent.js";
import { BrandedShortsHighlightsAgent } from "../agent/branded-shorts-highlights-agent.js";
import { deriveCutSegments, totalRetainedDuration } from "./cut-planner.js";
import { assembleJob, resolveRunPaths, type RunPaths } from "./job-builder.js";
import { deriveBrandSetup, type ResolveFontsOptions } from "./derive-brand-setup.js";
import { applyHighlightRhythm } from "./highlight-rhythm.js";
import {
  AssetLibraryIndexSchema,
  BrandedShortsClientConfigSchema,
  BrandedShortsIntakeSchema,
  dropViolatingItems,
  planPlateBudget,
  validateGraphicsPlan,
  MAX_RUN_COST_USD,
  PLATE_IMAGE_SKU,
  TARGET_RUN_SPEND_USD,
  type AssetLibraryStill,
  type BrandedShortsCopy,
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
  /**
   * The fetch a derived brand profile downloads fonts and the logo with (see
   * `derive-brand-setup.ts`). Defaults to the global `fetch`; tests inject a
   * fake so no run ever reaches Google Fonts or a real logo URL.
   */
  fetchImpl?: typeof fetch;
  /** Test seam for `resolveBrandFonts`' system-face fallback. */
  fontOptions?: ResolveFontsOptions;
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
async function generatePlates(tools: AgentToolRegistry, ctx: AgentContext, params: GeneratePlatesParams): Promise<{ plateFiles: Record<number, string>; unmet: string[] }> {
  const plates = params.plan.cutaways.map((c, i) => ({ c, i })).filter((p): p is { c: CutawayPlan; i: number } => p.c.kind === "plate");
  if (plates.length === 0) return { plateFiles: {}, unmet: [] };
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
  // THE RELEVANCE LAW stands: a missing visual is never SUBSTITUTED - nothing
  // else is put on screen in its place, because a plate that does not match
  // the phrase under it is worse than no plate. What changed on 2026-09-18 is
  // that the cutaway is DROPPED rather than the run ended: the short keeps its
  // footage, its captions, its overlays and every plate that did generate, and
  // the reviewer is told which visual is missing. Substitution and omission
  // are different things, and only one of them was ever forbidden.
  const unmet = result.unmet.map((u) => `cutaway[${u.n - 1}] (${u.reason})`);
  const plateFiles: Record<number, string> = {};
  for (const candidate of result.candidates) {
    const m = /^n(\d+)-gen\d+\./.exec(path.posix.basename(candidate.path));
    if (!m) continue;
    const index = Number(m[1]) - 1;
    if (plateFiles[index] === undefined) plateFiles[index] = path.resolve(params.workDir, candidate.path);
  }
  const missing = plates.filter(({ i }) => plateFiles[i] === undefined && !result.unmet.some((u) => u.n - 1 === i));
  if (missing.length > 0) {
    throw new WorkflowToolingFailure(`image.generate returned no file for cutaway(s) ${missing.map(({ i }) => i).join(", ")} although none was reported unmet`);
  }
  return { plateFiles, unmet };
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
    // reviewable.
    //
    // `mediaAssets` (2026-09-06): a source video attached to THIS run is the
    // footage, whatever the standing `brandedShortsIntake` says — that is how a
    // client hands over a recording from the portal without an operator editing
    // client config first. `mediaSource === "client"` additionally switches
    // off the one generative tier this agent has (image.generate cutaway
    // plates), so the short is built from the client's footage and their own
    // stills library and nothing else.
    const runDirection = readRunDirection(wf.input);
    const attachedVideo = firstAsset(runDirection.mediaAssets, "source");
    const clientMediaOnly = runDirection.mediaSource === "client";

    // ── 01b: the learning context (C7 §2) ──
    //
    // This is D08's EDITING agent, and it is the one of the three that chooses
    // nothing: the client hands over a finished video and says what it should
    // communicate (D19 — on demand, outside sequencing). So it reads the loop
    // for the two things that still apply — the craft rules the captions and
    // graphics are held to, and the client's standing preferences — and writes
    // its asset back so the subject table and the reporting see it.
    //
    // NO STRATEGY MAP, deliberately, and written down here rather than left as
    // an omission (`docs/AGENT-ARCHITECTURE.md` §6): a map is a pool of
    // subjects to pick from, and this agent has no subject to pick. The
    // subject is whatever the client filmed.
    //
    // The platform key is `tiktok`, shared with clipping and content design,
    // because the client has one TikTok account and one subject history on it.
    const learning: LearningContextLike = await readLearningContext(wf, tools, ctx, "tiktok", "01b-read-learning-context");
    const stage = stageForRun(runDirection.slotStage, learning.subjectWindow);
    /**
     * What this client asked for on PREVIOUS runs, read once above the review
     * loop so every round drafts against it.
     *
     * Read at all because this agent never did (2026-09-18): it was the only
     * one of D08's three that collected a reviewer's note and then never showed
     * it to the two models a note is actually about. A client who has said
     * "keep the captions off the speaker's face" on three runs was saying it
     * into a void.
     */
    const pastFeedback = await readPastFeedback(wf, tools, ctx, "01c-read-past-feedback");

    /**
     * The client's own profile, voice rules and brand-kit language, for the
     * one step on this product that writes free text (09c).
     *
     * Read here rather than inside the review round for the same reason the
     * learning context is: everything below `rev(id)` runs again on every
     * revision, and a client's voice does not change between attempt 1 and
     * attempt 2.
     *
     * Best-effort and never blocking. A client with nothing on file gets a
     * caption in the language their own transcript is in, which is what the
     * prompt falls back to.
     */
    const clientVoiceContext = await wf.step.code("01d-load-client-voice-context", async () => {
      const profileOutcome = await tools["client.getProfile"]?.execute({}, { ctx });
      const voiceOutcome = await tools["client.getVoiceRules"]?.execute({}, { ctx });
      const brandOutcome = await tools["client.getBrand"]?.execute({}, { ctx });
      return buildClientVoiceContext(
        profileOutcome?.status === "success" ? (profileOutcome.result as Record<string, unknown>) : undefined,
        voiceOutcome?.status === "success" ? (voiceOutcome.result as Record<string, unknown>) : undefined,
        brandOutcome?.status === "success" ? (brandOutcome.result as Record<string, unknown>) : undefined,
      );
    });

    // ── 00: brand resolve — the locked style and brand profile on file, or
    //        the same things DERIVED from the client's brand kit ──
    //
    // Until 2026-09-07 this step refused to run unless an operator had put a
    // brand-profile.json (with font files and an alpha-masked mark beside it),
    // a graphics-language.md and an approved-archetype list on the client's
    // config by hand, and unless Style Exploration had been run and locked.
    // Every karoslabs run on prep since 2026-09-05 was `blocked_intake` on
    // exactly that, while the client's brand kit held everything those files
    // are built from. Anything an operator DID configure still wins; what is
    // missing is derived (`derive-brand-setup.ts`), named in `setupNotes`, and
    // shown to the reviewer at 10-delivery-review. The run blocks only when
    // the kit itself cannot support a profile (no colour, no obtainable font).
    const brandResolve = await wf.step.code("00-brand-resolve", async () => {
      const beliefsOutcome = await tools["memory.read"]!.execute({ scope: "beliefs" }, { ctx });
      const beliefs = beliefsOutcome.status === "success" ? (beliefsOutcome.result as { beliefs: Record<string, unknown> }).beliefs : {};
      const lockedStyle = beliefs["brandedShortsLockedStyle"];

      const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
      const rawConfig = configOutcome.status === "success" ? (configOutcome.result as Record<string, unknown>) : {};
      const config = BrandedShortsClientConfigSchema.safeParse(rawConfig).success
        ? BrandedShortsClientConfigSchema.parse(rawConfig)
        : BrandedShortsClientConfigSchema.parse({});

      const workDir = config.brandedShortsWorkDir ?? path.join(os.tmpdir(), "branded-shorts", wf.runId);
      const configured = {
        profile: Boolean(config.brandedShortsProfilePath || config.brandedShortsAssetBundle),
        graphicsLanguage: Boolean(config.brandedShortsGraphicsLanguage),
        archetypes: Boolean(config.brandedShortsApprovedArchetypes && config.brandedShortsApprovedArchetypes.length > 0),
      };
      const lockedIsCandidate = typeof lockedStyle === "object" && lockedStyle !== null && typeof (lockedStyle as { name?: unknown }).name === "string";

      let derived: Awaited<ReturnType<typeof deriveBrandSetup>> | undefined;
      if (!configured.profile || !configured.graphicsLanguage || !configured.archetypes || !lockedIsCandidate) {
        const brandOutcome = await tools["client.getBrand"]?.execute({}, { ctx });
        const brand = brandOutcome?.status === "success" ? (brandOutcome.result as Record<string, unknown>) : {};
        derived = await deriveBrandSetup({
          brand,
          lockedStyle,
          workDir,
          tools,
          ctx,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          ...(options.fontOptions ? { fontOptions: options.fontOptions } : {}),
          needProfile: !configured.profile,
        });
        if (!derived.ok) {
          throw new WorkflowBlockedIntake(`branded-shorts setup is incomplete and could not be derived from the brand kit: ${derived.reason}`);
        }
      }
      const setup = derived?.ok ? derived.setup : undefined;

      // The locked style's own words become the plate generator's art
      // direction (CUTAWAY-IMAGE-PROMPTS production rule 5: "the client's
      // locked style governs palette, ground and light language in every
      // prompt") — read here, where the style is already in hand.
      const style = (lockedIsCandidate ? lockedStyle : setup?.style) as Record<string, unknown>;
      const lockedStyleNotes = ["description", "paletteUsage", "graphicsDirection"]
        .map((k) => style[k])
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .join(" ");
      const setupNotes: string[] = [
        ...(setup?.notes ?? []),
        ...(setup && !configured.profile ? ["brand profile derived from the brand kit (no brandedShortsProfilePath / brandedShortsAssetBundle on file)"] : []),
        ...(setup && !configured.graphicsLanguage ? ["graphics language derived from the style and the brand kit (no brandedShortsGraphicsLanguage on file)"] : []),
        ...(setup && !configured.archetypes ? [`approved archetypes defaulted to the render engine's registry: ${setup.approvedArchetypes.join(", ")}`] : []),
      ];
      return {
        profilePath: configured.profile ? config.brandedShortsProfilePath : setup!.profilePath!,
        assetBundle: configured.profile ? config.brandedShortsAssetBundle : undefined,
        lockedStyleNotes,
        styleSource: lockedIsCandidate ? ("locked" as const) : ("derived" as const),
        graphicsLanguage: configured.graphicsLanguage ? config.brandedShortsGraphicsLanguage! : setup!.graphicsLanguage,
        approvedArchetypes: configured.archetypes ? config.brandedShortsApprovedArchetypes! : setup!.approvedArchetypes,
        setupNotes,
        intakeRaw: config.brandedShortsIntake,
        paths: resolveRunPaths(workDir),
      };
    });

    // ── 01: per-upload intake (RFC-06 §7 / assets/INTAKE-REQUEST.md) ──
    const intake: BrandedShortsIntake = await wf.step.code("01-load-intake", () => {
      if (attachedVideo !== undefined) {
        // The attachment is the footage. The rest of the intake comes from the
        // standing config where it exists, and the run's own direction stands
        // in for the takeaway where it does not — a short has to leave the
        // viewer with something, and the person who attached the video and
        // typed a sentence has said what.
        const standing =
          typeof brandResolve.intakeRaw === "object" && brandResolve.intakeRaw !== null ? (brandResolve.intakeRaw as Record<string, unknown>) : {};
        const hasTakeaway = typeof standing["takeaway"] === "string" && (standing["takeaway"] as string).trim().length > 0;
        const merged = BrandedShortsIntakeSchema.safeParse({
          targetLength: "client_choice",
          ...standing,
          videoPath: attachedVideo.uri,
          ...(!hasTakeaway && runDirection.direction ? { takeaway: runDirection.direction } : {}),
        });
        if (!merged.success) {
          throw new WorkflowBlockedIntake(
            `a source video was attached to this run but the intake around it is incomplete (${merged.error.message}) — say in the run's direction what the short should leave the viewer with`,
          );
        }
        return merged.data;
      }
      if (clientMediaOnly) {
        throw new WorkflowBlockedIntake(
          "this run was set to client-provided media only, but no source video was attached — attach the talking-head footage this short is cut from",
        );
      }
      const parsed = BrandedShortsIntakeSchema.safeParse(brandResolve.intakeRaw);
      if (!parsed.success) {
        throw new WorkflowBlockedIntake(`no valid per-upload intake for this run (brandedShortsIntake): ${parsed.error.message}`);
      }
      return parsed.data;
    });

    // C7: the takeaway is what this short is ABOUT, and a client's never-topic
    // applies to it exactly as it applies to a subject someone typed on any
    // other agent. It HOLDS rather than editing the video to say something
    // else — nobody asked for that, and the client would read what came back
    // as the short they asked for.
    //
    // OUTSIDE the intake step and after it, deliberately: the takeaway arrives
    // by two roads (attached to this run, or the standing `brandedShortsIntake`
    // block) and a check inside one branch is a check the other road walks
    // straight past. It is still before the first model call and before a
    // single frame is rendered, so the refusal costs nothing.
    const refusedTakeaway = touchesNeverTopic(intake.takeaway, learning.preferences);
    if (refusedTakeaway !== undefined) {
      throw new WorkflowHeld(
        `the takeaway for this short touches a never-topic the client set ("${refusedTakeaway}") — nothing was edited in its place`,
      );
    }

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
    const cutGate = await wf.step.code("05-cut-gate", async () => {
      const writeOutcome = await tools["video.writeJsonFile"]!.execute(
        { path: brandResolve.paths.jobPath, data: { segments: cutPlan.segments, content_cuts: cutPlan.contentCuts } },
        { ctx },
      );
      if (writeOutcome.status !== "success") {
        throw new WorkflowToolingFailure(`video.writeJsonFile(job.json) failed: ${writeOutcome.status}`);
      }
      const verdict = await runGateTool(tools, "video.cutGate", { jobPath: brandResolve.paths.jobPath, transcriptPath: brandResolve.paths.transcriptPath }, ctx);
      if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`video.cutGate: ${verdict.reason}`);
      // Advisory since 2026-09-18 (the owner's always-deliver rule). The cut
      // list is DERIVED, not drafted: `deriveCutSegments` crops the ends and
      // drops filler by rule, so a gate objecting to it is objecting to the
      // rule's output on this transcript, not to a model's judgment. There is
      // no second cut to fall back to and no writer to send it back to - the
      // only two outcomes were ship it or end the run, and the reviewer at
      // 10-delivery-review can watch the result either way.
      if (verdict.verdict === "content_fail") {
        console.warn(`05-cut-gate: video.cutGate flagged the cut list, building it flagged rather than holding: ${verdict.reason}`);
        return { ...verdict, flagged: true as const };
      }
      return { ...verdict, flagged: false as const };
    });

    const kept = keptWords(transcript.words, cutPlan.segments);

    // ── 07: color grade — zero judgment, "auto" or a locked profile override (PLAYBOOK §4b) ──
    //
    // Outside the revision loop with the cut and the transcript: a reviewer's
    // note changes what the short SAYS and what it shows, never the client's
    // locked grade, so every round reuses this rather than re-deriving it.
    const colorGrade = await wf.step.code("07-color-grade", async () => {
      const outcome = await tools["video.colorGrade"]!.execute({ profile }, { ctx });
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`video.colorGrade failed: ${outcome.status}`);
      }
      return outcome.result as { grade: string; source: "auto" | "profile_locked" };
    });

    const libraryRoot = path.dirname(inputs.profilePath);
    const writeJob = async (job: unknown): Promise<void> => {
      const writeOutcome = await tools["video.writeJsonFile"]!.execute({ path: brandResolve.paths.jobPath, data: job }, { ctx });
      if (writeOutcome.status !== "success") {
        throw new WorkflowToolingFailure(`video.writeJsonFile(job.json) failed: ${writeOutcome.status}`);
      }
    };

    /**
     * What one generated cutaway plate costs, read off the same `UNIT_PRICING`
     * row `image.generate` bills against. A missing row is a tooling failure
     * rather than a free-looking plan: an estimate built on a rate nobody has
     * is a guess with a decimal point in it.
     */
    const platePriceUsd = (): number => {
      const row = UNIT_PRICING[PLATE_IMAGE_SKU];
      if (row === undefined) throw new WorkflowToolingFailure(`cannot price this run: no UNIT_PRICING row for "${PLATE_IMAGE_SKU}"`);
      return row.usdPerUnit;
    };
    /** The hard wall, lowered (never raised) by a dispatcher budget tighter than the product rule. */
    const costCapUsd = Math.min(MAX_RUN_COST_USD, wf.budget?.maxTotalCostUsd ?? MAX_RUN_COST_USD);
    /** What the run PLANS against, clamped to the wall so a tighter dispatcher budget still decides. */
    const targetSpendUsd = Math.min(TARGET_RUN_SPEND_USD, costCapUsd);

    /** What one review round produced, and what it had to adapt around to produce it. */
    interface ShortDraft {
      outputPath: string;
      /** The words this round would post the video with. Drafted inside the round, so a reviewer's note about the caption actually changes it. */
      copy: BrandedShortsCopy;
      durationSeconds: number | null;
      plan: GraphicsPlanOutput;
      warnings: string[];
      highlightStarts: number[];
      graphicsAttempts: number;
      /** The model's read of the finished video, when a deployment has one. */
      visualQa?: { passed: boolean; reason?: string; evidence: string[] };
      /** Everything this round had to work around, in the order it met it. Empty on the clean path. */
      repairs: ContentRepair[];
    }

    // ─────────────────────────────────────────────────────────────────────
    // ONE REVIEW ROUND: the two editorial islands (which moments to
    // highlight, what the graphics say), their gates, the composite, and the
    // two QA reads over it.
    //
    // Everything above this line is fixed for the whole run — the footage, the
    // transcript, the derived cut, the client's locked grade — because no
    // reviewer note can change any of it. Everything inside is what a note CAN
    // change, which is why it is scoped by revision: without the `-r{n}`
    // suffix a second round would short-circuit on round 0's checkpoints and
    // hand the reviewer the same video back while the trace claimed it had
    // been re-planned.
    // ─────────────────────────────────────────────────────────────────────
    const produceShort = async (revision: number, notes: readonly RevisionNote[]): Promise<ShortDraft> => {
      /** Revision 0 keeps the ORIGINAL ids, so a first-pass trace is byte-identical to what it was before the loop existed. */
      const rev = (id: string) => (revision === 0 ? id : `${id}-r${revision}`);
      const directive = revisionDirective(notes);
      const repairs: ContentRepair[] = [];

      // ── 06: highlights — the first bounded judgment island ──
      //
      // A `content_fail` here used to end the run. It no longer can: highlight
      // starts are punch-ins on moments that matter, and a short with none is
      // a flatter short, not a broken one. The cut, the grade and the client's
      // own words are all still there.
      const highlightsAgent = new BrandedShortsHighlightsAgent({ router: options.router, tools, promptStore: options.promptStore });
      const highlightsResult = await wf.step.agent(rev("06-highlights"), highlightsAgent, {
        ...runDirectionField(runDirection),
        words: kept,
        corrections: intake.names,
        takeaway: intake.takeaway,
        ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
        ...(directive !== undefined ? { revisionRequest: directive } : {}),
      });
      if (highlightsResult.status !== "completed" && highlightsResult.status !== "content_fail") {
        throw new WorkflowToolingFailure(`highlights step resolved to "${highlightsResult.status}"`);
      }
      // The model's timestamps are a PROPOSAL, snapped here onto words that
      // exist (2026-09-18). Its prompt has forbidden inventing one since v1
      // and nothing checked: the schema is `z.array(z.number())`, so any
      // number at all reached the render job's `highlight_starts`, where the
      // engine emphasised whatever was nearest, or nothing. The clipping agent
      // has validated its own model's timestamps from the beginning, for
      // exactly the reason its comment gives — a model asked for a timestamp
      // returns one whether or not the transcript supports it.
      const rhythm = await wf.step.code(rev("06b-highlight-rhythm"), () =>
        applyHighlightRhythm(highlightsResult.status === "completed" ? highlightsResult.finalOutput!.highlightStarts : [], kept),
      );
      const highlightStarts = rhythm.highlightStarts;
      if (rhythm.dropped.length > 0) {
        repairs.push({
          check: "highlight-rhythm",
          action: "redacted",
          detail: `${rhythm.dropped.length} proposed emphasis word(s) were dropped: ${rhythm.dropped.join("; ")}`,
        });
        console.warn(`${rev("06b-highlight-rhythm")}: ${rhythm.dropped.join("; ")}`);
      }
      if (highlightsResult.status === "content_fail") {
        repairs.push({
          check: "branded-shorts-highlights",
          action: "unresolved",
          detail: "the highlight picker returned nothing schema-valid; the short is built without punch-ins rather than not built at all",
        });
      }

      // Every job this round writes shares these; the plan (and, at the end,
      // the generated plate files) is what varies between them.
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

      // ── 07b: base render — the graded, concatenated footage timeline, ONCE ──
      //
      // `graphic_qa.py` judges every overlay's visibility over the frame it will
      // really sit on. That frame has to come from base.mp4 (footage only), not
      // from a finished composite that already carries the overlay being judged
      // — which is what this workflow used to hand it. The cut and grade are
      // fixed before any plan exists, so base renders once per round, outside
      // the plan loop; each plan attempt then costs overlay frames + gates, and
      // the full composite is paid for exactly once, after a plan has passed.
      const base = await wf.step.code(rev("07b-render-base"), async () => {
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
      // on a deployment without it — or on a run the client set to their own
      // media only — the agent is told so and plans none.
      const plateGenerationAvailable = tools["image.generate"] !== undefined && !clientMediaOnly;
      const graphicsAgent = new BrandedShortsGraphicsAgent({ router: options.router, tools, promptStore: options.promptStore });
      let priorFailureReason: string | undefined;
      let build: { outputPath: string; durationSeconds: number | null; plan: GraphicsPlanOutput; warnings: string[]; unmet: string[] } | undefined;
      let graphicsAttemptsUsed = 0;
      /** Set when the last attempt's plan had illegal items dropped out of it; it, not `plan`, is what builds. */
      let planForBuild: GraphicsPlanOutput | undefined;
      /** Set when the planner produced nothing schema-valid twice and the short is the footage alone. */
      let emptyPlanReason: string | undefined;

      for (let attempt = 1; attempt <= MAX_GRAPHICS_ATTEMPTS; attempt++) {
        graphicsAttemptsUsed = attempt;
        const planResult = await wf.step.agent(rev(`08a-plan-graphics-attempt-${attempt}`), graphicsAgent, {
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
          ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
          ...(directive !== undefined ? { revisionRequest: directive } : {}),
        });
        if (planResult.status !== "completed" && planResult.status !== "content_fail") {
          throw new WorkflowToolingFailure(`graphics plan step resolved to "${planResult.status}"`);
        }
        if (planResult.status === "content_fail") {
          // Nothing schema-valid came back. An empty plan is a legal plan - the
          // client's own footage, cut and graded, with no overlays and no
          // cutaways over it - so the round retries once and then builds that
          // rather than ending the run. A plainer short beats no short.
          priorFailureReason = "your last plan did not clear its own output validation";
          if (attempt < MAX_GRAPHICS_ATTEMPTS) continue;
          emptyPlanReason = "the graphics planner returned nothing schema-valid twice; the short was built from the footage alone, with no overlays or cutaways";
        }
        const plan: GraphicsPlanOutput = planResult.status === "completed" ? planResult.finalOutput! : { overlays: [], cutaways: [] };

        // P0#1 audit fix: reject an unapproved archetype BEFORE spending a render+gate cycle on
        // a plan already known to violate the closed-vocabulary invariant, and feed the exact
        // violation back into the same retry loop every other gate failure already uses. The
        // same pass now covers bursts (stills must come from the library) and plates (only on a
        // deployment that can generate one).
        const planViolations = await wf.step.code(rev(`08a2-validate-archetypes-attempt-${attempt}`), () =>
          validateGraphicsPlan(plan, { approvedArchetypes: brandResolve.approvedArchetypes, libraryFiles: library.map((s) => s.file), plateGenerationAvailable }),
        );
        if (planViolations.length > 0) {
          priorFailureReason = planViolations.join("; ");
          if (attempt === MAX_GRAPHICS_ATTEMPTS) {
            // The closed-vocabulary invariant is not negotiable - an unapproved
            // archetype is a graphic the client never signed off on, and a burst
            // built from a still that is not in their library is worse than a
            // gap. So the offending ITEMS go, not the run: what survives is
            // every overlay and cutaway that WAS approved, over the client's own
            // footage, and the reviewer is told what was dropped.
            const cleaned = dropViolatingItems(plan, { approvedArchetypes: brandResolve.approvedArchetypes, libraryFiles: library.map((st) => st.file), plateGenerationAvailable });
            repairs.push({
              check: "video.graphicsPlan",
              action: "redacted",
              detail: `${priorFailureReason} - those ${plan.overlays.length + plan.cutaways.length - cleaned.overlays.length - cleaned.cutaways.length} item(s) were dropped and the rest of the plan built`,
            });
            planForBuild = cleaned;
          } else {
            continue;
          }
        }

        // Render the overlay frames, then gate them over the REAL footage (base.mp4)
        // and gate the cutaway schedule — nothing here composites, so a failing
        // plan costs frames and two gate runs, never a full encode.
        const planned = planForBuild ?? plan;
        const attemptOutput = await wf.step.code(rev(`08b-render-and-gate-attempt-${attempt}`), async () => {
          await writeJob(assembleJob({ ...jobBase, plan: planned }));

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
          return { plan: planned, failures };
        });

        if (attemptOutput.failures.length > 0) {
          priorFailureReason = attemptOutput.failures.join("; ");
          if (attempt === MAX_GRAPHICS_ATTEMPTS) {
            // Two plans in and the gates still object. The objection is about
            // legibility and schedule, not about safety, and a person is about
            // to watch the result with the same eyes the gate is standing in
            // for. Built as planned, flagged with what the gates said.
            repairs.push({
              check: "video.graphicsGate",
              action: "unresolved",
              detail: `${priorFailureReason} - built and delivered flagged after ${MAX_GRAPHICS_ATTEMPTS} plans rather than withheld`,
            });
          } else {
            continue;
          }
        }

        // ── 08b2: price the plates BEFORE buying any (2026-09-18) ──
        //
        // This agent had no cost bound at all, alone among D08's three:
        // `image.generate` billed once per plate cutaway, and the plate COUNT
        // is a model's decision. A planner that proposed nine plates spent
        // nine plates' worth, and nothing anywhere said otherwise.
        //
        // Bursts are not counted and never cut — they are the client's own
        // stills, already on disk, and free. Only a plate is a purchase.
        const plateBudget = await wf.step.code(rev(`08b2-plate-budget-attempt-${attempt}`), async () =>
          planPlateBudget({
            plateCount: planned.cutaways.filter((c) => c.kind === "plate").length,
            spentSoFarUsd: await wf.costSoFarUsd(),
            platePriceUsd: platePriceUsd(),
            targetUsd: targetSpendUsd,
            maxUsd: costCapUsd,
          }),
        );
        if (plateBudget.note !== undefined) {
          repairs.push({ check: "run-budget", action: "trimmed", detail: plateBudget.note });
          console.warn(`${rev(`08b2-plate-budget-attempt-${attempt}`)}: ${plateBudget.note}`);
        }
        // Applied OUTSIDE the step from its recorded result, so a replay that
        // short-circuits the step still builds the plan the budget allowed.
        const maxPlates = plateBudget.maxPlates;
        let platesKept = 0;
        const affordable: GraphicsPlanOutput =
          maxPlates === undefined ? planned : { ...planned, cutaways: planned.cutaways.filter((c) => c.kind !== "plate" || platesKept++ < maxPlates) };

        // ── 08c: the plan passed — generate its plates, then the one full composite ──
        // Plates are generated only now, after the gates: each is a billed call,
        // and a plan that was going to fail its schedule should not have bought
        // images first. A plate the generator cannot produce holds the run with
        // the model's own reason; nothing is substituted.
        build = await wf.step.code(rev(`08c-plates-and-render-attempt-${attempt}`), async () => {
          const generated = await generatePlates(tools, ctx, {
            plan: affordable,
            workDir: brandResolve.paths.workDir,
            runId: wf.runId,
            palette: [profile.color.background, profile.color.foreground, profile.color.accent],
            accent: profile.color.accent,
            styleNotes: brandResolve.lockedStyleNotes,
          });
          // A plate the generator would not produce leaves its cutaway out of
          // the composite entirely. Kept in ONE place - here, where the missing
          // files are known - so the job written to disk and the plan recorded
          // on the deliverable are the same plan the render actually built.
          const built: GraphicsPlanOutput =
            generated.unmet.length === 0
              ? affordable
              : { ...affordable, cutaways: affordable.cutaways.filter((_, i) => affordable.cutaways[i]!.kind !== "plate" || generated.plateFiles[i] !== undefined) };
          await writeJob(assembleJob({ ...jobBase, plan: built, plateFiles: generated.plateFiles }));
          const renderOutcome = await tools["video.render"]!.execute({ profilePath: inputs.profilePath, jobPath: brandResolve.paths.jobPath }, { ctx });
          if (renderOutcome.status !== "success") {
            throw new WorkflowToolingFailure(`video.render failed: ${renderOutcome.status}: ${(renderOutcome as { reason?: string }).reason ?? ""}`);
          }
          const rendered = renderOutcome.result as { outputPath: string; durationSeconds: number | null; warnings: string[] };
          return { outputPath: rendered.outputPath, durationSeconds: rendered.durationSeconds, plan: built, warnings: rendered.warnings, unmet: generated.unmet };
        });
        if (build.unmet.length > 0) {
          repairs.push({
            check: "cutaway-plate",
            action: "redacted",
            detail: `the generator would not produce ${build.unmet.join("; ")}; ${build.unmet.length} cutaway(s) were left out rather than filled with something that does not match the phrase under them`,
          });
        }
        break;
      }
        if (!build) {
          // Unreachable: the loop above either sets `build` or, on its last
          // attempt, builds whatever survived its gates.
          throw new WorkflowToolingFailure("graphics/cutaway loop exited without a build result");
        }
        if (emptyPlanReason !== undefined) {
          repairs.push({ check: "branded-shorts-graphics", action: "unresolved", detail: emptyPlanReason });
        }
        if (cutGate.flagged) {
          repairs.push({
            check: "video.cutGate",
            action: "unresolved",
            detail: `${cutGate.reason ?? "the cut list was flagged"} — built and delivered flagged rather than withheld`,
          });
        }

        // ── 09: self-eval gate — PLAYBOOK §6, before anyone sees the output ──
        //
        // Carries `build.warnings` (e.g. build_short.py's caption-density check)
        // forward into this gate's own evidence (P0#3 audit fix) rather than
        // letting them vanish once video.render's result is otherwise consumed —
        // advisory, never turned into a content_fail on their own.
        //
        // The gate itself is advisory too since 2026-09-18, for the reason the
        // visual QA next door already is: a person is about to watch this exact
        // file, and no verdict this gate reaches is one that reviewer cannot
        // reach better. A `tooling_error` still throws — a check that could not
        // run has judged nothing.
        const selfEval = await wf.step.code(rev("09-self-eval-gate"), async (): Promise<{ passed: boolean; reason?: string }> => {
          const verdict = await runGateTool(
            tools,
            "video.selfEvalGate",
            { videoPath: build!.outputPath, renderWarnings: build!.warnings, profilePath: inputs.profilePath, jobPath: brandResolve.paths.jobPath },
            ctx,
          );
          if (verdict.verdict === "tooling_error") throw new WorkflowToolingFailure(`video.selfEvalGate: ${verdict.reason}`);
          if (verdict.verdict === "content_fail") {
            console.warn(`${rev("09-self-eval-gate")}: video.selfEvalGate flagged the finished video, delivering it flagged rather than held: ${verdict.reason}`);
            return { passed: false, reason: verdict.reason };
          }
          return { passed: true };
        });
        if (!selfEval.passed) {
          repairs.push({
            check: "video.selfEvalGate",
            action: "unresolved",
            detail: `${selfEval.reason ?? "the finished video failed its self-eval"} — delivered flagged for a person to watch rather than withheld`,
          });
        }

        // ── 09b: the visual QA — a model WATCHES the finished short ──
        //
        // The check this agent has never had, and the one clipping and content
        // design have had since 2026-09-07. `video.selfEvalGate` answers
        // questions about the FILE; until now nothing looked at the video.
        //
        // It matters most here because of what sits under it: this agent's
        // delivery gate auto-approves an unanswered review, so with no quality
        // signal the timeout was shipping whatever nobody happened to open
        // within the hour. That is the exact failure two prep clips met on
        // 2026-09-08. The timeout below now reads this verdict.
        //
        // Advisory like everywhere else, and a deployment without the gate
        // records that it was SKIPPED rather than pretending it passed — which
        // is what lets the timeout tell "reviewed and fine" from "never seen".
        const visualQa = await wf.step.code(
          rev("09b-visual-qa"),
          async (): Promise<{ skipped: true; note: string } | { skipped: false; passed: boolean; reason?: string; evidence: string[] }> => {
            const gate = tools["video.visualQaGate"];
            if (gate === undefined) return { skipped: true, note: "video.visualQaGate is not registered in this deployment" };
            const outcome = await gate.execute(
              {
                videoPath: build!.outputPath,
                expectations: {
                  topic: intake.takeaway,
                  captionsExpected: true,
                  voiceoverExpected: false,
                  brandColors: [profile.color.background, profile.color.foreground, profile.color.accent],
                  format: "commentary-clip",
                },
              },
              { ctx },
            );
            if (outcome.status === "not_available") return { skipped: true, note: `video.visualQaGate is not available: ${outcome.reason}` };
            if (outcome.status !== "success") {
              return { skipped: true, note: `video.visualQaGate ${outcome.status}; the reviewer judges the short unaided` };
            }
            const verdict = outcome.result as GateVerdict;
            if (verdict.verdict === "tooling_error") {
              return { skipped: true, note: `video.visualQaGate could not review the short (${verdict.reason}); the reviewer judges it unaided` };
            }
            if (verdict.verdict === "content_fail") {
              console.warn(`${rev("09b-visual-qa")}: visual QA flagged the short, delivering it flagged rather than held: ${verdict.reason}`);
              return { skipped: false, passed: false, reason: verdict.reason, evidence: verdict.evidence };
            }
            return { skipped: false, passed: true, evidence: verdict.evidence };
          },
        );

        // -- 09c: the words the video is posted with --
        //
        // The one free-text thing this product writes, and until now it wrote
        // nothing: the portal materialized a branded short with `content: ""`
        // and said so in its own comment. A client approved an MP4 and then
        // wrote the caption themselves.
        //
        // INSIDE the round on purpose. A reviewer at 10-delivery-review is
        // looking at the caption and the video together; "the caption misses
        // the point" is one of the likeliest notes they will send, and a
        // caption drafted outside the loop would come back identical. It is
        // also the only place the reviewer's directive can reach it.
        //
        // A `content_fail` cannot end the run (owner ruling 2026-09-17). The
        // client's own stated takeaway is the fallback: it is one sentence
        // they wrote themselves about what the video should say, so it is the
        // most honest thing to put under it when the drafter has produced
        // nothing schema-valid. The substitution is recorded, never silent --
        // a reviewer must be able to tell a written caption from a fallback.
        const captionAgent = new BrandedShortsCaptionAgent({ router: options.router, tools, promptStore: options.promptStore });
        const captionResult = await wf.step.agent(rev("09c-draft-caption"), captionAgent, {
          ...runDirectionField(runDirection),
          words: kept.map((w) => w.text),
          takeaway: intake.takeaway,
          ...(clientVoiceContext !== undefined ? { clientVoiceContext } : {}),
          ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
          ...(directive !== undefined ? { revisionRequest: directive } : {}),
        });
        if (captionResult.status !== "completed" && captionResult.status !== "content_fail") {
          throw new WorkflowToolingFailure(`caption step resolved to "${captionResult.status}"`);
        }
        const drafted = captionResult.status === "completed" ? captionResult.finalOutput : null;
        const copy: BrandedShortsCopy = drafted ?? { caption: intake.takeaway, about: intake.takeaway };
        if (drafted === null) {
          repairs.push({
            check: "branded-shorts-caption",
            action: "unresolved",
            detail: "the caption drafter returned nothing schema-valid; the short is posted with the client's own stated takeaway as its caption rather than with none at all",
          });
        }

        // -- terminal topic guardrail --
        //
        // The words that survive into the cut, plus the takeaway the client asked
        // for, plus the text this round put ON SCREEN. These are the client's OWN
        // words from their own footage, which is exactly why the check is worth
        // running: a subject they told us not to publish can still be something
        // they said on camera — and an overlay is published words too.
        //
        // Inside the round and revision-scoped: without the suffix a second round
        // short-circuits on round 0's checkpoint, the REVISED graphics are never
        // actually checked, and the trace still reports a pass.
        await runTopicGuardrail(
          wf,
          { tools, promptStore: options.promptStore, router: options.router },
          [kept.map((w) => w.text).join(" "), intake.takeaway, copy.caption, ...build.plan.overlays.map((o) => o.label ?? o.illustrates)].filter(Boolean).join("\n\n"),
          undefined,
          revision === 0 ? undefined : `-r${revision}`,
        );

        return {
          outputPath: build.outputPath,
          copy,
          durationSeconds: build.durationSeconds,
          plan: build.plan,
          warnings: build.warnings,
          highlightStarts,
          graphicsAttempts: graphicsAttemptsUsed,
          ...(visualQa.skipped
            ? {}
            : { visualQa: { passed: visualQa.passed, ...(visualQa.reason !== undefined ? { reason: visualQa.reason } : {}), evidence: visualQa.evidence } }),
          repairs,
        };
    };

    // ── 10: the approve / revise / reject cycle — SKILL.md requires_approval: true ──
    //
    // Until 2026-09-18 this was a bare `wf.step.gate` whose only two outcomes
    // were "approve" and a dead run: a reviewer who wanted the third cutaway
    // swapped had to dispatch a whole new run, re-upload, re-transcribe,
    // re-plan the cut and pay for a second base render to say so. Clipping and
    // content design have had `runReviewCycle` since they were migrated; this
    // is the same loop, and it reuses everything above it — the footage, the
    // transcript, the derived cut, the client's locked grade — so a revise
    // round costs one highlights turn, one plan turn, one base render and one
    // composite instead of a second run's worth of everything.
    //
    // A reject or an exhausted round no longer ends the run either: the short
    // is delivered carrying the decision, so the reviewer keeps the work and
    // the reason attached to it rather than an error where a video should be.
    const review = await runReviewCycle<ShortDraft>(wf, {
      gateId: "10-delivery-review",
      maxRevisions: MAX_REVISION_ROUNDS,
      ...(options.autoApprove ? { autoApprove: true } : {}),
      attempt: produceShort,
      buildGate: (draft, revision) => ({
        kind: "branded_shorts_delivery_review",
        payload: {
          runId: wf.runId,
          outputPath: draft.outputPath,
          durationSeconds: draft.durationSeconds,
          // The words this short would be posted with. A reviewer approving a
          // POST has to see the post, not only the video: until 2026-09-25
          // this gate showed a play button and six counts, and the caption
          // did not exist to show.
          //
          // `preview`, not `caption`, and the key is the whole point. The
          // portal's gate renderer paints an unanticipated string into a
          // `truncate`d fact row -- a caption cut to one line is the same
          // reviewer approving the same thing unseen -- while `preview` has
          // its own full-width block with `whitespace-pre-wrap` and
          // `dir="auto"`, which a Hebrew caption needs to read at all. It is
          // the key instagram, linkedin, blog and the campaign bundle already
          // send their copy under.
          preview: draft.copy.caption,
          about: draft.copy.about,
          overlayCount: draft.plan.overlays.length,
          cutawayCount: draft.plan.cutaways.length,
          renderWarnings: draft.warnings,
          revision,
          // What this run assumed instead of being told, so a video built on
          // a derived profile or an unlocked style is reviewed as exactly that.
          styleSource: brandResolve.styleSource,
          // What the model made of the finished short, so a flagged video
          // arrives with the reason beside the play button.
          ...(draft.visualQa !== undefined ? { visualQa: draft.visualQa } : {}),
          // Everything this round had to work around. `flagged` is the one
          // field the portal reads to decide whether to shout, so it is true
          // for a setup this run guessed at, a QA the model disliked, or any
          // repair at all.
          ...(draft.repairs.length > 0 ? { contentRepairs: draft.repairs } : {}),
          ...(brandResolve.setupNotes.length > 0 ? { setupNotes: brandResolve.setupNotes } : {}),
          ...(brandResolve.setupNotes.length > 0 || draft.repairs.length > 0 || draft.visualQa?.passed === false ? { flagged: true } : {}),
        },
        requiredRole: "account_manager",
        // An unanswered gate approves itself after an hour ONLY for a short the
        // visual QA watched and passed. Unconditional auto-approval is how two
        // prep clips scored 3/10 shipped by `system:gate-timeout` on
        // 2026-09-08; clipping fixed that the same week and this agent did not.
        // A flagged short, one the QA never got to watch, and one this run had
        // to repair all wait for a person, however long that takes.
        timeout: {
          duration: "1h",
          onTimeout: draft.visualQa?.passed === true && draft.repairs.length === 0 ? "auto_approve" : "hold",
        },
      }),
      onDecision: async ({ revision, response, output }) => {
        // A reject's drafted content has nowhere durable to go otherwise: it
        // lives only in this round's step checkpoints. An approval's already
        // has a copy via the deliverable, and a revise round's is superseded.
        await persistReviewFeedbackToMemory(
          wf,
          tools,
          ctx,
          revision,
          response,
          response.decision === "reject" ? JSON.stringify({ plan: output.plan, outputPath: output.outputPath }) : undefined,
        );
      },
    });
    const build = review.output;
    const highlightStarts = build.highlightStarts;
    const graphicsAttemptsUsed = build.graphicsAttempts;
    /**
     * Everything the APPROVED round had to repair, plus the reviewer's own
     * verdict when it was not an approval.
     *
     * A reviewer who rejected outright, or who ran the cycle out of rounds, is
     * recorded ON the deliverable rather than ending the run. Nothing here
     * publishes anything — the short still waits on a human — so what changes
     * is that the reviewer keeps the work and the reason attached to it.
     */
    const contentRepairs: ContentRepair[] = [...build.repairs];
    if (review.outcome !== undefined && review.outcome !== "approved") {
      contentRepairs.push({ check: "human-review", action: "unresolved", detail: review.outcomeDetail ?? review.outcome });
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

    /**
     * D11's goal line — what this short is for, who for, and why now.
     *
     * Resolved once and used for both the client's card and the state record
     * (C7 §3.2), in the structured shape clipping and content design use: the
     * client receives an mp4, there is no drafts markdown to hang a meta
     * bullet on.
     *
     * The why-now writes itself here and is the truest of the three agents':
     * D19 makes editing on demand, so the reason this short exists now is that
     * the client handed over a video and asked for it.
     */
    const goalLine: ResolvedGoalLine = resolveGoalLine(
      {},
      {
        stage,
        // The editing intake has no audience field — the client says what the
        // short should LEAVE the viewer with, not who the viewer is. Left
        // absent rather than filled with a guess: `goalLineBullets` and the
        // record both omit it, and an invented audience on a client's card is
        // worse than a missing one.
        whyNow: "the client handed over this video and asked for a short from it",
      },
    );

    // ── 11-13: persist deliverable, dashboard snapshot, commit + record ──
    const deliverableId = await finalizeDeliverable(wf, tools, ctx, {
      persistDeliverableStepId: "11-persist-deliverable",
      persistManifestStepId: "12-persist-manifest",
      kind: "branded-shorts-video",
      deliverable: {
        // D11 / C3: the point of the post, on the thing the client opens.
        goalLine,
        // The post. `materializeBrandedShortsVideo` reads this for the asset's
        // body; before it existed that body was the empty string by
        // construction, and the client wrote their own caption.
        caption: build!.copy.caption,
        about: build!.copy.about,
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
        // What the approved round had to adapt around, and the reviewer's own
        // verdict when it was not an approval. Omitted entirely when empty, so
        // a clean run persists the bytes it always did.
        ...(contentRepairs.length > 0 ? { contentRepairs } : {}),
        ...(build.visualQa !== undefined ? { visualQa: build.visualQa } : {}),
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

    // ── 14: what this run learned, handed back (C7 §3) ──
    //
    // Until D08's product table landed, this agent's runs were dispatched with
    // no learning context and collected nothing — it mapped to no platform, so
    // it drafted, delivered and silently learned nothing, which looked
    // completely healthy from the outside. This is the other half of that fix.
    await writeRunState(wf, tools, ctx, "14-write-run-state", {
      platform: "tiktok",
      deliverable: {
        kind: "branded-shorts-video",
        goal: goalLine.goal,
        ...(goalLine.audience !== undefined ? { audience: goalLine.audience } : {}),
        whyNow: goalLine.whyNow,
        type: "edited-short",
      },
      subjectRow: {
        subject: intake.takeaway,
        type: "edited-short",
        stage,
        goal: goalLine.goalText,
        status: "drafted",
        assetKind: "branded-shorts-video",
        // Never a strategy row: this agent picks no subject, so it can never
        // be spending one. See the note at `01b`.
        strategyRowId: null,
      },
      platformStateDelta: { postsByUs: 1, topics: [intake.takeaway] },
      readiness: learning.readiness,
    });

    return {
      outputPath: build.outputPath,
      durationSeconds: build.durationSeconds,
      deliverableId,
      copy: build.copy,
      overlayCount: build.plan.overlays.length,
      cutawayCount: build.plan.cutaways.length,
      contentCutsDeclared: cutPlan.contentCuts.length,
      graphicsAttempts: graphicsAttemptsUsed,
      renderWarnings: build.warnings,
      // SCRUM-242 (T-A10): same DEGRADED marker, on the workflow's own typed
      // return value — see 02c's own comment.
      ...(contextGrounding.decision === "degraded" ? { contextGrounding: contextGrounding.marker } : {}),
      ...(contentRepairs.length > 0 ? { contentRepairs } : {}),
    };
  };
}

/** Re-exported for tests that need to point at the same run-paths convention the workflow uses. */
export type { RunPaths };
