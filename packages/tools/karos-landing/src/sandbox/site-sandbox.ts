import { promises as fs } from "node:fs";
import * as path from "node:path";
import { sanitizeSegment } from "@agent-engine/tool-common";

/**
 * Thrown by every sandbox resolution function below — a distinct class (not
 * a bare `Error`) so tests can assert on the *kind* of failure, not just its
 * message string. Left uncaught by this module on purpose: `defineTool`
 * (RFC-01 §9.1 rule 2) catches anything a tool's `execute` throws and reports
 * it as `tooling_error`, so a sandbox violation is never mistaken for a
 * content judgment — the same three-way contract every other tool in this
 * repo already relies on.
 */
export class SiteSandboxViolation extends Error {}

export interface SiteSandboxConfig {
  /** Absolute path to the canonical, read-only template kit (`engine/template/`, RFC-07 §4 phase 4 / ENGINE-SPEC §13). Never a write target. */
  templateRoot: string;
  /** Absolute path to the engine's per-client build root (`engine/clients/`, AGENT-INVOCATION.md §2's `OUTPUT_PATH` minus the client segment). Each client's writable site lives at `<engineClientsRoot>/<clientSlug>/site`. */
  engineClientsRoot: string;
}

/** `OUTPUT_PATH/site` for one client — the only directory tree `landing.copyTemplate`/`landing.writeSiteFile` are ever allowed to write into. `clientSlug` is sanitized the same way `WorkspaceStore` sanitizes every tenant path segment (RFC-01 §9.1 rule 1: tenant is structural, never a raw path fragment). */
export function siteRootForClient(config: SiteSandboxConfig, clientSlug: string): string {
  return path.join(config.engineClientsRoot, sanitizeSegment(clientSlug), "site");
}

/**
 * Rejects anything that isn't a plain, relative, traversal-free path before
 * it ever reaches a filesystem call — the same shape of guard as
 * `karos-publish`'s `assertInside` (absolute paths, URL-shaped strings, and
 * `..` segments are refused outright), applied here as the first of two
 * layers (this module additionally resolves symlinks via `fs.realpath`,
 * which `assertInside` does not, because Landing Builder's threat model is
 * an agent writing into a tree it script-copied itself, where a
 * symlink planted by a prior step is a real concern `karos-publish`'s
 * template-authoring context does not have).
 */
function assertPlainRelativePath(rel: string, what: string): void {
  if (!rel || rel.length === 0) {
    throw new SiteSandboxViolation(`${what}: path must not be empty`);
  }
  if (rel.includes("\0")) {
    throw new SiteSandboxViolation(`${what}: path contains a NUL byte`);
  }
  if (path.isAbsolute(rel) || /^[a-z][a-z0-9+.-]*:\/\//i.test(rel)) {
    throw new SiteSandboxViolation(`${what} must be a relative path, got "${rel}"`);
  }
  const segments = rel.split(/[\\/]/);
  if (segments.some((segment) => segment === "..")) {
    throw new SiteSandboxViolation(`${what}: path traversal ('..') is not allowed, got "${rel}"`);
  }
}

/** Lexical containment: `target` must resolve to `root` itself or somewhere strictly beneath it. */
function assertLexicallyWithin(root: string, target: string, what: string): void {
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(target);
  if (targetResolved !== rootResolved && !targetResolved.startsWith(rootResolved + path.sep)) {
    throw new SiteSandboxViolation(`${what} escapes its sandbox root "${rootResolved}": resolved to "${targetResolved}"`);
  }
}

/**
 * Resolves the closest existing ancestor of `target` and returns its
 * canonical (symlink-resolved) path — used to catch a symlink planted at any
 * *already-existing* directory in the chain pointing outside the sandbox
 * root, even though the leaf file/subdirectory itself may not exist yet
 * (which is the normal case for a fresh write — `fs.realpath` throws ENOENT
 * on a path that doesn't exist).
 */
