import type { TemplateDefinition, TemplateQuery, TemplateStore } from "./types.js";

/**
 * Layers a persistent store ON TOP of the bundled floor.
 *
 * The ordering rule is the whole point: `list` returns every row from every
 * layer, and `resolveBest` then picks one template per archetype by
 * `qualityScore`. So a curated or promoted AI template only displaces the
 * bundled one when its score says it should, and the bundled one is always
 * still there to fall back to.
 *
 * A LATER store failing is absorbed, not propagated. If Firestore is
 * unreachable the run renders from the bundled files with less variety
 * instead of failing — the registry must never be able to take slide
 * rendering down, which is the same reasoning that keeps the keyless image
 * providers unconditional in `karos-media`.
 */
export function createCompositeTemplateStore(layers: readonly TemplateStore[]): TemplateStore {
  if (layers.length === 0) throw new Error("createCompositeTemplateStore: at least one layer is required");
  /** Writes go to the last (most persistent) layer that accepts them. */
  const writable = layers[layers.length - 1]!;

  return {
    name: `composite(${layers.map((l) => l.name).join("+")})`,

    async list(query?: TemplateQuery) {
      const all: TemplateDefinition[] = [];
      for (const layer of layers) {
        try {
          all.push(...(await layer.list(query)));
        } catch (error) {
          // Reported, not fatal. The bundled layer is first, so the run still
          // has a working set even when a remote layer is down.
          console.error(`karos-templates: layer "${layer.name}" failed to list, continuing without it`, error);
        }
      }
      return all;
    },

    async get(id: string) {
      for (const layer of layers) {
        try {
          const found = await layer.get(id);
          if (found) return found;
        } catch (error) {
          console.error(`karos-templates: layer "${layer.name}" failed to get("${id}"), continuing`, error);
        }
      }
      return undefined;
    },

    save(definition) {
      return writable.save(definition);
    },
    recordFeedback(id, entry, qualityDelta) {
      return writable.recordFeedback(id, entry, qualityDelta);
    },
  };
}

/**
 * One winning template per archetype.
 *
 * Ranked by `qualityScore`, then by a client-scoped row beating a global one
 * at equal score (a client that has bothered to author its own template
 * means it), then by id for a stable, deterministic tie-break — a registry
 * that returned a different winner between two runs of the same input would
 * make a rendering difference impossible to attribute.
 */
export function resolveBest(definitions: readonly TemplateDefinition[]): Map<string, TemplateDefinition> {
  const best = new Map<string, TemplateDefinition>();
  for (const candidate of definitions) {
    if (!candidate.enabled) continue;
    const incumbent = best.get(candidate.archetypeId);
    if (incumbent === undefined || beats(candidate, incumbent)) best.set(candidate.archetypeId, candidate);
  }
  return best;
}

function beats(candidate: TemplateDefinition, incumbent: TemplateDefinition): boolean {
  if (candidate.qualityScore !== incumbent.qualityScore) return candidate.qualityScore > incumbent.qualityScore;
  const candidateScoped = candidate.clientSlug !== undefined;
  const incumbentScoped = incumbent.clientSlug !== undefined;
  if (candidateScoped !== incumbentScoped) return candidateScoped;
  return candidate.id < incumbent.id;
}
