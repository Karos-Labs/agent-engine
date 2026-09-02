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
// form).
//
// ## Why this regex is shaped the way it is (rewritten 2026-09-02)
//
// It used to require `version` IMMEDIATELY after `name`, on the stated
// grounds that "every real call site in this repo orders `DefineToolOptions`
// fields that way". **No call site in this repo orders them that way.** All 88
// put `description` between the two, so this check matched nothing, saw zero
// tools, and had never been able to fail since AU11 shipped — while printing
// "every changed tool file that still declares a version bumped it" on every
// run. Its own regression test passed because its fixtures wrote the adjacent
// form the repo does not use.
//
// Found on 2026-09-02 while bumping `research.captureVisibility` for SCRUM-396:
// the file changed, the version did not, and the gate that exists for exactly
// that said nothing.
//
// Two things make it work now, and both are load-bearing:
//
//  * `version` may sit anywhere in the same object literal. The tempered
//    `(?!defineTool\()` keeps the lazy scan inside ONE call, so a tool that
//    declares no version cannot silently borrow the next tool's.
//  * the version may be a quoted literal OR any identifier. Two tools in
//    `karos-media/src/visual-patterns.ts` use `GET_TOOL_VERSION` /
//    `INGEST_TOOL_VERSION` rather than the bare `TOOL_VERSION` this used to
//    hardcode, and were invisible for that reason alone.
//
// `visible-to-this-check` is asserted against the REAL tree in
// `apps/agent-server/__tests__/tool-version-drift.test.ts`, not just against
// fixtures — a guard whose own premise is unchecked is how this one spent its
// whole life green.
const CALL_SITE = /defineTool(?:<[\s\S]*?>)?\(\{\s*name:\s*"([^"]+)"(?:(?!defineTool\()[\s\S])*?,\s*version:\s*(?:"([^"]*)"|([A-Za-z_$][\w$]*))/g;

/** Every `const <NAME> = "<value>"` in the file, so a `version:` naming one can be resolved. */
const VERSION_CONSTS = /const\s+([A-Za-z_$][\w$]*)\s*=\s*"([^"]*)"/g;

/**
 * Every `defineTool()` call site's declared name + resolved version, read
 * out of one file's text. A file with two tools sharing one `const
 * TOOL_VERSION` (e.g. `append-feedback.ts`'s append + read pair) yields two
 * entries with the same version — that is correct: they really do ship
 * together today, and this check has no opinion on whether they should.
 */
export function extractToolVersions(content: string): ToolVersionEntry[] {
  const consts = new Map<string, string>();
  for (const m of content.matchAll(VERSION_CONSTS)) consts.set(m[1]!, m[2]!);

  const entries: ToolVersionEntry[] = [];
  for (const m of content.matchAll(CALL_SITE)) {
    const toolName = m[1]!;
    // A quoted literal wins; otherwise the identifier is resolved against the
    // file's own consts. An identifier this file does not declare (imported
    // from elsewhere, or computed) yields no entry rather than a wrong one —
    // silence beats a version this check cannot actually see change.
    const version = m[2] !== undefined ? m[2] : consts.get(m[3]!);
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