interface ClosestExistingAncestor {
  /** The ancestor's own lexical (pre-realpath) path — used to compute the not-yet-existing suffix relative to it. */
  lexical: string;
  /** The same ancestor, symlink-resolved — used for the sandbox-containment check. */
  real: string;
}

async function realpathOfClosestExistingAncestor(target: string): Promise<ClosestExistingAncestor> {
  let candidate = target;
  for (;;) {
    try {
      return { lexical: candidate, real: await fs.realpath(candidate) };
    } catch (err) {
      if (!isNotFound(err)) throw err;
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        // Reached the filesystem root without finding anything that exists — should be unreachable
        // in practice (the sandbox root itself must exist before any write is attempted), but fail
        // closed rather than looping forever.
        throw new SiteSandboxViolation(`no existing ancestor found while resolving "${target}"`);
      }
      candidate = parent;
    }
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "ENOENT";
}

/**
 * The write-fence at the heart of RFC-07 §4/§7: resolves `relativePath`
 * against `sandboxRoot`, refuses path traversal and absolute/URL-shaped
 * input structurally (not by convention), then confirms via `fs.realpath`
 * that no symlink anywhere in the existing ancestor chain smuggles the
 * write outside `sandboxRoot` — and, as an explicit second boundary,
 * refuses to resolve to anywhere inside `forbiddenRoot` (the canonical
 * template kit) even if some future misconfiguration nested the two roots.
 * `sandboxRoot` itself must already exist (created by `landing.copyTemplate`
 * or a prior write) — this function only guards descendants of it, it does
 * not create the root.
 */
export async function resolveSandboxedWritePath(
  sandboxRoot: string,
  forbiddenRoot: string,
  relativePath: string,
): Promise<string> {
  assertPlainRelativePath(relativePath, "target path");
  const lexicalTarget = path.resolve(sandboxRoot, relativePath);
  assertLexicallyWithin(sandboxRoot, lexicalTarget, "target path");

  let realSandboxRoot: string;
  try {
    realSandboxRoot = await fs.realpath(sandboxRoot);
  } catch (err) {
    throw new SiteSandboxViolation(`sandbox root "${sandboxRoot}" does not exist yet — copy the template before writing into it (${describeErr(err)})`);
  }

  const ancestor = await realpathOfClosestExistingAncestor(lexicalTarget);
  if (ancestor.real !== realSandboxRoot && !ancestor.real.startsWith(realSandboxRoot + path.sep)) {
    throw new SiteSandboxViolation(`target path "${relativePath}" resolves (via a symlink) outside the sandbox root "${realSandboxRoot}"`);
  }

  let realForbiddenRoot: string | undefined;
  try {
    realForbiddenRoot = await fs.realpath(forbiddenRoot);
  } catch {
    realForbiddenRoot = path.resolve(forbiddenRoot);
  }
  if (ancestor.real === realForbiddenRoot || ancestor.real.startsWith(realForbiddenRoot + path.sep) || lexicalTarget === path.resolve(forbiddenRoot)) {
    throw new SiteSandboxViolation(`target path "${relativePath}" resolves into the read-only template root "${forbiddenRoot}" — the template kit may never be written to`);
  }

  // Re-derive the final path from the *canonical* ancestor + whatever not-yet-existing
  // subdirectory/leaf segments sit between it and the target, so the returned path is both
  // symlink-safe and safe to `fs.mkdir(..., {recursive:true})` + write to.
  const suffix = path.relative(ancestor.lexical, lexicalTarget);
  return suffix && suffix !== "." ? path.join(ancestor.real, suffix) : ancestor.real;
}

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read-side counterpart used by `landing.gate`/`landing.renderCheck` to walk
 * a client's built site — same traversal/absolute-path guard as the write
 * path, without the symlink/realpath machinery (nothing is created here, and
 * the gate only ever reads paths it discovered itself by walking the tree).
 */
export function assertReadPathWithinRoot(root: string, relativePath: string, what: string): string {
  assertPlainRelativePath(relativePath, what);
  const resolved = path.resolve(root, relativePath);
  assertLexicallyWithin(root, resolved, what);
  return resolved;
}
