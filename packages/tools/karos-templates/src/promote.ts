import { extractSupportedFields } from "./bundled-store.js";
import {
  DEFAULT_QUALITY_BY_SOURCE,
  TemplateDefinitionSchema,
  TemplateStoreError,
  type TemplateDefinition,
  type TemplateDerivedFrom,
  type TemplateRole,
  type TemplateSource,
  type TemplateStore,
} from "./types.js";

/**
 * How much a single review moves a template's `qualityScore`.
 *
 * Asymmetric on purpose: an approval nudges, a request for changes bites.
 * A design people keep asking to change should fall below the bundled floor
 * (70) quickly enough to stop being chosen, whereas one they like should have
 * to earn its way past a proven template over several runs rather than one.
 */
export const QUALITY_DELTA = { approved: 5, revise: -15 } as const;

export interface PromoteOptions {
  store: TemplateStore;
  /** The archetype this template implements, e.g. `stat_callout`. */
  archetypeId: string;
  name: string;
  htmlTemplate: string;
  cssStyles?: string;
  layoutType: "photo" | "typographic";
  /** `ai_generated` for a template a run produced; `curated` for a hand-authored one. */
  source: Extract<TemplateSource, "ai_generated" | "curated">;
  /** Scope it to one client, or omit to make it available to every client. */
  clientSlug?: string | undefined;
  /** Who approved it, and anything they said about the design. */
  actor: string;
  note?: string | undefined;
  /** Injected so a caller (and a test) controls the timestamp. */
  now: number;
  /** Stable id. Defaults to one derived from archetype + timestamp. */
  id?: string;
  /**
   * Opening score, overriding the per-source default.
   *
   * Exists for the Template Studio (`DEFAULT_QUALITY_STUDIO`), whose rows are
   * validated far more heavily than the mid-run fragment
   * `DEFAULT_QUALITY_BY_SOURCE.ai_generated` prices — and for the auto-
   * promotion path, whose evidence is two clean human ships. Clamped to the
   * 0-100 scale by the schema. Omit and the per-source default stands, so
   * every existing call site is unchanged.
   */
  qualityScore?: number;
  /**
   * Whether the row is immediately eligible for `resolveBest`.
   *
   * Defaults to `true` — the historical behaviour, and correct for a
   * promotion that a human just approved. The studio passes `false`: the row
   * is stored so the portal can show it, and stays out of every render until
   * somebody approves it (see `setTemplateEnabled`).
   */
  enabled?: boolean;
  /** What measured format justified this design (studio rows). */
  derivedFrom?: TemplateDerivedFrom | undefined;
  /** The interest-floor role this template is judged at (studio rows). */
  role?: TemplateRole | undefined;
}

/**
 * Persists a run-generated template into the registry so later runs can use
 * it, across every client unless scoped.
 *
 * The whole flywheel turns on one rule: **a template only arrives here after
 * a person approved it.** A run that invents a layout does not get to enrol
 * its own work — otherwise a single bad generation becomes a permanent
 * fixture that later runs keep picking, and the registry's quality score
 * measures nothing. So this is called from the approval path, never from the
 * rendering path, and it records who approved it alongside the markup.
 *
 * The opening score is `DEFAULT_QUALITY_BY_SOURCE.ai_generated` (40), which
 * sits BELOW the bundled floor (70) even after approval. That is intentional:
 * one person liking one render is evidence, not proof, so a promoted template
 * has to accumulate approvals before it starts displacing a design whose
 * rendering has been verified. It is available immediately for the client it
 * was scoped to, and competes globally only once it has earned the score.
 */
