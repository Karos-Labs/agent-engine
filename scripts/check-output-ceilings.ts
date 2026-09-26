/**
 * Every output ceiling this codebase declares must be one the engine can raise.
 *
 * ## The rule this enforces
 *
 * An agent does not fail on an internal fault. A truncated turn is the most
 * internal fault there is — the model had something to say and ran out of room
 * to say it — and the engine already knows how to fix it: `BaseAgent` catches
 * `OutputLimitExceededError` and re-asks once with more room
 * (`raisedOutputLimit`).
 *
 * That recovery has a hard edge. `raisedOutputLimit` returns `undefined` for a
 * ceiling already at or above `OUTPUT_LIMIT_RETRY_CEILING`, because there is
 * no larger ceiling every served vendor accepts. A step declaring `maxTokens`
 * at or above that number therefore has NO recovery path: its first truncation
 * is its last, and the client gets nothing.
 *
 * Nothing in the repo is over that line today. This check is what keeps it
 * that way — the rule was previously true only by coincidence, stated in a
 * comment nobody's editor reads while they type a bigger number.
 *
 * ## Why a CI check rather than a runtime guard
 *
 * Same reason `check-model-pricing.ts` exists: these are static integer
 * literals in shipping source. Whether a declared ceiling is recoverable is
 * knowable before a deploy, and a runtime throw would arrive after the money
 * was spent and the client's run was already lost.
 *
 * It cannot see a ceiling supplied at run time — `BaseAgent`'s own raised
 * retry passes one, and that one is `raisedOutputLimit`'s output by
 * construction, so it is inside the ceiling by definition.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { OUTPUT_LIMIT_RETRY_CEILING, raisedOutputLimit } from "../packages/core/src/router/adapters/structured-output.js";

const repoRoot = path.resolve(__dirname, "..");

/**
 * `maxTokens: 60_000` and `MAX_TOKENS = 48_000` both declare a ceiling, and a
 * step reaches its own either way — `intel-report-agent` exports the constant
 * and then assigns it. Matching only the property would miss every agent that
 * names its ceiling first, which is the long-form ones, which are exactly the
 * ones near the edge.
 */
const CEILING_DECLARATION = /(?:maxTokens\s*:|[A-Z_]*MAX_TOKENS\s*=)\s*([0-9][0-9_]*)/g;

/** Strips comments, so a number quoted in prose is never read as a declaration. Mirrors `check-model-pricing.ts`. */
function stripComments(source: string): string {
  const block = /\/\*[\s\S]*?\*\//g;
  const line = /(^|[^:])\/\/.*/gm;
  return source.replace(block, " ").replace(line, "$1 ");
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

export interface UnrecoverableCeiling {
  readonly declaredMaxTokens: number;
  readonly sites: readonly string[];
}

/** Every declared ceiling that `raisedOutputLimit` would refuse to raise. */
export function unrecoverableCeilings(): UnrecoverableCeiling[] {
  const sites = new Map<number, string[]>();

  for (const dir of ["packages", "apps", "agents"]) {
    for (const file of sourceFiles(path.join(repoRoot, dir))) {
      const rel = path.relative(repoRoot, file).replace(/\\/g, "/");
      // Tests declare unrecoverable ceilings on purpose — that is how the
      // refusal itself is asserted. `structured-output.ts` defines the bound.
      if (rel.includes("__tests__") || rel.endsWith("adapters/structured-output.ts")) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      for (const match of source.matchAll(CEILING_DECLARATION)) {
        const declared = Number(match[1]!.replace(/_/g, ""));
        if (!Number.isFinite(declared) || declared <= 0) continue;
        if (raisedOutputLimit(declared) !== undefined) continue;
        (sites.get(declared) ?? sites.set(declared, []).get(declared)!).push(rel);
      }
    }
  }

  return [...sites.entries()]
    .map(([declaredMaxTokens, found]) => ({ declaredMaxTokens, sites: [...new Set(found)].sort() }))
    .sort((a, b) => a.declaredMaxTokens - b.declaredMaxTokens);
}

if (require.main === module) {
  const gaps = unrecoverableCeilings();

  console.log(`--- CEILINGS THE ENGINE CANNOT RAISE (${gaps.length}) — hard failure ---`);
  for (const gap of gaps) console.log(`  ${gap.declaredMaxTokens.toLocaleString("en-US")}\n    ${gap.sites.join("\n    ")}`);
  if (gaps.length === 0) console.log("  (none)");
  console.log(`\nretry ceiling: ${OUTPUT_LIMIT_RETRY_CEILING.toLocaleString("en-US")} tokens`);

  if (gaps.length > 0) {
    console.error(
      `\ncheck-output-ceilings: ${gaps.length} declared output ceiling(s) at or above OUTPUT_LIMIT_RETRY_CEILING ` +
        `(${OUTPUT_LIMIT_RETRY_CEILING.toLocaleString("en-US")}). ` +
        "A step that truncates at such a ceiling has no recovery: `raisedOutputLimit` refuses to raise it, the turn becomes a " +
        "`tooling_error`, and the client's run ends with nothing. Either bring the ceiling below the bound, or split the step's " +
        "output so its answer fits — raising the bound itself is a vendor question, not a step-sizing one.",
    );
    process.exit(1);
  }
}
