import { z } from "zod";

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

/** The client-config slice step 00 reads: intake for this run, plus the locked brand style (SKILL.md step 0). */
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
}
