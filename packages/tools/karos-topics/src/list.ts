import { z } from "zod";
import type { WorkspaceStoreLike } from "@agent-engine/tool-common";
import { defineTool, success } from "@agent-engine/tool-common";
import { readCatalog, type TopicStatus } from "./catalog.js";

const TOOL_VERSION = "1.0.0";

export const ListTopicsInputSchema = z.object({
  lane: z.string().min(1).optional().describe("Only rows in this lane. Omit for the whole catalog."),
  status: z.array(z.enum(["available", "reserved", "committed"])).optional().describe("Only rows in these statuses. Omit for every status."),
});
export type ListTopicsInput = z.infer<typeof ListTopicsInputSchema>;

export interface ListTopicsResult {
  rows: Array<{ topic: string; status: TopicStatus; lane: string }>;
}

/**
 * `topics.list` (2026-09-09): read-only, the catalog as it stands.
 *
 * Until now nothing could ASK what a lane already held: `topics.topUp` was
 * idempotent on the exact normalized string, so a scout that re-proposed a
 * topic in slightly different words ("The rise of GEO" after "Introducing
 * GEO") added a new row every week and the lane filled with near-duplicates.
 * A discovery step that reads the lane first can hand the writer what is
 * already there as a do-not-repeat list, and drop what comes back anyway.
 */
export function createListTopics(store: WorkspaceStoreLike) {
  return defineTool<ListTopicsInput, ListTopicsResult>({
    name: "topics.list",
    description: "Read-only: the topic catalog's rows (topic, status, lane), optionally filtered by lane and status. What a discovery step reads before proposing more.",
    version: TOOL_VERSION,
    inputSchema: ListTopicsInputSchema,
    async execute({ lane, status }, { ctx }) {
      const catalog = await readCatalog(store, ctx.clientSlug);
      const wanted = status === undefined ? undefined : new Set<TopicStatus>(status);
      const rows = catalog
        .filter((r) => (lane === undefined || r.lane === lane) && (wanted === undefined || wanted.has(r.status)))
        .map((r) => ({ topic: r.topic, status: r.status, lane: r.lane }));
      return success<ListTopicsResult>({ rows });
    },
  });
}
