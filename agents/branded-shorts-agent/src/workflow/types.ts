import { z } from "zod";
import type { ContentRepair, DegradedContextGroundingMarker } from "@agent-engine/workflow";

/**
 * The per-upload intake (SKILL.md's `assets/INTAKE-REQUEST.md`, RFC-06 §7).
 * No dedicated per-run-input primitive exists in this engine yet (confirmed
 * across every migrated agent: `WorkflowEngine.run()` takes only
 * `runId`/`clientSlug`/`productId`/`runKind`/`budget` — see RFC-04's
 * `seo-geo-agent` and RFC-08's `reputation-agent`, neither of which has a
 * per-run payload channel either), so — same convention as every other
 * agent's "loose slice of `client.getConfig()`'s free-form record" — this is
 * read as `config.brandedShortsIntake` for the run currently in flight.
 */
export const BrandedShortsExclusionSchema = z.object({
  description: z.string().min(1),
  /** Only actioned when an explicit transcript span is supplied — free text alone is never auto-mapped to a cut (assets/INTAKE-REQUEST.md Q6: "our rule is to remove filler only ... if something needs to go ... we need you to say so"). */
  span: z.tuple([z.number().nonnegative(), z.number().nonnegative()]).optional(),
});
export type BrandedShortsExclusion = z.infer<typeof BrandedShortsExclusionSchema>;

export const BrandedShortsIntakeSchema = z.object({
  videoPath: z.string().min(1),
  targetLength: z.enum(["15s", "20-30s", "45-60s", "client_choice"]),
  sectionDescription: z.string().optional(),
  sectionTimestamps: z.tuple([z.number().nonnegative(), z.number().nonnegative()]).optional(),
  shortCount: z.number().int().positive().default(1),
  takeaway: z.string().min(1),
  exclusions: z.array(BrandedShortsExclusionSchema).default([]),
  /** One-off spoken names not already in the client's brand profile — never trusted to ASR (assets/INTAKE-REQUEST.md Q7). */
  names: z.array(z.string().min(1)).default([]),
  endcardOverride: z.string().optional(),
});
export type BrandedShortsIntake = z.infer<typeof BrandedShortsIntakeSchema>;

/**
 * The client-config slice step 00 reads: intake for this run, plus the
 * locked brand style (SKILL.md step 0). NOTE (SCRUM-309 / AU31): this is a
 * pointer/run-config wrapper, not the brand kit itself — the actual brand
 * data for this product is `BrandProfileSchema`
 * (`@agent-engine/tool-karos-video`, `packages/tools/karos-video/src/types.ts`),
 * loaded off disk at `brandedShortsProfilePath` by
 * `create-branded-shorts-agent-workflow.ts`'s "02-load-brand-profile" step.
 * That schema is `{ color, video_grade, video_captions_v2 }` only — no
 * voice/tone/language field exists there because none of this product's
 * output is free-text copy the model drafts: captions and the `illustrates`/
 * `phrase` fields on graphics/cutaway plans are required to quote the
 * source video's own transcript verbatim (THE RELEVANCE LAW, PLAYBOOK §4d
 * point 1; see `branded-shorts-graphics` prompt: "you cannot name the exact
 * phrase a graphic illustrates, do not propose it"), and `endcardOverride`
 * above is text the client supplies directly, never model-composed. A
 * client's spoken language is therefore whatever language they recorded
 * in — this pipeline has no language-CHOICE step for a language field to
 * govern, unlike the six copy-drafting channels `ClientBrand.language`
 * (`@agent-engine/tool-karos-client`) now feeds. Threading a `language`
 * field through this schema would be dead config nothing reads; if a real
 * language-sensitive step is ever added here (e.g. translated captions),
 * it should read `ClientBrand.language` for the same client the same way
 * the six copy channels do, not reinvent a third field.
 */
