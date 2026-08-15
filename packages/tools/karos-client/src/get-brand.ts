import { z } from "zod";
import type { WorkspaceStore } from "@agent-engine/tool-common";
import { defineTool, notAvailable, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";
const SEGMENTS = ["client", "brand"] as const;

export const GetBrandInputSchema = z.object({});
export type GetBrandInput = z.infer<typeof GetBrandInputSchema>;

/** The tenant's brand kit. Loose shape — no canonical producer exists yet. */
export interface ClientBrand {
  voice?: string;
  colors?: string[];
  logoUrl?: string;
  tagline?: string;
  [key: string]: unknown;
}

/**
 * Read-only lookup of the tenant's brand kit (RFC-01 §9.1/§9.2). Tenant comes
 * from `context.ctx.clientSlug` only — this tool takes no arguments.
 */
export function createGetBrand(store: WorkspaceStore) {
  return defineTool<GetBrandInput, ClientBrand>({
    name: "client.getBrand",
    version: TOOL_VERSION,
    inputSchema: GetBrandInputSchema,
    async execute(_args, { ctx }) {
      const brand = await store.readJson<ClientBrand>(ctx.clientSlug, [...SEGMENTS]);
      if (!brand) {
        return notAvailable<ClientBrand>("brand kit has not been set up for this client yet");
      }
      return success(brand);
    },
  });
}
