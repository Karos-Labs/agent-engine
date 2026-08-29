/**
 * SCRUM-296 (AU11) — CLI for the TOOL_VERSION drift check.
 *
 * Run: `npm run check:tool-versions` — a discrete step in
 * `.github/workflows/quality.yml` ("Tool version drift"), which also passes
 * `--base "$BASE_SHA"` (derived from `github.event.before`) and fetches full
 * history, because a push-triggered `actions/checkout@v4` at the default
 * `fetch-depth: 1` leaves no parent commit locally to diff against. Exit
 * code 1 on any drift, or on a base ref that cannot be resolved at all (see
 * `resolveBaseRef` — deliberately a hard failure, not a silent pass).
 *
 * Compares the working tree against `--base` (default: the merge-base with
 * `origin/main`, else `HEAD~1`). Every tracked file under `packages/tools/`
 * or `agents/` that changed since `baseRef` is read from `baseRef` via
 * `git show` and from disk as it stands now; `diffToolVersions` (see
 * `scripts/tool-registry.ts`) flags any tool whose file changed without its
 * declared version changing.
 *
 * `--root <dir>` runs against a different repo (the regression test uses a
 * throwaway git fixture rather than mutating this repo's own history).
 * `--json` prints machine-readable output.
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { diffToolVersions, REPO_ROOT, TOOL_SOURCE_GLOBS, type ToolVersionProblem } from "./tool-registry";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/**
 * Resolves what to diff against. Order: an explicit `--base` (or, in CI,
 * `$BASE_SHA` — see `.github/workflows/quality.yml`, which sets it from
 * `github.event.before`, the correct "everything this push introduced"
 * boundary for a push-triggered workflow); else the merge-base with
 * `origin/main`; else `HEAD~1`.
 *
 * Deliberately does NOT fall back to "no base ref, so check nothing" —
 * that shape (an empty allowlist meaning "anyone", a check wired to a
 * condition that never fires) is the exact defect family this repo has hit
 * repeatedly. A `pretest`/CI run with `fetch-depth: 1` and no usable base
 * commit is a MISCONFIGURATION, not "nothing to check" — so this throws,
 * which fails the run loudly instead of silently reporting zero problems
 * forever.
 */
function resolveBaseRef(root: string, requested: string | undefined): string {
  if (requested !== undefined && requested !== "") return requested;
  try {
    return git(root, ["merge-base", "HEAD", "origin/main"]);
  } catch {
    // fall through
  }
  try {
    git(root, ["rev-parse", "--verify", "--quiet", "HEAD~1"]);
    return "HEAD~1";
  } catch {
    throw new Error(
      "check:tool-versions: could not resolve a base ref to diff against — " +
        "no origin/main reachable and HEAD has no parent (a fetch-depth: 1 checkout with no " +
        "origin/main and a single commit looks exactly like this). Pass --base <ref> explicitly.",
    );
  }
}

/** Files under `TOOL_SOURCE_GLOBS` that changed between `baseRef` and the working tree, tracked or not deleted. */
function changedToolFiles(root: string, baseRef: string): string[] {
  // `baseRef` was already verified resolvable by `resolveBaseRef` (or supplied
  // explicitly by the caller) — a failure here is a real git error, not "no
  // base", and is allowed to propagate rather than being read as "0 files".
  const out = git(root, ["diff", "--name-only", "--diff-filter=ACMR", baseRef, "--", ...TOOL_SOURCE_GLOBS]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".ts") && !l.includes("__tests__") && !l.includes("/dist/"));
}

async function loadSnapshots(
  root: string,
  baseRef: string,
  relFiles: string[],
): Promise<{ before: Map<string, string>; after: Map<string, string> }> {
  const before = new Map<string, string>();
  const after = new Map<string, string>();
  for (const rel of relFiles) {
    try {
      before.set(rel, git(root, ["show", `${baseRef}:${rel}`]));
    } catch {
      // File did not exist at baseRef (newly added) — no "before" to drift from.
    }
    try {
      after.set(rel, await fs.readFile(path.join(root, rel), "utf8"));
    } catch {
      // File deleted in the working tree — nothing to check on this side.
    }
  }
  return { before, after };
}

export interface CheckToolVersionsResult {
  readonly baseRef: string;
  readonly filesChecked: number;
  readonly problems: ToolVersionProblem[];
}

export async function runCheck(root: string = REPO_ROOT, baseRefArg?: string): Promise<CheckToolVersionsResult> {
  const baseRef = resolveBaseRef(root, baseRefArg);
  const files = changedToolFiles(root, baseRef);
  const { before, after } = await loadSnapshots(root, baseRef, files);
  const problems = diffToolVersions(before, after);
  return { baseRef, filesChecked: files.length, problems };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag >= 0 ? path.resolve(argv[rootFlag + 1] ?? ".") : REPO_ROOT;
  const baseFlag = argv.indexOf("--base");
  const baseRefArg = baseFlag >= 0 ? argv[baseFlag + 1] : undefined;

  const result = await runCheck(root, baseRefArg);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${DIM}  tool versions: diffed against ${result.baseRef}, ${result.filesChecked} tool file(s) changed${RESET}`);
    if (result.problems.length === 0) {
      console.log(`  ${GREEN}✓${RESET} every changed tool file that still declares a version bumped it`);
    } else {
      console.error();
      console.error(`${RED}ERROR: ${result.problems.length} tool(s) changed without a TOOL_VERSION bump:${RESET}`);
      for (const p of result.problems) console.error(`  ${RED}✗${RESET} ${p.detail}`);
      console.error();
      console.error(`${DIM}  Bump the tool's TOOL_VERSION (or the literal passed to defineTool's "version") to match this change.${RESET}`);
    }
  }
  if (result.problems.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