export const BrandedShortsClientConfigSchema = z.object({
  brandedShortsIntake: BrandedShortsIntakeSchema.optional(),
  /** Path to the client's locked `brand-profile.json` — absent means "no locked style yet," which blocks the run (run the Style Exploration workflow first). */
  brandedShortsProfilePath: z.string().min(1).optional(),
  /** Raw contents of the client's `graphics-language.md`. */
  brandedShortsGraphicsLanguage: z.string().min(1).optional(),
  /**
   * The client's approved archetype names from their `make_motion_repertoire.py`
   * repertoire (PLAYBOOK §4c layer 2: "the client's repertoire generator holds
   * approved archetypes"). That generator is a per-client Python script this
   * migration does not read or execute (RFC-06 §5), so this is the structured
   * source of truth stood up in its place — without it, nothing constrains
   * `BrandedShortsGraphicsAgent` to a closed vocabulary at all (P0#1 audit
   * finding), so its absence blocks the run exactly like a missing brand
   * profile does.
   */
  brandedShortsApprovedArchetypes: z.array(z.string().min(1)).min(1).optional(),
  /**
   * A `.zip`/`.tar.gz` of the client's branded-shorts asset folder —
   * `brand-profile.json` at its root plus every font/mark it references by
   * relative path, and optionally `library/index.json` (real stills for burst
   * cutaways). A local path or a `gs://` URI in the media bucket;
   * `video.materializeInputs` unpacks it into the run's work directory and the
   * profile inside it becomes this run's `brandedShortsProfilePath`. This is
   * how per-client brand assets reach a Cloud Run instance, where nothing is on
   * local disk when a run starts; a laptop or a test can keep pointing
   * `brandedShortsProfilePath` at a local file instead.
   */
  brandedShortsAssetBundle: z.string().min(1).optional(),
  /** A local scratch directory for this run's job/profile/transcript intermediates — real files the Python engine opens directly (RFC-06 §3/§4's "adapter, never infra": the WorkspaceStore's abstract JSON store is not where ffmpeg/PIL read from). Defaults to a per-run temp directory. */
  brandedShortsWorkDir: z.string().min(1).optional(),
});
export type BrandedShortsClientConfig = z.infer<typeof BrandedShortsClientConfigSchema>;

// ---- Style Exploration (onboarding, one-time per client) ----

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected a 6-digit hex color");

export const StyleCandidateSchema = z.object({
  // No existing TSDoc on these fields to transcribe (SCRUM-293 flag) — synthesized from the schema's own doc comment and step 2's own output contract.
  name: z.string().min(1).describe("This candidate's short, distinguishing name."),
  description: z.string().min(1).describe("Prose description of this style candidate's overall direction."),
  paletteUsage: z.string().min(1).describe("Prose description of how this candidate uses color — cross-referenced against paletteTokensUsed's literal hex codes, never trusted alone."),
  captionTreatment: z.string().min(1).describe("Prose description of this candidate's caption styling."),
  graphicsDirection: z.string().min(1).describe("Prose description of this candidate's motion-graphics direction."),
  endcardTreatment: z.string().min(1).describe("Prose description of this candidate's endcard styling."),
  /**
   * The literal hex codes this candidate actually uses, declared explicitly
   * rather than left implicit in `paletteUsage`'s prose (P1#6 audit finding:
   * SKILL.md's "token fidelity is a HARD GATE" had no mechanical check
   * without something literal to cross-reference against the client's real
   * brand kit). `gate.styleTokenFidelity` cross-checks every value here
   * against `client.getBrand()`'s actual data.
   */
  paletteTokensUsed: z
    .array(HexColor)
    .min(1)
    .describe(
      "The literal hex codes this candidate actually uses, declared explicitly rather than left implicit in paletteUsage's prose — gate.styleTokenFidelity cross-checks every value here against client.getBrand()'s actual data.",
    ),
});
export type StyleCandidate = z.infer<typeof StyleCandidateSchema>;

/** Step 2's output (SKILL.md "per-client onboarding"): exactly three candidate directions, never more or fewer. */
export const StyleExplorationOutputSchema = z.object({
  candidates: z.array(StyleCandidateSchema).length(3),
});
export type StyleExplorationOutput = z.infer<typeof StyleExplorationOutputSchema>;

export interface StyleExplorationWorkflowResult {
  candidates: StyleCandidate[];
  lockedCandidateName: string;
}

// ---- Highlights (bounded step 3) ----

/** SKILL.md step 3 / PLAYBOOK §2: "roughly one decisive word every chunk or two." */
export const HighlightsOutputSchema = z.object({
  highlightStarts: z.array(z.number().nonnegative()),
});
export type HighlightsOutput = z.infer<typeof HighlightsOutputSchema>;

// ---- Graphics + cutaways (bounded step 5/5b, RFC-06 §1's other judgment island) ----

export const GraphicOverlayPlanSchema = z.object({
  /** An archetype from the client's `make_motion_repertoire.py` library (PLAYBOOK §4c layer 2) — never invented outside it. */
  archetype: z.string().min(1),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  /** The transcript phrase this graphic illustrates — CONTENT LAW (graphics-language.template.md): "derived fresh from each video's transcript... never stock, never random." */
  illustrates: z.string().min(1),
  x: z.union([z.literal("center"), z.number()]).optional(),
  y: z.number().optional(),
  /** For the text-bearing archetypes (callout, clock): the payoff word(s), QUOTED from the transcript — `render_overlays.py` sets it in the client's display face. Short: it is a graphic, not a caption. */
  label: z.string().min(1).max(32).optional(),
});
export type GraphicOverlayPlan = z.infer<typeof GraphicOverlayPlanSchema>;

