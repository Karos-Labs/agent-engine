import { TemplateDefinitionSchema, TemplateStoreError, type TemplateDefinition, type TemplateQuery, type TemplateStore } from "./types.js";

/** Shared by every store: client-scoped rows plus global ones, honouring `includeDisabled`. */
export function matchesQuery(definition: TemplateDefinition, query: TemplateQuery | undefined): boolean {
  if (!query) return definition.enabled;
  if (!query.includeDisabled && !definition.enabled) return false;
  // A client-scoped template is invisible to other clients; an unscoped one is
  // visible to all. A query naming no client sees only the unscoped ones,
  // which is the right default for "what does this engine ship with".
  if (definition.clientSlug !== undefined && definition.clientSlug !== query.clientSlug) return false;
  if (query.archetypeIds && !query.archetypeIds.includes(definition.archetypeId)) return false;
  return true;
}

/**
 * In-process store. Tests, local development, and the composite's cache of a
 * bundled seed.
 *
 * Genuinely correct for a single-process run and genuinely wrong for Cloud
 * Run, where each request may land on a different instance — the same
 * distinction `MemoryDurableStepStore` documents.
 */
export class MemoryTemplateStore implements TemplateStore {
  readonly name = "memory";
  private readonly rows = new Map<string, TemplateDefinition>();

  constructor(seed: readonly TemplateDefinition[] = []) {
    for (const row of seed) this.rows.set(row.id, row);
  }

  async list(query?: TemplateQuery): Promise<TemplateDefinition[]> {
    return [...this.rows.values()].filter((r) => matchesQuery(r, query));
  }

  async get(id: string): Promise<TemplateDefinition | undefined> {
    return this.rows.get(id);
  }

  async save(definition: TemplateDefinition): Promise<void> {
    this.rows.set(definition.id, TemplateDefinitionSchema.parse(definition));
  }

  async recordFeedback(
    id: string,
    entry: TemplateDefinition["feedback"][number],
    qualityDelta: number,
  ): Promise<void> {
    const existing = this.rows.get(id);
    if (!existing) throw new TemplateStoreError(`no template with id "${id}"`);
    this.rows.set(id, {
      ...existing,
      feedback: [...existing.feedback, entry],
      // Clamped, so a run of approvals cannot push a template past the top of
      // the scale and make every later comparison meaningless.
      qualityScore: Math.max(0, Math.min(100, existing.qualityScore + qualityDelta)),
      updatedAt: entry.at,
    });
  }
}
