import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";
const SEGMENTS = ["client", "voice-rules"] as const;

export const GetVoiceRulesInputSchema = z.object({});
export type GetVoiceRulesInput = z.infer<typeof GetVoiceRulesInputSchema>;

/** The tenant's editorial voice/style rules. Loose shape — no canonical producer exists yet. */
export interface VoiceRules {
  tone?: string;
  doList?: string[];
  dontList?: string[];
  [key: string]: unknown;
}

/**
 * Read-only lookup of the tenant's voice rules (RFC-01 §9.1/§9.2). Tenant
 * comes from `context.ctx.clientSlug` only — this tool takes no arguments.
 */
export function createGetVoiceRules(store: WorkspaceStoreLike) {
  return defineTool<GetVoiceRulesInput, VoiceRules>({
    name: "client.getVoiceRules",
    description: "Read-only lookup of the tenant's editorial voice/style rules. Tenant comes from context only — this tool takes no arguments.",
    version: TOOL_VERSION,
    inputSchema: GetVoiceRulesInputSchema,
    async execute(_args, { ctx }) {
      const rules = await store.readJson<VoiceRules>(ctx.clientSlug, [...SEGMENTS]);
      if (!rules) {
        return notAvailable<VoiceRules>("voice rules have not been set up for this client yet");
      }
      return success(rules);
    },
  });
}
