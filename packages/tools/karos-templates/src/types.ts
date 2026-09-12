import { z } from "zod";

/**
 * Where a template came from, which is what decides how much to trust it.
 *
 * `legacy` are the archetypes ported from the `karos-agents` design system:
 * hand-built, reviewed, and the floor every deployment gets for free.
 * `curated` is a human-authored addition. `ai_generated` is one a run
 * produced on the fly and a person has since approved for reuse — it only
 * ever reaches the registry through the promotion path, never directly from
 * a run, because a template nobody looked at is not a template.
 */
export const TemplateSourceSchema = z.enum(["legacy", "curated", "ai_generated"]);
export type TemplateSource = z.infer<typeof TemplateSourceSchema>;

/**
 * Whether the layout consumes a photograph.
 *
 * Load-bearing rather than descriptive: the calling agent asks the registry
 * which archetypes are typographic so it can skip image sourcing for those
 * slides entirely (see instagram-agent's `photoSlideNs`). Getting this wrong
 * costs a billed image search whose result is discarded.
 */
export const TemplateLayoutTypeSchema = z.enum(["photo", "typographic"]);
export type TemplateLayoutType = z.infer<typeof TemplateLayoutTypeSchema>;

/**
 * What justified a generated template, recorded on the row itself.
 *
 * Written by the per-client Template Studio (instagram-agent item N): the
 * measured format the design was derived from, the accounts and posts that
 * evidence came from, and — load-bearing — WHICH ENGAGEMENT SIGNALS WERE
 * AVAILABLE AND WHICH WERE NOT.
 *
 * `normalisedScore` is optional while `signalsAbsent` is required, and that
 * asymmetry is the whole point: `research.socialHistory` returns
 * `engagement { likes?, comments?, views? }` and only for x/instagram/reddit/
 * tiktok, so a ranking over it is frequently a ranking with a hole in it. A
 * schema that made the score required would force every caller to produce a
 * number, and the only way to produce a number you were not given is to
 * invent one. A row with no score and a named absence is an honest row; a row
 * with an invented score is a lie that outlives the run that told it.
 */
export const TemplateDerivedFromSchema = z.object({
  /** The ranker's own label for the format ("stat-led cover", "numbered listicle") — never a claim about the platform's taxonomy. */
  formatLabel: z.string().min(1),
  accounts: z.array(z.string()).default([]),
  postCount: z.number().int().nonnegative(),
  /** Per-account z-normalised engagement, averaged across accounts. ABSENT when no numeric field existed anywhere. */
  normalisedScore: z.number().optional(),
  signalsAvailable: z.array(z.string()).default([]),
  /** Named, not counted: "views absent for 4 of 6 accounts". */
  signalsAbsent: z.array(z.string()).default([]),
  exampleUrls: z.array(z.string()).max(6).default([]),
  why: z.string().min(1).max(400),
});
export type TemplateDerivedFrom = z.infer<typeof TemplateDerivedFromSchema>;

/**
 * Which slide role a template is JUDGED at — the interest-floor role
 * (instagram-agent item L), not a routing key.
 *
 * A cover and a closer are the grid thumbnail and the save moment, so they
 * must carry imagery or a device; an interior slide is allowed to be one
 * quiet all-type turn. The role travels with the row because a stored
 * template is judged again on every render, and re-deriving it from the
 * archetype id at each call site is how two call sites end up disagreeing.
 */
export const TemplateRoleSchema = z.enum(["cover", "interior", "closer"]);
export type TemplateRole = z.infer<typeof TemplateRoleSchema>;

/**
 * One slide template, stored rather than compiled in.
 *
 * ## Why `htmlTemplate` and `cssStyles` are separate columns
 *
 * They are concatenated back into one document at materialization time, so
 * splitting them buys nothing at render. It buys everything at authoring
 * time: the five ported archetypes each duplicate an identical ~20-line
 * design-token block, because `publish.renderCarousel` reads one
 * self-contained file per slide and has no include mechanism. With the CSS
 * as its own field a shared token sheet can be composed in front of each
 * template's own rules, which is the only way this library grows past a
 * handful of files without the tokens drifting between them.
 */
