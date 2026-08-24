import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_QUALITY_BY_SOURCE,
  TemplateDefinitionSchema,
  TemplateStoreError,
  type TemplateDefinition,
  type TemplateQuery,
  type TemplateStore,
} from "./types.js";
import { matchesQuery } from "./memory-store.js";

/**
 * Maps a bundled filename to the archetype it implements, and whether that
 * archetype wants a photograph.
 *
 * Declared rather than inferred from the filename: an archetype's
 * `layoutType` decides whether the calling agent pays for image sourcing on
 * that slide, and deriving something that load-bearing from a string match
 * would make renaming a file a silent behaviour change.
 */
export const BUNDLED_ARCHETYPES: readonly { file: string; archetypeId: string; name: string; photo: boolean }[] = [
  { file: "slide.html", archetypeId: "photo", name: "Photo slide", photo: true },
  { file: "stat-callout.html", archetypeId: "stat_callout", name: "Stat callout", photo: false },
  { file: "quote-card.html", archetypeId: "quote_card", name: "Quote card", photo: false },
  { file: "comparison-card.html", archetypeId: "comparison_card", name: "Comparison card", photo: false },
  { file: "list-takeaway.html", archetypeId: "list_takeaway", name: "List takeaway", photo: false },
  { file: "headline-focus.html", archetypeId: "headline_focus", name: "Headline focus", photo: false },
];

/** Every `{{slot}}`, `{{html:slot}}` and `{{image:slot}}` name a template actually reads. */
export function extractSupportedFields(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/\{\{(?:html:|image:)?([A-Za-z0-9_]+)\}\}/g)) {
    found.add(match[1]!);
  }
  return [...found];
}

/**
 * The on-disk archetype files, read as `source: "legacy"` rows.
 *
 * This is the floor, and it is why the registry can never take the rendering
 * pipeline down with it: whatever Firestore is doing, the files that ship
 * inside the container are always readable. `createTemplateStore` layers a
 * remote store ON TOP of this rather than instead of it.
 *
 * Read-only on purpose. `save`/`recordFeedback` throw rather than silently
 * doing nothing, because a promotion that reported success and then vanished
 * on the next deploy would be worse than one that failed loudly — the
 * container filesystem is not a database and pretending otherwise is how a
 * feedback flywheel quietly stops turning.
 */
export function createBundledTemplateStore(options: { templateDir: string }): TemplateStore {
  let cache: TemplateDefinition[] | undefined;

  async function load(): Promise<TemplateDefinition[]> {
    if (cache) return cache;
    const rows: TemplateDefinition[] = [];
    for (const entry of BUNDLED_ARCHETYPES) {
      let html: string;
      try {
        html = await fs.readFile(path.join(options.templateDir, entry.file), "utf8");
      } catch {
        // A bundled file that is not there is not fatal: a client with a
        // bespoke templateDir legitimately ships only some of them, and the
        // caller degrades per-archetype on what it finds.
        continue;
      }
      rows.push(
        TemplateDefinitionSchema.parse({
          id: `bundled:${entry.archetypeId}`,
          archetypeId: entry.archetypeId,
          name: entry.name,
          layoutType: entry.photo ? "photo" : "typographic",
          htmlTemplate: html,
          // Already inside the file's own <style> block; nothing to compose.
          cssStyles: "",
          supportedFields: extractSupportedFields(html),
          qualityScore: DEFAULT_QUALITY_BY_SOURCE.legacy,
          source: "legacy",
          enabled: true,
        }),
      );
    }
    cache = rows;
    return rows;
  }

  return {
    name: "bundled",
    async list(query?: TemplateQuery) {
      return (await load()).filter((r) => matchesQuery(r, query));
    },
    async get(id: string) {
      return (await load()).find((r) => r.id === id);
    },
    async save() {
      throw new TemplateStoreError("the bundled template store is read-only — promote into a persistent store instead");
    },
    async recordFeedback() {
      throw new TemplateStoreError("the bundled template store is read-only — record feedback against a persistent store instead");
    },
  };
}