export const CutawayPlanSchema = z.object({
  kind: z.enum(["plate", "burst"]),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  /** SOURCE-time transcript instant this cutaway leads (`cutaway_check.py`'s `word_src_start`). */
  wordSrcStart: z.number().nonnegative(),
  /** THE RELEVANCE LAW's justification (PLAYBOOK §4d point 1) — what the cutaway illustrates and why. */
  phrase: z.string().min(1),
  stillCount: z.number().int().min(3).max(6).optional(),
  /**
   * `kind: "burst"` only: 3-6 `file` values copied VERBATIM from the
   * `assetLibrary` given in the input — the client's own cleared, treated real
   * photos (PLAYBOOK §4d.1/.7). A burst is never invented: with no library
   * there are no bursts, and `validateGraphicsPlan` rejects one that names a
   * still the library does not hold.
   */
  stills: z.array(z.string().min(1)).min(3).max(6).optional(),
  /**
   * `kind: "plate"` only: the generation brief for the single plate, written
   * against docs/CUTAWAY-IMAGE-PROMPTS.md (one clear subject, specific,
   * cinematic, believable, no clichés, no text). Absent, the `phrase` itself
   * is used — which is usually too literal (Rule 10).
   */
  prompt: z.string().min(1).max(600).optional(),
});
export type CutawayPlan = z.infer<typeof CutawayPlanSchema>;

export const GraphicsPlanOutputSchema = z.object({
  overlays: z.array(GraphicOverlayPlanSchema),
  cutaways: z.array(CutawayPlanSchema),
});
export type GraphicsPlanOutput = z.infer<typeof GraphicsPlanOutputSchema>;

/**
 * `createGraphicOverlayPlanSchema` (P0#1 audit fix): a per-client-parameterized
 * refinement of `GraphicOverlayPlanSchema` rejecting any `archetype` not in
 * `allowedArchetypes` — the closed-vocabulary invariant RFC-06 §1 cites as
 * the safety justification for this being a *bounded* step ("constrained to
 * a closed vocabulary the client already approved") had no code enforcing it
 * before this fix.
 *
 * Deliberately NOT wired as `BrandedShortsGraphicsAgent`'s own `outputSchema`
 * (the schema the ReAct loop's structured-output contract is built from,
 * `base-agent.ts`'s `buildTurnSchema`): a `.refine()` predicate doesn't
 * survive `z.toJSONSchema()` (no JSON Schema equivalent), so the model is
 * never actually told about the constraint that way, and a `ModelAdapter`
 * hitting `req.schema.parse(...)` and throwing on a refine failure surfaces
 * as `tooling_error` from `BaseAgent.runOneTurn`'s try/catch — exactly the
 * content-judgment-mistaken-for-a-tooling-break conflation RFC-01 §6 exists
 * to prevent. Used instead as an explicit, separate validation pass the
 * workflow runs on the agent's returned plan, producing a clear per-overlay
 * violation list that feeds the same graphics/cutaway-gate retry loop as any
 * other gate failure.
 */
export function createGraphicOverlayPlanSchema(allowedArchetypes: readonly string[]) {
  const allowedSet = new Set(allowedArchetypes.map((a) => a.trim().toLowerCase()));
  return GraphicOverlayPlanSchema.superRefine((o, ctx) => {
    if (!allowedSet.has(o.archetype.trim().toLowerCase())) {
      ctx.addIssue({
        code: "custom",
        message: `"${o.archetype}" is not one of this client's approved archetypes: ${allowedArchetypes.join(", ")}`,
        path: ["archetype"],
      });
    }
  });
}

/** Validates every overlay's `archetype` against the client's approved repertoire, returning one human-readable violation per invalid overlay (empty when the plan is clean). */
export function validateGraphicsPlanArchetypes(plan: GraphicsPlanOutput, allowedArchetypes: readonly string[]): string[] {
  const schema = createGraphicOverlayPlanSchema(allowedArchetypes);
  const violations: string[] = [];
  for (const overlay of plan.overlays) {
    const result = schema.safeParse(overlay);
    if (!result.success) {
      violations.push(result.error.issues[0]?.message ?? `"${overlay.archetype}" is not an approved archetype`);
    }
  }
  return violations;
}

