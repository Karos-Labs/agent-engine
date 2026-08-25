import fs from "node:fs/promises";
import path from "node:path";
import { resolveBest } from "./composite-store.js";
import type { TemplateDefinition, TemplateStore } from "./types.js";

/**
 * Every materialized run directory lives under this repo-relative prefix,
 * alongside `.media-cache`. Kept in one place because a deployment that
 * mounts writable scratch space needs to know which directories grow.
 */
export const TEMPLATE_CACHE_PREFIX = ".template-cache";

/** The filename an archetype materializes as. Stable, so a render trace names something recognisable. */
export function templateFileName(archetypeId: string): string {
  return `${archetypeId.replaceAll("_", "-")}.html`;
}

export interface MaterializeResult {
  /** Repo-relative, forward-slashed — pass straight to `publish.renderCarousel`'s `templateDir`. */
  templateDir: string;
  /** `archetypeId` -> the filename written for it, for the caller's own layout routing. */
  files: Record<string, string>;
  /** Archetypes that render no photograph, so the caller can skip image sourcing for those slides. */
  typographicArchetypes: string[];
  /** Which template row won each archetype, for the run record. */
  chosen: Array<{ archetypeId: string; templateId: string; source: string; qualityScore: number }>;
}

/**
 * Approach (a): writes the registry's winning templates into this run's own
 * directory and hands back that directory.
 *
 * ## Why materialize instead of teaching the renderer to take inline HTML
 *
 * `publish.renderCarousel` resolves `templateDir` and every image path
 * through `assertInside`, refusing absolute paths, URL-shaped strings, and
 * anything escaping the repo root. That guard is the reason a bad path there
 * is a tooling failure rather than a silent render of the wrong thing, and it
 * only works because the renderer deals exclusively in repo-relative FILES.
 * Passing template bodies through the tool would mean either weakening that
 * check or growing a second, parallel input path with its own weaker
 * guarantees. Writing files into a bounds-checked run directory keeps exactly
 * one code path and exactly one set of guarantees, and costs a few KB of
 * writes per run.
 *
 * The client's own base template is copied in alongside the registry's rows,
 * because the renderer takes ONE `templateDir` and the photo archetype still
 * routes to whatever file that client configured.
 */
export async function materializeTemplates(options: {
  store: TemplateStore;
  /** Bounds root. The written directory is provably inside it. */
  repoRoot: string;
  runId: string;
  clientSlug: string;
  /** Only these archetypes are written. Omit for every archetype the registry offers. */
  archetypeIds?: readonly string[];
  /**
   * The client's existing template directory and base filename. Copied in
   * verbatim so a client with a bespoke `slide.html` keeps it.
   */
  clientTemplateDir?: string;
  clientTemplateFile?: string;
}): Promise<MaterializeResult> {
  const relDir = `${TEMPLATE_CACHE_PREFIX}/${options.runId}`;
  const absDir = path.resolve(options.repoRoot, relDir);
  const rootResolved = path.resolve(options.repoRoot);
  // Same bounds check the media cache applies, for the same reason: a runId
  // carrying "../" is the case that matters, and it is caught before a write.
  if (absDir !== rootResolved && !absDir.startsWith(rootResolved + path.sep)) {
    throw new Error(`materializeTemplates: resolved template dir escaped repoRoot (runId="${options.runId}")`);
  }
  await fs.mkdir(absDir, { recursive: true });

  const rows = await options.store.list({
    clientSlug: options.clientSlug,
    ...(options.archetypeIds ? { archetypeIds: options.archetypeIds } : {}),
  });
  const best = resolveBest(rows);

  const files: Record<string, string> = {};
  const typographicArchetypes: string[] = [];
  const chosen: MaterializeResult["chosen"] = [];

  for (const [archetypeId, definition] of best) {
    // The client's own base template is copied below rather than written from
    // the registry, so the `photo` archetype is skipped here.
    if (archetypeId === "photo") continue;
    const file = templateFileName(archetypeId);
    await fs.writeFile(path.join(absDir, file), composeDocument(definition), "utf8");
    files[archetypeId] = file;
    if (definition.layoutType === "typographic") typographicArchetypes.push(archetypeId);
    chosen.push({ archetypeId, templateId: definition.id, source: definition.source, qualityScore: definition.qualityScore });
  }

  // The client's base template, carried across so one `templateDir` holds
  // everything the renderer will be asked for.
  if (options.clientTemplateDir && options.clientTemplateFile) {
    const from = path.resolve(options.repoRoot, options.clientTemplateDir, options.clientTemplateFile);
    try {
      await fs.copyFile(from, path.join(absDir, options.clientTemplateFile));
      files["photo"] = options.clientTemplateFile;
    } catch {
      // Absent is survivable and the caller finds out by `files` lacking a
      // `photo` entry. Throwing here would fail a run over a template that
      // the archetypes could have covered for.
    }
  }

  return { templateDir: relDir, files, typographicArchetypes, chosen };
}

/**
 * Folds `cssStyles` into the template's own document.
 *
 * Injected immediately before `</head>` so registry CSS lands after whatever
 * the template's own `<style>` block declared, and therefore wins on
 * specificity ties — which is what makes a shared token sheet able to
 * override a template's built-in defaults rather than being silently ignored.
 *
 * A definition whose `cssStyles` is empty (every bundled row, whose CSS is
 * already inside its file) is returned untouched, so materializing the
 * bundled set is byte-identical to reading it from disk.
 */
export function composeDocument(definition: TemplateDefinition): string {
  if (definition.cssStyles.trim().length === 0) return definition.htmlTemplate;
  const style = `<style>\n${definition.cssStyles}\n</style>`;
  if (definition.htmlTemplate.includes("</head>")) {
    return definition.htmlTemplate.replace("</head>", `${style}\n</head>`);
  }
  // No <head> to target: prepending still gets the rules into the document,
  // which beats dropping them on the floor for a hand-authored fragment.
  return `${style}\n${definition.htmlTemplate}`;
}
