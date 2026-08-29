/**
 * SCRUM-296 (AU11) — TOOL_VERSION drift detection.
 *
 * WHAT WAS WRONG. Every tool built with `defineTool()` declares its own
 * `TOOL_VERSION` constant, which travels into every telemetry record
 * (`tool-factory.ts`'s `withToolCallSpan` call, RFC-01 §9.1 rule 5). ~50 of
 * those constants were `"1.0.0"` and had been since the tool was created —
 * only `research.pull` (now at `"1.1.0"`) had ever been bumped. A version
 * nobody increments is worse than no version at all: it actively misleads,
 * because telemetry attributes every result — across however many real
 * behavior changes the tool has been through — to `1.0.0`, so nothing
 * downstream can ever tell one tool revision's output from another's.
 *
 * WHAT THIS FILE DOES. It is a second, independent statement of "what
 * version is tool X at", read directly out of source text rather than
 * imported (so it works against a base-ref snapshot fetched via `git show`,
 * which is never on `node_modules`-resolvable disk). `diffToolVersions`
 * compares that statement across two snapshots of the same file — a "before"
 * and an "after" — and flags every tool whose file changed while its
 * declared version did not. It does not know or care WHY the file changed;
 * a change that is genuinely behavior-neutral (a comment, a rename) is
 * still expected to bump the version under this check, exactly as
 * `check-prompts.ts`'s registry drift check does not know why a prompt
 * changed — the human on the PR decides whether the change and the bump
 * agree, this only insists that some bump happened.
 *
 * Consumed by `scripts/check-tool-versions.ts` (the CLI wired into CI) and
 * by its regression test in `apps/agent-server/__tests__/`.
 */
import * as path from "node:path";

export const REPO_ROOT = path.resolve(__dirname, "..");

/** Directories that may contain `defineTool()` call sites worth checking. */
export const TOOL_SOURCE_GLOBS = ["packages/tools", "agents"] as const;

export interface ToolVersionEntry {
  readonly toolName: string;
  readonly version: string;
}

export interface ToolVersionProblem {
  readonly toolName: string;
  readonly file: string;
  readonly version: string;
  readonly detail: string;
}

// `defineTool<Foo, Bar>({` or the bare `defineTool({` form (both appear in
// this codebase — see `agents/*/src/tools/render-preview.ts` for the bare
// form). Deliberately requires `name` immediately followed by `version` —
// every real call site in this repo orders `DefineToolOptions` fields that
// way (`name`, `version`, `inputSchema`, `execute`), matching the type's own
// declared field order in `tool-factory.ts`.
const CALL_SITE = /defineTool(?:<[\s\S]*?>)?\(\{\s*name:\s*"([^"]+)",\s*version:\s*(TOOL_VERSION|"([^"]*)")/g;

const VERSION_CONST = /const\s+TOOL_VERSION\s*=\s*"([^"]*)"/;

/**
 * Every `defineTool()` call site's declared name + resolved version, read
 * out of one file's text. A file with two tools sharing one `const
 * TOOL_VERSION` (e.g. `append-feedback.ts`'s append + read pair) yields two
 * entries with the same version — that is correct: they really do ship
 * together today, and this check has no opinion on whether they should.
 */
export function extractToolVersions(content: string): ToolVersionEntry[] {
  const entries: ToolVersionEntry[] = [];
  const sharedConst = content.match(VERSION_CONST)?.[1];
  for (const m of content.matchAll(CALL_SITE)) {
    const toolName = m[1]!;
    const version = m[3] !== undefined ? m[3] : sharedConst;
    if (version !== undefined) entries.push({ toolName, version });
  }
  return entries;
}

/**
 * Compares one file's "before" and "after" text. Returns one problem per
 * tool whose entry exists on both sides, under an unchanged version, while
 * the file itself is not byte-identical — i.e. SOMETHING in the file moved
 * but the version travelling into telemetry did not follow it.
 *
 * A tool present only on one side (added or removed) is not drift — that is
 * a normal add/delete and carries no stale-version claim to check.
 */
export function diffFileToolVersions(relPath: string, before: string, after: string): ToolVersionProblem[] {
  if (before === after) return [];
  const beforeByName = new Map(extractToolVersions(before).map((e) => [e.toolName, e.version]));
  const problems: ToolVersionProblem[] = [];
  for (const entry of extractToolVersions(after)) {
    const beforeVersion = beforeByName.get(entry.toolName);
    if (beforeVersion !== undefined && beforeVersion === entry.version) {
      problems.push({
        toolName: entry.toolName,
        file: relPath,
        version: entry.version,
        detail:
          `${relPath} changed but "${entry.toolName}" is still TOOL_VERSION ${entry.version} — ` +
          `every telemetry record for this tool's next call is indistinguishable from one made before this change`,
      });
    }
  }
  return problems;
}

/**
 * Same comparison across a whole tree of {relPath -> content} snapshots.
 * `before` and `after` need only contain the files that matter — the CLI
 * populates them from `git show` / the working tree respectively, scoped to
 * `TOOL_SOURCE_GLOBS`.
 */
export function diffToolVersions(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): ToolVersionProblem[] {
  const problems: ToolVersionProblem[] = [];
  for (const [relPath, afterContent] of after) {
    const beforeContent = before.get(relPath);
    if (beforeContent === undefined) continue; // new file — nothing to have drifted from
    problems.push(...diffFileToolVersions(relPath, beforeContent, afterContent));
  }
  return problems;
}
