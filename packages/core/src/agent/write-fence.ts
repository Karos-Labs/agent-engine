import * as path from "node:path";
import type { AgentContext } from "../types/agent-context.js";

export type WriteFenceVerdict = { allowed: true } | { allowed: false; reason: string };

/** Field names a model might (incorrectly) populate with a tenant identifier of its own choosing. */
const TENANT_FIELD_NAMES = new Set(["clientSlug", "client_id", "clientId", "tenantId", "tenant_id", "tenant_slug"]);

/**
 * Argument key names whose value is expected to be a filesystem path. Every
 * tool package names its path argument differently (`path`, `videoPath`,
 * `jobPath`, `profilePath`, `relativePath`, …) so this matches by suffix
 * rather than an exhaustive literal set — the same shape of tradeoff
 * `TENANT_FIELD_NAMES` makes, scoped narrowly enough that ordinary content
 * strings (post text, transcripts) never match it.
 */
const PATH_LIKE_KEY_PATTERN = /(path|dir|directory|filename)$/i;

/**
 * `..` traversal is already caught by `containsPathTraversal` regardless of
 * key name; this catches the other half of the same escape — a value that is
 * already absolute (so it needs no `..` to leave a tool's sandboxed root), on
 * either path convention regardless of the host OS, or a `file://` URI (a
 * path smuggled through a URL-shaped string, the same escape `karos-publish`
 * and `karos-landing`'s own sandboxes refuse for their explicit path
 * arguments — this backstops it for every *other* tool's path-like argument
 * too). Deliberately does NOT flag `http(s)://` — those are legitimate,
 * routine tool arguments (e.g. `landing.renderCheck`'s `baseUrl`) and
 * blocking them here would be a real regression, not a security fix.
 */
function looksLikeAbsoluteOrUrlPath(value: string): boolean {
  return path.win32.isAbsolute(value) || path.posix.isAbsolute(value) || /^file:\/\//i.test(value);
}

function findPathEscapeViolation(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const violation = findPathEscapeViolation(item);
      if (violation) return violation;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      if (PATH_LIKE_KEY_PATTERN.test(key) && typeof val === "string" && looksLikeAbsoluteOrUrlPath(val)) {
        return `field "${key}" is an absolute or URL-shaped path ("${val}") — no tool argument may name one directly`;
      }
      const nested = findPathEscapeViolation(val);
      if (nested) return nested;
    }
  }
  return undefined;
}

function containsPathTraversal(value: unknown): boolean {
  if (typeof value === "string") {
    return value.split(/[\\/]/).includes("..");
  }
  if (Array.isArray(value)) {
    return value.some(containsPathTraversal);
  }
  if (value && typeof value === "object") {
    return Object.values(value).some(containsPathTraversal);
  }
  return false;
}

function findTenantViolation(value: unknown, clientSlug: string): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const violation = findTenantViolation(item, clientSlug);
      if (violation) return violation;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      if (TENANT_FIELD_NAMES.has(key) && typeof val === "string" && val !== clientSlug) {
        return `field "${key}" names tenant "${val}", outside this run's bound tenant "${clientSlug}"`;
      }
      const nested = findTenantViolation(val, clientSlug);
      if (nested) return nested;
    }
  }
  return undefined;
}

/**
 * The write-fence as a hook, not a rule someone has to remember (RFC-01 §9,
 * §10): rejects path traversal and any argument that names a tenant other
 * than the one bound to this run. Tenant is bound from `AgentContext`, never
 * accepted as a model-supplied argument — this is the structural backstop
 * for that rule, not the only enforcement of it (real Layer 3 tools must
 * still never accept a tenant argument at all).
 */
export function enforceWriteFence(ctx: AgentContext, toolName: string, args: unknown): WriteFenceVerdict {
  if (containsPathTraversal(args)) {
    return { allowed: false, reason: `path traversal ('..') detected in arguments to tool "${toolName}"` };
  }

  const pathEscapeViolation = findPathEscapeViolation(args);
  if (pathEscapeViolation) {
    return { allowed: false, reason: `tool "${toolName}" call crosses the write-fence: ${pathEscapeViolation}` };
  }

  const tenantViolation = findTenantViolation(args, ctx.clientSlug);
  if (tenantViolation) {
    return { allowed: false, reason: `tool "${toolName}" call crosses the tenant write-fence: ${tenantViolation}` };
  }

  return { allowed: true };
}
