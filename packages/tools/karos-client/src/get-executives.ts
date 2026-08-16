import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";
const SEGMENTS = ["client", "executives"] as const;

export const GetExecutivesInputSchema = z.object({});
export type GetExecutivesInput = z.infer<typeof GetExecutivesInputSchema>;

/** A single tracked executive. Loose shape — no canonical producer exists yet. */
export interface Executive {
  name: string;
  title?: string;
  [key: string]: unknown;
}

/**
 * Read-only lookup of the tenant's executive list (RFC-01 §9.1/§9.2), stored
 * as a single JSON array file. Tenant comes from `context.ctx.clientSlug`
 * only — this tool takes no arguments.
 *
 * An existing-but-empty array is a normal `success` with an empty list — only
 * a genuinely missing file is `not_available`.
 */
export function createGetExecutives(store: WorkspaceStoreLike) {
  return defineTool<GetExecutivesInput, Executive[]>({
    name: "client.getExecutives",
    version: TOOL_VERSION,
    inputSchema: GetExecutivesInputSchema,
    async execute(_args, { ctx }) {
      const executives = await store.readJson<Executive[]>(ctx.clientSlug, [...SEGMENTS]);
      if (!executives) {
        return notAvailable<Executive[]>("executive list has not been set up for this client yet");
      }
      return success(executives);
    },
  });
}
