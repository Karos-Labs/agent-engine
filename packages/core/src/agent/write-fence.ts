import type { AgentContext } from "../types/agent-context.js";

export type WriteFenceVerdict = { allowed: true } | { allowed: false; reason: string };

/** Field names a model might (incorrectly) populate with a tenant identifier of its own choosing. */
const TENANT_FIELD_NAMES = new Set(["clientSlug", "client_id", "clientId", "tenantId", "tenant_id", "tenant_slug"]);

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

  const tenantViolation = findTenantViolation(args, ctx.clientSlug);
  if (tenantViolation) {
    return { allowed: false, reason: `tool "${toolName}" call crosses the tenant write-fence: ${tenantViolation}` };
  }

  return { allowed: true };
}
