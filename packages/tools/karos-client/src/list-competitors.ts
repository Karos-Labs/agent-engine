import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, notAvailable, success } from "@agent-engine/tool-common";

const TOOL_VERSION = "1.0.0";
const SEGMENTS = ["client", "competitors"] as const;
const DEFAULT_LIMIT = 20;

export const ListCompetitorsInputSchema = z.object({
  // No existing TSDoc on this field to transcribe (SCRUM-293 flag) — synthesized from execute()'s use of `.slice(0, limit)`.
  limit: z.number().int().positive().default(DEFAULT_LIMIT).describe("Maximum number of competitors to return, taken from the front of the stored list."),
});
export type ListCompetitorsInput = z.infer<typeof ListCompetitorsInputSchema>;

/** A single tracked competitor. Loose shape — no canonical producer exists yet. */
export interface Competitor {
  name: string;
  website?: string;
  [key: string]: unknown;
}

/**
 * Read-only lookup of the tenant's competitor list (RFC-01 §9.1/§9.2), stored
 * as a single JSON array file rather than one-file-per-competitor. Tenant
 * comes from `context.ctx.clientSlug` only.
 *
 * An existing-but-empty array is a normal `success` with an empty list — only
 * a genuinely missing file (client never onboarded this data) is
 * `not_available`.
 */
export function createListCompetitors(store: WorkspaceStoreLike) {
  return defineTool<ListCompetitorsInput, Competitor[]>({
    name: "client.listCompetitors",
    description:
      "Read-only lookup of the tenant's competitor list, stored as a single JSON array file rather than one file per competitor. Tenant comes from context only.",
    version: TOOL_VERSION,
    inputSchema: ListCompetitorsInputSchema,
    async execute({ limit }, { ctx }) {
      const competitors = await store.readJson<Competitor[]>(ctx.clientSlug, [...SEGMENTS]);
      if (!competitors) {
        return notAvailable<Competitor[]>("competitor list has not been set up for this client yet");
      }
      return success(competitors.slice(0, limit));
    },
  });
}
