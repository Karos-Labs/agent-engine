/**
 * Publishes per-client CURATED template sets
 * (`agents/instagram-agent/assets/templates/clients/<slug>/` — see that
 * directory's README.md for the authoring contract) into the Firestore
 * template registry, as `source: "curated"` rows scoped to their client.
 *
 * WHY THE SCORE IS EXPLICIT AND ABOVE THE LEGACY FLOOR: `resolveBest`
 * compares `qualityScore` FIRST and uses client scope only to tie-break, so
 * a curated row left at `DEFAULT_QUALITY_BY_SOURCE.curated` (60) can never
 * beat the bundled floor's 70 — it would be seeded, listed, and silently
 * never chosen. meta.json therefore carries the score (default 75), and this
 * script writes rows DIRECTLY via the store's `save` rather than through
 * `promoteTemplate`: that path's below-the-floor opening score is a guard
 * for UNPROVEN AI generations, not for a hand-authored set a human is
 * seeding on purpose.
 *
 * Every row is validated LOUDLY here — `TemplateDefinitionSchema.parse` plus
 * the same `assertSafeMarkup` scan the promotion path runs — because the
 * Firestore store's read side silently SKIPS malformed rows: a bad row that
 * got written would not error anywhere, it would just quietly not exist.
 *
 * Dry-run by default; `--apply` writes. Run with (from the repo root):
 *   GOOGLE_CLOUD_PROJECT=karoscmo FIRESTORE_DATABASE_ID=prep npx tsx scripts/seed-client-templates.ts --apply
 *
 * Credentials: Application Default Credentials, same as publish-prompts.ts.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  TemplateDefinitionSchema,
  createFirestoreTemplateStore,
  extractSupportedFields,
  type FirestoreLike,
  type TemplateDefinition,
} from "@agent-engine/tool-karos-templates";

// scripts/*.ts compiles as CommonJS under the root tsconfig — see setup-local.ts's own note.
const REPO_ROOT = path.resolve(__dirname, "..");
const CLIENTS_DIR = path.join(REPO_ROOT, "agents", "instagram-agent", "assets", "templates", "clients");

const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const ok = (msg: string) => console.log(`  ${GREEN}✓${RESET} ${msg}`);

/** The default a curated client set seeds at — above the legacy floor (70), see this file's header. */
const CURATED_SEED_SCORE = 75;

interface ClientMeta {
  qualityScore?: number;
  templates: Record<string, { name: string; layoutType: "photo" | "typographic"; qualityScore?: number }>;
}

async function withRetry<T>(label: string, attempt: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastError = err;
      if (i < attempts) {
        console.warn(`  ${DIM}⚠ ${label}: attempt ${i}/${attempts} failed (${err instanceof Error ? err.message : String(err)}), retrying...${RESET}`);
        await new Promise((r) => setTimeout(r, 500 * i));
      }
    }
  }
  throw lastError;
}

async function collectRows(): Promise<TemplateDefinition[]> {
  let slugs: string[];
  try {
    slugs = (await fs.readdir(CLIENTS_DIR, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const rows: TemplateDefinition[] = [];
  for (const slug of slugs) {
    const dir = path.join(CLIENTS_DIR, slug);
    const metaRaw = await fs.readFile(path.join(dir, "meta.json"), "utf8").catch(() => {
      throw new Error(`seed-client-templates: "${slug}" has no meta.json — every client directory needs one (see clients/README.md)`);
    });
    const meta = JSON.parse(metaRaw) as ClientMeta;

    const htmlFiles = (await fs.readdir(dir)).filter((f) => f.endsWith(".html"));
    if (htmlFiles.length === 0) throw new Error(`seed-client-templates: "${slug}" declares a meta.json but holds no .html templates`);

    for (const file of htmlFiles) {
      const archetypeId = file.replace(/\.html$/, "");
      const entry = meta.templates[archetypeId];
      // Refused, never defaulted: layoutType decides whether image sourcing
      // runs for a slide, and guessing it costs a billed search or an empty hero.
      if (!entry) throw new Error(`seed-client-templates: "${slug}/${file}" has no meta.json entry — name and layoutType are required`);

      const htmlTemplate = await fs.readFile(path.join(dir, file), "utf8");
      const now = Date.now();
      // Loud validation: the Firestore store's read side silently skips a
      // malformed row, so this parse is the only place a mistake can surface.
      const row = TemplateDefinitionSchema.parse({
        id: `curated__${slug}__${archetypeId}`,
        archetypeId,
        name: entry.name,
        layoutType: entry.layoutType,
        htmlTemplate,
        cssStyles: "",
        supportedFields: extractSupportedFields(htmlTemplate),
        qualityScore: entry.qualityScore ?? meta.qualityScore ?? CURATED_SEED_SCORE,
        source: "curated",
        clientSlug: slug,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });

      // The same script/style/handler scan the promotion path runs. A curated
      // file is a full document, so <style> is legitimate here — scan the
      // BODY the way materialization serves it, with the document's own
      // style block lifted out first.
      const styleBlocks = [...htmlTemplate.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!).join("\n");
      const bodyWithoutStyles = htmlTemplate.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
      if (/<\/?\s*(script|iframe|object|embed|form)\b/i.test(bodyWithoutStyles)) {
        throw new Error(`seed-client-templates: "${slug}/${file}" contains a script/resource-loading tag — refused`);
      }
      if (/\bon\w+\s*=/i.test(bodyWithoutStyles) || /javascript:/i.test(styleBlocks + bodyWithoutStyles)) {
        throw new Error(`seed-client-templates: "${slug}/${file}" contains an event handler or javascript: URL — refused`);
      }

      rows.push(row);
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const rows = await collectRows();
  if (rows.length === 0) {
    console.log("No client template directories found under assets/templates/clients/ — nothing to seed.");
    return;
  }

  for (const row of rows) {
    ok(`${row.id} (${row.layoutType}, score ${row.qualityScore}, fields: ${row.supportedFields.join(", ") || "none"})`);
  }

  if (!apply) {
    console.log(`\n${DIM}  DRY RUN — ${rows.length} validated row(s), nothing written. Pass --apply to publish.${RESET}`);
    return;
  }

  const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
  if (!project) throw new Error("seed-client-templates: GOOGLE_CLOUD_PROJECT (or GCLOUD_PROJECT) must be set");
  const databaseId = process.env.FIRESTORE_DATABASE_ID ?? "(default)";
  const app = initializeApp({ credential: applicationDefault(), projectId: project });
  const db = getFirestore(app, databaseId);
  const store = createFirestoreTemplateStore(db as unknown as FirestoreLike);

  for (const row of rows) {
    await withRetry(row.id, () => store.save(row));
  }
  console.log(`\n${DIM}  ${rows.length} curated template row(s) written to project "${project}" database "${databaseId}".${RESET}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