export async function promoteTemplate(options: PromoteOptions): Promise<TemplateDefinition> {
  const id = options.id ?? `${options.source}:${options.archetypeId}:${options.now}`;
  const definition = TemplateDefinitionSchema.parse({
    id,
    archetypeId: options.archetypeId,
    name: options.name,
    layoutType: options.layoutType,
    htmlTemplate: options.htmlTemplate,
    cssStyles: options.cssStyles ?? "",
    supportedFields: extractSupportedFields(options.htmlTemplate + (options.cssStyles ?? "")),
    qualityScore: options.qualityScore ?? DEFAULT_QUALITY_BY_SOURCE[options.source],
    source: options.source,
    ...(options.clientSlug !== undefined ? { clientSlug: options.clientSlug } : {}),
    enabled: options.enabled ?? true,
    ...(options.derivedFrom !== undefined ? { derivedFrom: options.derivedFrom } : {}),
    ...(options.role !== undefined ? { role: options.role } : {}),
    createdAt: options.now,
    updatedAt: options.now,
    // The approval itself is the first feedback entry, so a template can
    // never exist in the registry with no record of who let it in. A studio
    // row's first entry is the generation, not an approval — hence the
    // caller-supplied `note`, and hence `enabled: false` until a human adds
    // the second entry through `setTemplateEnabled`.
    feedback: [
      {
        at: options.now,
        actor: options.actor,
        verdict: "approved" as const,
        note: options.note ?? "approved at review, promoted into the template library",
      },
    ],
  });
  await options.store.save(definition);
  return definition;
}

/**
 * Records a reviewer's verdict on a template already in the registry and
 * moves its score.
 *
 * This is the half that makes the loop a loop: without it every template
 * keeps its opening score forever and `resolveBest` is just a static
 * preference order.
 */
/**
 * Flips a stored template's `enabled` flag and records WHY, as a feedback
 * entry on the same row.
 *
 * This is the approval path for a Template Studio row (item N). The studio
 * stores its templates `enabled: false`; `resolveBest` already skips a
 * disabled candidate, so until this is called the client's runs render on the
 * bundled set while the portal can still show what was generated. The
 * reviewer's existing `templateFeedback` entry (`verdict: "approved",
 * promote: true`) on a studio `templateId` is what calls it — the same
 * mechanism a promotion already rides, not a second one.
 *
 * `qualityDelta: 0` deliberately. Enabling a row is not a judgment about how
 * good the design is relative to its peers: the studio already priced that at
 * `DEFAULT_QUALITY_STUDIO`, and the reviewer's own `approved`/`revise`
 * verdicts move the score through `reviewTemplate` as they always have.
 * Adding a delta here would double-count one human action.
 *
 * **Idempotent.** A row already in the requested state is returned unchanged,
 * with no second feedback entry and no `updatedAt` churn — a resumed run
 * replaying the review step must not stack five identical "approved for use"
 * notes on one template.
 */
export async function setTemplateEnabled(
  store: TemplateStore,
  templateId: string,
  enabled: boolean,
  actor: string,
  note: string,
  now: number,
): Promise<{ changed: boolean; definition: TemplateDefinition }> {
  const existing = await store.get(templateId);
  if (existing === undefined) {
    throw new TemplateStoreError(`setTemplateEnabled: no template with id "${templateId}"`);
  }
  if (existing.enabled === enabled) return { changed: false, definition: existing };

  // The row write first, then the feedback entry: `recordFeedback` is a
  // read-modify-write on the stored row in every implementation, so the
  // order below leaves both facts on one row regardless of which store this
  // is. The reverse order would have the feedback write's own copy of the row
  // overwrite the flag.
  await store.save({ ...existing, enabled, updatedAt: now });
  await store.recordFeedback(
    templateId,
    { at: now, actor, verdict: enabled ? "approved" : "revise", note },
    0,
  );
  return { changed: true, definition: (await store.get(templateId)) ?? { ...existing, enabled, updatedAt: now } };
}

export async function reviewTemplate(options: {
  store: TemplateStore;
  templateId: string;
  actor: string;
  verdict: "approved" | "revise";
  note: string;
  now: number;
}): Promise<void> {
  await options.store.recordFeedback(
    options.templateId,
    { at: options.now, actor: options.actor, verdict: options.verdict, note: options.note },
    QUALITY_DELTA[options.verdict],
  );
}
