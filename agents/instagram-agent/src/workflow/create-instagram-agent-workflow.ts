import fs from "node:fs/promises";
import path from "node:path";
import { readForbiddenTopics } from "@agent-engine/core";
import type { AgentContext, AgentTool, AgentToolRegistry, GateResponse, ModelRouter, PromptStore, StyleEdit, TemplateFeedback } from "@agent-engine/core";
import { type WorkflowContext, type RevisionNote, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure, runAutoSetup, runReviewCycle, runTopicGuardrail, readRunDirection, revisionDirective, runDirectionField, buildClientIntelContext, buildClientVoiceContext, readCrossChannelHistory, crossChannelDirective, crossChannelAvoidTopics, socialAccountsFromClient, checkOutputDedupe, dedupeRetryDirective, readClientIntelContext, readContextDoc, enforceContextDocPolicy, toAgentContext, distillStylePreferences, varyLearnedStyle, buildTrendQueries, hasTopicSignalMaterial, pullTrendResearch, runTrendScout, researchDigestForScout, selectContentMode, trendCandidateForDrafting, type ContentMode, type DistilledStyle, type FeedbackEntryLike, type StyleVariationEntry, type TrendResearch, type TrendScoutOutput } from "@agent-engine/workflow";
import type { ClientBrand, ClientBrief, ClientKnowledge, ClientProfile, VoiceRules } from "@agent-engine/tools";
import type { InstagramFormat, InstagramTopicClaim as InstagramTopicClaimShape } from "./types.js";
import type { RenderCarouselInput, RenderCarouselResult } from "@agent-engine/tool-karos-publish";
import { InstagramAngleAgent } from "../agent/instagram-angle-agent.js";
import { InstagramBriefAgent } from "../agent/instagram-brief-agent.js";
import { InstagramCopyAgent } from "../agent/instagram-copy-agent.js";
import { InstagramImageVettingAgent } from "../agent/instagram-image-vetting-agent.js";
import { InstagramResearchAgent } from "../agent/instagram-research-agent.js";
import { InstagramVisualQaAgent } from "../agent/instagram-visual-qa-agent.js";
// Phase 2, item N — the Template Studio's three setup-time agents.
import { InstagramDesignBriefAgent } from "../agent/instagram-design-brief-agent.js";
import { InstagramTemplateDesignerAgent } from "../agent/instagram-template-designer-agent.js";
import { InstagramTemplateSetReviewAgent } from "../agent/instagram-template-set-review-agent.js";
import {
  assertSafeMarkup,
  buildCustomArchetypeDocument,
  buildStudioTemplateDocument,
  composeDocument,
  composeRawDocument,
  DEFAULT_QUALITY_STUDIO,
  extractSupportedFields,
  LEGACY_ARCHETYPE_IDS,
  materializeTemplates,
  promoteTemplate,
  reviewTemplate,
  setTemplateEnabled,
  TemplateDefinitionSchema,
  templateFileName,
  type TemplateDefinition,
  type TemplateStore,
} from "@agent-engine/tool-karos-templates";
import { brandLogoDataUri, downloadBrandLogo, parseBrandLogoDataUri, renderVisualPatternReference, type BrandLogoPlacement, type MediaLibraryEntry, type VisualPatternProfile } from "@agent-engine/tool-karos-media";
import { buildBrandHeadHtml, buildBrandLogoBodyHtml, deriveBrandRenderTokens, filterLearnedStyleToRing, planBrandLogo, type BrandRenderTokens } from "./brand-render-tokens.js";
import { buildScriptFontHeadForLanguage } from "./script-fonts.js";
import { adoptBriefTargetLanguage, resolveTargetLanguage } from "./target-language.js";
import {
  BRIEF_AGENT_SKILL_REF,
  briefForPrompt,
  buildBriefAgentInput,
  buildGroundedQuery,
  deriveClientBrief,
  gatherBriefSourceUrls,
  isBriefStale,
  isThinlyGrounded,
  resolveBriefFreshness,
  stampAgentBrief,
} from "./client-brief.js";
import { gatherTopicSignals } from "./topic-engines.js";
import { describeWithVision } from "./vision-annotation.js";
import { buildResearchLanes, normalizeDomain, orderDocumentsPrimaryFirst, pickPrimarySourceUrls, pullResearchLanes } from "./research-lanes.js";
import { dedupeFactCards, factCardsForPrompt } from "./fact-cards.js";
import {
  angleDecisionSummary,
  angleForCopyInput,
  angleUnavailable,
  factsForAnglePrompt,
  pastAnglesFromDecisions,
  selectAngle,
  type AngleDecision,
} from "./angle-selection.js";
import {
  relevanceFailureReason,
  relevanceFloor,
  relevanceSlidesFor,
  relevanceSteerFor,
  relevanceThinGroundingEvent,
  relevanceUnavailableEvent,
  runRelevanceJudge,
  type RelevanceVerdict,
} from "./relevance-gate.js";
import { rankTopicCandidates, recentModesFromDecisions, resolveTopicClaim, topicDecisionForGate, topicDecisionSummary } from "./topic-selection.js";
import {
  CANDIDATES_PER_PHOTO_SLIDE,
  DEFAULT_RUN_SHAPE,
  RUN_BUDGET_BELIEF_KEY,
  RunSpendMeter,
  STEP_COST_ESTIMATES_USD,
  estimateVsActualLine,
  formatUsd,
  maxCrossedNote,
  planRunBudget,
  readBudgetHistory,
  recordRunInHistory,
  remainingGenerationBudget,
  revisionEstimateUsd,
  summarizeRunBudget,
  targetCrossedNote,
  type RunBudgetDecision,
  // Phase 2, item N — the SEPARATE per-client setup budget (target $2.00,
  // hard max $3.00). Same module, so no new import graph; its own meter, so
  // `02j`'s `meter.totalUsd` never sees a dollar of setup spend.
  DEFAULT_SETUP_SHAPE,
  MAX_SETUP_SPEND_USD,
  planSetupBudget,
  readSetupBudgetHistory,
  recordSetupInHistory,
  SETUP_BUDGET_BELIEF_KEY,
  SETUP_STEP_COST_ESTIMATES_USD,
  setupEstimateVsActualLine,
  summarizeSetupBudget,
  TARGET_SETUP_SPEND_USD,
  type SetupBudgetDecision,
  type SetupBudgetSummary,
  type SetupShape,
} from "./run-budget.js";
import {
  ARCHETYPE_TEMPLATE_FILES,
  assembleSlidesData,
  buildVariationPlan,
  checkSlidesData,
  collectDeviceIssues,
  fallbackArchetypeFor,
  HERO_IMAGE_LAYOUTS,
  INVERTED_TEMPLATE_SUFFIX,
  invertedTemplateFileName,
  resolveLayout,
  type GroundFgInversionConfig,
  type SlideStyleOverride,
  type VariationPlanEntry,
} from "./slides-data.js";
import { deviceCssBlock } from "./slide-devices.js";
// ── Phase 2 (RFC-14) — the four modules the integrator wires ──
import {
  checkInterestFloor,
  checkSlidesInterestFloor,
  FLAT_BACKGROUND_CEILING,
  formatInterestFailures,
  IMAGERY_OR_DEVICE_FLOOR,
  interestDegradedReason,
  LARGEST_EMPTY_RECT_CEILING,
  OCCUPIED_SHARE_FLOOR,
  summarizeInterestFindings,
  TEXT_SHARE_CEILING,
  type InterestFloorReport,
} from "./interest-floor.js";
import { planInterestRelayout, type InterestRelayoutPlan } from "./interest-relayout.js";
import {
  buildSkeletonEntry,
  checkSkeletonVariety,
  readSkeletonHistory,
  recordSkeleton,
  rolesForSlideCount,
  skeletonAvoidList,
  skeletonGateFacts,
  SKELETON_BELIEF_KEY,
  SKELETON_RULE_SENTENCE,
  withMeasuredOccupancy,
  type SkeletonHistory,
  type SkeletonVarietyVerdict,
} from "./skeleton-memory.js";
import {
  buildAutoPromotionRequest,
  cleanShipsFor,
  CUSTOM_ARCHETYPE_BELIEF_KEY,
  readCustomArchetypeHistory,
  recordCleanShip,
  type CustomArchetypeHistory,
  type ShippedCustomArchetype,
} from "./custom-archetype-memory.js";
import { validateCustomArchetypeSlots } from "./custom-archetype-checks.js";
import {
  buildDesignBriefInput,
  buildDesignerInput,
  buildSetReviewInput,
  buildStudioPromotion,
  checkTemplateStudio,
  formatStudioFailures,
  isStudioTemplateId,
  planStudioTemplates,
  rankReferenceFormats,
  studioNote,
  studioSampleSeedFromBrief,
  summarizeStudio,
  validateStudioTemplate,
  type StudioCheck,
  type StudioEvidenceBundle,
  type StudioPromotion,
  type StudioReferencePost,
  type StudioReport,
  type StudioSetupAttempt,
  type StudioSlideMetrics,
  type StudioSlideProbe,
  type StudioTemplateDraft,
  type StudioTemplateValidation,
  type StudioValidationDeps,
} from "./template-studio.js";
// ── Phase 3 (RFC-14 items Q-T) — the four modules the integrator wires ──
import { InstagramArtDirectorAgent } from "../agent/instagram-art-director-agent.js";
import {
  buildArtDirection,
  buildVisualDirectionInput,
  checkVisualDirection,
  fallbackVisualDirection,
  finaliseVisualDirection,
  VISUAL_DIRECTION_ATTEMPT_BELIEF_KEY,
  VISUAL_DIRECTION_BELIEF_KEY,
  VISUAL_DIRECTION_RETRY_DAYS,
  type VisualDirection,
  type VisualDirectionAttempt,
  type VisualDirectionEvidenceBundle,
  type VisualPatternEvidence,
} from "./visual-direction.js";
import { generationPromptFor, needsImageSourcing, normaliseVisualNeed, retrievalQueryFor, vetSubjectFor } from "./scene-brief.js";
import { imageTreatmentCssBlock, resolveGenerationStyle, type GenerationStyle } from "./style-lock.js";
import {
  buildLibraryEntry,
  CLIENT_UPLOAD_RIGHTS,
  describeLibraryCandidate,
  groupShippedUses,
  ingestedSlotOf,
  libraryIngestRequest,
  selectLibraryCandidates,
  sceneTagsFor,
} from "./media-library.js";
import { checkCraftHygiene } from "./craft-hygiene.js";
import { checkExpectedScript, languageGateText, runLanguageFluency, LANGUAGE_FLUENCY_STEP_ID, LANGUAGE_SCRIPT_STEP_ID } from "./language-gate.js";
import {
  assessBrandAssetPresence,
  assessContrastFacts,
  buildElevatedVisualQaCriteria,
  checkDefaultRenderRules,
  checkPaletteWithinKit,
  DEFAULT_RENDER_RULES,
  formatDefaultRenderRuleFailures,
  LAYOUT_FIELD_KEYS,
  resolveRenderRules,
  templateBasename,
  type ContrastFact,
} from "./visual-qa-pre-checks.js";
import { parseStyleDirective, applyIntents, type StyleDirectiveResult, type StyleIntent, type StyleRefusal } from "./style-directive.js";
import {
  BrandTokensSchema,
  type BrandTokens,
  mergeStyleOverrides,
  MIN_CLAIM_MATCH,
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
  type SlideCustomArchetype,
  type StyleOverrides,
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
/**
 * The stable id a `custom` archetype uses everywhere it's referenced before
 * it is ever promoted: the gate payload's synthetic `chosen` entry, the
 * reviewer's own `templateFeedback.templateId`, and (if promoted)
 * `promoteTemplate`'s own `id`. One id, minted at drafting time, so nothing
 * downstream needs a separate lookup to connect the three.
 */
export function customArchetypeTemplateId(clientSlug: string, archetypeId: string): string {
  return `${clientSlug}:${archetypeId}`;
}

/**
 * IGSTYLE-3, §2.3 — the effective kit for ONE attempt: `baseline` (Layer 0,
 * frozen at `02c-load-brand-kit`) with `learned` (Layer 1, the durable prior)
 * and `directive` (Layer 2, this run's own binding instruction) merged on
 * top, L2 winning (`mergeStyleOverrides`'s own last-wins contract).
 *
 * Pure and uncheckpointed on purpose: every input is already checkpointed
 * (`rawBrand` at 02g, `baseline` at 02c, `learned` at 02h, `directive` inside
 * `04g-style-directive`), so re-deriving this on every call is deterministic
 * and free — no separate checkpoint boundary needed, and none of the
 * "resuming an in-flight run replays an old-shape checkpoint" risk that
 * justifies the actual checkpointed steps' own existence.
 *
 * Two refuse-to-guess exits, both taken before spending a re-derivation:
 *
 * 1. Nothing to apply (`rawBrand` absent AND both patches empty) — returns
 *    `baseline` verbatim. The overwhelmingly common case (every revision-0
 *    call, and any later round nobody asked to re-colour), and the one that
 *    keeps revision 0 byte-identical to today.
 * 2. Re-deriving would DROP the `--bg`/`--fg` pair `baseline` had — a
 *    `StyleRefusal`, and the baseline kit ships instead. `deriveBrandRenderTokens`
 *    already drops a ground/fg pair that fails the 4.5:1 floor rather than
 *    shipping it broken; the bug this closes is what happens next — silently
 *    losing color from a working slide because ONE directive/learned patch
 *    turned out to be illegible is strictly worse than the run's original,
 *    frozen colors. "Never silently discard" (§2.3) is enforced here, not
 *    only inside `parseStyleDirective`.
 */
export function effectiveBrandKit(
  rawBrand: unknown,
  brandTokens: BrandTokens,
  learned: StyleOverrides,
  directive: StyleOverrides,
  baseline: BrandRenderTokens | undefined,
): { kit: BrandRenderTokens | undefined; refusals: StyleRefusal[] } {
  const learnedEmpty = Object.keys(learned).length === 0;
  const directiveEmpty = Object.keys(directive).length === 0;
  if (rawBrand === undefined && learnedEmpty && directiveEmpty) {
    return { kit: baseline, refusals: [] };
  }

  const merged = mergeStyleOverrides(brandTokens.renderTokens, learned, directive);
  // `deriveBrandRenderTokens`'s own explicit-override ladder only treats
  // ground/fg as an override AT ALL when BOTH are set (protecting its
  // contrast-floor check, which needs a pair to measure) — otherwise it
  // falls through to full re-derivation from `rawBrand`, silently discarding
  // a directive that touched only one of the two. That is the overwhelmingly
  // common real case ("make the text orange" says nothing about the
  // background), so a single-role pick must not be lost: fill the untouched
  // half from the CURRENT baseline's own resolved value before handing the
  // pair to `deriveBrandRenderTokens`. `finalize` (in `style-directive.ts`)
  // already checked the resulting pair against the contrast floor using
  // this exact baseline as context, so this fill-in cannot smuggle in a pair
  // that check would have refused.
  const groundFgFilled: StyleOverrides = { ...merged };
  if (merged.ground !== undefined && merged.fg === undefined && baseline?.cssVars["--fg"] !== undefined) {
    groundFgFilled.fg = baseline.cssVars["--fg"];
  }
  if (merged.fg !== undefined && merged.ground === undefined && baseline?.cssVars["--bg"] !== undefined) {
    groundFgFilled.ground = baseline.cssVars["--bg"];
  }
  const rederived = deriveBrandRenderTokens(rawBrand, { ...brandTokens, renderTokens: groundFgFilled });

  const baselineHadPair = baseline?.cssVars["--bg"] !== undefined && baseline?.cssVars["--fg"] !== undefined;
  const rederivedHasPair = rederived?.cssVars["--bg"] !== undefined && rederived?.cssVars["--fg"] !== undefined;
  if (baselineHadPair && !rederivedHasPair) {
    const refusal: StyleRefusal = {
      role: "pair",
      requested: `ground=${merged.ground ?? "(baseline)"} / fg=${merged.fg ?? "(baseline)"}`,
      reason:
        "re-deriving the brand kit with this round's merged style overrides dropped the ground/fg pair the baseline " +
        "kit had (most likely the pair failed deriveBrandRenderTokens's own contrast floor) — falling back to the " +
        "baseline kit rather than shipping this attempt with no ground/fg at all",
    };
    return { kit: baseline, refusals: [refusal] };
  }

  return { kit: rederived, refusals: [] };
}

/**
 * Validates every `layout: "custom"` slide's markup for THIS attempt and
 * returns the ones that passed — `resolveLayout` downgrades anything
 * missing, unvalidated, or a repeat within the carousel to `text_only`, so a
 * rejected or hallucinated custom archetype degrades exactly like a
 * `stat_callout` missing its `stat` does, never holding the run.
 *
 * Deliberately pure and re-derived every attempt from the checkpointed
 * `copy` — never itself checkpointed, for the same reason
 * `ensureTemplatesOnDisk` isn't: a validation result is only as good as the
 * file it describes actually being on THIS instance's disk, and re-deriving
 * both from the same checkpointed source on every attempt is what keeps
 * them from drifting apart across a resume on a different Cloud Run
 * instance.
 */
export function validateCustomArchetypes(copy: InstagramCopyOutput): SlideCustomArchetype[] {
  const validated: SlideCustomArchetype[] = [];
  for (const slide of copy.slides) {
    if (slide.layout !== "custom" || !slide.customArchetype) continue;
    const archetype = slide.customArchetype;
    // Belt-and-suspenders beyond the schema's own `custom_` regex: this
    // archetype's file lands in the SAME per-run directory the five real
    // structured archetypes' files do, and a collision would silently
    // overwrite one of them mid-run.
    if (LEGACY_ARCHETYPE_IDS.has(archetype.archetypeId)) {
      console.error(
        `validateCustomArchetypes: archetypeId "${archetype.archetypeId}" collides with a real archetype id — refusing rather than risking an overwrite`,
      );
      continue;
    }
    const safety = assertSafeMarkup(archetype.bodyHtml, archetype.css, archetype.slots);
    if (!safety.ok) {
      console.error(`validateCustomArchetypes: "${archetype.archetypeId}" failed its markup safety check: ${safety.reason}`);
      continue;
    }
    // Phase 2, item O (RFC-14): the slot contract, free and pre-render.
    // `fillTemplate` substitutes what it is handed and leaves the rest, so a
    // `{{price}}` nothing supplies reaches the slide as literal text and
    // nothing downstream fails — it just ships a hole. Refusing here sends
    // the slide down the same degrade ladder a `stat_callout` with no `stat`
    // takes, which is the honest outcome.
    const slots = validateCustomArchetypeSlots(archetype);
    if (!slots.ok) {
      console.error(`validateCustomArchetypes: "${archetype.archetypeId}" failed its slot contract: ${slots.reason}`);
      continue;
    }
    validated.push(archetype);
  }
  return validated;
}

/**
 * Builds the full, self-contained document `composeDocument`/the renderer
 * expect, from a validated custom archetype — branded like every other
 * template when the run has brand fragments.
 *
 * `extraHeadHtml` (Phase 2, item M) is the shared device stylesheet, passed
 * on every path so a custom archetype that renders a `{{html:device}}`
 * fragment is styled exactly as a bundled archetype's device is. It is a
 * parameter rather than part of the brand head for the reason
 * `composeDocument`'s own doc comment gives: a brandless client has no brand
 * head at all, and that is precisely the client this must not silently skip.
 */
export function composeCustomArchetypeDocument(
  archetype: SlideCustomArchetype,
  brandHeadHtml?: string,
  brandBodyHtml?: string,
  extraHeadHtml?: string,
): string {
  const definition = TemplateDefinitionSchema.parse({
    id: customArchetypeTemplateId("preview", archetype.archetypeId),
    archetypeId: archetype.archetypeId,
    name: archetype.name,
    layoutType: "typographic" as const,
    htmlTemplate: buildCustomArchetypeDocument(archetype.bodyHtml),
    cssStyles: archetype.css,
    source: "ai_generated" as const,
  });
  return composeDocument(definition, brandHeadHtml, brandBodyHtml, extraHeadHtml);
}

async function persistReviewFeedback(
  wf: WorkflowContext,
  tools: AgentToolRegistry,
  ctx: AgentContext,
  input: {
    revision: number;
    response: GateResponse;
    templateFeedback: readonly TemplateFeedback[];
    templateStore?: TemplateStore | undefined;
    /**
     * Every `custom` archetype THIS run drafted (across every revision so
     * far), keyed by the same `customArchetypeTemplateId` scheme the gate
     * payload used. `persistReviewFeedback` is a module-level function with
     * no closure access to a draft's `copy` — this is how it learns a
     * `templateFeedback.templateId` names a run-generated design rather than
     * an already-registered row.
     */
    customArchetypesByTemplateId?: ReadonlyMap<string, SlideCustomArchetype> | undefined;
    /**
     * SCRUM-306 (AU23): this round's full draft, verbatim — attached to the
     * feedback row only on `reject` (see `persistReviewFeedbackToMemory`'s
     * doc for why: an approval already has a durable copy via
     * `ledger.writeDeliverable`, and a revise round's draft is superseded by
     * the next attempt). Serialized here rather than in the shared helper,
     * same reason that helper takes `content` as a plain string rather than
     * a generic `output: T` — Layer 1 makes no content judgments, so nothing
     * shared knows how to turn a `DraftResult` into text.
     */
    content?: string | undefined;
    /**
     * IGSTYLE-5, §2.4 writer 1 — this round's resolved style directive
     * (`DraftResult["styleDirectiveOutcome"]`, minus `refusals`, which
     * `StylePreferenceSchema` deliberately has no room for — see that
     * schema's own doc comment), so a future run's `distillStylePreferences`
     * has real evidence to vote over. `undefined` on the overwhelming
     * majority of rounds (nothing style-related was even attempted), exactly
     * like `styleDirectiveOutcome` itself.
     */
    style?: { overrides: Record<string, string>; source: "structured" | "parsed" | "model"; intents: StyleIntent[]; applied: string[] } | undefined;
  },
): Promise<void> {
  const note = input.response.feedback ?? input.response.reason;
  const append = tools["memory.appendFeedback"];
  // IGSTYLE-5 widens this gate from `note !== undefined` alone: a plain
  // approve carries no `feedback`/`reason` text at all (there is nothing a
  // person typed), but can still be the round that resolved a style
  // directive — the SAME directive a `revise` round before it produced,
  // carried forward because a revision's directive is resolved fresh every
  // attempt from the accumulated notes (§2.2), not only on the round that
  // first typed them. Without this widening, the overwhelmingly common
  // "revise once, then approve" review shape would only ever persist ONE
  // structured row (the revise round's), which rule 4's own threshold
  // ("one parsed sentence does not suffice") deliberately treats as not
  // enough evidence to learn from — the approve round's row is what a real
  // review naturally supplies to clear it, exactly like "written for every
  // decision including approvals" already promises for prose feedback.
  if ((note !== undefined || input.style !== undefined) && append !== undefined) {
    try {
      await wf.step.code(`09a-record-feedback-r${input.revision}`, async () =>
        append.execute(
          {
            feedbackId: `${wf.runId}-r${input.revision}`,
            productId: wf.productId,
            decision: input.response.decision,
            actor: input.response.actor,
            // `AppendFeedbackInputSchema.note` requires non-empty text
            // (`min(1)`) — a decision with structured style evidence and no
            // typed note still needs SOME note to satisfy that.
            note: note ?? `${input.response.decision} — no reviewer note this round (style directive carried over)`,
            revision: input.revision,
            runId: wf.runId,
            ...(input.content !== undefined ? { content: input.content } : {}),
            ...(input.style !== undefined ? { style: input.style } : {}),
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
        const store = input.templateStore!;
        // A `promote: true` on a run-generated custom archetype's FIRST
        // approval enrolls it into the registry — `promoteTemplate`'s own
        // seeded feedback entry already records this approval, so it is
        // called INSTEAD of `reviewTemplate`, never alongside it (stacking
        // `QUALITY_DELTA.approved` on top in the same turn would double-count
        // one human action as two). `store.get` first, rather than assuming
        // "not yet promoted": a reviewer who promotes the SAME archetypeId
        // again in a later revision round of this same run must land on the
        // ordinary review path instead — `promoteTemplate` has no
        // existence check of its own and would otherwise blind-overwrite the
        // row, resetting its quality score back to 40.
        // Phase 2, item N — APPROVING A STUDIO ROW IS FLIPPING `enabled`.
        //
        // A studio template is already IN the store (written disabled at
        // `00c8`), so the promotion path above is the wrong mechanism twice
        // over: `promoteTemplate` would blind-overwrite the row's markup and
        // reset its score, and `reviewTemplate` would move the score without
        // ever making the row eligible. `setTemplateEnabled` writes the flag
        // and appends the reviewer's own feedback entry, moves no score, and
        // is idempotent — so a second approval in a later revision round is a
        // no-op rather than a double count. A `revise` verdict on a studio id
        // keeps going to `reviewTemplate` below, exactly as today: −15, the
        // row stays disabled, two revises and it stops being picked at all.
        if (entry.promote && entry.verdict === "approved" && isStudioTemplateId(entry.templateId)) {
          const flipped = await setTemplateEnabled(
            store,
            entry.templateId,
            true,
            input.response.actor,
            entry.note,
            Date.now(),
          );
          return { templateId: entry.templateId, verdict: entry.verdict, enabled: true, changed: flipped.changed };
        }

        const customArchetype = input.customArchetypesByTemplateId?.get(entry.templateId);
        if (entry.promote && customArchetype !== undefined && (await store.get(entry.templateId)) === undefined) {
          await promoteTemplate({
            store,
            archetypeId: customArchetype.archetypeId,
            name: customArchetype.name,
            htmlTemplate: buildCustomArchetypeDocument(customArchetype.bodyHtml),
            cssStyles: customArchetype.css,
            layoutType: "typographic",
            source: "ai_generated",
            clientSlug: wf.clientSlug,
            actor: input.response.actor,
            note: entry.note,
            now: Date.now(),
            id: entry.templateId,
          });
          return { templateId: entry.templateId, verdict: entry.verdict, promoted: true };
        }

        await reviewTemplate({
          store,
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

    // IGSTYLE-5, §2.4 writer 2 — the registry write above teaches the
    // template-quality system (a DIFFERENT store: `templateStore`, keyed by
    // `archetypeId`, moving a single row's score). It has nothing to do with
    // `distillStylePreferences`, which only ever reads `memory.feedback` rows
    // keyed by `clientSlug`. Without this second, ADDITIONAL write, a
    // reviewer's per-slide template note would never reach that store at
    // all — "in addition to the registry write, which must not be replaced"
    // is the acceptance line this satisfies. `scope: "template"` is what lets
    // a later `memory.readFeedback` consumer (or a human) tell this row apart
    // from an ordinary post-level decision.
    if (append !== undefined) {
      try {
        await wf.step.code(`09a-template-feedback-r${input.revision}-s${entry.slide}-tpl`, async () =>
          append.execute(
            {
              feedbackId: `${wf.runId}-r${input.revision}-s${entry.slide}-tpl`,
              productId: wf.productId,
              decision: entry.verdict === "approved" ? "approve" : "revise",
              actor: input.response.actor,
              note: entry.note,
              revision: input.revision,
              runId: wf.runId,
              scope: "template",
              slide: entry.slide,
            },
            { ctx },
          ),
        );
      } catch (error) {
        console.error(`persistReviewFeedback: could not record durable template feedback for "${entry.templateId}"`, error);
      }
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
  /**
   * The fetch used for the brand-logo download. Defaults to the global
   * fetch; tests inject a fake so a logo "download" is deterministic and
   * offline, the same reason the render tool takes a fake in tests.
   */
  fetchImpl?: typeof fetch;
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

    // ── 00a: "Only media I upload for this job" with nothing uploaded ──
    //
    // Refused FIRST, before auto-setup, the topic claim and the research pull
    // spend a reservation and several model calls on a carousel that cannot be
    // made: a client-only run with no attachments has no pictures for its photo
    // slides and no permission to source any. 05z below keeps the same check as
    // a belt for a caller that reaches it another way.
    await wf.step.code("00a-check-media-source", () => {
      const attached = runDirection.mediaAssets.filter((a) => a.role === "source" || a.role === "reference").length;
      if (runDirection.mediaSource === "client" && attached === 0) {
        throw new WorkflowBlockedIntake(
          "this run was set to client-provided media only, but no images were attached — attach the pictures for the slides, or let the agent source them",
        );
      }
      return { mediaSource: runDirection.mediaSource, attached };
    });

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
      // The post format (2026-09): this run's own request first, then the
      // client's standing setting. Anything but the three known values is
      // ignored so a typo cannot switch a client's whole feed to single images.
      const isFormatChoice = (v: unknown): v is "carousel" | "single" | "auto" => v === "carousel" || v === "single" || v === "auto";
      const runFormat = (wf.input ?? {})["requestedFormat"];
      const requestedFormat = isFormatChoice(runFormat) ? runFormat : isFormatChoice(runConfig["instagramFormat"]) ? runConfig["instagramFormat"] : undefined;
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
        ...(requestedFormat !== undefined ? { requestedFormat } : {}),
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

    // ── The per-run budget: an estimate, an adapted plan, a live meter — never a hold (Phase 0 cost controls) ──
    //
    // The owner's rule (2026-09-09, binding): target $1.00, hard max $1.50,
    // and a limit never breaks a run. `02j-plan-run-budget` estimates the run
    // from the plan (attempts, images, evidence pulls, re-vets) calibrated by
    // this client's own history (`memory` beliefs, written back at 09b), and
    // when the estimate would exceed the target it ADAPTS the plan to fit, in
    // the owner's order — images capped, evidence pulls warm-cache only, one
    // return to step 05 instead of two, optional re-vets off — recording each
    // adaptation as a note the reviewer sees. Then the meter: every model step
    // adds `max(measured, estimate)` (a Gemini-on-Vertex step may report $0),
    // every scraper execution and generated image its unit cost. Crossing the
    // target stops OPTIONAL work; crossing the hard max finishes on the
    // cheapest complete path and delivers `degraded`. Every mandatory gate
    // (self-check, craft hygiene, language, relevance, rights) still runs.
    //
    // The meter is a plain object, recreated on every invocation: a resumed
    // run replays each checkpointed step below and re-adds its line, so no
    // checkpoint of its own is needed. Precision is not the point; the
    // posture is.
    const meter = new RunSpendMeter();
    /** Run notes about money, in the order they happened — the plan's note first, then each threshold the meter crossed. Shown on the gate payload and persisted with the deliverable. */
    const budgetNotes: string[] = [];
    const budgetCrossed = { target: false, max: false };
    /** `meter.add` plus the one-time crossing notes, so no call site has to remember to check. */
    const spend = (label: string, measuredUsd: number | undefined, estimateUsd: number): void => {
      meter.add(label, measuredUsd, estimateUsd);
      if (!budgetCrossed.target && meter.crossedTarget) {
        budgetCrossed.target = true;
        budgetNotes.push(targetCrossedNote(meter, label));
      }
      if (!budgetCrossed.max && meter.crossedMax) {
        budgetCrossed.max = true;
        budgetNotes.push(maxCrossedNote(meter, label));
      }
    };
    /** Images the `generate` rescue tier has requested this run, against the plan's `generatedImagesCap`. Run-scoped: the cap is per run, not per attempt. */
    let generatedSoFar = 0;

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
    // SCRUM-309 (AU31): prose is a real signal but not a reliable one — the
    // fix above still depends on someone's profile blurb happening to
    // mention a language. `client.getBrand`'s structured `language` field
    // (read here, independently of step 02c's frozen render-token copy of
    // the same brand kit — see that step's own comment for why they are
    // deliberately two separate calls) is threaded in as a third,
    // unconditional argument so a language requirement no longer depends on
    // which sentence a human happened to write it into.
    //
    // Best-effort and non-blocking on purpose: a client with no profile/voice
    // rules set up yet should still get a carousel, in English, same as
    // before this step existed — this step only ever ADDS context, it never
    // gates on finding any.
    const clientVoiceContext = await wf.step.code("02b-load-client-voice-context", async () => {
      const profileOutcome = await tools["client.getProfile"]?.execute({}, { ctx });
      const voiceOutcome = await tools["client.getVoiceRules"]?.execute({}, { ctx });
      const brandOutcome = await tools["client.getBrand"]?.execute({}, { ctx });
      return buildClientVoiceContext(
        profileOutcome?.status === "success" ? (profileOutcome.result as Record<string, unknown>) : undefined,
        voiceOutcome?.status === "success" ? (voiceOutcome.result as Record<string, unknown>) : undefined,
        brandOutcome?.status === "success" ? (brandOutcome.result as Record<string, unknown>) : undefined,
      );
    });

    // ── 02c: the client's Brand Kit — best-effort, never blocking ──
    //
    // `client/brand.json` has carried each client's real palette, fonts,
    // visualStyle and logo since the portal started projecting them, and
    // NOTHING in the render path ever read it — the only brand value that
    // reached a slide was `instagramBrandTokens.accentColor`, which is how
    // every client shipped the same generic dark design (RFC-03's own step-02
    // row lists `client.getBrand` as one of the two tools this step should
    // read; only `getConfig` ever was).
    //
    // A NEW step rather than an extension of 02b, deliberately: 02b's
    // checkpoint shape is already in production, and an in-flight run
    // resuming across this deploy would replay an old-shape checkpoint into
    // new-shape code. And a CHECKPOINTED step, deliberately: every later
    // consumer (the head-fragment build, re-materialization after an
    // instance recycle) reads this frozen value only, so a portal edit
    // mid-run cannot change the brand between attempt 1 and a revision.
    // `?? undefined` on BOTH sides of the checkpoint: a step's return value
    // round-trips through JSON, which has no `undefined` — a first run's
    // `undefined` comes back as `null` on a resumed run, and `null !==
    // undefined` would send a brandless client down the branded path with a
    // null kit (the exact crash a resumed gate-approval hit in tests).
    const brandKit =
      (await wf.step.code("02c-load-brand-kit", async () => {
        const brandOutcome = await tools["client.getBrand"]?.execute({}, { ctx });
        return (
          deriveBrandRenderTokens(brandOutcome?.status === "success" ? brandOutcome.result : undefined, frozen.brandTokens) ?? null
        );
      })) ?? undefined;

    // ── 02d: the client's target language — the language gate's subject ──
    //
    // SCRUM-310 (AU32). 02b folds the client's language into a PROMPT (a
    // requirement the drafting model is asked to follow); steps 07e/07f need
    // the bare value back out to CHECK that it was followed.
    //
    // Instagram Phase 0, item B (2026-09): this step used to read ONLY
    // `client.getBrand().language`, and that field was unset for every
    // sampled prep client — so the gate ran in none of ten prep runs,
    // including geektime's, whose Hebrew is stated in its profile prose.
    // `resolveTargetLanguage` now resolves in order: brand.language (wins,
    // returned verbatim) -> an explicit language statement in the profile
    // description / voice rules / brand-voice doc -> a script sniff of that
    // same prose. A single-language script (Hebrew, Greek, Thai, ...) resolves
    // to its language; a script several languages share (Cyrillic, Arabic,
    // Devanagari, Han) with no explicit statement is an honest unknown, and
    // the run HOLDS here (intake, not return-to-step: no redraft can answer
    // "which language does this client publish in") with the candidates and
    // the one-line remedy. `null` when nothing anywhere points at a
    // non-English language, AND when what it points at is English itself
    // (`brand.language: "en-US"`, "for English-speaking markets"): there is
    // nothing for a script check or a fluency judge to verify about English
    // copy for an English client, and switching the fail-closed gate on for
    // it would only add a per-attempt Haiku call and a judge-outage hold path
    // the brief scoped to non-English targets. Every other Latin-script
    // language (Spanish, French) still resolves and still gets both stages.
    //
    // Same id and the same `string | null` checkpoint shape as before, so an
    // in-flight run resuming across this deploy replays its old value
    // unchanged. Checkpointed, so a portal edit mid-run cannot change the
    // language between attempt 1 and a revision — the gate must judge against
    // the language the copy was actually drafted for. `?? undefined` across
    // the checkpoint boundary for the same JSON round-trip reason as 02c.
    // Named `resolvedTargetLanguage`, not `targetLanguage`: this is what the
    // brand record, profile, voice rules and brand-voice document say, and it
    // is what `stampAgentBrief` writes into the brief. The run's ONE target
    // language is decided once the brief is known (`adoptBriefTargetLanguage`,
    // just after 02i) — a brief may declare a language 02d cannot see, because
    // 02d does not read the client's site and `00b1` does.
    const resolvedTargetLanguage =
      (await wf.step.code("02d-load-target-language", async () => {
        const brandOutcome = await tools["client.getBrand"]?.execute({}, { ctx });
        const profileOutcome = await tools["client.getProfile"]?.execute({}, { ctx });
        const voiceOutcome = await tools["client.getVoiceRules"]?.execute({}, { ctx });
        // Best-effort inline read, not `readContextDoc`: that helper is a
        // step of its own, and this step's id/shape must not change.
        const brandVoiceOutcome = await tools["client.getContextDoc"]?.execute({ docType: "brand-voice" }, { ctx });
        const brandVoiceDoc = brandVoiceOutcome?.status === "success" ? (brandVoiceOutcome.result as { markdown?: unknown }).markdown : undefined;
        const resolution = resolveTargetLanguage({
          brandLanguage: brandOutcome?.status === "success" ? (brandOutcome.result as { language?: unknown }).language : undefined,
          profile: profileOutcome?.status === "success" ? (profileOutcome.result as Record<string, unknown>) : undefined,
          voiceRules: voiceOutcome?.status === "success" ? (voiceOutcome.result as Record<string, unknown>) : undefined,
          brandVoiceDoc: typeof brandVoiceDoc === "string" ? brandVoiceDoc : undefined,
        });
        if (resolution.status === "unresolved-non-english") {
          // The reason names the prose that actually decided
          // (`resolution.sourceLabel`), not "the profile": the script can come
          // from the voice rules or the brand-voice document, and telling
          // somebody to look at the profile when the Cyrillic is in a do-list
          // line sends them to the wrong field.
          throw new WorkflowHeld(
            `target language could not be resolved for this client: ${resolution.sourceLabel} is written in the ${resolution.script} script ` +
              `(candidates: ${resolution.candidates.join(", ")}) — set brand.language in the portal`,
          );
        }
        return resolution.status === "resolved" ? resolution.language : null;
      })) ?? undefined;

    // ── 00b-00b3: the persisted Client Brief, written by an agent (Phase 1, item H) ──
    //
    // Phase 0 derives a brief deterministically on every run: copied prose,
    // `confidence: "low"`, nothing judged. This is the document that replaces
    // it — ONE Sonnet call that reads the client's onboarding data, their own
    // site (three pages) and their own recent posts, and writes
    // `clients/<slug>/brief/instagram-brief.json`. Every step from the trend
    // scout to the relevance judge reads it for the next 30 days, so its
    // ~$0.16 (the call plus the page fetches) amortises to about a cent a run
    // at a weekly cadence — and a client's first run is the only one that
    // pays it in full.
    //
    // WHY HERE, and not immediately after `01-open-run` where the spec's
    // ordering section puts it: the gather step wants the frozen
    // `forbiddenTopics` (02) and the RESOLVED target language (02d). A stored
    // brief whose `language.target` disagreed with what `07e`/`07f` judge
    // against would send the writer and the language gate to two different
    // languages — the one inconsistency this document must not introduce.
    // It still runs before every other model call of the run (the trend scout
    // at `03c` is the next one), which is what the fixtures' turn order
    // promises, and before `02i-resolve-client-brief`, which is what makes a
    // freshly-written brief THIS run's brief rather than next run's.
    //
    // Setup never blocks a run (the roster-setup precedent): a malformed turn,
    // an exhausted turn budget, or a store that refuses the write becomes a
    // ledger warn, `02i` falls through to the deterministic brief, and the
    // next run retries. A human-authored brief is never refreshed at all.
    const briefCheck = await wf.step.code("00b-check-client-brief", async () => {
      const got = await tools["client.getBrief"]?.execute({ channel: "instagram" }, { ctx });
      // `client.getBrief` reports `not_available` both for "this client has no
      // brief" and for "there is a file but it no longer parses". Both
      // correctly resolve to create/refresh: an unreadable document is not a
      // document, and re-writing it is the only way out.
      const stored = got?.status === "success" ? (got.result as { brief: ClientBrief }).brief : undefined;
      const decision = resolveBriefFreshness(stored, new Date(), (wf.input ?? {})["refreshBrief"] === true);
      return {
        action: decision.action,
        reason: decision.reason,
        // `NaN` (an undatable `generatedAt`) is a refresh REASON, not an age;
        // it would cross the JSON checkpoint as `null` and read as a number.
        ...(decision.ageDays !== undefined && Number.isFinite(decision.ageDays) ? { ageDays: decision.ageDays } : {}),
        ...(stored !== undefined ? { generatedBy: stored.generatedBy } : {}),
        // The stored brief's declared language, for the budget plan below and
        // nothing else: `02j` has to know whether the fluency judge will run
        // on every attempt, and on a `reuse` run the brief can be the only
        // place that says so (`adoptBriefTargetLanguage`, after 02i). Absent
        // on a create/refresh run, where the document does not exist yet —
        // the estimate then misses one $0.0165 line rather than guessing.
        ...(typeof stored?.language.target === "string" && stored.language.target.trim().length > 0 ? { languageTarget: stored.language.target } : {}),
      };
    });

    // ── 02j: the run's budget plan, BEFORE the first paid call ──
    //
    // Reads this client's budget history out of the memory beliefs document
    // (`RUN_BUDGET_BELIEF_KEY`, written by 09b of every delivered run) and
    // fits the plan to the target. The shape is the conservative carousel
    // case — six photo slides, the fluency judge when 02d resolved a
    // language, four cold trend queries, `03e`'s eight signal executions,
    // `04a2`'s six lane queries, `04a3`'s two page fetches and one angle
    // proposal — because the format (04h) and the copy are not known yet and
    // an estimate must not flatter itself. Checkpointed so a resume keeps the
    // plan it started under.
    //
    // WHY HERE and not next to the other `02*` steps, which is where its id
    // says it belongs: `00b1`/`00b2` bill about $0.18 on a brief refresh, and
    // this step used to run after them — so a new client's first run fitted
    // its plan to the whole $1.00 with a fifth of it already spent, and the
    // step's own promise ("BEFORE the first paid call") was false on exactly
    // the runs that most needed it. `00b-check-client-brief` above is a free
    // store read whose answer (`refresh`/`create` vs `reuse`) is the one plan
    // fact this step could not otherwise know, so the plan now sits BETWEEN
    // the decision and the spending. `spentUsd` is belt and braces for the
    // same invariant: the plan is fitted to what is left of the target, so
    // adding a paid step above this one can never silently disarm the lever.
    // The id is unchanged, so an in-flight run resumes onto its own plan.
    const budgetDecision: RunBudgetDecision = await wf.step.code("02j-plan-run-budget", async () => {
      let history = readBudgetHistory(undefined);
      try {
        const read = await tools["memory.read"]?.execute({ scope: "beliefs" }, { ctx });
        if (read?.status === "success") history = readBudgetHistory((read.result as { beliefs?: unknown }).beliefs);
      } catch (error) {
        console.error("02j-plan-run-budget: could not read the budget history, planning from the defaults", error);
      }
      return planRunBudget(
        {
          ...DEFAULT_RUN_SHAPE,
          // The fluency judge runs on every attempt for any non-English
          // target, and the target can come from the stored brief as well as
          // from 02d (`adoptBriefTargetLanguage`).
          targetLanguage:
            resolvedTargetLanguage !== undefined ||
            (briefCheck.languageTarget !== undefined && adoptBriefTargetLanguage(undefined, briefCheck.languageTarget).language !== undefined),
          // Phase 1, item H: the Sonnet brief call and its source scrapes are
          // this run's cost only when `00b` asked for a fresh document.
          briefRefresh: briefCheck.action !== "reuse",
        },
        history,
        { spentUsd: meter.totalUsd },
      );
    });
    const budgetPlan = budgetDecision.plan;
    budgetNotes.push(budgetDecision.note);

    // ── 02k: the client's STRUCTURAL memory (Phase 2, item P) ──
    //
    // One free `memory.read({ scope: "beliefs" })`, parsed twice: the
    // shipped-skeleton history the `07k` variety check and the `05` avoid-list
    // read, and the run-authored-archetype ledger `09f`'s auto-promotion
    // counts against. Two parses of one read rather than two reads, so `09f`
    // needs no second round trip.
    //
    // Its own step id rather than a share of `02j`'s read, deliberately:
    // "why did this run avoid a stat cover" has to be legible in the run
    // trace, and a fact folded into the budget step's output is a fact
    // nobody debugging repetition will ever find. Inert on a first run —
    // `readSkeletonHistory(undefined)` is an empty history — so a client with
    // no history, or a registry with no `memory.read` at all, drafts exactly
    // as it did before item P.
    const structuralMemory = await wf.step.code("02k-read-structural-memory", async () => {
      let beliefs: unknown;
      try {
        const read = await tools["memory.read"]?.execute({ scope: "beliefs" }, { ctx });
        if (read?.status === "success") beliefs = (read.result as { beliefs?: unknown }).beliefs;
      } catch (error) {
        console.error("02k-read-structural-memory: could not read the beliefs document, planning from an empty history", error);
      }
      return { skeletons: readSkeletonHistory(beliefs), customArchetypes: readCustomArchetypeHistory(beliefs) };
    });
    const skeletonHistory: SkeletonHistory = structuralMemory.skeletons;
    /** The last five shipped layout sequences, newest first — the copy prompt's avoid-list (item P, prompt @14 §21). Empty on a first run. */
    const recentSkeletons = skeletonAvoidList(skeletonHistory);
    /** Item O's ledger of run-authored designs, advanced by `09f` and written back at `09b`. */
    let customArchetypeHistory: CustomArchetypeHistory = structuralMemory.customArchetypes;

    /**
     * What the brief lifecycle did this run — `undefined` when the stored
     * brief was reused (the overwhelming majority of runs). A non-`written`
     * status is the honest signal on the gate payload that this run drafted
     * from the deterministic stand-in.
     */
    let briefWriteOutcome: { status: "written" | "brief-agent-failed" | "brief-write-refused"; reason?: string; sourceNotes?: string[] } | undefined;
    if (briefCheck.action !== "reuse") {
      // Every source read INLINE rather than through `readContextDoc`: that
      // helper is a checkpointed step of its own, and five more step ids for
      // documents only this once-a-month call reads would clutter every run
      // record. Nothing here throws and nothing holds — each failure is a
      // named string that becomes one of the agent's own `gaps`.
      const gathered = await wf.step.code("00b1-gather-brief-sources", async () => {
        const problems: string[] = [];
        const readObject = async <T,>(toolName: string, input: Record<string, unknown> = {}): Promise<T | undefined> => {
          const tool = tools[toolName];
          if (tool === undefined) {
            problems.push(`${toolName} is not registered for this client`);
            return undefined;
          }
          try {
            const outcome = await tool.execute(input, { ctx });
            if (outcome.status === "success" && outcome.result !== null && typeof outcome.result === "object") return outcome.result as T;
            // `not_available` is "nothing set up yet", which
            // `buildBriefAgentInput` already turns into a named gap; anything
            // else is a real failure worth naming separately.
            if (outcome.status !== "not_available") {
              problems.push(`${toolName} reported ${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""}`);
            }
            return undefined;
          } catch (error) {
            problems.push(`${toolName} could not be read: ${(error as Error).message}`);
            return undefined;
          }
        };

        const profile = await readObject<ClientProfile>("client.getProfile");
        const brand = await readObject<ClientBrand>("client.getBrand");
        const voiceRules = await readObject<VoiceRules>("client.getVoiceRules");
        const knowledge = await readObject<ClientKnowledge>("client.getKnowledge");
        const config = await readObject<Record<string, unknown>>("client.getConfig");

        const contextDocs: Record<string, string | undefined> = {};
        for (const docType of ["product-information", "target-audience", "market-strategy", "brand-voice", "competitor-analysis"] as const) {
          const doc = await readObject<{ markdown?: unknown }>("client.getContextDoc", { docType });
          // An absent or empty document is passed as `undefined` on purpose:
          // `buildBriefAgentInput` then names it as a gap instead of handing
          // the model an empty document to write around.
          contextDocs[docType] = typeof doc?.markdown === "string" && doc.markdown.trim().length > 0 ? doc.markdown : undefined;
        }

        // The client's own intel report, distilled by the same helper `04f`
        // uses — read inline here because `04f` runs much later, after the
        // topic is claimed.
        const intelReport = await readObject<{ report?: unknown }>("intel.getReport");
        const intelContext = intelReport === undefined ? undefined : buildClientIntelContext(intelReport.report);

        let scraperExecutions = 0;

        // The client's own site: home, /about, /pricing. Skipped entirely
        // (not called with an empty array, which the tool's schema refuses)
        // when the profile carries no usable website.
        let sitePages: Array<{ url: string; title?: string; text: string }> = [];
        const urls = gatherBriefSourceUrls(profile);
        const fetchPages = tools["research.fetchPages"];
        if (urls.length === 0) {
          // `buildBriefAgentInput` names this gap itself; nothing to add.
        } else if (fetchPages === undefined) {
          problems.push("research.fetchPages is not registered, so the client's own site was not read");
        } else {
          try {
            const outcome = await fetchPages.execute({ urls, maxChars: 4000 }, { ctx });
            if (outcome.status === "success") {
              const result = outcome.result as { pages: Array<{ url: string; title?: string; text: string; fromCache: boolean }>; problems: string[] };
              sitePages = result.pages.map((p) => ({ url: p.url, ...(p.title !== undefined ? { title: p.title } : {}), text: p.text }));
              scraperExecutions += result.pages.filter((p) => !p.fromCache).length;
              for (const problem of result.problems) problems.push(`site: ${problem}`);
            } else {
              problems.push(`the client's own site could not be read (research.fetchPages reported ${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""})`);
            }
          } catch (error) {
            problems.push(`the client's own site could not be read: ${(error as Error).message}`);
          }
        }

        // The client's own recent posts — the only OBSERVED evidence of their
        // register, as opposed to what their voice rules claim it is. A 24h
        // window shares its cache with `04e`'s read of the same accounts.
        let ownPosts: Array<{ platform: string; username: string; url: string; excerpt: string; publishedAt?: string }> = [];
        const accounts = socialAccountsFromClient(config, brand as Record<string, unknown> | undefined);
        const socialHistory = tools["research.socialHistory"];
        if (accounts.length === 0) {
          problems.push("the client's config and brand kit name no social accounts, so none of their own posts were read");
        } else if (socialHistory === undefined) {
          problems.push("research.socialHistory is not registered, so none of the client's own posts were read");
        } else {
          try {
            const outcome = await socialHistory.execute({ accounts, window: "24h" }, { ctx });
            if (outcome.status === "success") {
              const result = outcome.result as {
                posts: Array<{ platform: string; username: string; url: string; excerpt: string; publishedAt?: string }>;
                problems: string[];
                fromCache: boolean;
              };
              ownPosts = result.posts;
              if (!result.fromCache) scraperExecutions += accounts.length;
              for (const problem of result.problems) problems.push(`own account: ${problem}`);
            } else {
              problems.push(`the client's own posts could not be read (${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""})`);
            }
          } catch (error) {
            problems.push(`the client's own posts could not be read: ${(error as Error).message}`);
          }
        }

        const build = buildBriefAgentInput({
          profile,
          brand,
          voiceRules,
          knowledge,
          contextDocs,
          intelContext,
          sitePages,
          ownPosts,
          problems,
          targetLanguage: resolvedTargetLanguage,
          forbiddenTopics: frozen.forbiddenTopics,
        });
        return { ...build, scraperExecutions };
      });
      if (gathered.scraperExecutions > 0) {
        spend("00b1-gather-brief-sources", undefined, gathered.scraperExecutions * STEP_COST_ESTIMATES_USD.scraperExecution);
      }

      const briefAgent = new InstagramBriefAgent({ router: options.router, tools, promptStore: options.promptStore });
      const briefExec = await wf.step.agent("00b2-write-client-brief", briefAgent, gathered.input);
      spend("00b2-write-client-brief", briefExec.totalCostUsd, STEP_COST_ESTIMATES_USD.brief);

      briefWriteOutcome = await wf.step.code(
        "00b3-persist-client-brief",
        async (): Promise<{ status: "written" | "brief-agent-failed" | "brief-write-refused"; reason?: string; sourceNotes?: string[] }> => {
          /** One warn row so an operator can see that this run drafted from the stand-in, and why. Idempotent on `(runId, eventId)`. */
          const recordUnavailable = async (reason: string): Promise<void> => {
            try {
              await tools["ledger.appendEvent"]?.execute(
                {
                  runId: wf.runId,
                  eventId: `${wf.runId}__client-brief-unavailable`,
                  level: "warn",
                  message: `the client brief could not be written this run (${reason}) — this post was drafted from the deterministic brief, and the next run retries`,
                },
                { ctx },
              );
            } catch (error) {
              console.error("00b3-persist-client-brief: could not record the brief-unavailable warn", error);
            }
          };

          if (briefExec.status !== "completed" || briefExec.finalOutput === undefined || briefExec.finalOutput === null) {
            const reason = `the brief agent resolved to "${briefExec.status}"`;
            await recordUnavailable(reason);
            return { status: "brief-agent-failed", reason };
          }
          // `targetLanguage` overrides the model's own `language.target` —
          // `02d` resolved it with a documented precedence, and this document
          // outlives the run that wrote it.
          //
          // `presentSources` overrides the model's own `sources` the same way,
          // and for a sharper reason: that list is what `isThinlyGrounded`
          // reads, so left verbatim it would let the writer of the brief set
          // the relevance gate's own passing score (3/5 down to 2/5) by
          // under-reporting what it read. `stampAgentBrief` reconciles it
          // against what `00b1` actually supplied — every grounding-bearing
          // row this run read is stamped in, every row it did not supply is
          // dropped — and hands back the corrections, which ride on the step
          // record so the difference is visible rather than silent.
          const stamped = stampAgentBrief(briefExec.finalOutput, {
            targetLanguage: resolvedTargetLanguage,
            agentSkillRef: BRIEF_AGENT_SKILL_REF,
            presentSources: gathered.presentSources,
          });
          const sourceNotes = stamped.sourceNotes;
          if (sourceNotes.length > 0) console.warn(`00b3-persist-client-brief: ${sourceNotes.join("; ")}`);
          const write = await tools["client.writeBrief"]?.execute({ channel: "instagram", brief: stamped.brief }, { ctx });
          if (write === undefined || write.status !== "success") {
            // `content_fail` here is the store refusing the write, not a
            // fault: an invalid payload, or a human-authored brief on disk
            // that must not be overwritten.
            const reason =
              write === undefined
                ? "client.writeBrief is not registered for this client"
                : `client.writeBrief reported ${write.status}${"reason" in write ? `: ${write.reason}` : ""}`;
            await recordUnavailable(reason);
            return { status: "brief-write-refused", reason, ...(sourceNotes.length > 0 ? { sourceNotes } : {}) };
          }
          return { status: "written", ...(sourceNotes.length > 0 ? { sourceNotes } : {}) };
        },
      );
    }

    // ── 02e: the client's projected branding-guidelines context doc (C1/SCRUM-209, T-A9) ──
    //
    // instagram-agent is one of two agents this ticket calls "the agents that
    // read nothing" — before this step, nothing here ever called
    // `client.getContextDoc`, so a client's own visual-identity guidance
    // (logo/lockup rules, imagery do's and don'ts, palette usage beyond the
    // bare `accentColor` hex `instagramBrandTokens` already carries) never
    // reached the copy-writing prompt, even though this is a VISUAL post
    // whose `visualNeed`s and archetype choices are exactly what such
    // guidance is meant to steer. `branding-guidelines` (not `brand-voice`)
    // is the deliberate choice here: voice/tone already reaches this prompt
    // through `clientVoiceContext` (02b) and `client.getBrand`'s structured
    // fields (02c/02d); what was missing is the client's stated visual
    // identity rules, which is what `branding-guidelines` actually is.
    //
    // Best-effort and non-blocking, same as every other optional context
    // read here (02b/04f): a client with no projected branding-guidelines
    // doc yet drafts exactly as this workflow did before this step existed —
    // T-A10, not this ticket, decides whether a MISSING doc should ever
    // change that.
    const brandingGuidelines = await readContextDoc(wf, tools, ctx, "branding-guidelines", "02e-load-branding-guidelines");

    // ── 02f: SCRUM-242 (T-A10) — stop failing open. instagram-agent's row in the
    // one shared policy table (CONTEXT_DOC_POLICY) is DEGRADED, not BLOCK: this is
    // channel copy a human reviews before it ships, so the run still completes —
    // but the marker `enforceContextDocPolicy` returns is what makes "this ran
    // with zero real grounding" visible instead of indistinguishable from a
    // genuinely grounded post (the ticket's own "worst of the three options").
    // Threaded into the deliverable AND the workflow's own return value below —
    // see those sites' own comments for why a step checkpoint alone isn't enough.
    const contextGrounding = await wf.step.code("02f-enforce-context-doc-policy", () =>
      enforceContextDocPolicy({ agentId: "instagram-agent", docs: { "branding-guidelines": brandingGuidelines } }),
    );

    // ── 02g: the RAW brand kit (IGSTYLE-3, §2.3) ──
    //
    // `02c` above only ever kept `deriveBrandRenderTokens`'s OUTPUT. Applying a
    // learned/directive style patch means re-deriving with a merged
    // `renderTokens`, and re-deriving needs the raw `client.getBrand()` object
    // 02c itself derived from — never checkpointed anywhere until now.
    //
    // A NEW step rather than a widened 02c, for the exact reason 02c/02d's own
    // comments give: an in-flight run resuming across this deploy would replay
    // an old-shape checkpoint into new-shape code. Named `02g` (not the spec
    // draft's `02e`) because `02e`/`02f` were already taken by SCRUM-209/242's
    // branding-guidelines/context-doc-policy steps by the time this ticket
    // landed — same `?? undefined` JSON round-trip treatment as 02c/02d.
    const rawBrand =
      (await wf.step.code("02g-load-brand-kit-raw", async () => {
        const brandOutcome = await tools["client.getBrand"]?.execute({}, { ctx });
        return brandOutcome?.status === "success" ? brandOutcome.result : null;
      })) ?? undefined;

    // ── 02h: the learned style prior (IGSTYLE-5) ──
    //
    // Layer 1 of §2.2's three-layer resolution — a PRIOR distilled from this
    // client's accumulated feedback, read once and frozen for the run so
    // another run's write mid-flight can't change it under this one (hence a
    // single `wf.step.code` call outside `draftOnce` — every attempt inside
    // the revision loop below sees the SAME frozen prior, never a re-read
    // that could drift between round 0 and round 1 of the same run).
    //
    // Best-effort and never blocking, same convention as `readPastFeedback`
    // right below in the same source file this reads from
    // (`packages/workflow/src/primitives/review-cycle.ts`): a memory read
    // failing, or `memory.readFeedback` simply not being wired for this
    // client, must not stop a run that can draft without a prior — it drafts
    // exactly as it did before this ticket existed (an empty `learned` patch
    // is invisible to `mergeStyleOverrides`).
    const distilledStyle: DistilledStyle = await wf.step.code("02h-learned-style-preferences", async () => {
      const read = tools["memory.readFeedback"];
      if (read === undefined) return { overrides: {}, strength: {}, intents: [], evidence: [] };
      try {
        const outcome = await read.execute({ productId: wf.productId, limit: 50 }, { ctx });
        if (outcome.status !== "success") return { overrides: {}, strength: {}, intents: [], evidence: [] };
        const entries = (outcome.result as { entries: FeedbackEntryLike[] }).entries;
        return distillStylePreferences(entries, { productId: wf.productId });
      } catch (error) {
        console.error(`02h-learned-style-preferences: could not read client style history for run ${wf.runId}, drafting without a prior`, error);
        return { overrides: {}, strength: {}, intents: [], evidence: [] };
      }
    });
    // `DistilledStyle["overrides"]` is a plain `Record<string, string>` keyed
    // by role (never any key `StyleOverrides` doesn't also accept — see
    // `distillStylePreferences`'s own role loop, which only ever considers
    // "ground"/"fg"/"accent") — structurally exactly a `StyleOverrides`
    // patch, just not spelled as one in that lower package (§ this file's
    // import comment on why `packages/workflow` cannot import this agent's
    // own types).
    const learnedStyle: StyleOverrides = distilledStyle.overrides;

    // ── 02i: the Client Brief — who this client is, for every step that has to know (Phase 0, item C) ──
    //
    // The 2026-09-08 prep audit: an AI marketing agency shipped a real-estate
    // carousel about first-time HOME buyers, approved at the gate, because the
    // run request was searched verbatim and no prompt or check ever said who
    // the client was. The brief is the one document that does: positioning,
    // ICP, offers, core terms, forbidden claims, language. Read by 04a (the
    // grounded research query), 05 (the copy prompt's §15), 07g (the relevance
    // judge) and the gate payload.
    //
    // A persisted brief (`client.getBrief`, written by Phase 1's setup agent or
    // a human) wins when it is fresh; otherwise — including on every Phase 0
    // run — `deriveClientBrief` builds one deterministically from the
    // onboarding data already on disk (`confidence: "low"`, never a hold). The
    // three C1 documents it reads are steps of their own (`readContextDoc`),
    // so they are read OUTSIDE this step; brand-voice already reaches the
    // prompt via 02b. `profile`/`voiceRules`/`brand`/`knowledge` are re-read
    // here rather than threaded from 02b's prose blob: the derivation wants
    // the structured objects, and a store read is cheap next to a stale brief.
    const productInformation = await readContextDoc(wf, tools, ctx, "product-information", "02i1-load-product-information");
    const targetAudience = await readContextDoc(wf, tools, ctx, "target-audience", "02i2-load-target-audience");
    const marketStrategy = await readContextDoc(wf, tools, ctx, "market-strategy", "02i3-load-market-strategy");
    const briefResolution = await wf.step.code(
      "02i-resolve-client-brief",
      async (): Promise<{ brief: ClientBrief; source: "persisted" | "derived"; notes: string[] }> => {
        const notes: string[] = [];
        const got = await tools["client.getBrief"]?.execute({ channel: "instagram" }, { ctx });
        if (got?.status === "success") {
          const { brief, ageDays } = got.result as { brief: ClientBrief; ageDays: number };
          if (!isBriefStale(brief)) return { brief, source: "persisted", notes };
          notes.push(`persisted brief is stale (generatedBy ${brief.generatedBy}, ${ageDays} day(s) old) — derived a fresh deterministic brief instead`);
        } else if (got !== undefined && got.status !== "not_available") {
          notes.push(`client.getBrief reported ${got.status}${"reason" in got ? `: ${got.reason}` : ""} — derived a deterministic brief instead`);
        }
        // Each read's `result` is the karos-client tool's own typed output;
        // a non-success outcome (nothing set up yet) reads as `undefined` and
        // the derivation records the gap.
        const resultOf = <T,>(outcome: { status: string; result?: unknown } | undefined): T | undefined =>
          outcome?.status === "success" && outcome.result !== null && typeof outcome.result === "object" ? (outcome.result as T) : undefined;
        const profile = resultOf<ClientProfile>(await tools["client.getProfile"]?.execute({}, { ctx }));
        const voiceRules = resultOf<VoiceRules>(await tools["client.getVoiceRules"]?.execute({}, { ctx }));
        const brand = resultOf<ClientBrand>(await tools["client.getBrand"]?.execute({}, { ctx }));
        const knowledge = resultOf<ClientKnowledge>(await tools["client.getKnowledge"]?.execute({}, { ctx }));
        const brief = deriveClientBrief({
          profile,
          voiceRules,
          brand,
          contextDocs: { productInformation, targetAudience, marketStrategy },
          knowledge,
          forbiddenTopics: frozen.forbiddenTopics,
          targetLanguage: resolvedTargetLanguage,
        });
        return { brief, source: "derived", notes };
      },
    );
    const brief = briefResolution.brief;

    // ── The run's ONE target language (Phase 1, closing audit defect 5's second door) ──
    //
    // `adoptBriefTargetLanguage` (pure, `target-language.ts`): 02d's answer
    // wins; failing that, a NON-English language the brief declares is
    // adopted by the whole run. Not just by the writer — the copy prompt makes
    // `language.target` binding (@13 §15), and before this every guard read
    // 02d's value instead: `07e-language-script` and `07f-language-fluency`
    // only run `if (targetLanguage !== undefined)`, and
    // `buildScriptFontHeadForLanguage` emits the Hebrew stack off the same
    // value. A geektime-shaped client whose Hebrew appears only on their own
    // pages (which 02d does not read and `00b1` does) therefore shipped
    // Hebrew copy in a Chromium fallback face with no script check and no
    // fluency judge at all. One value from here down.
    const languageAdoption = adoptBriefTargetLanguage(resolvedTargetLanguage, brief.language.target);
    const targetLanguage = languageAdoption.language;
    if (languageAdoption.note !== undefined) {
      // A run note, not a gate: the language is now consistent everywhere, and
      // what an operator needs to know is that it came from a document rather
      // than from the brand record they can edit.
      console.warn(`02i-resolve-client-brief: ${languageAdoption.note}`);
    }

    /**
     * The brand kit THIS attempt actually renders with — `brandKit` (Layer 0,
     * frozen at 02c) until `draftOnce` resolves a revision's own effective
     * kit (§2.3's `effectiveBrandKit`) and reassigns it, at which point every
     * consumer below (`brandLogoAssessment`, `brandFragments`, the palette/
     * accent/handle reads inside `draftOnce`) sees the NEW kit on its very
     * next call — the same "re-derive fresh every call, never cache across a
     * revision" rule `ensureTemplatesOnDisk`'s own doc comment already
     * requires for the on-disk template files.
     *
     * A plain mutable binding rather than a parameter threaded through every
     * one of those closures: this whole workflow function replays
     * deterministically from its checkpoints on every resume (`brandKit`
     * itself is exactly this same pattern — a `const` derived from a
     * checkpointed step), and the review cycle is a strict, single-threaded
     * loop (`runReviewCycle`'s own doc comment: "attempt -> buildGate -> gate
     * -> onDecision, one round fully resolves before the next begins") — so
     * there is never a moment two revisions' effective kits are live at once.
     * Reassigned once per revision inside `draftOnce`, never per attempt: the
     * style directive is revision-scoped (`04g-style-directive`), not
     * attempt-scoped, so every attempt within one revision correctly shares
     * one effective kit.
     */
    let effectiveKit: BrandRenderTokens | undefined = brandKit;

    /**
     * IGSTYLE-3 — which kit `ensureTemplatesOnDisk` last actually wrote to
     * disk, so a revision whose `effectiveKit` differs from round 0's forces
     * a re-materialization even when the files are still physically PRESENT
     * (the common case: the same Cloud Run instance handles every round of
     * one run, so the 9qkTWlg7e9ZLiVIZUok4 "instance recycled" trigger never
     * fires, but the CONTENT still has to change). Without this, a directive
     * would resolve correctly at `04g-style-directive` and then silently
     * never reach a single rendered pixel, because the presence check alone
     * has no way to know the file on disk is stale rather than merely
     * present — exactly the kind of silent loss this whole ticket exists to
     * close.
     *
     * The sentinel (rather than starting at `undefined`) matters: `undefined`
     * is itself a legal `effectiveKit` value (a brandless client), and this
     * must force a materialization on the very first call regardless of
     * whether that first kit happens to be `undefined`.
     */
    const NEVER_MATERIALIZED = Symbol("templates-never-materialized");
    let templatesMaterializedForKit: BrandRenderTokens | undefined | typeof NEVER_MATERIALIZED = NEVER_MATERIALIZED;

    const brandFetch = options.fetchImpl ?? fetch;
    let cachedLogoDataUri: string | undefined;
    /**
     * The brand logo, as a data URI. Embedded rather than referenced —
     * a `slide.images` path whose file vanished on a recycled instance is a
     * run-holding `content_fail`, and brand furniture must never be able to
     * hold a run. Memoized in-process, cached on the run's own disk for a
     * same-instance restart, re-fetched fresh after a recycle; a fetch
     * FAILURE is never memoized, so the next attempt tries again and a
     * transient outage costs one attempt's logo, not the run's.
     */
    const ensureBrandLogoDataUri = async (): Promise<string | undefined> => {
      if (effectiveKit?.logoUrl === undefined) return undefined;
      if (cachedLogoDataUri !== undefined) return cachedLogoDataUri;
      const cacheDir = path.resolve(options.repoRoot, ".media-cache", wf.runId, "brand");
      const cacheFile = path.join(cacheDir, "logo.datauri");
      const rootResolved = path.resolve(options.repoRoot);
      if (!cacheDir.startsWith(rootResolved + path.sep)) return undefined;
      try {
        cachedLogoDataUri = await fs.readFile(cacheFile, "utf8");
        return cachedLogoDataUri;
      } catch {
        // Not cached on this instance yet — fetch below.
      }
      const download = await downloadBrandLogo(brandFetch, effectiveKit.logoUrl);
      if (download === undefined) return undefined;
      cachedLogoDataUri = brandLogoDataUri(download);
      try {
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.writeFile(cacheFile, cachedLogoDataUri, "utf8");
      } catch {
        // A cache write failure costs a refetch, nothing else.
      }
      return cachedLogoDataUri;
    };

    /**
     * The one place this run decides whether a brand logo will render at all
     * this attempt, and (AU38, SCRUM-322) where it goes and whether it
     * survives this client's ground — from the mark's own decoded pixels
     * against the ground token the slide will actually render on, never from
     * a sentence in a prompt asking for a legible placement.
     *
     * Factored out of `brandFragments` (SCRUM-324/AU40) so the deterministic
     * visual-QA pre-check (step 08a2 below) can read the SAME placement
     * `brandFragments` itself renders from, rather than re-deriving it — the
     * two must never be able to disagree about whether a logo shipped this
     * attempt.
     */
    const brandLogoAssessment = async (): Promise<{ logoDataUri?: string; placement?: BrandLogoPlacement }> => {
      if (effectiveKit === undefined) return {};
      const logoDataUri = await ensureBrandLogoDataUri();
      const download = logoDataUri !== undefined ? parseBrandLogoDataUri(logoDataUri) : undefined;
      // IGSTYLE-3: planned against `effectiveKit`, not the frozen 02c kit —
      // change the ground and keep the old plan and you ship a black logo on
      // a black slide. An illegible mark against the NEW ground is omitted
      // exactly as it always was against the old one (`planBrandLogoPlacement`
      // itself decides that); this just makes sure it is asked about the
      // ground that will actually be under it.
      const placement =
        download !== undefined
          ? planBrandLogo(effectiveKit, download, { hasSeriesBadge: frozen.brandTokens.seriesBadge !== undefined })
          : undefined;
      return { ...(logoDataUri !== undefined ? { logoDataUri } : {}), ...(placement !== undefined ? { placement } : {}) };
    };

    /**
     * The fragments (head: font links + token sheet + badge variant; body:
     * the logo `<img>`) spliced into every rendered document. Re-derived from
     * `effectiveKit` on every call (IGSTYLE-3 — was the frozen `brandKit`) —
     * the string work is pure, and the one piece of I/O (the logo fetch)
     * degrades to "no logo this attempt" rather than ever failing a compose.
     */
    const brandFragments = async (): Promise<{ head?: string; body?: string }> => {
      // Instagram Phase 0, item A (2026-09): the script-font sheet is driven
      // by the TARGET LANGUAGE (02d), not by what the client declared, and is
      // emitted independently of the kit — a brandless Hebrew client used to
      // get no head fragment at all and rendered in Chromium's fallback face.
      // `undefined` for Latin/unknown/no language, so an English client's head
      // is byte-identical to before. Ordered `[scriptHead, brandHead]` per the
      // spec; the sheet's own selectors make it order-independent anyway.
      const scriptHead = buildScriptFontHeadForLanguage(targetLanguage, effectiveKit?.cssVars);
      if (effectiveKit === undefined) return scriptHead !== undefined ? { head: scriptHead } : {};
      const { logoDataUri, placement } = await brandLogoAssessment();
      // A plan whose decision is `omit` emits neither the rules nor the
      // `<img>`: an illegible mark ships as nothing, never as a smudge, and
      // never as a held run.
      const showLogo = logoDataUri !== undefined && placement !== undefined && placement.decision !== "omit";
      const head = [scriptHead, buildBrandHeadHtml(effectiveKit, showLogo ? { logo: placement } : {})].filter((s): s is string => s !== undefined).join("\n");
      return {
        head,
        ...(showLogo ? { body: buildBrandLogoBodyHtml(logoDataUri) } : {}),
      };
    };

    // Render-type rules (Fix 2) — evaluated post-render by step 08b, never by
    // step 07's checkSlidesData (which only ever evaluates `check: "copy"`
    // rules). Instagram Phase 0, item D (2026-09): `renderRules` was empty for
    // EVERY prep client, so 08b passed each run with "no render rules
    // provided". When the frozen config declares none, the four
    // `DEFAULT_RENDER_RULES` apply instead — checked deterministically at
    // `07h` before any render is spent, with only the residue code cannot
    // decide handed to the 08b judge. A client with its own render rules sees
    // zero change (`renderRuleSource === "client"`).
    const { source: renderRuleSource, rules: renderRules } = resolveRenderRules(frozen.styleConfig.rules);

    // ── 00c*: the Template Studio — 4-6 templates generated PER CLIENT, once ──
    //
    // Phase 2, item N (RFC-14). The owner's complaint was that the templates
    // are boring: a mostly-grey plate with a headline in the lower third is a
    // post nobody saves, and it is what the bundled typographic set renders
    // for a client whose brief has nothing photographable in it. The answer
    // is not a better prompt — it is a per-client SET of templates, each
    // derived from a format that measurably performs in that client's niche,
    // and each refused before it is stored unless a real Chromium render
    // MEASURES as something (the eight gates in `validateStudioTemplate`).
    //
    // Placed here, after `02i-resolve-client-brief` and `02i`'s language
    // adoption and before `03-claim-topic`, so the studio reads a fresh
    // brief, the frozen brand kit (02c) and the run's one target language —
    // and so a normal weekly run reaches `03` having spent nothing, because
    // `00c` resolves `reuse`.
    //
    // THREE INVARIANTS, and they are why this block looks the way it does:
    //
    //  1. **Nothing here may throw.** Every failure is a `ledger.appendEvent`
    //     warn and the block falls through; the bundled eight archetypes are
    //     always underneath, so a setup that goes badly costs variety and
    //     never a delivery. Setup never blocks a run (the roster-setup
    //     precedent, the same rule `00b1`/`00b2`/`00b3` already follow).
    //  2. **Its own meter.** `setupMeter` carries the owner's SECOND pair of
    //     numbers (target $2.00, hard max $3.00 per client per setup). The
    //     run meter never sees a dollar of it, so `02j`'s `spentUsd:
    //     meter.totalUsd` is unaffected regardless of ordering — which is
    //     what makes running after `02j` harmless.
    //  3. **Stored disabled.** `resolveBest` already skips `!enabled`, so
    //     until a human approves the set at `09a` this run and every run
    //     after it renders on the bundled archetypes while the portal can
    //     still see exactly what was generated.
    //
    // Gated on a configured `templateStore`: with no registry there is
    // nowhere to store a template and nothing that could ever route to one.
    /** Item N's report, for the `09a` payload and the deliverable. Absent on a run that resolved `reuse` with no store, i.e. most runs. */
    let studioReport: StudioReport | undefined;
    /**
     * The client's own pages, as `00c2-gather-format-evidence` fetched them —
     * hoisted so `00d`'s art director reads evidence this run ALREADY PAID
     * ScrappyCoco for.
     *
     * `undefined` means no fetch was made for this run (the studio resolved
     * `reuse`, so `00c2` never ran); `[]` means one was made and came back
     * with nothing. `buildVisualDirectionInput` reports those as two different
     * gaps, because "the site was not fetched" and "the site could not be
     * read" send a reviewer to two different places.
     */
    let clientSitePages: Array<{ url: string; title?: string; text: string }> | undefined;
    /** The setup budget's own estimate-vs-actual, reported exactly the way a run's is. Absent unless this run actually generated a set. */
    let setupBudgetSummary: SetupBudgetSummary | undefined;
    /** What `09b` records under `SETUP_BUDGET_BELIEF_KEY` so the NEXT setup starts calibrated. */
    let setupBudgetRecord: { estimatedUsd: number; actualUsd: number; templatesStored: number; templatesDropped: number; crossedTarget: boolean; crossedMax: boolean; adaptations: number } | undefined;

    // ── The setup meter, hoisted: ONE per-client setup budget over items N and Q ──
    //
    // Phase 3 (item Q) puts a second piece of setup work — the visual
    // direction at `00d*` — on the same $2.00 target / $3.00 hard max the
    // Template Studio spends against, and on the same plan (`00c1`'s fifth
    // lever is "visual direction off"). The meter therefore cannot live
    // inside the studio's `generate` branch any more: the 90-day direction
    // TTL expires inside the 120-day studio TTL, so the commonest Phase 3
    // setup is a direction derived on a run whose studio resolved `reuse`.
    // One meter, one plan, one estimate-vs-actual line, whichever halves ran.
    const setupNotes: string[] = [];
    const setupMeter = new RunSpendMeter({ targetUsd: TARGET_SETUP_SPEND_USD, maxUsd: MAX_SETUP_SPEND_USD, scope: "setup" });
    const setupCrossed = { target: false, max: false };
    /** `setupMeter.add` plus the one-time crossing notes — the setup twin of `spend`, reading the setup meter's own $2.00/$3.00. */
    const setupSpend = (label: string, measuredUsd: number | undefined, estimateUsd: number): void => {
      setupMeter.add(label, measuredUsd, estimateUsd);
      if (!setupCrossed.target && setupMeter.crossedTarget) {
        setupCrossed.target = true;
        setupNotes.push(targetCrossedNote(setupMeter, label));
      }
      if (!setupCrossed.max && setupMeter.crossedMax) {
        setupCrossed.max = true;
        setupNotes.push(maxCrossedNote(setupMeter, label));
      }
    };
    /** One warn row per setup problem. Best-effort inside a best-effort block: losing the row costs visibility, never the run. */
    const setupWarn = async (eventId: string, message: string): Promise<void> => {
      try {
        await tools["ledger.appendEvent"]?.execute({ runId: wf.runId, eventId: `${wf.runId}__${eventId}`, level: "warn", message }, { ctx });
      } catch (error) {
        console.error(`setup: could not record the warn "${eventId}"`, error);
      }
    };
    /**
     * `00c1-plan-setup-budget` — the setup plan, BEFORE the first paid setup
     * call of EITHER item.
     *
     * One step id and one call site reached from two places, because a setup
     * that builds templates and a setup that only re-derives the direction
     * are the same budget decision with a different `shape`. `planSetupBudget`
     * never refuses (owner's standing amendment applied to setup): it fits the
     * plan by dropping the reference-image pass, then the set review, then
     * templates down to four, then repairs, then the visual direction, then —
     * past the hard max only — below four templates with the reason recorded.
     */
    let setupDecision: SetupBudgetDecision | undefined;
    const planSetup = async (shape: SetupShape): Promise<SetupBudgetDecision> =>
      wf.step.code("00c1-plan-setup-budget", async () => {
        let history = readSetupBudgetHistory(undefined);
        try {
          const read = await tools["memory.read"]?.execute({ scope: "beliefs" }, { ctx });
          if (read?.status === "success") history = readSetupBudgetHistory((read.result as { beliefs?: unknown }).beliefs);
        } catch (error) {
          console.error("00c1-plan-setup-budget: could not read the setup history, planning from the defaults", error);
        }
        return planSetupBudget(shape, history);
      });
    /** Templates this setup actually stored / dropped — read by the one setup-budget report below, which now runs after `00d*`. */
    let setupTemplatesStored = 0;
    let setupTemplatesDropped = 0;

    if (options.templateStore !== undefined) {
      const templateStore = options.templateStore;
      /** The studio's half of the shared setup warn row. Kept as a local alias so every `00c*` call site reads unchanged. */
      const studioWarn = setupWarn;

      const studioCheck: StudioCheck = await wf.step.code("00c-check-template-studio", async (): Promise<StudioCheck> => {
        try {
          // `includeDisabled: true` is load-bearing, not defensive: a set
          // awaiting approval is invisible to the default query, so without
          // it the studio would regenerate over the exact rows a human has
          // been asked to look at — and bill for it again.
          const rows = await templateStore.list({ clientSlug: wf.clientSlug, includeDisabled: true });
          // The setup history, because a setup that STORED NOTHING leaves the
          // store exactly as it found it — so without this "no rows" reads as
          // "never tried" and the whole per-client setup bill is re-paid on
          // every subsequent run instead of once per 120 days. A free beliefs
          // read, and a failed one degrades to today's behaviour rather than
          // suppressing a setup that should happen.
          let setupHistory: readonly StudioSetupAttempt[] = [];
          try {
            const read = await tools["memory.read"]?.execute({ scope: "beliefs" }, { ctx });
            if (read?.status === "success") {
              setupHistory = readSetupBudgetHistory((read.result as { beliefs?: unknown }).beliefs).setups.map((setup) => ({
                at: setup.at,
                templatesStored: setup.templatesStored,
              }));
            }
          } catch (error) {
            console.error("00c-check-template-studio: could not read the setup history; a zero-store setup will not be remembered", error);
          }
          return checkTemplateStudio({
            setupHistory,
            rows: rows.map((row) => ({
              id: row.id,
              archetypeId: row.archetypeId,
              enabled: row.enabled,
              ...(row.updatedAt !== undefined ? { updatedAt: row.updatedAt } : {}),
              ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
              ...(row.role !== undefined ? { role: row.role } : {}),
              ...(row.derivedFrom !== undefined ? { derivedFrom: { formatLabel: row.derivedFrom.formatLabel } } : {}),
            })),
            refreshRequested: (wf.input ?? {})["refreshTemplates"] === true,
          });
        } catch (error) {
          // A registry outage must never trigger a generate: "I could not
          // read the rows" is not "there are no rows", and confusing the two
          // is how an outage bills a setup and overwrites a good set.
          const reason = `the template store could not be listed (${(error as Error).message}) — this run renders on whatever the registry already holds`;
          console.error(`00c-check-template-studio: ${reason}`);
          return { action: "reuse", reason, rows: [], archetypeIds: [], staleArchetypeIds: [], freshArchetypeIds: [] };
        }
      });

      if (studioCheck.action !== "generate") {
        studioReport = summarizeStudio({ check: studioCheck, stored: [], dropped: [] });
      } else {
        // ── 00c1: the setup plan, BEFORE the first paid setup call ──
        //
        // `visualDirection: true` since Phase 3: item Q's `00d*` block spends
        // against this same plan, and lever 5 is what turns it off. It is
        // planned here even though `00d` may later resolve `reuse` and spend
        // nothing — the estimate must not flatter itself (the same rule that
        // keeps `DEFAULT_RUN_SHAPE.photoSlides` at 6), and an unspent $0.075
        // shows up as an under-target actual that relaxes the next setup.
        const decision = await planSetup({ ...DEFAULT_SETUP_SHAPE, referenceAccounts: brief.referenceAccounts.length, visualDirection: true });
        setupDecision = decision;
        const setupPlan = decision.plan;
        setupNotes.push(decision.note);

        // ── 00c2: what actually performs in this niche, and what was missing ──
        //
        // ScrappyCoco only (owner's rule): the brief's own reference accounts
        // through `research.socialHistory` (a 24h window, sharing the cache
        // `00b1`/`03e`/`04e` already warm), and up to three pages of the
        // client's own site through `research.fetchPages`. The ranking is
        // CODE (`rankReferenceFormats`), per-account z-normalised, and it
        // states which engagement signals were present and which were
        // absent — `signalsAbsent` is required on every row, so a hole in the
        // evidence is visible rather than fillable.
        const evidence = await wf.step.code("00c2-gather-format-evidence", async () => {
          const problems: string[] = [];
          let scraperExecutions = 0;

          let posts: StudioReferencePost[] = [];
          const accounts = brief.referenceAccounts.slice(0, 6).map((row) => ({ platform: row.platform, username: row.handle }));
          const socialHistory = tools["research.socialHistory"];
          if (accounts.length === 0) {
            problems.push("the client brief names no reference accounts, so no competitor formats could be read");
          } else if (socialHistory === undefined) {
            problems.push("research.socialHistory is not registered, so no reference-account posts were read");
          } else {
            try {
              const outcome = await socialHistory.execute({ accounts, window: "24h" }, { ctx });
              if (outcome.status === "success") {
                const result = outcome.result as { posts: StudioReferencePost[]; problems: string[]; fromCache: boolean };
                posts = result.posts;
                if (!result.fromCache) scraperExecutions += accounts.length;
                for (const problem of result.problems) problems.push(`reference account: ${problem}`);
              } else {
                problems.push(`the reference accounts could not be read (${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""})`);
              }
            } catch (error) {
              problems.push(`the reference accounts could not be read: ${(error as Error).message}`);
            }
          }

          let sitePages: Array<{ url: string; title?: string; text: string }> = [];
          // The client's own site: home, /about, /pricing — the same three
          // `00b1` reads, so a refresh run's fetch is warm in the same cache.
          // Read from the profile here rather than threaded from `00b1`,
          // which only ran on a brief create/refresh.
          let profileForSite: ClientProfile | undefined;
          try {
            const got = await tools["client.getProfile"]?.execute({}, { ctx });
            if (got?.status === "success" && got.result !== null && typeof got.result === "object") profileForSite = got.result as ClientProfile;
          } catch (error) {
            problems.push(`the client profile could not be read: ${(error as Error).message}`);
          }
          const urls = gatherBriefSourceUrls(profileForSite).slice(0, 3);
          const fetchPages = tools["research.fetchPages"];
          if (urls.length === 0) {
            problems.push("the client's profile and brief name no website, so their own pages were not read");
          } else if (fetchPages === undefined) {
            problems.push("research.fetchPages is not registered, so the client's own site was not read");
          } else {
            try {
              const outcome = await fetchPages.execute({ urls, maxChars: 4000 }, { ctx });
              if (outcome.status === "success") {
                const result = outcome.result as { pages: Array<{ url: string; title?: string; text: string; fromCache: boolean }>; problems: string[] };
                sitePages = result.pages.map((p) => ({ url: p.url, ...(p.title !== undefined ? { title: p.title } : {}), text: p.text }));
                scraperExecutions += result.pages.filter((p) => !p.fromCache).length;
                for (const problem of result.problems) problems.push(`site: ${problem}`);
              } else {
                problems.push(`the client's own site could not be read (${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""})`);
              }
            } catch (error) {
              problems.push(`the client's own site could not be read: ${(error as Error).message}`);
            }
          }

          // The reference-post IMAGE pass the spec priced is not reachable on
          // a ScrappyCoco-only stack: `research.socialHistory` returns
          // `{ platform, username, url, excerpt, publishedAt?, engagement? }`
          // and no image URL at all, so there is nothing to hand
          // `media.inspectImages`. Named as an absent signal rather than
          // filled with a guess (`plan.referenceImages` is therefore never
          // billed here — the vision line this setup does spend is the one
          // look at OUR OWN rendered samples at `00c5`).
          if (setupPlan.referenceImages > 0) {
            problems.push(
              "no reference-post images were inspected: research.socialHistory returns post text and engagement, never image URLs, so there is nothing for media.inspectImages to look at — formats were ranked from post text alone",
            );
          }

          const ranked = rankReferenceFormats(posts);
          return { evidence: ranked, problems, postCount: posts.length, sitePages, scraperExecutions };
        });
        if (evidence.scraperExecutions > 0) {
          setupSpend("00c2-gather-format-evidence", undefined, evidence.scraperExecutions * SETUP_STEP_COST_ESTIMATES_USD.scraperExecution);
        }
        // Paid for once, read twice: the same three pages feed the design
        // brief here and the art director at `00d2`. Assigned even when the
        // fetch returned nothing, so `00d` can tell "fetched and empty" from
        // "never fetched".
        clientSitePages = evidence.sitePages;
        setupNotes.push(...evidence.evidence.notes);

        const fragments = await brandFragments();
        const studioKit = effectiveKit !== undefined ? { cssVars: effectiveKit.cssVars, palette: effectiveKit.palette } : undefined;
        const bundle: StudioEvidenceBundle = {
          clientSlug: wf.clientSlug,
          brief,
          ...(studioKit !== undefined ? { kit: studioKit } : {}),
          sitePages: evidence.sitePages,
          referenceFormats: evidence.evidence,
          ...(targetLanguage !== undefined ? { targetLanguage } : {}),
          problems: evidence.problems,
        };
        const designBriefBuild = buildDesignBriefInput(bundle, setupPlan.templates);

        // ── The render seam (gates 5, 6 and 8) ──
        //
        // The document code built is written into this run's own template
        // cache and rendered through the SAME `publish.renderCarousel` the
        // carousel itself uses — `measure: true, probe: true`, `canvas.scale:
        // 2` (`validateRenderInputs` refuses anything else, which is what
        // makes every measured PNG exactly 2160x2880). Not `createRenderCarousel()`
        // directly: a caller that swapped the renderer for this run must have
        // its validation renders go through the same one, or the studio is
        // measuring a different renderer than the run.
        const studioRenderDir = `.template-cache/${wf.runId}/studio`;
        const studioDeps: StudioValidationDeps = {
          assertSafeMarkup,
          buildStudioTemplateDocument,
          composeDocument,
          interest: {
            // `slide: 1` because a validation render IS one slide: the
            // findings' sentences name "slide 1" and that is honest — the
            // sample is the only slide there is.
            check: ({ metrics, probe, role }) => checkInterestFloor(metrics, probe, role, { slide: 1 }),
            thresholds: {
              largestEmptyRectCeiling: LARGEST_EMPTY_RECT_CEILING,
              occupiedShareFloor: OCCUPIED_SHARE_FLOOR,
              flatBackgroundCeiling: FLAT_BACKGROUND_CEILING,
              imageryOrDeviceFloor: IMAGERY_OR_DEVICE_FLOOR,
              textShareCeiling: TEXT_SHARE_CEILING,
            },
          },
          render: async (request) => {
            try {
              const absDir = path.resolve(options.repoRoot, studioRenderDir);
              const rootResolved = path.resolve(options.repoRoot);
              if (!absDir.startsWith(rootResolved + path.sep)) return { ok: false, reason: `the studio render directory escaped repoRoot (runId="${wf.runId}")` };
              await fs.mkdir(absDir, { recursive: true });
              const file = `studio-${request.archetypeId}-${request.dir}.html`;
              await fs.writeFile(path.join(absDir, file), request.document, "utf8");
              const outcome = await tools["publish.renderCarousel"]!.execute(
                {
                  client: wf.clientSlug,
                  postId: `studio-${request.archetypeId}-${request.dir}`,
                  templateDir: studioRenderDir,
                  outDir: `${studioRenderDir}/out`,
                  repoRoot: options.repoRoot,
                  slides: [
                    {
                      n: 1,
                      template: file,
                      fields: request.content.fields,
                      images: request.content.imagePaths,
                      htmlFragments: request.content.htmlFragments,
                    },
                  ],
                  canvas: { w: 1080, h: 1440, scale: 2, slides_min: 1, slides_max: 8 },
                  readyFlag: "__CAROUSEL_READY__",
                  measure: true,
                  probe: true,
                },
                { ctx },
              );
              if (outcome.status !== "success") {
                return { ok: false, reason: `publish.renderCarousel reported ${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""}` };
              }
              const first = (outcome.result as RenderCarouselResult).rendered[0] as
                | (RenderCarouselResult["rendered"][number] & { metrics?: StudioSlideMetrics; probe?: StudioSlideProbe; measureFailure?: string })
                | undefined;
              if (first === undefined) return { ok: false, reason: "the renderer returned no slide" };
              if (first.metrics === undefined || first.probe === undefined) {
                // A template whose sample cannot be MEASURED cannot be
                // stored: gate 6 is the whole answer to "is this template
                // boring", and storing a design nobody measured would be the
                // defect with extra steps.
                return { ok: false, reason: first.measureFailure ?? "the render produced no measurement, so the interest floor could not be applied to it" };
              }
              return { ok: true, metrics: first.metrics, probe: first.probe, slideUrl: first.path };
            } catch (error) {
              return { ok: false, reason: `the validation render failed: ${(error as Error).message}` };
            }
          },
        };

        const seedFor = (dir: "ltr" | "rtl") =>
          studioSampleSeedFromBrief({
            brief,
            ...(studioKit !== undefined ? { kit: studioKit } : {}),
            clientSlug: wf.clientSlug,
            ...(targetLanguage !== undefined ? { targetLanguage } : {}),
            dir,
          });

        /** The one look a vision model takes at OUR OWN rendered sample, for `00c6`'s set review. Best-effort and skipped on the cheapest path. */
        const describeSample = async (slideRef: string | undefined): Promise<string | undefined> => {
          const inspect = tools["media.inspectImages"];
          if (inspect === undefined || slideRef === undefined || setupMeter.posture === "cheapest-path") return undefined;
          try {
            const isUrl = /^https?:\/\//i.test(slideRef);
            const relative = isUrl ? undefined : path.isAbsolute(slideRef) ? path.relative(options.repoRoot, slideRef) : slideRef;
            if (relative !== undefined && relative.startsWith("..")) return undefined;
            const outcome = await inspect.execute(
              {
                repoRoot: options.repoRoot,
                images: [isUrl ? { ref: "sample", url: slideRef } : { ref: "sample", path: relative!.replace(/\\/g, "/") }],
                purpose: "candidate-vetting",
                brief: "a slide template's sample render: does it read as a designed plate a reader would stop on, or as a headline on an empty ground",
              },
              { ctx },
            );
            setupSpend("00c5-validate-template-sample-inspect", undefined, SETUP_STEP_COST_ESTIMATES_USD.sampleInspect);
            if (outcome.status !== "success") return undefined;
            const inspections = (outcome.result as { inspections: Array<Record<string, unknown>> }).inspections;
            const description = inspections[0]?.["description"];
            return typeof description === "string" ? description : undefined;
          } catch (error) {
            console.error("00c5-validate-template: the sample inspection failed, continuing without a description", error);
            return undefined;
          }
        };

        const dropped: Array<{ archetypeId: string; reason: string }> = [];
        const stored: Array<{ promotion: StudioPromotion; validation: StudioTemplateValidation }> = [];

        // ── 00c3: the format thesis, once for the whole set ──
        const designBriefAgent = new InstagramDesignBriefAgent({ router: options.router, tools, promptStore: options.promptStore });
        const designBriefExec = await wf.step.agent("00c3-write-design-brief", designBriefAgent, {
          ...designBriefBuild.input,
          gaps: designBriefBuild.gaps,
        });
        setupSpend("00c3-write-design-brief", designBriefExec.totalCostUsd, SETUP_STEP_COST_ESTIMATES_USD.designBrief);

        if (designBriefExec.status !== "completed" || designBriefExec.finalOutput === undefined || designBriefExec.finalOutput === null) {
          await studioWarn(
            "template-studio-brief-failed",
            `the template studio's design brief resolved to "${designBriefExec.status}" — no templates were generated this run, and the bundled archetypes carried it`,
          );
          setupNotes.push(`the design brief resolved to "${designBriefExec.status}", so no templates were authored`);
          studioReport = summarizeStudio({ check: studioCheck, stored: [], dropped: [], evidence: evidence.evidence, notes: setupNotes });
        } else {
          const designBrief = designBriefExec.finalOutput;
          const plan = planStudioTemplates(designBrief, {
            budgetTemplates: setupPlan.templates,
            // FRESH rows only. `archetypeIds` carries the stale rows too, and
            // a TTL refresh exists to re-author exactly those — passing the
            // full list makes every proposal a "duplicate" and the refresh
            // authors nothing while re-paying the setup bill on every run.
            existingArchetypeIds: studioCheck.freshArchetypeIds,
          });
          for (const rejection of plan.rejected) {
            setupNotes.push(`${rejection.archetypeId}: ${rejection.reason}`);
            await studioWarn(`template-studio-rejected-${rejection.archetypeId}`, `template studio: ${rejection.archetypeId} was not authored — ${rejection.reason}`);
          }

          const designerAgent = new InstagramTemplateDesignerAgent({ router: options.router, tools, promptStore: options.promptStore });

          /** One planned template as it moves through the battery: authored, validated, reviewed, maybe repaired, maybe stored. */
          interface StudioCandidate {
            planned: (typeof plan.templates)[number];
            draft: StudioTemplateDraft;
            validation: StudioTemplateValidation;
            sampleDescription?: string | undefined;
            /** Set the moment it is out: a gate it could not clear after its repair, a `drop` verdict, a refused write. */
            dropReason?: string;
            /** The set review asked for a repair even though the eight gates passed. */
            reviewRepair?: string;
          }

          /** Re-usable because a repair re-runs the SAME battery on new markup: identical inputs, so a pass means the same thing both times. */
          const validateDraft = async (stepId: string, draft: StudioTemplateDraft, alreadyTaken: readonly string[]): Promise<StudioTemplateValidation> =>
            wf.step.code(stepId, async () =>
              validateStudioTemplate(
                {
                  draft,
                  clientSlug: wf.clientSlug,
                  // Fresh rows plus the ids this setup has already authored —
                  // a stale row is the thing being replaced, not a collision.
                  existingArchetypeIds: [...studioCheck.freshArchetypeIds, ...alreadyTaken],
                  ...(studioKit !== undefined ? { kit: studioKit } : {}),
                  ...(targetLanguage !== undefined ? { targetLanguage } : {}),
                  seed: seedFor("ltr"),
                  rtlSeed: seedFor("rtl"),
                  evidenceBlock: designBriefBuild.input.formatEvidence,
                  ...(fragments.head !== undefined ? { brandHeadHtml: fragments.head } : {}),
                  // The device sheet only, deliberately: item S's image
                  // treatment is frozen at `04k`, after this block, and a
                  // studio template is validated as a TEMPLATE — its interest
                  // floor and contrast must hold on the ungraded photograph,
                  // since the treatment is a per-client decision that can
                  // change under it without re-authoring the set.
                  extraHeadHtml: deviceCssBlock(),
                },
                studioDeps,
              ),
            );

          // Phase A (00c4/00c5): author each template, then MEASURE it.
          //
          // ONE call per template, never one for the set: at ~$0.051 a call
          // six cost $0.31 of a $2.00 budget, and in exchange a schema
          // failure or a refused gate costs ONE template instead of six.
          const candidates: StudioCandidate[] = [];
          for (const planned of plan.templates) {
            const designExec = await wf.step.agent(
              `00c4-design-template-${planned.archetypeId}`,
              designerAgent,
              buildDesignerInput({ planned, brief: designBrief, bundle }),
            );
            setupSpend(`00c4-design-template-${planned.archetypeId}`, designExec.totalCostUsd, SETUP_STEP_COST_ESTIMATES_USD.templateDesign);
            if (designExec.status !== "completed" || designExec.finalOutput === undefined || designExec.finalOutput === null) {
              const reason = `the designer turn resolved to "${designExec.status}"`;
              dropped.push({ archetypeId: planned.archetypeId, reason });
              await studioWarn(`template-studio-design-${planned.archetypeId}`, `template studio: dropped ${planned.archetypeId} — ${reason}`);
              continue;
            }
            const draft: StudioTemplateDraft = designExec.finalOutput;
            // Gate 1s duplicate half is per (client, archetype), and every
            // candidate authored so far this setup has already claimed its id.
            const taken = candidates.map((row) => row.draft.archetypeId);
            const validation = await validateDraft(`00c5-validate-template-${planned.archetypeId}`, draft, taken);
            candidates.push({ planned, draft, validation });
          }

          // The vision look at OUR OWN rendered samples, for the set review.
          // Only for candidates that actually rendered: there is nothing to
          // describe for one that never got past gate 2.
          for (const candidate of candidates) {
            if (!candidate.validation.ok) continue;
            const sampleDescription = await describeSample(candidate.validation.ltr?.slideUrl);
            if (sampleDescription !== undefined) candidate.sampleDescription = sampleDescription;
          }

          // Phase B (00c6): does the SET read as one system?
          //
          // The only judgment left after eight deterministic gates: the
          // factual half is already answered, so this is a cheap Flash call
          // over rendered samples it can see DESCRIBED, with each row's
          // measured numbers travelling alongside it. Optional spend — the
          // second lever `planSetupBudget` pulls.
          const reviewable = candidates.filter((row) => row.validation.ok);
          if (setupPlan.setReview && reviewable.length > 0) {
            const reviewAgent = new InstagramTemplateSetReviewAgent({ router: options.router, tools, promptStore: options.promptStore });
            const setExec = await wf.step.agent(
              "00c6-review-template-set",
              reviewAgent,
              buildSetReviewInput({
                clientSlug: wf.clientSlug,
                brief: designBrief,
                validated: reviewable.map((row) => ({ draft: row.draft, validation: row.validation, sampleDescription: row.sampleDescription })),
              }),
            );
            setupSpend("00c6-review-template-set", setExec.totalCostUsd, SETUP_STEP_COST_ESTIMATES_USD.setReview);
            if (setExec.status === "completed" && setExec.finalOutput !== undefined && setExec.finalOutput !== null) {
              setupNotes.push(setExec.finalOutput.setNote);
              for (const verdict of setExec.finalOutput.perTemplate) {
                const candidate = reviewable.find((row) => row.draft.archetypeId === verdict.archetypeId);
                if (candidate === undefined) continue;
                if (verdict.verdict === "drop") {
                  candidate.dropReason = `the set review dropped it: ${verdict.reason}`;
                  await studioWarn(`template-studio-set-drop-${verdict.archetypeId}`, `template studio: the set review dropped ${verdict.archetypeId} — ${verdict.reason}`);
                } else if (verdict.verdict === "repair") {
                  candidate.reviewRepair = verdict.reason;
                }
              }
            } else {
              setupNotes.push(`the set review resolved to "${setExec.status}", so every validated template was kept on its own gate results`);
            }
          }

          // Phase C (00c7): ONE repair per template, at most `plan.repairsAllowed`.
          //
          // The repair call is handed the refused gates BY NUMBER with their
          // measured figures verbatim, which is why a repair is worth $0.048
          // rather than a drop: the model is not guessing what went wrong.
          // Still failing afterwards — or no repair budget left — is a DROP
          // with the reason recorded, never a failed setup.
          let repairsSpent = 0;
          for (const candidate of candidates) {
            if (candidate.dropReason !== undefined) continue;
            const needsRepair = !candidate.validation.ok || candidate.reviewRepair !== undefined;
            if (!needsRepair) continue;
            if (repairsSpent >= setupPlan.repairsAllowed) {
              if (!candidate.validation.ok) {
                candidate.dropReason = `${formatStudioFailures(candidate.validation).join("; ") || "the validation battery refused it"} (no repair turn left in this setups budget)`;
              }
              continue;
            }
            repairsSpent += 1;
            const findings = candidate.validation.ok
              ? [`the set review asked for a repair: ${candidate.reviewRepair}`]
              : formatStudioFailures(candidate.validation);
            const repairExec = await wf.step.agent(
              `00c7-repair-template-${candidate.planned.archetypeId}`,
              designerAgent,
              buildDesignerInput({
                planned: candidate.planned,
                brief: designBrief,
                bundle,
                repair: { findings, previous: { bodyHtml: candidate.draft.bodyHtml, css: candidate.draft.css } },
              }),
            );
            setupSpend(`00c7-repair-template-${candidate.planned.archetypeId}`, repairExec.totalCostUsd, SETUP_STEP_COST_ESTIMATES_USD.templateRepair);
            if (repairExec.status !== "completed" || repairExec.finalOutput === undefined || repairExec.finalOutput === null) {
              if (!candidate.validation.ok) candidate.dropReason = `the repair turn resolved to "${repairExec.status}"`;
              continue;
            }
            const repaired = repairExec.finalOutput;
            const taken = candidates.filter((row) => row !== candidate).map((row) => row.draft.archetypeId);
            const revalidated = await validateDraft(`00c5-validate-template-${candidate.planned.archetypeId}-repaired`, repaired, taken);
            if (revalidated.ok) {
              candidate.draft = repaired;
              candidate.validation = revalidated;
            } else if (!candidate.validation.ok) {
              candidate.dropReason = formatStudioFailures(revalidated).join("; ") || "the validation battery refused the repaired template too";
            } else {
              // The gates had already passed and only the SET review asked
              // for a change: a repair that measures worse is discarded and
              // the original stands, rather than throwing away a template
              // that was already good enough to store.
              setupNotes.push(`${candidate.planned.archetypeId}: the repair measured worse than the original, so the original was kept`);
            }
          }

          for (const candidate of candidates) {
            if (candidate.dropReason === undefined) continue;
            dropped.push({ archetypeId: candidate.planned.archetypeId, reason: candidate.dropReason });
            await studioWarn(`template-studio-dropped-${candidate.planned.archetypeId}`, `template studio: dropped ${candidate.planned.archetypeId} — ${candidate.dropReason}`);
          }

          // Phase D (00c8): store the survivors, DISABLED, at the studio score.
          //
          // The id is derived (`studio_<client>_<archetype>`), so a resumed
          // run replaying this step upserts the same rows rather than
          // duplicating them. `enabled: false` IS the approval mechanism:
          // `resolveBest` already skips a disabled candidate, so this run and
          // every run until a human approves the set render on the bundled
          // archetypes while the portal can still show what was generated.
          const survivors = candidates.filter((row) => row.dropReason === undefined && row.validation.ok);
          if (survivors.length > 0) {
            await wf.step.code("00c8-store-template-set", async () => {
              const written: string[] = [];
              for (const row of survivors) {
                const promotion = buildStudioPromotion({
                  draft: row.draft,
                  validation: row.validation,
                  clientSlug: wf.clientSlug,
                  document: row.validation.document!,
                  qualityScore: DEFAULT_QUALITY_STUDIO,
                  now: Date.now(),
                });
                try {
                  await promoteTemplate({ store: templateStore, ...promotion });
                  stored.push({ promotion, validation: row.validation });
                  written.push(promotion.id);
                } catch (error) {
                  const reason = `the registry refused the write: ${(error as Error).message}`;
                  dropped.push({ archetypeId: row.planned.archetypeId, reason });
                  console.error(`00c8-store-template-set: ${reason}`);
                }
              }
              return { stored: written, dropped: dropped.map((d) => d.archetypeId) };
            });
          }
          studioReport = summarizeStudio({ check: studioCheck, stored, dropped, evidence: evidence.evidence, notes: setupNotes });
        }

        setupTemplatesStored = stored.length;
        setupTemplatesDropped = dropped.length;
        // The estimate-vs-actual line now waits for `00d*` below: one setup,
        // one meter, one report covering both halves.
      }

      if (studioReport !== undefined) {
        try {
          await tools["ledger.appendEvent"]?.execute(
            { runId: wf.runId, eventId: `${wf.runId}__template-studio`, level: "info", message: studioNote(studioReport) },
            { ctx },
          );
        } catch (error) {
          console.error("00c: could not record the template-studio ledger row", error);
        }
      }
    }

    // ── 00d*: this client's standing VISUAL DIRECTION (Phase 3, item Q) ──
    //
    // What this replaces is one sentence. `image.generate`'s brief falls back
    // to `"Style: realistic photography, natural lighting, clean
    // composition."` whenever the caller supplies nothing, and until now the
    // Instagram caller always did: `artDirectionFor` read four `BrandTokens`
    // fields no client config in the fleet sets. Every generated slide for
    // every client was drawn to the same twelve words.
    //
    // The same three invariants as `00c*`, for the same reasons:
    //
    //  1. **Nothing here may throw.** Every failure is a `ledger.appendEvent`
    //     warn and the block falls through to `fallbackVisualDirection`,
    //     which derives at least four grounded lines from the brand kit and
    //     the brief. Setup never blocks a run.
    //  2. **The setup meter, shared with the studio.** Lever 5 of
    //     `planSetupBudget` turns this whole block off; when it does, a
    //     stored-but-stale direction is still reused and the fallback catches
    //     the rest.
    //  3. **Deriving is once per client per 90 days**
    //     (`VISUAL_DIRECTION_TTL_DAYS`), not once per run.
    //
    // NOT gated on `options.templateStore`: a client with no template
    // registry still generates images, and the 90-day direction TTL expires
    // inside the studio's 120-day one, so the commonest Phase 3 setup is a
    // direction derived on a run whose studio resolved `reuse`.
    /** The direction every `image.generate` call this run inherits. Never `undefined` for a client with either a brand kit or a brief. */
    let visualDirection: VisualDirection | undefined;
    /** For the `09a` payload and the deliverable — a reviewer's one question is "where did these lines come from". */
    let visualDirectionReport: { action: string; reason: string; source?: string; generatedBy?: string; generatedAt?: string; styleLockId?: string; lines?: number; gaps?: string[] } | undefined;
    {
      const now = new Date();
      const directionCheck = await wf.step.code("00d-check-visual-direction", async () => {
        let beliefs: unknown;
        try {
          const read = await tools["memory.read"]?.execute({ scope: "beliefs" }, { ctx });
          if (read?.status === "success") beliefs = (read.result as { beliefs?: unknown }).beliefs;
        } catch (error) {
          // A beliefs read that failed is not "no direction on file" — but it
          // has to resolve to something, and `derive` is the honest one: the
          // worst case is one $0.075 re-derivation on the setup meter.
          console.error("00d-check-visual-direction: could not read the beliefs document", error);
        }
        // Lever 5. With no studio plan nothing has been spent on setup at
        // all, so the direction is affordable by construction — which is the
        // whole reason this reads a plan that may not exist rather than
        // demanding one.
        return checkVisualDirection(beliefs, { now, allowDerive: setupDecision?.plan.visualDirection ?? true });
      });
      visualDirection = directionCheck.direction;
      visualDirectionReport = { action: directionCheck.action, reason: directionCheck.reason };

      if (directionCheck.action === "derive") {
        // The plan, if the studio did not already make one. Same step id and
        // the same decision — a setup that only re-derives the direction is
        // the studio's budget question with `templates: 0`.
        if (setupDecision === undefined) {
          setupDecision = await planSetup({
            templates: 0,
            repairs: 0,
            referenceAccounts: 0,
            sitePages: 0,
            referenceImages: 0,
            setReview: false,
            visualDirection: true,
          });
          setupNotes.push(setupDecision.note);
        }

        // ── The LIVE meter, not only the plan ──
        //
        // `setupDecision.plan` was made before a cent was spent. `setupSpend`
        // records MEASURED costs, so the studio's own turns (`00c3`/`00c4`/
        // `00c7`) can overrun their estimates and push the setup meter past
        // the $2.00 target or the $3.00 hard max while this block still
        // believes its lever is on. The standing amendment is "past the
        // target stop optional work, past the hard max finish on the cheapest
        // complete path", and `planSetupBudget`'s lever 5 names THIS block as
        // the optional one — so it has to read the meter the way `describeSample`
        // already does, not the plan alone.
        //
        // The two halves degrade separately because they are not equally
        // optional: `00d1`'s pattern ingest is the cheaper, more skippable
        // half (the direction can be derived from the brand kit and the brief
        // alone, which is the `brand+brief` source most clients land on
        // anyway), so it stops at the target; `00d2` is the direction itself,
        // so it runs until the hard max and only then falls through to
        // `fallbackVisualDirection`. Every skip is a `setupNotes` line, so the
        // adaptation is reported like every other lever.
        const directionPosture = setupMeter.posture;
        if (!setupDecision.plan.visualDirection) {
          setupNotes.push("the setup budget turned the visual-direction step off — this run's generated images use the brand-kit fallback");
          visualDirectionReport = { action: "unavailable", reason: "the setup budget turned the art-direction step off" };
        } else if (directionPosture === "cheapest-path") {
          setupNotes.push(
            `the setup meter crossed its $${MAX_SETUP_SPEND_USD.toFixed(2)} hard max before the art-direction step (${setupMeter.totalUsd.toFixed(3)} spent), so no direction was derived — this client's generated images use the brand-kit fallback and the direction is derived on the next setup`,
          );
          visualDirectionReport = { action: "unavailable", reason: `the setup meter crossed its hard max ($${setupMeter.totalUsd.toFixed(3)} of $${MAX_SETUP_SPEND_USD.toFixed(2)}) before the art-direction step` };
        } else {
          // ── 00d1: the evidence, assembled by code ──
          //
          // The free read first. `media.getVisualPatterns` reads a profile
          // already stored in the client's own workspace and costs nothing;
          // only when there is none does `media.ingestVisualPatterns` pay for
          // one, and that tool gates on the client's recorded consent itself
          // — no consent means `not_available`, which is a NAMED problem in
          // the bundle, never a failure.
          const bundle = await wf.step.code("00d1-ingest-visual-patterns", async (): Promise<{ patterns?: VisualPatternEvidence; problems: string[]; accounts: number }> => {
            const problems: string[] = [];
            let patterns: VisualPatternEvidence | undefined;
            try {
              const got = await tools["media.getVisualPatterns"]?.execute({}, { ctx });
              if (got?.status === "success") {
                const result = got.result as { profile: { versionId: string; generatedAt: string; review: { status: string }; templateHints?: readonly string[] }; reference: string };
                patterns = {
                  versionId: result.profile.versionId,
                  generatedAt: result.profile.generatedAt,
                  reviewStatus: result.profile.review.status,
                  reference: result.reference,
                  ...(result.profile.templateHints !== undefined ? { templateHints: [...result.profile.templateHints] } : {}),
                };
              }
            } catch (error) {
              problems.push(`the stored visual-pattern profile could not be read (${(error as Error).message})`);
            }

            if (patterns === undefined && directionPosture !== "normal") {
              // Past the setup target: the optional half stops. The free read
              // above already happened, so a client who HAS a stored profile
              // still gets it; what is skipped is paying to build one.
              const skipped = `the setup meter is past its $${TARGET_SETUP_SPEND_USD.toFixed(2)} target ($${setupMeter.totalUsd.toFixed(3)} spent), so the client's own feed was not ingested — the direction rests on the brand kit, the brief and the site`;
              problems.push(skipped);
              setupNotes.push(skipped);
              return { problems, accounts: 0 };
            }

            if (patterns === undefined) {
              const ingest = tools["media.ingestVisualPatterns"];
              const accounts = await (async () => {
                try {
                  const configOutcome = await tools["client.getConfig"]?.execute({}, { ctx });
                  const brandOutcome = await tools["client.getBrand"]?.execute({}, { ctx });
                  return socialAccountsFromClient(
                    configOutcome?.status === "success" ? (configOutcome.result as Record<string, unknown>) : undefined,
                    brandOutcome?.status === "success" ? (brandOutcome.result as Record<string, unknown>) : undefined,
                  );
                } catch (error) {
                  problems.push(`the client's own accounts could not be read (${(error as Error).message})`);
                  return [];
                }
              })();
              if (ingest === undefined) {
                problems.push("media.ingestVisualPatterns is not registered on this deployment, so the client's own feed was not read");
              } else if (accounts.length === 0) {
                problems.push("the client's config and brand kit name no social account of their own, so there was no feed to learn from");
              } else {
                // Up to four, which is the tool's own ceiling.
                const outcome = await ingest.execute({ accounts: accounts.slice(0, 4).map((a) => ({ platform: a.platform, username: a.username })) }, { ctx });
                setupSpend("00d1-ingest-visual-patterns", undefined, SETUP_STEP_COST_ESTIMATES_USD.visualPatterns);
                if (outcome.status === "success") {
                  const result = outcome.result as { profile: VisualPatternProfile };
                  patterns = {
                    versionId: result.profile.versionId,
                    generatedAt: result.profile.generatedAt,
                    reviewStatus: result.profile.review.status,
                    reference: renderVisualPatternReference(result.profile),
                    ...(result.profile.templateHints !== undefined ? { templateHints: [...result.profile.templateHints] } : {}),
                  };
                } else {
                  // The commonest outcome in the fleet, and not an error:
                  // visual-pattern consent is usually absent, so most clients
                  // land on `brand+brief`. Named, so the gate says so.
                  problems.push(
                    `the client's own feed was not read (${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""}) — the direction rests on the brand kit, the brief and the site`,
                  );
                }
              }
              return { ...(patterns !== undefined ? { patterns } : {}), problems, accounts: accounts.length };
            }
            return { patterns, problems, accounts: 0 };
          });

          const evidenceBundle: VisualDirectionEvidenceBundle = {
            clientSlug: wf.clientSlug,
            brandTokens: frozen.brandTokens,
            ...(effectiveKit !== undefined ? { renderTokens: effectiveKit.cssVars } : {}),
            brief,
            ...(bundle.patterns !== undefined ? { patterns: bundle.patterns } : {}),
            // `sitePages` when this run's studio block fetched them at
            // `00c2` — already paid for, already cached, and the prompt
            // documents them as an input and lets a line cite one as its
            // `basis`. Never re-fetched here: a second ScrappyCoco pass to
            // re-read the pages the brief was derived FROM would buy the
            // prompt nothing the brief does not already carry, and the gap
            // now says which of the two happened.
            //
            // Still no `companyName`/`ownImageNotes`: the profile read
            // belongs to `03a`, and nothing in this workflow produces a
            // vision pass over the client's own post images — which is why
            // the prompt no longer advertises `ownImageNotes` as an input.
            ...(clientSitePages !== undefined ? { sitePages: clientSitePages } : {}),
            ...(targetLanguage !== undefined ? { targetLanguage } : {}),
            problems: bundle.problems,
          };
          const assembled = buildVisualDirectionInput(evidenceBundle);

          // ── 00d2: the six-to-ten lines ──
          const artDirectorAgent = new InstagramArtDirectorAgent({ router: options.router, tools, promptStore: options.promptStore });
          const directionExec = await wf.step.agent("00d2-derive-visual-direction", artDirectorAgent, assembled.input);
          setupSpend("00d2-derive-visual-direction", directionExec.totalCostUsd, SETUP_STEP_COST_ESTIMATES_USD.artDirection);

          /**
           * `00d3` on either path: the direction when there is one, the
           * failure marker when there is not.
           *
           * The failure marker is not bookkeeping. Without it `00d` resolves
           * `derive` again on the NEXT run, and the one after that, re-paying
           * `00d1` + `00d2` (~$0.075) every week for a step whose whole
           * premise is "once per client per 90 days" — recurring spend on the
           * one-off setup budget, invisible to the run's $1.00/$1.50
           * accounting because the setup meter is a different meter. Inside
           * `VISUAL_DIRECTION_RETRY_DAYS` the marker makes `00d` answer
           * `unavailable`, `fallbackVisualDirection` carries the run exactly
           * as it does now, and the 90-day re-derive is untouched.
           *
           * Best-effort in both directions, and the success path CLEARS the
           * marker (`updateBeliefs` shallow-merges, so `null` is how a key is
           * retired) — otherwise a client who failed once would carry a stale
           * failure alongside a good direction.
           */
          const persistDirection = async (diff: Record<string, unknown>, what: string): Promise<{ persisted: boolean }> => {
            try {
              const written = await tools["memory.updateBeliefs"]?.execute({ diff }, { ctx });
              if (written?.status !== "success") {
                await setupWarn(
                  "visual-direction-not-persisted",
                  `${what} could not be stored (${written?.status ?? "memory.updateBeliefs is not registered"}) — this run uses what it has and the next run retries`,
                );
                return { persisted: false };
              }
              return { persisted: true };
            } catch (error) {
              await setupWarn("visual-direction-not-persisted", `${what} could not be stored (${(error as Error).message}) — this run uses what it has and the next run retries`);
              return { persisted: false };
            }
          };

          /**
           * The turn's answer, or `undefined` when nothing storable came back.
           *
           * `finaliseVisualDirection` returns `undefined` for three reasons,
           * and all three are the same fact: this turn produced no document
           * the NEXT run could read. It demotes a line whose `basis` cites a
           * URL the evidence never carried, and it re-parses what it built
           * through the very schema `readVisualDirection` will parse it with
           * — so a direction that would be refused on the read is never
           * written. A document that cannot be read back is the expensive
           * failure: `00d` resolves `derive` again on every later run and
           * `00d1` + `00d2` are re-paid every week, on the success path,
           * where no failure marker is written.
           */
          const derived =
            directionExec.status === "completed" && directionExec.finalOutput !== undefined && directionExec.finalOutput !== null
              ? finaliseVisualDirection(directionExec.finalOutput, {
                  source: assembled.source,
                  generatedBy: "instagram-art-director@1",
                  now,
                  gaps: assembled.gaps,
                  evidenceUrls: assembled.evidenceUrls,
                })
              : undefined;

          if (derived === undefined) {
            const failedWith =
              directionExec.status === "completed" && directionExec.finalOutput !== undefined && directionExec.finalOutput !== null
                ? "00d2-derive-visual-direction returned a direction that could not be stored (too few grounded lines, or a document the schema refuses)"
                : `00d2-derive-visual-direction resolved to "${directionExec.status}"`;
            await setupWarn(
              "visual-direction-failed",
              `${failedWith} — this run's generated images use the brand-kit fallback direction, and the next ${VISUAL_DIRECTION_RETRY_DAYS} day(s) of runs use it too rather than re-paying for the same failure`,
            );
            setupNotes.push(`${failedWith}, so no visual direction was persisted — the failure is recorded for ${VISUAL_DIRECTION_RETRY_DAYS} day(s) so the next run does not re-pay for it`);
            visualDirectionReport = { action: "failed", reason: failedWith };
            await wf.step.code("00d3-persist-visual-direction", async () =>
              persistDirection(
                { [VISUAL_DIRECTION_ATTEMPT_BELIEF_KEY]: { version: 1, attemptedAt: now.toISOString(), failedWith } satisfies VisualDirectionAttempt },
                "the failed visual-direction attempt",
              ),
            );
          } else {
            visualDirection = derived;

            // ── 00d3: persist, best-effort ──
            //
            // Written here rather than folded into `09b`'s diff because a
            // quarter's direction that cost a Sonnet call must survive a run
            // that never reaches delivery. `updateBeliefs` merges a diff, so
            // the sibling keys `09b` writes never fight with this one — and
            // the same diff retires any failure marker an earlier run left.
            await wf.step.code("00d3-persist-visual-direction", async () => {
              const wrote = await persistDirection(
                { [VISUAL_DIRECTION_BELIEF_KEY]: derived, [VISUAL_DIRECTION_ATTEMPT_BELIEF_KEY]: null },
                "the visual direction",
              );
              if (wrote.persisted) return wrote;
              // The write itself is the failure now, and it re-bills exactly
              // like a failed turn: next run reads no direction, resolves
              // `derive`, and pays for the same Sonnet call again. So the
              // marker is tried on its own — a smaller write, which is worth
              // one attempt even against a store that just refused a larger
              // one.
              const marked = await persistDirection(
                {
                  [VISUAL_DIRECTION_ATTEMPT_BELIEF_KEY]: {
                    version: 1,
                    attemptedAt: now.toISOString(),
                    failedWith: "00d3-persist-visual-direction could not write the derived direction",
                  } satisfies VisualDirectionAttempt,
                },
                "the failed visual-direction write",
              );
              return { persisted: false, retryHeld: marked.persisted };
            });
          }
        }
      }

      // The insurance. With either a brand kit or a brief this returns at
      // least four grounded lines, which is what makes `image.generate`'s
      // neutral one-liner unreachable in practice — including when lever 5
      // turned the block off entirely.
      if (visualDirection === undefined) visualDirection = fallbackVisualDirection(frozen.brandTokens, brief, { now });
      if (visualDirection !== undefined) {
        visualDirectionReport = {
          ...(visualDirectionReport ?? { action: "fallback", reason: "no stored or derived direction" }),
          source: visualDirection.source,
          generatedBy: visualDirection.generatedBy,
          generatedAt: visualDirection.generatedAt,
          styleLockId: visualDirection.styleLock.id,
          lines: visualDirection.lines.length,
          gaps: visualDirection.gaps,
        };
      }
    }

    // ── The setup budget's own estimate-vs-actual, reported exactly as a run's is ──
    //
    // One report over BOTH setup halves (item N's studio and item Q's
    // direction), which is why it waits until here. Absent on a run that
    // planned no setup at all, i.e. most runs.
    if (setupDecision !== undefined) {
      const setupSummary = summarizeSetupBudget(setupDecision, setupMeter, setupNotes);
      setupBudgetSummary = setupSummary;
      setupBudgetRecord = {
        estimatedUsd: setupSummary.estimatedUsd,
        actualUsd: setupSummary.actualUsd,
        templatesStored: setupTemplatesStored,
        templatesDropped: setupTemplatesDropped,
        crossedTarget: setupSummary.crossedTarget,
        crossedMax: setupSummary.crossedMax,
        adaptations: setupSummary.adaptations.length,
      };
      try {
        await tools["ledger.appendEvent"]?.execute(
          {
            runId: wf.runId,
            eventId: `${wf.runId}__setup-budget`,
            level: setupSummary.crossedTarget ? "warn" : "info",
            message: setupEstimateVsActualLine(setupSummary),
          },
          { ctx },
        );
      } catch (error) {
        console.error("setup: could not record the setup-budget ledger row", error);
      }
    }

    // ── 03: claim the subject — the catalog first, then the same fallbacks every other channel already has ──
    const claimedTopic = await wf.step.code("03-claim-topic", async (): Promise<InstagramTopicClaim> => {
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

      // 2. Nothing planned and nothing requested: the client's declared
      //    industry, as a SEED ONLY (Phase 0, item E, 2026-09). This used to
      //    return a literal "<industry> trends" query as the subject — a query,
      //    not a subject — and the research step then researched the query; five
      //    auto prep runs landed on the same topic. `03g-select-topic` below
      //    MUST replace this seed with a scouted story or a real fetched
      //    headline, or hold honestly; it is never drafted from as-is.
      const profileOutcome = await tools["client.getProfile"]!.execute({}, { ctx });
      const industry =
        profileOutcome.status === "success" && typeof (profileOutcome.result as Record<string, unknown>)["industry"] === "string"
          ? ((profileOutcome.result as Record<string, unknown>)["industry"] as string)
          : undefined;
      if (industry) {
        return { topic: industry, source: "research" };
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

    // ── 04e: what this client already PUBLISHED — on every channel ──
    //
    // The anti-repetition read, cross-channel since 2026-09: every channel
    // agent's excerpt ledger (not only this one's) plus the client's own
    // accounts, read from the handles in their config and brand kit. Used
    // three times — as a hard do-not-repeat directive in the copy prompt, as
    // the corpus the post-draft similarity check (07d) scores against, and as
    // the list the trend scout must steer clear of. Read HERE, before the
    // topic is final, for that third use.
    const socialAccounts = await wf.step.code("04e0-load-social-accounts", async () => {
      const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
      const brandOutcome = await tools["client.getBrand"]!.execute({}, { ctx });
      return socialAccountsFromClient(
        configOutcome.status === "success" ? (configOutcome.result as Record<string, unknown>) : undefined,
        brandOutcome.status === "success" ? (brandOutcome.result as Record<string, unknown>) : undefined,
      );
    });
    const crossChannel = await readCrossChannelHistory(wf, tools, ctx, { stepId: "04e-read-cross-channel-history", socialAccounts });
    const outputHistory = crossChannel.entries;
    /** This agent's OWN shipped posts — what the format and mode rotations count on. */
    const ownShippedCount = crossChannel.entries.filter((e) => e.channel === "instagram-agent").length;
    const recentPostsDirective = crossChannelDirective(crossChannel);

    // ── 04f: the client's own intel report and knowledge base, as authoritative drafting context ──
    //
    // `intel.getReport` has been registered in every agent's registry since
    // the intel agent shipped, with zero channel-agent callers — a client
    // could pay for a full intel report (voice rows, positioning, whitespace
    // opportunities) and have their caption writer never see a word of it.
    const clientIntelContext = await readClientIntelContext(wf, tools, ctx, "04f-read-intel-context");

    // ── 03a-03c: the trend scout, on EVERY run (Phase 0, item E, 2026-09) ──
    //
    // The scout used to run only when step 03 had fallen through to the
    // "<industry> trends" query literal — so a client with a healthy
    // catalog or a requested subject never saw this week's stories. Now every
    // run pulls the field's news (several questions, cached 7d), scouts them
    // for brand-fit-scored candidates, and `03g` weighs them against the
    // planned row or the request: a person's choice still leads, but the
    // reviewer sees what was NOT chosen, and an empty catalog gets a real
    // story instead of a query. The request/row itself is researched alongside
    // the field (`requestedTopic`), so the draft has sources for it either way.
    const trendProfile = await wf.step.code("03a-load-trend-profile", async () => {
      const profileOutcome = await tools["client.getProfile"]!.execute({}, { ctx });
      const profile = profileOutcome.status === "success" ? (profileOutcome.result as Record<string, unknown>) : {};
      const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
      const config = configOutcome.status === "success" ? (configOutcome.result as Record<string, unknown>) : {};
      const configured = Array.isArray(config["trendQueries"]) ? (config["trendQueries"] as unknown[]).filter((q): q is string => typeof q === "string" && q.trim().length > 0) : [];
      return {
        profile,
        industry: typeof profile["industry"] === "string" ? (profile["industry"] as string) : undefined,
        companyName: typeof profile["companyName"] === "string" ? (profile["companyName"] as string) : typeof profile["name"] === "string" ? (profile["name"] as string) : undefined,
        trendQueries: configured,
        forbiddenTopics: readForbiddenTopics(config),
      };
    });
    // The request or the planned row is researched alongside the field, but
    // GROUNDED exactly as 04a grounds it (Phase 0, item C) — never verbatim.
    // The audited defect was this literal reaching a web index: "Create
    // content that introduces the new offer to first-time buyers" went out as
    // the first of the four queries and the scout's "alternatives" came back
    // about first-time HOME buyers. `buildGroundedQuery` reduces a direction
    // to its subject and anchors it in what the client sells and to whom
    // (the brief is resolved at 02i, before 03a); the scout reads the same
    // grounded subject as its reference for what the request is about.
    const requestedTopic = claimedTopic.source !== "research" ? buildGroundedQuery(claimedTopic, brief).query : undefined;
    const fullQueries = buildTrendQueries({
      industry: trendProfile.industry,
      companyName: trendProfile.companyName,
      configuredQueries: trendProfile.trendQueries,
      requestedTopic,
    });
    // Budget lever 2: a `reduced` plan keeps only the first query — the
    // industry question that repeats run to run and is therefore the one
    // most likely to be a free 7d cache hit.
    const queries = budgetPlan.evidencePulls === "reduced" ? fullQueries.slice(0, 1) : fullQueries;

    // 03b degrades on an outage for a PLANNED run. A reserved row or a typed
    // request is a subject someone already chose; a scraper that is not
    // configured or is down must not hold that run — it is recorded on the
    // claim as `scoutStatus: "unavailable"` and the row leads as it did before
    // the scout existed. With nothing planned the seed is only the industry,
    // so a failed pull is the tooling failure it always was.
    let trendResearch: TrendResearch | undefined;
    let scoutStatus: InstagramTopicClaimShape["scoutStatus"] = "no-documents";
    try {
      trendResearch = await pullTrendResearch(wf, tools, ctx, {
        stepId: "03b-trend-research-pull",
        job: "instagram-trend-scan",
        queries: queries.length > 0 ? queries : [claimedTopic.topic],
        window: "7d",
        historyAgentId: "instagram-agent",
      });
    } catch (error) {
      if (!(error instanceof WorkflowToolingFailure) || claimedTopic.source === "research") throw error;
      scoutStatus = "unavailable";
      console.error(`03b-trend-research-pull: scout unavailable on a planned run (${error.message}); the ${claimedTopic.source} subject leads without alternatives`);
    }
    // Only executions that actually hit the vendor cost anything; a 7d cache
    // hit is free. Counted from the pull's own per-query record.
    if (trendResearch !== undefined) {
      const executed = trendResearch.queries.filter((q) => q.status === "success" && !q.fromCache).length;
      if (executed > 0) spend("03b-trend-research-pull", undefined, executed * STEP_COST_ESTIMATES_USD.scraperExecution);
    }

    // ── 03e: the other four topic engines (Phase 1, item I) ──
    //
    // Niche news (03b) was the only engine this agent had, and a quiet news
    // week therefore meant a weak subject. Four more, all from material the
    // brief points at: what the client's REFERENCE ACCOUNTS posted that landed
    // (`research.socialHistory`, scored by whatever engagement fields the
    // provider returned), what the AUDIENCE is asking in communities (two
    // `research.pull` queries restricted to reddit/quora/HN/stackexchange),
    // the client's OWN ASSETS (brief `ownAssets` plus headings in the
    // product-information and market-strategy documents 02i already read) and
    // the brief's EVERGREEN angles. The last two cost nothing at all.
    //
    // `gatherTopicSignals` never throws: every source that fails becomes a
    // line in `notes`, carried to the gate payload so a reviewer can see that
    // an engine contributed nothing and why. Only executions that actually
    // reached the vendor are billed — the 24h reference-account read shares
    // its cache with `04e`, and the community queries are cached 7d.
    const topicSignals = await wf.step.code("03e-topic-signals", () =>
      gatherTopicSignals(tools, ctx, {
        brief,
        contextDocs: {
          ...(productInformation !== undefined ? { productInformation } : {}),
          ...(marketStrategy !== undefined ? { marketStrategy } : {}),
        },
        avoidTopics: crossChannelAvoidTopics(crossChannel),
        // `research.pull` gained `includeDomains` in this same phase (item J),
        // so the community filter genuinely applies.
        includeDomainsSupported: true,
      }),
    );
    if (topicSignals.scraperExecutions > 0) {
      spend("03e-topic-signals", undefined, topicSignals.scraperExecutions * STEP_COST_ESTIMATES_USD.scraperExecution);
    }

    let scout: TrendScoutOutput | undefined;
    // The scout used to be gated on the news digest alone, so a week whose
    // pull came back empty — or whose scraper was down on a planned run —
    // threw away the four engines the run had already paid for. It runs when
    // there is ANY material; `runTrendScout` itself makes no model call when
    // there is none, so the two conditions cannot disagree.
    const digest = trendResearch !== undefined ? researchDigestForScout(trendResearch.merged) : [];
    if (digest.length > 0 || hasTopicSignalMaterial(topicSignals.signals)) {
      scout = await runTrendScout(wf, { tools, promptStore: options.promptStore, router: options.router }, "03c-trend-scout", {
        research: digest,
        channel: "instagram",
        clientProfile: trendProfile.profile,
        // Phase 1, item I: the four other engines' material, and the brief as
        // the authority on who the client is — `clientProfile` is raw
        // onboarding prose, the brief is the judged version of it.
        signals: topicSignals.signals,
        clientBrief: briefForPrompt(brief),
        ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
        ...(clientVoiceContext !== undefined ? { clientVoiceContext } : {}),
        ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
        ...(requestedTopic !== undefined ? { requestedTopic } : {}),
        forbiddenTopics: trendProfile.forbiddenTopics,
        today: new Date().toISOString().slice(0, 10),
      });
      // A call was made (`runTrendScout` also returns `undefined` after a call
      // whose output failed its schema), so the status is "ran" and the meter
      // counts it.
      scoutStatus = "ran";
      spend("03c-trend-scout", undefined, STEP_COST_ESTIMATES_USD.scout);
    }

    // ── 03d: this run's content mode, rotated over the decision log (Phase 0, item E) ──
    //
    // Replaces `CONTENT_MODES[ownShippedCount % 3]`: a counter every failed or
    // held run left untouched, so the "rotation" could sit on one mode for
    // weeks. `09b` now appends one decision per delivered post and the shared
    // `selectContentMode` (the same rotation x-agent and linkedin-agent use)
    // reads it back — never the immediately prior mode, then the least used.
    // A `requestedMode` in the client config wins outright.
    //
    // Phase 1, item K: the same `memory.read` is the ONLY read of the decision
    // log this run makes, so the rows travel on this step's own checkpoint
    // (additive field `decisions`) for the angle step at `04i` to parse
    // `pastAngles` out of. Threaded rather than captured in a closure
    // variable: a resumed run replays this step from its checkpoint and never
    // re-executes the body, so a closure would be empty on exactly the runs
    // that matter.
    const modeSelection = await wf.step.code(
      "03d-select-content-mode",
      // `decisions` is declared OPTIONAL even though the body below always
      // returns it: this step's checkpoint predates the field, so a resumed
      // run genuinely replays an output without it, and typing it as required
      // is what let a new consumer read `.slice` off `undefined`.
      async (): Promise<{ mode: ContentMode; source: "requested" | "rotation"; priorMode?: ContentMode; decisions?: Array<{ at?: string; summary: string }> }> => {
        const configOutcome = await tools["client.getConfig"]?.execute({}, { ctx });
        const config = configOutcome?.status === "success" ? (configOutcome.result as Record<string, unknown>) : {};
        const requestedMode = typeof config["requestedMode"] === "string" ? (config["requestedMode"] as string) : undefined;
        let recentModes: ContentMode[] = [];
        let decisions: Array<{ at?: string; summary: string }> = [];
        try {
          const read = await tools["memory.read"]?.execute({ scope: "decisions", limit: 20 }, { ctx });
          if (read?.status === "success") {
            const items = (read.result as { items?: Array<{ at?: unknown; summary: string }> }).items ?? [];
            recentModes = recentModesFromDecisions(items);
            decisions = items
              .filter((item): item is { at?: unknown; summary: string } => typeof item?.summary === "string")
              .slice(0, 20)
              .map((item) => ({ ...(typeof item.at === "string" ? { at: item.at } : {}), summary: item.summary }));
          }
        } catch (error) {
          console.error("03d-select-content-mode: could not read the decision log, rotating from an empty history", error);
        }
        const mode = selectContentMode(recentModes, requestedMode);
        const priorMode = recentModes.at(-1);
        return {
          mode,
          source: requestedMode !== undefined && mode === requestedMode ? "requested" : "rotation",
          ...(priorMode !== undefined ? { priorMode } : {}),
          decisions,
        };
      },
    );

    /**
     * The decision rows `03d` read, as every later consumer must treat them:
     * possibly ABSENT.
     *
     * `decisions` is an additive field on `03d-select-content-mode`'s output,
     * and that step is checkpointed. A run that was sitting at a gate when
     * this phase deployed replays its old `03d` checkpoint verbatim — no
     * `decisions` key at all — while every NEW step id below (`03f`, `04i`)
     * executes its body for the first time. Reading the field unguarded there
     * turns such a resume into a `TypeError` instead of a delivered post,
     * which is the one thing the owner's rule forbids. One binding, guarded
     * once, read by both consumers.
     */
    const recentDecisions = modeSelection.decisions ?? [];

    /**
     * The five engines' candidates, ranked in code (Phase 1, item I).
     *
     * `interest × brandFit × distance × modeBonus × engineBonus` — the scout
     * judges a story, this decides between stories, and the arithmetic is
     * checkpointed so a reviewer can disagree with a weight rather than with a
     * verdict. `dropped` is the honest counterpart to `chosen`: what was
     * excluded before scoring, and why.
     *
     * Pure, and safe to compute even when the scout never ran (an empty
     * candidate list ranks to nothing and `03g` falls through exactly as it
     * did in Phase 0).
     */
    const rankedTopics = await wf.step.code("03f-rank-topic-candidates", () =>
      rankTopicCandidates(scout?.candidates ?? [], {
        mode: modeSelection.mode,
        brief,
        // The same two windows `07d` and the scout steer by: what shipped on
        // any channel, and what this agent decided on its last few runs.
        recentExcerpts: [
          ...crossChannel.entries.slice(-5).map((e) => e.excerpt),
          ...recentDecisions.slice(0, 5).map((d) => d.summary),
        ],
        avoidTopics: crossChannelAvoidTopics(crossChannel),
        // Required for the reference-accounts engagement bonus: the measured
        // engagement lives in 03e's signals, matched to a candidate through
        // its `evidenceRefs`. Without it the bonus is a neutral 1.0, never a
        // guess.
        signals: topicSignals.signals,
      }),
    );

    // ── 03g: the subject, under one precedence order (Phase 0, item E) ──
    //
    // `resolveTopicClaim` (pure, `topic-selection.ts`): a person's request >
    // a planned row (unless the client set `trendJacking: "always"` AND a
    // story is unmistakably on-brand, stops a reader, and out-scores the row
    // with distance from recent posts applied) > the strongest on-brand trend
    // for this run's mode > a real fetched headline > an honest hold. The
    // output IS the claim from here on; everything not chosen rides along as
    // `alternatives` for the gate. When a trend displaces a reserved row the
    // reservation is released so the row is reservable again — and the new
    // claim carries no key, so 09b never commits a topic the catalog did not
    // issue.
    const topicClaim: InstagramTopicClaimShape = await wf.step.code("03g-select-topic", async (): Promise<InstagramTopicClaimShape> => {
      const configOutcome = await tools["client.getConfig"]?.execute({}, { ctx });
      const config = configOutcome?.status === "success" ? (configOutcome.result as Record<string, unknown>) : {};
      const resolved = resolveTopicClaim(claimedTopic, scout, modeSelection.mode, {
        avoidTopics: crossChannelAvoidTopics(crossChannel),
        trendJacking: typeof config["trendJacking"] === "string" ? (config["trendJacking"] as string) : undefined,
        recentExcerpts: crossChannel.entries.map((e) => e.excerpt),
        trendResearchMerged: trendResearch?.merged,
        scoutStatus,
        // Phase 1, item I: the five-engine ranking replaces the Phase 0
        // in-function `selectTrendCandidate` call. Every precedence rule is
        // unchanged — the ranking only decides WHICH candidate is the
        // strongest, and supplies the score the trend-jack comparison uses.
        ranked: rankedTopics,
      });
      if ("hold" in resolved) throw new WorkflowHeld(resolved.hold);
      if (resolved.releaseReservation && claimedTopic.reservationKey !== undefined) {
        const release = await tools["topics.release"]?.execute({ reservationKey: claimedTopic.reservationKey }, { ctx });
        if (release !== undefined && release.status !== "success") {
          // The row stays reserved until the reservation expires on its own;
          // a stuck row is a smaller failure than holding a run that has a
          // stronger subject in hand.
          console.error(`03g-select-topic: topics.release reported ${release.status} for "${claimedTopic.reservationKey}"`);
        }
      }
      return resolved.claim;
    });

    // ── 04h: the post format — a request, the client's setting, or the rotation ──
    //
    // `carousel` unless someone asked otherwise. `auto` makes every third post
    // a single image with a deep caption, counted on the shipped-output window
    // so the rotation survives restarts without a decision log of its own.
    const format = await wf.step.code("04h-select-format", (): { format: InstagramFormat; source: string } => {
      const requested = runClaim.requestedFormat;
      if (requested === "single" || requested === "carousel") return { format: requested, source: "requested" };
      if (requested === "auto") return { format: ownShippedCount % 3 === 2 ? "single" : "carousel", source: "rotation" };
      return { format: "carousel", source: "default" };
    });

    // ── 04a2: research the subject in three lanes (Phase 1, item J) ──
    //
    // `04a-research-pull` is RETIRED. It asked ONE question with `maxResults:
    // 4` and a 24-hour window, and the audit's carousels were written from
    // four blog posts. `pullResearchLanes` asks the same grounded question
    // (Phase 0, item C — a scouted trend passes through as-is, anything else
    // is rewritten as `<subject> in the context of <what the client sells> for
    // <whom>`) plus a 90-day INSIGHT lane for reports and studies and, when
    // the brief points at real domains, a PRIMARY-DOMAINS lane restricted to
    // them. Typically 14-20 unique documents against yesterday's four.
    //
    // Phase 0's in-step fallback pull is SUBSUMED: the news lane's second and
    // third questions are the fallback, always asked rather than only after an
    // empty answer. A single dead query is recorded and skipped; the step
    // fails as tooling only when every query failed, which is
    // `pullTrendResearch`'s own rule.
    const grounded = buildGroundedQuery(topicClaim, brief);
    const clientWebsite = typeof trendProfile.profile["website"] === "string" ? (trendProfile.profile["website"] as string) : undefined;
    const clientDomain = clientWebsite === undefined ? undefined : normalizeDomain(clientWebsite);
    const researchLanes = buildResearchLanes({
      groundedQuery: grounded.query,
      subject: grounded.subject,
      brief,
      ...(trendProfile.companyName !== undefined ? { companyName: trendProfile.companyName } : {}),
      // Passed in rather than read inside the lane builder so the questions a
      // resumed run replays are the questions it originally asked.
      year: new Date().getUTCFullYear(),
      ...(clientDomain !== undefined ? { clientDomain } : {}),
      // `domain`, never `handle`: a handle is a social identifier ("lennysan",
      // "SaaS"), and feeding those to a domain filter either dropped them all
      // (no dot) or restricted the search to a host that does not exist. Only
      // the brief's own `referenceAccounts[].domain` is a hostname, and the
      // lane builder skips the whole lane when none of them resolves — see
      // `buildResearchLanes`.
      referenceDomains: brief.referenceAccounts.map((a) => a.domain).filter((d): d is string => d !== undefined),
    });
    const deepResearch = await pullResearchLanes(wf, tools, ctx, {
      stepId: "04a2-research-pull-deep",
      lanes: researchLanes,
      job: "instagram-carousel-research",
      historyAgentId: "instagram-agent",
    });
    // Only queries that actually reached the vendor are billed; the news lane
    // is cached 7d and the insight lane 90d, so a weekly cadence pays for the
    // news lane about once a week and the insight lane about once a quarter.
    if (deepResearch.billedPulls > 0) {
      spend("04a2-research-pull-deep", undefined, deepResearch.billedPulls * STEP_COST_ESTIMATES_USD.scraperExecution);
    }

    // ── 04a3: read the two most source-like pages in full (Phase 1, item J) ──
    //
    // A merged document carries an excerpt; a report carries the paragraph the
    // figure is in. Two pages, chosen by URL shape (`.pdf`, `/report`,
    // `/study`, `.gov`, `.edu`, or the client's own domain), at 8000
    // characters each — best-effort throughout, because a dead PDF link must
    // cost a note and not a run. The client's OWN material joins the same
    // input marked `primary`, at no vendor cost at all.
    const primarySources = await wf.step.code("04a3-fetch-primary-sources", async () => {
      const urls = pickPrimarySourceUrls(deepResearch.merged, clientDomain, 2);
      const notes: string[] = [];
      let pages: Array<{ title: string; url: string; content: string; primary: true; fromCache: boolean }> = [];
      const fetchPages = tools["research.fetchPages"];
      if (urls.length === 0) {
        notes.push("no merged document looked like a primary source, so no page was read in full");
      } else if (fetchPages === undefined) {
        // Guarded rather than asserted so this step is order-independent of
        // the work package that registers the tool.
        notes.push("research.fetchPages is not registered, so no primary source was read in full");
      } else {
        try {
          const outcome = await fetchPages.execute({ urls, maxChars: 8000 }, { ctx });
          if (outcome.status === "success") {
            const result = outcome.result as { pages: Array<{ url: string; title?: string; text: string; fromCache: boolean }>; problems: string[] };
            pages = result.pages.map((p) => ({ title: p.title ?? p.url, url: p.url, content: p.text, primary: true as const, fromCache: p.fromCache }));
            notes.push(...result.problems);
          } else {
            notes.push(`the primary sources could not be read (${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""})`);
          }
        } catch (error) {
          notes.push(`the primary sources could not be read: ${(error as Error).message}`);
        }
      }

      // The client's own material — the product-information document and
      // everything the brief lists as an own asset. `primary: true` because
      // it is: for a claim about this client, they ARE the source.
      const clientDocuments: Array<{ title: string; content: string; primary: true }> = [];
      if (productInformation !== undefined && productInformation.trim().length > 0) {
        clientDocuments.push({ title: "the client's product-information document", content: productInformation, primary: true });
      }
      for (const asset of brief.ownAssets) {
        clientDocuments.push({ title: `${asset.title} (${asset.kind}, from ${asset.sourceRef})`, content: asset.summary, primary: true });
      }
      return { urls, pages, clientDocuments, notes };
    });
    const fetchedPages = primarySources.pages.map((p) => ({ title: p.title, url: p.url, content: p.content, primary: true as const }));
    const billedPageFetches = primarySources.pages.filter((p) => !p.fromCache).length;
    if (billedPageFetches > 0) {
      spend("04a3-fetch-primary-sources", undefined, billedPageFetches * STEP_COST_ESTIMATES_USD.scraperExecution);
    }

    const researchAgent = new InstagramResearchAgent({ router: options.router, tools, promptStore: options.promptStore });
    const researchExec = await wf.step.agent("04b-research-extract-facts", researchAgent, {
      topic: topicClaim.topic,
      // `instagram-research@2`'s own field names. The raw payload is GONE from
      // the input: the prompt no longer mentions it, and shipping the merged
      // documents twice (once raw, once ordered) would double a 20k-token
      // bill for nothing. `rawPayloadRef` is the "+"-joined list of the
      // underlying pull run ids, so a card still traces to the record its
      // document came from.
      documents: orderDocumentsPrimaryFirst([...(deepResearch.merged.result?.documents ?? []), ...fetchedPages], clientDomain),
      clientDocuments: primarySources.clientDocuments,
      clientBrief: briefForPrompt(brief),
      rawPayloadRef: deepResearch.merged.runId,
    });
    spend("04b-research-extract-facts", researchExec.totalCostUsd, STEP_COST_ESTIMATES_USD.extraction);
    if (researchExec.status === "content_fail") {
      throw new WorkflowHeld("research extraction did not produce output that cleared its own schema — nothing honestly cleared this run's research step");
    }
    if (researchExec.status !== "completed") {
      throw new WorkflowToolingFailure(`research extraction step resolved to "${researchExec.status}"`);
    }
    // Re-validate defensively — `finalOutput` is already schema-checked inside
    // BaseAgent, but this keeps step 07's self-check callers honestly typed
    // without a non-null assertion on a value this workflow never produced itself.
    const researchExtracted: ResearchOutput = ResearchOutputSchema.parse(researchExec.finalOutput);

    // ── 04b2: one card per claim (Phase 1, item J) ──
    //
    // Three lanes over sixteen documents produce the same figure from the
    // study, the trade-press write-up of the study and somebody's blog post
    // about the write-up. `dedupeFactCards` keeps the primary/URL-bearing one
    // and records what it dropped and which rule fired. Everything downstream
    // — the copy input's `facts`, the angle proposal, and `checkSlidesData`'s
    // verbatim `sourceRef` trace — reads THIS set, so a slide can never cite a
    // card that was dropped.
    const factCards = await wf.step.code("04b2-dedupe-fact-cards", () => dedupeFactCards(researchExtracted.facts));
    const research: ResearchOutput = { ...researchExtracted, facts: factCards.facts };

    /**
     * The ONE ordered slice of the fact set every prompt in this run sees
     * (Phase 1, items J and K).
     *
     * `factCardsForPrompt` re-orders the deduped cards primary-first and keeps
     * the top 14. It used to be called only for the copy step, while the angle
     * proposer got `factsForAnglePrompt(research.facts)` — the first 14 in
     * DEDUPE order. With 15+ cards and any primary card past index 13 the two
     * slices differ, so the proposer could rest an angle on a card the writer
     * never received, and prompt @13 §17 tells the writer those cards carry
     * the argument and must be cited verbatim with their source, date and URL.
     * There is nothing the writer can do with a card that is not in its own
     * `facts` array.
     *
     * One list, three consumers: 04i proposes from it, 04j judges `restsOn`
     * eligibility against it (the proposer cannot honestly rest on a card it
     * was never shown), and 05 writes from it. Step 07's verbatim `sourceRef`
     * trace still runs against the FULL deduped set (`research.facts`), which
     * is a superset, so a citation that clears the writer's list clears the
     * gate too.
     */
    const promptFacts = factCardsForPrompt(research.facts);

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
    // "Only media I upload for this job" (RunDirection.mediaSource, 2026-09-06):
    // Tier 0 is the ONLY tier. 05b's harvesters and the 06b-06e rescue tiers are
    // skipped below, and a photo slide the client did not cover takes the same
    // typographic downgrade path as any other unsourced slide. A carousel has
    // no text fallback for ALL of its slides though, so a client-only run with
    // nothing attached is refused here, before copy is paid for.
    const clientMediaOnly = runDirection.mediaSource === "client";
    const tier0Pool = await wf.step.code("05z-attach-user-media", async () => {
      const usable = runDirection.mediaAssets.filter((a) => a.role === "source" || a.role === "reference");
      if (clientMediaOnly && usable.length === 0) {
        throw new WorkflowBlockedIntake(
          "this run was set to client-provided media only, but no images were attached — attach the pictures for the slides, or let the agent source them",
        );
      }
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

      // ── A vision model READS the client's pictures (2026-09) ──
      //
      // Until now the copy step wrote slide 1 with no idea what the client's
      // photo on slide 1 showed, and the vetting step judged that photo from
      // the licence line this pipeline itself wrote. `media.inspectImages`
      // describes each upload; the description reaches the copy prompt as
      // `attachedMedia` (so the words are written TO the picture) and is
      // appended to the candidate's own description (so the vetting judgment
      // is about what is actually in frame). Best-effort: no vision backend,
      // or a failed call, leaves the upload exactly as it was.
      const inspect = tools["media.inspectImages"];
      let analyses: Array<{ slot: number; description: string; subjects: string[]; textInImage: string[]; mood: string; suggestedAngle?: string }> = [];
      /**
       * The same inspections, keyed by the staged PATH rather than by a
       * position.
       *
       * `analyses[].slot` is the slide the upload was attached for, and
       * `result.candidates` is the successfully-ingested SUBSET of the request
       * (`ingest-assets` drops an unreadable object into `unmet` and carries
       * on), so after one failure the two no longer share an index. The path
       * is the one key both halves genuinely agree on.
       */
      const analysisByPath = new Map<string, { description: string; subjects: string[]; textInImage: string[]; mood: string }>();
      let candidates = result.candidates;
      let visionNote: string | undefined;
      if (inspect !== undefined && result.candidates.length > 0) {
        const inspected = await inspect.execute(
          { repoRoot: options.repoRoot, images: result.candidates.slice(0, 12).map((c, i) => ({ ref: `attached-${i + 1}`, path: c.path })), purpose: "attached-media" },
          { ctx },
        );
        if (inspected.status === "success") {
          const byRef = new Map(((inspected.result as { inspections: Array<Record<string, unknown>> }).inspections).map((i) => [i["ref"] as string, i]));
          analyses = result.candidates.flatMap((candidate, i) => {
            const found = byRef.get(`attached-${i + 1}`);
            if (!found) return [];
            const analysis = {
              description: String(found["description"] ?? ""),
              subjects: (found["subjects"] as string[] | undefined) ?? [],
              textInImage: (found["textInImage"] as string[] | undefined) ?? [],
              mood: String(found["mood"] ?? ""),
            };
            analysisByPath.set(candidate.path, analysis);
            return [
              {
                // The slide this upload was actually attached for, read back
                // out of the name `media.ingestAssets` wrote — NOT `i + 1`,
                // which is this candidate's position in the surviving subset
                // and drifts by one for every attachment that failed. It
                // reaches the copy prompt as `attachedMedia[].slot`, so a
                // drifted number would tell the writer slide 1 holds a
                // photograph that is really on slide 2.
                slot: ingestedSlotOf(candidate.path) ?? i + 1,
                ...analysis,
                ...(typeof found["suggestedAngle"] === "string" ? { suggestedAngle: found["suggestedAngle"] as string } : {}),
              },
            ];
          });
          candidates = result.candidates.map((c, i) => {
            const found = byRef.get(`attached-${i + 1}`);
            // `subjects` travels with the description (`describeWithVision`):
            // the vet judges pictures as text, and its `claimMatch` rubric
            // turns on the identity of what is in frame — the named team,
            // company, place or era. Dropped, an upload of the client's own
            // supporters under a rival's headline still read as "compatible
            // and generic" and cleared the selection floor.
            return found ? { ...c, description: describeWithVision(c.description, found) } : c;
          });
        } else {
          visionNote = `vision inspection of the attachments did not complete (${inspected.status}${"reason" in inspected ? `: ${inspected.reason}` : ""})`;
        }
      }

      // ── Item T: the upload joins the client's MEDIA LIBRARY ──
      //
      // Best-effort by contract. The run already holds the description a
      // vision call was paid for this attempt; filing it means the next post
      // can reuse the frame for nothing. A failed write is a note on this
      // step and changes nothing else — the upload still works as a run
      // attachment exactly as it did before this existed.
      let libraryNote: string | undefined;
      const libraryAdd = tools["media.libraryAdd"];
      if (libraryAdd !== undefined && result.candidates.length > 0) {
        // ── Paired by SLOT, never by position ──
        //
        // `result.candidates` is the successfully-ingested subset of `usable`:
        // `ingest-assets` pushes an unreadable object, an empty object or an
        // unsupported scheme into `unmet` and continues, and only fails
        // wholesale when NOTHING ingested. So `usable[index]` is the wrong
        // asset the moment one upload fails, and what gets filed is one
        // photograph's bytes and description under a DIFFERENT upload's
        // `gcsUri`. That corruption is durable: `media.libraryAdd` keeps the
        // first sighting and only overwrites `gcsUri` when a later call
        // supplies one, so a later run would re-ingest the wrong object and
        // hand the vet a sentence about a picture it is not looking at.
        //
        // The slot `media.ingestAssets` wrote into the filename is the only
        // key that survives a partial failure. A candidate whose name carries
        // no slot is SKIPPED with a note — filing a frame whose provenance
        // cannot be established is exactly the thing this comment is about.
        const unpairedPaths: string[] = [];
        const entries = result.candidates.flatMap((candidate) => {
          const slot = ingestedSlotOf(candidate.path);
          const asset = slot === undefined ? undefined : usable[slot - 1];
          const analysis = analysisByPath.get(candidate.path);
          if (asset === undefined) {
            unpairedPaths.push(candidate.path);
            return [];
          }
          // No description means no row: a library entry whose whole purpose
          // is a stored sentence is worth nothing without one, and writing a
          // placeholder would make the next run believe it had been described.
          if (analysis === undefined || analysis.description.trim().length === 0) return [];
          return [
            buildLibraryEntry(
              {
                description: analysis.description,
                subjects: analysis.subjects,
                textInImage: analysis.textInImage,
                mood: analysis.mood,
                ...(inspect?.version !== undefined ? { toolVersion: inspect.version } : {}),
              },
              { path: candidate.path, uri: asset.uri, ...(asset.label ? { label: asset.label } : {}) },
              CLIENT_UPLOAD_RIGHTS,
            ),
          ];
        });
        const libraryNotes: string[] = [];
        if (unpairedPaths.length > 0) {
          libraryNotes.push(
            `${unpairedPaths.length} staged file(s) could not be matched back to the attachment they came from and were not filed (${unpairedPaths.join(", ")})`,
          );
        }
        if (entries.length > 0) {
          try {
            const filed = await libraryAdd.execute({ repoRoot: options.repoRoot, entries }, { ctx });
            if (filed.status !== "success") {
              libraryNotes.push(`the media library write did not complete (${filed.status}${"reason" in filed ? `: ${filed.reason}` : ""})`);
            }
          } catch (error) {
            libraryNotes.push(`the media library write did not complete (${(error as Error).message})`);
          }
        }
        if (libraryNotes.length > 0) libraryNote = libraryNotes.join("; ");
      }

      const notes = [
        ...(result.unmet.length > 0 ? [result.unmet.map((u) => `slide ${u.slot}: ${u.reason}`).join("; ")] : []),
        ...(visionNote !== undefined ? [visionNote] : []),
        ...(libraryNote !== undefined ? [libraryNote] : []),
      ];
      // Phase 0, item F: the vet (`instagram-image-vet@3`) may re-offer a
      // client's upload to the slide it honestly fits rather than the slot
      // upload order assigned it — and it can only do that if it can tell a
      // client photo apart from a harvested one. `ImageCandidate` has no
      // source field, so the tag rides on the description the vet reads.
      //
      // The slot in that tag is the one `media.ingestAssets` wrote into the
      // filename, not this candidate's position: with one attachment unread,
      // position N is the upload the client attached for slide N+1, and the
      // vet would be told the client asked for it on a slide they did not.
      candidates = candidates.map((c, i) => ({ ...c, description: `[client upload, slot ${ingestedSlotOf(c.path) ?? i + 1}] ${c.description}` }));
      return {
        candidates,
        // Only the slides an asset actually landed on. An attachment that
        // failed to ingest must not reserve a slide the harvesters would then
        // skip, which would leave it empty for the rest of the run — which is
        // exactly what an index-derived list did, because `result.candidates`
        // is the surviving subset and its indices close over the gap.
        slots: result.candidates.flatMap((candidate) => {
          const slot = ingestedSlotOf(candidate.path);
          return slot === undefined ? [] : [slot];
        }),
        attached: usable.length,
        analyses,
        ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
      };
    });

    /** Slides already carrying a client upload, so no tier below wastes a call on them. */
    const tier0Slots = new Set(tier0Pool.slots);

    // ── 05y: Tier 0.5 — the client's own media LIBRARY (Phase 3, item T) ──
    //
    // Uploads used to be single-run attachments on an in-memory volume. They
    // are now filed (at `05z`, below) with the description the run's vision
    // pass already paid for, so a later post can draw on the archive — and,
    // because that description is on file, a library frame costs NO vision
    // call to offer. It is the only tier that is strictly cheaper than doing
    // nothing: a straight saving against sourcing a stock image.
    //
    // Two exclusion rules, neither invented here, and both applied to every
    // frame: `ledger.listUsedImages` (never twice, ever — read at `05a`,
    // matched against every `.media-cache/` path a frame has been known by,
    // because `05y` re-ingests an archived object under a fresh path) is
    // AUTHORITATIVE, per item T; the immediately previous post's run id
    // (never back to back), which item P's skeleton history already read at
    // `02k` is the one source for, is the second filter and the one that
    // still bites once an entry's capped `knownPaths` have rolled over.
    //
    // SKIPPED ENTIRELY on a client-media-only run. `mediaSource: "client"`
    // means "only media I upload for THIS job": the archive is media they
    // uploaded for an earlier one, so offering it would put pictures the
    // client did not supply for this post on slides they chose to have
    // degrade typographically — and would spend a `media.ingestAssets`
    // download per archived frame to do it. The step still runs and still
    // says so, because a skipped read and an empty archive are different
    // facts about a run.
    //
    // NO scene filter here, deliberately: the copy that names each slide's
    // scene has not been written yet (it is `05`, inside the attempt loop),
    // and a step that runs once per run cannot filter on it without either
    // guessing or moving into the loop and re-reading the archive on every
    // attempt. The archive is offered as a POOL and the vet decides per
    // slide, exactly as it does for every harvested candidate.
    const previousPostRunId = skeletonHistory.entries.at(-1)?.runId;
    const libraryRead = await wf.step.code("05y-read-media-library", async () => {
      const list = tools["media.libraryList"];
      const ingest = tools["media.ingestAssets"];
      /** `selected` is what the archive HELD for this post; `offered` is what actually reached the pool. They differ when a frame's object could not be re-read. */
      const empty = (note: string) => ({ candidates: [] as ImageCandidate[], selected: [] as string[], offered: [] as string[], excluded: [] as string[], considered: 0, note });
      if (clientMediaOnly) {
        return empty(
          "this run is set to client-provided media only, so the archive of earlier uploads was not read — tier 0 is the only tier and an uncovered photo slide takes the typographic downgrade",
        );
      }
      if (list === undefined) return empty("media.libraryList is not registered on this deployment");
      // Best-effort in every branch: `not_available` (no workspace),
      // `tooling_error` (an unparseable document) and an empty archive all
      // mean "no tier-0.5 candidates" and nothing else changes.
      try {
        const outcome = await list.execute({ ...(previousPostRunId !== undefined ? { excludeUsedInRunIds: [previousPostRunId] } : {}) }, { ctx });
        if (outcome.status !== "success") return empty(`the media library could not be read (${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""})`);
        const entries = (outcome.result as { entries: MediaLibraryEntry[] }).entries;
        const selection = selectLibraryCandidates(entries, "", {
          ...(previousPostRunId !== undefined ? { excludeUsedInRunIds: [previousPostRunId] } : {}),
          ledgerUsed: usedImages,
        });
        const selected = selection.candidates.map((c) => c.entry.assetId);
        if (selection.candidates.length === 0) {
          return {
            ...empty(`${entries.length} archived frame(s) on file, none offerable for this post`),
            considered: entries.length,
            // The reasons, without their asset ids: an id in this step's
            // output is the record of what was OFFERED, and a refused frame
            // listed beside them would read as one.
            excluded: selection.excluded.map((e) => e.reason),
          };
        }
        // A library entry is a durable URI, not a file — the `.media-cache/`
        // directory it was first read from belongs to a run that finished
        // months ago. Re-ingested through the same tool every other tier
        // uses, so one set of content-type, size and `assertInside`
        // guarantees covers library media too. With no ingester registered
        // the archive is still REPORTED (a trace that says nothing cannot be
        // told from an empty archive) and simply offers nothing.
        if (ingest === undefined) {
          return {
            ...empty(`${selected.length} archived frame(s) matched, but media.ingestAssets is not registered so none could be re-read`),
            selected,
            considered: entries.length,
            excluded: selection.excluded.map((e) => e.reason),
          };
        }
        // Slots start above EVERY tier-0 slot (`attached` is the number of
        // attachments requested, not the number that survived), so a library
        // frame and an upload can never be staged under the same `n<slot>-`
        // name, and the slot below is a key unique to this request.
        const requests = selection.candidates.map((candidate, index) => ({
          candidate,
          request: libraryIngestRequest(candidate, tier0Pool.attached + index + 1),
        }));
        const requestedBySlot = new Map(requests.map(({ candidate, request }) => [request.slot, candidate] as const));
        const ingested = await ingest.execute(
          {
            repoRoot: options.repoRoot,
            runId: wf.runId,
            assets: requests.map((r) => r.request),
          },
          { ctx },
        );
        if (ingested.status !== "success") {
          return {
            ...empty(`${selection.candidates.length} archived frame(s) could not be re-ingested (${ingested.status}${"reason" in ingested ? `: ${ingested.reason}` : ""})`),
            selected,
            considered: entries.length,
            excluded: selection.excluded.map((e) => e.reason),
          };
        }
        const staged = (ingested.result as { candidates: ImageCandidate[] }).candidates;
        // ── Each staged file re-joined to the ENTRY it came from, by slot ──
        //
        // Not by array index. `media.ingestAssets` returns the frames it could
        // read, not one per request: the risk `libraryIngestRequest`'s own doc
        // comment names — an archived frame whose object a lifecycle rule has
        // since deleted — drops out of `candidates`, and every later frame
        // then shifts up one. Index-pairing would hand frame 2's pixels frame
        // 1's stored sentence, and `06-vet-images` would score `claimMatch`
        // against a description of a different photograph: the gate built to
        // catch "the picture does not show the claim" returning a confident
        // lie, with `offered` naming the wrong asset ids in the trace too.
        //
        // A staged file whose name carries no recognisable slot is DROPPED
        // rather than offered with the generic ingest description: its bytes
        // are a real client frame, but which one is unknown, and a candidate
        // the vet cannot judge is worse than one slide fewer.
        const paired = staged.map((candidate) => {
          const slot = ingestedSlotOf(candidate.path);
          return { candidate, entry: slot === undefined ? undefined : requestedBySlot.get(slot)?.entry };
        });
        const unpaired = paired.filter((p) => p.entry === undefined).length;
        // The stored inspection, in the words the vet reads — built by the
        // same annotator a freshly inspected candidate goes through, so the
        // `claimMatch` identity rubric gets the named subjects either way.
        const candidates = paired.flatMap(({ candidate, entry }) =>
          entry === undefined ? [] : [{ ...candidate, description: describeLibraryCandidate(entry) }],
        );
        const offered = paired.flatMap(({ entry }) => (entry === undefined ? [] : [entry.assetId]));
        const missed = selected.filter((assetId) => !offered.includes(assetId));
        return {
          candidates,
          selected,
          offered,
          excluded: selection.excluded.map((e) => e.reason),
          considered: entries.length,
          note: [
            `${candidates.length} archived frame(s) offered at tier 0.5, with no vision call`,
            ...(missed.length > 0 ? [`${missed.length} matched frame(s) could not be re-read from their durable URI and were skipped`] : []),
            ...(unpaired > 0 ? [`${unpaired} staged file(s) could not be matched back to the archive entry they came from and were skipped`] : []),
          ].join("; "),
        };
      } catch (error) {
        return empty(`the media library could not be read (${(error as Error).message})`);
      }
    });
    /** Tier-0.5 paths, so `05c` never pays to re-inspect a frame whose description is already on file. That saving IS this tier. */
    const libraryPaths = new Set(libraryRead.candidates.map((c) => c.path));

    // ── 04k: freeze this run's ONE generation style (Phase 3, item S) ──
    //
    // Resolved ONCE, here, and inherited by every attempt, every revision and
    // every `image.generate` call — which is the entire promise: a set of
    // generated images has to read as one set, and re-resolving per attempt
    // is exactly how the third slide ends up in a different world from the
    // first. Checkpointed, so a resumed run replays the identical line.
    //
    // Placed immediately BEFORE `04c-resolve-templates` rather than after it
    // (a deliberate deviation from the spec's ordering): the renderer-side
    // half of item S is a stylesheet, and `04c` is where the documents this
    // run renders are written. A style frozen after `04c` would reach the
    // generator and miss the templates.
    //
    // The middle argument is the DERIVED kit, not the configured
    // `BrandTokens`: both treatment gates need `cssVars["--bg"]` and the
    // accent ring, and neither exists on `BrandTokens`.
    const frozenStyle: GenerationStyle = await wf.step.code("04k-freeze-generation-style", async () =>
      resolveGenerationStyle(visualDirection, effectiveKit, brief),
    );
    /**
     * The head fragments every rendered document receives: item M's device
     * stylesheet and item S's image-treatment sheet, in that order.
     *
     * One helper so the two can never arrive apart, and so a client with no
     * treatment (`"none"` — the default, and forced for a kit with no
     * treatment latitude) gets a byte-identical document to Phase 2's:
     * `imageTreatmentCssBlock` returns `""` there.
     */
    const headExtras = (): string => [deviceCssBlock(), imageTreatmentCssBlock(frozenStyle)].filter((s) => s.length > 0).join("\n");

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
    /**
     * The no-store branded path: copies every template file out of the
     * client's `templateDir` (which ships READ-ONLY in the container image —
     * in-place injection is impossible, not merely undesirable) into this
     * run's own `.template-cache/<runId>/`, splicing the brand head fragment
     * into each on the way. Same bounds check `materializeTemplates` itself
     * applies, for the same "a runId carrying ../ is the case that matters"
     * reason. Returns the archetype files present, preserving `files`'
     * existing meaning for `availableTemplates`/`resolveLayout`.
     */
    const materializeBrandedClientDir = async (): Promise<{ templateDir: string; files: string[] }> => {
      const relDir = `.template-cache/${wf.runId}`;
      const absDir = path.resolve(options.repoRoot, relDir);
      const rootResolved = path.resolve(options.repoRoot);
      if (absDir !== rootResolved && !absDir.startsWith(rootResolved + path.sep)) {
        throw new Error(`materializeBrandedClientDir: resolved dir escaped repoRoot (runId="${wf.runId}")`);
      }
      await fs.mkdir(absDir, { recursive: true });
      const fragments = await brandFragments();
      const srcDir = path.resolve(options.repoRoot, frozen.brandTokens.templateDir);
      const htmlFiles = (await fs.readdir(srcDir)).filter((f) => f.endsWith(".html"));
      for (const file of htmlFiles) {
        const html = await fs.readFile(path.join(srcDir, file), "utf8");
        // The no-store branded path is the one a BRANDLESS client takes, i.e.
        // exactly the client `extraHeadHtml` exists for (spec finding 10).
        await fs.writeFile(path.join(absDir, file), composeRawDocument(html, fragments.head, fragments.body, headExtras()), "utf8");
      }
      return { templateDir: relDir, files: htmlFiles.filter((f) => ARCHETYPE_TEMPLATE_FILES.includes(f)) };
    };

    /**
     * The token-drift note (modeled on karos-landing's own token-drift
     * gate): which brand hexes actually appear in the written template
     * files. Non-fatal by design — this exists so a trace can answer "did
     * the client's colors reach the pixels" without anyone re-deriving the
     * whole pipeline, not to hold a run over a hex.
     */
    const brandTokenDrift = async (templateDir: string): Promise<{ present: string[]; missing: string[] } | undefined> => {
      if (brandKit === undefined || Object.keys(brandKit.cssVars).length === 0) return undefined;
      const absDir = path.resolve(options.repoRoot, templateDir);
      // The whole directory, not just the archetype files — the base
      // slide.html carries the brand too, and a client whose dir holds ONLY
      // a base template would otherwise read as "every token missing".
      const htmlFiles = (await fs.readdir(absDir).catch(() => [] as string[])).filter((f) => f.endsWith(".html"));
      let combined = "";
      for (const file of htmlFiles) {
        combined += await fs.readFile(path.join(absDir, file), "utf8").catch(() => "");
      }
      const lower = combined.toLowerCase();
      const present: string[] = [];
      const missing: string[] = [];
      for (const [name, value] of Object.entries(brandKit.cssVars)) {
        (lower.includes(value.toLowerCase()) ? present : missing).push(`${name}=${value}`);
      }
      return { present, missing };
    };

    const templateResolution = await wf.step.code("04c-resolve-templates", async () => {
      if (options.templateStore !== undefined) {
        try {
          const fragments = await brandFragments();
          const materialized = await materializeTemplates({
            store: options.templateStore,
            repoRoot: options.repoRoot,
            runId: wf.runId,
            clientSlug: wf.clientSlug,
            clientTemplateDir: frozen.brandTokens.templateDir,
            clientTemplateFile: frozen.brandTokens.slideTemplate,
            ...(fragments.head !== undefined ? { brandHeadHtml: fragments.head } : {}),
            ...(fragments.body !== undefined ? { brandBodyHtml: fragments.body } : {}),
            // Phase 2, item M: the shared device stylesheet, on EVERY written
            // document. Brand-independent and always passed — a client with no
            // brand kit has no head fragment at all, so folding it into
            // `brandHeadHtml` would silently lose devices on exactly the
            // clients this parameter exists for.
            extraHeadHtml: headExtras(),
          });
          const files = Object.values(materialized.files);
          return {
            templateDir: materialized.templateDir,
            files,
            chosen: materialized.chosen,
            ...(brandKit !== undefined ? { brandTokenDrift: await brandTokenDrift(materialized.templateDir) } : {}),
          };
        } catch (error) {
          // A registry outage falls back to the on-disk path below rather
          // than failing the run — the whole point of the bundled floor.
          console.error("04c-resolve-templates: registry materialization failed, falling back to the client's templateDir", error);
        }
      }
      // No registry — copy the client's read-only templateDir into this run's
      // own directory, splicing in whatever belongs in the head. This is now
      // UNCONDITIONAL, and that is Phase 2's correction to it.
      //
      // It used to be gated on "is there something to splice": a brand kit,
      // or (Phase 0, item A) a script-font sheet for a non-Latin target
      // language even with no kit at all. Item M put a third fragment on
      // every document — `deviceCssBlock()`, where every `.dv-*` rule lives —
      // and that one is brand-independent and language-independent. Under the
      // old gate a client with no template registry, no brand kit and a Latin
      // target language fell through to the raw read-only dir, whose
      // `cover.html` defines only `.cov-device`: every number device on that
      // client rendered as unstyled default-size text over the ground. Which
      // is the brandless client `extraHeadHtml` was added for in the first
      // place (spec finding 10) — the gate just happened to spell the
      // condition as "has a brand or a non-Latin script".
      try {
        const branded = await materializeBrandedClientDir();
        return {
          ...branded,
          chosen: [],
          ...(brandKit !== undefined ? { brandTokenDrift: await brandTokenDrift(branded.templateDir) } : {}),
        };
      } catch (error) {
        console.error("04c-resolve-templates: branded copy of the client templateDir failed, falling back to the unbranded original", error);
      }
      // Last resort only: the client's own read-only dir, with no device
      // sheet and no brand fragment. Reached when the copy itself failed
      // (a read-only or full filesystem), where rendering unstyled devices
      // still beats not rendering at all.
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
    const ensureTemplatesOnDisk = async (validatedCustomArchetypes: readonly SlideCustomArchetype[] = []): Promise<void> => {
      /**
       * True when 04c pointed the renderer at the per-run cache dir — which
       * now happens on TWO paths: a registry materialization, or the
       * brand-kit copy of the client's read-only templateDir. Both are
       * per-instance disk state that a resume on a recycled instance loses,
       * so both get the same presence-check-and-rewrite treatment. Skipping
       * the branded no-store path here would recreate the exact
       * 9qkTWlg7e9ZLiVIZUok4 bug this function exists to close, on a new
       * path.
       */
      const usesRunCacheDir = effectiveTemplateDir !== frozen.brandTokens.templateDir;
      if (usesRunCacheDir && templateResolution.files.length > 0) {
        const absDir = path.resolve(options.repoRoot, effectiveTemplateDir);
        const allPresent = await Promise.all(
          templateResolution.files.map((file) =>
            fs
              .access(path.join(absDir, file))
              .then(() => true)
              .catch(() => false),
          ),
        );
        // IGSTYLE-3: re-materialize on a KIT change too, not only when a file
        // is physically missing — see `templatesMaterializedForKit`'s own
        // doc comment above.
        if (!allPresent.every(Boolean) || templatesMaterializedForKit !== effectiveKit) {
          try {
            if (options.templateStore !== undefined) {
              const fragments = await brandFragments();
              await materializeTemplates({
                store: options.templateStore,
                repoRoot: options.repoRoot,
                runId: wf.runId,
                clientSlug: wf.clientSlug,
                clientTemplateDir: frozen.brandTokens.templateDir,
                clientTemplateFile: frozen.brandTokens.slideTemplate,
                ...(fragments.head !== undefined ? { brandHeadHtml: fragments.head } : {}),
                ...(fragments.body !== undefined ? { brandBodyHtml: fragments.body } : {}),
                extraHeadHtml: headExtras(),
              });
            } else {
              // The branded no-store copy: pure local disk work, no registry
              // dependency, so this branch cannot even fail on an outage.
              await materializeBrandedClientDir();
            }
            templatesMaterializedForKit = effectiveKit;
          } catch (error) {
            // Same fallback rule as 04c-resolve-templates itself: a registry
            // outage here degrades layout variety, it does not fail the run.
            // `templatesMaterializedForKit` is deliberately NOT updated on
            // failure, so the next call retries rather than believing a
            // write that never happened.
            console.error("ensureTemplatesOnDisk: re-materialization failed, render will fall back to the client's own template", error);
          }
        }
      }

      // A validated `custom` archetype is never part of the registry fetch
      // above — it is THIS run's own, not-yet-promoted proposal, re-derived
      // straight from the checkpointed `copy` rather than fetched from
      // anywhere, and written unconditionally (never just "if missing"):
      // it's a pure, local, no-I/O-dependency rebuild, so re-writing it is
      // cheaper than checking first and there's no correctness reason to
      // skip it.
      if (validatedCustomArchetypes.length > 0) {
        const absDir = path.resolve(options.repoRoot, effectiveTemplateDir);
        const fragments = await brandFragments();
        for (const archetype of validatedCustomArchetypes) {
          try {
            await fs.writeFile(
              path.join(absDir, templateFileName(archetype.archetypeId)),
              composeCustomArchetypeDocument(archetype, fragments.head, fragments.body, headExtras()),
              "utf8",
            );
          } catch (error) {
            // Same "degrade, never fail the run" rule as everywhere else in
            // this function — a write failure here just means the slide
            // renders with a "template not found" tooling error further
            // downstream is impossible to avoid, but SHOULD not happen: disk
            // writes to a bounds-checked, already-existing directory fail
            // only on a genuine I/O problem, not a content one.
            console.error(`ensureTemplatesOnDisk: could not write custom archetype "${archetype.archetypeId}" to disk`, error);
          }
        }
      }

      // ── IGSTYLE-10, §10a — materialize every archetype file's ground/fg-
      // INVERTED sibling, so a slide `assembleSlidesData` points at the
      // "-inv" filename finds it on disk. Written unconditionally, same
      // as the custom-archetype block above: a few more KB of writes is
      // cheap next to a failed run, and it keeps this in lockstep with
      // whatever the primary materialization (registry, branded-copy, or
      // custom-archetype) just wrote — including a custom archetype's own
      // file, which is why this runs LAST, after both blocks above.
      //
      // Only possible when the effective kit actually derived a ground/fg
      // pair — nothing to swap otherwise, §10a's own "a derivable neutral
      // pair" requirement — and only when the renderer is pointed at a
      // writable per-run directory rather than the client's own read-only
      // `templateDir` (the no-registry, no-brand-kit floor, which also never
      // derives a pair in the first place, so this is mostly
      // belt-and-suspenders).
      const invertGround = effectiveKit?.cssVars["--bg"];
      const invertFg = effectiveKit?.cssVars["--fg"];
      if (invertGround !== undefined && invertFg !== undefined && effectiveTemplateDir !== frozen.brandTokens.templateDir) {
        const absDir = path.resolve(options.repoRoot, effectiveTemplateDir);
        // Appended AFTER whatever `:root{}` the primary file's own materialization
        // already spliced in — equal CSS specificity, later wins, the same rule
        // `buildBrandHeadHtml`'s own doc comment already relies on.
        const invertedHeadHtml = `<style>\n:root {\n  --bg: ${invertFg};\n  --fg: ${invertGround};\n}\n</style>`;
        const isAlreadyInverted = (file: string): boolean => {
          const dot = file.lastIndexOf(".");
          const stem = dot === -1 ? file : file.slice(0, dot);
          return stem.endsWith(INVERTED_TEMPLATE_SUFFIX);
        };
        try {
          const htmlFiles = (await fs.readdir(absDir)).filter((f) => f.endsWith(".html") && !isAlreadyInverted(f));
          for (const file of htmlFiles) {
            const primary = await fs.readFile(path.join(absDir, file), "utf8");
            const inverted = primary.includes("</head>") ? primary.replace("</head>", `${invertedHeadHtml}\n</head>`) : `${invertedHeadHtml}\n${primary}`;
            await fs.writeFile(path.join(absDir, invertedTemplateFileName(file)), inverted, "utf8");
          }
        } catch (error) {
          // Same "degrade, never fail the run" posture as every other write
          // in this function: a slide that wanted the inverted variant and
          // didn't get one falls through to `publish.renderCarousel`'s own
          // missing-template tooling error, which is loud (a real trace
          // entry), never a silently-wrong render.
          console.error("ensureTemplatesOnDisk: writing ground/fg-inverted template variants failed", error);
        }
      }
    };

    // ── 05-08b: write copy -> vet images -> emit + self-check + craft-hygiene
    //           -> render -> post-render visual QA, all sharing ONE retry
    //           budget capped at two returns to step 05 (RFC-03 §3 step 07,
    //           extended by Fixes 2/3 to cover the two new checks) ──
    const angleAgent = new InstagramAngleAgent({ router: options.router, tools, promptStore: options.promptStore });
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

    // (04e-read-output-history and 04f-read-intel-context moved above step 04a
    // in 2026-09 so the trend scout can read them; same step ids, same reads.)

    /**
     * The reviewer's structured colour pick from the PREVIOUS round's gate
     * response (IGSTYLE-3, §2.2 Layer 2) — `RevisionNote` (the shared,
     * cross-agent primitive in `packages/workflow`) carries only
     * `{revision, actor, at, feedback}`, deliberately never `edits`, so this
     * is captured separately, in `onDecision` below, rather than by widening
     * that shared shape for one agent's use. Read by `draftOnce` at the START
     * of the NEXT round; always `undefined` for revision 0, since there is no
     * previous round's response yet — which is exactly what keeps revision 0
     * unaffected.
     */
    let latestStyleEdit: StyleEdit | undefined;

    /** What one drafting pass produces, once its own self-checks have passed. */
    interface DraftResult {
      copy: InstagramCopyOutput;
      selections: ImageSelection[];
      slidesData: RenderCarouselInput;
      rendered: RenderCarouselResult;
      /**
       * IGSTYLE-3, §2.3's "loud refusals" requirement — what THIS round's
       * style-directive resolution did (`04g-style-directive`) plus any
       * `effectiveBrandKit` pair-drop refusal, surfaced verbatim in the gate
       * payload as `styleDirectiveOutcome`. `undefined` only when nothing was
       * even attempted — no structured pick, no free-text feedback, no
       * learned prior (the overwhelming majority of revision-0 rounds).
       */
      styleDirectiveOutcome?: {
        source: StyleDirectiveResult["source"];
        applied: string[];
        intents: StyleIntent[];
        refusals: StyleRefusal[];
        /**
         * IGSTYLE-5, §2.4 writer 1 — "carry the round's resolved `style`
         * patch + `source`": this round's own `styleDirectiveResult.overrides`
         * verbatim (never `effectiveBrandKit`'s re-derived/merged kit), so
         * `persistReviewFeedback` below can hand it straight to
         * `memory.appendFeedback`'s `style` field as future evidence for
         * `distillStylePreferences` to vote over. Additive to the gate
         * payload too — a reviewer seeing exactly which hex a refused pick
         * resolved to, alongside the refusal, is strictly more informative
         * than before.
         */
        overrides: StyleOverrides;
      };
      /**
       * IGSTYLE-7, §7b/7c — every departure this round's variation budget (or
       * an intent-only satisfaction) made from the raw learned prior
       * (`distilledStyle.overrides`/`.intents`), for the gate payload's own
       * `styleVariation`. Absent (never an empty array) when nothing
       * departed — the overwhelming majority of rounds: every learned role at
       * or above `VARIATION_THRESHOLD`, or no learned prior at all.
       */
      styleVariation?: StyleVariationEntry[];
      /**
       * IGSTYLE-10, §10e — which axis each slide used this attempt, and why
       * not when it didn't (`variationPlan`'s own doc comment in
       * `slides-data.ts` names every reason string). Absent only when
       * neither axis was even attempted — no accent ring AND no derived
       * ground/fg pair, i.e. a client with no brand kit at all — matching
       * every other optional gate-payload field's "absent, never empty"
       * convention here.
       */
      variationPlan?: VariationPlanEntry[];
      /** SCRUM-393 (IGSTYLE-8) — text and accent-on-ground contrast, reported as facts. Never gates. */
      contrastFacts: ContrastFact[];
      /**
       * Phase 0, item C — the relevance judge's verdict on the WINNING attempt
       * (`07g-relevance-attempt-N`), for the gate payload's and the
       * deliverable's `grounding.relevance`. Absent when the judge could not
       * run on that attempt (it fails open with a ledger warn), so a reviewer
       * can tell "judged 5/5" from "not judged" — never a fabricated score.
       *
       * `note` is present only when the score passed on the RELAXED floor
       * (`relevanceFloor` for a brief with no product-information and no
       * target-audience document): the post shipped at 2/5, and the reviewer
       * is told why the usual floor of 3 could not be applied to this client.
       */
      relevance?: { score: number; reason: string; note?: string };
      /**
       * Phase 1, item K — what `04i`/`04j` decided for THIS round: the chosen
       * angle, the two rejected ones with their scores, or
       * `status: "unavailable"` when the proposer could not run (fail-open).
       * Absent only when the round skipped the proposal entirely — the run was
       * already past the hard max and finished on the cheapest complete path.
       */
      angleDecision?: AngleDecision;
      /**
       * Phase 2, item L — the SHIPPED attempt's visual-interest floor: the
       * per-slide measurement, every finding, the clause-E waivers, the
       * warnings, and the slides the measurement could not read. Always
       * present (it is measured on every attempt at $0), so the gate payload
       * and the deliverable carry the numbers whether or not anything failed.
       */
      interest: InterestFloorReport;
      /**
       * The free deterministic re-layout this attempt ran, when the floor
       * failed and the remedy table had something to try. Absent on the
       * overwhelming majority of attempts — the floor passed — which is what
       * makes its presence on the gate meaningful: CODE fixed something the
       * writer got wrong.
       */
      interestRelayout?: InterestRelayoutPlan;
      /**
       * Set only when the floor was STILL failing on the final attempt (or
       * past the run's hard max): the post ships `degraded` with these
       * numbers rather than holding. An empty-looking slide is a
       * picture/layout problem, and this workflow's opening promise is that
       * one never costs the post — see `zero-held-guarantee.test.ts`.
       */
      interestDegraded?: InterestFloorReport;
      /**
       * Phase 2, item P — the layout sequence this attempt shipped, the
       * previous post's, and how far apart they measured. The first time
       * "are we shipping the same post every week" is answerable from the
       * portal.
       */
      skeleton: SkeletonVarietyVerdict;
      /**
       * Phase 2, item M — devices this attempt's copy authored that could not
       * render HONESTLY (a bar filling its whole track, a half-empty
       * before/after) and were therefore dropped from the render by
       * `contentFor`. A WARN-only fact: furniture must never be able to hold
       * a run, so this is surfaced rather than gated — without it the drop is
       * silent.
       */
      deviceIssues: Array<{ slide: number; kind: string; reason: string }>;
    }

    /**
     * Never prose — excluded from anything a human or the topic guardrail
     * reads as text. Lifted to `visual-qa-pre-checks.ts` (Phase 0, item D)
     * so the default render rules count content elements by the same list.
     */
    const NON_PROSE_FIELD_KEYS = LAYOUT_FIELD_KEYS;

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

      /**
       * The attempt cap THIS run drafts under: `MAX_SELF_CHECK_ATTEMPTS` by
       * default, lowered to 2 by the budget plan (lever 3, "one return to
       * step 05 instead of two") when the pre-run estimate did not fit the
       * target. Decided at 02j, before the loop — the budget never cuts the
       * loop mid-way into a hold (owner's rule), and a reviewer's `revise`
       * always gets its round: a run over the hard max drafts it on the
       * cheapest path instead of refusing.
       */
      const maxAttempts = Math.min(MAX_SELF_CHECK_ATTEMPTS, Math.max(1, budgetPlan.maxSelfCheckAttempts));

      // ── 04g: this round's style directive (IGSTYLE-3, §2.2 Layer 2 — ACTIVE, binding within this run) ──
      //
      // Revision-scoped, not attempt-scoped: resolved once here, reused by
      // every attempt in the loop below, exactly like `directive` above.
      // Revision 0 always sees `latestStyleEdit === undefined` and
      // `notes.length === 0`, so `parseStyleDirective` returns
      // `{overrides:{}, source:"none"}` unconditionally with no special
      // casing needed — byte-identical to a run before this ticket existed.
      //
      // The context this round's directive resolves AGAINST is Layer 0's own
      // ground/fg/ring (`brandKit`, not `effectiveKit`) — a directive is
      // always relative to the client's actual baseline kit, never to a
      // PREVIOUS round's already-adjusted colours, so "darker" means "darker
      // than the brand's real ground" in every round, not a runaway drift.
      const latestFeedback = notes.length > 0 ? notes[notes.length - 1]!.feedback : undefined;
      const styleDirectiveResult: StyleDirectiveResult = await wf.step.code(rev("04g-style-directive"), () =>
        parseStyleDirective(
          {
            ...(latestStyleEdit !== undefined ? { style: latestStyleEdit } : {}),
            ...(latestFeedback !== undefined ? { feedback: latestFeedback } : {}),
          },
          {
            ...(brandKit?.cssVars["--bg"] !== undefined ? { ground: brandKit.cssVars["--bg"] } : {}),
            ...(brandKit?.cssVars["--fg"] !== undefined ? { fg: brandKit.cssVars["--fg"] } : {}),
            ring: brandKit?.palette ?? [],
          },
          { router: options.router },
        ),
      );

      // ── IGSTYLE-7, §2.6 tier 2b: spend the variation budget on the LEARNED
      // prior — never on THIS round's own active directive, which stays
      // binding (`styleDirectiveResult.overrides` is untouched below and is
      // still merged LAST inside `effectiveBrandKit`, so "in-run supremacy"
      // holds structurally: an explicit directive always outranks whatever
      // 7b/7c produce here, exactly as IGSTYLE-3 already guarantees). ──
      // ── Phase 0, item G: a learned accent OUTSIDE the brand kit's ring is a
      // note for the reviewer, never applied. The ring is the single source of
      // truth for which accents this kit legally ships; applying a past "loved
      // the orange" vote from outside it set the render up to fail its own
      // palette gate three attempts later (prep run pubsub-21634455753345065,
      // $0.86 for nothing). Ground/fg are untouched — they have their own
      // contrast-floor refusal path. Each note becomes a `StyleRefusal` below,
      // written to the ledger and shown on the gate payload like any other.
      const { applied: ringLegalLearnedStyle, notes: learnedRingNotes } = filterLearnedStyleToRing(learnedStyle, brandKit?.palette ?? []);
      const { varied: variedLearnedStyle, variations: budgetVariations } = varyLearnedStyle(ringLegalLearnedStyle, distilledStyle.strength, wf.runId, {
        ...(brandKit?.cssVars["--bg"] !== undefined ? { baselineGround: brandKit.cssVars["--bg"] } : {}),
        ...(brandKit?.cssVars["--fg"] !== undefined ? { baselineFg: brandKit.cssVars["--fg"] } : {}),
        ring: brandKit?.palette ?? [],
      });

      // ── 7c: an intent survives even when its hex lost the distillation
      // vote (`distillStylePreferences`'s own rule 10) — satisfy the
      // DIRECTION against Layer 0's own baseline via the exact same
      // `applyIntents` Tier 1/2 already use, never pinning the specific hex
      // that lost. Only for roles 7b left untouched (a role already varied,
      // or already promoted at full strength, has nothing left to satisfy). ──
      const unsatisfiedIntents = distilledStyle.intents.filter((intent) => variedLearnedStyle[intent.role] === undefined);
      const intentSatisfaction =
        unsatisfiedIntents.length > 0
          ? applyIntents(unsatisfiedIntents, {
              ...(brandKit?.cssVars["--bg"] !== undefined ? { ground: brandKit.cssVars["--bg"] } : {}),
              ...(brandKit?.cssVars["--fg"] !== undefined ? { fg: brandKit.cssVars["--fg"] } : {}),
              ring: brandKit?.palette ?? [],
            })
          : { overrides: {}, applied: [], refusals: [] };
      for (const [role, hex] of Object.entries(intentSatisfaction.overrides)) {
        variedLearnedStyle[role] = hex;
      }
      const styleVariation: StyleVariationEntry[] = [
        ...budgetVariations,
        ...unsatisfiedIntents
          .filter((intent) => intentSatisfaction.overrides[intent.role] !== undefined)
          .map((intent) => ({
            role: intent.role,
            prior: `(no hex reached the evidence threshold for ${intent.role})`,
            used: intentSatisfaction.overrides[intent.role]!,
            reason: `distillation rule 10: the "${intent.direction}" intent survived even though no specific hex won the vote for ${intent.role} — satisfied the direction against baseline rather than pinning the losing hex`,
          })),
      ];

      const { kit: revisionEffectiveKit, refusals: kitRefusals } = effectiveBrandKit(
        rawBrand,
        frozen.brandTokens,
        variedLearnedStyle as StyleOverrides,
        styleDirectiveResult.overrides,
        brandKit,
      );
      // Every consumer below this line — `brandFragments`, `brandLogoAssessment`,
      // `ensureTemplatesOnDisk`, and every `effectiveKit?.X` read further down
      // in this attempt loop — now sees THIS round's kit.
      effectiveKit = revisionEffectiveKit;

      // ── IGSTYLE-10, §10a/10c-4 — this round's ground/fg inversion axis. ──
      //
      // Undefined (never attempted) when the effective kit derives no
      // ground/fg pair at all — §10a's own "a derivable neutral pair"
      // requirement. `directivePinned` reads THIS round's own resolved
      // Layer-2 patch (`styleDirectiveResult.overrides`, never the merged/
      // varied kit) — a reviewer who pinned so much as one colour this round
      // must see every slide obey it, never 25% inverted against it.
      const groundFgInversion: GroundFgInversionConfig | undefined =
        effectiveKit?.cssVars["--bg"] !== undefined && effectiveKit.cssVars["--fg"] !== undefined
          ? {
              ground: effectiveKit.cssVars["--bg"],
              fg: effectiveKit.cssVars["--fg"],
              directivePinned: Object.keys(styleDirectiveResult.overrides).length > 0,
            }
          : undefined;

      const allStyleRefusals: StyleRefusal[] = [
        ...styleDirectiveResult.refusals,
        ...kitRefusals,
        ...learnedRingNotes.map((reason): StyleRefusal => ({ role: "accent", requested: learnedStyle.accent ?? "(learned accent)", reason })),
      ];
      // Loud refusals (§2.3, mandatory): a silently-dropped directive is
      // indistinguishable from the original bug this whole ticket exists to
      // fix. One ledger event per revision (not per refusal) — `eventId` has
      // no per-role suffix, so a re-run that hits the identical refusal(s)
      // again collapses to the SAME row via karos-ledger's own
      // `(runId, eventId)` idempotency, exactly like SCRUM-393's
      // contrast-below-floor warn.
      if (allStyleRefusals.length > 0) {
        await wf.step.code(rev("04g-style-directive-record-refusal"), async () => {
          const summary = allStyleRefusals
            .map(
              (r) =>
                `${r.role} "${r.requested}": ${r.reason}${r.contrastRatio !== undefined ? ` (measured ${r.contrastRatio.toFixed(2)}:1)` : ""}`,
            )
            .join("; ");
          await tools["ledger.appendEvent"]?.execute(
            {
              runId: wf.runId,
              eventId: `${wf.runId}__style-directive-refused-r${revision}`,
              level: "warn",
              message: `round ${revision}'s style directive was partially or fully refused: ${summary}`,
            },
            { ctx },
          );
          return null;
        });
      }

      const styleDirectiveOutcome: DraftResult["styleDirectiveOutcome"] =
        styleDirectiveResult.source !== "none" || allStyleRefusals.length > 0
          ? {
              source: styleDirectiveResult.source,
              applied: [...styleDirectiveResult.applied],
              intents: [...styleDirectiveResult.intents],
              refusals: allStyleRefusals,
              overrides: { ...styleDirectiveResult.overrides },
            }
          : undefined;

      // ── 04i / 04j: the angle this carousel argues (Phase 1, item K) ──
      //
      // The audit's copy was competent and said nothing: research facts,
      // restated. The angle IS the editorial judgment — a wrong assumption in
      // the niche, a surprising number, or what this means for the ICP — and
      // one Sonnet call proposes three of them, each resting on named fact
      // cards and carrying the ONE sentence the reader should remember.
      // `selectAngle` then picks in code: brief fit × novelty against the
      // ledger × mode fit, so a proposal that repeats last week's line scores
      // zero however confident it is.
      //
      // Once per REVISION, outside the attempt loop (~$0.036, ≤ 3 per run):
      // three redrafts of the same round argue the same angle, which is the
      // point — a redraft fixes a finding, it does not change the argument.
      // A reviewer's `revise` round proposes fresh, with their words attached.
      //
      // FAILS OPEN, always. A malformed proposal or an exhausted turn budget
      // records `angleDecision.status === "unavailable"`, writes one ledger
      // warn, and the copy step drafts with no `angle` block at all — a
      // documented, unchanged path in prompt @13 §17. An angle improves a
      // post; it is not a precondition for one (owner's rule: a deliverable
      // always reaches the client).
      const pastAngles = pastAnglesFromDecisions(recentDecisions);
      let angleDecision: AngleDecision | undefined;
      if (meter.posture === "cheapest-path") {
        // Past the hard max: finish on the cheapest path that still yields a
        // complete deliverable. The angle is optional work by construction.
        budgetNotes.push("budget: angle proposal skipped on the cheapest complete path");
      } else {
        // A revision's own estimate, as a NOTE rather than a hold (owner's
        // amendment): a reviewer who asked for a change always gets their
        // round, and the meter's posture already trims the optional work
        // inside it.
        if (revision >= 1) {
          const verdict = meter.canAfford(revisionEstimateUsd({ attempts: maxAttempts, targetLanguage: targetLanguage !== undefined, angle: true }));
          if (!verdict.ok) budgetNotes.push(`budget: ${verdict.reason} — the revision runs on the cheapest complete path`);
        }
        const angleExec = await wf.step.agent(rev("04i-propose-angles"), angleAgent, {
          topicDecision: topicDecisionForGate(topicClaim),
          mode: topicClaim.mode ?? modeSelection.mode,
          clientBrief: briefForPrompt(brief),
          // The deduped cards (04b2), in the SAME ordered slice the writer
          // gets (`promptFacts`) — `restsOn` must name one of these verbatim,
          // so the proposer sees exactly what the writer will.
          facts: factsForAnglePrompt(promptFacts),
          pastAngles,
          targetLanguage: targetLanguage ?? "English",
          ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
          ...(directive !== undefined ? { revisionRequest: directive } : {}),
        });
        spend(rev("04i-propose-angles"), angleExec.totalCostUsd, STEP_COST_ESTIMATES_USD.angle);
        if (angleExec.status === "completed" && angleExec.finalOutput !== undefined && angleExec.finalOutput !== null) {
          const proposal = angleExec.finalOutput;
          angleDecision = await wf.step.code(rev("04j-select-angle"), () =>
            selectAngle(proposal.angles, {
              brief,
              // The eligibility set is the list the proposer SAW, not the full
              // deduped set: an angle resting on a card that never reached
              // either prompt is one the writer could not attribute.
              facts: promptFacts,
              pastAngles,
              recentExcerpts: crossChannel.entries.slice(-5).map((e) => e.excerpt),
              mode: topicClaim.mode ?? modeSelection.mode,
            }),
          );
        } else {
          angleDecision = angleUnavailable(`the angle proposer did not complete (${angleExec.status})`);
          // Keyed per revision so a resumed run writes ONE row, and so a
          // second round's outage is visible as its own.
          await tools["ledger.appendEvent"]?.execute(
            {
              runId: wf.runId,
              eventId: `${wf.runId}__angle-unavailable-r${revision}`,
              level: "warn",
              message: `revision ${revision}: the angle proposer could not run (${angleExec.status}); the post was drafted without an angle`,
            },
            { ctx },
          );
        }
      }
      /** `{ chosen, rejected }` for the copy prompt (§17) — `undefined` on the fail-open path, which the prompt documents as an unchanged drafting path. */
      const angleForCopy = angleDecision !== undefined ? angleForCopyInput(angleDecision) : undefined;

      let finalCopy: InstagramCopyOutput | undefined;
      let finalSelections: ImageSelection[] | undefined;
      let finalSlidesData: RenderCarouselInput | undefined;
      let finalRendered: RenderCarouselResult | undefined;
      /** SCRUM-393 (IGSTYLE-8) — the winning attempt's contrast facts, carried into the gate payload. */
      let finalContrastFacts: ContrastFact[] = [];
      /** Phase 2, item L — the shipped attempt's measured interest report, its free re-layout (if one ran), and the degrade marker when the floor never cleared. */
      let finalInterest: InterestFloorReport | undefined;
      let finalInterestRelayout: InterestRelayoutPlan | undefined;
      /** Set on the last attempt when the floor was still failing: the post ships flagged, never held. Attempt-scoped and reset per attempt so a fixed attempt is not reported as degraded. */
      let interestDegraded: InterestFloorReport | undefined;
      /** Phase 2, item P — this attempt's skeleton verdict, for the gate payload, the deliverable, `08b` and `09b`'s write-back. */
      let skeletonForGate: SkeletonVarietyVerdict | undefined;
      let finalSkeleton: SkeletonVarietyVerdict | undefined;
      let finalOutcomeOk = false;
      let lastSelfCheckReason = "no attempt completed";
      /** Set by a failed 07d similarity check, so the NEXT attempt's prompt names exactly which published post to move away from. */
      let dedupeRetrySteer: string | undefined;
      /** Set by an off-brief 07g verdict (Phase 0, item C), so the NEXT attempt's prompt names the bridge the judge could not find. */
      let relevanceSteer: string | undefined;
      /**
       * Every OTHER self-check finding the next draft must fix — 07's slide
       * check, 07b craft hygiene, 07e script, 07f fluency, 07h default render
       * rules, 08b visual QA. Until 2026-09-09 `lastSelfCheckReason` was read
       * by nothing but the final `WorkflowHeld`, so a Hebrew draft that "reads
       * translated" was redrafted from a byte-identical prompt and the gate
       * was a hold generator, not a corrector (spec B: the draft returns to 05
       * WITH the findings). Handed to the copy step as `selfCheckSteer`
       * (prompt §16) for exactly one attempt — the one right after the
       * failure; relevance and dedupe keep their own typed steers.
       */
      let selfCheckSteer: string | undefined;
      /** Records why this attempt failed AND hands that finding to the next draft. */
      const returnToCopyWith = (reason: string): void => {
        lastSelfCheckReason = reason;
        selfCheckSteer = reason;
      };
      /** The winning attempt's relevance verdict, for `DraftResult.relevance`; undefined when the judge could not run on it. */
      let finalRelevance: DraftResult["relevance"];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Consumed here so a finding from attempt 1 never outlives attempt 2:
      // an attempt that fails on relevance or dedupe instead carries THOSE
      // steers, and a stale render-rule finding must not ride along with them.
      const priorFindings = selfCheckSteer;
      selfCheckSteer = undefined;
      // Item L's degrade marker is ATTEMPT-scoped: an attempt whose free
      // re-layout fixed the floor must not ship carrying the previous
      // attempt's finding.
      interestDegraded = undefined;
      const copyExec = await wf.step.agent(rev(`05-write-copy-attempt-${attempt}`), copyAgent, {
        ...runDirectionField(runDirection),
        topic: topicClaim.topic,
        // Phase 0, item C — who this client is (prompt §15), read BEFORE the
        // facts; and, after an off-brief verdict, why the last draft failed
        // the relevance check and must be fixed, not argued with.
        clientBrief: briefForPrompt(brief),
        // Phase 1, item K — the angle this carousel argues (prompt §17): the
        // chosen one plus the two it is NOT making, as context. Absent on the
        // fail-open path, which the prompt documents as an unchanged path.
        ...(angleForCopy !== undefined ? { angle: angleForCopy } : {}),
        ...(relevanceSteer !== undefined ? { relevanceSteer } : {}),
        // What the previous attempt's self-check found (prompt §16) — the
        // fluency judge's issues, the failed render rule and slide, the
        // banned phrase — so the redraft fixes the finding instead of
        // repeating the draft blind.
        ...(priorFindings !== undefined ? { selfCheckSteer: priorFindings } : {}),
        // The post format (2026-09): `carousel` (6-8 slides) or `single` (one
        // designed slide and a deep caption). The copy step echoes it back and
        // `checkSlidesData` holds the slide count to it.
        format: format.format,
        // The scouted story, when one took the slot: angle, hook, why-now, the
        // brand-fit bridge, and the source URLs it rests on.
        ...(topicClaim.trend !== undefined ? { trendCandidate: trendCandidateForDrafting(topicClaim.trend) } : {}),
        // What the client attached, as a vision model described it — slide N
        // is written TO the client's picture N.
        ...("analyses" in tier0Pool && tier0Pool.analyses.length > 0 ? { attachedMedia: tier0Pool.analyses } : {}),
        // Phase 1, item J: the DEDUPED cards (04b2), rendered primary-first
        // with `kind` always present — prompt @13 §18 routes a card by its
        // kind (stat -> stat_callout, quote -> quote_card, event -> date it)
        // and prefers a `primary: true` card over an article about it, and
        // `kind` is optional on the wire. `claim` is untouched, so step 07's
        // verbatim `sourceRef` trace against the full deduped set still holds.
        // The SAME list the angle proposer read (`promptFacts`), so a chosen
        // angle's `restsOn` cards are always here to be cited.
        facts: promptFacts,
        styleConfig: {
          // Phase 0, item D: when the default render rules are in force the
          // writer is told the rules it will be judged by at 07h/08b, rather
          // than discovering them as a redraft.
          rules: renderRuleSource === "default" ? [...frozen.styleConfig.rules, ...DEFAULT_RENDER_RULES] : frozen.styleConfig.rules,
          banned_words: frozen.styleConfig.banned_words,
          banned_chars: frozen.styleConfig.banned_chars,
          compliance: frozen.styleConfig.compliance,
        },
        brandTokens: frozen.brandTokens,
        // The client's own profile description + voice-rules guidelines,
        // verbatim — this is where a language requirement like Geektime's
        // "Hebrew-language technology site" actually lives. See step 02b.
        ...(clientVoiceContext !== undefined ? { clientVoiceContext } : {}),
        // The client's projected branding-guidelines context doc (C1,
        // T-A9) — visual-identity rules distinct from the voice/tone
        // `clientVoiceContext` already carries. See step 02e.
        ...(brandingGuidelines !== undefined ? { brandingGuidelines } : {}),
        // The client's intel report, distilled to what steers copy (voice
        // rows, positioning, whitespace opportunities) — authoritative
        // client knowledge, read BEFORE external facts. See step 04f.
        ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
        // What this agent already shipped for this client — hard
        // do-not-repeat constraints, distinct from `pastFeedback` (what a
        // person SAID) the same way decisions are distinct from feedback.
        ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
        ...(dedupeRetrySteer !== undefined ? { dedupeAvoid: dedupeRetrySteer } : {}),
        // Two distinct kinds of steer, kept apart on purpose: `pastFeedback` is
        // what this client has said across previous RUNS (durable memory), and
        // `revisionRequest` is what a reviewer asked for about THIS run's draft
        // minutes ago. Collapsing them would let a months-old preference argue
        // with an instruction someone just gave.
        ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
        ...(directive !== undefined ? { revisionRequest: directive } : {}),
        // Phase 2, item P (prompt @14 §21): the last five shipped layout
        // sequences, newest first, and the rule sentence that makes them an
        // avoid-list rather than decoration. Empty on a client's first post,
        // so the field is omitted and the prompt reads exactly as it did.
        // This is the CHEAP half of "repetition reads as AI" — `07k` is the
        // half that enforces it.
        ...(recentSkeletons.length > 0 ? { recentSkeletons, skeletonRule: SKELETON_RULE_SENTENCE } : {}),
      });
      spend(rev(`05-write-copy-attempt-${attempt}`), copyExec.totalCostUsd, STEP_COST_ESTIMATES_USD.copyAttempt);
      if (copyExec.status === "tooling_error") {
        throw new WorkflowToolingFailure(`copy step resolved to "${copyExec.status}" on attempt ${attempt}/${maxAttempts}`);
      }
      if (copyExec.status !== "completed") {
        // A malformed draft (failed its own output schema) or a draft that ran
        // out of turns gets the same "return to 05" remedy as a step-07
        // self-check failure below. `budget_exceeded` was a tooling failure
        // here until 2026-09-07: a designed ceiling reported as a fault, with
        // two attempts still unspent.
        lastSelfCheckReason = `copy draft ${copyExec.status === "budget_exceeded" ? "ran out of turns" : "failed its own output validation"} on attempt ${attempt}`;
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
          // Phase 3, item T: tier 0.5 — the client's own archive — sits after
          // this run's fresh uploads (a fresh upload is a fresh instruction)
          // and before 05b's harvesters. It is absent on a client-media-only
          // run for the reason `05y` states: `mediaSource: "client"` is "only
          // media I upload for THIS job", and `05y` returns nothing there.
          : [...tier0Pool.candidates, ...(clientMediaOnly ? [] : libraryRead.candidates)];
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
      // Phase 2, item M: `HERO_IMAGE_LAYOUTS`, not `=== "photo"`. `cover`
      // consumes a hero image exactly as `photo` does, so testing for `photo`
      // alone meant a cover was never offered one — and then degraded for
      // want of the picture nobody went looking for, which is a
      // self-fulfilling downgrade straight into the defect item M exists to
      // remove.
      // Phase 3, item R: AND the scene brief actually asked for a picture.
      // `source: "none"` is the writer saying this idea is not photographable
      // — it then gets `typographicSelection(...)` below instead of an
      // unfillable entry, so it costs no search, no vision inspection and no
      // vet slot, and (this is the load-bearing half) it never enters
      // `downgradedForImagesThisAttempt`: it lost nothing, so it must not be
      // waived by the cover/interest-floor waivers that exist for a LOST
      // photograph. `default:no-image-means-device` is what keeps the lever
      // honest — a slide that chose no picture must carry a device.
      const photoSlideNs = new Set(
        copy.slides.filter((s) => HERO_IMAGE_LAYOUTS.has(resolveLayout(s, availableTemplates).layout) && needsImageSourcing(normaliseVisualNeed(s))).map((s) => s.n),
      );
      // Phase 0, item F: Tier-0 slots are harvested for TOO on a system-managed
      // run. The vet may move a client's upload to the slide it honestly fits,
      // and the slot it left behind then has alternatives instead of a forced
      // text-only downgrade. A client-only run (`mediaSource: "client"`) keeps
      // today's behaviour: nothing is sourced beyond the uploads.
      const slidesNeedingSource = copy.slides.filter((s) => photoSlideNs.has(s.n) && (!clientMediaOnly || !tier0Slots.has(s.n)));
      if (clientMediaOnly && slidesNeedingSource.length > 0) {
        // Recorded in the sourcing layer's own words, so the downgrade below
        // says "the client asked for no sourcing", not "nothing qualified".
        sourcingReason = `client-provided media only: ${slidesNeedingSource.length} photo slide(s) the client did not cover were not sourced or generated`;
      }
      if (imageCandidatePool.length === 0 && slidesNeedingSource.length > 0 && findImages !== undefined && !clientMediaOnly) {
        const sourced = await wf.step.code(rev(`05b-source-images-attempt-${attempt}`), async () =>
          findImages.execute(
            {
              repoRoot: options.repoRoot,
              runId: wf.runId,
              // Explicit rather than the tool schema's own default: 05c pays a
              // vision inspection per candidate in this pool, and the run
              // budget's pre-run estimate prices that term off the same
              // constant (`CANDIDATES_PER_PHOTO_SLIDE`). Leaving the width to
              // the tool's default is how the estimate came to under-count
              // 05c sixfold.
              maxPerNeed: CANDIDATES_PER_PHOTO_SLIDE,
              // Only the slides Tier 0 did not already fill. Searching for a
            // slide that already has the client's own photo on it would be
            // paying a harvester to produce a candidate that must lose.
            needs: slidesNeedingSource.map((s) => ({ n: s.n, query: retrievalQueryFor(normaliseVisualNeed(s)) })),
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
        claimMatch: 5,
        claimMatchReason: "typographic layout, no photograph to judge",
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
        // Phase 0, item F: a picture that does not show the slide's CLAIM is
        // not a picture for that slide, however good it is — re-checked here
        // against the model's own score rather than trusted to its threshold.
        if (s.claimMatch < MIN_CLAIM_MATCH) return true;
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
                claimMatch: 1,
                claimMatchReason: "no candidate was sourced, so nothing could be judged against the claim",
              }
            : typographicSelection({ n: s.n, layout: resolveLayout(s, availableTemplates).layout }),
        );
        unfillable = selections.filter(isUnfillable);
      } else {
        // ── 05c: a vision model looks at the candidates BEFORE the vetting judgment (2026-09) ──
        //
        // The vetting agent judges from text. Until now that text was a
        // provider's alt string, so a watermark, a cookie banner or a picture
        // of the wrong thing entirely sailed through when the alt text was
        // agreeable. Now each candidate carries what a vision model actually
        // saw, and the ones it grades unusable or watermarked never reach the
        // gate at all. Best-effort: no vision backend, or a failed call, leaves
        // the pool exactly as it was.
        const inspectTool = tools["media.inspectImages"];
        // Cheapest path (budget): over the hard max the per-candidate vision
        // pass is optional spend and is skipped; the vet still judges every
        // candidate, and rights/watermark/claim-match are still enforced.
        // Phase 3, item T: a tier-0.5 frame is ALREADY described — that is the
        // whole saving — so it is passed through rather than re-inspected,
        // and a pool made only of archived frames costs no vision call at all.
        const needsInspection = attemptPool.filter((c) => !libraryPaths.has(c.path));
        if (inspectTool !== undefined && meter.posture !== "cheapest-path" && needsInspection.length > 0) {
          attemptPool = await wf.step.code(rev(`05c-inspect-candidates-attempt-${attempt}`), async (): Promise<ImageCandidate[]> => {
            // Keyed by path and re-assembled in the ORIGINAL pool order at
            // the end, so passing a tier-0.5 frame through does not promote
            // it above this run's own uploads.
            const inspectedByPath = new Map<string, ImageCandidate | null>();
            let dropped = 0;
            for (let start = 0; start < needsInspection.length; start += 12) {
              const batch = needsInspection.slice(start, start + 12);
              const inspected = await inspectTool.execute(
                { repoRoot: options.repoRoot, images: batch.map((c, i) => ({ ref: `c-${start + i}`, path: c.path })), purpose: "candidate-vetting" },
                { ctx },
              );
              if (inspected.status !== "success") continue;
              const byRef = new Map(((inspected.result as { inspections: Array<Record<string, unknown>> }).inspections).map((i) => [i["ref"] as string, i]));
              batch.forEach((c, i) => {
                const found = byRef.get(`c-${start + i}`);
                if (!found) return;
                if (found["quality"] === "unusable" || found["hasWatermark"] === true) {
                  dropped += 1;
                  inspectedByPath.set(c.path, null);
                  return;
                }
                // Same annotation the tier-0 path builds, flags included:
                // description, then the NAMED subjects the vet's claimMatch
                // rubric is written against, then legible text, then the
                // screenshot / AI-generated flags.
                inspectedByPath.set(c.path, { ...c, description: describeWithVision(c.description, found, { includeFlags: true }) });
              });
            }
            if (dropped > 0) sourcingReason = `${sourcingReason ? `${sourcingReason}; ` : ""}${dropped} candidate(s) dropped by vision inspection (watermarked or unusable)`;
            return attemptPool.flatMap((c) => {
              if (!inspectedByPath.has(c.path)) return [c];
              const enrichedCandidate = inspectedByPath.get(c.path);
              return enrichedCandidate === null || enrichedCandidate === undefined ? [] : [enrichedCandidate];
            });
          });
          spend(rev(`05c-inspect-candidates-attempt-${attempt}`), undefined, needsInspection.length * STEP_COST_ESTIMATES_USD.visionInspectPerImage);
        }
        const imageExec = await wf.step.agent(rev(`06-vet-images-attempt-${attempt}`), imageAgent, {
          // Only the photo slides are put in front of the gate. A typographic
          // archetype has nothing for it to judge, and including it would ask
          // the model to match a picture to a slide that renders none.
          // Phase 0, item F (`instagram-image-vet@3`): each slide carries its
          // headline and body so the vet judges whether a picture shows the
          // CLAIM, not merely the objects `visualNeed` lists; and whether the
          // slot holds a client upload, so it can re-offer that upload to the
          // slide it honestly fits.
          slides: copy.slides
            .filter((s) => photoSlideNs.has(s.n))
            .map((s) => ({ n: s.n, headline: s.headline, body: s.body, ...vetSubjectFor(normaliseVisualNeed(s)), isClientPhotoSlot: tier0Slots.has(s.n) })),
          candidatePool: attemptPool,
          usedImages,
        });
        spend(rev(`06-vet-images-attempt-${attempt}`), imageExec.totalCostUsd, STEP_COST_ESTIMATES_USD.vetCall);
        if (imageExec.status === "tooling_error") {
          throw new WorkflowToolingFailure(`image vetting step resolved to "${imageExec.status}" on attempt ${attempt}/${maxAttempts}`);
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
            // Phase 3, items Q + S: this client's own direction, with the
            // run's FROZEN style lock winning over whatever the direction
            // says — `buildArtDirection` re-reads a direction that can drift
            // between attempts, `frozenStyle` cannot.
            art: { ...buildArtDirection(frozen.brandTokens, visualDirection), ...(frozenStyle.line !== undefined ? { styleLock: frozenStyle.line } : {}) },
          }),
        },
      ];

      /** Slides a rescue tier could not even ask for this attempt, with the budget reason: the run's image cap was spent, or the meter/plan stopped optional work (Phase 0 cost controls). */
      const rescueSkipped = new Map<number, string>();

      let tierIndex = 0;
      for (const tier of rescueTiers) {
        tierIndex += 1;
        // Client-only runs never scrape or generate: the gaps stay gaps and
        // take the downgrade path with the sourcing reason recorded above.
        if (clientMediaOnly || unfillable.length === 0 || tier.tool === undefined) continue;

        let gaps: ImageGap[] = unfillable
          .map((u) => {
            // Phase 3, item R: the FULL scene brief is what `image.generate`
            // interpolates, and it is the field that was starved — a twelve-word
            // keyword string was never a brief for a generator.
            const slide = copy.slides.find((sl) => sl.n === u.n);
            return { n: u.n, prompt: slide === undefined ? undefined : generationPromptFor(normaliseVisualNeed(slide)) };
          })
          .filter((g): g is ImageGap => g.prompt !== undefined);
        if (gaps.length === 0) continue;

        // Budget (owner's rule): the rescue tiers are OPTIONAL spend. They are
        // skipped — the gaps take the text-only downgrade, exactly like "no
        // viable image" today — when the plan turned optional re-vets off
        // (lever 4) or the live meter has crossed the target. Never a hold.
        if (!budgetPlan.optionalRevets) {
          for (const g of gaps) rescueSkipped.set(g.n, "optional rescue re-vets skipped by the run budget plan");
          continue;
        }
        if (meter.posture !== "normal") {
          for (const g of gaps) rescueSkipped.set(g.n, `run budget ${meter.crossedMax ? "hard max" : "target"} crossed (${formatUsd(meter.totalUsd)}) — no more ${tier.id === "generate" ? "generated images" : "rescue re-vets"}`);
          continue;
        }

        // Phase 0 cost controls: generation is billed per image, and it used to
        // be uncapped — a three-attempt run with several gaps each could bill
        // a dozen images. At most the plan's `generatedImagesCap` per RUN (not
        // per attempt; 8 at the widest, fewer when the estimate was adapted);
        // gaps over the cap stay unfillable and take the text-only downgrade
        // with the budget named as the reason — an adaptation, not a hold.
        if (tier.id === "generate") {
          const budget = remainingGenerationBudget(generatedSoFar, budgetPlan.generatedImagesCap);
          for (const over of gaps.slice(budget)) rescueSkipped.set(over.n, `generation budget for this run spent (${budgetPlan.generatedImagesCap} images)`);
          gaps = gaps.slice(0, budget);
          if (gaps.length === 0) continue;
        }

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
        if (tier.id === "generate") {
          generatedSoFar += tierPool.length;
          spend(rev(`06d-generate-images-attempt-${attempt}`), undefined, tierPool.length * STEP_COST_ESTIMATES_USD.generatedImage);
        } else {
          spend(rev(`06b-scrape-images-attempt-${attempt}`), undefined, gaps.length * STEP_COST_ESTIMATES_USD.scraperExecution);
        }
        if (tierPool.length === 0) continue;

        const revet = await wf.step.agent(rev(`06${"ce"[tierIndex - 1]}-vet-${tier.id}-attempt-${attempt}`), imageAgent, {
          // Same shape as 06's input (Phase 0, item F): the re-vet judges the
          // rescue candidates against the slide's claim too.
          slides: gaps.map((g) => {
            const slide = copy.slides.find((sl) => sl.n === g.n);
            return { n: g.n, headline: slide?.headline ?? "", body: slide?.body ?? "", scene: g.prompt, isClientPhotoSlot: tier0Slots.has(g.n) };
          }),
          candidatePool: tierPool,
          usedImages,
        });
        spend(rev(`06${"ce"[tierIndex - 1]}-vet-${tier.id}-attempt-${attempt}`), revet.totalCostUsd, STEP_COST_ESTIMATES_USD.vetCall);
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
      /** Which slides THIS attempt downgraded for want of a picture — read by 07h so a lost photograph is never mistaken for a copy defect. */
      let downgradedForImagesThisAttempt = new Set<number>();
      if (unfillable.length > 0) {
        // `s.reason` carries the real diagnostic (an unset key, a provider's
        // own "no results" chain, the vetting model's own explanation) —
        // the category label alone ("no candidate qualified") is exactly
        // the generic-editorial-verdict framing prep run
        // pubsub-21528976110173438 got burned by, with the actual cause
        // (an unset UNSPLASH_ACCESS_KEY) sitting one step upstream of it.
        const detail = unfillable.map((s) => {
          if (s.imagePath === null) return `${s.n}: ${rescueSkipped.has(s.n) ? `${rescueSkipped.get(s.n)}; ` : ""}${s.reason}`;
          if (!s.rightsUsable) return `${s.n}: not rights-usable (${s.reason})`;
          if (!s.watermarkFree) return `${s.n}: not watermark-free (${s.reason})`;
          // Phase 0, item F: the picture exists and is clean, but it does not
          // show what the slide claims — the vet's own words say what it shows.
          if (s.claimMatch < MIN_CLAIM_MATCH) return `${s.n}: picture does not show the slide's claim (claimMatch ${s.claimMatch}/5: ${s.claimMatchReason})`;
          return `${s.n}: already used in a prior post`;
        });
        const downgradedNs = new Set(unfillable.map((s) => s.n));
        downgradedForImagesThisAttempt = downgradedNs;
        // Phase 2, item M: the downgrade goes through the LADDER, not
        // straight to `text_only`.
        //
        // Item M widened image sourcing to covers (`HERO_IMAGE_LAYOUTS`), so
        // slide 1 now lands here whenever no picture survived the tiers. A
        // forced `text_only` routes to the client's own `slide.html`, which
        // got none of item M.3's ground rework (`grep ground
        // assets/templates/default/slide.html` finds only
        // `background: var(--bg)`) — i.e. the exact mostly-grey plate the
        // owner named, reached by the one path that cannot be redrafted out
        // of it: `07h` waives the cover rule for a lost photograph, clause E
        // of the interest floor is waived by `downgradedForImages`, and
        // clause C then fails the bare plate on every attempt until the run
        // ships it `degraded`. `resolveLayout` also HONOURS an explicit
        // `text_only` rather than laddering it, so nothing downstream
        // recovered it either.
        //
        // `fallbackArchetypeFor` with a KNOWN-absent hero instead: slide 1
        // keeps `cover` when it carries a device (the archetype's own
        // colour-block ground plus keyline is purpose-built for the no-hero
        // case) and otherwise takes the ground-reworked `headline_focus`;
        // an interior or closing slide takes the best archetype its own
        // content can fill. `text_only` stays reachable only through
        // `resolveLayout`'s own floor, for a client whose `templateDir`
        // holds nothing else.
        const lastIndex = copy.slides.length - 1;
        const downgradeTargets = new Map(
          copy.slides
            .map((s, index) =>
              downgradedNs.has(s.n)
                ? ([s.n, fallbackArchetypeFor(s, { index, lastIndex, hasHeroImage: false, earlier: copy.slides.slice(0, index) })] as const)
                : undefined,
            )
            .filter((entry): entry is readonly [number, InstagramSlideLayout] => entry !== undefined),
        );
        await wf.step.code(rev(`07a-downgrade-unfillable-slides-attempt-${attempt}`), () => ({
          downgraded: [...downgradedNs],
          archetypes: [...downgradeTargets].map(([n, layout]) => ({ slide: n, layout })),
          reason:
            `slide(s) ${[...downgradeTargets].map(([n, layout]) => `${n} → ${layout}`).join(", ")} re-laid-out without a photograph — ` +
            `no viable image survived retrieval, social-scrape, and generation (${detail.join("; ")})`,
        }));
        // Never a rights-encumbered/watermarked/reused image, regardless of
        // which of those disqualified the candidate — the slide gets NO
        // photo, not a demoted one.
        selections = selections.map((sel) => (downgradedNs.has(sel.n) ? { ...sel, imagePath: null } : sel));
        copy = {
          ...copy,
          slides: copy.slides.map((s) => {
            const target = downgradeTargets.get(s.n);
            return target === undefined ? s : { ...s, layout: target };
          }),
        };
      }

      const attemptChecked = await wf.step.code(rev(`07-self-check-attempt-${attempt}`), () =>
        checkSlidesData(tools, ctx, copy, selections, research, frozen.styleConfig),
      );

      if (!attemptChecked.ok) {
        returnToCopyWith(attemptChecked.reason);
        continue;
      }

      // Fix 3: the unconditional, mechanical craft-hygiene gate (em dash/
      // exclamation/sentence-case) — never client-config-driven, runs on
      // every attempt regardless of what the client's own style rules say.
      const craftHygiene = await wf.step.code(rev(`07b-craft-hygiene-attempt-${attempt}`), () => checkCraftHygiene(tools, ctx, copy));
      if (!craftHygiene.ok) {
        returnToCopyWith(craftHygiene.reason);
        continue;
      }

      // ── 07e/07f: the language-compliance gate (SCRUM-310/AU32) ──
      //
      // Both stages run BEFORE step 08's render, deliberately: text baked
      // into a 1080x1440 PNG is the one thing a reviewer at gate 09a cannot
      // fix in place. Neither existing quality judge covers this —
      // `instagram-image-vet@2` judges candidate photographs and
      // `instagram-visual-qa@1` judges the rendered attempt's structured
      // slide data against `check: "render"` layout rules; nothing asked
      // whether the words are fluent text in the client's own language,
      // which is how the geektime carousel shipped in English for a
      // Hebrew-only outlet and passed every check that existed.
      //
      // Both stages are skipped only for english-default clients — 02d found
      // no evidence of a non-English language anywhere (brand, profile, voice
      // rules, brand-voice doc). There is then nothing to check against, and
      // like `runTopicGuardrail` on a client who forbids no topics, that
      // costs no model call and adds no step to the trace.
      //
      // A failure routes into this SAME shared retry loop as every other
      // self-check, for the same reason: the remedy for wrong-language copy
      // is a redraft (RETURN: 05), and the language requirement is already
      // in the drafting prompt (step 02b) — the model is being told it did
      // not follow it.
      //
      // Placed ahead of 07d rather than after it so the cheapest rejection
      // happens first: a wrong-language draft is dead either way, and
      // scoring it for similarity against the client's back catalogue (or
      // building a dedupe steer out of it) is work thrown away. Step ids in
      // this loop are already not monotonic in execution order — 07d runs
      // before 07c — because they name what a step is, not when it runs.
      //
      // Order within the paid checks (Phase 0): 07e (free) -> 07g relevance
      // (Flash, ~$0.002) -> 07f fluency (Haiku, ~$0.0055) — cheapest paid
      // rejection first.
      const gateText = targetLanguage !== undefined ? languageGateText(copy) : undefined;
      if (targetLanguage !== undefined && gateText !== undefined) {
        // Stage 1 — deterministic, no model call, no tools. Runs first so
        // the catastrophic case (an entirely wrong-script post) never pays
        // for stage 2.
        const scriptCheck = await wf.step.code(rev(`${LANGUAGE_SCRIPT_STEP_ID}-attempt-${attempt}`), () =>
          checkExpectedScript(gateText, targetLanguage),
        );
        if (!scriptCheck.ok) {
          returnToCopyWith(`slide copy failed the deterministic language/script check: ${scriptCheck.reason}`);
          continue;
        }
      }

      // ── 07g: the relevance judge (Phase 0, item C) ──
      //
      // "Would a reader who follows this account see how this post connects
      // to what this business sells and to whom?" — scored 1-5 against the
      // brief by `instagram-relevance-judge` (one Flash call per attempt,
      // ~$0.002: closes the MassHousing class of defect at < 2% of the copy
      // step's cost). Below `MIN_RELEVANCE_SCORE` the draft returns to 05
      // with the judge's missing bridge as `relevanceSteer`. A judge that
      // cannot run FAILS OPEN with a ledger warn — this is a quality gate on a
      // run that still has a human gate, and the binding rule is about the
      // score, not the outage (unlike 07f, whose subject nothing else reads).
      //
      // The floor is `MIN_RELEVANCE_SCORE` (3), except for a brief with no
      // product-information and no target-audience document, where it is 2:
      // that score is the rubric's own ceiling for a post written from
      // industry-only grounding ("a different business in the same field
      // could have posted this"), so holding a run on it would fail every
      // attempt of exactly the thin-onboarding client the audit was about,
      // on a verdict no redraft can answer. A 1 — the audit's own
      // real-estate carousel — is off-brief at either floor.
      const relevanceGateFloor = relevanceFloor(isThinlyGrounded(brief));
      const relevance: RelevanceVerdict = await runRelevanceJudge(
        wf,
        { tools, promptStore: options.promptStore, router: options.router },
        rev(`07g-relevance-attempt-${attempt}`),
        { brief: briefForPrompt(brief), topic: topicClaim.topic, caption: copy.caption, slides: relevanceSlidesFor(copy) },
        relevanceGateFloor,
      );
      spend(rev(`07g-relevance-attempt-${attempt}`), undefined, STEP_COST_ESTIMATES_USD.relevance);
      if (relevance.status === "off-brief") {
        lastSelfCheckReason = relevanceFailureReason(relevance);
        relevanceSteer = relevanceSteerFor(relevance);
        continue;
      }
      if (relevance.status === "error") {
        try {
          await tools["ledger.appendEvent"]?.execute({ runId: wf.runId, ...relevanceUnavailableEvent(wf.runId, attempt, relevance) }, { ctx });
        } catch (error) {
          console.error(`07g-relevance-attempt-${attempt}: could not record the judge-unavailable warn`, error);
        }
      }
      // A draft that passed only on the relaxed floor is recorded where a
      // reviewer will see it, on the ledger as well as on the gate payload:
      // the post ships, and the reason the usual floor could not be applied
      // to this client is a sentence they can act on (two onboarding
      // documents).
      if (relevance.status === "relevant" && relevance.note !== undefined) {
        try {
          await tools["ledger.appendEvent"]?.execute({ runId: wf.runId, ...relevanceThinGroundingEvent(wf.runId, attempt, relevance) }, { ctx });
        } catch (error) {
          console.error(`07g-relevance-attempt-${attempt}: could not record the thin-grounding warn`, error);
        }
      }
      const attemptRelevance: DraftResult["relevance"] =
        relevance.status === "error"
          ? undefined
          : { score: relevance.score, reason: relevance.reason, ...(relevance.status === "relevant" && relevance.note !== undefined ? { note: relevance.note } : {}) };

      if (targetLanguage !== undefined && gateText !== undefined) {
        // Stage 2 — one commodity-tier judge call. Hebrew-shaped nonsense is
        // still Hebrew characters, so stage 1 cannot see it.
        const fluency = await runLanguageFluency(
          wf,
          { tools, promptStore: options.promptStore, router: options.router },
          gateText,
          targetLanguage,
          rev(`${LANGUAGE_FLUENCY_STEP_ID}-attempt-${attempt}`),
        );
        // An `error` verdict means the judge ran twice (the call and its one
        // in-step retry) and could not answer: the meter counts both calls.
        spend(rev(`${LANGUAGE_FLUENCY_STEP_ID}-attempt-${attempt}`), undefined, (fluency.status === "error" ? 2 : 1) * STEP_COST_ESTIMATES_USD.fluency);
        // FAILS CLOSED (Phase 0, item B). `error` used to be a pass — the same
        // fail-open posture as `runTopicGuardrail` — which is exactly what
        // let unverified Hebrew ship: copy in a language nothing else in the
        // pipeline reads does not go out on the strength of an outage.
        // `runLanguageFluency` already retried the judge once inside the
        // same step, so a transient 429 costs nothing here; a real outage
        // costs the attempt, bounded by MAX_SELF_CHECK_ATTEMPTS -> the
        // existing WorkflowHeld, whose reason names the outage so an operator
        // does not chase a copy problem.
        if (fluency.status !== "fluent") {
          // The judge's own findings (issues + evidence) travel into the
          // redraft prompt — a "reads translated" verdict with no steer was
          // a blind redraft of the same sentences.
          returnToCopyWith(
            fluency.status === "error"
              ? `the fluency judge could not run (${fluency.error ?? "unknown error"}): refusing to ship unverified ${targetLanguage} copy on attempt ${attempt}`
              : `slide copy is not fluent ${targetLanguage} on attempt ${attempt}: ` +
                  `${fluency.issues.length > 0 ? fluency.issues.join("; ") : "no specific issues given"}` +
                  `${fluency.evidence ? ` (e.g. "${fluency.evidence}")` : ""}`,
          );
          continue;
        }
      }

      // ── 07d: is this draft a repeat of something this client already published? ──
      //
      // Deterministic trigram-Jaccard scoring against the same excerpt
      // window step 04e read (`evaluateDedupe`'s calibrated 0.4 threshold —
      // the same scorer dynamic agents already run). A `similar` verdict
      // burns one of the SAME shared retry budget every other self-check
      // uses, with the offending post quoted into the redraft prompt; on the
      // final attempt the draft ships FLAGGED (the verdict is in this step's
      // checkpointed output for the trace and the human gate), never held —
      // two posts a fortnight apart about the same launch may be exactly
      // right, and a fixed threshold is not entitled to overrule the person
      // reviewing at 09a.
      const draftText = `${copy.caption}\n\n${copy.slides.map((s) => `${s.headline} ${s.body}`).join("\n")}`;
      const dedupeVerdict = await checkOutputDedupe(wf, rev(`07d-dedupe-check-attempt-${attempt}`), draftText, outputHistory);
      if (dedupeVerdict.status === "similar" && attempt < maxAttempts) {
        dedupeRetrySteer = dedupeRetryDirective(dedupeVerdict, outputHistory);
        lastSelfCheckReason = `draft is ${Math.round(dedupeVerdict.maxSimilarity * 100)}% similar to an already-published post (run ${dedupeVerdict.mostSimilarRunId ?? "unknown"})`;
        continue;
      }

      // A `custom` archetype's markup is validated fresh every attempt, from
      // this attempt's own `copy` — never checkpointed on its own (see
      // `validateCustomArchetypes`'s doc comment). `resolveLayout` (inside
      // `assembleSlidesData`) downgrades anything that didn't pass to
      // `text_only`, and `ensureTemplatesOnDisk` below writes exactly the
      // slides that did.
      let validatedCustomArchetypes = validateCustomArchetypes(copy);
      let validatedCustomArchetypeIds = new Set(validatedCustomArchetypes.map((a) => a.archetypeId));

      /**
       * Per-slide typography for THIS attempt, so item L's free re-layout can
       * step a slide's `fontScale` without a redraft.
       *
       * Attempt-scoped (declared inside the loop) rather than run-scoped: a
       * scale step is a remedy for what one attempt's copy measured, and
       * carrying it into a wholly-rewritten draft would be applying a fix to
       * a defect that no longer exists.
       */
      let slideStyleOverrides = new Map<number, SlideStyleOverride>();

      /**
       * The assembled slides-data for one candidate copy/selection pair, with
       * item L's per-slide measurement anchors attached.
       *
       * A closure rather than three copies of the same 20-line literal: this
       * attempt assembles up to three times (07c, the typographic fallback at
       * 08a, and the free re-layout's re-render at 08a1c), and the ONE thing
       * that must never differ between them is which tokens the measurement
       * is anchored on.
       *
       * Every input the caller can vary is a PARAMETER, including the style
       * overrides: the free re-layout at `08a1b` has to be able to assemble a
       * candidate without committing it (see there), and a map read out of
       * the closure cannot be handed a candidate value.
       */
      const assembleForAttempt = (
        copyForAssembly: InstagramCopyOutput,
        selectionsForAssembly: ImageSelection[],
        customIds: ReadonlySet<string>,
        overridesForAssembly: ReadonlyMap<number, SlideStyleOverride> = slideStyleOverrides,
      ): RenderCarouselInput => {
        const assembled = assembleSlidesData({
          clientSlug: wf.clientSlug,
          postId: runClaim.postId,
          repoRoot: options.repoRoot,
          brandTokens: frozen.brandTokens,
          copy: copyForAssembly,
          selections: selectionsForAssembly,
          canvas: frozen.styleConfig.canvas,
          availableTemplates,
          templateDirOverride: effectiveTemplateDir,
          validatedCustomArchetypeIds: customIds,
          slideStyleOverrides: overridesForAssembly,
          ...(effectiveKit?.brandAccent !== undefined ? { brandAccentFallback: effectiveKit.brandAccent } : {}),
          ...(effectiveKit?.handle !== undefined ? { brandHandle: effectiveKit.handle } : {}),
          // IGSTYLE-7, §7a — wires `paletteForSlide`'s already-built, already-
          // seeded rotation into the render path for the first time. Seeded
          // from `wf.runId` per the ticket; a ring of length ≤ 1 (or absent)
          // falls back to `brandAccentFallback` above for every slide.
          accentRing: effectiveKit?.palette ?? [],
          paletteSeed: wf.runId,
          ...(groundFgInversion !== undefined ? { groundFgInversion } : {}),
          // Phase 2, item M: the one string in the device library that is
          // neither a numeral nor model-authored copy — an unsourced
          // timeline/unit_grid's "illustrative, not measured" note.
          ...(targetLanguage !== undefined ? { targetLanguage } : {}),
          // Phase 3, item S: the run's ONE frozen treatment, per slide, for
          // reporting and trace. The grade itself is applied by the
          // stylesheet `headExtras()` splices into every document, so this is
          // additive and `"none"` emits nothing.
          imageTreatment: frozenStyle.treatment,
        });
        // Phase 2, item L: the measurement's anchors, per slide.
        //
        // `groundHex` is the one that matters: on a full-bleed photograph the
        // MODAL colour is the photograph, so a flat-background share measured
        // against it means nothing — naming the brand's own ground is what
        // makes `flatBackgroundShare` a fact about the design rather than
        // about the picture. Without `accentHex` every slide's `accentShare`
        // is 0 and the accent warning fires on all of them.
        //
        // `foregroundHex` is declared on the tool's schema and passed here
        // for completeness, but no emitted metric anchors on it: ink is
        // measured as "not the ground", because a photograph and a scrim are
        // ink as much as a glyph is.
        return {
          ...assembled,
          slides: assembled.slides.map((slide) => ({
            ...slide,
            measure: {
              ...(typeof slide.fields["accentColor"] === "string" ? { accentHex: slide.fields["accentColor"] } : {}),
              ...(effectiveKit?.cssVars["--fg"] !== undefined ? { foregroundHex: effectiveKit.cssVars["--fg"] } : {}),
              ...(effectiveKit?.cssVars["--bg"] !== undefined ? { groundHex: effectiveKit.cssVars["--bg"] } : {}),
            },
          })),
        };
      };

      const slidesDataAttempt = await wf.step.code(rev(`07c-emit-slides-data-attempt-${attempt}`), () =>
        assembleForAttempt(copy, selections, validatedCustomArchetypeIds),
      );

      // ── 07h: the default render rules, checked in code BEFORE any render is spent (Phase 0, item D) ──
      //
      // Only when the frozen config declares no render rules of its own. Runs
      // on the ASSEMBLED slides-data so it sees the templates `resolveLayout`
      // actually picked and the hero images the selections actually attached.
      // A failure is a copy/layout defect and returns the draft to 05 like
      // any other self-check; what code cannot decide (a closer with no
      // question mark or lexicon CTA, a custom-archetype cover) is `residue`
      // for the 08b judge — so "no render rules provided" never happens again.
      //
      // One deliberate waiver, for the zero-held guarantee above: slide 1's
      // cover rules are NOT failed when slide 1 lost its photograph to
      // sourcing (07a downgraded it this attempt). A redraft cannot conjure a
      // picture the tiers could not find, and holding for it would be exactly
      // the "held because of a picture" this workflow promises never to do —
      // the rules join the residue with the reason, so the judge and the
      // reviewer still see them.
      //
      // TWO rules, not one, and both for the same reason. `07a` now re-lays a
      // hero-less cover out through `fallbackArchetypeFor` rather than forcing
      // the client's bare `slide.html`, which for a cover with no device means
      // the ground-reworked `headline_focus`. `countContentElements` subtracts
      // one there ("a statement and its sub-line are ONE lockup"), and its own
      // doc comment calls that subtraction "belt and braces rather than the
      // deciding check" precisely because `default:cover-carries-device`
      // already fails such a slide. Waive only the cover rule and the belt
      // becomes the decider: a kicker-less cover that lost its photograph
      // would return to `05` on every attempt for a picture no redraft can
      // produce — the hold this waiver exists to prevent, re-created one rule
      // over. Scoped to slide 1, because no other slide's count depends on
      // the hero: an interior plate reads headline + body as two.
      const COVER_WAIVED_RULE_IDS = ["default:cover-carries-device", "default:two-elements-per-slide"] as const;
      let residueRules: typeof DEFAULT_RENDER_RULES = [];
      if (renderRuleSource === "default") {
        const drr = await wf.step.code(rev(`07h-default-render-rules-attempt-${attempt}`), () => {
          const checked = checkDefaultRenderRules(slidesDataAttempt, copy);
          const coverN = slidesDataAttempt.slides[0]?.n ?? -1;
          const coverLostToSourcing = downgradedForImagesThisAttempt.has(coverN);
          const isWaived = (f: { ruleId: string; slide?: number | undefined }): boolean =>
            coverLostToSourcing && f.slide === coverN && (COVER_WAIVED_RULE_IDS as readonly string[]).includes(f.ruleId);
          const failures = checked.failures.filter((f) => !isWaived(f));
          const waived = checked.failures.filter(isWaived);
          const waivedIds = new Set(waived.map((w) => w.ruleId));
          const residue = [...checked.residue, ...DEFAULT_RENDER_RULES.filter((r) => waivedIds.has(r.id))];
          return {
            failures,
            residue,
            ...(waived.length > 0
              ? { waived: waived.map((w) => ({ ...w, reason: `${w.reason} — waived: slide 1 lost its photograph to image sourcing this attempt, which is never a hold; left to the judge` })) }
              : {}),
          };
        });
        if (drr.failures.length > 0) {
          returnToCopyWith(`default render rule(s) failed on attempt ${attempt} (no render spent): ${formatDefaultRenderRuleFailures(drr.failures)}`);
          continue;
        }
        residueRules = drr.residue;
      }

      // ── 07k: the cross-run variety check (Phase 2, item P) ──
      //
      // The owner's second complaint: "בנוסף בגלל שזה חזרתי זה נראה AI" — the
      // repetition itself is the tell. Variety inside one carousel was
      // already enforced (`resolveLayout`'s once-per-archetype rule); this is
      // the half that measures it ACROSS runs, against the last five
      // signatures this client shipped.
      //
      // PRE-RENDER, deliberately, and that placement is the cost claim: a
      // repeated skeleton is knowable from the assembled slides-data alone,
      // so refusing it here costs no Chromium launch and no model call at
      // all. `07k` sits after `07h` (which already passed) and before `08`.
      //
      // Three clauses, and none of them can hold the run: a signature
      // IDENTICAL to the previous post's returns to 05 with both sequences
      // named; a near-match under `MIN_SKELETON_DISTANCE` returns on attempt
      // 1 only and warns after that; and on the final attempt
      // `checkSkeletonVariety` self-demotes to a warning, so this never
      // becomes a fourth hold cause.
      // Two clauses here are cross-run and answerable from the assembled
      // slides-data alone. The third — two ADJACENT slides that share an
      // archetype AND fill the plate to the same degree — is a fact about
      // pixels, so it cannot be answered at this placement and is re-run at
      // `08a1e` once `08a1` has measured the render. `let`, because that
      // merge replaces this verdict for everything downstream.
      let skeletonVerdict: SkeletonVarietyVerdict = await wf.step.code(rev(`07k-skeleton-variety-attempt-${attempt}`), () => {
        const roles = rolesForSlideCount(slidesDataAttempt.slides.length);
        const entry = buildSkeletonEntry({
          runId: wf.runId,
          at: new Date().toISOString(),
          // The ASSEMBLED slides, not the copy's requested layouts: a slide
          // that degraded for want of a picture records what actually
          // rendered, which is the only thing a future run can avoid.
          slides: slidesDataAttempt.slides.map((s) => ({ n: s.n, template: s.template, hasImage: s.images?.["hero"] !== undefined })),
          roles,
          // The RENDERED device kind (`fields.deviceKind`, emitted by
          // `contentFor` beside the fragment), not `copy.slides[].device`.
          // Only three archetypes declare a device slot, so reading the
          // request let a slide claim a device it never painted — and the
          // variety check would then be satisfied by a difference invisible
          // in the carousel.
          devices: slidesDataAttempt.slides.map((s) => s.fields?.["deviceKind"]),
          edited: false,
        });
        return checkSkeletonVariety(skeletonHistory, { signature: entry.signature }, { attempt, maxAttempts });
      });
      skeletonForGate = skeletonVerdict;
      if (skeletonVerdict.action === "return" && meter.posture !== "cheapest-path") {
        // `returnToCopyWith`, never a bare `continue`: the reason names BOTH
        // sequences, and it only reaches the writer through `selfCheckSteer`.
        returnToCopyWith(skeletonVerdict.reason ?? "this carousel repeats the previous post's layout sequence");
        continue;
      }
      if (skeletonVerdict.action === "return") {
        // PAST THE RUN'S HARD MAX: the standing amendment says finish on the
        // cheapest complete path and deliver. A repeated layout sequence is
        // the definition of optional work to drop here — this module's own
        // reasoning is that "there is no `hold`: repetition is a design
        // defect, not a compliance one", and a redraft for one costs a copy
        // attempt plus its vet, relevance and inspect legs (~$0.19) on a run
        // that has already crossed $1.50 (generated images bill measured, not
        // estimated, so `05b` alone can cross it on attempt 1). Demoted to
        // the `warn` shape the final attempt already produces, with the
        // reason recorded on the gate and in the ledger rather than paid for.
        const suppressed = `${skeletonVerdict.reason ?? "this carousel repeats the previous post's layout sequence"} — past the run's hard max, so it ships with the finding recorded rather than redrafted`;
        skeletonVerdict = { ...skeletonVerdict, ok: true, action: "warn", reason: suppressed };
        skeletonForGate = skeletonVerdict;
        try {
          await tools["ledger.appendEvent"]?.execute(
            { runId: wf.runId, eventId: `${wf.runId}__skeleton-variety-a${attempt}`, level: "warn", message: suppressed },
            { ctx },
          );
        } catch (error) {
          console.error(`07k-skeleton-variety-attempt-${attempt}: could not record the suppressed-escalation warn`, error);
        }
      }

      // ── 08: render via the shared, already-tested publish.renderCarousel tool ──
      //
      // `measure`/`probe` (item L, `publish.renderCarousel` 1.1.0): both free
      // — the measurement runs on the screenshot buffer the tool already
      // holds (with a mediaStore configured that is the only place those
      // bytes ever exist), and the probe is one `page.evaluate` in the page
      // that is already open. Their per-slide anchors were attached at 07c.
      await ensureTemplatesOnDisk(validatedCustomArchetypes);
      const renderOutcome = await wf.step.code(rev(`08-render-carousel-attempt-${attempt}`), async () =>
        tools["publish.renderCarousel"]!.execute({ ...slidesDataAttempt, measure: true, probe: true }, { ctx }),
      );

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
          assembleForAttempt(strippedCopy, strippedSelections, validatedCustomArchetypeIds),
        );
        copy = strippedCopy;
        selections = strippedSelections;
        await ensureTemplatesOnDisk(validatedCustomArchetypes);
        renderResolved = await wf.step.code(rev(`08-render-carousel-typographic-attempt-${attempt}`), async () =>
          tools["publish.renderCarousel"]!.execute({ ...slidesDataResolved, measure: true, probe: true }, { ctx }),
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
      let renderedAttempt = renderResolved.result as RenderCarouselResult;
      let slidesDataForQa = slidesDataResolved;

      // ── 08a1: the visual-interest floor, measured on the pixels ──
      //
      // The owner's first complaint, made enforceable: "טמפלייטים משעממים...
      // מסך אפור ברובו" — a mostly-grey plate with a headline in the lower
      // third is technically correct and empty, and "technically correct and
      // empty must fail, not pass". `checkSlidesInterestFloor` reads the
      // numbers `publish.renderCarousel` just measured and answers per slide,
      // at the slide's ROLE (slide 1 is a cover, the last slide is a closer,
      // the rest interior — assigned from carousel position inside the
      // policy, never here).
      //
      // WHERE it sits is the whole cost claim: immediately after the render
      // and STRICTLY BEFORE `08a2`'s palette gate, `08a4`'s vision pass
      // (~$0.008) and `08b`'s Flash judge ($0.004). A failing attempt
      // therefore spends a render and **zero model calls**, and then gets a
      // second free chance from the deterministic re-layout below before the
      // $0.126 redraft is spent at all.
      const measuredArchetypes = (assembled: RenderCarouselInput, copyNow: InstagramCopyOutput, customIds: ReadonlySet<string>): Map<number, string> =>
        new Map(
          assembled.slides.map((slide) => {
            const from = copyNow.slides.find((c) => c.n === slide.n);
            const customId =
              from?.layout === "custom" && from.customArchetype !== undefined && customIds.has(from.customArchetype.archetypeId)
                ? from.customArchetype.archetypeId
                : undefined;
            // A run-authored layout is named `custom-<archetypeId>` rather
            // than by its filename, so item O's designs are identifiable in
            // the ledger by the id the copy model chose for them.
            return [slide.n, customId !== undefined ? `custom-${customId}` : templateBasename(slide.template)] as const;
          }),
        );

      let floor: InterestFloorReport = await wf.step.code(rev(`08a1-interest-floor-attempt-${attempt}`), () =>
        // Passed straight in, with no cast: `rendered[]`'s rows ARE the
        // module's `MeasuredSlide` shape, so this call site is the
        // compile-time join between `slide-metrics.ts`'s real `SlideMetrics`
        // and `interest-floor.ts`'s structural mirror of it. A field rename
        // in the tool package fails to compile HERE, which is the point.
        checkSlidesInterestFloor(renderedAttempt.rendered, {
          downgradedForImages: downgradedForImagesThisAttempt,
          archetypeBySlide: measuredArchetypes(slidesDataForQa, copy, validatedCustomArchetypeIds),
        }),
      );
      let interestRelayout: InterestRelayoutPlan | undefined;

      // An unmeasurable PNG is a TOOLING oddity, never an editorial verdict:
      // one warn row naming the reason, and the attempt continues. Turning
      // "the decoder refused this buffer" into "this slide is boring" would
      // be the held-because-of-a-picture failure mode in a new costume.
      if (floor.notMeasured.length > 0) {
        try {
          await tools["ledger.appendEvent"]?.execute(
            {
              runId: wf.runId,
              eventId: `${wf.runId}__interest-not-measured`,
              level: "warn",
              message:
                `attempt ${attempt}: ${floor.notMeasured.length} slide(s) could not be measured for visual interest — ` +
                floor.notMeasured.map((n) => `slide ${n.slide}: ${n.reason}`).join("; "),
            },
            { ctx },
          );
        } catch (error) {
          console.error("08a1-interest-floor: could not record the not-measured warn", error);
        }
      }

      if (!floor.ok) {
        // ── 08a1b/08a1c/08a1d: the FREE remedy, once ──
        //
        // A render is $0; a Sonnet redraft is $0.12. `planInterestRelayout`
        // returns at most ONE change per failing slide from a fixed, tested
        // table — promote an already-vetted image to the cover, build a
        // device from a figure the slide already states, switch to the
        // archetype its own content calls for, step the type scale, move a
        // sentence to the caption. `undefined` means the table had nothing
        // to try, which is exactly what the paid redraft is for.
        const plan = planInterestRelayout(copy, selections, promptFacts, floor.findings, { styleOverrides: slideStyleOverrides });
        if (plan !== undefined) {
          interestRelayout = await wf.step.code(rev(`08a1b-relayout-for-interest-attempt-${attempt}`), () => plan);
          // Every mutation the re-layout makes is built into a CANDIDATE and
          // committed only after `08a1c` renders it — the copy, the image
          // selections, the type-scale overrides and the validated custom
          // set, all four.
          //
          // Committing first and keeping the edits when the render failed is
          // how the deliverable's text stops matching its own PNGs: the else
          // branch below keeps `renderedAttempt`/`slidesDataForQa` on the
          // FIRST render, and on the final attempt (or past the hard max)
          // there is no `continue`, so `finalCopy`/`finalRendered` ship
          // together. A `move-sentence-to-caption` would then publish the
          // sentence in the caption AND still burned into slide N's picture;
          // a `promote-image-to-cover` pointing at a path this instance does
          // not hold is a very reachable way to get there (`content_fail`).
          let nextCopy = copy;
          let nextSelections = selections;
          const nextStyleOverrides = new Map(slideStyleOverrides);
          const patchSlide = (n: number, patch: Partial<InstagramCopyOutput["slides"][number]>): void => {
            nextCopy = { ...nextCopy, slides: nextCopy.slides.map((s) => (s.n === n ? { ...s, ...patch } : s)) };
          };
          for (const change of plan.changes) {
            switch (change.kind) {
              case "re-render":
                // Nothing to change — the remedy IS rendering again.
                break;
              case "font-scale":
                nextStyleOverrides.set(change.slide, { ...nextStyleOverrides.get(change.slide), fontScale: change.to });
                break;
              case "attach-device":
                // The archetype rides along when the slide's current one has
                // no device slot — `contentFor` drops the fragment for every
                // archetype but `cover`/`headline_focus` (and a recap-less
                // `closer`), so setting the device alone there re-renders
                // byte-identically and burns the attempt's one free chance.
                patchSlide(change.slide, {
                  device: change.device,
                  ...(change.archetype !== undefined ? { layout: change.archetype as InstagramSlideLayout } : {}),
                });
                break;
              case "switch-archetype":
                // The planner already refuses a target another slide has
                // claimed, so `resolveLayout` will not degrade it straight
                // back — which is what would make this a no-op dressed as a
                // fix.
                patchSlide(change.slide, { layout: change.to as InstagramSlideLayout });
                break;
              case "promote-image-to-cover":
                // The whole per-image record moves, not only the path. One
                // selection row per slide is the compliance artefact for the
                // image that slide ships, so writing a new `imagePath` over
                // the cover's old verdict (on the reachable path, the
                // typographic stand-in: "n/a — typographic layout, no image
                // used", claimMatch 5, "no photograph to judge") would ship a
                // real third-party photograph described as something else —
                // and `09b` persists exactly this array on the deliverable.
                // `record.claimMatch` is capped because nothing re-vets the
                // picture against the cover's own headline at this point.
                nextSelections = nextSelections.map((sel) => (sel.n === change.slide ? { ...sel, imagePath: change.imagePath, ...change.record } : sel));
                patchSlide(change.slide, { layout: change.archetype as InstagramSlideLayout });
                break;
              case "build-recap":
                // `closer`'s recap strip is built BY CODE inside `contentFor`
                // from the carousel's own earlier slides (item M), so the
                // plan's `rows` are the reason, not the payload: switching
                // the archetype is what makes the strip render.
                patchSlide(change.slide, { layout: change.archetype as InstagramSlideLayout });
                break;
              case "add-question-block": {
                // The question is lifted from the post's OWN words (the
                // closer's headline, its body, or the caption) — the planner
                // never invents one. `contentFor` routes a closer's body into
                // the `question` slot when it actually asks something, so a
                // question that came from the CAPTION is appended to the body
                // verbatim; one already in the body needs nothing.
                const closerSlide = nextCopy.slides.find((s) => s.n === change.slide);
                const body =
                  closerSlide !== undefined && !closerSlide.body.includes(change.question)
                    ? `${closerSlide.body} ${change.question}`.trim()
                    : closerSlide?.body;
                patchSlide(change.slide, { layout: "closer", ...(body !== undefined ? { body } : {}) });
                break;
              }
              case "colour-block-ground":
                patchSlide(change.slide, { layout: change.archetype as InstagramSlideLayout });
                break;
              case "move-sentence-to-caption": {
                const from = nextCopy.slides.find((s) => s.n === change.slide);
                if (from !== undefined) {
                  patchSlide(change.slide, { body: from.body.replace(change.sentence, "").replace(/\s{2,}/gu, " ").trim() });
                  nextCopy = { ...nextCopy, caption: `${nextCopy.caption}\n\n${change.sentence}`.trim() };
                }
                break;
              }
            }
          }
          // A `switch-archetype` off a `custom` slide changes which custom
          // designs this attempt still renders, so the validated set is
          // re-derived rather than reused — off the CANDIDATE copy.
          const nextValidatedCustomArchetypes = validateCustomArchetypes(nextCopy);
          const nextValidatedCustomArchetypeIds = new Set(nextValidatedCustomArchetypes.map((a) => a.archetypeId));

          // Outside the step, deliberately: a checkpointed step replayed on a
          // recycled instance returns its cached value without re-writing the
          // files, which is the exact 9qkTWlg7e9ZLiVIZUok4 defect
          // `ensureTemplatesOnDisk`'s own doc comment exists to close.
          //
          // Safe to run before the commit decision because every write here
          // is additive — the first render's own files are never removed — so
          // abandoning the candidate leaves the earlier render's templates
          // exactly where they were.
          await ensureTemplatesOnDisk(nextValidatedCustomArchetypes);
          const relayoutRender = await wf.step.code(rev(`08a1c-render-relayout-attempt-${attempt}`), async () => {
            const assembled = assembleForAttempt(nextCopy, nextSelections, nextValidatedCustomArchetypeIds, nextStyleOverrides);
            const outcome = await tools["publish.renderCarousel"]!.execute({ ...assembled, measure: true, probe: true }, { ctx });
            return { slidesData: assembled, outcome };
          });
          if (relayoutRender.outcome.status === "success") {
            // THE COMMIT. Text and pixels move together or not at all.
            copy = nextCopy;
            selections = nextSelections;
            slideStyleOverrides = nextStyleOverrides;
            validatedCustomArchetypes = nextValidatedCustomArchetypes;
            validatedCustomArchetypeIds = nextValidatedCustomArchetypeIds;
            slidesDataForQa = relayoutRender.slidesData;
            renderedAttempt = relayoutRender.outcome.result as RenderCarouselResult;
            floor = await wf.step.code(rev(`08a1d-interest-floor-recheck-attempt-${attempt}`), () =>
              checkSlidesInterestFloor(renderedAttempt.rendered, {
                downgradedForImages: downgradedForImagesThisAttempt,
                archetypeBySlide: measuredArchetypes(slidesDataForQa, copy, validatedCustomArchetypeIds),
              }),
            );
            // A SECOND `render-integrity` failure after a re-render is not a
            // content verdict at all: no copy change can make a font load.
            if (
              plan.changes.some((c) => c.kind === "re-render") &&
              floor.findings.some((f) => f.kind === "render-integrity")
            ) {
              throw new WorkflowToolingFailure(
                `the carousel measured almost no ink twice in a row (${floor.findings
                  .filter((f) => f.kind === "render-integrity")
                  .map((f) => f.sentence)
                  .join("; ")}) — a re-render did not fix it, so this is a rendering failure and not a copy defect`,
              );
            }
          } else {
            // The candidate is ABANDONED, not half-kept: `copy`,
            // `selections`, `slideStyleOverrides` and the validated custom
            // set are all still the ones the first render actually painted,
            // so whatever ships is internally consistent. The findings stay
            // the first render's too, which is what routes this attempt to
            // the paid redraft (or to `degraded` on the last one).
            console.error(
              `08a1c-render-relayout-attempt-${attempt}: the re-layout's render reported ${relayoutRender.outcome.status} — ` +
                "discarding the re-layout's copy/selection changes and keeping the first render, its copy and its findings",
            );
            // Recomputed rather than checkpointed: `08a1b` and `08a1c` are
            // both steps, so on a resume this is a pure function of two
            // cached values and needs no step id of its own.
            interestRelayout = {
              ...plan,
              discarded: true,
              discardedReason: `the re-layout's render reported ${relayoutRender.outcome.status}, so its copy and selection changes were rolled back`,
            };
          }
        }
      }

      if (!floor.ok) {
        // One warn per FAILED attempt, keyed on the attempt so a retried
        // attempt overwrites its own row rather than stacking.
        try {
          await tools["ledger.appendEvent"]?.execute(
            {
              runId: wf.runId,
              eventId: `${wf.runId}__interest-floor-a${attempt}`,
              level: "warn",
              message: summarizeInterestFindings(floor.findings),
            },
            { ctx },
          );
        } catch (error) {
          console.error("08a1-interest-floor: could not record the interest-floor warn", error);
        }

        // NO FOURTH HOLD. Attempts 1..n-1 return to `05` with the measured
        // numbers through `returnToCopyWith` — never the bare `continue`
        // `08a2`'s palette gate does, or the numbers never reach
        // `selfCheckSteer` and the redraft is blind. On the final attempt, or
        // past the run's hard max where escalation is suppressed, the post
        // ships `degraded` with the finding recorded.
        if (attempt < maxAttempts && meter.posture !== "cheapest-path") {
          // A DROPPED DEVICE goes with the numbers. `collectDeviceIssues`
          // otherwise only ever reached the gate payload and the deliverable,
          // so a writer that DID set a device the archetype has no slot for
          // was told "this slide measured empty, give it a device" and had no
          // way to learn that it already had — it would set the same field
          // again and measure the same. Here the drop is stated with the
          // archetype that dropped it, which is the fact that makes the
          // remedy actionable.
          const drops = collectDeviceIssues(copy, slidesDataForQa);
          returnToCopyWith(
            drops.length > 0
              ? `${formatInterestFailures(floor.findings)} Devices this attempt set that did not render: ${drops.map((d) => `slide ${d.slide} (${d.kind}) — ${d.reason}`).join("; ")}`
              : formatInterestFailures(floor.findings),
          );
          continue;
        }
        interestDegraded = floor;
      }

      // ── 08a1e: the SHIPPED skeleton, and the pixel half of it (item P.2) ──
      //
      // Two jobs, and the first one is the reason this step re-derives rather
      // than decorates.
      //
      // 1. **The signature is recomputed from what is about to ship.** `07k`
      //    is pre-render and reads `slidesDataAttempt`; `08a1b` then mutates
      //    layouts, devices and type scales and commits a new
      //    `slidesDataForQa`. Every remedy kind changes the signature —
      //    `attach-device` appends `+<kind>`, and `switch-archetype`,
      //    `promote-image-to-cover`, `colour-block-ground`, `build-recap` and
      //    `add-question-block` all change an archetype token. Carrying
      //    `07k`'s tokens past a re-layout put a carousel that did not ship
      //    on the gate payload, on the deliverable and into the `08a1e`
      //    adjacency warnings (old tokens paired with new measured shares),
      //    while `09b` independently recorded the real one under
      //    `SKELETON_BELIEF_KEY` — so item P's whole purpose ("are we
      //    shipping the same post every week") answered wrong exactly when a
      //    re-layout ran. It is rebuilt the same way `09b` rebuilds it, off
      //    the same committed `slidesDataForQa`.
      //
      // 2. **The adjacency clause finally has pixels.** `07k` had no
      //    occupancy to read, so `adjacentRepeatWarnings` was structurally
      //    unreachable and `skeletonWarnings` never reached `08b`. Now that
      //    `08a1` (or `08a1d`, after a re-layout) has measured every slide,
      //    it is re-run against the real `occupiedShare` values.
      //
      // The re-run verdict can never `return`: the render is already paid
      // for, `08a1`'s own escalation decision has already been taken above,
      // and a second return point here would be a fifth hold cause in all
      // but name. So the cross-run clauses are re-evaluated for their
      // REASON and their numbers, and the action is demoted to `warn`.
      //
      // Positional, with holes: `floor.perSlide` skips a slide whose PNG
      // could not be decoded, so the array is built by slide number against
      // the ASSEMBLED order rather than from `perSlide`'s own length. A
      // compacted list would pair slide 3 with slide 5 and invent a
      // repetition that is not there.
      skeletonVerdict = await wf.step.code(rev(`08a1e-skeleton-occupancy-attempt-${attempt}`), () => {
        const byNumber = new Map(floor.perSlide.map((verdict) => [verdict.slide, verdict.metrics.occupiedShare]));
        const occupancy = slidesDataForQa.slides.map((s) => byNumber.get(s.n));
        const shipped = buildSkeletonEntry({
          runId: wf.runId,
          at: new Date().toISOString(),
          slides: slidesDataForQa.slides.map((s) => ({ n: s.n, template: s.template, hasImage: s.images?.["hero"] !== undefined })),
          roles: rolesForSlideCount(slidesDataForQa.slides.length),
          devices: slidesDataForQa.slides.map((s) => s.fields?.["deviceKind"]),
          edited: false,
        });
        const reChecked = checkSkeletonVariety(skeletonHistory, { signature: shipped.signature }, { attempt, maxAttempts });
        return withMeasuredOccupancy(
          // `ok: true` and `action: "warn"`/`"pass"` — never `return`. See above.
          { ...reChecked, ok: true, action: reChecked.action === "return" ? "warn" : reChecked.action },
          occupancy,
        );
      });
      skeletonForGate = skeletonVerdict;

      // ── 08a2: deterministic visual-QA pre-checks (SCRUM-324/AU40) —
      //         code answers every question that HAS a factual answer,
      //         before the model is ever asked to grade anything. See
      //         `visual-qa-pre-checks.ts`'s own header for the full
      //         rationale, including why "is the logo present" is a FACT fed
      //         to the judge rather than a gate on the attempt (brand
      //         furniture must never be able to hold a run — same invariant
      //         `brandFragments`/`brand-logo.ts` state repeatedly), while
      //         "are the palette tokens within the kit" genuinely gates and
      //         short-circuits the model call entirely: an off-kit accent is
      //         a real render defect, not an unreachable third-party asset. ──
      const preChecks = await wf.step.code(rev(`08a2-visual-qa-pre-checks-attempt-${attempt}`), async () => {
        const { placement } = await brandLogoAssessment();
        const usedHexes = slidesDataForQa.slides
          .map((s) => s.fields["accentColor"])
          .filter((h): h is string => typeof h === "string");
        return {
          // Phase 0, item G: the ring is the single source of truth and every
          // slide now paints FROM it (`resolveSlideAccent`), so this belt
          // cannot fail on a config-vs-brand accent disagreement any more. A
          // reviewer's explicit directive pick is unioned in for the same
          // reason — it is the ring anchor after re-derivation by construction.
          paletteGate: checkPaletteWithinKit(usedHexes, [
            ...(effectiveKit?.palette ?? []),
            ...(styleDirectiveResult.overrides.accent !== undefined ? [styleDirectiveResult.overrides.accent] : []),
          ]),
          brandAsset: assessBrandAssetPresence({
            configuredLogoUrl: effectiveKit?.logoUrl,
            rejectedLogoUrlReason: effectiveKit?.rejectedLogoUrlReason,
            hasDownload: placement !== undefined,
            placement,
          }),
          // SCRUM-393 (IGSTYLE-8): a FACT, never a gate — see
          // `assessContrastFacts`'s own doc comment. Computed from the same
          // `usedHexes` the palette gate above already derived, so "which
          // accents are being judged" can't drift between the two.
          contrastFacts: assessContrastFacts(brandKit, usedHexes),
        };
      });

      if (!preChecks.paletteGate.ok) {
        // The whole cost claim this ticket has to prove: this attempt never
        // reaches `qaAgent` at all — zero model calls for a defect code
        // already knows about with an `includes()` check.
        lastSelfCheckReason = `visual QA deterministic pre-check failed on attempt ${attempt} (no model call spent): ${preChecks.paletteGate.reason}`;
        continue;
      }

      // SCRUM-393 (IGSTYLE-8): surface every sub-floor contrast fact as a
      // ledger warn event — visible to a human without holding, degrading,
      // or retrying this attempt. Real brand colors (a client's own coral
      // accent on its own cream ground) can legitimately sit below the
      // floor; the point is that nobody currently learns this at all.
      const belowFloor = preChecks.contrastFacts.filter((f) => !f.pass);
      if (belowFloor.length > 0) {
        await wf.step.code(rev(`08a3-record-contrast-below-floor-attempt-${attempt}`), async () =>
          tools["ledger.appendEvent"]?.execute(
            {
              runId: wf.runId,
              eventId: `${wf.runId}__contrast-below-floor`,
              level: "warn",
              message: `attempt ${attempt}: ${belowFloor.length} contrast fact(s) below floor — ${belowFloor
                .map((f) => `${f.label}: ${f.ratio.toFixed(2)}:1 (floor ${f.floor}:1)`)
                .join("; ")}`,
            },
            { ctx },
          ),
        );
      }

      // ── 08b: post-render visual QA (Fix 2/AU40) — a text-proxy stand-in
      //         for real pixel inspection (see InstagramVisualQaAgent's own
      //         doc comment). Judges `check: "render"` rules from the frozen
      //         config PLUS the elevated criteria this ticket adds
      //         (composition richness, font hierarchy, brand-asset
      //         integration, colour harmony) — every one of which the
      //         08a2 pre-check has already stripped of its factual half, so
      //         the model grades only the aesthetic residue code cannot
      //         compute. A failure here `continue`s the SAME retry loop as
      //         step 07/07b above, matching carousel-agent-v2 SKILL.md step
      //         08's "a fail here is RETURN: 05, because it is the copy or
      //         the layout, not the code." ──
      // ── 08a4: a vision model LOOKS at the rendered PNGs (2026-09) ──
      //
      // The QA agent has always judged from structured slide data and said so
      // in its own prompt ("you do NOT see the actual rendered pixels"). With
      // `media.inspectImages` in the registry it can: each rendered slide is
      // described — legible text, quality grade, whether it reads as a
      // finished slide — and the descriptions ride into the QA input as
      // `renderedInspections`. Best-effort: no vision backend, or a failed
      // call, leaves the QA exactly as it was.
      const inspectRendered = tools["media.inspectImages"];
      let renderedInspections: Array<Record<string, unknown>> = [];
      // Cheapest path (budget): over the hard max the rendered inspection is
      // optional spend and is skipped; the deterministic 08a2 pre-checks stand.
      if (inspectRendered !== undefined && renderedAttempt.rendered.length > 0 && meter.posture !== "cheapest-path") {
        renderedInspections = await wf.step.code(rev(`08a4-inspect-rendered-attempt-${attempt}`), async (): Promise<Array<Record<string, unknown>>> => {
          const images = renderedAttempt.rendered.slice(0, 12).flatMap((r): Array<{ ref: string; url?: string; path?: string }> => {
            if (/^https?:\/\//i.test(r.path)) return [{ ref: `slide-${r.n}`, url: r.path }];
            // The renderer writes a local file when no media store is
            // configured; the vision tool takes it repo-relative and bounds-checks it.
            const relative = path.isAbsolute(r.path) ? path.relative(options.repoRoot, r.path) : r.path;
            if (relative.startsWith("..")) return [];
            return [{ ref: `slide-${r.n}`, path: relative.replace(/\\/g, "/") }];
          });
          if (images.length === 0) return [];
          const outcome = await inspectRendered.execute(
            {
              repoRoot: options.repoRoot,
              images,
              purpose: "candidate-vetting",
              brief: "a finished Instagram slide as it will be published: every word legible, nothing overlapping or cut off, not near-empty, the photo (if any) not fighting the text",
            },
            { ctx },
          );
          if (outcome.status !== "success") return [];
          return (outcome.result as { inspections: Array<Record<string, unknown>> }).inspections.map((i) => ({
            n: Number(String(i["ref"]).split("-")[1]),
            description: i["description"],
            textInImage: i["textInImage"],
            quality: i["quality"],
            qualityReason: i["qualityReason"],
            ...(i["fitScore"] !== undefined ? { fitScore: i["fitScore"], fitReason: i["fitReason"] } : {}),
          }));
        });
        spend(rev(`08a4-inspect-rendered-attempt-${attempt}`), undefined, Math.min(renderedAttempt.rendered.length, 12) * STEP_COST_ESTIMATES_USD.visionInspectPerImage);
      }

      const elevatedCriteria = buildElevatedVisualQaCriteria({ logo: preChecks.brandAsset, kitPalette: effectiveKit?.palette ?? [] });
      // Phase 0, item D: the client's own render rules when it has them;
      // otherwise the default rules 07h could NOT settle in code (the residue)
      // — never a rule that already passed deterministically.
      const judgedRenderRules = renderRuleSource === "client" ? renderRules : residueRules;
      // Cheapest path (budget, owner's rule): over the hard max the visual-QA
      // MODEL call is optional spend and is skipped — the deterministic 08a2
      // pre-checks above already passed, and the human gate still reviews the
      // render. Recorded as a checkpointed code step under the SAME id so the
      // trace shows the check was consciously skipped rather than never
      // reached, and the deliverable carries the degraded note.
      if (meter.posture === "cheapest-path") {
        await wf.step.code(rev(`08b-visual-qa-attempt-${attempt}`), () => ({
          skipped: "budget" as const,
          reason: `run budget hard max crossed (${formatUsd(meter.totalUsd)} > ${formatUsd(budgetDecision.maxUsd)}) — the optional visual-QA model call was skipped on the cheapest complete path; deterministic pre-checks passed`,
          renderRules: [...judgedRenderRules.map((r) => ({ id: r.id, description: r.description })), ...elevatedCriteria],
        }));
        finalCopy = copy;
        finalSelections = selections;
        finalSlidesData = slidesDataForQa;
        finalRendered = renderedAttempt;
        finalContrastFacts = preChecks.contrastFacts;
        finalRelevance = attemptRelevance;
        finalInterest = floor;
        finalInterestRelayout = interestRelayout;
        finalSkeleton = skeletonVerdict;
        finalOutcomeOk = true;
        break;
      }
      const qaExec = await wf.step.agent(rev(`08b-visual-qa-attempt-${attempt}`), qaAgent, {
        // The format (2026-09): a single-image post has no "closer" slide and
        // a rule written for an eight-slide carousel does not apply to it.
        format: copy.format,
        // What a vision model saw in the actual PNGs, when one was available.
        ...(renderedInspections.length > 0 ? { renderedInspections } : {}),
        slides: slidesDataForQa.slides.map((s) => ({ n: s.n, fields: s.fields, images: s.images })),
        renderRules: [...judgedRenderRules.map((r) => ({ id: r.id, description: r.description })), ...elevatedCriteria],
        // Facts the judge must not re-derive (per-criterion doc comments in
        // `visual-qa-pre-checks.ts`) — present only when the corresponding
        // elevated criterion above was actually included.
        ...(preChecks.brandAsset.present
          ? { brandAssetContext: { corner: preChecks.brandAsset.corner, scrimmed: preChecks.brandAsset.scrimmed } }
          : {}),
        ...(effectiveKit !== undefined && effectiveKit.palette.length > 0 ? { brandPalette: effectiveKit.palette } : {}),
        // Phase 2, item L (prompt @4 §6): the measured interest report for the
        // attempt about to ship, so the judge grades only the RESIDUE — does
        // the sequence have rhythm — rather than re-deciding emptiness that
        // `08a1` already measured in code. The same residue split `07h`/`08a2`
        // already established.
        interest: { perSlide: floor.perSlide, findings: floor.findings, waived: floor.waived, warnings: floor.warnings, notMeasured: floor.notMeasured },
        // Phase 2, item P: composition variety against the PREVIOUS POST, not
        // only within this carousel — the half of "repetition reads as AI" a
        // deterministic distance cannot judge.
        thisSkeleton: skeletonVerdict.signature,
        ...(skeletonVerdict.previous !== undefined ? { previousSkeleton: skeletonVerdict.previous } : {}),
        ...(skeletonVerdict.warnings.length > 0 ? { skeletonWarnings: skeletonVerdict.warnings } : {}),
      });
      spend(rev(`08b-visual-qa-attempt-${attempt}`), qaExec.totalCostUsd, STEP_COST_ESTIMATES_USD.visualQa);
      if (qaExec.status === "tooling_error") {
        throw new WorkflowToolingFailure(`visual QA step resolved to "${qaExec.status}" on attempt ${attempt}/${maxAttempts}`);
      }
      if (qaExec.status !== "completed") {
        lastSelfCheckReason = `visual QA output failed its own output validation on attempt ${attempt}`;
        continue;
      }
      const qa = qaExec.finalOutput!;
      if (!qa.pass) {
        const failing = qa.findings.filter((f) => !f.passed);
        returnToCopyWith(`visual QA failed on attempt ${attempt}: ${failing.length > 0 ? failing.map((f) => `${f.ruleId}${f.slide !== undefined ? ` (slide ${f.slide})` : ""}: ${f.note}`).join("; ") : "no specific findings given"}`);
        continue;
      }

      finalCopy = copy;
      finalSelections = selections;
      finalSlidesData = slidesDataForQa;
      finalRendered = renderedAttempt;
      finalContrastFacts = preChecks.contrastFacts;
      finalRelevance = attemptRelevance;
      finalInterest = floor;
      finalInterestRelayout = interestRelayout;
      finalSkeleton = skeletonVerdict;
      finalOutcomeOk = true;
      break;
    }

      if (!finalOutcomeOk || !finalCopy || !finalSelections || !finalSlidesData || !finalRendered) {
        throw new WorkflowHeld(
          `step 07's self-check never passed after ${maxAttempts} attempt(s) (initial + ${maxAttempts - 1} return(s) to step 05${maxAttempts < MAX_SELF_CHECK_ATTEMPTS ? ", the run budget plan allowed one return instead of two" : ""}) — last reason: ${lastSelfCheckReason}`,
        );
      }
      // IGSTYLE-10, §10e — reconstructed from the SAME pure per-slide
      // decisions `assembleSlidesData` itself used to build `finalSlidesData`
      // (`buildVariationPlan`'s own doc comment), so the report can never
      // drift from what actually rendered. Gated on a brand kit existing at
      // all — a client with neither an accent ring nor a derived ground/fg
      // pair has nothing either axis could have done, so nothing is reported,
      // matching every other optional field's "absent, not noise" convention.
      const variationPlan =
        effectiveKit !== undefined
          ? buildVariationPlan({
              slideNs: finalSlidesData.slides.map((s) => s.n),
              accentRing: effectiveKit.palette,
              paletteSeed: wf.runId,
              brandAccentFallback: frozen.brandTokens.accentColor ?? effectiveKit.brandAccent ?? "#C4552F",
              ...(groundFgInversion !== undefined ? { groundFgInversion } : {}),
            })
          : undefined;
      return {
        copy: finalCopy,
        selections: finalSelections,
        slidesData: finalSlidesData,
        rendered: finalRendered,
        ...(styleDirectiveOutcome !== undefined ? { styleDirectiveOutcome } : {}),
        ...(styleVariation.length > 0 ? { styleVariation } : {}),
        ...(variationPlan !== undefined && variationPlan.length > 0 ? { variationPlan } : {}),
        contrastFacts: finalContrastFacts,
        ...(finalRelevance !== undefined ? { relevance: finalRelevance } : {}),
        ...(angleDecision !== undefined ? { angleDecision } : {}),
        // Phase 2, items L/M/P — measured on the attempt that actually ships.
        // `interest` and `skeleton` are non-optional because both are
        // computed on every attempt at $0, so "absent" would only ever mean a
        // bug; the two markers below are absent on the common case.
        interest: finalInterest ?? { ok: true, perSlide: [], findings: [], waived: [], warnings: [], notMeasured: [] },
        ...(finalInterestRelayout !== undefined ? { interestRelayout: finalInterestRelayout } : {}),
        ...(interestDegraded !== undefined ? { interestDegraded } : {}),
        skeleton: finalSkeleton ?? { ok: true, action: "pass", signature: "", repeatedPrevious: false, warnings: [], recent: [] },
        // With the assembled slides, so a device that was valid and still
        // DROPPED (an archetype with no slot, a closer whose recap took the
        // middle) is reported as a fact rather than vanishing silently.
        deviceIssues: collectDeviceIssues(finalCopy, finalSlidesData),
      };
    };

    /**
     * Phase 0, item C — what grounded this post, for the gate payload and the
     * deliverable: where the brief came from, how confident it is, and the
     * relevance judge's verdict on the shipped attempt (absent when the judge
     * could not run — never a fabricated score).
     */
    const groundingFor = (draft: DraftResult) => ({
      briefSource: briefResolution.source,
      briefConfidence: brief.confidence,
      // Phase 1, item H — WHEN the brief was written and by what, so a
      // reviewer can tell a document written this morning from one a month
      // old, and an agent-written one from the deterministic stand-in.
      briefGeneratedAt: brief.generatedAt,
      briefGeneratedBy: brief.generatedBy,
      // When the run's target language came from the brief rather than from
      // the brand record (02d resolved none), the reviewer sees WHY this post
      // is in a language nothing in the portal declares — and the ledger has
      // the one-line remedy.
      ...(languageAdoption.source === "brief" && languageAdoption.note !== undefined
        ? { targetLanguage: languageAdoption.language, targetLanguageSource: "brief" as const, targetLanguageNote: languageAdoption.note }
        : {}),
      ...(briefWriteOutcome !== undefined && briefWriteOutcome.status !== "written"
        ? { briefWriteProblem: briefWriteOutcome.reason ?? briefWriteOutcome.status }
        : {}),
      // What the engine corrected in the brief's own audit trail when it was
      // written this run: a source the model claimed that this run never
      // supplied, or a grounding source it read and the model left out. The
      // relevance floor is computed from the corrected list, so this is the
      // line that explains a floor a reviewer might otherwise not expect.
      ...(briefWriteOutcome?.sourceNotes !== undefined && briefWriteOutcome.sourceNotes.length > 0
        ? { briefSourceNotes: briefWriteOutcome.sourceNotes }
        : {}),
      ...(draft.relevance !== undefined ? { relevance: draft.relevance } : {}),
    });

    /**
     * Phase 1, items I and J — what the evidence gathering could and could not
     * do this run: which topic engines contributed nothing and why, which
     * candidates were dropped before scoring, whether the research base came
     * in thin, and how many duplicate fact cards were merged. Notes, never
     * gates: every one of them is a run that still delivered.
     */
    const evidenceNotesForGate = () => ({
      ...(topicSignals.notes.length > 0 ? { topicSignals: topicSignals.notes } : {}),
      ...(rankedTopics.dropped.length > 0 ? { droppedCandidates: rankedTopics.dropped } : {}),
      documentCount: deepResearch.documentCount,
      ...(deepResearch.note !== undefined ? { researchNote: deepResearch.note } : {}),
      ...(primarySources.notes.length > 0 ? { primarySourceNotes: primarySources.notes } : {}),
      factCards: { kept: factCards.facts.length, duplicatesDropped: factCards.dropped.length, truncated: factCards.truncated },
    });

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
    // `runReviewCycle`'s `onDecision` now also receives the round's raw
    // `output` (SCRUM-306/AU23), but `templateFeedback` handling below needs
    // the SLIDES specifically, keyed for `customArchetypesByTemplateId` — so
    // this local capture stays rather than re-deriving that from `output` on
    // every decision. Captured here, in `attempt`, right before each round's
    // draft is returned — safe because the cycle is a strict, single-
    // threaded loop (attempt -> buildGate -> gate -> onDecision, one round
    // fully resolves before the next begins), so `onDecision` always reads
    // the draft the reviewer was actually looking at.
    let latestDraftForReview: DraftResult | undefined;

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
        latestDraftForReview = draft;
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
          // Phase 0, item C — the brief that grounded this post and the
          // relevance verdict, so the reviewer knows whether "reads as this
          // client's" was judged and how.
          grounding: groundingFor(draft),
          // Phase 0, item E — the subject decision: source, mode, the stories
          // NOT chosen and the rule that decided, so the reviewer sees the
          // road not taken rather than only the destination.
          topicDecision: topicDecisionForGate(topicClaim),
          // Phase 1, item K — the angle this round argues, the two it
          // rejected, and the arithmetic that decided; `status: "unavailable"`
          // when the proposer could not run.
          ...(draft.angleDecision !== undefined ? { angleDecision: draft.angleDecision } : {}),
          // Phase 1, items I/J — what the five engines and the three research
          // lanes could and could not read this run.
          evidence: evidenceNotesForGate(),
          // Phase 0 cost controls — what this run has spent so far
          // (max(measured, estimate) per step) and the plan it ran under:
          // estimate vs actual, every adaptation, every threshold crossed.
          // A reviewer sees what a `revise` will cost; nothing here ever
          // holds the run (owner's rule).
          spendUsd: meter.totalUsd,
          budget: summarizeRunBudget(budgetDecision, meter, budgetNotes),
          budgetLine: estimateVsActualLine(summarizeRunBudget(budgetDecision, meter, budgetNotes)),
          // Phase 2, item N — what the Template Studio did for this client,
          // and the SEPARATE setup budget it ran on (target $2.00, hard max
          // $3.00), reported exactly the way a run's is. This is also where a
          // reviewer APPROVES the set: a `templateFeedback` entry with
          // `verdict: "approved", promote: true` on a studio `templateId`
          // flips `enabled` (`persistReviewFeedback`), and only then does
          // `resolveBest` start picking it.
          ...(studioReport !== undefined ? { templateStudio: studioReport } : {}),
          ...(setupBudgetSummary !== undefined
            ? { setup: { budget: setupBudgetSummary, budgetLine: setupEstimateVsActualLine(setupBudgetSummary) } }
            : {}),
          // Phase 3, items Q + S — where this client's generated images get
          // their look, and what the whole set was graded with. `source` is
          // the field a reviewer needs: for most clients it reads
          // `brand+brief`, because visual-pattern consent is usually absent.
          ...(visualDirectionReport !== undefined ? { visualDirection: visualDirectionReport } : {}),
          styleLock: { id: frozenStyle.id, ...(frozenStyle.line !== undefined ? { line: frozenStyle.line } : {}), source: frozenStyle.source, treatment: frozenStyle.treatment, treatmentReason: frozenStyle.treatmentReason, ...(frozenStyle.tintHex !== undefined ? { tintHex: frozenStyle.tintHex } : {}) },
          // Phase 2, item L — what the shipped attempt's pixels MEASURED:
          // per-slide shares, every finding, the clause-E waivers, the
          // warnings that never gate, and the slides that could not be read.
          interest: {
            perSlide: draft.interest.perSlide,
            findings: draft.interest.findings,
            waived: draft.interest.waived,
            warnings: draft.interest.warnings,
            notMeasured: draft.interest.notMeasured,
          },
          // Present only when the free re-layout actually ran: a reviewer can
          // then see that CODE fixed something the writer got wrong, rather
          // than the post silently improving.
          ...(draft.interestRelayout !== undefined
            ? {
                interestRelayout: {
                  changes: draft.interestRelayout.changes,
                  notes: draft.interestRelayout.notes,
                  unremedied: draft.interestRelayout.unremedied,
                  // Load-bearing on the gate: without it a plan whose
                  // re-render FAILED (and whose changes were therefore rolled
                  // back) reads exactly like one that worked.
                  ...(draft.interestRelayout.discarded === true
                    ? { discarded: true, discardedReason: draft.interestRelayout.discardedReason ?? "the re-layout's render did not succeed" }
                    : {}),
                },
              }
            : {}),
          // Present only when the floor never cleared: the post shipped
          // flagged rather than held.
          ...(draft.interestDegraded !== undefined
            ? {
                visualInterest: {
                  findings: draft.interestDegraded.findings,
                  reason: interestDegradedReason(draft.interestDegraded.findings, { pastHardMax: meter.posture === "cheapest-path" }),
                },
              }
            : {}),
          // Phase 2, item P — the layout sequence this post ships, the
          // previous one, and the measured distance between them.
          skeleton: skeletonGateFacts(draft.skeleton),
          // Phase 2, item M — devices that could not render honestly and were
          // dropped. WARN-only: furniture must never hold a run, and without
          // surfacing it the drop is invisible.
          ...(draft.deviceIssues.length > 0 ? { deviceIssues: draft.deviceIssues } : {}),
          // IGSTYLE-3, §2.3's "loud refusals" requirement — what THIS round's
          // style-directive resolution did, including any refusal, so a
          // silently-dropped colour instruction is never indistinguishable
          // from one that simply wasn't asked for. Absent on the common case
          // (nothing was attempted this round) rather than an empty object,
          // matching every other optional gate-payload field's convention.
          ...(draft.styleDirectiveOutcome !== undefined ? { styleDirectiveOutcome: draft.styleDirectiveOutcome } : {}),
          // IGSTYLE-7, §7b/7c — every departure THIS round's variation budget
          // (or an intent-only satisfaction) made from the raw learned prior
          // below, so a reviewer can see not just WHAT was learned but
          // whether/why this round's render actually varied from it. Absent
          // on the common case — nothing departed — same convention as every
          // other optional gate-payload field here.
          ...(draft.styleVariation !== undefined ? { styleVariation: draft.styleVariation } : {}),
          // IGSTYLE-10, §10e — which axis each slide used this round, and why
          // not when it didn't (`ring=1`, `accent-fails-inverted-ground`,
          // `directive-pinned`, `no-ground-pair`) — the same "loud, never
          // silent" rule as `styleDirectiveOutcome` above, applied to the
          // 75/25 variation budget. Absent on the common case — no brand kit
          // at all, so neither axis was even attempted.
          ...(draft.variationPlan !== undefined ? { variationPlan: draft.variationPlan } : {}),
          // IGSTYLE-5, §2.4/§2.6 — the Layer-1 PRIOR this run drafted against
          // (frozen at 02h, same object every round of this run), so a
          // reviewer can see WHY revision 0 already leans a certain way with
          // no human input yet given this run. Absent on the common case —
          // no prior client history, or nothing in it cleared the evidence
          // threshold — same convention as `styleDirectiveOutcome` just
          // above.
          ...(distilledStyle.evidence.length > 0
            ? {
                learnedStylePreferences: {
                  overrides: distilledStyle.overrides,
                  strength: distilledStyle.strength,
                  intents: distilledStyle.intents,
                  evidence: distilledStyle.evidence,
                },
              }
            : {}),
          // The actual caption a reviewer approves alongside the images —
          // every other channel's gate payload has carried its drafted text
          // as `preview` since the review panel existed; a carousel's own
          // `preview` used to be a raw join of every slide's field values
          // (including `accentColor`'s hex code) because no real caption
          // existed yet to show instead.
          preview: draft.copy.caption,
          // SCRUM-393 (IGSTYLE-8): text and accent-on-ground contrast, as
          // FACTS — for passes as well as failures, so a reviewer sees the
          // good numbers too, not only a warning when something's wrong.
          contrastFacts: draft.contrastFacts,
          // The editable projection (Phase 2 in-place review editing): the
          // caption plus each slide's PROSE fields — never the layout
          // metadata in NON_PROSE_FIELD_KEYS — so the reviewer can edit the
          // actual text behind the pixels instead of describing a change and
          // paying for a redraft.
          copy: {
            caption: draft.copy.caption,
            slides: draft.slidesData.slides.map((slide) => ({
              n: slide.n,
              template: slide.template,
              fields: Object.fromEntries(Object.entries(slide.fields ?? {}).filter(([key]) => !NON_PROSE_FIELD_KEYS.has(key))),
            })),
          },
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
          //
          // A `custom` archetype this round drafted has no row in
          // `templateResolution.chosen` at all (that list is fixed at step
          // 04c, before this round's copy even exists) — a synthetic entry
          // is added here so it's found by the exact same lookup below, with
          // no change to the lookup itself. Its `templateId` is the same
          // `customArchetypeTemplateId` scheme `onDecision`/`promoteTemplate`
          // use, so a reviewer's `promote: true` on it connects straight
          // through with no separate lookup needed.
          slideTemplates: (() => {
            const chosenForGate = [
              ...templateResolution.chosen,
              ...draft.copy.slides
                .filter((s) => s.layout === "custom" && s.customArchetype)
                .map((s) => ({
                  archetypeId: s.customArchetype!.archetypeId,
                  templateId: customArchetypeTemplateId(wf.clientSlug, s.customArchetype!.archetypeId),
                  source: "ai_generated" as const,
                  qualityScore: 0,
                })),
            ];
            return draft.slidesData.slides.map((slide) => {
              const chosen = chosenForGate.find((c) => templateFileName(c.archetypeId) === slide.template);
              return {
                n: slide.n,
                template: slide.template,
                ...(chosen ? { templateId: chosen.templateId, templateSource: chosen.source } : {}),
                isExperimental: chosen?.source === "ai_generated",
              };
            });
          })(),
        },
        requiredRole: "account_manager",
        timeout: { duration: "1h", onTimeout: "auto_approve" },
      }),
      onDecision: async ({ revision, response, templateFeedback }) => {
        // IGSTYLE-3, §2.2 Layer 2 — captured here (not via `notes`, which the
        // shared `RevisionNote` shape deliberately never carries `edits` on)
        // so the NEXT round's `draftOnce` reads exactly the structured pick
        // THIS round's reviewer made. Only meaningful on `revise` — an
        // `approve`'s `edits.style` is Phase 2's in-place-edit path (09c/09d
        // below), not a directive for a future drafting round that will
        // never happen. Safe to read/write here with no staleness risk for
        // the same reason `latestDraftForReview` is (`runReviewCycle`'s own
        // doc comment: "attempt -> buildGate -> gate -> onDecision, one round
        // fully resolves before the next begins").
        latestStyleEdit = response.decision === "revise" ? response.edits?.style : undefined;

        const customArchetypesByTemplateId = new Map(
          (latestDraftForReview?.copy.slides ?? [])
            .filter((s) => s.layout === "custom" && s.customArchetype)
            .map((s) => [customArchetypeTemplateId(wf.clientSlug, s.customArchetype!.archetypeId), s.customArchetype!] as const),
        );
        // IGSTYLE-5, §2.4 writer 1 — pulled into a local first (rather than
        // narrowed inline in the object literal below) because
        // `latestDraftForReview` is a `let` captured across an `await`
        // boundary in this closure: TypeScript does not carry a narrowing on
        // `x.y.z` through that boundary, only on a local it can see is never
        // reassigned.
        const styleOutcome = latestDraftForReview?.styleDirectiveOutcome;
        await persistReviewFeedback(wf, tools, ctx, {
          revision,
          response,
          templateFeedback,
          templateStore: options.templateStore,
          customArchetypesByTemplateId,
          // SCRUM-306 (AU23): `latestDraftForReview` is exactly what this
          // round's reviewer looked at (see its own doc comment above, on
          // why reading it here is safe) — only serialized on reject, for
          // the same reason every other review-gated agent restricts this
          // to reject.
          content: response.decision === "reject" && latestDraftForReview !== undefined ? JSON.stringify(latestDraftForReview) : undefined,
          // IGSTYLE-5, §2.4 writer 1 — this round's resolved style directive,
          // verbatim off the draft the reviewer actually judged (never the
          // merged/re-derived effective kit — see `styleDirectiveOutcome`'s
          // own field doc). Undefined on the overwhelming majority of rounds,
          // exactly like `styleDirectiveOutcome` itself: nothing style-related
          // was even attempted.
          style:
            styleOutcome !== undefined && styleOutcome.source !== "none"
              ? {
                  // `StyleOverrides`' keys are all optional (`string |
                  // undefined`) so it isn't structurally a `Record<string,
                  // string>` — this drops any key that ended up unset rather
                  // than writing an illegal `undefined` value into the
                  // durable row.
                  overrides: Object.fromEntries(
                    Object.entries(styleOutcome.overrides).filter((entry): entry is [string, string] => entry[1] !== undefined),
                  ),
                  source: styleOutcome.source,
                  intents: styleOutcome.intents,
                  applied: styleOutcome.applied,
                }
              : undefined,
        });
      },
    });

    // ── 09c/09d: apply the reviewer's in-place edits (Phase 2) ──
    //
    // The reviewer IS the gate: their edits ship verbatim — no model pass, no
    // topic-guardrail re-run on human-authored text. Validation is structural
    // only (an edit may touch a prose field the slide actually has, never the
    // NON_PROSE layout metadata), and the whole path exists only when edits
    // were actually sent — a plain approve's trace is byte-identical to
    // before this feature.
    let slidesData = review.output.slidesData;
    let rendered = review.output.rendered;
    let caption = review.output.copy.caption;

    const reviewEdits = review.response.edits;
    const hasReviewEdits =
      reviewEdits !== undefined && (reviewEdits.caption !== undefined || (reviewEdits.slides?.length ?? 0) > 0);
    if (hasReviewEdits) {
      const applied = await wf.step.code("09c-apply-review-edits", () => {
        const summary: string[] = [];
        const editsBySlide = new Map((reviewEdits.slides ?? []).map((e) => [e.n, e]));
        const slides = review.output.slidesData.slides.map((slide) => {
          const edit = editsBySlide.get(slide.n);
          if (edit === undefined) return slide;
          const fields = { ...slide.fields };
          for (const [key, value] of Object.entries(edit.fields ?? {})) {
            // Only a prose field the slide already HAS is editable — an
            // unknown key or layout metadata is dropped with a note in the
            // step output, never an error: a stray key must not cost an
            // approved post.
            if (!(key in fields) || NON_PROSE_FIELD_KEYS.has(key)) {
              summary.push(`slide ${slide.n} ${key}: ignored (not an editable field)`);
              continue;
            }
            if (fields[key] !== value) {
              summary.push(`slide ${slide.n} ${key}: "${fields[key]}" -> "${value}"`);
              fields[key] = value;
            }
          }
          if (edit.fontScale !== undefined && fields["fontScale"] !== edit.fontScale) {
            summary.push(`slide ${slide.n} font size -> ${edit.fontScale}`);
            fields["fontScale"] = edit.fontScale;
          }
          if (edit.textAlign !== undefined && fields["textAlign"] !== edit.textAlign) {
            summary.push(`slide ${slide.n} alignment -> ${edit.textAlign}`);
            fields["textAlign"] = edit.textAlign;
          }
          return { ...slide, fields };
        });
        let editedCaption = review.output.copy.caption;
        if (reviewEdits.caption !== undefined && reviewEdits.caption !== editedCaption) {
          summary.push(`caption: "${editedCaption}" -> "${reviewEdits.caption}"`);
          editedCaption = reviewEdits.caption;
        }
        return {
          slidesData: { ...review.output.slidesData, slides },
          caption: editedCaption,
          summary,
        };
      });

      // Text edits change pixels, so the carousel re-renders through the
      // exact same path as the original. Image files may have vanished since
      // the pre-gate render (instance recycle): the 06f rule applies — a
      // missing picture strips to a typographic slide, it never holds.
      const editedInput: RenderCarouselInput = {
        ...applied.slidesData,
        slides: await Promise.all(
          applied.slidesData.slides.map(async (slide) => {
            const images: Record<string, string> = {};
            for (const [key, rel] of Object.entries(slide.images ?? {})) {
              const onDisk = await fs
                .access(path.resolve(options.repoRoot, rel))
                .then(() => true)
                .catch(() => false);
              if (onDisk) images[key] = rel;
            }
            return { ...slide, images };
          }),
        ),
      };
      await ensureTemplatesOnDisk(validateCustomArchetypes(review.output.copy));
      const editedRender = await wf.step.code("09d-render-edited-carousel", async () =>
        tools["publish.renderCarousel"]!.execute(editedInput, { ctx }),
      );

      const renderOk = editedRender.status === "success";
      if (renderOk) {
        slidesData = editedInput;
        rendered = (editedRender as { result: RenderCarouselResult }).result;
        caption = applied.caption;
      } else {
        // Pixels and text must never disagree: if the edited render failed,
        // the ORIGINAL approved render ships with its ORIGINAL slide text,
        // and only the caption edit (post text, not pixels) still applies.
        caption = reviewEdits.caption ?? caption;
        await wf.step.code("09d2-record-edits-not-applied", async () =>
          tools["ledger.appendEvent"]?.execute(
            {
              runId: wf.runId,
              eventId: `${wf.runId}__review-edits-not-applied`,
              level: "warn",
              message: `reviewer slide edits could not be applied (re-render: ${editedRender.status}); delivered the originally approved render, caption edit ${reviewEdits.caption !== undefined ? "applied" : "n/a"}`,
            },
            { ctx },
          ),
        );
      }

      // The preference half of the loop: the deltas become durable feedback,
      // so future drafts calibrate toward what the reviewer keeps fixing by
      // hand. A separate feedbackId from the decision's own note — both can
      // exist for one review.
      if (applied.summary.length > 0) {
        await wf.step.code("09e-record-edit-feedback", async () => {
          const note =
            `Reviewer edited before approving${renderOk ? "" : " (edits could not be applied to this post's pixels; treat as preference)"}: ` +
            applied.summary.slice(0, 12).join("; ").slice(0, 1800);
          try {
            await tools["memory.appendFeedback"]?.execute(
              {
                feedbackId: `${wf.runId}-r${review.revision}-edits`,
                productId: wf.productId,
                decision: "approve",
                actor: review.response.actor,
                note,
                revision: review.revision,
                runId: wf.runId,
              },
              { ctx },
            );
          } catch (error) {
            console.error("09e-record-edit-feedback: could not record the reviewer's edit deltas", error);
          }
          return { note };
        });
      }
    }

    // IGSTYLE-5, §2.4 writer 3 — `edits.style` is the reviewer's own color
    // controls (Phase 2, IGSTYLE-1 §"Meaningful on approve AND revise"; the
    // portal UI to submit it on approve is IGSTYLE-6's job, but the field is
    // already a legal `GateResponse.edits.style` today). Deliberately its OWN
    // step and its OWN `if`, independent of `hasReviewEdits` above: a reviewer
    // who only adjusted colors — no caption or slide text touched — still
    // must produce a durable, STRUCTURED row, not just prose, so a later
    // run's `distillStylePreferences` has real hex evidence to vote over.
    if (reviewEdits?.style !== undefined && Object.keys(reviewEdits.style).length > 0) {
      const styleOverrides = Object.fromEntries(
        Object.entries(reviewEdits.style).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      await wf.step.code("09e-record-edit-feedback-style", async () => {
        const note = `Reviewer set colors before approving: ${Object.entries(styleOverrides)
          .map(([k, v]) => `${k} -> ${v}`)
          .join("; ")}`;
        try {
          await tools["memory.appendFeedback"]?.execute(
            {
              feedbackId: `${wf.runId}-r${review.revision}-edits-style`,
              productId: wf.productId,
              decision: "approve",
              actor: review.response.actor,
              note,
              revision: review.revision,
              runId: wf.runId,
              style: { overrides: styleOverrides, source: "structured", intents: [], applied: [] },
            },
            { ctx },
          );
        } catch (error) {
          console.error("09e-record-edit-feedback-style: could not record the reviewer's color edits", error);
        }
        return { note };
      });
    }

    /**
     * Phase 2, item L — the degrade marker for the shipped draft, computed
     * once so the deliverable, the ledger row and the workflow's own return
     * value all carry the SAME sentence. Absent on the overwhelming majority
     * of runs: the floor passed, or the free re-layout fixed it.
     */
    const interestDegradedMarker =
      review.output.interestDegraded !== undefined
        ? {
            status: "degraded" as const,
            reason: interestDegradedReason(review.output.interestDegraded.findings, { pastHardMax: meter.posture === "cheapest-path" }),
          }
        : undefined;

    // ── 09f: the pool that grows (Phase 2, item O) ──
    //
    // A run-authored layout that shipped through the HUMAN gate twice with no
    // edit to the slide it renders, and no `revise` verdict on the design
    // itself, is promoted into that client's own template pool. This is the
    // "generator that updates the pool" the owner asked for, and the evidence
    // is two clean human ships rather than a model's opinion of its own work.
    //
    // The row is stored under a ROUTABLE archetype id — the design becomes
    // this client's own `headline_focus`/`closer`/`cover` — so that the third
    // run picks it the ordinary way through `resolveBest` and
    // `templateForLayout`. Stored under its authored `custom_*` id it could
    // never be picked at all: `templateForLayout` maps only the fixed layout
    // enum, and `custom` requires model-authored markup that attempt. A
    // design that reads its own invented slot names has no routable
    // archetype, so it is recorded with the reason and not stored; see
    // `buildAutoPromotionRequest`.
    //
    // Deliberately NOT a parallel scoring mechanism: the existing
    // `promoteTemplate` writes the row, `AUTO_PROMOTE_QUALITY_SCORE` (55) is
    // its opening score, and `reviewTemplate`'s `QUALITY_DELTA` moves it from
    // there exactly as it moves a human-promoted row's.
    //
    // Conditional on this run having actually shipped a custom design, so a
    // normal carousel's trace does not grow a step that never does anything.
    // `store.get` first (the same don't-blind-overwrite guard
    // `persistReviewFeedback` applies) plus `recordCleanShip`'s per-runId
    // idempotence is what makes a resumed run safe. Nothing here throws.
    const shippedCustomArchetypes: ShippedCustomArchetype[] = review.output.copy.slides
      .filter((slide) => slide.layout === "custom" && slide.customArchetype !== undefined)
      .map((slide) => {
        const archetype = slide.customArchetype!;
        const basename = templateBasename(templateFileName(archetype.archetypeId));
        return {
          templateId: customArchetypeTemplateId(wf.clientSlug, archetype.archetypeId),
          archetypeId: archetype.archetypeId,
          name: archetype.name,
          bodyHtml: archetype.bodyHtml,
          css: archetype.css,
          // Which slides it ACTUALLY rendered on, read off the assembled
          // slides-data rather than off the requested layout: a custom
          // archetype that degraded (a repeat, a failed slot contract) never
          // reached the pixels and must not earn a clean ship.
          slides: slidesData.slides.filter((s) => templateBasename(s.template) === basename).map((s) => s.n),
        };
      })
      .filter((row) => row.slides.length > 0);

    if (shippedCustomArchetypes.length > 0) {
      try {
        const promotionOutcome = await wf.step.code("09f-auto-promote-templates", async () => {
          const { ships, skipped } = cleanShipsFor({
            runId: wf.runId,
            at: new Date().toISOString(),
            delivered: true,
            decision: review.response.decision,
            editedSlides: (review.response.edits?.slides ?? []).map((edit) => edit.n),
            templateFeedback: (review.response.templateFeedback ?? []).map((entry) => ({ templateId: entry.templateId, verdict: entry.verdict })),
            shipped: shippedCustomArchetypes,
          });
          let history = customArchetypeHistory;
          const promoted: string[] = [];
          const problems: string[] = [];
          for (const ship of ships) {
            const advanced = recordCleanShip(history, ship);
            history = advanced.history;
            const promote = advanced.promote;
            if (promote === undefined) continue;
            if (options.templateStore === undefined) {
              problems.push(`${promote.templateId} earned promotion but no template registry is configured for this deployment`);
              continue;
            }
            if ((await options.templateStore.get(promote.templateId)) !== undefined) continue;
            const source = shippedCustomArchetypes.find((row) => row.templateId === promote.templateId);
            if (source === undefined) continue;
            // The design is stored as the ROUTABLE archetype it can fill, not
            // under its authored `custom_*` id: a row nothing in the layout
            // enum names can never be picked again, so promoting one would
            // ship a promise the code cannot keep. A design that reads its own
            // invented slot names has no such archetype, and that is recorded
            // rather than stored — see `buildAutoPromotionRequest`.
            const decision = buildAutoPromotionRequest(promote, {
              clientSlug: wf.clientSlug,
              now: Date.now(),
              readSlots: extractSupportedFields(`${source.bodyHtml}\n${source.css}`),
            });
            if (!decision.promote) {
              problems.push(decision.reason);
              continue;
            }
            try {
              await promoteTemplate({
                store: options.templateStore,
                htmlTemplate: buildCustomArchetypeDocument(source.bodyHtml),
                cssStyles: source.css,
                ...decision.request,
              });
              promoted.push(promote.templateId);
            } catch (error) {
              problems.push(`${promote.templateId} could not be promoted: ${(error as Error).message}`);
            }
          }
          // The advanced history is RETURNED rather than assigned inside the
          // step: a checkpointed step replayed on a resume hands back its
          // cached value without re-running the body, so a closure mutation
          // would silently be lost and `09b` would write a stale ledger.
          return { history, cleanShips: ships.map((s) => s.templateId), skipped, promoted, problems };
        });
        customArchetypeHistory = promotionOutcome.history;
        // Why a design that EARNED promotion was not stored — most often
        // because it reads its own invented slot names and no routable
        // archetype could supply them. On the ledger rather than only in the
        // step output, because "we approved this design twice and it never
        // joined the pool" is a question an operator asks from the run trace.
        if (promotionOutcome.problems.length > 0) {
          try {
            await tools["ledger.appendEvent"]?.execute(
              {
                runId: wf.runId,
                eventId: `${wf.runId}__custom-archetype-promotion`,
                level: "warn",
                message: `09f: ${promotionOutcome.problems.length} run-authored design(s) were not promoted — ${promotionOutcome.problems.join("; ")}`,
              },
              { ctx },
            );
          } catch (error) {
            console.error("09f-auto-promote-templates: could not record the promotion warn", error);
          }
        }
      } catch (error) {
        // Item O's flywheel is best-effort like every other `09b`-adjacent
        // write: losing a promotion costs the pool one design, failing an
        // approved post over it would cost the post.
        console.error("09f-auto-promote-templates: the auto-promotion pass failed", error);
      }
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
            // The format (2026-09) and, when a scouted story took the slot, its
            // why-now and brand-fit bridge for the reviewer.
            format: review.output.copy.format,
            ...(topicClaim.trend !== undefined ? { trend: topicClaim.trend } : {}),
            // Phase 0 (items C/E and the cost controls): the same grounding,
            // topic decision and spend the reviewer saw on the gate payload,
            // on the persisted record.
            grounding: groundingFor(review.output),
            topicDecision: topicDecisionForGate(topicClaim),
            // Phase 1 (items I/J/K): the angle the shipped post argues and
            // what the evidence gathering could read, on the persisted record.
            ...(review.output.angleDecision !== undefined ? { angleDecision: review.output.angleDecision } : {}),
            evidence: evidenceNotesForGate(),
            spendUsd: meter.totalUsd,
            budget: summarizeRunBudget(budgetDecision, meter, budgetNotes),
            // Phase 2 (items L/M/N/P): the same measured facts the reviewer
            // saw on the gate payload, on the PERSISTED record — what the
            // studio generated and what the setup cost, what the shipped
            // pixels measured, what code re-laid-out for free, the layout
            // sequence this post used, and any device that could not render
            // honestly.
            ...(studioReport !== undefined ? { templateStudio: studioReport } : {}),
            ...(setupBudgetSummary !== undefined ? { setup: { budget: setupBudgetSummary } } : {}),
          // Phase 3, items Q + S — where this client's generated images get
          // their look, and what the whole set was graded with. `source` is
          // the field a reviewer needs: for most clients it reads
          // `brand+brief`, because visual-pattern consent is usually absent.
          ...(visualDirectionReport !== undefined ? { visualDirection: visualDirectionReport } : {}),
          styleLock: { id: frozenStyle.id, ...(frozenStyle.line !== undefined ? { line: frozenStyle.line } : {}), source: frozenStyle.source, treatment: frozenStyle.treatment, treatmentReason: frozenStyle.treatmentReason, ...(frozenStyle.tintHex !== undefined ? { tintHex: frozenStyle.tintHex } : {}) },
            interest: {
              perSlide: review.output.interest.perSlide,
              findings: review.output.interest.findings,
              waived: review.output.interest.waived,
              warnings: review.output.interest.warnings,
              notMeasured: review.output.interest.notMeasured,
            },
            ...(review.output.interestRelayout !== undefined
              ? {
                  interestRelayout: {
                    changes: review.output.interestRelayout.changes,
                    notes: review.output.interestRelayout.notes,
                    unremedied: review.output.interestRelayout.unremedied,
                    ...(review.output.interestRelayout.discarded === true
                      ? {
                          discarded: true,
                          discardedReason: review.output.interestRelayout.discardedReason ?? "the re-layout's render did not succeed",
                        }
                      : {}),
                  },
                }
              : {}),
            ...(interestDegradedMarker !== undefined
              ? { visualInterest: { findings: review.output.interestDegraded!.findings, reason: interestDegradedMarker.reason } }
              : {}),
            skeleton: skeletonGateFacts(review.output.skeleton),
            ...(review.output.deviceIssues.length > 0 ? { deviceIssues: review.output.deviceIssues } : {}),
            // THE PER-IMAGE COMPLIANCE RECORD, on the persisted deliverable.
            //
            // One row per slide naming that image's source reason, its
            // licence, its rights and watermark verdicts, and whether the
            // picture carries THAT slide's claim — `ImageSelectionSchema`'s
            // own doc comment calls it exactly that. It was reaching
            // `ledger.recordUsedImages` (paths only) and nothing else, so the
            // one artefact that says *under what licence* each shipped
            // picture was used lived only in memory. A row that a free
            // re-layout moved a photograph into (`promote-image-to-cover`)
            // is the case that makes this load-bearing rather than tidy.
            selections: review.output.selections,
            caption,
            slides: slidesData.slides,
            rendered: rendered.rendered,
            // SCRUM-242 (T-A10): the DEGRADED marker, on the actual persisted
            // deliverable a reviewer looks at — see 02f's own comment.
            ...(contextGrounding.decision === "degraded" ? { contextGrounding: contextGrounding.marker } : {}),
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

      // The write half of the anti-repetition loop step 04e reads: the
      // shipped post's text joins this agent's rolling excerpt window, so
      // the NEXT run's research history, do-not-repeat directive, and 07d
      // similarity check all see it. Only on delivery (a post that never
      // shipped was never published — same rule as recordUsedImages above),
      // and best-effort: losing an excerpt costs future dedup signal, but
      // failing an otherwise-delivered post over it would cost the post.
      try {
        await tools["ledger.recordOutputExcerpt"]?.execute(
          // `slidesData` (not review.output) so the dedup window records what
          // ACTUALLY shipped — including any reviewer in-place edits.
          { agentId: "instagram-agent", runId: wf.runId, excerpt: `${caption}\n\n${slidesTextFor({ ...review.output, slidesData })}` },
          { ctx },
        );
      } catch (error) {
        console.error("09b-deliver-and-log: could not record the output excerpt for future dedup", error);
      }

      // Phase 0, item E: the decision log `03d` rotates the content mode over
      // next run, and (audit finding 8) the first place the archetypes a post
      // actually shipped with are recorded — at zero cost. Idempotent on
      // `decisionId`; best-effort like the excerpt write above: losing a row
      // costs rotation signal, failing a delivered post over it would cost
      // the post.
      try {
        await tools["memory.appendDecision"]?.execute(
          {
            decisionId: `${wf.runId}__topic`,
            // Phase 1, item K: the angle joins the same row, LAST inside the
            // parenthesis. `rememberLine` is free prose that may itself
            // contain semicolons and colons, so it has to be terminal for
            // `angleFromDecisionSummary` to read it back — which is how next
            // week's proposal knows what this account already said.
            // `parseContentModeFromSummary`'s `/mode: ([a-z-]+)/` still
            // matches, so the mode rotation is untouched.
            summary: angleDecisionSummary(
              topicDecisionSummary({
                topic: topicClaim.topic,
                mode: topicClaim.mode ?? modeSelection.mode,
                source: topicClaim.source,
                archetypes: slidesData.slides.map((s) => s.template.replace(/(-inv)?\.html$/, "")),
              }),
              review.output.angleDecision?.status === "selected" ? review.output.angleDecision.chosen : undefined,
            ),
            ...(topicClaim.weighting?.rule !== undefined ? { rationale: topicClaim.weighting.rule } : {}),
          },
          { ctx },
        );
      } catch (error) {
        console.error("09b-deliver-and-log: could not append the topic decision for the mode rotation", error);
      }

      // Budget learning (owner's rule 3): estimate vs actual for THIS run goes
      // into the client's history so the next run's `02j` starts calibrated —
      // tighter after an overrun, relaxed again after two runs under target —
      // and one ledger row says what happened to the money. Best-effort like
      // the writes above: losing the calibration costs the next estimate,
      // failing a delivered post over it would cost the post.
      const budgetSummary = summarizeRunBudget(budgetDecision, meter, budgetNotes);
      try {
        let history = readBudgetHistory(undefined);
        // The raw document, kept as well as the parsed budget history: the
        // setup history is a sibling key in the SAME document (item N.5), and
        // re-reading it would be a second round trip for a value already in
        // hand.
        let beliefsForSetup: unknown;
        const read = await tools["memory.read"]?.execute({ scope: "beliefs" }, { ctx });
        if (read?.status === "success") {
          beliefsForSetup = (read.result as { beliefs?: unknown }).beliefs;
          history = readBudgetHistory(beliefsForSetup);
        }
        const next = recordRunInHistory(history, {
          runId: wf.runId,
          at: new Date().toISOString(),
          estimatedUsd: budgetSummary.estimatedUsd,
          actualUsd: budgetSummary.actualUsd,
          crossedTarget: budgetSummary.crossedTarget,
          crossedMax: budgetSummary.crossedMax,
          adaptations: budgetSummary.adaptations.length,
        });
        // ONE call carrying every belief key this run learned something about,
        // not one call per key: `memory.updateBeliefs` shallow-merges a diff, so
        // N separate calls each read-modify-write the SAME document and the last
        // writer wins — which would silently drop two of the three.
        // `workflow-e2e.test.ts` counts the calls for exactly that reason.
        //
        // `occupancy` is left EMPTY rather than zero-filled when the measurement
        // did not happen: a zero-filled row is indistinguishable from six
        // genuinely empty slides, and this history is what a future run reasons
        // about.
        const shippedOccupancy = review.output.interest.perSlide.map((verdict) => verdict.metrics.occupiedShare);
        const skeletonEntry = buildSkeletonEntry({
          runId: wf.runId,
          at: new Date().toISOString(),
          slides: slidesData.slides.map((slide) => ({ n: slide.n, template: slide.template, hasImage: slide.images?.["hero"] !== undefined })),
          roles: rolesForSlideCount(slidesData.slides.length),
          // The rendered device kind, for the same reason `07k` reads it: the
          // stored signature has to describe what the client's audience saw,
          // or the next run avoids a skeleton this one never actually shipped.
          devices: slidesData.slides.map((slide) => slide.fields?.["deviceKind"]),
          ...(shippedOccupancy.length === slidesData.slides.length ? { occupancy: shippedOccupancy } : {}),
          edited: hasReviewEdits,
        });
        await tools["memory.updateBeliefs"]?.execute(
          {
            diff: {
              [RUN_BUDGET_BELIEF_KEY]: next,
              [SKELETON_BELIEF_KEY]: recordSkeleton(skeletonHistory, skeletonEntry),
              [CUSTOM_ARCHETYPE_BELIEF_KEY]: customArchetypeHistory,
              // The setup history is a fourth SIBLING key, written only on a
               // run that actually generated a set, so the next setup for this
               // client starts calibrated (item N.5).
              ...(setupBudgetRecord !== undefined
                ? {
                    [SETUP_BUDGET_BELIEF_KEY]: recordSetupInHistory(readSetupBudgetHistory(beliefsForSetup), {
                      runId: wf.runId,
                      at: new Date().toISOString(),
                      ...setupBudgetRecord,
                    }),
                  }
                : {}),
            },
          },
          { ctx },
        );
        // One operator-visible row carrying the ordered signature VERBATIM, so
        // "are we shipping the same post every week" is answerable from the run
        // trace without a beliefs read.
        try {
          await tools["ledger.appendEvent"]?.execute(
            {
              runId: wf.runId,
              eventId: `${wf.runId}__skeleton`,
              level: review.output.skeleton.repeatedPrevious ? "warn" : "info",
              message:
                `layout sequence ${skeletonEntry.signature}` +
                (review.output.skeleton.previous !== undefined ? ` (previous post: ${review.output.skeleton.previous}` : "") +
                (review.output.skeleton.previous !== undefined
                  ? review.output.skeleton.distance !== undefined
                    ? `, distance ${review.output.skeleton.distance.toFixed(2)})`
                    : ")"
                  : "") +
                (review.output.skeleton.warnings.length > 0 ? `; ${review.output.skeleton.warnings.join("; ")}` : ""),
            },
            { ctx },
          );
        } catch (error) {
          console.error("09b-deliver-and-log: could not record the skeleton ledger row", error);
        }
      } catch (error) {
        console.error("09b-deliver-and-log: could not record the run's budget history for the next run's estimate", error);
      }
      try {
        await tools["ledger.appendEvent"]?.execute(
          {
            runId: wf.runId,
            eventId: `${wf.runId}__budget`,
            level: budgetSummary.crossedTarget ? "warn" : "info",
            message: `${estimateVsActualLine(budgetSummary)}${budgetSummary.adaptations.length > 0 ? `; adaptations: ${budgetSummary.adaptations.join(", ")}` : ""}${budgetSummary.crossedMax ? "; delivered degraded on the cheapest complete path" : ""}`,
          },
          { ctx },
        );
      } catch (error) {
        console.error("09b-deliver-and-log: could not record the budget ledger row", error);
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

    // ── 09g: the shipped frames, recorded as LIBRARY uses (Phase 3, item T) ──
    //
    // Beside `ledger.recordUsedImages`, never instead of it: that ledger is
    // the "never twice, ever" rule and stays authoritative. This records
    // `{ runId, slide, at }` per frame, which is what makes "never twice in a
    // row" answerable next run — and what lets a frame that HAS shipped
    // survive eviction ahead of one that never has. Outside `09b` because a
    // step may not nest inside another; after it, because a use is only real
    // once the post is delivered — the same rule `recordUsedImages` follows.
    // Best-effort and idempotent per `(runId, slide)`, so a resumed delivery
    // counts nothing twice; `groupShippedUses` drops every path outside
    // `.media-cache/`, which is every rendered slide PNG.
    const shippedLibraryUses = groupShippedUses(
      review.output.selections.flatMap((sel) => (sel.imagePath === null ? [] : [{ path: sel.imagePath, slide: sel.n }])),
    );
    if (shippedLibraryUses.length > 0 && tools["media.libraryAdd"] !== undefined) {
      await wf.step.code("09g-record-media-library-use", async () => {
        try {
          const outcome = await tools["media.libraryAdd"]!.execute({ repoRoot: options.repoRoot, entries: shippedLibraryUses }, { ctx });
          if (outcome.status !== "success") {
            return { recorded: 0, note: `the media library use was not recorded (${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""})` };
          }
          const result = outcome.result as { usesAppended: number; skipped: Array<{ path: string; reason: string }> };
          return { recorded: result.usesAppended, skipped: result.skipped.length };
        } catch (error) {
          return { recorded: 0, note: `the media library use was not recorded (${(error as Error).message})` };
        }
      });
    }

    return {
      postId: runClaim.postId,
      topic: topicClaim.topic,
      slideCount: slidesData.slides.length,
      renderedCount: rendered.rendered.length,
      deliverableId,
      // SCRUM-242 (T-A10): same DEGRADED marker, on the workflow's own typed
      // return value — see 02f's own comment.
      ...(contextGrounding.decision === "degraded" ? { contextGrounding: contextGrounding.marker } : {}),
      // Budget (owner's rule): a run that crossed the hard max still COMPLETED
      // and delivered, on the cheapest complete path — the marker says so, and
      // why, so the reviewer knows which optional checks were skipped.
      ...(meter.crossedMax
        ? { budget: { status: "degraded" as const, reason: `${estimateVsActualLine(summarizeRunBudget(budgetDecision, meter, budgetNotes))}; ${budgetNotes.at(-1) ?? "hard max crossed"}` } }
        : {}),
      // Phase 2, item L — beside the budget marker, and for the same
      // reason: the run COMPLETED and delivered, and the marker is what keeps a
      // post that shipped with a measured defect distinguishable from one that
      // shipped clean. Never a hold.
      ...(interestDegradedMarker !== undefined ? { visualInterest: interestDegradedMarker } : {}),
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

// `artDirectionFor` lived here until Phase 3, item Q. It is now
// `buildArtDirection(tokens, direction?)` in `visual-direction.ts` — the same
// function widened by one argument, with a test of its own pinning that
// `direction === undefined` is byte-identical to what this returned.
