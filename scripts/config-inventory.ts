/**
 * Configuration inventory (AU49 / SCRUM-332).
 *
 * Emits three sets and the deltas between them:
 *
 *   READ BY CODE      — every env var the source actually reads
 *   WIRED AT DEPLOY   — per service, because deploy-http and deploy-worker are
 *                       different surfaces with different variables
 *   DOCUMENTED        — what .env.example tells a person exists
 *
 * Run it:
 *   npx tsx scripts/config-inventory.ts            # full report
 *   npx tsx scripts/config-inventory.ts --check    # CI mode, exit 1 on a hard delta
 *   npx tsx scripts/config-inventory.ts --json     # machine-readable
 *
 * ## Why this is not a grep
 *
 * Variables are read four ways, and only the first is greppable:
 *
 *   1. `process.env.X` / `process.env["X"]`
 *   2. `env.X` / `env["X"]` inside a helper taking an env bag
 *   3. `readEnv(env, "X", "Y")` — a fallback chain
 *   4. the NAME PASSED AS A STRING to a `*FromEnv` factory, e.g.
 *      `createArtifactStoreFromEnv("GCS_MEDIA_BUCKET", …)` — the variable
 *      never appears next to the word `env` at all
 *
 * A naive grep reports eleven variables as "wired but never read":
 * ANTHROPIC_VERTEX_PROJECT_ID, CLOUD_ML_REGION, GCS_ARTIFACTS_BUCKET,
 * GCS_MEDIA_BUCKET, GCS_WORKSPACE_BUCKET, LANDING_HOSTING_PROJECT,
 * LANDING_HOSTING_SITE_PREFIX, PROMPT_STORE_DRIVER, PUBSUB_PROJECT_ID,
 * QUEUE_PROVIDER, QUEUE_SUBSCRIPTION_RUN_JOBS.
 *
 * ALL ELEVEN ARE FALSE POSITIVES. Deleting any of them takes production down.
 * They are pinned below as `KNOWN_FALSE_POSITIVES` and asserted to be absent
 * from the wired-but-unread delta on every run — if this script ever reports
 * one of them, the script is broken, not the config.
 *
 * ## What it will never do
 *
 * Recommend a deletion. Wired-but-unread WARNS and never fails, because the
 * indirection above means absence of evidence is not evidence of absence. A
 * variable is removed by a person who checked, not on this script's say-so.
 */
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { catalogueVariables } from "@agent-engine/core";

// `__dirname`, not `import.meta`: tsx runs this as CommonJS (the root package
// has no "type": "module"), and `import.meta` fails the repo-wide typecheck
// here. Same convention, and the same reason, as scripts/setup-local.ts.
const REPO_ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOTS = ["packages", "apps", "agents", "scripts", "evals"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "assets"]);

/**
 * The regression test this script must pass. Every one of these is read
 * INDIRECTLY and would be reported as dead by naive tooling.
 */
const KNOWN_FALSE_POSITIVES = [
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "GCS_ARTIFACTS_BUCKET",
  "GCS_MEDIA_BUCKET",
  "GCS_WORKSPACE_BUCKET",
  "LANDING_HOSTING_PROJECT",
  "LANDING_HOSTING_SITE_PREFIX",
  "PROMPT_STORE_DRIVER",
  "PUBSUB_PROJECT_ID",
  "QUEUE_PROVIDER",
  "QUEUE_SUBSCRIPTION_RUN_JOBS",
] as const;

/**
 * Not application configuration: platform variables the runtime provides, and
 * names that exist only to drive a test. Filtering these is not hiding them —
 * documenting `HOME` in .env.example would be noise that trains people to skim.
 */
const NOT_APP_CONFIG = new Set([
  "HOME",
  "TMPDIR",
  "PATH",
  "LANG",
  "PORT",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NODE_ENV",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "PLAYWRIGHT_BROWSERS_PATH",
  "SOME_SECRET_FOR_TEST",
  "SCRAPPYCOCO_LIVE_TEST",
  "KAROS_SANDBOX_SCRATCH",
  "GCLOUD_PROJECT",
]);

