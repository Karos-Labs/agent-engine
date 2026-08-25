import { extractSupportedFields } from "./bundled-store.js";
import {
  DEFAULT_QUALITY_BY_SOURCE,
  TemplateDefinitionSchema,
  type TemplateDefinition,
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
    qualityScore: DEFAULT_QUALITY_BY_SOURCE[options.source],
    source: options.source,
    ...(options.clientSlug !== undefined ? { clientSlug: options.clientSlug } : {}),
    enabled: true,
    createdAt: options.now,
    updatedAt: options.now,
    // The approval itself is the first feedback entry, so a template can
    // never exist in the registry with no record of who let it in.
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