export const TemplateDefinitionSchema = z.object({
  /**
   * Unique id for this row. Distinct from `archetypeId`: several templates
   * can implement the same archetype (a client-specific `stat_callout`, an
   * AI-generated variant), and `quality_score` is what picks between them.
   */
  id: z.string().min(1),
  /** Which slide archetype this implements, e.g. `stat_callout`. Matches the calling agent's own layout enum. */
  archetypeId: z.string().min(1),
  name: z.string().min(1),
  layoutType: TemplateLayoutTypeSchema,
  /** The HTML, with `{{slot}}` / `{{html:slot}}` / `{{image:slot}}` placeholders. */
  htmlTemplate: z.string().min(1),
  /** Rules injected into the document's own `<style>` at materialization. May be empty for a fully self-contained `htmlTemplate`. */
  cssStyles: z.string().default(""),
  /**
   * The slot names this template actually consumes.
   *
   * Recorded because the caller decides whether a slide's content can fill a
   * template BEFORE rendering it. Without this the only way to discover a
   * template wanted `figure` was to render it and find a hole.
   */
  supportedFields: z.array(z.string().min(1)).default([]),
  /**
   * 0 to 100. Ranks two templates implementing the same archetype; the
   * highest wins. Seeded per `source` (see `DEFAULT_QUALITY_BY_SOURCE`) and
   * moved by human feedback, so an AI-generated template that people keep
   * approving can eventually outrank a legacy one.
   */
  qualityScore: z.number().min(0).max(100).default(50),
  source: TemplateSourceSchema,
  /**
   * Scopes the template to one client. Absent means available to every
   * client, which is what a promoted template becomes.
   */
  clientSlug: z.string().min(1).optional(),
  /**
   * Set false to retire a template without deleting its history.
   *
   * Also the APPROVAL mechanism for a Template Studio row (item N): a
   * generated template is stored `enabled: false`, which `resolveBest`
   * already skips, so until a human approves it in the portal the bundled
   * set is used — with no new filter, no new field and no change to
   * `materializeTemplates`. The row still exists for the portal to show,
   * which a "don't store it yet" design could not offer.
   */
  enabled: z.boolean().default(true),
  /**
   * What measured format justified this design, for a generated row.
   *
   * Additive and optional: every bundled, curated and previously promoted
   * row parses byte-identically without it.
   */
  derivedFrom: TemplateDerivedFromSchema.optional(),
  /** The interest-floor role this template is judged at. Absent on rows that predate the studio. */
  role: TemplateRoleSchema.optional(),
  /** Epoch millis, matching the rest of this codebase's timestamp convention. */
  createdAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
  /**
   * Free-text notes people left about this design, newest last.
   *
   * Kept on the template rather than only on the run that used it: the point
   * of the flywheel is that the NEXT run benefits, and a note attached only
   * to a finished job is invisible to it.
   */
  feedback: z
    .array(
      z.object({
        at: z.number().int().nonnegative(),
        actor: z.string().min(1),
        /** Whether the reviewer approved the design or asked for changes. */
        verdict: z.enum(["approved", "revise"]),
        note: z.string().min(1),
      }),
    )
    .default([]),
});
export type TemplateDefinition = z.infer<typeof TemplateDefinitionSchema>;
export type TemplateDefinitionInput = z.input<typeof TemplateDefinitionSchema>;

/**
 * Opening `qualityScore` per source.
 *
 * `legacy` sits above `curated` deliberately, and it is not a claim that
 * hand-porting beats hand-authoring. It is that the ported set is the only
 * one whose rendering has actually been verified end to end; a newly
 * authored template is unproven until somebody has looked at a render of it.
 * `ai_generated` starts lowest for the same reason, and climbs on approvals.
 */
export const DEFAULT_QUALITY_BY_SOURCE: Record<TemplateSource, number> = {
  legacy: 70,
  curated: 60,
  ai_generated: 40,
};

/**
 * The opening `qualityScore` for a Template Studio row — a per-client
 * template generated at setup, validated by the eight-gate battery.
 *
 * **65, and it must stay strictly below the bundled floor of 70.** Studio
 * rows reuse the ROUTABLE archetype ids (`cover`, `closer`, `stat_callout`,
 * …) rather than inventing new ones, because `templateForLayout` maps only
 * the caller's fixed layout enum to filenames and a new id is a routing dead
 * end nothing can pick. Reusing the ids is what makes a studio row
 * pickable — and it also puts it head-to-head with the bundled row of the
 * same id inside `resolveBest`. At 65 a per-client generated design never
 * silently displaces a design whose rendering has been verified across the
 * whole fleet; a human approval (`enabled`) plus `QUALITY_DELTA.approved`
 * reviews are how it earns the right to.
 *
 * Above `DEFAULT_QUALITY_BY_SOURCE.ai_generated` (40) for an equally precise
 * reason: 40 prices an UNVALIDATED fragment a run invented mid-draft, while a
 * studio row has already passed a real Chromium render, the interest floor
 * with a calibration margin, contrast, and an RTL/script-font render where
 * the client's language needs one.
 *
 * 70 would be actively wrong rather than merely generous: `beats()` awards an
 * equal score to the `clientSlug`-scoped row, so a studio row at 70 would
 * beat the bundled row it ties with and the approval gate would be
 * decorative.
 */
export const DEFAULT_QUALITY_STUDIO = 65;

export interface TemplateQuery {
  /** Only templates for this client, plus every unscoped (global) one. */
  clientSlug?: string;
  /** Restrict to these archetypes. Omit for all. */
  archetypeIds?: readonly string[];
  /** Include retired templates. Defaults to false. */
  includeDisabled?: boolean;
}

/**
 * The storage seam.
 *
 * One interface, three implementations (bundled-on-disk, Firestore, memory),
 * for the same reason `ScraperProvider` exists: this engine has twice shipped
 * a hardcoded backend and then discovered the hard way that the backend was
 * the single point of failure. A registry that cannot fall back to the
 * bundled files would make every deployment's slide rendering depend on
 * Firestore being reachable.
 */
export interface TemplateStore {
  readonly name: string;
  list(query?: TemplateQuery): Promise<TemplateDefinition[]>;
  get(id: string): Promise<TemplateDefinition | undefined>;
  /** Upserts by `id`. The promotion path's only writer. */
  save(definition: TemplateDefinition): Promise<void>;
  /** Appends a feedback entry and applies its quality delta. Separate from `save` so a reviewer's note cannot silently rewrite the markup. */
  recordFeedback(id: string, entry: TemplateDefinition["feedback"][number], qualityDelta: number): Promise<void>;
}

/** Thrown for a store-side failure the caller should surface as `tooling_error`. */
export class TemplateStoreError extends Error {}
