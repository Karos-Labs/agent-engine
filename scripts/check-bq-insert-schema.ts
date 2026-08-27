/**
 * Every field the telemetry insert writes must exist as a column
 * (AU68 — shipped without a Jira ticket).
 *
 * ## Why this is a check and not a comment
 *
 * `agent_runs_bi`'s insert sets `ignoreUnknownValues: true`. That does not
 * merely tolerate drift — it makes drift INVISIBLE: a field the row writes that
 * the table lacks is dropped, the insert reports success, and nothing anywhere
 * says a field went missing.
 *
 * It already happened. `operation`, `jobId`, `stepId` and `source` were added
 * to the insert row in 2026-08, with a doc comment explaining that without them
 * two step rows from one run cannot be told apart, and NONE OF THE FOUR EXISTED
 * IN THE TABLE. Every one was discarded on every insert for months.
 *
 * Both available runtime options are silent. Leaving the flag on drops columns
 * quietly; turning it off makes a mismatch throw into a catch that logs a
 * warning and swallows it, which trades silent column loss for silent ROW loss
 * — telemetry going dark with no signal but absence, and absence is exactly
 * what this codebase has repeatedly failed to notice.
 *
 * So neither: the field list is a STATIC FACT about the source, checkable
 * statically, and this fails the build instead. Same shape as
 * `check-model-pricing.ts` — "the real guard is ordering, schema first" becomes
 * something enforced rather than remembered.
 *
 * ## What it compares
 *
 * The keys of the object literal passed to `table.insert(...)` in
 * `packages/telemetry/src/span-helpers.ts`, against the live table schema in
 * whichever projects are reachable. Parsed from source rather than imported,
 * because importing would require building the package and running its GCP
 * client; the keys are a literal and reading them is exact.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const repoRoot = path.resolve(__dirname, "..");
const SOURCE = path.join(repoRoot, "packages", "telemetry", "src", "span-helpers.ts");

/** The projects whose copy of the table must accept every field. */
const PROJECTS = ["karoscmo-prep", "karoscmo"] as const;
const DATASET = "bi_telemetry";
const TABLE = "agent_runs_bi";

/**
 * The keys of the row literal handed to `table.insert`.
 *
 * Anchored on `await table.insert(` and read to the matching close, so a second
 * insert elsewhere in the file cannot be silently skipped — if the anchor stops
 * matching, this throws rather than returning an empty set. An empty set would
 * pass every comparison below by checking nothing.
 */
export function insertRowFields(source = readFileSync(SOURCE, "utf8")): string[] {
  const anchor = source.indexOf("table.insert(");
  if (anchor === -1) throw new Error("check-bq-insert-schema: could not find `table.insert(` in span-helpers.ts — the anchor moved, so this check is not checking anything");

  const open = source.indexOf("{", anchor);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error("check-bq-insert-schema: could not find the end of the inserted row literal");

  const body = source.slice(open + 1, end);
  // Top-level keys only: `key:` at depth 1 of the row object.
  const fields: string[] = [];
  let nest = 0;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (nest === 0) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(trimmed);
      if (match) fields.push(match[1]!);
    }
    nest += (line.match(/[{[(]/g) ?? []).length - (line.match(/[}\])]/g) ?? []).length;
  }
  return [...new Set(fields)];
}

function tableColumns(project: string): string[] | undefined {
  try {
    // One quoted shell string, not execFileSync with `shell: true` — that form
    // concatenates argv without quoting, so the Authorization header's space
    // splits it and every fetch silently "fails", which this check would then
    // report as UNREACHABLE. Found by running it: 15 fields extracted, both
    // projects unreachable, while the same curl worked by hand.
    const token = execSync("gcloud auth print-access-token", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${DATASET}/tables/${TABLE}`;
    const raw = execSync(`curl -s -H "Authorization: Bearer ${token}" "${url}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = JSON.parse(raw) as { schema?: { fields?: { name: string }[] }; error?: unknown };
    if (!parsed.schema?.fields) return undefined;
    return parsed.schema.fields.map((f) => f.name);
  } catch {
    return undefined;
  }
}

if (require.main === module) {
  const fields = insertRowFields();
  console.log(`--- FIELDS WRITTEN BY THE TELEMETRY INSERT (${fields.length}) ---`);
  console.log(`  ${fields.join(", ")}\n`);

  let failed = false;
  let checked = 0;

  for (const project of PROJECTS) {
    const columns = tableColumns(project);
    if (!columns) {
      // Not a failure: this runs in environments with no GCP credential (a
      // fresh checkout, a contributor's laptop). Reported so an unreachable
      // table can never be mistaken for a passing one.
      console.log(`--- ${project}: UNREACHABLE (no credential, or table absent) — not checked ---`);
      continue;
    }
    checked += 1;
    const missing = fields.filter((f) => !columns.includes(f));
    console.log(`--- ${project}: ${columns.length} columns, ${missing.length} missing ---`);
    for (const name of missing) console.log(`  ${name} — WRITTEN BY THE INSERT, NOT IN THE TABLE. Silently dropped on every insert.`);
    if (missing.length === 0) console.log("  (none)");
    if (missing.length > 0) failed = true;
  }

  if (checked === 0) {
    console.log("\nNo project was reachable — this check confirmed nothing. It is advisory here and authoritative in CI.");
  }

  if (failed) {
    console.error(
      "\ncheck-bq-insert-schema: the telemetry insert writes field(s) the table does not have. " +
        "`ignoreUnknownValues: true` means these are DROPPED SILENTLY and the insert still reports success — " +
        "add the columns to the table FIRST, then land the code. Schema before code, always.",
    );
    process.exit(1);
  }
}