export interface GraphicsPlanValidationContext {
  approvedArchetypes: readonly string[];
  /** `file` values of the client's `library/index.json` — empty when they have no asset library. */
  libraryFiles: readonly string[];
  /** Whether `image.generate` is registered and configured on this deployment. */
  plateGenerationAvailable: boolean;
}

/**
 * Every mechanical check a plan can fail BEFORE a render cycle is spent on
 * it, in one place: the closed archetype vocabulary (above), a burst that
 * names no stills or stills the library does not hold, and a plate on a
 * deployment that cannot generate one. One human-readable violation per
 * defect, fed back into the same remedy loop as a gate failure — the agent
 * fixes exactly that and keeps the rest of the plan.
 */
export function validateGraphicsPlan(plan: GraphicsPlanOutput, ctx: GraphicsPlanValidationContext): string[] {
  const violations = validateGraphicsPlanArchetypes(plan, ctx.approvedArchetypes);
  const library = new Set(ctx.libraryFiles);
  plan.cutaways.forEach((c, i) => {
    const tag = `cutaway[${i}] ("${c.phrase}")`;
    if (c.kind === "burst") {
      if (!c.stills || c.stills.length === 0) {
        violations.push(
          library.size === 0
            ? `${tag} is a burst, but this client has no asset library — a burst is 3-6 real photos from assetLibrary, so plan a plate here (or nothing) instead`
            : `${tag} is a burst but names no stills — pick 3-6 \`file\` values verbatim from assetLibrary`,
        );
      } else {
        const unknown = c.stills.filter((s) => !library.has(s));
        if (unknown.length > 0) violations.push(`${tag} names stills that are not in this client's asset library: ${unknown.join(", ")}`);
      }
    } else if (!ctx.plateGenerationAvailable) {
      violations.push(`${tag} is a plate, but this deployment cannot generate plates (image.generate is not configured) — use a burst from assetLibrary or drop it`);
    }
  });
  return violations;
}

/**
 * What one edited short may cost, all in.
 *
 * This agent had NO cost bound of any kind until 2026-09-18, alone among
 * D08's three. Clipping and content design have been priced before the first
 * purchase since 2026-09-09; here, `image.generate` was billed once per plate
 * cutaway with the plate COUNT decided by a model, so the only thing between a
 * client and an arbitrary bill was how many cutaways the graphics planner felt
 * like proposing.
 *
 * The same shape as the other two, and the same numbers, because it is the
 * same product line and the owner asked for one answer rather than three:
 * `TARGET` is the plan, `MAX` is the wall.
 */
export const TARGET_RUN_SPEND_USD = 1.8;
export const MAX_RUN_COST_USD = 2;

/**
 * The image SKU a cutaway plate is billed against.
 *
 * Named here rather than inlined at the estimate so the pricing row this
 * agent plans against and the one `image.generate` actually bills against are
 * one edit apart, not one search apart. `unitPriceUsd` throws on a SKU with no
 * `UNIT_PRICING` row, so a rename cannot silently produce a free-looking plan.
 */
export const PLATE_IMAGE_SKU = "gemini-3.1-flash-image";

/** How many plate cutaways a plan may carry once the estimate has had its say. `undefined` means "as planned". */
export interface PlateBudget {
  /** The most plates this run may buy; the rest of the cutaways are dropped from the plan. */
  maxPlates: number | undefined;
  estimatedTotalUsd: number;
  spentSoFarUsd: number;
  /** One line for the reviewer when the budget had to cut something. */
  note?: string;
}

/**
 * How many of a plan's plate cutaways this run can afford.
 *
 * Bursts are free — they are the client's own stills, already on disk — so
 * they are never counted and never cut. Only plates are a purchase, and they
 * come off newest-last: a plan's earlier cutaways are the ones the planner
 * anchored to the strongest phrases, so dropping from the end costs the least.
 *
 * Returns `maxPlates: undefined` on the normal path, which means "buy them
 * all" and is distinct from `0`.
 */
