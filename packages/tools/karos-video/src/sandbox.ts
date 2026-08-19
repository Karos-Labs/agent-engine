import { promises as fs } from "node:fs";
import * as path from "node:path";
import { sanitizeSegment } from "@agent-engine/tool-common";

/**
 * Thrown by `assertWithinTenantWorkRoot`/`assertNoTraversalOrNul` — a
 * distinct class (not a bare `Error`) so tests can assert on the *kind* of
 * failure. Left uncaught here on purpose: `defineTool` catches anything a
 * tool's `execute` throws and reports it as `tooling_error`, so a sandbox
 * violation is never mistaken for a content judgment (RFC-01 §6) — the same
 * contract `karos-landing`'s `SiteSandboxViolation` relies on.
 */
export class VideoPathViolation extends Error {}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "ENOENT";
}

/** Always-on, zero-config hardening: no path argument to a video tool may contain a NUL byte or a `..` traversal segment, regardless of whether a `workRoot` sandbox is configured. */
export function assertNoTraversalOrNul(candidate: string, what: string): void {
  if (candidate.includes("\0")) {
    throw new VideoPathViolation(`${what}: path contains a NUL byte`);
  }
  const segments = candidate.split(/[\\/]/);
  if (segments.some((segment) => segment === "..")) {
    throw new VideoPathViolation(`${what}: path traversal ('..') is not allowed, got "${candidate}"`);
  }
}

/**
 * Resolves the closest existing ancestor of `target` and returns its
 * canonical (symlink-resolved) path — same shape as `karos-landing`'s
 * `resolveSandboxedWritePath`, duplicated here rather than shared because the
 * two packages' sandboxes are provisioned independently and this one has no
 * read-only template root to protect, only a per-tenant work root.
 */
async function realpathOfClosestExistingAncestor(target: string): Promise<{ real: string }> {
  let candidate = target;
  for (;;) {
    try {
      return { real: await fs.realpath(candidate) };
    } catch (err) {
      if (!isNotFound(err)) throw err;
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw new VideoPathViolation(`no existing ancestor found while resolving "${target}"`);
      }
      candidate = parent;
    }
  }
}

/**
 * When `workRoot` is configured (`BRANDED_SHORTS_WORK_ROOT` /
 * `KarosVideoToolOptions.workRoot`), every `video.writeJsonFile` /
 * `video.readJsonFile` call is confined to
 * `<workRoot>/<sanitizeSegment(clientSlug)>/` — real-path-resolved so a
 * symlink planted anywhere in the existing ancestor chain can't smuggle the
 * call outside the tenant's directory (same threat model as
 * `karos-landing`'s site sandbox). `candidatePath` may be absolute or
 * relative: a relative path resolves against the tenant root, an absolute
 * one must already lie within it.
 */
export async function assertWithinTenantWorkRoot(workRoot: string, clientSlug: string, candidatePath: string, what: string): Promise<void> {
  assertNoTraversalOrNul(candidatePath, what);

  const tenantRoot = path.resolve(workRoot, sanitizeSegment(clientSlug));
  const lexicalTarget = path.resolve(tenantRoot, candidatePath);
  if (lexicalTarget !== tenantRoot && !lexicalTarget.startsWith(tenantRoot + path.sep)) {
    throw new VideoPathViolation(`${what} "${candidatePath}" escapes the tenant work root "${tenantRoot}"`);
  }

  let realTenantRoot: string;
  try {
    realTenantRoot = await fs.realpath(tenantRoot);
  } catch {
    // The tenant root doesn't exist yet — normal for a client's first write in this
    // workspace (the caller `mkdir -p`s it). Nothing exists yet for a symlink to hide in.
    return;
  }

  const ancestor = await realpathOfClosestExistingAncestor(lexicalTarget);
  if (ancestor.real !== realTenantRoot && !ancestor.real.startsWith(realTenantRoot + path.sep)) {
    throw new VideoPathViolation(`${what} "${candidatePath}" resolves (via a symlink) outside the tenant work root "${realTenantRoot}"`);
  }
}