/**
 * Families whose members are constructed at runtime from a step or model id
 * (`MODEL_STEP_<ID>_VENDOR`, `VERTEX_REGION_<MODEL>`). Individual members can
 * never be enumerated statically, so they are reported as a family rather than
 * as undocumented names.
 */
const DYNAMIC_PREFIXES = ["MODEL_STEP_", "VERTEX_REGION_", "GEMINI_REGION_", "MODEL_GARDEN_REGION_", "APIFY_ACTOR_"];

const isDynamic = (name: string): boolean => DYNAMIC_PREFIXES.some((p) => name.startsWith(p));

/**
 * Every file is read through this.
 *
 * On a Windows checkout these files are CRLF, and the newline-anchored step
 * splitter below matched nothing — the report cheerfully printed "wired at
 * deploy: 0 across 0 service surfaces" instead of failing. A config checker
 * that silently finds nothing is worse than no checker, so normalising is not
 * a tidiness measure.
 */
const normalise = (text: string): string => text.split("\r\n").join("\n");

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.m?ts$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const READ_PATTERNS: RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
  /process\.env\[\s*["']([A-Z][A-Z0-9_]{2,})["']\s*\]/g,
  /\benv\.([A-Z][A-Z0-9_]{2,})/g,
  /\benv\[\s*["']([A-Z][A-Z0-9_]{2,})["']\s*\]/g,
];
/** Pattern 4: the name travels as a string argument into a factory. */
const FACTORY_ARG = /\w*FromEnv\(\s*["']([A-Z][A-Z0-9_]{2,})["']/g;
/**
 * Pattern 3: a fallback chain — every name in the call counts as read.
 *
 * Matches the call by SHAPE (`<identifier>(env, "A", "B", ...)`), not by the
 * literal name `readEnv`. `create-model-router-from-env.ts`'s `readRegion` is
 * a thin wrapper around `readEnv` — `readRegion(env, "GEMINI_VERTEX_LOCATION",
 * "CLOUD_ML_REGION", "VERTEX_AI_LOCATION")` — and a name-literal match missed
 * both `GEMINI_VERTEX_LOCATION` and `MODEL_GARDEN_REGION`, the two names that
 * flow through `readRegion` and nowhere else. Matching the shape instead of
 * the name catches `readRegion` and any future same-shaped wrapper without
 * needing another hardcoded function name.
 */
const READ_ENV_CHAIN = /\b[A-Za-z_$][\w$]*\(\s*env\s*,\s*((?:["'][A-Z][A-Z0-9_]+["']\s*,?\s*)+)\)/g;

export interface Inventory {
  readByCode: Map<string, Set<string>>;
  wiredByService: Map<string, Set<string>>;
  documented: Set<string>;
}

function collectReadByCode(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const add = (name: string, file: string): void => {
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
    if (!found.has(name)) found.set(name, new Set());
    found.get(name)!.add(rel);
  };

  for (const root of SOURCE_ROOTS) {
    for (const file of walk(path.join(REPO_ROOT, root))) {
      const src = normalise(readFileSync(file, "utf8"));
      for (const pattern of READ_PATTERNS) {
        for (const m of src.matchAll(pattern)) add(m[1]!, file);
      }
      for (const m of src.matchAll(FACTORY_ARG)) add(m[1]!, file);
      for (const m of src.matchAll(READ_ENV_CHAIN)) {
        for (const n of m[1]!.matchAll(/["']([A-Z][A-Z0-9_]+)["']/g)) add(n[1]!, file);
      }
    }
  }
  return found;
}

/**
 * Per SERVICE, not per file: `deploy-http` and `deploy-worker` are separate
 * surfaces, and a variable wired to one and not the other is a real difference
 * that a file-level view hides.
 */
function collectWiredByService(): Map<string, Set<string>> {
  const wired = new Map<string, Set<string>>();

  for (const file of ["cloudbuild.yaml", "cloudbuild.promote.yaml"]) {
    const full = path.join(REPO_ROOT, file);
    let src: string;
    try {
      src = normalise(readFileSync(full, "utf8"));
    } catch {
      continue;
    }
    const env = file === "cloudbuild.promote.yaml" ? "prod" : "prep";

    // Split on the deploy step ids so each service's flags are attributed to it.
    for (const match of src.matchAll(/- id: (deploy-[a-z]+)\n([\s\S]*?)(?=\n  - id: |\nimages:|$)/g)) {
      const service = `${env}/${match[1]!}`;
      const body = match[2]!;
      const names = new Set<string>();

      for (const flag of body.matchAll(/--set-env-vars=([^\n]+)/g)) {
        for (const pair of flag[1]!.split(",")) {
          const name = pair.split("=")[0]?.trim();
          if (name && /^[A-Z][A-Z0-9_]+$/.test(name)) names.add(name);
        }
      }
      for (const flag of body.matchAll(/--set-secrets=([^\n]+)/g)) {
        for (const pair of flag[1]!.split(",")) {
          const name = pair.split("=")[0]?.trim();
          if (name && /^[A-Z][A-Z0-9_]+$/.test(name)) names.add(name);
        }
      }
      if (names.size > 0) wired.set(service, names);
    }
  }
  return wired;
}

function collectDocumented(): Set<string> {
  const documented = new Set<string>();
  let src: string;
  try {
    src = normalise(readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8"));
  } catch {
    return documented;
  }
  for (const line of src.split(/\r?\n/)) {
    // Both `NAME=` and `# NAME=` (a documented-but-commented optional var).
    const m = /^#?\s*([A-Z][A-Z0-9_]{2,})=/.exec(line.trim());
    if (m) documented.add(m[1]!);
  }
  return documented;
}

export function buildInventory(): Inventory {
  return { readByCode: collectReadByCode(), wiredByService: collectWiredByService(), documented: collectDocumented() };
}

// ── report ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const JSON_OUT = args.includes("--json");

const inv = buildInventory();
const appConfigRead = [...inv.readByCode.keys()].filter((n) => !NOT_APP_CONFIG.has(n) && !isDynamic(n)).sort();
const allWired = new Set([...inv.wiredByService.values()].flatMap((s) => [...s]));

const readButUndocumented = appConfigRead.filter((n) => !inv.documented.has(n));
const wiredButUnread = [...allWired].filter((n) => !inv.readByCode.has(n) && !isDynamic(n)).sort();
const documentedButUnread = [...inv.documented].filter((n) => !inv.readByCode.has(n) && !isDynamic(n) && !NOT_APP_CONFIG.has(n)).sort();

// Every variable the capability catalogue names must actually be read — a
// catalogue row pointing at a variable nothing reads is a lie in the report
// AU55 exists to make trustworthy.
const catalogueOrphans = catalogueVariables().filter((n) => !inv.readByCode.has(n));

/**
 * The reverse direction, and the one that closes AU55's real gap (AU56).
 *
 * The capability report is only as complete as the hand-written catalogue, so
 * left alone it surfaces exactly the keys somebody remembered to register — and
 * a new credential added without a catalogue row would degrade a capability as
 * silently as before, with a report that now falsely implies coverage.
 *
 * Credential-shaped names are the class that matters: those are what switch a
 * capability off when absent. A tuning knob like IMAGE_GEN_MODEL changes how a
 * capability behaves, not whether it exists, so it is not required here.
 */
const CREDENTIAL_SHAPED = /_(KEY|TOKEN|SECRET)$/;
const inCatalogue = new Set(catalogueVariables());
const credentialsWithoutCapability = appConfigRead.filter((n) => CREDENTIAL_SHAPED.test(n) && !inCatalogue.has(n)).sort();

// THE REGRESSION TEST: the eleven indirect reads must never appear as dead.
const falsePositivesReported = KNOWN_FALSE_POSITIVES.filter((n) => wiredButUnread.includes(n));

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        readByCode: appConfigRead,
        wiredByService: Object.fromEntries([...inv.wiredByService].map(([k, v]) => [k, [...v].sort()])),
        documented: [...inv.documented].sort(),
        deltas: { readButUndocumented, wiredButUnread, documentedButUnread, catalogueOrphans, credentialsWithoutCapability },
      },
      null,
      2,
    ),
  );
} else {
  console.log(`\n=== CONFIG INVENTORY ===\n`);
  console.log(`read by code (application config): ${appConfigRead.length}`);
  console.log(`documented in .env.example:        ${inv.documented.size}`);
  console.log(`wired at deploy:                   ${allWired.size} across ${inv.wiredByService.size} service surfaces\n`);

  console.log(`--- wired per service (deploy-http and deploy-worker differ) ---`);
  for (const [service, names] of [...inv.wiredByService].sort()) {
    console.log(`  ${service.padEnd(24)} ${names.size}`);
  }

  console.log(`\n--- READ BY CODE, NOT DOCUMENTED (${readButUndocumented.length}) — hard failure in --check ---`);
  for (const n of readButUndocumented) {
    const files = [...inv.readByCode.get(n)!].slice(0, 1);
    console.log(`  ${n.padEnd(34)} ${files[0]}`);
  }
  if (readButUndocumented.length === 0) console.log("  (none)");

  console.log(`\n--- WIRED, NOT SEEN AS READ (${wiredButUnread.length}) — WARNING ONLY, never a deletion list ---`);
  for (const n of wiredButUnread) console.log(`  ${n}`);
  if (wiredButUnread.length === 0) console.log("  (none)");

  console.log(`\n--- DOCUMENTED, NOT SEEN AS READ (${documentedButUnread.length}) — warning ---`);
  for (const n of documentedButUnread) console.log(`  ${n}`);
  if (documentedButUnread.length === 0) console.log("  (none)");

  console.log(`\n--- CAPABILITY CATALOGUE ORPHANS (${catalogueOrphans.length}) — hard failure ---`);
  for (const n of catalogueOrphans) console.log(`  ${n} (named by AU55's catalogue but read nowhere)`);
  if (catalogueOrphans.length === 0) console.log("  (none)");

  console.log(`\n--- CREDENTIALS WITH NO CAPABILITY ROW (${credentialsWithoutCapability.length}) — hard failure ---`);
  for (const n of credentialsWithoutCapability) console.log(`  ${n} (read by code, absent from the AU55 catalogue)`);
  if (credentialsWithoutCapability.length === 0) console.log("  (none)");

  console.log(`\n--- SELF-TEST: the eleven known indirect reads ---`);
  console.log(
    falsePositivesReported.length === 0
      ? "  PASS — none reported as dead"
      : `  FAIL — this script is broken, it reported: ${falsePositivesReported.join(", ")}`,
  );
  console.log();
}

if (CHECK) {
  let failed = false;
  if (falsePositivesReported.length > 0) {
    console.error(`config-inventory: SELF-TEST FAILED — reported known-indirect reads as dead: ${falsePositivesReported.join(", ")}`);
    console.error("This means the read-detection lost a pattern. Fix the script; do not touch the config.");
    failed = true;
  }
  if (readButUndocumented.length > 0) {
    console.error(`\nconfig-inventory: ${readButUndocumented.length} variable(s) read by code but absent from .env.example:`);
    for (const n of readButUndocumented) console.error(`  ${n}`);
    console.error("\nDocument each with what it does, whether it is required, and WHAT HAPPENS WHEN IT IS ABSENT.");
    failed = true;
  }
  if (catalogueOrphans.length > 0) {
    console.error(`\nconfig-inventory: capability catalogue names variable(s) nothing reads: ${catalogueOrphans.join(", ")}`);
    failed = true;
  }
  if (credentialsWithoutCapability.length > 0) {
    console.error(`\nconfig-inventory: credential(s) read by code with no capability-catalogue row: ${credentialsWithoutCapability.join(", ")}`);
    console.error("Without a row, an absent key degrades a capability and the report says nothing — the exact failure AU55 exists to end.");
    failed = true;
  }
  process.exit(failed ? 1 : 0);
}