export function planPlateBudget(input: { plateCount: number; spentSoFarUsd: number; platePriceUsd: number; targetUsd: number; maxUsd: number }): PlateBudget {
  const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
  const full = round(input.spentSoFarUsd + input.plateCount * input.platePriceUsd);
  if (full <= input.targetUsd || input.plateCount === 0) {
    return { maxPlates: undefined, estimatedTotalUsd: full, spentSoFarUsd: round(input.spentSoFarUsd) };
  }
  // Against the WALL, not the target, for the reason the other two agents give:
  // the gap between them exists so an ambitious short can spend it rather than
  // be trimmed into an ordinary one.
  const affordable = Math.max(0, Math.floor((input.maxUsd - input.spentSoFarUsd) / input.platePriceUsd));
  if (affordable >= input.plateCount) {
    return { maxPlates: undefined, estimatedTotalUsd: full, spentSoFarUsd: round(input.spentSoFarUsd) };
  }
  return {
    maxPlates: affordable,
    estimatedTotalUsd: round(input.spentSoFarUsd + affordable * input.platePriceUsd),
    spentSoFarUsd: round(input.spentSoFarUsd),
    note:
      `the plan asked for ${input.plateCount} generated plate(s) at $${input.platePriceUsd.toFixed(3)} each, which prices this run at ` +
      `$${full.toFixed(2)} against a $${input.maxUsd.toFixed(2)} ceiling; ${input.plateCount - affordable} were dropped and the short keeps the ` +
      `${affordable} strongest plus every burst from the client's own library`,
  };
}

/**
 * The plan with every item that failed {@link validateGraphicsPlan} removed.
 *
 * The deterministic floor under the plan loop (2026-09-18, the owner's
 * always-deliver rule). Two remedy attempts that still produce an unapproved
 * archetype, a burst naming stills the client does not own, or a plate a
 * deployment cannot generate used to end the run — throwing away the
 * transcript, the cut, the grade, the base render and every overlay in the
 * same plan that WAS legal.
 *
 * Dropping is the only honest repair for these three: the closed archetype
 * vocabulary is the client's own sign-off, a burst must be built from photos
 * they actually hold, and a plate nothing can generate is a file that will not
 * exist at render time. None of them can be rewritten into legality by code
 * without inventing a design decision, and substituting a different archetype
 * would put a graphic on screen that no human approved. So the item goes, the
 * rest of the plan builds, and the reviewer is told how many went.
 *
 * Re-validates rather than filtering on the caller's violation strings: a
 * violation message names an item in prose, and matching prose back to an
 * index is how the wrong overlay gets deleted.
 */
export function dropViolatingItems(plan: GraphicsPlanOutput, ctx: GraphicsPlanValidationContext): GraphicsPlanOutput {
  const archetypeSchema = createGraphicOverlayPlanSchema(ctx.approvedArchetypes);
  const library = new Set(ctx.libraryFiles);
  return {
    ...plan,
    overlays: plan.overlays.filter((overlay) => archetypeSchema.safeParse(overlay).success),
    cutaways: plan.cutaways.filter((c) => {
      if (c.kind === "burst") return (c.stills ?? []).length > 0 && c.stills!.every((s) => library.has(s));
      return ctx.plateGenerationAvailable;
    }),
  };
}

/** One entry of a client's `library/index.json` (`<profile dir>/library/index.json`): a cleared, brand-treated real still and what it shows. */
export const AssetLibraryStillSchema = z.object({
  /** Relative to the profile's directory, e.g. `library/openai-logo.png`. This exact string is what a plan's `stills[]` must carry. */
  file: z.string().min(1),
  /** What the still shows, in the words a transcript would use — the RELEVANCE LAW's matching key. */
  subjects: z.array(z.string().min(1)).min(1),
  credit: z.string().optional(),
});
export type AssetLibraryStill = z.infer<typeof AssetLibraryStillSchema>;
export const AssetLibraryIndexSchema = z.object({ stills: z.array(AssetLibraryStillSchema).default([]) }).passthrough();

export interface BrandedShortsWorkflowResult {
  outputPath: string;
  durationSeconds: number | null;
  deliverableId: string;
  overlayCount: number;
  cutawayCount: number;
  contentCutsDeclared: number;
  graphicsAttempts: number;
  /** Non-fatal advisories carried forward from `build_short.py`'s stdout (e.g. caption-density) — surfaced here, never silently dropped (P0#3 audit finding). */
  renderWarnings: string[];
  /** SCRUM-242 (T-A10) — present only when this run's branding-guidelines context doc was absent; a human reviewer must see this, not merely a system that fetched it. */
  contextGrounding?: DegradedContextGroundingMarker;
  /**
   * What the approved round had to adapt around on its way to a video, and the
   * reviewer's own verdict when it was not an approval.
   *
   * The honest half of the owner's always-deliver rule (2026-09-17): a run that
   * repairs silently is worse than one that holds, because nothing downstream
   * can tell a clean short from a salvaged one. Absent, never empty, on a clean
   * run - a marker attached unconditionally is the same failure in reverse.
   */
  contentRepairs?: ContentRepair[];
}
