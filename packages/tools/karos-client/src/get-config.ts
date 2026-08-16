import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";
const SEGMENTS = ["client", "config"] as const;

export const GetConfigInputSchema = z.object({});
export type GetConfigInput = z.infer<typeof GetConfigInputSchema>;

/** The tenant's free-form runtime config. No canonical schema exists yet. */
export type ClientConfig = Record<string, unknown>;

/**
 * Read-only lookup of the tenant's config (RFC-01 §9.1/§9.2). Tenant comes
 * from `context.ctx.clientSlug` only — this tool takes no arguments.
 */
export function createGetConfig(store: WorkspaceStoreLike) {
  return defineTool<GetConfigInput, ClientConfig>({
    name: "client.getConfig",
    version: TOOL_VERSION,
    inputSchema: GetConfigInputSchema,
    async execute(_args, { ctx }) {
      const config = await store.readJson<ClientConfig>(ctx.clientSlug, [...SEGMENTS]);
      if (!config) {
        return notAvailable<ClientConfig>("config has not been set up for this client yet");
      }
      return success(config);
    },
  });
}
