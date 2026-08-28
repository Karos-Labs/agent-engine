import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";
const SEGMENTS = ["client", "profile"] as const;

export const GetProfileInputSchema = z.object({});
export type GetProfileInput = z.infer<typeof GetProfileInputSchema>;

/**
 * The tenant's onboarding profile. No canonical schema exists yet (no
 * admin-authoring system is wired up in Phase 1), so this is intentionally
 * loose: a few illustrative fields plus an index signature for whatever else
 * a client's onboarding record happens to carry.
 */
export interface ClientProfile {
  name?: string;
  industry?: string;
  website?: string;
  description?: string;
  [key: string]: unknown;
}

/**
 * Read-only lookup of the tenant's profile (RFC-01 §9.1/§9.2). Tenant is
 * resolved exclusively from `context.ctx.clientSlug` — this tool's input
 * schema declares no fields at all, so there is nothing a caller could
 * override even by accident.
 */
export function createGetProfile(store: WorkspaceStoreLike) {
  return defineTool<GetProfileInput, ClientProfile>({
    name: "client.getProfile",
    description: "Read-only lookup of the tenant's onboarding profile. Tenant is resolved exclusively from context — this tool's input schema declares no fields at all.",
    version: TOOL_VERSION,
    inputSchema: GetProfileInputSchema,
    async execute(_args, { ctx }) {
      const profile = await store.readJson<ClientProfile>(ctx.clientSlug, [...SEGMENTS]);
      if (!profile) {
        return notAvailable<ClientProfile>("client profile has not been set up for this client yet");
      }
      return success(profile);
    },
  });
}
